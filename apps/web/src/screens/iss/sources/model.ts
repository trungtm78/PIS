import { ISSUE_READ_PERMISSION, ISSUE_SOURCES, toIssueLine } from '../issue-model';
import type { IssueSource, IssueStatus } from '../issue-model';
import type { Severity } from '../model';

/** The permission of ISS-11 (x-permission of `get_resources_issue`); the server judges each read again, with the scope of the unit, the project and the contract. */
export const READ_PERMISSION = ISSUE_READ_PERMISSION;

/** The modules whose events open an issue by themselves: the issue names the object it came from, a manual issue names none. */
export const AUTOMATIC_SOURCES = ISSUE_SOURCES.filter((source): source is Exclude<IssueSource, 'MANUAL'> => source !== 'MANUAL');
export type AutomaticSource = (typeof AUTOMATIC_SOURCES)[number];

/** Whether the permission is held, or not yet known: the screen asks for nothing it may not read. */
export const mayRead = (permissions: readonly string[] | undefined): boolean => permissions === undefined || permissions.includes(READ_PERMISSION);

/**
 * One issue as ISS-11 shows it. It carries the code, the source and the object the source names, the category, the severity, the deadline and the unit, and nothing a person wrote or a person's name: the
 * title, the description, the reporter and the assignee of the issue never reach this screen (the privacy rule of ISS-11).
 */
export interface SourceIssue {
  id: string;
  code: string;
  source: AutomaticSource;
  /** The id of the object in the owning module; the server sends none to a guest contractor. */
  sourceRefId: string | null;
  categoryLabel: string;
  severity: Severity;
  status: IssueStatus;
  projectCode: string;
  ownerUnitName: string;
  dueAt: string;
  overdueDays: number | null;
}

export function toSourceIssue(raw: unknown): SourceIssue | undefined {
  const line = toIssueLine(raw);
  if (line === undefined || line.sourceModule === 'MANUAL') return undefined;
  const ref = (raw as { source_ref_id?: unknown }).source_ref_id;
  return {
    id: line.id,
    code: line.code,
    source: line.sourceModule,
    sourceRefId: typeof ref === 'string' && ref !== '' ? ref : null,
    categoryLabel: line.categoryLabel,
    severity: line.severity,
    status: line.status,
    projectCode: line.projectCode,
    ownerUnitName: line.ownerUnitName,
    dueAt: line.dueAt,
    overdueDays: line.overdueDays,
  };
}

/**
 * The screen of the owning module that opens the object an issue came from, with the query parameter that screen reads it by. A link exists only where the reference the intake keeps (`source_ref_id`) is the very
 * object the parameter names: PMT-02 reads `permit` and the permit expiry event names the permit. The others are left out because their reference is another object than the one the screen takes: LND-08 takes a
 * `project` (the reference is a complaint, a deadline or a stage), QMS-07 a `contract` (the reference is a failed inspection item), PAY-12 only a `level` (the reference is an advance, an item or a settlement),
 * AST-05 an `obligation` (the reference is a claim) and CTR-05 a `contract` (the reference is a guarantee). Those show the module and the reference as text.
 */
const SOURCE_SCREEN: Readonly<Partial<Record<AutomaticSource, { path: string; param: string }>>> = {
  PMT: { path: '/pmt/pmt-02', param: 'permit' },
};

/** The address of the object in the screen of its module, or undefined when the reference cannot identify the object that screen opens, or the server did not say which object. */
export function sourceLink(issue: Pick<SourceIssue, 'source' | 'sourceRefId'>): string | undefined {
  const screen = SOURCE_SCREEN[issue.source];
  return screen === undefined || issue.sourceRefId === null ? undefined : `${screen.path}?${new URLSearchParams({ [screen.param]: issue.sourceRefId }).toString()}`;
}

export interface SourceFilter {
  source: AutomaticSource | '';
  category: string;
}
export const NO_FILTER: SourceFilter = { source: '', category: '' };

export function filterIssues(issues: readonly SourceIssue[], filter: SourceFilter): SourceIssue[] {
  return issues.filter((issue) => (filter.source === '' || issue.source === filter.source) && (filter.category === '' || issue.categoryLabel === filter.category));
}

/** The categories the issues are filed under, each once, in alphabetical order. */
export const categoriesOf = (issues: readonly SourceIssue[]): string[] => [...new Set(issues.map((issue) => issue.categoryLabel))].filter((label) => label !== '').sort((a, b) => a.localeCompare(b));

/** How many issues each source has opened, for the sources that have opened any. */
export function countBySource(issues: readonly SourceIssue[]): Array<{ source: AutomaticSource; count: number }> {
  return AUTOMATIC_SOURCES.map((source) => ({ source, count: issues.filter((issue) => issue.source === source).length })).filter((entry) => entry.count > 0);
}
