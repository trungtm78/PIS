import { canonicalJson, sha256Hex } from './canonical-json.ts';
import { hasControlChar, hasControlCharExceptWhitespace } from './control-chars.ts';
import { DomainError } from './errors.ts';
import { egpDayOf, egpHeaderOf, egpMoneyOf, normaliseTaxCode } from './egp.ts';
import { accept, planFileImport, reject, sourceRowsOfTable } from './file-import.ts';
import type { FileImportFormat, SourceRow } from './file-import.ts';
import { generateFeedRecords } from './finance-feed-generator.ts';
import type { FeedGeneratorParams } from './finance-feed-generator.ts';
import { readTabularFile } from './tabular-file.ts';
import type { AdapterStatus } from './connector.ts';
import { FEED_API_UNAVAILABLE_CODE, FEED_FUND_CODES, FEED_LAYOUT_VERSION, FEED_LAYOUT_VERSIONS, FEED_MAX_ROWS, FEED_MILESTONE_KINDS, FEED_POSITIONS, FEED_PROJECT_STATUSES, FEED_CONNECTOR_CODE, feedAcceptance, feedKindOf, feedRecordOf } from './finance-feed-model.ts';
import type { FeedAcceptance, FeedChannel, FeedKind, FeedRecord, FeedRecordByKind } from './finance-feed-model.ts';

/**
 * The feed of the Finance Department (So Tai chinh) into this system (lane FEED-1, `docs/finance-feed.md`), for the committee that steers public investment across the province.
 *
 * THIS MODULE IS PURE AND NEVER OPENS A CONNECTION. It imports no network module and calls no `fetch`. Three adapters sit behind one port (`FinanceFeedPort`):
 *   FILE        reads a file a person hands over (versioned layouts, working assumption, PENDING-EXTERNAL, dry run before apply);
 *   API_PUSH    the Finance application pushes with a machine account: a stub that refuses with `FEED_API_UNAVAILABLE` until the machine-account facility (INT-1) and the specification exist;
 *   GENERATOR   a deterministic producer of realistic records for a whole province; it feeds the same pipeline through the same validation, dry run and apply as a real file.
 * Every consumer reads `finance_feed_record` through the reader (`finance-feed-facts.ts`), never an adapter, so the real feed replaces the generator without touching a consumer. The channel a record came in by
 * is kept only as internal provenance (audit and replay).
 */



// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The layouts of the files (WORKING-ASSUMPTION-FIN-2026.1).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

type ColumnKind = 'code' | 'text' | 'day' | 'money' | 'year' | 'month' | 'enum' | 'taxCode';

interface ColumnSpec {
  name: string;
  kind: ColumnKind;
  required: boolean;
  max?: number;
  values?: readonly string[];
  fallback?: string;
}

interface Layout<K extends FeedKind> {
  kind: K;
  connectorCode: string;
  columns: readonly ColumnSpec[];
  keyOf(values: Readonly<Record<string, string>>): string;
  cross(values: Readonly<Record<string, string>>): { code: string; field: string } | undefined;
  build(values: Readonly<Record<string, string>>): FeedRecordByKind[K];
}

const col = (name: string, kind: ColumnKind, required: boolean, extra: Partial<ColumnSpec> = {}): ColumnSpec => ({ name, kind, required, ...extra });
const choice = (name: string, values: readonly string[], required: boolean, extra: Partial<ColumnSpec> = {}): ColumnSpec => col(name, 'enum', required, { values, ...extra });
const get = (values: Readonly<Record<string, string>>, name: string): string => values[name] ?? '';
const opt = (value: string | undefined): string | null => (value === undefined || value === '' ? null : value);
const num = (value: string | undefined): number | null => (value === undefined || value === '' ? null : Number(value));
const keyJoin = (values: Readonly<Record<string, string>>, names: readonly string[]): string => {
  const parts = names.map((name) => get(values, name.replace('?', '')).trim());
  return parts.some((part, index) => part === '' && !(names[index] ?? '').endsWith('?')) ? '' : parts.join('|');
};

