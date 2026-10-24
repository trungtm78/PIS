import { randomUUID } from 'node:crypto';
import { DomainError } from '@machvon/kernel';
import { DocumentDistributionStore } from '../src/document-distribution-store';
import type { NewDistribution } from '../src/document-distribution-store';
import { DocumentStore } from '../src/document-store';
import { NumberRegisterStore } from '../src/number-register-store';
import { OutgoingDocumentStore } from '../src/outgoing-document-store';
import { ACTOR, AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const documents = new DocumentStore();
const outgoing = new OutgoingDocumentStore();
const registers = new NumberRegisterStore();
const distributions = new DocumentDistributionStore();
const DRAFTER = memberId(1);
const LEADER = memberId(2);
const CLERK = memberId(3);
const NOW = new Date('2026-10-23T03:00:00Z');
const MINUTE = 60_000;
let layoutProfileId = '';
let registerId = '';

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

/** An outgoing document taken through the store up to SEALED, with the anchor fields numbering writes. */
async function sealed(): Promise<{ id: string; documentId: string; version: number }> {
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
  await harness.owner(TENANT_A, [
    [`update machvon.document set symbol = $2, issued_on = '2026-10-23', document_number = 1, number_year = 2026 where id = $1::uuid`, [documentId, `1/QD-${id.slice(0, 6)}`]],
  ]);
  await inA((tx) => outgoing.markSigned(tx, id, { expectedVersion: 1, signedAt: NOW, actor: LEADER }));
  await inA((tx) => outgoing.markNumbered(tx, id, { expectedVersion: 2, registerId, allocationId: randomUUID(), numberedAt: new Date(NOW.getTime() + MINUTE), clerk: CLERK }));
  await inA((tx) => outgoing.markSealed(tx, id, { expectedVersion: 3, sealedAt: new Date(NOW.getTime() + 2 * MINUTE), actor: CLERK }));
  return { id, documentId, version: 4 };
}

const unit = (name: string, overrides: Partial<NewDistribution> = {}): NewDistribution => ({
  recipientKind: 'INTERNAL_UNIT',
  recipientUnitId: unitId(2),
  recipientName: name,
  recipientCode: null,
  channel: 'INTERNAL',
  acknowledgementRequired: true,
  ...overrides,
});
const external = (name: string, overrides: Partial<NewDistribution> = {}): NewDistribution => ({
  recipientKind: 'EXTERNAL_AGENCY',
  recipientUnitId: null,
  recipientName: name,
  recipientCode: 'EXT-1',
  channel: 'PAPER_HANDOVER',
  acknowledgementRequired: true,
  ...overrides,
});

describe('DocumentDistributionStore and the issue of an outgoing document (ST-DOC-010)', () => {
  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: 1, path: '/a/1/' },
      { n: 2, path: '/a/2/' },
    ]);
    await harness.seedUnits(TENANT_B, [{ n: 1, path: '/b/1/' }]);
    for (const n of [1, 2, 3]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, 1, 1);
    layoutProfileId = (await inA((tx) => documents.seedDefaults(tx, ACTOR))).layoutProfileId;
    registerId = (await inA((tx) => registers.openRegister(tx, { registerCode: 'DIST-1', name: 'Outgoing', direction: 'OUTGOING', organizationUnitId: unitId(1), year: 2026, mode: 'MANAGED', scopeDocTypes: ['QD'], actor: ACTOR }))).id;
  }, 180_000);

  afterAll(() => harness.stop(), 60_000);

  describe('writing a recipient once', () => {
    it('writes one row per recipient and channel and finds the same row again, whatever the capitals of the name', async () => {
      const doc = await sealed();
      const first = await inA((tx) => distributions.insertIfAbsent(tx, doc.id, unit('Department of Finance'), CLERK));
      expect(first.created).toBe(true);
      expect(first.record).toMatchObject({ status: 'PENDING', channel: 'INTERNAL', recipientKind: 'INTERNAL_UNIT', acknowledgementRequired: true, attempts: 0, sentAt: null, version: 1 });
      const again = await inA((tx) => distributions.insertIfAbsent(tx, doc.id, unit('DEPARTMENT OF FINANCE'), CLERK));
      expect(again.created).toBe(false);
      expect(again.record.id).toBe(first.record.id);
      const otherChannel = await inA((tx) => distributions.insertIfAbsent(tx, doc.id, external('Department of Finance'), CLERK));
      expect(otherChannel.created).toBe(true);
      expect(await inA((tx) => distributions.count(tx, doc.id))).toBe(2);
      expect((await inA((tx) => distributions.listFor(tx, doc.id))).map((row) => row.channel)).toEqual(['INTERNAL', 'PAPER_HANDOVER']);
    });

    it('answers two dispatches that race with one row', async () => {
      const doc = await sealed();
      const results = await Promise.all([
        inA((tx) => distributions.insertIfAbsent(tx, doc.id, external('Racing agency'), CLERK)),
        inA((tx) => distributions.insertIfAbsent(tx, doc.id, external('Racing agency'), LEADER)),
      ]);
      expect(results.filter((result) => result.created)).toHaveLength(1);
      expect(results[0]?.record.id).toBe(results[1]?.record.id);
      expect(await inA((tx) => distributions.count(tx, doc.id))).toBe(1);
    });

    it('does not show the rows of a document to another tenant', async () => {
      const doc = await sealed();
      const written = await inA((tx) => distributions.insertIfAbsent(tx, doc.id, external('Hidden agency'), CLERK));
      expect(await harness.tenants.withTenant(ctxB, (tx) => distributions.find(tx, written.record.id))).toBeUndefined();
      expect(await harness.tenants.withTenant(ctxB, (tx) => distributions.listFor(tx, doc.id))).toEqual([]);
    });
  });

  describe('the attempts of a channel', () => {
    it('moves PENDING to SENT, or to DELIVERED at once, and counts the attempt', async () => {
      const doc = await sealed();
      const paper = await inA((tx) => distributions.insertIfAbsent(tx, doc.id, external('Paper agency'), CLERK));
      const sent = await inA((tx) => distributions.recordAttempt(tx, paper.record.id, { kind: 'SENT', at: NOW, externalRef: 'HANDOVER-1' }, CLERK));
      expect(sent).toMatchObject({ status: 'SENT', attempts: 1, sentAt: NOW, deliveredAt: null, externalRef: 'HANDOVER-1', errorCode: null, version: 2 });
      const internal = await inA((tx) => distributions.insertIfAbsent(tx, doc.id, unit('Inbox unit'), CLERK));
      const delivered = await inA((tx) => distributions.recordAttempt(tx, internal.record.id, { kind: 'DELIVERED', at: NOW }, CLERK));
      expect(delivered).toMatchObject({ status: 'DELIVERED', attempts: 1, sentAt: NOW, deliveredAt: NOW });
    });

    it('keeps a failed attempt with its reason and lets the same row be sent again, never a second row', async () => {
      const doc = await sealed();
      const mail = await inA((tx) => distributions.insertIfAbsent(tx, doc.id, external('Mail agency', { channel: 'EMAIL' }), CLERK));
      const failed = await inA((tx) => distributions.recordAttempt(tx, mail.record.id, { kind: 'FAILED', errorCode: 'CHANNEL_NOT_CONFIGURED' }, CLERK));
      expect(failed).toMatchObject({ status: 'FAILED', errorCode: 'CHANNEL_NOT_CONFIGURED', attempts: 1, sentAt: null });
      const retried = await inA((tx) => distributions.recordAttempt(tx, mail.record.id, { kind: 'SENT', at: NOW }, CLERK));
      expect(retried).toMatchObject({ status: 'SENT', errorCode: null, attempts: 2, sentAt: NOW });
      expect(await inA((tx) => distributions.count(tx, doc.id))).toBe(1);
    });

    it('refuses an attempt on a row that was already sent, and on a row that does not exist', async () => {
      const doc = await sealed();
      const paper = await inA((tx) => distributions.insertIfAbsent(tx, doc.id, external('Paper agency'), CLERK));
      await inA((tx) => distributions.recordAttempt(tx, paper.record.id, { kind: 'SENT', at: NOW }, CLERK));
      expect((await failure(inA((tx) => distributions.recordAttempt(tx, paper.record.id, { kind: 'SENT', at: NOW }, CLERK)))).code).toBe('DISTRIBUTION_STATE_INVALID');
      expect((await failure(inA((tx) => distributions.recordAttempt(tx, randomUUID(), { kind: 'SENT', at: NOW }, CLERK)))).code).toBe('RESOURCE_NOT_FOUND');
    });
  });

  describe('the receipt', () => {
    it('acknowledges a SENT row and delivers it at the instant of the receipt', async () => {
      const doc = await sealed();
      const paper = await inA((tx) => distributions.insertIfAbsent(tx, doc.id, external('Paper agency'), CLERK));
      await inA((tx) => distributions.recordAttempt(tx, paper.record.id, { kind: 'SENT', at: NOW }, CLERK));
      const receiptAt = new Date(NOW.getTime() + 5 * MINUTE);
      const acknowledged = await inA((tx) => distributions.acknowledge(tx, paper.record.id, 2, { acknowledgedAt: receiptAt, externalRef: 'RECEIPT-77' }, CLERK));
      expect(acknowledged).toMatchObject({ status: 'ACKNOWLEDGED', acknowledgedAt: receiptAt, deliveredAt: receiptAt, externalRef: 'RECEIPT-77', version: 3 });
    });

    it('keeps the instant a channel delivered at when the recipient acknowledges later', async () => {
      const doc = await sealed();
      const internal = await inA((tx) => distributions.insertIfAbsent(tx, doc.id, unit('Inbox unit'), CLERK));
      await inA((tx) => distributions.recordAttempt(tx, internal.record.id, { kind: 'DELIVERED', at: NOW }, CLERK));
      const receiptAt = new Date(NOW.getTime() + MINUTE);
      const acknowledged = await inA((tx) => distributions.acknowledge(tx, internal.record.id, 2, { acknowledgedAt: receiptAt, externalRef: null }, CLERK));
      expect(acknowledged).toMatchObject({ status: 'ACKNOWLEDGED', deliveredAt: NOW, acknowledgedAt: receiptAt });
    });

    it('refuses a stale version, a row that is not sent, a receipt before the sending and a row that is not there', async () => {
      const doc = await sealed();
      const paper = await inA((tx) => distributions.insertIfAbsent(tx, doc.id, external('Paper agency'), CLERK));
      expect((await failure(inA((tx) => distributions.acknowledge(tx, paper.record.id, 1, { acknowledgedAt: NOW, externalRef: null }, CLERK)))).code).toBe('DISTRIBUTION_STATE_INVALID');
      await inA((tx) => distributions.recordAttempt(tx, paper.record.id, { kind: 'SENT', at: NOW }, CLERK));
      expect((await failure(inA((tx) => distributions.acknowledge(tx, paper.record.id, 1, { acknowledgedAt: NOW, externalRef: null }, CLERK)))).code).toBe('VERSION_CONFLICT');
      expect((await failure(inA((tx) => distributions.acknowledge(tx, paper.record.id, 2, { acknowledgedAt: new Date(NOW.getTime() - MINUTE), externalRef: null }, CLERK)))).code).toBe('VALIDATION_FAILED');
      expect((await failure(inA((tx) => distributions.acknowledge(tx, randomUUID(), 1, { acknowledgedAt: NOW, externalRef: null }, CLERK)))).code).toBe('RESOURCE_NOT_FOUND');
      await inA((tx) => distributions.acknowledge(tx, paper.record.id, 2, { acknowledgedAt: NOW, externalRef: null }, CLERK));
      expect((await failure(inA((tx) => distributions.acknowledge(tx, paper.record.id, 3, { acknowledgedAt: NOW, externalRef: null }, CLERK)))).code).toBe('DISTRIBUTION_STATE_INVALID');
    });
  });

  describe('the figures the aggregate status is decided from', () => {
    it('counts the rows reached and the acknowledgements that were required', async () => {
      const doc = await sealed();
      expect(await inA((tx) => distributions.tally(tx, doc.id))).toEqual({ total: 0, reached: 0, required: 0, requiredAcknowledged: 0 });
      const first = await inA((tx) => distributions.insertIfAbsent(tx, doc.id, unit('One'), CLERK));
      const second = await inA((tx) => distributions.insertIfAbsent(tx, doc.id, external('Two'), CLERK));
      await inA((tx) => distributions.insertIfAbsent(tx, doc.id, external('Copy only', { acknowledgementRequired: false }), CLERK));
      await inA((tx) => distributions.recordAttempt(tx, first.record.id, { kind: 'DELIVERED', at: NOW }, CLERK));
      await inA((tx) => distributions.recordAttempt(tx, second.record.id, { kind: 'SENT', at: NOW }, CLERK));
      expect(await inA((tx) => distributions.tally(tx, doc.id))).toEqual({ total: 3, reached: 1, required: 2, requiredAcknowledged: 0 });
      await inA((tx) => distributions.acknowledge(tx, first.record.id, 2, { acknowledgedAt: NOW, externalRef: null }, CLERK));
      expect(await inA((tx) => distributions.tally(tx, doc.id))).toEqual({ total: 3, reached: 1, required: 2, requiredAcknowledged: 1 });
    });
  });

  describe('what the database holds whatever the code does', () => {
    it('refuses to delete or truncate a distribution, even for the owner of the table through the application role', async () => {
      const doc = await sealed();
      const written = await inA((tx) => distributions.insertIfAbsent(tx, doc.id, external('Kept agency'), CLERK));
      expect((await failure(inA((tx) => tx.query('delete from machvon.document_distribution where id = $1::uuid', [written.record.id])))).sqlState).toBe('42501');
      expect((await failure(inA((tx) => tx.query('truncate machvon.document_distribution')))).sqlState).toBe('42501');
    });

    it('refuses to change the recipient, the channel or the duty to acknowledge', async () => {
      const doc = await sealed();
      const written = await inA((tx) => distributions.insertIfAbsent(tx, doc.id, external('Fixed agency'), CLERK));
      for (const assignment of ["channel = 'EMAIL'", "recipient_name = 'Another agency'", 'acknowledgement_required = false', "recipient_code = 'OTHER'"]) {
        expect((await failure(inA((tx) => tx.query(`update machvon.document_distribution set ${assignment} where id = $1::uuid`, [written.record.id])))).sqlState).toBe('23514');
      }
    });

    it('refuses a state that skips ahead or goes back, and a receipt that is rewritten', async () => {
      const doc = await sealed();
      const written = await inA((tx) => distributions.insertIfAbsent(tx, doc.id, external('Ordered agency'), CLERK));
      const set = (assignment: string) => inA((tx) => tx.query(`update machvon.document_distribution set ${assignment} where id = $1::uuid`, [written.record.id]));
      expect((await failure(set(`status = 'ACKNOWLEDGED', acknowledged_at = now(), delivered_at = now(), sent_at = now()`))).sqlState).toBe('23514');
      await inA((tx) => distributions.recordAttempt(tx, written.record.id, { kind: 'SENT', at: NOW }, CLERK));
      await inA((tx) => distributions.acknowledge(tx, written.record.id, 2, { acknowledgedAt: NOW, externalRef: 'R-1' }, CLERK));
      expect((await failure(set("status = 'SENT'"))).sqlState).toBe('23514');
      expect((await failure(set("acknowledged_at = acknowledged_at + interval '1 day'"))).sqlState).toBe('23514');
      expect((await failure(set("external_ref = 'R-2'"))).sqlState).toBe('23514');
    });

    it('requires the instants and the reason that a state implies, and a unit for the internal channel', async () => {
      const doc = await sealed();
      const written = await inA((tx) => distributions.insertIfAbsent(tx, doc.id, external('Checked agency'), CLERK));
      const set = (assignment: string) => inA((tx) => tx.query(`update machvon.document_distribution set ${assignment} where id = $1::uuid`, [written.record.id]));
      expect((await failure(set("status = 'SENT'"))).sqlState).toBe('23514');
      expect((await failure(set("status = 'FAILED'"))).sqlState).toBe('23514');
      expect((await failure(set("error_code = 'lower case'"))).sqlState).toBe('23514');
      expect((await failure(inA((tx) => distributions.insertIfAbsent(tx, doc.id, unit('No unit', { recipientUnitId: null }), CLERK)))).sqlState).toBe('23514');
      expect((await failure(inA((tx) => distributions.insertIfAbsent(tx, doc.id, external(' padded '), CLERK)))).sqlState).toBe('23514');
    });
  });

  describe('the aggregate status of the document', () => {
    it('issues with the override of an unconfirmed template and keeps it for good', async () => {
      const doc = await sealed();
      const issued = await inA((tx) => outgoing.markIssued(tx, doc.id, { expectedVersion: doc.version, issuedAt: NOW, actor: CLERK, override: { reason: 'The legal office confirmed it by phone today', by: LEADER } }));
      expect(issued).toMatchObject({ status: 'ISSUED', issuedAt: NOW, unconfirmedOverrideReason: 'The legal office confirmed it by phone today', unconfirmedOverrideBy: LEADER });
      const set = (assignment: string) => inA((tx) => tx.query(`update machvon.outgoing_document set ${assignment} where id = $1::uuid`, [doc.id]));
      expect((await failure(set("unconfirmed_override_reason = 'Another reason that is long enough'"))).sqlState).toBe('23514');
      expect((await failure(set("issued_at = issued_at + interval '1 day'"))).sqlState).toBe('23514');
      expect((await failure(set("status = 'SEALED'"))).sqlState).toBe('23514');
    });

    it('refuses an override that is not a written reason of at least twenty characters', async () => {
      const doc = await sealed();
      const short = inA((tx) => outgoing.markIssued(tx, doc.id, { expectedVersion: doc.version, issuedAt: NOW, actor: CLERK, override: { reason: 'too short', by: LEADER } }));
      expect((await failure(short)).sqlState).toBe('23514');
    });

    it('moves ISSUED to DELIVERED to ACKNOWLEDGED, one version up each time, and never back', async () => {
      const doc = await sealed();
      const issued = await inA((tx) => outgoing.markIssued(tx, doc.id, { expectedVersion: doc.version, issuedAt: NOW, actor: CLERK }));
      expect(issued).toMatchObject({ status: 'ISSUED', unconfirmedOverrideReason: null });
      expect((await failure(inA((tx) => outgoing.markAcknowledged(tx, doc.id, { expectedVersion: issued.version, actor: CLERK })))).code).toBe('DOCUMENT_STATE_INVALID');
      const delivered = await inA((tx) => outgoing.markDelivered(tx, doc.id, { expectedVersion: issued.version, actor: CLERK }));
      expect(delivered).toMatchObject({ status: 'DELIVERED', version: issued.version + 1 });
      expect((await failure(inA((tx) => outgoing.markDelivered(tx, doc.id, { expectedVersion: delivered.version, actor: CLERK })))).code).toBe('DOCUMENT_STATE_INVALID');
      const acknowledged = await inA((tx) => outgoing.markAcknowledged(tx, doc.id, { expectedVersion: delivered.version, actor: CLERK }));
      expect(acknowledged).toMatchObject({ status: 'ACKNOWLEDGED', version: delivered.version + 1 });
      const set = (assignment: string) => inA((tx) => tx.query(`update machvon.outgoing_document set ${assignment} where id = $1::uuid`, [doc.id]));
      expect((await failure(set("status = 'DELIVERED'"))).sqlState).toBe('23514');
      expect((await failure(set("status = 'ISSUED'"))).sqlState).toBe('23514');
    });
  });
});
