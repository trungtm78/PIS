import { DomainError } from './errors.ts';
import { accept, reject, sourceRowsOfTable } from './file-import.ts';
import type { FileImportFormat, SourceRow } from './file-import.ts';
import { readTabularFile } from './tabular-file.ts';

/**
 * The milestones of the choice of a contractor, in the order they happen (BID 3 F8, ST-BID-005). The invitation comes first and the contract last; the bid closes
 * before it opens, and the evaluation, the approval and the publication of the result follow.
 */
export const MILESTONE_KINDS = ['INVITATION_PUBLISHED', 'CLARIFICATION_DEADLINE', 'BID_CLOSING', 'BID_OPENING', 'EVALUATION_DONE', 'RESULT_APPROVED', 'RESULT_PUBLISHED', 'CONTRACT_SIGNED'] as const;
export type MilestoneKind = (typeof MILESTONE_KINDS)[number];

export const MILESTONE_SOURCES = ['MANUAL', 'IMPORT'] as const;
export type MilestoneSource = (typeof MILESTONE_SOURCES)[number];

export type MilestoneField = 'planned_at' | 'actual_at';

export interface MilestoneDates {
  plannedAt: string | null;
  actualAt: string | null;
}

export interface MilestoneOrderIssue {
  field: MilestoneField;
  earlier: MilestoneKind;
  later: MilestoneKind;
}

/**
 * Where the dates of the milestones of a package break the order (BR-BID, BID 3 F8: "mốc thực tế theo thứ tự mời, đóng, mở, đánh giá, phê duyệt"): the planned dates and the
 * actual dates are each read in the order of `MILESTONE_KINDS`, and a milestone may not come before an earlier one that has a date (the same moment is allowed: the bid closes
 * and opens at once). `held` is what the package holds and `change` the new dates of one kind; the first fault is returned, none when the order holds.
 */
export function milestoneOrderIssue(held: Readonly<Partial<Record<MilestoneKind, MilestoneDates>>>, change: { kind: MilestoneKind; plannedAt?: string | null | undefined; actualAt?: string | null | undefined }): MilestoneOrderIssue | undefined {
  const next: Partial<Record<MilestoneKind, MilestoneDates>> = { ...held };
  const current = held[change.kind] ?? { plannedAt: null, actualAt: null };
  next[change.kind] = {
    plannedAt: change.plannedAt === undefined ? current.plannedAt : change.plannedAt,
    actualAt: change.actualAt === undefined ? current.actualAt : change.actualAt,
  };
  for (const [field, pick] of [
    ['planned_at', (dates: MilestoneDates) => dates.plannedAt],
    ['actual_at', (dates: MilestoneDates) => dates.actualAt],
  ] as const) {
    let last: { kind: MilestoneKind; at: number } | undefined;
    for (const kind of MILESTONE_KINDS) {
      const dates = next[kind];
      const value = dates === undefined ? null : pick(dates);
      if (value === null) continue;
      const at = Date.parse(value);
      if (last !== undefined && at < last.at) return { field, earlier: last.kind, later: kind };
      last = { kind, at };
    }
  }
  return undefined;
}

