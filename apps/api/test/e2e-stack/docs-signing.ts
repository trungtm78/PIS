import { X509Certificate } from 'node:crypto';
import type { TestDatabase } from '@machvon/db/src/test-database';
import { Client } from 'pg';
import { fingerprintOf } from '../../src/modules/doc/cms-verification';
import type { TrustStoreProvider } from '../../src/modules/doc/trust-anchors';
import { MockDocumentFilePort } from '../../src/modules/doc/file-port';
import { MockCertificateAuthority, MockTimestampAuthority, OID } from '../../src/modules/doc/mock-pki';
import { MockSigningDirectory } from '../../src/modules/doc/signing-adapters';
import { MockSigningPort } from '../../src/modules/doc/signing-port';
import type { SessionRef, SigningRequest } from '../../src/modules/doc/signing-port';

const DAY_MS = 86_400_000;
const ACTOR = '00000000-0000-4000-8000-0000000000f0';

/** The signer approves the moment a session opens: nobody holds a phone in a guide run. */
class ApprovingDirectory extends MockSigningDirectory {
  override async startSession(request: SigningRequest): Promise<SessionRef> {
    const ref = await super.startSession(request);
    this.approve(ref);
    return ref;
  }
}

export interface DocsSigningInput {
  database: TestDatabase;
  tenantId: string;
  /** The leader who signs, and the unit that holds the seal of the organisation. */
  signerMembershipId: string;
  organizationUnitId: string;
}

export interface DocsSigning {
  files: MockDocumentFilePort;
  signing: MockSigningDirectory;
  trust: TrustStoreProvider;
}

/**
 * The guide stack (E2E_SEED=docs) holds no business data, but the documents of the office are issued through the real chain of DOC: a leader signs
 * with a certificate, the organisation seals, the clerk numbers and issues. This is the infrastructure of that chain and nothing else: a test certificate
 * authority, the signing adapter that approves by itself, the file store of DOC and the two certificates registered for the leader and the organisation.
 * No document, no register and no template is written here: the office makes those through the commands of the product.
 */
export async function seedDocsSigning(input: DocsSigningInput): Promise<DocsSigning> {
  const now = new Date();
  const validFrom = new Date(now.getTime() - DAY_MS);
  const validUntil = new Date(now.getTime() + 400 * DAY_MS);
  const root = await MockCertificateAuthority.createRoot({ commonName: 'Cao Bang Test Root CA', notBefore: validFrom, notAfter: new Date(now.getTime() + 3650 * DAY_MS) });
  const leader = await root.issue({ commonName: 'Tran Thi Bich', organization: 'So Ke hoach va Dau tu Cao Bang', notBefore: validFrom, notAfter: validUntil });
  const organization = await root.issue({ commonName: 'So Ke hoach va Dau tu Cao Bang', notBefore: validFrom, notAfter: validUntil });
  const stamper = await root.issue({ commonName: 'Cao Bang Test TSA', notBefore: validFrom, notAfter: validUntil, extendedKeyUsage: [OID.timeStamping] });
  const clock = (): Date => new Date();
  const tsa = new MockTimestampAuthority(stamper, clock);
  const signing = new ApprovingDirectory();
  signing.register(fingerprintOf(new X509Certificate(leader.certificate)), new MockSigningPort({ identity: leader, clock, timestamps: tsa }));
  signing.register(fingerprintOf(new X509Certificate(organization.certificate)), new MockSigningPort({ identity: organization, clock, timestamps: tsa }));
  const trust: TrustStoreProvider = { forTenant: () => Promise.resolve({ anchors: () => [{ regime: 'PUBLIC_CA', certificate: root.certificate }] }) };

  const owner = new Client({ connectionString: input.database.urlFor('machvon_owner') });
  await owner.connect();
  try {
    await owner.query("select set_config('app.tenant_id', $1, false)", [input.tenantId]);
    const certificate = (kind: string, holder: string | null, unit: string | null, subject: string, bytes: Buffer): Promise<unknown> =>
      owner.query(
        `insert into machvon.signing_certificate (tenant_id, id, kind, holder_membership_id, organization_unit_id, certificate_serial, issuer_dn, subject_dn, provider_code, valid_from, valid_until, fingerprint_sha256, status, registered_by)
         values ($1, gen_random_uuid(), $2, $3, $4, '01', 'CN=Cao Bang Test Root CA', $5, 'MOCK', $6, $7, $8, 'Active', $9)`,
        [input.tenantId, kind, holder, unit, subject, validFrom, validUntil, fingerprintOf(new X509Certificate(bytes)), ACTOR],
      );
    await certificate('PERSONAL', input.signerMembershipId, null, 'CN=Tran Thi Bich,O=So Ke hoach va Dau tu Cao Bang', leader.certificate);
    await certificate('ORGANIZATION', null, input.organizationUnitId, 'CN=So Ke hoach va Dau tu Cao Bang', organization.certificate);
  } finally {
    await owner.end();
  }
  return { files: new MockDocumentFilePort(), signing, trust };
}
