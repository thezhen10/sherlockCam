import type { PreprocessingOptions } from './types';

/**
 * Rec. 601 luma weights - the standard perceptual grayscale conversion, and
 * what most OCR/barcode preprocessing pipelines use.
 */
const LUMA_R = 0.299;
const LUMA_G = 0.587;
const LUMA_B = 0.114;

/** True if any preprocessing step is enabled - lets callers cheaply skip the work entirely. */
export function hasAnyPreprocessing(options: PreprocessingOptions | undefined): boolean {
  return Boolean(options && (options.grayscale || options.contrastStretch || options.threshold));
}

/**
 * Applies the requested preprocessing to `imageData` in place. All steps work
 * off a single grayscale luminance pass, so enabling contrastStretch or
 * threshold always yields a grayscale result even if `grayscale` is false.
 *
 * These are intentionally dependency-free Canvas-level operations (no
 * OpenCV.js): grayscale, global contrast stretch, and Otsu threshold. They
 * target the common "detector finds nothing" causes - low contrast, backlit
 * or washed-out frames - without the weight of a full CV library.
 */
export function applyPreprocessing(
  imageData: ImageData,
  options: PreprocessingOptions,
): void {
  if (!hasAnyPreprocessing(options)) return;

  const { data } = imageData;
  const pixelCount = data.length / 4;

  // Pass 1: compute per-pixel luminance and track the actual min/max range.
  // Non-null assertions: every index below is provably in range, and this is
  // a per-pixel hot loop where the assertion is free (noUncheckedIndexedAccess
  // would otherwise widen typed-array reads to `number | undefined`).
  const luma = new Uint8ClampedArray(pixelCount);
  let min = 255;
  let max = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const value = data[i]! * LUMA_R + data[i + 1]! * LUMA_G + data[i + 2]! * LUMA_B;
    const rounded = value < 0 ? 0 : value > 255 ? 255 : value;
    luma[p] = rounded;
    if (rounded < min) min = rounded;
    if (rounded > max) max = rounded;
  }

  // Optional contrast stretch: remap [min, max] -> [0, 255]. Guard against a
  // flat frame (min === max) which would divide by zero.
  if (options.contrastStretch && max > min) {
    const range = max - min;
    for (let p = 0; p < pixelCount; p += 1) {
      luma[p] = ((luma[p]! - min) / range) * 255;
    }
  }

  // Optional Otsu threshold: pick the luminance cut that maximizes between-
  // class variance, then binarize. Computed on the (possibly stretched) luma.
  if (options.threshold) {
    const cut = computeOtsuThreshold(luma);
    for (let p = 0; p < pixelCount; p += 1) {
      luma[p] = luma[p]! > cut ? 255 : 0;
    }
  }

  // Write the luminance back into RGB (alpha untouched).
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const value = luma[p]!;
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
  }
}

/**
 * Otsu's method: builds a 256-bin histogram and returns the threshold that
 * maximizes between-class variance. Parameter-free, which is why it's the
 * default global-threshold choice for document/plate binarization.
 */
function computeOtsuThreshold(luma: Uint8ClampedArray): number {
  const histogram = new Array<number>(256).fill(0);
  for (let p = 0; p < luma.length; p += 1) {
    const bin = luma[p]!;
    histogram[bin] = histogram[bin]! + 1;
  }

  const total = luma.length;
  let sum = 0;
  for (let t = 0; t < 256; t += 1) {
    sum += t * histogram[t]!;
  }

  let sumBackground = 0;
  let weightBackground = 0;
  let maxVariance = 0;
  let threshold = 127;

  for (let t = 0; t < 256; t += 1) {
    weightBackground += histogram[t]!;
    if (weightBackground === 0) continue;

    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;

    sumBackground += t * histogram[t]!;
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;

    const betweenVariance =
      weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;

    if (betweenVariance > maxVariance) {
      maxVariance = betweenVariance;
      threshold = t;
    }
  }

  return threshold;
}
