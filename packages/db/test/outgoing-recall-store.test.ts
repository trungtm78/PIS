import { randomUUID } from 'node:crypto';
import { DomainError } from '@machvon/kernel';
import { DocIssueRequestStore } from '../src/doc-issue-request-store';
import { DocumentDistributionStore } from '../src/document-distribution-store';
import type { NewDistribution } from '../src/document-distribution-store';
import { DocumentStore } from '../src/document-store';
import { NumberRegisterStore } from '../src/number-register-store';
import type { RegisterRecord } from '../src/number-register-store';
import { OutgoingDocumentStore } from '../src/outgoing-document-store';
import { OutgoingRecallStore } from '../src/outgoing-recall-store';
import { ACTOR, AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const documents = new DocumentStore();
const outgoing = new OutgoingDocumentStore();
const registers = new NumberRegisterStore();
const distributions = new DocumentDistributionStore();
const recalls = new OutgoingRecallStore();
const requests = new DocIssueRequestStore();
const DRAFTER = memberId(1);
const LEADER = memberId(2);
const CLERK = memberId(3);
const MANAGER = memberId(4);
const APPROVER = memberId(5);
const NOW = new Date('2026-10-23T03:00:00Z');
const MINUTE = 60_000;
let layoutProfileId = '';
let templateId = '';
let register: RegisterRecord;

const ctxA = contextFor(TENANT_A, memberId(1));
const ctxB = contextFor(TENANT_B, memberId(1));
const inA = <T>(work: Parameters<typeof harness.tenants.withTenant<T>>[1]) => harness.tenants.withTenant(ctxA, work);

async function failure(promise: Promise<unknown>): Promise<{ code: string; sqlState?: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return { code: error.code };
    return { code: 'DB', sqlState: (error as { code?: string }).code };
  }
  throw new Error('expected a rejection');
}

interface Made {
  id: string;
  documentId: string;
  allocationId: string;
  number: number;
  version: number;
}

/** An outgoing document taken through the stores to NUMBERED, with a real allocation of the register. */
async function numbered(): Promise<Made> {
  const id = randomUUID();
  const documentId = await inA(async (tx) => {
    const document = await documents.insertDocument(tx, { docKind: 'OUTGOING', docTypeCode: 'QD', title: 'Decision', classification: 'INTERNAL', createdBy: ACTOR });
    await tx.query(
      `insert into machvon.outgoing_document (tenant_id, id, document_id, layout_profile_id, status, drafting_unit_id, drafter_user_id, signer_user_id, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, 'SUBMITTED', $4::uuid, $5::uuid, $6::uuid, $5::uuid, $5::uuid)`,
      [id, document.id, layoutProfileId, unitId(1), DRAFTER, LEADER],
    );
    return document.id;
  });
  await inA((tx) => outgoing.markSigned(tx, id, { expectedVersion: 1, signedAt: NOW, actor: LEADER }));
  const allocated = await inA((tx) =>
    registers.allocateNumber(tx, {
      registerId: register.id,
      documentId,
      issuedAt: NOW,
      symbolPattern: '{number}/{type}-{agency}',
      parts: { type: 'QD', agency: register.registerCode },
      allocatedBy: CLERK,
    }),
  );
  await inA((tx) => outgoing.markNumbered(tx, id, { expectedVersion: 2, registerId: register.id, allocationId: allocated.allocationId, numberedAt: new Date(NOW.getTime() + MINUTE), clerk: CLERK }));
  return { id, documentId, allocationId: allocated.allocationId, number: allocated.number, version: 3 };
}

async function sealed(): Promise<Made> {
  const made = await numbered();
  await inA((tx) => outgoing.markSealed(tx, made.id, { expectedVersion: made.version, sealedAt: new Date(NOW.getTime() + 2 * MINUTE), actor: CLERK }));
  return { ...made, version: made.version + 1 };
}

async function issued(): Promise<Made> {
  const made = await sealed();
  await inA((tx) => outgoing.markIssued(tx, made.id, { expectedVersion: made.version, issuedAt: new Date(NOW.getTime() + 3 * MINUTE), actor: CLERK }));
  return { ...made, version: made.version + 1 };
}

async function delivered(): Promise<Made> {
  const made = await issued();
  await inA((tx) => outgoing.markDelivered(tx, made.id, { expectedVersion: made.version, actor: CLERK }));
  return { ...made, version: made.version + 1 };
}

