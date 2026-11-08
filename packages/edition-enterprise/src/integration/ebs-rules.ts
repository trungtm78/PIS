import {
  DomainError,
  accept,
  addDecimal,
  compareDecimal,
  egpConnectorHealth,
  hasControlChar,
  hasControlCharExceptWhitespace,
  readTabularFile,
  reject,
  sha256Hex,
  sourceRowsOfTable,
  subtractDecimal,
} from '@machvon/kernel';
import type { EgpConnectorHealth, EgpFreshnessParams, FileImportFormat, SourceRow } from '@machvon/kernel';

/**
 * The file import and the reconciliation of Oracle EBS (ENT-2). Nobody has given the layout of the extract the customer can produce, so it is a working assumption (`WORKING-ASSUMPTION-2026.1`) and PENDING-EXTERNAL
 * (eng-review R18): it can run in UAT but cannot be accepted until an official sample file and the confirmation of the finance department exist. The platform never connects to EBS: a person hands over a file;
 * the dry run reads it as the apply will and writes nothing; the apply keeps what the file said (append-only), and the reconciliation compares it with our figures by project code, each difference an item with an owner who is
 * not one of its makers, settled by an explanation. This module is the pure part: the layout, the comparison, the life of an item.
 */

export const EBS_CONNECTOR_CODE = 'ebs.ledger';
/** The position of the file import framework (`integration_cursor`, `file_import.connector_code`). */
export const EBS_FILE_POSITION = 'EBS_LEDGER_FILE';
export const EBS_SOURCE_SYSTEM = 'ORACLE_EBS';
export const EBS_LAYOUT_VERSION = 'WORKING-ASSUMPTION-2026.1';
export const EBS_LAYOUT_VERSIONS: readonly string[] = [EBS_LAYOUT_VERSION];
export const EBS_ADAPTER_STATUS = 'PROPOSED' as const;
export const EBS_MAX_ROWS = 5000;
export const EBS_MIN_REASON = 10;
export const EBS_MAX_REASON = 2000;
export const EBS_MAX_REVIEW_DAYS = 365;

export type EbsAcceptance = 'PENDING_EXTERNAL' | 'ACCEPTABLE';

/** A layout that starts with WORKING-ASSUMPTION cannot be accepted (R18). */
export const ebsAcceptance = (layoutVersion: string): EbsAcceptance => (layoutVersion.startsWith('WORKING-ASSUMPTION') ? 'PENDING_EXTERNAL' : 'ACCEPTABLE');

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** The reason of a decision: ten characters at least, no control character other than whitespace, at most 2000. */
export function ebsReasonOf(value: unknown, field = 'reason', min: number = EBS_MIN_REASON): string {
  if (typeof value !== 'string') throw invalid(field);
  const text = value.trim();
  if (text.length < min || text.length > EBS_MAX_REASON || hasControlCharExceptWhitespace(text)) throw invalid(field);
  return text;
}

/** The layout a request names must be one the module reads; another one is refused before the file is opened and the answer names the versions that exist. */
export function assertEbsLayoutKnown(version: string | undefined): string {
  const asked = version ?? EBS_LAYOUT_VERSION;
  if (!EBS_LAYOUT_VERSIONS.includes(asked)) throw new DomainError('EBS_LAYOUT_VERSION_UNKNOWN', 422, 'mapping_version', { extensions: { layout_version: version ?? null, supported: [...EBS_LAYOUT_VERSIONS] } });
  return asked;
}

/** Switching the connection off or on: a reason both ways, and a move to the state it is already in is refused. */
export function ebsConnectionMove(current: { enabled: boolean }, target: { enabled: unknown; reason: unknown }): { enabled: boolean; reason: string } {
  if (typeof target.enabled !== 'boolean') throw invalid('enabled');
  if (target.enabled === current.enabled) throw invalid('enabled');
  return { enabled: target.enabled, reason: ebsReasonOf(target.reason) };
}

/** An apply of a file needs the connection on (409 `EBS_CONNECTION_DISABLED`); a dry run is allowed either way. */
export function assertEbsApplyAllowed(connection: { enabled: boolean }): void {
  if (!connection.enabled) throw new DomainError('EBS_CONNECTION_DISABLED', 409, 'connection');
}

// ---- the layout ---------------------------------------------------------------------------------------------------------------------------------

