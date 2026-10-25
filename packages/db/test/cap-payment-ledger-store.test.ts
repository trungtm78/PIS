import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { vietnamDateOf } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { AuditWriter } from '../src/audit-writer';
import { CapAvailabilityStore } from '../src/cap-availability-store';
import { CAP_BALANCE_DRIFT_EVENT, CAP_BALANCE_DRIFT_METRIC, CapBalanceReconcileJob } from '../src/cap-balance-reconcile-job';
import { CapPaymentLedgerStore } from '../src/cap-payment-ledger-store';
import type { DisbursementFacts, PaymentFacts, ReversalFacts } from '../src/cap-payment-ledger-store';
import { WORKER_MEMBERSHIP_ID } from '../src/consumer-inbox';
import { CapWorld, PUBLISHER } from './support/cap-fixtures';
import type { PublishedLine } from './support/cap-fixtures';
import { memberId, TENANT_A } from './support/authz-fixtures';
import { seedPaymentRequest } from './support/pay-fixtures';

const world = new CapWorld();
const ledger = new CapPaymentLedgerStore();
const availability = new CapAvailabilityStore();
const ACTOR = WORKER_MEMBERSHIP_ID;
const SETTLED_AT = '2026-07-25T05:00:00.000Z';
const REFUNDED_AT = '2026-07-30T03:00:00.000Z';

interface Refusal {
  code: string;
  status: number;
  extensions?: Record<string, unknown>;
}

async function refusal(work: Promise<unknown>): Promise<Refusal> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

interface Request {
  id: string;
  contractId: string;
  line: PublishedLine;
  net: string;
}

/** A payment request of a contract on the line, in the status given (the foreign keys to the contract and the acceptance are off, as for the other stories that only read them). */
async function request(line: PublishedLine, net: string, status = 'SUBMITTED', contractId: string = randomUUID()): Promise<Request> {
  const id = randomUUID();
  await seedPaymentRequest(world.harness.database.adminUrl, TENANT_A, { id, project: line.projectId, contract: contractId, acceptance: randomUUID(), status, netVnd: net, allocationLine: line.lineId, planYear: line.year });
  return { id, contractId, line, net };
}

