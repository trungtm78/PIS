import { dayMs } from '../../gov11/lookahead-form';
import { TEMPLATE_GROUPS } from './types';
import type { TemplateGroup } from './types';

/**
 * The rules of the form that drafts a revision of a document template (DOC-14, createDocumentTemplateRevision): the lengths and the required members of the contract schema, the two JSON members, and the period.
 * The server stays the judge of the legal side (a missing legal basis, an overlapping period, a placeholder schema it cannot use, a duplicate form code).
 */

export interface CreateValues {
  templateCode: string;
  groupCode: TemplateGroup | '';
  docTypeCode: string;
  formCode: string;
  title: string;
  sourceModule: string;
  layoutProfileId: string;
  bodyBlocks: string;
  placeholderSchema: string;
  legalBasis: string;
  legalConfirmationRef: string;
  effectiveFrom: string;
  effectiveUntil: string;
  watermarkText: string;
}

export const EMPTY_CREATE: CreateValues = {
  templateCode: '',
  groupCode: '',
  docTypeCode: '',
  formCode: '',
  title: '',
  sourceModule: '',
  layoutProfileId: '',
  bodyBlocks: '{}',
  placeholderSchema: '{}',
  legalBasis: '',
  legalConfirmationRef: '',
  effectiveFrom: '',
  effectiveUntil: '',
  watermarkText: '',
};

export type CreateProblem = 'required' | 'tooShort' | 'tooLong' | 'notJson' | 'notObject' | 'badDay' | 'beforeStart';
export type CreateField = keyof CreateValues;
export type CreateErrors = Partial<Record<CreateField, CreateProblem>>;

const LIMITS: Readonly<Record<CreateField, { min: number; max: number; required: boolean }>> = {
  templateCode: { min: 3, max: 80, required: true },
  groupCode: { min: 0, max: 0, required: true },
  docTypeCode: { min: 1, max: 20, required: true },
  formCode: { min: 1, max: 40, required: false },
  title: { min: 3, max: 300, required: true },
  sourceModule: { min: 2, max: 10, required: false },
  layoutProfileId: { min: 0, max: 0, required: true },
  bodyBlocks: { min: 0, max: 0, required: true },
  placeholderSchema: { min: 0, max: 0, required: true },
  legalBasis: { min: 3, max: 2000, required: true },
  legalConfirmationRef: { min: 0, max: 50, required: false },
  effectiveFrom: { min: 0, max: 0, required: true },
  effectiveUntil: { min: 0, max: 0, required: false },
  watermarkText: { min: 3, max: 120, required: false },
};

/** Parses a JSON object written in a box; an array, a number or text that is not JSON is told apart. */
export function jsonObjectOf(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; problem: 'notJson' | 'notObject' } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'notJson' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, problem: 'notObject' };
  return { ok: true, value: parsed as Record<string, unknown> };
}

export function validateCreate(values: CreateValues): CreateErrors {
  const errors: CreateErrors = {};
  const textFields: CreateField[] = ['templateCode', 'docTypeCode', 'formCode', 'title', 'sourceModule', 'legalBasis', 'legalConfirmationRef', 'watermarkText'];
  for (const field of textFields) {
    const limit = LIMITS[field];
    const text = values[field].trim();
    if (text === '') {
      if (limit.required) errors[field] = 'required';
    } else if (text.length < limit.min) errors[field] = 'tooShort';
    else if (text.length > limit.max) errors[field] = 'tooLong';
  }
  if (!(TEMPLATE_GROUPS as readonly string[]).includes(values.groupCode)) errors.groupCode = 'required';
  if (values.layoutProfileId === '') errors.layoutProfileId = 'required';
  for (const field of ['bodyBlocks', 'placeholderSchema'] as const) {
    const parsed = jsonObjectOf(values[field]);
    if (!parsed.ok) errors[field] = parsed.problem;
  }
  if (values.effectiveFrom === '') errors.effectiveFrom = 'required';
  else if (dayMs(values.effectiveFrom) === undefined) errors.effectiveFrom = 'badDay';
  if (values.effectiveUntil !== '') {
    if (dayMs(values.effectiveUntil) === undefined) errors.effectiveUntil = 'badDay';
    else if (dayMs(values.effectiveFrom) !== undefined && values.effectiveUntil < values.effectiveFrom) errors.effectiveUntil = 'beforeStart';
  }
  return errors;
}

/** The body of the command from values with no problem: blank optional members are left out, the JSON members are the parsed objects. */
export function createBody(values: CreateValues): Record<string, unknown> {
  const blocks = jsonObjectOf(values.bodyBlocks);
  const schema = jsonObjectOf(values.placeholderSchema);
  const body: Record<string, unknown> = {
    template_code: values.templateCode.trim(),
    group_code: values.groupCode,
    doc_type_code: values.docTypeCode.trim(),
    title: values.title.trim(),
    layout_profile_id: values.layoutProfileId,
    body_blocks: blocks.ok ? blocks.value : {},
    placeholder_schema: schema.ok ? schema.value : {},
    legal_basis: values.legalBasis.trim(),
    effective_from: values.effectiveFrom,
  };
  const optional: Array<[string, string]> = [
    ['form_code', values.formCode.trim()],
    ['source_module', values.sourceModule.trim()],
    ['legal_confirmation_ref', values.legalConfirmationRef.trim()],
    ['effective_until', values.effectiveUntil],
    ['watermark_text', values.watermarkText.trim()],
  ];
  for (const [key, value] of optional) if (value !== '') body[key] = value;
  return body;
}

/** The codes the operation names, in the order the screen tells them apart. */
export type CreateRefusal = 'legalBasis' | 'placeholders' | 'formDuplicate' | 'overlap' | 'invalid' | 'denied' | 'session' | 'other';

export function refusalOfCreate(code: string | undefined): CreateRefusal {
  switch (code) {
    case 'LEGAL_BASIS_REQUIRED':
      return 'legalBasis';
    case 'PLACEHOLDER_SCHEMA_INVALID':
      return 'placeholders';
    case 'FORM_CODE_DUPLICATE':
      return 'formDuplicate';
    case 'TEMPLATE_RANGE_OVERLAP':
      return 'overlap';
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return 'invalid';
    case 'SCOPE_DENIED':
    case 'ENTITLEMENT_DENIED':
      return 'denied';
    case 'SESSION_EXPIRED':
      return 'session';
    default:
      return 'other';
  }
}
