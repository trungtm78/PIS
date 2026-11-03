import { randomBytes } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { homeModule } from '../../src/modules/home';
import { ChannelHealthController } from '../../src/modules/home/channel-health.controller';
import { HOME_CLOCK } from '../../src/modules/home/tokens';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(120_000);

const SIGNING_KEY = randomBytes(32);
const READER = 1; // holds home.read
const NOBODY = 2; // holds no right to read HOME
const B_READER = 1;
const ROOT = 1;
const FAMILY = 0xb7;
const NOW = new Date('2027-10-15T03:00:00Z');

interface Channel {
  channel: string;
  state: string;
  open_since: string;
  last_delivered_at: string | null;
}

/** The banner of the degraded channels on the home screen, over HTTP (ST-KERNEL-073, UAT-NFR-AVAILABILITY-04). */
describe('the degraded channels for the banner of the home screen (ST-KERNEL-073)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let counter = 0;
  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function health(member = READER, tenantId = TENANT_A): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = await fetch(`${app.baseUrl}/home/channel-health`, { headers: { [TENANT_HEADER]: tokenOf(member, tenantId) } });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  const channels = (reply: { json: Record<string, unknown> }): Channel[] => reply.json.channels as Channel[];

  async function seed(statements: Array<[string, unknown[]]>): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }
  /** A channel account of a tenant, with the state of its circuit when it has one. */
  async function account(channel: string, circuit?: { state: 'CLOSED' | 'OPEN' | 'HALF_OPEN'; openedAt?: string }, tenant = TENANT_A): Promise<string> {
    counter += 1;
    const accountId = id(FAMILY, 100 + counter);
    const statements: Array<[string, unknown[]]> = [
      [
        `insert into machvon.channel_account (tenant_id, id, channel, external_account_id, credential_secret_ref, capability_version, status, verified_at) values ($1, $2, $3, $4, 'secret://x', '1', 'Active', now())`,
        [tenant, accountId, channel, `ext-${counter}`],
      ],
    ];
    if (circuit !== undefined) {
      statements.push([
        `insert into machvon.channel_account_circuit (tenant_id, channel_account_id, state, opened_at, probe_started_at) values ($1, $2, $3, $4::timestamptz, case when $3 = 'HALF_OPEN' then $4::timestamptz end)`,
        [tenant, accountId, circuit.state, circuit.state === 'CLOSED' ? null : (circuit.openedAt ?? '2027-10-15T02:00:00Z')],
      ]);
    }
    await seed(statements);
    return accountId;
  }
  /** A send on the account that the provider accepted at `acceptedAt` (and that was delivered at `deliveredAt`, when given). */
  async function delivery(accountId: string, channel: string, acceptedAt: string | null, deliveredAt: string | null = null, tenant = TENANT_A): Promise<void> {
    counter += 1;
    await seed([
      [
        `insert into machvon.delivery_attempt (tenant_id, id, notification_id, channel_account_id, attempt_no, status, cost, channel, template_version_id, accepted_at, delivered_at)
         values ($1, $2, $3, $4, 1, $5, 0, $6, $7, $8::timestamptz, $9::timestamptz)`,
        [tenant, id(FAMILY, 5000 + counter), id(FAMILY, 6000 + counter), accountId, deliveredAt === null ? 'ProviderAccepted' : 'Delivered', channel, id(FAMILY, 7), acceptedAt, deliveredAt],
      ],
    ]);
  }
  const wipe = (): Promise<void> => seed([['delete from machvon.delivery_attempt', []], ['delete from machvon.channel_account_circuit', []], ['delete from machvon.channel_account', []]]);

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
    await harness.seedMembership(TENANT_A, READER, ROOT);
    await harness.seedMembership(TENANT_A, NOBODY, ROOT);
    await harness.seedMembership(TENANT_B, B_READER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'HOME_READER', ['home.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'HOME_READER', ['home.read'], 20);
    await harness.seedGrants(TENANT_A, [{ n: 1, member: READER, role: 1, kind: 'TENANT' }]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_READER, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [ChannelHealthController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: HOME_CLOCK, useValue: () => NOW },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  beforeEach(wipe);

  it('is a controller of the HOME module', () => {
    expect(homeModule.controllers).toContain(ChannelHealthController);
  });

  it('AC-ST-KERNEL-073-2 UAT-NFR-AVAILABILITY-04: with the breaker of a channel open, names the channel and the time of its latest successful delivery', async () => {
    const sms = await account('SMS', { state: 'OPEN', openedAt: '2027-10-15T02:30:00Z' });
    await delivery(sms, 'SMS', '2027-10-15T01:00:00Z');
    await delivery(sms, 'SMS', '2027-10-15T02:10:00Z');
    await delivery(sms, 'SMS', '2027-10-14T23:00:00Z');
    const reply = await health();
    expect(reply.status).toBe(200);
    expect(channels(reply)).toEqual([{ channel: 'SMS', state: 'OPEN', open_since: '2027-10-15T02:30:00.000Z', last_delivered_at: '2027-10-15T02:10:00.000Z' }]);
    expect(reply.json.as_of).toBe(NOW.toISOString());
  });

  it('AC-ST-KERNEL-073-2 UAT-NFR-AVAILABILITY-04: says nothing is degraded while every breaker is closed, and when there is no breaker row yet', async () => {
    const email = await account('EMAIL', { state: 'CLOSED' });
    await account('SMS');
    await delivery(email, 'EMAIL', '2027-10-15T02:10:00Z');
    expect(channels(await health())).toEqual([]);
  });

  it('counts a delivery confirmed later than it was accepted, and says null when the channel never delivered', async () => {
    const zalo = await account('ZALO_OA', { state: 'OPEN' });
    await delivery(zalo, 'ZALO_OA', '2027-10-15T01:00:00Z', '2027-10-15T01:45:00Z');
    const push = await account('PUSH_FCM', { state: 'HALF_OPEN', openedAt: '2027-10-15T02:40:00Z' });
    expect(push).not.toBe(zalo);
    const reply = channels(await health());
    expect(reply).toEqual([
      { channel: 'PUSH_FCM', state: 'HALF_OPEN', open_since: '2027-10-15T02:40:00.000Z', last_delivered_at: null },
      { channel: 'ZALO_OA', state: 'OPEN', open_since: '2027-10-15T02:00:00.000Z', last_delivered_at: '2027-10-15T01:45:00.000Z' },
    ]);
  });

  it('shows one entry for a channel with several accounts: open if any account is open, since the earliest opening, with the latest delivery of any of them', async () => {
    const first = await account('SMS', { state: 'HALF_OPEN', openedAt: '2027-10-15T02:20:00Z' });
    const second = await account('SMS', { state: 'OPEN', openedAt: '2027-10-15T02:45:00Z' });
    await account('SMS', { state: 'CLOSED' });
    await delivery(first, 'SMS', '2027-10-15T00:30:00Z');
    await delivery(second, 'SMS', '2027-10-15T02:00:00Z');
    expect(channels(await health())).toEqual([{ channel: 'SMS', state: 'OPEN', open_since: '2027-10-15T02:20:00.000Z', last_delivered_at: '2027-10-15T02:00:00.000Z' }]);
  });

  it('does not count the deliveries of another channel as the last delivery of the degraded one', async () => {
    const sms = await account('SMS', { state: 'OPEN' });
    const email = await account('EMAIL', { state: 'CLOSED' });
    await delivery(email, 'EMAIL', '2027-10-15T02:55:00Z');
    expect(channels(await health())).toEqual([{ channel: 'SMS', state: 'OPEN', open_since: '2027-10-15T02:00:00.000Z', last_delivered_at: null }]);
    expect(sms).not.toBe(email);
  });

  it('shows a tenant only its own channels: the open breaker and the deliveries of another tenant never appear', async () => {
    const own = await account('SMS', { state: 'OPEN' });
    await delivery(own, 'SMS', '2027-10-15T01:00:00Z');
    const other = await account('SMS', { state: 'OPEN', openedAt: '2027-10-15T02:50:00Z' }, TENANT_B);
    await delivery(other, 'SMS', '2027-10-15T02:58:00Z', null, TENANT_B);
    expect(channels(await health())).toEqual([{ channel: 'SMS', state: 'OPEN', open_since: '2027-10-15T02:00:00.000Z', last_delivered_at: '2027-10-15T01:00:00.000Z' }]);
    expect(channels(await health(B_READER, TENANT_B))).toEqual([{ channel: 'SMS', state: 'OPEN', open_since: '2027-10-15T02:50:00.000Z', last_delivered_at: '2027-10-15T02:58:00.000Z' }]);
  });

  it('refuses a person who may not read HOME', async () => {
    await account('SMS', { state: 'OPEN' });
    expect((await health(NOBODY)).status).toBe(403);
  });
});