/** What one accepted row of the file says. An amount the file leaves empty is null: EBS says nothing about it, so nothing is compared. */
export interface EbsRecord {
  projectCode: string;
  /** The month the figures are to the end of, `YYYY-MM`. */
  period: string;
  /** The day the extract was taken in EBS: a restatement of the same period is another extract. */
  extractDate: string;
  disbursedVnd: string | null;
  committedVnd: string | null;
}

export const EBS_COLUMNS = ['project_code', 'period', 'extract_date', 'disbursed_vnd', 'committed_vnd'] as const;
const REQUIRED_HEADERS: readonly string[] = ['project_code', 'period', 'extract_date', 'disbursed_vnd', 'committed_vnd'];

const PROJECT_CODE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,59}$/;
const PERIOD_CELL = /^(\d{4})-(0[1-9]|1[0-2])$/;
const AMOUNT = /^-?\d{1,18}(\.\d{1,2})?$/;

const isRealDay = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

/** A header as it is compared: trimmed, lower case, spaces and hyphens as underscores. */
export const ebsHeaderOf = (header: string): string => header.trim().toLowerCase().replace(/[\s-]+/g, '_');

/** An amount as it is kept: no sign for zero, no trailing zero of the fraction (`12.50` stays, `12.00` is `12`). */
export function normalisedAmount(value: string): string {
  const negative = value.startsWith('-');
  const [integer = '0', fraction = ''] = value.replace('-', '').split('.');
  const trimmed = fraction.replace(/0+$/, '');
  const text = `${integer.replace(/^0+(?=\d)/, '')}${trimmed === '' ? '' : `.${trimmed}`}`;
  return text === '0' ? '0' : `${negative ? '-' : ''}${text}`;
}

const get = (values: Readonly<Record<string, string>>, name: string): string => (values[name] ?? '').trim();

type Reading = { ok: true; record: EbsRecord; fields: Record<string, string> } | { ok: false; code: string; field: string };

function readRow(values: Readonly<Record<string, string>>): Reading {
  const projectCode = get(values, 'project_code');
  if (projectCode === '') return { ok: false, code: 'REQUIRED', field: 'project_code' };
  if (!PROJECT_CODE.test(projectCode)) return { ok: false, code: 'CODE_INVALID', field: 'project_code' };
  const period = get(values, 'period');
  if (period === '') return { ok: false, code: 'REQUIRED', field: 'period' };
  if (!PERIOD_CELL.test(period)) return { ok: false, code: 'PERIOD_INVALID', field: 'period' };
  const extractDate = get(values, 'extract_date');
  if (extractDate === '') return { ok: false, code: 'REQUIRED', field: 'extract_date' };
  if (!isRealDay(extractDate)) return { ok: false, code: 'DATE_INVALID', field: 'extract_date' };
  const amounts: Record<'disbursed_vnd' | 'committed_vnd', string | null> = { disbursed_vnd: null, committed_vnd: null };
  for (const name of ['disbursed_vnd', 'committed_vnd'] as const) {
    const cell = get(values, name);
    if (cell === '') continue;
    if (!AMOUNT.test(cell)) return { ok: false, code: 'AMOUNT_INVALID', field: name };
    amounts[name] = normalisedAmount(cell);
  }
  if (amounts.disbursed_vnd === null && amounts.committed_vnd === null) return { ok: false, code: 'REQUIRED', field: 'disbursed_vnd' };
  const record: EbsRecord = { projectCode, period, extractDate, disbursedVnd: amounts.disbursed_vnd, committedVnd: amounts.committed_vnd };
  const fields: Record<string, string> = { project_code: projectCode, period, extract_date: extractDate };
  if (amounts.disbursed_vnd !== null) fields.disbursed_vnd = amounts.disbursed_vnd;
  if (amounts.committed_vnd !== null) fields.committed_vnd = amounts.committed_vnd;
  return { ok: true, record, fields };
}

export const ebsKeyOf = (record: Pick<EbsRecord, 'projectCode' | 'period' | 'extractDate'>): string => `${record.projectCode}|${record.period}|${record.extractDate}`;

const keyOfCells = (values: Readonly<Record<string, string>>): string => {
  const reading = readRow(values);
  return reading.ok ? ebsKeyOf(reading.record) : '';
};

const DUPLICATE_MARK = '__duplicate';
const CONFLICT_MARK = '__conflict';