const PROJECT: Layout<'PROJECT'> = {
  kind: 'PROJECT',
  connectorCode: FEED_POSITIONS.PROJECT,
  columns: [
    col('feed_project_code', 'code', true, { max: 50 }),
    col('as_of', 'day', true),
    col('project_name', 'text', true, { max: 500 }),
    col('sector_code', 'code', true, { max: 30 }),
    col('district_code', 'code', true, { max: 30 }),
    col('investor_code', 'code', true, { max: 30 }),
    col('investor_name', 'text', false, { max: 300 }),
    col('total_investment', 'money', false),
    col('start_year', 'year', false),
    col('end_year', 'year', false),
    choice('project_status', FEED_PROJECT_STATUSES, false, { fallback: 'ACTIVE' }),
    col('our_project_code', 'code', false, { max: 50 }),
  ],
  keyOf: (values) => keyJoin(values, ['feed_project_code', 'as_of']),
  cross: (v) => {
    const start = get(v, 'start_year');
    const end = get(v, 'end_year');
    if (start !== '' && end !== '' && Number(end) < Number(start)) return { code: 'YEARS_ORDER_INVALID', field: 'end_year' };
    return undefined;
  },
  build: (v) => ({
    feedProjectCode: get(v, 'feed_project_code'),
    asOf: get(v, 'as_of'),
    projectName: get(v, 'project_name'),
    sectorCode: get(v, 'sector_code'),
    districtCode: get(v, 'district_code'),
    investorCode: get(v, 'investor_code'),
    investorName: opt(v['investor_name']),
    totalInvestment: opt(v['total_investment']),
    startYear: num(v['start_year']),
    endYear: num(v['end_year']),
    projectStatus: get(v, 'project_status'),
    ourProjectCode: opt(v['our_project_code']),
  }),
};

const PLAN: Layout<'PLAN'> = {
  kind: 'PLAN',
  connectorCode: FEED_POSITIONS.PLAN,
  columns: [
    col('feed_project_code', 'code', true, { max: 50 }),
    col('fiscal_year', 'year', true),
    choice('fund_code', FEED_FUND_CODES, true),
    col('plan_amount', 'money', true),
    col('as_of', 'day', true),
    col('decision_no', 'text', false, { max: 100 }),
  ],
  keyOf: (values) => keyJoin(values, ['feed_project_code', 'fiscal_year', 'fund_code', 'as_of']),
  cross: () => undefined,
  build: (v) => ({
    feedProjectCode: get(v, 'feed_project_code'),
    fiscalYear: Number(get(v, 'fiscal_year')),
    fundCode: get(v, 'fund_code'),
    planAmount: get(v, 'plan_amount'),
    asOf: get(v, 'as_of'),
    decisionNo: opt(v['decision_no']),
  }),
};

const DISBURSEMENT: Layout<'DISBURSEMENT'> = {
  kind: 'DISBURSEMENT',
  connectorCode: FEED_POSITIONS.DISBURSEMENT,
  columns: [
    col('feed_project_code', 'code', true, { max: 50 }),
    col('fiscal_year', 'year', true),
    col('month', 'month', true),
    choice('fund_code', FEED_FUND_CODES, true),
    col('disbursed_month', 'money', true),
    col('disbursed_cumulative', 'money', true),
    col('reported_on', 'day', true),
    col('as_of', 'day', true),
  ],
  keyOf: (values) => keyJoin(values, ['feed_project_code', 'fiscal_year', 'month', 'fund_code', 'as_of']),
  cross: (v) => {
    if (BigInt(centsOf(get(v, 'disbursed_cumulative'))) < BigInt(centsOf(get(v, 'disbursed_month')))) return { code: 'CUMULATIVE_BELOW_MONTH', field: 'disbursed_cumulative' };
    if (get(v, 'reported_on') > get(v, 'as_of')) return { code: 'REPORTED_AFTER_AS_OF', field: 'reported_on' };
    return undefined;
  },
  build: (v) => ({
    feedProjectCode: get(v, 'feed_project_code'),
    fiscalYear: Number(get(v, 'fiscal_year')),
    month: Number(get(v, 'month')),
    fundCode: get(v, 'fund_code'),
    disbursedMonth: get(v, 'disbursed_month'),
    disbursedCumulative: get(v, 'disbursed_cumulative'),
    reportedOn: get(v, 'reported_on'),
    asOf: get(v, 'as_of'),
  }),
};

