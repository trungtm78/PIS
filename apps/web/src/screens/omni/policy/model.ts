import { ApiError } from '@machvon/api-client';

/** Permission of the screens (x-permission in openapi.json). */
export const MANAGE_PERMISSION = 'omni.policy.manage';

export const REASON_MIN = 10;
export const REASON_MAX = 2000;
export const BODY_MAX = 2000;
export const TITLE_MAX = 120;
export const CHANNELS = ['EMAIL', 'SMS', 'ZALO_OA', 'WHATSAPP'] as const;
export const PRIORITIES = ['HIGH', 'NORMAL', 'LOW'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const CLASSIFICATIONS = ['PUBLIC', 'INTERNAL'] as const;

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

// ---- the routing policy -----------------------------------------------------------------------------------------------------------

export interface Rule {
  channels: string[];
  keywords: string[];
  queueUnitId: string;
  priority: Priority;
}

export type PolicyStatus = 'Draft' | 'Published' | 'Superseded';

export interface Policy {
  id: string;
  revision: number;
  status: PolicyStatus;
  rules: Rule[];
  calendarCode: string;
  firstResponseMinutes: number;
  resolutionHours: number;
  publishedAt: string | undefined;
  version: number;
}

function toRule(raw: unknown): Rule | undefined {
  if (!isRecord(raw) || typeof raw.queue_unit_id !== 'string') return undefined;
  const priority = PRIORITIES.find((candidate) => candidate === raw.priority) ?? 'NORMAL';
  return { channels: strings(raw.channels), keywords: strings(raw.keywords), queueUnitId: raw.queue_unit_id, priority };
}

export function toPolicy(raw: unknown): Policy | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string') return undefined;
  const status = (['Draft', 'Published', 'Superseded'] as const).find((candidate) => candidate === raw.status);
  if (status === undefined) return undefined;
  return {
    id: raw.id,
    revision: typeof raw.revision === 'number' ? raw.revision : 0,
    status,
    rules: Array.isArray(raw.rules) ? raw.rules.flatMap((rule) => toRule(rule) ?? []) : [],
    calendarCode: text(raw.calendar_code),
    firstResponseMinutes: typeof raw.first_response_minutes === 'number' ? raw.first_response_minutes : 0,
    resolutionHours: typeof raw.resolution_hours === 'number' ? raw.resolution_hours : 0,
    publishedAt: typeof raw.published_at === 'string' ? raw.published_at : undefined,
    version: typeof raw.version === 'number' ? raw.version : 0,
  };
}

export interface PolicyPage {
  items: Policy[];
  nextCursor: string | undefined;
  /** The units a rule may name as a queue: given with the first page of the policies. */
  units: UnitOption[];
}

const cursorOf = (raw: Raw): string | undefined => (typeof raw.next_cursor === 'string' && raw.next_cursor !== '' ? raw.next_cursor : undefined);

export function toPolicyPage(raw: unknown): PolicyPage {
  const view: Raw = isRecord(raw) ? raw : {};
  return {
    items: Array.isArray(view.items) ? view.items.flatMap((item) => toPolicy(item) ?? []) : [],
    nextCursor: cursorOf(view),
    units: Array.isArray(view.units) ? view.units.flatMap((unit) => toUnit(unit) ?? []) : [],
  };
}

export interface UnitOption {
  id: string;
  name: string;
}

export function toUnit(raw: unknown): UnitOption | undefined {
  return isRecord(raw) && typeof raw.id === 'string' ? { id: raw.id, name: text(raw.name) || raw.id } : undefined;
}

export interface RuleForm {
  channel: string;
  keywords: string;
  queueUnitId: string;
  priority: Priority;
}

export interface PolicyForm {
  rules: RuleForm[];
  calendarCode: string;
  firstResponseMinutes: string;
  resolutionHours: string;
}

export const emptyRule = (): RuleForm => ({ channel: '', keywords: '', queueUnitId: '', priority: 'NORMAL' });
export const emptyPolicy = (): PolicyForm => ({ rules: [], calendarCode: '', firstResponseMinutes: '30', resolutionHours: '24' });

export type PolicyProblem = 'calendar' | 'firstResponse' | 'resolution' | 'ruleUnit';

const whole = (value: string, min: number, max: number): boolean => /^[0-9]{1,5}$/.test(value.trim()) && Number(value) >= min && Number(value) <= max;

/** What the server would refuse, told before anything is sent. */
export function policyProblems(form: PolicyForm): PolicyProblem[] {
  const found: PolicyProblem[] = [];
  if (!/^[A-Za-z0-9_.-]{1,60}$/.test(form.calendarCode.trim())) found.push('calendar');
  if (!whole(form.firstResponseMinutes, 1, 10_080)) found.push('firstResponse');
  if (!whole(form.resolutionHours, 1, 2_400)) found.push('resolution');
  if (form.rules.some((rule) => rule.queueUnitId === '')) found.push('ruleUnit');
  return found;
}

const words = (value: string): string[] => value.split(',').map((word) => word.trim()).filter((word) => word !== '');

