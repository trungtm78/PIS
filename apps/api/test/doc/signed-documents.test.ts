import { createHash, randomUUID } from 'node:crypto';
import { PdfLibRenderer } from '../../src/modules/doc/pdf-renderer';
import { applyNumbering } from '../../src/modules/doc/numbering-revision';
import { MockCertificateAuthority } from '../../src/modules/doc/mock-pki';
import type { Identity } from '../../src/modules/doc/mock-pki';
import { eicarBytes } from '../../src/modules/files/mock-scan';
import { CLERK, DRAFTER, EXT_CLERK, EXT_OUTSIDE, LEADER, MAKER, NOBODY, NOW, REFERENCER, REVIEWER, TENANT_A, TENANT_B, memberId, unitId } from './doc-app';
import { FlowWorld, payloadOf } from './support/flow-world';
import { signField } from './support/pdf-fixture';
import { sampleRequest } from './render-fixture';
import type { Reply } from './doc-app';

jest.setTimeout(240_000);

const flow = new FlowWorld();
const { app } = flow;
const owner = <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => app.harness.owner<T>(TENANT_A, [[sql, params]]);
const count = (sql: string, params: unknown[] = []): Promise<number> => app.count(sql, params);
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const tenantOf = (member: number, tenantId: string = TENANT_A) => ({ tenantId, membershipId: memberId(member), scopeVersion: 1 });
const HOUR = 60 * 60 * 1000;
const SIGNED_AT = new Date(NOW.getTime() - 24 * HOUR);
let base: Buffer;
let strangerCa: MockCertificateAuthority;
let stranger: Identity;

/** Puts a file through the shared upload pipeline, the way the screen will: judged by its bytes, scanned, stored under the tenant. */
async function upload(bytes: Uint8Array, tenantId: string = TENANT_A): Promise<{ key: string; sha: string; scan: string }> {
  const stored = await app.uploads.upload(tenantOf(EXT_CLERK, tenantId), { purpose: 'document', declaredType: 'application/pdf', bytes });
  return { key: stored.key, sha: sha256(bytes), scan: stored.scanStatus };
}

async function signedAs(pdf: Uint8Array, field: string, identity: Identity, options: { at?: Date; timestamp?: boolean } = {}): Promise<Buffer> {
  const at = options.at ?? SIGNED_AT;
  flow.world.setTime(at);
  try {
    return await signField(pdf, { field, identity, signingTime: at, ...(options.timestamp === false ? {} : { timestamps: flow.world.tsa }) });
  } finally {
    flow.world.setTime(NOW);
  }
}

/** A document the way it comes from another system: signed by the leader, numbered, sealed by the organisation, with the number printed in its form fields. */
async function externalFile(options: { number: number; symbol?: string; at?: Date; timestamp?: boolean; leader?: Identity; seal?: Identity | null; printed?: boolean } = { number: 1 }): Promise<Buffer> {
  const at = options.at ?? SIGNED_AT;
  const leader = options.leader ?? flow.world.leader;
  let pdf = await signedAs(base, 'sig_leader', leader, { at, ...(options.timestamp === undefined ? {} : { timestamp: options.timestamp }) });
  const symbol = options.symbol ?? `${options.number}/QD-UBND`;
  if (options.printed !== false) pdf = applyNumbering(pdf, { docNumber: String(options.number), docSymbol: symbol, docDate: '22/10/2026' }).pdf;
  if (options.seal === null) return pdf;
  return signedAs(pdf, 'sig_org', options.seal ?? flow.world.organization, { at: new Date(at.getTime() + HOUR), ...(options.timestamp === undefined ? {} : { timestamp: options.timestamp }) });
}

function registration(file: { key: string; sha: string }, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    doc_type_code: 'QD',
    title: 'Decision signed in another system',
    file_object_key: file.key,
    file_sha256: file.sha,
    declared_number: 128,
    declared_symbol: '128/QD-UBND',
    declared_issued_on: '2026-10-22',
    register_id: '',
    drafting_unit_id: unitId(2),
    recipients: [{ name: 'Department of Finance' }],
    ...overrides,
  };
}

const register = (body: Record<string, unknown>, member: number = EXT_CLERK, key?: string): Promise<Reply> =>
  app.call('POST', '/outgoing-documents/external-registrations', { member, body, ...(key === undefined ? {} : { key }) });
const uploadSigned = (id: string, version: number, body: Record<string, unknown>, member: number = EXT_CLERK): Promise<Reply> =>
  app.call('POST', `/outgoing-documents/${id}/signed-uploads`, { member, ifMatch: `"${version}"`, body });

