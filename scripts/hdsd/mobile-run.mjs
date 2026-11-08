import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, cacheDir } from './lib.mjs';
import { Screen, TABS, TAB_Y, adb, applyOverrides, back, centre, chapterProblems, factsOfNodes, filmMsOf, findNode, inputTextOf, launch, opNameOf, readScreen, sameBounds, sleep, swipeUp, tap, uiPattern } from './mobile.mjs';
import { composeTour } from './narration.mjs';
import { FFMPEG, narrate, probeMs } from './tts.mjs';

const CATALOGUE = join('Design', 'MACHVON_Design', '03_Engineering', 'screen_catalog.json');
const PACKAGE = 'vn.machvon.app';
/** The recorder of the phone starts a little after it is asked to, and the voice must not come before the picture. */
const RECORDER_LAG_MS = 700;
const VOICE_DELAY_MS = 400;
const TAIL_MS = 700;
/** A piece of the film older than this is closed and a new one begun at the next step: the recorder stops by itself at three minutes. */
const PIECE_LIMIT_MS = 120_000;
/** How long a screen is given to show what a step looks for. */
const SEE_TIMEOUT_MS = 15_000;


/** A node of the screen that matches, waited for: a screen that is loading shows it late, and moves it while it loads, so it must stand still for two looks. */
async function settled(serial, pattern, { scroll = false, timeoutMs = SEE_TIMEOUT_MS } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    let nodes = readScreen(serial);
    let target = findNode(nodes, pattern);
    for (let page = 0; target === undefined && scroll && page < 4; page += 1) {
      swipeUp(serial);
      await sleep(900);
      nodes = readScreen(serial);
      target = findNode(nodes, pattern);
    }
    if (target !== undefined) {
      await sleep(600);
      const again = findNode(readScreen(serial), pattern);
      if (sameBounds(target, again)) return again;
    }
    if (Date.now() > until) return undefined;
    await sleep(800);
  }
}

