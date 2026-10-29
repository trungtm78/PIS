import { DomainError } from '../src/errors';
import { MAX_DELEGATION_DAYS, assertValidDelegation, delegationAt, delegatorHolds, validateDelegation } from '../src/adm-delegation';
import type { DelegationRequest } from '../src/adm-delegation';
import type { EffectiveAccess, GrantView } from '../src/effective-access';
import type { Scope } from '../src/scope';

const NOW = new Date('2026-10-29T03:00:00Z');
const UNIT = '00000000-0000-4000-8000-000000000001';
const days = (from: Date, count: number): Date => new Date(from.getTime() + count * 86_400_000);

const request = (overrides: Partial<DelegationRequest> = {}): DelegationRequest => ({ permissions: ['approval.decide'], scopeKind: 'UNIT_SUBTREE', scopeRefIds: [UNIT], validFrom: NOW, validUntil: days(NOW, 7), ...overrides });
const fields = (r: DelegationRequest): string[] => validateDelegation(r, NOW).map((defect) => `${defect.field}:${defect.code}`);

describe('validateDelegation (BR-ADM-06, ST-ADM-014)', () => {
  it('accepts a delegation of a business permission for 7 days, and one of exactly 90 days', () => {
    expect(fields(request())).toEqual([]);
    expect(fields(request({ validUntil: days(NOW, MAX_DELEGATION_DAYS) }))).toEqual([]);
  });

  it('refuses more than 90 days, by a millisecond too', () => {
    expect(fields(request({ validUntil: days(NOW, 91) }))).toEqual(['valid_until:TOO_LONG']);
    expect(fields(request({ validUntil: new Date(days(NOW, 90).getTime() + 1) }))).toEqual(['valid_until:TOO_LONG']);
  });

  it('refuses a window that does not run forward or that has already ended', () => {
    expect(fields(request({ validUntil: NOW }))).toEqual(['valid_until:BEFORE_START']);
    expect(fields(request({ validFrom: days(NOW, 3), validUntil: days(NOW, 2) }))).toEqual(['valid_until:BEFORE_START']);
    expect(fields(request({ validFrom: days(NOW, -9), validUntil: days(NOW, -2) }))).toEqual(['valid_from:IN_THE_PAST', 'valid_until:ALREADY_ENDED']);
  });

  it('allows a start a few minutes in the past (the clock of the client) and not more', () => {
    expect(fields(request({ validFrom: new Date(NOW.getTime() - 4 * 60_000) }))).toEqual([]);
    expect(fields(request({ validFrom: new Date(NOW.getTime() - 10 * 60_000) }))).toEqual(['valid_from:IN_THE_PAST']);
  });

  it('delegates only business permissions: never iam.* or adm.*, never a wildcard that reaches them, and each only once', () => {
    expect(fields(request({ permissions: ['iam.role.grant'] }))).toEqual(['permissions[0]:ADMINISTRATIVE']);
    expect(fields(request({ permissions: ['approval.decide', 'adm.workflow.manage'] }))).toEqual(['permissions[1]:ADMINISTRATIVE']);
    expect(fields(request({ permissions: ['*'] }))).toEqual(['permissions[0]:WILDCARD']);
    expect(fields(request({ permissions: ['iam.*'] }))).toEqual(['permissions[0]:ADMINISTRATIVE']);
    expect(fields(request({ permissions: ['approval.decide', 'approval.decide'] }))).toEqual(['permissions[1]:DUPLICATE']);
    expect(fields(request({ permissions: [] }))).toEqual(['permissions:REQUIRED']);
    expect(fields(request({ permissions: ['Approval Decide'] }))).toEqual(['permissions[0]:MALFORMED']);
  });

  it('delegates only the permissions something reads a delegation for (approval.decide, doc.outgoing.sign); any other would be recorded and never exercised', () => {
    expect(fields(request({ permissions: ['approval.decide', 'doc.outgoing.sign'] }))).toEqual([]);
    expect(fields(request({ permissions: ['payment.approve'] }))).toEqual(['permissions[0]:UNSUPPORTED']);
    expect(fields(request({ permissions: ['approval.*'] }))).toEqual(['permissions[0]:UNSUPPORTED']);
    expect(fields(request({ permissions: ['approval.decide', 'report.accept'] }))).toEqual(['permissions[1]:UNSUPPORTED']);
  });

  it('needs a known scope kind and at least one distinct unit or project', () => {
    expect(fields(request({ scopeKind: 'TENANT' }))).toEqual(['scope_kind:UNSUPPORTED']);
    expect(fields(request({ scopeKind: 'CONTRACT' }))).toEqual(['scope_kind:UNSUPPORTED']);
    // A project scope would be accepted and then never matched by the engine that reads delegations, so it is refused.
    expect(fields(request({ scopeKind: 'PROJECT' }))).toEqual(['scope_kind:UNSUPPORTED']);
    expect(fields(request({ scopeRefIds: [] }))).toEqual(['scope_ref_ids:REQUIRED']);
    expect(fields(request({ scopeRefIds: [UNIT, UNIT] }))).toEqual(['scope_ref_ids:DUPLICATE']);
    expect(fields(request({ scopeKind: 'UNIT_ONLY' }))).toEqual([]);
  });

  it('assertValidDelegation answers DELEGATION_INVALID (422) naming the first field and carrying every defect', () => {
    expect(() => assertValidDelegation(request(), NOW)).not.toThrow();
    try {
      assertValidDelegation(request({ validUntil: days(NOW, 91), permissions: ['iam.role.grant'] }), NOW);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect(error).toMatchObject({ code: 'DELEGATION_INVALID', status: 422, detail: 'valid_until' });
      expect((error as DomainError).extensions?.defects).toEqual([
        { field: 'valid_until', code: 'TOO_LONG' },
        { field: 'permissions[0]', code: 'ADMINISTRATIVE' },
      ]);
    }
  });
});

