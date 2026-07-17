import { EventEmitter } from '../utils/EventEmitter';
import { Camera } from './Camera';
import { FrameGrabber } from './FrameGrabber';
import { ScannerStateMachine } from './StateMachine';
import type {
  CameraScannerOptions,
  Detector,
  PreprocessingOptions,
  RegionOfInterest,
  ScanResult,
  ScannerEventMap,
  ScannerState,
} from './types';

const DEFAULT_DETECTION_INTERVAL_MS = 50;

/**
 * The public entry point of the library. Orchestrates the camera, the frame
 * capture loop, and a list of pluggable detectors, and exposes only the
 * output a consuming app/game needs: state changes and detection results.
 *
 * Usage:
 *
 *   const scanner = new CameraScanner({
 *     videoElement,
 *     detectors: [ocrDetector, barcodeDetector],
 *   });
 *   scanner.on('detect', (result) => game.handleScanResult(result));
 *   await scanner.start();
 *   // ...later, once the game/UI is done reacting to a detection:
 *   scanner.dismiss();
 */
export class CameraScanner extends EventEmitter<ScannerEventMap> {
  private readonly detectors: Detector[];
  private readonly videoElement: HTMLVideoElement;
  private readonly camera: Camera;
  private readonly frameGrabber: FrameGrabber;
  private readonly stateMachine = new ScannerStateMachine();
  private readonly detectionIntervalMs: number;

  private loopHandle: ReturnType<typeof setTimeout> | null = null;
  private isDetecting = false;
  private detectorsInitialized = false;

  constructor(options: CameraScannerOptions) {
    super();
    this.detectors = options.detectors;
    this.videoElement = options.videoElement;
    this.detectionIntervalMs = options.detectionIntervalMs ?? DEFAULT_DETECTION_INTERVAL_MS;

    this.camera = new Camera({
      videoElement: this.videoElement,
      constraints: options.videoConstraints,
      pauseOnHidden: options.pauseOnHidden,
      continuousAutofocus: options.continuousAutofocus,
      torch: options.torch,
    });

    this.frameGrabber = new FrameGrabber({
      targetWidth: options.frameWidth,
      targetHeight: options.frameHeight,
      roi: options.roi,
      preprocessing: options.preprocessing,
    });
  }

  get state(): ScannerState {
    return this.stateMachine.state;
  }

  /** The resolved (defaults-applied) region of interest currently in effect - read this to size a matching guide overlay. */
  get regionOfInterest(): Required<RegionOfInterest> {
    return this.frameGrabber.roi;
  }

  /** Toggle the device torch/flashlight while scanning. Best-effort; no-ops where unsupported. */
  async setTorch(enabled: boolean): Promise<void> {
    await this.camera.setTorch(enabled);
  }

  /** Toggle continuous autofocus while scanning. Best-effort; no-ops where unsupported. */
  async setContinuousAutofocus(enabled: boolean): Promise<void> {
    await this.camera.setContinuousAutofocus(enabled);
  }

  /**
   * List available camera devices. Labels/deviceIds are only reliably
   * populated once camera permission has been granted (i.e. after start()
   * has resolved at least once) - see MDN's enumerateDevices() docs.
   */
  async listCameras(): Promise<MediaDeviceInfo[]> {
    return this.camera.listCameras();
  }

  /**
   * Switch to a specific camera device (from listCameras()) while scanning -
   * takes effect immediately and persists across future restarts (e.g. the
   * automatic pause/resume around backgrounding the tab), taking over from
   * the default back-camera selection. No restart needed.
   *
   * Unlike start(), a failure here does not move the scanner into the
   * 'error' state. If the new device can't be opened, Camera.switchCamera()
   * falls back to reopening the previous device, so in the common case the
   * session carries on uninterrupted on the camera it was already using. In
   * the rare case that fallback also fails, the camera is left stopped -
   * camera.isRunning becomes false and detection ticks simply no-op until
   * start() is called again. Either way, the failure is surfaced via the
   * 'error' event for diagnostics/UI, but swallowed rather than rethrown, so
   * callers don't need their own try/catch just to avoid an unhandled
   * rejection.
   */
  async switchCamera(deviceId: string): Promise<void> {
    try {
      await this.camera.switchCamera(deviceId);
    } catch (error) {
      this.emitError(error);
    }
  }

  /** Replace the per-frame preprocessing options. Takes effect on the next detection tick - no restart needed. */
  setPreprocessing(options: PreprocessingOptions): void {
    this.frameGrabber.setPreprocessing(options);
  }

