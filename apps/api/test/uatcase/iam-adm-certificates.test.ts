import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { SigningCertificateReadsController, SigningCertificatesController } from '../../src/modules/adm/certificates.controller';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { certificatePem } from '../../../../packages/kernel/test/support/x509';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';
import { assertStatus, expectCheckFails } from '../uat/uat-kit';
import type { Reply } from '../uat/uat-kit';

/**
 * UAT case of the signing certificates of FX-PLAT (ADM.md FR-ADM-08): a certificate that ended on 2025-12-31, a file that carries a private key, a valid certificate twice.
 * The private key text is written in two pieces so that a scan for committed keys does not take this dummy for one.
 */
const SIGNING_KEY = randomBytes(32);
const DAY = 86_400_000;
const ADMIN = 1;
const HOLDER = 2;
const KEY_MARKER = 'PRIVATEKEYMATERIAL0123456789abcdefghijklmnop';

describe('registration of signing certificates on the platform fixture (FR-ADM-08)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;

  async function register(pem: string): Promise<Reply> {
    const token = signTenantContext({ tenantId: TENANT_A, membershipId: memberId(ADMIN), scopeVersion: 1 }, SIGNING_KEY);
    const response = await fetch(`${app.baseUrl}/signing-certificates`, {
      method: 'POST',
      headers: { [TENANT_HEADER]: token, 'content-type': 'application/json', 'idempotency-key': `key-${randomUUID()}` },
      body: JSON.stringify({ kind: 'PERSONAL', holder_membership_id: memberId(HOLDER), certificate_pem: pem, provider_code: 'VNPT-CA' }),
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  const countOf = async (sql: string): Promise<number> => Number((await harness.owner<{ n: string }>(TENANT_A, [[sql, []]]))[0]?.n);

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: 1, path: `/${unitId(1)}/` }]);
    for (const member of [ADMIN, HOLDER]) await harness.seedMembership(TENANT_A, member, 1);
    await harness.seedRole(TENANT_A, 1, 'CERT_ADMIN', ['adm.signature.manage', 'adm.signature.read'], 60);
    await harness.seedGrants(TENANT_A, [{ n: 1, member: ADMIN, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [SigningCertificatesController, SigningCertificateReadsController],
      providers: [{ provide: TenantDatabase, useValue: tenants }, { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) }],
    });
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('UAT-AC136: an expired certificate is 422 CERTIFICATE_EXPIRED, a file with a private key is 422 CERTIFICATE_INVALID with nothing stored and the key in no log, a valid one is 201 and the same one again is 409 CERTIFICATE_DUPLICATE', async () => {
    const written: string[] = [];
    const sinks: Array<[NodeJS.WriteStream, NodeJS.WriteStream['write']]> = [process.stdout, process.stderr].map((stream) => [stream, stream.write.bind(stream)]);
    for (const [stream] of sinks) {
      stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
        written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return (sinks.find(([candidate]) => candidate === stream)?.[1] as (...args: unknown[]) => boolean)(chunk, ...rest);
      }) as NodeJS.WriteStream['write'];
    }
    try {
      const expired = await register(certificatePem({ validFrom: new Date('2024-01-01T00:00:00Z'), validUntil: new Date('2025-12-31T00:00:00Z'), serial: 5 }));
      assertStatus(expired, 422, 'CERTIFICATE_EXPIRED');
      expect(await countOf('select count(*) as n from machvon.signing_certificate')).toBe(0);

      const privateKey = '-----BEGIN PRIVATE' + ` KEY-----\nMC4CAQAwBQYDK2VwBCIEI${KEY_MARKER}\n-----END PRIVATE KEY-----\n`;
      const withKey = await register(privateKey);
      assertStatus(withKey, 422, 'CERTIFICATE_INVALID');
      expect(JSON.stringify(withKey.json)).not.toContain(KEY_MARKER);
      expect(await countOf('select count(*) as n from machvon.signing_certificate')).toBe(0);
      expect(await countOf(`select count(*) as n from machvon.audit_event where safe_diff::text like '%${KEY_MARKER}%'`)).toBe(0);
      expect(await countOf(`select count(*) as n from machvon.outbox_event where payload::text like '%${KEY_MARKER}%'`)).toBe(0);

      const valid = certificatePem({ validFrom: new Date(Date.now() - 30 * DAY), validUntil: new Date(Date.now() + 365 * DAY), serial: 9 });
      assertStatus(await register(valid), 201);
      assertStatus(await register(valid), 409, 'CERTIFICATE_DUPLICATE');
      expect(await countOf('select count(*) as n from machvon.signing_certificate')).toBe(1);
    } finally {
      for (const [stream, original] of sinks) stream.write = original;
    }
    expect(written.join('')).not.toContain(KEY_MARKER);
  });

  it('the checks of this suite can go red: a check fed the wrong answer throws', () => {
    expectCheckFails(() => assertStatus({ status: 201, json: {} }, 422, 'CERTIFICATE_EXPIRED'));
    expectCheckFails(() => assertStatus({ status: 409, json: { code: 'CERTIFICATE_INVALID' } }, 409, 'CERTIFICATE_DUPLICATE'));
  });
});
