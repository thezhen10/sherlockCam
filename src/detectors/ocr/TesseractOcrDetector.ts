import { createWorker, PSM, type Worker as TesseractWorker } from 'tesseract.js';
import type { Detector, DetectorFrame, OcrScanResult } from '../../core/types';

export interface TesseractOcrDetectorOptions {
  id?: string;
  /** Tesseract language code(s), e.g. 'eng', 'eng+fra'. Default 'eng'. */
  language?: string;
  /** Minimum Tesseract confidence (0-100) required to report a result. Default 60. */
  minConfidence?: number;
  /** Minimum trimmed text length required to report a result. Default 3. */
  minTextLength?: number;
}

/**
 * OCR detector backed by Tesseract.js. Tesseract.js manages its own internal
 * worker, so recognition already runs off the main thread.
 *
 * This is a reasonable default for v1. If OCR speed/accuracy becomes a
 * bottleneck, this class can be swapped for a PaddleOCR/ONNX-based detector
 * without touching CameraScanner or the Detector interface - see README.
 */
export class TesseractOcrDetector implements Detector<OcrScanResult> {
  readonly id: string;

  private worker: TesseractWorker | null = null;
  private readonly language: string;
  private readonly minConfidence: number;
  private readonly minTextLength: number;

  constructor(options: TesseractOcrDetectorOptions = {}) {
    this.id = options.id ?? 'tesseract-ocr';
    this.language = options.language ?? 'eng';
    this.minConfidence = options.minConfidence ?? 60;
    this.minTextLength = options.minTextLength ?? 3;
  }

  async init(): Promise<void> {
    if (this.worker) return;
    this.worker = await createWorker(this.language);
    await this.worker.setParameters({
      tessedit_pageseg_mode: PSM.SPARSE_TEXT, // or SINGLE_WORD / SPARSE_TEXT
    });
  }

  async detect(frame: DetectorFrame): Promise<OcrScanResult | null> {
    if (!this.worker) {
      throw new Error(`${this.id}: not initialized - call init() first`);
    }

    const {
      data: { text, confidence },
    } = await this.worker.recognize(frame.canvas as HTMLCanvasElement);

    const trimmed = text.trim();
    if (trimmed.length < this.minTextLength || confidence < this.minConfidence) {
      return null;
    }

    return {
      type: 'ocr',
      detectorId: this.id,
      text: trimmed,
      confidence,
      timestamp: frame.timestamp,
    };
  }

  async dispose(): Promise<void> {
    await this.worker?.terminate();
    this.worker = null;
  }
}
