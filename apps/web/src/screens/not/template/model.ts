import { ApiError } from '@machvon/api-client';

/** The permissions of NOT-07 and NOT-08 (x-permission of the operations in openapi.json). */
export const MANAGE_PERMISSION = 'notification.template.manage';
export const APPROVE_PERMISSION = 'notification.template.approve';
export const READ_PERMISSION = 'notification_template_version.read';

export const CHANNELS = ['IN_APP', 'EMAIL', 'SMS', 'PUSH_FCM', 'PUSH_APNS', 'ZALO_ZNS', 'ZALO_OA', 'WHATSAPP'] as const;
export type Channel = (typeof CHANNELS)[number];
export const LOCALES = ['vi-VN', 'en-US'] as const;
export const PURPOSES = ['OPERATIONAL', 'SECURITY', 'REMINDER', 'ANNOUNCEMENT', 'DIGEST', 'SUPPORT_CONVERSATION'] as const;
export const VARIABLE_TYPES = ['string', 'number', 'integer', 'boolean', 'money'] as const;
export const CLASSIFICATIONS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PERSONAL'] as const;
/** The channels that reach a phone or an outside provider (BR-NOT-11): the same set as the server's. */
const RESTRICTED: ReadonlySet<string> = new Set(['PUSH_FCM', 'PUSH_APNS', 'SMS', 'ZALO_ZNS', 'ZALO_OA', 'WHATSAPP']);
export const MAX_RECIPIENTS = 10;
export const TEST_PREFIX = '[TEST] ';
export const MIN_REASON = 10;
export const MAX_REASON = 2000;

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]{0,59})\s*\}\}/g;
const CODE = /^[a-z0-9_.-]{3,80}$/;
const VARIABLE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,59}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TemplateStatus = 'Draft' | 'InReview' | 'PendingProvider' | 'Active' | 'Rejected' | 'Retired';

export interface VariableView {
  name: string;
  type: string;
  classification: string;
}

export interface TemplateView {
  id: string;
  code: string;
  channel: string;
  locale: string;
  revision: number;
  purpose: string;
  subject: string | undefined;
  body: string;
  variables: VariableView[];
  lockscreenSafe: boolean;
  status: TemplateStatus;
  providerStatus: string;
  createdBy: string;
  approvedBy: string | undefined;
  supersedesId: string | undefined;
  createdAt: string;
  version: number;
}

export interface TemplatePage {
  items: TemplateView[];
  nextCursor: string | undefined;
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const optional = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const STATUSES: readonly string[] = ['Draft', 'InReview', 'PendingProvider', 'Active', 'Rejected', 'Retired'];

export function toTemplate(raw: unknown): TemplateView | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.code !== 'string') return undefined;
  const content = isRecord(raw.content_ast) ? raw.content_ast : {};
  const properties = isRecord(raw.variable_schema) && isRecord(raw.variable_schema.properties) ? raw.variable_schema.properties : {};
  return {
    id: raw.id,
    code: raw.code,
    channel: text(raw.channel),
    locale: text(raw.locale),
    revision: typeof raw.revision === 'number' ? raw.revision : 0,
    purpose: text(raw.purpose),
    subject: optional(content.subject),
    body: text(content.body),
    variables: Object.entries(properties).flatMap(([name, value]): VariableView[] => (isRecord(value) ? [{ name, type: text(value.type), classification: text(value.classification) }] : [])),
    lockscreenSafe: raw.lockscreen_safe === true,
    status: STATUSES.includes(text(raw.status)) ? (raw.status as TemplateStatus) : 'Draft',
    providerStatus: text(raw.provider_status),
    createdBy: text(raw.created_by),
    approvedBy: optional(raw.approved_by),
    supersedesId: optional(raw.supersedes_id),
    createdAt: text(raw.created_at),
    version: typeof raw.version === 'number' ? raw.version : 1,
  };
}

export function toTemplatePage(raw: unknown): TemplatePage {
  const view: Raw = isRecord(raw) ? raw : {};
  return { items: Array.isArray(view.items) ? view.items.flatMap((item) => toTemplate(item) ?? []) : [], nextCursor: optional(view.next_cursor) };
}

export const toRecipients = (raw: unknown): string[] => (isRecord(raw) && Array.isArray(raw.membership_ids) ? raw.membership_ids.filter((item): item is string => typeof item === 'string') : []);

export interface TemplateForm {
  code: string;
  channel: Channel;
  locale: string;
  purpose: string;
  subject: string;
  body: string;
  variables: VariableView[];
  supersedesId: string | undefined;
}

export const emptyForm = (): TemplateForm => ({ code: '', channel: 'EMAIL', locale: 'vi-VN', purpose: 'OPERATIONAL', subject: '', body: '', variables: [], supersedesId: undefined });

/** The form of a new revision that starts from an existing one: the same line, the same words, ready to change. */
export const reviseForm = (template: TemplateView): TemplateForm => ({
  code: template.code,
  channel: template.channel as Channel,
  locale: template.locale,
  purpose: template.purpose,
  subject: template.subject ?? '',
  body: template.body,
  variables: template.variables.map((variable) => ({ ...variable })),
  supersedesId: template.id,
});

