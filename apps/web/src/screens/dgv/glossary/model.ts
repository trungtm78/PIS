import { ApiError } from '@machvon/api-client';

export const MANAGE_PERMISSION = 'data.catalog.manage';
export const READ_PERMISSION = 'data.catalog.read';
/** The permission to read the glossary of MDM, which the terms to bind are listed with. */
export const GLOSSARY_READ_PERMISSION = 'glossary.read';

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export interface BindingView {
  id: string;
  columnName: string | null;
  term: { id: string; termCode: string; termVi: string; definition: string; revision: number; status: string };
  boundBy: string;
  boundAt: string;
  deprecated: boolean;
  successor: { id: string; revision: number } | null;
  replaced: boolean;
}

export interface Coverage {
  bound: number;
  deprecated: number;
  terms: number;
}

export interface BindingList {
  items: BindingView[];
  coverage: Coverage;
}

function toBinding(raw: unknown): BindingView | undefined {
  const row = asRecord(raw);
  const term = asRecord(row?.term);
  const id = text(row?.id);
  const termId = text(term?.id);
  const termCode = text(term?.term_code);
  if (row === undefined || id === undefined || termId === undefined || termCode === undefined || typeof term?.revision !== 'number') return undefined;
  const by = asRecord(row.bound_by);
  const successor = asRecord(row.successor);
  const successorId = text(successor?.id);
  return {
    id,
    columnName: nullableText(row.column_name),
    term: { id: termId, termCode, termVi: text(term.term_vi) ?? '', definition: text(term.definition) ?? '', revision: term.revision, status: text(term.status) ?? '' },
    boundBy: text(by?.display_name) ?? text(by?.membership_id) ?? '',
    boundAt: text(row.bound_at) ?? '',
    deprecated: row.deprecated === true,
    successor: successorId === undefined || typeof successor?.revision !== 'number' ? null : { id: successorId, revision: successor.revision },
    replaced: row.replaced === true,
  };
}

const whole = (value: unknown): number => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0);

export function toBindingList(raw: unknown): BindingList {
  const page = asRecord(raw);
  const coverage = asRecord(page?.coverage);
  return {
    items: (Array.isArray(page?.items) ? page.items : []).flatMap((item) => toBinding(item) ?? []),
    coverage: { bound: whole(coverage?.bound), deprecated: whole(coverage?.deprecated), terms: whole(coverage?.terms) },
  };
}

export interface TermOption {
  id: string;
  termCode: string;
  termVi: string;
  revision: number;
}

/** A term that can be bound: the revision in force (PUBLISHED); anything else is left out. */
export function toTermOption(raw: unknown): TermOption[] {
  const row = asRecord(raw);
  const id = text(row?.id);
  const termCode = text(row?.term_code);
  if (row === undefined || id === undefined || termCode === undefined || row.status !== 'PUBLISHED' || typeof row.revision !== 'number') return [];
  return [{ id, termCode, termVi: text(row.term_vi) ?? termCode, revision: row.revision }];
}

type Mode = 'FULL' | 'READ_ONLY' | undefined;
export const holds = (permissions: readonly string[] | undefined, permission: string, mode: Mode): boolean => (permissions === undefined || permissions.includes(permission)) && mode !== 'READ_ONLY';

// ---- the form ----------------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'invalid';
export type BindField = 'termId' | 'columnName';

export interface BindForm {
  /** The term chosen from the list, or typed as an identifier when the list is not offered. */
  termId: string;
  columnName: string;
}

export const EMPTY_BIND: BindForm = { termId: '', columnName: '' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateBind(form: BindForm): Partial<Record<BindField, FormProblem>> {
  const found: Partial<Record<BindField, FormProblem>> = {};
  const term = form.termId.trim();
  if (term === '') found.termId = 'required';
  else if (!UUID.test(term)) found.termId = 'invalid';
  const column = form.columnName.trim();
  if (column.length > 120) found.columnName = 'invalid';
  return found;
}

export const bindBody = (form: BindForm): Record<string, unknown> => ({
  glossary_term_id: form.termId.trim(),
  ...(form.columnName.trim() === '' ? {} : { column_name: form.columnName.trim() }),
});

// ---- what the server refuses ---------------------------------------------------------------------------------------------------

export type BindProblem = 'notPublished' | 'scopeDenied' | 'notFound' | 'validation' | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, BindProblem>> = {
  GLOSSARY_TERM_NOT_PUBLISHED: 'notPublished',
  SCOPE_DENIED: 'scopeDenied',
  RESOURCE_NOT_FOUND: 'notFound',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
};

export const describeBind = (error: unknown): BindProblem => (error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general');
