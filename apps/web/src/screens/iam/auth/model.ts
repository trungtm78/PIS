import { routeById } from '../../../routes/registry';

/** IAM-01 to IAM-03 (ST-IAM-002): what the address of a sign-in screen may say, and how long the second factor counts. The password, the code and the recovery are entered at the identity provider (Authorization Code + PKCE), never here. */
export const LOCK_MINUTES = 15;
/** A step-up counts for 15 minutes (SessionContext): after that a command that asks for aal2 asks again. */
export const STEP_UP_MINUTES = 15;
export const ACCOUNT_MAX_LENGTH = 254;

const MINUTE_MS = 60_000;
const SECOND_MS = 1000;

/** Why the person is back at the sign-in: the session ran out, a sign-in did not work, or the account waits. Anything else is an ordinary visit. */
export type SignInReason = 'expired' | 'failed' | 'locked';

export function reasonOf(search: string): SignInReason | undefined {
  const value = new URLSearchParams(search).get('reason');
  return value === 'expired' || value === 'failed' || value === 'locked' ? value : undefined;
}

/**
 * When the wait ends (`until`, seconds since 1970), or undefined when there is no wait to show. A wait is never longer than the lock itself: an address cannot hold anyone back for longer than the 15
 * minutes of BR-IAM-12, and one that has passed is no wait at all.
 */
export function lockedUntil(search: string, nowMs: number): number | undefined {
  const raw = new URLSearchParams(search).get('until');
  if (raw === null || !/^\d{1,12}$/.test(raw)) return undefined;
  const end = Number(raw) * SECOND_MS;
  if (end <= nowMs) return undefined;
  return Math.min(end, nowMs + LOCK_MINUTES * MINUTE_MS);
}

export interface Countdown {
  minutes: number;
  seconds: number;
}

/** What is left of a wait, rounded up to the second so the last second still reads 00:01. */
export function countdownOf(endMs: number, nowMs: number): Countdown {
  const left = Math.max(0, Math.ceil((endMs - nowMs) / SECOND_MS));
  return { minutes: Math.floor(left / 60), seconds: left % 60 };
}

export const clock = (value: Countdown): string => `${String(value.minutes).padStart(2, '0')}:${String(value.seconds).padStart(2, '0')}`;

export type AccountProblem = 'tooLong' | 'invalid';

/** The account the person types is only a hint for the provider's own page; it may be an e-mail address or a user name, but not text with spaces or control characters. */
export function accountProblem(account: string): AccountProblem | undefined {
  const value = account.trim();
  if (value.length > ACCOUNT_MAX_LENGTH) return 'tooLong';
  return /[\s\p{Cc}]/u.test(value) ? 'invalid' : undefined;
}

/** The login hint sent to the provider: nothing for an empty or unusable field. */
export function hintOf(account: string): string | undefined {
  const value = account.trim();
  return value === '' || accountProblem(value) !== undefined ? undefined : value;
}

/** Whether the second factor still counts: the session is aal2 and, when it says when, that was less than 15 minutes ago. */
export function stepUpHolds(assurance: { level: 'aal1' | 'aal2'; aal2At?: Date } | undefined, nowMs: number): boolean {
  if (assurance === undefined || assurance.level !== 'aal2') return false;
  return assurance.aal2At === undefined || nowMs - assurance.aal2At.getTime() < STEP_UP_MINUTES * MINUTE_MS;
}

/** Until when a step-up counts, when the session says when it happened. */
export function stepUpUntil(assurance: { level: 'aal1' | 'aal2'; aal2At?: Date } | undefined): Date | undefined {
  return assurance?.level === 'aal2' && assurance.aal2At !== undefined ? new Date(assurance.aal2At.getTime() + STEP_UP_MINUTES * MINUTE_MS) : undefined;
}

/** The address of another sign-in screen that keeps the destination the person asked for: `next` is the one the screen already made safe, and the ordinary destination (home) is left out, as it is what the other screen takes when it is told none. */
export function withNext(path: string, next: string, home: string): string {
  return next === home ? path : `${path}?${new URLSearchParams({ next }).toString()}`;
}

/** The address of a screen by its id, or the root where the registry does not know it. */
export const pathOf = (id: string): string => routeById(id)?.path ?? '/';