/** The status the request is in now (the consumer judges by it, not by the order of the events). */
async function moveTo(item: Request, status: string): Promise<void> {
  const client = new Client({ connectionString: world.harness.database.adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    const settled = status === 'SETTLED';
    await client.query(
      `update machvon.payment_request
          set status = $2, claims_acceptance = $3, settled_transaction_id = case when $4 then gen_random_uuid() else null end,
              treasury_paid_on = case when $4 then date '2026-07-25' else null end, settled_by = case when $4 then $5::uuid else null end, settled_at = case when $4 then now() else null end
        where id = $1::uuid`,
      [item.id, status, ['SUBMITTED', 'VERIFIED', 'SENT_TREASURY', 'SETTLED'].includes(status), settled, memberId(PUBLISHER)],
    );
  } finally {
    await client.end();
  }
}

const facts = (item: Request): PaymentFacts => ({ paymentRequestId: item.id, contractId: item.contractId, allocationLineId: item.line.lineId, planYear: undefined, amountVnd: item.net });
const settleFacts = (item: Request, transactionId: string = randomUUID()): DisbursementFacts => ({ ...facts(item), transactionId, confirmedAt: SETTLED_AT });
const reverseFacts = (item: Request, settledTransactionId: string, refundTransactionId: string = randomUUID()): ReversalFacts => ({
  ...facts(item),
  settledTransactionId,
  refundTransactionId,
  refundConfirmedAt: REFUNDED_AT,
});

const commit = (item: Request) => world.as((tx) => ledger.commit(tx, facts(item), ACTOR), PUBLISHER);
const release = (item: Request) => world.as((tx) => ledger.release(tx, facts(item), ACTOR), PUBLISHER);
const disburse = (item: Request, transactionId?: string) => world.as((tx) => ledger.disburse(tx, settleFacts(item, transactionId), ACTOR), PUBLISHER);
const reverse = (item: Request, settledTransactionId: string, refundTransactionId?: string) => world.as((tx) => ledger.reverse(tx, reverseFacts(item, settledTransactionId, refundTransactionId), ACTOR), PUBLISHER);

interface EntryView {
  entry_type: string;
  amount: string;
  source_ref_kind: string;
  seq: number;
  reversal_of_id: string | null;
  posted_at: string;
}
const entriesOf = (line: PublishedLine) =>
  world.owner<EntryView>(
    `select entry_type, amount_vnd::text as amount, source_ref_kind, source_ref_seq::int as seq, reversal_of_id, to_char(posted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as posted_at
       from machvon.capital_ledger_entry where allocation_line_id = $1::uuid and entry_type in ('COMMIT', 'UNCOMMIT', 'DISBURSE', 'REVERSAL') order by posted_at, entry_type`,
    [line.lineId],
  );
const typesOf = async (line: PublishedLine): Promise<string[]> => (await entriesOf(line)).map((entry) => entry.entry_type).sort();
const figures = async (line: PublishedLine): Promise<{ allocated: string; committed: string; disbursed: string }> => {
  const { allocated, committed, disbursed } = await world.balanceOf(line.balanceId);
  return { allocated, committed, disbursed };
};

beforeAll(() => world.start(), 240_000);
afterAll(() => world.stop(), 60_000);
jest.setTimeout(240_000);

describe('CapPaymentLedgerStore: a request that commits capital of its own (AC-ST-CAP-006-1, UAT-PLAN-01)', () => {
  it('commits at the sending, turns the commitment into a disbursement dated by the Treasury and takes the disbursement back on the refund, each fact once', async () => {
    const line = await world.publishedLine({ allocated: '1000' });
    const item = await request(line, '400');

    const sent = await commit(item);
    expect(sent.outcome).toBe('posted');
    expect(sent.entries).toMatchObject([{ type: 'COMMIT', amountVnd: '400' }]);
    expect(await figures(line)).toEqual({ allocated: '1000', committed: '400', disbursed: '0' });
    expect((await commit(item)).outcome).toBe('unchanged');

    await moveTo(item, 'SETTLED');
    const transaction = randomUUID();
    const paid = await disburse(item, transaction);
    expect(paid.entries.map((entry) => entry.type)).toEqual(['UNCOMMIT', 'DISBURSE']);
    expect(await figures(line)).toEqual({ allocated: '1000', committed: '0', disbursed: '400' });
    const disbursement = (await entriesOf(line)).find((entry) => entry.entry_type === 'DISBURSE');
    expect(disbursement).toMatchObject({ amount: '400', source_ref_kind: 'TREASURY_TRANSACTION', posted_at: SETTLED_AT });
    expect(vietnamDateOf(new Date(disbursement?.posted_at ?? ''))).toBe('2026-07-25');
    // The delivery comes again, and again with the transaction written differently: nothing is added.
    expect((await disburse(item, transaction)).outcome).toBe('unchanged');
    expect(await refusal(world.as((tx) => ledger.disburse(tx, { ...settleFacts(item, transaction), amountVnd: '401' }, ACTOR), PUBLISHER))).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 });

    const refund = randomUUID();
    const reversed = await reverse(item, transaction, refund);
    expect(reversed.entries.map((entry) => entry.type)).toEqual(['REVERSAL']);
    expect(await figures(line)).toEqual({ allocated: '1000', committed: '0', disbursed: '0' });
    const entries = await entriesOf(line);
    const undo = entries.find((entry) => entry.entry_type === 'REVERSAL');
    expect(undo).toMatchObject({ amount: '400', source_ref_kind: 'TREASURY_TRANSACTION', posted_at: REFUNDED_AT, reversal_of_id: expect.any(String) });
    expect((await reverse(item, transaction, refund)).outcome).toBe('unchanged');
    expect(await typesOf(line)).toEqual(['COMMIT', 'DISBURSE', 'REVERSAL', 'UNCOMMIT']);
  });

  it('gives the commitment back when the request is returned, commits again when it is sent again and settles from the second commitment', async () => {
    const line = await world.publishedLine({ allocated: '1000' });
    const item = await request(line, '300');
    await commit(item);
    await moveTo(item, 'RETURNED');
    const returned = await release(item);
    expect(returned.entries).toMatchObject([{ type: 'UNCOMMIT', amountVnd: '300' }]);
    expect(await figures(line)).toMatchObject({ committed: '0' });
    expect((await release(item)).outcome).toBe('unchanged');
    // A request that is sent again is the same request: the second commitment is another posting of the same fact.
    await moveTo(item, 'SUBMITTED');
    expect((await commit(item)).outcome).toBe('posted');
    expect(await figures(line)).toMatchObject({ committed: '300' });
    await moveTo(item, 'SETTLED');
    await disburse(item);
    expect(await figures(line)).toEqual({ allocated: '1000', committed: '0', disbursed: '300' });
    expect((await entriesOf(line)).filter((entry) => entry.entry_type === 'COMMIT').map((entry) => entry.seq)).toEqual([0, 1]);
    expect((await entriesOf(line)).filter((entry) => entry.entry_type === 'UNCOMMIT').map((entry) => entry.seq)).toEqual([0, 1]);
  });

  it('judges by the state the request is in now, so an event that comes late changes nothing', async () => {
    const line = await world.publishedLine({ allocated: '1000' });
    const item = await request(line, '200', 'RETURNED');
    expect((await commit(item)).outcome).toBe('stale');
    await moveTo(item, 'SUBMITTED');
    expect((await release(item)).outcome).toBe('stale');
    await moveTo(item, 'SENT_TREASURY');
    expect((await disburse(item)).outcome).toBe('stale');
    expect(await entriesOf(line)).toEqual([]);
    expect(await figures(line)).toMatchObject({ committed: '0', disbursed: '0' });
  });

  it('commits first when the payment is read before the sending, so the ledger tells the whole story and no balance goes below nothing', async () => {
    const line = await world.publishedLine({ allocated: '1000' });
    const item = await request(line, '250', 'SETTLED');
    const paid = await disburse(item);
    expect(paid.entries.map((entry) => entry.type)).toEqual(['COMMIT', 'UNCOMMIT', 'DISBURSE']);
    expect(await figures(line)).toEqual({ allocated: '1000', committed: '0', disbursed: '250' });
    // The event of the sending, read late, finds a request that is paid and posts nothing.
    expect((await commit(item)).outcome).toBe('stale');
  });
});

