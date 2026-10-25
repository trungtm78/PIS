import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { ContractScopes } from '../../src/ctr-contract-store';
import { PayClaimStore } from '../../src/pay-claim-store';
import { PayPaymentStore } from '../../src/pay-payment-store';
import { PaySettlementStore } from '../../src/pay-settlement-store';
import type { AcceptanceWorld } from './acceptance-fixtures';
import { TENANT_A, memberId } from './authz-fixtures';

/** The people of the payment: the one who draws the request up, the one who sends it, the one who checks it and the one who matches the Treasury transaction. */
export interface PaymentPeople {
  maker: number;
  sender: number;
  checker: number;
  matcher: number;
}

export interface SettledPayment {
  contractId: string;
  acceptanceId: string;
  paymentRequestId: string;
  transactionId: string;
  /** The measurement the acceptance rests on, one for each of its two lines. */
  measurementIds: string[];
}

const everything: ContractScopes = { update: () => ({ sql: 'true', params: [] }), read: () => ({ sql: 'true', params: [] }) };
let counter = 0;

/** Runs a statement as the superuser with the triggers off. */
export async function adminStatement(world: AcceptanceWorld, sql: string, params: unknown[] = []): Promise<void> {
  const client = new Client({ connectionString: world.harness.database.adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    await client.query(sql, params);
  } finally {
    await client.end();
  }
}

/**
 * A contract of the first project of the world with a payment of 3bn that the Treasury settled: gross 3bn (B01 2bn and B02 1bn), recovery 750m of an advance of 2bn, retention 150m, net 2.1bn. The
 * way the tests of PAY draw it: the stores of the product, a Treasury transaction written as the callback leaves it, and the match.
 */
export async function settledPayment(world: AcceptanceWorld, people: PaymentPeople): Promise<SettledPayment> {
  const payments = new PayPaymentStore();
  const claims = new PayClaimStore();
  const treasury = new PaySettlementStore();
  counter += 1;
  const contract = await world.seedContract();
  await world.owner('update machvon.contract_party set work_value_vnd = 10000000000 where contract_id = $1::uuid', [contract.contractId]);
  await world.owner('update machvon.contract set advance_paid_vnd = 2000000000 where id = $1::uuid', [contract.contractId]);
  const advanceId = randomUUID();
  await world.owner(
    `insert into machvon.contract_advance (tenant_id, id, contract_id, party_id, tranche_no, kind, amount_vnd, cap_vnd, status, paid_vnd, paid_on, recovery_threshold_pct, recovery_deadline, created_by, updated_by)
     values ($1, $5::uuid, $2::uuid, $3::uuid, 1, 'GPMB', 2000000000, 2000000000, 'PAID', 2000000000, date '2026-06-01', 80, date '2026-12-31', $4::uuid, $4::uuid)`,
    [TENANT_A, contract.contractId, contract.partyId, memberId(people.maker), advanceId],
  );
  // The journal of the advance: the money went out on 1 June (the fixture sets the tranche as paid without the entry that records it).
  await adminStatement(
    world,
    `insert into machvon.advance_ledger_entry (tenant_id, id, contract_id, payment_request_id, entry_kind, amount_vnd, posted_at, advance_id, party_id, outstanding_after_vnd, request_id)
     values ($1, gen_random_uuid(), $2::uuid, null, 'DISBURSE', 2000000000, timestamptz '2026-06-01T03:00:00Z', $3::uuid, $4::uuid, 2000000000, gen_random_uuid())`,
    [TENANT_A, contract.contractId, advanceId, contract.partyId],
  );
  const approved = await world.approve(contract, [
    { item: 0, quantity: '2000' },
    { item: 1, quantity: '500' },
  ]);
  const made = await world.as(
    (tx) =>
      payments.create(
        tx,
        { contractId: contract.contractId, requestKind: 'INTERIM', acceptanceId: approved.acceptance.id, allocationLineId: world.lineId, requestNo: `DNTT-S-${counter}-${randomUUID().slice(0, 6)}` },
        memberId(people.maker),
        everything,
        '2026-07-25',
      ),
    people.maker,
  );
  const document = await world.documentVersion();
  await world.as(
    (tx) =>
      payments.attachDocument(
        tx,
        made.id,
        { documentVersionId: document.id, docKind: 'INVOICE', invoiceNo: `HD-S-${counter}-${randomUUID().slice(0, 6)}`, invoiceDate: '2026-07-01' },
        memberId(people.maker),
        everything,
        { mayOverride: () => false },
      ),
    people.maker,
  );
  const sent = await world.as(
    (tx) => claims.submit(tx, made.id, made.version, { expectedGrossVnd: made.grossVnd, expectedNetVnd: made.netVnd, requestId: randomUUID() }, memberId(people.sender), everything, '2026-07-25'),
    people.sender,
  );
  await world.as((tx) => claims.verify(tx, made.id, sent.version, undefined, memberId(people.checker), everything), people.checker);
  await world.sendToTreasury(made.id);
  const transactionId = randomUUID();
  await world.owner(
    `insert into machvon.treasury_transaction
       (tenant_id, id, project_id, external_id, provider, amount_vnd, confirmed_at, source_hash, row_hash, direction, document_no, document_date, source_kind, provider_event_id, match_status)
     values ($1, $2::uuid, $3::uuid, $4, 'MOCKKB', 2100000000, timestamptz '2026-07-24T18:30:00Z', repeat('a', 64), repeat('a', 64), 'PAYMENT', $4, date '2026-07-30', 'CALLBACK_MOCK', $5, 'UNMATCHED')`,
    [TENANT_A, transactionId, world.projectId, `CT-S-${counter}`, `EVT-S-${counter}`],
  );
  const done = await world.as(
    (tx) => treasury.match(tx, { transactionId, paymentRequestId: made.id, actor: memberId(people.matcher), requestId: randomUUID(), scopes: everything, now: new Date('2026-07-25T05:00:00Z') }),
    people.matcher,
  );
  if (done.kind !== 'SETTLED') throw new Error('the fixture was not settled');
  const lines = await world.owner<{ measurement_id: string }>('select distinct measurement_id from machvon.acceptance_line where acceptance_id = $1::uuid order by measurement_id', [
    approved.acceptance.id,
  ]);
  return { contractId: contract.contractId, acceptanceId: approved.acceptance.id, paymentRequestId: made.id, transactionId, measurementIds: lines.map((row) => row.measurement_id) };
}
