import assert from 'node:assert/strict';
import test from 'node:test';
import { PWA_SCREENS, STANDALONE_SCRIPT, indexEntry } from './record/pwa.mjs';

test('the PWA recording visits the four installed-application screens in order', () => {
  assert.deepEqual(PWA_SCREENS.map((screen) => screen.id), ['PWA-01', 'PWA-02', 'PWA-03', 'PWA-04']);
  assert.ok(PWA_SCREENS.every((screen) => screen.path.startsWith('/m')));
});

test('the page script answers display-mode standalone with true and leaves other queries alone', () => {
  assert.match(STANDALONE_SCRIPT, /display-mode/u);
  assert.match(STANDALONE_SCRIPT, /standalone/u);
});

test('an index entry names the edition and the scene', () => {
  const [key, entry] = indexEntry({ name: 'ent-pwa-all.enterprise', edition: 'enterprise', file: 'x.mp4', durationMs: 1000, persona: 'capApprover', headline: 'h' });
  assert.equal(key, 'ent-pwa-all.enterprise');
  assert.equal(entry.scene, 'ent-pwa-all');
  assert.equal(entry.edition, 'enterprise');
});