const MILESTONE: Layout<'MILESTONE'> = {
  kind: 'MILESTONE',
  connectorCode: FEED_POSITIONS.MILESTONE,
  columns: [
    col('feed_project_code', 'code', true, { max: 50 }),
    choice('milestone_kind', FEED_MILESTONE_KINDS, true),
    col('package_code', 'code', false, { max: 100 }),
    col('planned_on', 'day', false),
    col('actual_on', 'day', false),
    col('contract_value', 'money', false),
    col('as_of', 'day', true),
  ],
  keyOf: (values) => keyJoin(values, ['feed_project_code', 'milestone_kind', 'package_code?', 'as_of']),
  cross: (v) => {
    return get(v, 'planned_on') === '' && get(v, 'actual_on') === '' ? { code: 'MILESTONE_DATE_REQUIRED', field: 'planned_on' } : undefined;
  },
  build: (v) => ({
    feedProjectCode: get(v, 'feed_project_code'),
    milestoneKind: get(v, 'milestone_kind'),
    packageCode: opt(v['package_code']),
    plannedOn: opt(v['planned_on']),
    actualOn: opt(v['actual_on']),
    contractValue: opt(v['contract_value']),
    asOf: get(v, 'as_of'),
  }),
};

export const FEED_LAYOUTS: { readonly [K in FeedKind]: Layout<K> } = { PROJECT, PLAN, DISBURSEMENT, MILESTONE };

/** The columns of a layout as the screen and the documentation list them. */
export function feedLayoutColumns(kind: FeedKind): Array<{ name: string; kind: string; required: boolean; values?: readonly string[] }> {
  return FEED_LAYOUTS[kind].columns.map((column) => ({ name: column.name, kind: column.kind, required: column.required, ...(column.values === undefined ? {} : { values: column.values }) }));
}

/** An amount as hundredths of a dong, exactly (an amount carries at most two decimals). Input must be a plain amount text. */
export function centsOf(amount: string): string {
  const [integer = '0', fraction = ''] = amount.split('.');
  return `${integer}${fraction.padEnd(2, '0').slice(0, 2)}`;
}

type CellReading = { ok: true; value: string } | { ok: false; code: string };

function readCell(spec: ColumnSpec, raw: string): CellReading {
  const text = raw.trim();
  if (text === '') return spec.required ? { ok: false, code: 'FIELD_REQUIRED' } : { ok: true, value: spec.fallback ?? '' };
  if (spec.kind === 'text' ? hasControlCharExceptWhitespace(text) : hasControlChar(text)) return { ok: false, code: 'CHARACTER_INVALID' };
  switch (spec.kind) {
    case 'code':
    case 'text': {
      const max = spec.max ?? (spec.kind === 'code' ? 100 : 500);
      return text.length > max ? { ok: false, code: 'FIELD_TOO_LONG' } : { ok: true, value: text.replace(/\s+/g, ' ') };
    }
    case 'taxCode': {
      const tax = normaliseTaxCode(text);
      return tax === undefined ? { ok: false, code: 'TAX_CODE_INVALID' } : { ok: true, value: tax };
    }
    case 'day': {
      const day = egpDayOf(text);
      return day === undefined ? { ok: false, code: 'DAY_INVALID' } : { ok: true, value: day };
    }
    case 'money': {
      const money = egpMoneyOf(text);
      return money === undefined ? { ok: false, code: 'MONEY_INVALID' } : { ok: true, value: money };
    }
    case 'year': {
      if (!/^\d{4}$/.test(text) || Number(text) < 2000 || Number(text) > 2100) return { ok: false, code: 'YEAR_INVALID' };
      return { ok: true, value: text };
    }
    case 'month': {
      if (!/^\d{1,2}$/.test(text) || Number(text) < 1 || Number(text) > 12) return { ok: false, code: 'MONTH_INVALID' };
      return { ok: true, value: String(Number(text)) };
    }
    case 'enum': {
      const word = text.toUpperCase().replace(/[\s-]+/g, '_');
      return (spec.values ?? []).includes(word) ? { ok: true, value: word } : { ok: false, code: 'ENUM_INVALID' };
    }
  }
}

