import { sha256Hex } from './canonical-json.ts';
import { DIRECTIVE_STATUSES } from './directive.ts';
import type { DirectiveStatus } from './directive.ts';
import { DomainError } from './errors.ts';
import { message } from './messages.ts';
import type { NarrativeBlock } from './report-layout.ts';
import type { TabularFile } from './tabular-file.ts';
import { asUuid } from './tenant-context.ts';

/**
 * The structured narrative of a period for the enterprise forms (ENT-3b; HSKT DL.01, CN.02, CN.03). It is not a second table: it is the block of the enterprise pack inside the narrative of a report
 * (`report_narrative`, one row per report revision, that is per project and period). The block holds the eight fields the customer asked for, the standard causes picked from the list (MDM-17), the
 * directives of the leadership meetings that were rolled up into the text, and, when the words began as a copy of the previous period, the trace of that copy.
 *
 * Everything here is pure: the store reads and writes, the controller judges access. The words people write are never produced by the platform; the platform only copies, rolls up and checks.
 */

export const NARRATIVE_PACK_ENTERPRISE = 'ENTERPRISE';
export const NARRATIVE_PACK_VERSION = 1;

/** The eight fields in the order of the form: execution, milestones, disbursement, causes, difficulties, solutions, plan of the next period, proposals. */
export const NARRATIVE_FIELDS = ['status', 'schedule', 'disbursement', 'causes', 'difficulties', 'solutions', 'next_plan', 'proposals'] as const;
export type NarrativeField = (typeof NARRATIVE_FIELDS)[number];
export const isNarrativeField = (value: unknown): value is NarrativeField => (NARRATIVE_FIELDS as readonly unknown[]).includes(value);

export const NARRATIVE_FIELD_MAX_CHARS = 4000;
export const NARRATIVE_MAX_CAUSE_CODES = 20;
export const NARRATIVE_MAX_DIRECTIVES = 50;
const CAUSE_CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** The name of a field in the facts of a `DATA_ENTRY_RULE` of the surface `PERIOD_NARRATIVE`. */
export const narrativeFactName = (field: NarrativeField): string => `NARRATIVE_${field.toUpperCase()}`;
/** The facts the pseudo field `MANDATORY_FIELDS` stands for on the narrative surface: where the plan stands, the milestones, the disbursement and the plan of the next period. */
export const NARRATIVE_MANDATORY_FACTS: readonly string[] = (['status', 'schedule', 'disbursement', 'next_plan'] as const).map(narrativeFactName);
/** The fact that carries the codes of the standard causes. */
export const NARRATIVE_CAUSE_CODES_FACT = 'NARRATIVE_CAUSE_CODES';

/** A directive that was rolled up: what the narrative says about it is a snapshot (its code and its state on the last day of the period). */
export interface DirectiveRef {
  id: string;
  code: string;
  statusAtEnd: DirectiveStatus;
}

/** Where the words of a draft began: a copy of the previous period, with the hash of each copied field, so a reader can tell the words that were kept from the ones that were rewritten. */
export interface NarrativeInheritance {
  fromReportId: string;
  fromPeriodId: string | null;
  at: string;
  by: string;
  /** The sha256 of each field as it was copied. */
  hashes: Readonly<Partial<Record<NarrativeField, string>>>;
}

export interface EnterpriseNarrative {
  packVersion: number;
  fields: Readonly<Record<NarrativeField, string | null>>;
  causeCodes: readonly string[];
  directiveRefs: readonly DirectiveRef[];
  /** Set by the store from the trace of the draft; never accepted from a request. */
  inheritance?: NarrativeInheritance | undefined;
}

export interface RawEnterpriseNarrative {
  status?: string | undefined;
  schedule?: string | undefined;
  disbursement?: string | undefined;
  causes?: string | undefined;
  difficulties?: string | undefined;
  solutions?: string | undefined;
  next_plan?: string | undefined;
  proposals?: string | undefined;
  cause_codes?: readonly string[] | undefined;
  directive_refs?: ReadonlyArray<{ id: string; code: string; status_at_end: string }> | undefined;
}

