import type { HoldView, PolicyView, ReviewItemView } from '../../adm/retention/model';
import { BASELINE } from '../../llm/llm-model';
import type { Route } from '../../llm/llm-model';
import { maskPersonal } from '../../llm/trace/model';
import type { Merge, MergeStatus } from '../../mdm/merge/model';
import type { ChangeView } from '../../mdm/model';
import { CLASSIFICATION_LIST } from '../model';
import type { Classification, DatasetView } from '../model';

/**
 * DGV-10, DGV-11, DGV-12 and DGV-15: the governance workspace over data that other modules own (ST-DGV-010, DGV 3.1). Everything here is read: the duplicates and the merges are MDM's, the retention and the holds are ADM's and
 * DOC's, the changes of critical data are decided in MDM, and the catalogue is DGV's own. Nothing is written, so there is no second source of truth.
 */
export const MASTER_READ_PERMISSION = 'master.read';
export const RETENTION_READ_PERMISSION = 'adm.retention.read';
export const HOLD_READ_PERMISSION = 'legal_hold.read';
export const DOC_RULE_READ_PERMISSION = 'doc.retention.read';
export const CATALOG_READ_PERMISSION = 'data.catalog.read';

export const MERGE_HISTORY_PATH = '/mdm/mdm-35';
export const MASTER_APPROVAL_PATH = '/mdm/mdm-32';
export const RETENTION_POLICY_PATH = '/adm/adm-12';
export const DOC_RETENTION_PATH = '/doc/doc-18';

/** Whether the permission is held; a session that does not list its permissions leaves the decision to the server. */
export const holds = (permissions: readonly string[] | undefined, permission: string): boolean => permissions === undefined || permissions.includes(permission);

// ---- DGV-10: the duplicates that were settled ------------------------------------------------------------------------------------------------

export interface DuplicateFilter {
  status: '' | MergeStatus;
  masterType: string;
  words: string;
}

export const NO_DUPLICATE_FILTER: DuplicateFilter = { status: '', masterType: '', words: '' };

/** The merges that match the filter, the latest first. */
export function duplicateRows(merges: readonly Merge[], filter: DuplicateFilter): Merge[] {
  const needle = filter.words.trim().toLowerCase();
  return merges
    .filter(
      (merge) =>
        (filter.status === '' || merge.status === filter.status) &&
        (filter.masterType === '' || merge.masterType === filter.masterType) &&
        (needle === '' || `${merge.survivorKey} ${merge.mergedKey} ${merge.mergedLabel ?? ''}`.toLowerCase().includes(needle)),
    )
    .sort((left, right) => right.appliedAt.localeCompare(left.appliedAt) || left.id.localeCompare(right.id));
}

export const masterTypesOf = (merges: readonly Merge[]): string[] => [...new Set(merges.map((merge) => merge.masterType))].sort();

export interface DecisionCounts {
  rule: number;
  override: number;
  other: number;
}

/** How the values of the golden record were chosen: by the rule, overridden by a steward, or settled without either (one side had it, or both were equal). */
export function decisionCounts(merge: Pick<Merge, 'decisions'>): DecisionCounts {
  const counts: DecisionCounts = { rule: 0, override: 0, other: 0 };
  for (const decision of merge.decisions) {
    if (decision.by === 'RULE') counts.rule += 1;
    else if (decision.by === 'OVERRIDE') counts.override += 1;
    else counts.other += 1;
  }
  return counts;
}

// ---- DGV-11: retention and holds ---------------------------------------------------------------------------------------------------------------

/** The rule of each kind of record that is in force: the latest revision that was published. */
export function inForce(policies: readonly PolicyView[]): PolicyView[] {
  const latest = new Map<string, PolicyView>();
  for (const policy of policies) {
    if (policy.status !== 'Published') continue;
    const current = latest.get(policy.recordClass);
    if (current === undefined || policy.revision > current.revision) latest.set(policy.recordClass, policy);
  }
  return [...latest.values()].sort((left, right) => left.recordClass.localeCompare(right.recordClass));
}

export interface Waiting {
  count: number;
  earliestDue: string;
}

/** The records of each kind whose period ran out and that wait for a decision on what happens at the end: how many, and the first day that was due. */
export function waitingByClass(items: readonly ReviewItemView[]): Map<string, Waiting> {
  const waiting = new Map<string, Waiting>();
  for (const item of items) {
    const current = waiting.get(item.recordClass);
    waiting.set(item.recordClass, { count: (current?.count ?? 0) + 1, earliestDue: current === undefined || item.dueOn < current.earliestDue ? item.dueOn : current.earliestDue });
  }
  return waiting;
}

/** The holds that stop a deletion now. */
export const activeHolds = (holdings: readonly HoldView[]): HoldView[] => holdings.filter((hold) => hold.status === 'Active');

// ---- DGV-12: the changes of critical data -------------------------------------------------------------------------------------------------------

export const APPROVAL_STATUSES = ['IN_REVIEW', 'APPROVED', 'APPLIED', 'REJECTED'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export interface Difference {
  attribute: string;
  before: string;
  after: string;
}

/** A value of an attribute as text, with anything that looks like an identity or telephone number hidden; nothing at all is shown as a dash. */
export function valueText(value: unknown): string {
  if (value === undefined || value === null) return '—';
  return maskPersonal(typeof value === 'string' ? value : JSON.stringify(value));
}

/** What a change moves, attribute by attribute: the value before and the value proposed, only for the attributes that differ. */
export function differences(change: Pick<ChangeView, 'before' | 'proposed'>): Difference[] {
  const before = change.before ?? {};
  return [...new Set([...Object.keys(before), ...Object.keys(change.proposed)])]
    .sort()
    .filter((attribute) => JSON.stringify(before[attribute]) !== JSON.stringify(change.proposed[attribute]))
    .map((attribute) => ({ attribute: maskPersonal(attribute), before: valueText(before[attribute]), after: valueText(change.proposed[attribute]) }));
}

/** The changes of the master type chosen ('' is all), the latest effective day first. */
export const changesOf = (changes: readonly ChangeView[], masterType: string): ChangeView[] =>
  changes.filter((change) => masterType === '' || change.masterType === masterType).sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom) || left.id.localeCompare(right.id));

// ---- DGV-15: classification ------------------------------------------------------------------------------------------------------------------

/** How many datasets stand at each of the five levels of classification, from the rows the caller was given: a dataset the caller may not see is not in the rows and so is not counted. */
export function classificationCounts(datasets: readonly Pick<DatasetView, 'classification'>[]): Record<Classification, number> {
  const counts = Object.fromEntries(CLASSIFICATION_LIST.map((level) => [level, 0])) as Record<Classification, number>;
  for (const dataset of datasets) counts[dataset.classification] += 1;
  return counts;
}

/** Whether a dataset holds personal data: its classification says so. */
export const holdsPersonalData = (classification: Classification): boolean => classification === 'PERSONAL';

/** The routes of the AI gateway the data of a classification may ever take (the baseline no policy may widen). */
export const routesOf = (classification: Classification): readonly Route[] => BASELINE[classification];
