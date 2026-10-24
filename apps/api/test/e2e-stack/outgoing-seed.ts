import { X509Certificate, createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentStore, NumberRegisterStore } from '@machvon/db';
import type { TenantDatabase } from '@machvon/db';
import type { TestDatabase } from '@machvon/db/src/test-database';
import { Client } from 'pg';
import { fingerprintOf } from '../../src/modules/doc/cms-verification';
import type { TrustStoreProvider } from '../../src/modules/doc/trust-anchors';
import { MockDocumentFilePort } from '../../src/modules/doc/file-port';
import { MockCertificateAuthority, MockTimestampAuthority, OID } from '../../src/modules/doc/mock-pki';
import { applyNumbering } from '../../src/modules/doc/numbering-revision';
import { PdfLibRenderer } from '../../src/modules/doc/pdf-renderer';
import { MockSigningDirectory } from '../../src/modules/doc/signing-adapters';
import { MockSigningPort } from '../../src/modules/doc/signing-port';
import type { SessionRef, SigningRequest } from '../../src/modules/doc/signing-port';
import { sampleRequest } from '../doc/render-fixture';
import { signField } from '../doc/support/pdf-fixture';

const DAY_MS = 86_400_000;
const ACTOR = '00000000-0000-4000-8000-0000000000f0';

/** The signer approves the moment a session opens: nobody holds a phone in a browser run. */
class ApprovingDirectory extends MockSigningDirectory {
  override async startSession(request: SigningRequest): Promise<SessionRef> {
    const ref = await super.startSession(request);
    this.approve(ref);
    return ref;
  }
}

export interface OutgoingSeedInput {
  database: TestDatabase;
  tenants: TenantDatabase;
  tenantId: string;
  /** The leader signer and certificate holder, and the drafter. */
  signerMembershipId: string;
  drafterMembershipId: string;
  /** The records clerk of DOC-09: the drafter of one document, so the screen can be shown refusing a person who uploads the signed file of their own document. */
  clerkMembershipId: string;
  /** The drafting unit of the documents, and the unit above it that holds the organisation certificate. */
  draftingUnitId: string;
  organizationUnitId: string;
}

export interface OutgoingSeed {
  files: MockDocumentFilePort;
  signing: MockSigningDirectory;
  trust: TrustStoreProvider;
  /** Ids the browser checks name: documents the visual cases read, and ones the flows change. */
  documents: { visualSubmitted: string; flowSubmitted: string; visualSigned: string; uploadSubmitted: string; selfDrafted: string };
}

/**
 * What the signing and numbering screens need to show real data: the document type, an open outgoing register, a leader and
 * an organisation certificate of a test authority (the API signs with it through the MOCK adapter, which approves by itself),
 * and outgoing documents in SUBMITTED and SIGNED whose PDFs carry the signature form (revision 0) and, for SIGNED, a real signature.
 */