/** A request of a source module that produced this document and is accepted (and issued when the document is). */
async function requestFor(made: Made, issuedToo: boolean): Promise<string> {
  const inserted = await inA((tx) =>
    requests.insertReceived(tx, {
      sourceModule: 'MNE',
      sourceRef: `MNE:report:${randomUUID()}:r1`,
      templateCode: 'QD-DEFAULT',
      payloadSha256: 'e'.repeat(64),
      payloadRef: `tenants/${TENANT_A}/payloads/x.json`,
      eventId: randomUUID(),
      signerHint: null,
      recipientsHint: null,
      requestedBy: CLERK,
    }),
  );
  await inA((tx) => requests.markAccepted(tx, inserted.request.id, { templateId, outgoingDocumentId: made.id, actor: CLERK }));
  if (issuedToo) await inA((tx) => requests.markIssued(tx, made.id, CLERK));
  return inserted.request.id;
}

const recipient = (name: string, overrides: Partial<NewDistribution> = {}): NewDistribution => ({
  recipientKind: 'EXTERNAL_AGENCY',
  recipientUnitId: null,
  recipientName: name,
  recipientCode: null,
  channel: 'PAPER_HANDOVER',
  acknowledgementRequired: true,
  ...overrides,
});

const recallInput = (overrides: Partial<Parameters<OutgoingRecallStore['recall']>[2]> = {}): Parameters<OutgoingRecallStore['recall']>[2] => ({
  reason: 'Wrong figures in table 2',
  basisDocumentId: null,
  notifyRecipients: true,
  actor: LEADER,
  now: new Date(NOW.getTime() + 10 * MINUTE),
  ...overrides,
});

const voidInput = (overrides: Partial<Parameters<OutgoingRecallStore['voidNumber']>[2]> = {}): Parameters<OutgoingRecallStore['voidNumber']>[2] => ({
  reason: 'The organisation seal cannot be completed',
  voidedBy: MANAGER,
  approvedBy: APPROVER,
  now: new Date(NOW.getTime() + 10 * MINUTE),
  ...overrides,
});

const lockedDocument = async (id: string) => {
  const found = await inA((tx) => outgoing.lock(tx, id));
  if (found === undefined) throw new Error('document not found');
  return found;
};

const recallOf = (made: Made, overrides: Partial<Parameters<OutgoingRecallStore['recall']>[2]> = {}) =>
  inA(async (tx) => {
    const document = await outgoing.lock(tx, made.id);
    if (document === undefined) throw new Error('document not found');
    return recalls.recall(tx, document, recallInput(overrides));
  });

const voidOf = (made: Made, overrides: Partial<Parameters<OutgoingRecallStore['voidNumber']>[2]> = {}) =>
  inA(async (tx) => {
    const document = await outgoing.lock(tx, made.id);
    if (document === undefined) throw new Error('document not found');
    return recalls.voidNumber(tx, document, voidInput(overrides));
  });

