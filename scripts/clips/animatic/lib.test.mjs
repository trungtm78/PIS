import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  APP_CSS, DATA_DIR, FPS, contentTypeOf, encodeArgs, enoughMemory, fontFacesFrom, frameCount, frameSchedule, frameTimeMs, listScenes, loadScene, pageHtml, parseArgs, parseVideoInfo, resolveStatic, sceneFile,
} from './lib.mjs';
import { join, sep } from 'node:path';

test('a scene has one frame for every 1/30 second and the frame times are exact', () => {
  assert.equal(frameCount(3000), 90);
  assert.equal(frameCount(1000, 25), 25);
  assert.equal(frameTimeMs(0), 0);
  assert.equal(frameTimeMs(3), 100);
  assert.equal(frameTimeMs(89), (89 * 1000) / 30);
  assert.throws(() => frameCount(0), /positive/);
  assert.throws(() => frameCount(1000, 0), /positive/);
});

test('the schedule lists every frame once, in order, and a smoke render can cap it', () => {
  const all = frameSchedule(3000, FPS);
  assert.equal(all.length, 90);
  assert.deepEqual(all[0], { index: 0, tMs: 0 });
  assert.deepEqual(all.map((frame) => frame.index), Array.from({ length: 90 }, (_, index) => index));
  assert.ok(all.every((frame, index) => index === 0 || frame.tMs > all[index - 1].tMs));
  assert.equal(frameSchedule(3000, FPS, 10).length, 10);
  assert.equal(frameSchedule(3000, FPS, 1000).length, 90);
});

test('ffmpeg is asked for 1920x1080 yuv420p H.264 at the frame rate, from a pipe of pictures, with no audio', () => {
  const args = encodeArgs({ out: 'x.mp4' });
  const text = args.join(' ');
  assert.match(text, /-framerate 30 -c:v png -i -/u);
  assert.match(text, /scale=1920:1080/u);
  assert.match(text, /format=yuv420p/u);
  assert.match(text, /-c:v libx264/u);
  assert.match(text, /-r 30/u);
  assert.ok(args.includes('-an'));
  assert.equal(args.at(-1), 'x.mp4');
  assert.match(encodeArgs({ out: 'y.mp4', fps: 25 }).join(' '), /-framerate 25/u);
  assert.throws(() => encodeArgs({ out: '' }), /output file/);
});

test('a browser is started only when 2.5 GB of memory is free', () => {
  assert.equal(enoughMemory(3 * 1024 ** 3), true);
  assert.equal(enoughMemory(2.4 * 1024 ** 3), false);
  assert.equal(enoughMemory(0.3 * 1024 ** 3), false);
  assert.equal(enoughMemory(1.2 * 1024 ** 3, 1), true);
});

test('the clip is set in the font of the web app: its font rules are taken as they are', () => {
  const rules = fontFacesFrom(readFileSync(APP_CSS, 'utf8'));
  assert.equal((rules.match(/@font-face/gu) ?? []).length, 12);
  assert.match(rules, /be-vietnam-pro-vietnamese-700\.woff2/u);
  assert.match(rules, /unicode-range: U\+0102-0103/u);
  assert.equal(fontFacesFrom('@font-face{font-family:"Other";src:url(a)}'), '');
});

test('the page server gives files only from its own directories', () => {
  const roots = { '/static/': join(DATA_DIR, '..'), '/fonts/': join(DATA_DIR, '..', 'fonts-dir') };
  assert.ok(resolveStatic('/static/stage.css', roots)?.endsWith(`animatic${sep}stage.css`));
  assert.ok(resolveStatic('/static/scenes/kit.mjs?x=1', roots)?.endsWith(`scenes${sep}kit.mjs`));
  assert.equal(resolveStatic('/static/../lib.mjs', roots), null);
  assert.equal(resolveStatic('/static/../../../package.json', roots), null);
  assert.equal(resolveStatic('/static/%2e%2e/%2e%2e/%2e%2e/package.json', roots), null);
  assert.equal(resolveStatic('/other/file', roots), null);
  assert.equal(contentTypeOf('a.woff2'), 'font/woff2');
  assert.equal(contentTypeOf('a.mjs'), 'text/javascript; charset=utf-8');
  assert.equal(contentTypeOf('a.bin'), 'application/octet-stream');
});

test('the page holds the tokens, the fonts and the stage, and loads the runtime', () => {
  const html = pageHtml({ tokensCss: ':root{--a:1}', fontCss: '@font-face{}', stageCss: '.x{}' });
  assert.match(html, /:root\{--a:1\}/u);
  assert.match(html, /<div id="stage">/u);
  assert.match(html, /src="\/static\/runtime\.mjs"/u);
});

test('flags: values, switches and positional words', () => {
  const { positional, flags } = parseArgs(['title-public', '--out', 'a.mp4', '--no-fade', '--max-seconds', '3']);
  assert.deepEqual(positional, ['title-public']);
  assert.deepEqual(flags, { out: 'a.mp4', 'no-fade': true, 'max-seconds': '3' });
});

test('scenes are found by name in data/ or by path, and a missing one is named', () => {
  assert.equal(sceneFile('progress-tree'), join(DATA_DIR, 'progress-tree.json'));
  assert.equal(sceneFile('C:/x/y.json').replaceAll('\\', '/').endsWith('x/y.json'), true);
  assert.ok(listScenes().includes('smoke-title'));
  assert.equal(loadScene('smoke-title').durationMs, 3000);
  assert.equal(loadScene('smoke-title', { fadeMs: 0 }).fadeMs, 0);
  assert.throws(() => loadScene('no-such-scene'), /no scene file/);
});

test('the facts of a render are read from what ffmpeg prints about it', () => {
  const printed = [
    'Input #0, mov,mp4,m4a,3gp,3g2,mj2, from \'x.mp4\':',
    '  Duration: 00:00:03.00, start: 0.000000, bitrate: 1433 kb/s',
    '  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 1431 kb/s, 30 fps, 30 tbr, 15360 tbn (default)',
  ].join('\n');
  assert.deepEqual(parseVideoInfo(printed), { codec: 'h264', width: 1920, height: 1080, fps: 30, durationMs: 3000, pixelFormat: 'yuv420p' });
  assert.throws(() => parseVideoInfo('Duration: 00:00:03.00'), /no video stream/);
});
