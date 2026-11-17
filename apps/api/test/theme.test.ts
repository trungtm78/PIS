import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EffectiveAccessStore, InMemoryAuthzCache, PLATFORM_TENANT_ID, ThemeStore, seedSystemRoles } from '@machvon/db';
import type { ThemeConfig } from '@machvon/db';
import { contrastRatio } from '@machvon/design-tokens';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { eicarBytes } from '../src/modules/files/mock-scan';
import { CONTROL_OPERATIONS, controlCasesFor } from './authz/control-matrix';
import { CLAIMS_HEADER, TENANT_HEADER } from './isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from './isolation/test-app';
import type { RunningApp } from './isolation/test-app';
import { ProvisioningHarness } from './provisioning/provisioning-fixtures';

const SIGNING_KEY = randomBytes(32);
const ADMIN_A = '00000000-0000-4000-8000-0000000000c9';
const ADMIN_B = '00000000-0000-4000-8000-0000000000ca';
const REASON = 'The new colours failed the accessibility audit.';

const THEME_V1: Record<string, string | null> = {
  name: 'Agency',
  title: 'Agency portal',
  subtitle: '',
  header: 'Agency',
  footer: '',
  address: '',
  email: '',
  phone: '',
  primary: '#0b5cad',
  primaryText: '#ffffff',
  menu: '#102a43',
  menuText: '#ffffff',
  selected: '#e6f0fa',
  selectedText: '#102a43',
  headerBg: '#ffffff',
  headerText: '#102a43',
  footerBg: '#f1f5f9',
  footerText: '#102a43',
  background: '#ffffff',
  titleColor: '#102a43',
  logoAssetId: null,
};
const themeWith = (patch: Record<string, string | null>): Record<string, string | null> => ({ ...THEME_V1, ...patch });

// The signature of a PNG file is all the upload policy asks of the bytes; the rest is padding.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngOf = (size: number): Buffer => Buffer.concat([PNG_SIGNATURE, Buffer.alloc(Math.max(0, size - PNG_SIGNATURE.length), 0x61)]);

interface Reply {
  status: number;
  headers: Headers;
  json: Record<string, unknown>;
  text: string;
}

