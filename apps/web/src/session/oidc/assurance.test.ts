import { describe, expect, it } from 'vitest';
import { assuranceOfClaims } from './assurance';

describe('the assurance the identity provider claims for the person', () => {
  const TIME = 1_800_000_000;

  it('is aal2 from the time of authentication when acr says so, or amr names an explicit mfa or two kinds of factor', () => {
    expect(assuranceOfClaims({ acr: 'aal2', auth_time: TIME })).toEqual({ level: 'aal2', aal2At: new Date(TIME * 1000) });
    expect(assuranceOfClaims({ acr: '2', auth_time: TIME }).level).toBe('aal2');
    expect(assuranceOfClaims({ amr: ['pwd', 'mfa'], auth_time: TIME }).level).toBe('aal2');
    expect(assuranceOfClaims({ amr: ['pwd', 'otp'], auth_time: TIME }).level).toBe('aal2');
    expect(assuranceOfClaims({ amr: ['pwd', 'fido', 7], auth_time: TIME }).level).toBe('aal2');
  });

  it('is aal1 for one kind of factor, a level that is not aal2, no time of authentication, or no claims at all', () => {
    expect(assuranceOfClaims({ amr: ['pwd', 'pin'], auth_time: TIME })).toEqual({ level: 'aal1' });
    expect(assuranceOfClaims({ amr: ['unknown', 'other'], auth_time: TIME })).toEqual({ level: 'aal1' });
    expect(assuranceOfClaims({ amr: 'mfa', auth_time: TIME })).toEqual({ level: 'aal1' });
    expect(assuranceOfClaims({ acr: 'aal1', auth_time: TIME })).toEqual({ level: 'aal1' });
    expect(assuranceOfClaims({ acr: 'aal2' })).toEqual({ level: 'aal1' });
    expect(assuranceOfClaims({ acr: 'aal2', auth_time: 0 })).toEqual({ level: 'aal1' });
    expect(assuranceOfClaims({ acr: 'aal2', auth_time: Number.NaN })).toEqual({ level: 'aal1' });
    expect(assuranceOfClaims(undefined)).toEqual({ level: 'aal1' });
  });
});