/**
 * The file of EBS for the framework: a CSV or Excel table with the columns of `EBS_COLUMNS` (header names are compared without case, spaces or hyphens). One row is one project in one period as of one extract. A project
 * with another extract of the same period is a restatement: it is a new fact (the key carries the extract day), the reconciliation reads the newest. Inside one file the same key twice is a harmless duplicate when the content is
 * the same and a conflict (refused, the first stands) when it is not.
 */
export const EBS_FORMAT: FileImportFormat<EbsRecord> = {
  connectorCode: EBS_FILE_POSITION,
  formatVersion: EBS_LAYOUT_VERSION,

  parse(bytes: Uint8Array): SourceRow[] {
    const table = readTabularFile(bytes);
    const headers = table.headers.map(ebsHeaderOf);
    const named = headers.filter((header) => header !== '');
    if (new Set(named).size !== named.length) throw new DomainError('IMPORT_SCHEMA_INVALID', 422, 'file', { extensions: { duplicate_columns: true } });
    const missing = REQUIRED_HEADERS.filter((name) => !headers.includes(name));
    if (missing.length > 0) throw new DomainError('IMPORT_SCHEMA_INVALID', 422, 'file', { extensions: { missing_columns: missing } });
    const first = new Map<string, { line: number; signature: string }>();
    return sourceRowsOfTable({ ...table, headers }).map((row) => {
      const key = keyOfCells(row.values);
      if (key === '') return row;
      const reading = readRow(row.values);
      const signature = reading.ok ? JSON.stringify(reading.fields) : '';
      const earlier = first.get(key);
      if (earlier === undefined) {
        first.set(key, { line: row.line, signature });
        return row;
      }
      return { line: row.line, values: { ...row.values, [earlier.signature === signature ? DUPLICATE_MARK : CONFLICT_MARK]: String(earlier.line) } };
    });
  },

  judge(row: SourceRow) {
    const reading = readRow(row.values);
    const key = keyOfCells(row.values);
    if (!reading.ok) return reject<EbsRecord>(reading.code, reading.field, key === '' ? undefined : key);
    if (row.values[DUPLICATE_MARK] !== undefined) return reject<EbsRecord>('ROW_DUPLICATE', 'project_code', key);
    if (row.values[CONFLICT_MARK] !== undefined) return reject<EbsRecord>('ROW_CONFLICT', 'project_code', key);
    return accept<EbsRecord>({ businessKey: ebsKeyOf(reading.record), fields: reading.fields, record: reading.record, ...(reading.record.disbursedVnd === null ? {} : { measure: reading.record.disbursedVnd }) });
  },

  /** Codes, months, days and amounts may be shown beside an error: there is no free text in the file. */
  mask(values: Readonly<Record<string, string>>): Record<string, string> {
    const shown: Record<string, string> = {};
    for (const name of EBS_COLUMNS) shown[name] = get(values, name);
    return shown;
  },
};