export async function seedOutgoingDocuments(input: OutgoingSeedInput): Promise<OutgoingSeed> {
  const now = new Date();
  const validFrom = new Date(now.getTime() - DAY_MS);
  const validUntil = new Date(now.getTime() + 400 * DAY_MS);
  const root = await MockCertificateAuthority.createRoot({ commonName: 'E2E Test Root CA', notBefore: validFrom, notAfter: new Date(now.getTime() + 3650 * DAY_MS) });
  const leader = await root.issue({ commonName: 'Nguyen An', organization: 'E2E Agency', notBefore: validFrom, notAfter: validUntil });
  const organization = await root.issue({ commonName: 'E2E Agency Seal', notBefore: validFrom, notAfter: validUntil });
  const stamper = await root.issue({ commonName: 'E2E TSA', notBefore: validFrom, notAfter: validUntil, extendedKeyUsage: [OID.timeStamping] });
  const clock = (): Date => new Date();
  const tsa = new MockTimestampAuthority(stamper, clock);
  const signing = new ApprovingDirectory();
  signing.register(fingerprintOf(new X509Certificate(leader.certificate)), new MockSigningPort({ identity: leader, clock, timestamps: tsa }));
  signing.register(fingerprintOf(new X509Certificate(organization.certificate)), new MockSigningPort({ identity: organization, clock, timestamps: tsa }));
  const trust: TrustStoreProvider = { forTenant: () => Promise.resolve({ anchors: () => [{ regime: 'PUBLIC_CA', certificate: root.certificate }] }) };

  const files = new MockDocumentFilePort();
  const documents = new DocumentStore();
  const registers = new NumberRegisterStore();
  const context = { tenantId: input.tenantId, membershipId: ACTOR, scopeVersion: 1 };
  const { layoutProfileId, templateId } = await input.tenants.withTenant(context, async (tx) => {
    const seeded = await documents.seedDefaults(tx, ACTOR);
    await documents.defineDocType(tx, {
      code: 'QD',
      name: 'Quyet dinh',
      abbreviation: 'QD',
      symbolKind: 'DECISION',
      symbolPattern: '{number}/{type}-{agency}',
      registerCode: 'REG-QD',
      legalBasis: 'ND 30/2020',
      effectiveFrom: '2026-01-01',
      actor: ACTOR,
    });
    await registers.openRegister(tx, {
      registerCode: 'UBND',
      name: 'So van ban di',
      direction: 'OUTGOING',
      organizationUnitId: input.draftingUnitId,
      year: now.getFullYear(),
      mode: 'MANAGED',
      scopeDocTypes: ['QD'],
      actor: ACTOR,
    });
    // A register that mirrors the numbers of another system: the flow of DOC-09 registers a document that was numbered elsewhere. Its code sorts after UBND, so
    // the numbering screen keeps choosing UBND.
    await registers.openRegister(tx, {
      registerCode: 'ZEXT',
      name: 'So van ban ky ben ngoai',
      direction: 'OUTGOING',
      organizationUnitId: input.draftingUnitId,
      year: now.getFullYear(),
      mode: 'MIRRORED',
      scopeDocTypes: ['QD'],
      actor: ACTOR,
    });
    return seeded;
  });
  const owner = new Client({ connectionString: input.database.urlFor('machvon_owner') });
  await owner.connect();
  try {
    await owner.query("select set_config('app.tenant_id', $1, false)", [input.tenantId]);
    const certificate = (kind: string, holder: string | null, unit: string | null, subject: string, bytes: Buffer): Promise<unknown> =>
      owner.query(
        `insert into machvon.signing_certificate (tenant_id, id, kind, holder_membership_id, organization_unit_id, certificate_serial, issuer_dn, subject_dn, provider_code, valid_from, valid_until, fingerprint_sha256, status, registered_by)
         values ($1, gen_random_uuid(), $2, $3, $4, '01', 'CN=E2E Test Root CA', $5, 'MOCK', $6, $7, $8, 'Active', $9)`,
        [input.tenantId, kind, holder, unit, subject, validFrom, validUntil, fingerprintOf(new X509Certificate(bytes)), ACTOR],
      );
    await certificate('PERSONAL', input.signerMembershipId, null, 'CN=Nguyen An,O=E2E Agency', leader.certificate);
    await certificate('ORGANIZATION', null, input.organizationUnitId, 'CN=E2E Agency Seal', organization.certificate);
  } finally {
    await owner.end();
  }

  const rendered = Buffer.from((await new PdfLibRenderer().render({ ...sampleRequest(), signatureFields: true })).bytes);
  const leaderSigned = await signField(rendered, { field: 'sig_leader', identity: leader, signingTime: now, timestamps: tsa });

  const insert = async (title: string, signed: boolean, drafter: string = input.drafterMembershipId): Promise<string> => {
    const outgoingId = randomUUID();
    await input.tenants.withTenant(context, async (tx) => {
      const document = await documents.insertDocument(tx, { docKind: 'OUTGOING', docTypeCode: 'QD', title, classification: 'INTERNAL', createdBy: ACTOR, issuerUnitId: input.draftingUnitId });
      const store = async (bytes: Buffer, stage: 'RENDERED_FINAL' | 'LEADER_SIGNED', name: string): Promise<void> => {
        const key = `tenants/${input.tenantId}/documents/${document.id}-${name}.pdf`;
        await files.put(key, bytes, 'application/pdf');
        const version = await documents.appendVersion(tx, {
          documentId: document.id,
          objectKey: key,
          checksum: createHash('sha256').update(bytes).digest('hex'),
          mime: 'application/pdf',
          pageCount: 1,
          classification: 'INTERNAL',
          stage,
          byteLength: bytes.length,
          createdBy: ACTOR,
        });
        await documents.setScanResult(tx, version.id, 'CLEAN');
      };
      await store(rendered, 'RENDERED_FINAL', 'rendered');
      if (signed) await store(leaderSigned, 'LEADER_SIGNED', 'leader');
      await tx.query(
        `insert into machvon.outgoing_document (tenant_id, id, document_id, layout_profile_id, status, drafting_unit_id, drafter_user_id, signer_user_id, signer_title, leader_signed_at, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::uuid, $7::uuid, 'Giam doc', $8::timestamptz, $6::uuid, $6::uuid)`,
        [outgoingId, document.id, layoutProfileId, signed ? 'SIGNED' : 'SUBMITTED', input.draftingUnitId, drafter, input.signerMembershipId, signed ? now.toISOString() : null],
      );
    });
    return outgoingId;
  };
  const visualSigned = await insert('Quyet dinh giao von dot 2', true);
  const flowSubmitted = await insert('Quyet dinh phe duyet ke hoach giai ngan', false);
  const visualSubmitted = await insert('Quyet dinh giao von dot 1', false);
  const uploadSubmitted = await insert('Quyet dinh cho lanh dao ky ben ngoai', false);
  const selfDrafted = await insert('Quyet dinh do van thu soan', false, input.clerkMembershipId);
  await writeSignedSamples({ rendered, leaderSigned, organization, tsa, now, uploadSubmitted, selfDrafted });
  await seedIssueDocuments({ input, files, store: documents, context, layoutProfileId, templateId, leaderSigned, organization, tsa, now });
  return { files, signing, trust, documents: { visualSubmitted, flowSubmitted, visualSigned, uploadSubmitted, selfDrafted } };
}

