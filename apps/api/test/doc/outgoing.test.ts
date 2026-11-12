import { X509Certificate, createHash, randomUUID } from 'node:crypto';
import { DocumentStore } from '@machvon/db';
import { fingerprintOf } from '../../src/modules/doc/cms-verification';
import { readNumberFields } from '../../src/modules/doc/external-signature';
import { PdfLibRenderer } from '../../src/modules/doc/pdf-renderer';
import { MockSigningPort } from '../../src/modules/doc/signing-port';
import { ACTOR, ADMIN, CLERK, DRAFTER, DocApp, LEADER, NOBODY, NOW, TENANT_A, TENANT_B, memberId, unitId } from './doc-app';
import { sampleRequest } from './render-fixture';
import type { Identity } from '../../src/modules/doc/mock-pki';
import { signField } from './support/pdf-fixture';
import { createWorld } from './support/pki-world';
import type { World } from './support/pki-world';

jest.setTimeout(120_000);

const app = new DocApp();
const store = new DocumentStore();
let world: World;
let pdf: Buffer;
let registerCounter = 0;
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const ctx = (member: number = ADMIN) => ({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 });
const owner = <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => app.harness.owner<T>(TENANT_A, [[sql, params]]);
const MINUTE = 60 * 1000;

interface Seed {
  drafter?: number;
  signer?: number;
  unit?: number;
  status?: string;
}

async function seedOutgoing(options: Seed = {}): Promise<{ id: string; documentId: string; versionId: string }> {
  const id = randomUUID();
  const unit = unitId(options.unit ?? 2);
  const { documentId, versionId } = await app.harness.tenants.withTenant(ctx(), async (tx) => {
    const document = await store.insertDocument(tx, { docKind: 'OUTGOING', docTypeCode: 'QD', title: 'Decision to assign capital', classification: 'INTERNAL', createdBy: ACTOR, issuerUnitId: unit });
    const key = `tenants/${TENANT_A}/documents/${document.id}-rendered.pdf`;
    await app.files.put(key, pdf, 'application/pdf');
    const version = await store.appendVersion(tx, {
      documentId: document.id,
      objectKey: key,
      checksum: sha256(pdf),
      mime: 'application/pdf',
      pageCount: 1,
      classification: 'INTERNAL',
      stage: 'RENDERED_FINAL',
      byteLength: pdf.length,
      createdBy: ACTOR,
    });
    await store.setScanResult(tx, version.id, 'CLEAN');
    await tx.query(
      `insert into machvon.outgoing_document (tenant_id, id, document_id, layout_profile_id, status, drafting_unit_id, drafter_user_id, signer_user_id, signer_title, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::uuid, $7::uuid, 'Chairman', $6::uuid, $6::uuid)`,
      [id, document.id, app.layoutProfileId, options.status ?? 'SUBMITTED', unit, memberId(options.drafter ?? DRAFTER), memberId(options.signer ?? LEADER)],
    );
    return { documentId: document.id, versionId: version.id };
  });
  return { id, documentId, versionId };
}

async function openRegister(overrides: Record<string, unknown> = {}): Promise<string> {
  registerCounter += 1;
  const reply = await app.call('POST', '/document-number-registers', {
    member: ADMIN,
    body: { register_code: `R${registerCounter}`, name: 'Outgoing register', direction: 'OUTGOING', organization_unit_id: unitId(2), year: 2026, mode: 'MANAGED', scope_doc_types: ['QD'], ...overrides },
  });
  expect(reply.status).toBe(200);
  return reply.json.resource_id as string;
}

const startLeader = (id: string, member: number, options: { version?: number; body?: Record<string, unknown>; key?: string } = {}) =>
  app.call('POST', `/outgoing-documents/${id}/leader-signing-sessions`, { member, ifMatch: `"${options.version ?? 1}"`, body: options.body ?? {}, ...(options.key === undefined ? {} : { key: options.key }) });
const complete = (sessionId: string, member: number, options: { version?: number; body?: Record<string, unknown>; key?: string } = {}) =>
  app.call('POST', `/signing-sessions/${sessionId}/completion`, { member, ifMatch: `"${options.version ?? 1}"`, body: options.body ?? {}, ...(options.key === undefined ? {} : { key: options.key }) });
const number = (id: string, member: number, version: number, body: Record<string, unknown>) =>
  app.call('POST', `/outgoing-documents/${id}/numbering`, { member, ifMatch: `"${version}"`, body });
const startSeal = (id: string, member: number, options: { version?: number; body?: Record<string, unknown>; key?: string } = {}) =>
  app.call('POST', `/outgoing-documents/${id}/organization-seal-sessions`, { member, ifMatch: `"${options.version ?? 1}"`, body: options.body ?? {}, ...(options.key === undefined ? {} : { key: options.key }) });

/** The signer confirming on their device: the mock provider then signs. */
async function approve(sessionId: string): Promise<void> {
  const [row] = await owner<{ provider_txn_ref: string; expires_at: Date }>('select provider_txn_ref, expires_at from machvon.doc_signing_session where id = $1', [sessionId]);
  if (row === undefined) throw new Error('no session');
  app.signing.approve({ provider: 'MOCK', sessionId: row.provider_txn_ref, expiresAt: row.expires_at });
}

async function documentRow(id: string): Promise<{ status: string; version: string; leader_signed_at: Date | null; numbered_at: Date | null; sealed_at: Date | null; allocation_id: string | null }> {
  const [row] = await owner<{ status: string; version: string; leader_signed_at: Date | null; numbered_at: Date | null; sealed_at: Date | null; allocation_id: string | null }>(
    'select status, version::text as version, leader_signed_at, numbered_at, sealed_at, allocation_id from machvon.outgoing_document where id = $1',
    [id],
  );
  if (row === undefined) throw new Error('no document');
  return row;
}

