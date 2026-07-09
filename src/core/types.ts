/**
 * The scanner's lifecycle. Enforced by ScannerStateMachine - see StateMachine.ts.
 *
 *   idle -> starting -> scanning -> detected -> awaiting_dismissal -> scanning (loop)
 *                             |                                          |
 *                             +-------------------> stopped <------------+
 */
export type ScannerState =
  | 'idle'
  | 'starting'
  | 'scanning'
  | 'detected'
  | 'awaiting_dismissal'
  | 'stopped'
  | 'error';

export interface OcrScanResult {
  type: 'ocr';
  detectorId: string;
  text: string;
  confidence: number;
  timestamp: number;
}

export interface BarcodeScanResult {
  type: 'barcode';
  detectorId: string;
  format: string;
  value: string;
  timestamp: number;
}

/**
 * The payload handed back to the consuming app/game. Add new variants here
 * (and to the union) when adding new detector types.
 */
export type ScanResult = OcrScanResult | BarcodeScanResult;

/**
 * A single captured camera frame, already downscaled and drawn to a canvas,
 * handed to every registered detector on each detection tick.
 */
export interface DetectorFrame {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  imageData: ImageData;
  width: number;
  height: number;
  timestamp: number;
}

/**
 * Implement this interface to plug a new kind of detection (OCR, barcode,
 * face, custom object model, ...) into the scanner. The core engine only
 * ever talks to detectors through this interface, so it doesn't need to know
 * anything about how a specific detector works internally.
 */
export interface Detector<TResult extends ScanResult = ScanResult> {
  readonly id: string;
  init(): Promise<void>;
  detect(frame: DetectorFrame): Promise<TResult | null>;
  dispose(): Promise<void>;
}

/**
 * A fixed, centered crop window applied to every captured frame before it's
 * handed to detectors, expressed as fractions of the native camera frame
 * (not the on-screen rendered video size). 1 = no cropping on that axis.
 *
 * This deliberately does NOT try to auto-detect where a barcode/text is in
 * the frame - that's what the player does, by physically aiming the camera
 * so their target falls inside this fixed window (see the guide overlay in
 * the demo). Restricting detection to a smaller, known region both improves
 * accuracy (excludes noisy background) and effectively increases resolution
 * on the target, since less of the downscale budget is spent on pixels that
 * would've been discarded anyway.
 */
export interface RegionOfInterest {
  /** Fraction of the native frame width to keep, centered. Default 0.75. */
  widthFraction?: number;
  /** Fraction of the native frame height to keep, centered. Default 0.5. */
  heightFraction?: number;
}

/**
 * Cheap, dependency-free image preprocessing applied to each captured frame
 * (in place on its ImageData) before it reaches the detectors. All default
 * off - enable them to help detection on low-contrast, washed-out, or noisy
 * frames. Effects are applied in the order grayscale -> contrastStretch ->
 * threshold, and enabling contrastStretch or threshold always implies a
 * grayscale result even if `grayscale` itself is false.
 */
export interface PreprocessingOptions {
  /** Convert to grayscale (luminance) before handing to detectors. */
  grayscale?: boolean;
  /** Linearly rescale luminance so the frame's actual min/max spans 0-255. Fixes low-contrast/backlit frames. */
  contrastStretch?: boolean;
  /** Binarize to pure black/white using an automatically computed Otsu threshold. */
  threshold?: boolean;
}

export interface CameraScannerOptions {
  /** Detectors run in array order on every tick; the first one to return a result wins the tick. */
  detectors: Detector[];
  /** <video> element the camera stream is attached to. Must be in the DOM. */
  videoElement: HTMLVideoElement;
  /** How often to run detection while scanning. Lower = more responsive, more CPU/battery. Default 400ms. */
  detectionIntervalMs?: number;
  /** Frame is downscaled to fit within this box before being handed to detectors (aspect ratio preserved). */
  frameWidth?: number;
  frameHeight?: number;
  /** Crop each frame to this centered window (in native camera pixels) before downscaling. See RegionOfInterest. */
  roi?: RegionOfInterest;
  /** Cheap per-frame image preprocessing applied before detection. See PreprocessingOptions. All off by default. */
  preprocessing?: PreprocessingOptions;
  /** Passed through to getUserMedia's video constraints, merged over sensible mobile defaults. */
  videoConstraints?: MediaTrackConstraints;
  /** Stop the camera when the page/tab is hidden and restart it when visible again. Default true. */
  pauseOnHidden?: boolean;
  /** Request continuous autofocus on the camera track (best-effort; Chrome/Android only). Default true. */
  continuousAutofocus?: boolean;
  /** Turn on the device torch/flashlight if supported (best-effort; Chrome/Android only). Default false. */
  torch?: boolean;
}

export interface ScannerEventMap {
  statechange: ScannerState;
  detect: ScanResult;
  error: Error;
  /** Emitted every detection tick with the exact (preprocessed) frame handed to detectors. Useful for diagnostics. */
  frame: DetectorFrame;
  // Index signature so this satisfies EventEmitter's generic constraint.
  [key: string]: unknown;
}
