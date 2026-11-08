// The command line of the recorder.
//   node scripts/clips/record/cli.mjs <scene.json | scene.mjs> --web-url http://127.0.0.1:5173 --api-url http://127.0.0.1:3000 [options]
//   --check-data      only read the key lists of the tenant and say whether the scene may be recorded (no browser, no emulator)
//   --dry-run         only check the scene (steps, actions, targets); no stack is needed
//   --slow 1.5        slow motion: every pause, travel and key is 1.5 times longer (1 is real time)
//   --audio file      the audio index of the clip ({ steps: { <id>: { durationMs } } }): each step lasts as long as its voice
//   --only a,b        record only these steps (a retake)
//   --out dir         where the files go (default D:/tmp/clips-out/record)
//   --serial id       the adb serial of the emulator (phone scenes)
// The session key and the tenant come from the environment: E2E_SESSION_KEY, CLIPS_TENANT_ID, CLIPS_MEMBERSHIP_ID (or CLIPS_API_TOKEN).
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from '../animatic/lib.mjs';
import { EmptyTenantError } from './data-guard.mjs';
import { recordPhoneScene } from './phone.mjs';
import { OUT_ROOT, checkTenant, recordWebScene } from './recorder.mjs';
import { parseScene, sceneProblems } from './scene.mjs';

/** A scene from a json file (actions as data) or from a module (`export default scene`, steps may hold `run` functions). */
export async function loadSceneFile(file) {
  const path = resolve(file);
  if (extname(path) === '.json') return JSON.parse(readFileSync(path, 'utf8'));
  const module = await import(pathToFileURL(path).href);
  return module.default ?? module.scene;
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [file] = positional;
  if (file === undefined) {
    console.error('usage: node scripts/clips/record/cli.mjs <scene.json | scene.mjs> --web-url <url> --api-url <url> [--slow 1.5] [--audio file] [--only a,b] [--out dir] [--serial id] [--check-data] [--dry-run]');
    process.exitCode = 1;
    return;
  }
  const raw = await loadSceneFile(file);
  const problems = sceneProblems(raw);
  if (problems.length > 0) throw new Error(`scene ${raw?.id ?? file}: ${problems.join('; ')}`);
  const scene = parseScene(raw);
  if (flags['dry-run'] === true) {
    console.log(`${scene.id}: ${scene.platform} scene, ${scene.platform === 'phone' ? `phone chapter ${scene.phoneChapter}` : `${scene.steps.length} steps`}, edition ${scene.edition ?? 'public'}`);
    return;
  }
  const apiUrl = typeof flags['api-url'] === 'string' ? flags['api-url'] : process.env.CLIPS_API_URL;
  if (apiUrl === undefined) throw new Error('the address of the API is needed to read the tenant (--api-url or CLIPS_API_URL)');
  let verdict;
  try {
    verdict = await checkTenant(scene, { apiUrl });
    console.log(`data guard passed: ${verdict.rows.map((row) => `${row.id}=${row.found}`).join(' ')}`);
  } catch (error) {
    if (error instanceof EmptyTenantError) {
      console.error(error.message);
      process.exitCode = 2;
      return;
    }
    throw error;
  }
  if (flags['check-data'] === true) return;
  const outDir = typeof flags.out === 'string' ? flags.out : `${OUT_ROOT}/record`;
  const only = typeof flags.only === 'string' ? flags.only.split(',').filter((id) => id !== '') : undefined;
  if (scene.platform === 'phone') {
    console.log(await recordPhoneScene(scene, { serial: flags.serial, outDir, only }));
    return;
  }
  const audio = typeof flags.audio === 'string' ? JSON.parse(readFileSync(flags.audio, 'utf8')) : undefined;
  console.log(
    await recordWebScene(raw, {
      baseUrl: flags['web-url'],
      apiUrl,
      outDir,
      slowMo: typeof flags.slow === 'string' ? Number(flags.slow) : 1,
      audio,
      only,
      // The tenant was read just above: the verdict is handed on instead of reading it twice.
      guard: async () => verdict,
    }),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