async function versions(documentId: string): Promise<Array<{ id: string; version: number; stage: string; object_key: string; prefix_sha256: string | null; pdf_revision_count: number | null }>> {
  return owner('select id, version, stage, object_key, prefix_sha256, pdf_revision_count from machvon.document_version where document_id = $1 order by version', [documentId]);
}

async function bytesOf(objectKey: string): Promise<Buffer> {
  const file = await app.files.get(objectKey);
  if (file === undefined) throw new Error('no file');
  return Buffer.from(file.bytes);
}

const count = (sql: string, params: unknown[] = []): Promise<number> => app.count(sql, params);

/** Registers a certificate of the signing register (status Active) for the holder or the unit. */
function registerCertificate(id: string, kind: string, holder: string | null, unit: string | null, subject: string, bytes: Buffer): Promise<unknown> {
  return app.harness.owner(TENANT_A, [
    [
      `insert into machvon.signing_certificate (tenant_id, id, kind, holder_membership_id, organization_unit_id, certificate_serial, issuer_dn, subject_dn, provider_code, valid_from, valid_until, fingerprint_sha256, status, registered_by)
       values ($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, '01', 'CN=Test Root CA', $6, 'MOCK', '2026-01-01', '2030-01-01', $7, 'Active', $8::uuid)`,
      [TENANT_A, id, kind, holder, unit, subject, fingerprintOf(new X509Certificate(bytes)), ACTOR],
    ],
  ]);
}

/**
 * A signer certified by an intermediate authority whose certificate the CMS does not carry: against a trust list that holds
 * only the root the chain stays incomplete (INDETERMINATE, CHAIN_INCOMPLETE) while the timestamp is still proven.
 */
async function signerWithIncompleteChain(commonName: string): Promise<Identity> {
  const intermediate = await world.root.createIntermediate({ commonName: `${commonName} CA`, notBefore: new Date('2026-01-01T00:00:00Z'), notAfter: new Date('2030-01-01T00:00:00Z') });
  const issued = await intermediate.issue({ commonName, notBefore: new Date('2026-01-01T00:00:00Z'), notAfter: new Date('2030-01-01T00:00:00Z') });
  return { ...issued, chain: [] };
}

async function signAsLeader(seed: Seed = {}): Promise<{ id: string; documentId: string; sessionId: string }> {
  const created = await seedOutgoing(seed);
  const started = await startLeader(created.id, seed.signer ?? LEADER);
  expect(started.status).toBe(202);
  const sessionId = started.json.resource_id as string;
  await approve(sessionId);
  const done = await complete(sessionId, seed.signer ?? LEADER);
  expect(done.status).toBe(200);
  return { id: created.id, documentId: created.documentId, sessionId };
}

async function numbered(registerId?: string): Promise<{ id: string; documentId: string; registerId: string }> {
  const signed = await signAsLeader();
  const register = registerId ?? (await openRegister());
  const reply = await number(signed.id, CLERK, 2, { register_id: register });
  expect(reply.status).toBe(200);
  return { id: signed.id, documentId: signed.documentId, registerId: register };
}

