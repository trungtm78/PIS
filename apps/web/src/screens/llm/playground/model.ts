import { ApiError } from '@machvon/api-client';
import { REQUEST_STATUSES } from '../gateway-model';
import type { RequestStatus } from '../gateway-model';
import { CLASSIFICATIONS, ROUTES } from '../llm-model';
import type { Classification, Route } from '../llm-model';

/** LLM-11: the playground of the AI gateway (ST-LLM-009, LLM F1, BR-LLM-01). A try goes through the same classification, the same route rules and the same budget as any other request; nothing that was typed or answered is kept or shown. */
export const INVOKE_PERMISSION = 'ai.invoke';
export const PROFILE_READ_PERMISSION = 'model_profile_version.read';
export const TRACE_PATH = '/llm/llm-14';

export const MAX_INPUT = 20_000;
export const MAX_DOCUMENTS = 50;
const MODULE_PATTERN = /^[A-Za-z][A-Za-z0-9]{1,9}$/;
const COST_PATTERN = /^[0-9]{1,24}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PlaygroundForm {
  profileId: string;
  subjectModule: string;
  documents: string;
  input: string;
  maxCostVnd: string;
  attestationId: string;
}

export const EMPTY_FORM: PlaygroundForm = { profileId: '', subjectModule: 'LLM', documents: '', input: '', maxCostVnd: '', attestationId: '' };

export type FieldProblem = 'required' | 'invalid' | 'tooMany' | 'tooLong';
export type FormErrors = Partial<Record<keyof PlaygroundForm, FieldProblem>>;

/** The document versions typed in, one or more to a line or separated by commas, each once and in lower case. */
export function documentIds(documents: string): string[] {
  return [
    ...new Set(
      documents
        .split(/[\s,;]+/)
        .filter((entry) => entry !== '')
        .map((entry) => entry.toLowerCase()),
    ),
  ];
}

/** What is wrong with the form before it is sent; the server decides again on everything. */
export function validate(form: PlaygroundForm): FormErrors {
  const errors: FormErrors = {};
  if (form.profileId === '') errors.profileId = 'required';
  if (!MODULE_PATTERN.test(form.subjectModule.trim())) errors.subjectModule = form.subjectModule.trim() === '' ? 'required' : 'invalid';
  const ids = documentIds(form.documents);
  if (ids.length > MAX_DOCUMENTS) errors.documents = 'tooMany';
  else if (ids.some((id) => !UUID_PATTERN.test(id))) errors.documents = 'invalid';
  if (form.input.trim() === '') errors.input = 'required';
  else if (form.input.length > MAX_INPUT) errors.input = 'tooLong';
  if (form.maxCostVnd.trim() !== '' && !COST_PATTERN.test(form.maxCostVnd.trim())) errors.maxCostVnd = 'invalid';
  if (form.attestationId.trim() !== '' && !UUID_PATTERN.test(form.attestationId.trim())) errors.attestationId = 'invalid';
  return errors;
}

/** The SHA-256 of the text as 64 lower-case hexadecimal digits: the gateway is given this and a reference, never the text. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface CompletionBody {
  task_type: string;
  subject_module: string;
  source_refs: Array<{ document_version_id: string }>;
  input_ref: string;
  input_sha256: string;
  max_cost_vnd?: string;
  anonymisation_attestation_id?: string;
}

export function requestBody(form: PlaygroundForm, taskType: string, inputSha256: string): CompletionBody {
  return {
    task_type: taskType,
    subject_module: form.subjectModule.trim().toUpperCase(),
    source_refs: documentIds(form.documents).map((id) => ({ document_version_id: id })),
    input_ref: `playground/${inputSha256}`,
    input_sha256: inputSha256,
    ...(form.maxCostVnd.trim() === '' ? {} : { max_cost_vnd: form.maxCostVnd.trim() }),
    ...(form.attestationId.trim() === '' ? {} : { anonymisation_attestation_id: form.attestationId.trim().toLowerCase() }),
  };
}

export interface Answer {
  requestId: string;
  status: RequestStatus;
  classification: Classification | null;
  route: Route | null;
  rejectCode: string | null;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
const oneOf = <T extends string>(list: readonly T[], value: unknown): T | undefined => list.find((entry) => entry === value);

/** What the gateway answered to a try: where it stands, how the data were classified, the route they were given and the rule that refused them, if one did. */
export function toAnswer(raw: unknown): Answer | undefined {
  const row = asRecord(raw);
  const status = oneOf(REQUEST_STATUSES, row?.status);
  if (row === undefined || typeof row.resource_id !== 'string' || status === undefined) return undefined;
  return {
    requestId: row.resource_id,
    status,
    classification: oneOf(CLASSIFICATIONS, row.data_classification) ?? null,
    route: oneOf(ROUTES, row.route_class) ?? null,
    rejectCode: typeof row.reject_code === 'string' ? row.reject_code : null,
  };
}

export type Reason = 'quota' | 'budget' | 'routeNotAllowed' | 'killSwitch' | 'validation' | 'scope' | 'general';

const BY_CODE: Record<string, Reason> = {
  BUDGET_EXCEEDED: 'budget',
  AI_ROUTE_NOT_ALLOWED: 'routeNotAllowed',
  AI_KILL_SWITCH_ENGAGED: 'killSwitch',
  VALIDATION_FAILED: 'validation',
  SCOPE_DENIED: 'scope',
};

const TOO_MANY_REQUESTS = 429;

/** Why the gateway refused a try: a code of the gateway is told by its meaning, a rate limit (429) that is not the budget is the quota of the playground. */
export function describeProblem(error: unknown): Reason {
  if (!(error instanceof ApiError)) return 'general';
  return BY_CODE[error.code] ?? (error.status === TOO_MANY_REQUESTS ? 'quota' : 'general');
}
