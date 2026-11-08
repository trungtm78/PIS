import { availableParallelism } from 'node:os';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { DESIGN_ROOT } from './vite.config';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@design': DESIGN_ROOT } },
  test: {
    environment: 'jsdom',
    // A test that waits for something that never comes (a refusal, an absent button) waits the whole async timeout, and a busy machine slows every step.
    testTimeout: 20_000,
    // Half of the cores: with every core busy (the pre-push gate also runs on a shared machine) the jsdom files starve one another under coverage, so a test that takes a second alone takes tens of seconds and times out. Fewer workers finish the suite sooner than more workers that thrash.
    maxWorkers: Math.max(2, Math.floor(availableParallelism() / 2)),
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      // `src/pwa/sw.ts` is the entry of the service worker, bundled by vite.pwa.ts and run only in a browser worker; its logic (sw-core.ts) is covered.
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/vite-env.d.ts', 'src/pwa/sw.ts'],
      reporter: ['text'],
      thresholds: { lines: 90 },
    },
  },
});
