import { createHash } from 'node:crypto';
import { DocumentStore } from '@machvon/db';
import { payloadSha256 } from '@machvon/kernel';
import { ACTOR, ADMIN, DocApp, NOBODY, NOW, RENDERER_ONLY, TENANT_A, TENANT_B, UNIT_TWO_CLERK, memberId, unitId } from './doc-app';

jest.setTimeout(60_000);

const harnessApp = new DocApp();
const store = new DocumentStore();
const ctx = (tenantId: string, member = ADMIN) => ({ tenantId, membershipId: memberId(member), scopeVersion: 1 });

const PAYLOAD = { title: 'Decision on the disbursement plan', body: 'The plan is approved.', agency: 'Project board', place: 'Cao Bang', signer_title: 'Director', signer_name: 'An', recipients: ['As above'] };
const renderBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ template_code: 'QD-DEFAULT', as_of_date: '2026-10-23', payload: PAYLOAD, ...overrides });

async function insertVersion(tenantId: string, issuerUnitId: string | undefined, scan: 'PENDING' | 'CLEAN' | 'INFECTED'): Promise<string> {
  const bytes = new Uint8Array(Buffer.from(`%PDF-fake-${Math.random()}`));
  const key = `tenants/${tenantId}/documents/fake-${Math.random().toString(16).slice(2)}.pdf`;
  await harnessApp.files.put(key, bytes, 'application/pdf');
  return harnessApp.harness.tenants.withTenant(ctx(tenantId), async (tx) => {
    const document = await store.insertDocument(tx, { docKind: 'OUTGOING', docTypeCode: 'QD', title: 'Seeded', classification: 'INTERNAL', createdBy: ACTOR, issuerUnitId });
    const version = await store.appendVersion(tx, {
      documentId: document.id,
      objectKey: key,
      checksum: createHash('sha256').update(bytes).digest('hex'),
      mime: 'application/pdf',
      pageCount: 1,
      classification: 'INTERNAL',
      stage: 'RENDERED_FINAL',
      byteLength: bytes.length,
      createdBy: ACTOR,
    });
    if (scan !== 'PENDING') await store.setScanResult(tx, version.id, scan);
    return version.id;
  });
}

