import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baselinesFolder, visualGate } from './visual-baselines.ts';

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
