import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, cacheDir } from './lib.mjs';

/**
 * What the phone chapters need from the service apart from the business data (which the seed layer makes through the product's commands):
 * who the next sign-in is, a session that is revoked, and the conditions of the service that no data makes (a service that fails, a licence that
 * has expired, a maintenance window). Run as `node scripts/hdsd/mobile-data.mjs <command> [argument]`; the chapters call it with the operation `run`.
 *
 * The conditions go through a small proxy between the phone and the API (`proxy`): the phone is told the API is at 3999 (adb reverse to the proxy), the proxy
 * passes everything through and, in a mode, answers instead of the API. The real API has no version policy for the application yet (`GET /mobile/version-policy`
 * is asked by the application and answered by nobody), so the maintenance notice of MOB-54 can only be shown by answering it here.
 */

export const MODES = ['ok', 'service-down', 'licence-expired', 'maintenance'];

const problem = (status, code, title) => ({ status, headers: { 'content-type': 'application/problem+json' }, body: JSON.stringify({ type: 'about:blank', title, status, code }) });

/** What the proxy answers in a mode, or `undefined` when the call goes on to the API. The control and health paths of the stack are never answered. */
export function answerFor(mode, method, path, now = new Date()) {
  if (path.startsWith('/__')) return undefined;
  if (mode === 'service-down' && path !== '/mobile/version-policy') return problem(500, 'INTERNAL_ERROR', 'Service error');
  if (mode === 'licence-expired' && path !== '/mobile/version-policy' && method === 'GET') return problem(422, 'LICENSE_EXPIRED', 'Licence expired');
  if (mode === 'maintenance' && method === 'GET' && path === '/mobile/version-policy') {
    const ends = new Date(now.getTime() + 2 * 3_600_000);
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'maintenance', reason_code: 'MAINTENANCE_WINDOW', maintenance: { starts_at: now.toISOString(), ends_at: ends.toISOString() } }),
    };
  }
  return undefined;
}

const modeFile = (cache = cacheDir()) => join(cache, 'proxy-mode.txt');

export function readMode(cache = cacheDir()) {
  try {
    const mode = readFileSync(modeFile(cache), 'utf8').trim();
    return MODES.includes(mode) ? mode : 'ok';
  } catch {
    return 'ok';
  }
}

export function writeMode(mode, cache = cacheDir()) {
  if (!MODES.includes(mode)) throw new Error(`unknown mode ${mode}`);
  mkdirSync(cache, { recursive: true });
  writeFileSync(modeFile(cache), mode);
}

/** The proxy between the phone and the API: it passes calls on and answers in the mode of the moment. */
export function startProxy({ listen, target, cache = cacheDir() }) {
  const server = createServer((incoming, outgoing) => {
    const answer = answerFor(readMode(cache), incoming.method ?? 'GET', (incoming.url ?? '/').split('?')[0]);
    if (answer !== undefined) {
      incoming.resume();
      outgoing.writeHead(answer.status, answer.headers);
      outgoing.end(answer.body);
      return;
    }
    const forward = httpRequest({ host: '127.0.0.1', port: target, path: incoming.url, method: incoming.method, headers: incoming.headers }, (reply) => {
      outgoing.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(outgoing);
    });
    forward.on('error', () => {
      outgoing.writeHead(502, { 'content-type': 'application/problem+json' });
      outgoing.end(JSON.stringify({ type: 'about:blank', title: 'Bad gateway', status: 502, code: 'BAD_GATEWAY' }));
    });
    incoming.pipe(forward);
  });
  return new Promise((done) => server.listen(listen, '127.0.0.1', () => done(server)));
}

const fixtures = () => JSON.parse(readFileSync(join(REPO_ROOT, 'apps', 'web', 'e2e', 'support', 'e2e-fixtures.json'), 'utf8'));
const infoFile = () => {
  const file = process.env.E2E_STACK_INFO;
  if (file === undefined || file === '') throw new Error('E2E_STACK_INFO is not set');
  return file;
};

