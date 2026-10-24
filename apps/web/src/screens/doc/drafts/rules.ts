import type { components } from '@machvon/contracts';
import { REVIEW_CHECKLIST } from './types';
import type { ChecklistKey, Circulation, DraftDetail, RecipientKind, SigningMode, Urgency } from './types';

type Schemas = components['schemas'];
export type CreateBody = Schemas['DocOutgoingCreate'];
export type UpdateBodyShape = Schemas['DocOutgoingDraftChange'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;
const WHOLE_VND = /^(0|[1-9][0-9]{0,23})$/;
export const MIN_TITLE_CHARS = 3;
export const MAX_TITLE_CHARS = 500;
export const MIN_REASON_CHARS = 10;
export const MAX_RECIPIENTS = 500;

/** The members of a payload the face of a document is made of besides the placeholders of the template (DOC.md F14). */
export const FIXED_FIELDS = ['agency', 'parent_agency', 'place', 'signer_title', 'signer_name', 'amount_vnd'] as const;
const REQUIRED_FIXED: readonly string[] = ['agency', 'place'];

export interface RecipientForm {
  key: string;
  kind: RecipientKind;
  name: string;
  code: string;
}

export interface DraftForm {
  docTypeCode: string;
  templateCode: string;
  title: string;
  unitId: string;
  urgency: Urgency;
  circulation: Circulation;
  values: Record<string, string>;
  recipients: RecipientForm[];
  signerId: string;
  signingMode: SigningMode;
  delegationId: string;
}

export const EMPTY_FORM: DraftForm = {
  docTypeCode: '',
  templateCode: '',
  title: '',
  unitId: '',
  urgency: 'NORMAL',
  circulation: 'INTERNAL_CIRCULATION',
  values: {},
  recipients: [],
  signerId: '',
  signingMode: 'DIRECT',
  delegationId: '',
};

/** The contract types a free-form object as `Record<string, never>`; the server reads what the object holds. */
export const loose = (value: Record<string, unknown>): Record<string, never> => value as Record<string, never>;

export const isUuid = (value: string): boolean => UUID.test(value.trim());

/** The placeholders of a template body in order of first use, each once. */
export function placeholdersOf(blocks: ReadonlyArray<{ text: string }>): string[] {
  const names: string[] = [];
  for (const block of blocks) for (const match of block.text.matchAll(PLACEHOLDER)) if (match[1] !== undefined && !names.includes(match[1])) names.push(match[1]);
  return names;
}

export interface PayloadField {
  name: string;
  required: boolean;
  /** The placeholders that carry running text are written in a text area. */
  multiline: boolean;
}

const MULTILINE: readonly string[] = ['body', 'grounds', 'content', 'subject', 'greeting'];

/** The inputs of the editor for a template: the placeholders of its body, the required members first. */
export function payloadFields(blocks: ReadonlyArray<{ text: string }>, required: readonly string[]): PayloadField[] {
  const names = [...new Set([...required, ...placeholdersOf(blocks)])].filter((name) => !(FIXED_FIELDS as readonly string[]).includes(name));
  return names.map((name) => ({ name, required: required.includes(name), multiline: MULTILINE.includes(name) || name.endsWith('_text') }));
}

/** A payload from the values of the form: empty values are left out, a dotted name becomes a nested member. */
export function payloadOf(values: Readonly<Record<string, string>>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(values)) {
    const value = raw.trim();
    if (value === '') continue;
    const path = name.split('.');
    let target = payload;
    for (const [index, part] of path.entries()) {
      if (index === path.length - 1) target[part] = value;
      else {
        const next = target[part];
        target = typeof next === 'object' && next !== null ? (next as Record<string, unknown>) : (target[part] = {} as Record<string, unknown>);
      }
    }
  }
  return payload;
}

/** The values of the form from a payload that was stored: nested members are written with dotted names again. */
export function valuesOf(payload: Readonly<Record<string, unknown>>, prefix = ''): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [name, member] of Object.entries(payload)) {
    if (typeof member === 'string') values[`${prefix}${name}`] = member;
    else if (typeof member === 'object' && member !== null && !Array.isArray(member)) Object.assign(values, valuesOf(member as Record<string, unknown>, `${prefix}${name}.`));
  }
  return values;
}

let counter = 0;
export const newRecipient = (kind: RecipientKind = 'EXTERNAL_AGENCY', name = '', code = ''): RecipientForm => ({ key: `r${(counter += 1)}`, kind, name, code });

/** The form of an existing draft. */
export function formOf(detail: DraftDetail, templateCode: string): DraftForm {
  return {
    docTypeCode: detail.docTypeCode,
    templateCode,
    title: detail.title,
    unitId: detail.draftingUnitId,
    urgency: detail.urgency,
    circulation: detail.circulation,
    values: valuesOf(detail.payload),
    recipients: detail.recipients.map((recipient) => newRecipient(recipient.kind, recipient.name, recipient.code ?? '')),
    signerId: detail.signerUserId ?? '',
    signingMode: detail.signingMode,
    delegationId: detail.delegationId ?? '',
  };
}

export type FieldProblemCode = 'REQUIRED' | 'TOO_SHORT' | 'TOO_LONG' | 'INVALID' | 'DELEGATION_REQUIRED' | 'DELEGATION_NOT_ALLOWED';

export interface FieldProblem {
  field: string;
  code: FieldProblemCode;
}

