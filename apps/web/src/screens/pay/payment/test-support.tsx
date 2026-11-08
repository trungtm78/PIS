import { vi } from 'vitest';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import { PROJECT, contractId, line as contractLine, mount } from '../../ctr/test-support';
import { acceptance, acceptanceId } from '../../ctr/acceptance/test-support';
import { line as capitalLine, project as planProject } from '../../bid/plan-test-support';

export { PROJECT, contractId, mount };
export type { Harness };

export const ACCOUNTANT = ['payment_request.read', 'payment.create', 'payment.document.attach', 'payment.cancel', 'contract.read', 'acceptance.read'];
export const APPROVER = ['payment_request.read', 'payment.document.attach', 'payment.verify'];
export const READER = ['payment_request.read'];

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const paymentId = (n: number): string => uuid('0090', n);
export const LINE_ID = uuid('0040', 1);
export const DOCUMENT_VERSION = uuid('00c0', 1);
export { acceptanceId };

export const routeOf = (id: string, module: string, req: string) => ({
  id,
  path: `/${module.toLowerCase()}/${id.toLowerCase()}`,
  title: id,
  kind: 'form' as const,
  area: 'investment' as const,
  module,
  group: 'Hồ sơ thanh toán',
  role: 'workspace' as const,
  parent: null,
  req,
});

export const actions = (overrides: Record<string, unknown> = {}) => ({ revise: true, attach_document: true, cancel: true, override_duplicate: false, submit: false, verify: false, return: false, generate_forms: false, send_treasury: false, ...overrides });

/** One line of a request: B01 and B02 of the example of the chief accountant (gross 3bn, recovery 750m, retention 150m). */
export const paymentLine = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid('00a0', n),
  acceptance_line_id: uuid('00e0', n),
  boq_item: { id: uuid('0014', n), business_key: `B0${n}`, description: `Hạng mục ${n}`, unit_code: 'M3' },
  party_id: null,
  quantity: n === 1 ? '2000.000000' : '500.000000',
  unit_price_snapshot: n === 1 ? '1000000.000000' : '2000000.000000',
  retention_pct_snapshot: '5.0000',
  gross_vnd: n === 1 ? '2000000000' : '1000000000',
  advance_recovery_vnd: n === 1 ? '500000000' : '250000000',
  retention_vnd: n === 1 ? '100000000' : '50000000',
  net_vnd: n === 1 ? '1400000000' : '700000000',
  ...overrides,
});

export const paymentDocument = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid('00d0', n),
  document_version_id: uuid('00c0', n),
  doc_kind: 'INVOICE',
  checksum: `${'ab'.repeat(32)}`,
  invoice_no: 'HD-0001234',
  invoice_date: '2026-07-01',
  signed: true,
  duplicate_override_reason: null,
  duplicate_override_by: null,
  created_by: uuid('0030', 1),
  created_at: '2026-10-25T01:00:00.000Z',
  ...overrides,
});

/** A request as the read answers it: a draft of the example, with its two lines and no document. */
export const payment = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: paymentId(n),
  request_no: `DNTT-00${n}`,
  request_kind: 'INTERIM',
  status: 'DRAFT',
  contract: { id: contractId(1), code: 'HD-A-001', status: 'ACTIVE' },
  project_id: PROJECT,
  acceptance: { id: acceptanceId(1), acceptance_no: 'NT-001', accepted_on: '2026-07-25' },
  advance_id: null,
  settlement_revision_id: null,
  allocation_line_id: LINE_ID,
  plan_year: 2026,
  gross_vnd: '3000000000',
  advance_recovery_vnd: '750000000',
  retention_vnd: '150000000',
  tax_adjustment_vnd: '0',
  tax_adjustment_basis: null,
  advance_recovery_extra_vnd: '0',
  net_vnd: '2100000000',
  claims_acceptance: false,
  other_drafts: 0,
  return_reason: null,
  cancel_reason: null,
  verification_note: null,
  treasury_submitted_on: null,
  treasury_ref: null,
  treasury_paid_on: null,
  settled_transaction_id: null,
  reversed_at: null,
  refund_transaction_id: null,
  forms_standing: [],
  created_by: uuid('0030', 1),
  created_at: '2026-10-25T01:00:00.000Z',
  updated_at: '2026-10-25T01:00:00.000Z',
  lines: [paymentLine(1), paymentLine(2)],
  documents: [],
  actions: actions(),
  version: 1,
  ...overrides,
});

