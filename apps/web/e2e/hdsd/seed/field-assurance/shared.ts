import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SeedContext } from '../context.ts';
import type { Obj } from '../context.ts';
import { asVersion } from '../context.ts';
import TEXTS from './data/shared.json' with { type: 'json' };
import { textsOf } from '../../../support/texts.ts';

const tx = textsOf(TEXTS);

/**
 * What the six modules of the group `field-assurance` (ISS, QMS, AUD, LND, AST, PMT) share: the papers (a letter received through DOC stands for every
 * decision, record and report the commands ask a document for), the catalogue entries (a master record goes through proposal, review and publication),
 * the working calendar of the SLAs, the projects and contracts that earlier groups made, and a way to let a refusal of the rules be a warning where the
 * story allows it. Nothing here writes to the database: every line is a command of the product, as a person of the guide.
 */

export const MAKER = 'projectManager';
export const CHECKER = 'capApprover';
export const OWNER = 'owner';

/** The words of a person, without the marks: the PDF the seeds make carries only the letters of the basic set. */
export function plain(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[\u0111\u0110]/gu, (character) => (character === '\u0111' ? 'd' : 'D'));
}

export const asString = (value: unknown): string => (typeof value === 'string' ? value : String(value ?? ''));

// ---- the papers ------------------------------------------------------------------------------------------------------------------

export interface Paper {
  /** The id of the document (what a decision or an engagement names). */
  documentId: string;
  /** The id of its version (what a permit, a handover or a payment names). */
  versionId: string;
}

export interface PaperSpec {
  /** The symbol of the letter, which is also its natural key: a letter that is there is not received twice. */
  symbol: string;
  title: string;
  /** The document type (`QD` exists after the base group; the others are defined by `ensureDocTypes`). */
  type?: string;
  sender?: string;
  issuedOn?: string;
  lines?: string[];
}

const DOC_TYPES = [
  { code: 'GP', name: tx('name.002'), abbreviation: 'GP', register: 'SO-GP' },
  { code: 'BB', name: tx('name.003'), abbreviation: 'BB', register: 'SO-BB' },
  { code: 'BC', name: tx('name.004'), abbreviation: 'BC', register: 'SO-BC' },
  { code: 'KL', name: tx('name.005'), abbreviation: 'KL', register: 'SO-KL' },
  { code: 'TB', name: tx('name.006'), abbreviation: 'TB', register: 'SO-TB' },
  { code: 'CV', name: tx('name.007'), abbreviation: 'CV', register: 'SO-CV' },
];

const knownTypes = new WeakMap<SeedContext, Set<string>>();

/**
 * The document types the papers of this group use (decision QD comes from the base group). A type that exists makes the command answer a conflict: that
 * is the "skip". A type that cannot be defined is warned about and the letter falls back to QD, so that the story goes on.
 */
export async function ensureDocTypes(ctx: SeedContext): Promise<Set<string>> {
  const known = knownTypes.get(ctx);
  if (known !== undefined) return known;
  const set = new Set<string>(['QD']);
  for (const type of DOC_TYPES) {
    const reply = await ctx.call(MAKER, 'POST', '/document-types', {
      code: type.code,
      name: type.name,
      abbreviation: type.abbreviation,
      symbol_kind: 'NAMED_TYPE',
      symbol_pattern: '{number}/{type}-{agency}',
      register_code: type.register,
      legal_basis: tx('legal_basis.008'),
      effective_from: '2026-01-01',
    });
    if (reply.ok || reply.status === 409) set.add(type.code);
    else ctx.warn(`document type ${type.code} not defined: HTTP ${reply.status} ${reply.text.slice(0, 200)}`);
  }
  knownTypes.set(ctx, set);
  return set;
}

const papers = new Map<string, Paper>();

/** The ids of the papers that a run made are kept next to the stack: the list of letters does not show the version of a file, and a second run must find them. */
function cacheFile(ctx: SeedContext): string {
  return join(ctx.stackDir, 'seed-papers.json');
}
function readCache(ctx: SeedContext): Record<string, Paper> {
  try {
    return JSON.parse(readFileSync(cacheFile(ctx), 'utf8')) as Record<string, Paper>;
  } catch {
    return {};
  }
}
function writeCache(ctx: SeedContext, symbol: string, found: Paper): void {
  const all = readCache(ctx);
  all[symbol] = found;
  mkdirSync(ctx.stackDir, { recursive: true });
  writeFileSync(cacheFile(ctx), JSON.stringify(all, null, 1), 'utf8');
}

/**
 * A letter received through DOC (an uploaded PDF), or the one that is already there with the symbol. The letter stands for the paper the command asks for:
 * the decision of an inspection, the minutes of a handover, the licence of a permit.
 */
