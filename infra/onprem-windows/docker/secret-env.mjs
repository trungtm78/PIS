// Preloaded by the api image (node --import): turns every NAME_FILE=<path> variable into NAME=<content of the file> before the application reads its environment.
// Secrets are files mounted from the host; they never sit in the image or in the compose file. Values are never printed.
import { loadSecretFiles } from './secret-files.mjs';

const unreadable = loadSecretFiles(process.env);
if (unreadable !== undefined) {
  process.stderr.write(`secret-env: ${unreadable} names a file that cannot be read\n`);
  process.exit(78);
}
