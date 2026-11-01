import { describe, expect, it } from 'vitest';
import { ACCOUNT_MAX_LENGTH, LOCK_MINUTES, accountProblem, clock, countdownOf, hintOf, lockedUntil, pathOf, reasonOf, stepUpHolds, stepUpUntil, withNext } from './model';

const NOW = Date.parse('2026-11-02T08:00:00Z');

describe('the addresses of the sign-in screens', () => {
  it('keeps the destination asked for on the way to another sign-in screen, and leaves out the ordinary one', () => {
    expect(withNext('/iam/iam-03', '/prj/prj-01', '/home/home-01')).toBe('/iam/iam-03?next=%2Fprj%2Fprj-01');
    expect(withNext('/iam/iam-03', '/home/home-01', '/home/home-01')).toBe('/iam/iam-03');
  });

  it('names the path of a screen by its id, and the root for an id the registry does not know', () => {
    expect(pathOf('IAM-01')).toBe('/iam/iam-01');
    expect(pathOf('NO-SUCH-SCREEN')).toBe('/');
  });
});

describe('the address of a sign-in screen (BR-IAM-12)', () => {
  it('reads only the three reasons the screen knows', () => {
    expect(reasonOf('?reason=expired')).toBe('expired');
    expect(reasonOf('?reason=failed')).toBe('failed');
    expect(reasonOf('?reason=locked')).toBe('locked');
    expect(reasonOf('?reason=unknown')).toBeUndefined();
    expect(reasonOf('')).toBeUndefined();
  });

  it('holds a person back until the end given, but never for longer than the lock itself', () => {
    const seconds = (offsetMs: number): string => String(Math.floor((NOW + offsetMs) / 1000));
    expect(lockedUntil(`?until=${seconds(5 * 60_000)}`, NOW)).toBe(NOW + 5 * 60_000);
    expect(lockedUntil(`?until=${seconds(24 * 3_600_000)}`, NOW)).toBe(NOW + LOCK_MINUTES * 60_000);
    expect(lockedUntil(`?until=${seconds(-1000)}`, NOW)).toBeUndefined();
    expect(lockedUntil('?until=abc', NOW)).toBeUndefined();
    expect(lockedUntil('?until=-5', NOW)).toBeUndefined();
    expect(lockedUntil('', NOW)).toBeUndefined();
  });

  it('counts down to the second and writes the clock with two digits', () => {
    expect(countdownOf(NOW + 61_500, NOW)).toEqual({ minutes: 1, seconds: 2 });
    expect(countdownOf(NOW + 1, NOW)).toEqual({ minutes: 0, seconds: 1 });
    expect(countdownOf(NOW - 5000, NOW)).toEqual({ minutes: 0, seconds: 0 });
    expect(clock({ minutes: 14, seconds: 5 })).toBe('14:05');
  });
});

describe('the account field', () => {
  it('accepts an e-mail address or a user name, empty included', () => {
    expect(accountProblem('')).toBeUndefined();
    expect(accountProblem(' an@pmu.gov.vn ')).toBeUndefined();
    expect(hintOf(' an@pmu.gov.vn ')).toBe('an@pmu.gov.vn');
  });

  it('refuses a value that is too long or holds spaces or control characters, and sends no hint for it', () => {
    expect(accountProblem('a'.repeat(ACCOUNT_MAX_LENGTH + 1))).toBe('tooLong');
    expect(accountProblem('an van')).toBe('invalid');
    expect(accountProblem('an\u0007')).toBe('invalid');
    expect(hintOf('an van')).toBeUndefined();
    expect(hintOf('   ')).toBeUndefined();
  });
});

describe('the second factor', () => {
  it('counts for 15 minutes from the moment it was given', () => {
    const at = new Date(NOW - 14 * 60_000);
    expect(stepUpHolds({ level: 'aal2', aal2At: at }, NOW)).toBe(true);
    expect(stepUpHolds({ level: 'aal2', aal2At: new Date(NOW - 15 * 60_000) }, NOW)).toBe(false);
    expect(stepUpHolds({ level: 'aal2' }, NOW)).toBe(true);
    expect(stepUpHolds({ level: 'aal1' }, NOW)).toBe(false);
    expect(stepUpHolds(undefined, NOW)).toBe(false);
  });

  it('says until when it counts only when the session says when it happened', () => {
    expect(stepUpUntil({ level: 'aal2', aal2At: new Date(NOW) })?.getTime()).toBe(NOW + 15 * 60_000);
    expect(stepUpUntil({ level: 'aal2' })).toBeUndefined();
    expect(stepUpUntil({ level: 'aal1', aal2At: new Date(NOW) })).toBeUndefined();
    expect(stepUpUntil(undefined)).toBeUndefined();
  });
});