type RowReading = { ok: true; values: Record<string, string> } | { ok: false; code: string; field: string };

function readRow(layout: Layout<FeedKind>, cells: Readonly<Record<string, string>>): RowReading {
  const values: Record<string, string> = {};
  for (const spec of layout.columns) {
    const reading = readCell(spec, get(cells, spec.name));
    if (!reading.ok) return { ok: false, code: reading.code, field: spec.name };
    values[spec.name] = reading.value;
  }
  const crossed = layout.cross(values);
  return crossed === undefined ? { ok: true, values } : { ok: false, code: crossed.code, field: crossed.field };
}

const DUPLICATE_MARK = '__duplicate';
const CONFLICT_MARK = '__conflict';

function formatOf<K extends FeedKind>(layout: Layout<K>): FileImportFormat<FeedRecord<K>> {
  const keyField = layout.columns[0]?.name ?? 'file';
  const textual = new Set(layout.columns.filter((column) => column.kind === 'text').map((column) => column.name));
  return {
    connectorCode: layout.connectorCode,
    formatVersion: FEED_LAYOUT_VERSION,

    parse(bytes: Uint8Array): SourceRow[] {
      const table = readTabularFile(bytes);
      const headers = table.headers.map(egpHeaderOf);
      if (new Set(headers.filter((header) => header !== '')).size !== headers.filter((header) => header !== '').length) throw new DomainError('IMPORT_SCHEMA_INVALID', 422, 'file', { extensions: { duplicate_columns: true } });
      const missing = layout.columns.filter((column) => column.required && !headers.includes(column.name)).map((column) => column.name);
      if (missing.length > 0) throw new DomainError('IMPORT_SCHEMA_INVALID', 422, 'file', { extensions: { missing_columns: missing } });
      const first = new Map<string, { line: number; signature: string }>();
      return sourceRowsOfTable({ ...table, headers }).map((row) => {
        const reading = readRow(layout, row.values);
        const key = layout.keyOf(reading.ok ? reading.values : row.values);
        if (key === '') return row;
        const signature = reading.ok ? JSON.stringify(reading.values) : `?${layout.columns.map((column) => get(row.values, column.name).trim()).join('|')}`;
        const earlier = first.get(key);
        if (earlier === undefined) {
          first.set(key, { line: row.line, signature });
          return row;
        }
        return { line: row.line, values: { ...row.values, [earlier.signature === signature ? DUPLICATE_MARK : CONFLICT_MARK]: String(earlier.line) } };
      });
    },

    judge(row: SourceRow) {
      const reading = readRow(layout, row.values);
      if (!reading.ok) return reject<FeedRecord<K>>(reading.code, reading.field, layout.keyOf(row.values) === '' ? undefined : layout.keyOf(row.values));
      const key = layout.keyOf(reading.values);
      if (row.values[DUPLICATE_MARK] !== undefined) return reject<FeedRecord<K>>('ROW_DUPLICATE', keyField, key);
      if (row.values[CONFLICT_MARK] !== undefined) return reject<FeedRecord<K>>('ROW_CONFLICT', keyField, key);
      const record = feedRecordOf(layout.kind, layout.build(reading.values));
      return accept<FeedRecord<K>>({ businessKey: record.businessKey, fields: reading.values, record });
    },

    /** Codes, days, amounts and words may be shown beside an error; free text (names, decisions) is left out. */
    mask(values: Readonly<Record<string, string>>): Record<string, string> {
      const shown: Record<string, string> = {};
      for (const column of layout.columns) if (!textual.has(column.name)) shown[column.name] = get(values, column.name).trim();
      return shown;
    },
  };
}