/** Who signs in next on the phone: the test identity provider reads the key of the person from the file next to the info of the stack. */
export function setPersona(key, file = infoFile()) {
  if (!fixtures().users.some((user) => user.key === key)) throw new Error(`no fixture person ${key}`);
  writeFileSync(`${file}.user`, key);
}

/** A call to the API as a person of the stack, with the development token (the same one the web session signs). */
async function apiCall(key, method, path, body) {
  const info = JSON.parse(readFileSync(infoFile(), 'utf8'));
  const user = fixtures().users.find((candidate) => candidate.key === key);
  const secret = process.env.E2E_SESSION_KEY;
  if (user === undefined || secret === undefined || secret === '') throw new Error('the person or E2E_SESSION_KEY is missing');
  const payload = Buffer.from(JSON.stringify({ tenantId: info.tenants.A, membershipId: user.membershipId, scopeVersion: 1, exp: Math.floor(Date.now() / 1000) + 300 }), 'utf8').toString('base64url');
  const token = `${payload}.${createHmac('sha256', Buffer.from(secret, 'base64')).update(payload).digest('base64url')}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  if (method !== 'GET') headers['idempotency-key'] = `hdsd-${randomUUID()}`;
  const response = await fetch(`http://127.0.0.1:${info.apiPort}${path}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  const text = await response.text();
  return { status: response.status, json: text === '' ? {} : JSON.parse(text) };
}

/** Revokes the open sessions of a person through the product (the same call as "Thu hồi" on the screen of devices); the phone's next call is refused with 401. */
export async function revokeSessions(key) {
  const listed = await apiCall(key, 'GET', '/me/sessions');
  const sessions = (listed.json.items ?? listed.json.sessions ?? listed.json.data ?? []);
  let revoked = 0;
  for (const session of sessions) {
    const done = await apiCall(key, 'POST', `/me/sessions/${session.id ?? session.session_id}/revoke`);
    if (done.status < 300) revoked += 1;
  }
  return { listed: listed.status, sessions: sessions.length, revoked };
}

const COMMANDS = {
  persona: async (argument) => {
    setPersona(argument);
    return `the next sign-in is ${argument}`;
  },
  'revoke-session': async (argument) => `sessions of ${argument ?? 'projectManager'}: ${JSON.stringify(await revokeSessions(argument ?? 'projectManager'))}`,
  'service-down': async () => (writeMode('service-down'), 'the proxy answers 500'),
  'licence-expired': async () => (writeMode('licence-expired'), 'the proxy answers 422 LICENSE_EXPIRED to reads'),
  'licence-ok': async () => (writeMode('ok'), 'the proxy passes everything'),
  maintenance: async () => (writeMode('maintenance'), 'the proxy declares a maintenance window'),
  ok: async () => (writeMode('ok'), 'the proxy passes everything'),
  denied: async () => {
    setPersona('nobody');
    return 'the next sign-in is nobody';
  },
  conflict: async () => {
    throw new Error('conflict: not made yet (it needs the diary of the seed layer; see the report)');
  },
  proxy: async (argument) => {
    const [listen, target] = (argument ?? `${process.env.E2E_PROXY_PORT ?? 4999} ${process.env.E2E_API_PORT ?? 3999}`).split(/\s+/u).map(Number);
    await startProxy({ listen, target });
    return `proxy ${listen} -> ${target}; it stays until it is killed`;
  },
};

export const commandNames = Object.keys(COMMANDS);

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [command, ...rest] = process.argv.slice(2);
  if (COMMANDS[command] === undefined) {
    console.error(`usage: node scripts/hdsd/mobile-data.mjs <${commandNames.join('|')}> [argument]`);
    process.exitCode = 1;
  } else {
    try {
      console.log(await COMMANDS[command](rest.join(' ') || undefined));
    } catch (error) {
      console.error(String(error.message ?? error));
      process.exitCode = 1;
    }
  }
}
