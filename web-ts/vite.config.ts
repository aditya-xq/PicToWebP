/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'path';

/**
 * Privacy hardening: inject a strict Content-Security-Policy into the built
 * index.html. Applied at build time only so Vite dev/HMR keeps working.
 * The app is fully local — the policy forbids every remote origin so even a
 * supply-chain compromise could not exfiltrate image data.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // inline style attributes used by the UI
  "img-src 'self' blob: data:",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function cspPlugin(): Plugin {
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<head>',
        `<head>\n  <meta http-equiv="Content-Security-Policy" content="${CSP}">`,
      );
    },
  };
}

export default defineConfig({
  // Vitest: unit tests only — Playwright specs live in e2e/ and run via
  // `npm run test:e2e`; importing @playwright/test under vitest throws.
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**'],
  },
  // GitHub Pages serves the site from a project subpath.
  base: '/PicToWebP/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'index.html'),
    },
    target: 'es2020',
    minify: 'esbuild',
    cssMinify: true,
    sourcemap: false,
  },
  server: {
    port: 3000,
    open: true,
    // Allow the dev server to serve the shared stylesheet from the Python
    // package directory (production builds bundle it, no restriction needed).
    fs: {
      allow: ['..'],
    },
  },
  plugins: [cspPlugin()],
});
