import type { DistributionChannel, DraftRecipient } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import { normaliseRecipients } from './outgoing-rules';

/** The most distributions one document can have: the contract allows 500 recipients in one request, and a document keeps the same bound over all its requests. */
export const MAX_DISTRIBUTIONS = 500;

/**
 * The channels of the first release (the design: internal, email, paper handover). The LGSP channel waits for ST-DOC-021 and is refused by name, not
 * silently: a recipient that cannot be reached must not look as if it was.
 */
export const DISPATCH_CHANNELS = ['INTERNAL', 'EMAIL', 'PAPER_HANDOVER'] as const satisfies readonly DistributionChannel[];
export type DispatchChannel = (typeof DISPATCH_CHANNELS)[number];

const ITEM_MEMBERS: readonly string[] = ['kind', 'name', 'code', 'unit_id', 'channel', 'acknowledgement_required'];
const RECIPIENT_MEMBERS: readonly string[] = ['kind', 'name', 'code', 'unit_id'];

/** One recipient to send to: a recipient named on the document, the channel to use, and whether a receipt is required. */
export interface DispatchItem {
  recipient: DraftRecipient;
  channel: DispatchChannel;
  acknowledgementRequired: boolean;
}

const plain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const fold = (text: string): string => text.normalize('NFC').trim().toLowerCase();

function invalid(index: number, member: string, reason?: string): DomainError {
  return new DomainError('RECIPIENT_INVALID', 422, `recipients[${index}].${member}`, reason === undefined ? undefined : { extensions: { reason } });
}

/** The channel a recipient gets when the issuer asks to distribute at once and names none: the unit's own inbox, otherwise the paper handover. */
export function defaultChannelOf(recipient: DraftRecipient): DispatchChannel {
  return recipient.kind === 'INTERNAL_UNIT' && recipient.unit_id !== undefined ? 'INTERNAL' : 'PAPER_HANDOVER';
}

/** Every recipient printed on the document, each on its default channel with a receipt required. */
export function itemsForAllRecipients(recipients: readonly DraftRecipient[]): DispatchItem[] {
  return recipients.map((recipient) => ({ recipient, channel: defaultChannelOf(recipient), acknowledgementRequired: true }));
}

/** The recipient of the document that a request names: the same kind and name, taking the code and unit from the document when the request gives none. */
function resolveOnDocument(index: number, given: DraftRecipient, onDocument: readonly DraftRecipient[]): DraftRecipient {
  const found = onDocument.find((candidate) => candidate.kind === given.kind && fold(candidate.name) === fold(given.name));
  if (found === undefined) throw invalid(index, 'name', 'NOT_ON_DOCUMENT');
  if (given.unit_id !== undefined && given.unit_id !== found.unit_id) throw invalid(index, 'unit_id', 'NOT_ON_DOCUMENT');
  if (given.code !== undefined && given.code !== found.code) throw invalid(index, 'code', 'NOT_ON_DOCUMENT');
  return found;
}

/**
 * The recipients of a dispatch request as they are stored (DOC.md F8): each is a recipient the document names ("Noi nhan" is the legal list of who
 * receives it, so a document is not sent to anyone else), on a channel of the first release, with the duty to acknowledge decided. The same recipient
 * on the same channel twice is one. Anything else is 422 RECIPIENT_INVALID with the member and the reason.
 */
export function normaliseDispatch(raw: readonly object[], onDocument: readonly DraftRecipient[]): DispatchItem[] {
  if (raw.length === 0) throw new DomainError('RECIPIENT_INVALID', 422, 'recipients', { extensions: { reason: 'EMPTY' } });
  const items: DispatchItem[] = [];
  const seen = new Set<string>();
  for (const [index, item] of raw.entries()) {
    if (!plain(item)) throw invalid(index, 'name');
    for (const key of Object.keys(item)) if (!ITEM_MEMBERS.includes(key)) throw invalid(index, key);
    const channel = item.channel;
    if (channel === 'LGSP') throw invalid(index, 'channel', 'CHANNEL_NOT_SUPPORTED');
    if (typeof channel !== 'string' || !(DISPATCH_CHANNELS as readonly string[]).includes(channel)) throw invalid(index, 'channel');
    const required = item.acknowledgement_required;
    if (required !== undefined && typeof required !== 'boolean') throw invalid(index, 'acknowledgement_required');
    let named: DraftRecipient | undefined;
    try {
      [named] = normaliseRecipients([Object.fromEntries(Object.entries(item).filter(([key]) => RECIPIENT_MEMBERS.includes(key)))]);
    } catch (error) {
      // The shared normaliser reports a member as recipients[0].<member>: the same member under the index of this request.
      const member = error instanceof DomainError ? (error.detail?.split('.')[1] ?? 'name') : 'name';
      throw invalid(index, member);
    }
    if (named === undefined) throw invalid(index, 'name');
    const recipient = resolveOnDocument(index, named, onDocument);
    if (channel === 'INTERNAL' && (recipient.kind !== 'INTERNAL_UNIT' || recipient.unit_id === undefined)) throw invalid(index, 'channel', 'INTERNAL_CHANNEL_NEEDS_UNIT');
    const key = `${fold(recipient.name)}|${channel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ recipient, channel: channel as DispatchChannel, acknowledgementRequired: required ?? true });
  }
  return items;
}
