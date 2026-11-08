import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LAYOUT_VERSION, LAYOUT_VERSIONS } from './layout.mjs';

const SECRET_WORD = /secret|password|passwd|token|apikey|api_key|credential/i;

/** The paths of every key in a configuration that looks like a secret and holds text (a key that ends in `File` or `Env` only names where the secret is, and is allowed). */
export function secretKeysIn(value, path = '') {
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, item]) => {
    const here = path === '' ? key : `${path}.${key}`;
    if (typeof item === 'string' && SECRET_WORD.test(key) && !/(File|Env)$/.test(key)) return [here];
    return secretKeysIn(item, here);
  });
}

const fail = (message) => {
  throw new Error(`configuration: ${message}`);
};

/**
 * Judges the configuration of the collector. The secret of the machine account is never in the file: it is read from an environment variable (default `FEED_CLIENT_SECRET`) or from a file the configuration names.
 * `source` is a drop folder (`{ type: 'folder', path }`) or an export API (`{ type: 'api', url, bearerEnv? }`).
 */
export function validateConfig(raw, env = process.env) {
  const secrets = secretKeysIn(raw);
  if (secrets.length > 0) fail(`a secret must not be written in the file: ${secrets.join(', ')}`);
  const source = raw.source;
  if (source === undefined || (source.type !== 'folder' && source.type !== 'api')) fail('source.type must be folder or api');
  if (source.type === 'folder' && (typeof source.path !== 'string' || source.path === '')) fail('source.path is required for a folder');
  if (source.type === 'api' && (typeof source.url !== 'string' || !/^https?:\/\//.test(source.url))) fail('source.url must be an http or https address');
  const platform = raw.platform;
  if (platform === undefined || typeof platform.baseUrl !== 'string' || !/^https?:\/\//.test(platform.baseUrl)) fail('platform.baseUrl must be an http or https address');
  const layoutVersion = raw.layoutVersion ?? LAYOUT_VERSION;
  if (!LAYOUT_VERSIONS.includes(layoutVersion)) fail(`layoutVersion ${layoutVersion} is not read by the platform (supported: ${LAYOUT_VERSIONS.join(', ')})`);
  const intervalSeconds = raw.intervalSeconds ?? 60;
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1 || intervalSeconds > 86_400) fail('intervalSeconds must be a whole number of seconds from 1 to 86400');
  const baseUrl = platform.baseUrl.replace(/\/+$/, '');
  return {
    source: source.type === 'folder' ? { type: 'folder', path: resolve(source.path) } : { type: 'api', url: source.url, bearerEnv: source.bearerEnv ?? 'FEED_SOURCE_BEARER' },
    platform: {
      baseUrl,
      tokenUrl: platform.tokenUrl ?? `${baseUrl}/oauth/token`,
      heartbeatUrl: platform.heartbeatUrl ?? null,
      clientIdEnv: platform.clientIdEnv ?? 'FEED_CLIENT_ID',
      clientSecretEnv: platform.clientSecretEnv ?? 'FEED_CLIENT_SECRET',
      clientSecretFile: platform.clientSecretFile ?? null,
    },
    stateDir: resolve(raw.stateDir ?? 'feed-collector-state'),
    layoutVersion,
    intervalSeconds,
    retryBaseSeconds: raw.retryBaseSeconds ?? 30,
    retryMaxSeconds: raw.retryMaxSeconds ?? 3600,
    env,
  };
}

export async function loadConfig(path, env = process.env) {
  let raw;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    fail(`cannot read ${path}: ${error.message}`);
  }
  return validateConfig(raw, env);
}

/** The credentials of the machine account: the id from the environment, the secret from the environment or from the file the configuration names. Missing ones are an error that names where they are looked for. */
export async function credentialsOf(config) {
  const clientId = config.env[config.platform.clientIdEnv];
  let clientSecret = config.env[config.platform.clientSecretEnv];
  if ((clientSecret === undefined || clientSecret === '') && config.platform.clientSecretFile !== null) clientSecret = (await readFile(config.platform.clientSecretFile, 'utf8')).trim();
  if (clientId === undefined || clientId === '') fail(`the client id is not in the environment variable ${config.platform.clientIdEnv}`);
  if (clientSecret === undefined || clientSecret === '') fail(`the client secret is not in ${config.platform.clientSecretEnv} nor in a file`);
  return { clientId, clientSecret };
}
