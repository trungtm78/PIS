import { randomUUID } from 'node:crypto';
import { DomainError, INTEROP_MAX_ATTEMPTS, planFailure } from '@machvon/kernel';
import { DocIncomingStore } from '../src/doc-incoming-store';
import { DocInteropStore } from '../src/doc-interop-store';
import type { InteropRecord, NewInboundMessage, NewOutboundMessage } from '../src/doc-interop-store';
import { DocumentDistributionStore } from '../src/document-distribution-store';
import { DocumentStore } from '../src/document-store';
import { NumberRegisterStore } from '../src/number-register-store';
import { OutgoingDocumentStore } from '../src/outgoing-document-store';
import { ACTOR, AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

jest.setTimeout(240_000);

const harness = new AuthzHarness();
const documents = new DocumentStore();
const outgoing = new OutgoingDocumentStore();
const registers = new NumberRegisterStore();
const distributions = new DocumentDistributionStore();
const incoming = new DocIncomingStore();
const store = new DocInteropStore();
const DRAFTER = memberId(1);
const LEADER = memberId(2);
const CLERK = memberId(3);
const WORKER = memberId(4);
const NOW = new Date('2026-11-03T03:00:00Z');
const MINUTE = 60_000;
let layoutProfileId = '';
let registerId = '';

const ctxA = contextFor(TENANT_A, memberId(1));
const ctxB = contextFor(TENANT_B, memberId(1));
const inA = <T>(work: Parameters<typeof harness.tenants.withTenant<T>>[1]) => harness.tenants.withTenant(ctxA, work);
const inB = <T>(work: Parameters<typeof harness.tenants.withTenant<T>>[1]) => harness.tenants.withTenant(ctxB, work);
const rowsA = <R extends object>(sql: string, params: unknown[] = []) => harness.owner<R>(TENANT_A, [[sql, params]]);

async function failure(promise: Promise<unknown>): Promise<{ code: string; status?: number; sqlState?: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return { code: error.code, status: error.status, message: error.message };
    return { code: 'DB', sqlState: (error as { code?: string }).code, message: (error as Error).message };
  }
  throw new Error('expected a rejection');
}

/** An outgoing document taken through the store up to SEALED, as the distribution store test does. */
async function sealed(): Promise<{ id: string; documentId: string }> {
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
  await harness.owner(TENANT_A, [[`update machvon.document set symbol = $2, issued_on = '2026-11-03', document_number = 1, number_year = 2026 where id = $1::uuid`, [documentId, `1/QD-${id.slice(0, 6)}`]]]);
  await inA((tx) => outgoing.markSigned(tx, id, { expectedVersion: 1, signedAt: NOW, actor: LEADER }));
  await inA((tx) => outgoing.markNumbered(tx, id, { expectedVersion: 2, registerId, allocationId: randomUUID(), numberedAt: new Date(NOW.getTime() + MINUTE), clerk: CLERK }));
  await inA((tx) => outgoing.markSealed(tx, id, { expectedVersion: 3, sealedAt: new Date(NOW.getTime() + 2 * MINUTE), actor: CLERK }));
  return { id, documentId };
}

const digest = (): string => randomUUID().replaceAll('-', '').repeat(2);

/** A distribution on the LGSP channel and the input of the message that carries it. */
async function lgsp(recipient = `Agency ${randomUUID().slice(0, 8)}`): Promise<{ outgoingId: string; distributionId: string; input: NewOutboundMessage }> {
  const doc = await sealed();
  const row = await inA((tx) =>
    distributions.insertIfAbsent(tx, doc.id, { recipientKind: 'EXTERNAL_AGENCY', recipientUnitId: null, recipientName: recipient, recipientCode: 'G08.SKHDT', channel: 'LGSP', acknowledgementRequired: true }, CLERK),
  );
  const input: NewOutboundMessage = {
    id: randomUUID(),
    documentId: doc.documentId,
    distributionId: row.record.id,
    adapterCode: 'LGSP_EDXML',
    adapterStatus: 'MOCK',
    senderCode: 'G08.SO-XD',
    receiverCode: 'G08.SKHDT',
    envelopeSha256: digest(),
    envelopeObjectKey: `tenants/${TENANT_A}/interop-envelope/${randomUUID()}`,
  };
  return { outgoingId: doc.id, distributionId: row.record.id, input };
}

async function queued(): Promise<InteropRecord> {
  const { input } = await lgsp();
  return (await inA((tx) => store.insertOutbound(tx, input, CLERK))).record;
}

