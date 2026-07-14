import * as tf from '@tensorflow/tfjs';
import type { CharacterScanResult, Detector, DetectorFrame } from '../../core/types';

export type CharacterNormalizeMode = 'minusOneToOne' | 'zeroToOne';

export interface TensorflowCharacterDetectorOptions {
  id?: string;
  /** URL to the exported model.json (e.g. Teachable Machine export). */
  modelUrl: string;
  /**
   * Ordered class labels matching the model's output index order.
   * For Teachable Machine exports, copy these from `metadata.json`'s `labels` array.
   */
  labels: string[];
  /** Square input size the model expects. Teachable Machine default: 224. */
  inputSize?: number;
  /** Minimum softmax confidence (0-1) required to report a result. Default 0.9. */
  minConfidence?: number;
  /**
   * Pixel normalization applied before inference. Must match training.
   * Teachable Machine image models use `minusOneToOne` (default).
   */
  normalize?: CharacterNormalizeMode;
  /**
   * Predicted label to treat as "nothing detected" rather than a real
   * result - e.g. a trained 'none'/background class. When the top
   * prediction matches this label, `detect()` returns `null` regardless of
   * confidence, so it never triggers the scanner's detected/awaiting_dismissal
   * flow. Unset by default (no label is treated specially).
   */
  unknownLabel?: string;
}

/**
 * Single-character image classifier backed by TensorFlow.js.
 *
 * Designed for closed-set classification of a known character set (e.g. a
 * Teachable Machine export trained on photos of painted wall characters),
 * not open-ended OCR. Drop the exported `model.json` + weight shards under
 * a static assets path and pass `modelUrl` + `labels` here.
 *
 * TesseractOcrDetector remains available as an alternative for open-ended
 * text recognition - swap which detector is in the CameraScanner array.
 */
export class TensorflowCharacterDetector implements Detector<CharacterScanResult> {
  readonly id: string;

  private model: tf.LayersModel | null = null;
  private readonly modelUrl: string;
  private readonly labels: string[];
  private readonly inputSize: number;
  private readonly minConfidence: number;
  private readonly normalize: CharacterNormalizeMode;
  private readonly unknownLabel: string | undefined;

  constructor(options: TensorflowCharacterDetectorOptions) {
    if (!options.modelUrl) {
      throw new Error('TensorflowCharacterDetector: modelUrl is required');
    }
    if (!options.labels?.length) {
      throw new Error('TensorflowCharacterDetector: labels must be a non-empty array');
    }

    this.id = options.id ?? 'character-tf';
    this.modelUrl = options.modelUrl;
    this.labels = options.labels;
    this.inputSize = options.inputSize ?? 224;
    this.minConfidence = options.minConfidence ?? 0.9;
    this.normalize = options.normalize ?? 'minusOneToOne';
    this.unknownLabel = options.unknownLabel;
  }

  async init(): Promise<void> {
    if (this.model) return;

    this.model = await tf.loadLayersModel(this.modelUrl);

    // Warm-up: first predict() pays WebGL shader compile cost; do it here
    // so the first real camera frame isn't penalized.
    const warmup = tf.tidy(() => {
      const dummy = tf.zeros([1, this.inputSize, this.inputSize, 3]);
      return this.model!.predict(dummy) as tf.Tensor;
    });
    warmup.dispose();
  }

  async detect(frame: DetectorFrame): Promise<CharacterScanResult | null> {
    if (!this.model) {
      throw new Error(`${this.id}: not initialized - call init() first`);
    }

    const { index, confidence } = tf.tidy(() => {
      // ImageData is always available on DetectorFrame and works for both
      // HTMLCanvasElement and OffscreenCanvas sources.
      const pixels = tf.browser.fromPixels(frame.imageData);
      const resized = tf.image.resizeBilinear(pixels, [this.inputSize, this.inputSize]);
      const batched = resized.expandDims(0);
      const input =
        this.normalize === 'zeroToOne'
          ? batched.div(255)
          : batched.sub(127.5).div(127.5);

      const prediction = this.model!.predict(input) as tf.Tensor;
      const scores = prediction.dataSync();
      let bestIndex = 0;
      let bestScore = scores[0] ?? 0;
      for (let i = 1; i < scores.length; i += 1) {
        const score = scores[i] ?? 0;
        if (score > bestScore) {
          bestScore = score;
          bestIndex = i;
        }
      }
      return { index: bestIndex, confidence: bestScore };
    });

    if (confidence < this.minConfidence) {
      return null;
    }

    const character = this.labels[index];
    if (character === undefined || character === this.unknownLabel) {
      return null;
    }

    return {
      type: 'character',
      detectorId: this.id,
      character,
      confidence,
      timestamp: frame.timestamp,
    };
  }

  async dispose(): Promise<void> {
    this.model?.dispose();
    this.model = null;
  }
}
