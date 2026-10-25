import { randomUUID } from 'node:crypto';
import { CtrMeasurementStore } from '../src/ctr-measurement-store';
import type { ContractScopes } from '../src/ctr-contract-store';
import { CHAIN_NODE_TYPES, PayChainStore } from '../src/pay-chain-store';
import type { PaymentChain } from '../src/pay-chain-store';
import { PayProjectSettlementStore } from '../src/pay-project-settlement-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AcceptanceWorld } from './support/acceptance-fixtures';
import { TENANT_A, memberId } from './support/authz-fixtures';
import { adminStatement, settledPayment } from './support/settled-payment';

jest.setTimeout(600_000);

const fixtures = new AcceptanceWorld();
const chains = new PayChainStore();
const MAKER = 1;
const SENDER = 2;
const CHECKER = 3;
const MATCHER = 4;
const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });
const nothing: ScopeBuilder = () => ({ sql: 'false', params: [] });
const contractScopes: ContractScopes = { update: everything, read: everything };
const as = <T>(work: (tx: TenantTx) => Promise<T>, member = MAKER): Promise<T> => fixtures.as(work, member);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

const read = (input: { projectId: string; contractId?: string }, scope: ScopeBuilder = everything, store: PayChainStore = chains): Promise<PaymentChain> => as((tx) => store.read(tx, scope, input));
const typesOf = (chain: PaymentChain): string[] => chain.nodes.map((node) => node.type);
const nodeOf = (chain: PaymentChain, type: string, id?: string) => chain.nodes.find((node) => node.type === type && (id === undefined || node.id === id));

