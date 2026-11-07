import { readFileSync } from 'node:fs';
import { defineConfig } from '@playwright/test';
import type { PlaywrightTestConfig } from '@playwright/test';
import base from './playwright.config.ts';

/**
 * The recording of the clips of the user guide (e2e/hdsd/*.hdsd.ts): the same API stack, identity provider and web server as the browser flows, one clip at a time.
 * The stack starts in its docs mode (E2E_SEED=docs): the tenants, the units and seven people with real names, and no business data: the clips make it.
 * Run it with `npx playwright test -c playwright.hdsd.config.ts`; the voice is made by the recording itself (scripts/hdsd/tts.mjs).
 */
interface Person {
  key: string;
  name: string;
  initials: string;
  membershipId?: string;
}
const fixtureUsers = (JSON.parse(readFileSync(new URL('./e2e/support/e2e-fixtures.json', import.meta.url), 'utf8')) as { users: Array<{ key: string; membershipId: string }> }).users;
const people = JSON.parse(readFileSync(new URL('./e2e/support/docs-people.json', import.meta.url), 'utf8')) as Person[];
// The development session knows its users by key; the people of the guide have real names and no list of permissions (the API decides what each may do).
const devUsers = people.map((person) => ({
  key: person.key,
  displayName: person.name,
  initials: person.initials,
  membershipId: fixtureUsers.find((user) => user.key === person.key)?.membershipId,
  permissions: null,
}));

const servers = (Array.isArray(base.webServer) ? base.webServer : base.webServer === undefined ? [] : [base.webServer]).map((server, index) => ({
  ...server,
  env: { ...server.env, ...(index === 0 ? { E2E_SEED: 'docs' } : { VITE_DEV_USERS: JSON.stringify(devUsers) }) },
}));

const config: PlaywrightTestConfig = {
  ...base,
  testDir: './e2e/hdsd',
  testMatch: '**/*.hdsd.ts',
  timeout: 600_000,
  // A chapter that failed is filmed once more (a service that was busy, a page that was slow); a chapter that still fails does not stop the others.
  retries: 1,
  reporter: [['list']],
  outputDir: './e2e/test-results-hdsd',
  webServer: servers,
};

export default defineConfig(config);
