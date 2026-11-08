// Real phone footage for the clips: the Android emulator runs the Flutter app against the seeded stack, the screen is recorded on the device
// (`adb shell screenrecord`) while a walk of the app is made with the operations of the phone guide (scripts/hdsd/mobile-run.mjs), and each scene
// is saved as a portrait mp4 (constant 30 fps) under D:/PIS-clips-out/phone with an index (scene id -> file, duration).
//
//   node scripts/clips/record/phone-film.mjs sign-in <public|enterprise> --persona owner [--serial emulator-5554]
//   node scripts/clips/record/phone-film.mjs scene <scene-id> [--out D:/PIS-clips-out/phone] [--edition public]
//   node scripts/clips/record/phone-film.mjs dump                      what the screen shows now (the labels the walks look for)
//   node scripts/clips/record/phone-film.mjs list
//
// The walks are data (phone-film.json): the operations of the guide (tab, tap, scroll, back, see, wait ...) plus `hold` (stand still) and `touches`.
// The sign-in of a person goes through the test identity provider of the stack: `mobile-data.mjs persona <key>` names who signs in next
// (E2E_STACK_INFO must point at the info file of the stack). Screens the application hides from recordings are not filmed (`pause` / `resume`).
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FFMPEG, probeMs } from '../../hdsd/tts.mjs';
import { Screen, adb, centre, readScreen, sleep, tap } from '../../hdsd/mobile.mjs';
import { operate } from '../../hdsd/mobile-run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
export const PLAN_FILE = join(HERE, 'phone-film.json');
export const OUT_DIR = process.env.CLIPS_PHONE_OUT ?? 'D:/PIS-clips-out/phone';
/** The films of a clip go in a folder of their own for the enterprise edition: <out>/enterprise/<scene id>.mp4 (make.mjs --phone-dir). */
export const outDirOf = (edition, base = OUT_DIR) => (edition === 'public' ? base : join(base, edition));
/** The recorder of the device begins its picture a little after it is asked to. */
const LAG_MS = 700;

export const loadPlan = (file = PLAN_FILE) => JSON.parse(readFileSync(file, 'utf8'));

/** What is wrong with the plan: a walk with no operation, an unknown scene edition, a person that is not known. */
export function planProblems(plan) {
  const problems = [];
  for (const [id, scene] of Object.entries(plan.scenes ?? {})) {
    if (!Array.isArray(scene.ops) || scene.ops.length === 0) problems.push(`${id}: no operations`);
    if (!(Number.isFinite(scene.minSec) && scene.minSec >= 8)) problems.push(`${id}: minSec must be a number of seconds, at least 8`);
    if (typeof scene.persona !== 'string') problems.push(`${id}: the person who signs in is missing`);
    const pauses = (scene.ops ?? []).filter((op) => 'pause' in op).length;
    const resumes = (scene.ops ?? []).filter((op) => 'resume' in op).length;
    if (pauses !== resumes) problems.push(`${id}: pause and resume must come in pairs`);
  }
  return problems;
}

const arg = (argv, name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};

const ffmpeg = (args) => {
  const done = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (done.status !== 0) throw new Error(`ffmpeg failed: ${(done.stderr ?? '').split('\n').slice(-4).join(' ')}`);
};

/** The operations of a walk run one after the other; `hold` stands still, `touches` is done outside. */
async function walk(serial, ops, recorder, log) {
  for (const op of ops) {
    if ('hold' in op) {
      await sleep(op.hold);
      continue;
    }
    if ('reset' in op) {
      // Back to the root of the tab: the back button of the bar is pressed while the screen shows one.
      for (let step = 0; step < 6; step += 1) {
        const back = readScreen(serial).find((node) => /^Quay lại$/u.test(node.label));
        if (back === undefined) break;
        tap(serial, ...centre(back));
        await sleep(1500);
      }
      continue;
    }
    await operate(serial, op, log, recorder);
  }
}

/** Shows taps as circles on the picture (what a viewer expects of a phone film) and keeps the screen awake. */
export function prepareDevice(serial) {
  for (const args of [
    ['shell', 'settings', 'put', 'system', 'show_touches', '1'],
    ['shell', 'settings', 'put', 'global', 'stay_on_while_plugged_in', '7'],
    ['shell', 'settings', 'put', 'system', 'screen_off_timeout', '1800000'],
    ['shell', 'settings', 'put', 'global', 'window_animation_scale', '1'],
    ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'],
    ['shell', 'wm', 'dismiss-keyguard'],
  ]) adb(serial, ...args);
}

