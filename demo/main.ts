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
  // ROI is set dynamically by syncRegionOfInterest() below (viewfinder-space square).
  videoConstraints: {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  },
  pauseOnHidden: true,
});

// Fraction of the smaller viewfinder (container) dimension - mirrors html5-qrcode's
// qrboxFunction(minEdgePercentage) pattern: define the square in on-screen space,
// then derive both the guide overlay and the native-pixel crop from that one value.
const ROI_EDGE_FRACTION = 0.3;

/**
 * Sizes a centered square off the smaller on-screen viewfinder dimension, then
 * pushes the matching native-frame fractions into the scanner. Both the guide
 * overlay and the actual detector crop trace back to the same onScreenEdge, so
 * they stay in sync as the container or camera resolution changes.
 *
 * The <video> uses object-fit: cover, so converting viewfinder pixels -> native
 * camera pixels requires dividing by coverScale (the larger of the two axis
 * scale factors). Without that, the guide would point at the right place on
 * screen but FrameGrabber would crop a differently-sized window.
 */
function syncRegionOfInterest(): void {
  const { videoWidth, videoHeight } = videoElement;
  if (!videoWidth || !videoHeight) return;

  const containerWidth = videoContainer.clientWidth;
  const containerHeight = videoContainer.clientHeight;
  if (!containerWidth || !containerHeight) return;

  // Square edge in on-screen pixels, sized off the smaller viewfinder dimension.
  const onScreenEdge = Math.min(containerWidth, containerHeight) * ROI_EDGE_FRACTION;

  // Drive the guide directly from viewfinder space.
  roiGuide.style.width = `${(onScreenEdge / containerWidth) * 100}%`;
  roiGuide.style.height = `${(onScreenEdge / containerHeight) * 100}%`;

  // Convert the same edge into native camera pixels to drive the actual detector crop.
  const coverScale = Math.max(containerWidth / videoWidth, containerHeight / videoHeight);
  const nativeEdge = onScreenEdge / coverScale;
  scanner.setRegionOfInterest({
    widthFraction: nativeEdge / videoWidth,
    heightFraction: nativeEdge / videoHeight,
  });
}

videoElement.addEventListener('loadedmetadata', syncRegionOfInterest);
videoElement.addEventListener('resize', syncRegionOfInterest);
window.addEventListener('resize', syncRegionOfInterest);

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
