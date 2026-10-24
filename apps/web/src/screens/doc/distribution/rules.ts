import type { Channel, DispatchChannel, DistributionRow, DocumentRecipient } from './types';
import { DISPATCH_CHANNELS } from './types';

/** The shortest written reason the server takes for issuing a document of a template that is not confirmed (BR-DOC-10). */
export const MIN_OVERRIDE_CHARS = 20;
export const MAX_OVERRIDE_CHARS = 1000;
export const MAX_REFERENCE_CHARS = 120;

export type OverrideProblem = 'required' | 'tooShort' | 'tooLong';

/** What is wrong with the reason typed for an unconfirmed template; nothing is wrong when the template needs no reason. */
export function overrideProblem(rendersWatermarked: boolean, reason: string): OverrideProblem | undefined {
  if (!rendersWatermarked) return undefined;
  const length = reason.trim().length;
  if (length === 0) return 'required';
  if (length < MIN_OVERRIDE_CHARS) return 'tooShort';
  return length > MAX_OVERRIDE_CHARS ? 'tooLong' : undefined;
}

/** The channels a recipient can be sent to: the inbox of a unit only for a unit of this system. */
export function channelsFor(recipient: DocumentRecipient): DispatchChannel[] {
  return DISPATCH_CHANNELS.filter((channel) => channel !== 'INTERNAL' || (recipient.kind === 'INTERNAL_UNIT' && recipient.unitId !== null));
}

/** The inbox of a unit of this system, otherwise the paper handover: the one channel that needs no transport that may not be connected. */
export function defaultChannelOf(recipient: DocumentRecipient): DispatchChannel {
  return channelsFor(recipient).includes('INTERNAL') ? 'INTERNAL' : 'PAPER_HANDOVER';
}

const sameName = (left: string, right: string): boolean => left.normalize('NFC').trim().toLowerCase() === right.normalize('NFC').trim().toLowerCase();

/** The row a recipient already has on a channel: sending again writes nothing, so the screen shows what happened instead of offering it. */
export function rowOf(distributions: readonly DistributionRow[], recipient: DocumentRecipient, channel: Channel): DistributionRow | undefined {
  return distributions.find((row) => row.channel === channel && sameName(row.recipientName, recipient.name));
}

/** A recipient that has a row on some channel is already being served; the screen keeps it out of a new dispatch unless another channel is chosen. */
export const canAcknowledge = (row: DistributionRow): boolean => row.status === 'SENT' || row.status === 'DELIVERED';
export const canRetry = (row: DistributionRow): boolean => row.status === 'FAILED';

export interface Progress {
  total: number;
  reached: number;
  acknowledged: number;
  failed: number;
}

export function progressOf(distributions: readonly DistributionRow[]): Progress {
  return {
    total: distributions.length,
    reached: distributions.filter((row) => row.status === 'DELIVERED' || row.status === 'ACKNOWLEDGED').length,
    acknowledged: distributions.filter((row) => row.status === 'ACKNOWLEDGED').length,
    failed: distributions.filter((row) => row.status === 'FAILED').length,
  };
}

/** The time a receipt is typed as at first: now, and never before the row was sent or delivered. */
export function defaultReceiptTime(row: DistributionRow, now: Date): Date {
  const latest = [row.sentAt, row.deliveredAt].flatMap((value) => (value === null ? [] : [new Date(value)])).reduce<Date>((a, b) => (a > b ? a : b), now);
  return latest;
}

/** A local date-time input value ("2026-10-23T10:30") as the instant the server takes, or undefined when it is not a time. */
export function instantOf(local: string): string | undefined {
  if (local === '') return undefined;
  const parsed = new Date(local);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/** The value of a local date-time input for an instant, rounded UP to the second (in the time zone of the browser): a receipt must not fall before the sending it answers. */
export function localInputOf(at: Date): string {
  const whole = new Date(Math.ceil(at.getTime() / 1000) * 1000);
  const shifted = new Date(whole.getTime() - whole.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 19);
}
