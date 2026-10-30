import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { ChannelAccountsController } from '../../src/omni/channel-accounts.controller';
import { ChannelVerificationConsumer, VERIFICATION_REQUESTED_EVENT } from '../../src/omni/channel-verification.consumer';
import { MockChannelVerifier } from '../../src/omni/channel-verifier';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const RELAY_KEY = randomBytes(32);
const SUPERVISOR = 1; // omni.channel.manage and channel_account.read on the whole tenant
const READER = 2; // channel_account.read only
const SUBTREE = 3; // both, on one unit only
const NOBODY = 4;
const OTHER_TENANT_SUPERVISOR = 1; // of tenant B
const REASON = 'Checked with the owner of the account.';
const CREDENTIAL = 'secret://omni/whatsapp/token';
const WEBHOOK = 'secret://omni/whatsapp/webhook';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the channel accounts (ST-OMNI-001, OMNI-05, OMNI-06)', () => {
  const harness = new AuthzHarness();
  const verifier = new MockChannelVerifier();
  const raised: Array<{ code: string; context: Record<string, unknown> }> = [];
  let app: RunningApp;
  let consumer: ChannelVerificationConsumer;
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  const rows = <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

  async function call(method: 'GET' | 'POST' | 'PUT', url: string, options: { member?: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string } = {}): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member ?? SUPERVISOR, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, ...(method === 'GET' ? {} : { body: JSON.stringify(options.body ?? {}) }) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const idOf = (reply: Reply): string => reply.json.resource_id as string;
  const external = (): string => `1048576${(counter += 1).toString().padStart(5, '0')}${randomUUID().slice(0, 4)}`;
  const connectBody = (overrides: Record<string, unknown> = {}) => ({ channel: 'WHATSAPP', external_account_id: external(), display_name: 'Hotline', credential_secret_ref: CREDENTIAL, webhook_secret_ref: WEBHOOK, ...overrides });
  const connect = (body: Record<string, unknown> = connectBody(), member = SUPERVISOR, tenantId = TENANT_A) => call('POST', '/channel-accounts', { member, tenantId, body });
  const verify = (id: string, version: number, member = SUPERVISOR) => call('POST', `/channel-accounts/${id}/verify`, { member, ifMatch: `"${version}"`, body: { reason: REASON } });
  const disable = (id: string, version: number, member = SUPERVISOR) => call('POST', `/channel-accounts/${id}/disable`, { member, ifMatch: `"${version}"`, body: { reason: REASON } });
  const update = (id: string, version: number, body: Record<string, unknown>, member = SUPERVISOR) => call('PUT', `/channel-accounts/${id}`, { member, ifMatch: `"${version}"`, body: { reason: REASON, ...body } });
  const read = (id: string, member = SUPERVISOR, tenantId = TENANT_A) => call('GET', `/resources/channel_account/${id}`, { member, tenantId });
  const accountRow = async (id: string) => {
    const [row] = await rows<{ status: string; verified_at: Date | null; verify_requested_at: Date | null; verification_error: string | null; version: string }>(
      'select status, verified_at, verify_requested_at, verification_error, version::text as version from machvon.channel_account where id = $1',
      [id],
    );
    if (row === undefined) throw new Error('no account');
    return row;
  };

  /** The delivery the relay would hand the consumer for the request that the command wrote to the outbox. */
  async function requestsOf(id: string) {
    const events = await rows<{ id: string; payload: Record<string, unknown> }>("select id, payload from machvon.outbox_event where type = $1 and aggregate_id = $2 order by created_at, id", [VERIFICATION_REQUESTED_EVENT, id]);
    return events.map((event) => ({
      id: event.id,
      tenantId: TENANT_A,
      tenantContext: signTenantContext({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, RELAY_KEY),
      type: VERIFICATION_REQUESTED_EVENT,
      payload: event.payload,
    }));
  }

  async function requestOf(id: string) {
    const all = await requestsOf(id);
    const latest = all[all.length - 1];
    if (latest === undefined) throw new Error('no request');
    return latest;
  }

  /** Connects, asks for the verification and lets the consumer answer. */
  async function active(overrides: Record<string, unknown> = {}): Promise<string> {
    const made = await connect(connectBody(overrides));
    expect(made.status).toBe(201);
    expect((await verify(idOf(made), 1)).status).toBe(202);
    expect(await consumer.handle(await requestOf(idOf(made)))).toBe('processed');
    expect((await accountRow(idOf(made))).status).toBe('Active');
    return idOf(made);
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }, { n: 2, path: `/${unitId(1)}/${unitId(2)}/`, parent: 1 }]);
    for (const [member, unit] of [[SUPERVISOR, 1], [READER, 1], [SUBTREE, 2], [NOBODY, 1]] as const) await harness.seedMembership(TENANT_A, member, unit, { validFrom: '2026-01-01T00:00:00Z' });
    await harness.seedMembership(TENANT_B, OTHER_TENANT_SUPERVISOR, 1, { validFrom: '2026-01-01T00:00:00Z' });
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedRole(tenant, 1, 'OMNI_SUPERVISOR', ['omni.channel.manage', 'channel_account.read'], 50);
      await harness.seedRole(tenant, 2, 'ACCOUNT_READER', ['channel_account.read'], 10);
    }
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: SUPERVISOR, role: 1, kind: 'TENANT' },
      { n: 2, member: READER, role: 2, kind: 'TENANT' },
      { n: 3, member: SUBTREE, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT_SUPERVISOR, role: 1, kind: 'TENANT' }]);
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, legal_basis_ref, status, created_by, published_by, published_at)
         values ($1, gen_random_uuid(), 'VN-STD', 2026, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, 'Bo luat Lao dong', 'Published', $2, $2, now())`,
        [TENANT_A, memberId(SUPERVISOR)],
      ],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    consumer = new ChannelVerificationConsumer({ database: tenants, verifier, security: { signingKey: RELAY_KEY }, timeoutMs: 200, alerts: { raise: (code, context) => void raised.push({ code, context: context ?? {} }) } });
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [ChannelAccountsController],
      providers: [{ provide: TenantDatabase, useValue: tenants }, { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) }],
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await harness.stop();
  }, 60_000);

  beforeEach(() => {
    verifier.recover();
    verifier.asked.length = 0;
  });

  describe('connecting (OMNI-05)', () => {
    it('AC-ST-OMNI-001-2 UI-OMNI-05: connects an account as pending verification, and no answer, audit row or event holds a reference to a secret', async () => {
      const body = connectBody();
      const made = await connect(body);
      expect(made.status).toBe(201);
      expect(made.json).toMatchObject({ status: 'PENDING_VERIFICATION' });
      const shown = await read(idOf(made));
      expect(shown.status).toBe(200);
      expect(shown.json).toMatchObject({ status: 'PendingVerification', channel: 'WHATSAPP', external_account_id: body.external_account_id, display_name: 'Hotline', credential_configured: true, webhook_configured: true, verified_at: null, version: 1 });
      expect(JSON.stringify(shown.json)).not.toContain('secret://');
      const listed = await call('GET', '/resources/channel_account');
      expect(JSON.stringify(listed.json)).not.toContain('secret://');
      const audit = await rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where action = 'omni.channel_account_connected' and resource_id = $1", [idOf(made)]);
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit)).not.toMatch(/secret:\/\/|1048576/);
      expect(JSON.stringify(await rows('select * from machvon.outbox_event where aggregate_id = $1', [idOf(made)]))).not.toContain('secret://');
    });

    it('is 409 CHANNEL_ACCOUNT_EXISTS for the same account of the same channel, and a closed account does not free it', async () => {
      const body = connectBody();
      expect((await connect(body)).status).toBe(201);
      const again = await connect(body);
      expect([again.status, again.json.code]).toEqual([409, 'CHANNEL_ACCOUNT_EXISTS']);
      // The same id on another tenant is another account: the unique index is the tenant's.
      expect((await connect(body, OTHER_TENANT_SUPERVISOR, TENANT_B)).status).toBe(201);
    });

    it('refuses a secret written in place of its reference, a webhook secret on a push channel and none on a channel that has webhooks', async () => {
      for (const bad of [{ credential_secret_ref: 'EAAG-pasted-token' }, { webhook_secret_ref: 'pasted-secret' }, { webhook_secret_ref: undefined }, { channel: 'PUSH_FCM' }, { channel: 'FAX' }, { display_name: ' ' }, { external_account_id: 'has space' }]) {
        const refused = await connect(connectBody(bad));
        expect([refused.status, refused.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      }
      const push = await connect(connectBody({ channel: 'PUSH_FCM', webhook_secret_ref: undefined }));
      expect(push.status).toBe(201);
    });

    it('lets the same provider account be connected again once the first was closed, and still not while one is open', async () => {
      const body = connectBody();
      const first = idOf(await connect(body));
      expect((await connect(body)).status).toBe(409);
      expect((await disable(first, 1)).status).toBe(200);
      const again = await connect(body);
      expect(again.status).toBe(201);
      expect(idOf(again)).not.toBe(first);
      expect((await connect(body)).status).toBe(409);
      expect(await rows('select id from machvon.channel_account where external_account_id = $1', [body.external_account_id])).toHaveLength(2);
    });

    it('is for the supervisors of the whole tenant: a reader, a holder on one unit and a member with nothing are refused', async () => {
      for (const member of [READER, SUBTREE, NOBODY]) expect((await connect(connectBody(), member)).status).toBe(403);
    });
  });

  describe('reading (OMNI-05, OMNI-06)', () => {
    it('lists the accounts newest first, by status and by channel, in pages, and reads one; another tenant sees none of them', async () => {
      const first = idOf(await connect(connectBody({ channel: 'SMS' })));
      const second = idOf(await connect(connectBody({ channel: 'SMS' })));
      const page = await call('GET', '/resources/channel_account?channel=SMS&limit=1');
      expect((page.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([second]);
      expect(page.json.next_cursor).not.toBeNull();
      const next = await call('GET', `/resources/channel_account?channel=SMS&limit=1&cursor=${encodeURIComponent(page.json.next_cursor as string)}`);
      expect((next.json.items as Array<{ id: string }>)[0]?.id).toBe(first);
      const pending = await call('GET', '/resources/channel_account?status=PendingVerification');
      expect((pending.json.items as Array<{ status: string }>).every((item) => item.status === 'PendingVerification')).toBe(true);
      expect((await call('GET', '/resources/channel_account?status=Nope')).status).toBe(422);
      expect((await read(first, READER)).status).toBe(200);
      expect((await read(first, OTHER_TENANT_SUPERVISOR, TENANT_B)).status).toBe(404);
      const foreign = await call('GET', '/resources/channel_account', { member: OTHER_TENANT_SUPERVISOR, tenantId: TENANT_B });
      expect((foreign.json.items as Array<{ id: string }>).map((item) => item.id)).not.toContain(first);
      for (const member of [SUBTREE, NOBODY]) expect((await call('GET', '/resources/channel_account', { member })).status).toBe(403);
    });
  });

  describe('verifying (OMNI 3.7)', () => {
    it('AC-ST-OMNI-001-1 UAT-AC196: asked for, it is 202 and the consumer makes the account Active and verified, once, with the audit row and the event', async () => {
      const made = await connect(connectBody());
      const id = idOf(made);
      const asked = await verify(id, 1);
      expect(asked.status).toBe(202);
      expect(asked.json).toMatchObject({ status: 'VERIFICATION_REQUESTED', resource_version: 2 });
      expect(await accountRow(id)).toMatchObject({ status: 'PendingVerification', verified_at: null });
      expect((await accountRow(id)).verify_requested_at).not.toBeNull();
      const delivery = await requestOf(id);
      expect(await consumer.handle(delivery)).toBe('processed');
      expect(verifier.asked).toHaveLength(1);
      const done = await accountRow(id);
      expect(done).toMatchObject({ status: 'Active', verify_requested_at: null, verification_error: null });
      expect(done.verified_at).not.toBeNull();
      expect((await read(id)).json).toMatchObject({ status: 'Active', version: 3 });
      // Delivered again, the provider is not asked again and nothing changes.
      expect(await consumer.handle(delivery)).toBe('duplicate');
      expect(verifier.asked).toHaveLength(1);
      expect(await rows("select 1 from machvon.audit_event where action = 'omni.channel_account_verified' and resource_id = $1", [id])).toHaveLength(1);
      expect(await rows("select 1 from machvon.outbox_event where type = 'omni.channel_account.verified.v1' and aggregate_id = $1", [id])).toHaveLength(1);
    });

    it('keeps the reason a provider refused with, leaves the account pending, and verifies again once it is corrected', async () => {
      const body = connectBody();
      const id = idOf(await connect(body));
      verifier.refuse(body.external_account_id as string, 'CREDENTIAL_INVALID');
      await verify(id, 1);
      expect(await consumer.handle(await requestOf(id))).toBe('processed');
      expect(await accountRow(id)).toMatchObject({ status: 'PendingVerification', verification_error: 'CREDENTIAL_INVALID', verify_requested_at: null });
      expect(raised.filter((alert) => alert.code === 'OMNI_CHANNEL_VERIFICATION_FAILED').map((alert) => alert.context)).toContainEqual({ tenantId: TENANT_A, channelAccountId: id, channel: 'WHATSAPP', reason: 'CREDENTIAL_INVALID' });
      expect(JSON.stringify(raised)).not.toMatch(/secret:\/\/|1048576/);
      expect((await read(id)).json).toMatchObject({ status: 'PendingVerification', verification_error: 'CREDENTIAL_INVALID' });
      verifier.recover();
      const current = Number((await accountRow(id)).version);
      expect((await verify(id, current)).status).toBe(202);
      expect(await consumer.handle(await requestOf(id))).toBe('processed');
      expect(await accountRow(id)).toMatchObject({ status: 'Active', verification_error: null });
    });

    it('treats a provider that is down, or does not answer in time, as a refusal to ask again later, never as a good account', async () => {
      const down = idOf(await connect(connectBody()));
      verifier.failAll('connect ECONNREFUSED');
      await verify(down, 1);
      expect(await consumer.handle(await requestOf(down))).toBe('processed');
      expect(await accountRow(down)).toMatchObject({ status: 'PendingVerification', verification_error: 'PROVIDER_UNREACHABLE' });
      verifier.recover();
      const slow = idOf(await connect(connectBody()));
      verifier.hangAll();
      await verify(slow, 1);
      expect(await consumer.handle(await requestOf(slow))).toBe('processed');
      expect(await accountRow(slow)).toMatchObject({ status: 'PendingVerification', verification_error: 'PROVIDER_UNREACHABLE' });
    });

    it('does not apply an answer to a request that was withdrawn, and does not verify a closed account', async () => {
      const id = idOf(await connect(connectBody()));
      await verify(id, 1);
      const delivery = await requestOf(id);
      // The supervisor closes the account before the answer comes.
      expect((await disable(id, 2)).status).toBe(200);
      expect(await consumer.handle(delivery)).toBe('processed');
      expect(await accountRow(id)).toMatchObject({ status: 'Disabled', verified_at: null });
      expect(verifier.asked).toHaveLength(0);
    });

    it('is 409 CHANNEL_ACCOUNT_STATE_INVALID for an account that is Active or closed, 409 VERSION_CONFLICT for a stale version and 428 without one', async () => {
      const id = await active();
      const refused = await verify(id, 3);
      expect([refused.status, refused.json.code]).toEqual([409, 'CHANNEL_ACCOUNT_STATE_INVALID']);
      const stale = await verify(id, 1);
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const missing = await call('POST', `/channel-accounts/${id}/verify`, { body: { reason: REASON } });
      expect(missing.status).toBe(428);
      expect((await verify(id, 3, READER)).status).toBe(403);
    });

    it('verifies an account whose credential expired, and the account is usable again', async () => {
      const id = await active();
      await rows("update machvon.channel_account set status = 'CredentialExpired', version = version + 1 where id = $1", [id]);
      expect((await verify(id, 4)).status).toBe(202);
      expect(await consumer.handle(await requestOf(id))).toBe('processed');
      expect(await accountRow(id)).toMatchObject({ status: 'Active', verification_error: null });
    });

    it('ignores what is not for it: another event, a payload of another tenant, one without an account', async () => {
      const id = idOf(await connect(connectBody()));
      await verify(id, 1);
      const delivery = await requestOf(id);
      expect(await consumer.handle({ ...delivery, type: 'report.overdue' })).toBe('ignored');
      expect(await consumer.handle({ ...delivery, payload: { ...delivery.payload, tenant_id: TENANT_B } })).toBe('ignored');
      expect(await consumer.handle({ ...delivery, payload: { tenant_id: TENANT_A } })).toBe('ignored');
      expect(verifier.asked).toHaveLength(0);
    });
  });

  describe('changing and closing (OMNI-06)', () => {
    it('changes the name, the auto reply and the calendar at the version read, clears them with null, and says which fields changed in the audit row without what the auto reply says', async () => {
      const id = idOf(await connect(connectBody()));
      const changed = await update(id, 1, { display_name: 'Hotline 24/7', auto_reply_text: 'We answer from 8:00 on working days.', calendar_code: 'VN-STD' });
      expect(changed.status).toBe(200);
      expect((await read(id)).json).toMatchObject({ display_name: 'Hotline 24/7', auto_reply_text: 'We answer from 8:00 on working days.', calendar_code: 'VN-STD', version: 2 });
      const audit = await rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where action = 'omni.channel_account_updated' and resource_id = $1", [id]);
      expect(audit[0]?.safe_diff).toMatchObject({ fields: ['autoReplyText', 'calendarCode', 'displayName'] });
      expect(JSON.stringify(audit)).not.toContain('We answer');
      expect((await update(id, 2, { auto_reply_text: '', calendar_code: '' })).status).toBe(200);
      expect((await read(id)).json).toMatchObject({ auto_reply_text: null, calendar_code: null, version: 3 });
    });

    it('refuses a calendar the tenant has not published, an empty change and a stale version, and does not change a closed account', async () => {
      const id = idOf(await connect(connectBody()));
      expect([(await update(id, 1, { calendar_code: 'NOPE' })).status, (await update(id, 1, { calendar_code: 'NOPE' })).json.detail]).toEqual([422, 'calendar_code']);
      expect((await update(id, 1, {})).status).toBe(422);
      const stale = await update(id, 5, { display_name: 'x' });
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      expect((await update(id, 1, { display_name: 'New name' }, READER)).status).toBe(403);
      expect((await disable(id, 1)).status).toBe(200);
      const closed = await update(id, 2, { display_name: 'Again' });
      expect([closed.status, closed.json.code]).toEqual([409, 'CHANNEL_ACCOUNT_STATE_INVALID']);
    });

    it('AC-ST-OMNI-001-4 UI-OMNI-06: closes an account for good, with the audit row and the event, and a closed account is neither verified nor closed again', async () => {
      const id = await active();
      const closed = await disable(id, 3);
      expect(closed.status).toBe(200);
      expect(closed.json).toMatchObject({ status: 'DISABLED', resource_version: 4 });
      expect((await read(id)).json).toMatchObject({ status: 'Disabled' });
      expect(await rows("select 1 from machvon.audit_event where action = 'omni.channel_account_disabled' and resource_id = $1", [id])).toHaveLength(1);
      expect(await rows("select 1 from machvon.outbox_event where type = 'omni.channel_account.disabled.v1' and aggregate_id = $1", [id])).toHaveLength(1);
      for (const again of [await verify(id, 4), await disable(id, 4)]) expect([again.status, again.json.code]).toEqual([409, 'CHANNEL_ACCOUNT_STATE_INVALID']);
    });
  });

  describe('what the database keeps', () => {
    it('does not let what an account is change, an account come back from Disabled, or Active be without a verification', async () => {
      const id = await active();
      const refuses = async (sql: string): Promise<boolean> => {
        try {
          await rows(sql, [id]);
          return false;
        } catch {
          return true;
        }
      };
      expect(await refuses("update machvon.channel_account set external_account_id = 'other' where id = $1")).toBe(true);
      expect(await refuses("update machvon.channel_account set credential_secret_ref = 'secret://other' where id = $1")).toBe(true);
      expect(await refuses("update machvon.channel_account set channel = 'SMS' where id = $1")).toBe(true);
      expect(await refuses("update machvon.channel_account set status = 'PendingVerification' where id = $1")).toBe(true);
      await rows("update machvon.channel_account set status = 'Disabled' where id = $1", [id]);
      expect(await refuses("update machvon.channel_account set status = 'Active' where id = $1")).toBe(true);
      const fresh = idOf(await connect(connectBody()));
      expect(await refuses(`update machvon.channel_account set status = 'Active' where id = '${fresh}'`.replace('$1', '$1'))).toBe(true);
    });
  });
});
