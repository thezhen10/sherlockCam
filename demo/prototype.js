import {
  CameraScanner,
  TensorflowCharacterDetector,
  ZxingBarcodeDetector,
} from '../src/index';

// This is a focused mobile prototype (chat-style dashboard over a camera
// viewfinder) built directly on top of the same scanner engine main.ts uses.
// Almost everything here is plain JS-driven DOM: index.html only provides
// container elements, and this file owns all state and renders into them.

const videoElement = document.querySelector('#camera');
const videoContainer = document.querySelector('#video-container');
const roiGuide = document.querySelector('#roi-guide');
const startButton = document.querySelector('#start-button');
const switchCameraButton = document.querySelector('#switch-camera-button');
const stateLabel = document.querySelector('#state-label');
const dashboard = document.querySelector('#dashboard');
const dashboardHandle = document.querySelector('#dashboard-handle');
const messageLog = document.querySelector('#message-log');
const callbackModal = document.querySelector('#callback-modal');

// Debugging aid: shows the raw value of the most recent detection, so it's
// visible on-device (e.g. over remote/on-device inspection) without needing
// to dig through console logs. Fixed to the viewport so it stays visible
// regardless of dashboard expand/collapse.
const debugOverlay = document.createElement('div');
debugOverlay.id = 'debug-overlay';
debugOverlay.style.cssText = [
  'position: fixed',
  'top: 8px',
  'left: 8px',
  'z-index: 1000',
  'padding: 4px 8px',
  'background: rgba(0, 0, 0, 0.7)',
  'color: #0f0',
  'font: 12px monospace',
  'border-radius: 4px',
  'pointer-events: none',
  'max-width: 90vw',
  'white-space: pre-wrap',
].join(';');
debugOverlay.textContent = 'detected: ';
document.body.appendChild(debugOverlay);
let debugOverlayTimeout = null;

// The three one-time targets to scan for. Placeholders - swap in real values.
const target1 = 'A';
const target2 = 'B';
const target3 = 'hampter';
const targets = { target1, target2, target3 };
const foundTargets = new Set();

// Teachable Machine export lives under demo/public/models/character-classifier/.
// BASE_URL keeps this working for both local `/` and GitHub Pages `/sherlockCam/`.
const characterDetector = new TensorflowCharacterDetector({
  modelUrl: `${import.meta.env.BASE_URL}models/character-classifier/model.json`,
  labels: ['hampter', 'none'], // TODO: replace with labels from metadata.json
  inputSize: 224,
  minConfidence: 0.7,
  unknownLabel: 'none',
});

