import { randomUUID } from 'node:crypto';
import { MockCertificateAuthority } from '../../src/modules/doc/mock-pki';
import { appendRevision } from '../../src/modules/doc/pdf-incremental';
import { ISSUED_SIGNATURE_REVOKED_ALERT, recheckIssuedRevocation } from '../../src/modules/doc/revocation-recheck';
import { ISSUER, ISSUER_DISTRIBUTOR, LEADER, LEGAL_ISSUER, LEGAL_UNIT, NOBODY, NOW, TENANT_A, memberId, unitId } from './doc-app';
import type { Reply } from './doc-app';
import { FlowWorld, payloadOf } from './support/flow-world';
import { revisionZero, signField, withNumbering } from './support/pdf-fixture';
import { pageTexts } from './support/pdf-pages-text';
import { EXTERNAL_RECIPIENT, replaceSealedFile, sealedBytes, sealedDocument, sha256 } from './support/sealed-documents';
import type { Sealed } from './support/sealed-documents';

jest.setTimeout(240_000);

const flow = new FlowWorld();
const { app } = flow;
const owner = <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => app.harness.owner<T>(TENANT_A, [[sql, params]]);
const HOUR = 60 * 60 * 1000;
const SIGNED_AT = new Date(NOW.getTime() - HOUR);
const REASON = 'The legal office confirmed the template by letter 12/PC';
const NUMBERING = { doc_number: '7', doc_symbol: '7/QD-UBND', doc_date: '23/10/2026' };

const issue = (id: string, member: number, version: number, body: Record<string, unknown> = {}, key?: string): Promise<Reply> =>
  app.call('POST', `/outgoing-documents/${id}/issuance`, { member, ifMatch: `"${version}"`, body, ...(key === undefined ? {} : { key }) });

async function row(id: string): Promise<{ status: string; version: string; issued_at: Date | null; unconfirmed_override_reason: string | null; unconfirmed_override_by: string | null }> {
  const [found] = await owner<{ status: string; version: string; issued_at: Date | null; unconfirmed_override_reason: string | null; unconfirmed_override_by: string | null }>(
    'select status, version::text as version, issued_at, unconfirmed_override_reason, unconfirmed_override_by from machvon.outgoing_document where id = $1',
    [id],
  );
  if (found === undefined) throw new Error('no document');
  return found;
}

const events = (id: string, type: string): Promise<Array<{ payload: Record<string, unknown> }>> =>
  owner('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at', [id, type]);

/** Template and layout of the default template confirmed (owner, for the tests that need a document without a watermark), and put back after. */
async function setConfirmed(confirmed: boolean): Promise<void> {
  await owner(
    confirmed
      ? "update machvon.document_template set confirmation_status = 'CONFIRMED', legal_confirmation_ref = 'CXN-TEST', legal_confirmed_by = $2::uuid, legal_confirmed_at = now() where template_code = $1"
      : "update machvon.document_template set confirmation_status = 'PENDING_CONFIRMATION', legal_confirmation_ref = null, legal_confirmed_by = null, legal_confirmed_at = null where template_code = $1 and $2::uuid is not null",
    ['QD-DEFAULT', memberId(LEGAL_ISSUER)],
  );
  await owner('update machvon.document_layout_profile set confirmation_status = $1', [confirmed ? 'CONFIRMED' : 'PENDING_CONFIRMATION']);
}

async function leaderSigned(options: { timestamps?: boolean } = {}): Promise<Buffer> {
  flow.world.setTime(SIGNED_AT);
  try {
    return await signField(revisionZero(), {
      field: 'sig_leader',
      identity: flow.world.leader,
      signingTime: SIGNED_AT,
      docMdpLevel: 2,
      ...(options.timestamps === false ? {} : { timestamps: flow.world.tsa }),
    });
  } finally {
    flow.world.setTime(NOW);
  }
}