async function finalPdf(documentId: string): Promise<Buffer> {
  const [row] = await owner<{ object_key: string }>("select object_key from machvon.document_version where document_id = $1 and stage = 'RENDERED_FINAL' order by version desc limit 1", [documentId]);
  const file = await app.files.get(row?.object_key ?? '');
  if (file === undefined) throw new Error('no final PDF');
  return Buffer.from(file.bytes);
}

/** A document that waits for the leader: created, sent for review and approved. */
async function waiting(overrides: Record<string, unknown> = {}): Promise<{ id: string; documentId: string; version: number }> {
  const made = await flow.create({
    doc_type_code: 'QD',
    template_code: 'QD-DEFAULT',
    title: 'Decision to be signed outside',
    drafting_unit_id: unitId(2),
    payload: payloadOf(),
    recipients: [{ name: 'Department of Finance' }],
    signer_user_id: memberId(LEADER),
    ...overrides,
  });
  expect(made.status).toBe(200);
  const id = made.json.resource_id as string;
  expect((await flow.submit(id, 1)).status).toBe(200);
  const approved = await flow.approve(id, 2);
  expect(approved.status).toBe(200);
  return { id, documentId: made.json.document_id as string, version: approved.json.resource_version as number };
}

const row = async (id: string): Promise<{ status: string; route: string; version: string; leader_signed_at: Date | null }> => {
  const [found] = await owner<{ status: string; route: string; version: string; leader_signed_at: Date | null }>('select status, route, version::text as version, leader_signed_at from machvon.outgoing_document where id = $1', [id]);
  if (found === undefined) throw new Error('no document');
  return found;
};
const versionCount = (documentId: string): Promise<number> => count('select count(*) as n from machvon.document_version where document_id = $1', [documentId]);

