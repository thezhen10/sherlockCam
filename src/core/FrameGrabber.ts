import { applyPreprocessing, hasAnyPreprocessing } from './preprocessing';
import type { DetectorFrame, PreprocessingOptions, RegionOfInterest } from './types';

const DEFAULT_TARGET_WIDTH = 640;
const DEFAULT_TARGET_HEIGHT = 480;
const DEFAULT_ROI_WIDTH_FRACTION = 0.5;
const DEFAULT_ROI_HEIGHT_FRACTION = 0.25;

export interface FrameGrabberOptions {
  targetWidth?: number;
  targetHeight?: number;
  roi?: RegionOfInterest;
  preprocessing?: PreprocessingOptions;
}

/**
 * Captures the current video frame into a reusable canvas: first cropped to
 * a centered region of interest (native camera pixels), then downscaled to
 * fit within a target box (aspect ratio preserved). Reusing the same canvas
 * across ticks avoids per-frame allocation churn, which matters more on
 * phones than desktops.
 *
 * Cropping before scaling (rather than scaling the whole frame and cropping
 * after) means the ROI gets the full downscale budget instead of sharing it
 * with background pixels that were going to be discarded anyway - this is
 * what actually improves effective resolution on the target.
 */
export class FrameGrabber {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly targetWidth: number;
  private readonly targetHeight: number;
  private readonly resolvedRoi: Required<RegionOfInterest>;
  private preprocessing: PreprocessingOptions;

  constructor(options: FrameGrabberOptions = {}) {
    this.targetWidth = options.targetWidth ?? DEFAULT_TARGET_WIDTH;
    this.targetHeight = options.targetHeight ?? DEFAULT_TARGET_HEIGHT;
    this.resolvedRoi = {
      widthFraction: clampFraction(options.roi?.widthFraction ?? DEFAULT_ROI_WIDTH_FRACTION),
      heightFraction: clampFraction(options.roi?.heightFraction ?? DEFAULT_ROI_HEIGHT_FRACTION),
    };
    this.preprocessing = options.preprocessing ?? {};

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.targetWidth;
    this.canvas.height = this.targetHeight;

    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      throw new Error('FrameGrabber: could not acquire a 2D canvas context');
    }
    this.ctx = ctx;
  }

  /** The resolved (defaults-applied) region of interest, in native-frame fractions. Read by the demo to draw a matching guide overlay. */
  get roi(): Required<RegionOfInterest> {
    return this.resolvedRoi;
  }

  /** Replace the preprocessing options applied to each grabbed frame. Takes effect on the next grab(). */
  setPreprocessing(options: PreprocessingOptions): void {
    this.preprocessing = options;
  }

  grab(video: HTMLVideoElement): DetectorFrame {
    const { videoWidth, videoHeight } = video;
    if (!videoWidth || !videoHeight) {
      throw new Error('FrameGrabber: video has no dimensions yet (wait for loadedmetadata)');
    }

    const roiWidth = videoWidth * this.resolvedRoi.widthFraction;
    const roiHeight = videoHeight * this.resolvedRoi.heightFraction;
    const roiX = (videoWidth - roiWidth) / 2;
    const roiY = (videoHeight - roiHeight) / 2;

    const scale = Math.min(this.targetWidth / roiWidth, this.targetHeight / roiHeight, 1);
    const drawWidth = Math.max(1, Math.round(roiWidth * scale));
    const drawHeight = Math.max(1, Math.round(roiHeight * scale));

    if (this.canvas.width !== drawWidth || this.canvas.height !== drawHeight) {
      this.canvas.width = drawWidth;
      this.canvas.height = drawHeight;
    }

    // 9-argument drawImage crops the source (roiX/roiY/roiWidth/roiHeight)
    // and scales it to the destination size in one pass.
    this.ctx.drawImage(video, roiX, roiY, roiWidth, roiHeight, 0, 0, drawWidth, drawHeight);
    const imageData = this.ctx.getImageData(0, 0, drawWidth, drawHeight);

    // Preprocess in place, then write the result back to the canvas so the
    // ImageData (used by the barcode detector) and the canvas (used by the
    // OCR detector) stay in sync - both see the same preprocessed pixels.
    if (hasAnyPreprocessing(this.preprocessing)) {
      applyPreprocessing(imageData, this.preprocessing);
      this.ctx.putImageData(imageData, 0, 0);
    }

    return {
      canvas: this.canvas,
      imageData,
      width: drawWidth,
      height: drawHeight,
      timestamp: performance.now(),
    };
  }
}

function clampFraction(value: number): number {
  return Math.min(1, Math.max(0.01, value));
}
