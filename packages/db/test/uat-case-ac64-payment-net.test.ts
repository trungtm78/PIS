import { randomUUID } from 'node:crypto';
import { PayClaimStore } from '../src/pay-claim-store';
import { PayPaymentStore } from '../src/pay-payment-store';
import type { ContractScopes } from '../src/ctr-contract-store';
import type { TenantTx } from '../src/tenant-database';
import { TENANT_A, memberId } from './support/authz-fixtures';
import { AcceptanceWorld } from './support/acceptance-fixtures';
import type { ApprovedAcceptance } from './support/acceptance-fixtures';

/**
 * UAT-AC64 (docs/uat/ctr/uat.json, PAY-02): a payment request whose net does not balance with its parts is refused at sending, the same request with the right net is sent, and the database refuses an
 * unbalanced net written by the application role. The rounding half of the case (B09 and B10, 3 x 1,234.5 to 3,704 and 3,703) is proven in apps/api/test/ctr/boq-import.test.ts under the same id.
 */
jest.setTimeout(600_000);

const fixtures = new AcceptanceWorld();
const payments = new PayPaymentStore();
const claims = new PayClaimStore();
const MAKER = 1;
const SENDER = 2;
const TODAY = '2026-07-25';
const everything: ContractScopes = { update: () => ({ sql: 'true', params: [] }), read: () => ({ sql: 'true', params: [] }) };

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = MAKER): Promise<T> => fixtures.as(work, member);
const owner = fixtures.owner.bind(fixtures);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; extensions?: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

async function databaseMessage(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    return (error as { message: string }).message;
  }
  return undefined;
}

/** PR-A-001: gross 3,000,000,000, advance recovery 750,000,000, retention 150,000,000, tax 0, net 2,100,000,000, in DRAFT with its invoice. */
async function draftOf(): Promise<{ approved: ApprovedAcceptance; id: string; version: number }> {
  const contract = await fixtures.seedContract();
  await owner('update machvon.contract_party set work_value_vnd = 10000000000 where contract_id = $1::uuid', [contract.contractId]);
  await owner('update machvon.contract set advance_paid_vnd = 2000000000 where id = $1::uuid', [contract.contractId]);
  await owner(
    `insert into machvon.contract_advance
       (tenant_id, id, contract_id, party_id, tranche_no, kind, amount_vnd, cap_vnd, status, paid_vnd, paid_on, recovery_threshold_pct, recovery_deadline, created_by, updated_by)
     values ($1, gen_random_uuid(), $2, $3, 1, 'GPMB', 2000000000, 2000000000, 'PAID', 2000000000, date '2026-06-01', 80, date '2026-12-31', $4, $4)`,
    [TENANT_A, contract.contractId, contract.partyId, memberId(MAKER)],
  );
  const approved = await fixtures.approve(contract, [
    { item: 0, quantity: '2000' },
    { item: 1, quantity: '500' },
  ]);
  const made = await as((tx) =>
    payments.create(tx, { contractId: contract.contractId, requestKind: 'INTERIM', acceptanceId: approved.acceptance.id, allocationLineId: fixtures.lineId, requestNo: `DNTT-N-${randomUUID().slice(0, 8)}` }, memberId(MAKER), everything, TODAY),
  );
  const document = await fixtures.documentVersion();
  await as((tx) =>
    payments.attachDocument(tx, made.id, { documentVersionId: document.id, docKind: 'INVOICE', invoiceNo: `HD-N-${randomUUID().slice(0, 8)}`, invoiceDate: '2026-07-01' }, memberId(MAKER), everything, { mayOverride: () => false }),
  );
  expect([made.grossVnd, made.netVnd]).toEqual(['3000000000', '2100000000']);
  return { approved, id: made.id, version: made.version };
}

const submit = (target: { id: string; version: number }, expectedNet: string) =>
  as((tx) => claims.submit(tx, target.id, target.version, { expectedGrossVnd: '3000000000', expectedNetVnd: expectedNet, requestId: randomUUID() }, memberId(SENDER), everything, TODAY), SENDER);
const statusOf = async (id: string) => (await owner<{ status: string; net: string }>('select status, net_vnd::text as net from machvon.payment_request where id = $1::uuid', [id]))[0];
const bookEntries = async (id: string): Promise<number> =>
  Number(
    (await owner<{ n: string }>('select ((select count(*) from machvon.cumulative_ledger_entry where payment_request_id = $1::uuid) + (select count(*) from machvon.advance_ledger_entry where payment_request_id = $1::uuid))::text as n', [id]))[0]?.n,
  );

describe('UAT-AC64: the net of a payment request has to balance with its parts', () => {
  beforeAll(() => fixtures.start(), 240_000);
  afterAll(() => fixtures.stop(), 60_000);

  it('UAT-AC64: net 2,100,000,001 is 422 PAYMENT_NET_MISMATCH and the request stays DRAFT with nothing on the books, net 2,100,000,000 sends it, and the application role cannot write a net that does not add up', async () => {
    const target = await draftOf();
    // Step 1.
    const refused = await refusal(submit(target, '2100000001'));
    expect(refused).toMatchObject({ code: 'PAYMENT_NET_MISMATCH', status: 422, extensions: { gross_vnd: '3000000000', net_vnd: '2100000000' } });
    expect(await statusOf(target.id)).toEqual({ status: 'DRAFT', net: '2100000000' });
    expect(await bookEntries(target.id)).toBe(0);
    // Step 2.
    await submit(target, '2100000000');
    expect(await statusOf(target.id)).toEqual({ status: 'SUBMITTED', net: '2100000000' });
    expect(await bookEntries(target.id)).toBeGreaterThan(0);

    // Step 3: gross 100, recovery 10, retention 5, tax 0, net 86 as the role of the application (the net has to be 85).
    const insert = (net: string) =>
      as((tx) =>
        tx.query(
          `insert into machvon.payment_request (tenant_id, id, project_id, contract_id, acceptance_id, currency, gross_vnd, advance_recovery_vnd, retention_vnd, tax_adjustment_vnd, net_vnd, status, version)
           select nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), project_id, id, $2::uuid, 'VND', 100, 10, 5, 0, $3::numeric, 'DRAFT', 1 from machvon.contract where id = $1::uuid`,
          [target.approved.contract.contractId, target.approved.acceptance.id, net],
        ),
      );
    expect(await databaseMessage(insert('86'))).toContain('payment_request_net_chk');
    // The check is what refused it: a net of 85 does not meet this check (another rule of the table may still refuse the row).
    expect((await databaseMessage(insert('85'))) ?? '').not.toContain('payment_request_net_chk');
  });

  it('negative control: the checks of this suite go red on an answer that is wrong on purpose', async () => {
    const target = await draftOf();
    // The right net is not refused: the refusal above is the refusal of the wrong net.
    await expect(refusal(submit(target, '2100000000'))).rejects.toThrow('expected a refusal');
    expect(await statusOf(target.id)).toMatchObject({ status: 'SUBMITTED' });
  });
});