interface IssueSeed {
  input: OutgoingSeedInput;
  files: MockDocumentFilePort;
  store: DocumentStore;
  context: { tenantId: string; membershipId: string; scopeVersion: number };
  layoutProfileId: string;
  templateId: string;
  leaderSigned: Buffer;
  organization: Parameters<typeof signField>[1]['identity'];
  tsa: MockTimestampAuthority;
  now: Date;
}

/** The titles of the documents the issue and distribution flows (DOC-08) work on; the specs find them by title. */
export const ISSUE_TITLES = {
  confirmed: 'Quyet dinh cho phat hanh (mau da xac nhan)',
  override: 'Quyet dinh phat hanh kem ly do (mau chua xac nhan)',
  tampered: 'Quyet dinh bi sua sau khi dong dau',
  distribute: 'Quyet dinh dang phan phoi',
  visualSealed: 'Quyet dinh hien thi cho phat hanh',
  visualIssued: 'Quyet dinh hien thi da phan phoi',
  resend: 'Quyet dinh gui lai qua thu dien tu',
} as const;

const RECIPIENTS = [
  { kind: 'INTERNAL_UNIT', name: 'Phong Ke hoach' },
  { kind: 'EXTERNAL_AGENCY', name: 'So Tai chinh', code: 'SKHDT' },
];

interface DistributionSeed {
  name: string;
  kind: 'INTERNAL_UNIT' | 'EXTERNAL_AGENCY';
  channel: 'INTERNAL' | 'EMAIL' | 'PAPER_HANDOVER';
  status: 'SENT' | 'DELIVERED' | 'FAILED';
}

/**
 * Documents that the issue gate and the distribution can be shown on (DOC-08): sealed ones whose file really carries the two signatures (one with its
 * template unconfirmed, one whose bytes were changed after the seal) and issued ones with their rows. They are written the way the commands leave them, so a
 * flow starts from the state a clerk would find.
 */
