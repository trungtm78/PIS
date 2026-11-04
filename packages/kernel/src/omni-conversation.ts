import { activeGrants } from './effective-access.ts';
import type { EffectiveAccess } from './effective-access.ts';
import { DomainError } from './errors.ts';
import { permissionMatches } from './permission.ts';
import { scopeContains } from './scope.ts';
import { asUuid } from './tenant-context.ts';
import type { IdentityChannel } from './omni-contact.ts';

/**
 * The conversations of the omnichannel center (ST-OMNI-004, OMNI.md 3.1, 3.2, BR-OMNI-03): a message that comes in opens a conversation with a contact, or goes into the one that is open on the same thread; a supervisor assigns it to an agent who may
 * answer it; the window in which the provider lets the tenant answer, and the word that withdraws a consent, are read from what comes in. The rules below are pure.
 *
 *   New -assign-> Assigned -open-> InProgress <-> PendingCustomer ; InProgress|PendingCustomer -resolve-> Resolved -(a message)-> InProgress ; Resolved -close-> Closed (final: a message on its thread opens a new conversation linked to it)
 */
export const CONVERSATION_STATUSES = ['New', 'Assigned', 'InProgress', 'PendingCustomer', 'Resolved', 'Closed'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];
export type ConversationAction = 'assign' | 'open' | 'pend' | 'reply' | 'resolve' | 'reopen' | 'close' | 'inbound';

const TRANSITIONS: Readonly<Record<ConversationAction, Readonly<Partial<Record<ConversationStatus, ConversationStatus>>>>> = {
  // A reassignment keeps the state it is in; a new conversation becomes Assigned.
  assign: { New: 'Assigned', Assigned: 'Assigned', InProgress: 'InProgress', PendingCustomer: 'PendingCustomer' },
  open: { Assigned: 'InProgress', PendingCustomer: 'InProgress' },
  pend: { InProgress: 'PendingCustomer' },
  // An answer to the person takes a conversation that was given to an agent, or waited for the customer, up; one that is under way stays so (OMNI.md 4).
  reply: { Assigned: 'InProgress', InProgress: 'InProgress', PendingCustomer: 'InProgress' },
  // A conversation that nobody has taken up is not resolved (OMNI.md 4: resolve on New is 409).
  resolve: { InProgress: 'Resolved', PendingCustomer: 'Resolved' },
  reopen: { Resolved: 'InProgress' },
  close: { Resolved: 'Closed' },
  // What a message that comes in does: a customer who answers moves a conversation that waited for them; one that was resolved is reopened (OMNI.md 3.1). A closed conversation takes no message: it is final (OMNI.md 4), the message opens a new one.
  inbound: { New: 'New', Assigned: 'Assigned', InProgress: 'InProgress', PendingCustomer: 'InProgress', Resolved: 'InProgress' },
};

/** The state a conversation is in after an action, or a 409 `CONVERSATION_STATE_INVALID` when the action does not apply to the state it is in. */
export function conversationAfter(status: ConversationStatus, action: ConversationAction): ConversationStatus {
  const next = TRANSITIONS[action][status];
  if (next === undefined) throw new DomainError('CONVERSATION_STATE_INVALID', 409, 'status');
  return next;
}

/** The channels whose provider lets a tenant answer only within a window after the last message of the person (WhatsApp, Zalo OA: 24 hours [CXN-ZNS-01]). Others have none. */
const WINDOW_CHANNELS: ReadonlySet<string> = new Set(['ZALO_OA', 'WHATSAPP']);
export const WINDOW_MS = 24 * 3_600_000;

/** The instant until which the tenant may answer freely on the channel, or undefined when the channel has no window. */
export function windowExpiresAt(accountChannel: string, lastInboundAt: Date): Date | undefined {
  return WINDOW_CHANNELS.has(accountChannel) ? new Date(lastInboundAt.getTime() + WINDOW_MS) : undefined;
}

/** The identity a message on a channel account comes from: the phone number of a text message, the address of a mail, the id of Zalo or WhatsApp. A channel that carries no inbound message has none. */
export function identityChannelOfAccount(accountChannel: string): IdentityChannel | undefined {
  switch (accountChannel) {
    case 'EMAIL':
      return 'EMAIL';
    case 'SMS':
      return 'PHONE';
    case 'ZALO_OA':
    case 'ZALO_ZNS':
      return 'ZALO';
    case 'WHATSAPP':
      return 'WHATSAPP';
    default:
      return undefined;
  }
}

/** The channels whose provider authenticates the sender of a message: an identity that writes to them is verified by the provider (the signature of the webhook stands for it). A mail and a text message prove nothing of the sender. */
export const SENDER_AUTHENTICATED_CHANNELS: ReadonlySet<string> = new Set(['ZALO_OA', 'WHATSAPP']);

/** The consent channel a message on a channel account speaks for (the one a STOP on it withdraws). */
export function consentChannelOfAccount(accountChannel: string): 'EMAIL' | 'SMS' | 'ZALO' | 'WHATSAPP' | undefined {
  switch (accountChannel) {
    case 'EMAIL':
      return 'EMAIL';
    case 'SMS':
      return 'SMS';
    case 'ZALO_OA':
    case 'ZALO_ZNS':
      return 'ZALO';
    case 'WHATSAPP':
      return 'WHATSAPP';
    default:
      return undefined;
  }
}

const STOP_WORDS: ReadonlySet<string> = new Set(['STOP', 'HUY', 'DUNG']);

/** Whether a message is the word that withdraws a consent (BR-OMNI-03): the whole message, whatever the case, the accents and the punctuation, is STOP, HUY or DUNG. A sentence that has the word in it is not one. */
export function isStopKeyword(text: string): boolean {
  const word = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // the combining marks (U+0300 to U+036F) that NFD splits off the letters
    .replace(/\u0111/gi, 'd') // the letter d with a stroke, either case
    .replace(/[^A-Za-z]/g, '')
    .toUpperCase();
  return text.trim().length <= 20 && STOP_WORDS.has(word);
}

export interface Assignment {
  assigneeId: string;
  reason: string | undefined;
}

/** What an assignment may carry: the member it goes to, and a reason of up to 500 characters if said. */
export function assertAssignment(raw: { assignee_membership_id?: unknown; reason?: unknown }): Assignment {
  const assigneeId = asUuid(raw.assignee_membership_id);
  if (assigneeId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'assignee_membership_id');
  let reason: string | undefined;
  if (raw.reason !== undefined) {
    reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
    if (reason === '' || reason.length > 500) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
  }
  return { assigneeId, reason };
}

/** The permission of whoever answers a conversation: the one a person needs to be given it. */
export const ANSWER_PERMISSION = 'omni.conversation.reply';

/**
 * Whether a member may be given a conversation (OMNI.md 3.2): the membership is active and holds the permission to answer with a grant whose scope contains the unit whose queue the conversation is in. A conversation in the queue of the whole
 * tenant (no unit) goes to anyone who holds the permission anywhere.
 */
export function assigneeEligible(access: EffectiveAccess, queueUnit: { id: string; path: string } | undefined, now: Date): boolean {
  return activeGrants(access, now).some(
    (grant) => grant.permissions.some((held) => permissionMatches(held, ANSWER_PERMISSION)) && (queueUnit === undefined || scopeContains(grant.scope, { ownerUnitId: queueUnit.id, ownerUnitPath: queueUnit.path })),
  );
}
