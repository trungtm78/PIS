// Run once while the api image is built: links every workspace package of C:\app\packages into node_modules\@machvon, as `npm ci` does on the build machine
// (a directory junction does not survive the copy of the build pack to the server, so the pack carries none).
import { mkdirSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = dirname(fileURLToPath(import.meta.url));
const scope = join(app, 'node_modules', '@machvon');
mkdirSync(scope, { recursive: true });
for (const entry of readdirSync(join(app, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const { name } = JSON.parse(readFileSync(join(app, 'packages', entry.name, 'package.json'), 'utf8'));
  if (typeof name !== 'string' || !name.startsWith('@machvon/')) continue;
  symlinkSync(join(app, 'packages', entry.name), join(scope, name.slice('@machvon/'.length)), 'junction');
}