const textOf = (value: unknown, member: string): string | null => {
  if (value === undefined) return null;
  if (typeof value !== 'string') throw new DomainError('VALIDATION_FAILED', 422, `narrative.enterprise.${member}`);
  const words = value.normalize('NFC').trim();
  if (words.length > NARRATIVE_FIELD_MAX_CHARS) throw new DomainError('VALIDATION_FAILED', 422, `narrative.enterprise.${member}`);
  return words === '' ? null : words;
};

/** The sha256 of the words of a field (what the trace of an inheritance keeps). */
export const fieldHash = (text: string): string => sha256Hex(text.normalize('NFC').trim());

/**
 * The enterprise block of a request. Each field is trimmed, normalised and at most 4000 characters (an empty one counts as left out). The cause codes are shaped like codes, each once, at most 20 (whether
 * they are in use in the list is the store's to say); the directives are valid ids with a known state, each once, at most 50. A block with no word, no cause and no directive is the same as none (null).
 */
export function enterpriseNarrativeOf(raw: RawEnterpriseNarrative | undefined): EnterpriseNarrative | null {
  if (raw === undefined) return null;
  const fields = {} as Record<NarrativeField, string | null>;
  for (const field of NARRATIVE_FIELDS) fields[field] = textOf(raw[field], field);
  const given = raw.cause_codes ?? [];
  if (!Array.isArray(given) || given.length > NARRATIVE_MAX_CAUSE_CODES) throw new DomainError('VALIDATION_FAILED', 422, 'narrative.enterprise.cause_codes');
  const causeCodes: string[] = [];
  given.forEach((code, index) => {
    if (typeof code !== 'string' || !CAUSE_CODE.test(code) || causeCodes.includes(code)) throw new DomainError('VALIDATION_FAILED', 422, `narrative.enterprise.cause_codes[${index}]`);
    causeCodes.push(code);
  });
  const refsGiven = raw.directive_refs ?? [];
  if (!Array.isArray(refsGiven) || refsGiven.length > NARRATIVE_MAX_DIRECTIVES) throw new DomainError('VALIDATION_FAILED', 422, 'narrative.enterprise.directive_refs');
  const directiveRefs: DirectiveRef[] = [];
  refsGiven.forEach((ref, index) => {
    const at = `narrative.enterprise.directive_refs[${index}]`;
    const id = typeof ref?.id === 'string' ? asUuid(ref.id) : undefined;
    const status = (DIRECTIVE_STATUSES as readonly string[]).find((one) => one === ref?.status_at_end) as DirectiveStatus | undefined;
    if (id === undefined || directiveRefs.some((one) => one.id === id)) throw new DomainError('VALIDATION_FAILED', 422, `${at}.id`);
    if (typeof ref.code !== 'string' || ref.code === '' || ref.code.length > 64) throw new DomainError('VALIDATION_FAILED', 422, `${at}.code`);
    if (status === undefined) throw new DomainError('VALIDATION_FAILED', 422, `${at}.status_at_end`);
    directiveRefs.push({ id, code: ref.code, statusAtEnd: status });
  });
  const block: EnterpriseNarrative = { packVersion: NARRATIVE_PACK_VERSION, fields, causeCodes, directiveRefs };
  return isEmptyBlock(block) ? null : block;
}

/** Whether a block has nothing in it: no word, no cause, no directive. */
export const isEmptyBlock = (block: EnterpriseNarrative): boolean => NARRATIVE_FIELDS.every((field) => block.fields[field] === null) && block.causeCodes.length === 0 && block.directiveRefs.length === 0;

/** The fields with words. */
export const filledFields = (block: EnterpriseNarrative): NarrativeField[] => NARRATIVE_FIELDS.filter((field) => block.fields[field] !== null);

// ---- the rules at entry (IND-1, surface PERIOD_NARRATIVE) --------------------------------------------------------------------------------------------------

