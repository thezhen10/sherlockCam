import type { ReaderOptions } from 'zxing-wasm/reader';
import type { Detector, DetectorFrame, BarcodeScanResult } from '../../core/types';
import type { ZxingWorkerRequest, ZxingWorkerResponse } from './zxing.worker';

export interface ZxingBarcodeDetectorOptions {
  id?: string;
  /** Restrict decoding to specific symbologies (e.g. ['QRCode', 'EAN13']). Default: all supported formats. */
  formats?: ReaderOptions['formats'];
  /**
   * Have the decoder try harder (multiple rotations/orientations, more
   * exhaustive search) before giving up on a frame. This is the single
   * biggest lever for real-world scan reliability - most reports of ZXing
   * "not detecting" real barcodes are resolved by enabling this - at the
   * cost of extra CPU time per frame (it runs in a worker, so this doesn't
   * block the UI, but it does mean the worker takes longer per tick).
   * Default true.
   */
  tryHarder?: boolean;
  /**
   * Provide a pre-constructed Worker if your bundler doesn't support the
   * `new Worker(new URL(...), import.meta.url)` pattern used by default
   * (this covers Vite, Webpack 5+, and esbuild out of the box).
   */
  worker?: Worker;
}

interface PendingRequest {
  resolve: (response: ZxingWorkerResponse) => void;
  reject: (error: Error) => void;
}

/**
 * Barcode/QR detector backed by zxing-wasm, running in a dedicated Web
 * Worker so decoding never blocks the main thread/UI.
 *
 * We use zxing-wasm directly (rather than the native `BarcodeDetector` Web
 * API) because native support does not exist on iOS Safari at all and is
 * inconsistent even on Android/Firefox - see README for details. This keeps
 * behavior identical across every mobile browser this app targets.
 */
export class ZxingBarcodeDetector implements Detector<BarcodeScanResult> {
  readonly id: string;

  private worker: Worker | null = null;
  private requestCounter = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly formats?: ReaderOptions['formats'];
  private readonly tryHarder: boolean;
  private readonly providedWorker?: Worker;

  constructor(options: ZxingBarcodeDetectorOptions = {}) {
    this.id = options.id ?? 'zxing-barcode';
    this.formats = options.formats;
    this.tryHarder = options.tryHarder ?? true;
    this.providedWorker = options.worker;
  }

  async init(): Promise<void> {
    if (this.worker) return;

    // ".js" (not ".ts") is intentional: TS/Vite resolve it against the local
    // zxing.worker.ts source during dev, and it matches the real flat
    // dist/zxing.worker.js file produced by the library build - see
    // tsup.config.ts. A literal file must exist at this exact relative path
    // for the reference to work with zero bundler-specific magic.
    this.worker =
      this.providedWorker ??
      new Worker(new URL('./zxing.worker.js', import.meta.url), { type: 'module' });

    this.worker.onmessage = (event: MessageEvent<ZxingWorkerResponse>) => {
      const pending = this.pending.get(event.data.id);
      if (!pending) return;
      this.pending.delete(event.data.id);
      pending.resolve(event.data);
    };

    this.worker.onerror = (event: ErrorEvent) => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error(event.message));
      }
      this.pending.clear();
    };
  }

  async detect(frame: DetectorFrame): Promise<BarcodeScanResult | null> {
    if (!this.worker) {
      throw new Error(`${this.id}: not initialized - call init() first`);
    }

    const requestId = ++this.requestCounter;
    const response = await new Promise<ZxingWorkerResponse>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      const request: ZxingWorkerRequest = {
        id: requestId,
        imageData: frame.imageData,
        options: {
          maxNumberOfSymbols: 1,
          tryHarder: this.tryHarder,
          ...(this.formats ? { formats: this.formats } : {}),
        },
      };
      this.worker!.postMessage(request);
    });

    if (response.error) {
      throw new Error(`${this.id}: ${response.error}`);
    }

    const first = response.results?.[0];
    if (!first) return null;

    return {
      type: 'barcode',
      detectorId: this.id,
      format: first.format,
      value: first.text,
      timestamp: frame.timestamp,
    };
  }

  async dispose(): Promise<void> {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }
}