describe('CapPaymentLedgerStore: a request paid out of the commitment of its contract', () => {
  it('commits nothing at the sending, pays out of the commitment and commits the amount again on a reversal (the acceptance is owed again)', async () => {
    const line = await world.publishedLine({ allocated: '1000' });
    const contractId = randomUUID();
    await world.as((tx) => availability.checkAndCommit(tx, { allocationLineId: line.lineId, amountVnd: '600', sourceKind: 'CONTRACT', sourceId: contractId, acknowledgeWarning: true }, memberId(PUBLISHER)), PUBLISHER);
    const item = await request(line, '400', 'SUBMITTED', contractId);

    expect((await commit(item)).outcome).toBe('covered');
    expect(await figures(line)).toEqual({ allocated: '1000', committed: '600', disbursed: '0' });
    expect((await release(item)).outcome).toBe('stale');

    await moveTo(item, 'SETTLED');
    const transaction = randomUUID();
    expect((await disburse(item, transaction)).entries.map((entry) => entry.type)).toEqual(['UNCOMMIT', 'DISBURSE']);
    expect(await figures(line)).toEqual({ allocated: '1000', committed: '200', disbursed: '400' });

    const undone = await reverse(item, transaction);
    expect(undone.entries.map((entry) => entry.type)).toEqual(['REVERSAL', 'REVERSAL']);
    expect(await figures(line)).toEqual({ allocated: '1000', committed: '600', disbursed: '0' });
    const reversals = (await entriesOf(line)).filter((entry) => entry.entry_type === 'REVERSAL');
    expect(reversals.map((entry) => entry.source_ref_kind).sort()).toEqual(['PAYMENT_REQUEST', 'TREASURY_TRANSACTION']);
    expect((await reverse(item, transaction)).outcome).toBe('unchanged');
  });
});

