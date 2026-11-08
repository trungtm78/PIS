import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const CATALOG = join('Design', 'MACHVON_Design', '03_Engineering', 'screen_catalog.json');
const PACKAGE = 'vn.machvon.app';
/** The words of the phone application (tab names, titles, buttons) live in uat-mobile-walk.json next to this script. */
const WORDS = JSON.parse(readFileSync(join(SCRIPT_DIR, 'uat-mobile-walk.json'), 'utf8'));
const PATTERNS = Object.fromEntries(Object.entries(WORDS.patterns).map(([name, { source, flags }]) => [name, new RegExp(source, flags)]));

/** The tab bar of the application (apps/mobile/lib/core/navigation/app_shell.dart) as the pixels of the 720 x 1560 emulator: the centre of each tab. */
const TABS = WORDS.tabs;
const TAB_Y = 1432;
/** Where the content of a screen is: under the bar of the system and the title, over the tab bar. */
const CONTENT_TOP = 240;
const TAB_BAR_TOP = 1352;
const STATUS_BAR = 128;
/** Where the bar of a screen ends: its title is drawn between the bar of the system and this line. */
const BAR_BOTTOM = 250;
/** How many pages a screen is scrolled when its touch areas are listed. */
const MAX_PAGES = 4;
/** 48 dp at the 2 pixels per dp of the emulator. */
const MIN_TOUCH_PX = 96;
/** What a walk never taps: it leaves the session, deletes, sends, decides, switches the tenant or sets a filter (a menu is not a screen). The screens are looked at, not used. */
const NEVER_TAP = PATTERNS.neverTap;
/** The screens whose rows are an action (a choice of tenant or unit, the device list with its sign-out): the walk does not go below them. */
const NO_DESCEND = new Set(['MOB-03', 'MOB-04', 'MOB-48', 'MOB-49']);
const LOG_PROBLEM = /FATAL EXCEPTION|EXCEPTION CAUGHT BY|RenderFlex overflowed|overflowed by|ANR in|Process vn\.machvon\.app.*has died/u;

/** The title the application writes where it is not the one of the screen catalogue (the strings files of the features in apps/mobile/lib/features). */
export const TITLE_ALIASES = WORDS.titleAliases;

const normal = (text) => String(text).normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim();

export function parseBounds(text) {
  const found = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/u.exec(String(text ?? ''));
  return found === null ? null : { left: Number(found[1]), top: Number(found[2]), right: Number(found[3]), bottom: Number(found[4]) };
}

