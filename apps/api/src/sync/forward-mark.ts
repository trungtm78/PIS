import { randomBytes, timingSafeEqual } from 'node:crypto';

/** The header that marks a call a batch makes to the server itself. */
export const SYNC_FORWARD_HEADER = 'x-machvon-sync-forward';

/** Known to this process only: it is made when the process starts and is never sent anywhere but to the server itself, on the calls of a batch. */
const SECRET = randomBytes(32);

/** The value a batch puts on the calls it makes to the server itself. */
export const syncForwardMark = (): string => SECRET.toString('hex');

/**
 * Whether the request is a call that a batch made to the server itself. Such a call keeps its idempotency record for the 7 days of the offline queue instead of 72 hours, so a command whose answer was lost with the
 * batch can still be sent again on the last day without being carried out twice. A client cannot ask for this: the value is a secret of the process, and a header with that name on a batch is not forwarded.
 */
export function isSyncForward(header: string | string[] | undefined): boolean {
  if (typeof header !== 'string') return false;
  const given = Buffer.from(header, 'utf8');
  const expected = Buffer.from(syncForwardMark(), 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
