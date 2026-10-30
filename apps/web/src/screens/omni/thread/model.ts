import { ApiError } from '@machvon/api-client';
import { toConversation } from '../conversation/model';
import type { Conversation } from '../conversation/model';

/** Permissions of the screen (x-permission in openapi.json). */
export const READ_PERMISSION = 'conversation.read';
export const MESSAGE_READ_PERMISSION = 'channel_message.read';
export const REPLY_PERMISSION = 'omni.conversation.reply';

export const TEXT_MAX = 4000;
export const REASON_MIN = 10;
export const REASON_MAX = 2000;
export const PURPOSES = ['SUPPORT_CONVERSATION', 'OPERATIONAL', 'REMINDER'] as const;
export type Purpose = (typeof PURPOSES)[number];

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const optional = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

export type Direction = 'INBOUND' | 'OUTBOUND' | 'INTERNAL_NOTE';
export type DeliveryStatus = 'Queued' | 'ProviderAccepted' | 'Delivered' | 'Read' | 'Failed';
const DIRECTIONS: readonly Direction[] = ['INBOUND', 'OUTBOUND', 'INTERNAL_NOTE'];
const DELIVERY: readonly DeliveryStatus[] = ['Queued', 'ProviderAccepted', 'Delivered', 'Read', 'Failed'];

export interface ThreadMessage {
  id: string;
  direction: Direction;
  deliveryStatus: DeliveryStatus | undefined;
  authorId: string | undefined;
  createdAt: string;
}

export function toMessage(raw: unknown): ThreadMessage | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string') return undefined;
  const direction = DIRECTIONS.find((candidate) => candidate === raw.direction);
  if (direction === undefined) return undefined;
  return { id: raw.id, direction, deliveryStatus: DELIVERY.find((candidate) => candidate === raw.delivery_status), authorId: optional(raw.author_membership_id), createdAt: text(raw.created_at) };
}

export const toMessages = (rows: readonly unknown[]): ThreadMessage[] => rows.flatMap((row) => toMessage(row) ?? []);

/** The text of one message, as the read of that message gives it. */
export const toMessageText = (raw: unknown): string => (isRecord(raw) ? text(raw.text) : '');

export { toConversation };
export type { Conversation };

/** An answer to the person goes while the conversation is with an agent or waits for the customer; a note can be written until it is closed. */
export const mayReply = (conversation: Pick<Conversation, 'status'>): boolean => conversation.status === 'Assigned' || conversation.status === 'InProgress' || conversation.status === 'PendingCustomer';
export const mayNote = (conversation: Pick<Conversation, 'status'>): boolean => conversation.status !== 'Closed';
export const mayResolve = (conversation: Pick<Conversation, 'status'>): boolean => conversation.status === 'InProgress' || conversation.status === 'PendingCustomer';
export const mayReopen = (conversation: Pick<Conversation, 'status'>): boolean => conversation.status === 'Resolved';

export interface Countdown {
  closed: boolean;
  hours: number;
  minutes: number;
}

/** What is left of the window in which the provider lets the tenant answer freely, in whole hours and minutes; none for a channel without a window. */
export function countdownOf(conversation: Pick<Conversation, 'windowExpiresAt'>, now: Date): Countdown | undefined {
  if (conversation.windowExpiresAt === undefined) return undefined;
  const left = Date.parse(conversation.windowExpiresAt) - now.getTime();
  if (Number.isNaN(left) || left <= 0) return { closed: true, hours: 0, minutes: 0 };
  const minutes = Math.floor(left / 60_000);
  return { closed: false, hours: Math.floor(minutes / 60), minutes: minutes % 60 };
}

// ---- the composer -----------------------------------------------------------------------------------------------------------------------

export interface Draft {
  note: boolean;
  purpose: Purpose;
  text: string;
}

export const emptyDraft = (): Draft => ({ note: false, purpose: 'SUPPORT_CONVERSATION', text: '' });
export const textProblem = (draft: Pick<Draft, 'text'>): boolean => draft.text.trim() === '' || draft.text.trim().length > TEXT_MAX;
export const reasonProblem = (reason: string): boolean => reason.trim().length < REASON_MIN || reason.trim().length > REASON_MAX;

/** The body of a send: a note carries no purpose; a message to the person names the account of the conversation, the one the server checks it against. */
export function sendBody(draft: Draft, channelAccountId: string): Record<string, unknown> {
  return draft.note
    ? { kind: 'INTERNAL_NOTE', channel_account_id: channelAccountId, text: draft.text.trim() }
    : { kind: 'EXTERNAL', channel_account_id: channelAccountId, purpose: draft.purpose, text: draft.text.trim() };
}

// ---- what the server refused with ----------------------------------------------------------------------------------------------------

export type ProblemReason =
  | 'invalid'
  | 'consent'
  | 'optIn'
  | 'window'
  | 'account'
  | 'unverified'
  | 'content'
  | 'template'
  | 'state'
  | 'contact'
  | 'conflict'
  | 'denied'
  | 'notFound'
  | 'session'
  | 'general';
export interface ProblemView {
  reason: ProblemReason;
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  CONSENT_DENIED: 'consent',
  OPT_IN_REQUIRED: 'optIn',
  CHANNEL_WINDOW_CLOSED: 'window',
  CHANNEL_ACCOUNT_MISMATCH: 'account',
  CHANNEL_UNVERIFIED: 'unverified',
  CONTENT_CLASSIFICATION_BLOCKED: 'content',
  TEMPLATE_INVALID: 'template',
  CONVERSATION_STATE_INVALID: 'state',
  CONTACT_STATE_INVALID: 'contact',
  VERSION_CONFLICT: 'conflict',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  RESOURCE_NOT_FOUND: 'notFound',
  SESSION_EXPIRED: 'session',
};

/** The answers that say the person may not see this any more (signed out, refused, gone): what was loaded is no longer theirs to show. A break in the network or a failure of the server says nothing of that. */
export const revokesAccess = (error: unknown): boolean => error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404);

/** The error the screen shows for a query: one that has nothing loaded shows any error; one that has something shows only a refusal, and keeps what it has through a break in the network or a failure of the server. */
export const shownError = (error: unknown, loaded: boolean): unknown => (error === null || error === undefined ? undefined : !loaded || revokesAccess(error) ? error : undefined);

export function describeProblem(error: unknown): ProblemView {
  return { reason: error instanceof ApiError ? (REASON_BY_CODE[error.code] ?? 'general') : 'general' };
}
