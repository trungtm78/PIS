/** The waits of the first retries, in seconds: a minute, five minutes, half an hour (ST-ADM-018). */
const RETRY_SECONDS = [60, 300, 1800] as const;

/**
 * The wait before retry number `attempt` (1-based) of a failed inbox event: 1, 5 and then 30 minutes. An event is tried ten times
 * (INBOX_MAX_ATTEMPTS of the inbox store) before it is parked as DEAD.
 */
export function inboxRetryDelaySeconds(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError('attempt must be a positive integer');
  return RETRY_SECONDS[Math.min(attempt, RETRY_SECONDS.length) - 1] as number;
}
