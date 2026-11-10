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
const fixtureUsers = (JSON.parse(readFileSync(new URL('./e2e/support/e2e-fixtures.json', import.meta.url), 'utf8')) as { users: Array<{ key: string; membershipId: string; audience?: string; roles?: string[]; permissions?: string[] | null }> }).users;
const people = JSON.parse(readFileSync(new URL('./e2e/support/docs-people.json', import.meta.url), 'utf8')) as Person[];
// The development session knows its users by key; the people of the guide have real names and no list of permissions (the API decides what each may do).
const devUsers = people.map((person) => {
  const fixture = fixtureUsers.find((user) => user.key === person.key);
  return {
    key: person.key,
    displayName: person.name,
    initials: person.initials,
    membershipId: fixture?.membershipId,
    // The control-plane screens hold a person to the permissions the fixture lists; the people of a tenant are left to the API.
    permissions: fixture?.audience === 'control' ? (fixture.permissions ?? null) : null,
    // The platform operator signs in on the control plane: a token of the control audience with its realm roles.
    ...(fixture?.audience === 'control' ? { audience: 'control', roles: fixture.roles ?? [] } : {}),
  };
});

const servers = (Array.isArray(base.webServer) ? base.webServer : base.webServer === undefined ? [] : [base.webServer]).map((server, index) => ({
  ...server,
  env: { ...server.env, ...(index === 0 ? { E2E_SEED: 'docs' } : { VITE_DEV_USERS: JSON.stringify(devUsers) }) },
}));

const config: PlaywrightTestConfig = {
  ...base,
  testDir: './e2e/hdsd',
  timeout: 600_000,
  // The clips that make the data run one after the other (each needs what the one before made); the tours only read it, so two of them are filmed at a time.
  workers: 2,
  projects: [
    { name: 'dang-nhap', testMatch: '01-*.hdsd.ts' },
    { name: 'dia-ban', testMatch: '02-*.hdsd.ts', dependencies: ['dang-nhap'] },
    { name: 'du-an', testMatch: '03-*.hdsd.ts', dependencies: ['dia-ban'] },
    // Not a clip: the business data every other screen of the tours shows, made through the commands of the product (e2e/hdsd/seed).
    { name: 'du-lieu', testMatch: '04-*.hdsd.ts', dependencies: ['du-an'] },
    { name: 'tham-quan', testMatch: 'tours.hdsd.ts', dependencies: ['du-lieu'], fullyParallel: true },
  ],
  // A chapter that failed is filmed once more (a service that was busy, a page that was slow); a chapter that still fails does not stop the others.
  retries: 1,
  reporter: [['list']],
  outputDir: './e2e/test-results-hdsd',
  webServer: servers,
};

export default defineConfig(config);
