import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EffectiveAccessStore, InMemoryAuthzCache, PLATFORM_TENANT_ID, ThemeStore } from '@machvon/db';
import type { ThemeConfig } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { AppModule } from '../../src/app.module';
import { CLAIMS_HEADER, TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';
import { ProvisioningHarness } from '../provisioning/provisioning-fixtures';
import { assertStatus, expectCheckFails } from '../uat/uat-kit';
import type { Reply } from '../uat/uat-kit';

/**
 * UAT cases of the theme of a tenant on the control plane (SAS.md BR-SAS-17, FR-SAS-04): only a System Admin changes it, a review is the right of the moment and cannot be used for another
 * tenant, nor twice. The theme review code of the product is REVIEW_INVALID (error_codes.json lists REVIEW_TOKEN_INVALID as a retired spelling of it).
 */
const SIGNING_KEY = randomBytes(32);
const SA_01 = '00000000-0000-4000-8000-0000000000c9';
const TA_A = '00000000-0000-4000-8000-0000000000cb';

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

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('the theme of a tenant on the control plane (BR-SAS-17)', () => {
  const harness = new ProvisioningHarness();
  const store = new ThemeStore();
  const objectRoot = mkdtempSync(join(tmpdir(), 'machvon-sec-theme-'));
  let app: RunningApp;

  async function call(method: string, path: string, options: { roles?: string[]; audience?: string; payload?: unknown; raw?: { body: Buffer; contentType: string }; ifMatch?: string; admin?: string } = {}): Promise<Reply> {
    const token = signTenantContext({ tenantId: PLATFORM_TENANT_ID, membershipId: options.admin ?? SA_01, scopeVersion: 0 }, SIGNING_KEY);
    const headers: Record<string, string> = { [TENANT_HEADER]: token, [CLAIMS_HEADER]: JSON.stringify({ aud: options.audience ?? 'control', roles: options.roles ?? ['SystemAdmin'] }) };
    if (options.raw !== undefined) headers['content-type'] = options.raw.contentType;
    else if (method !== 'GET') headers['content-type'] = 'application/json';
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const body = options.raw !== undefined ? options.raw.body : method === 'GET' ? undefined : JSON.stringify(options.payload ?? {});
    const response = await fetch(`${app.baseUrl}${path}`, { method, headers, body });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  async function themedTenant(): Promise<string> {
    const created = await harness.request();
    await harness.registry.transition(created.tenantId, 'Requested', 'Provisioning');
    await harness.registry.transition(created.tenantId, 'Provisioning', 'Active');
    await harness.control.withTenantOf(PLATFORM_TENANT_ID, (tx) =>
      store.actingAs(tx, created.tenantId, PLATFORM_TENANT_ID, () => store.createInitialVersion(tx, { tenantId: created.tenantId, config: THEME_V1 as ThemeConfig, publishedBy: SA_01 })),
    );
    return created.tenantId;
  }

  const draftPath = (tenantId: string): string => `/system/tenants/${tenantId}/theme/draft`;
  const review = (tenantId: string, draftRevision: number, baseVersion: number, roles?: string[]): Promise<Reply> =>
    call('POST', `/system/tenants/${tenantId}/theme/reviews`, { payload: { draftRevision, baseVersion }, roles });
  const publish = (tenantId: string, reviewToken: string, baseVersion: number, roles?: string[]): Promise<Reply> =>
    call('POST', `/system/tenants/${tenantId}/theme/publish`, { payload: { reviewToken, baseVersion }, roles });
  const currentVersion = async (tenantId: string): Promise<number> =>
    Number((await harness.admin((client) => client.query<{ v: string }>('select current_version::text as v from machvon.tenant_theme_pointer where tenant_id = $1', [tenantId]))).rows[0]?.v);
  const draftRevisionOf = async (tenantId: string): Promise<number | undefined> => {
    const rows = await harness.admin((client) => client.query<{ r: string }>('select revision::text as r from machvon.tenant_theme_draft where tenant_id = $1', [tenantId]));
    return rows.rows[0] === undefined ? undefined : Number(rows.rows[0].r);
  };
  const assetCount = (tenantId: string): Promise<number> => harness.count('select count(*) as n from machvon.tenant_theme_asset where tenant_id = $1', [tenantId]);
  const deniedAudits = (action: string): Promise<number> =>
    harness.count("select count(*) as n from machvon.audit_event where tenant_id = $1 and outcome = 'DENIED' and action = $2", [PLATFORM_TENANT_ID, action]);

  /** Edits the draft, has it reviewed and publishes it as the next version; returns the review token that was used. */
  async function publishChange(tenantId: string, patch: Record<string, string | null>, revision: number, base: number): Promise<string> {
    assertStatus(await call('PUT', draftPath(tenantId), { payload: themeWith(patch), ifMatch: `"${revision - 1}"` }), 200);
    const reviewed = await review(tenantId, revision, base);
    assertStatus(reviewed, 200);
    const token = reviewed.json.reviewToken as string;
    assertStatus(await publish(tenantId, token, base), 200);
    return token;
  }

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

  it('SEC03: a System Admin whose right was withdrawn after the review is refused 403 at the publication, nothing is published, no other tenant changes, and the review does not carry the right', async () => {
    const a = await themedTenant();
    const b = await themedTenant();
    assertStatus(await call('PUT', draftPath(a), { payload: themeWith({ primary: '#112233' }), ifMatch: '"0"' }), 200);
    const reviewed = await review(a, 1, 1);
    assertStatus(reviewed, 200);
    const token = reviewed.json.reviewToken as string;

    const deniedBefore = await deniedAudits('authz.denied:publishSystemTenantTheme');
    const refused = await publish(a, token, 1, []);
    assertStatus(refused, 403, 'SCOPE_DENIED');
    expect(await currentVersion(a)).toBe(1);
    expect(await currentVersion(b)).toBe(1);
    expect(await deniedAudits('authz.denied:publishSystemTenantTheme')).toBe(deniedBefore + 1);
    expect(await harness.count("select count(*) as n from machvon.outbox_event where tenant_id = $1 and type = 'sas.theme.published.v1'", [a])).toBe(0);

    // The review itself was not spent by the refusal: with the right in force again the same publication goes through, so it was the right of the moment that decided.
    assertStatus(await publish(a, token, 1), 200);
    expect(await currentVersion(a)).toBe(2);
    expect(await currentVersion(b)).toBe(1);
  });

  it('the control plane theme is closed to the tenant plane, and a review of another tenant or one already spent publishes nothing: 403 SCOPE_DENIED for the four tenant calls, 409 REVIEW_INVALID for the two reviews, the theme stays at version 3', async () => {
    const a = await themedTenant();
    const b = await themedTenant();
    await publishChange(a, { primary: '#112233' }, 1, 1);
    // After a publication the draft starts again at revision 0.
    const spent = await publishChange(a, { primary: '#223344' }, 1, 2);
    expect(await currentVersion(a)).toBe(3);

    const draftBefore = await draftRevisionOf(a);
    // The tenant administrator ta.a holds a tenant token: the draft, the logo, the review and the publication are all refused.
    const tenantToken = { audience: 'tenant', roles: ['TENANT_ADMIN'], admin: TA_A };
    const png = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(56, 0x61)]);
    const boundary = `----sec${randomUUID().replaceAll('-', '')}`;
    const upload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="logo.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const refused = [
      await call('PUT', draftPath(a), { ...tenantToken, payload: themeWith({ title: 'Nope' }), ifMatch: '"0"' }),
      await call('POST', `/system/tenants/${a}/theme/assets`, { ...tenantToken, raw: { body: upload, contentType: `multipart/form-data; boundary=${boundary}` } }),
      await call('POST', `/system/tenants/${a}/theme/reviews`, { ...tenantToken, payload: { draftRevision: 1, baseVersion: 3 } }),
      await call('POST', `/system/tenants/${a}/theme/publish`, { ...tenantToken, payload: { reviewToken: 'x'.repeat(43), baseVersion: 3 } }),
    ];
    for (const reply of refused) assertStatus(reply, 403, 'SCOPE_DENIED');
    expect(await currentVersion(a)).toBe(3);
    expect(await draftRevisionOf(a)).toBe(draftBefore);
    expect(await assetCount(a)).toBe(0);

    // A review given for tenant B does not publish tenant A, and a review that was already spent does not publish again.
    assertStatus(await call('PUT', draftPath(b), { payload: themeWith({ primary: '#334455' }), ifMatch: '"0"' }), 200);
    const forB = await review(b, 1, 1);
    assertStatus(forB, 200);
    assertStatus(await publish(a, forB.json.reviewToken as string, 3), 409, 'REVIEW_INVALID');
    assertStatus(await publish(a, spent, 3), 409, 'REVIEW_INVALID');
    expect(await currentVersion(a)).toBe(3);
    expect(await currentVersion(b)).toBe(1);
  });

  it('the checks of this suite can go red: a check fed the wrong answer throws', () => {
    expectCheckFails(() => assertStatus({ status: 200, json: {} }, 403, 'SCOPE_DENIED'));
    expectCheckFails(() => assertStatus({ status: 409, json: { code: 'VERSION_CONFLICT' } }, 409, 'REVIEW_INVALID'));
  });
});