describe('the trace of a payment, from the project to its settlement (ST-PAY-010, AC-ST-PAY-010-1, UAT-AC67)', () => {
  beforeAll(async () => {
    await fixtures.start();
    for (const member of [MATCHER]) await fixtures.harness.seedMembership(TENANT_A, member, 1);
    // The project is being built: a settlement of one of its contracts can be opened.
    await adminStatement(fixtures, "update machvon.project set status = 'IMPLEMENTATION', project_group = 'B' where id = $1::uuid", [fixtures.projectId]);
  });
  afterAll(() => fixtures.stop(), 60_000);

  it('gives the seven kinds of node, each with its id and its version, in the order of the chain, and the total of the payment', async () => {
    const paid = await settledPayment(fixtures, { maker: MAKER, sender: SENDER, checker: CHECKER, matcher: MATCHER });
    const settlement = await as((tx) => new PayProjectSettlementStore().open(tx, { projectId: fixtures.projectId, scope: 'CONTRACT', contractId: paid.contractId }, memberId(MAKER), everything));
    const chain = await read({ projectId: fixtures.projectId, contractId: paid.contractId });

    expect(chain.projectId).toBe(fixtures.projectId);
    expect(chain.contractId).toBe(paid.contractId);
    expect([...new Set(typesOf(chain))]).toEqual([...CHAIN_NODE_TYPES]);
    expect(typesOf(chain)).toEqual(['project', 'contract', 'measurement', 'measurement', 'acceptance', 'payment_request', 'treasury_transaction', 'settlement_revision']);
    for (const node of chain.nodes) {
      expect(node.id).toMatch(/^[0-9a-f-]{36}$/);
      if (node.type !== 'treasury_transaction') expect(Number.isInteger(node.version)).toBe(true);
    }
    expect(nodeOf(chain, 'contract')).toMatchObject({ id: paid.contractId, revision: 1, status: 'ACTIVE', amountVnd: '9000000000' });
    expect(nodeOf(chain, 'acceptance')).toMatchObject({ id: paid.acceptanceId, status: 'APPROVED', amountVnd: '3000000000' });
    expect(chain.nodes.filter((node) => node.type === 'measurement').map((node) => node.id).sort()).toEqual([...paid.measurementIds].sort());
    expect(nodeOf(chain, 'payment_request')).toMatchObject({ id: paid.paymentRequestId, status: 'SETTLED', amountVnd: '3000000000', facts: { net_vnd: '2100000000', request_kind: 'INTERIM', treasury_paid_on: '2026-07-25' } });
    expect(nodeOf(chain, 'treasury_transaction')).toMatchObject({ id: paid.transactionId, version: null, status: 'MATCHED', amountVnd: '2100000000', facts: { direction: 'PAYMENT' } });
    expect(nodeOf(chain, 'settlement_revision')).toMatchObject({ id: settlement.view.id, revision: 1, status: 'DRAFT', superseded: false });
    expect(chain.totals).toEqual({ countedRequests: 1, countedGrossVnd: '3000000000', settledGrossVnd: '3000000000' });
    expect(chain.truncated).toEqual([]);

    const edge = (from: string, to: string) => chain.edges.find((candidate) => candidate.from === from && candidate.to === to)?.relation;
    expect(edge(fixtures.projectId, paid.contractId)).toBe('HAS_CONTRACT');
    for (const id of paid.measurementIds) {
      expect(edge(paid.contractId, id)).toBe('MEASURED_IN');
      expect(edge(id, paid.acceptanceId)).toBe('ACCEPTED_AS');
    }
    expect(edge(paid.acceptanceId, paid.paymentRequestId)).toBe('CLAIMED_BY');
    expect(edge(paid.paymentRequestId, paid.transactionId)).toBe('PAID_BY');
    expect(edge(paid.contractId, settlement.view.id)).toBe('SETTLED_IN');

    // Without a contract the chain holds every contract of the project, this one among them.
    const whole = await read({ projectId: fixtures.projectId });
    expect(whole.contractId).toBeNull();
    expect(whole.nodes.some((node) => node.id === paid.contractId)).toBe(true);
    expect(whole.nodes.filter((node) => node.type === 'project')).toHaveLength(1);
  });

  it('shows a corrected measurement as the new revision and the old one as superseded, and the acceptance keeps the revision it used', async () => {
    const contract = await fixtures.seedContract();
    const approved = await fixtures.approve(contract, [{ item: 0, quantity: '100' }]);
    const measurementId = (await fixtures.world.owner<{ measurement_id: string }>('select measurement_id from machvon.acceptance_line where acceptance_id = $1::uuid', [approved.acceptance.id]))[0]?.measurement_id as string;
    // The acceptance is revoked, so the measurement is free to be corrected: the correction writes revision 2 and supersedes revision 1.
    await fixtures.revoke(approved);
    const [held] = await fixtures.world.owner<{ version: string }>('select version::text from machvon.measurement where id = $1::uuid', [measurementId]);
    const corrected = await as((tx) =>
      new CtrMeasurementStore().correct(tx, measurementId, Number(held?.version), { quantityPeriod: '90', correctionReason: 'Re-measured on site.', evidenceRefs: [] }, memberId(MAKER), contractScopes),
    );
    const chain = await read({ projectId: fixtures.projectId, contractId: contract.contractId });
    const measurements = chain.nodes.filter((node) => node.type === 'measurement');
    const first = measurements[0]?.revision as number;
    expect(measurements.map((node) => [node.revision, node.status, node.superseded])).toEqual([
      [first, 'SUPERSEDED', true],
      [first + 1, 'DRAFT', false],
    ]);
    expect(measurements[1]?.id).toBe(corrected.id);
    expect(measurements[1]?.facts.corrects).toBe(measurementId);
    expect(nodeOf(chain, 'acceptance')).toMatchObject({ id: approved.acceptance.id, status: 'REVOKED' });
    const edge = (from: string, to: string) => chain.edges.find((candidate) => candidate.from === from && candidate.to === to)?.relation;
    expect(edge(measurementId, approved.acceptance.id)).toBe('ACCEPTED_AS');
    expect(edge(corrected.id, measurementId)).toBe('CORRECTS');
    expect(edge(corrected.id, approved.acceptance.id)).toBeUndefined();
    // A contract with no payment has no payment, no transaction and no settlement, and the totals say so.
    expect(typesOf(chain)).not.toContain('payment_request');
    expect(chain.totals).toEqual({ countedRequests: 0, countedGrossVnd: '0', settledGrossVnd: '0' });
  });

  it('keeps a request that is not counted out of the totals, and shows a request for an advance under its contract', async () => {
    const contract = await fixtures.seedContract();
    const requestId = randomUUID();
    await adminStatement(
      fixtures,
      `insert into machvon.payment_request (tenant_id, id, project_id, contract_id, advance_id, currency, gross_vnd, advance_recovery_vnd, retention_vnd, tax_adjustment_vnd, net_vnd, status, version, claims_acceptance, request_no, request_kind)
       values ($1, $2::uuid, $3::uuid, $4::uuid, gen_random_uuid(), 'VND', 500000000, 0, 0, 0, 500000000, 'DRAFT', 3, false, $5, 'ADVANCE')`,
      [TENANT_A, requestId, fixtures.projectId, contract.contractId, `DNTT-CH-${requestId.slice(0, 6)}`],
    );
    const chain = await read({ projectId: fixtures.projectId, contractId: contract.contractId });
    expect(nodeOf(chain, 'payment_request')).toMatchObject({ id: requestId, version: 3, status: 'DRAFT', facts: { request_kind: 'ADVANCE' } });
    expect(chain.edges.find((edge) => edge.to === requestId)).toEqual({ from: contract.contractId, to: requestId, relation: 'CLAIMED_BY' });
    expect(chain.totals).toEqual({ countedRequests: 0, countedGrossVnd: '0', settledGrossVnd: '0' });
    // A settlement of the whole project hangs from the project.
    const another = await fixtures.seedContract();
    expect((await read({ projectId: fixtures.projectId, contractId: another.contractId })).nodes.some((node) => node.type === 'payment_request')).toBe(false);
  });

  it('answers 404 for a project that is not there or outside the scope, a contract that is not the project’s, and refuses an identifier that is not one', async () => {
    const paid = await settledPayment(fixtures, { maker: MAKER, sender: SENDER, checker: CHECKER, matcher: MATCHER });
    expect(await refusal(read({ projectId: randomUUID() }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    expect(await refusal(read({ projectId: fixtures.projectId }, nothing))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    expect(await refusal(read({ projectId: fixtures.projectId, contractId: randomUUID() }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    // A contract of another project is not found under this one.
    const other = await fixtures.world.publishedLine({ allocated: '1000000000' });
    expect(await refusal(read({ projectId: other.projectId, contractId: paid.contractId }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    expect(await refusal(read({ projectId: 'nope' }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'project_id' });
    expect(await refusal(read({ projectId: fixtures.projectId, contractId: 'nope' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'contract_id' });
  });

  it('says which kinds of node were cut when a chain is longer than it may be', async () => {
    const paid = await settledPayment(fixtures, { maker: MAKER, sender: SENDER, checker: CHECKER, matcher: MATCHER });
    const small = new PayChainStore({ nodes: 1, contracts: 1 });
    const cut = await read({ projectId: fixtures.projectId }, everything, small);
    expect(cut.truncated).toContain('contract');
    expect(cut.nodes.filter((node) => node.type === 'contract')).toHaveLength(1);
    const oneContract = await read({ projectId: fixtures.projectId, contractId: paid.contractId }, everything, small);
    expect(oneContract.truncated).toEqual(['measurement']);
    expect(oneContract.nodes.filter((node) => node.type === 'measurement')).toHaveLength(1);
    expect(oneContract.nodes.filter((node) => node.type === 'acceptance')).toHaveLength(1);
  });
});