const scanner = new CameraScanner({
  videoElement,
  detectors: [new ZxingBarcodeDetector({ tryHarder: true }), characterDetector],
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

// Absolute on-screen (CSS px) clamp applied after the fraction above, so the
// viewfinder doesn't shrink to an unusably small target on tiny containers or
// balloon past a comfortable aiming size on large ones.
const ROI_MIN_EDGE_PX = 300;
const ROI_MAX_EDGE_PX = 500;

/**
 * Sizes a centered square off the smaller on-screen viewfinder dimension, then
 * pushes the matching native-frame fractions into the scanner. Both the guide
 * overlay and the actual detector crop trace back to the same onScreenEdge, so
 * they stay in sync as the container or camera resolution changes.
 * #video-container's own size is fixed regardless of #dashboard's
 * expanded/collapsed state (the dashboard overlays on top rather than
 * resizing it - see index.html), so no resync is needed on dashboard
 * expand/collapse, only on real video/window resizes.
 */
function syncRegionOfInterest() {
  const { videoWidth, videoHeight } = videoElement;
  if (!videoWidth || !videoHeight) return;

  const containerWidth = videoContainer.clientWidth;
  const containerHeight = videoContainer.clientHeight;
  if (!containerWidth || !containerHeight) return;

  const rawEdge = Math.min(containerWidth, containerHeight) * ROI_EDGE_FRACTION;
  const onScreenEdge = Math.min(Math.max(rawEdge, ROI_MIN_EDGE_PX), ROI_MAX_EDGE_PX);

  roiGuide.style.width = `${(onScreenEdge / containerWidth) * 100}%`;
  roiGuide.style.height = `${(onScreenEdge / containerHeight) * 100}%`;

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

// Normalizes whichever ScanResult variant fired, since a match can come from
// any detector (barcode, character-classifier, or OCR if it's ever added back).
function extractScanValue(result) {
  switch (result.type) {
    case 'barcode':
      return result.value;
    case 'character':
      return result.character;
    case 'ocr':
      return result.text;
    default:
      return null;
  }
}

// --- Chat-style message log -------------------------------------------------

const messages = [];

function renderMessage(message) {
  const bubble = document.createElement('div');
  bubble.className = `bubble ${message.role}`;
  bubble.textContent = message.text;
  messageLog.appendChild(bubble);
  messageLog.scrollTop = messageLog.scrollHeight;
}

function postMessage(role, text) {
  const message = { role, text, timestamp: Date.now() };
  messages.push(message);
  renderMessage(message);
  return message;
}

dashboardHandle.addEventListener('click', () => {
  dashboard.classList.toggle('expanded');
});

// --- Blocking acknowledgment modal ------------------------------------------
// Built entirely from JS - index.html only provides the empty #callback-modal
// container. Only ever shown for a genuine new-target match; the Dismiss
// button is the only thing that resumes scanning in that case.

const modalCard = document.createElement('div');
modalCard.id = 'callback-card';

const modalTitle = document.createElement('h2');
modalTitle.textContent = 'Target found!';

const modalBody = document.createElement('p');

const modalDismissButton = document.createElement('button');
modalDismissButton.textContent = 'Dismiss & resume scanning';
modalDismissButton.addEventListener('click', () => {
  callbackModal.classList.remove('visible');
  scanner.dismiss();
});

modalCard.append(modalTitle, modalBody, modalDismissButton);
callbackModal.appendChild(modalCard);

function showBlockingModal(text) {
  modalBody.textContent = text;
  callbackModal.classList.add('visible');
}

// --- Detection handling ------------------------------------------------------
// "Any detection value returned is dismissed automatically unless it is one
// of the undetected targets": non-matches dismiss themselves immediately
// below (scanning never visibly pauses for noise, which matters a lot since
// detection ticks run continuously); a genuine match posts a chat message
// AND opens the blocking modal, and only the modal's Dismiss tap resumes
// scanning.

scanner.on('detect', (result) => {
  // Prints every detection (match or not) so it's obvious what's actually
  // being decoded when a target isn't matching - same idea as main.ts's
  // callback panel, just to the console since this prototype has no debug UI.
  console.log('[detect]', result);

  const value = extractScanValue(result);
  debugOverlay.textContent = `detected: ${value}`;
  clearTimeout(debugOverlayTimeout);
  debugOverlayTimeout = setTimeout(() => {
    debugOverlay.textContent = 'detected: ';
  }, 1000);

  const matchedKey = Object.keys(targets).find(
    (key) => !foundTargets.has(key) && targets[key] === value,
  );

  if (!matchedKey) {
    scanner.dismiss();
    return;
  }

  foundTargets.add(matchedKey);
  const message = postMessage('match', `Target found: ${matchedKey} (${value})`);
  showBlockingModal(message.text);

  if (foundTargets.size === Object.keys(targets).length) {
    postMessage('completion', 'All targets found!');
  }
});

// Enabling switchCameraButton is one-way: once the scanner has reached
// 'scanning' for the first time (so a real stream/device list exists),
// it stays enabled - gating on 'scanning' rather than the button's own click
// avoids racing the still-in-flight initial getUserMedia call.
let hasScannedOnce = false;

scanner.on('statechange', (state) => {
  stateLabel.textContent = state;
  startButton.classList.toggle(
    'hidden',
    state === 'starting' || state === 'scanning' || state === 'detected' || state === 'awaiting_dismissal',
  );

  if (!hasScannedOnce && state === 'scanning') {
    hasScannedOnce = true;
    switchCameraButton.disabled = false;
  }
});

scanner.on('error', (error) => {
  console.error('[scanner error]', error);
  stateLabel.textContent = `error: ${error.message}`;
});

startButton.addEventListener('click', () => {
  void scanner.start();
});

// Cycles to the next available camera device on each click. The device list
// is re-fetched every click rather than cached, since it's cheap and this
// keeps it correct if the set of cameras ever changes mid-session.
let cameraIndex = 0;

switchCameraButton.addEventListener('click', async () => {
  const cameras = await scanner.listCameras();
  if (cameras.length < 2) return;

  cameraIndex = (cameraIndex + 1) % cameras.length;
  await scanner.switchCamera(cameras[cameraIndex].deviceId);
});

window.addEventListener('beforeunload', () => {
  void scanner.destroy();
});
