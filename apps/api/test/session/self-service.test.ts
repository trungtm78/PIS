import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, UserSessionStore } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { IDENTITY_LOGOUT, SESSION_REVOCATION, SelfServiceController } from '../../src/session/self.controller';
import { UserSessionDenyList } from '../../src/session/user-session-deny-list';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { CLAIMS_HEADER, TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const ME = 1;
const OTHER = 2;
const NO_RIGHT = 3; // holds neither profile.self nor session.self
const OTHER_TENANT = 4;
const REASON = 'Tôi không còn dùng thiết bị này nữa.';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the profile, the sessions and the devices of a person over HTTP (ST-IAM-006)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let tenants: TenantDatabase;
  const revoked: string[] = [];
  const loggedOut: string[] = [];

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function call(method: 'GET' | 'POST' | 'PUT', url: string, options: { member?: number; tenantId?: string; sid?: string; body?: unknown; ifMatch?: string | null } = {}): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member ?? ME, options.tenantId), 'content-type': 'application/json', [CLAIMS_HEADER]: JSON.stringify({ sid: options.sid ?? 'unused' }) };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined && options.ifMatch !== null) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenantId = TENANT_A): Promise<R[]> => harness.owner<R>(tenantId, [[sql, params]]);

  async function session(member: number, options: { device?: string } = {}): Promise<{ id: string; idp: string }> {
    const id = randomUUID();
    const idp = `idp-${id}`;
    await rows(
      `insert into machvon.user_session (tenant_id, id, user_account_id, membership_id, idp_session_id, assurance_level, ip_hash, user_agent_summary, device_registration_id)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, (select user_id from machvon.membership where id = $2::uuid), $2::uuid, $3, 'aal1', repeat('a', 64), 'Firefox on Linux', $4::uuid)`,
      [id, memberId(member), idp, options.device ?? null],
    );
    return { id, idp };
  }
  async function device(member: number): Promise<string> {
    const id = randomUUID();
    await rows(
      `insert into machvon.device_registration (tenant_id, id, membership_id, device_public_id, push_secret_ref, platform, last_seen_at, token_fingerprint, app_version)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4, 'android', now(), repeat('b', 64), '1.0.0')`,
      [id, memberId(member), `dev-${id}`, `secret://push/${id}`],
    );
    return id;
  }
  const outbox = (id: string, type: string) => rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2', [id, type]);

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }]);
    for (const n of [ME, OTHER, NO_RIGHT]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, OTHER_TENANT, 1);
    await harness.seedRole(TENANT_A, 1, 'MEMBER', ['profile.self', 'session.self'], 5);
    await harness.seedRole(TENANT_A, 2, 'NOTHING', ['tenant.theme.read'], 5);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ME, role: 1, kind: 'TENANT' },
      { n: 2, member: OTHER, role: 1, kind: 'TENANT' },
      { n: 3, member: NO_RIGHT, role: 2, kind: 'TENANT' },
    ]);
    await harness.seedRole(TENANT_B, 1, 'MEMBER', ['profile.self', 'session.self'], 5);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT, role: 1, kind: 'TENANT' }]);
    tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [SelfServiceController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: SESSION_REVOCATION, useValue: { revoke: (id: string) => revoked.push(id) } },
        { provide: IDENTITY_LOGOUT, useValue: { logout: (idp: string) => Promise.resolve(void loggedOut.push(idp)) } },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 240_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('AC-ST-IAM-006-2, UAT-AC122: reads the profile masked, then updates it: no If-Match is 428, a stale one is 409 with what the profile says now, the right one is 200', async () => {
    await rows('update machvon.user_account set version = 4, phone_e164 = $2 where id = (select user_id from machvon.membership where id = $1)', [memberId(ME), '+84901234567']);
    const read = await call('GET', '/me/profile');
    expect(read).toMatchObject({ status: 200, json: { display_name: 'User 1', email_masked: 'u***@example.test', phone_masked: '*********567', locale: 'vi-VN', time_zone: 'Asia/Ho_Chi_Minh', version: 4 } });
    expect(JSON.stringify(read.json)).not.toContain('user1@example.test');
    const body = { display_name: 'Nguyễn Văn An', locale: 'en-US' };
    expect(await call('PUT', '/me/profile', { body, ifMatch: null })).toMatchObject({ status: 428 });
    const stale = await call('PUT', '/me/profile', { body, ifMatch: '"3"' });
    expect(stale).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    expect(JSON.stringify(stale.json)).toContain('User 1');
    expect((await rows<{ display_name: string }>('select display_name from machvon.user_account where id = (select user_id from machvon.membership where id = $1)', [memberId(ME)]))[0]?.display_name).toBe('User 1');
    const done = await call('PUT', '/me/profile', { body, ifMatch: '"4"' });
    expect(done).toMatchObject({ status: 200, json: { display_name: 'Nguyễn Văn An', locale: 'en-US', version: 5, phone_masked: '*********567' } });
    // The audit names the fields, never the name that was written.
    const audit = await rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where action = 'user.profile_updated' and resource_id = $1", [done.json.id]);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.safe_diff).toMatchObject({ fields: ['display_name', 'locale'], version: 5 });
    expect(JSON.stringify(audit[0]?.safe_diff)).not.toContain('Nguyễn');
  });

  it('refuses a profile that is not acceptable, naming the field, and a body that changes nothing', async () => {
    const version = String((await call('GET', '/me/profile')).json.version);
    const put = (body: Record<string, unknown>) => call('PUT', '/me/profile', { body, ifMatch: `"${version}"` });
    expect(await put({ display_name: 'A' })).toMatchObject({ status: 422, json: { detail: 'display_name' } });
    expect(await put({ time_zone: 'Mars/Olympus' })).toMatchObject({ status: 422, json: { detail: 'time_zone' } });
    expect(await put({ phone_e164: '0901234567' })).toMatchObject({ status: 422, json: { detail: 'phone_e164' } });
    expect(await put({ locale: 'fr-FR' })).toMatchObject({ status: 422, json: { detail: 'locale' } });
    expect(await put({})).toMatchObject({ status: 422, json: { detail: 'body' } });
    expect((await call('GET', '/me/profile')).json.version).toBe(Number(version));
  });

  it('AC-ST-IAM-006-1, UAT-AC120: S1 revokes S2: S2 is refused by the deny-list at once and from the database for any process, S1 is not, and the identity provider is told', async () => {
    const s1 = await session(ME);
    const s2 = await session(ME);
    const listed = await call('GET', '/me/sessions', { sid: s1.id });
    const items = listed.json.items as Array<{ id: string; current: boolean }>;
    expect(items.filter((item) => [s1.id, s2.id].includes(item.id)).map((item) => [item.id === s1.id ? 'S1' : 'S2', item.current]).sort()).toEqual([['S1', true], ['S2', false]]);
    expect(JSON.stringify(listed.json)).not.toContain('aaaaaaaa');
    expect(await call('POST', `/me/sessions/${s1.id}/revoke`, { sid: s1.id, body: { reason: REASON } })).toMatchObject({ status: 422, json: { code: 'SESSION_CURRENT' } });
    expect(await call('POST', `/me/sessions/${s2.id}/revoke`, { sid: s1.id, body: { reason: 'short' } })).toMatchObject({ status: 422, json: { detail: 'reason' } });
    const done = await call('POST', `/me/sessions/${s2.id}/revoke`, { sid: s1.id, body: { reason: REASON } });
    expect(done).toMatchObject({ status: 200, json: { status: 'REVOKED', resource_id: s2.id } });
    expect(revoked).toContain(s2.id);
    expect(revoked).not.toContain(s1.id);
    expect(loggedOut).toContain(s2.idp);
    // Another process, with nothing in memory, asks the database: S2 is refused, S1 is served.
    const fresh = new UserSessionDenyList(new UserSessionStore(tenants), { negativeTtlMs: 0 });
    expect(await fresh.isRevoked(s2.id, TENANT_A)).toBe(true);
    expect(await fresh.isRevoked(s1.id, TENANT_A)).toBe(false);
    expect((await call('GET', '/me/sessions', { sid: s1.id })).status).toBe(200);
    expect(((await call('GET', '/me/sessions', { sid: s1.id })).json.items as Array<{ id: string }>).map((item) => item.id)).not.toContain(s2.id);
    // The same again changes nothing: one revocation on the record, one event, and the repeat noted.
    expect(await call('POST', `/me/sessions/${s2.id}/revoke`, { sid: s1.id, body: { reason: REASON } })).toMatchObject({ status: 200 });
    expect(await rows("select id from machvon.audit_event where action = 'session.revoked' and resource_id = $1", [s2.id])).toHaveLength(1);
    expect(await rows("select id from machvon.audit_event where action = 'session.revoke_repeated' and resource_id = $1", [s2.id])).toHaveLength(1);
    expect(await outbox(s2.id, 'iam.session.revoked.v1')).toHaveLength(1);
    expect((await outbox(s2.id, 'iam.session.revoked.v1'))[0]?.payload).toMatchObject({ session_id: s2.id, membership_id: memberId(ME) });
  });

  it('does not reveal or revoke the sessions and devices of other people: another member\'s and another tenant\'s are not found', async () => {
    const theirs = await session(OTHER);
    const theirDevice = await device(OTHER);
    const mine = await session(ME);
    expect(await call('POST', `/me/sessions/${theirs.id}/revoke`, { sid: mine.id, body: { reason: REASON } })).toMatchObject({ status: 404 });
    expect(await call('POST', `/me/devices/${theirDevice}/revoke`, { sid: mine.id, body: { reason: REASON } })).toMatchObject({ status: 404 });
    expect(await call('POST', `/me/sessions/${mine.id}/revoke`, { member: OTHER_TENANT, tenantId: TENANT_B, sid: 'x', body: { reason: REASON } })).toMatchObject({ status: 404 });
    expect(await call('POST', `/me/sessions/${randomUUID()}/revoke`, { sid: mine.id, body: { reason: REASON } })).toMatchObject({ status: 404 });
    expect(await call('POST', '/me/sessions/not-a-uuid/revoke', { sid: mine.id, body: { reason: REASON } })).toMatchObject({ status: 422 });
    expect(revoked).not.toContain(theirs.id);
    expect(((await call('GET', '/me/devices')).json.items as Array<{ id: string }>).map((item) => item.id)).not.toContain(theirDevice);
    expect((await rows<{ revoked: boolean }>('select revoked_at is not null as revoked from machvon.user_session where id = $1', [theirs.id]))[0]?.revoked).toBe(false);
  });

  it('AC-ST-IAM-006-3, UAT-AC192: removes a device: one row, revoked, the push token gone, the sessions opened on it signed out, one event', async () => {
    const id = await device(ME);
    const onIt = await session(ME, { device: id });
    const current = await session(ME);
    const before = await call('GET', '/me/devices');
    expect((before.json.items as Array<{ id: string; status: string }>).find((item) => item.id === id)).toMatchObject({ status: 'ACTIVE', platform: 'android' });
    const done = await call('POST', `/me/devices/${id}/revoke`, { sid: current.id, body: { reason: REASON } });
    expect(done).toMatchObject({ status: 200, json: { status: 'REVOKED', resource_id: id } });
    expect(await rows<{ revoked: boolean; push_secret_ref: string | null }>('select revoked_at is not null as revoked, push_secret_ref from machvon.device_registration where id = $1', [id])).toEqual([{ revoked: true, push_secret_ref: null }]);
    expect(await rows('select id from machvon.device_registration where membership_id = $1 and id = $2', [memberId(ME), id])).toHaveLength(1);
    expect(revoked).toContain(onIt.id);
    expect(revoked).not.toContain(current.id);
    expect(loggedOut).toContain(onIt.idp);
    expect(((await call('GET', '/me/devices')).json.items as Array<{ id: string; status: string }>).find((item) => item.id === id)).toMatchObject({ status: 'REVOKED' });
    expect(await call('POST', `/me/devices/${id}/revoke`, { sid: current.id, body: { reason: REASON } })).toMatchObject({ status: 200 });
    expect(await outbox(id, 'iam.device.revoked.v1')).toHaveLength(1);
    expect((await outbox(id, 'iam.device.revoked.v1'))[0]?.payload).toMatchObject({ device_id: id, session_ids: [onIt.id] });
    expect(await rows("select id from machvon.audit_event where action = 'device.revoked' and resource_id = $1", [id])).toHaveLength(1);
  });

  it('signing out of a session that was opened on a device removes that device', async () => {
    const id = await device(ME);
    const onIt = await session(ME, { device: id });
    const current = await session(ME);
    expect(await call('POST', `/me/sessions/${onIt.id}/revoke`, { sid: current.id, body: { reason: REASON } })).toMatchObject({ status: 200 });
    expect(await rows<{ revoked: boolean; push_secret_ref: string | null }>('select revoked_at is not null as revoked, push_secret_ref from machvon.device_registration where id = $1', [id])).toEqual([{ revoked: true, push_secret_ref: null }]);
    expect(await outbox(id, 'iam.device.revoked.v1')).toHaveLength(1);
  });

  it('is for those who hold the right: without profile.self and session.self every one of them is refused', async () => {
    const id = await session(ME);
    for (const [method, url, body] of [
      ['GET', '/me/profile', undefined],
      ['PUT', '/me/profile', { display_name: 'Intruder' }],
      ['GET', '/me/sessions', undefined],
      ['GET', '/me/devices', undefined],
      ['POST', `/me/sessions/${id.id}/revoke`, { reason: REASON }],
      ['POST', `/me/devices/${randomUUID()}/revoke`, { reason: REASON }],
    ] as const) {
      expect([method, url, (await call(method, url, { member: NO_RIGHT, body, ifMatch: '"1"' })).status]).toEqual([method, url, 403]);
    }
    expect((await rows<{ revoked: boolean }>('select revoked_at is not null as revoked from machvon.user_session where id = $1', [id.id]))[0]?.revoked).toBe(false);
  });
});