/** The Vietnam calendar date of a moment (UTC+7, no daylight saving): the day a milestone is reconciled by. */
export function vietnamDayOf(moment: string): string {
  return new Date(Date.parse(moment) + 7 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * The file of the national bidding system (ST-BID-005, BID 3 F8): the export that a procurement planner downloads from the Hệ thống mạng đấu thầu quốc gia and reconciles with the
 * register. The platform calls no API of that system (adapter PROPOSED, D05): it reads the file the person hands over.
 *
 * THE LAYOUT IS A WORKING ASSUMPTION. No sample of the file and no specification of the system were available, so the layout below is the smallest one that names a package by
 * what the register holds and carries the milestone; `formatVersion` is kept with every import so that a change of layout is visible in the evidence.
 *
 *   - a CSV (UTF-8; comma, semicolon or tab) or the first sheet of an XLSX, with a header row;
 *   - `package_code`: the code of the package in the register; `project_code` (optional): the internal code of its project, to tell apart two packages with one code;
 *   - `external_code`: the code of the package on the national network;
 *   - `milestone_kind`: one of the eight kinds; `actual_at`: when it happened, as `YYYY-MM-DD` (the day in Vietnam), `DD/MM/YYYY` or an ISO date-time with its offset;
 *   - any other column is ignored. Header names are read without regard to case or surrounding space.
 */
export const PROCUREMENT_CONNECTOR = 'PROCUREMENT_FILE';
export const PROCUREMENT_FORMAT_VERSION = 'WORKING-ASSUMPTION-2026.1';
/** The adapter is a proposal until the owner of the system confirms the format; it is shown as such on BID-19. */
export const PROCUREMENT_ADAPTER_STATUS = 'PROPOSED';
export const PROCUREMENT_SOURCE_SYSTEM = 'MUASAMCONG';
export const PROCUREMENT_CODE_MAX_LENGTH = 50;
export const PROCUREMENT_EXTERNAL_CODE_MAX_LENGTH = 100;

const PACKAGE_COLUMN = 'package_code';
const PROJECT_COLUMN = 'project_code';
const EXTERNAL_COLUMN = 'external_code';
const KIND_COLUMN = 'milestone_kind';
const ACTUAL_COLUMN = 'actual_at';
/** Set on the rows that repeat an earlier row of the same file: the format judges one row at a time. */
const DUPLICATE_MARK = '__duplicate';
const CONFLICT_MARK = '__external_conflict';

export interface ProcurementRow {
  packageCode: string;
  projectCode: string | null;
  externalCode: string;
  milestoneKind: MilestoneKind;
  /** The moment, as an ISO date-time in UTC. */
  actualAt: string;
}

const hasControlCharacter = (text: string): boolean => Array.from(text).some((character) => (character.codePointAt(0) ?? 0) < 0x20 || character.codePointAt(0) === 0x7f);

const realDate = (year: number, month: number, day: number): boolean => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

/**
 * The moment of a cell: `YYYY-MM-DD` and `DD/MM/YYYY` are a day in Vietnam (its first instant), an ISO date-time must carry its offset (a time without one is not a moment).
 * Anything else, a day that does not exist or a year outside 2000 to 2100 is undefined.
 */
export function momentOf(cell: string): string | undefined {
  const text = cell.trim();
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text) ?? undefined;
  const vietnamese = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text) ?? undefined;
  const parts = day !== undefined ? [Number(day[1]), Number(day[2]), Number(day[3])] : vietnamese !== undefined ? [Number(vietnamese[3]), Number(vietnamese[2]), Number(vietnamese[1])] : undefined;
  if (parts !== undefined) {
    const [year, month, date] = parts as [number, number, number];
    if (year < 2000 || year > 2100 || !realDate(year, month, date)) return undefined;
    return new Date(Date.UTC(year, month - 1, date) - 7 * 3_600_000).toISOString();
  }
  const stamp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(text);
  if (stamp === null) return undefined;
  // The reader of dates rolls 30 February over to March and 24:00 to the next day; a moment that is written so does not exist.
  const [, y = '', mo = '', d = '', h = '', mi = '', sec = '0'] = stamp;
  if (!realDate(Number(y), Number(mo), Number(d)) || Number(h) > 23 || Number(mi) > 59 || Number(sec) > 59) return undefined;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return undefined;
  const iso = new Date(at).toISOString();
  const year = Number(iso.slice(0, 4));
  return year >= 2000 && year <= 2100 ? iso : undefined;
}

/**
 * The format of the file as a pure `FileImportFormat`. The business key of a row is the package with the milestone (`project|package|kind`): the same milestone of the same
 * package is one fact in whichever file it comes. A row that repeats the key of an earlier row of the same file is refused with ROW_DUPLICATE (the first row keeps it), and a
 * row that gives a code of the national network already given to another package earlier in the file is refused with EXTERNAL_CODE_CONFLICT.
 */
