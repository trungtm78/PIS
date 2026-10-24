import { randomUUID } from 'node:crypto';
import { auditRegisterGaps, auditRegisterVoids } from '../../src/modules/doc/register-jobs';
import { CLERK, DISTRIBUTOR, LEGAL_ISSUER, NOBODY, OUTSIDE_MANAGER, RECALLER, RECORDS_MANAGER, SECOND_MANAGER, TENANT_A, memberId } from './doc-app';
import type { Reply } from './doc-app';
import { FlowWorld } from './support/flow-world';
import { EXTERNAL_RECIPIENT, INTERNAL_RECIPIENT, numberedDocument, sealedDocument } from './support/sealed-documents';

jest.setTimeout(240_000);

const flow = new FlowWorld();
const { app } = flow;
const owner = <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => app.harness.owner<T>(TENANT_A, [[sql, params]]);
const REASON = 'Wrong figures in table 2, issued for the wrong period';

const recall = (id: string, member: number, version: number, body: Record<string, unknown> = { reason: REASON }, key?: string): Promise<Reply> =>
  app.call('POST', `/outgoing-documents/${id}/recall`, { member, ifMatch: `"${version}"`, body, ...(key === undefined ? {} : { key }) });
const voidNumber = (id: string, member: number, version: number, body: Record<string, unknown>): Promise<Reply> =>
  app.call('POST', `/outgoing-documents/${id}/number-voiding`, { member, ifMatch: `"${version}"`, body });

interface Issued {
  id: string;
  documentId: string;
  /** The version of the outgoing document after the issue (and the distribution, when it was asked for). */
  version: number;
}

/** A document issued through the command (the default template is unconfirmed, so a legal user gives the reason) and, when asked, sent to its recipients. */
async function issued(options: { distribute?: boolean } = {}): Promise<Issued> {
  const sealed = await sealedDocument(flow);
  const reply = await app.call('POST', `/outgoing-documents/${sealed.id}/issuance`, {
    member: LEGAL_ISSUER,
    ifMatch: `"${sealed.version}"`,
    body: { unconfirmed_override_reason: 'The legal office confirmed the template by letter 12/PC' },
  });
  expect(reply.status).toBe(200);
  let version = reply.json.resource_version as number;
  if (options.distribute === true) {
    const sent = await app.call('POST', `/outgoing-documents/${sealed.id}/distributions`, {
      member: DISTRIBUTOR,
      ifMatch: `"${version}"`,
      body: { recipients: [{ ...INTERNAL_RECIPIENT, channel: 'INTERNAL' }, { ...EXTERNAL_RECIPIENT, channel: 'PAPER_HANDOVER' }] },
    });
    expect(sent.status).toBe(200);
    version = sent.json.resource_version as number;
  }
  return { id: sealed.id, documentId: sealed.documentId, version };
}

const events = (id: string, type: string): Promise<Array<{ payload: Record<string, unknown> }>> =>
  owner('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at', [id, type]);

async function row(id: string): Promise<{ status: string; version: string; effect_status: string; recall_reason: string | null; recalled_by: string | null; cancel_reason: string | null; allocation_id: string | null }> {
  const [found] = await owner<{ status: string; version: string; effect_status: string; recall_reason: string | null; recalled_by: string | null; cancel_reason: string | null; allocation_id: string | null }>(
    `select o.status, o.version::text as version, d.effect_status, o.recall_reason, o.recalled_by, o.cancel_reason, o.allocation_id
       from machvon.outgoing_document o join machvon.document d on d.tenant_id = o.tenant_id and d.id = o.document_id where o.id = $1`,
    [id],
  );
  if (found === undefined) throw new Error('no document');
  return found;
}