async function seedIssueDocuments(seed: IssueSeed): Promise<void> {
  const { input, store, files } = seed;
  const owner = new Client({ connectionString: input.database.urlFor('machvon_owner') });
  await owner.connect();
  await owner.query("select set_config('app.tenant_id', $1, false)", [input.tenantId]);
  const [year, month, day] = seed.now.toISOString().slice(0, 10).split('-');
  let counter = 900;
  const build = async (title: string, options: { status: 'SEALED' | 'ISSUED'; template?: boolean; tamper?: boolean; rows?: DistributionSeed[] }): Promise<void> => {
    counter += 1;
    const symbol = `${counter}/QD-UBND`;
    const numbered = applyNumbering(seed.leaderSigned, { docNumber: String(counter), docSymbol: symbol, docDate: `${day}/${month}/${year}` }).pdf;
    let sealed = await signField(numbered, { field: 'sig_org', identity: seed.organization, signingTime: new Date(seed.now.getTime() + 60_000), timestamps: seed.tsa });
    if (options.tamper === true) {
      sealed = Buffer.from(sealed);
      // One byte inside the first stream of the file, which both signatures cover.
      const at = sealed.indexOf('stream' + String.fromCharCode(10)) + 'stream'.length + 6;
      sealed[at] = sealed[at] === 0x44 ? 0x45 : 0x44;
    }
    const documentId = await input.tenants.withTenant(seed.context, async (tx) => {
      const anchor = await store.insertDocument(tx, { docKind: 'OUTGOING', docTypeCode: 'QD', title, classification: 'INTERNAL', createdBy: ACTOR, issuerUnitId: input.draftingUnitId });
      const key = `tenants/${input.tenantId}/documents/${anchor.id}-sealed.pdf`;
      await files.put(key, sealed, 'application/pdf');
      const version = await store.appendVersion(tx, {
        documentId: anchor.id,
        objectKey: key,
        checksum: createHash('sha256').update(sealed).digest('hex'),
        mime: 'application/pdf',
        pageCount: 1,
        classification: 'INTERNAL',
        stage: 'ORG_SEALED',
        byteLength: sealed.length,
        createdBy: ACTOR,
      });
      await store.setScanResult(tx, version.id, 'CLEAN');
      return anchor.id;
    });
    const issued = options.status === 'ISSUED';
    await owner.query('update machvon.document set symbol = $2, issued_on = $3::date, document_number = $4, number_year = $5, effect_status = $6 where id = $1::uuid', [
      documentId,
      symbol,
      `${year}-${month}-${day}`,
      counter,
      Number(year),
      issued ? 'EFFECTIVE' : 'PENDING',
    ]);
    const outgoingId = randomUUID();
    const recipients = RECIPIENTS.map((recipient) => (recipient.kind === 'INTERNAL_UNIT' ? { ...recipient, unit_id: input.draftingUnitId } : recipient));
    await owner.query(
      `insert into machvon.outgoing_document
         (tenant_id, id, document_id, layout_profile_id, template_id, status, drafting_unit_id, drafter_user_id, signer_user_id, signer_title, allocation_id, recipients,
          leader_signed_at, numbered_at, sealed_at, issued_at, created_by, updated_by)
       values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7::uuid, $8::uuid, $9::uuid, 'Giam doc', gen_random_uuid(), $10::jsonb,
          $11::timestamptz, $11::timestamptz, $11::timestamptz, $12::timestamptz, $8::uuid, $8::uuid)`,
      [input.tenantId, outgoingId, documentId, seed.layoutProfileId, options.template === true ? seed.templateId : null, options.status, input.draftingUnitId, input.drafterMembershipId, input.signerMembershipId, JSON.stringify(recipients), seed.now.toISOString(), issued ? seed.now.toISOString() : null],
    );
    for (const row of options.rows ?? []) {
      await owner.query(
        `insert into machvon.document_distribution
           (tenant_id, id, outgoing_document_id, recipient_kind, recipient_unit_id, recipient_name, recipient_code, channel, status, sent_at, delivered_at, attempts, error_code, created_by, updated_by)
         values ($1::uuid, gen_random_uuid(), $2::uuid, $3, $4::uuid, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, 1, $11, $12::uuid, $12::uuid)`,
        [
          input.tenantId,
          outgoingId,
          row.kind,
          row.kind === 'INTERNAL_UNIT' ? input.draftingUnitId : null,
          row.name,
          row.kind === 'EXTERNAL_AGENCY' ? 'SKHDT' : null,
          row.channel,
          row.status,
          row.status === 'FAILED' ? null : seed.now.toISOString(),
          row.status === 'DELIVERED' ? seed.now.toISOString() : null,
          row.status === 'FAILED' ? 'PROVIDER_UNAVAILABLE' : null,
          input.clerkMembershipId,
        ],
      );
    }
  };
  try {
    await build(ISSUE_TITLES.confirmed, { status: 'SEALED' });
    await build(ISSUE_TITLES.override, { status: 'SEALED', template: true });
    await build(ISSUE_TITLES.tampered, { status: 'SEALED', tamper: true });
    await build(ISSUE_TITLES.distribute, { status: 'ISSUED' });
    await build(ISSUE_TITLES.visualSealed, { status: 'SEALED' });
    await build(ISSUE_TITLES.visualIssued, {
      status: 'ISSUED',
      rows: [
        { name: 'Phong Ke hoach', kind: 'INTERNAL_UNIT', channel: 'INTERNAL', status: 'DELIVERED' },
        { name: 'So Tai chinh', kind: 'EXTERNAL_AGENCY', channel: 'PAPER_HANDOVER', status: 'SENT' },
      ],
    });
    await build(ISSUE_TITLES.resend, { status: 'ISSUED', rows: [{ name: 'So Tai chinh', kind: 'EXTERNAL_AGENCY', channel: 'EMAIL', status: 'FAILED' }] });
  } finally {
    await owner.end();
  }
}

