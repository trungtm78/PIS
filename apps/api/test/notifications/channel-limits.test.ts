import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { ChannelLimitsController } from '../../src/notifications/limits/limits.controller';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const ADMIN = 1; // notification.channel.manage and delivery_attempt.read on the whole tenant
const READER = 2; // delivery_attempt.read only
const SUBTREE = 3; // both, on one unit
const NOBODY = 4;
const OTHER_TENANT_ADMIN = 1; // of tenant B
const REASON = 'The budget of the quarter was approved.';
const ACTOR = '00000000-0000-4000-8000-0000000000f0';
const WORKFLOW = '00000000-0000-4000-8000-0000000000b1';
const TEMPLATE = '00000000-0000-4000-8000-0000000000e2';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the limits of the channels and the overview of the delivery (ST-NOT-010, NOT-04, NOT-15)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  const rows = <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

  async function call(method: 'GET' | 'PUT', url: string, options: { member?: number; tenantId?: string; body?: unknown; ifMatch?: string } = {}): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member ?? ADMIN, options.tenantId), 'content-type': 'application/json' };
    if (method === 'PUT') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, ...(method === 'PUT' ? { body: JSON.stringify(options.body ?? {}) } : {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  async function account(status = 'Active', channel = 'SMS', tenant = TENANT_A): Promise<string> {
    const accountId = id(0xd0, (counter += 1));
    await harness.owner(tenant, [
      [
        `insert into machvon.channel_account (tenant_id, id, channel, external_account_id, credential_secret_ref, capability_version, status, verified_at, webhook_secret_ref, display_name)
         values ($1, $2, $3, $4, 'secret://t/x', 'v1', 'Active', now(), 'secret://t/y', $5)`,
        [tenant, accountId, channel, `acct-${counter}-${randomUUID().slice(0, 6)}`, `Account ${counter}`],
      ],
    ]);
    if (status !== 'Active') await harness.owner(tenant, [[`update machvon.channel_account set status = '${status}' where id = $1`, [accountId]]]);
    return accountId;
  }
  const set = (accountId: string, version: number, body: Record<string, unknown>, member = ADMIN) => call('PUT', `/channel-accounts/${accountId}/limits`, { member, ifMatch: `"${version}"`, body: { reason: REASON, ...body } });
  const accountRow = async (accountId: string) => {
    const [row] = await rows<{ daily_send_cap: number | null; monthly_budget_vnd: string | null; version: string }>('select daily_send_cap, monthly_budget_vnd::text as monthly_budget_vnd, version::text as version from machvon.channel_account where id = $1', [accountId]);
    if (row === undefined) throw new Error('no account');
    return row;
  };

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }, { n: 2, path: `/${unitId(1)}/${unitId(2)}/`, parent: 1 }]);
    for (const [member, unit] of [[ADMIN, 1], [READER, 1], [SUBTREE, 2], [NOBODY, 1]] as const) await harness.seedMembership(TENANT_A, member, unit, { validFrom: '2026-01-01T00:00:00Z' });
    await harness.seedMembership(TENANT_B, OTHER_TENANT_ADMIN, 1, { validFrom: '2026-01-01T00:00:00Z' });
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedRole(tenant, 1, 'CHANNEL_ADMIN', ['notification.channel.manage', 'delivery_attempt.read'], 50);
      await harness.seedRole(tenant, 2, 'DELIVERY_READER', ['delivery_attempt.read'], 10);
    }
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ADMIN, role: 1, kind: 'TENANT' },
      { n: 2, member: READER, role: 2, kind: 'TENANT' },
      { n: 3, member: SUBTREE, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT_ADMIN, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [ChannelLimitsController],
      providers: [{ provide: TenantDatabase, useValue: tenants }, { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) }],
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await harness.stop();
  }, 60_000);

  describe('setting the limits (NOT-15)', () => {
    it('sets a daily cap and a monthly budget at the version read, with the audit row and the version moved, and takes each off with its own flag', async () => {
      const accountId = await account();
      const set1 = await set(accountId, 1, { daily_send_cap: 500, monthly_budget_vnd: '1000000' });
      expect(set1.status).toBe(200);
      expect(set1.json).toMatchObject({ resource_version: 2, resource_id: accountId });
      expect(await accountRow(accountId)).toMatchObject({ daily_send_cap: 500, monthly_budget_vnd: '1000000', version: '2' });
      const audit = await rows<{ safe_diff: Record<string, unknown>; reason: string | null }>("select safe_diff, reason from machvon.audit_event where action = 'notification.channel_limits_set' and resource_id = $1", [accountId]);
      expect(audit).toHaveLength(1);
      expect(audit[0]?.safe_diff).toMatchObject({ channel: 'SMS', daily_send_cap: 500, monthly_budget_vnd: '1000000' });
      // One limit changes, the other stays; a limit comes off with its flag.
      expect((await set(accountId, 2, { daily_send_cap: 100 })).status).toBe(200);
      expect(await accountRow(accountId)).toMatchObject({ daily_send_cap: 100, monthly_budget_vnd: '1000000' });
      expect((await set(accountId, 3, { clear_daily_send_cap: true, clear_monthly_budget: true })).status).toBe(200);
      expect(await accountRow(accountId)).toMatchObject({ daily_send_cap: null, monthly_budget_vnd: null, version: '4' });
    });

    it('refuses what is not a limit, a contradiction, a stale version and a closed account', async () => {
      const accountId = await account();
      for (const [bad, field] of [
        [{ daily_send_cap: 0 }, 'daily_send_cap'],
        [{ daily_send_cap: 10_000_001 }, 'daily_send_cap'],
        [{ monthly_budget_vnd: '-5' }, 'monthly_budget_vnd'],
        [{ monthly_budget_vnd: '12.5' }, 'monthly_budget_vnd'],
        [{ daily_send_cap: 5, clear_daily_send_cap: true }, 'clear_daily_send_cap'],
        [{}, 'daily_send_cap'],
      ] as const) {
        const refused = await set(accountId, 1, bad);
        expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'VALIDATION_FAILED', field]);
      }
      const stale = await set(accountId, 7, { daily_send_cap: 5 });
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      expect((await call('PUT', `/channel-accounts/${accountId}/limits`, { body: { reason: REASON, daily_send_cap: 5 } })).status).toBe(428);
      const closed = await account('Disabled');
      const refusedClosed = await set(closed, 1, { daily_send_cap: 5 });
      expect([refusedClosed.status, refusedClosed.json.code]).toEqual([409, 'CHANNEL_ACCOUNT_STATE_INVALID']);
      expect((await set(randomUUID(), 1, { daily_send_cap: 5 })).status).toBe(404);
      expect(await accountRow(accountId)).toMatchObject({ daily_send_cap: null, version: '1' });
    });

    it('is for the administrators of the tenant: a reader, a holder on one unit and a member with nothing are refused, and so is the account of another tenant', async () => {
      const accountId = await account();
      for (const member of [READER, SUBTREE, NOBODY]) expect((await set(accountId, 1, { daily_send_cap: 5 }, member)).status).toBe(403);
      // The administrator of tenant B names the account of tenant A: it is not there for them.
      const foreign = await call('PUT', `/channel-accounts/${accountId}/limits`, { member: OTHER_TENANT_ADMIN, tenantId: TENANT_B, ifMatch: '"1"', body: { reason: REASON, daily_send_cap: 5 } });
      expect(foreign.status).toBe(404);
      expect(await accountRow(accountId)).toMatchObject({ daily_send_cap: null });
    });
  });

  describe('the overview of the delivery (NOT-04)', () => {
    /** 100 attempts of the period on 20 notifications: 70 delivered, 10 read, 5 suppressed, 11 unknown, 4 failed. */
    let seeded: Promise<void> | undefined;
    const seedAttempts = (accountId: string): Promise<void> => (seeded ??= insertAttempts(accountId));
    async function insertAttempts(accountId: string): Promise<void> {
      await harness.owner(TENANT_A, [
        [
          `insert into machvon.workflow_version (tenant_id, id, business_type, revision, definition_json, status, kind, event_type, created_by, definition_hash)
           values ($1, $2, 'report.overdue', 1, '{}'::jsonb, 'Published', 'NOTIFICATION', 'report.overdue', $3, repeat('a', 64)) on conflict do nothing`,
          [TENANT_A, WORKFLOW, ACTOR],
        ],
        [
          `insert into machvon.notification_template_version (tenant_id, id, code, channel, locale, revision, content_ast, variable_schema, status, content_hash, created_by)
           values ($1, $2, 'sms.a', 'SMS', 'vi-VN', 1, '{"body":"B"}'::jsonb, '{}'::jsonb, 'Active', $3, $4) on conflict do nothing`,
          [TENANT_A, TEMPLATE, createHash('sha256').update('sms.a').digest('hex'), ACTOR],
        ],
      ]);
      const statuses = [...Array(70).fill('Delivered'), ...Array(10).fill('Read'), ...Array(5).fill('Suppressed'), ...Array(11).fill('Unknown'), ...Array(4).fill('Failed')] as string[];
      const statements: Array<[string, unknown[]]> = [];
      for (let n = 0; n < 20; n += 1) {
        const notificationId = id(0x8e, 1000 + n);
        statements.push([
          `insert into machvon.notification_instance (tenant_id, id, event_id, workflow_version_id, recipient_id, purpose, dedupe_key, expires_at, status, source_event_type, ack_required)
           values ($1, $2, $3, $4, $5, 'OPERATIONAL', $6, now() + interval '1 day', 'Delivered', 'report.overdue', false)`,
          [TENANT_A, notificationId, id(0x8f, 1000 + n), WORKFLOW, memberId(ADMIN), `n1:${'a'.repeat(62)}${n.toString(16).padStart(2, '0')}`],
        ]);
        for (let attempt = 1; attempt <= 5; attempt += 1) {
          const status = statuses[n * 5 + attempt - 1] as string;
          statements.push([
            `insert into machvon.delivery_attempt (tenant_id, id, notification_id, channel_account_id, attempt_no, status, cost, channel, template_version_id, failure_class, failed_at, unknown_at, delivered_at, read_at, error_code)
             values ($1, gen_random_uuid(), $2, $3, $4, $5, 0, 'SMS', $6,
                     case when $5 = 'Failed' then 'PERMANENT' when $5 = 'Unknown' then 'UNKNOWN' end,
                     case when $5 = 'Failed' then now() end, case when $5 = 'Unknown' then now() end,
                     case when $5 in ('Delivered', 'Read') then now() end, case when $5 = 'Read' then now() end,
                     case when $5 = 'Suppressed' then 'NO_CONSENT' end)`,
            [TENANT_A, notificationId, accountId, attempt, status, TEMPLATE],
          ]);
        }
      }
      for (const statement of statements) await harness.owner(TENANT_A, [statement]);
    }

    it('AC-ST-NOT-010-2 UAT-AC193: 100 attempts with 5 suppressed and 11 unknown give 84.21 % over a denominator of 95, with the unknown shown apart', async () => {
      const accountId = await account();
      await seedAttempts(accountId);
      const overview = await call('GET', '/delivery-overview');
      expect(overview.status).toBe(200);
      const sms = (overview.json.channels as Array<Record<string, unknown>>).find((channel) => channel.channel === 'SMS');
      expect(sms).toMatchObject({ delivered: 70, read: 10, ended: 100, suppressed: 5, unknown: 11, failed: 4, denominator: 95, delivered_rate: 84.21 });
      expect(overview.json.to).toEqual(expect.any(String));
      expect(overview.json.as_of).toEqual(expect.any(String));
    }, 60_000);

    it('shows each open account against its cap and its budget, and leaves a closed account out', async () => {
      const open = await account();
      const closed = await account('Disabled');
      await seedAttempts(open);
      await set(open, 1, { daily_send_cap: 50, monthly_budget_vnd: '2000000' });
      // A message of its own that waits for the cap of the account.
      await rows("insert into machvon.notification_instance (tenant_id, id, event_id, workflow_version_id, recipient_id, purpose, dedupe_key, expires_at, status, source_event_type, ack_required) values ($1, $2, $3, $4, $5, 'OPERATIONAL', $6, now() + interval '1 day', 'Queued', 'report.overdue', false)", [TENANT_A, id(0x8e, 2000), id(0x8f, 2000), WORKFLOW, memberId(ADMIN), 'n1:' + 'b'.repeat(64)]);
      await rows("insert into machvon.delivery_attempt (tenant_id, id, notification_id, channel_account_id, attempt_no, status, cost, channel, template_version_id, next_retry_at, error_code) values ($1, gen_random_uuid(), $2, $3, 1, 'Queued', 0, 'SMS', $4, now() + interval '1 day', 'CHANNEL_CAP')", [TENANT_A, id(0x8e, 2000), open, TEMPLATE]);
      const overview = await call('GET', '/delivery-overview');
      const accounts = overview.json.accounts as Array<Record<string, unknown>>;
      const mine = accounts.find((entry) => entry.channel_account_id === open);
      expect(mine).toMatchObject({ daily_send_cap: 50, monthly_budget_vnd: '2000000', sent_today: 0, spent_month_vnd: '0', held_by_limit: 1, status: 'Active', version: 2 });
      expect(accounts.map((entry) => entry.channel_account_id)).not.toContain(closed);
    }, 60_000);

    it('has no rate for a period with nothing in it, takes a period of up to 90 days, and refuses a period that is backwards or too long', async () => {
      const quiet = await call('GET', '/delivery-overview?from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z');
      expect(quiet.status).toBe(200);
      expect(quiet.json.channels).toEqual([]);
      for (const query of ['from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z', 'from=2025-01-01T00:00:00Z&to=2026-01-01T00:00:00Z', 'from=nope']) {
        expect((await call('GET', `/delivery-overview?${query}`)).status).toBe(422);
      }
    });

    it('is for who reads the delivery on the whole tenant, and the other tenant sees none of it', async () => {
      expect((await call('GET', '/delivery-overview', { member: READER })).status).toBe(200);
      // The delivery of the tenant is the tenant's: a holder on one unit and a member with nothing are refused.
      for (const member of [SUBTREE, NOBODY]) expect((await call('GET', '/delivery-overview', { member })).status).toBe(403);
      const foreign = await call('GET', '/delivery-overview', { member: OTHER_TENANT_ADMIN, tenantId: TENANT_B });
      expect(foreign.status).toBe(200);
      expect(foreign.json.channels).toEqual([]);
      expect(foreign.json.accounts).toEqual([]);
    });
  });
});
