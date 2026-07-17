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

// getUserMedia can throw NotReadableError when a device was very recently
// stopped (e.g. by switchCamera()'s own previous call) and the OS/driver
// hasn't finished releasing it yet - common with USB webcams on Windows,
// where hardware teardown noticeably lags behind track.stop() returning.
// This is usually transient, not a real failure, so it's worth a few retries
// before surfacing it as an actual error.
const GET_USER_MEDIA_MAX_ATTEMPTS = 4;
const GET_USER_MEDIA_RETRY_DELAY_MS = 300;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNotReadableError(error: unknown): boolean {
  return error instanceof Error && error.name === 'NotReadableError';
}

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
  /** Guards against overlapping switchCamera() calls - see switchCamera(). */
  private isSwitchingCamera = false;

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
   * Switch to a specific camera device (from listCameras()) while running.
   * The selection is remembered and takes over from the facingMode default
   * on every future acquire (including the automatic restart on
   * visibilitychange), the same way the torch/continuousAutofocus
   * preferences are - see buildConstraints(). If called before the camera
   * has ever started, this just records the preference for the next start().
   *
   * Fully stops the current stream *before* requesting the new device,
   * rather than briefly holding both open. On mobile, front/back cameras
   * typically share a single hardware/ISP pipeline, and the OS only permits
   * one active camera session at a time - requesting a second device while
   * the first is still streaming is rejected outright there, not just
   * racy. (This differs from two genuinely separate desktop webcams - e.g.
   * a laptop's built-in one plus a USB one - which really can both be open
   * briefly; but stop-then-acquire is the ordering that works everywhere,
   * so it's the one used unconditionally.) getUserMediaWithRetry()'s
   * retry/backoff still absorbs the desktop-side release-lag race this
   * ordering reintroduces (briefly requesting a device that hasn't fully
   * finished releasing yet).
   *
   * If the new device still fails to open after retrying, falls back to
   * reopening the previous device so the camera doesn't go dead, then
   * rethrows the original error - the fallback's own failure, if any, is
   * swallowed in favor of surfacing that original error. Overlapping calls
   * (e.g. the toggle button tapped twice before the first switch settles)
   * are ignored rather than racing each other.
   */
  async switchCamera(deviceId: string): Promise<void> {
    if (this.isSwitchingCamera) return;
    this.isSwitchingCamera = true;

    try {
      if (!this.stream) {
        this.activeDeviceId = deviceId;
        return;
      }

      const previousDeviceId = this.activeDeviceId;
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
      this.videoElement.srcObject = null;

      this.activeDeviceId = deviceId;
      try {
        await this.acquireStream();
      } catch (error) {
        this.activeDeviceId = previousDeviceId;
        try {
          await this.acquireStream();
        } catch {
          // Fallback also failed - the camera is left stopped. Swallowed in
          // favor of rethrowing the original (more relevant) error below.
        }
        throw error;
      }
    } finally {
      this.isSwitchingCamera = false;
    }
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
    this.stream = await this.getUserMediaWithRetry();

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
   * Retries on NotReadableError (see the comment on GET_USER_MEDIA_MAX_ATTEMPTS)
   * with a short, increasing delay between attempts, so a device that's mid-release
   * from a just-stopped previous stream gets a chance to actually free up before
   * this gives up. Any other error (permission denied, no matching device, etc.)
   * is a real failure and is thrown immediately, without retrying.
   */
  private async getUserMediaWithRetry(): Promise<MediaStream> {
    const constraints = this.buildConstraints();
    let attempt = 0;

    while (true) {
      attempt += 1;
      try {
        return await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
      } catch (error) {
        if (!isNotReadableError(error) || attempt >= GET_USER_MEDIA_MAX_ATTEMPTS) throw error;
        await delay(attempt * GET_USER_MEDIA_RETRY_DELAY_MS);
      }
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
