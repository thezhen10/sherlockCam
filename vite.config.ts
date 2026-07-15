/// <reference types="node" />
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// GitHub Pages serves project sites at https://<user>.github.io/<repo>/, not
// at the domain root, so a production build needs every asset URL prefixed
// with the repo name. Dev stays at '/' so the local/LAN URLs printed by
// `npm run dev` keep working unchanged.
const GITHUB_PAGES_BASE = '/sherlockCam/';

// The demo app is a throwaway harness for manually testing the scanner engine
// in a real browser (including on a phone over HTTPS - see README), and also
// what gets deployed to GitHub Pages (see `npm run build:demo`).
export default defineConfig(({ mode }) => {
  // `vite build` and `vite preview` both resolve with mode 'production' by
  // default (preview forces it so it accurately reflects a real build),
  // while `vite`/`vite dev` defaults to 'development' - checking mode (not
  // command) keeps `npm run preview` consistent with the real Pages build
  // instead of serving build.outDir at the wrong base path.
  const isProduction = mode === 'production';

  return {
    root: 'demo',
    base: isProduction ? GITHUB_PAGES_BASE : '/',
    build: {
      // Kept outside the library's dist/ (produced by tsup) so building the
      // demo never clobbers the published package output, or vice versa.
      outDir: '../dist-demo',
      emptyOutDir: true,
      // Vite's default build only bundles <root>/index.html - now that there
      // are two pages (the target-scan prototype at index.html, and the full
      // detector-comparison harness moved to demo.html), both need to be
      // listed explicitly or the second page is silently dropped from the
      // production build.
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'demo/index.html'),
          demo: resolve(__dirname, 'demo/demo.html'),
        },
      },
    },
    server: {
      host: true, // expose on LAN so a phone can reach it
    },
    // basicSsl gives us HTTPS on localhost/LAN, which getUserMedia requires
    // on real mobile devices - only needed for local dev. GitHub Pages
    // already serves over HTTPS, and self-signed certs aren't meaningful in
    // a static build. Set VITE_HTTPS=0 to disable for local dev if unneeded.
    plugins: isProduction || process.env.VITE_HTTPS === '0' ? [] : [basicSsl()],
  };
});