const allocationOf = async (id: string): Promise<{ id: string; register_id: string; number: number; status: string; voided_by: string | null; void_approved_by: string | null; void_reason: string | null }> => {
  const [found] = await owner<{ id: string; register_id: string; number: number; status: string; voided_by: string | null; void_approved_by: string | null; void_reason: string | null }>(
    'select a.id, a.register_id, a.number, a.status, a.voided_by, a.void_approved_by, a.void_reason from machvon.document_number_allocation a join machvon.outgoing_document o on o.allocation_id = a.id where o.id = $1',
    [id],
  );
  if (found === undefined) throw new Error('no allocation');
  return found;
};

describe('recalling an issued document and voiding a number (ST-DOC-012)', () => {
  beforeAll(() => flow.start(), 300_000);
  afterAll(() => flow.stop(), 60_000);
  afterEach(() => {
    flow.reset();
    app.emailBehaviour = { outcome: 'SENT', externalRef: 'MAIL-1' };
    app.emailSent.length = 0;
  });

  describe('recallOutgoingDocument (AC-ST-DOC-012-1, UAT-AC411)', () => {
    it('recalls a delivered document: RECALLED with the reason, the recipients noticed, one event with the reference and the hash, and the number stays in the ledger as recalled', async () => {
      const doc = await issued({ distribute: true });
      expect(await row(doc.id)).toMatchObject({ status: 'DELIVERED', effect_status: 'EFFECTIVE' });
      await owner("update machvon.outgoing_document set source_module = 'MNE', source_ref = 'MNE:mne_report:MR-3:r1', payload_sha256 = repeat('c', 64) where id = $1", [doc.id]);
      const before = await allocationOf(doc.id);

      const reply = await recall(doc.id, RECALLER, doc.version, { reason: `  ${REASON}  `, notify_recipients: true });
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ status: 'RECALLED', effect_status: 'RECALLED', notified_count: 2, called_off_count: 0, resource_version: doc.version + 1, document_id: doc.documentId });
      expect(await row(doc.id)).toMatchObject({ status: 'RECALLED', effect_status: 'RECALLED', recall_reason: REASON, recalled_by: memberId(RECALLER) });
      const [event] = await events(doc.id, 'doc.recalled.v1');
      expect(event?.payload).toMatchObject({
        document_id: doc.documentId,
        outgoing_document_id: doc.id,
        source_module: 'MNE',
        source_ref: 'MNE:mne_report:MR-3:r1',
        payload_sha256: 'c'.repeat(64),
        reason: REASON,
        actor_id: memberId(RECALLER),
      });
      expect((event?.payload.notified_recipients as Array<{ recipient_name: string }>).map((entry) => entry.recipient_name).sort()).toEqual(['Department of Finance', 'Planning Division']);
      expect(await events(doc.id, 'doc.recalled.v1')).toHaveLength(1);

      const notices = await owner<{ recipient_name: string; status: string; recall_notice_at: Date | null }>('select recipient_name, status, recall_notice_at from machvon.document_distribution where outgoing_document_id = $1', [doc.id]);
      expect(notices).toHaveLength(2);
      for (const notice of notices) expect(notice.recall_notice_at).not.toBeNull();
      const history = await owner<{ kind: string; comment: string }>("select kind, comment from machvon.outgoing_document_event where outgoing_document_id = $1 and kind = 'RECALLED'", [doc.id]);
      expect(history).toEqual([{ kind: 'RECALLED', comment: REASON }]);
      const [audit] = await owner<{ reason: string; safe_diff: Record<string, unknown> }>("select reason, safe_diff from machvon.audit_event where resource_id = $1 and action = 'outgoing_document.recall'", [doc.id]);
      expect(audit).toMatchObject({ reason: REASON, safe_diff: { from_status: 'DELIVERED', notified: 2 } });

      // The number is not given back: the allocation is still taken and the ledger shows the document as recalled; the next number follows.
      expect(await allocationOf(doc.id)).toEqual(before);
      const ledger = await app.call('GET', `/document-number-registers/${before.register_id}/entries`, { member: 1 });
      expect((ledger.json.items as Array<{ number: number; status: string }>).map((entry) => [entry.number, entry.status])).toEqual([[before.number, 'RECALLED']]);

      const detail = await app.call('GET', `/outgoing-documents/${doc.id}`, { member: RECALLER });
      expect(detail.json).toMatchObject({ status: 'RECALLED', effect_status: 'RECALLED', recall_reason: REASON, recalled_by: memberId(RECALLER) });
      expect(detail.json.recalled_at).toEqual(expect.any(String));
      const shown = detail.json.distributions as Array<{ recall_notice_at: string | null }>;
      expect(shown).toHaveLength(2);
      for (const view of shown) expect(view.recall_notice_at).toEqual(expect.any(String));
    });

    it('answers a second recall with 409 and keeps the first, and the same key again with the first answer', async () => {
      const doc = await issued();
      const key = `recall-${randomUUID()}`;
      const first = await recall(doc.id, RECALLER, doc.version, { reason: REASON }, key);
      expect(first.status).toBe(200);
      const replayed = await recall(doc.id, RECALLER, doc.version, { reason: REASON }, key);
      expect([replayed.status, replayed.json.resource_version]).toEqual([200, doc.version + 1]);
      const second = await recall(doc.id, RECALLER, doc.version + 1, { reason: 'Another reason, written later on' });
      expect([second.status, second.json.code]).toEqual([409, 'DOCUMENT_STATE_INVALID']);
      expect((await row(doc.id)).recall_reason).toBe(REASON);
      expect(await events(doc.id, 'doc.recalled.v1')).toHaveLength(1);
    });

    it('closes the distribution of a recalled document: nothing more is sent and no receipt is taken (409)', async () => {
      const doc = await issued({ distribute: true });
      const reply = await recall(doc.id, RECALLER, doc.version);
      expect(reply.status).toBe(200);
      const [row] = await owner<{ id: string; version: string }>("select id, version::text as version from machvon.document_distribution where outgoing_document_id = $1 and channel = 'PAPER_HANDOVER'", [doc.id]);
      const again = await app.call('POST', `/outgoing-documents/${doc.id}/distributions`, {
        member: DISTRIBUTOR,
        ifMatch: `"${reply.json.resource_version as number}"`,
        body: { recipients: [{ ...EXTERNAL_RECIPIENT, name: 'Another agency', channel: 'PAPER_HANDOVER' }] },
      });
      expect([again.status, again.json.code]).toEqual([409, 'DOCUMENT_STATE_INVALID']);
      const receipt = await app.call('POST', `/document-distributions/${row?.id}/acknowledgement`, { member: DISTRIBUTOR, ifMatch: `"${row?.version}"`, body: { acknowledged_at: new Date().toISOString() } });
      expect([receipt.status, receipt.json.code]).toEqual([409, 'DOCUMENT_STATE_INVALID']);
    });

    it('calls off what was not sent and gives no notice when asked for none', async () => {
      const doc = await issued();
      app.emailBehaviour = new Error('mail transport down');
      const sent = await app.call('POST', `/outgoing-documents/${doc.id}/distributions`, {
        member: DISTRIBUTOR,
        ifMatch: `"${doc.version}"`,
        body: { recipients: [{ ...EXTERNAL_RECIPIENT, channel: 'EMAIL' }, { ...INTERNAL_RECIPIENT, channel: 'PAPER_HANDOVER' }] },
      });
      expect(sent.status).toBe(200);
      const reply = await recall(doc.id, RECALLER, sent.json.resource_version as number, { reason: REASON, notify_recipients: false });
      expect(reply.json).toMatchObject({ status: 'RECALLED', notified_count: 0, called_off_count: 1 });
      const rows = await owner<{ channel: string; status: string; recall_notice_at: Date | null }>('select channel, status, recall_notice_at from machvon.document_distribution where outgoing_document_id = $1 order by channel', [doc.id]);
      expect(rows).toEqual([
        { channel: 'EMAIL', status: 'CANCELLED', recall_notice_at: null },
        { channel: 'PAPER_HANDOVER', status: 'SENT', recall_notice_at: null },
      ]);
    });

    it('keeps the relation RECALLS from the recalling document, and refuses a basis that is not in force', async () => {
      const basis = await issued();
      const target = await issued();
      const missing = await recall(target.id, RECALLER, target.version, { reason: REASON, recall_basis_document_id: randomUUID() });
      expect([missing.status, missing.json.code]).toEqual([422, 'RECALL_BASIS_REQUIRED']);
      const self = await recall(target.id, RECALLER, target.version, { reason: REASON, recall_basis_document_id: target.documentId });
      expect([self.status, self.json.code]).toEqual([422, 'RECALL_BASIS_REQUIRED']);
      expect((await row(target.id)).status).toBe('ISSUED');
      const reply = await recall(target.id, RECALLER, target.version, { reason: REASON, recall_basis_document_id: basis.documentId });
      expect(reply.status).toBe(200);
      const relations = await owner<{ from_document_id: string; to_document_id: string; relation_kind: string }>('select from_document_id, to_document_id, relation_kind from machvon.document_relation where to_document_id = $1', [target.documentId]);
      expect(relations).toEqual([{ from_document_id: basis.documentId, to_document_id: target.documentId, relation_kind: 'RECALLS' }]);
      // The recalling document itself is still in force.
      expect((await row(basis.id)).effect_status).toBe('EFFECTIVE');
      expect((await events(target.id, 'doc.recalled.v1'))[0]?.payload).toMatchObject({ basis_document_id: basis.documentId });
    });

    it('refuses what is not a document in force, a reason that is too short, a stale version, a missing right and a document out of reach', async () => {
      const sealed = await sealedDocument(flow);
      const early = await recall(sealed.id, RECALLER, sealed.version);
      expect([early.status, early.json.code]).toEqual([409, 'DOCUMENT_STATE_INVALID']);
      const doc = await issued();
      const blanks = await recall(doc.id, RECALLER, doc.version, { reason: `${'x'.repeat(4)}${' '.repeat(20)}` });
      expect([blanks.status, blanks.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const short = await recall(doc.id, RECALLER, doc.version, { reason: 'too short' });
      expect([short.status, short.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const stale = await recall(doc.id, RECALLER, doc.version - 1);
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const nobody = await recall(doc.id, NOBODY, doc.version);
      expect(nobody.status).toBe(403);
      const outside = await recall(doc.id, OUTSIDE_MANAGER, doc.version);
      expect(outside.status).toBe(403);
      const unknown = await recall(randomUUID(), RECALLER, 1);
      expect([unknown.status, unknown.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect(await row(doc.id)).toMatchObject({ status: 'ISSUED', effect_status: 'EFFECTIVE', recall_reason: null });
      expect(await events(doc.id, 'doc.recalled.v1')).toHaveLength(0);
    });
  });

  describe('voidOutgoingDocumentNumber (AC-ST-DOC-012-2, UAT-AC427)', () => {
    it('refuses the clerk who allocated the number and then voids it with a second person: allocation VOIDED, document CANCELLED, one event, the next number follows and the audit lists it as voided', async () => {
      const registerId = await flow.openRegister({ register_code: 'VOID-1' });
      await numberedDocument(flow, registerId);
      const second = await numberedDocument(flow, registerId);
      expect(await row(second.id)).toMatchObject({ status: 'NUMBERED' });
      const taken = await allocationOf(second.id);
      expect(taken.number).toBe(2);

      const self = await voidNumber(second.id, CLERK, second.version, { reason: 'The seal of the organisation cannot be completed', approver_user_id: memberId(CLERK) });
      expect([self.status, self.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      const allocator = await voidNumber(second.id, RECORDS_MANAGER, second.version, { reason: 'The seal of the organisation cannot be completed', approver_user_id: memberId(CLERK) });
      expect([allocator.status, allocator.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      const same = await voidNumber(second.id, RECORDS_MANAGER, second.version, { reason: 'The seal of the organisation cannot be completed', approver_user_id: memberId(RECORDS_MANAGER) });
      expect([same.status, same.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      expect(await row(second.id)).toMatchObject({ status: 'NUMBERED' });
      expect((await allocationOf(second.id)).status).toBe('ALLOCATED');

      const voided = await voidNumber(second.id, RECORDS_MANAGER, second.version, { reason: '  The seal of the organisation cannot be completed  ', approver_user_id: memberId(SECOND_MANAGER) });
      expect(voided.status).toBe(200);
      expect(voided.json).toMatchObject({ status: 'CANCELLED', number: 2, allocation_status: 'VOIDED', resource_version: second.version + 1, document_id: second.documentId });
      expect(await row(second.id)).toMatchObject({ status: 'CANCELLED', effect_status: 'EXPIRED', cancel_reason: 'The seal of the organisation cannot be completed' });
      expect(await allocationOf(second.id)).toMatchObject({ status: 'VOIDED', voided_by: memberId(RECORDS_MANAGER), void_approved_by: memberId(SECOND_MANAGER), void_reason: 'The seal of the organisation cannot be completed' });
      const [event] = await events(second.id, 'doc.number_voided.v1');
      expect(event?.payload).toMatchObject({ register_id: registerId, number: 2, approved_by: memberId(SECOND_MANAGER), actor_id: memberId(RECORDS_MANAGER), from_status: 'NUMBERED' });
      expect(await events(second.id, 'doc.number_voided.v1')).toHaveLength(1);
      expect(await events(second.id, 'doc.rejected.v1')).toHaveLength(0);
      const [audit] = await owner<{ reason: string }>("select reason from machvon.audit_event where resource_id = $1 and action = 'outgoing_document.number_void'", [second.id]);
      expect(audit?.reason).toBe('The seal of the organisation cannot be completed');

      // The next number is 3: a voided number is never reused, and the ledger and the audit show 2 as voided, not as missing.
      const third = await numberedDocument(flow, registerId);
      expect((await allocationOf(third.id)).number).toBe(3);
      const ledger = await app.call('GET', `/document-number-registers/${registerId}/entries`, { member: 1 });
      expect((ledger.json.items as Array<{ number: number; status: string }>).map((entry) => [entry.number, entry.status])).toEqual([
        [1, 'ALLOCATED'],
        [2, 'VOIDED'],
        [3, 'ALLOCATED'],
      ]);
      expect(await app.harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(1), scopeVersion: 1 }, (tx) => auditRegisterGaps(tx))).toEqual([]);
      const voids = await app.harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(1), scopeVersion: 1 }, (tx) => auditRegisterVoids(tx));
      expect(voids).toEqual([{ registerId, registerCode: 'VOID-1', year: 2026, numbers: [2] }]);
    });

    it('lets the clerk who allocated the number void it when a second person approves', async () => {
      const registerId = await flow.openRegister();
      const doc = await numberedDocument(flow, registerId);
      const reply = await voidNumber(doc.id, CLERK, doc.version, { reason: 'The seal of the organisation cannot be completed', approver_user_id: memberId(RECORDS_MANAGER) });
      expect(reply.status).toBe(200);
      expect(await allocationOf(doc.id)).toMatchObject({ status: 'VOIDED', voided_by: memberId(CLERK), void_approved_by: memberId(RECORDS_MANAGER) });
    });

    it('ends the seal session that is still open when the number is voided', async () => {
      const registerId = await flow.openRegister();
      const doc = await numberedDocument(flow, registerId);
      const started = await app.call('POST', `/outgoing-documents/${doc.id}/organization-seal-sessions`, { member: CLERK, ifMatch: `"${doc.version}"`, body: {} });
      expect(started.status).toBe(202);
      const sessionId = started.json.resource_id as string;
      const reply = await voidNumber(doc.id, RECORDS_MANAGER, Number((await row(doc.id)).version), { reason: 'The seal of the organisation cannot be completed', approver_user_id: memberId(SECOND_MANAGER) });
      expect(reply.status).toBe(200);
      const [session] = await owner<{ status: string }>('select status from machvon.doc_signing_session where id = $1', [sessionId]);
      expect(session?.status).toBe('CANCELLED');
    });

    it('refuses an approver who may not void numbers over the unit of the document, and one who is not a member', async () => {
      const registerId = await flow.openRegister();
      const doc = await numberedDocument(flow, registerId);
      const body = { reason: 'The seal of the organisation cannot be completed' };
      const outside = await voidNumber(doc.id, RECORDS_MANAGER, doc.version, { ...body, approver_user_id: memberId(OUTSIDE_MANAGER) });
      expect([outside.status, outside.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const nobody = await voidNumber(doc.id, RECORDS_MANAGER, doc.version, { ...body, approver_user_id: memberId(NOBODY) });
      expect([nobody.status, nobody.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const stranger = await voidNumber(doc.id, RECORDS_MANAGER, doc.version, { ...body, approver_user_id: randomUUID() });
      expect([stranger.status, stranger.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      // Nothing was left behind by the refusals.
      expect(await row(doc.id)).toMatchObject({ status: 'NUMBERED' });
      expect((await allocationOf(doc.id)).status).toBe('ALLOCATED');
      expect(await events(doc.id, 'doc.number_voided.v1')).toHaveLength(0);
    });

    it('voids the number of a sealed document, and refuses an issued one, a voided one, a short reason, a stale version and a missing right', async () => {
      const sealed = await sealedDocument(flow);
      const body = { reason: 'The seal of the organisation cannot be completed', approver_user_id: memberId(SECOND_MANAGER) };
      const stale = await voidNumber(sealed.id, RECORDS_MANAGER, sealed.version - 1, body);
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      expect((await voidNumber(sealed.id, NOBODY, sealed.version, body)).status).toBe(403);
      const short = await voidNumber(sealed.id, RECORDS_MANAGER, sealed.version, { ...body, reason: 'short' });
      expect([short.status, short.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const blanks = await voidNumber(sealed.id, RECORDS_MANAGER, sealed.version, { ...body, reason: `${'x'.repeat(4)}${' '.repeat(20)}` });
      expect([blanks.status, blanks.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const voided = await voidNumber(sealed.id, RECORDS_MANAGER, sealed.version, body);
      expect(voided.status).toBe(200);
      expect(await row(sealed.id)).toMatchObject({ status: 'CANCELLED' });
      const again = await voidNumber(sealed.id, RECORDS_MANAGER, sealed.version + 1, body);
      expect([again.status, again.json.code]).toEqual([409, 'DOCUMENT_STATE_INVALID']);

      const doc = await issued();
      const late = await voidNumber(doc.id, RECORDS_MANAGER, doc.version, body);
      expect([late.status, late.json.code]).toEqual([409, 'DOCUMENT_STATE_INVALID']);
      expect(await row(doc.id)).toMatchObject({ status: 'ISSUED' });
      expect((await allocationOf(doc.id)).status).toBe('ALLOCATED');
    });

    it('tells the source module that the document will not come, and ends the request it made', async () => {
      const registerId = await flow.openRegister();
      const doc = await numberedDocument(flow, registerId);
      await owner("update machvon.outgoing_document set source_module = 'MNE', source_ref = 'MNE:mne_report:MR-9:r1', payload_sha256 = repeat('d', 64) where id = $1", [doc.id]);
      const reply = await voidNumber(doc.id, RECORDS_MANAGER, doc.version, { reason: 'The seal of the organisation cannot be completed', approver_user_id: memberId(SECOND_MANAGER) });
      expect(reply.status).toBe(200);
      const [rejected] = await events(doc.id, 'doc.rejected.v1');
      expect(rejected?.payload).toEqual({ source_module: 'MNE', source_ref: 'MNE:mne_report:MR-9:r1', payload_sha256: 'd'.repeat(64), reject_code: 'NUMBER_VOIDED' });
    });
  });
});