/** What the server would refuse for the shape of the form, found before a request is made. The required members of the payload are enforced when the draft goes to review: a draft may be saved unfinished. */
export function formProblems(form: DraftForm, options: { creating: boolean }): FieldProblem[] {
  const problems: FieldProblem[] = [];
  const title = form.title.trim();
  if (options.creating && form.docTypeCode === '') problems.push({ field: 'docTypeCode', code: 'REQUIRED' });
  if (options.creating && form.unitId === '') problems.push({ field: 'unitId', code: 'REQUIRED' });
  if (title === '') problems.push({ field: 'title', code: 'REQUIRED' });
  else if (title.length < MIN_TITLE_CHARS) problems.push({ field: 'title', code: 'TOO_SHORT' });
  else if (title.length > MAX_TITLE_CHARS) problems.push({ field: 'title', code: 'TOO_LONG' });
  const amount = (form.values.amount_vnd ?? '').trim();
  if (amount !== '' && !WHOLE_VND.test(amount)) problems.push({ field: 'amount_vnd', code: 'INVALID' });
  if (form.signerId.trim() !== '' && !isUuid(form.signerId)) problems.push({ field: 'signerId', code: 'INVALID' });
  if (form.delegationId.trim() !== '' && !isUuid(form.delegationId)) problems.push({ field: 'delegationId', code: 'INVALID' });
  if (form.signingMode !== 'DIRECT' && form.delegationId.trim() === '') problems.push({ field: 'delegationId', code: 'DELEGATION_REQUIRED' });
  if (form.signingMode === 'DIRECT' && form.delegationId.trim() !== '') problems.push({ field: 'delegationId', code: 'DELEGATION_NOT_ALLOWED' });
  if (form.recipients.some((recipient) => recipient.name.trim() === '')) problems.push({ field: 'recipients', code: 'REQUIRED' });
  if (form.recipients.length > MAX_RECIPIENTS) problems.push({ field: 'recipients', code: 'TOO_LONG' });
  return problems;
}

/** The required members of the payload that the form still leaves empty (the fixed ones and those of the template). */
export function missingFields(form: DraftForm, required: readonly string[]): string[] {
  return [...new Set([...REQUIRED_FIXED, ...required])].filter((name) => (form.values[name] ?? '').trim() === '');
}

/** The body of createOutgoingDocument from the form. */
export function createBody(form: DraftForm): CreateBody {
  return {
    doc_type_code: form.docTypeCode,
    ...(form.templateCode === '' ? {} : { template_code: form.templateCode }),
    title: form.title.trim(),
    drafting_unit_id: form.unitId,
    urgency: form.urgency,
    circulation: form.circulation,
    payload: loose(payloadOf(form.values)),
    recipients: recipientsOf(form.recipients),
    ...signingOf(form),
  };
}

/** The body of updateOutgoingDocumentDraft: the whole editable part of the form, which the server compares and stores. */
export function updateBody(form: DraftForm): UpdateBodyShape {
  return {
    title: form.title.trim(),
    urgency: form.urgency,
    payload: loose(payloadOf(form.values)),
    recipients: recipientsOf(form.recipients),
    ...signingOf(form),
  };
}

function recipientsOf(recipients: readonly RecipientForm[]): Array<Record<string, never>> {
  return recipients.map((recipient) => loose({ kind: recipient.kind, name: recipient.name.trim(), ...(recipient.code.trim() === '' ? {} : { code: recipient.code.trim() }) }));
}

function signingOf(form: DraftForm): Pick<CreateBody, 'signing_mode' | 'signer_user_id' | 'delegation_id'> {
  return {
    signing_mode: form.signingMode,
    ...(form.signerId.trim() === '' ? {} : { signer_user_id: form.signerId.trim().toLowerCase() }),
    ...(form.delegationId.trim() === '' ? {} : { delegation_id: form.delegationId.trim().toLowerCase() }),
  };
}

/** Whether every item of the checklist is confirmed. */
export const checklistComplete = (checks: Readonly<Partial<Record<ChecklistKey, boolean>>>): boolean => REVIEW_CHECKLIST.every((key) => checks[key] === true);

/** The body of the review decision: each item with its answer. */
export function checklistBody(checks: Readonly<Partial<Record<ChecklistKey, boolean>>>): Record<ChecklistKey, boolean> {
  return Object.fromEntries(REVIEW_CHECKLIST.map((key) => [key, checks[key] === true])) as Record<ChecklistKey, boolean>;
}

export const reasonProblem = (reason: string): 'REQUIRED' | 'TOO_SHORT' | undefined => {
  const trimmed = reason.trim();
  if (trimmed === '') return 'REQUIRED';
  return trimmed.length < MIN_REASON_CHARS ? 'TOO_SHORT' : undefined;
};

/** The date in Vietnam (UTC+7) as year-month-day: the day a template is looked up for. */
export function vietnamDate(now: Date): string {
  return new Date(now.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Whether a draft can still be edited by its editors. */
export const editable = (status: string): boolean => status === 'DRAFT';

/** A value with its thousands separated for reading: `6000000000` is `6.000.000.000`. */
export function groupDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** The queue a document is read in: where the work on it goes next. */
export function nextRoute(status: string): 'editor' | 'review' | 'signing' | 'numbering' | 'none' {
  if (status === 'DRAFT') return 'editor';
  if (status === 'IN_REVIEW') return 'review';
  if (status === 'SUBMITTED') return 'signing';
  if (status === 'SIGNED') return 'numbering';
  return 'none';
}
