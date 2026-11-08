import { createHmac, createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import fixtures from '../../support/e2e-fixtures.json' with { type: 'json' };
import people from '../../support/docs-people.json' with { type: 'json' };
import { STACK_DIR, STACK_INFO_PATH } from '../../support/stack-paths.ts';
import { pdfWithText } from '../pdf.ts';
import TEXTS from './data/context.json' with { type: 'json' };
import { textsOf } from '../../support/texts.ts';

const tx = textsOf(TEXTS);

/**
 * The shared client and helpers of the seeds of the guide (e2e/hdsd/seed/*.ts).
 *
 * The data of the guide is made ONLY through the product's own commands: the real HTTP API of the stack, as one of the seven people of
 * apps/web/e2e/support/docs-people.json (the API decides what each may do: maker is not checker, approvals, state machines). Nothing here
 * writes to the database. A group is `export async function seed<Group>(ctx: SeedContext): Promise<void>`; it builds on the groups before it by
 * QUERYING what exists (`ctx.list`), never by ids written in the code.
 *
 * This file is shared by every group: it is only ever extended, never changed in a way that breaks a seed already written.
 */

// ---- shapes ------------------------------------------------------------------------------------------------------------------------

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
/** The body of any JSON answer; the seeds name the fields they read. */
export type Obj = Record<string, unknown>;
export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A person of the guide: `key` is what `call` takes (owner, unitAdmin, projectManager, capApprover, treasuryMaker, auditor, nobody, plus any added). */
export interface Person {
  key: string;
  name: string;
  initials: string;
  unit: number;
  role: string;
  membershipId: string;
}

export interface CallOptions {
  /** The version the caller saw (`If-Match`): a number, or the answer of the command that made it (its `resource_version`). */
  version?: number | { resource_version: number };
  /** Query string values; undefined ones are left out. */
  query?: Record<string, string | number | boolean | undefined>;
  /** Replaces the random idempotency key of a command (to repeat the very same intention). */
  idempotencyKey?: string;
  headers?: Record<string, string>;
}

export interface Reply<T = Obj> {
  status: number;
  ok: boolean;
  /** The parsed JSON answer ({} when the answer is empty or not JSON). */
  json: T;
  text: string;
  method: Method;
  path: string;
}

/** What every successful command answers (CommandResult of openapi.json). */
export interface CommandReply {
  operation_id: string;
  status: string;
  resource_version: number;
  resource_id: string;
}

/** A line of the ledger (apps/web/e2e/.stack/seed-ledger.<group>.json, or next to the stack info file). */
export interface LedgerEntry {
  group: string;
  module: string;
  screen?: string;
  kind: string;
  id: string;
  code: string;
  note: string;
}

export interface Upload {
  filename: string;
  mime?: string;
  buffer: Buffer;
  /** The form field of the file ('file' by default). */
  field?: string;
  /** More form fields. */
  fields?: Record<string, string>;
}

export interface StackInfoFile {
  apiPort: number;
  tenants: { A: string; B: string; C: string };
  units: { A: Record<string, string> };
}

/** A failed step: it names its module, the command, the HTTP status and the body of the answer. */
export class SeedError extends Error {
  readonly reply?: Reply;
  constructor(message: string, reply?: Reply) {
    super(message);
    this.name = 'SeedError';
    this.reply = reply;
  }
}

/** A nested part of a loose body as a body: an empty one when the part is missing or is not an object (so a field can be read off it safely). */
export function asObj(value: unknown): Obj {
  return typeof value === 'object' && value !== null ? (value as Obj) : {};
}

/** The version of a row read from a loose body, as a command takes it: a number, or a numeric string; anything else is no version. */
export function asVersion(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

// ---- pure helpers (unit tested: context.test.ts) -----------------------------------------------------------------------------------

/** Vietnamese text without its marks, upper-cased and joined by hyphens: a business code from a name. */
export function codeOf(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[\u0111\u0110]/gu, 'D')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

/** `DA-2026-007`: a prefix, a year (optional) and a running number of a fixed width. */
export function seqCode(prefix: string, n: number, options: { year?: number; width?: number } = {}): string {
  const width = options.width ?? 3;
  return [prefix, options.year === undefined ? undefined : String(options.year), String(n).padStart(width, '0')].filter((part) => part !== undefined).join('-');
}

/** An amount in billions of dong as the string of whole dong the API takes (`vnd(150)` is "150000000000"). */
export function vnd(billions: number): string {
  return String(Math.round(billions * 1_000_000_000));
}

/** An amount in millions of dong, the same way. */
export function vndMillions(millions: number): string {
  return String(Math.round(millions * 1_000_000));
}

/** A ten-digit tax code of a firm, stable for a number (the first two digits follow the province code of Cao Bang, 04). */
export function taxCode(n: number): string {
  const digest = createHash('sha256').update(`mst-${n}`).digest();
  const tail = Array.from(digest.subarray(0, 8), (byte) => byte % 10).join('');
  return `04${tail}`;
}

/** The date (YYYY-MM-DD) that is `days` days from `from`, in the calendar of Vietnam. */
export function shiftDate(from: string, days: number): string {
  const [y, m, d] = from.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return shifted.toISOString().slice(0, 10);
}

/** Today's date in Vietnam (UTC+7) for an instant. */
export function vietnamDate(instant: Date): string {
  return new Date(instant.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
}

/** The Monday of the week of a date (weekly reports are kept by week starting Monday). */
export function mondayOf(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return shiftDate(date, -((weekday + 6) % 7));
}

/** The first day of the month of a date, shifted by whole months. */
export function monthStart(date: string, shiftMonths = 0): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + shiftMonths, 1)).toISOString().slice(0, 10);
}

