import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import RequestAdvanceScreen from './RequestAdvanceScreen';
import { ACCOUNTANT, READER, answer, client, commandsOf, contractId, mount, routeOf, world } from './test-support';
import type { World } from './test-support';
import { EMPTY_REQUEST, describeRequestRefusal, requestBody, toRequested, validateRequest } from './request-model';

const ROUTE = routeOf('PAY-11', 'PAY', 'FR-PAY-11');
const text = (key: string, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);
const planned = (overrides: Record<string, unknown> = {}) => answer(1, { status: 'PLANNED', amount_vnd: '1000000000', cap_vnd: '2000000000', cap_pct: '20', paid_vnd: '0', recovered_vnd: '0', outstanding_vnd: '0', ...overrides });

afterEach(cleanup);

function open(state: World, options: { path?: string; permissions?: readonly string[]; mode?: 'FULL' | 'READ_ONLY'; command?: (operation: string, input: unknown) => unknown } = {}) {
  const h = client(state, options.command ?? (() => planned()));
  mount(<RequestAdvanceScreen route={ROUTE} />, h, { permissions: options.permissions ?? ACCOUNTANT, path: options.path ?? `/pay/pay-11?contract=${contractId(1)}`, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}
const field = (id: string): HTMLInputElement & HTMLSelectElement => document.getElementById(id) as HTMLInputElement & HTMLSelectElement;
const type = (id: string, value: string): void => {
  fireEvent.change(field(id), { target: { value } });
};
const submit = (): void => {
  fireEvent.click(screen.getByRole('button', { name: vi_['pay.request.submit'] }));
};
/** Fills the form of the contract in the address: the member and the line wait for their reads. */
async function fill(amount = '1000000000'): Promise<void> {
  await waitFor(() => expect(field('request-party').options.length).toBeGreaterThan(1));
  await waitFor(() => expect(field('request-line').options.length).toBeGreaterThan(1));
  type('request-party', field('request-party').options[1]?.value ?? '');
  type('request-kind', 'CONTRACT');
  type('request-amount', amount);
  type('request-line', field('request-line').options[1]?.value ?? '');
}

describe('RequestAdvanceScreen (PAY-11): the request for an advance', () => {
  it('UI-PAY-11: offers the contracts in force, the members of the chosen contract and the lines of its project, and no cap or guarantee', async () => {
    open(world(), { path: '/pay/pay-11' });
    await waitFor(() => expect(field('request-contract').options.length).toBeGreaterThan(1));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['pay.request.title']);
    expect(Array.from(field('request-contract').options).map((option) => option.textContent)).toEqual([vi_['pay.advance.field.choose'], 'HD-A-001']);
    expect(field('request-party').options).toHaveLength(1);
    type('request-contract', contractId(1));
    await waitFor(() => expect(field('request-party').options.length).toBeGreaterThan(1));
    expect(Array.from(field('request-party').options).map((option) => option.textContent)).toEqual([vi_['pay.advance.field.choose'], 'Nhà thầu A']);
    await waitFor(() => expect(field('request-line').options.length).toBeGreaterThan(1));
    expect(Array.from(field('request-kind').options).map((option) => option.value)).toEqual(['', 'CONTRACT', 'GPMB']);
    expect(document.getElementById('request-cap')).toBeNull();
    expect(document.getElementById('request-guarantee')).toBeNull();
    expect(screen.getByText(text('pay.request.footer', { id: 'PAY-11', req: 'FR-PAY-11' }))).toBeTruthy();
  });

  it('asks for every field before it asks the server, and refuses an amount or a tranche that cannot be one', async () => {
    const h = open(world(), { path: '/pay/pay-11' });
    await waitFor(() => expect(field('request-contract').options.length).toBeGreaterThan(1));
    submit();
    expect(await screen.findAllByText(vi_['pay.payment.problem.required'])).toHaveLength(5);
    type('request-amount', '12.5');
    type('request-tranche', '40000');
    submit();
    expect(await screen.findAllByText(vi_['pay.payment.problem.amount'])).toHaveLength(2);
    expect(h.command).not.toHaveBeenCalled();
  });

  it('AC-ST-PAY-004-1: plans the advance with the member, the kind, the amount and the line and nothing else, then shows the cap the server gave and the rule that waits', async () => {
    const h = open(world(), { command: () => planned({ warnings: [{ code: 'RULE_AWAITING_CONFIRMATION', detail: {} }] }) });
    await fill();
    type('request-tranche', '2');
    submit();
    await waitFor(() => expect(commandsOf(h, 'requestAdvance')).toHaveLength(1));
    const [sent] = commandsOf(h, 'requestAdvance');
    expect(sent).toMatchObject({ path: { id: contractId(1) }, body: { kind: 'CONTRACT', amount_vnd: '1000000000', tranche_no: 2 } });
    expect(Object.keys(sent?.body ?? {}).sort()).toEqual(['allocation_line_id', 'amount_vnd', 'kind', 'party_id', 'tranche_no']);
    expect((await screen.findByTestId('requested')).textContent).toContain(text('pay.request.done', { amount: '1.000.000.000', cap: '2.000.000.000', pct: '20' }));
    expect(screen.getByTestId('rule-waits').textContent).toBe(vi_['pay.request.ruleWaits']);
    expect((screen.getByTestId('to-list') as HTMLAnchorElement).getAttribute('href')).toBe(`/pay/pay-07?contract=${contractId(1)}`);
    // The form starts over for the next request, on the same contract.
    expect(field('request-amount').value).toBe('');
    expect(field('request-contract').value).toBe(contractId(1));
  });

  it('does not tell of a rule that waits when the server did not, and clears the answer when the form is changed', async () => {
    open(world());
    await fill();
    submit();
    expect(await screen.findByTestId('requested')).toBeTruthy();
    expect(screen.queryByTestId('rule-waits')).toBeNull();
    type('request-amount', '5');
    expect(screen.queryByTestId('requested')).toBeNull();
  });

  it.each([
    ['ADVANCE_CONTRACT_NOT_EFFECTIVE', 422, {}, vi_['pay.request.error.contractNotEffective']],
    ['ADVANCE_GUARANTEE_REQUIRED', 422, { reason: 'EXPIRED' }, text('pay.request.error.guaranteeRequired', { reason: vi_['pay.request.reason.expired'] })],
    ['ADVANCE_GUARANTEE_REQUIRED', 422, { reason: 'NO_GUARANTEE' }, text('pay.request.error.guaranteeRequired', { reason: vi_['pay.request.reason.none'] })],
    ['ADVANCE_GUARANTEE_REQUIRED', 422, { reason: 'NOT_FOUND' }, text('pay.request.error.guaranteeRequired', { reason: vi_['pay.request.reason.notFound'] })],
    ['ADVANCE_GUARANTEE_REQUIRED', 422, { reason: 'NOT_VERIFIED' }, text('pay.request.error.guaranteeRequired', { reason: vi_['pay.request.reason.notVerified'] })],
    ['ADVANCE_GUARANTEE_REQUIRED', 422, { reason: 'NOT_ACTIVE' }, text('pay.request.error.guaranteeRequired', { reason: vi_['pay.request.reason.notActive'] })],
    ['ADVANCE_GUARANTEE_REQUIRED', 422, { reason: 'TOO_SMALL' }, text('pay.request.error.guaranteeRequired', { reason: vi_['pay.request.reason.tooSmall'] })],
    ['ADVANCE_GUARANTEE_REQUIRED', 422, { reason: 'OTHER_MEMBER' }, text('pay.request.error.guaranteeRequired', { reason: vi_['pay.request.reason.otherMember'] })],
    ['ADVANCE_GUARANTEE_REQUIRED', 422, {}, text('pay.request.error.guaranteeRequired', { reason: vi_['pay.request.reason.unknown'] })],
    ['ADVANCE_CAP_EXCEEDED', 422, { cap_vnd: '500000000' }, text('pay.request.error.capExceeded', { cap: '500.000.000' })],
    ['ADVANCE_CAP_EXCEEDED', 422, {}, text('pay.request.error.capExceeded', { cap: '' })],
    ['ADVANCE_RULE_UNCONFIRMED', 422, {}, vi_['pay.request.error.ruleUnconfirmed']],
    ['ADVANCE_OUTSTANDING_PRIOR', 422, {}, vi_['pay.request.error.outstandingPrior']],
    ['VALUE_EXCEEDED', 409, {}, vi_['pay.request.error.valueExceeded']],
    ['VALIDATION_FAILED', 422, {}, vi_['pay.request.error.validation']],
    ['RESOURCE_NOT_FOUND', 404, {}, vi_['pay.request.error.notFound']],
    ['SCOPE_DENIED', 403, {}, vi_['pay.request.error.denied']],
    ['SESSION_EXPIRED', 401, {}, vi_['pay.request.error.session']],
    ['INTERNAL', 500, {}, vi_['pay.request.error.general']],
  ] as const)('says in words why the server refused with %s %s', async (code, status, extensions, message) => {
    open(world(), { command: () => new ApiError({ status, code, correlationId: 'c', extensions }) });
    await fill();
    submit();
    expect((await screen.findByTestId('refusal')).textContent).toBe(message);
    expect(screen.queryByTestId('requested')).toBeNull();
  });

  it('shows a reader or a read-only session the form and sends nothing', async () => {
    const h = open(world(), { permissions: READER });
    await fill();
    expect((screen.getByRole('button', { name: vi_['pay.request.submit'] }) as HTMLButtonElement).disabled).toBe(true);
    submit();
    expect(h.command).not.toHaveBeenCalled();
    cleanup();
    const second = open(world(), { mode: 'READ_ONLY' });
    await fill();
    expect((screen.getByRole('button', { name: vi_['pay.request.submit'] }) as HTMLButtonElement).disabled).toBe(true);
    expect(second.command).not.toHaveBeenCalled();
    expect(within(document.body).getByRole('link', { name: vi_['pay.request.back'] })).toBeTruthy();
  });
});

describe('the model of PAY-11', () => {
  it('validates the form and builds the body without a cap and without a guarantee', () => {
    const good = { ...EMPTY_REQUEST, contractId: 'c', partyId: 'p', kind: 'GPMB' as const, amount: ' 1000 ', allocationLineId: 'l' };
    expect(validateRequest(good)).toEqual({});
    expect(validateRequest(EMPTY_REQUEST)).toEqual({ contractId: 'required', partyId: 'required', kind: 'required', amount: 'required', allocationLineId: 'required' });
    expect(validateRequest({ ...good, amount: '0' })).toEqual({ amount: 'amount' });
    expect(validateRequest({ ...good, amount: '1e3' })).toEqual({ amount: 'amount' });
    expect(validateRequest({ ...good, trancheNo: '32767' })).toEqual({});
    expect(validateRequest({ ...good, trancheNo: '32768' })).toEqual({ trancheNo: 'amount' });
    expect(validateRequest({ ...good, trancheNo: '0' })).toEqual({ trancheNo: 'amount' });
    expect(requestBody(good)).toEqual({ party_id: 'p', kind: 'GPMB', amount_vnd: '1000', allocation_line_id: 'l' });
    expect(requestBody({ ...good, trancheNo: ' 3 ' })).toMatchObject({ tranche_no: 3 });
    expect(requestBody({ ...good, kind: '' }).kind).toBe('CONTRACT');
  });

  it('reads the answer and the refusal of the server', () => {
    expect(toRequested(undefined)).toBeUndefined();
    expect(toRequested({ resource_id: 'a' })).toBeUndefined();
    expect(toRequested({ resource_id: 'a', amount_vnd: '5', cap_vnd: '9', cap_pct: '20', warnings: [{ code: 'RULE_AWAITING_CONFIRMATION' }] })).toEqual({ id: 'a', amountVnd: '5', capVnd: '9', capPct: '20', ruleAwaitingConfirmation: true });
    expect(toRequested({ resource_id: 'a', amount_vnd: '5', cap_vnd: '9', warnings: 'x' })).toEqual({ id: 'a', amountVnd: '5', capVnd: '9', capPct: null, ruleAwaitingConfirmation: false });
    expect(describeRequestRefusal(new Error('boom'))).toEqual({ problem: 'general', capVnd: null, reason: null });
    expect(describeRequestRefusal(new ApiError({ status: 422, code: 'ADVANCE_CAP_EXCEEDED', correlationId: 'c', extensions: { cap_vnd: '7' } }))).toEqual({ problem: 'capExceeded', capVnd: '7', reason: null });
    expect(describeRequestRefusal(new ApiError({ status: 422, code: 'INVALID_REQUEST', correlationId: 'c', extensions: { reason: 'ODD' } }))).toEqual({ problem: 'validation', capVnd: null, reason: null });
  });
});
