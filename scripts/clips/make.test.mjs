import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { captionsAss, viewsOf } from './make.mjs';
import { parseSelect, selectValue, tokenFor } from './manifest.mjs';
import { edgeKey } from './tts-edge.mjs';

test('selectValue follows keys, filters and indexes', () => {
  const answer = { tiles: [{ metric_code: 'A', value: '1' }, { metric_code: 'B', value: '48.1' }], stuck: [{ days: 49 }], totals: { cells: { n: 5 } } };
  assert.equal(selectValue(answer, 'tiles[metric_code=B].value'), '48.1');
  assert.equal(selectValue(answer, 'stuck[0].days'), 49);
  assert.equal(selectValue(answer, 'totals.cells.n'), 5);
  assert.equal(selectValue(answer, 'tiles[metric_code=Z].value'), undefined);
  assert.equal(selectValue(answer, 'nothing.here'), undefined);
  assert.throws(() => parseSelect('a..b'), /cannot read the path/u);
});

test('the development token carries the tenant and the membership and is signed', () => {
  const token = tokenFor({ key: Buffer.from('k'.repeat(32)).toString('base64'), tenantId: 't', membershipId: 'm', now: 1_000_000 });
  const [payload, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')), { tenantId: 't', membershipId: 'm', scopeVersion: 1, exp: 1600 });
  assert.ok(signature.length > 20);
});

test('the views of a scene are its opened screens with the persona that opens them; unknown people become the leader', () => {
  const scene = { screen: { screens: ['HOME-09', 'HOME-01', 'DIS-23'] }, steps: [{ do: 'as', persona: 'bidManager' }, { do: 'open', screen: 'HOME-09' }, { do: 'spot' }, { do: 'as', persona: 'treasuryMaker' }, { do: 'open', screen: 'HOME-01' }] };
  assert.deepEqual(viewsOf(scene), [
    { screen: 'HOME-09', persona: 'capApprover' },
    { screen: 'HOME-01', persona: 'treasuryMaker' },
    { screen: 'DIS-23', persona: 'treasuryMaker' },
  ]);
});

test('captions are written as an ASS file with times from the start of the scene, and nothing for a scene without captions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clip-ass-'));
  assert.equal(captionsAss([], 0, join(dir, 'a.ass')), null);
  const file = captionsAss([{ startMs: 11_000, endMs: 14_500, text: 'x' }], 10_000, join(dir, 'b.ass'));
  assert.match(readFileSync(file, 'utf8'), /Dialogue: 0,0:00:01\.00,0:00:04\.50,Caption/u);
});

test('the key of the fallback voice depends on the voice and on the spoken text', () => {
  assert.notEqual(edgeKey('a'), edgeKey('b'));
  assert.notEqual(edgeKey('a', 'v1'), edgeKey('a', 'v2'));
});
