export interface CameraOptions {
  videoElement: HTMLVideoElement;
  constraints?: MediaTrackConstraints;
  /** Stop the stream when the page is hidden and restart it when visible again. Default true. */
  pauseOnHidden?: boolean;
  /** Request continuous autofocus once the stream starts (best-effort). Default true. */
  continuousAutofocus?: boolean;
  /** Turn on the device torch once the stream starts, if supported (best-effort). Default false. */
  torch?: boolean;
}

/**
 * `torch` and `focusMode` are real, widely-shipped capabilities (Image
 * Capture spec extensions) but are not in lib.dom.d.ts, so we declare the
 * narrow shape we use. Everything touching these is capability-checked and
 * wrapped in try/catch, since they're absent on iOS Safari entirely.
 */
interface ExtendedCapabilities extends MediaTrackCapabilities {
  torch?: boolean;
  focusMode?: string[];
}

interface ExtendedConstraintSet extends MediaTrackConstraintSet {
  torch?: boolean;
  focusMode?: string;
}

const DEFAULT_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: { ideal: 'environment' },
  // Deliberately modest - detection doesn't need full sensor resolution, and
  // requesting less keeps per-frame processing (and battery use) down on phones.
  width: { ideal: 1280 },
  height: { ideal: 720 },
};

/**
 * Thin wrapper around getUserMedia with the mobile-specific behavior a
 * scanner needs: back camera by default, inline (non-fullscreen) playback on
 * iOS, and automatic stop/restart when the page is backgrounded so the OS
 * doesn't fight us for the camera and we're not draining battery off-screen.
 */
export class Camera {
  private stream: MediaStream | null = null;
  private wasRunningBeforeHidden = false;
  private readonly videoElement: HTMLVideoElement;
  private readonly constraints: MediaTrackConstraints;
  private readonly pauseOnHidden: boolean;
  private continuousAutofocus: boolean;
  private torch: boolean;

  private readonly onVisibilityChange = (): void => {
    void this.handleVisibilityChange();
  };

  constructor(options: CameraOptions) {
    this.videoElement = options.videoElement;
    this.constraints = { ...DEFAULT_CONSTRAINTS, ...options.constraints };
    this.pauseOnHidden = options.pauseOnHidden ?? true;
    this.continuousAutofocus = options.continuousAutofocus ?? true;
    this.torch = options.torch ?? false;

    if (this.pauseOnHidden) {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }
  }

  get isRunning(): boolean {
    return this.stream !== null;
  }

  /**
   * Must be called from a user gesture (e.g. a tap on a "Start scanning"
   * button) - iOS Safari will reject/ignore camera starts that aren't.
   */
  async start(): Promise<void> {
    if (this.stream) return;

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: this.constraints,
      audio: false,
    });

    this.videoElement.srcObject = this.stream;
    // Required on iOS: without playsInline the video is forced fullscreen;
    // without muted, autoplay is blocked by the browser's autoplay policy.
    this.videoElement.playsInline = true;
    this.videoElement.muted = true;

    await this.videoElement.play();

    // Best-effort camera tuning - applied after the stream is live because
    // capabilities are only known once a track exists. Never fatal.
    if (this.continuousAutofocus) {
      await this.applyTrackConstraint({ focusMode: 'continuous' }, 'focusMode');
    }
    if (this.torch) {
      await this.applyTrackConstraint({ torch: true }, 'torch');
    }
  }

  stop(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.videoElement.srcObject = null;
  }

  /** Fully tears down the camera, including the visibility listener. Call once you're done with this instance. */
  destroy(): void {
    this.stop();
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
  }

  /**
   * Toggle the device torch/flashlight while the camera is running.
   * Best-effort: silently no-ops if the running track doesn't support torch
   * (e.g. iOS Safari, or a front camera). The preference is remembered and
   * re-applied on the next start().
   */
  async setTorch(enabled: boolean): Promise<void> {
    this.torch = enabled;
    await this.applyTrackConstraint({ torch: enabled }, 'torch');
  }

  /**
   * Toggle continuous autofocus while the camera is running. Best-effort;
   * silently no-ops where unsupported. Preference is re-applied on next start().
   */
  async setContinuousAutofocus(enabled: boolean): Promise<void> {
    this.continuousAutofocus = enabled;
    await this.applyTrackConstraint(
      { focusMode: enabled ? 'continuous' : 'manual' },
      'focusMode',
    );
  }

  /**
   * Applies a single non-standard capability constraint to the live video
   * track, but only if the track advertises support for it. All failures are
   * swallowed - these capabilities are genuinely optional and absent on many
   * mobile browsers, so a failure here must never break scanning.
   */
  private async applyTrackConstraint(
    constraint: ExtendedConstraintSet,
    capability: keyof ExtendedCapabilities,
  ): Promise<void> {
    const track = this.stream?.getVideoTracks()[0];
    if (!track || typeof track.getCapabilities !== 'function') return;

    const capabilities = track.getCapabilities() as ExtendedCapabilities;
    if (!(capability in capabilities)) return;

    try {
      await track.applyConstraints({ advanced: [constraint] } as MediaTrackConstraints);
    } catch {
      // Unsupported/failed - intentionally ignored (best-effort tuning).
    }
  }

  async listCameras(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === 'videoinput');
  }

  private async handleVisibilityChange(): Promise<void> {
    if (document.hidden) {
      this.wasRunningBeforeHidden = this.isRunning;
      this.stop();
      return;
    }

    if (this.wasRunningBeforeHidden) {
      this.wasRunningBeforeHidden = false;
      await this.start();
    }
  }
}