  /** Replace the region of interest. Takes effect on the next detection tick - no restart needed. */
  setRegionOfInterest(roi: RegionOfInterest): void {
    this.frameGrabber.setRegionOfInterest(roi);
  }

  /** Must be called from a user gesture on iOS - see Camera.start(). */
  async start(): Promise<void> {
    if (this.state === 'starting' || this.state === 'scanning') return;

    this.setState('starting');
    try {
      if (!this.detectorsInitialized) {
        await Promise.all(this.detectors.map((detector) => detector.init()));
        this.detectorsInitialized = true;
      }
      await this.camera.start();
      this.setState('scanning');
      this.scheduleNextDetection();
    } catch (error) {
      this.setState('error');
      this.emitError(error);
      throw error;
    }
  }

  /** Stops the camera and the detection loop. Detectors stay initialized so start() can resume quickly. */
  stop(): void {
    this.cancelLoop();
    this.camera.stop();
    this.setState('stopped');
  }

  /** Full teardown - releases the camera, workers, and all listeners. The instance is not reusable after this. */
  async destroy(): Promise<void> {
    this.stop();
    this.camera.destroy();
    await Promise.all(this.detectors.map((detector) => detector.dispose()));
    this.detectorsInitialized = false;
    this.removeAllListeners();
  }

  /**
   * Call this once the consuming app/game has finished reacting to a
   * `detect` event. Scanning will not resume before this is called - this is
   * the "player must dismiss before scanning starts again" gate.
   */
  dismiss(): void {
    if (this.state !== 'awaiting_dismissal') return;
    this.setState('scanning');
    this.scheduleNextDetection();
  }

  private setState(state: ScannerState): void {
    if (this.stateMachine.transition(state)) {
      this.emit('statechange', state);
    }
  }

  private emitError(error: unknown): void {
    this.emit('error', error instanceof Error ? error : new Error(String(error)));
  }

  private scheduleNextDetection(): void {
    if (this.state !== 'scanning') return;
    this.loopHandle = setTimeout(() => {
      void this.runDetectionTick();
    }, this.detectionIntervalMs);
  }

  private cancelLoop(): void {
    if (this.loopHandle !== null) {
      clearTimeout(this.loopHandle);
      this.loopHandle = null;
    }
  }

  private async runDetectionTick(): Promise<void> {
    if (this.state !== 'scanning' || this.isDetecting) return;

    // The camera can be transiently not-running while still logically
    // 'scanning' - e.g. mid-switchCamera(), which briefly sets the stream to
    // null between releasing the old device and acquiring the new one. This
    // must reschedule rather than just return: scheduleNextDetection() is
    // only ever called from within this method's own finally block (or
    // dismiss()/start()), so returning here without it would permanently
    // break the self-perpetuating timer chain - the scanner would silently
    // stop ticking forever, even once the camera becomes ready again.
    if (!this.camera.isRunning) {
      this.scheduleNextDetection();
      return;
    }

    this.isDetecting = true;
    try {
      const frame = this.frameGrabber.grab(this.videoElement);
      // Surface the exact (preprocessed) frame for diagnostics/UI before detection.
      this.emit('frame', frame);

      for (const detector of this.detectors) {
        this.emit('detectoractivity', { detectorId: detector.id, busy: true });
        let result: ScanResult | null;
        try {
          result = await detector.detect(frame);
        } finally {
          // Always emitted, even if detect() throws, so a busy indicator
          // never gets stuck "on" after a detector error.
          this.emit('detectoractivity', { detectorId: detector.id, busy: false });
        }
        // A dismiss/stop may have happened while this detector was running.
        if (this.state !== 'scanning') return;
        if (result) {
          this.handleDetection(result);
          return;
        }
      }
    } catch (error) {
      this.emitError(error);
    } finally {
      this.isDetecting = false;
      if (this.state === 'scanning') {
        this.scheduleNextDetection();
      }
    }
  }

  /**
   * State is advanced to 'awaiting_dismissal' *before* emitting 'detect' -
   * emit() calls listeners synchronously, so a listener that calls
   * dismiss() directly (e.g. to auto-resume on a non-match) needs the state
   * to already reflect 'awaiting_dismissal' or dismiss()'s own guard
   * (`state !== 'awaiting_dismissal'`) rejects the call as a no-op, leaving
   * the scanner stuck once this method's final setState runs afterward.
   */
  private handleDetection(result: ScanResult): void {
    this.setState('detected');
    this.setState('awaiting_dismissal');
    this.emit('detect', result);
  }
}
