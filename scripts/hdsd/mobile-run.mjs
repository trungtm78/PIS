import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, cacheDir } from './lib.mjs';
import { Screen, TABS, TAB_Y, adb, back, centre, factsOfNodes, findNode, launch, readScreen, sleep, swipeUp, tap } from './mobile.mjs';
import { composeTour } from './narration.mjs';
import { FFMPEG, narrate } from './tts.mjs';

const CATALOGUE = join('Design', 'MACHVON_Design', '03_Engineering', 'screen_catalog.json');
const PACKAGE = 'vn.machvon.app';
/** The recorder of the phone starts a little after it is asked to, and the voice must not come before the picture. */
const RECORDER_LAG_MS = 700;
const VOICE_DELAY_MS = 400;
const TAIL_MS = 700;

/** The time the steps of a clip take at least: the voice of the step, then a pause. */
export const stepEnd = (startMs, audioMs) => startMs + VOICE_DELAY_MS + audioMs + TAIL_MS;

/** One operation of a step, done on the device the way a person does it. */
async function operate(serial, op, log) {
  if ('clear' in op) {
    adb(serial, 'shell', 'pm', 'clear', PACKAGE);
    adb(serial, 'shell', 'am', 'force-stop', 'com.android.chrome');
    launch(serial);
    await sleep(6000);
  } else if ('relaunch' in op) {
    adb(serial, 'shell', 'am', 'force-stop', PACKAGE);
    launch(serial);
    await sleep(6000);
  } else if ('wait' in op) {
    await sleep(op.wait);
  } else if ('back' in op) {
    back(serial);
    await sleep(1800);
  } else if ('tab' in op) {
    tap(serial, TABS[op.tab], TAB_Y);
    await sleep(2500);
  } else if ('tap' in op) {
    const pattern = new RegExp(op.tap, 'u');
    let nodes = readScreen(serial);
    let target = findNode(nodes, pattern);
    for (let page = 0; target === undefined && op.scroll === true && page < 4; page += 1) {
      swipeUp(serial);
      await sleep(900);
      nodes = readScreen(serial);
      target = findNode(nodes, pattern);
    }
    if (target === undefined) throw new Error(`the screen has nothing named ${op.tap}`);
    tap(serial, ...centre(target));
    await sleep(2500);
  } else if ('sso' in op) {
    const sso = findNode(readScreen(serial), /Đăng nhập bằng SSO/u);
    if (sso === undefined) throw new Error('the sign-in screen has no SSO button');
    tap(serial, ...centre(sso));
    for (let wait = 0; wait < 20; wait += 1) {
      await sleep(3000);
      const nodes = readScreen(serial);
      const chrome = nodes.find((node) => /^Use without an account$|^Sử dụng mà không|^Không, cảm ơn/iu.test(node.label));
      if (chrome !== undefined) tap(serial, ...centre(chrome));
      if (findNode(nodes, /^Chọn đơn vị và vai trò/u) !== undefined) return;
    }
    throw new Error('the sign-in did not reach the choice of the unit');
  } else if ('unit' in op) {
    const unit = findNode(readScreen(serial), new RegExp(`^${op.unit}`, 'u'));
    if (unit === undefined) throw new Error(`no unit named ${op.unit}`);
    tap(serial, ...centre(unit));
    await sleep(1000);
    const next = findNode(readScreen(serial), /^Tiếp tục$/u);
    if (next === undefined) throw new Error('no Continue button');
    tap(serial, ...centre(next));
    await sleep(5000);
  } else if ('mfa' in op) {
    const second = findNode(readScreen(serial), /Xác thực trong trình duyệt/u);
    if (second === undefined) throw new Error('no second factor button');
    tap(serial, ...centre(second));
    for (let wait = 0; wait < 20; wait += 1) {
      await sleep(3000);
      if (findNode(readScreen(serial), /Trang chủ lãnh đạo/u) !== undefined) return;
    }
    throw new Error('the second factor did not reach the home screen');
  } else {
    throw new Error(`unknown operation ${JSON.stringify(op)}`);
  }
  log(`  ${JSON.stringify(op)}`);
}

