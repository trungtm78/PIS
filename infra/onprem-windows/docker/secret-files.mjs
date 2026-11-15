// The contract of infra/onprem/docker/secret-env.sh for the Node of the api image: every NAME_FILE=<path> variable becomes NAME=<content of the file>.
import { readFileSync } from 'node:fs';

/** Changes `env` in place. Returns the name of the first variable whose file cannot be read, or undefined when every file was read. */
export function loadSecretFiles(env, read = (path) => readFileSync(path, 'utf8')) {
  for (const [name, path] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*_FILE$/.test(name) || path === undefined || path === '') continue;
    let value;
    try {
      value = read(path);
    } catch {
      return name;
    }
    env[name.slice(0, -'_FILE'.length)] = value.replace(/[\r\n]+$/, '');
    delete env[name];
  }
  return undefined;
}
