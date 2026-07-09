import { defineConfig } from 'tsup';

export default defineConfig({
  // The zxing worker is built as its own entry (not imported at the value
  // level anywhere) so it ends up as its own file. Using the object form of
  // `entry` (rather than an array) forces tsup to name the output by the key
  // given here, flattening it to dist/zxing.worker.js instead of mirroring
  // the nested src/detectors/barcode/... path. ZxingBarcodeDetector
  // references it at runtime via `new URL('./zxing.worker.js', import.meta.url)`,
  // which only resolves correctly because both files land flat in dist/.
  entry: {
    index: 'src/index.ts',
    'zxing.worker': 'src/detectors/barcode/zxing.worker.ts',
  },
  // This is a browser-only library (getUserMedia, Worker, canvas) - CJS
  // consumers can't do anything useful with it anyway, and esbuild can't
  // correctly emit `import.meta.url` (used for worker loading) in CJS.
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  target: 'es2022',
});
