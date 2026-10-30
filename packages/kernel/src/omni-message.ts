import { DomainError } from './errors.ts';
import { asUuid } from './tenant-context.ts';

/**
 * What an agent says in a conversation (ST-OMNI-005, OMNI.md 3.3): a message to the person on the channel the person used, or a note for the colleagues that never leaves the system. The checks of an outgoing message run in a fixed
 * order, all before any adapter is called, and stop at the first that fails. The rules below are pure.
 */
export const MESSAGE_KINDS = ['EXTERNAL', 'INTERNAL_NOTE'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export const MESSAGE_PURPOSES = ['SUPPORT_CONVERSATION', 'OPERATIONAL', 'REMINDER'] as const;
export type MessagePurpose = (typeof MESSAGE_PURPOSES)[number];

export const MESSAGE_TEXT_MAX = 4000;
export const MAX_ATTACHMENTS = 5;
export const MAX_LINKS = 5;
export const REASON_MIN = 10;
export const REASON_MAX = 2000;
/** What can be attached or linked: a version of a document of the tenant (the only resource a message can carry today). */
export const LINKABLE_TYPES = ['document_version'] as const;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export interface MessageDraft {
  kind: MessageKind;
  channelAccountId: string;
  purpose: MessagePurpose;
  text: string | undefined;
  templateVersionId: string | undefined;
  templateVariables: Record<string, string>;
  attachmentIds: string[];
  links: Array<{ resourceType: string; resourceId: string }>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * What a send may carry. A note has a text and nothing else (no purpose, no template, no attachment: it goes nowhere); a message to the person has a text or an approved template, a purpose (support by default), at most five
 * attachments and five links.
 */
export function assertMessageSend(raw: Record<string, unknown>): MessageDraft {
  const kind = (MESSAGE_KINDS as readonly unknown[]).includes(raw.kind) ? (raw.kind as MessageKind) : undefined;
  if (kind === undefined) throw invalid('kind');
  const channelAccountId = asUuid(raw.channel_account_id);
  if (channelAccountId === undefined) throw invalid('channel_account_id');
  let text: string | undefined;
  if (raw.text !== undefined) {
    if (typeof raw.text !== 'string') throw invalid('text');
    text = raw.text.normalize('NFC').trim();
    if (text === '' || text.length > MESSAGE_TEXT_MAX) throw invalid('text');
  }
  let purpose: MessagePurpose = 'SUPPORT_CONVERSATION';
  if (raw.purpose !== undefined) {
    if (!(MESSAGE_PURPOSES as readonly unknown[]).includes(raw.purpose)) throw invalid('purpose');
    purpose = raw.purpose as MessagePurpose;
  }
  let templateVersionId: string | undefined;
  if (raw.template_version_id !== undefined) {
    templateVersionId = asUuid(raw.template_version_id);
    if (templateVersionId === undefined) throw invalid('template_version_id');
  }
  const templateVariables: Record<string, string> = {};
  if (raw.template_variables !== undefined) {
    if (!isRecord(raw.template_variables)) throw invalid('template_variables');
    for (const [name, value] of Object.entries(raw.template_variables)) {
      if (typeof value !== 'string' || value.length > 500) throw invalid('template_variables');
      templateVariables[name] = value;
    }
  }
  const attachmentIds: string[] = [];
  if (raw.attachment_ids !== undefined) {
    if (!Array.isArray(raw.attachment_ids) || raw.attachment_ids.length > MAX_ATTACHMENTS) throw invalid('attachment_ids');
    for (const item of raw.attachment_ids) {
      const attachment = asUuid(item);
      if (attachment === undefined || attachmentIds.includes(attachment)) throw invalid('attachment_ids');
      attachmentIds.push(attachment);
    }
  }
  const links: MessageDraft['links'] = [];
  if (raw.resource_links !== undefined) {
    if (!Array.isArray(raw.resource_links) || raw.resource_links.length > MAX_LINKS) throw invalid('resource_links');
    for (const item of raw.resource_links) {
      const type = isRecord(item) ? item.resource_type : undefined;
      const id = isRecord(item) ? asUuid(item.resource_id) : undefined;
      if (!(LINKABLE_TYPES as readonly unknown[]).includes(type) || id === undefined || links.some((link) => link.resourceId === id)) throw invalid('resource_links');
      links.push({ resourceType: type as string, resourceId: id });
    }
  }
  if (kind === 'INTERNAL_NOTE') {
    // A note is a text for the colleagues: whatever would make it leave the system is refused, not ignored.
    if (text === undefined) throw invalid('text');
    if (raw.purpose !== undefined) throw invalid('purpose');
    if (templateVersionId !== undefined) throw invalid('template_version_id');
    if (attachmentIds.length > 0) throw invalid('attachment_ids');
    if (links.length > 0) throw invalid('resource_links');
    return { kind, channelAccountId, purpose, text, templateVersionId, templateVariables: {}, attachmentIds, links };
  }
  if (text === undefined && templateVersionId === undefined) throw invalid('text');
  if (text !== undefined && templateVersionId !== undefined) throw invalid('template_version_id');
  if (templateVersionId === undefined && Object.keys(templateVariables).length > 0) throw invalid('template_variables');
  return { kind, channelAccountId, purpose, text, templateVersionId, templateVariables, attachmentIds, links };
}

/** The reason of a resolve or a reopening: 10 to 2000 characters. */
export function assertConversationReason(raw: { reason?: unknown }): string {
  if (typeof raw.reason !== 'string') throw invalid('reason');
  const reason = raw.reason.trim();
  if (reason.length < REASON_MIN || reason.length > REASON_MAX) throw invalid('reason');
  return reason;
}

/** The classes of a document that may leave the system in a message: what is public or the tenant's own; the rest (confidential, personal, core) stays inside, behind the login. */
export const SENDABLE_CLASSIFICATIONS: ReadonlySet<string> = new Set(['PUBLIC', 'INTERNAL']);

/** Whether a document may be attached to a message: its class may leave, and the scan found it clean. */
export function attachable(document: { classification: string; scanStatus: string }): boolean {
  return SENDABLE_CLASSIFICATIONS.has(document.classification) && document.scanStatus.toUpperCase() === 'CLEAN';
}

/** The only link a message carries to a file or a record: opaque, naming nothing about it, and opening it asks the person to sign in (BR-NOT-11). */
export const opaqueResourceLink = (resourceId: string): string => `/d/${resourceId}`;

/** The text that goes out: the words of the agent and, after them, one opaque link for each file and record named. */
export function textWithLinks(text: string, resourceIds: readonly string[]): string {
  return resourceIds.length === 0 ? text : `${text}\n${resourceIds.map(opaqueResourceLink).join('\n')}`;
}

const OPAQUE_DOCUMENT_LINK = /^\/d\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/gim;

/**
 * The text as the person receives it: each opaque link (a path of the application) is made a whole address with the public origin of the web application, since an SMS, a mail or a chat has no application around it. A text that has no
 * link goes as it is; one that has links when no origin is known cannot be sent (undefined): a path that opens nothing would be sent as if it were a link.
 */
export function withAbsoluteLinks(text: string, origin: string | undefined): string | undefined {
  if (!new RegExp(OPAQUE_DOCUMENT_LINK.source, 'im').test(text)) return text;
  if (origin === undefined) return undefined;
  const base = origin.replace(/\/+$/, '');
  return text.replace(OPAQUE_DOCUMENT_LINK, (path) => `${base}${path}`);
}

export type ConsentWord = 'Granted' | 'Withdrawn' | 'Expired' | undefined;

export interface SendFacts {
  /** The account the agent named, and the account of the conversation. */
  requestedAccountId: string;
  conversationAccountId: string;
  accountStatus: string;
  accountVerified: boolean;
  /** The channel of the account (`WHATSAPP`, `ZALO_OA`, `EMAIL`, `SMS`). */
  channel: string;
  purpose: MessagePurpose;
  /** The latest word about the consent of the contact for the channel and the purpose; none at all is no consent. */
  consent: ConsentWord;
  /** The window in which the provider lets the tenant answer freely; none for a channel without one. */
  windowExpiresAt: Date | undefined;
  now: Date;
  /** The message is made from a template that is Active and approved by the provider for this channel. */
  approvedTemplate: boolean;
}

/**
 * The checks of a message to the person, in the order of OMNI.md 3.3, stopping at the first that fails:
 *   2. the account is the conversation's (422 CHANNEL_ACCOUNT_MISMATCH);
 *   3. the account is Active and verified (422 CHANNEL_UNVERIFIED);
 *   4. the contact consents: a word that withdrew the consent stops the message (422 CONSENT_DENIED); with no word, an answer for support in the window that the person opened by writing is grounded without one; anything
 *      else needs a Granted consent (422 CONSENT_DENIED; on WhatsApp, which asks for an opt-in before the first message the tenant starts, 422 OPT_IN_REQUIRED);
 *   5. the window: a free text outside it is refused, a template that the provider approved is not (422 CHANNEL_WINDOW_CLOSED).
 */
export function judgeSend(facts: SendFacts): void {
  if (facts.requestedAccountId !== facts.conversationAccountId) throw new DomainError('CHANNEL_ACCOUNT_MISMATCH', 422, 'channel_account_id');
  if (facts.accountStatus !== 'Active' || !facts.accountVerified) throw new DomainError('CHANNEL_UNVERIFIED', 422, 'channel_account_id');
  const inWindow = facts.windowExpiresAt === undefined || facts.now.getTime() < facts.windowExpiresAt.getTime();
  if (facts.consent === 'Withdrawn' || facts.consent === 'Expired') throw new DomainError('CONSENT_DENIED', 422, 'purpose');
  if (facts.consent !== 'Granted' && !(facts.purpose === 'SUPPORT_CONVERSATION' && inWindow)) {
    throw new DomainError(facts.channel === 'WHATSAPP' ? 'OPT_IN_REQUIRED' : 'CONSENT_DENIED', 422, 'purpose');
  }
  if (!inWindow && !facts.approvedTemplate) throw new DomainError('CHANNEL_WINDOW_CLOSED', 422, 'text');
}

/** The statuses of a message that went out, in the order they are reached: a status never goes back (a late receipt cannot undo a later one), and a failure is final. */
export const DELIVERY_RANK: Readonly<Record<string, number>> = { Queued: 0, ProviderAccepted: 1, Delivered: 2, Read: 3 };

/** The status a receipt of the provider brings, in the words of the message. */
export const DELIVERY_STATUS_OF: Readonly<Record<string, string>> = { ACCEPTED: 'ProviderAccepted', DELIVERED: 'Delivered', READ: 'Read', FAILED: 'Failed' };

/** Whether a message in `from` may take the status `to`: forward only, a failure only before delivery, nothing after a failure. */
export function mayMoveDelivery(from: string, to: string): boolean {
  if (from === 'Failed' || from === to) return false;
  if (to === 'Failed') return from === 'Queued' || from === 'ProviderAccepted';
  return (DELIVERY_RANK[to] ?? -1) > (DELIVERY_RANK[from] ?? 99);
}

/** How often a message is sent again after a failure the provider says is worth another try, and how long it waits before each. */
export const SEND_ATTEMPTS_MAX = 3;
export const retryDelayMs = (attempt: number): number => 30_000 * 2 ** Math.max(0, attempt - 1);
