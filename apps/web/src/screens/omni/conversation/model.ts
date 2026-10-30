import { ApiError } from '@machvon/api-client';

/** Permissions of the screen (x-permission in openapi.json). */
export const READ_PERMISSION = 'conversation.read';
export const ASSIGN_PERMISSION = 'omni.conversation.assign';

export const REASON_MAX = 500;

/** Where the conversation of the inbox is opened (OMNI-02): the id is in the address, as the other detail screens do. */
export const conversationLink = (id: string): string => `/omni/omni-02?id=${id}`;
/** Where a conversation is turned into an issue (OMNI-09). */
export const conversionLink = (id: string): string => `/omni/omni-09?id=${id}`;

export const STATUSES = ['New', 'Assigned', 'InProgress', 'PendingCustomer', 'Resolved', 'Closed'] as const;
export type ConversationStatus = (typeof STATUSES)[number];

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const optional = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

export interface Conversation {
  id: string;
  channelAccountId: string;
  channel: string;
  accountName: string;
  contactName: string;
  status: ConversationStatus;
  assigneeName: string | undefined;
  assigneeId: string | undefined;
  queueUnitName: string | undefined;
  lastInboundAt: string | undefined;
  windowExpiresAt: string | undefined;
  firstResponseDueAt: string | undefined;
  messageCount: number;
  version: number;
}

export interface ConversationPage {
  items: Conversation[];
  nextCursor: string | undefined;
}

export function toConversation(raw: unknown): Conversation | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string') return undefined;
  const status = STATUSES.find((candidate) => candidate === raw.status);
  if (status === undefined) return undefined;
  return {
    id: raw.id,
    channelAccountId: text(raw.channel_account_id),
    channel: text(raw.channel),
    accountName: text(raw.account_name),
    contactName: text(raw.contact_name),
    status,
    assigneeName: optional(raw.assignee_name),
    assigneeId: optional(raw.assignee_membership_id),
    queueUnitName: optional(raw.queue_unit_name),
    lastInboundAt: optional(raw.last_inbound_at),
    windowExpiresAt: optional(raw.window_expires_at),
    firstResponseDueAt: optional(raw.sla_first_response_due_at),
    messageCount: typeof raw.message_count === 'number' ? raw.message_count : 0,
    version: typeof raw.version === 'number' ? raw.version : 0,
  };
}

export function toConversationPage(raw: unknown): ConversationPage {
  const view: Raw = isRecord(raw) ? raw : {};
  return { items: Array.isArray(view.items) ? view.items.flatMap((item) => toConversation(item) ?? []) : [], nextCursor: optional(view.next_cursor) };
}

export interface Assignee {
  membershipId: string;
  displayName: string;
}

export function toAssignees(raw: unknown): Assignee[] {
  const view: Raw = isRecord(raw) ? raw : {};
  if (!Array.isArray(view.items)) return [];
  return view.items.flatMap((item) => (isRecord(item) && typeof item.membership_id === 'string' ? [{ membershipId: item.membership_id, displayName: text(item.display_name) }] : []));
}

/** A conversation can be given to someone while it is open: not once it is resolved (it comes back with a message) or closed. */
export const mayAssign = (conversation: Pick<Conversation, 'status'>): boolean => conversation.status !== 'Resolved' && conversation.status !== 'Closed';

/** Whether the window in which the provider lets the tenant answer is over at the moment given. */
export const windowClosed = (conversation: Pick<Conversation, 'windowExpiresAt'>, now: Date): boolean => conversation.windowExpiresAt !== undefined && Date.parse(conversation.windowExpiresAt) <= now.getTime();

export interface Filters {
  status: ConversationStatus | '';
  mine: boolean;
}

export const NO_FILTER: Filters = { status: '', mine: false };

/** The query of the list for the filters chosen: nothing is sent for a filter that is off. */
export function queryOf(filters: Filters, cursor: string | undefined): Record<string, string | boolean> {
  return {
    ...(filters.status === '' ? {} : { status: filters.status }),
    ...(filters.mine ? { mine: true } : {}),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

export const reasonProblem = (reason: string): boolean => reason.trim().length > REASON_MAX;

// ---- what the server refused with ----------------------------------------------------------------------------------------------------

export type ProblemReason = 'invalid' | 'notEligible' | 'state' | 'conflict' | 'denied' | 'notFound' | 'session' | 'general';
export interface ProblemView {
  reason: ProblemReason;
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  ASSIGNEE_NOT_ELIGIBLE: 'notEligible',
  CONVERSATION_STATE_INVALID: 'state',
  VERSION_CONFLICT: 'conflict',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  RESOURCE_NOT_FOUND: 'notFound',
  SESSION_EXPIRED: 'session',
};

export function describeProblem(error: unknown): ProblemView {
  return { reason: error instanceof ApiError ? (REASON_BY_CODE[error.code] ?? 'general') : 'general' };
}
