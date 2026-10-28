import { randomUUID } from 'node:crypto';
import { DomainError } from '@machvon/kernel';
import { DISTRIBUTOR, ISSUER, ISSUER_DISTRIBUTOR, LEGAL_ISSUER, NOBODY, NOW, TENANT_A } from './doc-app';
import type { Reply } from './doc-app';
import { FlowWorld } from './support/flow-world';
import { EXTERNAL_RECIPIENT, INTERNAL_RECIPIENT, THIRD_RECIPIENT, sealedDocument } from './support/sealed-documents';

jest.setTimeout(240_000);

const flow = new FlowWorld();
const { app } = flow;
const owner = <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => app.harness.owner<T>(TENANT_A, [[sql, params]]);
const MINUTE = 60_000;

const dispatch = (id: string, member: number, version: number, recipients: unknown[], key?: string): Promise<Reply> =>
  app.call('POST', `/outgoing-documents/${id}/distributions`, { member, ifMatch: `"${version}"`, body: { recipients }, ...(key === undefined ? {} : { key }) });
const acknowledge = (id: string, member: number, version: number, body: Record<string, unknown>): Promise<Reply> =>
  app.call('POST', `/document-distributions/${id}/acknowledgement`, { member, ifMatch: `"${version}"`, body });
const retry = (id: string, member: number, version: number): Promise<Reply> => app.call('POST', `/document-distributions/${id}/retry`, { member, ifMatch: `"${version}"`, body: {} });

const paper = (recipient: object, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ ...recipient, channel: 'PAPER_HANDOVER', ...extra });

interface Issued {
  id: string;
  /** The version of the outgoing document after the issue. */
  version: number;
}

/** A document issued through the command: sealed over the routes of the screens, then issued with the reason of a legal user (the default template is unconfirmed). */
async function issued(overrides: Record<string, unknown> = {}): Promise<Issued> {
  const sealed = await sealedDocument(flow, overrides);
  const reply = await app.call('POST', `/outgoing-documents/${sealed.id}/issuance`, {
    member: LEGAL_ISSUER,
    ifMatch: `"${sealed.version}"`,
    body: { unconfirmed_override_reason: 'The legal office confirmed the template by letter 12/PC' },
  });
  expect(reply.status).toBe(200);
  return { id: sealed.id, version: reply.json.resource_version as number };
}

async function status(id: string): Promise<{ status: string; version: number }> {
  const [found] = await owner<{ status: string; version: string }>('select status, version::text as version from machvon.outgoing_document where id = $1', [id]);
  if (found === undefined) throw new Error('no document');
  return { status: found.status, version: Number(found.version) };
}

const distributionsOf = (id: string) =>
  owner<{ id: string; recipient_name: string; channel: string; status: string; version: string; attempts: number; error_code: string | null; acknowledgement_required: boolean }>(
    'select id, recipient_name, channel, status, version::text as version, attempts, error_code, acknowledgement_required from machvon.document_distribution where outgoing_document_id = $1 order by recipient_name, channel',
    [id],
  );

const events = (id: string, type: string): Promise<Array<{ payload: Record<string, unknown> }>> =>
  owner('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at', [id, type]);

