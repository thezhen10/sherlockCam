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
  width: { ideal: 1920 },
  height: { ideal: 1080 },
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
  private readonly baseConstraints: MediaTrackConstraints;
  private readonly pauseOnHidden: boolean;
  private continuousAutofocus: boolean;
  private torch: boolean;
  /** Explicit device selected via switchCamera(), if any - see buildConstraints(). */
  private activeDeviceId: string | null = null;

  private readonly onVisibilityChange = (): void => {
    void this.handleVisibilityChange();
  };

  constructor(options: CameraOptions) {
    this.videoElement = options.videoElement;
    this.baseConstraints = { ...DEFAULT_CONSTRAINTS, ...options.constraints };
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
    await this.acquireStream();
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
   * Switch to a specific camera device (from listCameras()) while running -
   * stops the current stream's tracks and opens a new one for that device.
   * The selection is remembered and takes over from the facingMode default
   * on every future acquire (including the automatic restart on
   * visibilitychange), the same way the torch/continuousAutofocus
   * preferences are - see buildConstraints(). If called before the camera
   * has ever started, this just records the preference for the next start().
   */
  async switchCamera(deviceId: string): Promise<void> {
    this.activeDeviceId = deviceId;
    if (!this.stream) return;

    this.stream.getTracks().forEach((track) => track.stop());
    this.stream = null;
    await this.acquireStream();
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

  /**
   * Opens getUserMedia with the current constraints, attaches it to the
   * video element, and applies best-effort tuning - shared by start() and
   * switchCamera() so both paths stay identical (and any future track-level
   * tuning only needs to be added in one place).
   */
  private async acquireStream(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: this.buildConstraints(),
      audio: false,
    });

    this.videoElement.srcObject = this.stream;
    // Required on iOS: without playsInline the video is forced fullscreen;
    // without muted, autoplay is blocked by the browser's autoplay policy.
    this.videoElement.playsInline = true;
    this.videoElement.muted = true;

    await this.videoElement.play();

    // Best-effort camera tuning - applied after the stream is live because
    // capabilities are only known once a track exists, and re-applied here
    // (rather than assumed to carry over) since switchCamera() gives us a
    // brand new track that starts with none of this tuning. Never fatal.
    if (this.continuousAutofocus) {
      await this.applyTrackConstraint({ focusMode: 'continuous' }, 'focusMode');
    }
    if (this.torch) {
      await this.applyTrackConstraint({ torch: true }, 'torch');
    }
  }

  /**
   * facingMode and an explicit deviceId are mutually exclusive - browsers'
   * handling of specifying both is unreliable/inconsistent. Once a specific
   * device has been chosen (via switchCamera()), it takes over entirely from
   * the facingMode default on every subsequent acquire; until then, this
   * returns the original base constraints unchanged (facingMode included),
   * preserving the "back camera by default" behavior for the common case
   * where switchCamera() is never called.
   */
  private buildConstraints(): MediaTrackConstraints {
    if (!this.activeDeviceId) return this.baseConstraints;

    const { facingMode, ...rest } = this.baseConstraints;
    return { ...rest, deviceId: { exact: this.activeDeviceId } };
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