async function sealedWith(pdf: Buffer, options: { identity?: typeof flow.world.organization; timestamps?: boolean; field?: string } = {}): Promise<Buffer> {
  flow.world.setTime(new Date(SIGNED_AT.getTime() + 60_000));
  try {
    return await signField(withNumbering(pdf, NUMBERING), {
      field: options.field ?? 'sig_org',
      identity: options.identity ?? flow.world.organization,
      signingTime: new Date(SIGNED_AT.getTime() + 60_000),
      ...(options.timestamps === false ? {} : { timestamps: flow.world.tsa }),
    });
  } finally {
    flow.world.setTime(NOW);
  }
}

/** A sealed document whose stored file is replaced by a hand-built one (its checksum follows, so the signatures are what the gate judges). */
async function sealedAs(bytes: Buffer): Promise<Sealed> {
  const sealed = await sealedDocument(flow);
  await replaceSealedFile(flow, sealed, bytes);
  return sealed;
}

async function expectRefused(sealed: Sealed, status: number, code: string, member: number = ISSUER): Promise<Reply> {
  const reply = await issue(sealed.id, member, sealed.version, { unconfirmed_override_reason: REASON });
  expect([reply.status, reply.json.code]).toEqual([status, code]);
  expect(await row(sealed.id)).toMatchObject({ status: 'SEALED', issued_at: null });
  expect(await events(sealed.id, 'doc.issued.v1')).toHaveLength(0);
  return reply;
}

let strangerCa: MockCertificateAuthority;