describe('distributing an issued document and tracking the receipts (ST-DOC-010)', () => {
  beforeAll(() => flow.start(), 300_000);
  afterAll(() => flow.stop(), 60_000);
  afterEach(() => {
    flow.reset();
    app.emailBehaviour = { outcome: 'SENT', externalRef: 'MAIL-1' };
    app.emailSent.length = 0;
  });

  it('sends to two recipients, moves the document to DELIVERED on the first receipt and to ACKNOWLEDGED on the last, and a resend adds no row (AC-ST-DOC-010-2, UAT-AC410)', async () => {
    const doc = await issued();
    const sent = await dispatch(doc.id, DISTRIBUTOR, doc.version, [paper(INTERNAL_RECIPIENT), paper(EXTERNAL_RECIPIENT)]);
    expect(sent.status).toBe(200);
    expect(sent.json).toMatchObject({ status: 'ISSUED', resource_version: doc.version });
    expect(sent.json.distributions).toEqual([
      expect.objectContaining({ channel: 'PAPER_HANDOVER', status: 'SENT', created: true }),
      expect.objectContaining({ channel: 'PAPER_HANDOVER', status: 'SENT', created: true }),
    ]);
    // Two rows, both SENT: nobody has the document yet as far as the system knows.
    const rows = await distributionsOf(doc.id);
    expect(rows.map((found) => [found.recipient_name, found.status, found.attempts])).toEqual([
      ['Department of Finance', 'SENT', 1],
      ['Planning Division', 'SENT', 1],
    ]);
    expect(await status(doc.id)).toMatchObject({ status: 'ISSUED' });
    expect(await events(doc.id, 'doc.delivered.v1')).toHaveLength(0);

    // Sending to the same recipients on the same channel again writes nothing, whatever the capitals.
    const again = await dispatch(doc.id, DISTRIBUTOR, doc.version, [paper({ ...EXTERNAL_RECIPIENT, name: 'DEPARTMENT OF FINANCE' }), paper(INTERNAL_RECIPIENT)]);
    expect(again.status).toBe(200);
    expect((again.json.distributions as Array<{ created: boolean }>).map((entry) => entry.created)).toEqual([false, false]);
    expect(await distributionsOf(doc.id)).toHaveLength(2);

    const [first, second] = rows;
    if (first === undefined || second === undefined) throw new Error('rows are missing');
    const receipt = NOW.toISOString();
    const firstAck = await acknowledge(first.id, DISTRIBUTOR, Number(first.version), { acknowledged_at: receipt, external_ref: 'RECEIPT-1' });
    expect(firstAck.status).toBe(200);
    expect(firstAck.json).toMatchObject({ status: 'ACKNOWLEDGED', document_status: 'DELIVERED' });
    expect(await status(doc.id)).toMatchObject({ status: 'DELIVERED' });
    expect(await events(doc.id, 'doc.delivered.v1')).toHaveLength(1);
    expect(await events(doc.id, 'doc.acknowledged.v1')).toHaveLength(0);

    const secondAck = await acknowledge(second.id, DISTRIBUTOR, Number(second.version), { acknowledged_at: receipt });
    expect(secondAck.json).toMatchObject({ status: 'ACKNOWLEDGED', document_status: 'ACKNOWLEDGED' });
    expect(await status(doc.id)).toMatchObject({ status: 'ACKNOWLEDGED' });
    expect(await events(doc.id, 'doc.delivered.v1')).toHaveLength(1);
    expect(await events(doc.id, 'doc.acknowledged.v1')).toHaveLength(1);
    const history = await owner<{ kind: string }>("select kind from machvon.outgoing_document_event where outgoing_document_id = $1 and kind in ('DELIVERED', 'ACKNOWLEDGED') order by seq", [doc.id]);
    expect(history.map((event) => event.kind)).toEqual(['DELIVERED', 'ACKNOWLEDGED']);
    expect(await distributionsOf(doc.id)).toHaveLength(2);
  });

  it('still records the receipts and retries the deliveries of a document that has been filed, and keeps it FILED (ST-DOC-013)', async () => {
    const doc = await issued();
    expect((await dispatch(doc.id, DISTRIBUTOR, doc.version, [paper(INTERNAL_RECIPIENT), paper(EXTERNAL_RECIPIENT)])).status).toBe(200);
    const [first, second] = await distributionsOf(doc.id);
    if (first === undefined || second === undefined) throw new Error('rows are missing');
    expect((await acknowledge(first.id, DISTRIBUTOR, Number(first.version), { acknowledged_at: NOW.toISOString() })).status).toBe(200);
    // The archivist files it while the other receipt is still to come.
    await owner("update machvon.outgoing_document set status = 'FILED' where id = $1", [doc.id]);
    const late = await acknowledge(second.id, DISTRIBUTOR, Number(second.version), { acknowledged_at: NOW.toISOString() });
    expect(late).toMatchObject({ status: 200, json: { status: 'ACKNOWLEDGED', document_status: 'FILED' } });
    expect(await status(doc.id)).toMatchObject({ status: 'FILED' });
  });

  it('delivers to the inbox of a unit at once, and counts only the recipients that must acknowledge', async () => {
    const doc = await issued({ recipients: [INTERNAL_RECIPIENT, EXTERNAL_RECIPIENT, THIRD_RECIPIENT] });
    const sent = await dispatch(doc.id, DISTRIBUTOR, doc.version, [
      { ...INTERNAL_RECIPIENT, channel: 'INTERNAL' },
      paper(EXTERNAL_RECIPIENT),
      paper(THIRD_RECIPIENT, { acknowledgement_required: false }),
    ]);
    expect(sent.status).toBe(200);
    // The unit has it already: the document is DELIVERED by the dispatch itself, and the event is sent once.
    expect(sent.json).toMatchObject({ status: 'DELIVERED', resource_version: doc.version + 1 });
    const rows = await distributionsOf(doc.id);
    expect(rows.map((found) => [found.recipient_name, found.channel, found.status, found.acknowledgement_required])).toEqual([
      ['Department of Finance', 'PAPER_HANDOVER', 'SENT', true],
      ['Planning Division', 'INTERNAL', 'DELIVERED', true],
      ['State Treasury', 'PAPER_HANDOVER', 'SENT', false],
    ]);
    expect(await events(doc.id, 'doc.delivered.v1')).toHaveLength(1);
    const at = NOW.toISOString();
    const unit = rows.find((found) => found.channel === 'INTERNAL');
    const agency = rows.find((found) => found.recipient_name === 'Department of Finance');
    if (unit === undefined || agency === undefined) throw new Error('rows are missing');
    await acknowledge(unit.id, DISTRIBUTOR, Number(unit.version), { acknowledged_at: at });
    expect((await status(doc.id)).status).toBe('DELIVERED');
    // The copy that needed no receipt does not hold the document back.
    await acknowledge(agency.id, DISTRIBUTOR, Number(agency.version), { acknowledged_at: at });
    expect((await status(doc.id)).status).toBe('ACKNOWLEDGED');
  });

  describe('the email channel behind its port', () => {
    it('keeps a message the adapter queued as SENT, and one it confirmed as DELIVERED', async () => {
      const doc = await issued();
      const sent = await dispatch(doc.id, DISTRIBUTOR, doc.version, [{ ...EXTERNAL_RECIPIENT, channel: 'EMAIL' }]);
      expect(sent.json.distributions).toEqual([expect.objectContaining({ channel: 'EMAIL', status: 'SENT' })]);
      expect(app.emailSent).toHaveLength(1);
      expect(app.emailSent[0]).toMatchObject({ outgoingDocumentId: doc.id, recipientName: 'Department of Finance', recipientCode: 'SKHDT' });
      expect(app.emailSent[0]?.fileSha256).toMatch(/^[0-9a-f]{64}$/);
      const other = await issued();
      app.emailBehaviour = { outcome: 'DELIVERED', externalRef: 'MAIL-2' };
      const delivered = await dispatch(other.id, DISTRIBUTOR, other.version, [{ ...EXTERNAL_RECIPIENT, channel: 'EMAIL' }]);
      expect(delivered.json).toMatchObject({ status: 'DELIVERED' });
    });

    it('records a failure with its reason instead of pretending, and sends the same row again on request, never a second row', async () => {
      const doc = await issued();
      app.emailBehaviour = new DomainError('PROVIDER_UNAVAILABLE', 503);
      const failed = await dispatch(doc.id, DISTRIBUTOR, doc.version, [{ ...EXTERNAL_RECIPIENT, channel: 'EMAIL' }]);
      expect(failed.status).toBe(200);
      expect(failed.json.distributions).toEqual([expect.objectContaining({ status: 'FAILED', error_code: 'PROVIDER_UNAVAILABLE' })]);
      expect(await status(doc.id)).toMatchObject({ status: 'ISSUED' });
      const [row] = await distributionsOf(doc.id);
      if (row === undefined) throw new Error('row is missing');
      expect(row).toMatchObject({ status: 'FAILED', error_code: 'PROVIDER_UNAVAILABLE', attempts: 1 });

      // A plain dispatch of the same recipient does not send again: the row is there and says what happened.
      const same = await dispatch(doc.id, DISTRIBUTOR, doc.version, [{ ...EXTERNAL_RECIPIENT, channel: 'EMAIL' }]);
      expect((same.json.distributions as Array<{ created: boolean; status: string }>)[0]).toMatchObject({ created: false, status: 'FAILED' });
      expect(app.emailSent).toHaveLength(1);

      const stale = await retry(row.id, DISTRIBUTOR, Number(row.version) + 3);
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      app.emailBehaviour = new Error('connection reset');
      const stillFailing = await retry(row.id, DISTRIBUTOR, Number(row.version));
      expect(stillFailing.json).toMatchObject({ status: 'FAILED', error_code: 'CHANNEL_ERROR' });
      app.emailBehaviour = { outcome: 'SENT', externalRef: 'MAIL-3' };
      const [again] = await distributionsOf(doc.id);
      const retried = await retry(row.id, DISTRIBUTOR, Number(again?.version));
      expect(retried.status).toBe(200);
      expect(retried.json).toMatchObject({ status: 'SENT', error_code: null });
      expect(await distributionsOf(doc.id)).toHaveLength(1);
      expect((await distributionsOf(doc.id))[0]).toMatchObject({ status: 'SENT', attempts: 3, error_code: null });
      const notFailed = await retry(row.id, DISTRIBUTOR, Number(retried.json.resource_version));
      expect([notFailed.status, notFailed.json.code]).toEqual([409, 'DISTRIBUTION_STATE_INVALID']);
    });
  });

  describe('recipients and channels that are refused (RECIPIENT_INVALID)', () => {
    it.each([
      ['a recipient the document does not name', [paper({ kind: 'EXTERNAL_AGENCY', name: 'Somebody Else' })], 'recipients[0].name', 'NOT_ON_DOCUMENT'],
      ['the LGSP channel, which waits for another story', [{ ...EXTERNAL_RECIPIENT, channel: 'LGSP' }], 'recipients[0].channel', 'CHANNEL_NOT_SUPPORTED'],
      ['a channel nobody knows', [{ ...EXTERNAL_RECIPIENT, channel: 'FAX' }], 'recipients[0].channel', undefined],
      ['the internal channel for an agency outside the system', [{ ...EXTERNAL_RECIPIENT, channel: 'INTERNAL' }], 'recipients[0].channel', 'INTERNAL_CHANNEL_NEEDS_UNIT'],
      ['a member the request may not carry', [paper(EXTERNAL_RECIPIENT, { status: 'DELIVERED' })], 'recipients[0].status', undefined],
      ['a duty to acknowledge that is not a boolean', [paper(EXTERNAL_RECIPIENT, { acknowledgement_required: 'yes' })], 'recipients[0].acknowledgement_required', undefined],
      ['a unit that is not the unit named on the document', [paper({ ...INTERNAL_RECIPIENT, unit_id: randomUUID() })], 'recipients[0].unit_id', 'NOT_ON_DOCUMENT'],
      ['no recipient at all', [], 'recipients', 'EMPTY'],
    ])('refuses %s', async (_name, recipients, detail, reason) => {
      const doc = await issued();
      const reply = await dispatch(doc.id, DISTRIBUTOR, doc.version, recipients);
      expect([reply.status, reply.json.code, reply.json.detail]).toEqual([422, 'RECIPIENT_INVALID', detail]);
      if (reason !== undefined) expect(reply.json.reason).toBe(reason);
      expect(await distributionsOf(doc.id)).toHaveLength(0);
    });
  });

  describe('states, versions and rights', () => {
    it('does not distribute a document that is not issued, and answers a stale version', async () => {
      const sealed = await sealedDocument(flow);
      const early = await dispatch(sealed.id, DISTRIBUTOR, sealed.version, [paper(EXTERNAL_RECIPIENT)]);
      expect([early.status, early.json.code]).toEqual([409, 'DOCUMENT_STATE_INVALID']);
      const doc = await issued();
      const stale = await dispatch(doc.id, DISTRIBUTOR, doc.version - 1, [paper(EXTERNAL_RECIPIENT)]);
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const bare = await app.call('POST', `/outgoing-documents/${doc.id}/distributions`, { member: DISTRIBUTOR, body: { recipients: [paper(EXTERNAL_RECIPIENT)] } });
      expect(bare.status).toBe(428);
      expect(await distributionsOf(doc.id)).toHaveLength(0);
    });

    it('answers a receipt that is not possible: in the future, before the sending, twice, or on a stale version', async () => {
      const doc = await issued();
      await dispatch(doc.id, DISTRIBUTOR, doc.version, [paper(EXTERNAL_RECIPIENT)]);
      const [row] = await distributionsOf(doc.id);
      if (row === undefined) throw new Error('row is missing');
      const version = Number(row.version);
      const future = await acknowledge(row.id, DISTRIBUTOR, version, { acknowledged_at: new Date(NOW.getTime() + 10 * MINUTE).toISOString() });
      expect([future.status, future.json.code, future.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'acknowledged_at']);
      const before = await acknowledge(row.id, DISTRIBUTOR, version, { acknowledged_at: new Date(NOW.getTime() - 60 * MINUTE).toISOString() });
      expect([before.status, before.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const stale = await acknowledge(row.id, DISTRIBUTOR, version + 1, { acknowledged_at: NOW.toISOString() });
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const impossible = await acknowledge(row.id, DISTRIBUTOR, version, { acknowledged_at: '2026-02-30T00:00:00Z' });
      expect(impossible.status).toBeGreaterThanOrEqual(400);
      const long = await acknowledge(row.id, DISTRIBUTOR, version, { acknowledged_at: NOW.toISOString(), external_ref: 'x'.repeat(130) });
      expect(long.status).toBeGreaterThanOrEqual(400);
      const done = await acknowledge(row.id, DISTRIBUTOR, version, { acknowledged_at: NOW.toISOString(), external_ref: '  RECEIPT  ' });
      expect(done.status).toBe(200);
      const [stored] = await owner<{ external_ref: string }>('select external_ref from machvon.document_distribution where id = $1', [row.id]);
      expect(stored?.external_ref).toBe('RECEIPT');
      const twice = await acknowledge(row.id, DISTRIBUTOR, Number(done.json.resource_version), { acknowledged_at: NOW.toISOString() });
      expect([twice.status, twice.json.code]).toEqual([409, 'DISTRIBUTION_STATE_INVALID']);
    });

    it('needs the right to distribute over the unit that drafted the document', async () => {
      const doc = await issued();
      for (const member of [NOBODY, ISSUER]) {
        const denied = await dispatch(doc.id, member, doc.version, [paper(EXTERNAL_RECIPIENT)]);
        expect([denied.status]).toEqual([403]);
      }
      expect((await dispatch(doc.id, ISSUER_DISTRIBUTOR, doc.version, [paper(EXTERNAL_RECIPIENT)])).status).toBe(200);
      const [row] = await distributionsOf(doc.id);
      if (row === undefined) throw new Error('row is missing');
      expect((await acknowledge(row.id, ISSUER, Number(row.version), { acknowledged_at: NOW.toISOString() })).status).toBe(403);
      expect((await retry(row.id, ISSUER, Number(row.version))).status).toBe(403);
      const missing = await acknowledge(randomUUID(), DISTRIBUTOR, 1, { acknowledged_at: NOW.toISOString() });
      expect([missing.status, missing.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
    });

    it('gives two dispatches that race the same rows', async () => {
      const doc = await issued();
      const replies = await Promise.all([
        dispatch(doc.id, DISTRIBUTOR, doc.version, [paper(INTERNAL_RECIPIENT), paper(EXTERNAL_RECIPIENT)]),
        dispatch(doc.id, ISSUER_DISTRIBUTOR, doc.version, [paper(EXTERNAL_RECIPIENT), paper(INTERNAL_RECIPIENT)]),
      ]);
      expect(replies.map((reply) => reply.status)).toEqual([200, 200]);
      expect(await distributionsOf(doc.id)).toHaveLength(2);
      const created = replies.flatMap((reply) => (reply.json.distributions as Array<{ created: boolean }>).filter((entry) => entry.created));
      expect(created).toHaveLength(2);
    });
  });

  describe('what is written down', () => {
    it('audits every command without the names of the recipients, shows the rows on the document and counts the outcomes', async () => {
      const doc = await issued();
      await dispatch(doc.id, DISTRIBUTOR, doc.version, [paper(INTERNAL_RECIPIENT), paper(EXTERNAL_RECIPIENT)]);
      const [row] = await distributionsOf(doc.id);
      if (row === undefined) throw new Error('row is missing');
      await acknowledge(row.id, DISTRIBUTOR, Number(row.version), { acknowledged_at: NOW.toISOString(), external_ref: 'RECEIPT-9' });
      const audits = await owner<{ action: string; safe_diff: Record<string, unknown> }>(
        "select action, safe_diff from machvon.audit_event where action in ('outgoing_document.distribute', 'document_distribution.acknowledge', 'document_distribution.retry') and resource_id in ($1, $2) order by occurred_at, id",
        [doc.id, row.id],
      );
      expect(audits.map((audit) => audit.action)).toEqual(['outgoing_document.distribute', 'document_distribution.acknowledge']);
      expect(audits[0]?.safe_diff).toMatchObject({ requested: 2, created: 2, existing: 0, document_status: 'ISSUED' });
      expect(JSON.stringify(audits)).not.toContain('Department of Finance');
      expect(JSON.stringify(audits)).not.toContain('RECEIPT-9');
      expect(audits[1]?.safe_diff).toMatchObject({ has_external_ref: true, document_status: 'DELIVERED', channel: 'PAPER_HANDOVER' });

      const detail = await app.call('GET', `/outgoing-documents/${doc.id}`, { member: DISTRIBUTOR });
      expect(detail.status).toBe(200);
      const shown = detail.json.distributions as Array<Record<string, unknown>>;
      expect(shown).toHaveLength(2);
      expect(shown.map((entry) => Object.keys(entry).sort())[0]).toEqual(
        [
          'acknowledged_at',
          'acknowledgement_required',
          'attempts',
          'channel',
          'delivered_at',
          'error_code',
          'external_ref',
          'id',
          'recipient_code',
          'recipient_kind',
          'recipient_name',
          'recall_notice_at',
          'recipient_unit_id',
          'sent_at',
          'status',
          'version',
        ].sort(),
      );
      expect(app.metrics).toContainEqual({ name: 'doc_distribution_total', labels: { channel: 'paper_handover', outcome: 'sent' } });
      expect(app.metrics).toContainEqual({ name: 'doc_distribution_total', labels: { channel: 'paper_handover', outcome: 'acknowledged' } });
    });
  });
});
