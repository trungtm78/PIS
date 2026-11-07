import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cacheDir } from './lib.mjs';

/** The tab bar of the phone application (apps/mobile/lib/core/navigation/app_shell.dart): the centre of each tab on a 720 x 1560 screen. */
export const TABS = { 'Trang chủ': 72, 'Dự án': 216, 'Phê duyệt': 360, 'Thông báo': 504, 'Cá nhân': 648 };
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
  const buttons = unique(content.filter((node) => node.clickable).map(first)).filter((label) => label !== 'Quay lại' && label !== 'Làm mới');
  const text = content.map((node) => node.label).join(' ');
  return { labels, buttons, rows: 0, empty: /chưa có dữ liệu/iu.test(text), denied: /không đủ quyền/iu.test(text), needsRecord: false };
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

/** One recording of the screen of the phone; the file is made on the device in pieces of at most three minutes (the limit of the recorder), which are put together afterwards. */
export class Screen {
  constructor(serial, dir) {
    this.serial = serial;
    this.dir = dir;
    this.pieces = [];
    this.child = undefined;
    mkdirSync(dir, { recursive: true });
  }

  start() {
    const remote = `/sdcard/hdsd-${this.pieces.length}.mp4`;
    this.pieces.push(remote);
    this.child = spawn('adb', ['-s', this.serial, 'shell', 'screenrecord', '--time-limit', '170', '--bit-rate', '3000000', remote], { stdio: 'ignore' });
  }

  async stop() {
    adb(this.serial, 'shell', 'pkill', '-2', 'screenrecord');
    await sleep(2500);
    const local = [];
    for (const [index, remote] of this.pieces.entries()) {
      const file = join(this.dir, `piece-${index}.mp4`);
      adb(this.serial, 'pull', remote, file);
      adb(this.serial, 'shell', 'rm', remote);
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
