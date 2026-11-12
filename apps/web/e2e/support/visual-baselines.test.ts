import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baselinesFolder, missingBaselinesReason, visualGate } from './visual-baselines.ts';

test('Windows keeps the committed baselines, which Google Chrome on Windows rendered', () => {
  assert.equal(baselinesFolder('win32', {}), 'visual-baselines');
});

test('every other OS has a folder of its own, because its text is drawn differently', () => {
  assert.equal(baselinesFolder('linux', {}), 'visual-baselines-linux');
  assert.equal(baselinesFolder('darwin', {}), 'visual-baselines-darwin');
});

test('E2E_VISUAL_BASELINES names the folder, and an empty value changes nothing', () => {
  assert.equal(baselinesFolder('linux', { E2E_VISUAL_BASELINES: 'elsewhere' }), 'elsewhere');
  assert.equal(baselinesFolder('linux', { E2E_VISUAL_BASELINES: '' }), 'visual-baselines-linux');
});

test('without baselines the visual cases are skipped when optional and FAIL when required; with baselines or while rendering them they run', () => {
  assert.equal(visualGate({ updating: false, required: false, baselinesExist: false }), 'skip');
  assert.equal(visualGate({ updating: false, required: true, baselinesExist: false }), 'fail');
  assert.equal(visualGate({ updating: false, required: true, baselinesExist: true }), 'run');
  assert.equal(visualGate({ updating: false, required: false, baselinesExist: true }), 'run');
  assert.equal(visualGate({ updating: true, required: true, baselinesExist: false }), 'run');
});

test('the enterprise edition has baselines of its own: it never compares with the pixels of the public edition', () => {
  assert.equal(baselinesFolder('win32', { MACHVON_EDITION: 'enterprise' }), 'visual-baselines-enterprise');
  assert.equal(baselinesFolder('linux', { VITE_EDITION: 'enterprise' }), 'visual-baselines-enterprise-linux');
  assert.equal(baselinesFolder('win32', { MACHVON_EDITION: 'public' }), 'visual-baselines');
  assert.notEqual(baselinesFolder('win32', { MACHVON_EDITION: 'enterprise' }), baselinesFolder('win32', {}));
});

test('an explicit folder wins over the edition, and says so by being the owner of the choice', () => {
  assert.equal(baselinesFolder('win32', { MACHVON_EDITION: 'enterprise', E2E_VISUAL_BASELINES: 'elsewhere' }), 'elsewhere');
});

test('the reason names the edition and the folder that had no baselines', () => {
  const reason = missingBaselinesReason('visual-baselines-enterprise', 'enterprise');
  assert.match(reason, /enterprise edition/);
  assert.match(reason, /visual-baselines-enterprise/);
  assert.match(missingBaselinesReason('visual-baselines', 'public'), /public edition/);
});
