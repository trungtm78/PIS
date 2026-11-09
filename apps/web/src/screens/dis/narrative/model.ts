import { ApiError } from '@machvon/api-client';
import type { ReportDetail } from '../report/model';
import { keepBody } from '../report/step-model';
import type { ReportDraftBody } from '../report/model';

type Raw = Record<string, unknown>;

/** The eight fields of the structured narrative, in the order of the form (HSKT DL.01, CN.02). */
export const FIELDS = ['status', 'schedule', 'disbursement', 'causes', 'difficulties', 'solutions', 'next_plan', 'proposals'] as const;
export type Field = (typeof FIELDS)[number];
export const FIELD_MAX_CHARS = 4000;
export const THIS_PATH = '/dis/dis-34';

const record = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const texts = (value: unknown): string[] => (Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : []);
const list = (value: unknown): Raw[] => (Array.isArray(value) ? value.flatMap((one) => (record(one) === undefined ? [] : [record(one) as Raw])) : []);

export interface DirectiveRef {
  id: string;
  code: string;
  statusAtEnd: string;
}

export interface DirectiveItem extends DirectiveRef {
  line: string;
  rolledUp: boolean;
}

export interface Cause {
  code: string;
  label: string;
}

export interface Violation {
  ruleCode: string;
  fields: string[];
  message: string;
}

export interface NarrativeContext {
  causes: Cause[];
  directives: DirectiveItem[];
  directivesTruncated: boolean;
  previous: { reportId: string; periodCode: string; fields: string[] } | null;
  inheritance: { fromReportId: string; fields: string[] } | null;
  unchangedInherited: string[];
  blocking: Violation[];
  warnings: Violation[];
}

const violation = (row: Raw): Violation => ({ ruleCode: text(row.rule_code), fields: texts(row.fields), message: text(row.message) });

export function toContext(raw: unknown): NarrativeContext {
  const row = record(raw) ?? {};
  const directives = record(row.directives) ?? {};
  const previous = record(row.previous);
  const inheritance = record(row.inheritance);
  const verdict = record(row.verdict) ?? {};
  return {
    causes: list(row.causes).map((one) => ({ code: text(one.code), label: text(one.label) })),
    directives: list(directives.items).map((one) => ({ id: text(one.id), code: text(one.code), statusAtEnd: text(one.status_at_end), line: text(one.line), rolledUp: one.rolled_up === true })),
    directivesTruncated: directives.truncated === true,
    previous: previous === undefined ? null : { reportId: text(previous.report_id), periodCode: text(previous.period_code), fields: texts(previous.fields) },
    inheritance: inheritance === undefined ? null : { fromReportId: text(inheritance.from_report_id), fields: texts(inheritance.fields) },
    unchangedInherited: texts(row.unchanged_inherited),
    blocking: list(verdict.blocking).map(violation),
    warnings: list(verdict.warnings).map(violation),
  };
}

export interface NarrativeForm {
  fields: Record<Field, string>;
  causeCodes: string[];
  directives: DirectiveRef[];
}

/** The form from what the report holds: the words as written, the standard causes picked and the directives rolled up. */
export function formOf(detail: ReportDetail): NarrativeForm {
  const block = detail.narrative?.enterprise ?? undefined;
  const fields = Object.fromEntries(FIELDS.map((field) => [field, text(block?.[field])])) as Record<Field, string>;
  return {
    fields,
    causeCodes: texts(block?.cause_codes),
    directives: list(block?.directive_refs).map((one) => ({ id: text(one.id), code: text(one.code), statusAtEnd: text(one.status_at_end) })),
  };
}

export const tooLong = (form: NarrativeForm): Field[] => FIELDS.filter((field) => form.fields[field].trim().length > FIELD_MAX_CHARS);

/** The save of the structured narrative: the block is the whole of it, the public sections and the issues the narrative already had stay as they were. */
export function bodyOf(detail: ReportDetail, form: NarrativeForm): ReportDraftBody {
  const words = Object.fromEntries(FIELDS.flatMap((field) => (form.fields[field].trim() === '' ? [] : [[field, form.fields[field].trim()] as const])));
  const held = detail.narrative;
  const publicSections = Object.fromEntries(
    (['results', 'causes', 'solutions', 'proposals'] as const).flatMap((field) => (held?.[field] == null || held[field] === '' ? [] : [[field, held[field]] as const])),
  );
  const issues = held?.linkedIssueIds ?? [];
  const enterprise = {
    ...words,
    ...(form.causeCodes.length === 0 ? {} : { cause_codes: form.causeCodes }),
    ...(form.directives.length === 0 ? {} : { directive_refs: form.directives.map((one) => ({ id: one.id, code: one.code, status_at_end: one.statusAtEnd })) }),
  };
  return { ...keepBody(detail), narrative: { ...publicSections, ...(issues.length === 0 ? {} : { linked_issue_ids: issues }), ...(Object.keys(enterprise).length === 0 ? {} : { enterprise }) } };
}

/** The line of a directive as it is added to the words of a field: the text is only appended, never replaced. */
export const appendLine = (current: string, line: string): string => (current.includes(line) ? current : current.trim() === '' ? line : `${current.trim()}\n${line}`);

export type Problem = 'nothing' | 'locked' | 'conflict' | 'denied' | 'invalid' | 'general';

const BY_CODE: Readonly<Record<string, Problem>> = {
  NARRATIVE_NOTHING_TO_INHERIT: 'nothing',
  PERIOD_LOCKED: 'locked',
  REVISION_IMMUTABLE: 'locked',
  VERSION_CONFLICT: 'conflict',
  IND_ENTRY_RULE_VIOLATED: 'invalid',
  VALIDATION_FAILED: 'invalid',
  SCOPE_DENIED: 'denied',
};

export const problemOf = (error: unknown): Problem => (error instanceof ApiError ? (BY_CODE[error.code] ?? 'general') : 'general');
