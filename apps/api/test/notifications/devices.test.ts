import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { DeviceRegistrationsController } from '../../src/notifications/devices/devices.controller';
import { InMemoryPushTokenVault, PUSH_TOKEN_VAULT } from '../../src/notifications/devices/push-vault';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { IDENTITY_LOGOUT, SESSION_REVOCATION, SelfServiceController } from '../../src/session/self.controller';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { CLAIMS_HEADER, TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const OWNER = 1; // notification.self: registers their own devices
const OTHER = 2; // the same, another person
const OPERATOR = 3; // device_registration.read on the whole tenant
const SUBTREE = 4; // the same, on one unit
const NOBODY = 5;
const OTHER_TENANT_MEMBER = 1; // of tenant B
const REASON = 'The phone was lost on the way to the site.';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the push devices of the members (ST-NOT-006, NOT-14)', () => {
  const harness = new AuthzHarness();
  const vault = new InMemoryPushTokenVault();
  let app: RunningApp;
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  const rows = <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

  async function call(method: 'GET' | 'POST', url: string, options: { member?: number; tenantId?: string; body?: unknown; key?: string; sid?: string } = {}): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member ?? OWNER, options.tenantId), 'content-type': 'application/json' };
    if (options.sid !== undefined) headers[CLAIMS_HEADER] = JSON.stringify({ sid: options.sid });
    if (method === 'POST') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, ...(method === 'POST' ? { body: JSON.stringify(options.body ?? {}) } : {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const publicId = (): string => `device-public-${(counter += 1).toString().padStart(4, '0')}-${randomUUID().slice(0, 8)}`;
  const registration = (overrides: Record<string, unknown> = {}) => ({
    device_public_id: publicId(),
    platform: 'android',
    push_token: `fcm-token-${randomUUID()}`,
    permission_state: 'granted',
    app_version: '1.4.2',
    ...overrides,
  });
  const register = (body: Record<string, unknown>, member = OWNER, tenantId = TENANT_A, key?: string, sid?: string) => call('POST', '/devices', { member, tenantId, body, ...(key === undefined ? {} : { key }), ...(sid === undefined ? {} : { sid }) });
  const live = (membership: number, devicePublicId: string) =>
    rows<{ id: string; push_secret_ref: string | null; token_fingerprint: string; permission_state: string; app_version: string; revoked_at: Date | null; revoke_reason: string | null }>(
      'select id, push_secret_ref, token_fingerprint, permission_state, app_version, revoked_at, revoke_reason from machvon.device_registration where membership_id = $1 and device_public_id = $2 order by last_seen_at',
      [memberId(membership), devicePublicId],
    );

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }, { n: 2, path: `/${unitId(1)}/${unitId(2)}/`, parent: 1 }]);
    for (const [member, unit] of [[OWNER, 1], [OTHER, 1], [OPERATOR, 1], [SUBTREE, 2], [NOBODY, 1]] as const) await harness.seedMembership(TENANT_A, member, unit, { validFrom: '2026-01-01T00:00:00Z' });
    await harness.seedMembership(TENANT_B, OTHER_TENANT_MEMBER, 1, { validFrom: '2026-01-01T00:00:00Z' });
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedRole(tenant, 1, 'MEMBER_SELF', ['notification.self', 'session.self'], 5);
      await harness.seedRole(tenant, 2, 'DEVICE_READER', ['device_registration.read'], 50);
    }
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: OWNER, role: 1, kind: 'TENANT' },
      { n: 2, member: OTHER, role: 1, kind: 'TENANT' },
      { n: 3, member: OPERATOR, role: 2, kind: 'TENANT' },
      { n: 4, member: SUBTREE, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT_MEMBER, role: 2, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [DeviceRegistrationsController, SelfServiceController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: PUSH_TOKEN_VAULT, useValue: vault },
        { provide: SESSION_REVOCATION, useValue: { revoke: () => undefined } },
        { provide: IDENTITY_LOGOUT, useValue: { logout: async () => undefined } },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await harness.stop();
  }, 60_000);

  describe('registering a device (NOT-14, MOB-05)', () => {
    it('AC-ST-NOT-006-1 UAT-AC192: a device that registers twice is one registration, and after the member removes it the registration is revoked and its token is gone from the vault', async () => {
      const body = registration();
      const first = await register(body);
      expect(first.status).toBe(201);
      expect(first.json).toMatchObject({ status: 'REGISTERED' });
      const second = await register({ ...body, push_token: `fcm-token-rotated-${randomUUID()}`, app_version: '1.5.0', permission_state: 'provisional' });
      expect(second.status).toBe(201);
      expect(second.json).toMatchObject({ status: 'UPDATED', resource_id: first.json.resource_id });
      const [only, ...rest] = await live(OWNER, body.device_public_id);
      expect(rest).toEqual([]);
      expect(only).toMatchObject({ id: first.json.resource_id, permission_state: 'provisional', app_version: '1.5.0', revoked_at: null });
      expect(only?.push_secret_ref).toMatch(/^secret:\/\/push\//);
      // The vault holds the latest token under the reference of the registration, the database its fingerprint only.
      const rotated = vault.tokens.get(only?.push_secret_ref as string);
      expect(rotated).toMatch(/^fcm-token-rotated-/);
      expect(only?.token_fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(await rows('select * from machvon.device_registration where id = $1', [only?.id]))).not.toContain(rotated as string);

      const removed = await call('POST', `/me/devices/${only?.id}/revoke`, { body: { reason: REASON } });
      expect(removed.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const [gone] = await live(OWNER, body.device_public_id);
      expect(gone).toMatchObject({ push_secret_ref: null });
      expect(gone?.revoked_at).not.toBeNull();
      expect(gone?.revoke_reason).toBe('USER_REVOKED');
      expect(vault.tokens.has(only?.push_secret_ref as string)).toBe(false);
    });

    it('never lets the token out: not in the answer, the audit trail, the events, the stored answer of the command or the rows of the table', async () => {
      const body = registration();
      const reply = await register(body);
      const secret = body.push_token;
      expect(JSON.stringify(reply.json)).not.toContain(secret);
      const everything = JSON.stringify([
        await rows('select * from machvon.device_registration where id = $1', [reply.json.resource_id]),
        await rows('select safe_diff, action from machvon.audit_event where resource_id = $1', [reply.json.resource_id]),
        await rows('select payload, type from machvon.outbox_event where aggregate_id = $1', [reply.json.resource_id]),
        await rows('select response_ref from machvon.idempotency_record where resource_id = $1', [reply.json.resource_id]),
      ]);
      expect(everything).not.toContain(secret);
      const audits = await rows<{ action: string; safe_diff: Record<string, unknown> }>("select action, safe_diff from machvon.audit_event where resource_id = $1 and action = 'device.registered'", [reply.json.resource_id]);
      expect(audits).toHaveLength(1);
      expect(Object.keys(audits[0]?.safe_diff ?? {}).sort()).toEqual(['app_version', 'permission_state', 'platform', 'token_changed']);
    });

    it('registers a device again after it was removed as a new registration, and one device of two members as two', async () => {
      const body = registration();
      const first = await register(body);
      await call('POST', `/me/devices/${first.json.resource_id as string}/revoke`, { body: { reason: REASON } });
      const again = await register(body);
      expect(again.json).toMatchObject({ status: 'REGISTERED' });
      expect(again.json.resource_id).not.toBe(first.json.resource_id);
      const shared = registration();
      const a = await register(shared, OWNER);
      const b = await register(shared, OTHER);
      expect(a.json.resource_id).not.toBe(b.json.resource_id);
    });

    it('keeps one live registration when the app asks twice at the same moment, and replays the answer of a repeated request', async () => {
      const body = registration();
      const answers = await Promise.all([register(body), register(body)]);
      expect(answers.map((answer) => answer.status)).toEqual([201, 201]);
      expect(answers[0]?.json.resource_id).toBe(answers[1]?.json.resource_id);
      expect(await live(OWNER, body.device_public_id)).toHaveLength(1);
      const key = `key-${randomUUID()}`;
      const once = await register(registration(), OWNER, TENANT_A, key);
      const replay = await register(registration(), OWNER, TENANT_A, key);
      expect([once.status, replay.status]).toEqual([201, 409]);
    });

    it('refuses what is not a registration: no token, a public id that is not one, an app version or locale that is not, and somebody without notification.self', async () => {
      for (const [overrides, detail] of [
        [{ push_token: '   ' }, 'push_token'],
        [{ device_public_id: 'short' }, 'device_public_id'],
        [{ device_public_id: 'has spaces and is long enough' }, 'device_public_id'],
        [{ app_version: 'v 1' }, 'app_version'],
        [{ locale: 'vietnamese' }, 'locale'],
      ] as const) {
        const refused = await register(registration(overrides));
        expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'VALIDATION_FAILED', detail]);
      }
      expect((await register(registration(), NOBODY)).status).toBe(403);
    });

    it('ties the session of the request to the device it registers, so that removing the device ends the session and ending the session removes the device and its token', async () => {
      const session = async (): Promise<string> => {
        const id = randomUUID();
        await rows(
          `insert into machvon.user_session (tenant_id, id, user_account_id, membership_id, idp_session_id, assurance_level, ip_hash, user_agent_summary)
           values ($1, $2::uuid, (select user_id from machvon.membership where id = $3::uuid), $3::uuid, $4, 'aal1', repeat('a', 64), 'Firefox on Linux')`,
          [TENANT_A, id, memberId(OWNER), `idp-${id}`],
        );
        return id;
      };
      const boundTo = async (sessionId: string): Promise<string | null> => (await rows<{ device_registration_id: string | null }>('select device_registration_id from machvon.user_session where id = $1', [sessionId]))[0]?.device_registration_id ?? null;
      // Removing the device ends the session opened on it.
      const first = await session();
      const body = registration();
      const made = await register(body, OWNER, TENANT_A, undefined, first);
      expect(await boundTo(first)).toBe(made.json.resource_id);
      const other = await session();
      const removed = await call('POST', `/me/devices/${made.json.resource_id as string}/revoke`, { body: { reason: REASON }, sid: other });
      expect(removed.status).toBe(200);
      expect((await rows<{ revoked_at: Date | null }>('select revoked_at from machvon.user_session where id = $1', [first]))[0]?.revoked_at).not.toBeNull();
      // Ending the session (from another session) removes the device and its token.
      const second = await session();
      const again = registration();
      const registered = await register(again, OWNER, TENANT_A, undefined, second);
      const [row] = await live(OWNER, again.device_public_id);
      expect(vault.tokens.has(row?.push_secret_ref as string)).toBe(true);
      const ended = await call('POST', `/me/sessions/${second}/revoke`, { body: { reason: REASON }, sid: other });
      expect(ended.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const [gone] = await live(OWNER, again.device_public_id);
      expect(gone?.revoked_at).not.toBeNull();
      expect(vault.tokens.has(row?.push_secret_ref as string)).toBe(false);
      expect(registered.status).toBe(201);
    });

    it('gives every new token a reference of its own: a rotation that commits removes the token it replaced, and one that does not leaves the old token untouched, however many fail in a row', async () => {
      const body = registration();
      await register(body);
      const [first] = await live(OWNER, body.device_public_id);
      const oldRef = first?.push_secret_ref as string;
      const oldToken = vault.tokens.get(oldRef);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        vault.failNext('put-after-write');
        expect((await register({ ...body, push_token: `fcm-token-never-committed-${attempt}` })).status).toBeGreaterThanOrEqual(500);
      }
      const [unchanged] = await live(OWNER, body.device_public_id);
      expect(unchanged).toMatchObject({ push_secret_ref: oldRef, token_fingerprint: first?.token_fingerprint });
      expect(vault.tokens.get(oldRef)).toBe(oldToken);
      expect([...vault.tokens.values()].some((value) => value.startsWith('fcm-token-never-committed'))).toBe(false);
      // A rotation that commits: the row points to the new reference and the old token is gone.
      expect((await register({ ...body, push_token: 'fcm-token-committed' })).status).toBe(201);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const [rotated] = await live(OWNER, body.device_public_id);
      expect(rotated?.push_secret_ref).not.toBe(oldRef);
      expect(vault.tokens.get(rotated?.push_secret_ref as string)).toBe('fcm-token-committed');
      expect(vault.tokens.has(oldRef)).toBe(false);
    });

    it('registers nothing for a session that has ended: 401, no device, no token', async () => {
      const ended = randomUUID();
      await rows(
        `insert into machvon.user_session (tenant_id, id, user_account_id, membership_id, idp_session_id, assurance_level, ip_hash, user_agent_summary, revoked_at, revoke_reason)
         values ($1, $2::uuid, (select user_id from machvon.membership where id = $3::uuid), $3::uuid, $4, 'aal1', repeat('a', 64), 'Firefox on Linux', now(), 'USER_REVOKED')`,
        [TENANT_A, ended, memberId(OWNER), `idp-${ended}`],
      );
      const body = registration();
      const tokensBefore = vault.tokens.size;
      const refused = await register(body, OWNER, TENANT_A, undefined, ended);
      expect([refused.status, refused.json.code]).toEqual([401, 'SESSION_EXPIRED']);
      expect(await live(OWNER, body.device_public_id)).toEqual([]);
      expect(vault.tokens.size).toBe(tokensBefore);
    });

    it('refuses a registration of a device that says another platform than the one it registered with, and changes nothing', async () => {
      const body = registration({ platform: 'android' });
      await register(body);
      const [before] = await live(OWNER, body.device_public_id);
      const tokensBefore = new Map(vault.tokens);
      const refused = await register({ ...body, platform: 'ios', push_token: 'fcm-token-of-another-platform', app_version: '9.9.9' });
      expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'platform']);
      const [after] = await live(OWNER, body.device_public_id);
      expect(after).toEqual(before);
      expect(new Map(vault.tokens)).toEqual(tokensBefore);
    });

    it('repairs a vault that lost the token: the next registration of the same token writes it again', async () => {
      const body = registration();
      const first = await register(body);
      const [row] = await live(OWNER, body.device_public_id);
      vault.tokens.clear();
      expect((await register(body)).json).toMatchObject({ status: 'UPDATED', resource_id: first.json.resource_id });
      expect(vault.tokens.get(row?.push_secret_ref as string)).toBe(body.push_token);
    });

    it('takes a new registration whose write was not acknowledged out of the vault again', async () => {
      const fresh = registration();
      const refsBefore = vault.tokens.size;
      vault.failNext('put-after-write');
      expect((await register(fresh)).status).toBeGreaterThanOrEqual(500);
      expect(vault.tokens.size).toBe(refsBefore);
      expect(await live(OWNER, fresh.device_public_id)).toEqual([]);
    });

    it('fails the command whole when the vault cannot take the token: no registration is left behind', async () => {
      const body = registration();
      vault.failNext('put');
      const failed = await register(body);
      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(await live(OWNER, body.device_public_id)).toEqual([]);
      expect((await register(body)).status).toBe(201);
    });
  });

  describe('reading the devices (NOT-14)', () => {
    it('AC-ST-NOT-006-3 UI-NOT-14: shows the operator the devices without a token, a reference, a fingerprint or the whole public id', async () => {
      const body = registration({ platform: 'ios' });
      const made = await register(body, OTHER);
      const page = await call('GET', '/resources/device_registration?limit=200', { member: OPERATOR });
      expect(page.status).toBe(200);
      const item = (page.json.items as Array<Record<string, unknown>>).find((entry) => entry.id === made.json.resource_id);
      expect(item).toMatchObject({ membership_id: memberId(OTHER), platform: 'ios', permission_state: 'granted', app_version: '1.4.2', status: 'Active', revoked_at: null });
      expect(Object.keys(item ?? {}).sort()).toEqual(['app_version', 'device_hint', 'id', 'last_seen_at', 'locale', 'membership_id', 'permission_state', 'platform', 'revoke_reason', 'revoked_at', 'status']);
      expect(item?.device_hint).toBe(`${body.device_public_id.slice(0, 4)}…${body.device_public_id.slice(-4)}`);
      expect(JSON.stringify(page.json)).not.toContain(body.push_token);
      expect(JSON.stringify(page.json)).not.toContain(body.device_public_id);
      expect(JSON.stringify(page.json)).not.toMatch(/secret:|fingerprint/);
      const one = await call('GET', `/resources/device_registration/${made.json.resource_id as string}`, { member: OPERATOR });
      expect(one.json).toMatchObject({ id: made.json.resource_id, device_hint: item?.device_hint });
      expect(JSON.stringify(one.json)).not.toContain(body.device_public_id);
    });

    it('shows a device that was removed as revoked with the reason, filters by status, platform and member, and pages newest first', async () => {
      const body = registration({ platform: 'web' });
      const made = await register(body);
      await call('POST', `/me/devices/${made.json.resource_id as string}/revoke`, { body: { reason: REASON } });
      const revoked = await call('GET', '/resources/device_registration?status=Revoked&platform=web&limit=200', { member: OPERATOR });
      const item = (revoked.json.items as Array<Record<string, unknown>>).find((entry) => entry.id === made.json.resource_id);
      expect(item).toMatchObject({ status: 'Revoked', revoke_reason: 'USER_REVOKED' });
      expect(item?.revoked_at).not.toBeNull();
      expect((revoked.json.items as Array<Record<string, unknown>>).every((entry) => entry.status === 'Revoked' && entry.platform === 'web')).toBe(true);
      const mine = await call('GET', `/resources/device_registration?membership_id=${memberId(OTHER)}&limit=200`, { member: OPERATOR });
      expect((mine.json.items as Array<Record<string, unknown>>).every((entry) => entry.membership_id === memberId(OTHER))).toBe(true);
      expect((await call('GET', '/resources/device_registration?status=Bogus', { member: OPERATOR })).status).toBe(422);
      // Thirty-six characters of the right kind are not an id: a validation error, not a failure of the query.
      expect((await call('GET', `/resources/device_registration?membership_id=${'-'.repeat(36)}`, { member: OPERATOR })).status).toBe(422);
      const all = (await call('GET', '/resources/device_registration?limit=200', { member: OPERATOR })).json.items as Array<{ id: string }>;
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const next: Reply = await call('GET', `/resources/device_registration?limit=3${cursor === null ? '' : `&cursor=${cursor}`}`, { member: OPERATOR });
        seen.push(...(next.json.items as Array<{ id: string }>).map((entry) => entry.id));
        cursor = next.json.next_cursor as string | null;
      } while (cursor !== null);
      expect(seen).toEqual(all.map((entry) => entry.id));
    });

    it('is for who may read the devices of the tenant: a person on one unit, or without the right, is refused, and another tenant sees none', async () => {
      const made = await register(registration());
      expect((await call('GET', '/resources/device_registration', { member: SUBTREE })).status).toBe(403);
      expect((await call('GET', '/resources/device_registration', { member: NOBODY })).status).toBe(403);
      expect((await call('GET', `/resources/device_registration/${made.json.resource_id as string}`, { member: SUBTREE })).status).toBe(403);
      expect((await call('GET', '/resources/device_registration?limit=200', { member: OTHER_TENANT_MEMBER, tenantId: TENANT_B })).json.items).toEqual([]);
      expect((await call('GET', `/resources/device_registration/${made.json.resource_id as string}`, { member: OTHER_TENANT_MEMBER, tenantId: TENANT_B })).status).toBe(404);
      expect((await call('GET', `/resources/device_registration/${randomUUID()}`, { member: OPERATOR })).status).toBe(404);
    });
  });
});