describe('delegationAt (the life of a delegation, ST-ADM-014)', () => {
  const window = { validFrom: days(NOW, 1), validUntil: days(NOW, 8) };
  it('is Scheduled before its first instant, Active inside its window and Ended from its last instant', () => {
    expect(delegationAt(window, NOW)).toBe('Scheduled');
    expect(delegationAt(window, window.validFrom)).toBe('Active');
    expect(delegationAt(window, new Date(window.validUntil.getTime() - 1))).toBe('Active');
    expect(delegationAt(window, window.validUntil)).toBe('Ended');
  });
});

describe('delegatorHolds (what the delegator passes on is theirs, ST-ADM-014)', () => {
  const ROOT_PATH = '/root/';
  const CHILD_PATH = '/root/child/';
  const OTHER_PATH = '/other/';
  const grant = (overrides: Partial<GrantView> = {}): GrantView => ({ roleCode: 'LEADER', rank: 60, permissions: ['approval.decide', 'doc.outgoing.sign'], scope: { kind: 'UNIT_SUBTREE', refIds: ['u-root'], paths: [ROOT_PATH] }, status: 'Active', effectiveFrom: new Date('2020-01-01T00:00:00Z'), effectiveUntil: null, ...overrides });
  const access = (grants: GrantView[], membershipActive = true): EffectiveAccess => ({ membershipId: 'm1', scopeVersion: 1, membershipActive, grants });
  const subtree = (path: string): Scope => ({ kind: 'UNIT_SUBTREE', refIds: ['u'], paths: [path] });

  it('holds when every permission is covered by the active grants whose scope covers the scope delegated', () => {
    expect(delegatorHolds(access([grant()]), ['approval.decide'], subtree(CHILD_PATH), NOW)).toBe(true);
    expect(delegatorHolds(access([grant()]), ['approval.decide', 'doc.outgoing.sign'], subtree(ROOT_PATH), NOW)).toBe(true);
  });

  it('does not hold a permission the grants do not carry, nor one over a scope they do not cover', () => {
    expect(delegatorHolds(access([grant()]), ['approval.decide', 'payment.approve'], subtree(CHILD_PATH), NOW)).toBe(false);
    expect(delegatorHolds(access([grant()]), ['approval.decide'], subtree(OTHER_PATH), NOW)).toBe(false);
  });

  it('counts only grants that are active now, of a membership that is active', () => {
    expect(delegatorHolds(access([grant({ status: 'Revoked' })]), ['approval.decide'], subtree(CHILD_PATH), NOW)).toBe(false);
    expect(delegatorHolds(access([grant({ effectiveUntil: new Date('2026-10-01T00:00:00Z') })]), ['approval.decide'], subtree(CHILD_PATH), NOW)).toBe(false);
    expect(delegatorHolds(access([grant()], false), ['approval.decide'], subtree(CHILD_PATH), NOW)).toBe(false);
  });

  it('a pattern is covered only by an equal or broader pattern, never by the exact names below it', () => {
    expect(delegatorHolds(access([grant({ permissions: ['approval.*'] })]), ['approval.decide', 'approval.*'], subtree(CHILD_PATH), NOW)).toBe(true);
    expect(delegatorHolds(access([grant({ permissions: ['approval.decide'] })]), ['approval.*'], subtree(CHILD_PATH), NOW)).toBe(false);
  });

  it('the permissions may come from different grants over the scope', () => {
    expect(delegatorHolds(access([grant({ permissions: ['approval.decide'] }), grant({ permissions: ['doc.outgoing.sign'], rank: 10 })]), ['approval.decide', 'doc.outgoing.sign'], subtree(CHILD_PATH), NOW)).toBe(true);
  });
});