export function policyBody(form: PolicyForm): Record<string, unknown> {
  return {
    rules: form.rules.map((rule) => ({
      ...(rule.channel === '' ? {} : { channels: [rule.channel] }),
      ...(words(rule.keywords).length === 0 ? {} : { keywords: words(rule.keywords) }),
      queue_unit_id: rule.queueUnitId,
      priority: rule.priority,
    })),
    calendar_code: form.calendarCode.trim(),
    first_response_minutes: Number(form.firstResponseMinutes),
    resolution_hours: Number(form.resolutionHours),
  };
}

export const reasonProblem = (reason: string): boolean => reason.trim().length < REASON_MIN || reason.trim().length > REASON_MAX;

// ---- the canned replies -----------------------------------------------------------------------------------------------------------

export interface Reply {
  id: string;
  code: string;
  title: string;
  bodyText: string;
  channels: string[];
  classification: string;
  status: 'Active' | 'Retired';
  version: number;
}

export function toReply(raw: unknown): Reply | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string') return undefined;
  return {
    id: raw.id,
    code: text(raw.code),
    title: text(raw.title),
    bodyText: text(raw.body_text),
    channels: strings(raw.channels),
    classification: text(raw.classification),
    status: raw.status === 'Retired' ? 'Retired' : 'Active',
    version: typeof raw.version === 'number' ? raw.version : 0,
  };
}

export interface ReplyPage {
  items: Reply[];
  nextCursor: string | undefined;
}

export function toReplyPage(raw: unknown): ReplyPage {
  const view: Raw = isRecord(raw) ? raw : {};
  return { items: Array.isArray(view.items) ? view.items.flatMap((item) => toReply(item) ?? []) : [], nextCursor: cursorOf(view) };
}

export interface ReplyForm {
  code: string;
  title: string;
  bodyText: string;
  channels: string[];
  classification: string;
}

export const emptyReply = (): ReplyForm => ({ code: '', title: '', bodyText: '', channels: [], classification: 'PUBLIC' });
export const formOfReply = (reply: Reply): ReplyForm => ({ code: reply.code, title: reply.title, bodyText: reply.bodyText, channels: reply.channels, classification: reply.classification });

/** A place to be filled (the same as the server's): a reply that has one is a template, and templates are made in NOT. */
const VARIABLE = /\{\{[^}]*\}\}|\{[A-Za-z_][A-Za-z0-9_.]*\}|\$\{[^}]*\}|%[A-Za-z_][A-Za-z0-9_]*%/;

export type ReplyField = 'code' | 'title' | 'bodyText' | 'channels' | 'classification';

/** The fields the server would refuse, with the reason of each: shown next to the field. */
export function replyProblems(form: ReplyForm): Partial<Record<ReplyField, 'invalid' | 'variable' | 'class'>> {
  const found: Partial<Record<ReplyField, 'invalid' | 'variable' | 'class'>> = {};
  if (!/^[a-z0-9_.-]{3,60}$/.test(form.code)) found.code = 'invalid';
  if (form.title.trim() === '' || form.title.trim().length > TITLE_MAX) found.title = 'invalid';
  const body = form.bodyText.trim();
  if (body === '' || body.length > BODY_MAX) found.bodyText = 'invalid';
  else if (VARIABLE.test(body)) found.bodyText = 'variable';
  if (form.channels.length === 0) found.channels = 'invalid';
  if (!(CLASSIFICATIONS as readonly string[]).includes(form.classification)) found.classification = 'class';
  return found;
}

export const replyBody = (form: ReplyForm): Record<string, unknown> => ({
  code: form.code,
  title: form.title.trim(),
  body_text: form.bodyText.trim(),
  channels: form.channels,
  classification: form.classification,
});

// ---- what the server refused with ----------------------------------------------------------------------------------------------------

export type ProblemReason = 'invalid' | 'calendar' | 'taken' | 'state' | 'conflict' | 'denied' | 'notFound' | 'session' | 'general';
export interface ProblemView {
  reason: ProblemReason;
  /** The field the server named, when it names one. */
  field: string | undefined;
}

export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined };
  const field = error.detail;
  switch (error.code) {
    case 'POLICY_INVALID':
      return { reason: field === 'calendar_code' ? 'calendar' : 'invalid', field };
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
      return { reason: 'invalid', field };
    case 'CANNED_CODE_TAKEN':
      return { reason: 'taken', field: 'code' };
    case 'POLICY_STATE_INVALID':
      return { reason: 'state', field };
    case 'VERSION_CONFLICT':
      return { reason: 'conflict', field };
    case 'SCOPE_DENIED':
    case 'ENTITLEMENT_DENIED':
      return { reason: 'denied', field };
    case 'RESOURCE_NOT_FOUND':
      return { reason: 'notFound', field };
    case 'SESSION_EXPIRED':
      return { reason: 'session', field };
    default:
      return { reason: 'general', field };
  }
}

/** The field of the reply form a refusal names, in the words of the form (`body_text` is the text). */
export const replyFieldOf = (field: string | undefined): ReplyField | undefined => (field === 'body_text' ? 'bodyText' : (['code', 'title', 'channels', 'classification'] as const).find((candidate) => candidate === field));
