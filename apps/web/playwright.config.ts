import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { defineConfig } from '@playwright/test';
import { browserChannel } from './e2e/support/browser-channel.ts';
import { browserProjects } from './e2e/support/browsers.ts';
import { withReaderPersona } from './e2e/support/screen-personas.ts';
import { STACK_INFO_PATH } from './e2e/support/stack-paths.ts';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close((closeError) => (closeError ? reject(closeError) : resolve(port)));
    });
  });
}

// One id for this invocation: the report marks what an earlier run wrote as stale (the workers inherit it).
process.env.E2E_RUN_ID ??= randomUUID();

const port = Number(process.env.E2E_PORT ?? (await freePort()));
// The test workers load this file again: keeping the port in the environment makes them agree with the dev server.
process.env.E2E_PORT = String(port);
// The API stack the browser talks to: its port and the key that signs the development session tokens are fixed here,
// before any process starts, and kept in the environment so the test workers (which load this file again) agree.
const apiPort = Number(process.env.E2E_API_PORT ?? (await freePort()));
process.env.E2E_API_PORT = String(apiPort);
// The test identity provider the stack runs for the real sign-in flow; the web application is told its issuer address.
const idpPort = Number(process.env.E2E_IDP_PORT ?? (await freePort()));
process.env.E2E_IDP_PORT = String(idpPort);
const sessionKey = process.env.E2E_SESSION_KEY ?? randomBytes(32).toString('base64');
process.env.E2E_SESSION_KEY = sessionKey;
process.env.E2E_STACK_INFO = STACK_INFO_PATH;
// The users of the stack, and the persona that only reads (screen-contract.spec.ts): the browser knows it, the API stack does not need to.
const fixtureUsers: unknown = withReaderPersona((JSON.parse(readFileSync(new URL('./e2e/support/e2e-fixtures.json', import.meta.url), 'utf8')) as { users: Array<{ key: string; membershipId: string; displayName: string }> }).users);
const channel = browserChannel();
// E2E_BROWSERS (chromium, firefox, webkit) makes one project per engine; without it there are none and the run is the single default one.
const projects = browserProjects(process.env, channel);

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  // One browser at a time: the machine runs real PostgreSQL servers and other builds alongside.
  workers: 1,
  fullyParallel: false,
  // What a page says after a click is awaited for 5 seconds on a developer machine; a hosted runner (a shared virtual machine with its own API, database and browser) needs more than that for the same screen,
  // and the cases that failed there each failed once on a different screen with the answer a moment late. A longer wait costs nothing when the page is right and only a failing case waits it out.
  expect: { timeout: process.env.CI ? 20_000 : 5_000 },
  // A UAT run (scripts/uat-run.mjs) sets UAT_JOURNAL: the result of each test is then written to that file as well.
  reporter: process.env.UAT_JOURNAL ? [['list'], ['./e2e/support/uat-reporter.ts']] : [['list']],
  outputDir: './e2e/test-results',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    // With projects the channel belongs to the Chromium project: another engine cannot take one.
    ...(channel === undefined || projects.length > 0 ? {} : { channel }),
    deviceScaleFactor: 1,
    locale: 'vi-VN',
  },
  ...(projects.length > 0 ? { projects } : {}),
  globalTeardown: './e2e/support/global-teardown.ts',
  webServer: [
    {
      // The real API over a real database, seeded with the fixture tenants and users (apps/api/test/e2e-stack).
      command: 'node e2e/support/clean-orphans.ts && npm run e2e:stack -w @machvon/api',
      url: `http://127.0.0.1:${apiPort}/__e2e/health`,
      reuseExistingServer: false,
      timeout: 300_000,
      env: { E2E_API_PORT: String(apiPort), E2E_IDP_PORT: String(idpPort), E2E_SESSION_KEY: sessionKey, E2E_STACK_INFO: STACK_INFO_PATH },
    },
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
      url: `http://127.0.0.1:${port}/`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        VITE_DEV_SESSION_KEY: sessionKey,
        VITE_DEV_USERS: JSON.stringify(fixtureUsers),
        VITE_API_BASE_URL: '/api',
        VITE_API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`,
        // Only `?session=oidc` signs in through the provider; every other flow keeps the development session.
        VITE_OIDC_ISSUER: `http://127.0.0.1:${idpPort}/realms/machvon`,
      },
    },
  ],
});
