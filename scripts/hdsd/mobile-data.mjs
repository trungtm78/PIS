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
async function apiCall(key, method, path, body, version) {
  const info = JSON.parse(readFileSync(infoFile(), 'utf8'));
  const user = fixtures().users.find((candidate) => candidate.key === key);
  const secret = process.env.E2E_SESSION_KEY;
  if (user === undefined || secret === undefined || secret === '') throw new Error('the person or E2E_SESSION_KEY is missing');
  const payload = Buffer.from(JSON.stringify({ tenantId: info.tenants.A, membershipId: user.membershipId, scopeVersion: 1, exp: Math.floor(Date.now() / 1000) + 300 }), 'utf8').toString('base64url');
  const token = `${payload}.${createHmac('sha256', Buffer.from(secret, 'base64')).update(payload).digest('base64url')}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  if (method !== 'GET') headers['idempotency-key'] = `hdsd-${randomUUID()}`;
  if (version !== undefined) headers['if-match'] = `"${version}"`;
  const response = await fetch(`http://127.0.0.1:${info.apiPort}${path}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  const text = await response.text();
  return { status: response.status, json: text === '' ? {} : JSON.parse(text) };
}

/** Revokes the open sessions of a person through the product (the same call as the revoke button on the screen of devices); the phone's next call is refused with 401. */
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

/**
 * A diary that conflicts with the server (MOB-42): the way the product itself makes one. A site diary of a contract and a day is saved, then revised (version 2);
 * a second save of the same day from "a device" that last saw version 1 is answered 409 DIARY_SYNC_CONFLICT and the server keeps the second copy as a conflict diary,
 * which the person then resolves (keep the main copy, adopt the other, or merge). Everything goes through the commands of the product as the officer; the contract is the
 * first active one (the seed layer makes the contracts), the day is a working day in the past with no diary yet. `call(person, method, path, body)` answers `{ status, json }`.
 */
export async function makeDiaryConflict({ call, today = new Date(), operationId = randomUUID, person = 'projectManager' }) {
  const contracts = (await call(person, 'GET', '/resources/contract?limit=200')).json;
  const active = (contracts.items ?? []).find((row) => row.status === 'ACTIVE');
  if (active === undefined) throw new Error('conflict: there is no active contract; run the seed layer (group clip-public-contracts) first');
  const taken = new Set(((await call(person, 'GET', `/resources/site_diary?contract_id=${active.id}&limit=200`)).json.items ?? []).map((row) => String(row.record_date).slice(0, 10)));
  let day;
  for (let ago = 2; ago < 60 && day === undefined; ago += 1) {
    const candidate = new Date(today.getTime() - ago * 86_400_000);
    const weekday = candidate.getUTCDay();
    const text = candidate.toISOString().slice(0, 10);
    if (weekday !== 0 && weekday !== 6 && !taken.has(text)) day = text;
  }
  if (day === undefined) throw new Error('conflict: no free working day in the last sixty days');
  const first = await call(person, 'POST', '/site-diaries', { contract_id: active.id, record_date: day, client_operation_id: operationId(), content: { weather_code: 'SUNNY', workforce_count: 40, work_done: 'Concrete of the foundation, first lift', issues: 'None' } });
  if (first.status >= 300) throw new Error(`conflict: the diary was refused (${first.status})`);
  const id = first.json.resource_id;
  const revised = await call(person, 'POST', `/site-diaries/${id}/draft`, { content: { weather_code: 'RAIN', workforce_count: 32, work_done: 'Concrete of the foundation, second lift', issues: 'Rain in the afternoon' }, client_operation_id: operationId() }, first.json.resource_version);
  if (revised.status >= 300) throw new Error(`conflict: the revision was refused (${revised.status})`);
  const other = await call(person, 'POST', '/site-diaries', { contract_id: active.id, record_date: day, client_operation_id: operationId(), base_server_version: first.json.resource_version, content: { weather_code: 'SUNNY', workforce_count: 45, work_done: 'Formwork of the columns', issues: 'None' } });
  if (other.status !== 409 || other.json.code !== 'DIARY_SYNC_CONFLICT') throw new Error(`conflict: the server did not answer a conflict (${other.status} ${other.json.code ?? ''})`);
  return { contract: active.id, day, diary: id, conflictOf: other.json.diary_id ?? null };
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
    const made = await makeDiaryConflict({ call: (person, method, path, body, version) => apiCall(person, method, path, body, version) });
    return `a diary of ${made.day} conflicts with the server copy (contract ${made.contract}, diary ${made.diary})`;
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