/** Signs a person in: the test identity provider is told who, the application is cleared and goes through the unit choice and the second factor. */
export async function signIn(serial, { persona, unit, log = console.log }) {
  const data = spawnSync(process.execPath, ['scripts/hdsd/mobile-data.mjs', 'persona', persona], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (data.status !== 0) throw new Error(`persona ${persona}: ${data.stderr || data.stdout}`);
  log(data.stdout.trim());
  await walk(serial, [{ clear: true }, { wait: 2500 }, { relaunch: true }, { see: '^Đăng nhập bằng SSO', timeout: 40000 }, { sso: true }], undefined, log);
  // A person with one unit goes straight to the second factor or the home screen: each step is done only when the screen asks for it.
  for (let look = 0; look < 8; look += 1) {
    await sleep(2500);
    const nodes = readScreen(serial);
    const labels = nodes.map((node) => node.label);
    if (labels.some((label) => /Tab 1 trong tổng số/u.test(label))) return;
    if (labels.some((label) => /^Chọn đơn vị và vai trò/u.test(label))) {
      const wanted = nodes.find((node) => new RegExp(`^${unit}`, 'u').test(node.label));
      const choice = wanted ?? nodes.find((node) => node.clickable && node.bounds.top > 330 && !/^Tiếp tục$/u.test(node.label));
      log(`unit choice: ${choice?.label ?? 'none'}`);
      if (choice !== undefined) tap(serial, ...centre(choice));
      await sleep(1000);
      const next = readScreen(serial).find((node) => /^Tiếp tục$/u.test(node.label));
      if (next !== undefined) tap(serial, ...centre(next));
    } else if (labels.some((label) => /Xác thực trong trình duyệt/u.test(label))) await walk(serial, [{ mfa: true }], undefined, log);
  }
}

/** Films one scene of the plan and saves the portrait film and its entry in the index. */
export async function filmScene(id, { serial, outDir = OUT_DIR, plan = loadPlan(), log = console.log, edition = 'public' } = {}) {
  const scene = plan.scenes[id];
  if (scene === undefined) throw new Error(`the plan has no scene ${id}`);
  mkdirSync(outDir, { recursive: true });
  const work = join(outDir, `${id}.work`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const screen = new Screen(serial, work);
  const recorder = {
    pause: () => screen.pause(),
    resume: async () => {
      screen.start();
      await sleep(LAG_MS);
    },
  };
  // Get to the first screen of the scene without filming it.
  await walk(serial, scene.before ?? [{ relaunch: true }], undefined, log);
  const started = Date.now();
  screen.start();
  await sleep(LAG_MS);
  await walk(serial, scene.ops, recorder, log);
  const missing = scene.minSec * 1000 - (Date.now() - started);
  if (missing > 0) await sleep(missing);
  const pieces = await screen.stop();
  if (pieces.length === 0) throw new Error(`no film of ${id}`);
  const joined = pieces.length === 1 ? pieces[0] : join(work, 'joined.mp4');
  if (pieces.length > 1) {
    writeFileSync(join(work, 'list.txt'), pieces.map((piece) => `file '${piece.replace(/\\/gu, '/')}'`).join('\n'));
    ffmpeg(['-f', 'concat', '-safe', '0', '-i', join(work, 'list.txt'), '-c', 'copy', joined]);
  }
  // Constant 30 fps (the device writes a picture only when the screen changes), the first moments before the picture cut off.
  const file = join(outDir, `${id}.mp4`);
  ffmpeg(['-ss', String(LAG_MS / 1000), '-i', joined, '-vf', 'fps=30,format=yuv420p', '-r', '30', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-movflags', '+faststart', file]);
  const entry = { scene: id, edition, file, durationMs: probeMs(file), persona: scene.persona, headline: scene.headline ?? null };
  updateIndex(outDir, entry);
  rmSync(work, { recursive: true, force: true });
  log(`film ${id}: ${(entry.durationMs / 1000).toFixed(1)} s -> ${file}`);
  return entry;
}

/** The index of the footage: scene id and edition -> file and duration. */
export function updateIndex(outDir, entry) {
  const file = join(outDir, 'index.json');
  const index = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { schema: 'phone-footage/1', orientation: 'portrait', size: '720x1560', fps: 30, scenes: {} };
  index.scenes[entry.scene] = { scene: entry.scene, edition: entry.edition, file: entry.file, durationMs: entry.durationMs, persona: entry.persona, headline: entry.headline };
  writeFileSync(file, `${JSON.stringify(index, null, 2)}\n`);
}

/** Stops a recording that a failed walk left running on the device. */
function screenStop(serial) {
  adb(serial, 'shell', 'pkill', '-2', 'screenrecord');
}

async function main(argv) {
  const [command, ...rest] = argv;
  const serial = arg(argv, 'serial', 'emulator-5554');
  const edition = arg(argv, 'edition', 'public');
  const plan = loadPlan();
  if (command === 'list') {
    for (const [id, scene] of Object.entries(plan.scenes)) console.log(`${id}\t${scene.persona}\t${scene.minSec} s\t${scene.headline ?? ''}`);
    return 0;
  }
  if (command === 'check') {
    const problems = planProblems(plan);
    console.log(problems.length === 0 ? `plan ok: ${Object.keys(plan.scenes).length} scenes` : problems.join('\n'));
    return problems.length === 0 ? 0 : 1;
  }
  if (command === 'dump') {
    for (const node of readScreen(serial)) if (node.label !== '') console.log(`${node.clickable ? '[tap]' : '     '} ${node.label.replace(/\n/gu, ' / ')}  @${node.bounds.left},${node.bounds.top}`);
    return 0;
  }
  prepareDevice(serial);
  if (command === 'sign-in') {
    const persona = arg(argv, 'persona', 'owner');
    await signIn(serial, { persona, unit: plan.units[edition] ?? plan.units.public });
    return 0;
  }
  if (command === 'scene') {
    const ids = rest.filter((word) => !word.startsWith('--') && word !== serial && word !== edition && word !== arg(argv, 'out', ''));
    for (const id of ids) {
      try {
        await filmScene(id, { serial, outDir: outDirOf(edition, arg(argv, 'out', OUT_DIR)), plan, edition });
      } catch (error) {
        // A walk that fails is reported and the next scene goes on (the emulator is brought back to the first screen by the next walk).
        console.error(`scene ${id} failed: ${error instanceof Error ? error.message : error}`);
        screenStop(serial);
      }
    }
    return 0;
  }
  console.error('usage: phone-film.mjs <sign-in|scene|dump|list|check> ...');
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