describe('CapPaymentLedgerStore: what it refuses', () => {
  it('refuses a payment read before its refund can be, an amount that is not the one disbursed and a line that is not in force', async () => {
    const line = await world.publishedLine({ allocated: '1000' });
    const item = await request(line, '100', 'SETTLED');
    expect(await refusal(reverse(item, randomUUID()))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    const transaction = randomUUID();
    await disburse(item, transaction);
    expect(await refusal(world.as((tx) => ledger.reverse(tx, { ...reverseFacts(item, transaction), amountVnd: '99' }, ACTOR), PUBLISHER))).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 });
    expect(await refusal(world.as((tx) => ledger.commit(tx, { ...facts(item), allocationLineId: randomUUID() }, ACTOR), PUBLISHER))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    expect(await refusal(world.as((tx) => ledger.commit(tx, { ...facts(item), amountVnd: '0' }, ACTOR), PUBLISHER))).toMatchObject({ status: 422 });
    expect(await refusal(world.as((tx) => ledger.commit(tx, { ...facts(item), paymentRequestId: randomUUID() }, ACTOR), PUBLISHER))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
  });

});

describe('CapPaymentLedgerStore: two postings on one balance (AC-ST-CAP-006-2, UAT-NFR-SECURITY-09)', () => {
  it('posts exactly one of two commitments of 100 that race on a balance of 100, and the other leaves no entry', async () => {
    const line = await world.publishedLine({ allocated: '100' });
    const first = await request(line, '100');
    const second = await request(line, '100');
    const outcomes = await Promise.allSettled([commit(first), commit(second)]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const failed = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    expect(failed?.reason).toMatchObject({ code: 'BALANCE_INSUFFICIENT', status: 409 });
    expect(await figures(line)).toEqual({ allocated: '100', committed: '100', disbursed: '0' });
    expect(await entriesOf(line)).toHaveLength(1);
  });

  it('settles two payments that race on the same commitment one after the other, never past the balance', async () => {
    const line = await world.publishedLine({ allocated: '100' });
    const first = await request(line, '60');
    const second = await request(line, '40');
    await commit(first);
    await commit(second);
    await moveTo(first, 'SETTLED');
    await moveTo(second, 'SETTLED');
    await Promise.all([disburse(first), disburse(second)]);
    expect(await figures(line)).toEqual({ allocated: '100', committed: '0', disbursed: '100' });
  });
});

describe('CapBalanceReconcileJob (AC-ST-CAP-006-3, UAT-PLAN-02)', () => {
  const audit = new AuditWriter(world.harness.tenants);
  const gauges: Array<{ name: string; value: number; labels: Record<string, string> | undefined }> = [];
  const metrics: MetricsSink = { increment: () => undefined, gauge: (name, value, labels) => void gauges.push({ name, value, labels }) };
  const job = new CapBalanceReconcileJob(audit, metrics);
  const run = (now = new Date('2026-08-01T19:00:00Z')) => world.as((tx) => job.run(tx, ACTOR, now), PUBLISHER);

  it('finds the ledger equal to the balances after the postings, and sets the gauge to nothing', async () => {
    const line = await world.publishedLine({ allocated: '500' });
    const item = await request(line, '200');
    await commit(item);
    await moveTo(item, 'SETTLED');
    const transaction = randomUUID();
    await disburse(item, transaction);
    await reverse(item, transaction);
    const result = await run();
    expect(result.drift).toEqual([]);
    expect(result.totalDriftVnd).toBe('0');
    expect(result.checked).toBeGreaterThan(0);
    expect(gauges.at(-1)).toMatchObject({ name: CAP_BALANCE_DRIFT_METRIC, value: 0, labels: { tenant_id: TENANT_A } });
  });

  it('reports a balance that differs from the ledger on the gauge, in an audit row and in an event once a day, and corrects nothing', async () => {
    const line = await world.publishedLine({ allocated: '700' });
    const item = await request(line, '100');
    await commit(item);
    // A balance that moved without its entry: the ledger says 100 committed, the balance 130.
    await world.setFigures(line.balanceId, { committed: '130' });
    const result = await run();
    expect(result.drift).toEqual([{ projectId: line.projectId, appropriationId: line.appropriationId, column: 'committed_vnd', ledgerVnd: '100', balanceVnd: '130', differenceVnd: '30' }]);
    expect(result.totalDriftVnd).toBe('30');
    expect(gauges.at(-1)).toMatchObject({ name: CAP_BALANCE_DRIFT_METRIC, value: 30 });
    expect((await world.balanceOf(line.balanceId)).committed).toBe('130');
    expect(await world.owner("select 1 from machvon.capital_ledger_entry where allocation_line_id = $1::uuid and entry_type <> 'ALLOCATE' and entry_type <> 'COMMIT'", [line.lineId])).toEqual([]);
    const audits = await world.owner<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where action = 'cap.balance_drift_detected' and resource_id = $1", [line.appropriationId]);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.safe_diff).toMatchObject({ project_id: line.projectId });
    const events = () => world.owner<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where type = $1 and aggregate_id = $2::uuid', [CAP_BALANCE_DRIFT_EVENT, line.appropriationId]);
    expect(await events()).toHaveLength(1);
    expect((await events())[0]?.payload).toMatchObject({ project_id: line.projectId, appropriation_id: line.appropriationId, source_module: 'CAP' });
    // The same night again, and the day after: one event for a day, a new one for the next day.
    await run();
    expect(await events()).toHaveLength(1);
    await run(new Date('2026-08-02T19:00:00Z'));
    expect(await events()).toHaveLength(2);
    // Once the figure is put right by the people who own it, the gauge returns to nothing.
    await world.setFigures(line.balanceId, { committed: '100' });
    expect((await run()).drift).toEqual([]);
    expect(gauges.at(-1)).toMatchObject({ name: CAP_BALANCE_DRIFT_METRIC, value: 0 });
  });

  it('reports a disbursed amount that no entry explains', async () => {
    const line = await world.publishedLine({ allocated: '400' });
    await world.setFigures(line.balanceId, { disbursed: '50' });
    const result = await run();
    expect(result.drift.filter((row) => row.appropriationId === line.appropriationId)).toEqual([
      { projectId: line.projectId, appropriationId: line.appropriationId, column: 'disbursed_vnd', ledgerVnd: '0', balanceVnd: '50', differenceVnd: '50' },
    ]);
    // Two columns of one appropriation are one report, with both columns in it.
    await world.setFigures(line.balanceId, { committed: '10' });
    const both = await run(new Date('2026-08-05T19:00:00Z'));
    expect(both.drift.filter((row) => row.appropriationId === line.appropriationId).map((row) => row.column)).toEqual(['committed_vnd', 'disbursed_vnd']);
    expect(both.totalDriftVnd).toBe('60');
    const [report] = await world.owner<{ payload: { columns: unknown[] } }>('select payload from machvon.outbox_event where type = $1 and aggregate_id = $2::uuid order by created_at desc', [CAP_BALANCE_DRIFT_EVENT, line.appropriationId]);
    expect(report?.payload.columns).toHaveLength(2);
    await world.setFigures(line.balanceId, { committed: '0', disbursed: '0' });
    expect((await run()).drift).toEqual([]);
  });
});

// Last in the file: it leaves a reversal in the ledger that no balance follows, which the nightly check above would report.
describe('CapPaymentLedgerStore: what the database holds', () => {
  it('holds what the database holds: an entry of a payment has a line and a project, and a reversal undoes one entry of its line, once, for its whole amount', async () => {
    const line = await world.publishedLine({ allocated: '1000' });
    const item = await request(line, '100');
    await commit(item);
    const [commitment] = await world.owner<{ id: string }>("select id from machvon.capital_ledger_entry where allocation_line_id = $1::uuid and entry_type = 'COMMIT'", [line.lineId]);
    const insert = (type: string, amount: string, reversalOf: string | null, project: string | null = line.projectId, source = item.id) =>
      world.owner(
        `insert into machvon.capital_ledger_entry (tenant_id, id, appropriation_id, allocation_line_id, project_id, entry_type, amount_vnd, plan_year, source_ref_kind, source_ref_id, reversal_of_id, posted_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4, $5::numeric, $6, 'PAYMENT_REQUEST', $7::uuid, $8::uuid, $9::uuid)`,
        [line.appropriationId, line.lineId, project, type, amount, line.year, source, reversalOf, ACTOR],
      );
    await expect(insert('UNCOMMIT', '100', null, null)).rejects.toMatchObject({ code: '23514' });
    await expect(insert('REVERSAL', '99', commitment?.id ?? null, line.projectId, randomUUID())).rejects.toMatchObject({ code: '23514' });
    await expect(insert('REVERSAL', '100', randomUUID(), line.projectId, randomUUID())).rejects.toMatchObject({ code: '23514' });
    await insert('REVERSAL', '100', commitment?.id ?? null, line.projectId, randomUUID());
    await expect(insert('REVERSAL', '100', commitment?.id ?? null, line.projectId, randomUUID())).rejects.toMatchObject({ code: '23505' });
  });
});
