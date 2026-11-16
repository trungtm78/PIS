/**
 * Picking the session up again after a reload.
 *
 * The identity of the person (the tokens) is kept in the memory of the tab only, never in a storage the page scripts can read, so a reload forgets it. The session of the
 * PROVIDER is not forgotten (its own cookie), so the way back in is one trip to the provider that needs no password. This module keeps ONE small fact in the storage of
 * the tab: "a person was signed in in this tab and did not sign out on purpose". With it the gate of the sign-in starts that trip by itself, instead of asking the person to
 * press "Đăng nhập" at every reload.
 *
 * Guards against a loop: the trip is started once per `RESUME_COOLDOWN_MS`; a deliberate sign-out removes the fact; a tab that never held a session has no fact and keeps
 * waiting for the person.
 */
const MARK = 'pis.session.resume';
const LAST = 'pis.session.resume.at';
export const RESUME_COOLDOWN_MS = 20_000;

const store = (): Storage | undefined => {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
};

/** A person is signed in in this tab: remember it for the next load. A trip that ended in a session is not a failed attempt, so the cooldown (which only stops a loop of failed trips) starts over. */
export function rememberSession(): void {
  try {
    store()?.setItem(MARK, '1');
    store()?.removeItem(LAST);
  } catch {
    // A storage that refuses is a tab that cannot resume, nothing more.
  }
}

/** The person signed out on purpose: nothing is picked up again. */
export function forgetSessionMark(): void {
  try {
    store()?.removeItem(MARK);
    store()?.removeItem(LAST);
  } catch {
    // See above.
  }
}

/** True when the gate may start the trip now (and records that it did, so that a second load within the cooldown does not). */
export function takeResumeTurn(nowMs: number = Date.now()): boolean {
  try {
    const storage = store();
    if (storage === undefined || storage.getItem(MARK) !== '1') return false;
    const last = Number(storage.getItem(LAST) ?? '0');
    if (Number.isFinite(last) && nowMs - last < RESUME_COOLDOWN_MS) return false;
    storage.setItem(LAST, String(nowMs));
    return true;
  } catch {
    return false;
  }
}