export async function paper(ctx: SeedContext, spec: PaperSpec): Promise<Paper> {
  const cached = papers.get(`${ctx.info.apiPort}:${spec.symbol}`);
  if (cached !== undefined) return cached;
  const letters = await ctx.list(MAKER, '/incoming-documents');
  const existing = letters.find((letter) => letter.original_symbol === spec.symbol);
  let found: Paper | undefined;
  const stored = readCache(ctx)[spec.symbol];
  if (existing !== undefined && stored !== undefined) {
    found = stored;
  } else {
    const types = await ensureDocTypes(ctx);
    const type = spec.type !== undefined && types.has(spec.type) ? spec.type : 'QD';
    const bytes = ctx.pdf(...(spec.lines ?? [plain(spec.title)]).map(plain));
    const uploaded = ctx.expectOk(await ctx.upload<{ file_object_key: string; file_sha256: string }>(MAKER, '/document-files', { filename: `${plain(spec.symbol).replace(/[^A-Za-z0-9]+/gu, '-')}.pdf`, buffer: bytes }), `upload the file of ${spec.symbol}`).json;
    const received = await ctx.must<{ document_id: string; version_id: string }>(MAKER, 'POST', '/incoming-documents', {
      title: spec.title,
      doc_type_code: type,
      channel: 'UPLOAD',
      file_object_key: uploaded.file_object_key,
      file_sha256: uploaded.file_sha256,
      original_symbol: spec.symbol,
      original_issued_on: spec.issuedOn ?? ctx.day(-30),
      sender_name: spec.sender ?? tx('sender_name.009'),
      // the clerk takes the letter in again when the id of its first reception was not kept (a later run on the same stack)
      ...(existing === undefined ? {} : { duplicate_override_reason: tx('duplicate_override_reason.010') }),
    });
    found = { documentId: received.document_id, versionId: received.version_id };
  }
  papers.set(`${ctx.info.apiPort}:${spec.symbol}`, found);
  writeCache(ctx, spec.symbol, found);
  return found;
}

// ---- the catalogue ---------------------------------------------------------------------------------------------------------------

/** The master record of a type and key (any status), or undefined. */
export async function masterRecord(ctx: SeedContext, type: string, key: string): Promise<Obj | undefined> {
  return ctx.find(MAKER, '/master-records', (record) => record.business_key === key, { master_type: type });
}

/**
 * An entry of a catalogue of the tenant: proposed by the project board, sent for review, approved by the leader and published with a decision. It goes as far
 * as it is, so a half-made entry of an earlier run is finished. Returns the record (with the version in force).
 */
export async function publishMaster(ctx: SeedContext, entry: { type: string; key: string; label: string; attributes?: Obj; reason: string; validFrom?: string; parentRecordId?: string }, decision: Paper): Promise<Obj> {
  let record = await masterRecord(ctx, entry.type, entry.key);
  if (record === undefined) {
    await ctx.command(MAKER, '/master-records', {
      namespace: 'TENANT',
      master_type: entry.type,
      business_key: entry.key,
      label: entry.label,
      ...(entry.parentRecordId === undefined ? {} : { parent_record_id: entry.parentRecordId }),
      attributes: entry.attributes ?? {},
      valid_from: entry.validFrom ?? '2026-01-01',
      reason: entry.reason,
    });
    record = await masterRecord(ctx, entry.type, entry.key);
  }
  if (record === undefined) throw new Error(`${entry.type}/${entry.key} cannot be found after it was proposed`);
  const changeId = asString(record.open_change_request_id);
  if (record.status === 'DRAFT') {
    const change = await ctx.get(MAKER, `/master-change-requests/${changeId}`);
    await ctx.command(MAKER, `/master-change-requests/${changeId}/submit`, {}, { version: asVersion(change.version) });
    record = await masterRecord(ctx, entry.type, entry.key);
  }
  if (record?.status === 'IN_REVIEW') {
    const change = await ctx.get(CHECKER, `/master-change-requests/${changeId}`);
    await ctx.command(CHECKER, `/master-change-requests/${changeId}/decision`, { decision: 'approve', reason: entry.reason }, { version: asVersion(change.version) });
    record = await masterRecord(ctx, entry.type, entry.key);
  }
  if (record?.status === 'APPROVED') {
    await ctx.command(CHECKER, `/master-records/${asString(record.id)}/publish`, { decision_document_id: decision.documentId }, { version: Number(record.version) });
    record = await masterRecord(ctx, entry.type, entry.key);
  }
  if (record === undefined || record.status !== 'EFFECTIVE') throw new Error(`${entry.type}/${entry.key} is ${asString(record?.status)} after the approval chain`);
  return record;
}

