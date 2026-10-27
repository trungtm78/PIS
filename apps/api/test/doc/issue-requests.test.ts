import { createHash, randomUUID } from 'node:crypto';
import { WORKER_MEMBERSHIP_ID } from '@machvon/db';
import type { OutboxDelivery } from '@machvon/db';
import { payloadSha256, signTenantContext } from '@machvon/kernel';
import { DocumentIssueConsumer, issueRequestOf } from '../../src/modules/doc/issue-consumer';
import { DocumentIssueService } from '../../src/modules/doc/issue-request.service';
import { loadPlatformTemplates } from '../../src/modules/doc/template-pack';
import { ACTOR, CLERK, DRAFTER, LEADER, MAKER, NOBODY, REFERENCER, REVIEWER, SIGNING_KEY, SOURCE, SOURCE_UNIT, TENANT_A, TENANT_B, memberId, unitId } from './doc-app';
import { FlowWorld, payloadOf } from './support/flow-world';
import { pageTexts } from './support/pdf-pages-text';

jest.setTimeout(240_000);

const flow = new FlowWorld();
const { app } = flow;
const owner = <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => app.harness.owner<T>(TENANT_A, [[sql, params]]);
const count = (sql: string, params: unknown[] = []): Promise<number> => app.count(sql, params);
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const WATERMARK = 'CHƯA XÁC NHẬN PHÁP LÝ [CXN-10]';

interface Stored {
  ref: string;
  sha: string;
}

async function store(payload: unknown, tenantId: string = TENANT_A): Promise<Stored> {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const ref = `tenants/${tenantId}/payloads/${randomUUID()}.json`;
  await app.files.put(ref, bytes, 'application/json');
  return { ref, sha: payloadSha256(payload) };
}

interface RequestOptions {
  payload?: unknown;
  stored?: Stored;
  template?: string;
  asOf?: string;
  event?: string;
  ref?: string;
  hint?: Record<string, unknown> | null;
  recipients?: unknown[];
  sha?: string;
}

async function requestBody(options: RequestOptions = {}): Promise<Record<string, unknown>> {
  const stored = options.stored ?? (await store(options.payload ?? payloadOf()));
  return {
    source_module: 'MNE',
    source_ref: options.ref ?? `MNE:mne_report:${randomUUID()}:r1`,
    template_code: options.template ?? 'QD-DEFAULT',
    payload_ref: stored.ref,
    payload_sha256: options.sha ?? stored.sha,
    event_id: options.event ?? randomUUID(),
    as_of_date: options.asOf ?? '2026-10-23',
    ...(options.hint === null ? {} : { signer_hint: options.hint ?? { drafting_unit_id: unitId(2), membership_id: memberId(LEADER) } }),
    recipients: options.recipients ?? [{ name: 'Department of Finance' }],
  };
}

const ask = (body: Record<string, unknown>, member: number = SOURCE, key?: string) => app.call('POST', '/document-issue-requests', { member, body, ...(key === undefined ? {} : { key }) });

interface RequestRow {
  id: string;
  status: string;
  reject_code: string | null;
  outgoing_document_id: string | null;
  template_id: string | null;
  completed_at: Date | null;
}

const requestRow = async (eventId: string): Promise<RequestRow> => {
  const [row] = await owner<RequestRow>('select id, status, reject_code, outgoing_document_id, template_id, completed_at from machvon.doc_issue_request where event_id = $1', [eventId]);
  if (row === undefined) throw new Error('no request');
  return row;
};

const eventsOf = (aggregateId: string, type?: string) =>
  owner<{ type: string; payload: Record<string, unknown> }>('select type, payload from machvon.outbox_event where aggregate_id = $1 and ($2::text is null or type = $2) order by created_at, id', [aggregateId, type ?? null]);