/** The facts of a narrative for the `DATA_ENTRY_RULE` rules: the words of each field (blank when not given) and the codes of the causes, joined. */
export function narrativeEntryValues(block: EnterpriseNarrative | null): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of NARRATIVE_FIELDS) values[narrativeFactName(field)] = block?.fields[field] ?? '';
  values[NARRATIVE_CAUSE_CODES_FACT] = (block?.causeCodes ?? []).join(',');
  return values;
}

// ---- inheritance ---------------------------------------------------------------------------------------------------------------------------------------------

export interface InheritedDraft {
  block: EnterpriseNarrative;
  /** The fields that were copied (the ones of the previous period that had words and are empty in the draft). */
  copied: NarrativeField[];
}

/**
 * Copies the words of the previous period into the draft: only the fields the draft has left empty are filled (what a person already wrote is never overwritten, and the cause codes follow the same rule),
 * and the directives of the previous period are NOT carried (they belong to that period). Returns the new block and the fields copied; nothing copied means nothing to do (the caller says so).
 */
export function inheritNarrative(previous: EnterpriseNarrative, current: EnterpriseNarrative | null): InheritedDraft {
  const fields = {} as Record<NarrativeField, string | null>;
  const copied: NarrativeField[] = [];
  for (const field of NARRATIVE_FIELDS) {
    const own = current?.fields[field] ?? null;
    if (own !== null) {
      fields[field] = own;
    } else if (previous.fields[field] !== null) {
      fields[field] = previous.fields[field];
      copied.push(field);
    } else {
      fields[field] = null;
    }
  }
  const ownCauses = current?.causeCodes ?? [];
  const causeCodes = ownCauses.length > 0 ? [...ownCauses] : [...previous.causeCodes];
  if (ownCauses.length === 0 && previous.causeCodes.length > 0) copied.push('causes');
  return { block: { packVersion: NARRATIVE_PACK_VERSION, fields, causeCodes: [...new Set(causeCodes)], directiveRefs: [...(current?.directiveRefs ?? [])] }, copied: [...new Set(copied)] };
}

/** The trace of a copy: the hash of each field as it was copied. */
export function inheritanceHashes(block: EnterpriseNarrative, copied: readonly NarrativeField[]): Partial<Record<NarrativeField, string>> {
  const hashes: Partial<Record<NarrativeField, string>> = {};
  for (const field of copied) {
    const text = block.fields[field];
    if (text !== null) hashes[field] = fieldHash(text);
  }
  return hashes;
}

/** The fields that still carry the words of the previous period unchanged (the hash of the text equals the hash that was kept when it was copied). */
export function unchangedInherited(block: EnterpriseNarrative, trace: NarrativeInheritance | undefined): NarrativeField[] {
  if (trace === undefined) return [];
  return NARRATIVE_FIELDS.filter((field) => {
    const kept = trace.hashes[field];
    const text = block.fields[field];
    return kept !== undefined && text !== null && fieldHash(text) === kept;
  });
}

// ---- the directives of the leadership meetings (DIR-05, CN.03) ---------------------------------------------------------------------------------------------

/** What the roll-up reads of a directive of the period (a part of the report view of the DIR module). */
export interface DirectiveForNarrative {
  id: string;
  code: string;
  meetingDate: string;
  text: string;
  assigneeUnitName: string;
  dueOnAtEnd: string;
  statusAtEnd: DirectiveStatus;
  lastNote: string | null;
}

/** One line per directive, in the order given: what was asked, who is to do it, when, the state on the last day of the period and the latest result noted. Vietnamese text lives in the messages. */
export function directiveLine(item: DirectiveForNarrative): string {
  const head = message('ent.narrative.directive_line', {
    code: item.code,
    meetingDate: item.meetingDate,
    text: item.text.trim(),
    unit: item.assigneeUnitName,
    dueOn: item.dueOnAtEnd,
    status: message(`ent.narrative.directive_status.${item.statusAtEnd}`),
  });
  return item.lastNote === null || item.lastNote.trim() === '' ? head : `${head} ${message('ent.narrative.directive_result', { note: item.lastNote.trim() })}`;
}

