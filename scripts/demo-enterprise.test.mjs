import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_PORTS,
  DEMO_PERSONAS,
  buildDevUsers,
  buildStackEnv,
  buildWebEnv,
  busyMessage,
  busyPorts,
  loginHint,
  loginUrl,
  lowMemoryWarning,
  nodeVersionOk,
  parseArgs,
  plannedSteps,
  resolvePorts,
  waitForUrl,
} from './demo-enterprise.mjs';

test('parseArgs reads flags and values, and names what it does not know', () => {
  assert.deepEqual(parseArgs([]).flags, { open: false, seed: true, dryRun: false, help: false });
  const { flags, bad } = parseArgs(['--web-port', '6000', '--no-seed', '--open', '--dry-run']);
  assert.equal(flags.webPort, '6000');
  assert.equal(flags.seed, false);
  assert.equal(flags.open, true);
  assert.equal(flags.dryRun, true);
  assert.deepEqual(bad, []);
  assert.equal(parseArgs(['--nope']).bad.length, 1);
  assert.equal(parseArgs(['--api-port']).bad.length, 1);
  assert.equal(parseArgs(['--api-port', '--open']).bad.length, 1);
});

test('resolvePorts: option, then environment, then default; refuses nonsense and clashes', () => {
  assert.deepEqual(resolvePorts({}, {}), { ports: DEFAULT_PORTS, bad: [] });
  assert.equal(resolvePorts({ webPort: '6001' }, { DEMO_WEB_PORT: '6002' }).ports.web, 6001);
  assert.equal(resolvePorts({}, { DEMO_API_PORT: '6003' }).ports.api, 6003);
  assert.equal(resolvePorts({ webPort: 'abc' }, {}).bad.length, 1);
  assert.equal(resolvePorts({ webPort: '80' }, {}).bad.length, 1);
  assert.equal(resolvePorts({ webPort: '47311' }, {}).bad.length, 1);
});

test('buildStackEnv is the enterprise window of docs/clip-data.md', () => {
  const env = buildStackEnv({ ports: DEFAULT_PORTS, sessionKey: 'k', infoPath: 'x/info.json' });
  assert.equal(env.MACHVON_EDITION, 'enterprise');
  assert.equal(env.E2E_SEED, 'docs');
  assert.equal(env.DEMO_FORMS, 'true');
  assert.equal(env.E2E_API_PORT, '47311');
  assert.equal(env.E2E_IDP_PORT, '47312');
  assert.equal(env.E2E_SESSION_KEY, 'k');
  assert.equal(env.E2E_STACK_INFO, 'x/info.json');
});

test('buildDevUsers puts the people on the fixture memberships; buildWebEnv carries them to the web', () => {
  const users = buildDevUsers([{ key: 'owner', membershipId: 'm1' }], [{ key: 'owner', name: 'An', initials: 'VA' }, { key: 'ghost', name: 'G', initials: 'G' }]);
  assert.deepEqual(users[0], { key: 'owner', displayName: 'An', initials: 'VA', membershipId: 'm1', permissions: null });
  assert.equal(users[1].membershipId, undefined);
  const env = buildWebEnv({ ports: DEFAULT_PORTS, sessionKey: 'k', devUsers: users });
  assert.equal(env.VITE_EDITION, 'enterprise');
  assert.equal(env.VITE_API_BASE_URL, '/api');
  assert.equal(env.VITE_API_PROXY_TARGET, 'http://127.0.0.1:47311');
  assert.equal(JSON.parse(env.VITE_DEV_USERS)[0].key, 'owner');
});

test('the personas are people of the docs stack, and the sign-in address names them', () => {
  assert.ok(DEMO_PERSONAS.length >= 4);
  assert.equal(loginUrl(5173, DEMO_PERSONAS[0]), 'http://127.0.0.1:5173/home/home-09?devUser=owner');
  const hint = loginHint(5173);
  for (const persona of DEMO_PERSONAS) assert.ok(hint.includes(`devUser=${persona.key}`));
});

test('lowMemoryWarning only speaks when memory is short', () => {
  assert.equal(lowMemoryWarning(8 * 1024 ** 3), undefined);
  assert.match(lowMemoryWarning(1 * 1024 ** 3), /1\.0 GB/u);
});

test('nodeVersionOk', () => {
  assert.equal(nodeVersionOk('v24.20.0'), true);
  assert.equal(nodeVersionOk('v22.1.0'), false);
  assert.equal(nodeVersionOk('garbage'), false);
});

test('busyPorts lists the busy ones and busyMessage says how to go on', async () => {
  const busy = await busyPorts({ web: 1, api: 2, idp: 3 }, (port) => Promise.resolve(port === 2));
  assert.deepEqual(busy, [{ name: 'api', port: 2 }]);
  const message = busyMessage(busy);
  assert.match(message, /api 2/u);
  assert.match(message, /--api-port/u);
  assert.deepEqual(await busyPorts({ web: 1 }, () => Promise.resolve(false)), []);
});

test('plannedSteps drops the seed step on --no-seed', () => {
  assert.equal(plannedSteps({ seed: true, ports: DEFAULT_PORTS }).length, 3);
  assert.match(plannedSteps({ seed: false, ports: DEFAULT_PORTS })[1], /no-seed/u);
});

test('waitForUrl returns true on a success, false on timeout or when the child ended', async () => {
  let calls = 0;
  const flaky = () => (++calls < 3 ? Promise.reject(new Error('down')) : Promise.resolve({ ok: true }));
  assert.equal(await waitForUrl('http://x', { timeoutMs: 2000, fetchImpl: flaky, intervalMs: 5 }), true);
  assert.equal(await waitForUrl('http://x', { timeoutMs: 30, fetchImpl: () => Promise.reject(new Error('down')), intervalMs: 5 }), false);
  assert.equal(await waitForUrl('http://x', { timeoutMs: 2000, child: { exitCode: 1 }, fetchImpl: () => Promise.resolve({ ok: true }), intervalMs: 5 }), false);
});
