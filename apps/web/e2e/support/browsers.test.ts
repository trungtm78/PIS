import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { BASELINE_ONLY, BrowserSelectionError, CROSS_BROWSER_SMOKE, ENGINES, browserProjects, engineIgnore, selectedEngines } from './browsers.ts';

const E2E_DIR = join(import.meta.dirname, '..');
const WEB_DIR = join(E2E_DIR, '..');

test('without E2E_BROWSERS there is no project: the single default run is unchanged', () => {
  assert.deepEqual(selectedEngines({}), []);
  assert.deepEqual(selectedEngines({ E2E_BROWSERS: '' }), []);
  assert.deepEqual(selectedEngines({ E2E_BROWSERS: '  ' }), []);
  assert.deepEqual(browserProjects({}, 'chrome'), []);
});

test('the engines asked for are read in a stable order, once each, without regard to case and spaces', () => {
  assert.deepEqual(selectedEngines({ E2E_BROWSERS: 'webkit, Firefox ,chromium,firefox' }), ['chromium', 'firefox', 'webkit']);
  assert.deepEqual(selectedEngines({ E2E_BROWSERS: 'webkit' }), ['webkit']);
  assert.deepEqual(selectedEngines({ E2E_BROWSERS: ',firefox,' }), ['firefox']);
});

test('an engine that does not exist is an error and is named', () => {
  assert.throws(() => selectedEngines({ E2E_BROWSERS: 'chromium,edge,opera' }), (error: unknown) => error instanceof BrowserSelectionError && /edge, opera/.test(error.message));
});

test('chromium keeps the whole suite and the channel of the default run; the other engines run the smoke subset only', () => {
  const projects = browserProjects({ E2E_BROWSERS: 'chromium,firefox,webkit' }, 'chrome');
  assert.deepEqual(projects.map((project) => project.name), ['chromium', 'firefox', 'webkit']);
  assert.deepEqual(projects[0], { name: 'chromium', testMatch: '**/*.spec.ts', use: { browserName: 'chromium', channel: 'chrome' } });
  for (const project of projects.slice(1)) {
    assert.deepEqual(project.testMatch, CROSS_BROWSER_SMOKE.map((name) => `**/${name}`));
    assert.deepEqual(project.testIgnore, BASELINE_ONLY.map((name) => `**/${name}`));
    assert.equal('channel' in project.use, false, 'a channel is for Chromium only');
  }
  assert.equal('channel' in browserProjects({ E2E_BROWSERS: 'chromium' }, undefined)[0]!.use, false);
});

test('E2E_BROWSER_SCOPE=full gives the other engines the whole suite, minus the specs of the baseline engine', () => {
  const [firefox] = browserProjects({ E2E_BROWSERS: 'firefox', E2E_BROWSER_SCOPE: 'full' }, undefined);
  assert.equal(firefox?.testMatch, '**/*.spec.ts');
  assert.deepEqual(firefox?.testIgnore, engineIgnore('firefox'));
  assert.deepEqual(engineIgnore('chromium'), []);
});

test('every smoke spec and every baseline-only spec exists, and no spec is in both lists', () => {
  for (const name of [...CROSS_BROWSER_SMOKE, ...BASELINE_ONLY]) assert.ok(existsSync(join(E2E_DIR, name)), `${name} is not in apps/web/e2e`);
  assert.deepEqual(CROSS_BROWSER_SMOKE.filter((name) => BASELINE_ONLY.includes(name)), []);
  assert.ok(CROSS_BROWSER_SMOKE.length >= 3);
});

test('the engines are the three Playwright engines', () => {
  assert.deepEqual([...ENGINES], ['chromium', 'firefox', 'webkit']);
});

test('the shared configuration uses the helper and keeps the channel for the default run only; the recording of the guide stays on its own projects', () => {
  const shared = readFileSync(join(WEB_DIR, 'playwright.config.ts'), 'utf8');
  assert.match(shared, /browserProjects\(process\.env, channel\)/);
  assert.match(shared, /channel === undefined \|\| projects\.length > 0/);
  assert.match(shared, /projects\.length > 0 \? \{ projects \}/);
  const guide = readFileSync(join(WEB_DIR, 'playwright.hdsd.config.ts'), 'utf8');
  assert.match(guide, /\r?\n {2}projects: \[/, 'the recording of the guide defines its own projects, so E2E_BROWSERS does not touch it');
});

test('the script e2e:smoke runs the smoke specs and nothing else', () => {
  const pkg = JSON.parse(readFileSync(join(WEB_DIR, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  const command = pkg.scripts['e2e:smoke'];
  assert.ok(command !== undefined, 'e2e:smoke is missing');
  assert.match(command, /^playwright test /);
  for (const name of CROSS_BROWSER_SMOKE) assert.ok(command.includes(`e2e/${name}`), `${name} is not in e2e:smoke`);
  assert.equal(command.split(/\s+/).filter((part) => part.startsWith('e2e/')).length, CROSS_BROWSER_SMOKE.length);
});