function delivery(type: string, payload: Record<string, unknown>, id: string = randomUUID()): OutboxDelivery {
  return {
    id,
    tenantId: TENANT_A,
    tenantContext: signTenantContext({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, SIGNING_KEY),
    type,
    schemaVersion: 1,
    aggregateType: 'mne_report',
    aggregateId: randomUUID(),
    aggregateVersion: 1,
    payload,
    eventKey: id,
    correlationId: randomUUID(),
    attempts: 0,
  };
}

const consumer = (): DocumentIssueConsumer =>
  new DocumentIssueConsumer({ database: app.harness.tenants, service: new DocumentIssueService(app.files, undefined, () => app.now), security: { signingKey: SIGNING_KEY } });

describe('issue requests and document references for source modules (ST-DOC-008)', () => {
  beforeAll(async () => {
    await flow.start();
    await app.harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: ACTOR, scopeVersion: 1 }, (tx) => loadPlatformTemplates(tx, ACTOR));
  }, 300_000);

  afterAll(() => flow.stop(), 60_000);
  afterEach(() => flow.reset());

  describe('requestDocumentIssue', () => {
    it('accepts a request: the payload is read and hashed again, the template of the date is chosen and a draft carrying the source reference is made', async () => {
      const body = await requestBody({ payload: payloadOf({ summary: 'Report of the month' }) });
      const reply = await ask(body);
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ status: 'ACCEPTED', issue_status: 'ACCEPTED', resource_version: 2 });
      const outgoingId = reply.json.outgoing_document_id as string;
      const request = await requestRow(body.event_id as string);
      expect(request).toMatchObject({ id: reply.json.resource_id, status: 'ACCEPTED', reject_code: null, outgoing_document_id: outgoingId });
      expect(request.completed_at).not.toBeNull();
      const [draft] = await owner<{ status: string; route: string; source_module: string; source_ref: string; issue_request_id: string; payload_sha256: string; signer_user_id: string; template_id: string; recipients: unknown; title: string; effect_status: string; source_ref_doc: string }>(
        `select o.status, o.route, o.source_module, o.source_ref, o.issue_request_id, o.payload_sha256, o.signer_user_id, o.template_id, o.recipients, d.title, d.effect_status, d.source_ref as source_ref_doc
           from machvon.outgoing_document o join machvon.document d on d.id = o.document_id where o.id = $1`,
        [outgoingId],
      );
      expect(draft).toMatchObject({
        status: 'DRAFT',
        route: 'IN_SYSTEM',
        source_module: 'MNE',
        source_ref: body.source_ref,
        source_ref_doc: body.source_ref,
        issue_request_id: request.id,
        payload_sha256: body.payload_sha256,
        signer_user_id: memberId(LEADER),
        template_id: request.template_id,
        title: 'Report of the month',
        effect_status: 'PENDING',
      });
      expect(draft?.recipients).toEqual([{ kind: 'EXTERNAL_AGENCY', name: 'Department of Finance' }]);
      const accepted = await eventsOf(request.id, 'doc.issue_accepted.v1');
      expect(accepted[0]?.payload).toMatchObject({ source_module: 'MNE', source_ref: body.source_ref, payload_sha256: body.payload_sha256, outgoing_document_id: outgoingId });
      expect((await eventsOf(outgoingId)).map((event) => event.type)).toEqual(['doc.draft_created.v1']);
      const history = await owner<{ kind: string }>('select kind from machvon.outgoing_document_event where outgoing_document_id = $1', [outgoingId]);
      expect(history.map((row) => row.kind)).toEqual(['CREATED']);
      // The draft is not issued by the module: no event says so, and the request is only ACCEPTED.
      expect(await count("select count(*) as n from machvon.outbox_event where type = 'doc.issued.v1' and payload->>'source_ref' = $1", [body.source_ref])).toBe(0);
    });

    it('rejects a payload whose hash is not the one declared: 422 PAYLOAD_HASH_MISMATCH, the request REJECTED and doc.rejected.v1 with the source reference (AC-ST-DOC-008-1, UAT-AC408)', async () => {
      const body = await requestBody({ sha: 'f'.repeat(64) });
      const reply = await ask(body);
      expect([reply.status, reply.json.code]).toEqual([422, 'PAYLOAD_HASH_MISMATCH']);
      const request = await requestRow(body.event_id as string);
      expect(request).toMatchObject({ status: 'REJECTED', reject_code: 'PAYLOAD_HASH_MISMATCH', outgoing_document_id: null });
      const events = await eventsOf(request.id, 'doc.rejected.v1');
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toEqual({ source_module: 'MNE', source_ref: body.source_ref, payload_sha256: 'f'.repeat(64), source_payload_sha256: 'f'.repeat(64), source_event_id: body.event_id, reject_code: 'PAYLOAD_HASH_MISMATCH' });
      expect(await count("select count(*) as n from machvon.outgoing_document where source_ref = $1", [body.source_ref])).toBe(0);
      // The refusal is final for that key: the same call again gets the same answer and writes nothing new.
      const again = await ask(body, SOURCE, undefined);
      expect([again.status, again.json.code]).toEqual([422, 'PAYLOAD_HASH_MISMATCH']);
      expect(again.json.replayed).toBe(true);
      expect(await count('select count(*) as n from machvon.doc_issue_request where event_id = $1', [body.event_id])).toBe(1);
    });

    it.each([
      ['a payload that cannot be found', 'PAYLOAD_HASH_MISMATCH'],
      ['a payload that is not JSON', 'PAYLOAD_SCHEMA_INVALID'],
      ['a payload that is not an object', 'PAYLOAD_SCHEMA_INVALID'],
      ['a payload with a field missing', 'PAYLOAD_SCHEMA_INVALID'],
      ['an amount that is not whole VND', 'PAYLOAD_SCHEMA_INVALID'],
      ['a template that never existed', 'DOC_TEMPLATE_MISSING'],
      ['a template that is not in force on the date', 'TEMPLATE_NOT_EFFECTIVE'],
      ['a payload that declares a state secret', 'STATE_SECRET_NOT_SUPPORTED'],
      ['recipients that cannot be read', 'PAYLOAD_SCHEMA_INVALID'],
      ['no drafting unit', 'PAYLOAD_SCHEMA_INVALID'],
      ['a drafting unit of nobody', 'PAYLOAD_SCHEMA_INVALID'],
      ['a delegated signature without a delegation', 'PAYLOAD_SCHEMA_INVALID'],
    ] as const)('refuses %s with %s and keeps the refusal', async (name, code) => {
      let body: Record<string, unknown>;
      switch (name) {
        case 'a payload that cannot be found':
          body = await requestBody({ stored: { ref: `tenants/${TENANT_A}/payloads/missing.json`, sha: 'a'.repeat(64) } });
          break;
        case 'a payload that is not JSON': {
          const ref = `tenants/${TENANT_A}/payloads/${randomUUID()}.json`;
          await app.files.put(ref, Buffer.from('not json at all'), 'application/json');
          body = await requestBody({ stored: { ref, sha: 'a'.repeat(64) } });
          break;
        }
        case 'a payload that is not an object': {
          const ref = `tenants/${TENANT_A}/payloads/${randomUUID()}.json`;
          await app.files.put(ref, Buffer.from('[1,2]'), 'application/json');
          body = await requestBody({ stored: { ref, sha: 'a'.repeat(64) } });
          break;
        }
        case 'a payload with a field missing':
          body = await requestBody({ payload: { agency: 'Only the agency' } });
          break;
        case 'an amount that is not whole VND':
          body = await requestBody({ payload: payloadOf({ amount_vnd: '12.5' }) });
          break;
        case 'a template that never existed':
          body = await requestBody({ template: 'NO-SUCH-TEMPLATE' });
          break;
        case 'a template that is not in force on the date':
          body = await requestBody({ asOf: '2019-01-01' });
          break;
        case 'a payload that declares a state secret':
          body = await requestBody({ payload: payloadOf({ secrecy_level: 'Tối mật' }) });
          break;
        case 'recipients that cannot be read':
          body = await requestBody({ recipients: [{ name: ' ' }] });
          break;
        case 'no drafting unit':
          body = await requestBody({ hint: null });
          break;
        case 'a drafting unit of nobody':
          body = await requestBody({ hint: { drafting_unit_id: randomUUID() } });
          break;
        case 'a delegated signature without a delegation':
          body = await requestBody({ hint: { drafting_unit_id: unitId(2), signing_mode: 'KT' } });
          break;
      }
      const reply = await ask(body);
      expect([reply.status, reply.json.code]).toEqual([422, code]);
      expect(await requestRow(body.event_id as string)).toMatchObject({ status: 'REJECTED', reject_code: code });
      expect((await eventsOf((await requestRow(body.event_id as string)).id, 'doc.rejected.v1'))[0]?.payload).toMatchObject({ reject_code: code, source_ref: body.source_ref });
      expect(await count('select count(*) as n from machvon.outgoing_document where source_ref = $1', [body.source_ref])).toBe(0);
    });

    it('answers the same event with the first answer, whichever key it comes with, and refuses the same event with other content', async () => {
      const body = await requestBody();
      const first = await ask(body);
      const second = await ask(body, SOURCE, `second-${randomUUID()}`);
      expect(second.status).toBe(200);
      expect(second.json.resource_id).toBe(first.json.resource_id);
      expect(second.json.outgoing_document_id).toBe(first.json.outgoing_document_id);
      expect(await count('select count(*) as n from machvon.outgoing_document where source_ref = $1', [body.source_ref])).toBe(1);
      const other = await ask({ ...body, source_ref: `${String(body.source_ref)}-other` });
      expect([other.status, other.json.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    });

    it('answers a second request for the same content with 409 ISSUE_REQUEST_ALREADY_OPEN and the request that is open (AC-ST-DOC-008-2, UAT-AC409)', async () => {
      const first = await requestBody();
      const accepted = await ask(first);
      const again = await ask({ ...first, event_id: randomUUID() });
      expect([again.status, again.json.code]).toEqual([409, 'ISSUE_REQUEST_ALREADY_OPEN']);
      expect(again.json).toMatchObject({ issue_request_id: accepted.json.resource_id, outgoing_document_id: accepted.json.outgoing_document_id, issue_status: 'ACCEPTED' });
      expect(await count('select count(*) as n from machvon.outgoing_document where source_ref = $1', [first.source_ref])).toBe(1);
      // New content for the same reference is a new request.
      const changed = await store(payloadOf({ body: 'The text was changed' }));
      const next = await ask({ ...first, event_id: randomUUID(), payload_ref: changed.ref, payload_sha256: changed.sha });
      expect(next.status).toBe(200);
      expect(await count('select count(*) as n from machvon.outgoing_document where source_ref = $1', [first.source_ref])).toBe(2);
    });

    it('lets the content ask again once the document it produced was cancelled, and keeps the earlier request as it ended', async () => {
      const body = await requestBody();
      const first = await ask(body);
      const outgoingId = first.json.outgoing_document_id as string;
      const cancelled = await app.call('POST', `/outgoing-documents/${outgoingId}/cancellation`, { member: MAKER, ifMatch: '"1"', body: { reason: 'The report was withdrawn', reject_code: 'SOURCE_WITHDRAWN' } });
      expect(cancelled.status).toBe(200);
      expect(await requestRow(body.event_id as string)).toMatchObject({ status: 'CANCELLED' });
      const rejected = await eventsOf(outgoingId, 'doc.rejected.v1');
      expect(rejected[0]?.payload).toMatchObject({ source_ref: body.source_ref, reject_code: 'SOURCE_WITHDRAWN' });
      const again = await ask({ ...body, event_id: randomUUID() });
      expect(again.status).toBe(200);
      expect(again.json.outgoing_document_id).not.toBe(outgoingId);
    });

    it('is asked by a source module over the whole tenant, not by a holder of a branch of the tree, nor by somebody without the permission', async () => {
      const body = await requestBody();
      const branch = await ask(body, SOURCE_UNIT);
      expect([branch.status, branch.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const nobody = await ask(body, NOBODY);
      expect([nobody.status, nobody.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect(await count('select count(*) as n from machvon.doc_issue_request where event_id = $1', [body.event_id])).toBe(0);
    });

    it('does not read a payload that lies in the storage of another tenant, nor accept a module code that is not one', async () => {
      const foreign = await store(payloadOf(), TENANT_B);
      const reply = await ask(await requestBody({ stored: foreign }));
      expect([reply.status, reply.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const lower = await ask({ ...(await requestBody()), source_module: 'mne' });
      expect([lower.status, lower.json.code]).toEqual([422, 'VALIDATION_FAILED']);
    });

    it('keeps a request the database refuses to change: what was asked is fixed, the outcome moves forward only, nothing is deleted', async () => {
      const accepted = await ask(await requestBody());
      const id = accepted.json.resource_id as string;
      const tenant = { tenantId: TENANT_A, membershipId: memberId(SOURCE), scopeVersion: 1 };
      for (const sql of [
        "update machvon.doc_issue_request set payload_sha256 = repeat('a', 64) where id = $1",
        "update machvon.doc_issue_request set source_ref = 'MNE:other' where id = $1",
        "update machvon.doc_issue_request set status = 'RECEIVED' where id = $1",
        "update machvon.doc_issue_request set status = 'REJECTED', reject_code = 'PAYLOAD_SCHEMA_INVALID', outgoing_document_id = null where id = $1",
        'delete from machvon.doc_issue_request where id = $1',
      ]) {
        await expect(app.harness.tenants.withTenant(tenant, (tx) => tx.query(sql, [id]))).rejects.toMatchObject({ code: expect.stringMatching(/^(23514|42501)$/) as unknown });
      }
      await expect(app.harness.tenants.withTenant(tenant, (tx) => tx.query('truncate machvon.doc_issue_request'))).rejects.toMatchObject({ code: '42501' });
      await expect(app.harness.owner(TENANT_A, [["insert into machvon.doc_issue_request (tenant_id, id, source_module, source_ref, template_code, payload_sha256, payload_ref, event_id, status, requested_by, created_by, updated_by) values ($1, gen_random_uuid(), 'mne', 'MNE:x:1', 'T', repeat('a', 64), 'p', gen_random_uuid(), 'RECEIVED', $2, $2, $2)", [TENANT_A, ACTOR]]])).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('the event consumer', () => {
    it('makes one document from the same event delivered twice and none from a second event for the same content (AC-ST-DOC-008-2, UAT-AC409)', async () => {
      const stored = await store(payloadOf({ summary: 'Event report' }));
      const reference = `MNE:mne_report:${randomUUID()}:r2`;
      const payload = {
        source_ref: reference,
        template_code: 'QD-DEFAULT',
        payload_ref: stored.ref,
        payload_sha256: stored.sha,
        event_id: randomUUID(),
        as_of_date: '2026-10-23',
        signer_hint: { drafting_unit_id: unitId(2), membership_id: memberId(LEADER) },
        recipients: [{ name: 'Department of Finance' }],
      };
      const subject = consumer();
      const first = delivery('mne.report.issue_requested.v1', payload);
      expect(await subject.handle(first)).toBe('processed');
      // The relay delivers an event at least once: the same delivery again is a counted duplicate...
      expect(await subject.handle(first)).toBe('duplicate');
      // ...and the same business event through another delivery is the same request.
      expect(await subject.handle(delivery('doc.issue_requested.v1', { ...payload, source_module: 'MNE' }))).toBe('processed');
      expect(await count('select count(*) as n from machvon.outgoing_document where source_ref = $1', [reference])).toBe(1);
      // A second event, other event id, same reference and hash: no second document.
      expect(await subject.handle(delivery('mne.report.issue_requested.v1', { ...payload, event_id: randomUUID() }))).toBe('processed');
      expect(await count('select count(*) as n from machvon.outgoing_document where source_ref = $1', [reference])).toBe(1);
      expect(await count("select count(*) as n from machvon.doc_issue_request where source_ref = $1 and status = 'ACCEPTED'", [reference])).toBe(1);
      // The REST path answers the same content with the 409.
      const rest = await ask({ source_module: 'MNE', source_ref: reference, template_code: 'QD-DEFAULT', payload_ref: stored.ref, payload_sha256: stored.sha, event_id: randomUUID(), as_of_date: '2026-10-23' });
      expect([rest.status, rest.json.code]).toEqual([409, 'ISSUE_REQUEST_ALREADY_OPEN']);
      expect(await count('select count(*) as n from machvon.outgoing_document where source_ref = $1', [reference])).toBe(1);
    });

    it('records a refusal the way the port does, and leaves an event that is not a request, or not well formed, alone', async () => {
      const stored = await store(payloadOf());
      const subject = consumer();
      const event = randomUUID();
      const base = { source_module: 'DIS', source_ref: `DIS:report:${randomUUID()}:r1`, template_code: 'NO-SUCH-TEMPLATE', payload_ref: stored.ref, payload_sha256: stored.sha, event_id: event, as_of_date: '2026-10-23', signer_hint: { drafting_unit_id: unitId(2) } };
      expect(await subject.handle(delivery('doc.issue_requested.v1', base))).toBe('processed');
      expect(await requestRow(event)).toMatchObject({ status: 'REJECTED', reject_code: 'DOC_TEMPLATE_MISSING' });
      expect((await owner<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where type = 'doc.rejected.v1' and payload->>'source_ref' = $1", [base.source_ref]))[0]?.payload).toMatchObject({ source_module: 'DIS', reject_code: 'DOC_TEMPLATE_MISSING' });
      expect(await subject.handle(delivery('mne.report.updated.v1', base))).toBe('ignored');
      expect(await subject.handle({ ...delivery('doc.issue_requested.v1', base), schemaVersion: 2 })).toBe('ignored');
      for (const broken of [{ ...base, event_id: 'nope' }, { ...base, payload_sha256: 'short' }, { ...base, as_of_date: 'yesterday' }, { ...base, recipients: 'x' }, { ...base, signer_hint: 'x' }, { ...base, source_ref: '' }]) {
        expect(await subject.handle(delivery('doc.issue_requested.v1', broken))).toBe('ignored');
      }
      expect(await count("select count(*) as n from machvon.doc_issue_request where source_module = 'DIS'")).toBe(1);
      expect(issueRequestOf({ type: 'mne.report.issue_requested.v1', payload: { ...base, source_module: undefined } })?.sourceModule).toBe('MNE');
      expect(issueRequestOf({ type: 'aud.report.issue_requested.v1', payload: { ...base, source_module: undefined } })?.sourceModule).toBe('AUD');
      expect(issueRequestOf({ type: 'doc.issue_requested.v1', payload: { ...base, source_module: undefined } })).toBeUndefined();
      expect(issueRequestOf({ type: 'doc.issue_requested.v1', payload: { ...base, source_module: 'bad' } })).toBeUndefined();
      expect(issueRequestOf({ type: 'doc.issue_requested.v1', payload: { ...base, event_id: randomUUID().toUpperCase() } })?.eventId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('refuses a delivery whose signed context is not the one of its tenant', async () => {
      const stored = await store(payloadOf());
      const forged = { ...delivery('doc.issue_requested.v1', { source_module: 'MNE', source_ref: 'MNE:mne_report:forged:r1', template_code: 'QD-DEFAULT', payload_ref: stored.ref, payload_sha256: stored.sha, event_id: randomUUID(), as_of_date: '2026-10-23' }), tenantId: TENANT_B };
      await expect(consumer().handle(forged)).rejects.toMatchObject({ code: 'TENANT_CONTEXT_INVALID' });
      expect(await count("select count(*) as n from machvon.doc_issue_request where source_ref = 'MNE:mne_report:forged:r1'")).toBe(0);
    });
  });

  describe('the chain from a source module to ISSUED', () => {
    it('keeps the module waiting until doc.issued.v1: draft, review, signature, number, seal and issue, with the event once (AC-ST-DOC-008-3, UAT-AC410)', async () => {
      const body = await requestBody({ payload: payloadOf({ amount_vnd: '2500000000' }) });
      const accepted = await ask(body);
      const id = accepted.json.outgoing_document_id as string;
      const requestId = accepted.json.resource_id as string;
      // The drafter completes the place of issue: the hash of the draft is no longer the hash of the request.
      await owner("update machvon.outgoing_document set payload_sha256 = repeat('c', 64) where id = $1", [id]);
      expect((await flow.submit(id, 1)).status).toBe(200);
      const approved = await flow.approve(id, 2);
      expect(approved.status).toBe(200);
      const register = await flow.openRegister();
      const sealedVersion = await flow.sealFrom(id, approved.json.resource_version as number, register);
      // Sealed is not issued: the module has been told nothing and its request is still only ACCEPTED.
      expect((await requestRow(body.event_id as string)).status).toBe('ACCEPTED');
      expect(await eventsOf(id, 'doc.issued.v1')).toHaveLength(0);
      expect(sealedVersion).toBeGreaterThan(0);

      await flow.issueSealed(id);
      const [issued] = await owner<{ status: string; issued_at: Date | null; document_number: number; symbol: string; effect_status: string; checksum: string; version_id: string }>(
        `select o.status, o.issued_at, d.document_number, d.symbol, d.effect_status, v.checksum, v.id as version_id
           from machvon.outgoing_document o join machvon.document d on d.id = o.document_id join machvon.document_version v on v.id = d.current_version_id where o.id = $1`,
        [id],
      );
      expect(issued).toMatchObject({ status: 'ISSUED', effect_status: 'EFFECTIVE' });
      expect(issued?.issued_at).not.toBeNull();
      const events = await eventsOf(id, 'doc.issued.v1');
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({
        source_module: 'MNE',
        source_ref: body.source_ref,
        // What the module asked for travels apart from the hash of the draft the drafter changed.
        payload_sha256: 'c'.repeat(64),
        source_payload_sha256: body.payload_sha256,
        source_event_id: body.event_id,
        document_number: issued?.document_number,
        symbol: issued?.symbol,
        file_sha256: issued?.checksum,
        document_version_id: issued?.version_id,
        route: 'IN_SYSTEM',
      });
      expect(await requestRow(body.event_id as string)).toMatchObject({ id: requestId, status: 'ISSUED' });
      // The history says so, and a second attempt to issue the same document is refused by the state, not repeated.
      const history = await owner<{ kind: string }>('select kind from machvon.outgoing_document_event where outgoing_document_id = $1 order by seq', [id]);
      expect(history.map((row) => row.kind)).toEqual(['CREATED', 'REVIEW_REQUESTED', 'REVIEW_APPROVED', 'LEADER_SIGNED', 'NUMBERED', 'SEALED', 'ISSUED']);
      await expect(flow.issueSealed(id)).rejects.toMatchObject({ code: 'DOCUMENT_STATE_INVALID' });
      expect(await eventsOf(id, 'doc.issued.v1')).toHaveLength(1);
      // The same content cannot be asked for again while its request is issued.
      const again = await ask({ ...body, event_id: randomUUID() });
      expect([again.status, again.json.code]).toEqual([409, 'ISSUE_REQUEST_ALREADY_OPEN']);
      // The reference port now says the document may be relied on.
      const usable = await app.call('GET', `/documents/${accepted.json.document_id as string}/usability`, { member: REFERENCER });
      expect(usable.status).toBe(200);
      expect(usable.json).toMatchObject({ usable: true, effect_status: 'EFFECTIVE', symbol: issued?.symbol, doc_type_code: 'QD' });
    });

    it('renders an issue request on a template that waits for legal confirmation with the watermark on every page (AC-ST-DOC-006-3, UAT-AC407)', async () => {
      const report = await store({ agency: 'People Committee', place: 'Cao Bang', title: 'Monitoring report M02', period: 'Quarter 3 of 2026', body: 'The projects were monitored.' });
      const body = await requestBody({ stored: report, template: 'MNE-TT44-M02' });
      const accepted = await ask(body);
      expect(accepted.status).toBe(200);
      const id = accepted.json.outgoing_document_id as string;
      expect((await flow.submit(id, 1)).status).toBe(200);
      const approved = await flow.approve(id, 2);
      expect(approved.status).toBe(200);
      const [file] = await owner<{ object_key: string }>('select v.object_key from machvon.document_version v join machvon.outgoing_document o on o.document_id = v.document_id where o.id = $1', [id]);
      const bytes = await app.files.get(file?.object_key ?? '');
      expect(sha256(bytes?.bytes ?? new Uint8Array())).toBe(approved.json.file_sha256);
      const pages = await pageTexts(bytes?.bytes ?? new Uint8Array());
      expect(pages.length).toBeGreaterThan(0);
      for (const texts of pages) expect(texts).toContain(WATERMARK);
    });
  });

  describe('resolveDocumentReference', () => {
    let counter = 0;
    async function document(effect: string, extra: string = ''): Promise<string> {
      const id = randomUUID();
      counter += 1;
      await app.harness.owner(TENANT_A, [
        [
          `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, effect_status, document_number, number_year, symbol, issued_on, created_by, updated_by${extra === '' ? '' : ', classification'})
           values ($1, $2, 'OUTGOING', 'QD', 'A document', $3, case when $3 = 'PENDING' then null else 5 end, case when $3 = 'PENDING' then null else 2026 end,
                   case when $3 = 'PENDING' then null else $5::text end, case when $3 = 'PENDING' then null else date '2026-06-15' end, $4, $4${extra === '' ? '' : ", 'PERSONAL'"})`,
          [TENANT_A, id, effect, ACTOR, `${counter}/QD-REF`],
        ],
      ]);
      return id;
    }
    const relate = (from: string, to: string, kind: string) =>
      app.harness.owner(TENANT_A, [["insert into machvon.document_relation (tenant_id, id, from_document_id, to_document_id, relation_kind, created_by, updated_by) values ($1, gen_random_uuid(), $2, $3, $4, $5, $5)", [TENANT_A, from, to, kind, ACTOR]]]);
    const usability = (id: string, member: number = REFERENCER) => app.call('GET', `/documents/${id}/usability`, { member });

    it('says that a document in force may be relied on, with what is printed on its face and nothing else', async () => {
      const id = await document('EFFECTIVE');
      const reply = await usability(id);
      expect(reply.status).toBe(200);
      expect(reply.json).toEqual({
        document_id: id,
        usable: true,
        doc_kind: 'OUTGOING',
        doc_type_code: 'QD',
        effect_status: 'EFFECTIVE',
        symbol: '1/QD-REF',
        document_number: 5,
        number_year: 2026,
        issued_on: '2026-06-15',
        relations: [],
      });
    });

    it('refuses a document that was recalled, replaced, expired or never issued with DOCUMENT_NOT_EFFECTIVE, and names what replaced it', async () => {
      for (const effect of ['PENDING', 'RECALLED', 'EXPIRED']) {
        const reply = await usability(await document(effect));
        expect([reply.status, reply.json.code, reply.json.effect_status]).toEqual([422, 'DOCUMENT_NOT_EFFECTIVE', effect]);
      }
      const old = await document('REPLACED');
      const replacement = await document('EFFECTIVE');
      await relate(replacement, old, 'REPLACES');
      const replaced = await usability(old);
      expect([replaced.status, replaced.json.code, replaced.json.reason]).toEqual([422, 'DOCUMENT_NOT_EFFECTIVE', 'NOT_EFFECTIVE']);
      expect(replaced.json.relations).toEqual([{ kind: 'REPLACES', document_id: replacement }]);
    });

    it('keeps a corrected document in force and shows the correction', async () => {
      const original = await document('CORRECTED');
      const correction = await document('EFFECTIVE');
      await relate(correction, original, 'CORRECTS');
      const reply = await usability(original);
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ usable: true, effect_status: 'CORRECTED', relations: [{ kind: 'CORRECTS', document_id: correction }] });
    });

    it('does not show a document that does not exist (the other tenants are held out by the isolation suite), or to somebody without the permission', async () => {
      const id = await document('EFFECTIVE');
      expect((await usability(randomUUID())).status).toBe(404);
      const nobody = await usability(id, NOBODY);
      expect([nobody.status, nobody.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect((await usability('not-a-uuid')).status).toBe(422);
    });
  });

  it('keeps the people of the flow separate: a drafter, a reviewer and a clerk hold none of the permissions of a source module', async () => {
    const body = await requestBody();
    for (const member of [DRAFTER, REVIEWER, CLERK, MAKER]) expect((await ask(body, member)).status).toBe(403);
  });
});