/** The last day of the month of a date, shifted by whole months. */
export function monthEnd(date: string, shiftMonths = 0): string {
  return shiftDate(monthStart(date, shiftMonths + 1), -1);
}

/** The whole body of the answer, for a message of an error (long bodies are cut). */
function brief(text: string): string {
  return text.length > 1200 ? `${text.slice(0, 1200)}...` : text;
}

function versionOf(version: CallOptions['version']): number | undefined {
  if (version === undefined) return undefined;
  return typeof version === 'number' ? version : version.resource_version;
}

// ---- the context -------------------------------------------------------------------------------------------------------------------

export class SeedContext {
  /** The group being seeded; set by the runner, written on the ledger lines. */
  group = 'base';
  /** The module being seeded: `step` sets it, errors name it. */
  module = '';
  /** The instant the seed started; `today` and every relative date come from it. */
  asOf: Date;
  /** Today in Vietnam (YYYY-MM-DD). */
  today: string;
  readonly people: Record<string, Person>;
  readonly ledger: LedgerEntry[] = [];
  readonly warnings: string[] = [];
  readonly stackDir: string;
  readonly info: StackInfoFile;
  private readonly sessionKey: Buffer;
  private readonly base: string;
  private calls = 0;
  /** Logs one line per step to this function (the runner prints; the Playwright spec prints too). */
  log: (line: string) => void = (line) => void process.stdout.write(`${line}\n`);

  constructor(options: { asOf?: Date } = {}) {
    const key = process.env.E2E_SESSION_KEY;
    if (key === undefined || key === '') throw new SeedError('E2E_SESSION_KEY is not set (it must be the key the stack was started with)');
    this.sessionKey = Buffer.from(key, 'base64');
    this.info = JSON.parse(readFileSync(STACK_INFO_PATH, 'utf8')) as StackInfoFile;
    // CLIP_API_URL points the seeds at an API that is not on the loopback port of the stack info (scripts/clip-seed.mjs apply --api).
    this.base = (process.env.CLIP_API_URL ?? '') === '' ? `http://127.0.0.1:${this.info.apiPort}` : String(process.env.CLIP_API_URL).replace(/\/+$/u, '');
    this.stackDir = STACK_DIR;
    this.asOf = options.asOf ?? new Date();
    this.today = vietnamDate(this.asOf);
    this.people = Object.fromEntries(
      (people as Array<{ key: string; name: string; initials: string; unit: number; role: string }>).map((person) => {
        const fixture = fixtures.users.find((user) => user.key === person.key);
        if (fixture === undefined) throw new SeedError(`the person ${person.key} has no fixture account (e2e-fixtures.json)`);
        return [person.key, { ...person, membershipId: fixture.membershipId }];
      }),
    );
  }

