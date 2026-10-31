export const READ_PERMISSION = 'capital.ledger.read';

export const COLUMNS = ['appropriated', 'allocated', 'reserved', 'committed', 'disbursed'] as const;
export type Column = (typeof COLUMNS)[number];

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export interface EntryView {
  id: string;
  entryType: string;
  amountVnd: string;
  planYear: number;
  allocationLineId: string | null;
  project: { id: string; code: string; name: string } | null;
  sourceRefKind: string;
  reversalOfId: string | null;
  reason: string | null;
  postedAt: string;
  postedBy: string;
}

export interface LedgerPage {
  items: EntryView[];
  nextCursor: string | undefined;
  balance: Record<Column, string>;
  entryCount: number;
  asOf: string;
}

function toEntry(raw: unknown): EntryView | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const type = text(row?.entry_type);
  const amount = text(row?.amount_vnd);
  const postedAt = text(row?.posted_at);
  if (row === undefined || id === undefined || type === undefined || amount === undefined || postedAt === undefined) return undefined;
  const project = asRecord(row.project);
  const projectId = text(project?.id);
  const by = asRecord(row.posted_by);
  return {
    id,
    entryType: type,
    amountVnd: amount,
    planYear: typeof row.plan_year === 'number' ? row.plan_year : 0,
    allocationLineId: nullableText(row.allocation_line_id),
    project: projectId === undefined ? null : { id: projectId, code: text(project?.code) ?? '', name: text(project?.name) ?? '' },
    sourceRefKind: text(row.source_ref_kind) ?? '',
    reversalOfId: nullableText(row.reversal_of_id),
    reason: nullableText(row.reason),
    postedAt,
    postedBy: text(by?.display_name) ?? text(by?.membership_id) ?? '',
  };
}

export function toLedgerPage(raw: unknown): LedgerPage {
  const page = asRecord(raw);
  const balance = asRecord(page?.balance);
  const figure = (column: Column): string => text(balance?.[`${column}_vnd`]) ?? '0';
  return {
    items: (Array.isArray(page?.items) ? page.items : []).flatMap((item) => toEntry(item) ?? []),
    nextCursor: text(page?.next_cursor),
    balance: { appropriated: figure('appropriated'), allocated: figure('allocated'), reserved: figure('reserved'), committed: figure('committed'), disbursed: figure('disbursed') },
    entryCount: typeof page?.entry_count === 'number' ? page.entry_count : 0,
    asOf: text(page?.as_of) ?? '',
  };
}

/** Whole VND with the thousands separators of the language, exact for any size; anything that is not digits is shown as it came. */
export function formatVnd(amount: string, locale: string): string {
  return /^-?[0-9]{1,24}$/.test(amount) ? BigInt(amount).toLocaleString(locale) : amount;
}

export interface LedgerFilter {
  projectId: string;
  appropriationId: string;
  lineId: string;
  /** The day to look at, `YYYY-MM-DD`; empty means now. */
  day: string;
}

export const EMPTY_FILTER: LedgerFilter = { projectId: '', appropriationId: '', lineId: '', day: '' };
export type FilterField = 'appropriationId' | 'lineId' | 'day';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isDay(day: string): boolean {
  const parsed = new Date(`${day}T00:00:00Z`);
  return DATE.test(day) && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}

/** What the screen can tell before it asks: an identifier that is not one and a day that does not exist. */
export function validateFilter(filter: LedgerFilter): Partial<Record<FilterField, 'invalid'>> {
  const found: Partial<Record<FilterField, 'invalid'>> = {};
  if (filter.appropriationId.trim() !== '' && !UUID.test(filter.appropriationId.trim())) found.appropriationId = 'invalid';
  if (filter.lineId.trim() !== '' && !UUID.test(filter.lineId.trim())) found.lineId = 'invalid';
  if (filter.day !== '' && !isDay(filter.day)) found.day = 'invalid';
  return found;
}

/** The query of the read for a filter that passed `validateFilter`. */
export function ledgerQuery(filter: LedgerFilter): Record<string, string> {
  return {
    ...(filter.projectId === '' ? {} : { project_id: filter.projectId }),
    ...(filter.appropriationId.trim() === '' ? {} : { appropriation_id: filter.appropriationId.trim() }),
    ...(filter.lineId.trim() === '' ? {} : { allocation_line_id: filter.lineId.trim() }),
    ...(filter.day === '' ? {} : { at: filter.day }),
  };
}