/** The last day of a `YYYY-MM` period: the day our figures are read to. */
export function ebsPeriodEnd(period: string): string {
  const match = PERIOD_CELL.exec(period);
  if (match === null) throw invalid('period');
  const year = Number(match[1]);
  const month = Number(match[2]);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

export const isEbsPeriod = (value: unknown): value is string => typeof value === 'string' && PERIOD_CELL.test(value);

// ---- the connection and its health --------------------------------------------------------------------------------------------------------------

/** The health of the connection: the age of the last applied file against the rule `CONNECTOR_FRESHNESS`, code `EBS_FILE`; the same judgement as the other file connections, with this layout's acceptance word. */
export function ebsHealthOf(input: { lastImportAt: Date | null; now: Date; params: EgpFreshnessParams; layoutVersion?: string }): EgpConnectorHealth {
  return egpConnectorHealth({ lastImportAt: input.lastImportAt, now: input.now, params: input.params, adapterStatus: EBS_ADAPTER_STATUS, layoutVersion: input.layoutVersion ?? EBS_LAYOUT_VERSION });
}

// ---- the comparison -----------------------------------------------------------------------------------------------------------------------------

export const EBS_MEASURES = ['DISBURSED_VND', 'COMMITTED_VND'] as const;
export type EbsMeasure = (typeof EBS_MEASURES)[number];

export type EbsDifferenceKind = 'AMOUNT_MISMATCH' | 'MISSING_OURS';

/** What each side holds for one project and period: whole-dong decimals as text, or null for "nothing held" (never zero: no data is not zero). */
export type EbsFigures = Readonly<Record<EbsMeasure, string | null>>;

export interface EbsDifference {
  measure: EbsMeasure;
  kind: EbsDifferenceKind;
  ours: string | null;
  theirs: string;
  /** `theirs - ours` when both are held; null for MISSING_OURS. */
  delta: string | null;
}

/**
 * Compares our figures with the statement of EBS, measure by measure. Only a measure EBS states (the file cell is not empty) is compared; a measure we hold nothing for is MISSING_OURS (EBS has money we cannot see), and a
 * different amount is AMOUNT_MISMATCH with the signed difference. Equal amounts give nothing. Both sides are exact decimals: no rounding is applied before the comparison.
 */
export function diffEbs(ours: EbsFigures, theirs: EbsFigures): EbsDifference[] {
  const found: EbsDifference[] = [];
  for (const measure of EBS_MEASURES) {
    const stated = theirs[measure];
    if (stated === null) continue;
    const held = ours[measure];
    if (held === null) {
      found.push({ measure, kind: 'MISSING_OURS', ours: null, theirs: stated, delta: null });
      continue;
    }
    if (compareDecimal(held, stated) !== 0) found.push({ measure, kind: 'AMOUNT_MISMATCH', ours: held, theirs: stated, delta: subtractDecimal(stated, held) });
  }
  return found;
}

/** What the two sides said when the difference was found: a reading again of the same figures is the same difference, and a figure that moved is a new one. */
export const ebsFingerprint = (input: { projectCode: string; period: string; measure: EbsMeasure; ours: string | null; theirs: string | null }): string =>
  sha256Hex(JSON.stringify([input.projectCode, input.period, input.measure, input.ours, input.theirs]));

/** The sum of decimals, for the totals of a screen (exact). */
export const sumAmounts = (values: readonly string[]): string => values.reduce((total, value) => addDecimal(total, value), '0');

// ---- the item: owner, maker-checker, explanation ------------------------------------------------------------------------------------------------

export const EBS_RESOLUTION_KINDS = ['OURS_WRONG', 'EBS_WRONG', 'TIMING', 'WAIVED'] as const;
export type EbsResolutionKind = (typeof EBS_RESOLUTION_KINDS)[number];

/** What each way of explaining a difference needs besides the explanation itself: a reference to the correction or the ticket, or a day the difference is looked at again. */
export const EBS_RESOLUTION_RULES: Readonly<Record<EbsResolutionKind, { evidenceRequired: boolean; reviewRequired: boolean }>> = {
  OURS_WRONG: { evidenceRequired: true, reviewRequired: false },
  EBS_WRONG: { evidenceRequired: true, reviewRequired: false },
  TIMING: { evidenceRequired: false, reviewRequired: true },
  WAIVED: { evidenceRequired: false, reviewRequired: true },
};

export interface EbsResolution {
  kind: EbsResolutionKind;
  resolvedById: string;
  resolvedAt: string;
  reason: string;
  evidenceRef: string | null;
  reviewOn: string | null;
}

export interface EbsItem {
  projectCode: string;
  period: string;
  measure: EbsMeasure;
  kind: EbsDifferenceKind;
  ours: string | null;
  theirs: string | null;
  delta: string | null;
  state: 'OPEN' | 'RESOLVED';
  ownerId: string;
  /** The people who made the figures compared: whoever loaded the file and whoever ran the comparison. None of them settles the difference. */
  makerIds: readonly string[];
  openedAt: string;
  dueAt: string;
  resolution: EbsResolution | null;
}

/**
 * The owner of a new item: the person asked for if they are one of the candidates (active holders of the right to reconcile) and not a maker, else the first candidate who is not a maker;
 * undefined when nobody is left (a difference that nobody may answer for is not opened). A person who is not a candidate never becomes an owner, however they were named.
 */
export function pickEbsOwner(candidates: readonly string[], makerIds: readonly string[], preferred?: string): string | undefined {
  if (preferred !== undefined && candidates.includes(preferred) && !makerIds.includes(preferred)) return preferred;
  return candidates.find((candidate) => !makerIds.includes(candidate));
}

/** The items a set of differences opens: each with the owner, due time and makers of the run. */
export function openEbsItems(input: { projectCode: string; period: string; differences: readonly EbsDifference[]; ownerId: string; makerIds: readonly string[]; openedAt: Date; dueAt: Date }): EbsItem[] {
  if (input.makerIds.includes(input.ownerId)) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'owner');
  return input.differences.map((difference) => ({
    projectCode: input.projectCode,
    period: input.period,
    measure: difference.measure,
    kind: difference.kind,
    ours: difference.ours,
    theirs: difference.theirs,
    delta: difference.delta,
    state: 'OPEN',
    ownerId: input.ownerId,
    makerIds: [...input.makerIds],
    openedAt: input.openedAt.toISOString(),
    dueAt: input.dueAt.toISOString(),
    resolution: null,
  }));
}

