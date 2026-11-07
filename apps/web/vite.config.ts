import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { pwaPlugin } from './vite.pwa';

/** The design package is the single source of the mockup: the web imports its stylesheets and navigation data from there. */
export const DESIGN_ROOT = fileURLToPath(new URL('../../Design/MACHVON_Design', import.meta.url));

/** With VITE_API_PROXY_TARGET set (the browser end-to-end tests), `/api` reaches that API on the same origin. */
const apiTarget = process.env.VITE_API_PROXY_TARGET;

export default defineConfig({
  plugins: [react(), pwaPlugin()],
  resolve: { alias: { '@design': DESIGN_ROOT } },
  // Screens load lazily, so the dev server would first meet their dependencies in the middle of a browser session,
  // re-bundle them and reload every open page. Scanning every screen up front keeps the dependency graph fixed.
  optimizeDeps: { entries: ['index.html', 'src/**/*.{ts,tsx}', '!src/**/*.test.{ts,tsx}', '!src/test/**'] },
  server: {
    fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] },
    ...(apiTarget === undefined ? {} : { proxy: { '/api': { target: apiTarget, changeOrigin: true, rewrite: (path: string) => path.slice('/api'.length) } } }),
  },
});
