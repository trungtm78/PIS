import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cacheDir } from './lib.mjs';

/** The words of the phone application the recorder looks for (tab names, button names, texts of a screen) live in mobile-ui.json. */
const UI = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'mobile-ui.json'), 'utf8'));
/** A pattern of mobile-ui.json by its name. */
export const uiPattern = (name) => new RegExp(UI.patterns[name].source, UI.patterns[name].flags);

/** The tab bar of the phone application (apps/mobile/lib/core/navigation/app_shell.dart): the centre of each tab on a 720 x 1560 screen. */
export const TABS = UI.tabs;
export const TAB_Y = 1432;
const TAB_BAR_TOP = 1352;
const STATUS_BAR = 128;
const PACKAGE = 'vn.machvon.app';

const decode = (text) => text.replace(/&quot;/gu, '"').replace(/&apos;/gu, "'").replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&amp;/gu, '&').replace(/&#10;/gu, '\n');

/** The nodes of an `uiautomator dump`: what a person hears (text, else the description), where it is and whether it takes a touch. */
export function nodesOfDump(xml) {
  const nodes = [];
  for (const found of xml.matchAll(/<node\b([^>]*?)\/?>/gu)) {
    const attributes = Object.fromEntries([...found[1].matchAll(/([\w-]+)="([^"]*)"/gu)].map((pair) => [pair[1], decode(pair[2])]));
    const bounds = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/u.exec(attributes.bounds ?? '');
    if (bounds === null) continue;
    nodes.push({
      label: (attributes.text || attributes['content-desc'] || '').trim(),
      clickable: attributes.clickable === 'true' || /Button$/u.test(attributes.class ?? ''),
      bounds: { left: Number(bounds[1]), top: Number(bounds[2]), right: Number(bounds[3]), bottom: Number(bounds[4]) },
    });
  }
  return nodes;
}

export const centre = (node) => [Math.round((node.bounds.left + node.bounds.right) / 2), Math.round((node.bounds.top + node.bounds.bottom) / 2)];

/** What the narration is made from: the labels and the buttons of the content of the screen (the bar of the system and the tab bar are left out). */
export function factsOfNodes(nodes) {
  const content = nodes.filter((node) => node.bounds.top >= STATUS_BAR && node.bounds.bottom <= TAB_BAR_TOP && node.label !== '');
  const unique = (items) => [...new Set(items)];
  const first = (node) => node.label.split('\n')[0];
  const labels = unique(content.filter((node) => !node.clickable).map(first)).filter((label) => label.length <= 60);
  const buttons = unique(content.filter((node) => node.clickable).map(first)).filter((label) => !UI.buttonsLeftOut.includes(label));
  const text = content.map((node) => node.label).join(' ');
  return { labels, buttons, rows: 0, empty: uiPattern('empty').test(text), denied: uiPattern('denied').test(text), needsRecord: false };
}

/** The first node whose name matches, in the content of the screen. */
export const findNode = (nodes, pattern) => nodes.find((node) => node.bounds.top >= STATUS_BAR && node.bounds.bottom <= TAB_BAR_TOP && pattern.test(node.label));

export function adb(serial, ...args) {
  return spawnSync('adb', serial === undefined ? args : ['-s', serial, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** The screen as nodes: the dump is taken on the device and read here. */
export function readScreen(serial) {
  const done = adb(serial, 'exec-out', 'uiautomator', 'dump', '/dev/tty');
  const xml = done.stdout.slice(done.stdout.indexOf('<?xml'));
  return nodesOfDump(xml);
}

export const tap = (serial, x, y) => adb(serial, 'shell', 'input', 'tap', String(x), String(y));
export const back = (serial) => adb(serial, 'shell', 'input', 'keyevent', 'KEYCODE_BACK');
export const launch = (serial) => adb(serial, 'shell', 'monkey', '-p', PACKAGE, '-c', 'android.intent.category.LAUNCHER', '1');
export const swipeUp = (serial) => adb(serial, 'shell', 'input', 'swipe', '360', '1100', '360', '450', '500');
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * The recording of the screen of the phone, made on the device in pieces: the recorder stops by itself after three minutes, and the film is stopped on
 * purpose while a screen that the application hides from recordings is crossed. The pieces are put together afterwards (`filmMsOf` places a moment in them).
 */
export class Screen {
  constructor(serial, dir) {
    this.serial = serial;
    this.dir = dir;
    this.pieces = [];
    this.child = undefined;
    this.running = false;
    mkdirSync(dir, { recursive: true });
  }

  start() {
    const remote = `/sdcard/hdsd-${this.pieces.length}.mp4`;
    this.pieces.push({ remote, startWall: Date.now(), durationMs: 0 });
    this.child = spawn('adb', ['-s', this.serial, 'shell', 'screenrecord', '--time-limit', '170', '--bit-rate', process.env.PHONE_BITRATE ?? '3000000', remote], { stdio: 'ignore' });
    this.running = true;
  }

  /** How long the piece that is being made has lasted. */
  age() {
    return this.running ? Date.now() - this.pieces[this.pieces.length - 1].startWall : 0;
  }

  /** The moment now, in the terms of `filmMsOf`. */
  mark() {
    return { piece: this.pieces.length - 1, wall: Date.now() };
  }

  async pause() {
    if (!this.running) return;
    adb(this.serial, 'shell', 'pkill', '-2', 'screenrecord');
    await sleep(2500);
    this.running = false;
  }

  async stop() {
    await this.pause();
    const local = [];
    for (const [index, piece] of this.pieces.entries()) {
      const file = join(this.dir, `piece-${index}.mp4`);
      adb(this.serial, 'pull', piece.remote, file);
      adb(this.serial, 'shell', 'rm', piece.remote);
      local.push(file);
    }
    return local;
  }

  shot(file) {
    const done = spawnSync('adb', ['-s', this.serial, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(file, done.stdout);
  }
}

export const cacheOf = (id, cache = cacheDir()) => join(cache, 'rec', id);

/** The piece of a recording that was made first is the film when there is one piece; more pieces are joined by the next stage. */
export function keepVideo(pieces, target) {
  if (pieces.length === 1) {
    copyFileSync(pieces[0], target);
    return target;
  }
  const list = `${target}.txt`;
  writeFileSync(list, pieces.map((piece) => `file '${piece.replace(/\\/gu, '/')}'`).join('\n'));
  return list;
}

export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** The operations a step may do, each written as an object with that key (see `operate` in mobile-run.mjs). */
export const KNOWN_OPS = [
  'clear',
  'relaunch',
  'wait',
  'back',
  'tab',
  'tap',
  'sso',
  'unit',
  'mfa',
  // The film is stopped while the next operations run (a screen the application hides from recordings, or a stretch of typing that says nothing), and starts again.
  'pause',
  'resume',
  'fill',
  'hideKeyboard',
  'scroll',
  'airplane',
  'adb',
  'see',
  'grant',
  // A command of the repository run while the chapter is made (a person of the unit does something on the web, a condition of the service is set): its words are in scripts/hdsd/mobile-data.mjs.
  'run',
];

/** The key that names an operation. */
export const opNameOf = (op) => KNOWN_OPS.find((name) => name in op);

/** The longest chapter of the guide: a longer one is cut in two. */
export const MAX_STEPS = 8;

/**
 * The problems of a phone chapter: its shape, its steps (each shows one screen of the catalogue, once), its operations (known, and with the film stopped and
 * started in pairs), and its length.
 */
export function chapterProblems(chapter, catalogueIds) {
  const problems = [];
  const say = (text) => problems.push(`${chapter.id}: ${text}`);
  for (const key of ['id', 'group', 'title', 'audience', 'outcome']) if (typeof chapter[key] !== 'string' || chapter[key].trim() === '') say(`${key} is missing`);
  if (chapter.module !== 'MOB') say('the module must be MOB');
  if (!Array.isArray(chapter.steps) || chapter.steps.length === 0) {
    say('there are no steps');
    return problems;
  }
  if (chapter.steps.length > MAX_STEPS) say(`${chapter.steps.length} steps, at most ${MAX_STEPS}`);
  const seen = new Set();
  let paused = false;
  const walk = (ops, where) => {
    for (const op of ops) {
      const name = opNameOf(op ?? {});
      if (name === undefined) {
        say(`${where}: unknown operation ${JSON.stringify(op)}`);
      } else if (where === 'prepare' && (name === 'pause' || name === 'resume')) {
        say('prepare: nothing is filmed there, so the film cannot be stopped or started');
      } else if (name === 'pause') {
        if (paused) say(`${where}: the film is stopped twice`);
        paused = true;
      } else if (name === 'resume') {
        if (!paused) say(`${where}: the film is started while it runs`);
        paused = false;
      }
    }
  };
  walk(chapter.prepare ?? [], 'prepare');
  for (const step of chapter.steps) {
    if (!Array.isArray(step.screens) || step.screens.length !== 1) {
      say(`step ${step.id}: it must show exactly one screen`);
      continue;
    }
    const [screen] = step.screens;
    if (!catalogueIds.has(screen)) say(`step ${step.id}: ${screen} is not in the catalogue`);
    if (seen.has(screen)) say(`step ${step.id}: ${screen} is shown twice`);
    seen.add(screen);
    if (step.id !== screen.toLowerCase()) say(`step ${step.id}: the id must be ${screen.toLowerCase()}`);
    if (!Array.isArray(step.ops) || step.ops.length === 0) say(`step ${step.id}: it has no operations`);
    walk(step.ops ?? [], `step ${step.id}`);
    if (paused) say(`step ${step.id}: the film is still stopped when the step ends (the screen of the step would not be filmed)`);
  }
  return problems;
}

/** The words the author of a chapter wrote for a step replace the words made from the catalogue (a state shown inside another screen needs its own words). */
export function applyOverrides(flow, chapter) {
  for (const step of chapter.steps) {
    const target = flow.steps.find((candidate) => candidate.id === step.id);
    if (target === undefined) continue;
    for (const key of ['heading', 'text', 'note']) if (typeof step[key] === 'string') target[key] = step[key];
  }
  return flow;
}

/** Whether two sightings of a node are the same: a screen that is still loading moves what is under it, and a touch must not land before it has stopped. */
export const sameBounds = (left, right) => left !== undefined && right !== undefined && JSON.stringify(left.bounds) === JSON.stringify(right.bounds);

/** A text typed with `adb shell input text`: the spaces become %s and the signs the shell reads are escaped. Only ASCII can be typed this way. */
export function inputTextOf(text) {
  if (/[^\x20-\x7e]/u.test(text)) throw new Error(`only ASCII can be typed with input text: ${text}`);
  return text.replace(/([\\"'`$&|;<>()*?#~[\]{}!^])/gu, '\\$1').replace(/ /gu, '%s');
}

/**
 * Where a moment of a recording is in the finished film. The recorder of the phone makes pieces (it stops by itself after three minutes, and the film is
 * stopped on purpose while a protected screen is crossed); the film is the pieces one after the other. A moment is a piece and the wall clock at which it
 * happened; a piece begins its picture a little after it was asked to.
 */
export function filmMsOf(moment, pieces, lagMs) {
  let before = 0;
  for (const [index, piece] of pieces.entries()) {
    if (index === moment.piece) return before + Math.min(Math.max(moment.wall - piece.startWall - lagMs, 0), piece.durationMs);
    before += piece.durationMs;
  }
  throw new Error(`the recording has no piece ${moment.piece}`);
}
