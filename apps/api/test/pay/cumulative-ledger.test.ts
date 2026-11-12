import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import type { OutboxDelivery } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { payModule } from '../../src/modules/pay';
import { AcceptanceLedgerConsumer, PAY_LEDGER_CHECK_ALERT } from '../../src/modules/pay/acceptance-ledger.consumer';
import { CumulativeLedgerController } from '../../src/modules/pay/cumulative-ledger.controller';
import { SHARED_LEDGER_CACHE } from '../../src/modules/pay/ledger-cache';
import { createOutboxConsumers } from '../../src/workers/outbox-consumers';
import { TENANT_A, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { AcceptanceWorld } from '../../../../packages/db/test/support/acceptance-fixtures';
import type { ApprovedAcceptance } from '../../../../packages/db/test/support/acceptance-fixtures';
import { seedContractor } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(480_000);

const SIGNING_KEY = randomBytes(32);
const RELAY_KEY = randomBytes(32);
const ROOT = 1;
const READER = 11; // ledger.read over the whole tenant
const NOBODY = 12; // no right to the ledger
const ELSEWHERE = 13; // ledger.read over another branch
const OTHER_BRANCH = 5;
const MEMBERS = [READER, NOBODY, ELSEWHERE];
/** The budget of the read of a large ledger, declared here as the story asks: the time of the 95th percentile of the requests, in milliseconds. */
const COLD_P95_MS = 5_000;
const WARM_P95_MS = 1_000;
const LARGE_ROWS = 3_000;

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const percentile = (samples: number[], p: number): number => [...samples].sort((a, b) => a - b)[Math.min(samples.length - 1, Math.ceil(samples.length * p) - 1)]!;

describe('the cumulative ledger over HTTP and the consumer of the acceptance events (ST-PAY-001)', () => {
  const fixtures = new AcceptanceWorld();
  const harness = fixtures.harness;
  let app: RunningApp;
  let guests = 20;
  let grants = 10;
  let contractor = '';
  const raised: Array<{ code: string; context: Record<string, unknown> }> = [];

  const tokenOf = (member: number): string => signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function get(url: string, member: number): Promise<Reply> {
    const response = await fetch(`${app.baseUrl}${url}`, { headers: { [TENANT_HEADER]: tokenOf(member), 'content-type': 'application/json' } });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => fixtures.owner<R>(sql, params);
  const consumer = () => new AcceptanceLedgerConsumer({ database: harness.tenants as TenantDatabase, security: { signingKey: RELAY_KEY, alerts: { raise: (code, context) => void raised.push({ code, context }) } } });
  const delivery = (approved: ApprovedAcceptance, type = 'ctr.acceptance.approved.v1', overrides: Partial<OutboxDelivery> = {}): OutboxDelivery => ({
    id: randomUUID(),
    tenantId: TENANT_A,
    tenantContext: signTenantContext({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, RELAY_KEY),
    type,
    schemaVersion: 1,
    aggregateType: 'acceptance',
    aggregateId: approved.acceptance.id,
    aggregateVersion: 3,
    payload: { tenant_id: TENANT_A, acceptance_id: approved.acceptance.id, contract_id: approved.contract.contractId },
    eventKey: `acceptance:${approved.acceptance.id}:${randomUUID()}`,
    correlationId: randomUUID(),
    attempts: 0,
    ...overrides,
  });
  const entryCount = async (acceptanceId: string) => (await rows<{ n: number }>('select count(*)::int as n from machvon.cumulative_ledger_entry where acceptance_id = $1::uuid', [acceptanceId]))[0]?.n;
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at, id', [aggregateId, type]);

  /** An approved acceptance of two items worth 200,000,000 on a contract of its own. */
  const approvedTwoItems = async (): Promise<ApprovedAcceptance> =>
    fixtures.approve(await fixtures.seedContract(), [
      { item: 0, quantity: '100' },
      { item: 1, quantity: '50' },
    ]);

  /** A guest of the contractor with the right to the ledger over the contract (the grant is as wide as it can be for a guest): the member number. */
  async function guestOf(contractId: string): Promise<number> {
    guests += 1;
    grants += 1;
    await harness.seedMembership(TENANT_A, guests, ROOT);
    await fixtures.owner("update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2::uuid, valid_until = now() + interval '1 year' where id = $1::uuid", [memberId(guests), contractor]);
    await harness.seedGrants(TENANT_A, [{ n: grants, member: guests, role: 101, kind: 'CONTRACT', refs: [contractId] }]);
    return guests;
  }

  beforeAll(async () => {
    await fixtures.start();
    await harness.seedUnits(TENANT_A, [{ n: OTHER_BRANCH, path: `/${unitId(OTHER_BRANCH)}/` }]);
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedRole(TENANT_A, 101, 'LEDGER_READER', ['ledger.read'], 30);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: READER, role: 101, kind: 'TENANT' },
      { n: 2, member: ELSEWHERE, role: 101, kind: 'UNIT_SUBTREE', refs: [unitId(OTHER_BRANCH)] },
    ]);
    contractor = await seedContractor(harness);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [CumulativeLedgerController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 480_000);

  afterAll(async () => {
    if (app) await app.close();
    await fixtures.stop();
  }, 60_000);

  it('is registered in the module of PAY and in the consumers of the outbox', () => {
    expect(payModule.controllers).toEqual(expect.arrayContaining([CumulativeLedgerController]));
    const names = createOutboxConsumers({
      tenants: harness.tenants as TenantDatabase,
      security: { signingKey: RELAY_KEY },
    } as unknown as Parameters<typeof createOutboxConsumers>[0]).map((registered) => registered.name);
    expect(names).toContain('pay-acceptance-ledger');
  });

  describe('the consumer of the acceptance events', () => {
    it('AC-ST-PAY-001-1, UAT-AC322: an approval delivered twice, and told again by another event, leaves exactly one entry for each line, worth the sum of the lines', async () => {
      const approved = await approvedTwoItems();
      const first = delivery(approved);
      expect(await consumer().handle(first)).toBe('processed');
      expect(await consumer().handle(first)).toBe('duplicate');
      expect(await consumer().handle(delivery(approved))).toBe('processed');
      expect(await entryCount(approved.acceptance.id)).toBe(2);
      const balances = await rows<{ accepted_vnd: string; requested_vnd: string }>('select accepted_vnd::text, requested_vnd::text from machvon.cumulative_ledger where acceptance_id = $1::uuid order by accepted_vnd', [approved.acceptance.id]);
      expect(balances.map((row) => row.accepted_vnd)).toEqual(['100000000', '100000000']);
      expect(await rows('select 1 from machvon.integration_event_inbox where provider = $1 and event_key = $2', ['consumer:pay-acceptance-ledger', first.id])).toHaveLength(1);
      // One audit row and one event of PAY for the approval that was acted on, none for the repeats.
      const audits = await rows<{ actor_id: string; safe_diff: Record<string, unknown> }>(
        "select actor_id, safe_diff from machvon.audit_event where resource_id = $1 and action = 'ledger.acceptance_recognized'",
        [approved.contract.contractId],
      );
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ actor_id: WORKER_MEMBERSHIP_ID, safe_diff: { acceptance_id: approved.acceptance.id, entries: 2, accepted_vnd: '200000000' } });
      const told = await events(approved.contract.contractId, 'pay.ledger.acceptance_recognized.v1');
      expect(told).toHaveLength(1);
      expect(told[0]?.payload).toMatchObject({ contract_id: approved.contract.contractId, acceptance_id: approved.acceptance.id, entries: 2, accepted_vnd: '200000000' });
    });

    it('takes a revoked acceptance back once, and does not recognise one that is not approved', async () => {
      const approved = await approvedTwoItems();
      expect(await consumer().handle(delivery(approved))).toBe('processed');
      await fixtures.revoke(approved);
      expect(await consumer().handle(delivery(approved, 'ctr.acceptance.revoked.v1'))).toBe('processed');
      expect(await consumer().handle(delivery(approved, 'ctr.acceptance.revoked.v1'))).toBe('processed');
      expect(await entryCount(approved.acceptance.id)).toBe(4);
      expect((await rows<{ accepted_vnd: string }>('select accepted_vnd::text from machvon.cumulative_ledger where acceptance_id = $1::uuid', [approved.acceptance.id])).map((row) => row.accepted_vnd)).toEqual(['0', '0']);
      expect(await events(approved.contract.contractId, 'pay.ledger.acceptance_revoked.v1')).toHaveLength(1);
      // The approval that arrives after the revocation finds the acceptance revoked and posts nothing.
      expect(await consumer().handle(delivery(approved))).toBe('processed');
      expect(await entryCount(approved.acceptance.id)).toBe(4);
    });

    it('ignores what is not about an acceptance and what another tenant signed, and does not retry what cannot be understood into success', async () => {
      const approved = await approvedTwoItems();
      expect(await consumer().handle(delivery(approved, 'ctr.acceptance.drafted.v1'))).toBe('ignored');
      expect(await consumer().handle(delivery(approved, 'ctr.acceptance.approved.v1', { payload: { tenant_id: randomUUID(), acceptance_id: approved.acceptance.id, contract_id: approved.contract.contractId } }))).toBe('ignored');
      await expect(consumer().handle(delivery(approved, 'ctr.acceptance.approved.v1', { payload: { tenant_id: TENANT_A, acceptance_id: 'x', contract_id: approved.contract.contractId } }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(consumer().handle(delivery(approved, 'ctr.acceptance.approved.v1', { payload: { tenant_id: TENANT_A, acceptance_id: approved.acceptance.id } }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(consumer().handle(delivery(approved, 'ctr.acceptance.approved.v1', { tenantContext: signTenantContext({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, randomBytes(32)) }))).rejects.toMatchObject({ code: 'TENANT_CONTEXT_INVALID' });
      expect(await entryCount(approved.acceptance.id)).toBe(0);
    });

    it('raises the alert when the database had to refuse a rule of the ledger that the store let through, and leaves nothing posted', async () => {
      const approved = await approvedTwoItems();
      raised.length = 0;
      // A balance that already exceeds its rules in the database cannot be made by the store; a trigger-made one stands in for the defect the alert is for.
      await fixtures.owner(
        `create or replace function machvon.pay_test_break() returns trigger language plpgsql as $f$ begin raise exception 'test: cumulative_ledger_nonneg_chk' using errcode = '23514'; end $f$`,
      );
      await fixtures.owner('create trigger pay_test_break before insert on machvon.cumulative_ledger_entry for each row execute function machvon.pay_test_break()');
      try {
        await expect(consumer().handle(delivery(approved))).rejects.toMatchObject({ code: '23514' });
      } finally {
        await fixtures.owner('drop trigger pay_test_break on machvon.cumulative_ledger_entry');
        await fixtures.owner('drop function machvon.pay_test_break()');
      }
      expect(raised).toEqual([{ code: PAY_LEDGER_CHECK_ALERT, context: expect.objectContaining({ tenantId: TENANT_A, acceptanceId: approved.acceptance.id, eventType: 'ctr.acceptance.approved.v1' }) }]);
      expect(await entryCount(approved.acceptance.id)).toBe(0);
      expect(await consumer().handle(delivery(approved))).toBe('processed');
      expect(await entryCount(approved.acceptance.id)).toBe(2);
    });
  });

  describe('reading the ledger', () => {
    it('AC-ST-PAY-001-4, UAT-AC341: gives the staff with the right the balances, entries and totals; a guest of the contractor, a member without the right and a member of another branch get nothing', async () => {
      const approved = await approvedTwoItems();
      await consumer().handle(delivery(approved));
      const url = `/contracts/${approved.contract.contractId}/cumulative-ledger`;
      const read = await get(url, READER);
      expect(read.status).toBe(200);
      expect(read.json).toMatchObject({
        contract: { id: approved.contract.contractId, code: approved.contract.code, contract_value_vnd: '9000000000', accepted_total_vnd: '200000000', advance_outstanding_vnd: '0' },
        total: { accepted_vnd: '200000000', requested_vnd: '0', paid_vnd: '0', advance_recovered_vnd: '0', retention_held_vnd: '0' },
        reconciled: true,
        next_cursor: null,
      });
      const items = read.json.items as Array<Record<string, unknown>>;
      expect(items.map((item) => [item.boq_item_key, item.accepted_vnd])).toEqual(expect.arrayContaining([['B01', '100000000'], ['B02', '100000000']]));
      expect((items[0]!.entries as Array<Record<string, unknown>>)[0]).toMatchObject({ kind: 'RECOGNIZE_ACCEPTANCE', accepted_delta_vnd: '100000000', reversal_of_id: null });
      // Whoever lacks the right, or holds it elsewhere, or is a guest of the contractor even with the right, gets no ledger field.
      expect(await get(url, NOBODY)).toMatchObject({ status: 403 });
      expect(await get(url, ELSEWHERE)).toMatchObject({ status: 404 });
      const guest = await guestOf(approved.contract.contractId);
      const refused = await get(url, guest);
      expect(refused).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect(JSON.stringify(refused.json)).not.toContain('accepted_vnd');
      expect(await get(`/contracts/${randomUUID()}/cumulative-ledger`, READER)).toMatchObject({ status: 404 });
      expect(await get(`${url}?boq_item_id=x`, READER)).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await get(`${url}?acceptance_id=x`, READER)).toMatchObject({ status: 422 });
      expect(await get(`${url}?limit=0`, READER)).toMatchObject({ status: 422 });
    });

    it('filters by item and acceptance and pages with a cursor', async () => {
      const approved = await approvedTwoItems();
      await consumer().handle(delivery(approved));
      const url = `/contracts/${approved.contract.contractId}/cumulative-ledger`;
      const one = await get(`${url}?limit=1`, READER);
      expect(one.status).toBe(200);
      expect(one.json.items).toHaveLength(1);
      expect(typeof one.json.next_cursor).toBe('string');
      const two = await get(`${url}?limit=1&cursor=${encodeURIComponent(one.json.next_cursor as string)}`, READER);
      expect((two.json.items as Array<{ id: string }>)[0]?.id).not.toBe((one.json.items as Array<{ id: string }>)[0]?.id);
      expect(two.json.next_cursor).toBeNull();
      const filtered = await get(`${url}?boq_item_id=${approved.contract.items[0]}&acceptance_id=${approved.acceptance.id}`, READER);
      expect((filtered.json.items as Array<{ boq_item_id: string }>).map((item) => item.boq_item_id)).toEqual([approved.contract.items[0]]);
      expect(filtered.json.total).toMatchObject({ accepted_vnd: '100000000' });
    });

    it('keeps a page by the version of the contract: a change moves the version and shows at once, and a pay.* event drops what is kept', async () => {
      const approved = await approvedTwoItems();
      await consumer().handle(delivery(approved));
      const url = `/contracts/${approved.contract.contractId}/cumulative-ledger`;
      const before = await get(url, READER);
      expect(SHARED_LEDGER_CACHE.size).toBeGreaterThan(0);
      // Behind the cache: the contract is changed without a new version, as another process might between events.
      await fixtures.owner('update machvon.cumulative_ledger set updated_by = updated_by where acceptance_id = $1::uuid', [approved.acceptance.id]);
      await fixtures.owner('update machvon.contract set paid_total_vnd = 0, retention_released_vnd = 0 where id = $1::uuid', [approved.contract.contractId]);
      expect((await get(url, READER)).json.as_of).not.toBe(before.json.as_of);
      expect(((await get(url, READER)).json.contract as { version: number }).version).toBe((before.json.contract as { version: number }).version);
      // An event of PAY about the contract empties what the cache keeps for it.
      const prefix = `t:${TENANT_A}:pay:ledger:${approved.contract.contractId}:`;
      const keys = () => [...(SHARED_LEDGER_CACHE as unknown as { entries: Map<string, unknown> }).entries.keys()].filter((key) => key.startsWith(prefix));
      expect(keys().length).toBeGreaterThan(0);
      expect(keys()[0]).toMatch(new RegExp(`^${prefix}v[0-9]+:`));
      await consumer().handle(delivery(approved, 'pay.ledger.acceptance_recognized.v1'));
      expect(keys()).toEqual([]);
      // A revocation moves the version of the contract, so the next read is a different page.
      await fixtures.revoke(approved);
      await consumer().handle(delivery(approved, 'ctr.acceptance.revoked.v1'));
      const after = await get(url, READER);
      expect((after.json.contract as { version: number }).version).toBeGreaterThan((before.json.contract as { version: number }).version);
      expect(after.json.total).toMatchObject({ accepted_vnd: '0' });
    });

    it('AC-ST-PAY-001-3, UAT-AC343: reads a ledger of thousands of rows within the budget, cold and warm, and the warm read comes from the cache', async () => {
      const contract = await fixtures.seedContract();
      const approved = await fixtures.approve(contract, [{ item: 0, quantity: '1' }]);
      await fixtures.owner(
        `insert into machvon.boq_item (tenant_id, id, contract_id, business_key, description, unit_code, created_by, updated_by)
         select $1, gen_random_uuid(), $2::uuid, 'L' || lpad(g::text, 5, '0'), 'Bulk item ' || g, 'M3', $3::uuid, $3::uuid from generate_series(1, $4::int) as g`,
        [TENANT_A, contract.contractId, memberId(1), LARGE_ROWS],
      );
      // The ledger rows and their entries are written the way the store writes them, in one transaction, so the sum of each balance is the sum of its entries at the commit.
      await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(1), scopeVersion: 1 }, async (tx) => {
        await tx.query(
          `insert into machvon.cumulative_ledger (tenant_id, id, contract_id, boq_item_id, acceptance_id, accepted_vnd, created_by, updated_by)
           select tenant_id, gen_random_uuid(), contract_id, id, $2::uuid, 1000, $3::uuid, $3::uuid from machvon.boq_item where contract_id = $1::uuid and business_key like 'L%'`,
          [contract.contractId, approved.acceptance.id, memberId(1)],
        );
        await tx.query(
          `insert into machvon.cumulative_ledger_entry (tenant_id, id, ledger_id, contract_id, boq_item_id, acceptance_id, entry_kind, accepted_delta_vnd, advance_outstanding_after_vnd, request_id, created_by)
           select tenant_id, gen_random_uuid(), id, contract_id, boq_item_id, acceptance_id, 'RECOGNIZE_ACCEPTANCE', 1000, 0, gen_random_uuid(), created_by from machvon.cumulative_ledger where contract_id = $1::uuid`,
          [contract.contractId],
        );
      });
      const url = `/contracts/${contract.contractId}/cumulative-ledger`;
      const cold: number[] = [];
      const warm: number[] = [];
      // A different page size is a different question, so each cold read misses the cache; each warm read repeats a question that was asked.
      for (let n = 0; n < 20; n += 1) {
        const started = performance.now();
        const reply = await get(`${url}?limit=${100 + n}`, READER);
        cold.push(performance.now() - started);
        expect(reply.status).toBe(200);
        expect(reply.json.items).toHaveLength(100 + n);
      }
      for (let n = 0; n < 60; n += 1) {
        const started = performance.now();
        const reply = await get(`${url}?limit=${100 + (n % 20)}`, READER);
        warm.push(performance.now() - started);
        expect(reply.status).toBe(200);
      }
      expect((await get(url, READER)).json.total).toMatchObject({ accepted_vnd: String(1000 * LARGE_ROWS) });
      expect(percentile(cold, 0.95)).toBeLessThan(COLD_P95_MS);
      expect(percentile(warm, 0.95)).toBeLessThan(WARM_P95_MS);
      // A cached read is not slower than an uncached one; the medians of two short runs of a few milliseconds differ by noise, so half as much again is allowed before it counts as slower.
      expect(percentile(warm, 0.5)).toBeLessThanOrEqual(percentile(cold, 0.5) * 1.5);
    });
  });
});
