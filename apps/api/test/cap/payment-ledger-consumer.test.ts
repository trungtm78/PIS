import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { WORKER_MEMBERSHIP_ID } from '@machvon/db';
import type { OutboxDelivery, TenantDatabase } from '@machvon/db';
import { signTenantContext } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { createOutboxConsumers } from '../../src/workers/outbox-consumers';
import {
  CAP_LEDGER_CHECK_ALERT,
  CAP_LEDGER_POSTED_EVENT,
  CAP_PAYMENT_LEDGER_CONSUMER,
  CAP_POSTING_METRIC,
  PAYMENT_CANCELLED_EVENT,
  PAYMENT_RETURNED_EVENT,
  PAYMENT_REVERSED_EVENT,
  PAYMENT_SETTLED_EVENT,
  PAYMENT_SUBMITTED_EVENT,
  PaymentLedgerConsumer,
} from '../../src/modules/cap/payment-ledger.consumer';
import { TENANT_A, memberId } from '../../../../packages/db/test/support/authz-fixtures';
import { CapWorld, PUBLISHER } from '../../../../packages/db/test/support/cap-fixtures';
import type { PublishedLine } from '../../../../packages/db/test/support/cap-fixtures';
import { seedPaymentRequest } from '../../../../packages/db/test/support/pay-fixtures';

const RELAY_KEY = randomBytes(32);
const SETTLED_AT = '2026-07-25T05:00:00.000Z';
const REFUNDED_AT = '2026-07-30T03:00:00.000Z';

