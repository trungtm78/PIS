import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { answerFor, commandNames, readMode, setPersona, startProxy, writeMode } from './mobile-data.mjs';

test('in a mode the proxy answers what the service would answer, and passes on everything else; the paths of the stack are never answered', () => {
  assert.equal(answerFor('ok', 'GET', '/resources/project'), undefined);
  assert.equal(answerFor('service-down', 'GET', '/resources/project').status, 500);
  assert.equal(JSON.parse(answerFor('service-down', 'GET', '/me/sessions').body).code, 'INTERNAL_ERROR');
  assert.equal(answerFor('service-down', 'GET', '/__e2e/health'), undefined);
  assert.equal(JSON.parse(answerFor('licence-expired', 'GET', '/resources/project').body).code, 'LICENSE_EXPIRED');
  assert.equal(answerFor('licence-expired', 'POST', '/reports'), undefined);
  assert.equal(answerFor('maintenance', 'GET', '/resources/project'), undefined);
  const policy = JSON.parse(answerFor('maintenance', 'GET', '/mobile/version-policy', new Date('2026-11-08T01:00:00Z')).body);
  assert.deepEqual(policy, { status: 'maintenance', reason_code: 'MAINTENANCE_WINDOW', maintenance: { starts_at: '2026-11-08T01:00:00.000Z', ends_at: '2026-11-08T03:00:00.000Z' } });
});

test('the mode is kept in a file; a mode that is not known is refused and a missing file means ok', () => {
  const cache = mkdtempSync(join(tmpdir(), 'hdsd-mode-'));
  try {
    assert.equal(readMode(cache), 'ok');
    writeMode('maintenance', cache);
    assert.equal(readMode(cache), 'maintenance');
    assert.throws(() => writeMode('fire', cache), /unknown mode/u);
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test('the person who signs in next is written next to the info of the stack, and only a person of the fixtures', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hdsd-persona-'));
  try {
    setPersona('nobody', join(dir, 'stack-info.json'));
    assert.equal(readFileSync(join(dir, 'stack-info.json.user'), 'utf8'), 'nobody');
    assert.throws(() => setPersona('stranger', join(dir, 'stack-info.json')), /no fixture person/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the proxy passes a call to the API and answers instead of it in a mode', async () => {
  const cache = mkdtempSync(join(tmpdir(), 'hdsd-proxy-'));
  const api = createServer((request, reply) => reply.end(`api:${request.url}`));
  await new Promise((done) => api.listen(0, '127.0.0.1', done));
  const proxy = await startProxy({ listen: 0, target: api.address().port, cache });
  const ask = async (path) => {
    const response = await fetch(`http://127.0.0.1:${proxy.address().port}${path}`);
    return [response.status, await response.text()];
  };
  try {
    assert.deepEqual(await ask('/resources/project?limit=1'), [200, 'api:/resources/project?limit=1']);
    writeMode('service-down', cache);
    assert.equal((await ask('/resources/project'))[0], 500);
    assert.equal((await ask('/__e2e/health'))[0], 200);
    writeMode('ok', cache);
    assert.equal((await ask('/resources/project'))[0], 200);
  } finally {
    proxy.close();
    api.close();
    rmSync(cache, { recursive: true, force: true });
  }
});

test('the commands that the chapters call exist', () => {
  for (const name of ['persona', 'denied', 'revoke-session', 'service-down', 'licence-expired', 'licence-ok', 'maintenance', 'ok', 'conflict', 'proxy']) assert.ok(commandNames.includes(name), name);
});