describe('OutgoingRecallStore (ST-DOC-012)', () => {
  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: 1, path: '/a/1/' },
      { n: 2, path: '/a/2/' },
    ]);
    await harness.seedUnits(TENANT_B, [{ n: 1, path: '/b/1/' }]);
    for (const n of [1, 2, 3, 4, 5]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, 1, 1);
    const seeded = await inA((tx) => documents.seedDefaults(tx, ACTOR));
    layoutProfileId = seeded.layoutProfileId;
    templateId = seeded.templateId;
    register = await inA((tx) => registers.openRegister(tx, { registerCode: 'RCL-1', name: 'Outgoing', direction: 'OUTGOING', organizationUnitId: unitId(1), year: 2026, mode: 'MANAGED', scopeDocTypes: ['QD'], actor: ACTOR }));
  }, 180_000);

  afterAll(() => harness.stop(), 60_000);

  describe('recalling an issued document (AC-ST-DOC-012-1)', () => {
    it('recalls a delivered document: the effect is RECALLED, the reason is kept, the number stays in the ledger as recalled and the next number follows', async () => {
      const made = await delivered();
      const result = await recallOf(made);
      expect(result.from).toBe('DELIVERED');
      expect(result.document).toMatchObject({ status: 'RECALLED', effectStatus: 'RECALLED', recallReason: 'Wrong figures in table 2', recalledBy: LEADER, version: made.version + 1 });
      expect(result.document.recalledAt?.toISOString()).toBe(new Date(NOW.getTime() + 10 * MINUTE).toISOString());
      const entries = await inA((tx) => registers.listEntries(tx, register.id, { limit: 200 }));
      expect(entries.find((entry) => entry.number === made.number)?.status).toBe('RECALLED');
      const [allocation] = await harness.owner<{ status: string }>(TENANT_A, [['select status from machvon.document_number_allocation where id = $1', [made.allocationId]]]);
      expect(allocation?.status).toBe('ALLOCATED');
      const next = await numbered();
      expect(next.number).toBe(made.number + 1);
    });

    it('recalls from each state of a document in force and refuses every other state and a second recall (409)', async () => {
      for (const status of ['ISSUED', 'DELIVERED', 'ACKNOWLEDGED', 'FILED']) {
        const made = await issued();
        if (status !== 'ISSUED') await harness.owner(TENANT_A, [[`update machvon.outgoing_document set status = '${status}' where id = $1`, [made.id]]]);
        const result = await recallOf(made);
        expect(result.from).toBe(status);
        expect(result.document.status).toBe('RECALLED');
      }
      const again = await delivered();
      await recallOf(again);
      expect((await failure(recallOf(again))).code).toBe('DOCUMENT_STATE_INVALID');
      for (const made of [await numbered(), await sealed()]) {
        expect((await failure(recallOf(made))).code).toBe('DOCUMENT_STATE_INVALID');
      }
    });

    it('keeps the relation RECALLS from the recalling document, and needs a basis that is in force for an archived document (RECALL_BASIS_REQUIRED)', async () => {
      const basis = await issued();
      const target = await issued();
      const archived = await issued();
      await harness.owner(TENANT_A, [["update machvon.outgoing_document set status = 'ARCHIVED' where id = $1", [archived.id]]]);
      expect(await failure(recallOf(archived))).toEqual({ code: 'RECALL_BASIS_REQUIRED' });
      expect(await failure(recallOf(target, { basisDocumentId: target.documentId }))).toEqual({ code: 'RECALL_BASIS_REQUIRED' });
      const notInForce = await numbered();
      expect(await failure(recallOf(target, { basisDocumentId: notInForce.documentId }))).toEqual({ code: 'RECALL_BASIS_REQUIRED' });
      expect(await failure(recallOf(target, { basisDocumentId: randomUUID() }))).toEqual({ code: 'RECALL_BASIS_REQUIRED' });
      await recallOf(target, { basisDocumentId: basis.documentId });
      await recallOf(archived, { basisDocumentId: basis.documentId });
      const relations = await harness.owner<{ from_document_id: string; to_document_id: string; relation_kind: string; note: string }>(TENANT_A, [
        ['select from_document_id, to_document_id, relation_kind, note from machvon.document_relation where from_document_id = $1 order by created_at', [basis.documentId]],
      ]);
      expect(relations).toEqual([
        { from_document_id: basis.documentId, to_document_id: target.documentId, relation_kind: 'RECALLS', note: 'Wrong figures in table 2' },
        { from_document_id: basis.documentId, to_document_id: archived.documentId, relation_kind: 'RECALLS', note: 'Wrong figures in table 2' },
      ]);
      // A relation is kept for good: the runtime role cannot delete it.
      expect((await failure(inA((tx) => tx.query('delete from machvon.document_relation')))).sqlState).toBe('42501');
    });

    it('calls off what was not sent and gives the notice to those who have the document, once', async () => {
      const made = await issued();
      const pending = await inA((tx) => distributions.insertIfAbsent(tx, made.id, recipient('Pending agency'), CLERK));
      const failed = await inA((tx) => distributions.insertIfAbsent(tx, made.id, recipient('Failed agency', { channel: 'EMAIL' }), CLERK));
      await inA((tx) => distributions.recordAttempt(tx, failed.record.id, { kind: 'FAILED', errorCode: 'CHANNEL_NOT_CONFIGURED' }, CLERK));
      const sent = await inA((tx) => distributions.insertIfAbsent(tx, made.id, recipient('Sent agency'), CLERK));
      await inA((tx) => distributions.recordAttempt(tx, sent.record.id, { kind: 'SENT', at: NOW }, CLERK));
      const acknowledged = await inA((tx) => distributions.insertIfAbsent(tx, made.id, recipient('Acknowledged agency', { channel: 'LGSP' }), CLERK));
      await inA((tx) => distributions.recordAttempt(tx, acknowledged.record.id, { kind: 'SENT', at: NOW }, CLERK));
      await inA((tx) => distributions.acknowledge(tx, acknowledged.record.id, 2, { acknowledgedAt: new Date(NOW.getTime() + MINUTE), externalRef: null }, CLERK));

      const result = await recallOf(made);
      expect(result.cancelled.map((row) => [row.recipientName, row.status, row.errorCode]).sort()).toEqual([
        ['Failed agency', 'CANCELLED', null],
        ['Pending agency', 'CANCELLED', null],
      ]);
      expect(result.notified.map((row) => [row.recipientName, row.status]).sort()).toEqual([
        ['Acknowledged agency', 'ACKNOWLEDGED'],
        ['Sent agency', 'SENT'],
      ]);
      for (const row of result.notified) expect(row.recallNoticeAt?.toISOString()).toBe(new Date(NOW.getTime() + 10 * MINUTE).toISOString());
      const rows = await inA((tx) => distributions.listFor(tx, made.id));
      expect(rows.find((row) => row.id === pending.record.id)?.recallNoticeAt).toBeNull();
      // The instant of the notice is written once.
      expect((await failure(inA((tx) => tx.query("update machvon.document_distribution set recall_notice_at = now() where id = $1::uuid", [sent.record.id])))).sqlState).toBe('23514');
    });

    it('gives no notice when the issuer asked for none, and still calls off what was not sent', async () => {
      const made = await issued();
      await inA((tx) => distributions.insertIfAbsent(tx, made.id, recipient('Pending agency'), CLERK));
      const sent = await inA((tx) => distributions.insertIfAbsent(tx, made.id, recipient('Sent agency', { channel: 'LGSP' }), CLERK));
      await inA((tx) => distributions.recordAttempt(tx, sent.record.id, { kind: 'SENT', at: NOW }, CLERK));
      const result = await recallOf(made, { notifyRecipients: false });
      expect(result.notified).toEqual([]);
      expect(result.cancelled).toHaveLength(1);
    });

    it('marks the issue request of the source module RECALLED', async () => {
      const made = await issued();
      await requestFor(made, true);
      const result = await recallOf(made);
      expect(result.requestRecalled).toBe(true);
      const [request] = await harness.owner<{ status: string }>(TENANT_A, [['select status from machvon.doc_issue_request where outgoing_document_id = $1', [made.id]]]);
      expect(request?.status).toBe('RECALLED');
      expect((await recallOf(await issued())).requestRecalled).toBe(false);
    });

    it('is final in the database: a recalled document is not in force again and its recall is not rewritten', async () => {
      const made = await delivered();
      await recallOf(made);
      const back = await failure(inA((tx) => tx.query("update machvon.outgoing_document set status = 'ISSUED' where id = $1::uuid", [made.id])));
      expect(back.sqlState).toBe('23514');
      const rewrite = await failure(inA((tx) => tx.query("update machvon.outgoing_document set recall_reason = 'another reason that is long enough' where id = $1::uuid", [made.id])));
      expect(rewrite.sqlState).toBe('23514');
      const effect = await failure(inA((tx) => tx.query("update machvon.document set effect_status = 'EFFECTIVE' where id = $1::uuid", [made.documentId])));
      expect(effect.sqlState).toBe('23514');
    });

    it('does not show a document of one tenant to another', async () => {
      const made = await delivered();
      expect(await harness.tenants.withTenant(ctxB, (tx) => outgoing.lock(tx, made.id))).toBeUndefined();
    });
  });

  describe('voiding the number of a document that cannot be sealed (AC-ST-DOC-012-2)', () => {
    it('refuses the allocator as approver, then voids with a second person: allocation VOIDED, document CANCELLED, the number stays and the next one follows', async () => {
      const made = await numbered();
      expect((await failure(voidOf(made, { voidedBy: CLERK, approvedBy: CLERK }))).code).toBe('SELF_APPROVAL_DENIED');
      expect((await failure(voidOf(made, { voidedBy: MANAGER, approvedBy: CLERK }))).code).toBe('SELF_APPROVAL_DENIED');
      expect((await failure(voidOf(made, { voidedBy: MANAGER, approvedBy: MANAGER }))).code).toBe('SELF_APPROVAL_DENIED');
      expect((await lockedDocument(made.id)).status).toBe('NUMBERED');

      const result = await voidOf(made);
      expect(result.from).toBe('NUMBERED');
      expect(result.entry).toMatchObject({ number: made.number, status: 'VOIDED' });
      expect(result.document).toMatchObject({ status: 'CANCELLED', cancelReason: 'The organisation seal cannot be completed', effectStatus: 'EXPIRED', version: made.version + 1 });
      const [allocation] = await harness.owner<{ status: string; voided_by: string; void_approved_by: string; void_reason: string }>(TENANT_A, [
        ['select status, voided_by, void_approved_by, void_reason from machvon.document_number_allocation where id = $1', [made.allocationId]],
      ]);
      expect(allocation).toEqual({ status: 'VOIDED', voided_by: MANAGER, void_approved_by: APPROVER, void_reason: 'The organisation seal cannot be completed' });
      expect(await inA((tx) => registers.voidedNumbers(tx, register.id))).toContain(made.number);
      expect(await inA((tx) => registers.gaps(tx, register.id))).toEqual([]);
      const next = await numbered();
      expect(next.number).toBeGreaterThan(made.number);
      expect(await inA((tx) => registers.gaps(tx, register.id))).toEqual([]);
    });

    it('voids the number of a sealed document, and ends its open signing sessions', async () => {
      const made = await sealed();
      const result = await voidOf(made);
      expect(result.from).toBe('SEALED');
      expect(result.document.status).toBe('CANCELLED');
      expect(result.sessions).toEqual([]);
    });

    it('refuses a document that is not numbered or sealed, and a voided number a second time', async () => {
      const done = await issued();
      expect((await failure(voidOf(done))).code).toBe('DOCUMENT_STATE_INVALID');
      const made = await numbered();
      await voidOf(made);
      expect((await failure(voidOf(made))).code).toBe('DOCUMENT_STATE_INVALID');
    });

    it('calls off the issue request the document came from', async () => {
      const made = await numbered();
      const requestId = await requestFor(made, false);
      await harness.owner(TENANT_A, [['update machvon.outgoing_document set issue_request_id = $2::uuid where id = $1', [made.id, requestId]]]);
      const result = await voidOf(made);
      expect(result.requestCancelled).toBe(true);
      const [request] = await harness.owner<{ status: string }>(TENANT_A, [['select status from machvon.doc_issue_request where id = $1', [requestId]]]);
      expect(request?.status).toBe('CANCELLED');
    });
  });

  describe('a number is never given back (V1224)', () => {
    it('is never deleted, never changes its register, number or document, and a voided number never changes', async () => {
      const made = await numbered();
      expect((await failure(inA((tx) => tx.query('delete from machvon.document_number_allocation where id = $1::uuid', [made.allocationId])))).sqlState).toBe('42501');
      expect((await failure(inA((tx) => tx.query('update machvon.document_number_allocation set number = number + 100 where id = $1::uuid', [made.allocationId])))).sqlState).toBe('42501');
      expect((await failure(inA((tx) => tx.query("update machvon.document_number_allocation set symbol = 'changed' where id = $1::uuid", [made.allocationId])))).sqlState).toBe('42501');
      await voidOf(made);
      expect((await failure(inA((tx) => tx.query("update machvon.document_number_allocation set void_reason = 'another reason' where id = $1::uuid", [made.allocationId])))).sqlState).toBe('42501');
      expect((await failure(inA((tx) => tx.query("update machvon.document_number_allocation set status = 'ALLOCATED' where id = $1::uuid", [made.allocationId])))).sqlState).toBe('42501');
    });

    it('keeps a cancelled document cancelled and its reason as written', async () => {
      const made = await numbered();
      await voidOf(made);
      expect((await failure(inA((tx) => tx.query("update machvon.outgoing_document set status = 'DRAFT' where id = $1::uuid", [made.id])))).sqlState).toBe('23514');
      expect((await failure(inA((tx) => tx.query("update machvon.outgoing_document set cancel_reason = 'rewritten later' where id = $1::uuid", [made.id])))).sqlState).toBe('23514');
    });
  });
});
