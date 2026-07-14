import {
  CameraScanner,
  // TesseractOcrDetector, // kept available - swap back into detectors[] if needed
  TensorflowCharacterDetector,
  ZxingBarcodeDetector,
  type ScanResult,
} from '../src/index';

// This file is a thin harness for manually exercising the library in a real
// browser/device. The "game" would own this glue code in a real integration.

const videoElement = document.querySelector<HTMLVideoElement>('#camera')!;
const videoContainer = document.querySelector<HTMLDivElement>('#video-container')!;
const roiGuide = document.querySelector<HTMLDivElement>('#roi-guide')!;
const startButton = document.querySelector<HTMLButtonElement>('#start-button')!;
const stopButton = document.querySelector<HTMLButtonElement>('#stop-button')!;
const dismissButton = document.querySelector<HTMLButtonElement>('#dismiss-button')!;
const stateLabel = document.querySelector<HTMLSpanElement>('#state-label')!;
const callbackModal = document.querySelector<HTMLDivElement>('#callback-modal')!;
const callbackContent = document.querySelector<HTMLPreElement>('#callback-content')!;

const debugCanvas = document.querySelector<HTMLCanvasElement>('#debug-canvas')!;
const debugCtx = debugCanvas.getContext('2d')!;

const autofocusToggle = document.querySelector<HTMLInputElement>('#autofocus-toggle')!;
const torchToggle = document.querySelector<HTMLInputElement>('#torch-toggle')!;
const autofocusLabel = document.querySelector<HTMLLabelElement>('#autofocus-label')!;
const torchLabel = document.querySelector<HTMLLabelElement>('#torch-label')!;
const grayscaleToggle = document.querySelector<HTMLInputElement>('#grayscale-toggle')!;
const contrastToggle = document.querySelector<HTMLInputElement>('#contrast-toggle')!;
const thresholdToggle = document.querySelector<HTMLInputElement>('#threshold-toggle')!;

const detectorIndicators = new Map(
  Array.from(document.querySelectorAll<HTMLElement>('.detector-indicator')).map(
    (indicator) => [indicator.dataset.detectorId, indicator] as const,
  ),
);

// Teachable Machine export lives under demo/public/models/character-classifier/.
// BASE_URL keeps this working for both local `/` and GitHub Pages `/sherlockCam/`.
// Replace `labels` with the exact ordered list from that export's metadata.json.
const characterDetector = new TensorflowCharacterDetector({
  modelUrl: `${import.meta.env.BASE_URL}models/character-classifier/model.json`,
  labels: ['hampter', 'none'], // TODO: replace with labels from metadata.json
  inputSize: 224,
  minConfidence: 0.4,
  unknownLabel: 'none', // trained background/none class - never treated as a real detection
});

const scanner = new CameraScanner({
  videoElement,
  detectors: [
    new ZxingBarcodeDetector({ tryHarder: true }),
    characterDetector,
    // new TesseractOcrDetector({ language: 'eng' }), // swap back in to compare against TF
  ],
  detectionIntervalMs: 1,
  frameWidth: 2560,
  frameHeight: 1440,
  roi: { widthFraction: 0.225, heightFraction: 0.4 },
  videoConstraints: {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  },
  pauseOnHidden: true,
});

/**
 * Sizes the on-screen guide box so it visually matches the actual pixels
 * the scanner crops out (see FrameGrabber.grab()). This is NOT just "75%
 * width, 50% height of the container" - the <video> element is displayed
 * with `object-fit: cover`, which itself crops the native video to fill the
 * container, so we have to reproduce that same math here or the guide would
 * point at the wrong pixels.
 */
function updateRoiGuide(): void {
  const { videoWidth, videoHeight } = videoElement;
  if (!videoWidth || !videoHeight) return;

  const containerWidth = videoContainer.clientWidth;
  const containerHeight = videoContainer.clientHeight;
  if (!containerWidth || !containerHeight) return;

  // object-fit: cover scales the video by whichever axis needs the *larger*
  // factor to fully cover the container, cropping the overflow on the other axis.
  const coverScale = Math.max(containerWidth / videoWidth, containerHeight / videoHeight);

  const { widthFraction, heightFraction } = scanner.regionOfInterest;
  const onScreenRoiWidth = videoWidth * widthFraction * coverScale;
  const onScreenRoiHeight = videoHeight * heightFraction * coverScale;

  roiGuide.style.width = `${(onScreenRoiWidth / containerWidth) * 100}%`;
  roiGuide.style.height = `${(onScreenRoiHeight / containerHeight) * 100}%`;
}

videoElement.addEventListener('loadedmetadata', updateRoiGuide);
window.addEventListener('resize', updateRoiGuide);

// Diagnostics: paint the exact (cropped + preprocessed) frame the detectors
// receive, so it's obvious whether a "no detection" is really a blur/lighting/
// crop problem rather than a detector-tuning one.
scanner.on('frame', (frame) => {
  if (debugCanvas.width !== frame.width || debugCanvas.height !== frame.height) {
    debugCanvas.width = frame.width;
    debugCanvas.height = frame.height;
  }
  debugCtx.putImageData(frame.imageData, 0, 0);
});

// Lights up a detector's dot while it's actively processing a frame - makes
// it obvious when a slower detector (e.g. Tesseract) is the one taking time
// on a given tick, rather than that being invisible between state changes.
scanner.on('detectoractivity', ({ detectorId, busy }) => {
  detectorIndicators.get(detectorId)?.classList.toggle('busy', busy);
});

function readPreprocessing() {
  return {
    grayscale: grayscaleToggle.checked,
    contrastStretch: contrastToggle.checked,
    threshold: thresholdToggle.checked,
  };
}

for (const toggle of [grayscaleToggle, contrastToggle, thresholdToggle]) {
  toggle.addEventListener('change', () => {
    scanner.setPreprocessing(readPreprocessing());
  });
}

// Camera-level controls only act on a live track, so they're gated on the
// scanner actually running.
autofocusToggle.addEventListener('change', () => {
  void scanner.setContinuousAutofocus(autofocusToggle.checked);
});
torchToggle.addEventListener('change', () => {
  void scanner.setTorch(torchToggle.checked);
});

function setCameraTogglesEnabled(enabled: boolean): void {
  autofocusToggle.disabled = !enabled;
  torchToggle.disabled = !enabled;
  autofocusLabel.classList.toggle('disabled', !enabled);
  torchLabel.classList.toggle('disabled', !enabled);
}

scanner.on('statechange', (state) => {
  stateLabel.textContent = state;
  startButton.disabled = state === 'starting' || state === 'scanning' || state === 'detected' || state === 'awaiting_dismissal';
  stopButton.disabled = state === 'idle' || state === 'stopped';
  callbackModal.classList.toggle('visible', state === 'awaiting_dismissal');

  const cameraLive = state === 'scanning' || state === 'detected' || state === 'awaiting_dismissal';
  setCameraTogglesEnabled(cameraLive);
});

scanner.on('detect', (result: ScanResult) => {
  // This is the payload a real game/app would route into its own logic.
  callbackContent.textContent = JSON.stringify(result, null, 2);
});

scanner.on('error', (error) => {
  console.error('[scanner error]', error);
  stateLabel.textContent = `error: ${error.message}`;
});

startButton.addEventListener('click', () => {
  void scanner.start();
});

stopButton.addEventListener('click', () => {
  scanner.stop();
});

dismissButton.addEventListener('click', () => {
  scanner.dismiss();
});

window.addEventListener('beforeunload', () => {
  void scanner.destroy();
});
