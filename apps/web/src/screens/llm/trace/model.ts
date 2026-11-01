import type { RequestEntry, RequestStatus } from '../gateway-model';

/** LLM-14 and LLM-15: the traces of the gateway and its guardrails (ST-LLM-009, LLM F1, UAT-AC465, UAT-AC466). Only what the gateway recorded about a request is shown; what was asked and what was answered are not kept. */
export const TRACE_PATH = '/llm/llm-14';
export const GUARDRAIL_PATH = '/llm/llm-15';

/** The states a request ends in when something stopped it or went wrong. */
export const ERROR_STATUSES: readonly RequestStatus[] = ['REJECTED_POLICY', 'REJECTED_NO_CITATION', 'FAILED', 'CANCELLED', 'PENDING_RECONCILE'];
/** The states in which a guardrail refused the request. */
export const GUARDRAIL_STATUSES: readonly RequestStatus[] = ['REJECTED_POLICY', 'REJECTED_NO_CITATION'];

const MASK = '***';
// A national identity number is twelve digits; a telephone number is a zero or +84 with nine more digits, which may be set apart by spaces, dots or dashes; a longer run of digits is not one of them. It is for the free text of a trace, not for its identifiers.
const PERSONAL_PATTERNS = [/(?<!\d)\d{12}(?!\d)/g, /(?<!\d)(?:\+84|0)(?:[ .-]?\d){9}(?!\d)/g];

/** The text with anything that looks like an identity number or a telephone number hidden: a trace never shows one, even if one found its way into a field of free text. */
export function maskPersonal(value: string): string {
  return PERSONAL_PATTERNS.reduce((masked, pattern) => masked.replace(pattern, MASK), value);
}

export const isError = (entry: Pick<RequestEntry, 'status' | 'rejectCode'>): boolean => ERROR_STATUSES.includes(entry.status) || entry.rejectCode !== null;

export const isGuardrail = (entry: Pick<RequestEntry, 'status'>): boolean => GUARDRAIL_STATUSES.includes(entry.status);

/** The first eight characters of an identifier, which is how a trace is told in a list. */
export const shortId = (id: string): string => id.slice(0, 8);

/** Whether the words typed are found in the identifier, the task, the model, the provider or the rule of the request; none typed finds everything. */
export function matches(entry: Pick<RequestEntry, 'id' | 'taskType' | 'modelId' | 'providerCode' | 'rejectCode'>, words: string): boolean {
  const needle = words.trim().toLowerCase();
  if (needle === '') return true;
  return [entry.id, entry.taskType, entry.modelId ?? '', entry.providerCode ?? '', entry.rejectCode ?? ''].some((field) => field.toLowerCase().includes(needle));
}