function multipart(parts: Array<{ name: string; filename?: string; type?: string; body: Buffer | string }>): { body: Buffer; contentType: string } {
  const boundary = `----theme${randomUUID().replaceAll('-', '')}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition = `form-data; name="${part.name}"${part.filename === undefined ? '' : `; filename="${part.filename}"`}`;
    const head = `--${boundary}\r\nContent-Disposition: ${disposition}\r\n${part.type === undefined ? '' : `Content-Type: ${part.type}\r\n`}\r\n`;
    chunks.push(Buffer.from(head), Buffer.isBuffer(part.body) ? part.body : Buffer.from(part.body), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

describe('tenant themes over HTTP (ST-SAS-005)', () => {
  const harness = new ProvisioningHarness();
  const store = new ThemeStore();
  const objectRoot = mkdtempSync(join(tmpdir(), 'machvon-theme-'));
  let app: RunningApp;
  let counter = 0;

  async function call(
    method: string,
    path: string,
    options: { roles?: string[]; audience?: string; payload?: unknown; key?: string; ifMatch?: string; admin?: string; raw?: { body: Buffer; contentType: string } } = {},
  ): Promise<Reply> {
    const token = signTenantContext({ tenantId: PLATFORM_TENANT_ID, membershipId: options.admin ?? ADMIN_A, scopeVersion: 0 }, SIGNING_KEY);
    const headers: Record<string, string> = {
      [TENANT_HEADER]: token,
      // The second factor is fresh: publishing a theme is a step-up operation (x-step-up aal2).
      [CLAIMS_HEADER]: JSON.stringify({ aud: options.audience ?? 'control', roles: options.roles ?? ['SystemAdmin'], aal: 'aal2', aal2At: new Date().toISOString() }),
    };
    if (options.raw === undefined && method !== 'GET') headers['content-type'] = 'application/json';
    if (options.raw !== undefined) headers['content-type'] = options.raw.contentType;
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const body = options.raw !== undefined ? options.raw.body : method === 'GET' ? undefined : JSON.stringify(options.payload ?? {});
    const response = await fetch(`${app.baseUrl}${path}`, { method, headers, body });
    const text = await response.text();
    return { status: response.status, headers: response.headers, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>), text };
  }

  async function asMember(tenantId: string, membershipId: string, path: string, baseUrl: string = app.baseUrl): Promise<Reply> {
    const token = signTenantContext({ tenantId, membershipId, scopeVersion: 1 }, SIGNING_KEY);
    const response = await fetch(`${baseUrl}${path}`, { headers: { [TENANT_HEADER]: token, [CLAIMS_HEADER]: JSON.stringify({ aud: 'tenant' }) } });
    const text = await response.text();
    return { status: response.status, headers: response.headers, json: JSON.parse(text) as Record<string, unknown>, text };
  }

  /** A tenant with its first published theme, and one member who holds the seeded MEMBER role. */
  async function themedTenant(): Promise<{ tenantId: string; memberId: string }> {
    counter += 1;
    const created = await harness.request();
    const tenantId = created.tenantId;
    await harness.registry.transition(tenantId, 'Requested', 'Provisioning');
    await harness.registry.transition(tenantId, 'Provisioning', 'Active');
    await harness.control.withTenantOf(PLATFORM_TENANT_ID, (tx) =>
      store.actingAs(tx, tenantId, PLATFORM_TENANT_ID, () => store.createInitialVersion(tx, { tenantId, config: THEME_V1 as ThemeConfig, publishedBy: ADMIN_A })),
    );
    const memberId = `00000000-0000-4000-8000-${(0xa000 + counter).toString(16).padStart(12, '0')}`;
    await harness.tenants.withTenant({ tenantId, membershipId: memberId, scopeVersion: 1 }, (tx) => seedSystemRoles(tx, ADMIN_A));
    const owner = new Client({ connectionString: harness.database.urlFor('machvon_owner') });
    await owner.connect();
    try {
      await owner.query("select set_config('app.tenant_id', $1, false)", [tenantId]);
      const unitId = randomUUID();
      const userId = randomUUID();
      await owner.query("insert into machvon.organization_unit (tenant_id, id, code, name, valid_from, path, depth) values ($1, $2, 'U1', 'Unit 1', date '2026-01-01', '/u1/', 0)", [tenantId, unitId]);
      await owner.query("insert into machvon.user_account (id, idp_subject, email_normalized, display_name, status) values ($1, $2, $3, 'Member', 'Active')", [userId, `sub-${userId}`, `${userId}@example.test`]);
      await owner.query("insert into machvon.membership (tenant_id, id, user_id, organization_id, status, valid_from) values ($1, $2, $3, $4, 'Active', now())", [tenantId, memberId, userId, unitId]);
      const role = await owner.query<{ id: string }>("select id from machvon.role_definition where code = 'MEMBER'");
      await owner.query(
        `insert into machvon.role_grant (tenant_id, id, membership_id, role_id, scope_json, effective_from, scope_kind, scope_ref_ids, status, granted_by, grant_reason)
         values ($1, $2, $3, $4, '{"kind":"TENANT","ref_ids":[]}'::jsonb, '2026-01-01T00:00:00Z', 'TENANT', '{}', 'Active', $5, 'test')`,
        [tenantId, randomUUID(), memberId, role.rows[0]?.id, ADMIN_A],
      );
    } finally {
      await owner.end();
    }
    return { tenantId, memberId };
  }

  const draftPath = (tenantId: string): string => `/system/tenants/${tenantId}/theme/draft`;
  const putDraft = (tenantId: string, config: Record<string, unknown>, ifMatch: string, options: { roles?: string[]; audience?: string; key?: string } = {}): Promise<Reply> =>
    call('PUT', draftPath(tenantId), { ...options, payload: config, ifMatch });
  const requestReview = (tenantId: string, payload: Record<string, unknown>, options: { admin?: string } = {}): Promise<Reply> => call('POST', `/system/tenants/${tenantId}/theme/reviews`, { ...options, payload });
  const publish = (tenantId: string, token: string, baseVersion: number, options: { admin?: string; key?: string } = {}): Promise<Reply> =>
    call('POST', `/system/tenants/${tenantId}/theme/publish`, { ...options, payload: { reviewToken: token, baseVersion } });
  const upload = (tenantId: string, parts: Parameters<typeof multipart>[0], options: { key?: string; roles?: string[]; audience?: string } = {}): Promise<Reply> =>
    call('POST', `/system/tenants/${tenantId}/theme/assets`, { ...options, raw: multipart(parts) });

  /** Edits the draft and publishes it as the next version; returns the published version. */
  async function publishChange(tenantId: string, patch: Record<string, string | null>, base: number, revision: number): Promise<Reply> {
    expect((await putDraft(tenantId, themeWith(patch), `"${revision - 1}"`)).status).toBe(200);
    const reviewed = await requestReview(tenantId, { draftRevision: revision, baseVersion: base });
    expect(reviewed.status).toBe(200);
    return publish(tenantId, reviewed.json.reviewToken as string, base);
  }

  const versionCount = (tenantId: string): Promise<number> => harness.count('select count(*) as n from machvon.tenant_theme_version where tenant_id = $1', [tenantId]);
  const currentVersion = async (tenantId: string): Promise<number> =>
    Number((await harness.admin((client) => client.query<{ v: string }>('select current_version::text as v from machvon.tenant_theme_pointer where tenant_id = $1', [tenantId]))).rows[0]?.v);
  const draftRevision = async (tenantId: string): Promise<number | undefined> => {
    const rows = await harness.admin((client) => client.query<{ r: string }>('select revision::text as r from machvon.tenant_theme_draft where tenant_id = $1', [tenantId]));
    return rows.rows[0] === undefined ? undefined : Number(rows.rows[0].r);
  };
  const assetCount = (tenantId: string): Promise<number> => harness.count('select count(*) as n from machvon.tenant_theme_asset where tenant_id = $1', [tenantId]);
  const auditActions = async (tenantId: string): Promise<string[]> =>
    (await harness.admin((client) => client.query<{ action: string }>('select action from machvon.audit_event where tenant_id = $1 order by occurred_at, id', [tenantId]))).rows.map((row) => row.action);

  beforeAll(async () => {
    process.env.MACHVON_OBJECT_ROOT = objectRoot;
    await harness.start();
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        AppModule.register({
          database: harness.tenants,
          registry: loadErrorRegistry(ERROR_CODES_PATH),
          policy: { database: harness.tenants, access: new EffectiveAccessStore(harness.tenants, new InMemoryAuthzCache()) },
          control: { database: harness.control, registry: harness.registry },
        }),
      ],
    });
  }, 180_000);

  afterAll(async () => {
    delete process.env.MACHVON_OBJECT_ROOT;
    if (app) await app.close();
    await harness.stop();
    rmSync(objectRoot, { recursive: true, force: true });
  }, 60_000);

  describe('an application without a control plane', () => {
    let bare: RunningApp;

    beforeAll(async () => {
      bare = await startTestApp({
        signingKey: SIGNING_KEY,
        imports: [
          AppModule.register({
            database: harness.tenants,
            registry: loadErrorRegistry(ERROR_CODES_PATH),
            policy: { database: harness.tenants, access: new EffectiveAccessStore(harness.tenants, new InMemoryAuthzCache()) },
          }),
        ],
      });
    }, 60_000);

    afterAll(async () => {
      if (bare) await bare.close();
    });

    it('still serves the published theme to a member of the tenant, and nothing of the control plane', async () => {
      const { tenantId, memberId } = await themedTenant();
      const mine = await asMember(tenantId, memberId, '/me/tenant/theme', bare.baseUrl);
      expect([mine.status, mine.json.version]).toEqual([200, 1]);
      expect(bare.implementedOperations.has('getMyPublishedTheme')).toBe(true);
      expect(bare.implementedOperations.has('putSystemTenantThemeDraft')).toBe(false);
    });
  });

  describe('the draft', () => {
    it('is the published theme at revision 0 and carries its revision as the ETag', async () => {
      const { tenantId } = await themedTenant();
      const reply = await call('GET', draftPath(tenantId));
      expect(reply.status).toBe(200);
      expect(reply.json).toEqual({ revision: 0, config: THEME_V1 });
      expect(reply.headers.get('etag')).toBe('"0"');
    });

    it('persists for this tenant only and leaves the published theme and the members alone (TH01) (AC-ST-SAS-005-1)', async () => {
      const a = await themedTenant();
      const b = await themedTenant();
      const saved = await putDraft(a.tenantId, themeWith({ primary: '#112233', title: 'Draft title' }), '"0"');
      expect([saved.status, saved.json.revision, saved.headers.get('etag')]).toEqual([200, 1, '"1"']);
      expect((await call('GET', draftPath(a.tenantId))).json).toMatchObject({ revision: 1, config: { primary: '#112233', title: 'Draft title' } });
      expect((await call('GET', draftPath(b.tenantId))).json).toEqual({ revision: 0, config: THEME_V1 });
      expect(await currentVersion(a.tenantId)).toBe(1);
      const published = await asMember(a.tenantId, a.memberId, '/me/tenant/theme');
      expect(published.status).toBe(200);
      expect(published.json).toMatchObject({ tenantId: a.tenantId, version: 1, config: THEME_V1, sourceVersion: null });
      expect(await auditActions(a.tenantId)).toContain('tenant.theme_draft.saved');
    });

    it('refuses a pair at 3.2:1 with the contrast finding and stores nothing; 4.5:1 is accepted', async () => {
      const { tenantId } = await themedTenant();
      expect(contrastRatio('#8c8c8c', '#ffffff')).toBeGreaterThan(3);
      expect(contrastRatio('#8c8c8c', '#ffffff')).toBeLessThan(4.5);
      const weak = await putDraft(tenantId, themeWith({ primary: '#8c8c8c', primaryText: '#ffffff' }), '"0"');
      expect([weak.status, weak.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      expect(weak.json.findings).toEqual([expect.objectContaining({ code: 'CONTRAST', token: 'primaryText', against: 'primary' })]);
      expect(await draftRevision(tenantId)).toBeUndefined();
      expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThanOrEqual(4.5);
      expect((await putDraft(tenantId, themeWith({ primary: '#767676', primaryText: '#ffffff' }), '"0"')).status).toBe(200);
    });

    it('refuses a colour that is not hex, a value that could become CSS, and a contact email that is not one', async () => {
      const { tenantId } = await themedTenant();
      const patches: Array<Record<string, string>> = [{ primary: 'red' }, { primary: 'url(https://evil.example/x)' }, { menu: '#12345g' }, { email: 'not an email' }];
      for (const patch of patches) {
        const reply = await putDraft(tenantId, themeWith(patch), '"0"');
        expect([reply.status, reply.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      }
      expect(await draftRevision(tenantId)).toBeUndefined();
      expect((await putDraft(tenantId, { ...THEME_V1, extra: 'x' }, '"0"')).json.code).toBe('FIELD_NOT_ALLOWED');
      expect((await putDraft(tenantId, themeWith({ email: 'office@agency.example' }), '"0"')).status).toBe(200);
    });

    it('needs the revision it was read at: a stale one is VERSION_CONFLICT, a missing one PRECONDITION_REQUIRED', async () => {
      const { tenantId } = await themedTenant();
      expect((await putDraft(tenantId, themeWith({ title: 'One' }), '"0"')).status).toBe(200);
      const stale = await putDraft(tenantId, themeWith({ title: 'Two' }), '"0"');
      expect([stale.status, stale.json.code, stale.json.current_version]).toEqual([409, 'VERSION_CONFLICT', 1]);
      const missing = await call('PUT', draftPath(tenantId), { payload: themeWith({ title: 'Three' }) });
      expect([missing.status, missing.json.code]).toEqual([428, 'PRECONDITION_REQUIRED']);
      expect((await call('GET', draftPath(tenantId))).json).toMatchObject({ revision: 1, config: { title: 'One' } });
    });

    it('replays the same key and body and answers a different body under the same key with IDEMPOTENCY_CONFLICT', async () => {
      const { tenantId } = await themedTenant();
      const key = `key-${randomUUID()}`;
      const first = await putDraft(tenantId, themeWith({ title: 'Once' }), '"0"', { key });
      const again = await putDraft(tenantId, themeWith({ title: 'Once' }), '"0"', { key });
      expect([first.status, again.status, again.headers.get('idempotency-replayed')]).toEqual([200, 200, 'true']);
      expect(again.json).toEqual(first.json);
      // The replay carries the revision ETag too: the next If-Match of the editor is built from it.
      expect([first.headers.get('etag'), again.headers.get('etag')]).toEqual(['"1"', '"1"']);
      expect((await putDraft(tenantId, themeWith({ title: 'Other' }), '"0"', { key })).json.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(await draftRevision(tenantId)).toBe(1);
    });

    it('answers 404 for a tenant that does not exist, in the same way for a read and a write', async () => {
      const unknown = '00000000-0000-4000-8000-0000000000ee';
      expect((await call('GET', draftPath(unknown))).status).toBe(404);
      expect((await putDraft(unknown, THEME_V1, '"0"')).status).toBe(404);
      expect((await requestReview(unknown, { draftRevision: 1, baseVersion: 1 })).status).toBe(404);
    });
  });

  describe('review and publish', () => {
    it('publishes the reviewed draft as version 2, moves the pointer, audits it and emits the event without the token (TH02) (AC-ST-SAS-005-2)', async () => {
      const a = await themedTenant();
      expect((await putDraft(a.tenantId, themeWith({ primary: '#112233' }), '"0"')).status).toBe(200);
      const reviewed = await requestReview(a.tenantId, { draftRevision: 1, baseVersion: 1 });
      expect(reviewed.status).toBe(200);
      expect(reviewed.json).toMatchObject({ baseVersion: 1, candidate: themeWith({ primary: '#112233' }), changes: [{ field: 'primary', before: '#0b5cad', after: '#112233' }] });
      const token = reviewed.json.reviewToken as string;
      expect(token.length).toBeGreaterThanOrEqual(32);
      // Nothing is published by a review.
      expect(await currentVersion(a.tenantId)).toBe(1);
      const published = await publish(a.tenantId, token, 1);
      expect(published.status).toBe(200);
      expect(published.json).toMatchObject({ tenantId: a.tenantId, version: 2, sourceVersion: null, config: themeWith({ primary: '#112233' }) });
      expect(await currentVersion(a.tenantId)).toBe(2);
      expect((await asMember(a.tenantId, a.memberId, '/me/tenant/theme')).json).toMatchObject({ version: 2, config: { primary: '#112233' } });
      expect(await auditActions(a.tenantId)).toEqual(expect.arrayContaining(['tenant.theme_draft.saved', 'tenant.theme.reviewed', 'tenant.theme.published']));
      const events = await harness.admin((client) => client.query<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where tenant_id = $1 and type = 'sas.theme.published.v1'", [a.tenantId]));
      expect(events.rows).toHaveLength(1);
      expect(events.rows[0]?.payload).toMatchObject({ tenant_id: a.tenantId, version: 2, config_hash: published.json.hash, source_version: null });
      const stored = await harness.admin((client) => client.query('select safe_diff::text as d from machvon.audit_event where tenant_id = $1', [a.tenantId]));
      expect(JSON.stringify([stored.rows, events.rows])).not.toContain(token);
    });

    it('rejects a review used twice, expired, issued to another person or to another tenant, or never issued, and creates no version (SEC04) (AC-ST-SAS-005-9)', async () => {
      const a = await themedTenant();
      const b = await themedTenant();
      expect((await putDraft(a.tenantId, themeWith({ primary: '#112233' }), '"0"')).status).toBe(200);
      const reviewed = await requestReview(a.tenantId, { draftRevision: 1, baseVersion: 1 });
      const token = reviewed.json.reviewToken as string;
      const foreignActor = await publish(a.tenantId, token, 1, { admin: ADMIN_B });
      expect([foreignActor.status, foreignActor.json.code]).toEqual([409, 'REVIEW_INVALID']);
      expect(foreignActor.text).not.toContain(ADMIN_A);
      expect(foreignActor.text).not.toContain(ADMIN_B);
      expect((await publish(b.tenantId, token, 1)).json.code).toBe('REVIEW_INVALID');
      expect((await publish(a.tenantId, 'x'.repeat(43), 1)).json.code).toBe('REVIEW_INVALID');
      await harness.admin((client) => client.query("update machvon.tenant_theme_review set expires_at = now() - interval '1 second' where tenant_id = $1", [a.tenantId]));
      const expired = await publish(a.tenantId, token, 1);
      expect([expired.status, expired.json.code]).toEqual([409, 'REVIEW_INVALID']);
      expect(await versionCount(a.tenantId)).toBe(1);
      expect(await versionCount(b.tenantId)).toBe(1);

      expect((await putDraft(a.tenantId, themeWith({ primary: '#223344' }), '"1"')).status).toBe(200);
      const fresh = await requestReview(a.tenantId, { draftRevision: 2, baseVersion: 1 });
      expect((await publish(a.tenantId, fresh.json.reviewToken as string, 1)).status).toBe(200);
      const reused = await publish(a.tenantId, fresh.json.reviewToken as string, 2);
      expect([reused.status, reused.json.code]).toEqual([409, 'REVIEW_INVALID']);
      expect(await versionCount(a.tenantId)).toBe(2);
    });

    it('rejects a review whose draft was edited afterwards', async () => {
      const { tenantId } = await themedTenant();
      expect((await putDraft(tenantId, themeWith({ primary: '#112233' }), '"0"')).status).toBe(200);
      const reviewed = await requestReview(tenantId, { draftRevision: 1, baseVersion: 1 });
      expect((await putDraft(tenantId, themeWith({ primary: '#999999', primaryText: '#000000' }), '"1"')).status).toBe(200);
      const late = await publish(tenantId, reviewed.json.reviewToken as string, 1);
      expect([late.status, late.json.code]).toEqual([409, 'REVIEW_INVALID']);
      expect(await currentVersion(tenantId)).toBe(1);
    });

    it('answers VERSION_CONFLICT for a base version that is not the published one, and REVIEW_INVALID for the expired review (UAT-AC175, AC-ST-SAS-005-6)', async () => {
      const { tenantId } = await themedTenant();
      expect((await putDraft(tenantId, themeWith({ primary: '#112233' }), '"0"')).status).toBe(200);
      const stale = await requestReview(tenantId, { draftRevision: 1, baseVersion: 5 });
      expect([stale.status, stale.json.code, stale.json.current_version]).toEqual([409, 'VERSION_CONFLICT', 1]);
      const reviewed = await requestReview(tenantId, { draftRevision: 1, baseVersion: 1 });
      const conflict = await publish(tenantId, reviewed.json.reviewToken as string, 3);
      expect([conflict.status, conflict.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      expect(await currentVersion(tenantId)).toBe(1);
    });

    it('lets one of two publishers on the same base win; the other must review again (TH03) (AC-ST-SAS-005-3)', async () => {
      const { tenantId } = await themedTenant();
      expect((await putDraft(tenantId, themeWith({ primary: '#112233' }), '"0"')).status).toBe(200);
      const first = await requestReview(tenantId, { draftRevision: 1, baseVersion: 1 });
      const second = await requestReview(tenantId, { draftRevision: 1, baseVersion: 1 }, { admin: ADMIN_B });
      const replies = await Promise.all([publish(tenantId, first.json.reviewToken as string, 1), publish(tenantId, second.json.reviewToken as string, 1, { admin: ADMIN_B })]);
      expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
      expect(replies.find((reply) => reply.status === 409)?.json.code).toBe('VERSION_CONFLICT');
      expect(await versionCount(tenantId)).toBe(2);
      expect(await currentVersion(tenantId)).toBe(2);
    });

    it('refuses to review a draft revision that does not exist (VERSION_CONFLICT) and audits nothing', async () => {
      const { tenantId } = await themedTenant();
      const reply = await requestReview(tenantId, { draftRevision: 1, baseVersion: 1 });
      expect([reply.status, reply.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      expect(await auditActions(tenantId)).not.toContain('tenant.theme.reviewed');
    });

    it('restores an old version as a new one and keeps the versions in between (TH02 rollback) (AC-ST-SAS-005-2)', async () => {
      const { tenantId, memberId } = await themedTenant();
      const second = await publishChange(tenantId, { primary: '#112233' }, 1, 1);
      expect(second.status).toBe(200);
      const short = await requestReview(tenantId, { sourceVersion: 1, baseVersion: 2, reason: 'too short' });
      expect([short.status, short.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const unknown = await requestReview(tenantId, { sourceVersion: 9, baseVersion: 2, reason: REASON });
      expect(unknown.status).toBe(404);
      const reviewed = await requestReview(tenantId, { sourceVersion: 1, baseVersion: 2, reason: REASON });
      expect(reviewed.json).toMatchObject({ candidate: THEME_V1, changes: [{ field: 'primary', before: '#112233', after: '#0b5cad' }] });
      const restored = await publish(tenantId, reviewed.json.reviewToken as string, 2);
      expect(restored.json).toMatchObject({ version: 3, sourceVersion: 1, config: THEME_V1 });
      const versions = (await call('GET', `/system/tenants/${tenantId}/theme/versions`)).json.items as Array<{ version: number; hash: string }>;
      expect(versions.map((item) => item.version)).toEqual([3, 2, 1]);
      expect(versions[0]?.hash).toBe(versions[2]?.hash);
      expect(versions[0]?.hash).not.toBe(versions[1]?.hash);
      expect(await versionCount(tenantId)).toBe(3);
      expect((await asMember(tenantId, memberId, '/me/tenant/theme')).json).toMatchObject({ version: 3, config: { primary: '#0b5cad' } });
      const stored = await harness.admin((client) => client.query<{ reason: string | null }>('select reason from machvon.tenant_theme_version where tenant_id = $1 and version = 3', [tenantId]));
      expect(stored.rows[0]?.reason).toBe(REASON);
    });

    it('lists versions newest first, pages with an opaque cursor, and refuses a cursor of another tenant', async () => {
      const a = await themedTenant();
      const b = await themedTenant();
      expect((await publishChange(a.tenantId, { primary: '#112233' }, 1, 1)).status).toBe(200);
      // Publishing cleared the draft, so the next edit starts again at draft revision 1.
      expect((await publishChange(a.tenantId, { primary: '#223344' }, 2, 1)).status).toBe(200);
      const first = await call('GET', `/system/tenants/${a.tenantId}/theme/versions?limit=2`);
      expect((first.json.items as Array<{ version: number }>).map((item) => item.version)).toEqual([3, 2]);
      const cursor = first.json.nextCursor as string;
      expect(typeof cursor).toBe('string');
      const next = await call('GET', `/system/tenants/${a.tenantId}/theme/versions?limit=2&cursor=${cursor}`);
      expect((next.json.items as Array<{ version: number }>).map((item) => item.version)).toEqual([1]);
      expect(next.json.nextCursor).toBeNull();
      expect((await call('GET', `/system/tenants/${b.tenantId}/theme/versions?cursor=${cursor}`)).status).toBe(422);
      expect((await call('GET', `/system/tenants/${a.tenantId}/theme/versions?limit=0`)).status).toBe(422);
    });
  });

  describe('who may call it (SEC02)', () => {
    const operations = CONTROL_OPERATIONS.filter((operation) => operation.path.includes('/theme/'));

    it('lists the six system theme operations of the matrix', () => {
      expect(operations.map((operation) => operation.operationId).sort()).toEqual([
        'getSystemTenantThemeDraft',
        'listSystemTenantThemeVersions',
        'publishSystemTenantTheme',
        'putSystemTenantThemeDraft',
        'reviewSystemTenantTheme',
        'uploadSystemTenantThemeAsset',
      ]);
    });

    const cases = controlCasesFor(operations);
    it.each(cases.map((matrixCase) => [matrixCase.id, matrixCase] as const))('%s', async (_id, matrixCase) => {
      const operation = operations.find((candidate) => candidate.operationId === matrixCase.operationId);
      if (operation === undefined) throw new Error('operation of the case is not listed');
      const { tenantId } = await themedTenant();
      const path = operation.path.replace('{tenantId}', tenantId);
      const roles = [matrixCase.role];
      const deniedBefore = await harness.count("select count(*) as n from machvon.audit_event where tenant_id = $1 and outcome = 'DENIED' and action = $2", [PLATFORM_TENANT_ID, `authz.denied:${operation.operationId}`]);
      let reply: Reply;
      if (operation.operationId === 'putSystemTenantThemeDraft') reply = await call('PUT', path, { roles, payload: themeWith({ title: 'Matrix' }), ifMatch: '"0"' });
      else if (operation.operationId === 'reviewSystemTenantTheme') reply = await call('POST', path, { roles, payload: { draftRevision: 1, baseVersion: 1 } });
      else if (operation.operationId === 'publishSystemTenantTheme') reply = await call('POST', path, { roles, payload: { reviewToken: 'x'.repeat(43), baseVersion: 1 } });
      else if (operation.operationId === 'uploadSystemTenantThemeAsset') reply = await upload(tenantId, [{ name: 'file', filename: 'logo.png', type: 'image/png', body: pngOf(64) }], { roles });
      else reply = await call('GET', path, { roles });
      if (matrixCase.expected === 'allow') {
        // Allowed by permission: the request got through the guard (what it then answers is the business of the other tests).
        expect(reply.status).not.toBe(403);
        return;
      }
      expect([reply.status, reply.json.code]).toEqual([403, 'SCOPE_DENIED']);
      if (operation.method !== 'GET') {
        expect(await harness.count("select count(*) as n from machvon.audit_event where tenant_id = $1 and outcome = 'DENIED' and action = $2", [PLATFORM_TENANT_ID, `authz.denied:${operation.operationId}`])).toBe(deniedBefore + 1);
      }
      expect(await currentVersion(tenantId)).toBe(1);
      expect(await draftRevision(tenantId)).toBeUndefined();
      expect(await assetCount(tenantId)).toBe(0);
    });

    it('refuses a tenant token even when its roles name SystemAdmin, for all seven theme operations, and changes nothing (AC-ST-SAS-005-5)', async () => {
      const { tenantId, memberId } = await themedTenant();
      const tenantToken = { audience: 'tenant', roles: ['SystemAdmin', 'TENANT_ADMIN'] };
      const replies = [
        await call('GET', draftPath(tenantId), tenantToken),
        await putDraft(tenantId, themeWith({ title: 'Nope' }), '"0"', tenantToken),
        await call('GET', `/system/tenants/${tenantId}/theme/versions`, tenantToken),
        await call('POST', `/system/tenants/${tenantId}/theme/reviews`, { ...tenantToken, payload: { draftRevision: 1, baseVersion: 1 } }),
        await call('POST', `/system/tenants/${tenantId}/theme/publish`, { ...tenantToken, payload: { reviewToken: 'x'.repeat(43), baseVersion: 1 } }),
        await upload(tenantId, [{ name: 'file', filename: 'logo.png', type: 'image/png', body: pngOf(64) }], tenantToken),
      ];
      expect(replies.map((reply) => [reply.status, reply.json.code])).toEqual(replies.map(() => [403, 'SCOPE_DENIED']));
      // A tenant member reads the published theme of the own tenant (the seventh operation) and nothing of the control plane.
      expect((await asMember(tenantId, memberId, '/me/tenant/theme')).status).toBe(200);
      expect(await currentVersion(tenantId)).toBe(1);
      expect(await draftRevision(tenantId)).toBeUndefined();
      expect(await assetCount(tenantId)).toBe(0);
    });

    it('shows each member only the published theme of the tenant of the token, never a draft', async () => {
      const a = await themedTenant();
      const b = await themedTenant();
      expect((await publishChange(a.tenantId, { title: 'Theme of A' }, 1, 1)).status).toBe(200);
      expect((await putDraft(b.tenantId, themeWith({ title: 'Draft of B' }), '"0"')).status).toBe(200);
      const seenByA = await asMember(a.tenantId, a.memberId, '/me/tenant/theme');
      const seenByB = await asMember(b.tenantId, b.memberId, '/me/tenant/theme');
      expect(seenByA.json).toMatchObject({ tenantId: a.tenantId, version: 2, config: { title: 'Theme of A' } });
      expect(seenByB.json).toMatchObject({ tenantId: b.tenantId, version: 1, config: { title: 'Agency portal' } });
      expect(seenByA.text).not.toContain(b.tenantId);
      expect(seenByB.text).not.toContain('Draft of B');
      // A member of tenant A with the token of tenant A cannot name tenant B at all: the tenant comes from the token.
      expect((await asMember(a.tenantId, b.memberId, '/me/tenant/theme')).status).toBe(403);
    });
  });

  describe('logo upload', () => {
    const png = (name = 'logo.png'): Parameters<typeof multipart>[0] => [{ name: 'file', filename: name, type: 'image/png', body: pngOf(2048) }];

    it('stores a PNG privately as clean, returns the asset, and the draft may use it (and no other tenant may)', async () => {
      const a = await themedTenant();
      const b = await themedTenant();
      const uploaded = await upload(a.tenantId, png());
      expect(uploaded.status).toBe(200);
      expect(uploaded.json).toMatchObject({ scanStatus: 'clean', contentType: 'image/png' });
      expect(uploaded.json.contentHash).toMatch(/^[a-f0-9]{64}$/);
      const assetId = uploaded.json.assetId as string;
      const row = await harness.admin((client) => client.query('select mime, size_bytes::int as size, scan_status, storage_key from machvon.tenant_theme_asset where tenant_id = $1 and id = $2', [a.tenantId, assetId]));
      expect(row.rows[0]).toMatchObject({ mime: 'image/png', size: 2048, scan_status: 'clean' });
      expect(row.rows[0].storage_key).toContain(a.tenantId);
      expect((await putDraft(a.tenantId, themeWith({ logoAssetId: assetId }), '"0"')).status).toBe(200);
      const foreign = await putDraft(b.tenantId, themeWith({ logoAssetId: assetId }), '"0"');
      expect([foreign.status, foreign.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const missing = await putDraft(b.tenantId, themeWith({ logoAssetId: randomUUID() }), '"0"');
      expect(missing.status).toBe(422);
      expect(await auditActions(a.tenantId)).toContain('tenant.theme_asset.uploaded');
    });

    it('refuses an SVG renamed png, a 1.5 MB image, a renamed executable and a declared SVG, and keeps no asset (TH04) (AC-ST-SAS-005-4)', async () => {
      const { tenantId } = await themedTenant();
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
      const executable = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(512, 0x90)]);
      const cases: Array<[string, Parameters<typeof multipart>[0], number, string]> = [
        ['svg renamed png', [{ name: 'file', filename: 'logo.png', type: 'image/png', body: svg }], 422, 'FILE_TYPE_NOT_ALLOWED'],
        ['svg declared', [{ name: 'file', filename: 'logo.svg', type: 'image/svg+xml', body: svg }], 422, 'FILE_TYPE_NOT_ALLOWED'],
        ['executable renamed png', [{ name: 'file', filename: 'logo.png', type: 'image/png', body: executable }], 422, 'FILE_TYPE_NOT_ALLOWED'],
        ['executable declared', [{ name: 'file', filename: 'logo.exe', type: 'application/x-msdownload', body: executable }], 422, 'FILE_TYPE_NOT_ALLOWED'],
        ['no declared type', [{ name: 'file', filename: 'logo.png', body: pngOf(512) }], 422, 'FILE_TYPE_NOT_ALLOWED'],
        ['1.5 MB image', [{ name: 'file', filename: 'big.png', type: 'image/png', body: pngOf(1_500_000) }], 413, 'PAYLOAD_TOO_LARGE'],
        ['one byte over 1 MiB', [{ name: 'file', filename: 'big.png', type: 'image/png', body: pngOf(1_048_577) }], 413, 'PAYLOAD_TOO_LARGE'],
        ['infected', [{ name: 'file', filename: 'logo.png', type: 'image/png', body: Buffer.concat([PNG_SIGNATURE, Buffer.from(eicarBytes())]) }], 422, 'FILE_NOT_CLEAN'],
      ];
      for (const [name, parts, status, code] of cases) {
        const reply = await upload(tenantId, parts);
        expect({ name, status: reply.status, code: reply.json.code }).toEqual({ name, status, code });
      }
      expect(await assetCount(tenantId)).toBe(0);
      expect(await upload(tenantId, [{ name: 'file', filename: 'edge.png', type: 'image/png', body: pngOf(1_048_576) }])).toMatchObject({ status: 200 });
    });

    it('refuses a request that is not exactly one file named file', async () => {
      const { tenantId } = await themedTenant();
      const reply = (parts: Parameters<typeof multipart>[0]): Promise<Reply> => upload(tenantId, parts);
      expect((await reply([])).json.code).toBe('INVALID_REQUEST');
      expect((await reply([{ name: 'other', filename: 'logo.png', type: 'image/png', body: pngOf(64) }])).json.code).toBe('INVALID_REQUEST');
      expect((await reply([{ name: 'file', type: 'image/png', body: pngOf(64) }])).json.code).toBe('INVALID_REQUEST');
      expect((await reply([...png(), ...png('second.png')])).json.code).toBe('INVALID_REQUEST');
      expect((await reply([...png(), { name: 'note', body: 'hello' }])).json.code).toBe('INVALID_REQUEST');
      const json = await call('POST', `/system/tenants/${tenantId}/theme/assets`, { payload: {} });
      expect([json.status, json.json.code]).toEqual([400, 'INVALID_REQUEST']);
      expect(await assetCount(tenantId)).toBe(0);
    });

    it('treats the same key with the same file as one upload and with another file as IDEMPOTENCY_CONFLICT', async () => {
      const { tenantId } = await themedTenant();
      const key = `key-${randomUUID()}`;
      const first = await upload(tenantId, png(), { key });
      const again = await upload(tenantId, png('renamed-later.png'), { key });
      expect([first.status, again.status, again.headers.get('idempotency-replayed')]).toEqual([200, 200, 'true']);
      expect(again.json.assetId).toBe(first.json.assetId);
      expect((await upload(tenantId, [{ name: 'file', filename: 'logo.png', type: 'image/png', body: pngOf(4096) }], { key })).json.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(await assetCount(tenantId)).toBe(1);
    });

    it('answers 404 for a tenant that does not exist', async () => {
      expect((await upload('00000000-0000-4000-8000-0000000000ee', png())).status).toBe(404);
    });

    it('gives a member the logo of the published theme of their own tenant as base64, never the logo of a draft or of another tenant (getMyThemeLogo)', async () => {
      const a = await themedTenant();
      const b = await themedTenant();
      // The first version has no logo.
      expect((await asMember(a.tenantId, a.memberId, '/me/tenant/theme/logo')).status).toBe(404);
      const uploaded = await upload(a.tenantId, png());
      const assetId = uploaded.json.assetId as string;
      // A draft that names the logo is not the theme in force: still nothing to read.
      expect((await putDraft(a.tenantId, themeWith({ logoAssetId: assetId }), '"0"')).status).toBe(200);
      expect((await asMember(a.tenantId, a.memberId, '/me/tenant/theme/logo')).status).toBe(404);
      // Published (reviewed by another administrator): the member reads exactly the bytes that were uploaded.
      expect((await publishChange(a.tenantId, { logoAssetId: assetId }, 1, 2)).status).toBe(200);
      const logo = await asMember(a.tenantId, a.memberId, '/me/tenant/theme/logo');
      expect(logo.status).toBe(200);
      expect(logo.json).toMatchObject({ content_hash: uploaded.json.contentHash, mime: 'image/png' });
      expect(Buffer.from(String(logo.json.content_base64), 'base64').equals(pngOf(2048))).toBe(true);
      // Another tenant has no logo, and its member cannot read the logo of A with a token of A.
      expect((await asMember(b.tenantId, b.memberId, '/me/tenant/theme/logo')).status).toBe(404);
      expect((await asMember(a.tenantId, b.memberId, '/me/tenant/theme/logo')).status).toBe(403);
    });
  });
});
