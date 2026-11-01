import { ApiError, newCommandAttempt } from '@machvon/api-client';
import type { CommandAttempt } from '@machvon/api-client';

const REQUEST_TIMEOUT = 408;
const TOO_MANY_REQUESTS = 429;
const IDEMPOTENCY_IN_PROGRESS = 'IDEMPOTENCY_IN_PROGRESS';

/**
 * The server refused the request itself (a 4xx other than a timeout, a rate limit or a command still running): that answer is
 * final and the server replays it for the same idempotency key. A lost answer, a 5xx or a timeout is not final.
 */
/** The server does not know who is asking (401): the request was not refused for what it says, and it can be sent again once the person has signed in again. */
export function isSessionExpired(failure: unknown): boolean {
  return failure instanceof ApiError && (failure.status === 401 || failure.code === 'SESSION_EXPIRED');
}

export function isDefinitiveRefusal(failure: unknown): boolean {
  if (!(failure instanceof ApiError)) return false;
  return failure.status >= 400 && failure.status < 500 && failure.status !== REQUEST_TIMEOUT && failure.status !== TOO_MANY_REQUESTS && failure.code !== IDEMPOTENCY_IN_PROGRESS;
}

/**
 * Hands out the idempotency attempt of the user's current intention: the same payload (a retry after a failure, a second
 * click) reuses it so the server runs the command once, a different payload is a new intention with a new key, and a
 * success ends the intention.
 */
export class AttemptRegistry {
  private last: { payload: string; attempt: CommandAttempt } | undefined;

  constructor(private readonly start: () => CommandAttempt = newCommandAttempt) {}

  forPayload(payload: unknown): CommandAttempt {
    const text = JSON.stringify(payload);
    if (this.last?.payload !== text) this.last = { payload: text, attempt: this.start() };
    return this.last.attempt;
  }

  done(): void {
    this.last = undefined;
  }

  /** The command failed: a final refusal ends the intention (the unchanged request is a new one), a lost answer keeps the attempt for the retry. */
  ended(failure: unknown): void {
    if (isDefinitiveRefusal(failure)) this.last = undefined;
  }
}
