import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SeedContext } from '../context.ts';
import type { CallOptions, Json, Method, Obj, Reply } from '../context.ts';

/**
 * Helpers shared by the modules of the group `platform-records` (DOC, NOT, OMNI, ADM, SAS, IAM, MDM).
 *
 * - `once` makes a step safe to run again on the same stack: the answer of a step that went through is kept in a small file next to the stack
 *   info, and a second run returns it instead of repeating the commands. A step is one business chain (a few commands); a step that failed
 *   half-way is not kept, so make a step small enough that repeating it from the start is harmless, or ask first (`ctx.find`) inside it.
 * - `control*` call the control plane (the platform operators of SAS) with the development token of a control-plane user.
 * - `made` writes a line of the ledger.
 */

// ---- memory of the steps ---------------------------------------------------------------------------------------------------------------

/** One file for each module (the first word of the key: `doc.template.X` is kept in the file of `doc`), so that the modules written at the same time never overwrite each other. */
function memoryPath(ctx: SeedContext, key: string): string {
  mkdirSync(ctx.stackDir, { recursive: true });
  return join(ctx.stackDir, `seed-steps.platform-records.${key.split('.')[0] ?? 'misc'}.json`);
}

function readMemory(ctx: SeedContext, key: string): Record<string, Json | Obj> {
  const file = memoryPath(ctx, key);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, Json | Obj>;
  } catch {
    return {};
  }
}

/**
 * Runs `run` once per stack: the value it returns (JSON only: ids, versions, codes) is remembered under `key` and returned again on every later run.
 * The key is stable and business-readable: `doc.template.DOC-QD-PHE-DUYET-DU-AN`.
 */
export async function once<T extends Json | Obj>(ctx: SeedContext, key: string, run: () => Promise<T>): Promise<T> {
  const memory = readMemory(ctx, key);
  if (key in memory) return memory[key] as T;
  const value = await run();
  // Read again: another module of the group may have written its own key while this step ran.
  const fresh = readMemory(ctx, key);
  fresh[key] = value;
  writeFileSync(memoryPath(ctx, key), `${JSON.stringify(fresh, null, 2)}\n`, 'utf8');
  return value;
}

/** What `once` remembered under a key (undefined when the step has not been run yet). */
export function remembered<T extends Json | Obj>(ctx: SeedContext, key: string): T | undefined {
  return readMemory(ctx, key)[key] as T | undefined;
}

// ---- ledger ----------------------------------------------------------------------------------------------------------------------------

/** One line of the ledger of the group: what was made for which screen. */
export function made(ctx: SeedContext, module: string, kind: string, code: string, note: string, options: { id?: string; screen?: string } = {}): void {
  ctx.record({ module, kind, code, note, id: options.id ?? '', ...(options.screen === undefined ? {} : { screen: options.screen }) });
}

// ---- the control plane -----------------------------------------------------------------------------------------------------------------

/** The platform pseudo-tenant a control-plane user signs in on (packages/db/src/control-database.ts). */
export const PLATFORM_TENANT_ID = '00000000-0000-4000-8000-0000000000aa';

/** The control-plane users of the stack (apps/web/e2e/support/e2e-fixtures.json): the realm role each token carries. */
export const CONTROL_USERS = {
  sysAdmin: { membershipId: '00000000-0000-4000-8000-0000000000e9', roles: ['SystemAdmin'] },
  operator: { membershipId: '00000000-0000-4000-8000-0000000000ea', roles: ['PlatformOperator'] },
  billingAdmin: { membershipId: '00000000-0000-4000-8000-0000000000eb', roles: ['BillingOperator'] },
} as const;
export type ControlUser = keyof typeof CONTROL_USERS;

function controlToken(user: ControlUser): string {
  const key = process.env.E2E_SESSION_KEY;
  if (key === undefined || key === '') throw new Error('E2E_SESSION_KEY is not set');
  const entry = CONTROL_USERS[user];
  const payload = Buffer.from(
    JSON.stringify({ tenantId: PLATFORM_TENANT_ID, membershipId: entry.membershipId, scopeVersion: 1, exp: Math.floor(Date.now() / 1000) + 300, aud: 'control', roles: entry.roles }),
    'utf8',
  ).toString('base64url');
  return `${payload}.${createHmac('sha256', Buffer.from(key, 'base64')).update(payload).digest('base64url')}`;
}

/** A call to the API as a control-plane user (never throws on an HTTP error; same reply as `ctx.call`). */
export async function controlCall<T = Obj>(ctx: SeedContext, user: ControlUser, method: Method, path: string, body?: unknown, options: CallOptions = {}): Promise<Reply<T>> {
  const query = Object.entries(options.query ?? {})
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`)
    .join('&');
  const url = `http://127.0.0.1:${ctx.info.apiPort}${path}${query === '' ? '' : `${path.includes('?') ? '&' : '?'}${query}`}`;
  const headers: Record<string, string> = { authorization: `Bearer ${controlToken(user)}`, accept: 'application/json, application/problem+json', ...options.headers };
  if (method !== 'GET' && method !== 'DELETE') headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['idempotency-key'] = options.idempotencyKey ?? randomUUID();
  const version = options.version === undefined ? undefined : typeof options.version === 'number' ? options.version : options.version.resource_version;
  if (version !== undefined) headers['if-match'] = `"${version}"`;
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, { method, headers, body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body ?? {}) });
    const text = await response.text();
    let json: unknown = {};
    try {
      json = text === '' ? {} : JSON.parse(text);
    } catch {
      json = {};
    }
    const busy = response.status === 409 && /IDEMPOTENCY_IN_PROGRESS/u.test(text);
    if ((busy || response.status === 429 || response.status === 503) && attempt < 6) {
      await new Promise((wait) => setTimeout(wait, 800 * (attempt + 1)));
      continue;
    }
    return { status: response.status, ok: response.ok, json: json as T, text, method, path };
  }
}

/** `controlCall` that throws a descriptive error unless the reply is ok; returns the JSON body. */
export async function controlMust<T = Obj>(ctx: SeedContext, user: ControlUser, method: Method, path: string, body?: unknown, options: CallOptions = {}): Promise<T> {
  return ctx.expectOk(await controlCall<T>(ctx, user, method, path, body, options)).json;
}

/** Every row of a list read of the control plane ({items, next_cursor}). */
export async function controlList<T = Obj>(ctx: SeedContext, user: ControlUser, path: string, query: CallOptions['query'] = {}): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const answer = await controlMust<Obj>(ctx, user, 'GET', path, undefined, { query: { limit: 100, ...query, cursor } });
    const items: unknown = Array.isArray(answer) ? answer : (answer.items ?? answer.rows ?? answer.data);
    if (!Array.isArray(items)) return rows;
    rows.push(...(items as T[]));
    cursor = typeof answer.next_cursor === 'string' && answer.next_cursor !== '' ? answer.next_cursor : undefined;
    if (cursor === undefined) break;
  }
  return rows;
}

// ---- dates and times for commands that take a date-time ----------------------------------------------------------------------------------

/** An ISO instant `days` days from the start of the seed, at an hour of the working day in Vietnam (UTC+7). */
export function at(ctx: SeedContext, days: number, hour = 9): string {
  const [y, m, d] = ctx.day(days).split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d, hour - 7, 0, 0)).toISOString();
}
