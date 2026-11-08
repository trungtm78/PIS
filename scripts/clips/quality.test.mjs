import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeVideo, findings, openFreeze, parseBlackDetect, parseDuration, parseFreezeDetect, sceneAt } from './quality.mjs';

const LOG = `  Duration: 00:01:40.50, start: 0.000000, bitrate: 1200 kb/s
[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 12.5
[freezedetect @ 0x1] lavfi.freezedetect.freeze_duration: 9.25
[freezedetect @ 0x1] lavfi.freezedetect.freeze_end: 21.75
[blackdetect @ 0x2] black_start:30 black_end:32.4 black_duration:2.4
[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 95`;

test('freeze and black windows are read from the log, and a freeze that never ended is closed at the end of the film', () => {
  assert.deepEqual(parseFreezeDetect(LOG), [{ startSec: 12.5, endSec: 21.75, durationSec: 9.25 }]);
  assert.deepEqual(parseBlackDetect(LOG), [{ startSec: 30, endSec: 32.4, durationSec: 2.4 }]);
  assert.equal(parseDuration(LOG), 100.5);
  assert.equal(openFreeze(LOG), 95);
  const analysis = analyzeVideo('f.mp4', { runner: () => ({ status: 0, stderr: LOG }) });
  assert.equal(analysis.freezes.length, 2);
  assert.deepEqual(analysis.freezes[1], { startSec: 95, endSec: 100.5, durationSec: 5.5 });
  assert.throws(() => analyzeVideo('f.mp4', { runner: () => ({ status: 1, stderr: 'boom' }) }), /quality pass failed/u);
});

test('findings name the scene, put page problems first and ignore short holds', () => {
  const timeline = { scenes: [{ id: 'a', startMs: 0, endMs: 25000 }, { id: 'b', startMs: 25000, endMs: 60000 }] };
  const analysis = { freezes: [{ startSec: 12.5, endSec: 21.75, durationSec: 9.25 }, { startSec: 40, endSec: 44, durationSec: 4 }], blacks: [{ startSec: 30, endSec: 32.4, durationSec: 2.4 }] };
  const makeReport = { scenes: [{ id: 'b', problems: ['HOME-09: banner "Không tải được"'], steps: { total: 4, lines: [{ status: 'skipped', reason: 'not visible on the screen' }, { status: 'skipped', reason: 'no binding for this ref' }, { status: 'skipped', reason: 'not visible' }, { status: 'replayed' }] } }] };
  const list = findings(analysis, { timeline, makeReport });
  assert.deepEqual(list.map((item) => [item.level, item.kind, item.scene]), [['error', 'page', 'b'], ['warn', 'frozen', 'a'], ['warn', 'black', 'b'], ['info', 'steps', 'b']]);
  assert.equal(sceneAt(timeline, 30), 'b');
  assert.equal(sceneAt(timeline, 99), null);
  assert.deepEqual(findings({ freezes: [], blacks: [] }), []);
});
