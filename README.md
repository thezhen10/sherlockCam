# sherlockCam

A framework-agnostic camera scanning engine for the web: point a camera at
something, detect it (OCR, barcode/QR, or any custom detector you add), pause,
and wait for an explicit dismissal before scanning resumes.

This library only does capture + detection + state management. It does not
render any UI - it's meant to be embedded as a component inside a larger
app/game, which decides what to show and how to react to a detection.

## Why this shape

- **No framework lock-in.** Core is plain TypeScript. No React/Next.js
  dependency, so it can be dropped into any game/app stack.
- **Pluggable detectors.** OCR and barcode detection are just two
  implementations of one `Detector` interface. Add a new detector (face,
  custom object model, etc.) without touching the core engine.
- **Explicit state machine.** "Player must dismiss before scanning resumes"
  is enforced structurally (see `src/core/StateMachine.ts`), not by convention.
- **Mobile-first.** Built assuming this runs in a mobile browser/webview, not
  just desktop Chrome - see [Mobile notes](#mobile-notes) below.

## Project structure

```
src/
  core/
    types.ts            Detector interface, ScanResult union, options, events
    StateMachine.ts      idle -> starting -> scanning -> detected -> awaiting_dismissal -> scanning
    Camera.ts            getUserMedia wrapper, iOS quirks, visibility-based pause/resume
    FrameGrabber.ts      captures + downscales video frames into a reusable canvas
    CameraScanner.ts     public orchestrator: wires camera + detectors + state machine together
  detectors/
    ocr/
      TesseractOcrDetector.ts    OCR via Tesseract.js
    barcode/
      ZxingBarcodeDetector.ts    Barcode/QR via zxing-wasm, run in a Web Worker
      zxing.worker.ts            the worker itself
  utils/
    EventEmitter.ts      tiny typed pub/sub, no dependency
  index.ts               public exports
demo/                    minimal harness for manual testing on a real device (not shipped in dist/)
```

## Core API

```ts
import { CameraScanner, TesseractOcrDetector, ZxingBarcodeDetector } from 'sherlock-cam';

const scanner = new CameraScanner({
  videoElement,                                  // an existing <video> in the DOM
  detectors: [new ZxingBarcodeDetector(), new TesseractOcrDetector()],
  detectionIntervalMs: 400,                      // throttle - see Performance notes
  roi: { widthFraction: 0.75, heightFraction: 0.5 }, // see Region of interest, below
  preprocessing: { grayscale: false, contrastStretch: false, threshold: false }, // see Preprocessing
  continuousAutofocus: true,                     // best-effort camera tuning - see Mobile notes
  torch: false,
});

scanner.on('statechange', (state) => { /* 'idle' | 'starting' | 'scanning' | 'detected' | 'awaiting_dismissal' | 'stopped' | 'error' */ });
scanner.on('detect', (result) => {
  // result: { type: 'ocr', text, confidence, ... } | { type: 'barcode', format, value, ... }
  game.handleScanResult(result);
});
scanner.on('frame', (frame) => { /* the exact (preprocessed) frame handed to detectors - use for diagnostics */ });
scanner.on('error', (error) => { /* camera/detector failures */ });

await scanner.start();   // must be called from a user gesture on iOS
scanner.dismiss();       // call once your game/UI is done reacting to a `detect` event
scanner.stop();          // stop camera + loop, keeps detectors warm for a fast restart
await scanner.destroy(); // full teardown (releases camera + worker + all listeners)

// Live tuning while scanning (no restart needed):
scanner.setPreprocessing({ grayscale: true, contrastStretch: true });
await scanner.setTorch(true);              // best-effort; no-ops where unsupported
await scanner.setContinuousAutofocus(true);
```

Detection results are a discriminated union (`ScanResult` in `src/core/types.ts`)
so the consuming app can `switch (result.type)` without knowing anything
about detector internals.

## Adding a new detector

Implement the `Detector` interface and register an instance in the
`detectors` array passed to `CameraScanner` - the engine doesn't need to know
what the detector does internally:

```ts
interface Detector<TResult extends ScanResult = ScanResult> {
  readonly id: string;
  init(): Promise<void>;
  detect(frame: DetectorFrame): Promise<TResult | null>;
  dispose(): Promise<void>;
}
```

Detectors run in array order on every tick; the first one to return a
non-null result wins that tick and triggers `detect` + pauses scanning.

If your result shape is new, add a variant to the `ScanResult` union in
`src/core/types.ts` so consumers get type-safe narrowing.

## Region of interest

`FrameGrabber` crops every frame to a fixed, centered window (`roi` on
`CameraScannerOptions`) *before* downscaling, rather than handing detectors
the whole frame:

```ts
roi: { widthFraction: 0.75, heightFraction: 0.5 } // default
```

This is deliberately **not** smart/content-aware - there's no attempt to
auto-detect where a barcode or line of text is in the frame. Instead, the
player aims the camera so their target falls inside this fixed window (the
demo draws a matching guide overlay - see `demo/main.ts`'s `updateRoiGuide()`
- so they can see exactly where that window is). This mirrors how virtually
every barcode-scanner app works: a fixed viewfinder box, not a smart tracker.

Cropping before downscaling (rather than downscaling the whole frame and
cropping after) matters: it means the region actually being scanned gets the
full resolution budget instead of sharing it with background pixels that
were going to be discarded anyway. This is one of the most commonly-cited
fixes for "the barcode/text is clearly visible but the detector won't find
it" - see the barcode/OCR-specific notes below.

Both detectors currently share one `FrameGrabber`, so they share one ROI. If
different detectors ever need differently-shaped regions (e.g. a tighter
band for 1D barcodes vs. a squarer box for OCR), that would need each
`Detector` to be able to request its own frame from a shared source rather
than all reading from one pre-cropped `DetectorFrame` - a design change, not
a config tweak.

## Preprocessing

Each captured frame can be run through cheap, dependency-free image
preprocessing before it reaches the detectors (`preprocessing` on
`CameraScannerOptions`, or `scanner.setPreprocessing(...)` to change it live).
All options are **off by default**:

```ts
preprocessing: {
  grayscale: false,       // convert to luminance
  contrastStretch: false, // rescale actual min/max luminance to full 0-255 range
  threshold: false,       // binarize to pure black/white via an Otsu threshold
}
```

These target the most common cause of "the detector returns nothing at all"
(as opposed to returning a wrong value): low-contrast, backlit, or washed-out
frames where ZXing can't even locate a barcode pattern and Tesseract finds no
text regions. They're applied in order (grayscale -> contrastStretch ->
threshold), and enabling `contrastStretch` or `threshold` implies a grayscale
result regardless of the `grayscale` flag. The processing runs in place on the
frame's `ImageData` (`src/core/preprocessing.ts`) and the result is written
back to the shared canvas, so both detectors see the same preprocessed pixels.