  // ---- identity and units

  /** The id of a unit of the tenant by code (CB-SKHDT-QLDA, CB-SKHDT-VP, CB-SKHDT, CB-STC, CB-HQ). */
  unitId(code: string): string {
    const id = this.info.units.A[code];
    if (id === undefined) throw new SeedError(`unit ${code} does not exist (known: ${Object.keys(this.info.units.A).join(', ')})`);
    return id;
  }

  nameOf(person: string): string {
    return this.person(person).name;
  }

  person(key: string): Person {
    const found = this.people[key];
    if (found === undefined) throw new SeedError(`the person ${key} is not in docs-people.json (known: ${Object.keys(this.people).join(', ')})`);
    return found;
  }

  /** The development session token of a person, valid for five minutes (the same format and key the web session signs with). */
  token(person: string): string {
    const payload = Buffer.from(JSON.stringify({ tenantId: this.info.tenants.A, membershipId: this.person(person).membershipId, scopeVersion: 1, aal: 'aal2', aal2At: new Date().toISOString(), exp: Math.floor(Date.now() / 1000) + 300 }), 'utf8').toString('base64url');
    return `${payload}.${createHmac('sha256', this.sessionKey).update(payload).digest('base64url')}`;
  }

  // ---- dates

  /**
   * Takes the day from the clock of the stack (GET /__e2e/clock) when it has one: the clip data is made with the clock of the stack moved to the past, and
   * every date the seeds compute (`day`, `today`) must be the day the server believes it is. A stack without the route keeps the clock of this machine.
   */
  async syncClock(): Promise<void> {
    try {
      const response = await fetch(`${this.base}/__e2e/clock`);
      if (!response.ok) return;
      const body = (await response.json()) as { now?: string };
      if (typeof body.now === 'string') {
        this.asOf = new Date(body.now);
        this.today = vietnamDate(this.asOf);
      }
    } catch (error) {
      this.warn(`the clock of the stack cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The date `days` days from today (negative: in the past), YYYY-MM-DD. */
  day(days: number): string {
    return shiftDate(this.today, days);
  }

  /** The year of today. */
  get year(): number {
    return Number(this.today.slice(0, 4));
  }

  // ---- calls

  private async send<T>(person: string, method: Method, path: string, body: unknown, options: CallOptions, form?: FormData): Promise<Reply<T>> {
    const query = Object.entries(options.query ?? {})
      .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      .join('&');
    const url = `${this.base}${path}${query === '' ? '' : `${path.includes('?') ? '&' : '?'}${query}`}`;
    const headers: Record<string, string> = { authorization: `Bearer ${this.token(person)}`, accept: 'application/json, application/problem+json', ...options.headers };
    if (form === undefined && method !== 'GET' && method !== 'DELETE') headers['content-type'] = 'application/json';
    if (method !== 'GET') headers['idempotency-key'] = options.idempotencyKey ?? randomUUID();
    const version = versionOf(options.version);
    if (version !== undefined) headers['if-match'] = `"${version}"`;
    for (let attempt = 0; ; attempt += 1) {
      this.calls += 1;
      const response = await fetch(url, {
        method,
        headers,
        body: form ?? (method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body ?? {})),
      });
      const text = await response.text();
      let json: unknown = {};
      try {
        json = text === '' ? {} : JSON.parse(text);
      } catch {
        json = {};
      }
      const busy = response.status === 409 && /IDEMPOTENCY_IN_PROGRESS/u.test(text);
      if ((busy || response.status === 429 || response.status === 503) && attempt < 6) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 800 * (attempt + 1)));
        continue;
      }
      return { status: response.status, ok: response.ok, json: json as T, text, method, path };
    }
  }

  /**
   * One call to the API as a person. It never throws on an HTTP error: the reply says (`ok`, `status`, `json`). Commands carry an
   * Idempotency-Key by themselves; give `version` for a versioned one.
   */
  call<T = Obj>(person: string, method: Method, path: string, body?: unknown, options: CallOptions = {}): Promise<Reply<T>> {
    return this.send<T>(person, method, path, body, options);
  }

  /** A multipart upload (the file endpoints: /document-files, /report-files, ...). */
  upload<T = Obj>(person: string, path: string, file: Upload, options: CallOptions = {}): Promise<Reply<T>> {
    const form = new FormData();
    form.append(file.field ?? 'file', new Blob([new Uint8Array(file.buffer)], { type: file.mime ?? 'application/pdf' }), file.filename);
    for (const [name, value] of Object.entries(file.fields ?? {})) form.append(name, value);
    return this.send<T>(person, 'POST', path, undefined, options, form);
  }

  /** Throws a descriptive error when a reply is not ok; returns it otherwise. */
  expectOk<T>(reply: Reply<T>, what?: string): Reply<T> {
    if (reply.ok) return reply;
    throw new SeedError(`[${this.group}/${this.module || '-'}] ${what === undefined ? '' : `${what}: `}${reply.method} ${reply.path} -> HTTP ${reply.status} ${brief(reply.text)}`, reply as Reply);
  }

  /** `call` that throws a descriptive error (module, command, HTTP status, body) unless the reply is ok; returns the JSON body. */
  async must<T = Obj>(person: string, method: Method, path: string, body?: unknown, options: CallOptions = {}): Promise<T> {
    return this.expectOk(await this.call<T>(person, method, path, body, options)).json;
  }

  /** `must` for a command: the answer is typed as the CommandResult (`resource_id`, `resource_version`, `status`). */
  command(person: string, path: string, body?: unknown, options: CallOptions = {}): Promise<CommandReply> {
    return this.must<CommandReply>(person, 'POST', path, body, options);
  }

  /** `must` for a read. */
  get<T = Obj>(person: string, path: string, query?: CallOptions['query']): Promise<T> {
    return this.must<T>(person, 'GET', path, undefined, { query });
  }

  /**
   * Like `call`, for a step that may legitimately be refused by the rules of the product (a state that does not allow it): a refusal is
   * written in `warnings` and the reply returned; seeds go on. A refusal that says nothing about the business (HTTP 5xx) still throws.
   */
  async attempt<T = Obj>(person: string, method: Method, path: string, body?: unknown, options: CallOptions = {}): Promise<Reply<T>> {
    const reply = await this.call<T>(person, method, path, body, options);
    if (reply.status >= 500) this.expectOk(reply);
    if (!reply.ok) this.warn(`${method} ${path} -> HTTP ${reply.status} ${brief(reply.text).slice(0, 300)}`);
    return reply;
  }

  /**
   * Every row of a list endpoint ({items, next_cursor}), following the cursor. `path` may already carry a query string. The key of the
   * rows is `items` unless the answer names another array (`rows`, `data`).
   */
  async list<T = Obj>(person: string, path: string, query: CallOptions['query'] = {}): Promise<T[]> {
    const rows: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 200; page += 1) {
      const answer = await this.must<Obj>(person, 'GET', path, undefined, { query: { limit: 200, ...query, cursor } });
      const items: unknown = Array.isArray(answer) ? answer : (answer.items ?? answer.rows ?? answer.data);
      if (!Array.isArray(items)) return rows;
      rows.push(...(items as T[]));
      cursor = typeof answer.next_cursor === 'string' && answer.next_cursor !== '' ? answer.next_cursor : undefined;
      if (cursor === undefined) break;
    }
    return rows;
  }

  /** The first row of a list that matches, or undefined: the "skip if it exists" of a seed. */
  async find<T = Obj>(person: string, path: string, match: (row: T) => boolean, query: CallOptions['query'] = {}): Promise<T | undefined> {
    return (await this.list<T>(person, path, query)).find(match);
  }

  // ---- files

  /** A small valid PDF with some lines of text (a scanned letter, a decision, a report). */
  pdf(...lines: string[]): Buffer {
    return pdfWithText(lines);
  }

  sha256(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
  }

  // ---- documents (the decisions that ground the commands of every module)

  private readonly letterIds = new Map<string, { documentId: string; incomingId: string }>();
  private lettersLoaded = false;

  /**
   * A letter of the incoming register (the decision, the submission, the minutes a command cites as its ground), received once by its original
   * symbol: a second call with the same symbol returns the one already there. `documentId` is what the commands name (decision_document_id,
   * policy_proposal_document_id, evidence_document_id...). The document type `docType` (QD by default) must exist: group `base` defines QD.
   */
  async letter(spec: { symbol: string; title: string; issuedOn?: string; sender?: string; docType?: string; person?: string; urgency?: 'NORMAL' | 'KHAN' | 'THUONG_KHAN' | 'HOA_TOC' }): Promise<{ documentId: string; incomingId: string }> {
    const person = spec.person ?? 'projectManager';
    if (!this.lettersLoaded) {
      for (const row of await this.list<Obj>(person, '/incoming-documents')) if (typeof row.original_symbol === 'string') this.letterIds.set(row.original_symbol, { documentId: String(row.document_id), incomingId: String(row.id) });
      this.lettersLoaded = true;
    }
    const known = this.letterIds.get(spec.symbol);
    if (known !== undefined) return known;
    const buffer = this.pdf(codeOf(spec.sender ?? 'UBND TINH CAO BANG'), `So ${codeOf(spec.symbol)}`, codeOf(spec.title).slice(0, 80));
    const file = this.expectOk(await this.upload<{ file_object_key: string; file_sha256: string }>(person, '/document-files', { filename: `${codeOf(spec.symbol).toLowerCase()}.pdf`, buffer }), `upload the letter ${spec.symbol}`).json;
    const received = await this.must<{ resource_id: string; document_id: string }>(person, 'POST', '/incoming-documents', {
      title: spec.title,
      doc_type_code: spec.docType ?? 'QD',
      channel: 'UPLOAD',
      file_object_key: file.file_object_key,
      file_sha256: file.file_sha256,
      original_symbol: spec.symbol,
      original_issued_on: spec.issuedOn ?? this.day(-30),
      sender_name: spec.sender ?? tx('sender_name.001'),
      ...(spec.urgency === undefined ? {} : { urgency: spec.urgency }),
    });
    const made = { documentId: received.document_id, incomingId: received.resource_id };
    this.letterIds.set(spec.symbol, made);
    return made;
  }

  // ---- steps, ledger, warnings

  /** Names the step: a failure inside is reported with module and title; the elapsed time is logged. */
  async step<T>(module: string, title: string, run: () => Promise<T>): Promise<T> {
    this.module = module;
    const started = Date.now();
    try {
      const result = await run();
      this.log(`  [${this.group}/${module}] ${title} (${Date.now() - started} ms)`);
      return result;
    } catch (error) {
      if (error instanceof SeedError) throw error;
      throw new SeedError(`[${this.group}/${module}] ${title}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Writes a line of the ledger: what was made (or found), for the report and for the screens' check. */
  record(entry: Omit<LedgerEntry, 'group'> & { group?: string }): void {
    this.ledger.push({ group: this.group, ...entry });
  }

  warn(message: string): void {
    const line = `[${this.group}/${this.module || '-'}] ${message}`;
    this.warnings.push(line);
    this.log(`  ! ${line}`);
  }

  /** How many HTTP calls were made. */
  get callCount(): number {
    return this.calls;
  }

  /** Writes the ledger of a group to `<stack dir>/seed-ledger.<group>.json` (the entries of that group only). */
  flushLedger(group: string = this.group): string {
    mkdirSync(this.stackDir, { recursive: true });
    const file = join(this.stackDir, `seed-ledger.${group}.json`);
    writeFileSync(file, `${JSON.stringify(this.ledger.filter((entry) => entry.group === group), null, 2)}\n`, 'utf8');
    return file;
  }
}