export const directiveRefOf = (item: DirectiveForNarrative): DirectiveRef => ({ id: item.id, code: item.code, statusAtEnd: item.statusAtEnd });

// ---- the import from Excel (CN.02 entry from the template) --------------------------------------------------------------------------------------------

export const NARRATIVE_IMPORT_MAPPING = 'ENT-NARRATIVE-1';
const PROJECT_COLUMN = 'project_code';
const CAUSE_CODES_COLUMN = 'cause_codes';
/** The columns of the template in order; the first is the key and the others are optional. */
export const NARRATIVE_IMPORT_COLUMNS: readonly string[] = [PROJECT_COLUMN, ...NARRATIVE_FIELDS, CAUSE_CODES_COLUMN];

export const NARRATIVE_IMPORT_FAULTS = {
  projectRequired: 'PROJECT_CODE_REQUIRED',
  projectDuplicate: 'PROJECT_DUPLICATE_IN_FILE',
  fieldTooLong: 'FIELD_TOO_LONG',
  causeCodeInvalid: 'CAUSE_CODE_INVALID',
  rowEmpty: 'ROW_EMPTY',
  projectNotFound: 'PROJECT_NOT_FOUND',
  reportDraftMissing: 'REPORT_DRAFT_MISSING',
  causeCodeUnknown: 'CAUSE_CODE_UNKNOWN',
  periodLocked: 'PERIOD_LOCKED',
} as const;

export interface NarrativeImportRow {
  line: number;
  projectCode: string;
  block: EnterpriseNarrative;
}

export interface NarrativeRowFault {
  line: number;
  projectCode: string | null;
  field: string;
  code: string;
}

export interface ParsedNarrativeImport {
  totalRows: number;
  rows: NarrativeImportRow[];
  faults: NarrativeRowFault[];
}

/**
 * Reads the template as the mapping says and judges every row on its own: one project once, each field at most 4000 characters, the cause codes shaped like codes (separated by a semicolon, a comma or a
 * line break), the row not empty. 422 `IMPORT_SCHEMA_INVALID` when the column of the project is missing; columns that are not in the template are ignored. Whether the project exists, has a draft for the
 * period and the codes are in use is for the store.
 */
export function parseNarrativeImport(table: TabularFile): ParsedNarrativeImport {
  const names = table.headers.map((header) => header.trim().toLowerCase());
  if (!names.includes(PROJECT_COLUMN)) throw new DomainError('IMPORT_SCHEMA_INVALID', 422, 'file', { extensions: { missing_columns: [PROJECT_COLUMN] } });
  const at = (cells: readonly string[], column: string): string | undefined => {
    const index = names.indexOf(column);
    const value = index < 0 ? undefined : cells[index]?.trim();
    return value === undefined || value === '' ? undefined : value;
  };
  const occurrences = new Map<string, number>();
  for (const cells of table.rows) {
    const code = at(cells, PROJECT_COLUMN);
    if (code !== undefined) occurrences.set(code, (occurrences.get(code) ?? 0) + 1);
  }
  const rows: NarrativeImportRow[] = [];
  const faults: NarrativeRowFault[] = [];
  table.rows.forEach((cells, index) => {
    const line = table.lines[index] ?? index + 2;
    const projectCode = at(cells, PROJECT_COLUMN);
    const found: NarrativeRowFault[] = [];
    const fault = (field: string, code: string): void => void found.push({ line, projectCode: projectCode ?? null, field, code });
    if (projectCode === undefined) fault(PROJECT_COLUMN, NARRATIVE_IMPORT_FAULTS.projectRequired);
    else if ((occurrences.get(projectCode) ?? 0) > 1) fault(PROJECT_COLUMN, NARRATIVE_IMPORT_FAULTS.projectDuplicate);
    const raw: RawEnterpriseNarrative = {};
    for (const field of NARRATIVE_FIELDS) {
      const value = at(cells, field);
      if (value === undefined) continue;
      if (value.normalize('NFC').length > NARRATIVE_FIELD_MAX_CHARS) fault(field, NARRATIVE_IMPORT_FAULTS.fieldTooLong);
      else raw[field] = value;
    }
    const codesText = at(cells, CAUSE_CODES_COLUMN);
    if (codesText !== undefined) {
      const codes = codesText.split(/[;,\r\n]+/).map((code) => code.trim()).filter((code) => code !== '');
      if (codes.length > NARRATIVE_MAX_CAUSE_CODES || codes.some((code, position) => !CAUSE_CODE.test(code) || codes.indexOf(code) !== position)) fault(CAUSE_CODES_COLUMN, NARRATIVE_IMPORT_FAULTS.causeCodeInvalid);
      else raw.cause_codes = codes;
    }
    let block: EnterpriseNarrative | null = null;
    if (found.length === 0) {
      block = enterpriseNarrativeOf(raw);
      if (block === null) fault('row', NARRATIVE_IMPORT_FAULTS.rowEmpty);
    }
    if (found.length > 0 || projectCode === undefined || block === null) faults.push(...found);
    else rows.push({ line, projectCode, block });
  });
  return { totalRows: table.rows.length, rows, faults };
}

