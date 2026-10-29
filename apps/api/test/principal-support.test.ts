import { principalOf } from '../src/principal';

const TENANT = '00000000-0000-4000-8000-00000000000a';
const OPERATOR = '00000000-0000-4000-8000-0000000000d1';
const GRANT = '00000000-0000-4000-8000-0000000000e1';

const request = (over: Record<string, unknown> = {}) => ({
  principal: { tenant: { tenantId: TENANT, membershipId: OPERATOR, scopeVersion: 0 }, audience: 'tenant', assurance: 'aal1', sessionId: 'sid-1', support: { grantId: GRANT, operatorId: OPERATOR }, ...over },
});

describe('the support claim of a principal (ST-SAS-015)', () => {
  it('is read when it names a grant and the operator who is the membership of the context, on the tenant plane', () => {
    expect(principalOf(request()).support).toEqual({ grantId: GRANT, operatorId: OPERATOR });
  });

  it('is absent from an ordinary principal', () => {
    expect(principalOf(request({ support: undefined })).support).toBeUndefined();
  });

  it('is refused when the grant or the operator is not an identifier, the operator is not the membership, or the token is for the control plane', () => {
    for (const bad of [
      { support: { grantId: 'x', operatorId: OPERATOR } },
      { support: { grantId: GRANT, operatorId: 'x' } },
      { support: { grantId: GRANT } },
      { support: 'support' },
      { support: { grantId: GRANT, operatorId: '00000000-0000-4000-8000-0000000000d2' } },
      { audience: 'control' },
    ]) {
      expect(() => principalOf(request(bad))).toThrow(expect.objectContaining({ code: 'SESSION_EXPIRED', status: 401 }));
    }
  });
});
