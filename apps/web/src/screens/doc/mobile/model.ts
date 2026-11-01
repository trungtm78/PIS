import { READ_PERMISSION as INCOMING_READ_PERMISSION, holds } from '../incoming/model';
import type { IncomingLine } from '../incoming/model';

export { holds };

/** The permissions of DOC-22 and DOC-23 (x-permission of the operations in openapi.json); the server judges each command again, with the scope of the unit. */
export const INCOMING_READ = INCOMING_READ_PERMISSION;
export const OUTGOING_READ = 'doc.outgoing.read';
export const OUTGOING_SIGN = 'doc.outgoing.sign';
export const OUTGOING_REVIEW = 'doc.outgoing.review';

/** The letters on this list are the ones a handler can still act on. */
const HANDLING_STATUSES: readonly IncomingLine['status'][] = ['ASSIGNED', 'PROCESSING'];

/**
 * The letters to handle: assigned or in handling, and the caller's own, either because the letter names the caller as its assignee or because the server says the caller may start or resolve it (the actions of the
 * line are judged for the permission and the scope). The late ones come first, the most days late first, then by deadline, and a letter with no deadline last.
 */
export function lettersToHandle(lines: readonly IncomingLine[], membershipId: string | undefined): IncomingLine[] {
  return lines
    .filter((line) => HANDLING_STATUSES.includes(line.status) && (line.assignee?.userId === membershipId || line.actions.startProcessing || line.actions.resolve))
    .sort((a, b) => (b.overdueDays ?? 0) - (a.overdueDays ?? 0) || (a.dueOn ?? '9999-12-31').localeCompare(b.dueOn ?? '9999-12-31') || b.receivedAt.localeCompare(a.receivedAt));
}

/** The number a letter was registered under, with its symbol when it has one. */
export const numberOf = (line: Pick<IncomingLine, 'number' | 'symbol'>): string | null =>
  line.number === null ? null : line.symbol === null ? String(line.number) : `${line.number} · ${line.symbol}`;