// ---- the Word document (CN.02: the narrative of the form) -------------------------------------------------------------------------------------------------

/** What the Word document needs of one project's narrative: the words as written, the labels of the standard causes and the lines of the directives. */
export interface ProjectNarrativeText {
  projectCode: string;
  projectName: string;
  fields: Readonly<Partial<Record<NarrativeField, string | null>>>;
  /** The names of the standard causes picked from the list. */
  causeLabels: readonly string[];
  /** The lines of the directives that were rolled up (see `directiveLine`). */
  directiveLines: readonly string[];
}

/** The token of the skeleton of a form that stands for the narratives of all the projects of the period. */
export const NARRATIVE_PROJECTS_TOKEN = '{{narrative:PROJECTS}}';

const lines = (text: string): string[] => text.split(/\r\n|\n|\r/).map((line) => line.trim()).filter((line) => line !== '');

/**
 * The blocks that the token `{{narrative:PROJECTS}}` stands for: for each project a heading with its code and name, then the eight headed fields in the order of the form (a field with no words keeps a square-bracket
 * hint, as the skeleton of a form does: the platform never writes a reason or a request), the standard causes and the directive results. With no project the token becomes one italic line that says so.
 */
export function projectNarrativeBlocks(items: readonly ProjectNarrativeText[]): NarrativeBlock[] {
  if (items.length === 0) return [{ type: 'PARAGRAPH', text: `[${message('ent.narrative.word.none')}]`, italic: true }];
  const blocks: NarrativeBlock[] = [];
  for (const item of items) {
    blocks.push({ type: 'HEADING', level: 3, text: `${item.projectCode} - ${item.projectName}` });
    NARRATIVE_FIELDS.forEach((field, index) => {
      blocks.push({ type: 'PARAGRAPH', text: `${index + 1}. ${message(`ent.narrative.field.${field}`)}`, bold: true, align: 'LEFT' });
      const text = item.fields[field] ?? null;
      if (text === null) blocks.push({ type: 'PARAGRAPH', text: `[${message('ent.narrative.word.empty')}]`, italic: true });
      else for (const line of lines(text)) blocks.push({ type: 'PARAGRAPH', text: line, align: 'JUSTIFY' });
      if (field === 'causes' && item.causeLabels.length > 0) blocks.push({ type: 'PARAGRAPH', text: message('ent.narrative.word.standard_causes', { causes: item.causeLabels.join('; ') }), italic: true });
    });
    if (item.directiveLines.length > 0) {
      blocks.push({ type: 'PARAGRAPH', text: message('ent.narrative.word.directives'), bold: true, align: 'LEFT' });
      blocks.push({ type: 'LIST', ordered: false, items: [...item.directiveLines] });
    }
  }
  return blocks;
}