describe('outgoing documents: leader signing, numbering and the organisation seal (ST-DOC-005)', () => {
  beforeAll(async () => {
    world = await createWorld();
    pdf = Buffer.from((await new PdfLibRenderer().render({ ...sampleRequest(), signatureFields: true })).bytes);
    await app.start();
    app.anchors = [{ regime: 'PUBLIC_CA', certificate: world.root.certificate }];
    const clock = (): Date => app.now;
    app.signing.register(fingerprintOf(new X509Certificate(world.leader.certificate)), new MockSigningPort({ identity: world.leader, clock, timestamps: world.tsa }));
    app.signing.register(fingerprintOf(new X509Certificate(world.organization.certificate)), new MockSigningPort({ identity: world.organization, clock, timestamps: world.tsa }));
    world.setTime(NOW);
    await registerCertificate(randomUUID(), 'PERSONAL', memberId(LEADER), null, 'CN=Nguyen Van A', world.leader.certificate);
    await registerCertificate(randomUUID(), 'ORGANIZATION', null, unitId(1), 'CN=Test Agency Seal', world.organization.certificate);
    const type = await app.call('POST', '/document-types', {
      member: ADMIN,
      body: { code: 'QD', name: 'Decision', abbreviation: 'QD', symbol_kind: 'DECISION', symbol_pattern: '{number}/{type}-{agency}', register_code: 'REG-QD', legal_basis: 'ND 30/2020', effective_from: '2026-01-01' },
    });
    expect(type.status).toBe(200);
  }, 300_000);

  afterAll(() => app.stop(), 60_000);

  afterEach(() => {
    app.now = NOW;
    world.setTime(NOW);
    app.signing.setAvailable(true);
  });

  describe('the whole flow', () => {
    it('signs, numbers and seals a document behind the mock signing port, with three file versions that only grow (AC-ST-DOC-005-1)', async () => {
      const created = await seedOutgoing();
      const register = await openRegister();

      const started = await startLeader(created.id, LEADER);
      expect(started.status).toBe(202);
      expect(started.json).toMatchObject({ status: 'AWAITING_SIGNER', role: 'LEADER', adapter_code: 'MOCK', adapter_status: 'MOCK', resource_version: 1, outgoing_document_id: created.id });
      expect(started.json.digest_hex).toMatch(/^[0-9a-f]{64}$/);
      const leaderSession = started.json.resource_id as string;
      expect((await documentRow(created.id)).status).toBe('SUBMITTED');
      await approve(leaderSession);
      const signed = await complete(leaderSession, LEADER);
      expect(signed.status).toBe(200);
      expect(signed.json).toMatchObject({ status: 'SIGNED', document_status: 'SIGNED', document_version: 2, signature_status: 'VALID', overall: 'VALID' });

      const numberedReply = await number(created.id, CLERK, 2, { register_id: register, clerk_note: 'first of the year' });
      expect(numberedReply.status).toBe(200);
      expect(numberedReply.json).toMatchObject({ status: 'NUMBERED', number: 1, display_number: '01', symbol: `01/QD-R${registerCounter}`, issued_on: '2026-10-23', resource_version: 3 });

      const sealStarted = await startSeal(created.id, CLERK, { version: 3 });
      expect(sealStarted.status).toBe(202);
      expect(sealStarted.json).toMatchObject({ role: 'ORGANIZATION', status: 'AWAITING_SIGNER' });
      const sealSession = sealStarted.json.resource_id as string;
      await approve(sealSession);
      const sealed = await complete(sealSession, CLERK);
      expect(sealed.status).toBe(200);
      expect(sealed.json).toMatchObject({ status: 'SEALED', document_status: 'SEALED', document_version: 4, overall: 'VALID' });

      expect(await documentRow(created.id)).toMatchObject({ status: 'SEALED', version: '4' });
      const stored = await versions(created.documentId);
      expect(stored.map((row) => row.stage)).toEqual(['RENDERED_FINAL', 'LEADER_SIGNED', 'NUMBERED', 'ORG_SEALED']);
      const files = await Promise.all(stored.map((row) => bytesOf(row.object_key)));
      // Each version keeps every byte of the one before it, and says which hash that earlier revision had.
      for (let index = 1; index < files.length; index += 1) {
        const earlier = files[index - 1] as Buffer;
        const later = files[index] as Buffer;
        expect(later.length).toBeGreaterThan(earlier.length);
        expect(sha256(later.subarray(0, earlier.length))).toBe(sha256(earlier));
        expect(stored[index]?.prefix_sha256).toBe(sha256(earlier));
      }
      expect(stored.map((row) => row.pdf_revision_count)).toEqual([null, 2, 3, 4]);

      // The verifier agrees: two valid signatures, each followed only by allowed changes, the whole file covered by the seal.
      const report = await app.call('GET', `/document-versions/${stored[3]?.id}/signature-report`, { member: ADMIN });
      expect(report.status).toBe(200);
      expect(report.json.overall).toBe('VALID');
      expect((report.json.signatures as Array<Record<string, unknown>>).map((row) => [row.role, row.status, row.incremental_changes_allowed])).toEqual([
        ['LEADER', 'VALID', true],
        ['ORGANIZATION', 'VALID', true],
      ]);
      const [document] = await owner<{ current_version_id: string; document_number: number; symbol: string }>('select current_version_id, document_number, symbol from machvon.document where id = $1', [created.documentId]);
      expect(document).toMatchObject({ current_version_id: stored[3]?.id, document_number: 1, symbol: `01/QD-R${registerCounter}` });
    });

    it('UAT-AC403 each step of the signing adds one revision to the locked file and never changes the bytes before it: the leader signature (2 revisions, one VALID signature), the number 42 as a later revision (3 revisions, the leader signature still VALID with only allowed changes) and the organisation seal over the whole file, with the number, the symbol and the date in the fields', async () => {
      const issuedAt = new Date('2026-10-22T03:00:00Z');
      app.now = issuedAt;
      world.setTime(issuedAt);
      const register = await openRegister({ register_code: 'UBND' });
      await owner('update machvon.document_number_register set last_number = 41 where id = $1', [register]);
      const created = await seedOutgoing();
      const locked = await versions(created.documentId);
      const lockedFile = await bytesOf(locked[0]?.object_key as string);
      const h0 = sha256(lockedFile);
      const l0 = lockedFile.length;
      const reportOf = async (stage: string): Promise<Array<Record<string, unknown>>> => {
        const stored = await versions(created.documentId);
        const version = stored.find((row) => row.stage === stage);
        const report = await app.call('GET', `/document-versions/${version?.id}/signature-report`, { member: ADMIN });
        expect(report.status).toBe(200);
        return report.json.signatures as Array<Record<string, unknown>>;
      };
      // Step 1: the leader signs.
      const started = await startLeader(created.id, LEADER);
      await approve(started.json.resource_id as string);
      expect((await complete(started.json.resource_id as string, LEADER)).status).toBe(200);
      let stored = await versions(created.documentId);
      expect(stored.map((row) => [row.stage, row.pdf_revision_count])).toEqual([['RENDERED_FINAL', null], ['LEADER_SIGNED', 2]]);
      expect((await reportOf('LEADER_SIGNED')).map((row) => [row.role, row.status])).toEqual([['LEADER', 'VALID']]);
      // Step 2: the clerk numbers it: the number 42 comes in a later revision, and the bytes of the locked file are untouched.
      const numbered = await number(created.id, CLERK, 2, { register_id: register });
      expect(numbered.json).toMatchObject({ status: 'NUMBERED', number: 42, display_number: '42', symbol: '42/QD-UBND', issued_on: '2026-10-22' });
      stored = await versions(created.documentId);
      expect(stored.map((row) => [row.stage, row.pdf_revision_count])).toEqual([['RENDERED_FINAL', null], ['LEADER_SIGNED', 2], ['NUMBERED', 3]]);
      const numberedFile = await bytesOf(stored[2]?.object_key as string);
      expect(sha256(numberedFile.subarray(0, l0))).toBe(h0);
      expect(stored[1]?.prefix_sha256).toBe(h0);
      expect(stored[2]?.prefix_sha256).toBe(sha256(await bytesOf(stored[1]?.object_key as string)));
      expect((await reportOf('NUMBERED')).map((row) => [row.role, row.status, row.incremental_changes_allowed])).toEqual([['LEADER', 'VALID', true]]);
      // Step 3: the clerk seals it for the organisation; the seal covers the whole file.
      const sealStarted = await startSeal(created.id, CLERK, { version: 3 });
      await approve(sealStarted.json.resource_id as string);
      expect((await complete(sealStarted.json.resource_id as string, CLERK)).status).toBe(200);
      stored = await versions(created.documentId);
      expect(stored.map((row) => row.stage)).toEqual(['RENDERED_FINAL', 'LEADER_SIGNED', 'NUMBERED', 'ORG_SEALED']);
      const sealedFile = await bytesOf(stored[3]?.object_key as string);
      expect(sha256(sealedFile.subarray(0, l0))).toBe(h0);
      const sealedReport = await reportOf('ORG_SEALED');
      expect(sealedReport.map((row) => [row.role, row.status])).toEqual([['LEADER', 'VALID'], ['ORGANIZATION', 'VALID']]);
      expect(sealedReport.find((row) => row.role === 'ORGANIZATION')?.covers_end_offset).toBe(sealedFile.length);
      expect(readNumberFields(sealedFile)).toEqual({ doc_number: '42', doc_symbol: '42/QD-UBND', doc_date: '22/10/2026' });
      // The negative control: a check that wants the prefix of the sealed file to differ from the locked file must fail.
      expect(() => expect(sha256(sealedFile.subarray(0, l0))).not.toBe(h0)).toThrow();
    });

    it('audits and announces every step', async () => {
      const created = await seedOutgoing();
      const register = await openRegister();
      const started = await startLeader(created.id, LEADER);
      const session = started.json.resource_id as string;
      await approve(session);
      await complete(session, LEADER);
      await number(created.id, CLERK, 2, { register_id: register });
      const sealStarted = await startSeal(created.id, CLERK, { version: 3 });
      await approve(sealStarted.json.resource_id as string);
      await complete(sealStarted.json.resource_id as string, CLERK);
      const actions = await owner<{ action: string }>("select action from machvon.audit_event where resource_id = $1 and action like 'outgoing_document.%' order by occurred_at, id", [created.id]);
      expect(actions.map((row) => row.action).sort()).toEqual(
        [
          'outgoing_document.leader_signing.start',
          'outgoing_document.leader_signing.complete',
          'outgoing_document.number',
          'outgoing_document.organization_seal.start',
          'outgoing_document.organization_seal.complete',
        ].sort(),
      );
      const events = await owner<{ type: string }>('select type from machvon.outbox_event where aggregate_id = $1 order by created_at, id', [created.id]);
      expect(events.map((row) => row.type).sort()).toEqual(['doc.numbered.v1', 'doc.seal_started.v1', 'doc.sealed.v1', 'doc.signed.v1', 'doc.signing_started.v1']);
      expect(app.metrics).toContainEqual({ name: 'doc_numbered_total', labels: { outcome: 'numbered' } });
    });

    it('certifies the document when asked for DocMDP and the verifier reads the level back', async () => {
      const created = await seedOutgoing();
      const started = await startLeader(created.id, LEADER, { body: { certify_docmdp: true } });
      const session = started.json.resource_id as string;
      await approve(session);
      const done = await complete(session, LEADER);
      expect(done.status).toBe(200);
      const result = done.json.result_version_id as string;
      const report = await app.call('GET', `/document-versions/${result}/signature-report`, { member: ADMIN });
      expect((report.json.signatures as Array<Record<string, unknown>>)[0]).toMatchObject({ role: 'LEADER', docmdp_level: 2, status: 'VALID' });
    });
  });

  describe('startLeaderSigning', () => {
    it('refuses a second session while one is open, then lets a new one start once the first has run out (AC-ST-DOC-005-4)', async () => {
      const created = await seedOutgoing();
      const first = await startLeader(created.id, LEADER);
      expect(first.status).toBe(202);
      const second = await startLeader(created.id, LEADER);
      expect([second.status, second.json.code]).toEqual([409, 'SIGNING_SESSION_OPEN']);
      app.now = new Date(NOW.getTime() + 16 * MINUTE);
      world.setTime(app.now);
      const third = await startLeader(created.id, LEADER);
      expect(third.status).toBe(202);
      const rows = await owner<{ id: string; status: string }>('select id, status from machvon.doc_signing_session where outgoing_document_id = $1 order by created_at', [created.id]);
      expect(rows.map((row) => row.status)).toEqual(['EXPIRED', 'AWAITING_SIGNER']);
    });

    it('does not let the drafter sign their own document, nor anyone but the named signer', async () => {
      const own = await seedOutgoing({ drafter: DRAFTER, signer: DRAFTER });
      const denied = await startLeader(own.id, DRAFTER);
      expect([denied.status, denied.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      const other = await seedOutgoing();
      const notSigner = await startLeader(other.id, CLERK);
      expect([notSigner.status, notSigner.json.code]).toEqual([422, 'SIGNER_NOT_AUTHORIZED']);
      expect(await count('select count(*) as n from machvon.doc_signing_session where outgoing_document_id = any($1::uuid[])', [[own.id, other.id]])).toBe(0);
    });

    it('keeps the state when the provider cannot be reached and lets the same call succeed once, with the same key', async () => {
      const created = await seedOutgoing();
      const key = `retry-${randomUUID()}`;
      app.signing.setAvailable(false);
      const failed = await startLeader(created.id, LEADER, { key });
      expect([failed.status, failed.json.code]).toEqual([503, 'PROVIDER_UNAVAILABLE']);
      expect(await documentRow(created.id)).toMatchObject({ status: 'SUBMITTED', version: '1' });
      expect(await count('select count(*) as n from machvon.doc_signing_session where outgoing_document_id = $1', [created.id])).toBe(0);
      app.signing.setAvailable(true);
      const retried = await startLeader(created.id, LEADER, { key });
      expect(retried.status).toBe(202);
      const again = await startLeader(created.id, LEADER, { key });
      expect(again.status).toBe(202);
      expect(again.headers.get('idempotency-replayed')).toBe('true');
      expect(again.json.resource_id).toBe(retried.json.resource_id);
      expect(await count('select count(*) as n from machvon.doc_signing_session where outgoing_document_id = $1', [created.id])).toBe(1);
    });

    it('refuses a certificate that is suspended, belongs to someone else or is not there', async () => {
      const created = await seedOutgoing();
      const unknown = await startLeader(created.id, LEADER, { body: { certificate_id: randomUUID() } });
      expect([unknown.status, unknown.json.code]).toEqual([422, 'CERTIFICATE_NOT_ACTIVE']);
      const [personal] = await owner<{ id: string }>("select id from machvon.signing_certificate where kind = 'PERSONAL' and holder_membership_id = $1", [memberId(LEADER)]);
      await owner("update machvon.signing_certificate set status = 'Suspended', status_reason = 'key lost' where id = $1", [personal?.id]);
      try {
        const suspended = await startLeader(created.id, LEADER);
        expect([suspended.status, suspended.json.code]).toEqual([422, 'CERTIFICATE_NOT_ACTIVE']);
      } finally {
        await owner("update machvon.signing_certificate set status = 'Active', status_reason = null where id = $1", [personal?.id]);
      }
    });

    it('answers a state error outside SUBMITTED, a precondition error without If-Match and a conflict for a stale version', async () => {
      const signed = await signAsLeader();
      const wrongState = await startLeader(signed.id, LEADER, { version: 2 });
      expect([wrongState.status, wrongState.json.code]).toEqual([409, 'DOCUMENT_STATE_INVALID']);
      const created = await seedOutgoing();
      const stale = await startLeader(created.id, LEADER, { version: 9 });
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const missing = await app.call('POST', `/outgoing-documents/${created.id}/leader-signing-sessions`, { member: LEADER, body: {} });
      expect([missing.status, missing.json.code]).toEqual([428, 'PRECONDITION_REQUIRED']);
    });

    it('hides a document outside the scope of the caller and needs the signing permission', async () => {
      const elsewhere = await seedOutgoing({ unit: 1 });
      expect((await startLeader(elsewhere.id, LEADER)).status).toBe(404);
      const created = await seedOutgoing();
      expect((await startLeader(created.id, LEADER)).status).toBe(202);
      const noPermission = await startLeader((await seedOutgoing()).id, NOBODY);
      expect([noPermission.status, noPermission.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const admin = await startLeader((await seedOutgoing()).id, ADMIN);
      expect([admin.status, admin.json.code]).toEqual([403, 'SCOPE_DENIED']);
    });

    it('accepts any requested adapter while the mock is the one bound', async () => {
      const created = await seedOutgoing();
      expect((await startLeader(created.id, LEADER, { body: { adapter_code: 'REMOTE_CA' } })).status).toBe(202);
    });
  });

  describe('completeSigningSession', () => {
    it('waits for the signer, then completes; an unconfirmed session stays open', async () => {
      const created = await seedOutgoing();
      const started = await startLeader(created.id, LEADER);
      const session = started.json.resource_id as string;
      const early = await complete(session, LEADER);
      expect([early.status, early.json.code]).toEqual([409, 'SIGNING_SESSION_OPEN']);
      expect(await documentRow(created.id)).toMatchObject({ status: 'SUBMITTED' });
      await approve(session);
      expect((await complete(session, LEADER)).status).toBe(200);
      const [row] = await owner<{ status: string; result_version_id: string | null }>('select status, result_version_id from machvon.doc_signing_session where id = $1', [session]);
      expect(row?.status).toBe('EMBEDDED');
      expect(row?.result_version_id).not.toBeNull();
    });

    it('refuses to complete a session that ran out, and a session that is already complete (AC-ST-DOC-005-4)', async () => {
      const created = await seedOutgoing();
      const started = await startLeader(created.id, LEADER);
      const session = started.json.resource_id as string;
      await approve(session);
      app.now = new Date(NOW.getTime() + 16 * MINUTE);
      const late = await complete(session, LEADER);
      expect([late.status, late.json.code]).toEqual([409, 'SIGNING_SESSION_EXPIRED']);
      app.now = NOW;
      expect((await complete(session, LEADER)).status).toBe(200);
      const twice = await complete(session, LEADER, { version: 2 });
      expect([twice.status, twice.json.code]).toEqual([409, 'DOCUMENT_STATE_INVALID']);
    });

    it('refuses a digest that is not the locked one and a signature that is not a signature, and the session stays open', async () => {
      const created = await seedOutgoing();
      const started = await startLeader(created.id, LEADER);
      const session = started.json.resource_id as string;
      await approve(session);
      const wrongDigest = await complete(session, LEADER, { body: { client_digest_hex: 'f'.repeat(64) } });
      expect([wrongDigest.status, wrongDigest.json.code]).toEqual([422, 'DIGEST_MISMATCH']);
      const garbage = await complete(session, LEADER, { body: { cms_signature: Buffer.from('not a signature').toString('base64') } });
      expect([garbage.status, garbage.json.code]).toEqual([422, 'SIGNATURE_INVALID']);
      expect(await documentRow(created.id)).toMatchObject({ status: 'SUBMITTED', version: '1' });
      const [row] = await owner<{ status: string }>('select status from machvon.doc_signing_session where id = $1', [session]);
      expect(row?.status).toBe('AWAITING_SIGNER');
      expect((await complete(session, LEADER, { body: { client_digest_hex: started.json.digest_hex } })).status).toBe(200);
    });

    it('does not accept a signature made with a certificate other than the registered one', async () => {
      const created = await seedOutgoing();
      const started = await startLeader(created.id, LEADER);
      const session = started.json.resource_id as string;
      // The organisation's key signs the leader's digest: valid CMS, wrong signer.
      const port = new MockSigningPort({ identity: world.organization, clock: () => app.now, timestamps: world.tsa });
      const ref = await port.startSession({ digestSha256: started.json.digest_hex as string, certificateFingerprint: fingerprintOf(new X509Certificate(world.organization.certificate)), correlationId: randomUUID() });
      port.approve(ref);
      const payload = await port.collect(ref);
      if (payload === 'PENDING') throw new Error('not approved');
      const reply = await complete(session, LEADER, { body: { cms_signature: Buffer.from(payload.cms).toString('base64') } });
      expect([reply.status, reply.json.code]).toEqual([422, 'SIGNATURE_INVALID']);
    });

    it('does not accept a signature whose chain cannot be completed: INDETERMINATE is not a signature to build on', async () => {
      const identity = await signerWithIncompleteChain('Tran Thi B');
      await registerCertificate(randomUUID(), 'PERSONAL', memberId(DRAFTER), null, 'CN=Tran Thi B', identity.certificate);
      app.signing.register(fingerprintOf(new X509Certificate(identity.certificate)), new MockSigningPort({ identity, clock: () => app.now, timestamps: world.tsa }));
      const created = await seedOutgoing({ drafter: ADMIN, signer: DRAFTER });
      const started = await startLeader(created.id, DRAFTER);
      expect(started.status).toBe(202);
      const session = started.json.resource_id as string;
      await approve(session);
      const reply = await complete(session, DRAFTER);
      expect([reply.status, reply.json.code]).toEqual([422, 'SIGNATURE_INVALID']);
      expect(reply.json.findings).toEqual(['CHAIN_INCOMPLETE']);
      expect(await documentRow(created.id)).toMatchObject({ status: 'SUBMITTED', version: '1' });
      expect(await count('select count(*) as n from machvon.document_version where document_id = $1', [created.documentId])).toBe(1);
    });

    it('leaves no prepared file behind when the provider cannot be reached, however often the call is repeated', async () => {
      const created = await seedOutgoing();
      const preparedBefore = app.files.keys().filter((key) => key.includes('/signing/')).length;
      app.signing.setAvailable(false);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const failed = await startLeader(created.id, LEADER);
        expect([failed.status, failed.json.code]).toEqual([503, 'PROVIDER_UNAVAILABLE']);
      }
      expect(app.files.keys().filter((key) => key.includes('/signing/')).length).toBe(preparedBefore);
      app.signing.setAvailable(true);
      expect((await startLeader(created.id, LEADER)).status).toBe(202);
      expect(app.files.keys().filter((key) => key.includes('/signing/')).length).toBe(preparedBefore + 1);
    });

    it('is for the signer who started the session, and a suspended certificate stops it', async () => {
      const created = await seedOutgoing();
      const started = await startLeader(created.id, LEADER);
      const session = started.json.resource_id as string;
      await approve(session);
      const other = await complete(session, CLERK);
      expect([other.status, other.json.code]).toEqual([422, 'SIGNER_NOT_AUTHORIZED']);
      const [personal] = await owner<{ id: string }>("select id from machvon.signing_certificate where kind = 'PERSONAL' and holder_membership_id = $1", [memberId(LEADER)]);
      await owner("update machvon.signing_certificate set status = 'Suspended', status_reason = 'key lost' where id = $1", [personal?.id]);
      try {
        const suspended = await complete(session, LEADER);
        expect([suspended.status, suspended.json.code]).toEqual([422, 'CERTIFICATE_NOT_ACTIVE']);
      } finally {
        await owner("update machvon.signing_certificate set status = 'Active', status_reason = null where id = $1", [personal?.id]);
      }
      expect((await complete(session, LEADER)).status).toBe(200);
    });

    it('answers a stale session version with a conflict and an unknown session with not found', async () => {
      const created = await seedOutgoing();
      const started = await startLeader(created.id, LEADER);
      const session = started.json.resource_id as string;
      const stale = await complete(session, LEADER, { version: 5 });
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      expect((await complete(randomUUID(), LEADER)).status).toBe(404);
    });
  });

  describe('assignOutgoingDocumentNumber', () => {
    it('hands out the next number of the register to the next document, in order (AC-ST-DOC-005-2)', async () => {
      const register = await openRegister();
      const first = await signAsLeader();
      const second = await signAsLeader();
      expect((await number(first.id, CLERK, 2, { register_id: register })).json).toMatchObject({ number: 1, display_number: '01' });
      expect((await number(second.id, CLERK, 2, { register_id: register })).json).toMatchObject({ number: 2, display_number: '02' });
      expect(await count('select count(*) as n from machvon.document_number_allocation where register_id = $1', [register])).toBe(2);
      expect(await documentRow(first.id)).toMatchObject({ status: 'NUMBERED' });
    });

    it('UAT-AC401 the numbering of a signed decision answers 200 with the next number (42) and the status NUMBERED, the same command with the same key answers the first answer without a new number, and a new key on the numbered document is 409 DOCUMENT_STATE_INVALID with the counter still 42 and one allocation', async () => {
      const register = await openRegister();
      await owner('update machvon.document_number_register set last_number = 41 where id = $1', [register]);
      const signed = await signAsLeader();
      const send = (key: string, version: number) => app.call('POST', `/outgoing-documents/${signed.id}/numbering`, { member: CLERK, ifMatch: `"${version}"`, key, body: { register_id: register } });
      const lastNumber = async (): Promise<number> => (await owner<{ last_number: number }>('select last_number from machvon.document_number_register where id = $1', [register]))[0]?.last_number as number;
      const first = await send('k-401-0000000001', 2);
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({ number: 42, display_number: '42' });
      expect(await documentRow(signed.id)).toMatchObject({ status: 'NUMBERED' });
      expect(await lastNumber()).toBe(42);
      // The same command again, with the same key and body: the first answer, and no new number.
      const replay = await send('k-401-0000000001', 2);
      expect(replay.status).toBe(200);
      expect(replay.json).toEqual(first.json);
      expect(await lastNumber()).toBe(42);
      // A new command, with a new key, for the same document that is NUMBERED: refused, the counter does not move, one allocation exists for the document.
      const again = await send('k-401-0000000002', 3);
      expect([again.status, again.json.code]).toEqual([409, 'DOCUMENT_STATE_INVALID']);
      expect(await lastNumber()).toBe(42);
      expect(await count('select count(*) as n from machvon.document_number_allocation where register_id = $1', [register])).toBe(1);
      // The negative control: a check that wants a second number must fail on the counter.
      expect(() => expect(first.json).toMatchObject({ number: 43 })).toThrow();
    });

    it('refuses a document that is not signed yet, one that is numbered already, and keeps the counter (AC-ST-DOC-005-5)', async () => {
      const register = await openRegister();
      const unsigned = await seedOutgoing();
      const early = await number(unsigned.id, CLERK, 1, { register_id: register });
      expect([early.status, early.json.code]).toEqual([422, 'NUMBERING_BEFORE_SIGNATURE']);
      const done = await numbered(register);
      const again = await number(done.id, CLERK, 3, { register_id: register });
      expect([again.status, again.json.code]).toEqual([409, 'DOCUMENT_STATE_INVALID']);
      const [row] = await owner<{ last_number: number }>('select last_number from machvon.document_number_register where id = $1', [register]);
      expect(row?.last_number).toBe(1);
    });

    it('refuses a register that is closed, of another year, of the wrong direction or out of scope, and spends no number', async () => {
      const signed = await signAsLeader();
      const closed = await openRegister();
      expect((await app.call('POST', `/document-number-registers/${closed}/closure`, { member: ADMIN, ifMatch: '"1"', body: { reason: 'closing the register for the test' } })).status).toBe(200);
      const notOpen = await number(signed.id, CLERK, 2, { register_id: closed });
      expect([notOpen.status, notOpen.json.code]).toEqual([409, 'REGISTER_NOT_OPEN']);
      const lastYear = await openRegister({ year: 2025 });
      const year = await number(signed.id, CLERK, 2, { register_id: lastYear });
      expect([year.status, year.json.code]).toEqual([409, 'REGISTER_YEAR_MISMATCH']);
      const incoming = await openRegister({ direction: 'INCOMING' });
      expect((await number(signed.id, CLERK, 2, { register_id: incoming })).json.code).toBe('VALIDATION_FAILED');
      const otherUnit = await openRegister({ organization_unit_id: unitId(1) });
      expect((await number(signed.id, CLERK, 2, { register_id: otherUnit })).json.code).toBe('VALIDATION_FAILED');
      expect((await number(signed.id, CLERK, 2, { register_id: randomUUID() })).json.code).toBe('VALIDATION_FAILED');
      expect((await number(signed.id, CLERK, 2, {})).json.code).toBe('VALIDATION_FAILED');
      expect((await number(signed.id, CLERK, 2, { register_id: lastYear, issued_on: '2999-01-01' })).json.code).toBe('VALIDATION_FAILED');
      expect(await count('select count(*) as n from machvon.document_number_allocation where document_id = $1', [signed.documentId])).toBe(0);
      expect(await documentRow(signed.id)).toMatchObject({ status: 'SIGNED' });
    });

    it('stops with LEADER_SIGNATURE_BROKEN when the stored file no longer carries a valid leader signature, and spends no number', async () => {
      const signed = await signAsLeader();
      const [signedVersion] = (await versions(signed.documentId)).filter((row) => row.stage === 'LEADER_SIGNED');
      if (signedVersion === undefined) throw new Error('no signed version');
      const original = await bytesOf(signedVersion.object_key);
      const tampered = Buffer.from(original);
      // A byte inside the covered range: the digest no longer matches.
      tampered[20] = tampered[20] === 0x41 ? 0x42 : 0x41;
      const key = `tenants/${TENANT_A}/documents/${signed.documentId}-tampered.pdf`;
      await app.files.put(key, tampered, 'application/pdf');
      await owner('update machvon.document_version set object_key = $2 where id = $1', [signedVersion.id, key]);
      const register = await openRegister();
      const reply = await number(signed.id, CLERK, 2, { register_id: register });
      expect([reply.status, reply.json.code]).toEqual([422, 'LEADER_SIGNATURE_BROKEN']);
      const [row] = await owner<{ last_number: number }>('select last_number from machvon.document_number_register where id = $1', [register]);
      expect(row?.last_number).toBe(0);
    });

    it('stops with LEADER_SIGNATURE_BROKEN when the leader signature is no more than INDETERMINATE, and spends no number', async () => {
      const created = await seedOutgoing();
      const identity = await signerWithIncompleteChain('Le Van C');
      const signed = await signField(pdf, { field: 'sig_leader', identity, signingTime: NOW, timestamps: world.tsa });
      const key = `tenants/${TENANT_A}/documents/${created.documentId}-incomplete-chain.pdf`;
      await app.files.put(key, signed, 'application/pdf');
      await app.harness.tenants.withTenant(ctx(), async (tx) => {
        const version = await store.appendVersion(tx, { documentId: created.documentId, objectKey: key, checksum: sha256(signed), mime: 'application/pdf', pageCount: 1, classification: 'INTERNAL', stage: 'LEADER_SIGNED', byteLength: signed.length, createdBy: ACTOR });
        await store.setScanResult(tx, version.id, 'CLEAN');
      });
      await owner("update machvon.outgoing_document set status = 'SIGNED', leader_signed_at = $2::timestamptz where id = $1", [created.id, new Date(NOW.getTime() - MINUTE).toISOString()]);
      const register = await openRegister();
      const reply = await number(created.id, CLERK, 1, { register_id: register });
      expect([reply.status, reply.json.code]).toEqual([422, 'LEADER_SIGNATURE_BROKEN']);
      const [row] = await owner<{ last_number: number }>('select last_number from machvon.document_number_register where id = $1', [register]);
      expect(row?.last_number).toBe(0);
    });

    it('needs the numbering permission over the unit and hides a document out of scope', async () => {
      const signed = await signAsLeader();
      const register = await openRegister();
      const denied = await number(signed.id, LEADER, 2, { register_id: register });
      expect([denied.status, denied.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const elsewhere = await seedOutgoing({ unit: 1 });
      expect((await number(elsewhere.id, CLERK, 1, { register_id: register })).status).toBe(404);
    });
  });

  describe('startOrganizationSeal', () => {
    it('refuses a document that is not numbered yet and a unit that has no seal certificate', async () => {
      const signed = await signAsLeader();
      const early = await startSeal(signed.id, CLERK, { version: 2 });
      expect([early.status, early.json.code]).toEqual([409, 'DOCUMENT_STATE_INVALID']);
      const done = await numbered();
      const personal = await owner<{ id: string }>("select id from machvon.signing_certificate where kind = 'PERSONAL'");
      const wrongKind = await startSeal(done.id, CLERK, { version: 3, body: { certificate_id: personal[0]?.id } });
      expect([wrongKind.status, wrongKind.json.code]).toEqual([422, 'CERTIFICATE_NOT_ACTIVE']);
    });

    it('keeps the document numbered with its number when the provider fails, and the retry does not take a new number (AC-ST-DOC-005-3, AC-ST-KERNEL-003-2)', async () => {
      const done = await numbered();
      const before = await documentRow(done.id);
      app.signing.setAvailable(false);
      const failed = await startSeal(done.id, CLERK, { version: 3 });
      expect([failed.status, failed.json.code]).toEqual([503, 'PROVIDER_UNAVAILABLE']);
      expect(await documentRow(done.id)).toEqual(before);
      app.signing.setAvailable(true);
      const retried = await startSeal(done.id, CLERK, { version: 3 });
      expect(retried.status).toBe(202);
      expect(await count('select count(*) as n from machvon.document_number_allocation where document_id = $1', [done.documentId])).toBe(1);
      const second = await startSeal(done.id, CLERK, { version: 3 });
      expect([second.status, second.json.code]).toEqual([409, 'SIGNING_SESSION_OPEN']);
    });

    it('leaves a seal session to the clerk who started it', async () => {
      const done = await numbered();
      const started = await startSeal(done.id, CLERK, { version: 3 });
      const session = started.json.resource_id as string;
      await approve(session);
      const other = await complete(session, LEADER);
      expect([other.status, other.json.code]).toEqual([422, 'SIGNER_NOT_AUTHORIZED']);
      expect((await complete(session, CLERK)).status).toBe(200);
    });
  });

  describe('reads', () => {
    it('lists the outgoing documents in the scope of the caller with the filters, and pages', async () => {
      const created = await seedOutgoing();
      const elsewhere = await seedOutgoing({ unit: 1 });
      const all = await app.call('GET', '/outgoing-documents?limit=200', { member: DRAFTER });
      const ids = (all.json.items as Array<{ id: string }>).map((row) => row.id);
      expect(ids).toContain(created.id);
      expect(ids).not.toContain(elsewhere.id);
      const submitted = await app.call('GET', '/outgoing-documents?status=SUBMITTED&doc_type_code=QD&limit=200', { member: DRAFTER });
      expect((submitted.json.items as Array<{ status: string }>).every((row) => row.status === 'SUBMITTED')).toBe(true);
      const page = await app.call('GET', '/outgoing-documents?limit=1', { member: DRAFTER });
      expect(page.json.next_cursor).not.toBeNull();
      const next = await app.call('GET', `/outgoing-documents?limit=1&cursor=${page.json.next_cursor as string}`, { member: DRAFTER });
      expect((next.json.items as Array<{ id: string }>)[0]?.id).not.toBe((page.json.items as Array<{ id: string }>)[0]?.id);
      expect((await app.call('GET', '/outgoing-documents?status=NOPE', { member: DRAFTER })).status).toBe(422);
      expect((await app.call('GET', '/outgoing-documents?year=20x', { member: DRAFTER })).status).toBe(422);
      expect((await app.call('GET', '/outgoing-documents?drafting_unit_id=zz', { member: DRAFTER })).status).toBe(422);
      expect((await app.call('GET', '/outgoing-documents', { member: NOBODY })).status).toBe(403);
    });

    it('shows one document with its sessions, versions, certificates and signatures', async () => {
      const done = await numbered();
      const reply = await app.call('GET', `/outgoing-documents/${done.id}`, { member: DRAFTER });
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ id: done.id, status: 'NUMBERED', document_number: 1, version: 3, signer_user_id: memberId(LEADER) });
      expect((reply.json.sessions as Array<{ role: string; status: string }>).map((row) => [row.role, row.status])).toEqual([['LEADER', 'EMBEDDED']]);
      expect((reply.json.versions as Array<{ stage: string }>).map((row) => row.stage)).toEqual(['NUMBERED', 'LEADER_SIGNED', 'RENDERED_FINAL']);
      expect((reply.json.certificates as Array<{ kind: string; status: string }>).map((row) => [row.kind, row.status]).sort()).toEqual([
        ['ORGANIZATION', 'Active'],
        ['PERSONAL', 'Active'],
      ]);
      expect((reply.json.signatures as Array<{ role: string; status: string }>).map((row) => [row.role, row.status])).toEqual([['LEADER', 'VALID']]);
      expect((await app.call('GET', `/outgoing-documents/${(await seedOutgoing({ unit: 1 })).id}`, { member: DRAFTER })).status).toBe(404);
      expect((await app.call('GET', `/outgoing-documents/${done.id}`, { member: ADMIN, tenantId: TENANT_B })).status).toBe(404);
      expect((await app.call('GET', `/outgoing-documents/${done.id}`, { member: NOBODY })).status).toBe(403);
    });
  });
});
