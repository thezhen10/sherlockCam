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
const stateLabel = document.querySelector('#state-label');
const dashboard = document.querySelector('#dashboard');
const dashboardHandle = document.querySelector('#dashboard-handle');
const messageLog = document.querySelector('#message-log');
const callbackModal = document.querySelector('#callback-modal');

// The three one-time targets to scan for. Placeholders - swap in real values.
const target1 = 'TODO_TARGET_1';
const target2 = 'TODO_TARGET_2';
const target3 = 'TODO_TARGET_3';
const targets = { target1, target2, target3 };
const foundTargets = new Set();

// Teachable Machine export lives under demo/public/models/character-classifier/.
// BASE_URL keeps this working for both local `/` and GitHub Pages `/sherlockCam/`.
const characterDetector = new TensorflowCharacterDetector({
  modelUrl: `${import.meta.env.BASE_URL}models/character-classifier/model.json`,
  labels: ['hampter', 'none'], // TODO: replace with labels from metadata.json
  inputSize: 224,
  minConfidence: 0.4,
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

/**
 * Sizes a centered square off the smaller on-screen viewfinder dimension, then
 * pushes the matching native-frame fractions into the scanner. Both the guide
 * overlay and the actual detector crop trace back to the same onScreenEdge, so
 * they stay in sync as the container (which shrinks when the dashboard expands)
 * or camera resolution changes.
 */
function syncRegionOfInterest() {
  const { videoWidth, videoHeight } = videoElement;
  if (!videoWidth || !videoHeight) return;

  const containerWidth = videoContainer.clientWidth;
  const containerHeight = videoContainer.clientHeight;
  if (!containerWidth || !containerHeight) return;

  const onScreenEdge = Math.min(containerWidth, containerHeight) * ROI_EDGE_FRACTION;

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

// The dashboard resizing also resizes #video-container (flex: 1 fills whatever
// #dashboard doesn't take), so the ROI must be re-synced once that transition
// finishes, not just on window/video resize.
dashboard.addEventListener('transitionend', (event) => {
  if (event.propertyName === 'height') syncRegionOfInterest();
});

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
  const value = extractScanValue(result);
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

scanner.on('statechange', (state) => {
  stateLabel.textContent = state;
  startButton.classList.toggle(
    'hidden',
    state === 'starting' || state === 'scanning' || state === 'detected' || state === 'awaiting_dismissal',
  );
});

scanner.on('error', (error) => {
  console.error('[scanner error]', error);
  stateLabel.textContent = `error: ${error.message}`;
});

startButton.addEventListener('click', () => {
  void scanner.start();
});

window.addEventListener('beforeunload', () => {
  void scanner.destroy();
});
