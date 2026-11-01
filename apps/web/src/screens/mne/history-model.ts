import { shown } from './report-model';
import { REPORT_STATUSES, toReport } from './types';
import type { ObligationView, ReportStatus, ReportView } from './types';

/**
 * MNE-10: the revisions of a report and what a correction changed (ST-MNE-010, MNE F8). A report that was issued does not change; a correction makes a new revision with its reason, and the revision it corrects is kept
 * (and stays downloadable) once the new one is issued. The history comes with the report the server reads; the difference between two revisions is the difference between their cells, never a figure worked out here.
 */

/** The states a report is in once it has been issued, or has gone back or been replaced: the ones that have, or may get, a correction. */
export const HISTORIC_STATUSES: readonly ReportStatus[] = ['ISSUED', 'EXPORTED', 'SUBMITTED_EXTERNAL', 'RETURNED', 'SUPERSEDED'];

/** The obligations of the calendar that were issued at least once, whatever came after. */
export const historicObligations = (items: readonly ObligationView[]): ObligationView[] => items.filter((item) => HISTORIC_STATUSES.includes(item.status));

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** One line of the history of a report. */
export interface HistoryEntry {
  id: string;
  revision: number;
  status: ReportStatus;
  correctionReason: string | null;
  supersedesId: string | null;
  issuedAt: string | null;
  createdAt: string | null;
  /** The revision the report that was read is. */
  current: boolean;
}

/** A revision as `getMneReport` answers it: the report, who approved it, why it was made and every revision of the report. */
export interface Revision {
  report: ReportView;
  approvedBy: string | null;
  correctionReason: string | null;
  supersedesId: string | null;
  history: HistoryEntry[];
}

function toEntry(raw: unknown): HistoryEntry | undefined {
  if (!isRecord(raw)) return undefined;
  const id = text(raw.id);
  const status = REPORT_STATUSES.find((candidate) => candidate === raw.status);
  if (id === null || status === undefined || typeof raw.revision !== 'number' || !Number.isInteger(raw.revision)) return undefined;
  return {
    id,
    revision: raw.revision,
    status,
    correctionReason: text(raw.correction_reason),
    supersedesId: text(raw.supersedes_id),
    issuedAt: text(raw.issued_at),
    createdAt: text(raw.created_at),
    current: raw.current === true,
  };
}

/** The revision a `getMneReport` answer describes, with the history oldest first; undefined when the answer is not a report. */
export function toRevision(raw: unknown): Revision | undefined {
  const report = toReport(raw);
  if (report === undefined || !isRecord(raw)) return undefined;
  return {
    report,
    approvedBy: text(raw.approved_by),
    correctionReason: text(raw.correction_reason),
    supersedesId: text(raw.supersedes_id),
    history: (Array.isArray(raw.history) ? raw.history : []).flatMap((entry) => toEntry(entry) ?? []).sort((a, b) => a.revision - b.revision),
  };
}

/** The revision the one that was opened corrects, which is what it is compared with unless the person chooses another. */
export const defaultAgainst = (revision: Pick<Revision, 'supersedesId'>): string | undefined => revision.supersedesId ?? undefined;

/** Whether the revision may be compared with another: the history holds one beside it. */
export const hasOthers = (history: readonly HistoryEntry[], id: string): boolean => history.some((entry) => entry.id !== id);

export type Change = 'same' | 'changed' | 'added' | 'removed';

/** One cell of the two revisions side by side, as each shows it (null where the cell is empty or is not in that revision). */
export interface DiffRow {
  key: string;
  label: string;
  before: string | null;
  after: string | null;
  change: Change;
}

/**
 * The cells of the two revisions side by side, in the order of the newer one and then the cells only the older one has. A cell is changed when what it shows differs, added when only the newer revision has it and removed
 * when only the older one has it.
 */
export function diffCells(before: Pick<ReportView, 'fields'>, after: Pick<ReportView, 'fields'>): DiffRow[] {
  const earlier = new Map(before.fields.map((field) => [field.key, field]));
  const later = new Map(after.fields.map((field) => [field.key, field]));
  const rows: DiffRow[] = after.fields.map((field) => {
    const old = earlier.get(field.key);
    const was = old === undefined ? null : shown(old);
    const now = shown(field);
    return { key: field.key, label: field.label, before: was, after: now, change: old === undefined ? 'added' : was === now ? 'same' : 'changed' };
  });
  for (const field of before.fields) if (!later.has(field.key)) rows.push({ key: field.key, label: field.label, before: shown(field), after: null, change: 'removed' });
  return rows;
}

/** How many cells differ between the two revisions. */
export const changedCount = (rows: readonly DiffRow[]): number => rows.filter((row) => row.change !== 'same').length;
