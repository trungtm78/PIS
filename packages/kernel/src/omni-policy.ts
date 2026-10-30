import { DomainError } from './errors.ts';
import { asUuid } from './tenant-context.ts';

/**
 * The rules that put a new conversation in a queue and give it a deadline for the first answer (ST-OMNI-006, OMNI.md 3.1 step 5, BR-OMNI-06), and the answers an agent can reuse (BR-OMNI-08). A policy is a version: written as a draft, published
 * once, replaced by a later one; the conversation keeps the version it was routed by. The rules below are pure.
 */
export const POLICY_CHANNELS = ['EMAIL', 'SMS', 'ZALO_OA', 'WHATSAPP'] as const;
export const POLICY_PRIORITIES = ['HIGH', 'NORMAL', 'LOW'] as const;
export type PolicyPriority = (typeof POLICY_PRIORITIES)[number];
export const MAX_RULES = 50;
export const MAX_KEYWORDS = 20;
export const KEYWORD_MAX = 60;
export const FIRST_RESPONSE_MINUTES_MAX = 10_080;
/** A deadline is not counted further than the working calendar can answer: 2400 working hours, as the issues of ISS. */
export const RESOLUTION_HOURS_MAX = 2_400;

const policyInvalid = (field: string): DomainError => new DomainError('POLICY_INVALID', 422, field);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export interface RoutingRule {
  /** The channels the rule is for; none means every channel. */
  channels: string[];
  /** Words one of which must be in the first message (any case, any accents); none means no word is asked for. */
  keywords: string[];
  /** The unit whose queue the conversation goes to. */
  queueUnitId: string;
  priority: PolicyPriority;
}

export interface PolicyDraft {
  rules: RoutingRule[];
  calendarCode: string;
  firstResponseMinutes: number;
  resolutionHours: number;
}

/** The text for a comparison: no accents, no case, single spaces. */
export function foldText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function ruleOf(raw: unknown): RoutingRule {
  if (!isRecord(raw)) throw policyInvalid('rules');
  const allowed = new Set(['channels', 'keywords', 'queue_unit_id', 'priority']);
  if (Object.keys(raw).some((key) => !allowed.has(key))) throw policyInvalid('rules');
  const channels: string[] = [];
  if (raw.channels !== undefined) {
    if (!Array.isArray(raw.channels)) throw policyInvalid('rules');
    for (const channel of raw.channels) {
      if (typeof channel !== 'string' || !(POLICY_CHANNELS as readonly string[]).includes(channel) || channels.includes(channel)) throw policyInvalid('rules');
      channels.push(channel);
    }
  }
  const keywords: string[] = [];
  if (raw.keywords !== undefined) {
    if (!Array.isArray(raw.keywords) || raw.keywords.length > MAX_KEYWORDS) throw policyInvalid('rules');
    for (const word of raw.keywords) {
      const folded = typeof word === 'string' ? foldText(word) : '';
      if (folded === '' || folded.length > KEYWORD_MAX || keywords.includes(folded)) throw policyInvalid('rules');
      keywords.push(folded);
    }
  }
  const queueUnitId = asUuid(raw.queue_unit_id);
  if (queueUnitId === undefined) throw policyInvalid('rules');
  let priority: PolicyPriority = 'NORMAL';
  if (raw.priority !== undefined) {
    if (!(POLICY_PRIORITIES as readonly unknown[]).includes(raw.priority)) throw policyInvalid('rules');
    priority = raw.priority as PolicyPriority;
  }
  return { channels, keywords, queueUnitId, priority };
}

/**
 * What a policy may carry: up to 50 rules in the order they are tried (each names the unit whose queue it is, and may narrow by channel and by words), the calendar the deadlines are counted on, the minutes of working time for the first
 * answer (1 to 10080) and the hours for the resolution (1 to 2400). Anything else is 422 `POLICY_INVALID` naming the field.
 */
