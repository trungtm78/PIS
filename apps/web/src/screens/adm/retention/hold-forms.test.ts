import { describe, expect, it } from 'vitest';
import { EMPTY_HOLD, holdBody, holdHasProblems, idsOf, validateHold, validateRelease } from './hold-forms';

const ID1 = '00000000-0000-4000-8000-0000000000a1';
const ID2 = '00000000-0000-4000-8000-0000000000A2';
const good = { ...EMPTY_HOLD, ids: ID1, authorityReference: 'Decision 12/QD-TTCP', reason: 'An inspection of the project' };

describe('validateHold', () => {
  it('accepts a hold on a project and builds the body with lower-case unique ids', () => {
    expect(holdHasProblems(validateHold(good))).toBe(false);
    expect(holdBody({ ...good, ids: `${ID1}, ${ID2}\n${ID1.toUpperCase()}` })).toEqual({ hold_kind: 'INSPECTION', resource_scope: { kind: 'PROJECT', ids: [ID1, ID2.toLowerCase()] }, authority_reference: 'Decision 12/QD-TTCP', reason: 'An inspection of the project' });
  });

  it('wants the paper of the authority and a reason of ten characters', () => {
    expect(validateHold({ ...good, authorityReference: 'abc', reason: 'short' })).toMatchObject({ authorityReference: 'tooShort', reason: 'tooShort' });
    expect(validateHold({ ...good, authorityReference: ' ', reason: '' })).toMatchObject({ authorityReference: 'required', reason: 'required' });
    expect(validateHold({ ...good, reason: 'x'.repeat(2001) }).reason).toBe('tooLong');
  });

  it('wants ids for every scope but the tenant, and none for the tenant', () => {
    expect(validateHold({ ...good, ids: '' }).ids).toBe('noIds');
    expect(validateHold({ ...good, ids: 'nope' }).ids).toBe('invalid');
    expect(validateHold({ ...good, scopeKind: 'TENANT' }).ids).toBe('idsNotAllowed');
    expect(validateHold({ ...good, scopeKind: 'TENANT', ids: '' }).ids).toBeUndefined();
    expect(holdBody({ ...good, scopeKind: 'TENANT', ids: '' })).toMatchObject({ resource_scope: { kind: 'TENANT' } });
    expect(validateHold({ ...good, ids: Array.from({ length: 201 }, () => ID1).join(' ') }).ids).toBe('tooManyIds');
  });

  it('sends the start as an instant when one is given and refuses one that is not a date', () => {
    expect(holdBody({ ...good, effectiveAt: '2026-11-08T10:00' })).toHaveProperty('effective_at');
    expect(validateHold({ ...good, effectiveAt: 'garbage' }).effectiveAt).toBe('invalid');
    expect(idsOf(' a,b;c  d\n')).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('validateRelease', () => {
  it('wants a reason of ten to two thousand characters', () => {
    expect(validateRelease('')).toBe('required');
    expect(validateRelease('too short')).toBe('tooShort');
    expect(validateRelease('The authority lifted the hold')).toBeUndefined();
    expect(validateRelease('x'.repeat(2001))).toBe('tooLong');
  });
});