/** Every node of a `maestro hierarchy` answer, flat: what the person hears (text, else accessibility text), where it is and whether it takes a touch. */
export function nodesOf(root) {
  const out = [];
  const visit = (node) => {
    if (node === null || typeof node !== 'object') return;
    const attributes = node.attributes ?? {};
    const bounds = parseBounds(attributes.bounds);
    if (bounds !== null) {
      const label = String(attributes.text || attributes.accessibilityText || '').trim();
      const cls = attributes.class ?? '';
      // The framework draws a row of a list as a Button that is not flagged clickable: it takes a touch all the same.
      out.push({ label, bounds, clickable: attributes.clickable === 'true' || /\.Button$/u.test(cls), editable: /EditText/u.test(cls), cls });
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return out;
}

/** The title of a screen as the screen catalogue writes it, by id, from the nodes: the first line of a label, compared without case. */
export function titlesOf(catalog, aliases = TITLE_ALIASES) {
  const titles = new Map();
  for (const screen of catalog) if (/^MOB-/u.test(screen.id)) titles.set(normal(screen.title), screen.id);
  for (const [title, id] of Object.entries(aliases)) titles.set(normal(title), id);
  return titles;
}

/**
 * The design id of the screen the nodes show: a title of the catalogue in the bar of the screen, null when there is none. Only the bar says which screen it is:
 * the body of a detail page names other screens (its sections, its links), and a title found there would call the page by the name of its neighbour.
 */
export function identify(nodes, titles) {
  const bar = nodes.filter((node) => node.bounds.top >= STATUS_BAR && node.bounds.top < BAR_BOTTOM && node.label !== '');
  for (const node of bar) {
    const id = titles.get(normal(node.label.split('\n')[0]));
    if (id !== undefined) return id;
  }
  return null;
}

/** The first label in the bar of the screen, for a screen the catalogue does not know. */
export function headingOf(nodes) {
  const node = nodes.find((candidate) => candidate.label !== '' && candidate.label !== WORDS.backLabel && candidate.bounds.top >= STATUS_BAR && candidate.bounds.top < CONTENT_TOP + 120);
  return node === undefined ? '' : node.label.split('\n')[0];
}

const inApp = (node) => node.bounds.top >= STATUS_BAR && node.bounds.bottom - node.bounds.top < 1400 && node.bounds.right - node.bounds.left > 0;

/** The controls a person cannot hear: a node that takes a touch and says nothing. */
export function unlabelled(nodes) {
  return nodes.filter((node) => inApp(node) && node.clickable && node.label === '' && !node.editable);
}

/** The touch areas under 48 dp, with their name. They are reported, they do not fail a screen (the threshold is the one of AC-ST-MOB-040-1). */
export function smallTargets(nodes) {
  return nodes
    .filter((node) => inApp(node) && node.clickable && node.label !== '')
    .filter((node) => node.bounds.right - node.bounds.left < MIN_TOUCH_PX || node.bounds.bottom - node.bounds.top < MIN_TOUCH_PX)
    .map((node) => ({ label: node.label.split('\n')[0], width: node.bounds.right - node.bounds.left, height: node.bounds.bottom - node.bounds.top }));
}

/** What the walk may tap on a screen: a labelled touch area of the content that is not an action to keep away from, once for each name, in the order of the screen. */
export function targetsOf(nodes, limit) {
  const seen = new Set();
  const targets = [];
  for (const node of nodes) {
    if (!node.clickable || node.editable || node.label === '' || NEVER_TAP.test(node.label)) continue;
    // The buttons of the bar of a screen (a conversation, a setting) open screens too; the bar of the system is above STATUS_BAR.
    if (node.bounds.top < STATUS_BAR || node.bounds.bottom > TAB_BAR_TOP || node.bounds.right - node.bounds.left < 40) continue;
    const key = normal(node.label);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(node);
    if (targets.length === limit) break;
  }
  return targets;
}

/** The lines of a log that say the application broke: a crash, an exception of the framework, a layout that overflowed, an application that stopped answering. */
export function logProblems(log) {
  return String(log)
    .split(/\r?\n/u)
    .filter((line) => LOG_PROBLEM.test(line))
    .slice(0, 5)
    .map((line) => line.slice(0, 240));
}

/** How a visit to a screen ended, by the contract of the screen cases (no crash, no overflow, every control has a name, something is on the screen). */
export function judge({ nodes, problems, alive }) {
  const reasons = [];
  if (!alive) reasons.push('the application is not in the foreground: it stopped');
  if (problems.length > 0) reasons.push(`the log has ${problems.length} line(s) of a crash or an overflow`);
  const mute = unlabelled(nodes);
  if (mute.length > 0) reasons.push(`${mute.length} touch area(s) without a name`);
  if (!nodes.some((node) => inApp(node) && node.label !== '')) reasons.push('nothing is written on the screen');
  return { status: reasons.length === 0 ? 'passed' : 'failed', reasons };
}

/** The journal lines of a walk, one result for each design screen case (UI-MOB-nn): failed when any visit failed, the window of the first visit holds the requests. */
export function journalOf(visits) {
  const byId = new Map();
  for (const visit of visits.filter((candidate) => candidate.id !== null)) {
    const before = byId.get(visit.id);
    if (before === undefined) byId.set(visit.id, { ...visit });
    else if (before.status === 'passed' && visit.status === 'failed') byId.set(visit.id, { ...visit });
  }
  return [...byId.values()].map((visit) => ({
    kind: 'result',
    suite: 'maestro',
    file: '',
    name: `UI-${visit.id} ${visit.title}`,
    status: visit.status,
    retry: 0,
    durationMs: Date.parse(visit.endedAt) - Date.parse(visit.at),
    at: visit.at,
    endedAt: visit.endedAt,
  }));
}

/** Maestro is a Java program: its output follows the code page of Windows (a Vietnamese name becomes `?`) unless the JVM is told to write UTF-8. */
const UTF8_JAVA = '-Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dsun.stdout.encoding=UTF-8';

function run(command, args, { shell = false, timeout = 120_000 } = {}) {
  const env = { ...process.env, MAESTRO_CLI_NO_ANALYTICS: '1', JAVA_TOOL_OPTIONS: `${process.env.JAVA_TOOL_OPTIONS ?? ''} ${UTF8_JAVA}`.trim() };
  const done = spawnSync(command, args, { encoding: 'utf8', shell, timeout, env, maxBuffer: 64 * 1024 * 1024 });
  return { code: done.status, out: `${done.stdout ?? ''}`, err: `${done.stderr ?? ''}` };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const adb = (...args) => run('adb', args);

function readScreen() {
  const answer = run('maestro', ['hierarchy'], { shell: true, timeout: 90_000 });
  const start = answer.out.indexOf('{');
  if (start < 0) return [];
  try {
    return nodesOf(JSON.parse(answer.out.slice(start)));
  } catch {
    return [];
  }
}

const centre = (node) => [Math.round((node.bounds.left + node.bounds.right) / 2), Math.round((node.bounds.top + node.bounds.bottom) / 2)];
const tap = (x, y) => adb('shell', 'input', 'tap', String(x), String(y));
const back = () => adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
const inForeground = () => /topResumedActivity=.*vn\.machvon\.app/u.test(adb('shell', 'dumpsys', 'activity', 'activities').out);
const launch = () => adb('shell', 'monkey', '-p', PACKAGE, '-c', 'android.intent.category.LAUNCHER', '1');

export async function walk({ root = REPO_ROOT, label, journal, budgetMinutes, perScreen, perChild, maxDepth = 3, log = console.log }) {
  const titles = titlesOf(JSON.parse(readFileSync(join(root, CATALOG), 'utf8')));
  const outDir = join(root, 'apps', 'mobile', 'qa', 'device', 'results', label);
  mkdirSync(join(outDir, 'screens'), { recursive: true });
  const deadline = Date.now() + budgetMinutes * 60_000;
  const visits = [];
  const unknown = [];

  const visit = (at, nodes, via) => {
    const id = identify(nodes, titles);
    const catalogTitle = id === null ? headingOf(nodes) : [...titles].find(([, value]) => value === id)?.[0] ?? '';
    const alive = inForeground();
    const problems = logProblems(adb('logcat', '-d', '-v', 'brief').out);
    const verdict = judge({ nodes, problems, alive });
    const endedAt = new Date().toISOString();
    const shot = `${id ?? `unknown-${unknown.length + 1}`}.png`;
    adb('shell', 'screencap', '-p', '/sdcard/walk.png');
    adb('pull', '/sdcard/walk.png', join(outDir, 'screens', shot));
    const record = {
      id,
      title: catalogTitle,
      heading: headingOf(nodes),
      via,
      at: at.toISOString(),
      endedAt,
      status: verdict.status,
      reasons: verdict.reasons,
      problems,
      controls: nodes.filter((node) => node.clickable && node.label !== '').length,
      smallTargets: smallTargets(nodes),
      screenshot: `screens/${shot}`,
    };
    if (id === null) unknown.push(record);
    visits.push(record);
    log(`${verdict.status === 'passed' ? 'PASS' : 'FAIL'} ${id ?? '?'} ${record.heading} <- ${via}${verdict.reasons.length > 0 ? ` (${verdict.reasons.join('; ')})` : ''}`);
    return id;
  };

  const settle = async () => {
    await sleep(2500);
    return readScreen();
  };

  // 1. The sign-in, screen by screen, through the system browser: MOB-01 to MOB-04 and the first home.
  adb('shell', 'am', 'force-stop', PACKAGE);
  adb('logcat', '-c');
  launch();
  await sleep(6000);
  let signedIn = false;
  let seenWelcome = false;
  for (let step = 0; step < 14 && !signedIn; step += 1) {
    const at = new Date();
    const nodes = readScreen();
    const id = identify(nodes, titles);
    const find = (pattern) => nodes.find((node) => pattern.test(node.label));
    if (find(PATTERNS.useWithoutAccount)) {
      tap(...centre(find(PATTERNS.useWithoutAccount)));
      await sleep(3000);
    } else if (id === 'MOB-02') {
      visit(at, nodes, 'launch');
      if (!seenWelcome && find(PATTERNS.changeTenant)) {
        seenWelcome = true;
        const started = new Date();
        tap(...centre(find(PATTERNS.changeTenant)));
        const welcome = await settle();
        visit(started, welcome, PATTERNS.changeTenant.source);
        back();
        await sleep(2000);
        // The welcome screen is the first of its stack: the back key leaves the application.
        if (!inForeground()) {
          launch();
          await sleep(6000);
        }
      }
      const sso = readScreen().find((node) => PATTERNS.sso.test(node.label));
      if (sso) tap(...centre(sso));
      await sleep(6000);
    } else if (id === 'MOB-04') {
      visit(at, nodes, 'sign-in');
      const unit = find(PATTERNS.unit);
      if (unit) tap(...centre(unit));
      await sleep(1000);
      const next = readScreen().find((node) => PATTERNS.next.test(node.label));
      if (next) tap(...centre(next));
      await sleep(5000);
    } else if (id === 'MOB-03') {
      visit(at, nodes, 'sign-in');
      const browser = find(PATTERNS.secondFactor);
      if (browser) tap(...centre(browser));
      await sleep(8000);
    } else if (id === 'MOB-07') {
      signedIn = true;
    } else if (!inForeground()) {
      launch();
      await sleep(6000);
    } else {
      await sleep(4000);
    }
  }
  if (!signedIn) {
    log('the sign-in did not reach the home screen: the walk stops');
    writeFileSync(join(outDir, 'walk.json'), `${JSON.stringify({ label, signedIn, visits }, null, 2)}\n`);
    return { visits, signedIn, unknown, timedOut: false };
  }

  // 2. Each tab and what a person can open from it, as deep as the depth allows. A screen is opened once for its own children (a list of projects has one detail page to look at, not ten).
  let timedOut = false;
  const tried = new Set();
  const explored = new Set();
  const swipeUp = () => adb('shell', 'input', 'swipe', '360', '1100', '360', '450', '500');
  const swipeDown = () => adb('shell', 'input', 'swipe', '360', '450', '360', '1100', '300');
  const toTop = async () => {
    for (let times = 0; times <= MAX_PAGES; times += 1) swipeDown();
    await sleep(800);
  };
  const contentLabels = (nodes) => nodes.filter((node) => node.label !== '' && node.bounds.top >= CONTENT_TOP && node.bounds.bottom <= TAB_BAR_TOP).map((node) => normal(node.label));

  /** What can be touched on a screen, from its top to its end: the screen is scrolled until a page adds no label, then brought back to the top. */
  const targetLabels = async (first, limit) => {
    const labels = [];
    const seen = new Set();
    const known = new Set(contentLabels(first));
    const add = (nodes) => {
      for (const node of targetsOf(nodes, 200)) {
        const key = normal(node.label);
        if (seen.has(key)) continue;
        seen.add(key);
        labels.push(node.label);
      }
    };
    add(first);
    for (let page = 0; page < MAX_PAGES; page += 1) {
      swipeUp();
      await sleep(900);
      const nodes = readScreen();
      const fresh = contentLabels(nodes).filter((label) => !known.has(label));
      if (fresh.length === 0) break;
      for (const label of fresh) known.add(label);
      add(nodes);
    }
    await toTop();
    return labels.slice(0, limit);
  };

  /** The touch area with a name, wherever the screen has been scrolled to: from the top, one page at a time. */
  const locate = async (label, start) => {
    let nodes = start;
    const find = () => targetsOf(nodes, 200).find((node) => node.label === label);
    if (find() !== undefined) return find();
    await toTop();
    for (let page = 0; page <= MAX_PAGES; page += 1) {
      nodes = readScreen();
      if (find() !== undefined) return find();
      swipeUp();
      await sleep(900);
    }
    return undefined;
  };

  const explore = async (first, parent, depth) => {
    const limit = depth === 1 ? perScreen : perChild;
    const labels = await targetLabels(first, limit);
    let current = first;
    for (const [index, label] of labels.entries()) {
      const name = label.split('\n')[0];
      const key = `${parent}>${normal(label)}`;
      if (tried.has(key)) continue;
      if (Date.now() > deadline) {
        timedOut = true;
        return 'time';
      }
      // A walk that lost the application before the touch cannot blame the screen it touches next.
      if (!inForeground()) {
        log(`lost: the application is not in the foreground before "${name}"`);
        return 'lost';
      }
      if (index > 0) {
        // The list has moved since it was read (a scroll position comes back, a row is drawn again): the screen is read again and the row is found by its name.
        current = readScreen();
        if (parent !== null && identify(current, titles) !== parent) {
          back();
          await sleep(1500);
          current = readScreen();
          if (identify(current, titles) !== parent) {
            log(`lost: after the back key the screen is not ${parent} (it is ${identify(current, titles)})`);
            return 'lost';
          }
        }
      }
      const target = await locate(label, current);
      if (target === undefined) {
        log(`skip: "${name}" is not on the screen any more`);
        tried.add(key);
        continue;
      }
      tried.add(key);
      adb('logcat', '-c');
      const at = new Date();
      tap(...centre(target));
      const after = await settle();
      const id = identify(after, titles);
      // The touch changed nothing (the screen is the one it was on): there is nothing to record and nothing to go back from.
      if (id !== null && id === parent) {
        log(`skip: "${name}" changed nothing`);
        continue;
      }
      visit(at, after, name);
      if (!inForeground()) {
        launch();
        await sleep(6000);
        return 'lost';
      }
      if (id !== null && depth < maxDepth && !NO_DESCEND.has(id) && !explored.has(id)) {
        explored.add(id);
        if ((await explore(after, id, depth + 1)) === 'lost') return 'lost';
      }
      back();
      await sleep(1500);
      if (!inForeground()) {
        launch();
        await sleep(6000);
        return 'lost';
      }
    }
    return 'done';
  };
  for (const tab of TABS) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (Date.now() > deadline) {
        timedOut = true;
        break;
      }
      if (!inForeground()) {
        launch();
        await sleep(6000);
      }
      adb('logcat', '-c');
      const at = new Date();
      tap(tab.x, TAB_Y);
      const nodes = await settle();
      const id = visit(at, nodes, `tab ${tab.name}`);
      explored.add(id);
      // Lost on the way: the walk starts again from the root of the tab and goes on with what it has not touched yet.
      if ((await explore(nodes, id, 1)) !== 'lost') break;
    }
    tap(tab.x, TAB_Y);
    await sleep(1500);
    if (timedOut) break;
  }

  const lines = journalOf(visits);
  if (journal) for (const line of lines) appendFileSync(journal, `${JSON.stringify(line)}\n`);
  writeFileSync(join(outDir, 'walk.json'), `${JSON.stringify({ label, signedIn, timedOut, visits, journal: lines.length }, null, 2)}\n`);
  return { visits, signedIn, unknown, timedOut };
}

export async function main(argv, io = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      label: { type: 'string', default: 'emulator' },
      journal: { type: 'string', default: process.env.UAT_JOURNAL ?? '' },
      budget: { type: 'string', default: '45' },
      'per-screen': { type: 'string', default: '10' },
      'per-child': { type: 'string', default: '6' },
      depth: { type: 'string', default: '3' },
    },
  });
  const log = io.log ?? console.log;
  const result = await walk({
    label: values.label,
    journal: values.journal === '' ? undefined : values.journal,
    budgetMinutes: Number(values.budget),
    perScreen: Number(values['per-screen']),
    perChild: Number(values['per-child']),
    maxDepth: Number(values.depth),
    log,
  });
  const ids = new Set(result.visits.filter((visit) => visit.id !== null).map((visit) => visit.id));
  log(`${result.visits.length} visits, ${ids.size} screens of the catalogue, ${result.unknown.length} not in it${result.timedOut ? ', the time ran out' : ''}`);
  return result.signedIn ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
