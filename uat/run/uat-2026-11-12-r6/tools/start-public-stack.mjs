// Starts the API stack of the PUBLIC edition the way scripts/demo-enterprise.mjs starts the enterprise one (nothing forked, only run): `npm run e2e:stack -w @machvon/api` with the docs seed
// and no edition variable, then `node scripts/clip-seed.mjs apply --dataset public`. It stays up until the file <dir>/stack-info.json.stop exists, then stops the stack through that file.
// node start-public-stack.mjs <dir> <apiPort> <idpPort> <sessionKey>
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [dir, apiPort, idpPort, sessionKey] = process.argv.slice(2);
const ROOT = resolve('.');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const infoPath = join(dir, 'stack-info.json');
const env = { ...process.env, E2E_SEED: 'docs', E2E_API_PORT: apiPort, E2E_IDP_PORT: idpPort, E2E_SESSION_KEY: sessionKey, E2E_STACK_INFO: infoPath, MACHVON_TEST_LANE: 'unit' };
delete env.MACHVON_EDITION;
const stack = spawn('npm.cmd', ['run', 'e2e:stack', '-w', '@machvon/api'], { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'], shell: true });
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
let up = false;
for (let i = 0; i < 720 && !up; i += 1) {
  await wait(500);
  try {
    up = (await fetch(`http://127.0.0.1:${apiPort}/__e2e/health`)).ok;
  } catch {
    up = false;
  }
}
if (!up) {
  console.error('the stack did not come up');
  process.exit(1);
}
console.log('[public-stack] API up, seeding the public dataset');
const seed = spawnSync('node', ['scripts/clip-seed.mjs', 'apply', '--dataset', 'public', '--api', `http://127.0.0.1:${apiPort}`, '--stack-info', infoPath], { cwd: ROOT, env, stdio: 'inherit', shell: true });
console.log(`[public-stack] SEED-EXIT ${seed.status}`);
console.log('[public-stack] READY');
while (!existsSync(`${infoPath}.stop`)) await wait(1000);
writeFileSync(`${infoPath}.stop`, 'stop');
await wait(15000);
spawnSync('taskkill', ['/PID', String(stack.pid), '/T', '/F'], { shell: true });
console.log('[public-stack] stopped');
process.exit(0);
