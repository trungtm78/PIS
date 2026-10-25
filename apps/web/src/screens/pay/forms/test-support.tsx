import { vi } from 'vitest';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import { actions as paymentActions, payment as basePayment, paymentId, routeOf as baseRoute, mount } from '../payment/test-support';

export { mount, paymentId };
export type { Harness };

export const FORMER = ['payment_request.read', 'payment.forms.generate', 'payment.treasury.send', 'contract.read'];
export const READER = ['payment_request.read'];

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const formId = (n: number): string => uuid('00f1', n);

export const routeOf = (id: string, req: string) => baseRoute(id, 'PAY', req);

/** A request that has been checked, with the buttons the server allows to the caller. */
export const checked = (n: number, overrides: Record<string, unknown> = {}, actionOverrides: Record<string, unknown> = {}) =>
  basePayment(n, {
    status: 'VERIFIED',
    actions: paymentActions({ revise: false, attach_document: false, cancel: false, generate_forms: true, send_treasury: false, ...actionOverrides }),
    ...overrides,
  });

/** A form as the read answers it. */
export const form = (n: number, code: string, overrides: Record<string, unknown> = {}) => ({
  id: formId(n),
  payment_request_id: paymentId(1),
  form_code: code,
  status: 'GENERATED',
  template_code: `PAY-ND254-${code.slice(0, 4).replace(/\W/g, '')}`,
  template_revision: 2,
  legal_basis: 'Nghị định 254/2025/NĐ-CP, phụ lục (mẫu thử)',
  document_id: uuid('00f2', n),
  document_version_id: uuid('00f3', n),
  file_sha256: `${String(n).repeat(64).slice(0, 64)}`,
  payload_sha256: 'b'.repeat(64),
  generated_at: '2026-10-25T01:00:00.000Z',
  generated_by: uuid('0030', 1),
  ...overrides,
});

export const answer = (overrides: Record<string, unknown> = {}) => ({
  operation_id: uuid('00f0', 1),
  status: 'VERIFIED',
  resource_version: 2,
  resource_id: paymentId(1),
  gross_vnd: '3000000000',
  advance_recovery_vnd: '750000000',
  retention_vnd: '150000000',
  tax_adjustment_vnd: '0',
  net_vnd: '2100000000',
  plan_year: 2026,
  warnings: [],
  forms: [],
  ...overrides,
});

export interface World {
  payments: Array<Record<string, unknown>>;
  forms: Array<Record<string, unknown>> | Error;
  failing: Set<string>;
}

export function world(overrides: Partial<World> = {}): World {
  return { payments: [checked(1)], forms: [], failing: new Set(), ...overrides };
}

/** A client over `state`: the requests and their forms are answered from it, and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => answer()): Harness {
  const h = baseHarness((operation, input) => {
    if (state.failing.has(operation)) return new Error(`${operation} failed`);
    const id = (input as { path?: { id?: string } } | undefined)?.path?.id;
    if (operation === 'get_resources_payment_request_id') return state.payments.find((item) => item.id === id) ?? new Error('not found');
    if (operation === 'listPaymentForms') return state.forms instanceof Error ? state.forms : { items: state.forms };
    return new Error(`unexpected read ${operation}`);
  }, command);
  (h.client as unknown as { readAll: (operation: string, input?: unknown) => Promise<unknown[]> }).readAll = vi.fn((operation: string) => {
    if (state.failing.has(operation)) return Promise.reject(new Error(`${operation} failed`));
    return operation === 'get_resources_payment_request' ? Promise.resolve(state.payments) : Promise.reject(new Error(`unexpected readAll ${operation}`));
  });
  return h;
}

export const commandsOf = (h: Harness, operation: string): Array<{ path?: { id?: string }; body: Record<string, unknown>; ifMatchVersion?: number }> =>
  h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { path?: { id?: string }; body: Record<string, unknown>; ifMatchVersion?: number });
