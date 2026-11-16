import { workflowCodeFrom } from './codes-model';

/**
 * "Áp cho" (R60): which projects take this procedure when they are registered. That is not a field of the template: it is the rule `PROJECT_WORKFLOW_ASSIGNMENT` (code `DEFAULT`), versioned and approved on its
 * own. The editor shows the lines of that rule that point at the template; adding or removing one never writes the rule in force: it makes a DRAFT of the rule that is submitted together with the template, and the
 * approver sees both.
 */

export const ASSIGNMENT_RULE_TYPE = 'PROJECT_WORKFLOW_ASSIGNMENT';
export const ASSIGNMENT_RULE_CODE = 'DEFAULT';
export const APPLY_FIELDS = ['project_type', 'project_group', 'funding_source'] as const;
export type ApplyField = (typeof APPLY_FIELDS)[number];
export const MAX_ASSIGNMENT_LINES = 60;

type Params = Record<string, unknown>;
const isRecord = (value: unknown): value is Params => typeof value === 'object' && value !== null && !Array.isArray(value);
const listOf = (value: unknown): Params[] => (Array.isArray(value) ? value.filter(isRecord) : []);

export interface ApplyCondition {
  field: ApplyField;
  in: string[];
}

export interface ApplyLine {
  code: string;
  priority: number;
  templateCode: string;
  when: ApplyCondition[];
}

const fieldOf = (value: unknown): ApplyField => APPLY_FIELDS.find((field) => field === value) ?? 'project_type';

export function readLines(params: unknown): ApplyLine[] {
  if (!isRecord(params)) return [];
  return listOf(params.lines)
    .map((line) => ({
      code: typeof line.code === 'string' ? line.code : '',
      priority: typeof line.priority === 'number' ? line.priority : 0,
      templateCode: typeof line.template_code === 'string' ? line.template_code : '',
      when: listOf(line.when).map((entry) => ({ field: fieldOf(entry.field), in: Array.isArray(entry.in) ? entry.in.filter((value): value is string => typeof value === 'string') : [] })),
    }))
    .sort((a, b) => a.priority - b.priority);
}

/** The lines that send a project to this template, in the order the rule reads them. */
export const linesFor = (params: unknown, templateCode: string): ApplyLine[] => readLines(params).filter((line) => line.templateCode === templateCode);

export interface ApplyAddition {
  field: ApplyField;
  value: string;
  /** Read before the lines of other procedures that take the same value (the person chose which procedure wins). */
  first: boolean;
}

export interface ApplyChange {
  added: ApplyAddition[];
  /** The codes of the lines taken off. */
  removed: string[];
}

export const NO_APPLY_CHANGE: ApplyChange = { added: [], removed: [] };
export const hasApplyChange = (change: ApplyChange): boolean => change.added.length > 0 || change.removed.length > 0;

/** The lines of OTHER procedures that already take a value: two procedures for one kind of project, of which only the one read first is ever suggested. */
export function overlapping(params: unknown, templateCode: string, field: ApplyField, value: string): ApplyLine[] {
  return readLines(params).filter((line) => line.templateCode !== templateCode && line.when.some((entry) => entry.field === field && entry.in.includes(value)));
}

/** Whether the template already takes the value (through a line of the rule or one waiting to be submitted). */
export function alreadyApplies(params: unknown, templateCode: string, change: ApplyChange, field: ApplyField, value: string): boolean {
  const kept = linesFor(params, templateCode).filter((line) => !change.removed.includes(line.code));
  return kept.some((line) => line.when.length === 1 && line.when[0]?.field === field && line.when[0].in.includes(value)) || change.added.some((one) => one.field === field && one.value === value);
}

const freePriority = (used: ReadonlySet<number>, from: number, step: 1 | -1): number | undefined => {
  for (let value = from; value >= 1 && value <= 9999; value += step) if (!used.has(value)) return value;
  return undefined;
};

/**
 * The params of the draft of the rule: the rule in force with the lines removed and the new lines added. Every line nobody touched is written exactly as it is stored. A new line gets a code made from the template
 * and the value, and a priority of its own: before the first line of another procedure that takes the same value when the person said this procedure wins, else after every line.
 */
export function applyChange(params: unknown, templateCode: string, change: ApplyChange): Params {
  const base: Params = isRecord(params) ? params : {};
  const lines = listOf(base.lines).filter((line) => !(line.template_code === templateCode && typeof line.code === 'string' && change.removed.includes(line.code)));
  const codes = lines.map((line) => String(line.code));
  const used = new Set(lines.map((line) => Number(line.priority)));
  const made: Params[] = [];
  for (const one of change.added) {
    const code = workflowCodeFrom(`${templateCode}_${one.value}`, codes);
    codes.push(code);
    const rivals = overlapping({ lines }, templateCode, one.field, one.value);
    const last = Math.max(0, ...used);
    const wanted = one.first && rivals.length > 0 ? freePriority(used, Math.min(...rivals.map((line) => line.priority)) - 1, -1) : undefined;
    const priority = wanted ?? freePriority(used, last + 10, 1) ?? freePriority(used, 1, 1) ?? last + 1;
    used.add(priority);
    made.push({ code, priority, template_code: templateCode, when: [{ field: one.field, in: [one.value] }] });
  }
  return { ...base, lines: [...lines, ...made] };
}

/** What a draft of the rule would change for this template against another version of the rule: the lines it adds and the lines it takes off (what the approver of the template is shown). */
export function applyDifference(before: unknown, after: unknown, templateCode: string): { added: ApplyLine[]; removed: ApplyLine[] } {
  const was = linesFor(before, templateCode);
  const now = linesFor(after, templateCode);
  const key = (line: ApplyLine): string => JSON.stringify([line.code, line.when]);
  return { added: now.filter((line) => !was.some((old) => key(old) === key(line))), removed: was.filter((line) => !now.some((next) => key(next) === key(line))) };
}