describe('documents API (ST-DOC-001)', () => {
  beforeAll(() => harnessApp.start(), 240_000);
  afterAll(() => harnessApp.stop(), 60_000);

  describe('renderDocumentPreview', () => {
    it('renders a watermarked PDF while the template waits for legal confirmation, stores it and audits it', async () => {
      const reply = await harnessApp.call('POST', '/document-renders', { member: ADMIN, body: renderBody() });
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ status: 'RENDERED', resource_version: 1, watermarked: true, page_count: 1 });
      const versionId = reply.json.resource_id as string;
      expect(reply.json.version_id).toBe(versionId);
      const [row] = await harnessApp.harness.owner<{ object_key: string; checksum: string; scan_status: string; stage: string; renderer_version: string }>(TENANT_A, [
        ['select object_key, checksum, scan_status, stage, renderer_version from machvon.document_version where id = $1', [versionId]],
      ]);
      expect(row).toMatchObject({ checksum: reply.json.sha256, scan_status: 'CLEAN', stage: 'RENDERED_FINAL' });
      expect(row?.object_key.startsWith(`tenants/${TENANT_A}/documents/`)).toBe(true);
      const stored = await harnessApp.files.get(row?.object_key ?? '');
      expect(createHash('sha256').update(stored?.bytes ?? new Uint8Array()).digest('hex')).toBe(row?.checksum);
      const audit = await harnessApp.harness.owner<{ safe_diff: Record<string, unknown> }>(TENANT_A, [
        ["select safe_diff from machvon.audit_event where action = 'document.render' and resource_id = $1", [versionId]],
      ]);
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit[0]?.safe_diff)).not.toContain('Decision on the disbursement plan');
      expect(harnessApp.metrics).toContainEqual({ name: 'doc_render_total', labels: { outcome: 'rendered', watermarked: 'true' } });
    });

    it('gives the same file for the same input and replays an idempotent retry without a second document (AC-ST-DOC-001-1)', async () => {
      const key = 'render-idempotent-1';
      const before = await harnessApp.count('select count(*) as n from machvon.document');
      const first = await harnessApp.call('POST', '/document-renders', { member: ADMIN, body: renderBody(), key });
      const replay = await harnessApp.call('POST', '/document-renders', { member: ADMIN, body: renderBody(), key });
      expect(replay.status).toBe(first.status);
      expect(replay.json.resource_id).toBe(first.json.resource_id);
      expect(await harnessApp.count('select count(*) as n from machvon.document')).toBe(before + 1);
      const again = await harnessApp.call('POST', '/document-renders', { member: ADMIN, body: renderBody() });
      expect(again.json.sha256).toBe(first.json.sha256);
      expect(again.json.resource_id).not.toBe(first.json.resource_id);
    });

    it('refuses to render with a template that is not confirmed when confirmed ones are required (BR-DOC-10)', async () => {
      const reply = await harnessApp.call('POST', '/document-renders', { member: ADMIN, body: renderBody({ require_confirmed: true }) });
      expect(reply.status).toBe(422);
      expect(reply.json.code).toBe('TEMPLATE_UNCONFIRMED');
    });

    it('checks the declared payload hash and the payload against the template', async () => {
      const good = await harnessApp.call('POST', '/document-renders', { member: ADMIN, body: renderBody({ payload_sha256: payloadSha256(PAYLOAD) }) });
      expect(good.status).toBe(200);
      const bad = await harnessApp.call('POST', '/document-renders', { member: ADMIN, body: renderBody({ payload_sha256: 'f'.repeat(64) }) });
      expect([bad.status, bad.json.code]).toEqual([422, 'PAYLOAD_HASH_MISMATCH']);
      const missing = await harnessApp.call('POST', '/document-renders', { member: ADMIN, body: renderBody({ payload: { ...PAYLOAD, body: '' } }) });
      expect([missing.status, missing.json.code]).toEqual([422, 'PAYLOAD_SCHEMA_INVALID']);
    });

    it('answers TEMPLATE_NOT_EFFECTIVE for an unknown template or a date before it takes effect, and refuses a PNG preview', async () => {
      const unknown = await harnessApp.call('POST', '/document-renders', { member: ADMIN, body: renderBody({ template_code: 'NO-SUCH' }) });
      expect([unknown.status, unknown.json.code]).toEqual([422, 'TEMPLATE_NOT_EFFECTIVE']);
      const early = await harnessApp.call('POST', '/document-renders', { member: ADMIN, body: renderBody({ as_of_date: '2019-01-01' }) });
      expect([early.status, early.json.code]).toEqual([422, 'TEMPLATE_NOT_EFFECTIVE']);
      const png = await harnessApp.call('POST', '/document-renders', { member: ADMIN, body: renderBody({ output: 'PREVIEW_PNG' }) });
      expect([png.status, png.json.code]).toEqual([422, 'VALIDATION_FAILED']);
    });

    it('does not let a member without the permission render', async () => {
      const reply = await harnessApp.call('POST', '/document-renders', { member: NOBODY, body: renderBody() });
      expect([reply.status, reply.json.code]).toEqual([403, 'SCOPE_DENIED']);
    });

    it('renders from the templates of its own tenant only', async () => {
      const reply = await harnessApp.call('POST', '/document-renders', { member: ADMIN, tenantId: TENANT_B, body: renderBody() });
      expect([reply.status, reply.json.code]).toEqual([422, 'TEMPLATE_NOT_EFFECTIVE']);
    });
  });

  describe('downloads (BR-DOC-19)', () => {
    it('UAT-AC432: hands out a URL that lives 300 seconds for a clean file and audits the download (AC-ST-DOC-001-2)', async () => {
      const rendered = await harnessApp.call('POST', '/document-renders', { member: ADMIN, body: renderBody() });
      const versionId = rendered.json.resource_id as string;
      const reply = await harnessApp.call('GET', `/document-versions/${versionId}/download`, { member: ADMIN });
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ version_id: versionId, mime: 'application/pdf', expires_at: new Date(NOW.getTime() + 300_000).toISOString() });
      expect(String(reply.json.url)).toContain('mock://documents/');
      expect(await harnessApp.count("select count(*) as n from machvon.audit_event where action = 'document.download' and outcome = 'SUCCESS' and resource_id = $1", [versionId])).toBe(1);
    });

    it('UAT-AC432: answers 409 SCAN_PENDING while the scan is pending (AC-ST-DOC-001-2)', async () => {
      const versionId = await insertVersion(TENANT_A, undefined, 'PENDING');
      const reply = await harnessApp.call('GET', `/document-versions/${versionId}/download`, { member: ADMIN });
      expect([reply.status, reply.json.code]).toEqual([409, 'SCAN_PENDING']);
    });

    it('UAT-AC432: blocks an infected file, records the denial with INFECTED_FILE_BLOCKED and hands out no URL (AC-ST-DOC-001-2)', async () => {
      const versionId = await insertVersion(TENANT_A, undefined, 'INFECTED');
      const reply = await harnessApp.call('GET', `/document-versions/${versionId}/download`, { member: ADMIN });
      expect([reply.status, reply.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect(JSON.stringify(reply.json)).not.toContain('mock://');
      const [denied] = await harnessApp.harness.owner<{ safe_diff: { reason: string } }>(TENANT_A, [
        ["select safe_diff from machvon.audit_event where action = 'document.download' and outcome = 'DENIED' and resource_id = $1", [versionId]],
      ]);
      expect(denied?.safe_diff.reason).toBe('INFECTED_FILE_BLOCKED');
    });

    it('UAT-AC432: hides a version of another tenant and one outside the unit scope of the caller as if it did not exist (AC-ST-DOC-001-3)', async () => {
      const foreign = await insertVersion(TENANT_B, undefined, 'CLEAN');
      expect((await harnessApp.call('GET', `/document-versions/${foreign}/download`, { member: ADMIN })).status).toBe(404);
      const inUnitOne = await insertVersion(TENANT_A, unitId(1), 'CLEAN');
      const inUnitTwo = await insertVersion(TENANT_A, unitId(2), 'CLEAN');
      expect((await harnessApp.call('GET', `/document-versions/${inUnitOne}/download`, { member: UNIT_TWO_CLERK })).status).toBe(404);
      expect((await harnessApp.call('GET', `/document-versions/${inUnitTwo}/download`, { member: UNIT_TWO_CLERK })).status).toBe(200);
      expect((await harnessApp.call('GET', `/document-versions/${inUnitOne}/download`, { member: NOBODY })).status).toBe(403);
      expect((await harnessApp.call('GET', '/document-versions/not-a-uuid/download', { member: ADMIN })).status).toBe(422);
    });
  });

  describe('reads of document versions', () => {
    it('lists versions without the storage key and finds one by id inside the scope', async () => {
      const mine = await insertVersion(TENANT_A, unitId(2), 'CLEAN');
      const outside = await insertVersion(TENANT_A, unitId(1), 'CLEAN');
      const clerk = await harnessApp.call('GET', '/resources/document_version?limit=200', { member: UNIT_TWO_CLERK });
      expect(clerk.status).toBe(200);
      const items = clerk.json.items as Array<Record<string, unknown>>;
      expect(items.map((item) => item.id)).toContain(mine);
      expect(items.map((item) => item.id)).not.toContain(outside);
      expect(JSON.stringify(items)).not.toContain('object_key');
      const one = await harnessApp.call('GET', `/resources/document_version/${mine}`, { member: UNIT_TWO_CLERK });
      expect(one.json).toMatchObject({ id: mine, scan_status: 'CLEAN', stage: 'RENDERED_FINAL' });
      expect((await harnessApp.call('GET', `/resources/document_version/${outside}`, { member: UNIT_TWO_CLERK })).status).toBe(404);
      expect((await harnessApp.call('GET', `/resources/document_version/${mine}`, { member: ADMIN, tenantId: TENANT_B })).status).toBe(404);
    });

    it('pages with an opaque cursor and refuses a malformed one', async () => {
      const first = await harnessApp.call('GET', '/resources/document_version?limit=2', { member: ADMIN });
      expect((first.json.items as unknown[]).length).toBe(2);
      expect(typeof first.json.next_cursor).toBe('string');
      const second = await harnessApp.call('GET', `/resources/document_version?limit=2&cursor=${String(first.json.next_cursor)}`, { member: ADMIN });
      const ids = [...(first.json.items as Array<{ id: string }>), ...(second.json.items as Array<{ id: string }>)].map((item) => item.id);
      expect(new Set(ids).size).toBe(ids.length);
      const bad = await harnessApp.call('GET', '/resources/document_version?cursor=%21%21', { member: ADMIN });
      expect([bad.status, bad.json.code]).toEqual([422, 'VALIDATION_FAILED']);
    });

    it('keeps a stored version immutable even for the application role', async () => {
      const versionId = await insertVersion(TENANT_A, undefined, 'CLEAN');
      await expect(
        harnessApp.harness.tenants.withTenant(ctx(TENANT_A), (tx) => tx.query("update machvon.document_version set checksum = repeat('b', 64) where id = $1", [versionId])),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('defineDocumentType', () => {
    const typeBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      code: 'QD',
      name: 'Decision',
      symbol_kind: 'DECISION',
      symbol_pattern: '{number}/{type}-{agency}',
      register_code: 'REG-QD',
      legal_basis: 'ND 30/2020',
      effective_from: '2026-01-01',
      ...overrides,
    });

    it('defines a type, audits it and refuses an overlapping period and a bad pattern', async () => {
      const reply = await harnessApp.call('POST', '/document-types', { member: ADMIN, body: typeBody() });
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ status: 'DEFINED', resource_version: 1 });
      expect(await harnessApp.count("select count(*) as n from machvon.audit_event where action = 'doc_type.define' and resource_id = $1", [reply.json.resource_id])).toBe(1);
      const overlap = await harnessApp.call('POST', '/document-types', { member: ADMIN, body: typeBody({ effective_from: '2025-06-01', effective_until: '2026-06-01' }) });
      expect([overlap.status, overlap.json.code]).toEqual([409, 'DOC_TYPE_RANGE_OVERLAP']);
      const bad = await harnessApp.call('POST', '/document-types', { member: ADMIN, body: typeBody({ code: 'BAD', symbol_pattern: '{number}a/{type}' }) });
      expect([bad.status, bad.json.code]).toEqual([409, 'SYMBOL_PATTERN_INVALID']);
      const shown = await harnessApp.call('GET', '/document-number-registers', { member: ADMIN });
      expect((shown.json.doc_types as Array<{ code: string }>).map((type) => type.code)).toContain('QD');
    });

    it('does not let a member without the permission define a type', async () => {
      const reply = await harnessApp.call('POST', '/document-types', { member: RENDERER_ONLY, body: typeBody({ code: 'XX' }) });
      expect([reply.status, reply.json.code]).toEqual([403, 'SCOPE_DENIED']);
    });
  });
});