/** The file formats as the file import framework takes them (`planFileImport`, `previewFileImport`): the same pure layouts the dry run reads. */
export const FEED_FORMATS: { readonly [K in FeedKind]: FileImportFormat<FeedRecord<K>> } = {
  PROJECT: formatOf(PROJECT),
  PLAN: formatOf(PLAN),
  DISBURSEMENT: formatOf(DISBURSEMENT),
  MILESTONE: formatOf(MILESTONE),
};

/** The layout version of a request must be one the module reads: another is refused before the file is opened and the answer names the versions that exist. */
export function assertFeedLayoutKnown(version: string | undefined): string {
  const asked = version ?? FEED_LAYOUT_VERSION;
  if (!FEED_LAYOUT_VERSIONS.includes(asked)) throw new DomainError('FEED_LAYOUT_VERSION_UNKNOWN', 422, 'mapping_version', { extensions: { layout_version: version ?? null, supported: [...FEED_LAYOUT_VERSIONS] } });
  return asked;
}

export type FeedRowStatus = 'VALID' | 'ERROR' | 'DUPLICATE' | 'CONFLICT';

export interface FeedDryRunRow {
  line: number;
  status: FeedRowStatus;
  businessKey: string | null;
  rowHash: string;
  code?: string;
  field?: string;
  record?: FeedRecord;
}

export interface FeedDryRun {
  kind: FeedKind;
  layoutVersion: string;
  fileSha256: string;
  rows: FeedDryRunRow[];
  counts: { total: number; valid: number; errors: number; duplicates: number; conflicts: number };
  acceptance: FeedAcceptance;
}