// ---- the working calendar ----------------------------------------------------------------------------------------------------------

/** The public holidays of a year the calendar of the tenant lists (the Tet days follow the lunar year of 2026; other years carry the fixed ones). */
function holidaysOf(year: number): Array<{ date: string; name: string; legal_basis_ref: string }> {
  const basis = tx('basis.011');
  const fixed = [
    { date: `${year}-01-01`, name: tx('name.012') },
    { date: `${year}-04-30`, name: tx('name.013') },
    { date: `${year}-05-01`, name: tx('name.014') },
    { date: `${year}-09-02`, name: tx('name.015') },
  ];
  const lunar =
    year === 2026
      ? [
          { date: '2026-02-16', name: tx('name.016') },
          { date: '2026-02-17', name: tx('name.016') },
          { date: '2026-02-18', name: tx('name.016') },
          { date: '2026-02-19', name: tx('name.016') },
          { date: '2026-02-20', name: tx('name.016') },
          { date: '2026-04-27', name: tx('name.017') },
        ]
      : [];
  return [...fixed, ...lunar].map((holiday) => ({ ...holiday, legal_basis_ref: basis })).filter((holiday) => new Date(`${holiday.date}T00:00:00Z`).getUTCDay() % 6 !== 0);
}

/**
 * The calendar WORKDAY_VN (Monday to Friday) for the year of today and the next, published: the SLAs of the issues are counted on it. `years` names other years (the schedule of a project workflow is laid
 * on the published calendars to its last day, which may be years ahead).
 */
export async function ensureWorkCalendar(ctx: SeedContext, years: readonly number[] = [ctx.year, ctx.year + 1]): Promise<void> {
  const versions = await ctx.list(MAKER, '/resources/work_calendar_version');
  for (const year of years) {
    const mine = versions.filter((row) => row.calendar_code === 'WORKDAY_VN' && Number(row.year) === year);
    if (mine.some((row) => ['Published', 'PUBLISHED'].includes(asString(row.status)))) continue;
    let draft = mine[0];
    if (draft === undefined) {
      const created = await ctx.command(MAKER, '/work-calendars', {
        calendar_code: 'WORKDAY_VN',
        year,
        working_days: [1, 2, 3, 4, 5],
        holidays: holidaysOf(year),
        compensated_workdays: [],
        legal_basis_ref: tx('basis.011'),
      });
      draft = { id: created.resource_id, version: created.resource_version };
    }
    const reason = { reason: tx('reason.018', year) };
    const options = { version: Number(draft.version) };
    const published = await ctx.attempt(MAKER, 'POST', `/work-calendars/${asString(draft.id)}/publish`, reason, options);
    if (!published.ok) ctx.expectOk(await ctx.call(OWNER, 'POST', `/work-calendars/${asString(draft.id)}/publish`, reason, options), `publish the calendar ${year}`);
  }
}

// ---- what earlier groups made ---------------------------------------------------------------------------------------------------

export interface ProjectRef {
  id: string;
  code: string;
  name: string;
}

/** The projects of the tenant (the three of clip 03 first, in the order of their codes in BASE), by code. */
export async function projects(ctx: SeedContext): Promise<Record<string, ProjectRef>> {
  const rows = await ctx.list(MAKER, '/resources/project');
  return Object.fromEntries(rows.map((row) => [asString(row.code), { id: asString(row.id), code: asString(row.code), name: asString(row.name ?? row.title ?? row.code) }]));
}

export async function projectOf(ctx: SeedContext, code: string): Promise<ProjectRef> {
  const found = (await projects(ctx))[code];
  if (found === undefined) throw new Error(`the project ${code} does not exist: the base group must run first`);
  return found;
}

/** The contracts of the tenant that are being performed, by project code (the delivery group made them). */
export async function activeContracts(ctx: SeedContext): Promise<Obj[]> {
  const rows = await ctx.list(MAKER, '/resources/contract');
  return rows.filter((row) => asString(row.status) === 'ACTIVE');
}

/** The members the issue module offers as workers of an issue. */
export const newOperation = (): string => randomUUID();

// ---- a step that may be refused by the rules -----------------------------------------------------------------------------------

/**
 * A step of the story that the rules of the product may refuse for a reason of the story (a state that does not allow it): the refusal is written down as
 * a warning and the story goes on; anything else (a server error, a failure that is not a refusal) is thrown as it is.
 */
export async function tolerate<T>(ctx: SeedContext, what: string, run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/HTTP 5\d\d/u.test(message)) throw error;
    ctx.warn(`${what}: ${message.slice(0, 400)}`);
    return undefined;
  }
}
