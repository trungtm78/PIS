import { randomBytes, randomUUID } from 'node:crypto';
import { OutboxRelay, enqueueOutbox } from '@machvon/db';
import type { OutboxDelivery } from '@machvon/db';
import { Client, Pool } from 'pg';
import { GuestContractClosedConsumer } from '../src/modules/adm/guest-contract-closed.consumer';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId, unitId } from '../../../packages/db/test/support/authz-fixtures';

const RELAY_KEY = randomBytes(32);
const WORKER = '00000000-0000-4000-8000-000000000000';
const CONTRACTOR = id(0x54, 1);
const CONTRACT_A = id(0x53, 21);
const CONTRACT_B = id(0x53, 22);
const GUEST_ROLE = 1;
const MEMBER_ROLE = 2;
const ADMIN = 1;

/** The end of a contract and the guests of its contractor (BR-IAM-08): the access they hold on that contract goes with it (ST-ADM-007, UAT-AC109). */
describe('guest access follows the contract (AC-ST-ADM-007-2)', () => {
  const harness = new AuthzHarness();
  let relayPool: Pool;
  let counter = 10;

  const consumer = (): GuestContractClosedConsumer => new GuestContractClosedConsumer({ database: harness.tenants, security: { signingKey: RELAY_KEY } });

  /** The relay delivers what the outbox holds, to the real consumer. */
  async function relay(): Promise<string[]> {
    const outcomes: string[] = [];
    const real = consumer();
    await new OutboxRelay(relayPool, async (delivery: OutboxDelivery) => void outcomes.push(await real.handle(delivery)), { signingKey: RELAY_KEY }).runOnce();
    return outcomes.filter((outcome) => outcome !== 'ignored');
  }

  const publish = (type: string, contractId: string, tenantId = TENANT_A, payloadTenant = tenantId): Promise<unknown> =>
    harness.tenants.withTenant(contextFor(tenantId, memberId(ADMIN)), (tx) =>
      enqueueOutbox(tx, {
        aggregateType: 'contract',
        aggregateId: contractId,
        aggregateVersion: 1,
        type,
        schemaVersion: 1,
        payload: { tenant_id: payloadTenant, contract_id: contractId, status: type.includes('terminated') ? 'TERMINATED' : 'CLOSED' },
        eventKey: `${type}:${contractId}:${randomUUID()}`,
        correlationId: randomUUID(),
      }),
    );

  async function guest(contracts: readonly string[]): Promise<number> {
    counter += 1;
    const n = counter;
    await harness.seedMembership(TENANT_A, n, 1, { validUntil: '2030-01-01T00:00:00Z' });
    await harness.owner(TENANT_A, [
      [`update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2 where id = $1`, [memberId(n), CONTRACTOR]],
      [
        `insert into machvon.user_session (tenant_id, id, user_account_id, membership_id, idp_session_id, assurance_level, ip_hash, user_agent_summary)
         values ($1, $2, $3, $4, $5, 'aal1', $6, 'test')`,
        [TENANT_A, randomUUID(), id(0x60, n), memberId(n), `idp-${n}`, '0'.repeat(64)],
      ],
    ]);
    await harness.seedGrants(TENANT_A, [
      { n: n * 10, member: n, role: GUEST_ROLE, kind: 'CONTRACT', refs: contracts },
      { n: n * 10 + 1, member: n, role: MEMBER_ROLE, kind: 'CONTRACT', refs: contracts },
    ]);
    return n;
  }

  const statusOf = async (n: number): Promise<{ status: string; scope_version: string }> =>
    (await harness.owner<{ status: string; scope_version: string }>(TENANT_A, [['select status, scope_version::text from machvon.membership where id = $1', [memberId(n)]]])).at(-1) ?? { status: '', scope_version: '' };
  const grantStatuses = async (n: number): Promise<string[]> =>
    (await harness.owner<{ status: string }>(TENANT_A, [['select status from machvon.role_grant where membership_id = $1 order by id', [memberId(n)]]])).map((row) => row.status);
  const liveSessions = async (n: number): Promise<number> =>
    Number((await harness.owner<{ n: string }>(TENANT_A, [['select count(*) as n from machvon.user_session where membership_id = $1 and revoked_at is null', [memberId(n)]]])).at(-1)?.n);
  const events = async (type: string, aggregate: string): Promise<number> =>
    Number((await harness.owner<{ n: string }>(TENANT_A, [['select count(*) as n from machvon.outbox_event where type = $1 and aggregate_id = $2', [type, aggregate]]])).at(-1)?.n);
  const audits = async (action: string): Promise<number> =>
    Number((await harness.owner<{ n: string }>(TENANT_A, [['select count(*) as n from machvon.audit_event where action = $1 and actor_id = $2', [action, WORKER]]])).at(-1)?.n);

  beforeAll(async () => {
    await harness.start();
    relayPool = new Pool({ connectionString: harness.database.urlFor('machvon_outbox_relay'), max: 2 });
    relayPool.on('error', () => undefined);
    await harness.seedUnits(TENANT_A, [{ n: 1, path: `/${unitId(1)}/` }]);
    await harness.seedMembership(TENANT_A, ADMIN, 1);
    // The contractor that the guests belong to; the document of its profile belongs to another module, so the seed runs with foreign keys off.
    const admin = new Client({ connectionString: harness.database.adminUrl });
    await admin.connect();
    try {
      await admin.query('set session_replication_role = replica');
      await admin.query("insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id) values ($1, $2, '0100000001', 'Cao Bang Builders', 'VERIFIED', $3)", [TENANT_A, CONTRACTOR, id(0x55, 1)]);
    } finally {
      await admin.end();
    }
    await harness.seedRole(TENANT_A, GUEST_ROLE, 'GUEST_CONTRACTOR', ['contract.read'], 10);
    await harness.seedRole(TENANT_A, MEMBER_ROLE, 'MEMBER', ['session.read'], 5);
  }, 240_000);

  afterAll(async () => {
    await relayPool?.end();
    await harness.stop();
  }, 60_000);

  it('AC-ST-ADM-007-2 / UAT-AC109: expires the grants of a guest when their contract closes, ends the guest with their sessions, and tells the access to be judged again', async () => {
    const n = await guest([CONTRACT_A]);
    const before = Number((await statusOf(n)).scope_version);
    await publish('ctr.contract.closed.v1', CONTRACT_A);
    expect(await relay()).toEqual(['processed']);
    expect(await grantStatuses(n)).toEqual(['Expired', 'Expired']);
    expect((await statusOf(n)).status).toBe('Ended');
    expect(Number((await statusOf(n)).scope_version)).toBe(before + 1);
    expect(await liveSessions(n)).toBe(0);
    expect(await events('iam.membership.ended.v1', memberId(n))).toBe(1);
    expect(await events('iam.access.changed.v1', memberId(n))).toBe(1);
    expect(await audits('membership.ended_with_contract')).toBeGreaterThanOrEqual(1);
    expect(await audits('role_grant.expired')).toBeGreaterThanOrEqual(2);
  });

  it('treats a terminated contract like a closed one, and a guest of two contracts keeps the other until it ends too', async () => {
    const n = await guest([CONTRACT_B, id(0x53, 23)]);
    await publish('ctr.contract.terminated.v1', CONTRACT_B);
    expect(await relay()).toEqual(['processed']);
    expect(await grantStatuses(n)).toEqual(['Active', 'Active']);
    expect((await statusOf(n)).status).toBe('Active');
    expect(await liveSessions(n)).toBe(1);
    expect(await audits('role_grant.narrowed')).toBeGreaterThanOrEqual(2);
    await publish('ctr.contract.closed.v1', id(0x53, 23));
    expect(await relay()).toEqual(['processed']);
    expect((await statusOf(n)).status).toBe('Ended');
    expect(await liveSessions(n)).toBe(0);
  });

  it('changes nothing when the same event is delivered again, and ignores events that are not about the end of a contract or name another tenant', async () => {
    const contract = id(0x53, 24);
    const n = await guest([contract]);
    const seen: OutboxDelivery[] = [];
    await publish('ctr.contract.closed.v1', contract);
    await new OutboxRelay(relayPool, async (delivery: OutboxDelivery) => void seen.push(delivery), { signingKey: RELAY_KEY }).runOnce();
    const delivery = seen.find((candidate) => candidate.aggregateId === contract) as OutboxDelivery;
    expect(await consumer().handle(delivery)).toBe('processed');
    expect(await consumer().handle(delivery)).toBe('duplicate');
    expect(await events('iam.membership.ended.v1', memberId(n))).toBe(1);
    expect(await consumer().handle({ ...delivery, id: randomUUID(), type: 'ctr.contract.activated.v1' })).toBe('ignored');
    expect(await consumer().handle({ ...delivery, id: randomUUID(), payload: { ...delivery.payload, tenant_id: TENANT_B } })).toBe('ignored');
    await expect(consumer().handle({ ...delivery, id: randomUUID(), payload: { tenant_id: TENANT_A } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('writes no event for a contract that no guest holds', async () => {
    const contract = id(0x53, 25);
    await publish('ctr.contract.closed.v1', contract);
    expect(await relay()).toEqual(['processed']);
    expect(await events('iam.access.changed.v1', contract)).toBe(0);
  });
});