describe('documents signed outside the system (ST-DOC-009)', () => {
  beforeAll(async () => {
    await flow.start();
    base = Buffer.from((await new PdfLibRenderer().render({ ...sampleRequest(), signatureFields: true })).bytes);
    strangerCa = await MockCertificateAuthority.createRoot({ commonName: 'Stranger CA', notBefore: new Date('2026-01-01T00:00:00Z'), notAfter: new Date('2040-01-01T00:00:00Z') });
    stranger = await strangerCa.issue({ commonName: 'Somebody Else', notBefore: new Date('2026-01-01T00:00:00Z'), notAfter: new Date('2030-01-01T00:00:00Z') });
  }, 300_000);

  afterAll(() => flow.stop(), 60_000);
  afterEach(() => flow.reset());

  describe('uploadLeaderSignedDocument', () => {
    it('takes the file the leader signed with their own tool when the signing time is proven, and refuses the one whose time nobody proved: the document stays SUBMITTED (AC-ST-DOC-009-2, UAT-AC406)', async () => {
      const waits = await waiting();
      const approved = await finalPdf(waits.documentId);
      const untimed = await upload(await signedAs(approved, 'sig_leader', flow.world.leader, { timestamp: false }));
      const refused = await uploadSigned(waits.id, waits.version, { file_object_key: untimed.key, file_sha256: untimed.sha });
      expect([refused.status, refused.json.code]).toEqual([422, 'SIGNING_TIME_UNPROVEN']);
      expect(refused.json.findings).toContain('SIGNING_TIME_UNPROVEN');
      expect(await row(waits.id)).toMatchObject({ status: 'SUBMITTED', route: 'IN_SYSTEM' });
      expect(await versionCount(waits.documentId)).toBe(1);

      const timed = await upload(await signedAs(approved, 'sig_leader', flow.world.leader));
      const accepted = await uploadSigned(waits.id, waits.version, { file_object_key: timed.key, file_sha256: timed.sha, declared_signer_user_id: memberId(LEADER).toUpperCase() });
      expect(accepted.status).toBe(200);
      expect(accepted.json).toMatchObject({ status: 'SIGNED', route: 'EXTERNAL_UPLOAD', file_sha256: timed.sha, signature_status: 'VALID', resource_version: waits.version + 1 });
      expect(await row(waits.id)).toMatchObject({ status: 'SIGNED', route: 'EXTERNAL_UPLOAD' });
      // The leader signed a day before the upload, and the document remembers when.
      expect((await row(waits.id)).leader_signed_at?.toISOString()).toBe(SIGNED_AT.toISOString());
      const versions = await owner<{ stage: string; scan_status: string; prefix_sha256: string; classification: string }>('select stage, scan_status, prefix_sha256, classification from machvon.document_version where document_id = $1 order by version', [waits.documentId]);
      expect(versions.map((version) => [version.stage, version.scan_status, version.classification])).toEqual([['RENDERED_FINAL', 'CLEAN', 'INTERNAL'], ['LEADER_SIGNED', 'CLEAN', 'INTERNAL']]);
      expect(versions[1]?.prefix_sha256).toBe(sha256(approved));
      const signatures = await owner<{ role: string; verification_status: string; trust_regime: string }>('select role, verification_status, trust_regime from machvon.document_signature s join machvon.document_version v on v.id = s.document_version_id where v.document_id = $1', [waits.documentId]);
      expect(signatures).toEqual([{ role: 'LEADER', verification_status: 'VALID', trust_regime: 'PUBLIC_CA' }]);
      const events = await owner<{ type: string; payload: Record<string, unknown> }>("select type, payload from machvon.outbox_event where aggregate_id = $1 and type = 'doc.signed.v1'", [waits.id]);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({ route: 'EXTERNAL_UPLOAD', signed_at: SIGNED_AT.toISOString() });
      const history = await owner<{ kind: string }>('select kind from machvon.outgoing_document_event where outgoing_document_id = $1 order by seq', [waits.id]);
      expect(history.map((entry) => entry.kind)).toEqual(['CREATED', 'REVIEW_REQUESTED', 'REVIEW_APPROVED', 'SIGNED_UPLOADED']);
      expect(await count("select count(*) as n from machvon.audit_event where resource_id = $1 and action = 'outgoing_document.signed_upload' and outcome = 'SUCCESS'", [waits.id])).toBe(1);
    });

    it('goes on to be numbered and sealed in the system: the uploaded file is the one the numbering works on', async () => {
      const waits = await waiting();
      const signed = await upload(await signedAs(await finalPdf(waits.documentId), 'sig_leader', flow.world.leader));
      const accepted = await uploadSigned(waits.id, waits.version, { file_object_key: signed.key, file_sha256: signed.sha });
      expect(accepted.status).toBe(200);
      const registerId = await flow.openRegister();
      const numbered = await app.call('POST', `/outgoing-documents/${waits.id}/numbering`, { member: CLERK, ifMatch: `"${accepted.json.resource_version as number}"`, body: { register_id: registerId } });
      expect(numbered.status).toBe(200);
      expect(numbered.json).toMatchObject({ status: 'NUMBERED' });
      // The number may not come before the signature, and it does not: the day of the signature is the earliest day of issue.
      expect(String(numbered.json.issued_on) >= '2026-10-22').toBe(true);
    });

    it('ends a signing session that was still open in the system, with the provider told', async () => {
      const waits = await waiting();
      const started = await app.call('POST', `/outgoing-documents/${waits.id}/leader-signing-sessions`, { member: LEADER, ifMatch: `"${waits.version}"`, body: {} });
      expect(started.status).toBe(202);
      const signed = await upload(await signedAs(await finalPdf(waits.documentId), 'sig_leader', flow.world.leader));
      const accepted = await uploadSigned(waits.id, waits.version, { file_object_key: signed.key, file_sha256: signed.sha });
      expect(accepted.status).toBe(200);
      const [session] = await owner<{ status: string }>('select status from machvon.doc_signing_session where id = $1', [started.json.resource_id]);
      expect(session?.status).toBe('CANCELLED');
      const late = await app.call('POST', `/signing-sessions/${started.json.resource_id as string}/completion`, { member: LEADER, ifMatch: '"1"', body: {} });
      expect(late.status).toBeGreaterThanOrEqual(400);
    });

    it('refuses a file that is not what the leader was shown, or that cannot be relied on, each with its own reason and nothing written', async () => {
      const waits = await waiting();
      const other = await waiting({ title: 'Another decision', payload: payloadOf({ body: 'Quite another text of the decision.' }) });
      const approved = await finalPdf(waits.documentId);
      const signedOther = await signedAs(await finalPdf(other.documentId), 'sig_leader', flow.world.leader);
      const good = await signedAs(approved, 'sig_leader', flow.world.leader);
      const tampered = Buffer.from(good);
      tampered[approved.length + 40] = (tampered[approved.length + 40] ?? 0) ^ 0xff;
      const cases: Array<[string, Buffer, number, string, Record<string, unknown>?]> = [
        ['a signature on another document (content that was not approved)', signedOther, 422, 'SIGNED_CONTENT_MISMATCH'],
        ['the approved file itself with no signature', approved, 422, 'SIGNED_CONTENT_MISMATCH'],
        ['a signed file that was changed after it was signed', tampered, 422, 'SIGNATURE_INVALID'],
        ['a signature by an authority the tenant does not trust', await signedAs(approved, 'sig_leader', stranger), 422, 'CERTIFICATE_CHAIN_UNTRUSTED'],
        ['a signature made with a certificate of somebody else', await signedAs(approved, 'sig_leader', flow.world.organization), 422, 'SIGNER_NOT_AUTHORIZED', { reason: 'SIGNER_IDENTITY_MISMATCH' }],
        ['a signature in a field that is not the leader field', await signedAs(approved, 'sig_org', flow.world.leader), 422, 'SIGNATURE_INVALID'],
        ['two signatures where the leader signs once', await signedAs(good, 'sig_org', flow.world.organization), 422, 'SIGNATURE_INVALID'],
      ];
      for (const [name, bytes, status, code, extra] of cases) {
        const file = await upload(bytes);
        const reply = await uploadSigned(waits.id, waits.version, { file_object_key: file.key, file_sha256: file.sha });
        expect([name, reply.status, reply.json.code]).toEqual([name, status, code]);
        if (extra !== undefined) expect(reply.json).toMatchObject(extra);
      }
      expect(await row(waits.id)).toMatchObject({ status: 'SUBMITTED', version: String(waits.version) });
      expect(await versionCount(waits.documentId)).toBe(1);
    });

    it('refuses what the pipeline refuses: a file that is not a PDF, an infected file, one that is still being scanned, a hash that is not the file, a key of another tenant', async () => {
      const waits = await waiting();
      const text = await app.uploads.upload(tenantOf(EXT_CLERK), { purpose: 'document', declaredType: 'application/pdf', bytes: Buffer.from('%PDF-1.4 but the rest is not a document') });
      // A file is a PDF by its first bytes AND by being readable as one.
      const notReadable = await uploadSigned(waits.id, waits.version, { file_object_key: text.key, file_sha256: sha256(Buffer.from('%PDF-1.4 but the rest is not a document')) });
      expect(notReadable.status).toBe(422);
      const infected = await app.uploads.upload(tenantOf(EXT_CLERK), { purpose: 'document', declaredType: 'application/pdf', bytes: Buffer.concat([Buffer.from('%PDF-1.4\n'), eicarBytes()]) });
      expect(infected.scanStatus).toBe('INFECTED');
      const virus = await uploadSigned(waits.id, waits.version, { file_object_key: infected.key, file_sha256: sha256(Buffer.concat([Buffer.from('%PDF-1.4\n'), eicarBytes()])) });
      expect([virus.status, virus.json.code]).toEqual([422, 'FILE_NOT_CLEAN']);
      const pdf = await signedAs(await finalPdf(waits.documentId), 'sig_leader', flow.world.leader);
      const pending = await app.objects.put(tenantOf(EXT_CLERK), `tenants/${TENANT_A}/document/${randomUUID()}`, pdf, { contentType: 'application/pdf' });
      const waitsForScan = await uploadSigned(waits.id, waits.version, { file_object_key: pending.key, file_sha256: pending.sha256 });
      expect([waitsForScan.status, waitsForScan.json.code]).toEqual([409, 'SCAN_PENDING']);
      const clean = await upload(pdf);
      const wrongHash = await uploadSigned(waits.id, waits.version, { file_object_key: clean.key, file_sha256: 'e'.repeat(64) });
      expect([wrongHash.status, wrongHash.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const foreign = await app.uploads.upload(tenantOf(EXT_CLERK, TENANT_B), { purpose: 'document', declaredType: 'application/pdf', bytes: pdf });
      const crossTenant = await uploadSigned(waits.id, waits.version, { file_object_key: foreign.key, file_sha256: sha256(pdf) });
      expect([crossTenant.status, crossTenant.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      // Not a PDF at all: a plain text file is judged by the pipeline before DOC sees it.
      await expect(app.uploads.upload(tenantOf(EXT_CLERK), { purpose: 'document', declaredType: 'application/pdf', bytes: Buffer.from('plain text, not a document') })).rejects.toMatchObject({ code: 'FILE_TYPE_NOT_ALLOWED' });
      expect(await row(waits.id)).toMatchObject({ status: 'SUBMITTED' });
    });

    it('answers the state, the version, the signer, the drafter and the scope of the caller before it looks at the file', async () => {
      const waits = await waiting();
      const pdf = await signedAs(await finalPdf(waits.documentId), 'sig_leader', flow.world.leader);
      const file = await upload(pdf);
      const body = { file_object_key: file.key, file_sha256: file.sha };
      const stale = await uploadSigned(waits.id, waits.version + 5, body);
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const other = await uploadSigned(waits.id, waits.version, { ...body, declared_signer_user_id: memberId(CLERK) });
      expect([other.status, other.json.code, other.json.reason]).toEqual([422, 'SIGNER_NOT_AUTHORIZED', 'SIGNER_DECLARED_OTHER']);
      const denied = await uploadSigned(waits.id, waits.version, body, EXT_OUTSIDE);
      expect(denied.status).toBe(404);
      const nobody = await uploadSigned(waits.id, waits.version, body, NOBODY);
      expect([nobody.status, nobody.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const draft = await flow.create({ doc_type_code: 'QD', template_code: 'QD-DEFAULT', title: 'Still a draft', drafting_unit_id: unitId(2), payload: payloadOf() });
      const early = await uploadSigned(draft.json.resource_id as string, 1, body);
      expect([early.status, early.json.code]).toEqual([409, 'DOCUMENT_STATE_INVALID']);
      expect(await row(waits.id)).toMatchObject({ status: 'SUBMITTED' });
    });

    it('does not take the leader signature from the person who drafted the document', async () => {
      const drafted = await flow.create({ doc_type_code: 'QD', template_code: 'QD-DEFAULT', title: 'Drafted by the uploader', drafting_unit_id: unitId(2), payload: payloadOf(), recipients: [{ name: 'Somebody' }], signer_user_id: memberId(LEADER) }, EXT_CLERK);
      expect(drafted.status).toBe(403);
      // The clerk holds no drafting permission here; the drafter in this world is MAKER, who has no upload permission either.
      const waits = await waiting();
      const file = await upload(await signedAs(await finalPdf(waits.documentId), 'sig_leader', flow.world.leader));
      const asDrafter = await uploadSigned(waits.id, waits.version, { file_object_key: file.key, file_sha256: file.sha }, MAKER);
      expect(asDrafter.status).toBe(403);
      await app.harness.owner(TENANT_A, [["update machvon.outgoing_document set drafter_user_id = $2 where id = $1", [waits.id, memberId(EXT_CLERK)]]]);
      const own = await uploadSigned(waits.id, waits.version, { file_object_key: file.key, file_sha256: file.sha });
      expect([own.status, own.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
    });
  });

  describe('registerExternallySignedDocument', () => {
    it('enters a document numbered elsewhere in a mirrored register, refuses the number a second time and a tampered file, and announces the issue once (AC-ST-DOC-009-1, UAT-AC417)', async () => {
      const registerId = await flow.openRegister({ mode: 'MIRRORED' });
      await owner("update machvon.document_number_register set last_number = 127 where id = $1", [registerId]);
      const ext1 = await upload(await externalFile({ number: 128 }));
      const issued = await register(registration(ext1, { register_id: registerId }));
      expect(issued.status).toBe(200);
      expect(issued.json).toMatchObject({ status: 'ISSUED', route: 'EXTERNAL_UPLOAD', number: 128, symbol: '128/QD-UBND', issued_on: '2026-10-22', file_sha256: ext1.sha });
      const id = issued.json.resource_id as string;
      expect(await row(id)).toMatchObject({ status: 'ISSUED', route: 'EXTERNAL_UPLOAD' });
      const [registerRow] = await owner<{ last_number: number }>('select last_number from machvon.document_number_register where id = $1', [registerId]);
      expect(registerRow?.last_number).toBe(128);

      const again = await upload(await externalFile({ number: 128, at: new Date(SIGNED_AT.getTime() + 60_000) }));
      const duplicate = await register(registration(again, { register_id: registerId }));
      expect([duplicate.status, duplicate.json.code]).toEqual([409, 'NUMBER_ALREADY_REGISTERED']);

      const good = await externalFile({ number: 129 });
      const broken = Buffer.from(good);
      broken[200] = (broken[200] ?? 0) ^ 0xff;
      const tampered = await upload(broken);
      const refused = await register(registration(tampered, { register_id: registerId, declared_number: 129, declared_symbol: '129/QD-UBND' }));
      expect([refused.status, refused.json.code]).toEqual([422, 'SIGNATURE_INVALID']);
      // The tampered file is refused for the signature even when its number is the one that is taken.
      expect((await register(registration(tampered, { register_id: registerId }))).json.code).toBe('SIGNATURE_INVALID');

      const events = await owner<{ type: string; payload: Record<string, unknown> }>("select type, payload from machvon.outbox_event where type = 'doc.issued.v1' and aggregate_id = $1", [id]);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({ document_number: 128, symbol: '128/QD-UBND', issued_on: '2026-10-22', file_sha256: ext1.sha, route: 'EXTERNAL_UPLOAD', source_ref: null });
      expect(await count("select count(*) as n from machvon.outgoing_document where route = 'EXTERNAL_UPLOAD' and status = 'ISSUED' and register_id = $1", [registerId])).toBe(1);

      // The document is what a source module may rely on, with its number in the register log.
      const documentId = issued.json.document_id as string;
      const usable = await app.call('GET', `/documents/${documentId}/usability`, { member: REFERENCER });
      expect(usable.json).toMatchObject({ usable: true, effect_status: 'EFFECTIVE', symbol: '128/QD-UBND', document_number: 128, number_year: 2026 });
      const entries = await app.call('GET', `/document-number-registers/${registerId}/entries`, { member: EXT_CLERK });
      expect(entries.status).toBe(200);
      expect((entries.json.items as Array<{ number: number; symbol: string }>).map((entry) => [entry.number, entry.symbol])).toEqual([[128, '128/QD-UBND']]);
      const versions = await owner<{ stage: string; scan_status: string }>('select stage, scan_status from machvon.document_version where document_id = $1', [documentId]);
      expect(versions).toEqual([{ stage: 'ORG_SEALED', scan_status: 'CLEAN' }]);
      const signatures = await owner<{ role: string; verification_status: string }>('select s.role, s.verification_status from machvon.document_signature s join machvon.document_version v on v.id = s.document_version_id where v.document_id = $1 order by s.signature_index', [documentId]);
      expect(signatures).toEqual([{ role: 'LEADER', verification_status: 'VALID' }, { role: 'ORGANIZATION', verification_status: 'VALID' }]);
      const history = await owner<{ kind: string; to_status: string }>('select kind, to_status from machvon.outgoing_document_event where outgoing_document_id = $1', [id]);
      expect(history).toEqual([{ kind: 'EXTERNALLY_REGISTERED', to_status: 'ISSUED' }]);
    });

    it('lets a mirrored register take a number below its counter that is still free, and keeps the counter where it was', async () => {
      const registerId = await flow.openRegister({ mode: 'MIRRORED' });
      await owner('update machvon.document_number_register set last_number = 40 where id = $1', [registerId]);
      const file = await upload(await externalFile({ number: 12 }));
      const reply = await register(registration(file, { register_id: registerId, declared_number: 12, declared_symbol: '12/QD-UBND' }));
      expect(reply.status).toBe(200);
      const [counter] = await owner<{ last_number: number }>('select last_number from machvon.document_number_register where id = $1', [registerId]);
      expect(counter?.last_number).toBe(40);
      const taken = await upload(await externalFile({ number: 12, at: new Date(SIGNED_AT.getTime() + 120_000) }));
      expect((await register(registration(taken, { register_id: registerId, declared_number: 12, declared_symbol: '12/QD-UBND' }))).json.code).toBe('NUMBER_ALREADY_REGISTERED');
    });

    it('asks a managed register for the next number, and then moves it on', async () => {
      const registerId = await flow.openRegister({ mode: 'MANAGED' });
      const skipped = await upload(await externalFile({ number: 3 }));
      const refused = await register(registration(skipped, { register_id: registerId, declared_number: 3, declared_symbol: '3/QD-UBND' }));
      expect([refused.status, refused.json.code]).toEqual([409, 'REGISTER_MODE_MISMATCH']);
      const next = await upload(await externalFile({ number: 1 }));
      const accepted = await register(registration(next, { register_id: registerId, declared_number: 1, declared_symbol: '1/QD-UBND' }));
      expect(accepted.status).toBe(200);
      const [counter] = await owner<{ last_number: number }>('select last_number from machvon.document_number_register where id = $1', [registerId]);
      expect(counter?.last_number).toBe(1);
    });

    it('answers the same call with the same key once, and enters nothing twice', async () => {
      const registerId = await flow.openRegister({ mode: 'MIRRORED' });
      const file = await upload(await externalFile({ number: 55 }));
      const body = registration(file, { register_id: registerId, declared_number: 55, declared_symbol: '55/QD-UBND' });
      const key = `external-${randomUUID()}`;
      const first = await register(body, EXT_CLERK, key);
      const second = await register(body, EXT_CLERK, key);
      expect(second.json.resource_id).toBe(first.json.resource_id);
      expect(await count("select count(*) as n from machvon.document_number_allocation where register_id = $1", [registerId])).toBe(1);
      expect(await count("select count(*) as n from machvon.outbox_event where type = 'doc.issued.v1' and payload->>'symbol' = '55/QD-UBND'")).toBe(1);
    });

    it.each([
      ['a signing time nobody proved', { timestamp: false }, 422, 'SIGNING_TIME_UNPROVEN'],
      ['an authority the tenant does not trust', { leader: 'stranger', seal: 'stranger' }, 422, 'CERTIFICATE_CHAIN_UNTRUSTED'],
      ['a file with one signature only', { seal: null }, 422, 'SIGNATURE_INVALID'],
    ] as const)('refuses a file with %s', async (_name, variant, status, code) => {
      const registerId = await flow.openRegister({ mode: 'MIRRORED' });
      const file = await upload(
        await externalFile({
          number: 70,
          ...('timestamp' in variant ? { timestamp: variant.timestamp } : {}),
          ...('leader' in variant ? { leader: stranger } : {}),
          ...('seal' in variant ? { seal: variant.seal === 'stranger' ? stranger : null } : {}),
        }),
      );
      const reply = await register(registration(file, { register_id: registerId, declared_number: 70, declared_symbol: '70/QD-UBND' }));
      expect([reply.status, reply.json.code]).toEqual([status, code]);
      expect(await count('select count(*) as n from machvon.document_number_allocation where register_id = $1', [registerId])).toBe(0);
    });

    it('refuses a file whose last signature does not cover the whole file, and one that says another number than the clerk declared', async () => {
      const registerId = await flow.openRegister({ mode: 'MIRRORED' });
      const sealed = await externalFile({ number: 80 });
      const trailing = await upload(Buffer.concat([sealed, Buffer.from('\n% a comment added after the seal\n')]));
      const open = await register(registration(trailing, { register_id: registerId, declared_number: 80, declared_symbol: '80/QD-UBND' }));
      expect([open.status, open.json.code]).toEqual([422, 'SIGNATURE_INVALID']);
      const file = await upload(sealed);
      for (const [field, change] of [
        ['declared_number', { declared_number: 81, declared_symbol: '81/QD-UBND' }],
        ['declared_symbol', { declared_symbol: '80/QD-OTHER' }],
        ['declared_issued_on', { declared_issued_on: '2026-10-21' }],
      ] as const) {
        const reply = await register(registration(file, { register_id: registerId, declared_number: 80, declared_symbol: '80/QD-UBND', ...(change as Record<string, unknown>) }));
        expect([reply.status, reply.json.code, field]).toEqual([422, 'VALIDATION_FAILED', field]);
        expect(reply.json.reason).toBe('DECLARED_DIFFERS_FROM_FILE');
      }
      // A file that prints no number is taken at the word of the clerk: the signatures are what is verified.
      const unprinted = await upload(await externalFile({ number: 82, printed: false }));
      expect((await register(registration(unprinted, { register_id: registerId, declared_number: 82, declared_symbol: '82/QD-UBND' }))).status).toBe(200);
    });

    it('checks what the clerk declared against the register and the document type before it looks at the signatures', async () => {
      const registerId = await flow.openRegister({ mode: 'MIRRORED' });
      const lastYear = await flow.openRegister({ mode: 'MIRRORED', year: 2025 });
      const file = await upload(await externalFile({ number: 90 }));
      const ok = { register_id: registerId, declared_number: 90, declared_symbol: '90/QD-UBND' };
      const cases: Array<[string, Record<string, unknown>, number, string]> = [
        ['a symbol that is not a symbol', { declared_symbol: 'QD-UBND/90' }, 422, 'SYMBOL_FORMAT_INVALID'],
        ['a symbol of another number', { declared_symbol: '91/QD-UBND' }, 422, 'SYMBOL_FORMAT_INVALID'],
        ['a date in the future', { declared_issued_on: '2026-10-24' }, 422, 'VALIDATION_FAILED'],
        ['a date that does not exist', { declared_issued_on: '2026-02-30' }, 422, 'VALIDATION_FAILED'],
        ['a number that is not positive', { declared_number: 0, declared_symbol: '0/QD-UBND' }, 422, 'VALIDATION_FAILED'],
        ['a date before the document type came into force', { declared_issued_on: '2025-12-31' }, 422, 'VALIDATION_FAILED'],
        ['a register of another year', { register_id: lastYear }, 409, 'REGISTER_YEAR_MISMATCH'],
        ['a document type the register does not number', { doc_type_code: 'BC' }, 422, 'VALIDATION_FAILED'],
        ['a document type that does not exist', { doc_type_code: 'ZZ' }, 422, 'VALIDATION_FAILED'],
        ['a register that does not exist', { register_id: randomUUID() }, 422, 'VALIDATION_FAILED'],
        ['a drafting unit that does not exist', { drafting_unit_id: randomUUID() }, 422, 'VALIDATION_FAILED'],
        ['a subject module without an id', { subject_module: 'PRJ' }, 422, 'SUBJECT_REF_INVALID'],
        ['a subject id without a module', { subject_id: randomUUID() }, 422, 'SUBJECT_REF_INVALID'],
        ['a recipient without a name', { recipients: [{ name: ' ' }] }, 422, 'VALIDATION_FAILED'],
      ];
      for (const [name, change, status, code] of cases) {
        const reply = await register(registration(file, { ...ok, ...change }));
        expect([name, reply.status, reply.json.code]).toEqual([name, status, code]);
      }
      await app.call('POST', `/document-number-registers/${registerId}/closure`, { member: 1, ifMatch: '"1"', body: { reason: 'closed for the year' } });
      const closed = await register(registration(file, ok));
      expect([closed.status, closed.json.code]).toEqual([409, 'REGISTER_NOT_OPEN']);
      expect(await count('select count(*) as n from machvon.document_number_allocation where register_id = $1', [registerId])).toBe(0);
    });

    it('enters nothing for a caller outside the unit or without the permission, and carries the subject and the recipients of the clerk when they are right', async () => {
      const registerId = await flow.openRegister({ mode: 'MIRRORED' });
      const file = await upload(await externalFile({ number: 100 }));
      const body = registration(file, { register_id: registerId, declared_number: 100, declared_symbol: '100/QD-UBND' });
      expect((await register(body, EXT_OUTSIDE)).json.code).toBe('SCOPE_DENIED');
      expect((await register(body, NOBODY)).json.code).toBe('SCOPE_DENIED');
      expect((await register(body, DRAFTER)).json.code).toBe('SCOPE_DENIED');
      const subject = randomUUID();
      const accepted = await register({ ...body, subject_module: 'PRJ', subject_id: subject.toUpperCase(), recipients: [{ name: 'Department of Finance' }, { name: 'Archive', kind: 'INTERNAL_UNIT', unit_id: unitId(2) }] });
      expect(accepted.status).toBe(200);
      const [anchor] = await owner<{ subject_module: string; subject_id: string; classification: string; issuer_unit_id: string; title: string }>('select subject_module, subject_id, classification, issuer_unit_id, title from machvon.document where id = $1', [accepted.json.document_id]);
      expect(anchor).toMatchObject({ subject_module: 'PRJ', subject_id: subject, classification: 'INTERNAL', issuer_unit_id: unitId(2), title: 'Decision signed in another system' });
      const detail = await app.call('GET', `/outgoing-documents/${accepted.json.resource_id as string}`, { member: EXT_CLERK });
      expect(detail.json.recipients).toEqual([{ kind: 'EXTERNAL_AGENCY', name: 'Department of Finance' }, { kind: 'INTERNAL_UNIT', name: 'Archive', unit_id: unitId(2) }]);
      expect(detail.json).toMatchObject({ status: 'ISSUED', route: 'EXTERNAL_UPLOAD', symbol: '100/QD-UBND', effect_status: 'EFFECTIVE' });
    });

    it('keeps the register log honest when two clerks enter the same number at once: one wins, the other is told', async () => {
      const registerId = await flow.openRegister({ mode: 'MIRRORED' });
      const first = await upload(await externalFile({ number: 200 }));
      const second = await upload(await externalFile({ number: 200, at: new Date(SIGNED_AT.getTime() + 300_000) }));
      const [one, two] = await Promise.all([
        register(registration(first, { register_id: registerId, declared_number: 200, declared_symbol: '200/QD-UBND' })),
        register(registration(second, { register_id: registerId, declared_number: 200, declared_symbol: '200/QD-UBND' })),
      ]);
      expect([one.status, two.status].sort()).toEqual([200, 409]);
      expect([one, two].find((reply) => reply.status === 409)?.json.code).toBe('NUMBER_ALREADY_REGISTERED');
      expect(await count('select count(*) as n from machvon.document_number_allocation where register_id = $1', [registerId])).toBe(1);
    });
  });

  it('keeps the people apart: the reviewer and the maker of the other flows cannot take in a signed file', async () => {
    const registerId = await flow.openRegister({ mode: 'MIRRORED' });
    const file = await upload(await externalFile({ number: 300 }));
    for (const member of [REVIEWER, MAKER]) {
      expect((await register(registration(file, { register_id: registerId, declared_number: 300, declared_symbol: '300/QD-UBND' }), member)).status).toBe(403);
    }
  });
});
