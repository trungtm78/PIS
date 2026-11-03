import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { DocumentDistributionStore, OutgoingDocumentStore, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import type { TenantDatabase } from '@machvon/db';
import { AlertEvaluator, INTEROP_MAX_ATTEMPTS, interopBackoffSeconds, signInteropMessage } from '@machvon/kernel';
import type { AlertRule, InteropSignedFields } from '@machvon/kernel';
import { JsonInteropCodec } from '../../src/modules/doc/interop-codec';
import { INTEROP_DEAD_GAUGE } from '../../src/modules/doc/interop-sender';
import { eicarBytes } from '../../src/modules/files/mock-scan';
import { DISTRIBUTOR, INTEROP_ADMIN, INTEROP_GATEWAY, INTEROP_READER, INTEROP_UNIT, LEGAL_ISSUER, NOBODY, RECALLER, TENANT_A, TENANT_B, memberId } from './doc-app';
import type { Reply } from './doc-app';
import { FlowWorld } from './support/flow-world';
import { EXTERNAL_RECIPIENT, INTERNAL_RECIPIENT, sealedDocument } from './support/sealed-documents';

jest.setTimeout(300_000);

const flow = new FlowWorld();
const { app } = flow;
const owner = <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => app.harness.owner<T>(TENANT_A, [[sql, params]]);
const codec = new JsonInteropCodec();
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const MINUTE = 60_000;
const SECRET_NAME = 'MACHVON_SECRET_PRODUCTION_CONNECTORS_LGSP';
const KEY = 'k-2026';
const SECRET = 'shared-secret-of-the-agency';
const ENDPOINT = 'https://lgsp.example.gov.vn/ws/edxml';
const worker = { tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 };
const tenantOf = (member: number, tenantId: string = TENANT_A) => ({ tenantId, membershipId: memberId(member), scopeVersion: 1 });

interface Message {
  id: string;
  direction: string;
  status: string;
  attempts: number;
  error_code: string | null;
  next_attempt_at: Date | null;
  external_message_id: string | null;
  adapter_status: string;
  distribution_id: string | null;
  incoming_id: string | null;
  version: string;
}
const MESSAGE_COLUMNS = `m.id, m.direction, m.status, m.attempts, m.error_code, m.next_attempt_at, m.external_message_id, m.adapter_status, m.distribution_id, i.id as incoming_id, m.version::text as version`;

/** The messages of the distributions of an outgoing document. */
const messagesOf = (outgoingId: string): Promise<Message[]> =>
  owner<Message>(
    `select ${MESSAGE_COLUMNS} from machvon.doc_interop_message m join machvon.document_distribution d on d.id = m.distribution_id left join machvon.incoming_document i on i.interop_message_id = m.id
      where d.outgoing_document_id = $1 order by m.created_at`,
    [outgoingId],
  );
const messageById = async (id: string): Promise<Message> => {
  const [found] = await owner<Message>(`select ${MESSAGE_COLUMNS} from machvon.doc_interop_message m left join machvon.incoming_document i on i.interop_message_id = m.id where m.id = $1`, [id]);
  if (found === undefined) throw new Error('no message');
  return found;
};
const distributionOf = async (outgoingId: string) => {
  const [row] = await owner<{ id: string; status: string; attempts: number; error_code: string | null; external_ref: string | null; version: string }>(
    'select id, status, attempts, error_code, external_ref, version::text from machvon.document_distribution where outgoing_document_id = $1 and channel = $2',
    [outgoingId, 'LGSP'],
  );
  if (row === undefined) throw new Error('no LGSP distribution');
  return row;
};
const outgoingStatus = async (id: string): Promise<string> => (await owner<{ status: string }>('select status from machvon.outgoing_document where id = $1', [id]))[0]?.status ?? '';
const events = (id: string, type: string) => owner<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at', [id, type]);
const pass = (at: Date) => app.sender.runPass(app.harness.tenants as TenantDatabase, worker, at);

const dispatch = (id: string, version: number, recipients: unknown[], member = DISTRIBUTOR): Promise<Reply> =>
  app.call('POST', `/outgoing-documents/${id}/distributions`, { member, ifMatch: `"${version}"`, body: { recipients } });
const lgspRecipient = { ...EXTERNAL_RECIPIENT, channel: 'LGSP' };

/** A document issued through the command (the default template is unconfirmed, so a legal user gives the reason). */
async function issued(): Promise<{ id: string; version: number }> {
  const sealed = await sealedDocument(flow);
  const reply = await app.call('POST', `/outgoing-documents/${sealed.id}/issuance`, {
    member: LEGAL_ISSUER,
    ifMatch: `"${sealed.version}"`,
    body: { unconfirmed_override_reason: 'The legal office confirmed the template by letter 12/PC' },
  });
  expect(reply.status).toBe(200);
  return { id: sealed.id, version: reply.json.resource_version as number };
}

/** An issued document sent to the agency over the LGSP: its message is QUEUED. */
async function queued(): Promise<{ id: string; version: number; message: Message }> {
  const doc = await issued();
  const sent = await dispatch(doc.id, doc.version, [lgspRecipient]);
  expect(sent.status).toBe(200);
  const [message] = await messagesOf(doc.id);
  if (message === undefined) throw new Error('no message was queued');
  return { id: doc.id, version: sent.json.resource_version as number, message };
}

interface ConnectorOptions {
  status?: string;
  adapter?: string;
  config?: Record<string, unknown>;
  secretRef?: string | null;
}
/** The LGSP connector of the tenant, as ADM-09 keeps it. */
async function connector(options: ConnectorOptions = {}): Promise<void> {
  await owner("delete from machvon.integration_connector where mode = 'LGSP'");
  const config = options.config ?? { endpoint: ENDPOINT, egress_allowlist: ['lgsp.example.gov.vn'], agency_code: 'G08.SO-XD' };
  await owner(
    `insert into machvon.integration_connector (tenant_id, id, connector_code, adapter_status, mode, config_json, credential_secret_ref, status, version, created_by, updated_by)
     values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), 'lgsp-gateway', $1, 'LGSP', $2::jsonb, $3, $4, 1, $5::uuid, $5::uuid)`,
    [options.adapter ?? 'MOCK', JSON.stringify(config), options.secretRef === undefined ? 'secret://production/connectors/lgsp' : options.secretRef, options.status ?? 'Active', memberId(INTEROP_ADMIN)],
  );
}

/** Ends the messages that wait to be sent or answered, so that a pass handles what the test queued and nothing else. */
const endWaiting = (): Promise<unknown[]> =>
  owner("update machvon.doc_interop_message set status = 'REJECTED', error_code = 'TEST_CLEANUP', next_attempt_at = null, processed_at = now() where status in ('QUEUED', 'FAILED', 'SENT')");

/** A PDF of one page whose bytes are its own. */
async function pdf(label = randomUUID()): Promise<Buffer> {
  const document = await PDFDocument.create();
  document.setTitle(label);
  document.addPage([595, 842]);
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

interface Delivery {
  body: Record<string, unknown>;
  fields: InteropSignedFields;
  bytes: Buffer;
}
/** An envelope the LGSP delivers: put through the upload pipeline, and signed by the agency over the fields of the message. */
async function delivery(options: { externalId?: string; symbol?: string; title?: string; docTypeCode?: string; pdfBytes?: Uint8Array; raw?: Buffer; keyId?: string; secret?: string; sender?: string } = {}): Promise<Delivery> {
  const bytes =
    options.raw ??
    codec.encode({
      messageId: options.externalId ?? 'E-IN-1',
      senderCode: options.sender ?? 'G08.BTC',
      receiverCode: 'G08.SO-XD',
      symbol: options.symbol ?? '45/BTC-KHDT',
      issuedOn: '2026-10-20',
      title: options.title ?? 'Official letter on the capital plan of 2026',
      docTypeCode: options.docTypeCode ?? 'QD',
      urgency: 'KHAN',
      pdf: options.pdfBytes ?? (await pdf()),
    });
  const uploaded = await app.uploads.upload(tenantOf(INTEROP_GATEWAY), { purpose: 'document', declaredType: 'text/plain', bytes });
  const fields: InteropSignedFields = {
    externalMessageId: options.externalId ?? 'E-IN-1',
    senderCode: options.sender ?? 'G08.BTC',
    envelopeSha256: sha256(bytes),
    envelopeObjectKey: uploaded.key,
    signatureKeyId: options.keyId ?? KEY,
  };
  const body = {
    envelope_object_key: fields.envelopeObjectKey,
    envelope_sha256: fields.envelopeSha256,
    external_message_id: fields.externalMessageId,
    sender_code: fields.senderCode,
    signature_key_id: fields.signatureKeyId,
    signature: signInteropMessage(Buffer.from(options.secret ?? SECRET), fields),
  };
  return { body, fields, bytes };
}
const receive = (body: Record<string, unknown>, member = INTEROP_GATEWAY, key?: string): Promise<Reply> =>
  app.call('POST', '/integrations/lgsp/inbound-messages', { member, body, ...(key === undefined ? {} : { key }) });
const retry = (id: string, version: number, member = INTEROP_ADMIN): Promise<Reply> => app.call('POST', `/doc-interop-messages/${id}/retry`, { member, ifMatch: `"${version}"`, body: {} });
const incomingCount = async (): Promise<number> => app.count("select count(*) as n from machvon.incoming_document where channel = 'LGSP'");
const inboundCount = async (): Promise<number> => app.count("select count(*) as n from machvon.doc_interop_message where direction = 'INBOUND'");

const rule = JSON.parse(readFileSync(join(__dirname, '../../../../alerts/rules/DOC_INTEROP_DEAD.json'), 'utf8')) as AlertRule;

describe('document interoperability through the LGSP (ST-DOC-021)', () => {
  beforeAll(async () => {
    await flow.start();
    app.secrets[SECRET_NAME] = `${KEY}:${SECRET},k-old:the-key-before-rotation`;
  }, 480_000);
  afterAll(() => flow.stop(), 60_000);
  // The messages the earlier tests left waiting are ended first.
  beforeEach(async () => {
    await endWaiting();
    await connector();
  });
  afterEach(() => {
    flow.reset();
    app.gateway.reset();
    app.metrics.length = 0;
    app.gauges.length = 0;
  });

  describe('a distribution on the LGSP channel', () => {
    it('is queued, not sent: the row waits PENDING with one QUEUED message, the document is not reported as delivered, and a second dispatch adds nothing (AC-ST-DOC-021-1)', async () => {
      const doc = await issued();
      const sent = await dispatch(doc.id, doc.version, [lgspRecipient]);
      expect(sent).toMatchObject({ status: 200, json: { status: 'ISSUED', resource_version: doc.version } });
      expect(sent.json.distributions).toEqual([expect.objectContaining({ channel: 'LGSP', status: 'PENDING', created: true, error_code: null })]);
      const [message, ...others] = await messagesOf(doc.id);
      expect(others).toHaveLength(0);
      expect(message).toMatchObject({ direction: 'OUTBOUND', status: 'QUEUED', attempts: 0, error_code: null, adapter_status: 'MOCK' });
      expect(await distributionOf(doc.id)).toMatchObject({ status: 'PENDING', attempts: 0 });
      expect(app.gateway.endpoints).toEqual([]);
      const again = await dispatch(doc.id, doc.version, [lgspRecipient]);
      expect(again.json.distributions).toEqual([expect.objectContaining({ created: false, status: 'PENDING' })]);
      expect(await messagesOf(doc.id)).toHaveLength(1);
      expect(app.metrics).toContainEqual({ name: 'doc_interop_message_total', labels: { direction: 'outbound', outcome: 'queued' } });
    });

    it('keeps the envelope in the object store under its digest, with the sealed PDF inside it and the parties by their codes', async () => {
      const doc = await queued();
      const [stored] = await owner<{ envelope_sha256: string; envelope_object_key: string; sender_code: string; receiver_code: string }>(
        'select trim(envelope_sha256) as envelope_sha256, envelope_object_key, sender_code, receiver_code from machvon.doc_interop_message where id = $1',
        [doc.message.id],
      );
      expect(stored).toMatchObject({ sender_code: 'G08.SO-XD', receiver_code: 'SKHDT' });
      const kept = await app.uploads.readStored(tenantOf(INTEROP_ADMIN), stored?.envelope_object_key as string);
      expect(sha256(kept.bytes)).toBe(stored?.envelope_sha256);
      const letter = codec.decode(kept.bytes);
      expect(letter.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(letter.docTypeCode).toBe('QD');
    });

    it('is addressed by the code the document prints for the agency, and only an agency can be reached this way (RECIPIENT_INVALID)', async () => {
      const doc = await issued();
      const unit = await dispatch(doc.id, doc.version, [{ ...INTERNAL_RECIPIENT, channel: 'LGSP' }]);
      expect([unit.status, unit.json.code, unit.json.reason]).toEqual([422, 'RECIPIENT_INVALID', 'LGSP_NEEDS_AGENCY']);
      expect(await messagesOf(doc.id)).toHaveLength(0);
    });

    it('refuses to queue a row that has no code for the agency: the rules keep it out of a dispatch, and a row written by another path is refused too', async () => {
      const doc = await issued();
      const tenant = tenantOf(INTEROP_ADMIN);
      const refusal = await app.harness.tenants
        .withTenant(tenant, async (tx) => {
          const document = await new OutgoingDocumentStore().find(tx, doc.id);
          const { record } = await new DocumentDistributionStore().insertIfAbsent(tx, doc.id, { recipientKind: 'EXTERNAL_AGENCY', recipientUnitId: null, recipientName: 'Agency with no code', recipientCode: null, channel: 'LGSP', acknowledgementRequired: true }, tenant.membershipId);
          if (document === undefined) throw new Error('no document');
          return app.interop.enqueue({ tx, tenant }, { document, distribution: record, objectKey: 'unused' });
        })
        .catch((error: unknown) => error as { code: string; extensions?: Record<string, unknown> });
      expect(refusal).toMatchObject({ code: 'RECIPIENT_INVALID', extensions: { reason: 'CODE_REQUIRED_FOR_LGSP' } });
      expect(await messagesOf(doc.id)).toHaveLength(0);
    });

    it('is sent again by the monitor and not by the retry of the distribution: the message carries it (DISTRIBUTION_STATE_INVALID)', async () => {
      const doc = await queued();
      await owner("update machvon.document_distribution set status = 'FAILED', error_code = 'INTEROP_DEAD' where outgoing_document_id = $1", [doc.id]);
      const row = await distributionOf(doc.id);
      const reply = await app.call('POST', `/document-distributions/${row.id}/retry`, { member: DISTRIBUTOR, ifMatch: `"${row.version}"`, body: {} });
      expect([reply.status, reply.json.code, reply.json.reason]).toEqual([409, 'DISTRIBUTION_STATE_INVALID', 'USE_INTEROP_RETRY']);
    });
  });

  describe('the job that sends', () => {
    it('hands the message to the gateway, then the confirmation of the receiving agency acknowledges the row and the document (AC-ST-DOC-021-1)', async () => {
      const doc = await queued();
      app.gateway.answer = { outcome: 'PENDING' };
      const first = await pass(app.now);
      expect(first).toMatchObject({ sent: 1, failed: 0, dead: 0, acknowledged: 0 });
      const handed = await messageById(doc.message.id);
      expect(handed).toMatchObject({ status: 'SENT', attempts: 1, external_message_id: expect.stringMatching(/^LGSP-\d+$/), error_code: null });
      expect(await distributionOf(doc.id)).toMatchObject({ status: 'SENT', attempts: 1, external_ref: handed.external_message_id });
      expect(await outgoingStatus(doc.id)).toBe('ISSUED');
      expect(app.gateway.accepted).toHaveLength(1);
      expect(app.gateway.accepted[0]).toMatchObject({ endpoint: ENDPOINT, messageId: doc.message.id, senderCode: 'G08.SO-XD', receiverCode: 'SKHDT' });
      // The receiving agency has not answered: the message is asked about again and stays SENT.
      expect(await pass(new Date(app.now.getTime() + MINUTE))).toMatchObject({ sent: 0, acknowledged: 0, rejected: 0 });
      expect((await messageById(doc.message.id)).status).toBe('SENT');
      app.gateway.answer = { outcome: 'ACKED' };
      const second = await pass(new Date(app.now.getTime() + 2 * MINUTE));
      expect(second).toMatchObject({ acknowledged: 1 });
      expect(await messageById(doc.message.id)).toMatchObject({ status: 'ACKED', attempts: 1 });
      expect(await distributionOf(doc.id)).toMatchObject({ status: 'ACKNOWLEDGED', external_ref: handed.external_message_id });
      expect(await outgoingStatus(doc.id)).toBe('ACKNOWLEDGED');
      expect(await events(doc.id, 'doc.delivered.v1')).toHaveLength(1);
      expect(await events(doc.id, 'doc.acknowledged.v1')).toHaveLength(1);
      expect(await events(doc.message.id, 'doc.interop_acked.v1')).toHaveLength(1);
      // Nothing is sent twice.
      expect(await pass(new Date(app.now.getTime() + 3 * MINUTE))).toEqual({ sent: 0, failed: 0, dead: 0, acknowledged: 0, rejected: 0 });
      expect(app.gateway.accepted).toHaveLength(1);
    });

    it('goes QUEUED, SENT after attempt 5 and ACKED when the gateway answers 503 four times first, waiting longer each time (AC-ST-DOC-021-1, UAT-AC425)', async () => {
      const doc = await queued();
      app.gateway.failures = 4;
      let at = app.now;
      const waits: number[] = [];
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        expect(await pass(at)).toMatchObject({ failed: 1, sent: 0 });
        const failed = await messageById(doc.message.id);
        expect(failed).toMatchObject({ status: 'FAILED', attempts: attempt, error_code: 'PROVIDER_UNAVAILABLE' });
        waits.push((failed.next_attempt_at as Date).getTime() - at.getTime());
        // Before the wait is over the message is left alone.
        const early = await pass(new Date((failed.next_attempt_at as Date).getTime() - 1000));
        expect(early).toMatchObject({ sent: 0, failed: 0 });
        expect((await messageById(doc.message.id)).attempts).toBe(attempt);
        at = failed.next_attempt_at as Date;
      }
      expect(waits).toEqual([1, 2, 3, 4].map((n) => interopBackoffSeconds(n) * 1000));
      expect(waits).toEqual([60_000, 120_000, 240_000, 480_000]);
      // The distribution is not reported as failed while the message still has its attempts.
      expect(await distributionOf(doc.id)).toMatchObject({ status: 'PENDING' });
      expect(await pass(at)).toMatchObject({ sent: 1, failed: 0 });
      expect(await messageById(doc.message.id)).toMatchObject({ status: 'SENT', attempts: 5, error_code: null, next_attempt_at: null });
      expect(await distributionOf(doc.id)).toMatchObject({ status: 'SENT', attempts: 5 });
      expect(await pass(new Date(at.getTime() + MINUTE))).toMatchObject({ acknowledged: 1 });
      expect(await messageById(doc.message.id)).toMatchObject({ status: 'ACKED', attempts: 5 });
      expect(await outgoingStatus(doc.id)).toBe('ACKNOWLEDGED');
      // Five calls reached the gateway, all to the address of the connector.
      expect(app.gateway.endpoints.filter((endpoint) => endpoint === ENDPOINT)).toHaveLength(app.gateway.endpoints.length);
      expect(app.gateway.accepted).toHaveLength(1);
    });

    it('ends DEAD after 20 forced failures with an alert that has an owner, and the document is not reported as sent (AC-ST-DOC-021-1, UAT-AC425)', async () => {
      const doc = await queued();
      app.gateway.failures = 1000;
      let at = app.now;
      for (let attempt = 1; attempt <= INTEROP_MAX_ATTEMPTS; attempt += 1) {
        const result = await pass(at);
        expect(result).toMatchObject(attempt === INTEROP_MAX_ATTEMPTS ? { dead: 1, failed: 0 } : { failed: 1, dead: 0 });
        const message = await messageById(doc.message.id);
        expect(message.attempts).toBe(attempt);
        if (attempt < INTEROP_MAX_ATTEMPTS) at = message.next_attempt_at as Date;
      }
      expect(await messageById(doc.message.id)).toMatchObject({ status: 'DEAD', attempts: 20, error_code: 'PROVIDER_UNAVAILABLE', next_attempt_at: null });
      expect(await distributionOf(doc.id)).toMatchObject({ status: 'FAILED', error_code: 'PROVIDER_UNAVAILABLE', attempts: 20 });
      expect(await outgoingStatus(doc.id)).toBe('ISSUED');
      expect(await events(doc.message.id, 'doc.interop_dead.v1')).toHaveLength(1);
      expect(app.gateway.accepted).toHaveLength(0);
      const callsBefore = app.gateway.endpoints.length;
      // A dead message is not tried again by the job, however long it waits.
      expect(await pass(new Date(at.getTime() + 24 * 3600_000))).toEqual({ sent: 0, failed: 0, dead: 0, acknowledged: 0, rejected: 0 });
      expect(app.gateway.endpoints).toHaveLength(callsBefore);

      // The gauge of the dead messages fires the alert of the integration team, which has an owner and a runbook.
      const gauges = app.gauges.filter((sample) => sample.name === INTEROP_DEAD_GAUGE).map((sample) => ({ name: sample.name, value: sample.value, labels: sample.labels ?? {} }));
      expect(gauges.at(-1)).toMatchObject({ value: 1, labels: { tenant_id: TENANT_A } });
      const evaluator = new AlertEvaluator([rule], () => at);
      const firing = evaluator.evaluate({ gauges: gauges.slice(-1), counters: [], events: [] });
      expect(firing.fired).toEqual([expect.objectContaining({ ruleId: 'DOC_INTEROP_DEAD', severity: 'critical', owner: 'integration-admin', runbook: 'docs/runbooks/alerts/DOC_INTEROP_DEAD.md', value: 1 })]);

      // A person sends it again; it starts over with twenty attempts, goes out and is acknowledged, and the alert resolves.
      const current = await messageById(doc.message.id);
      const resent = await retry(doc.message.id, Number(current.version));
      expect(resent).toMatchObject({ status: 200, json: { status: 'QUEUED', resource_version: Number(current.version) + 1 } });
      expect(await messageById(doc.message.id)).toMatchObject({ status: 'QUEUED', attempts: 0 });
      app.gateway.failures = 0;
      expect(await pass(new Date(at.getTime() + MINUTE))).toMatchObject({ sent: 1 });
      expect(await distributionOf(doc.id)).toMatchObject({ status: 'SENT', error_code: null, attempts: 20 });
      expect(await pass(new Date(at.getTime() + 2 * MINUTE))).toMatchObject({ acknowledged: 1 });
      expect(await outgoingStatus(doc.id)).toBe('ACKNOWLEDGED');
      const recovered = app.gauges.filter((sample) => sample.name === INTEROP_DEAD_GAUGE).at(-1);
      expect(recovered?.value).toBe(0);
      expect(evaluator.evaluate({ gauges: [{ name: INTEROP_DEAD_GAUGE, value: 0, labels: { tenant_id: TENANT_A } }], counters: [], events: [] }).resolved).toEqual(['DOC_INTEROP_DEAD']);
      const audit = await owner<{ action: string }>("select action from machvon.audit_event where resource_type = 'doc_interop_message' and resource_id = $1 order by occurred_at, id", [doc.message.id]);
      expect(audit.map((entry) => entry.action)).toContain('doc_interop_message.retry');
      expect(audit.map((entry) => entry.action)).toContain('doc_interop_message.dead');
    });

    it('calls only a host on the allowlist of the tenant: any other address fails the message with EGRESS_NOT_ALLOWED and no call is made (AC-ST-DOC-021-2, UAT-AC425)', async () => {
      const cases: Array<[string, Record<string, unknown>]> = [
        ['a host that is not listed', { endpoint: 'https://elsewhere.example.org/ws', egress_allowlist: ['lgsp.example.gov.vn'], agency_code: 'G08.SO-XD' }],
        ['an address that is not https', { endpoint: 'http://lgsp.example.gov.vn/ws', egress_allowlist: ['lgsp.example.gov.vn'], agency_code: 'G08.SO-XD' }],
        ['an allowlist that names nothing', { endpoint: ENDPOINT, egress_allowlist: [], agency_code: 'G08.SO-XD' }],
        ['no allowlist at all', { endpoint: ENDPOINT, agency_code: 'G08.SO-XD' }],
        ['no address', { egress_allowlist: ['lgsp.example.gov.vn'], agency_code: 'G08.SO-XD' }],
        ['a look-alike host', { endpoint: 'https://lgsp.example.gov.vn.attacker.net/ws', egress_allowlist: ['lgsp.example.gov.vn'], agency_code: 'G08.SO-XD' }],
      ];
      for (const [, config] of cases) {
        await connector({ config });
        const doc = await queued();
        expect(await pass(app.now)).toMatchObject({ failed: 1, sent: 0 });
        expect(await messageById(doc.message.id)).toMatchObject({ status: 'FAILED', error_code: 'EGRESS_NOT_ALLOWED' });
      }
      expect(app.gateway.endpoints).toEqual([]);
      // A wildcard covers the hosts below its domain, and the call goes there.
      await endWaiting();
      await connector({ config: { endpoint: 'https://edxml.lgsp.example.gov.vn/ws', egress_allowlist: ['*.example.gov.vn'], agency_code: 'G08.SO-XD' } });
      const ok = await queued();
      expect(await pass(new Date(app.now.getTime() + 24 * 3600_000))).toMatchObject({ sent: 1 });
      expect(app.gateway.endpoints).toEqual(['https://edxml.lgsp.example.gov.vn/ws']);
      expect((await messageById(ok.message.id)).status).toBe('SENT');
    });

    it.each([
      ['no connector', () => owner("delete from machvon.integration_connector where mode = 'LGSP'")],
      ['a connector that is only a draft', () => connector({ status: 'Draft', adapter: 'PROPOSED' })],
      ['a connector that was disabled', () => connector({ status: 'Disabled' })],
    ])('sends nothing where the tenant has %s: the message fails with INTEROP_ADAPTER_NOT_ACTIVE and waits (AC-ST-DOC-021-1)', async (_name, arrange) => {
      const doc = await queued();
      await arrange();
      expect(await pass(app.now)).toMatchObject({ failed: 1, sent: 0 });
      expect(await messageById(doc.message.id)).toMatchObject({ status: 'FAILED', error_code: 'INTEROP_ADAPTER_NOT_ACTIVE', adapter_status: expect.any(String) });
      expect(app.gateway.endpoints).toEqual([]);
    });

    it('records the adapter as MISSING on a message queued where the tenant declared no connector, and as the connector says otherwise', async () => {
      await owner("delete from machvon.integration_connector where mode = 'LGSP'");
      const missing = await queued();
      expect(missing.message.adapter_status).toBe('MISSING');
      await connector({ adapter: 'PROPOSED', status: 'Draft' });
      expect((await queued()).message.adapter_status).toBe('PROPOSED');
    });

    it('fails with the code the gateway named, or CHANNEL_ERROR for a failure that has none', async () => {
      const doc = await queued();
      app.gateway.failures = 2;
      app.gateway.failure = new Error('connection reset');
      expect(await pass(app.now)).toMatchObject({ failed: 1 });
      expect(await messageById(doc.message.id)).toMatchObject({ status: 'FAILED', error_code: 'CHANNEL_ERROR' });
    });

    it('does not send an envelope that changed in the store since it was queued', async () => {
      const doc = await queued();
      const [stored] = await owner<{ envelope_object_key: string }>('select envelope_object_key from machvon.doc_interop_message where id = $1', [doc.message.id]);
      await app.uploads.remove(tenantOf(INTEROP_ADMIN), stored?.envelope_object_key as string);
      await app.uploads.storeGenerated(tenantOf(INTEROP_ADMIN), 'interop-envelope', stored?.envelope_object_key.split('/').at(-1) as string, Buffer.from('{"tampered":true}'), 'application/json');
      expect(await pass(app.now)).toMatchObject({ failed: 1 });
      expect(await messageById(doc.message.id)).toMatchObject({ status: 'FAILED', error_code: 'ENVELOPE_INVALID' });
      expect(app.gateway.accepted).toEqual([]);
    });

    it('marks the row FAILED and keeps the document ISSUED when the receiving agency refuses the document, and does not send it again (AC-ST-DOC-021-1)', async () => {
      const doc = await queued();
      app.gateway.answer = { outcome: 'REJECTED', reasonCode: 'RECEIVER_UNKNOWN' };
      expect(await pass(app.now)).toMatchObject({ sent: 1 });
      expect(await pass(new Date(app.now.getTime() + MINUTE))).toMatchObject({ rejected: 1 });
      expect(await messageById(doc.message.id)).toMatchObject({ status: 'REJECTED', error_code: 'RECEIVER_UNKNOWN' });
      expect(await distributionOf(doc.id)).toMatchObject({ status: 'FAILED', error_code: 'RECEIVER_UNKNOWN' });
      expect(await outgoingStatus(doc.id)).toBe('ISSUED');
      expect(await events(doc.message.id, 'doc.interop_rejected.v1')).toHaveLength(1);
      const current = await messageById(doc.message.id);
      const refusal = await retry(doc.message.id, Number(current.version));
      expect([refusal.status, refusal.json.code]).toEqual([409, 'INTEROP_STATE_INVALID']);
    });

    it('keeps the row as it is when a clerk recorded the receipt by hand, and leaves a message the gateway cannot answer about as it is', async () => {
      const doc = await queued();
      expect(await pass(app.now)).toMatchObject({ sent: 1 });
      const handed = await messageById(doc.message.id);
      const row = await distributionOf(doc.id);
      const ack = await app.call('POST', `/document-distributions/${row.id}/acknowledgement`, { member: DISTRIBUTOR, ifMatch: `"${row.version}"`, body: { acknowledged_at: app.now.toISOString() } });
      expect(ack.status).toBe(200);
      expect(await pass(new Date(app.now.getTime() + MINUTE))).toMatchObject({ acknowledged: 1 });
      expect(await distributionOf(doc.id)).toMatchObject({ status: 'ACKNOWLEDGED', external_ref: handed.external_message_id });
      expect((await messageById(doc.message.id)).status).toBe('ACKED');

      const other = await queued();
      expect(await pass(new Date(app.now.getTime() + 2 * MINUTE))).toMatchObject({ sent: 1 });
      app.gateway.receiptFailure = new Error('gateway timeout');
      expect(await pass(new Date(app.now.getTime() + 3 * MINUTE))).toMatchObject({ acknowledged: 0, rejected: 0 });
      expect((await messageById(other.message.id)).status).toBe('SENT');
      expect(app.metrics).toContainEqual({ name: 'doc_interop_message_total', labels: { direction: 'outbound', outcome: 'receipt_unavailable' } });
    });

    it('writes the moment each message was asked for its receipt, whatever the answer, so the next pass asks the ones asked least recently first (AC-ST-DOC-021-1)', async () => {
      const one = await queued();
      const two = await queued();
      const polledAt = async (id: string): Promise<{ at: string | null; version: string }> => {
        const [row] = await owner<{ at: string | null; version: string }>("select to_char(last_polled_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') as at, version::text from machvon.doc_interop_message where id = $1", [id]);
        if (row === undefined) throw new Error('no message');
        return row;
      };
      const iso = (at: Date): string => at.toISOString().slice(0, 19) + 'Z';
      app.gateway.answer = { outcome: 'PENDING' };
      expect(await pass(app.now)).toMatchObject({ sent: 2 });
      // Handed over in this pass, so nobody asked about them yet.
      expect((await polledAt(one.message.id)).at).toBeNull();
      const handed = (await polledAt(one.message.id)).version;

      // Still pending: asked, and the time is written; the version of the message does not move.
      const pending = new Date(app.now.getTime() + MINUTE);
      expect(await pass(pending)).toMatchObject({ acknowledged: 0, rejected: 0 });
      expect(await polledAt(one.message.id)).toEqual({ at: iso(pending), version: handed });
      expect((await polledAt(two.message.id)).at).toBe(iso(pending));

      // The gateway cannot answer: asked all the same.
      app.gateway.receiptFailure = new Error('gateway timeout');
      const unavailable = new Date(app.now.getTime() + 2 * MINUTE);
      expect(await pass(unavailable)).toMatchObject({ acknowledged: 0, rejected: 0 });
      expect((await polledAt(two.message.id)).at).toBe(iso(unavailable));
    });

    it('calls off a queued message with the recall of the document: nothing is sent for a document that is no longer in force', async () => {
      const doc = await queued();
      const recalled = await app.call('POST', `/outgoing-documents/${doc.id}/recall`, { member: RECALLER, ifMatch: `"${doc.version}"`, body: { reason: 'Wrong figures in table 2, issued for the wrong period' } });
      expect(recalled.status).toBe(200);
      expect(await messageById(doc.message.id)).toMatchObject({ status: 'REJECTED', error_code: 'DISTRIBUTION_CANCELLED' });
      expect(await distributionOf(doc.id)).toMatchObject({ status: 'CANCELLED' });
      expect(await pass(app.now)).toMatchObject({ sent: 0, failed: 0 });
      expect(app.gateway.endpoints).toEqual([]);
    });

    it('hands over a message whose row a recall called off in the meantime without touching the row', async () => {
      const doc = await queued();
      // The race: the row is CANCELLED but the message was already chosen by the pass.
      await owner("update machvon.document_distribution set status = 'CANCELLED' where outgoing_document_id = $1", [doc.id]);
      expect(await pass(app.now)).toMatchObject({ sent: 1 });
      expect((await messageById(doc.message.id)).status).toBe('SENT');
      expect(await distributionOf(doc.id)).toMatchObject({ status: 'CANCELLED' });
    });

    it('sends the messages of several documents in one pass, each in a transaction of its own, so that one that fails does not hold the others', async () => {
      const a = await queued();
      const b = await queued();
      app.gateway.failures = 1;
      expect(await pass(app.now)).toMatchObject({ sent: 1, failed: 1 });
      const statuses = [(await messageById(a.message.id)).status, (await messageById(b.message.id)).status].sort();
      expect(statuses).toEqual(['FAILED', 'SENT']);
    });
  });

  describe('sending again by hand (retryInteropMessage)', () => {
    async function failedMessage() {
      const doc = await queued();
      app.gateway.failures = 1;
      await pass(app.now);
      const message = await messageById(doc.message.id);
      expect(message.status).toBe('FAILED');
      return { doc, message };
    }

    it('takes a failed message back to QUEUED, keeps its count, audits it, and leaves the version check to If-Match', async () => {
      const { message } = await failedMessage();
      const stale = await retry(message.id, Number(message.version) + 3);
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const done = await retry(message.id, Number(message.version));
      expect(done).toMatchObject({ status: 200, json: { status: 'QUEUED', resource_version: Number(message.version) + 1, resource_id: message.id } });
      expect(await messageById(message.id)).toMatchObject({ status: 'QUEUED', attempts: 1, next_attempt_at: null });
      const [audit] = await owner<{ safe_diff: Record<string, unknown>; classification: string }>("select safe_diff, classification from machvon.audit_event where action = 'doc_interop_message.retry' and resource_id = $1", [message.id]);
      expect(audit).toMatchObject({ classification: 'INTERNAL', safe_diff: { from_status: 'FAILED', to_status: 'QUEUED', attempts_before: 1, error_code_before: 'PROVIDER_UNAVAILABLE' } });
      // The same request again (same key) is the same answer; a new key on a message no longer failed is 409.
      const sameKey = randomUUID();
      const next = await app.call('POST', `/doc-interop-messages/${message.id}/retry`, { member: INTEROP_ADMIN, ifMatch: `"${Number(message.version) + 1}"`, body: {}, key: sameKey });
      expect([next.status, next.json.code]).toEqual([409, 'INTEROP_STATE_INVALID']);
    });

    it.each(['QUEUED', 'SENT'] as const)('refuses a %s message with 409 INTEROP_STATE_INVALID', async (status) => {
      const doc = await queued();
      if (status === 'SENT') await pass(app.now);
      const message = await messageById(doc.message.id);
      expect(message.status).toBe(status);
      const reply = await retry(message.id, Number(message.version));
      expect([reply.status, reply.json.code]).toEqual([409, 'INTEROP_STATE_INVALID']);
    });

    it('is 404 for a message that does not exist or that another tenant holds', async () => {
      const { message } = await failedMessage();
      expect((await retry(randomUUID(), 1)).status).toBe(404);
      const foreign = await app.call('POST', `/doc-interop-messages/${message.id}/retry`, { member: 1, tenantId: TENANT_B, ifMatch: `"${message.version}"`, body: {} });
      expect(foreign.status).toBe(404);
    });

    it('needs the right to manage the messages over the whole tenant', async () => {
      const { message } = await failedMessage();
      for (const member of [INTEROP_READER, INTEROP_GATEWAY, NOBODY]) expect((await retry(message.id, Number(message.version), member)).status).toBe(403);
      // The three rights over a subtree are not a right over the messages of the tenant.
      const unit = await retry(message.id, Number(message.version), INTEROP_UNIT);
      expect([unit.status, unit.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect((await messageById(message.id)).status).toBe('FAILED');
    });
  });

  describe('the monitor (listInteropMessages, DOC-20)', () => {
    it('lists the messages of the tenant, the latest first, with the state of each and what can be done, and never the envelope', async () => {
      const failing = await queued();
      app.gateway.failures = 1;
      await pass(app.now);
      await owner('update machvon.doc_interop_message set created_at = created_at - interval \'1 hour\' where id = $1', [failing.message.id]);
      const received = await delivery({ externalId: 'E-LIST-1', symbol: '81/BTC-KHDT' });
      expect((await receive(received.body)).status).toBe(200);
      const reply = await app.call('GET', '/doc-interop-messages', { member: INTEROP_READER });
      expect(reply.status).toBe(200);
      const items = reply.json.items as Array<Record<string, unknown>>;
      expect(reply.json.next_cursor).toBeNull();
      expect(typeof reply.json.as_of).toBe('string');
      const out = items.find((item) => item.id === failing.message.id);
      const inn = items.find((item) => item.external_message_id === 'E-LIST-1');
      expect(out).toMatchObject({
        direction: 'OUTBOUND',
        status: 'FAILED',
        adapter_code: 'LGSP_EDXML',
        adapter_status: 'MOCK',
        sender_code: 'G08.SO-XD',
        receiver_code: 'SKHDT',
        outgoing_document_id: failing.id,
        incoming_document_id: null,
        attempts: 1,
        error_code: 'PROVIDER_UNAVAILABLE',
        actions: { retry: true },
      });
      expect(inn).toMatchObject({ direction: 'INBOUND', status: 'PROCESSED', sender_code: 'G08.BTC', receiver_code: null, outgoing_document_id: null, actions: { retry: false } });
      expect(inn?.incoming_document_id).toEqual(expect.any(String));
      expect(items.indexOf(inn as Record<string, unknown>)).toBeLessThan(items.indexOf(out as Record<string, unknown>));
      for (const item of items) {
        expect(Object.keys(item).sort()).toEqual(
          ['actions', 'adapter_code', 'adapter_status', 'attempts', 'created_at', 'direction', 'error_code', 'external_message_id', 'id', 'incoming_document_id', 'next_attempt_at', 'outgoing_document_id', 'processed_at', 'receiver_code', 'sender_code', 'status', 'updated_at', 'version'],
        );
      }
      expect(JSON.stringify(reply.json)).not.toContain('envelope');
    });

    it('filters by status and direction, pages with a cursor, and refuses values it does not know', async () => {
      await queued();
      await queued();
      const failing = await queued();
      app.gateway.failures = 1000;
      await pass(app.now);
      app.gateway.failures = 0;
      const failedOnly = await app.call('GET', '/doc-interop-messages?status=FAILED&direction=OUTBOUND', { member: INTEROP_ADMIN });
      expect((failedOnly.json.items as Array<{ status: string }>).every((item) => item.status === 'FAILED')).toBe(true);
      expect((failedOnly.json.items as Array<{ id: string }>).some((item) => item.id === failing.message.id)).toBe(true);
      const inboundOnly = await app.call('GET', '/doc-interop-messages?direction=INBOUND', { member: INTEROP_ADMIN });
      expect((inboundOnly.json.items as Array<{ direction: string }>).every((item) => item.direction === 'INBOUND')).toBe(true);
      const page = await app.call('GET', '/doc-interop-messages?limit=2', { member: INTEROP_ADMIN });
      expect((page.json.items as unknown[]).length).toBe(2);
      expect(typeof page.json.next_cursor).toBe('string');
      const next = await app.call('GET', `/doc-interop-messages?limit=2&cursor=${page.json.next_cursor as string}`, { member: INTEROP_ADMIN });
      const ids = [...(page.json.items as Array<{ id: string }>), ...(next.json.items as Array<{ id: string }>)].map((item) => item.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const query of ['status=BROKEN', 'direction=SIDEWAYS', 'limit=0', 'cursor=%25%25']) {
        const refused = await app.call('GET', `/doc-interop-messages?${query}`, { member: INTEROP_ADMIN });
        expect([refused.status, refused.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      }
    });

    it('shows nothing to another tenant, and needs the right to read over the whole tenant', async () => {
      await queued();
      const foreign = await app.call('GET', '/doc-interop-messages', { member: 1, tenantId: TENANT_B });
      expect(foreign.status).toBe(200);
      expect(foreign.json.items).toEqual([]);
      for (const member of [NOBODY, INTEROP_GATEWAY]) expect((await app.call('GET', '/doc-interop-messages', { member })).status).toBe(403);
      const unit = await app.call('GET', '/doc-interop-messages', { member: INTEROP_UNIT });
      expect([unit.status, unit.json.code]).toEqual([403, 'SCOPE_DENIED']);
    });
  });

  describe('the overview of the documents (DOC-01)', () => {
    it('counts the messages that failed or died for the reader of the whole tenant, and gives a reader of a unit no figure instead of 0', async () => {
      await queued();
      app.gateway.failures = 1;
      expect(await pass(app.now)).toMatchObject({ failed: 1 });
      const expected = await app.count("select count(*) as n from machvon.doc_interop_message where status in ('FAILED', 'DEAD')");
      expect(expected).toBeGreaterThanOrEqual(1);
      const tileOf = async (member: number): Promise<unknown> => ((await app.call('GET', '/document-overview', { member })).json.tiles as Array<{ key: string; count: number | null }>).find((tile) => tile.key === 'interop_errors')?.count;
      expect(await tileOf(INTEROP_ADMIN)).toBe(expected);
      expect(await tileOf(INTEROP_UNIT)).toBeNull();
    });
  });

  describe('the webhook that receives (receiveInteropMessage)', () => {
    it('makes one incoming letter when the same envelope is delivered twice, and the second delivery changes nothing (AC-ST-DOC-021-2, UAT-AC425)', async () => {
      const sent = await delivery({ externalId: 'E-IN-1', symbol: '45/BTC-KHDT' });
      const before = { letters: await incomingCount(), messages: await inboundCount() };
      const first = await receive(sent.body);
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({ status: 'PROCESSED', resource_version: 2 });
      const messageId = first.json.resource_id as string;
      const letterId = first.json.incoming_document_id as string;
      expect(await incomingCount()).toBe(before.letters + 1);
      expect(await inboundCount()).toBe(before.messages + 1);
      expect(await messageById(messageId)).toMatchObject({ direction: 'INBOUND', status: 'PROCESSED', external_message_id: 'E-IN-1', incoming_id: letterId, attempts: 0, adapter_status: 'MOCK' });
      const [letter] = await owner<{ status: string; channel: string; original_symbol: string; original_issued_on: string; sender_name: string; urgency: string; interop_message_id: string; received_by: string }>(
        'select status, channel, original_symbol, original_issued_on::text, sender_name, urgency, interop_message_id, received_by from machvon.incoming_document where id = $1',
        [letterId],
      );
      expect(letter).toEqual({ status: 'RECEIVED', channel: 'LGSP', original_symbol: '45/BTC-KHDT', original_issued_on: '2026-10-20', sender_name: 'G08.BTC', urgency: 'KHAN', interop_message_id: messageId, received_by: memberId(INTEROP_GATEWAY) });
      // The letter has its file: the PDF that was in the envelope, clean.
      const [file] = await owner<{ stage: string; scan_status: string; checksum: string }>(
        'select v.stage, v.scan_status, trim(v.checksum) as checksum from machvon.document_version v join machvon.incoming_document i on i.document_id = v.document_id where i.id = $1',
        [letterId],
      );
      expect(file).toMatchObject({ stage: 'RECEIVED_SCAN', scan_status: 'CLEAN' });
      expect(file?.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(await events(letterId, 'doc.incoming_received.v1')).toHaveLength(1);
      expect((await events(letterId, 'doc.incoming_received.v1'))[0]?.payload).toMatchObject({ channel: 'LGSP', interop_message_id: messageId });

      // The same envelope again, as the LGSP does when it did not see the answer: a new request, the same digest.
      const second = await receive(sent.body);
      expect(second).toMatchObject({ status: 409, json: { code: 'ENVELOPE_DUPLICATE', interop_message_id: messageId, incoming_document_id: letterId } });
      expect(await incomingCount()).toBe(before.letters + 1);
      expect(await inboundCount()).toBe(before.messages + 1);
      expect(await events(letterId, 'doc.incoming_received.v1')).toHaveLength(1);

      // The same request (same idempotency key) is answered with the first answer, whatever happened since.
      const key = randomUUID();
      const other = await delivery({ externalId: 'E-IN-2', symbol: '46/BTC-KHDT' });
      const firstAnswer = await receive(other.body, INTEROP_GATEWAY, key);
      const replay = await receive(other.body, INTEROP_GATEWAY, key);
      expect(replay.json).toEqual(firstAnswer.json);
      expect(await incomingCount()).toBe(before.letters + 2);
    });

    it('treats the same id of the sender with other bytes as the message that came again', async () => {
      const first = await delivery({ externalId: 'E-IN-ID', symbol: '50/BTC-KHDT' });
      expect((await receive(first.body)).status).toBe(200);
      const changed = await delivery({ externalId: 'E-IN-ID', symbol: '51/BTC-KHDT' });
      const reply = await receive(changed.body);
      expect([reply.status, reply.json.code]).toEqual([409, 'ENVELOPE_DUPLICATE']);
    });

    it('makes one letter when two deliveries of the same envelope arrive at once', async () => {
      const sent = await delivery({ externalId: 'E-IN-RACE', symbol: '60/BTC-KHDT' });
      const before = await incomingCount();
      const replies = await Promise.all([receive(sent.body), receive(sent.body)]);
      expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
      expect(await incomingCount()).toBe(before + 1);
    });

    it('takes a letter that looks like one already in the register with the reason that it came again, pointing at the first', async () => {
      const first = await receive((await delivery({ externalId: 'E-IN-A', symbol: '70/BTC-KHDT' })).body);
      const again = await receive((await delivery({ externalId: 'E-IN-B', symbol: '70/btc-khdt' })).body);
      expect([first.status, again.status]).toEqual([200, 200]);
      const [letter] = await owner<{ duplicate_of_id: string; duplicate_override_reason: string }>('select duplicate_of_id, duplicate_override_reason from machvon.incoming_document where id = $1', [again.json.incoming_document_id as string]);
      expect(letter).toEqual({ duplicate_of_id: first.json.incoming_document_id, duplicate_override_reason: 'Received again through the LGSP under another envelope' });
    });

    describe('the signature of the message', () => {
      it('refuses a key the connector does not hold with 422 SIGNATURE_KEY_UNKNOWN, before anything of the message is read', async () => {
        const before = await inboundCount();
        const unknown = await delivery({ keyId: 'k-unknown' });
        const reply = await receive(unknown.body);
        expect([reply.status, reply.json.code]).toEqual([422, 'SIGNATURE_KEY_UNKNOWN']);
        expect(await inboundCount()).toBe(before);
      });

      it.each([
        ['a signature made with another secret', { secret: 'not-the-secret-of-the-agency' }, (body: Record<string, unknown>) => body],
        ['a signature of another key', { keyId: 'k-old' }, (body: Record<string, unknown>) => body],
        ['a sender code changed after signing', {}, (body: Record<string, unknown>) => ({ ...body, sender_code: 'G08.OTHER' })],
        ['a message id changed after signing', {}, (body: Record<string, unknown>) => ({ ...body, external_message_id: 'E-CHANGED' })],
        ['a digest changed after signing', {}, (body: Record<string, unknown>) => ({ ...body, envelope_sha256: 'a'.repeat(64) })],
      ])('refuses %s with 401 SIGNATURE_INVALID and writes nothing', async (_name, options, change) => {
        const before = { letters: await incomingCount(), messages: await inboundCount() };
        const sent = await delivery({ externalId: `E-SIG-${randomUUID().slice(0, 6)}`, ...options });
        const body = change(sent.body);
        const reply = await receive(body);
        expect([reply.status, reply.json.code]).toEqual([401, 'SIGNATURE_INVALID']);
        expect({ letters: await incomingCount(), messages: await inboundCount() }).toEqual(before);
      });

      it('accepts the previous key of a rotation while the connector holds both', async () => {
        const sent = await delivery({ externalId: 'E-ROT', keyId: 'k-old', secret: 'the-key-before-rotation', symbol: '90/BTC-KHDT' });
        expect((await receive(sent.body)).status).toBe(200);
      });

      it.each([
        ['no connector', () => owner("delete from machvon.integration_connector where mode = 'LGSP'")],
        ['a connector that is not Active', () => connector({ status: 'Draft', adapter: 'PROPOSED' })],
      ])('takes nothing in where the tenant has %s: 503 PROVIDER_UNAVAILABLE', async (_name, arrange) => {
        const sent = await delivery({ externalId: `E-NC-${randomUUID().slice(0, 6)}` });
        await arrange();
        const before = await inboundCount();
        const reply = await receive(sent.body);
        expect([reply.status, reply.json.code]).toEqual([503, 'PROVIDER_UNAVAILABLE']);
        expect(await inboundCount()).toBe(before);
      });

      it('knows no key for a connector that holds no credential', async () => {
        await connector({ secretRef: null });
        const reply = await receive((await delivery({ externalId: 'E-NOCRED' })).body);
        expect([reply.status, reply.json.code]).toEqual([422, 'SIGNATURE_KEY_UNKNOWN']);
      });
    });

    describe('the envelope', () => {
      it('is the bytes whose digest was signed: another digest than the file has is 422 VALIDATION_FAILED', async () => {
        const sent = await delivery({ externalId: 'E-HASH' });
        const fields = { ...sent.fields, envelopeSha256: 'c'.repeat(64) };
        const body = { ...sent.body, envelope_sha256: fields.envelopeSha256, signature: signInteropMessage(Buffer.from(SECRET), fields) };
        const reply = await receive(body);
        expect([reply.status, reply.json.code, reply.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'envelope_sha256']);
      });

      it('must be an envelope of the format: 422 ENVELOPE_INVALID naming what is wrong', async () => {
        const cases: Array<[string, Buffer]> = [
          ['text that is not JSON', Buffer.from('this is not an envelope')],
          ['JSON of another format', Buffer.from(JSON.stringify({ format: 'other/1' }))],
          ['an attachment that does not match its digest', Buffer.from(JSON.stringify({ format: 'machvon.lgsp.json/1', document: { title: 'T', doc_type_code: 'QD' }, attachment: { media_type: 'application/pdf', sha256: 'd'.repeat(64), content_base64: Buffer.from('%PDF-1.4').toString('base64') } }))],
        ];
        for (const [, raw] of cases) {
          const reply = await receive((await delivery({ externalId: `E-BAD-${randomUUID().slice(0, 6)}`, raw })).body);
          expect([reply.status, reply.json.code]).toEqual([422, 'ENVELOPE_INVALID']);
        }
      });

      it('must carry a PDF, and a document type the tenant has', async () => {
        const notPdf = await receive((await delivery({ externalId: 'E-NOPDF', pdfBytes: Buffer.from('plain text, not a PDF') })).body);
        expect([notPdf.status, notPdf.json.code]).toEqual([422, 'UPLOAD_NOT_PDF']);
        const noType = await receive((await delivery({ externalId: 'E-NOTYPE', docTypeCode: 'NO-SUCH-TYPE' })).body);
        expect([noType.status, noType.json.code, noType.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'doc_type_code']);
        // Nothing of either was kept: the message is written in the transaction that makes the letter.
        expect(await app.count("select count(*) as n from machvon.doc_interop_message where external_message_id in ('E-NOPDF', 'E-NOTYPE')")).toBe(0);
      });

      it('is refused when its upload is not clean or is not this tenant\'s (the shared pipeline of uploads)', async () => {
        const infected = await delivery({ externalId: 'E-EICAR', raw: Buffer.from(eicarBytes()) });
        expect((await receive(infected.body)).status).toBe(422);
        const sent = await delivery({ externalId: 'E-FOREIGN' });
        const foreignKey = (await app.uploads.upload(tenantOf(1, TENANT_B), { purpose: 'document', declaredType: 'text/plain', bytes: sent.bytes })).key;
        const fields = { ...sent.fields, envelopeObjectKey: foreignKey };
        const reply = await receive({ ...sent.body, envelope_object_key: foreignKey, signature: signInteropMessage(Buffer.from(SECRET), fields) });
        expect(reply.status).toBe(404);
      });

      it('is not kept when it carries a level of state secret (BR-DOC-20): the refusal is audited as DENIED and nothing is created', async () => {
        const before = { letters: await incomingCount(), messages: await inboundCount() };
        const reply = await receive((await delivery({ externalId: 'E-SECRET', title: 'Công văn TUYỆT MẬT về kế hoạch' })).body);
        expect([reply.status, reply.json.code]).toEqual([422, 'STATE_SECRET_NOT_SUPPORTED']);
        expect({ letters: await incomingCount(), messages: await inboundCount() }).toEqual(before);
        const denied = await app.count("select count(*) as n from machvon.audit_event where action = 'doc_interop_message.receive' and outcome = 'DENIED'");
        expect(denied).toBeGreaterThanOrEqual(1);
      });
    });

    it('is taken by the service principal of the LGSP over the whole tenant and by no one else', async () => {
      for (const member of [NOBODY, INTEROP_READER]) {
        const reply = await receive((await delivery({ externalId: `E-AUTH-${randomUUID().slice(0, 6)}` })).body, member);
        expect(reply.status).toBe(403);
      }
      const unit = await receive((await delivery({ externalId: `E-AUTH-${randomUUID().slice(0, 6)}` })).body, INTEROP_UNIT);
      expect([unit.status, unit.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect((await receive((await delivery({ externalId: 'E-AUTH-OK', symbol: '99/BTC-KHDT' })).body, INTEROP_ADMIN)).status).toBe(200);
    });

    it('audits the receipt by the parties and the ids, never by the words of the letter', async () => {
      const reply = await receive((await delivery({ externalId: 'E-AUDIT', symbol: '98/BTC-KHDT', title: 'Distinctive title of the audited letter' })).body);
      const [entry] = await owner<{ safe_diff: Record<string, unknown>; classification: string }>("select safe_diff, classification from machvon.audit_event where action = 'doc_interop_message.receive' and resource_id = $1", [reply.json.resource_id as string]);
      expect(entry?.classification).toBe('INTERNAL');
      expect(entry?.safe_diff).toMatchObject({ sender_code: 'G08.BTC', signature_key_id: KEY, incoming_document_id: reply.json.incoming_document_id, to_status: 'PROCESSED' });
      expect(JSON.stringify(entry?.safe_diff)).not.toContain('Distinctive');
    });
  });
});