export const procurementFileFormat: FileImportFormat<ProcurementRow> = {
  connectorCode: PROCUREMENT_CONNECTOR,
  formatVersion: PROCUREMENT_FORMAT_VERSION,

  parse(bytes: Uint8Array): SourceRow[] {
    const table = readTabularFile(bytes);
    const headers = table.headers.map((header) => header.trim().toLowerCase());
    for (const required of [PACKAGE_COLUMN, EXTERNAL_COLUMN, KIND_COLUMN, ACTUAL_COLUMN]) {
      if (!headers.includes(required)) throw new DomainError('IMPORT_SCHEMA_INVALID', 422, 'file');
    }
    const rows = sourceRowsOfTable({ ...table, headers });
    const firstOfKey = new Map<string, number>();
    const packageOfExternal = new Map<string, string>();
    return rows.map((row) => {
      const packageKey = `${(row.values[PROJECT_COLUMN] ?? '').trim()}|${(row.values[PACKAGE_COLUMN] ?? '').trim()}`;
      const key = `${packageKey}|${(row.values[KIND_COLUMN] ?? '').trim().toUpperCase()}`;
      const external = (row.values[EXTERNAL_COLUMN] ?? '').trim();
      const marks: Record<string, string> = {};
      if (packageKey !== '|') {
        if (firstOfKey.has(key)) marks[DUPLICATE_MARK] = String(firstOfKey.get(key));
        else firstOfKey.set(key, row.line);
      }
      if (external !== '' && packageKey !== '|') {
        const owner = packageOfExternal.get(external);
        if (owner === undefined) packageOfExternal.set(external, packageKey);
        else if (owner !== packageKey) marks[CONFLICT_MARK] = owner;
      }
      return Object.keys(marks).length === 0 ? row : { line: row.line, values: { ...row.values, ...marks } };
    });
  },

  judge(row: SourceRow) {
    const packageCode = (row.values[PACKAGE_COLUMN] ?? '').trim();
    const projectCode = (row.values[PROJECT_COLUMN] ?? '').trim();
    const externalCode = (row.values[EXTERNAL_COLUMN] ?? '').trim();
    const kind = (row.values[KIND_COLUMN] ?? '').trim().toUpperCase();
    if (packageCode === '') return reject<ProcurementRow>('PACKAGE_CODE_EMPTY', PACKAGE_COLUMN);
    if (packageCode.length > PROCUREMENT_CODE_MAX_LENGTH || hasControlCharacter(packageCode)) return reject<ProcurementRow>('CODE_INVALID', PACKAGE_COLUMN, packageCode);
    if (projectCode.length > PROCUREMENT_CODE_MAX_LENGTH || hasControlCharacter(projectCode)) return reject<ProcurementRow>('CODE_INVALID', PROJECT_COLUMN, packageCode);
    if (externalCode === '') return reject<ProcurementRow>('EXTERNAL_CODE_EMPTY', EXTERNAL_COLUMN, packageCode);
    if (externalCode.length > PROCUREMENT_EXTERNAL_CODE_MAX_LENGTH || hasControlCharacter(externalCode)) return reject<ProcurementRow>('CODE_INVALID', EXTERNAL_COLUMN, packageCode);
    if (!(MILESTONE_KINDS as readonly string[]).includes(kind)) return reject<ProcurementRow>('MILESTONE_KIND_INVALID', KIND_COLUMN, packageCode);
    const actualAt = momentOf(row.values[ACTUAL_COLUMN] ?? '');
    if (actualAt === undefined) return reject<ProcurementRow>('ACTUAL_AT_INVALID', ACTUAL_COLUMN, packageCode);
    if (row.values[DUPLICATE_MARK] !== undefined) return reject<ProcurementRow>('ROW_DUPLICATE', KIND_COLUMN, packageCode);
    if (row.values[CONFLICT_MARK] !== undefined) return reject<ProcurementRow>('EXTERNAL_CODE_CONFLICT', EXTERNAL_COLUMN, packageCode);
    return accept<ProcurementRow>({
      businessKey: `${projectCode}|${packageCode}|${kind}`,
      fields: { [PROJECT_COLUMN]: projectCode, [PACKAGE_COLUMN]: packageCode, [EXTERNAL_COLUMN]: externalCode, [KIND_COLUMN]: kind, [ACTUAL_COLUMN]: actualAt },
      record: { packageCode, projectCode: projectCode === '' ? null : projectCode, externalCode, milestoneKind: kind as MilestoneKind, actualAt },
    });
  },

  /** Every cell is a code of the register or of the national network, a kind or a date: nothing personal, so they may be shown beside the error. */
  mask(values: Readonly<Record<string, string>>): Record<string, string> {
    const shown: Record<string, string> = {};
    for (const column of [PROJECT_COLUMN, PACKAGE_COLUMN, EXTERNAL_COLUMN, KIND_COLUMN, ACTUAL_COLUMN]) shown[column] = (values[column] ?? '').trim();
    return shown;
  },
};
