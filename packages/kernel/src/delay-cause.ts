/**
 * The catalogue of standard causes of delay (MD.02, CN.02 and the narrative forms of the enterprise edition, ENT-4e). It is not a new catalogue: it is the
 * MDM-17 catalogue `ISSUE_CATEGORY` of the tenant, whose entries carry two more attributes, `delay_cause` (the entry may be named as a cause of delay) and
 * `cause_group` (the family the cause is listed under). One list therefore serves the project issue form (the category of an issue is its cause) and the
 * narrative forms (a cause is cited by the key of its entry, never by a label), and an entry that issues use is retired only with a successor (MASTER_IN_USE).
 */
export const DELAY_CAUSE_GROUPS = ['SITE_CLEARANCE', 'CAPITAL', 'PROCEDURE', 'CONTRACTOR', 'DESIGN', 'WEATHER', 'SUPPLY', 'OTHER'] as const;
export type DelayCauseGroup = (typeof DELAY_CAUSE_GROUPS)[number];

/** An entry of ISSUE_CATEGORY as the web and the reports read it. */
export interface IssueCategoryEntry {
  key: string;
  label: string;
  versionId: string;
  recordId: string;
  parentRecordId: string | null;
  /** The attributes of the version in force. */
  attributes: Readonly<Record<string, unknown>>;
  retired?: boolean;
}

export interface DelayCauseOption {
  key: string;
  label: string;
  versionId: string;
  recordId: string;
  group: DelayCauseGroup;
}

export interface DelayCauseGroupList {
  group: DelayCauseGroup;
  causes: DelayCauseOption[];
}

const isGroup = (value: unknown): value is DelayCauseGroup => (DELAY_CAUSE_GROUPS as readonly unknown[]).includes(value);

/** Whether an entry is offered as a cause of delay: it says so, and it is in force. */
export function isDelayCause(entry: Pick<IssueCategoryEntry, 'attributes' | 'retired'>): boolean {
  return entry.attributes['delay_cause'] === true && entry.retired !== true;
}

/** The family of an entry; an entry that names none or an unknown one is listed under OTHER. */
export function causeGroupOf(entry: Pick<IssueCategoryEntry, 'attributes'>): DelayCauseGroup {
  const value = entry.attributes['cause_group'];
  return isGroup(value) ? value : 'OTHER';
}

/** The causes in force, in the order of the families and then by label (Vietnamese collation), each with the key a narrative cites. */
export function delayCauseOptions(entries: readonly IssueCategoryEntry[]): DelayCauseOption[] {
  return entries
    .filter(isDelayCause)
    .map((entry) => ({ key: entry.key, label: entry.label, versionId: entry.versionId, recordId: entry.recordId, group: causeGroupOf(entry) }))
    .sort((left, right) => DELAY_CAUSE_GROUPS.indexOf(left.group) - DELAY_CAUSE_GROUPS.indexOf(right.group) || left.label.localeCompare(right.label, 'vi') || (left.key < right.key ? -1 : 1));
}

/** The same causes grouped by family; a family with no cause is left out. */
export function delayCauseGroups(options: readonly DelayCauseOption[]): DelayCauseGroupList[] {
  return DELAY_CAUSE_GROUPS.flatMap((group) => {
    const causes = options.filter((option) => option.group === group);
    return causes.length === 0 ? [] : [{ group, causes }];
  });
}

/** Whether a key names a cause in force: a narrative form refuses a cause that is not in the list. */
export function isKnownDelayCause(entries: readonly IssueCategoryEntry[], key: string): boolean {
  return entries.some((entry) => entry.key === key && isDelayCause(entry));
}