/** One operation of a step, done on the device the way a person does it. `recorder` is given while the film is made: it stops and starts the film. */
export async function operate(serial, op, log, recorder) {
  const name = opNameOf(op);
  if (name === 'clear') {
    adb(serial, 'shell', 'pm', 'clear', PACKAGE);
    adb(serial, 'shell', 'am', 'force-stop', 'com.android.chrome');
    launch(serial);
    await sleep(6000);
  } else if (name === 'relaunch') {
    adb(serial, 'shell', 'am', 'force-stop', PACKAGE);
    launch(serial);
    await sleep(6000);
  } else if (name === 'wait') {
    await sleep(op.wait);
  } else if (name === 'back') {
    back(serial);
    await sleep(1800);
  } else if (name === 'tab') {
    tap(serial, TABS[op.tab], TAB_Y);
    await sleep(2500);
  } else if (name === 'scroll') {
    for (let page = 0; page < Number(op.scroll); page += 1) {
      swipeUp(serial);
      await sleep(900);
    }
  } else if (name === 'tap') {
    if (typeof op.open === 'string' && findNode(readScreen(serial), new RegExp(op.tap, 'u')) === undefined) {
      // The row is inside a group that is closed (it may have been left open by an earlier visit, so it is opened only when the row is not there).
      const group = await settled(serial, new RegExp(op.open, 'u'), { scroll: true });
      if (group === undefined) throw new Error(`the screen has nothing named ${op.open}`);
      tap(serial, ...centre(group));
      await sleep(1200);
    }
    const target = await settled(serial, new RegExp(op.tap, 'u'), { scroll: op.scroll === true });
    if (target === undefined) throw new Error(`the screen has nothing named ${op.tap}`);
    tap(serial, ...centre(target));
    await sleep(2500);
  } else if (name === 'see') {
    const found = await settled(serial, new RegExp(op.see, 'u'), { timeoutMs: op.timeout ?? SEE_TIMEOUT_MS });
    if (found === undefined) throw new Error(`the screen does not show ${op.see}`);
  } else if (name === 'fill') {
    for (const [field, text] of Object.entries(op.fill)) {
      const target = await settled(serial, new RegExp(field, 'u'), { scroll: true });
      if (target === undefined) throw new Error(`the screen has no field named ${field}`);
      tap(serial, ...centre(target));
      await sleep(600);
      adb(serial, 'shell', 'input', 'text', inputTextOf(String(text)));
      await sleep(500);
    }
  } else if (name === 'hideKeyboard') {
    const shown = adb(serial, 'shell', 'dumpsys', 'input_method').stdout.includes('mInputShown=true');
    if (shown) back(serial);
    await sleep(900);
  } else if (name === 'airplane') {
    adb(serial, 'shell', 'cmd', 'connectivity', 'airplane-mode', op.airplane ? 'enable' : 'disable');
    await sleep(op.airplane ? 3000 : 6000);
  } else if (name === 'grant') {
    for (const permission of op.grant) adb(serial, 'shell', 'pm', 'grant', PACKAGE, permission);
  } else if (name === 'run') {
    const done = spawnSync(process.execPath, ['scripts/hdsd/mobile-data.mjs', ...String(op.run).split(/\s+/u)], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 300_000 });
    if (done.status !== 0) throw new Error(`mobile-data ${op.run} failed: ${done.stderr || done.stdout}`);
    log(done.stdout.trim());
  } else if (name === 'adb') {
    adb(serial, ...String(op.adb).split(/\s+/u));
    await sleep(1500);
  } else if (name === 'pause') {
    await recorder?.pause();
  } else if (name === 'resume') {
    await recorder?.resume();
  } else if (name === 'sso') {
    const sso = findNode(readScreen(serial), uiPattern('sso'));
    if (sso === undefined) throw new Error('the sign-in screen has no SSO button');
    tap(serial, ...centre(sso));
    for (let wait = 0; wait < 20; wait += 1) {
      await sleep(3000);
      const nodes = readScreen(serial);
      const chrome = nodes.find((node) => uiPattern('browserChrome').test(node.label));
      if (chrome !== undefined) tap(serial, ...centre(chrome));
      if (findNode(nodes, uiPattern('unitChoice')) !== undefined || nodes.some((node) => /Tab 1 trong tổng số/u.test(node.label))) return;
    }
    throw new Error('the sign-in did not reach the choice of the unit');
  } else if (name === 'unit') {
    const unit = await settled(serial, new RegExp(`^${op.unit}`, 'u'));
    if (unit === undefined) throw new Error(`no unit named ${op.unit}`);
    tap(serial, ...centre(unit));
    await sleep(1000);
    const next = findNode(readScreen(serial), uiPattern('next'));
    if (next === undefined) throw new Error('no Continue button');
    tap(serial, ...centre(next));
    await sleep(5000);
  } else if (name === 'mfa') {
    const second = findNode(readScreen(serial), uiPattern('secondFactor'));
    if (second === undefined) throw new Error('no second factor button');
    tap(serial, ...centre(second));
    for (let wait = 0; wait < 20; wait += 1) {
      await sleep(3000);
      if (findNode(readScreen(serial), uiPattern('leaderHome')) !== undefined) return;
    }
    throw new Error('the second factor did not reach the home screen');
  } else {
    throw new Error(`unknown operation ${JSON.stringify(op)}`);
  }
  log(`  ${JSON.stringify(op)}`);
}

/** The operations of a step, then a look for the title of its screen: a step that did not get there fails now, not in the film. */
async function perform(serial, step, log, recorder) {
  for (const op of step.ops) await operate(serial, op, log, recorder);
  if (typeof step.expect === 'string') await operate(serial, { see: step.expect }, log, recorder);
}