/** Reads a file as it would be applied and writes nothing: row by row VALID, ERROR (with a code and the field), DUPLICATE (ignored) or CONFLICT (refused, the first row stands). */
export function dryRunFeedFile(kind: FeedKind, bytes: Uint8Array, layoutVersion: string = FEED_LAYOUT_VERSION): FeedDryRun {
  assertFeedLayoutKnown(layoutVersion);
  const plan = planFileImport(FEED_FORMATS[kind] as FileImportFormat<FeedRecord>, bytes, FEED_MAX_ROWS);
  const rows = plan.rows.map((row): FeedDryRunRow => {
    if (row.accepted) return { line: row.line, status: 'VALID', businessKey: row.row.businessKey, rowHash: row.rowHash, record: row.row.record };
    const { code, field } = row.rejection;
    const status: FeedRowStatus = code === 'ROW_DUPLICATE' ? 'DUPLICATE' : code === 'ROW_CONFLICT' ? 'CONFLICT' : 'ERROR';
    return { line: row.line, status, businessKey: row.businessKey, rowHash: row.rowHash, code, field };
  });
  const count = (status: FeedRowStatus): number => rows.filter((row) => row.status === status).length;
  return {
    kind,
    layoutVersion,
    fileSha256: plan.fileSha256,
    rows,
    counts: { total: rows.length, valid: count('VALID'), errors: count('ERROR'), duplicates: count('DUPLICATE'), conflicts: count('CONFLICT') },
    acceptance: feedAcceptance(layoutVersion),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The port and its three adapters.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** What a read asks for. FILE needs `kind` and `file`; GENERATOR needs `generator`; API_PUSH will take `rows` (cells by column name, the same shape a file row has). */
export interface FeedReadRequest {
  kind?: FeedKind;
  file?: Uint8Array;
  layoutVersion?: string;
  generator?: FeedGeneratorParams;
  rows?: ReadonlyArray<Readonly<Record<string, string>>>;
}

export interface FeedRowRejection {
  line: number;
  code: string;
  field: string | null;
  businessKey: string | null;
}

/** What every adapter hands to the store: records already typed and keyed, whatever the way they came. */
export interface FeedBatch {
  channel: FeedChannel;
  adapterStatus: AdapterStatus;
  layoutVersion: string;
  acceptance: FeedAcceptance;
  kind: FeedKind | null;
  fileSha256: string | null;
  seed: number | null;
  records: FeedRecord[];
  rejected: FeedRowRejection[];
  counts: { total: number; valid: number; errors: number; duplicates: number; conflicts: number };
  /** SHA-256 of the canonical form of the records: the same input gives the same digest, so a run can be proved repeatable. */
  digest: string;
}

export const feedDigestOf = (records: readonly FeedRecord[]): string => sha256Hex(canonicalJson(records.map((record) => [record.kind, record.businessKey, record.record])));

export interface FinanceFeedPort {
  readonly code: string;
  readonly channel: FeedChannel;
  readonly adapterStatus: AdapterStatus;
  /** Whether the adapter ever opens a connection. None does. */
  readonly opensNetwork: boolean;
  read(request: FeedReadRequest): Promise<FeedBatch>;
}

function batchOfDryRun(run: FeedDryRun, channel: FeedChannel, adapterStatus: AdapterStatus): FeedBatch {
  const records = run.rows.filter((row): row is FeedDryRunRow & { record: FeedRecord } => row.status === 'VALID' && row.record !== undefined).map((row) => row.record);
  return {
    channel,
    adapterStatus,
    layoutVersion: run.layoutVersion,
    acceptance: run.acceptance,
    kind: run.kind,
    fileSha256: run.fileSha256,
    seed: null,
    records,
    rejected: run.rows.filter((row) => row.status !== 'VALID').map((row) => ({ line: row.line, code: row.code ?? 'ROW_INVALID', field: row.field ?? null, businessKey: row.businessKey })),
    counts: run.counts,
    digest: feedDigestOf(records),
  };
}

/** Reads the files a person hands over. It has no constructor argument and holds no client: it CANNOT open a connection. */
export class FeedFileAdapter implements FinanceFeedPort {
  readonly code = FEED_CONNECTOR_CODE;
  readonly channel: FeedChannel = 'FILE';
  readonly adapterStatus: AdapterStatus = 'PROPOSED';
  readonly opensNetwork = false;

  read(request: FeedReadRequest): Promise<FeedBatch> {
    try {
      if (request.file === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'file');
      const kind = feedKindOf(request.kind);
      return Promise.resolve(batchOfDryRun(dryRunFeedFile(kind, request.file, request.layoutVersion), 'FILE', this.adapterStatus));
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

/**
 * Judges rows given as cells by column name (what a push carries) with the very layouts the file uses, so the push and the file can never disagree about what a valid row is. The API adapter of the day the
 * machine account exists is this function behind an authenticated endpoint.
 */
export function feedBatchOfRows(kind: FeedKind, rows: ReadonlyArray<Readonly<Record<string, string>>>, channel: FeedChannel = 'API_PUSH', layoutVersion: string = FEED_LAYOUT_VERSION): FeedBatch {
  assertFeedLayoutKnown(layoutVersion);
  if (rows.length === 0) throw new DomainError('IMPORT_EMPTY', 422, 'rows');
  if (rows.length > FEED_MAX_ROWS) throw new DomainError('VALIDATION_FAILED', 422, 'rows');
  const format = FEED_FORMATS[kind] as FileImportFormat<FeedRecord>;
  const layout = FEED_LAYOUTS[kind] as Layout<FeedKind>;
  const first = new Map<string, string>();
  const records: FeedRecord[] = [];
  const rejected: FeedRowRejection[] = [];
  let duplicates = 0;
  let conflicts = 0;
  rows.forEach((cells, index) => {
    const line = index + 1;
    const reading = readRow(layout, cells);
    if (!reading.ok) {
      rejected.push({ line, code: reading.code, field: reading.field, businessKey: null });
      return;
    }
    const key = layout.keyOf(reading.values);
    const signature = JSON.stringify(reading.values);
    const earlier = first.get(key);
    if (earlier !== undefined) {
      if (earlier === signature) duplicates += 1;
      else conflicts += 1;
      rejected.push({ line, code: earlier === signature ? 'ROW_DUPLICATE' : 'ROW_CONFLICT', field: layout.columns[0]?.name ?? null, businessKey: key });
      return;
    }
    first.set(key, signature);
    const judged = format.judge({ line, values: cells });
    if (judged.accepted) records.push(judged.row.record);
  });
  const errors = rejected.length - duplicates - conflicts;
  return {
    channel,
    adapterStatus: 'MISSING',
    layoutVersion,
    acceptance: feedAcceptance(layoutVersion),
    kind,
    fileSha256: null,
    seed: null,
    records,
    rejected,
    counts: { total: rows.length, valid: records.length, errors, duplicates, conflicts },
    digest: feedDigestOf(records),
  };
}

const apiUnavailable = (): Promise<never> =>
  Promise.reject(new DomainError(FEED_API_UNAVAILABLE_CODE, 503, 'adapter', { extensions: { adapter_status: 'MISSING', reason: 'MACHINE_ACCOUNT_PENDING' } }));

/** The adapter for the push of the Finance application: a stub that refuses every call with 503 `FEED_API_UNAVAILABLE`. The day INT-1 gives the machine account this class is the only thing that changes. */
export class FeedApiPushAdapter implements FinanceFeedPort {
  readonly code = FEED_CONNECTOR_CODE;
  readonly channel: FeedChannel = 'API_PUSH';
  readonly adapterStatus: AdapterStatus = 'MISSING';
  readonly opensNetwork = false;

  read(): Promise<FeedBatch> {
    return apiUnavailable();
  }
}

/** The data generator: a deterministic producer of the records of a province from its parameters. It reads nothing, writes nothing and never calls out; its records go through the same pipeline as a file. */
export class FeedGeneratorAdapter implements FinanceFeedPort {
  readonly code = FEED_CONNECTOR_CODE;
  readonly channel: FeedChannel = 'GENERATOR';
  readonly adapterStatus: AdapterStatus = 'MOCK';
  readonly opensNetwork = false;

  read(request: FeedReadRequest): Promise<FeedBatch> {
    try {
      if (request.generator === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'generator');
      const records = generateFeedRecords(request.generator);
      return Promise.resolve({
        channel: 'GENERATOR',
        adapterStatus: this.adapterStatus,
        layoutVersion: FEED_LAYOUT_VERSION,
        acceptance: feedAcceptance(FEED_LAYOUT_VERSION),
        kind: null,
        fileSha256: null,
        seed: request.generator.seed,
        records,
        rejected: [],
        counts: { total: records.length, valid: records.length, errors: 0, duplicates: 0, conflicts: 0 },
        digest: feedDigestOf(records),
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

/** The adapter of a channel: the three of them behind the one port. */
export function financeFeedPortFor(channel: FeedChannel): FinanceFeedPort {
  switch (channel) {
    case 'FILE':
      return new FeedFileAdapter();
    case 'GENERATOR':
      return new FeedGeneratorAdapter();
    case 'API_PUSH':
      return new FeedApiPushAdapter();
  }
}

/**
 * Judges a batch of the generator through the very judgement of a file row: every record is rendered as cells and read back by the layout of its kind, so the generator can never produce what a file could not
 * carry. Returns the records that the layouts accept and the rejections (none is expected; a test pins that).
 */
export function validateFeedRecords(records: readonly FeedRecord[]): { accepted: FeedRecord[]; rejected: FeedRowRejection[] } {
  const accepted: FeedRecord[] = [];
  const rejected: FeedRowRejection[] = [];
  records.forEach((one, index) => {
    const layout = FEED_LAYOUTS[one.kind] as Layout<FeedKind>;
    const cells: Record<string, string> = {};
    const body = one.record as unknown as Record<string, unknown>;
    for (const column of layout.columns) {
      const camel = column.name.replace(/_([a-z])/g, (_all, letter: string) => letter.toUpperCase());
      const value = body[camel];
      cells[column.name] = value === null || value === undefined ? '' : String(value);
    }
    const reading = readRow(layout, cells);
    if (reading.ok) accepted.push(one);
    else rejected.push({ line: index + 1, code: reading.code, field: reading.field, businessKey: one.businessKey });
  });
  return { accepted, rejected };
}