const inbound = (overrides: Partial<NewInboundMessage> = {}): NewInboundMessage => ({
  adapterCode: 'LGSP_EDXML',
  adapterStatus: 'MOCK',
  externalMessageId: `E-IN-${randomUUID().slice(0, 8)}`,
  senderCode: 'G08.BTC',
  envelopeSha256: digest(),
  envelopeObjectKey: `tenants/${TENANT_A}/uploads/${randomUUID()}`,
  ...overrides,
});

/** The message failed `count` times in a row, each time at the moment its wait ended; returns it after the last failure. */
async function failed(record: InteropRecord, count: number): Promise<InteropRecord> {
  let current = record;
  let clock = NOW;
  for (let n = 0; n < count; n += 1) {
    const before = current;
    const plan = planFailure(before.attempts, clock);
    current = await inA(async (tx) => {
      const queuedAgain = before.status === 'FAILED' ? await store.requeue(tx, before, WORKER) : before;
      return store.markFailed(tx, queuedAgain, plan, { errorCode: 'PROVIDER_UNAVAILABLE', adapterStatus: 'MOCK' }, WORKER);
    });
    if (plan.nextAttemptAt !== null) clock = plan.nextAttemptAt;
  }
  return current;
}

describe('DocInteropStore and the messages of the LGSP (ST-DOC-021, DOC 3 F13)', () => {
  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: 1, path: '/a/1/' },
      { n: 2, path: '/a/2/' },
    ]);
    await harness.seedUnits(TENANT_B, [{ n: 1, path: '/b/1/' }]);
    for (const n of [1, 2, 3, 4]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, 1, 1);
    layoutProfileId = (await inA((tx) => documents.seedDefaults(tx, ACTOR))).layoutProfileId;
    registerId = (await inA((tx) => registers.openRegister(tx, { registerCode: 'LGSP-1', name: 'Outgoing', direction: 'OUTGOING', organizationUnitId: unitId(1), year: 2026, mode: 'MANAGED', scopeDocTypes: ['QD'], actor: ACTOR }))).id;
  }, 240_000);

  afterAll(() => harness.stop(), 60_000);

  describe('the message that leaves', () => {
    it('is written QUEUED for a distribution, once: the same row comes back for the same distribution (AC-ST-DOC-021-1)', async () => {
      const { input, distributionId, outgoingId } = await lgsp();
      const first = await inA((tx) => store.insertOutbound(tx, input, CLERK));
      expect(first.created).toBe(true);
      expect(first.record).toMatchObject({
        id: input.id,
        direction: 'OUTBOUND',
        status: 'QUEUED',
        attempts: 0,
        nextAttemptAt: null,
        errorCode: null,
        externalMessageId: null,
        adapterCode: 'LGSP_EDXML',
        adapterStatus: 'MOCK',
        senderCode: 'G08.SO-XD',
        receiverCode: 'G08.SKHDT',
        distributionId,
        outgoingDocumentId: outgoingId,
        incomingDocumentId: null,
        processedAt: null,
        version: 1,
      });
      const again = await inA((tx) => store.insertOutbound(tx, { ...input, id: randomUUID(), envelopeSha256: digest() }, LEADER));
      expect(again.created).toBe(false);
      expect(again.record.id).toBe(input.id);
    });

    it('answers two queuings of one distribution that race with one message', async () => {
      const { input } = await lgsp();
      const results = await Promise.all([inA((tx) => store.insertOutbound(tx, input, CLERK)), inA((tx) => store.insertOutbound(tx, { ...input, id: randomUUID() }, LEADER))]);
      expect(results.filter((result) => result.created)).toHaveLength(1);
      expect(results[0]?.record.id).toBe(results[1]?.record.id);
    });

    it('is handed over: SENT with the id the gateway gave it, the attempt counted, no error left (AC-ST-DOC-021-1)', async () => {
      const message = await queued();
      const sent = await inA((tx) => store.markSent(tx, message, { externalMessageId: 'LGSP-77', adapterStatus: 'VERIFIED' }, WORKER));
      expect(sent).toMatchObject({ status: 'SENT', attempts: 1, externalMessageId: 'LGSP-77', adapterStatus: 'VERIFIED', errorCode: null, nextAttemptAt: null, version: 2 });
      expect((await inA((tx) => store.find(tx, message.id)))?.status).toBe('SENT');
    });

    it('goes QUEUED, SENT after attempt 5 and ACKED when four attempts failed first (AC-ST-DOC-021-1, UAT-AC425)', async () => {
      const message = await failed(await queued(), 4);
      expect(message).toMatchObject({ status: 'FAILED', attempts: 4, errorCode: 'PROVIDER_UNAVAILABLE' });
      expect(Date.parse(message.nextAttemptAt as string)).toBeGreaterThan(NOW.getTime());
      const sent = await inA(async (tx) => store.markSent(tx, await store.requeue(tx, message, WORKER), { externalMessageId: 'LGSP-5', adapterStatus: 'MOCK' }, WORKER));
      expect(sent).toMatchObject({ status: 'SENT', attempts: 5, errorCode: null, nextAttemptAt: null });
      const acked = await inA((tx) => store.markAcknowledged(tx, sent, new Date(NOW.getTime() + MINUTE), WORKER));
      expect(acked).toMatchObject({ status: 'ACKED', attempts: 5, processedAt: new Date(NOW.getTime() + MINUTE).toISOString() });
    });

    it('is DEAD on the twentieth failure, with its reason and no next attempt (AC-ST-DOC-021-1, UAT-AC425)', async () => {
      const message = await failed(await queued(), 19);
      expect(message).toMatchObject({ status: 'FAILED', attempts: 19 });
      const dead = await failed(message, 1);
      expect(dead).toMatchObject({ status: 'DEAD', attempts: INTEROP_MAX_ATTEMPTS, nextAttemptAt: null, errorCode: 'PROVIDER_UNAVAILABLE' });
      expect(await inA((tx) => store.countByStatus(tx, ['DEAD']))).toBeGreaterThanOrEqual(1);
    });

    it('is refused by the receiving agency: REJECTED with the code of the reason', async () => {
      const sent = await inA(async (tx) => store.markSent(tx, await queued(), { externalMessageId: `LGSP-${randomUUID().slice(0, 6)}`, adapterStatus: 'MOCK' }, WORKER));
      const rejected = await inA((tx) => store.markRejected(tx, sent, { errorCode: 'RECEIVER_UNKNOWN', at: NOW }, WORKER));
      expect(rejected).toMatchObject({ status: 'REJECTED', errorCode: 'RECEIVER_UNKNOWN', processedAt: NOW.toISOString() });
    });

    it.each([
      ['acknowledge a message that was not sent', (record: InteropRecord) => inA((tx) => store.markAcknowledged(tx, record, NOW, WORKER))],
      ['reject a message that was not sent', (record: InteropRecord) => inA((tx) => store.markRejected(tx, record, { errorCode: 'X_REASON', at: NOW }, WORKER))],
      ['requeue a message that is not failed', (record: InteropRecord) => inA((tx) => store.requeue(tx, record, WORKER))],
    ])('refuses to %s with 409 INTEROP_STATE_INVALID', async (_name, move) => {
      const refusal = await failure(move(await queued()));
      expect([refusal.code, refusal.status]).toEqual(['INTEROP_STATE_INVALID', 409]);
    });

    it('is not moved twice: a message another pass already took is refused, not written over', async () => {
      const message = await queued();
      await inA((tx) => store.markSent(tx, message, { externalMessageId: 'LGSP-ONCE', adapterStatus: 'MOCK' }, WORKER));
      const refusal = await failure(inA((tx) => store.markSent(tx, message, { externalMessageId: 'LGSP-TWICE', adapterStatus: 'MOCK' }, WORKER)));
      expect(refusal.code).toBe('INTEROP_STATE_INVALID');
      expect((await inA((tx) => store.find(tx, message.id)))?.externalMessageId).toBe('LGSP-ONCE');
    });
  });

  describe('the messages that are due', () => {
    it('are the queued ones and the failed ones whose wait is over, oldest due first, and no other (AC-ST-DOC-021-1)', async () => {
      const fresh = await queued();
      const waiting = await failed(await queued(), 1);
      const ripe = await failed(await queued(), 1);
      const sent = await inA(async (tx) => store.markSent(tx, await queued(), { externalMessageId: `LGSP-${randomUUID().slice(0, 6)}`, adapterStatus: 'MOCK' }, WORKER));
      const afterWait = new Date(Date.parse(ripe.nextAttemptAt as string) + 1);
      const due = await inA((tx) => store.dueForAttempt(tx, afterWait, 500));
      const ids = due.map((record) => record.id);
      expect(ids).toContain(fresh.id);
      expect(ids).toContain(ripe.id);
      expect(ids).not.toContain(sent.id);
      // The wait of the other failed message ends at the same minute: it is due too, a minute earlier it is not.
      const beforeWait = new Date(Date.parse(waiting.nextAttemptAt as string) - 1);
      expect((await inA((tx) => store.dueForAttempt(tx, beforeWait, 500))).map((record) => record.id)).not.toContain(waiting.id);
    });

    it('are locked by the pass that takes them, and a second pass leaves them alone', async () => {
      const message = await queued();
      await inA(async (tx) => {
        const first = await store.dueForAttempt(tx, NOW, 500);
        expect(first.map((record) => record.id)).toContain(message.id);
        // Another pass, on a connection of its own, finds the message taken.
        const second = await harness.tenants.withTenant(ctxA, (other) => store.dueForAttempt(other, NOW, 500));
        expect(second.map((record) => record.id)).not.toContain(message.id);
      });
    });

    it('come oldest due first: by the end of the wait for a failed one, by the moment of writing for a queued one', async () => {
      const late = await queued();
      const waited = await failed(await queued(), 1);
      const early = await queued();
      await harness.owner(TENANT_A, [
        ["update machvon.doc_interop_message set created_at = '2026-11-03T05:00:00Z' where id = $1", [late.id]],
        ["update machvon.doc_interop_message set next_attempt_at = '2026-11-03T04:00:00Z' where id = $1", [waited.id]],
        ["update machvon.doc_interop_message set created_at = '2026-11-03T03:00:00Z' where id = $1", [early.id]],
      ]);
      const order = (await inA((tx) => store.dueForAttempt(tx, new Date('2026-11-03T06:00:00Z'), 500))).map((record) => record.id).filter((id) => [late.id, waited.id, early.id].includes(id));
      expect(order).toEqual([early.id, waited.id, late.id]);
    });

    it('are limited to the batch asked for', async () => {
      await queued();
      await queued();
      expect(await inA((tx) => store.dueForAttempt(tx, NOW, 1))).toHaveLength(1);
    });

    it('lists the messages that wait for a receipt, the longest waiting first', async () => {
      const sent = await inA(async (tx) => store.markSent(tx, await queued(), { externalMessageId: `LGSP-${randomUUID().slice(0, 6)}`, adapterStatus: 'MOCK' }, WORKER));
      const waiting = await inA((tx) => store.awaitingReceipt(tx, 500));
      expect(waiting.every((record) => record.status === 'SENT')).toBe(true);
      expect(waiting.map((record) => record.id)).toContain(sent.id);
      expect(await inA((tx) => store.awaitingReceipt(tx, 0))).toEqual([]);
    });

    it('rotates: the messages not asked for the longest come first, so a batch that stays pending does not hold the others back (AC-ST-DOC-021-1)', async () => {
      const batch = 50;
      for (let n = 0; n < 60; n += 1) await inA(async (tx) => store.markSent(tx, await queued(), { externalMessageId: `LGSP-${randomUUID().slice(0, 8)}`, adapterStatus: 'MOCK' }, WORKER));
      const total = (await inA((tx) => store.awaitingReceipt(tx, 1000))).length;
      expect(total).toBeGreaterThanOrEqual(60);

      const first = await inA((tx) => store.awaitingReceipt(tx, batch));
      expect(first).toHaveLength(batch);
      // Every one of them is asked and stays pending: only the moment of the poll is written, not the version or the time of the last change.
      const before = await inA((tx) => store.find(tx, first[0]?.id as string));
      await inA(async (tx) => {
        for (const record of first) await store.recordReceiptPoll(tx, record.id, NOW);
      });
      const after = await inA((tx) => store.find(tx, first[0]?.id as string));
      expect(after).toMatchObject({ status: 'SENT', version: before?.version, updatedAt: before?.updatedAt, attempts: before?.attempts });
      expect(await rowsA<{ polled: number }>('select count(*)::int as polled from machvon.doc_interop_message where last_polled_at = $1::timestamptz', [NOW.toISOString()])).toEqual([{ polled: batch }]);

      // The next pass takes every message never asked before any that was asked.
      const asked = new Set(first.map((record) => record.id));
      const neverAsked = Math.min(total - batch, batch);
      expect(neverAsked).toBeGreaterThanOrEqual(10);
      const second = await inA((tx) => store.awaitingReceipt(tx, batch));
      expect(second.slice(0, neverAsked).filter((record) => !asked.has(record.id))).toHaveLength(neverAsked);

      // Once every message was asked, those asked the longest ago come first.
      const later = new Date(NOW.getTime() + MINUTE);
      await inA(async (tx) => {
        for (const record of await store.awaitingReceipt(tx, 1000)) if (!asked.has(record.id)) await store.recordReceiptPoll(tx, record.id, later);
      });
      const third = await inA((tx) => store.awaitingReceipt(tx, batch));
      expect(third.filter((record) => asked.has(record.id))).toHaveLength(batch);
    });

    it('writes the moment of a poll only while the message waits for its receipt (AC-ST-DOC-021-1)', async () => {
      const waiting = await queued();
      const early = await failure(inA((tx) => store.recordReceiptPoll(tx, waiting.id, NOW)));
      expect([early.code, early.status]).toEqual(['INTEROP_STATE_INVALID', 409]);
      const sent = await inA((tx) => store.markSent(tx, waiting, { externalMessageId: `LGSP-${randomUUID().slice(0, 8)}`, adapterStatus: 'MOCK' }, WORKER));
      await inA((tx) => store.recordReceiptPoll(tx, sent.id, NOW));
      // The database says the same to a writer that bypasses the store: a message that is not SENT has no poll to write, and one that ended is kept as it is.
      const queuedOnly = await queued();
      const direct = await failure(inA((tx) => tx.query('update machvon.doc_interop_message set last_polled_at = now() where id = $1::uuid', [queuedOnly.id])));
      expect(direct.sqlState).toBe('23514');
      await inA((tx) => store.markAcknowledged(tx, sent, new Date(NOW.getTime() + MINUTE), WORKER));
      const ended = await failure(inA((tx) => tx.query('update machvon.doc_interop_message set last_polled_at = now() where id = $1::uuid', [sent.id])));
      expect(ended.sqlState).toBe('23514');
    });
  });

  describe('sending again by hand (retryInteropMessage, AC-ST-DOC-021-1)', () => {
    it('takes a dead message back to QUEUED with a fresh count of attempts', async () => {
      const dead = await failed(await queued(), 20);
      expect(dead.status).toBe('DEAD');
      const { before, record } = await inA((tx) => store.retry(tx, dead.id, dead.version, CLERK));
      expect(before).toMatchObject({ status: 'DEAD', attempts: 20 });
      expect(record).toMatchObject({ status: 'QUEUED', attempts: 0, nextAttemptAt: null, errorCode: 'PROVIDER_UNAVAILABLE', version: dead.version + 1 });
      expect(await rowsA<{ updated_by: string }>('select updated_by from machvon.doc_interop_message where id = $1', [dead.id])).toEqual([{ updated_by: CLERK }]);
    });

    it('takes a failed message back to QUEUED and keeps its count, so the twenty attempts remain the bound', async () => {
      const failing = await failed(await queued(), 3);
      const { record } = await inA((tx) => store.retry(tx, failing.id, failing.version, CLERK));
      expect(record).toMatchObject({ status: 'QUEUED', attempts: 3, nextAttemptAt: null });
    });

    it('refuses a stale version with 409 VERSION_CONFLICT', async () => {
      const failing = await failed(await queued(), 1);
      const refusal = await failure(inA((tx) => store.retry(tx, failing.id, failing.version + 5, CLERK)));
      expect([refusal.code, refusal.status]).toEqual(['VERSION_CONFLICT', 409]);
    });

    it.each(['queued', 'sent', 'acked'] as const)('refuses a %s message with 409 INTEROP_STATE_INVALID', async (kind) => {
      let record = await queued();
      if (kind !== 'queued') record = await inA((tx) => store.markSent(tx, record, { externalMessageId: `LGSP-${randomUUID().slice(0, 6)}`, adapterStatus: 'MOCK' }, WORKER));
      if (kind === 'acked') record = await inA((tx) => store.markAcknowledged(tx, record, NOW, WORKER));
      const refusal = await failure(inA((tx) => store.retry(tx, record.id, record.version, CLERK)));
      expect([refusal.code, refusal.status]).toEqual(['INTEROP_STATE_INVALID', 409]);
    });

    it('refuses a message that arrived: nothing is sent for it', async () => {
      const received = (await inA((tx) => store.insertInbound(tx, inbound(), CLERK))).record;
      const refusal = await failure(inA((tx) => store.retry(tx, received.id, received.version, CLERK)));
      expect(refusal.code).toBe('INTEROP_STATE_INVALID');
    });

    it('is 404 for a message that does not exist, or that another tenant holds', async () => {
      const message = await queued();
      expect((await failure(inA((tx) => store.retry(tx, randomUUID(), 1, CLERK)))).code).toBe('RESOURCE_NOT_FOUND');
      expect((await failure(inB((tx) => store.retry(tx, message.id, message.version, CLERK)))).code).toBe('RESOURCE_NOT_FOUND');
    });
  });

  describe('the distributions that are called off (the recall of the document)', () => {
    it('end the messages that did not leave as REJECTED with that reason, and leave the ones that did', async () => {
      const waiting = await queued();
      const failing = await failed(await queued(), 2);
      const sent = await inA(async (tx) => store.markSent(tx, await queued(), { externalMessageId: `LGSP-${randomUUID().slice(0, 6)}`, adapterStatus: 'MOCK' }, WORKER));
      const ended = await inA((tx) => store.cancelOfDistributions(tx, [waiting, failing, sent].map((record) => record.distributionId as string), NOW, CLERK));
      expect(ended.map((record) => record.id).sort()).toEqual([waiting.id, failing.id].sort());
      for (const record of ended) expect(record).toMatchObject({ status: 'REJECTED', errorCode: 'DISTRIBUTION_CANCELLED', nextAttemptAt: null, processedAt: NOW.toISOString() });
      expect((await inA((tx) => store.find(tx, sent.id)))?.status).toBe('SENT');
      expect(await inA((tx) => store.cancelOfDistributions(tx, [], NOW, CLERK))).toEqual([]);
    });
  });

  describe('the message that arrives', () => {
    it('is written RECEIVED once, and a digest or an id seen before is the message that came again (AC-ST-DOC-021-2, UAT-AC425)', async () => {
      const message = inbound();
      const first = await inA((tx) => store.insertInbound(tx, message, CLERK));
      expect(first.created).toBe(true);
      expect(first.record).toMatchObject({ direction: 'INBOUND', status: 'RECEIVED', senderCode: 'G08.BTC', receiverCode: null, distributionId: null, documentId: null, attempts: 0, externalMessageId: message.externalMessageId, envelopeSha256: message.envelopeSha256 });
      const sameDigest = await inA((tx) => store.insertInbound(tx, { ...message, externalMessageId: 'E-IN-OTHER' }, LEADER));
      expect(sameDigest).toMatchObject({ created: false, record: { id: first.record.id } });
      const sameId = await inA((tx) => store.insertInbound(tx, { ...message, envelopeSha256: digest() }, LEADER));
      expect(sameId).toMatchObject({ created: false, record: { id: first.record.id } });
      expect(await rowsA('select 1 from machvon.doc_interop_message where direction = $1 and envelope_sha256 = $2', ['INBOUND', message.envelopeSha256])).toHaveLength(1);
    });

    it('is one row when two deliveries of the same envelope race', async () => {
      const message = inbound();
      const results = await Promise.all([inA((tx) => store.insertInbound(tx, message, CLERK)), inA((tx) => store.insertInbound(tx, message, LEADER))]);
      expect(results.filter((result) => result.created)).toHaveLength(1);
      expect(results[0]?.record.id).toBe(results[1]?.record.id);
    });

    it('does not collide with a message that left with the same digest, nor with the same envelope of another tenant', async () => {
      const message = inbound();
      const { input } = await lgsp();
      await inA((tx) => store.insertOutbound(tx, { ...input, envelopeSha256: message.envelopeSha256 }, CLERK));
      expect((await inA((tx) => store.insertInbound(tx, message, CLERK))).created).toBe(true);
      expect((await inB((tx) => store.insertInbound(tx, message, CLERK))).created).toBe(true);
    });

    it('is PROCESSED once the document is made, and links to the one letter made from it (AC-ST-DOC-021-2)', async () => {
      const received = (await inA((tx) => store.insertInbound(tx, inbound(), CLERK))).record;
      const documentId = await inA(async (tx) => (await documents.insertDocument(tx, { docKind: 'INCOMING', docTypeCode: 'QD', title: 'Letter', classification: 'INTERNAL', createdBy: CLERK })).id);
      const letter = await inA((tx) =>
        incoming.insert(tx, { documentId, channel: 'LGSP', receivedAt: NOW, receivedBy: CLERK, originalSymbol: '12/BTC', originalIssuedOn: '2026-11-02', senderName: 'Bo Tai chinh', urgency: 'NORMAL', duplicateOfId: undefined, duplicateOverrideReason: undefined, interopMessageId: received.id }),
      );
      const processed = await inA((tx) => store.markProcessed(tx, received, { documentId, at: NOW }, CLERK));
      expect(processed).toMatchObject({ status: 'PROCESSED', documentId, incomingDocumentId: letter.id, processedAt: NOW.toISOString(), version: 2 });
      // A second letter for the same message cannot be.
      const otherDocument = await inA(async (tx) => (await documents.insertDocument(tx, { docKind: 'INCOMING', docTypeCode: 'QD', title: 'Letter 2', classification: 'INTERNAL', createdBy: CLERK })).id);
      const second = await failure(
        inA((tx) =>
          incoming.insert(tx, { documentId: otherDocument, channel: 'LGSP', receivedAt: NOW, receivedBy: CLERK, originalSymbol: '13/BTC', originalIssuedOn: '2026-11-02', senderName: 'Bo Tai chinh', urgency: 'NORMAL', duplicateOfId: undefined, duplicateOverrideReason: undefined, interopMessageId: received.id }),
        ),
      );
      expect(second).toMatchObject({ code: 'DB', sqlState: '23505' });
    });

    it('is not processed twice', async () => {
      const received = (await inA((tx) => store.insertInbound(tx, inbound(), CLERK))).record;
      const documentId = await inA(async (tx) => (await documents.insertDocument(tx, { docKind: 'INCOMING', docTypeCode: 'QD', title: 'Letter', classification: 'INTERNAL', createdBy: CLERK })).id);
      await inA((tx) => store.markProcessed(tx, received, { documentId, at: NOW }, CLERK));
      expect((await failure(inA((tx) => store.markProcessed(tx, received, { documentId, at: NOW }, CLERK)))).code).toBe('INTEROP_STATE_INVALID');
    });
  });

  describe('the monitor', () => {
    it('lists the latest first, in pages, and filters by status and direction', async () => {
      const older = await queued();
      const newer = await queued();
      const received = (await inA((tx) => store.insertInbound(tx, inbound(), CLERK))).record;
      const page = await inA((tx) => store.list(tx, {}, { limit: 2 }));
      expect(page.records).toHaveLength(2);
      expect(page.next).toBeDefined();
      const all: InteropRecord[] = [];
      for (let after = undefined as { code: string; id: string } | undefined; ; ) {
        const next = await inA((tx) => store.list(tx, {}, { limit: 3, after }));
        all.push(...next.records);
        if (next.next === undefined) break;
        after = next.next;
      }
      const ids = all.map((record) => record.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
      expect(ids).toContain(received.id);
      const sorted = [...all].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      expect(ids).toEqual(sorted.map((record) => record.id));
      const inboundOnly = await inA((tx) => store.list(tx, { direction: 'INBOUND' }, { limit: 200 }));
      expect(inboundOnly.records.every((record) => record.direction === 'INBOUND')).toBe(true);
      const receivedOnly = await inA((tx) => store.list(tx, { status: 'RECEIVED', direction: 'INBOUND' }, { limit: 200 }));
      expect(receivedOnly.records.map((record) => record.id)).toContain(received.id);
      expect((await inA((tx) => store.list(tx, { status: 'DEAD' }, { limit: 200 }))).records.every((record) => record.status === 'DEAD')).toBe(true);
    });

    it('refuses a cursor that is not one of its own with 422 VALIDATION_FAILED', async () => {
      const refusal = await failure(inA((tx) => store.list(tx, {}, { limit: 5, after: { code: 'not a time', id: randomUUID() } })));
      expect([refusal.code, refusal.status]).toEqual(['VALIDATION_FAILED', 422]);
    });

    it('does not show the messages of a tenant to another', async () => {
      const message = await queued();
      expect(await inB((tx) => store.find(tx, message.id))).toBeUndefined();
      // The other tenant has its own messages (one arrived with the same envelope above) and none of this tenant's.
      expect((await inB((tx) => store.list(tx, {}, { limit: 200 }))).records.map((record) => record.id)).not.toContain(message.id);
      expect(await inB((tx) => store.countByStatus(tx, ['QUEUED']))).toBe(0);
    });
  });

  describe('the rules the database keeps whoever writes (V1230)', () => {
    const update = (id: string, set: string, params: unknown[] = []) => inA((tx) => tx.query(`update machvon.doc_interop_message set ${set} where id = $1::uuid`, [id, ...params]));

    it.each([
      ['the direction', "direction = 'INBOUND'"],
      ['the envelope digest', `envelope_sha256 = '${'f'.repeat(64)}'`],
      ['the envelope key', "envelope_object_key = 'tenants/other/key-0001'"],
      ['the receiver', "receiver_code = 'SOMEONE.ELSE'"],
      ['the adapter code', "adapter_code = 'OTHER'"],
      ['the distribution', 'distribution_id = null'],
    ])('never changes %s of a message', async (_name, set) => {
      const message = await queued();
      expect((await failure(update(message.id, set))).sqlState).toBe('23514');
    });

    it('writes the id of the gateway and the document once', async () => {
      const sent = await inA(async (tx) => store.markSent(tx, await queued(), { externalMessageId: 'LGSP-FIX', adapterStatus: 'MOCK' }, WORKER));
      expect((await failure(update(sent.id, "external_message_id = 'LGSP-CHANGED'"))).sqlState).toBe('23514');
    });

    it.each([
      ['QUEUED to ACKED', "status = 'ACKED', processed_at = now()"],
      ['QUEUED to PROCESSED', "status = 'PROCESSED', processed_at = now()"],
    ])('refuses the move %s', async (_name, set) => {
      const message = await queued();
      expect((await failure(update(message.id, set))).sqlState).toBe('23514');
    });

    it('refuses to count the attempts back, except for a dead message that is sent again', async () => {
      const failing = await failed(await queued(), 5);
      const refusal = await failure(update(failing.id, "status = 'QUEUED', next_attempt_at = null, attempts = 2"));
      expect(refusal.sqlState).toBe('23514');
      await update(failing.id, "status = 'QUEUED', next_attempt_at = null");
      const dead = await failed(await queued(), 20);
      await update(dead.id, "status = 'QUEUED', attempts = 0");
      expect((await inA((tx) => store.find(tx, dead.id)))?.attempts).toBe(0);
    });

    it('keeps a message that ended as it is', async () => {
      const sent = await inA(async (tx) => store.markSent(tx, await queued(), { externalMessageId: `LGSP-${randomUUID().slice(0, 6)}`, adapterStatus: 'MOCK' }, WORKER));
      const acked = await inA((tx) => store.markAcknowledged(tx, sent, NOW, WORKER));
      expect((await failure(update(acked.id, 'error_code = null'))).sqlState).toBe('23514');
    });

    it('is never deleted, by the runtime role or by anyone in the schema', async () => {
      const message = await queued();
      expect((await failure(inA((tx) => tx.query('delete from machvon.doc_interop_message where id = $1::uuid', [message.id])))).sqlState).toBe('42501');
      expect((await failure(inA((tx) => tx.query('truncate machvon.doc_interop_message')))).sqlState).toBe('42501');
    });

    it('refuses a message written as anything but queued (what leaves) or received (what arrives)', async () => {
      const { input } = await lgsp();
      const written = await failure(
        inA((tx) =>
          tx.query(
            `insert into machvon.doc_interop_message (tenant_id, id, direction, status, attempts, external_message_id, document_id, distribution_id, receiver_code, envelope_sha256, envelope_object_key, created_by, updated_by)
             values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), 'OUTBOUND', 'SENT', 1, 'LGSP-X', $1::uuid, $2::uuid, 'X', $3, 'tenants/x/interop/zzzz', $4::uuid, $4::uuid)`,
            [input.documentId, input.distributionId, digest(), CLERK],
          ),
        ),
      );
      expect(written.sqlState).toBe('23514');
    });

    it.each([
      ['a failed message without a wait', "status = 'FAILED', attempts = 3, error_code = 'PROVIDER_UNAVAILABLE'"],
      ['a failed message without a reason', "status = 'FAILED', attempts = 3, next_attempt_at = now()"],
      ['a dead message that did not use its twenty attempts', "status = 'DEAD', attempts = 7, error_code = 'PROVIDER_UNAVAILABLE'"],
      ['an error code that is not a code', "status = 'FAILED', attempts = 3, next_attempt_at = now(), error_code = 'not a code'"],
    ])('refuses %s', async (_name, set) => {
      const message = await queued();
      expect((await failure(update(message.id, set))).sqlState).toBe('23514');
    });

    it('refuses an envelope digest that is not 64 lower-case hex digits, and a message that leaves with no receiver', async () => {
      const { input } = await lgsp();
      expect((await failure(inA((tx) => store.insertOutbound(tx, { ...input, envelopeSha256: 'F'.repeat(64) }, CLERK)))).sqlState).toBe('23514');
      const second = await lgsp();
      expect((await failure(inA((tx) => store.insertOutbound(tx, { ...second.input, receiverCode: '' }, CLERK)))).sqlState).toBe('23514');
    });

    it('refuses a message that arrives with a distribution or attempts, and one that leaves without a document', async () => {
      const received = (await inA((tx) => store.insertInbound(tx, inbound(), CLERK))).record;
      expect((await failure(update(received.id, 'attempts = 2'))).sqlState).toBe('23514');
      const { input } = await lgsp();
      expect(
        (
          await failure(
            inA((tx) =>
              tx.query(
                "insert into machvon.doc_interop_message (tenant_id, id, direction, distribution_id, receiver_code, envelope_sha256, envelope_object_key, created_by, updated_by) values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), 'OUTBOUND', $1::uuid, 'X', $2, 'tenants/x/interop/zzzz', $3::uuid, $3::uuid)",
                [input.distributionId, digest(), CLERK],
              ),
            ),
          )
        ).sqlState,
      ).toBe('23514');
    });
  });
});