This is deliberately kept to global, parameter-free operations. **Adaptive
(local) thresholding** - which handles uneven lighting *within* a single frame,
e.g. glare on one side of a plate - is not included because doing it well
effectively means pulling in OpenCV.js (a multi-MB dependency). If plain
contrast-stretch + Otsu isn't enough, that's the next step up.

To see exactly what the detectors receive after cropping and preprocessing,
listen to the `frame` event - the demo paints it into a small "Detector input"
panel (`demo/main.ts`), which is the fastest way to tell a blur/lighting/crop
problem apart from a detector-tuning one.

## Library choices and alternatives considered

- **Barcode/QR: `zxing-wasm`**, not the native `BarcodeDetector` Web API.
  The native API has no support at all on iOS Safari (any version) and is
  inconsistent even on Android/Firefox, so relying on it (even with a
  polyfill) would mean most of your mobile users fall back to a
  ZXing-based implementation anyway. Using `zxing-wasm` directly is simpler
  and behaves identically across every target browser. `@zxing/library`
  (pure JS) is a drop-in fallback if you ever hit a WASM/CSP restriction.
  `ZxingBarcodeDetector`'s `tryHarder` option (on by default) is the single
  most commonly-cited fix for "a clearly visible barcode isn't being
  detected" across ZXing's own issue tracker and various write-ups - it
  makes the decoder attempt multiple rotations/orientations before giving up
  on a frame, at the cost of extra (still off-main-thread) CPU time per tick.
- **OCR: Tesseract.js.** Mature, well-documented, works everywhere. It's
  larger and slower than newer ONNX/PaddleOCR-based options
  (`ppu-paddle-ocr`, `client-side-ocr`, `@ocr-web/core`), which are worth
  evaluating later if OCR speed/accuracy becomes a bottleneck - swapping
  the implementation only means writing a new `Detector`, not touching the
  core engine.
- **No AR/3D rendering library** (AR.js, MindAR, WebXR) - out of scope per
  current requirements (no visual overlay needed). If that changes, it would
  plug in as a separate rendering layer alongside, not instead of, this
  engine.

## Mobile notes

This is expected to run inside a mobile browser/webview, which changes a few
things from a typical desktop web app:

- **HTTPS is required.** `getUserMedia` will not work over plain HTTP on a
  real device. The dev server here uses `@vitejs/plugin-basic-ssl` so you can
  test on your phone over your LAN - see [Running the demo](#running-the-demo).
- **Camera start must originate from a user gesture** (e.g. a button tap) -
  `Camera.start()` will be rejected/ignored by iOS Safari otherwise.
- **`playsinline` + `muted`** are set on the `<video>` element automatically
  by `Camera` - without them iOS forces fullscreen playback or blocks
  autoplay entirely.
- **Frames are cropped to a region of interest, then downscaled**, before
  detection (`FrameGrabber`, default crop 75%x50% centered, downscale target
  640x480) - phone cameras default to much higher resolution than detection
  needs, and processing full-res frames would be slow and battery-hungry. See
  [Region of interest](#region-of-interest) above.
- **Camera pauses when the tab/webview is backgrounded** (`Camera`'s
  `pauseOnHidden`, on by default) via the Page Visibility API, both to save
  battery and because mobile OSes often reclaim the camera in the background
  anyway.
- **Continuous autofocus / torch are best-effort** (`continuousAutofocus`,
  default on; `torch`, default off - both also toggleable live via
  `scanner.setContinuousAutofocus()` / `scanner.setTorch()`). These use
  non-standard `MediaStreamTrack` capabilities that are essentially
  **Chrome-on-Android only** - iOS Safari does not expose `focusMode` or
  `torch` to web pages at all. Everything is capability-checked and wrapped in
  try/catch, so on unsupported devices it silently no-ops rather than erroring.
  Autofocus in particular matters because blur is one of the most common causes
  of zero detections.
- **WASM threading is not assumed.** Both Tesseract.js and `zxing-wasm` can
  use multi-threaded WASM for extra speed, but that requires
  `Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy` response
  headers that you may not control if this is embedded into someone else's
  page. This scaffold does not configure those headers, so both detectors
  run in their safe single-threaded default. Add the headers on your hosting
  and consult each library's docs if you want to opt into threading.
- **Worker bundling** for `zxing.worker.ts` uses the
  `new Worker(new URL('./zxing.worker.ts', import.meta.url))` pattern, which
  Vite, Webpack 5+, and esbuild all support natively. If the consuming app's
  bundler doesn't support this, pass a pre-built `Worker` instance via
  `ZxingBarcodeDetector({ worker: myWorker })`.

## Getting started

Requires Node.js (this environment doesn't have Node installed, so these
commands haven't been run here - install Node 18+ locally before continuing).

```bash
npm install
```

### Running the demo

```bash
npm run dev
```

This serves `demo/` with HTTPS enabled (self-signed cert) so you can open it
on your phone over the same network (Vite will print a `Network:` URL). On
first load your browser will warn about the self-signed certificate - accept
it to proceed. Tap **Start scanning**, then point the camera at a QR
code/barcode or some text.

If you don't need HTTPS (e.g. testing only on desktop `localhost`), run:

```bash
VITE_HTTPS=0 npm run dev
```

### Deploying the demo to GitHub Pages

The demo can be published as a static site so it can be opened on a phone
(over real HTTPS, no LAN/self-signed-cert dance needed) without anyone
running a local dev server. This deploys the `demo/` harness only - not the
published `sherlock-cam` package, which is published separately (see
[Building the library](#building-the-library)).

```bash
npm run build:demo
```

This runs a production Vite build (not `tsup`) rooted at `demo/`, outputting
static files to `dist-demo/` (kept separate from the library's `dist/` so the
two builds never clobber each other). The build automatically uses
`/sherlockCam/` as the base path - matching a GitHub Pages project site at
`https://<user>.github.io/sherlockCam/` - and skips the dev-only
`basicSsl()` plugin, since Pages already serves over HTTPS. If your repo has
a different name, update `GITHUB_PAGES_BASE` in `vite.config.ts` to match.

A workflow at `.github/workflows/deploy-pages.yml` builds and deploys
`dist-demo/` automatically on every push to `main`, using the standard
`actions/upload-pages-artifact` + `actions/deploy-pages` flow. One-time setup
in the repo: **Settings -> Pages -> Build and deployment -> Source ->
"GitHub Actions"**. After that, pushes to `main` (or a manual run from the
Actions tab) publish the demo automatically.

To preview the exact production build locally first:

```bash
npm run build:demo
npm run preview
```

Since `sherlock-cam` (the library) needs `getUserMedia`, the deployed demo
still requires camera permission and a user gesture to start - see
[Mobile notes](#mobile-notes). Worker/WASM loading (`zxing-wasm`,
Tesseract.js) is bundled by Vite the same way for a Pages build as for local
dev; verify barcode/OCR scanning still works on the deployed URL, since
worker/asset paths are one of the few things that can behave differently
once a non-root base path is involved.

### Building the library

```bash
npm run build
```

Outputs an ESM bundle and type declarations to `dist/`, ready to be
published or linked into the larger game project. ESM-only is intentional -
this is a browser-only library (`getUserMedia`/`Worker`/canvas), so a CJS
build wouldn't be useful to anyone, and esbuild can't correctly emit the
`import.meta.url` used for worker loading in CJS output anyway.

### Type-checking

```bash
npm run typecheck
```

## Not yet implemented (KIV)

- Visual overlay/AR rendering (deliberately out of scope for now)
- Per-detector region of interest / frame size (currently one shared crop
  for all detectors - see [Region of interest](#region-of-interest))
- Adaptive (local) thresholding and deskew/perspective correction - the
  global preprocessing options (grayscale, contrast stretch, Otsu threshold)
  are implemented and dependency-free; handling uneven in-frame lighting or
  off-angle plates well would mean pulling in OpenCV.js, at the cost of a much
  heavier dependency. See [Preprocessing](#preprocessing).
- Camera device switching UI (front/back/multi-lens) - `Camera.listCameras()`
  already exists as a building block