/** What a command answers: the figures the server computed. */
export const answer = (n: number, overrides: Record<string, unknown> = {}) => ({
  operation_id: uuid('00f0', 1),
  status: 'DRAFT',
  resource_version: 1,
  resource_id: paymentId(n),
  gross_vnd: '3000000000',
  advance_recovery_vnd: '750000000',
  retention_vnd: '150000000',
  tax_adjustment_vnd: '0',
  net_vnd: '2100000000',
  plan_year: 2026,
  warnings: [],
  ...overrides,
});

export interface World {
  payments: Array<Record<string, unknown>>;
  contracts: Array<Record<string, unknown>>;
  acceptances: Array<Record<string, unknown>>;
  /** The lines of capital the read of allocation lines answers. */
  lines: Array<Record<string, unknown>>;
  /** Reads that fail, by operation. */
  failing: Set<string>;
  /** An answer to the read of one request instead of the stored ones (an error to fail it). */
  detail?: unknown;
}

export function world(overrides: Partial<World> = {}): World {
  return {
    payments: [payment(1)],
    contracts: [contractLine(1, { status: 'ACTIVE' })],
    acceptances: [acceptance(1, { status: 'APPROVED' }), acceptance(2, { status: 'DRAFT' })],
    lines: [capitalLine({ project: planProject({ id: PROJECT }) })],
    failing: new Set(),
    ...overrides,
  };
}

/** A client over `state`: the requests, contracts, acceptances and lines of capital are answered from it, and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => answer(1)): Harness {
  const h = baseHarness((operation, input) => {
    if (state.failing.has(operation)) return new Error(`${operation} failed`);
    if (operation === 'get_resources_payment_request_id') {
      if (state.detail !== undefined) return state.detail;
      const id = (input as { path?: { id?: string } } | undefined)?.path?.id;
      return state.payments.find((item) => item.id === id) ?? new Error('not found');
    }
    if (operation === 'listPaymentReturnReasons') return { items: [{ code: 'MISSING_DOCUMENT', category: 'DOSSIER', requires_note: false, active: true }, { code: 'WRONG_AMOUNT', category: 'AMOUNT', requires_note: true, active: true }], reason_code_required: true, as_of: '2026-11-08' };
    return new Error(`unexpected read ${operation}`);
  }, command);
  (h.client as unknown as { readAll: (operation: string, input?: unknown) => Promise<unknown[]> }).readAll = vi.fn((operation: string, input?: unknown) => {
    if (state.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
    const query = (input as { query?: Record<string, string> } | undefined)?.query ?? {};
    switch (operation) {
      case 'get_resources_payment_request':
        return Promise.resolve(state.payments.filter((item) => (query.contract_id === undefined || (item.contract as { id: string }).id === query.contract_id) && (query.status === undefined || item.status === query.status)));
      case 'get_resources_contract':
        return Promise.resolve(state.contracts);
      case 'get_resources_acceptance':
        return Promise.resolve(state.acceptances.filter((item) => query.contract_id === undefined || (item.contract as { id: string }).id === query.contract_id));
      case 'get_resources_allocation_line':
        return Promise.resolve(state.lines);
      default:
        return Promise.reject(new Error(`unexpected readAll ${operation}`));
    }
  });
  return h;
}

export const readsOf = (h: Harness, operation: string): unknown[] => h.read.mock.calls.filter((call) => call[0] === operation).map((call) => call[1]);
export const commandsOf = (h: Harness, operation: string): Array<{ path?: { id?: string }; body: Record<string, unknown>; ifMatchVersion?: number }> =>
  h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { path?: { id?: string }; body: Record<string, unknown>; ifMatchVersion?: number });
