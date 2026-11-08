import { ACCESS_CONNECTOR_CODE, ACCESS_DEFAULT_PARAMS, accessConnectionView } from '../src/integration-access-connection';
import type { AccessAccountFacts } from '../src/integration-access-connection';

const NOW = new Date('2026-11-08T03:00:00Z');
const NO_READERS = { ACTIVE: 0, SUSPENDED: 0, RETIRED: 0 };

function account(overrides: Partial<AccessAccountFacts> = {}): AccessAccountFacts {
  return {
    id: 'a1',
    name: 'Lakehouse',
    status: 'ACTIVE',
    scopes: ['open.projects.read'],
    ratePerMinute: 60,
    expiresOn: null,
    createdAt: new Date('2026-11-01T00:00:00Z'),
    lastUsedAt: new Date('2026-11-08T02:00:00Z'),
    credential: { createdAt: new Date('2026-11-01T00:00:00Z'), expiresAt: null, revokedAt: null, supersededAt: null },
    rateLimitedCalls: 0,
    ...overrides,
  };
}

describe('the access connector of the Integration Hub (INT-1)', () => {
  it('says nothing was ever opened, which is not an error', () => {
    expect(accessConnectionView({ accounts: [], readers: NO_READERS, now: NOW })).toMatchObject({ connectorCode: ACCESS_CONNECTOR_CODE, status: 'NO_CONSUMERS', attentionCount: 0, lastUsedAt: null, consumers: [] });
  });

  it('is healthy when every live account is used, in date and under its limit, and reports the last use and the state of the credential', () => {
    const view = accessConnectionView({ accounts: [account()], readers: { ...NO_READERS, ACTIVE: 1 }, now: NOW });
    expect(view.status).toBe('HEALTHY');
    expect(view.lastUsedAt).toBe('2026-11-08T02:00:00.000Z');
    expect(view.counts).toEqual({ machineAccounts: { ACTIVE: 1, SUSPENDED: 0, REVOKED: 0 }, biReaders: { ACTIVE: 1, SUSPENDED: 0, RETIRED: 0 } });
    expect(view.consumers[0]).toMatchObject({ kind: 'MACHINE_ACCOUNT', credentialState: 'ACTIVE', rateLimitPerMinute: 60, attention: [] });
  });

  it('asks for a look at an account that ends soon, has ended, keeps an old secret, was limited lately or was never used', () => {
    const cases: Array<[Partial<AccessAccountFacts>, string]> = [
      [{ expiresOn: '2026-11-20' }, 'EXPIRES_SOON'],
      [{ expiresOn: '2026-11-08' }, 'EXPIRED'],
      [{ credential: { createdAt: new Date('2025-10-01T00:00:00Z'), expiresAt: null, revokedAt: null, supersededAt: null } }, 'SECRET_OVERDUE'],
      [{ rateLimitedCalls: 3 }, 'RATE_LIMITED_RECENTLY'],
      [{ lastUsedAt: null, createdAt: new Date('2026-10-01T00:00:00Z') }, 'NEVER_USED'],
    ];
    for (const [change, code] of cases) {
      const view = accessConnectionView({ accounts: [account(change)], readers: NO_READERS, now: NOW });
      expect([code, view.status, view.consumers[0]?.attention]).toEqual([code, 'ATTENTION', [code]]);
    }
    // A new account that has not been used yet is not late.
    expect(accessConnectionView({ accounts: [account({ lastUsedAt: null, createdAt: new Date('2026-11-07T00:00:00Z') })], readers: NO_READERS, now: NOW }).status).toBe('HEALTHY');
    expect(ACCESS_DEFAULT_PARAMS.expiresSoonDays).toBe(14);
  });

  it('does not nag about a suspended or revoked account: that was a decision', () => {
    const view = accessConnectionView({ accounts: [account({ status: 'SUSPENDED', rateLimitedCalls: 9 }), account({ id: 'a2', status: 'REVOKED', expiresOn: '2020-01-01', credential: { createdAt: new Date('2020-01-01T00:00:00Z'), expiresAt: null, revokedAt: NOW, supersededAt: null } })], readers: NO_READERS, now: NOW });
    expect(view.status).toBe('HEALTHY');
    expect(view.consumers.map((consumer) => [consumer.status, consumer.credentialState])).toEqual([['SUSPENDED', 'ACTIVE'], ['REVOKED', 'REVOKED']]);
  });
});