describe('issueOutgoingDocument: the verify-and-issue gate (ST-DOC-010)', () => {
  beforeAll(async () => {
    await flow.start();
    strangerCa = await MockCertificateAuthority.createRoot({ commonName: 'Stranger CA', notBefore: new Date('2026-01-01T00:00:00Z'), notAfter: new Date('2040-01-01T00:00:00Z') });
  }, 300_000);
  afterAll(() => flow.stop(), 60_000);
  afterEach(async () => {
    flow.reset();
    app.revocationAnswer = { status: 'GOOD' };
    app.anchors = [{ regime: 'PUBLIC_CA', certificate: flow.world.root.certificate }];
    await setConfirmed(false);
  });

  describe('a template that waits for its legal confirmation (BR-DOC-10)', () => {
    it('refuses without a reason, then issues with the reason of a legal user while the file keeps its watermark (AC-ST-DOC-010-1, UAT-AC407)', async () => {
      const sealed = await sealedDocument(flow);
      const before = await sealedBytes(flow, sealed);
      const detail = await app.call('GET', `/outgoing-documents/${sealed.id}`, { member: LEGAL_ISSUER });
      expect(detail.json).toMatchObject({ status: 'SEALED', renders_watermarked: true, unconfirmed_override_reason: null });

      const without = await issue(sealed.id, LEGAL_ISSUER, sealed.version);
      expect([without.status, without.json.code]).toEqual([422, 'TEMPLATE_PENDING_LEGAL_CONFIRMATION']);
      const spaces = await issue(sealed.id, LEGAL_ISSUER, sealed.version, { unconfirmed_override_reason: `${'x'.repeat(10)}${' '.repeat(30)}` });
      expect([spaces.status, spaces.json.code]).toEqual([422, 'TEMPLATE_PENDING_LEGAL_CONFIRMATION']);
      expect(await row(sealed.id)).toMatchObject({ status: 'SEALED', issued_at: null });
      expect(await events(sealed.id, 'doc.issued.v1')).toHaveLength(0);

      const issued = await issue(sealed.id, LEGAL_ISSUER, sealed.version, { unconfirmed_override_reason: `  ${REASON}  ` });
      expect(issued.status).toBe(200);
      expect(issued.json).toMatchObject({ status: 'ISSUED', template_unconfirmed: true, signature_status: 'VALID', revocation_status: 'GOOD', resource_version: sealed.version + 1, version_id: sealed.versionId, distribution_ids: [] });
      expect(await row(sealed.id)).toMatchObject({ status: 'ISSUED', unconfirmed_override_reason: REASON, unconfirmed_override_by: memberId(LEGAL_ISSUER) });

      // The file is the sealed one, unchanged, and every page still says the template is not confirmed.
      const after = await sealedBytes(flow, sealed);
      expect(sha256(after)).toBe(sha256(before));
      const [template] = await owner<{ watermark_text: string }>("select watermark_text from machvon.document_template where template_code = 'QD-DEFAULT'");
      const pages = await pageTexts(after);
      expect(pages.length).toBeGreaterThan(0);
      for (const texts of pages) expect(texts).toContain(template?.watermark_text);
      const [versions] = await owner<{ n: string }>('select count(*)::text as n from machvon.document_version where document_id = $1', [sealed.documentId]);
      expect(versions?.n).toBe('4');

      const [audit] = await owner<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where resource_id = $1 and action = 'outgoing_document.issue'", [sealed.id]);
      expect(audit?.safe_diff).toMatchObject({ unconfirmed_override_reason: REASON, unconfirmed_override_by: memberId(LEGAL_ISSUER), file_sha256: sha256(after) });
      const [announced] = await events(sealed.id, 'doc.issued.v1');
      expect(announced?.payload).toMatchObject({ template_unconfirmed: true, file_sha256: sha256(after) });
      expect(app.metrics).toContainEqual({ name: 'doc_template_unconfirmed_issued_total', labels: undefined });
    });

    it('does not take the reason of someone who may not confirm templates over the whole tenant', async () => {
      const sealed = await sealedDocument(flow);
      for (const member of [ISSUER, LEGAL_UNIT]) {
        const reply = await issue(sealed.id, member, sealed.version, { unconfirmed_override_reason: REASON });
        expect([reply.status, reply.json.code]).toEqual([403, 'SCOPE_DENIED']);
      }
      expect(await row(sealed.id)).toMatchObject({ status: 'SEALED', unconfirmed_override_reason: null });
      expect(await events(sealed.id, 'doc.issued.v1')).toHaveLength(0);
    });

    it('issues a document of a confirmed template without a reason, and refuses a reason it does not need', async () => {
      await setConfirmed(true);
      const sealed = await sealedDocument(flow);
      const detail = await app.call('GET', `/outgoing-documents/${sealed.id}`, { member: ISSUER });
      expect(detail.json.renders_watermarked).toBe(false);
      const needless = await issue(sealed.id, LEGAL_ISSUER, sealed.version, { unconfirmed_override_reason: REASON });
      expect([needless.status, needless.json.code, needless.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'unconfirmed_override_reason']);
      expect((await row(sealed.id)).status).toBe('SEALED');
      const issued = await issue(sealed.id, ISSUER, sealed.version);
      expect(issued.status).toBe(200);
      expect(issued.json).toMatchObject({ status: 'ISSUED', template_unconfirmed: false });
      expect(await row(sealed.id)).toMatchObject({ unconfirmed_override_reason: null, unconfirmed_override_by: null });
      const [announced] = await events(sealed.id, 'doc.issued.v1');
      expect(announced?.payload.template_unconfirmed).toBe(false);
    });
  });

  describe('the signatures are verified again, from the stored file', () => {
    it('refuses a sealed document with a tampered byte: the document stays SEALED and nothing is announced (AC-ST-DOC-010-3, UAT-AC404)', async () => {
      const sealed = await sealedDocument(flow);
      const tampered = Buffer.from(await sealedBytes(flow, sealed));
      // One byte inside the first stream of the file, which both signatures cover.
      const marker = 'stream' + String.fromCharCode(10);
      const at = tampered.indexOf(marker) + marker.length + 5;
      expect(at).toBeGreaterThan(5);
      tampered[at] = tampered[at] === 0x44 ? 0x45 : 0x44;
      await replaceSealedFile(flow, sealed, tampered);
      const reply = await expectRefused(sealed, 422, 'SIGNATURE_VERIFICATION_FAILED');
      expect(reply.json.findings).toEqual(expect.arrayContaining(['DIGEST_MISMATCH']));
      expect(app.metrics).toContainEqual({ name: 'doc_signature_verification_total', labels: { result: 'invalid', purpose: 'issue' } });
      const [request] = await owner<{ n: string }>("select count(*)::text as n from machvon.doc_issue_request where status = 'ISSUED'");
      expect(request?.n).toBe('0');
    });

    it('refuses a file that is not the one that was sealed, before judging any signature', async () => {
      const sealed = await sealedDocument(flow);
      const swapped = Buffer.concat([await sealedBytes(flow, sealed), Buffer.from('\n% appended')]);
      await replaceSealedFile(flow, sealed, swapped, { keepChecksum: true });
      const reply = await expectRefused(sealed, 422, 'SIGNATURE_VERIFICATION_FAILED');
      expect(reply.json.findings).toEqual(['FILE_HASH_MISMATCH']);
    });

    it('refuses bytes appended after the seal and a change of the page after the leader signed: INCREMENTAL_CHANGES_NOT_ALLOWED', async () => {
      const appended = await sealedAs(Buffer.concat([await sealedWith(await leaderSigned()), Buffer.from('trailing bytes')]));
      await expectRefused(appended, 422, 'INCREMENTAL_CHANGES_NOT_ALLOWED');
      const leader = await leaderSigned();
      const changed = appendRevision(leader, [{ num: 4, body: '<< /Length 36 >>\nstream\nBT /F1 12 Tf 72 780 Td (Fraud) Tj ET\nendstream' }]).pdf;
      const rewritten = await sealedAs(await sealedWith(changed));
      const reply = await expectRefused(rewritten, 422, 'INCREMENTAL_CHANGES_NOT_ALLOWED');
      expect(reply.json.signatures).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'LEADER', status: 'INVALID' })]));
    });

    it('refuses a chain that does not end at a trust anchor of the tenant: CERTIFICATE_CHAIN_UNTRUSTED', async () => {
      const stranger = await strangerCa.issue({ commonName: 'Somebody Else', notBefore: new Date('2026-01-01T00:00:00Z'), notAfter: new Date('2030-01-01T00:00:00Z') });
      const sealed = await sealedAs(await sealedWith(await leaderSigned(), { identity: stranger }));
      await expectRefused(sealed, 422, 'CERTIFICATE_CHAIN_UNTRUSTED');
    });

    it('refuses a signing time that nobody proved: SIGNING_TIME_UNPROVEN', async () => {
      const sealed = await sealedAs(await sealedWith(await leaderSigned({ timestamps: false }), { timestamps: false }));
      await expectRefused(sealed, 422, 'SIGNING_TIME_UNPROVEN');
    });

    it('refuses a file that lacks the organisation seal, or whose two signatures are the same certificate', async () => {
      const unsealed = await sealedAs(withNumbering(await leaderSigned(), NUMBERING));
      const missing = await expectRefused(unsealed, 422, 'SIGNATURE_VERIFICATION_FAILED');
      expect(missing.json.findings).toEqual(['SIGNATURE_MISSING']);
      const twice = await sealedAs(await sealedWith(await leaderSigned(), { identity: flow.world.leader }));
      const same = await expectRefused(twice, 422, 'SIGNATURE_VERIFICATION_FAILED');
      expect(same.json.findings).toEqual(['SIGNATURE_MISSING']);
    });

    it('refuses a certificate that is revoked, and says plainly that a revocation nobody could establish is not good (503, PROVIDER_UNAVAILABLE)', async () => {
      const sealed = await sealedDocument(flow);
      app.revocationAnswer = { status: 'REVOKED', revokedAt: new Date(SIGNED_AT.getTime() - 24 * HOUR) };
      const revoked = await expectRefused(sealed, 422, 'SIGNATURE_VERIFICATION_FAILED');
      expect(revoked.json.findings).toEqual(expect.arrayContaining(['CERTIFICATE_REVOKED']));
      app.revocationAnswer = { status: 'UNKNOWN' };
      const unknown = await expectRefused(sealed, 503, 'PROVIDER_UNAVAILABLE');
      expect(unknown.json.reason).toBe('REVOCATION_UNAVAILABLE');
      expect(unknown.json.signatures).toEqual(expect.arrayContaining([expect.objectContaining({ revocation: 'UNKNOWN' })]));
      // The answer becomes known: the same document is issued, nothing was spent by the refusals.
      app.revocationAnswer = { status: 'GOOD' };
      const issued = await issue(sealed.id, LEGAL_ISSUER, sealed.version, { unconfirmed_override_reason: REASON });
      expect(issued.status).toBe(200);
    });
  });

  describe('the command', () => {
    it('writes the state, the history, the verification, the audit row and the event once, and answers a replay with the first answer (UAT-AC404)', async () => {
      await setConfirmed(true);
      const sealed = await sealedDocument(flow);
      const signaturesBefore = await owner<{ n: string }>('select count(*)::text as n from machvon.document_signature where document_version_id = $1', [sealed.versionId]);
      const key = `issue-${randomUUID()}`;
      const first = await issue(sealed.id, ISSUER, sealed.version, {}, key);
      expect(first.status).toBe(200);
      const [number] = await owner<{ document_number: number; symbol: string; effect_status: string; issued_on: string }>(
        'select d.document_number, d.symbol, d.effect_status, d.issued_on::text as issued_on from machvon.document d where d.id = $1',
        [sealed.documentId],
      );
      expect(number).toMatchObject({ document_number: 1, effect_status: 'EFFECTIVE' });
      expect(first.json).toMatchObject({ status: 'ISSUED', document_number: 1, symbol: number?.symbol, issued_on: number?.issued_on, document_id: sealed.documentId });
      const replay = await issue(sealed.id, ISSUER, sealed.version, {}, key);
      expect(replay.status).toBe(200);
      expect(replay.headers.get('idempotency-replayed')).toBe('true');
      expect(replay.json.resource_id).toBe(first.json.resource_id);

      expect(await events(sealed.id, 'doc.issued.v1')).toHaveLength(1);
      const history = await owner<{ kind: string; from_status: string; to_status: string }>('select kind, from_status, to_status from machvon.outgoing_document_event where outgoing_document_id = $1 order by seq desc limit 1', [sealed.id]);
      expect(history[0]).toEqual({ kind: 'ISSUED', from_status: 'SEALED', to_status: 'ISSUED' });
      const signaturesAfter = await owner<{ n: string }>('select count(*)::text as n from machvon.document_signature where document_version_id = $1', [sealed.versionId]);
      expect(Number(signaturesAfter[0]?.n) - Number(signaturesBefore[0]?.n)).toBe(2);
      expect(app.metrics).toContainEqual({ name: 'doc_signature_verification_total', labels: { result: 'valid', purpose: 'issue' } });
      expect(app.metrics).toContainEqual({ name: 'doc_issued_total', labels: { route: 'in_system' } });
      const latency = app.gauges.find((gauge) => gauge.name === 'doc_issue_latency_seconds');
      expect(latency?.value).toBeGreaterThanOrEqual(0);
      // The sealed file is now the document in force and a second issue is a state error, not a second event.
      const again = await issue(sealed.id, ISSUER, sealed.version + 1);
      expect([again.status, again.json.code]).toEqual([409, 'DOCUMENT_STATE_INVALID']);
      expect(await events(sealed.id, 'doc.issued.v1')).toHaveLength(1);
    });

    it('answers a stale version, a missing precondition, a document that is not sealed and a caller without the right', async () => {
      await setConfirmed(true);
      const sealed = await sealedDocument(flow);
      const stale = await issue(sealed.id, ISSUER, sealed.version - 1);
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const bare = await app.call('POST', `/outgoing-documents/${sealed.id}/issuance`, { member: ISSUER, body: {} });
      expect(bare.status).toBe(428);
      const denied = await issue(sealed.id, NOBODY, sealed.version);
      expect(denied.status).toBe(403);
      const unknown = await issue(randomUUID(), ISSUER, 1);
      expect([unknown.status, unknown.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect(await row(sealed.id)).toMatchObject({ status: 'SEALED', version: String(sealed.version) });
      // A document that is still a draft is not sealed: it cannot be issued.
      const draft = await flow.create({ doc_type_code: 'QD', template_code: 'QD-DEFAULT', title: 'Still a draft', drafting_unit_id: unitId(2), payload: payloadOf(), recipients: [EXTERNAL_RECIPIENT], signer_user_id: memberId(LEADER) });
      expect(draft.status).toBe(200);
      const early = await issue(draft.json.resource_id as string, ISSUER, 1);
      expect([early.status, early.json.code]).toEqual([409, 'DOCUMENT_STATE_INVALID']);
    });

    it('distributes at once when asked, and only for someone who may also distribute', async () => {
      await setConfirmed(true);
      const sealed = await sealedDocument(flow);
      const denied = await issue(sealed.id, ISSUER, sealed.version, { distribute_now: true });
      expect([denied.status, denied.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect((await row(sealed.id)).status).toBe('SEALED');
      const done = await issue(sealed.id, ISSUER_DISTRIBUTOR, sealed.version, { distribute_now: true });
      expect(done.status).toBe(200);
      // The unit's inbox is delivered at once, the agency gets the paper handover (sent, awaiting a receipt): the document is DELIVERED.
      expect(done.json).toMatchObject({ status: 'DELIVERED', resource_version: sealed.version + 2 });
      expect(done.json.distribution_ids).toHaveLength(2);
      const rows = await owner<{ channel: string; status: string }>('select channel, status from machvon.document_distribution where outgoing_document_id = $1 order by channel', [sealed.id]);
      expect(rows).toEqual([
        { channel: 'INTERNAL', status: 'DELIVERED' },
        { channel: 'PAPER_HANDOVER', status: 'SENT' },
      ]);
      expect(await events(sealed.id, 'doc.issued.v1')).toHaveLength(1);
      expect(await events(sealed.id, 'doc.delivered.v1')).toHaveLength(1);
    });
  });

  describe('doc.revocation-recheck', () => {
    it('asks again about the documents in force and raises an alert when a certificate was revoked after the issue', async () => {
      await setConfirmed(true);
      const sealed = await sealedDocument(flow);
      expect((await issue(sealed.id, ISSUER, sealed.version)).status).toBe(200);
      const raised: Array<{ code: string; context: Record<string, unknown> }> = [];
      const alerts = { raise: (code: string, context: Record<string, unknown>) => void raised.push({ code, context }) };
      const run = (at: Date): Promise<Awaited<ReturnType<typeof recheckIssuedRevocation>>> =>
        app.harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(ISSUER), scopeVersion: 1 }, (tx) =>
          recheckIssuedRevocation(tx, TENANT_A, at, {
            files: app.files,
            trust: { forTenant: async () => ({ anchors: () => app.anchors }) },
            revocation: { check: async () => app.revocationAnswer },
            alerts,
            metrics: { increment: (name, labels) => void app.metrics.push({ name, labels }), gauge: () => undefined },
          }),
        );

      // The verification of the issue was recent and good: nothing is due yet, and nothing is asked.
      const fresh = await run(NOW);
      expect(fresh.checked).toBe(0);
      // A day later it is asked again, and the answer is still good.
      const later = new Date(NOW.getTime() + 25 * HOUR);
      const good = await run(later);
      expect(good.good).toBeGreaterThanOrEqual(1);
      expect(good.revoked).toEqual([]);
      // An answer that cannot be had changes nothing and is counted; the document is asked about on the next run.
      app.revocationAnswer = { status: 'UNKNOWN' };
      const unknown = await run(new Date(later.getTime() + 25 * HOUR));
      expect(unknown.unknown).toBeGreaterThanOrEqual(1);
      expect(raised).toEqual([]);
      expect((await row(sealed.id)).status).toBe('ISSUED');
      // A certificate that was revoked before the signing: the alert names the document.
      app.revocationAnswer = { status: 'REVOKED', revokedAt: new Date(SIGNED_AT.getTime() - 24 * HOUR) };
      const revoked = await run(new Date(later.getTime() + 50 * HOUR));
      expect(revoked.revoked).toContain(sealed.id);
      expect(raised).toContainEqual({ code: ISSUED_SIGNATURE_REVOKED_ALERT, context: { outgoing_document_id: sealed.id, version_id: sealed.versionId } });
      expect(app.metrics).toContainEqual({ name: 'doc_revocation_recheck_total', labels: { outcome: 'revoked' } });
    });
  });
});