export function assertPolicy(raw: Record<string, unknown>): PolicyDraft {
  if (!Array.isArray(raw.rules) || raw.rules.length > MAX_RULES) throw policyInvalid('rules');
  const rules = raw.rules.map(ruleOf);
  const calendarCode = typeof raw.calendar_code === 'string' ? raw.calendar_code.trim() : '';
  if (calendarCode === '' || calendarCode.length > 60 || !/^[A-Za-z0-9_.-]+$/.test(calendarCode)) throw policyInvalid('calendar_code');
  const firstResponseMinutes = raw.first_response_minutes;
  if (typeof firstResponseMinutes !== 'number' || !Number.isInteger(firstResponseMinutes) || firstResponseMinutes < 1 || firstResponseMinutes > FIRST_RESPONSE_MINUTES_MAX) throw policyInvalid('first_response_minutes');
  const resolutionHours = raw.resolution_hours;
  if (typeof resolutionHours !== 'number' || !Number.isInteger(resolutionHours) || resolutionHours < 1 || resolutionHours > RESOLUTION_HOURS_MAX) throw policyInvalid('resolution_hours');
  return { rules, calendarCode, firstResponseMinutes, resolutionHours };
}

export interface Routed {
  queueUnitId: string;
  priority: PolicyPriority;
}

/** The first rule whose channel and words fit the conversation that begins, in the order of the policy; none when no rule fits (the conversation stays in the queue of the whole tenant). */
export function routeOf(rules: readonly RoutingRule[], conversation: { channel: string; text: string }): Routed | undefined {
  const text = foldText(conversation.text);
  for (const rule of rules) {
    if (rule.channels.length > 0 && !rule.channels.includes(conversation.channel)) continue;
    if (rule.keywords.length > 0 && !rule.keywords.some((word) => text.includes(word))) continue;
    return { queueUnitId: rule.queueUnitId, priority: rule.priority };
  }
  return undefined;
}

// ---- the answers an agent can reuse -----------------------------------------------------------------------------------------------

export const CANNED_CHANNELS = ['EMAIL', 'SMS', 'ZALO_OA', 'WHATSAPP'] as const;
export const CANNED_CLASSIFICATIONS = ['PUBLIC', 'INTERNAL'] as const;
export const CANNED_BODY_MAX = 2_000;
export const CANNED_TITLE_MAX = 120;

export interface CannedReplyDraft {
  code: string;
  title: string;
  bodyText: string;
  channels: string[];
  classification: (typeof CANNED_CLASSIFICATIONS)[number];
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** A place to be filled: `{{name}}`, `{name}`, `${name}` or `%name%`. A reply that has one is not a reply but a template, and templates are made in NOT, where the variables are declared (BR-OMNI-08). */
const VARIABLE = /\{\{[^}]*\}\}|\{[A-Za-z_][A-Za-z0-9_.]*\}|\$\{[^}]*\}|%[A-Za-z_][A-Za-z0-9_]*%/;

/**
 * What a canned reply may carry: a code (3 to 60 of lower case, digits, dot, dash, underscore), a title, a text of up to 2000 characters with **no variable**, the channels it is for, and a class that is PUBLIC or INTERNAL: what is
 * confidential or personal is never in a reply that agents send to people (422 on `classification`).
 */
export function assertCannedReply(raw: Record<string, unknown>): CannedReplyDraft {
  const code = typeof raw.code === 'string' ? raw.code : '';
  if (!/^[a-z0-9_.-]{3,60}$/.test(code)) throw invalid('code');
  const title = typeof raw.title === 'string' ? raw.title.normalize('NFC').trim() : '';
  if (title === '' || title.length > CANNED_TITLE_MAX) throw invalid('title');
  const bodyText = typeof raw.body_text === 'string' ? raw.body_text.normalize('NFC').trim() : '';
  if (bodyText === '' || bodyText.length > CANNED_BODY_MAX) throw invalid('body_text');
  if (VARIABLE.test(bodyText)) throw invalid('body_text');
  const channels: string[] = [];
  if (!Array.isArray(raw.channels) || raw.channels.length === 0) throw invalid('channels');
  for (const channel of raw.channels) {
    if (typeof channel !== 'string' || !(CANNED_CHANNELS as readonly string[]).includes(channel) || channels.includes(channel)) throw invalid('channels');
    channels.push(channel);
  }
  if (!(CANNED_CLASSIFICATIONS as readonly unknown[]).includes(raw.classification)) throw invalid('classification');
  return { code, title, bodyText, channels, classification: raw.classification as CannedReplyDraft['classification'] };
}

/** The reason of a publication: 10 to 2000 characters. */
export function assertPublishReason(raw: { reason?: unknown }): string {
  if (typeof raw.reason !== 'string') throw invalid('reason');
  const reason = raw.reason.trim();
  if (reason.length < 10 || reason.length > 2_000) throw invalid('reason');
  return reason;
}
