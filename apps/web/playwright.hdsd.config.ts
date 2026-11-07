import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';

/**
 * The recording of the clips of the user guide (e2e/hdsd/*.hdsd.ts): the same API stack, identity provider and web server as the browser flows, one clip at a time.
 * Run it with `npx playwright test -c playwright.hdsd.config.ts`; the voice must exist first (`node scripts/hdsd/tts.mjs <flow id>`).
 */
export default defineConfig({
  ...base,
  testDir: './e2e/hdsd',
  testMatch: '**/*.hdsd.ts',
  timeout: 600_000,
  // A chapter that failed is filmed once more (a service that was busy, a page that was slow); a chapter that still fails does not stop the others.
  retries: 1,
  reporter: [['list']],
  outputDir: './e2e/test-results-hdsd',
});