/** Handing an item to someone else: the new owner is not one of its makers (403 `SELF_APPROVAL_DENIED`) and the item is open (409 `EBS_ITEM_STATE_INVALID`). */
export function assertEbsReassign(item: Pick<EbsItem, 'state' | 'makerIds'>, newOwnerId: string): void {
  if (item.state !== 'OPEN') throw new DomainError('EBS_ITEM_STATE_INVALID', 409, 'state');
  if (item.makerIds.includes(newOwnerId)) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'owner');
}

/**
 * Explains and closes an item. Only an open item (409 `EBS_ITEM_STATE_INVALID`); only its owner (403 `SCOPE_DENIED`), who is never a maker (403 `SELF_APPROVAL_DENIED`); the explanation is at least ten characters; a correction
 * (ours or EBS) names its evidence; a timing difference or a waiver names the day it is looked at again, from tomorrow to a year ahead. The order of the checks lets a stale screen see the conflict first.
 */
export function resolveEbsItem(item: EbsItem, step: { kind: unknown; actorId: string; at: Date; reason: unknown; evidenceRef?: unknown; reviewOn?: unknown }, today: string): EbsItem {
  if (item.state !== 'OPEN') throw new DomainError('EBS_ITEM_STATE_INVALID', 409, 'state');
  if (!(EBS_RESOLUTION_KINDS as readonly unknown[]).includes(step.kind)) throw invalid('kind');
  const kind = step.kind as EbsResolutionKind;
  if (item.ownerId !== step.actorId) throw new DomainError('SCOPE_DENIED', 403, 'owner');
  if (item.makerIds.includes(step.actorId)) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'actor');
  const reason = ebsReasonOf(step.reason);
  const rule = EBS_RESOLUTION_RULES[kind];
  let evidenceRef: string | null = null;
  if (step.evidenceRef !== undefined && step.evidenceRef !== null && step.evidenceRef !== '') {
    if (typeof step.evidenceRef !== 'string' || step.evidenceRef.trim() === '' || step.evidenceRef.length > 200 || hasControlChar(step.evidenceRef)) throw invalid('evidence_ref');
    evidenceRef = step.evidenceRef.trim();
  }
  if (rule.evidenceRequired && evidenceRef === null) throw invalid('evidence_ref');
  let reviewOn: string | null = null;
  if (step.reviewOn !== undefined && step.reviewOn !== null && step.reviewOn !== '') {
    if (typeof step.reviewOn !== 'string' || !isRealDay(step.reviewOn)) throw invalid('review_on');
    reviewOn = step.reviewOn;
  }
  if (rule.reviewRequired) {
    if (reviewOn === null) throw invalid('review_on');
    const days = (Date.parse(`${reviewOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000;
    if (days < 1 || days > EBS_MAX_REVIEW_DAYS) throw invalid('review_on');
  } else {
    reviewOn = null;
  }
  return { ...item, state: 'RESOLVED', resolution: { kind, resolvedById: step.actorId, resolvedAt: step.at.toISOString(), reason, evidenceRef, reviewOn } };
}

/** The numbers of `EBS_RECONCILE_POLICY`: the working days an item has to be settled. */
export interface EbsReconcileParams {
  due_in_working_days: number;
}

export function ebsReconcileParamsOf(params: Readonly<Record<string, unknown>>): EbsReconcileParams {
  const days = params.due_in_working_days;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 365) throw new Error('EBS_RECONCILE_POLICY: due_in_working_days must be an integer from 1 to 365');
  return { due_in_working_days: days };
}