/** Films one chapter of the phone: first what is on each screen (to write the words), then the voice, then the film itself. */
export async function recordMobile(chapterId, { serial, root = REPO_ROOT, cache = cacheDir(), log = console.log } = {}) {
  const chapters = JSON.parse(readFileSync(join(root, 'scripts', 'hdsd', 'mobile-chapters.json'), 'utf8'));
  const chapter = chapters.find((candidate) => candidate.id === chapterId);
  if (chapter === undefined) throw new Error(`no phone chapter ${chapterId}`);
  const catalogue = new Map(JSON.parse(readFileSync(join(root, CATALOGUE), 'utf8')).map((screen) => [screen.id, screen]));
  const problems = chapterProblems(chapter, new Set(catalogue.keys()));
  if (problems.length > 0) throw new Error(problems.join('; '));
  const screens = chapter.steps.map((step) => catalogue.get(step.screens[0]));

  // 0. What the chapter needs to have been done once (a draft made, a message sent): it is not filmed and not repeated.
  for (const op of chapter.prepare ?? []) await operate(serial, op, log);

  // 1. What is on the screens now.
  const facts = new Map();
  for (const step of chapter.steps) {
    await perform(serial, step, log);
    await sleep(1500);
    facts.set(step.screens[0], factsOfNodes(readScreen(serial)));
  }

  // 2. The words and the voice.
  const flow = composeTour({ id: chapter.id, module: chapter.module, group: chapter.title, groupTitle: chapter.group, title: chapter.title, screens: chapter.steps.map((step) => step.screens[0]) }, screens, facts);
  flow.audience = chapter.audience;
  flow.outcome = chapter.outcome;
  flow.platform = 'mobile';
  applyOverrides(flow, chapter);
  writeFileSync(join(root, 'scripts', 'hdsd', 'flows', `${chapter.id}.json`), `${JSON.stringify(flow, null, 2)}\n`);
  const audio = narrate(chapter.id, { root, cache, log });

  // 3. The film.
  const dir = join(cache, 'rec', chapter.id);
  mkdirSync(join(dir, 'shots'), { recursive: true });
  const screen = new Screen(serial, dir);
  const marks = [];
  let startWall = 0;
  let startMark;
  const recorder = {
    pause: () => screen.pause(),
    resume: async () => {
      screen.start();
      await sleep(RECORDER_LAG_MS);
      startMark = screen.mark();
      startWall = Date.now();
    },
  };
  await recorder.resume();
  for (const [index, step] of chapter.steps.entries()) {
    if (screen.age() > PIECE_LIMIT_MS) {
      await screen.pause();
      await recorder.resume();
    }
    startMark = screen.mark();
    startWall = Date.now();
    await perform(serial, step, log, recorder);
    const flowStep = flow.steps[index];
    const wanted = VOICE_DELAY_MS + audio.steps[flowStep.id].durationMs + TAIL_MS;
    const spent = Date.now() - startWall;
    if (wanted > spent) await sleep(wanted - spent);
    const shot = join(dir, 'shots', `${flowStep.id}.png`);
    screen.shot(shot);
    marks.push({ id: flowStep.id, heading: flowStep.heading, screens: flowStep.screens, startMark, endMark: screen.mark(), shot });
  }
  const files = await screen.stop();
  const pieces = screen.pieces.map((piece, index) => ({ ...piece, durationMs: probeMs(files[index]) }));
  const timeline = marks.map((mark) => {
    const startMs = filmMsOf(mark.startMark, pieces, RECORDER_LAG_MS);
    return { id: mark.id, heading: mark.heading, screens: mark.screens, startMs, endMs: filmMsOf(mark.endMark, pieces, RECORDER_LAG_MS), voiceMs: startMs + VOICE_DELAY_MS, shot: mark.shot };
  });
  let video = files[0];
  if (files.length > 1) {
    const list = join(dir, 'pieces.txt');
    writeFileSync(list, files.map((piece) => `file '${piece.replace(/\\/gu, '/')}'`).join('\n'));
    video = join(dir, 'joined.mp4');
    spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', video], { encoding: 'utf8' });
  }
  if (!existsSync(video)) throw new Error('the phone recording was not made');
  spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-c', 'copy', join(dir, 'video.mp4')], { encoding: 'utf8' });
  writeFileSync(join(dir, 'timeline.json'), `${JSON.stringify({ flow: chapter.id, timeline }, null, 2)}\n`);
  return { chapter: chapter.id, steps: timeline.length, pieces: pieces.length };
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