/** Films one chapter of the phone: first what is on each screen (to write the words), then the voice, then the film itself. */
export async function recordMobile(chapterId, { serial, root = REPO_ROOT, cache = cacheDir(), log = console.log } = {}) {
  const chapters = JSON.parse(readFileSync(join(root, 'scripts', 'hdsd', 'mobile-chapters.json'), 'utf8'));
  const chapter = chapters.find((candidate) => candidate.id === chapterId);
  if (chapter === undefined) throw new Error(`no phone chapter ${chapterId}`);
  const catalogue = new Map(JSON.parse(readFileSync(join(root, CATALOGUE), 'utf8')).map((screen) => [screen.id, screen]));
  const screens = chapter.steps.map((step) => catalogue.get(step.screens[0]));
  if (screens.some((screen) => screen === undefined)) throw new Error('a screen of the chapter is not in the catalogue');

  // 1. What is on the screens now.
  const facts = new Map();
  for (const step of chapter.steps) {
    for (const op of step.ops) await operate(serial, op, log);
    await sleep(1500);
    facts.set(step.screens[0], factsOfNodes(readScreen(serial)));
  }

  // 2. The words and the voice.
  const flow = composeTour({ id: chapter.id, module: chapter.module, group: chapter.title, groupTitle: chapter.group, title: chapter.title, screens: chapter.steps.map((step) => step.screens[0]) }, screens, facts);
  flow.audience = chapter.audience;
  flow.outcome = chapter.outcome;
  flow.platform = 'mobile';
  writeFileSync(join(root, 'scripts', 'hdsd', 'flows', `${chapter.id}.json`), `${JSON.stringify(flow, null, 2)}\n`);
  const audio = narrate(chapter.id, { root, cache, log });

  // 3. The film.
  const dir = join(cache, 'rec', chapter.id);
  mkdirSync(join(dir, 'shots'), { recursive: true });
  const screen = new Screen(serial, dir);
  const timeline = [];
  screen.start();
  const begun = Date.now();
  await sleep(RECORDER_LAG_MS);
  for (const [index, step] of chapter.steps.entries()) {
    const startMs = Date.now() - begun - RECORDER_LAG_MS;
    for (const op of step.ops) await operate(serial, op, log);
    const flowStep = flow.steps[index];
    const voiceMs = startMs + VOICE_DELAY_MS;
    const wanted = stepEnd(startMs, audio.steps[flowStep.id].durationMs);
    const now = Date.now() - begun - RECORDER_LAG_MS;
    if (wanted > now) await sleep(wanted - now);
    const shot = join(dir, 'shots', `${flowStep.id}.png`);
    screen.shot(shot);
    timeline.push({ id: flowStep.id, heading: flowStep.heading, screens: flowStep.screens, startMs, endMs: Date.now() - begun - RECORDER_LAG_MS, voiceMs, shot });
  }
  const pieces = await screen.stop();
  let video = pieces[0];
  if (pieces.length > 1) {
    const list = join(dir, 'pieces.txt');
    writeFileSync(list, pieces.map((piece) => `file '${piece.replace(/\\/gu, '/')}'`).join('\n'));
    video = join(dir, 'joined.mp4');
    spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', video], { encoding: 'utf8' });
  }
  if (!existsSync(video)) throw new Error('the phone recording was not made');
  spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-c', 'copy', join(dir, 'video.mp4')], { encoding: 'utf8' });
  writeFileSync(join(dir, 'timeline.json'), `${JSON.stringify({ flow: chapter.id, timeline }, null, 2)}\n`);
  return { chapter: chapter.id, steps: timeline.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [serial, ...ids] = process.argv.slice(2);
  if (serial === undefined || ids.length === 0) {
    console.error('usage: node scripts/hdsd/mobile-run.mjs <adb serial> <phone chapter id>...');
    process.exitCode = 1;
  } else {
    for (const id of ids) console.log(await recordMobile(id, { serial }));
  }
}