export const isPushChannel = (channel: string): boolean => channel === 'PUSH_FCM' || channel === 'PUSH_APNS';
export const placeholdersOf = (value: string): string[] => [...new Set([...value.matchAll(PLACEHOLDER)].map((match) => match[1] as string))];

export type FormProblem = { field: 'code' | 'body' | 'subject' | 'variables' } | { field: 'undeclared'; name: string } | { field: 'classified'; name: string };

/** What the server would refuse, judged the way it does, so that the author is told before sending: the server stays the judge. */
export function problemsOf(form: TemplateForm): FormProblem[] {
  const found: FormProblem[] = [];
  if (!CODE.test(form.code.trim())) found.push({ field: 'code' });
  if (form.body.trim() === '') found.push({ field: 'body' });
  if (form.channel === 'EMAIL' && form.subject.trim() === '' ) found.push({ field: 'subject' });
  const names = form.variables.map((variable) => variable.name.trim());
  if (names.some((name) => !VARIABLE_NAME.test(name)) || new Set(names).size !== names.length) found.push({ field: 'variables' });
  const declared = new Map(form.variables.map((variable) => [variable.name.trim(), variable] as const));
  for (const name of placeholdersOf(`${form.body} ${form.channel === 'EMAIL' ? form.subject : ''}`)) {
    const variable = declared.get(name);
    if (variable === undefined) found.push({ field: 'undeclared', name });
    else if (RESTRICTED.has(form.channel) && (variable.type === 'money' || variable.classification === 'CONFIDENTIAL' || variable.classification === 'PERSONAL')) found.push({ field: 'classified', name });
  }
  return found;
}

export function bodyOf(form: TemplateForm): Record<string, unknown> {
  return form.channel === 'EMAIL' ? { subject: form.subject.trim(), body: form.body } : { body: form.body };
}

export function variableSchemaOf(form: TemplateForm): Record<string, unknown> {
  return { type: 'object', properties: Object.fromEntries(form.variables.map((variable) => [variable.name.trim(), { type: variable.type, classification: variable.classification }])) };
}

/** The preview of a test message: the template filled with the sample values, with the prefix every test message has. A placeholder with no value stays visible, marked, so the author sees what is missing. */
export function previewOf(template: Pick<TemplateView, 'subject' | 'body'>, samples: Readonly<Record<string, string>>): { subject: string | undefined; text: string; missing: string[] } {
  const missing = new Set<string>();
  const fill = (value: string): string =>
    value.replace(PLACEHOLDER, (_whole, name: string) => {
      const sample = Object.hasOwn(samples, name) ? samples[name] : undefined;
      if (sample === undefined || sample === '') {
        missing.add(name);
        return `{{${name}}}`;
      }
      return sample;
    });
  const text = `${TEST_PREFIX}${fill(template.body)}`;
  const subject = template.subject === undefined ? undefined : `${TEST_PREFIX}${fill(template.subject)}`;
  return { subject, text, missing: [...missing] };
}

/** The sample values the server takes: numbers for number, integer and money, true or false for boolean; a value that does not fit is left out so the server names it. */
export function samplesOf(variables: readonly VariableView[], entered: Readonly<Record<string, string>>): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const variable of variables) {
    const raw = entered[variable.name];
    if (raw === undefined || raw === '') continue;
    if (variable.type === 'string') values[variable.name] = raw;
    // Only the two explicit values: anything else is left out, so the server names the variable instead of a guess being sent.
    else if (variable.type === 'boolean') {
      if (raw === 'true' || raw === 'false') values[variable.name] = raw === 'true';
    }
    else if (Number.isFinite(Number(raw))) values[variable.name] = Number(raw);
  }
  return values;
}

export const canSubmit = (template: Pick<TemplateView, 'status'>): boolean => template.status === 'Draft';
export const canDecide = (template: Pick<TemplateView, 'status'>): boolean => template.status === 'InReview' || template.status === 'PendingProvider';
/** A revision is edited only while it is a Draft; the server refuses any other edit (TEMPLATE_IMMUTABLE). */
export const isLocked = (template: Pick<TemplateView, 'status'>): boolean => template.status !== 'Draft';
export const isUuid = (value: string): boolean => UUID.test(value.trim());
export const isReasonValid = (reason: string): boolean => reason.trim().length >= MIN_REASON && reason.trim().length <= MAX_REASON;

export type ProblemReason = 'invalid' | 'classified' | 'immutable' | 'providerPending' | 'self' | 'conflict' | 'recipient' | 'account' | 'provider' | 'denied' | 'notFound' | 'session' | 'general';
export interface ProblemView {
  reason: ProblemReason;
  field: string | undefined;
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  TEMPLATE_INVALID: 'invalid',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  TEMPLATE_VARIABLE_CLASSIFIED: 'classified',
  TEMPLATE_IMMUTABLE: 'immutable',
  TEMPLATE_PROVIDER_PENDING: 'providerPending',
  SELF_APPROVAL_DENIED: 'self',
  VERSION_CONFLICT: 'conflict',
  TEST_RECIPIENT_NOT_ALLOWED: 'recipient',
  CHANNEL_ACCOUNT_UNKNOWN: 'account',
  PROVIDER_UNAVAILABLE: 'provider',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  RESOURCE_NOT_FOUND: 'notFound',
  SESSION_EXPIRED: 'session',
};

export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail };
}