/** The folder the browser flow of DOC-09 reads its files from (the spec and the stack agree on the name). */
export const SIGNED_SAMPLES_DIR = join(tmpdir(), 'machvon-e2e-doc-signed');

/**
 * Files for the upload of documents signed outside the system: the PDF the leader signed (the locked version of the document that waits for the
 * signature, plus a timestamped signature in its leader field), the same PDF signed and numbered by another system (number, symbol and date in its
 * form fields, the seal of the organisation on top), and the one nobody signed. The manifest names what the file declares.
 */
async function writeSignedSamples(input: {
  rendered: Buffer;
  leaderSigned: Buffer;
  organization: Parameters<typeof signField>[1]['identity'];
  tsa: MockTimestampAuthority;
  now: Date;
  uploadSubmitted: string;
  selfDrafted: string;
}): Promise<void> {
  const issuedOn = input.now.toISOString().slice(0, 10);
  const [year, month, day] = issuedOn.split('-');
  const number = 128;
  const symbol = `${number}/QD-NGOAI`;
  const numbered = applyNumbering(input.leaderSigned, { docNumber: String(number), docSymbol: symbol, docDate: `${day}/${month}/${year}` }).pdf;
  const sealed = await signField(numbered, { field: 'sig_org', identity: input.organization, signingTime: new Date(input.now.getTime() + 60_000), timestamps: input.tsa });
  mkdirSync(SIGNED_SAMPLES_DIR, { recursive: true });
  writeFileSync(join(SIGNED_SAMPLES_DIR, 'leader-signed.pdf'), input.leaderSigned);
  writeFileSync(join(SIGNED_SAMPLES_DIR, 'externally-issued.pdf'), sealed);
  writeFileSync(join(SIGNED_SAMPLES_DIR, 'unsigned.pdf'), input.rendered);
  writeFileSync(join(SIGNED_SAMPLES_DIR, 'manifest.json'), JSON.stringify({ number, symbol, issuedOn, uploadDocumentId: input.uploadSubmitted, selfDraftedId: input.selfDrafted, sha256: createHash('sha256').update(sealed).digest('hex') }));
}
