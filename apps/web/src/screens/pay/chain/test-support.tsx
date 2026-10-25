import { ApiError } from '@machvon/api-client';
import { vi } from 'vitest';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import { PROJECT, mount } from '../payment/test-support';
import { routeOf as baseRoute } from '../payment/test-support';

export { PROJECT, mount };
export type { Harness };

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const contractOf = (n: number): string => uuid('0010', n);
export const OTHER_PROJECT = uuid('0001', 2);
export const nodeId = (family: string, n: number): string => uuid(family, n);

export const routeOf = (id: string, req: string) => baseRoute(id, 'PAY', req);

export const AUDITOR = ['payment.chain.read', 'project.read'];
export const AUDITOR_WITHOUT_LIST = ['payment.chain.read'];
export const NOBODY = ['payment_request.read'];

export const node = (type: string, id: string, overrides: Record<string, unknown> = {}) => ({
  type,
  id,
  version: 1,
  revision: null,
  status: null,
  label: id.slice(-8),
  contract_id: null,
  amount_vnd: null,
  superseded: false,
  facts: {},
  ...overrides,
});

/** The chain of the example: the project, the contract (revision 1), a measurement corrected once (revision 1 superseded, 2 draft), an acceptance of the first one, a payment of 3bn settled by a transaction of 2.1bn, and a settlement. */
export function chain(overrides: Record<string, unknown> = {}) {
  const contract = contractOf(1);
  const m1 = nodeId('0070', 1);
  const m2 = nodeId('0070', 2);
  const acceptance = nodeId('0080', 1);
  const payment = nodeId('0090', 1);
  const transaction = nodeId('0100', 1);
  const settlement = nodeId('0150', 1);
  return {
    project_id: PROJECT,
    contract_id: contract,
    nodes: [
      node('project', PROJECT, { version: 4, status: 'IMPLEMENTATION', label: 'DA-001', facts: { name: 'Cầu qua sông' } }),
      node('contract', contract, { version: 7, revision: 1, status: 'ACTIVE', label: 'HD-001', contract_id: contract, amount_vnd: '9000000000' }),
      node('measurement', m1, { version: 3, revision: 1, status: 'SUPERSEDED', label: 'NK-001', contract_id: contract, superseded: true }),
      node('measurement', m2, { version: 1, revision: 2, status: 'DRAFT', label: 'NK-001', contract_id: contract, facts: { corrects: m1 } }),
      node('acceptance', acceptance, { version: 5, status: 'APPROVED', label: 'NT-001', contract_id: contract, amount_vnd: '3000000000' }),
      node('payment_request', payment, {
        version: 9,
        status: 'SETTLED',
        label: 'DNTT-001',
        contract_id: contract,
        amount_vnd: '3000000000',
        facts: { request_kind: 'INTERIM', net_vnd: '2100000000' },
      }),
      node('treasury_transaction', transaction, { version: null, status: 'MATCHED', label: 'CT-0001', contract_id: contract, amount_vnd: '2100000000' }),
      node('settlement_revision', settlement, { version: 2, revision: 1, status: 'DRAFT', label: 'PROJECT', contract_id: null, amount_vnd: '9850000000' }),
    ],
    edges: [
      { from: PROJECT, to: contract, relation: 'HAS_CONTRACT' },
      { from: contract, to: m1, relation: 'MEASURED_IN' },
      { from: contract, to: m2, relation: 'MEASURED_IN' },
      { from: m2, to: m1, relation: 'CORRECTS' },
      { from: m1, to: acceptance, relation: 'ACCEPTED_AS' },
      { from: acceptance, to: payment, relation: 'CLAIMED_BY' },
      { from: payment, to: transaction, relation: 'PAID_BY' },
      { from: payment, to: settlement, relation: 'SETTLED_IN' },
    ],
    totals: { counted_requests: 1, counted_gross_vnd: '3000000000', settled_gross_vnd: '3000000000' },
    truncated: [],
    as_of: '2026-10-26T05:00:00.000Z',
    ...overrides,
  };
}

export interface World {
  chains: Array<Record<string, unknown>>;
  projects: Array<Record<string, unknown>>;
  failing: Set<string>;
}

export function world(overrides: Partial<World> = {}): World {
  return { chains: [chain()], projects: [{ id: PROJECT, code: 'DA-001', name: 'Cầu qua sông' }], failing: new Set(), ...overrides };
}

/** A client over `state`: the chain is answered for the project (and contract) asked, and a project it does not know is a 404. */
export function client(state: World): Harness {
  const h = baseHarness((operation, input) => {
    if (state.failing.has(operation)) return new Error(`${operation} failed`);
    if (operation !== 'getPaymentChain') return new Error(`unexpected read ${operation}`);
    const asked = (input as { query?: { project_id?: string; contract_id?: string } } | undefined)?.query;
    const found = state.chains.find((item) => item.project_id === asked?.project_id && (asked?.contract_id === undefined || item.contract_id === asked.contract_id || item.contract_id === null));
    return found ?? new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c', extensions: {} });
  });
  (h.client as unknown as { readAll: (operation: string, input?: unknown) => Promise<unknown[]> }).readAll = vi.fn((operation: string) =>
    operation === 'get_resources_project' ? Promise.resolve(state.projects) : Promise.reject(new Error(`unexpected readAll ${operation}`)),
  );
  return h;
}