describe('the consumer of the payment events on the capital ledger (ST-CAP-006)', () => {
  const world = new CapWorld();
  const raised: Array<{ code: string; context: Record<string, unknown> }> = [];
  const counted: Array<{ name: string; labels: Record<string, string> | undefined }> = [];
  const metrics: MetricsSink = { increment: (name, labels) => void counted.push({ name, labels }), gauge: () => undefined };
  const consumer = () => new PaymentLedgerConsumer({ database: world.harness.tenants as TenantDatabase, metrics, security: { signingKey: RELAY_KEY, alerts: { raise: (code, context) => void raised.push({ code, context }) } } });

  beforeAll(() => world.start(), 240_000);
  afterAll(() => world.stop(), 60_000);
  jest.setTimeout(240_000);

  const delivery = (type: string, payload: Record<string, unknown>, overrides: Partial<OutboxDelivery> = {}): OutboxDelivery => ({
    id: randomUUID(),
    tenantId: TENANT_A,
    tenantContext: signTenantContext({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, RELAY_KEY),
    type,
    schemaVersion: type === PAYMENT_SETTLED_EVENT ? 2 : 1,
    aggregateType: 'payment_request',
    aggregateId: String(payload.payment_request_id ?? randomUUID()),
    aggregateVersion: 3,
    payload: { tenant_id: TENANT_A, ...payload },
    eventKey: `payment_request:${randomUUID()}`,
    correlationId: randomUUID(),
    attempts: 0,
    ...overrides,
  });

  interface Case {
    id: string;
    contractId: string;
    line: PublishedLine;
  }
  async function request(line: PublishedLine, net: string, status = 'SUBMITTED'): Promise<Case> {
    const id = randomUUID();
    const contractId = randomUUID();
    await seedPaymentRequest(world.harness.database.adminUrl, TENANT_A, { id, project: line.projectId, contract: contractId, acceptance: randomUUID(), status, netVnd: net, allocationLine: line.lineId, planYear: line.year });
    return { id, contractId, line };
  }
  async function moveTo(item: Case, status: string): Promise<void> {
    const client = new Client({ connectionString: world.harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      const settled = status === 'SETTLED';
      await client.query(
        `update machvon.payment_request set status = $2, claims_acceptance = $3, settled_transaction_id = case when $4 then gen_random_uuid() else null end,
                treasury_paid_on = case when $4 then date '2026-07-25' else null end, settled_by = case when $4 then $5::uuid else null end, settled_at = case when $4 then now() else null end,
                cancel_reason = case when $2 = 'CANCELLED' then 'Cancelled by the maker' else null end where id = $1::uuid`,
        [item.id, status, ['SUBMITTED', 'VERIFIED', 'SENT_TREASURY', 'SETTLED'].includes(status), settled, memberId(PUBLISHER)],
      );
    } finally {
      await client.end();
    }
  }
  const facts = (item: Case, net: string) => ({ payment_request_id: item.id, contract_id: item.contractId, allocation_line_id: item.line.lineId, plan_year: item.line.year, net_vnd: net });

  it('is registered among the consumers of the outbox', () => {
    const names = createOutboxConsumers({ tenants: world.harness.tenants as TenantDatabase, security: { signingKey: RELAY_KEY } } as unknown as Parameters<typeof createOutboxConsumers>[0]).map((registered) => registered.name);
    expect(names).toContain(CAP_PAYMENT_LEDGER_CONSUMER);
    expect(consumer().name).toBe(CAP_PAYMENT_LEDGER_CONSUMER);
  });

  it('posts the sending, the payment and the reversal of one request, once each however often the events are delivered (UAT-PLAN-01)', async () => {
    const line = await world.publishedLine({ allocated: '1000' });
    const item = await request(line, '400');
    const sent = delivery(PAYMENT_SUBMITTED_EVENT, facts(item, '400'));
    expect(await consumer().handle(sent)).toBe('processed');
    expect(await consumer().handle(sent)).toBe('duplicate');
    // The same fact in another delivery (the relay delivered the event twice with two ids) posts nothing more.
    expect(await consumer().handle(delivery(PAYMENT_SUBMITTED_EVENT, facts(item, '400')))).toBe('processed');
    expect(await world.balanceOf(line.balanceId)).toMatchObject({ committed: '400', disbursed: '0' });

    await moveTo(item, 'SETTLED');
    const transactionId = randomUUID();
    const settled = delivery(PAYMENT_SETTLED_EVENT, { payment_request_id: item.id, contract_id: item.contractId, allocation_line_id: line.lineId, plan_year: line.year, amount_vnd: '400', transaction_id: transactionId, confirmed_at: SETTLED_AT, treasury_paid_on: '2026-07-25' });
    expect(await consumer().handle(settled)).toBe('processed');
    expect(await consumer().handle(settled)).toBe('duplicate');
    expect(await world.balanceOf(line.balanceId)).toMatchObject({ committed: '0', disbursed: '400' });

    const reversed = delivery(PAYMENT_REVERSED_EVENT, {
      payment_request_id: item.id,
      contract_id: item.contractId,
      allocation_line_id: line.lineId,
      plan_year: line.year,
      amount_vnd: '400',
      settled_transaction_id: transactionId,
      refund_transaction_id: randomUUID(),
      refund_confirmed_at: REFUNDED_AT,
    });
    expect(await consumer().handle(reversed)).toBe('processed');
    expect(await consumer().handle(reversed)).toBe('duplicate');
    expect(await world.balanceOf(line.balanceId)).toMatchObject({ committed: '0', disbursed: '0' });

    const entries = await world.owner<{ entry_type: string }>("select entry_type from machvon.capital_ledger_entry where allocation_line_id = $1::uuid and entry_type not in ('ALLOCATE') order by posted_at, entry_type", [line.lineId]);
    expect(entries.map((entry) => entry.entry_type).sort()).toEqual(['COMMIT', 'DISBURSE', 'REVERSAL', 'UNCOMMIT']);
    // One audit row and one event for each posting that moved something, in the name of the system.
    const audits = await world.owner<{ actor_id: string }>("select actor_id from machvon.audit_event where action = 'capital_ledger.payment_posted' and resource_id = $1", [item.id]);
    expect(audits).toHaveLength(3);
    expect(audits.every((row) => row.actor_id === WORKER_MEMBERSHIP_ID)).toBe(true);
    const events = await world.owner<{ payload: { entries: Array<{ entry_type: string }>; source_event_type: string } }>('select payload from machvon.outbox_event where type = $1 and aggregate_id = $2::uuid order by created_at', [CAP_LEDGER_POSTED_EVENT, item.id]);
    expect(events.map((event) => event.payload.source_event_type)).toEqual([PAYMENT_SUBMITTED_EVENT, PAYMENT_SETTLED_EVENT, PAYMENT_REVERSED_EVENT]);
    expect(events[1]?.payload.entries.map((entry) => entry.entry_type)).toEqual(['UNCOMMIT', 'DISBURSE']);
    expect(counted).toContainEqual({ name: CAP_POSTING_METRIC, labels: { event: PAYMENT_SETTLED_EVENT, outcome: 'posted' } });
    expect(counted).toContainEqual({ name: CAP_POSTING_METRIC, labels: { event: PAYMENT_SUBMITTED_EVENT, outcome: 'unchanged' } });
  });

  it('gives the commitment back for a request that is returned and for one that is cancelled', async () => {
    const line = await world.publishedLine({ allocated: '1000' });
    const returned = await request(line, '100');
    const cancelled = await request(line, '200');
    await consumer().handle(delivery(PAYMENT_SUBMITTED_EVENT, facts(returned, '100')));
    await consumer().handle(delivery(PAYMENT_SUBMITTED_EVENT, facts(cancelled, '200')));
    expect((await world.balanceOf(line.balanceId)).committed).toBe('300');
    await moveTo(returned, 'RETURNED');
    await moveTo(cancelled, 'CANCELLED');
    expect(await consumer().handle(delivery(PAYMENT_RETURNED_EVENT, facts(returned, '100')))).toBe('processed');
    expect(await consumer().handle(delivery(PAYMENT_CANCELLED_EVENT, facts(cancelled, '200')))).toBe('processed');
    expect((await world.balanceOf(line.balanceId)).committed).toBe('0');
  });

  it('leaves alone the events that are not its own, the ones of another tenant or version, and the ones of a request on no line', async () => {
    const line = await world.publishedLine({ allocated: '1000' });
    const item = await request(line, '100');
    const own = facts(item, '100');
    expect(await consumer().handle(delivery('pay.payment_request.verified.v1', own))).toBe('ignored');
    expect(await consumer().handle(delivery(PAYMENT_SUBMITTED_EVENT, own, { schemaVersion: 2 }))).toBe('ignored');
    expect(await consumer().handle(delivery(PAYMENT_SETTLED_EVENT, own, { schemaVersion: 1 }))).toBe('ignored');
    expect(await consumer().handle(delivery(PAYMENT_SUBMITTED_EVENT, { ...own, tenant_id: randomUUID() }))).toBe('ignored');
    expect(await consumer().handle(delivery(PAYMENT_SUBMITTED_EVENT, { ...own, allocation_line_id: null }))).toBe('ignored');
    expect(counted).toContainEqual({ name: CAP_POSTING_METRIC, labels: { event: PAYMENT_SUBMITTED_EVENT, outcome: 'no_line' } });
    expect((await world.balanceOf(line.balanceId)).committed).toBe('0');
  });

  it('fails a delivery whose payload is not well formed, whose context is forged or whose line cannot take it, and leaves no entry', async () => {
    const line = await world.publishedLine({ allocated: '100' });
    const item = await request(line, '100');
    const own = facts(item, '100');
    await expect(consumer().handle(delivery(PAYMENT_SUBMITTED_EVENT, { ...own, net_vnd: '10.5' }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(consumer().handle(delivery(PAYMENT_SUBMITTED_EVENT, { ...own, payment_request_id: 'x' }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(consumer().handle(delivery(PAYMENT_SETTLED_EVENT, { ...own, amount_vnd: '100', transaction_id: randomUUID(), confirmed_at: 'yesterday' }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(consumer().handle(delivery(PAYMENT_SUBMITTED_EVENT, own, { tenantContext: signTenantContext({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, randomBytes(32)) }))).rejects.toMatchObject({ code: 'TENANT_CONTEXT_INVALID' });
    // A line that cannot take the net is refused whole: no entry and no inbox row, so the relay tries it again.
    const other = await request(line, '100');
    await consumer().handle(delivery(PAYMENT_SUBMITTED_EVENT, own));
    const refused = delivery(PAYMENT_SUBMITTED_EVENT, facts(other, '100'));
    await expect(consumer().handle(refused)).rejects.toMatchObject({ code: 'BALANCE_INSUFFICIENT', status: 409 });
    expect((await world.owner("select 1 from machvon.capital_ledger_entry where allocation_line_id = $1::uuid and entry_type = 'COMMIT'", [line.lineId])).length).toBe(1);
    expect(await world.owner("select 1 from machvon.integration_event_inbox where event_key = $1", [refused.id])).toEqual([]);
  });

  it('raises the alert when the database refuses a rule of the ledger, and lets the failure through', async () => {
    const failing = {
      withTenant: async () => {
        throw Object.assign(new Error('check violated'), { code: '23514' });
      },
    } as unknown as TenantDatabase;
    const rogue = new PaymentLedgerConsumer({ database: failing, security: { signingKey: RELAY_KEY, alerts: { raise: (code, context) => void raised.push({ code, context }) } } });
    const line = await world.publishedLine({ allocated: '100' });
    const item = await request(line, '10');
    const event = delivery(PAYMENT_SUBMITTED_EVENT, facts(item, '10'));
    await expect(rogue.handle(event)).rejects.toMatchObject({ code: '23514' });
    expect(raised).toContainEqual({ code: CAP_LEDGER_CHECK_ALERT, context: { tenantId: TENANT_A, eventType: PAYMENT_SUBMITTED_EVENT, eventId: event.id } });
  });
});
