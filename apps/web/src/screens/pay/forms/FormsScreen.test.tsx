import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import FormsScreen from './FormsScreen';
import { FORMER, READER, answer, checked, client, commandsOf, form, formId, mount, paymentId, routeOf, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('PAY-14', 'FR-PAY-14');
const PATH = `/pay/pay-14?request=${paymentId(1)}`;
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);
const refusal = (code: string, extensions: Record<string, unknown> = {}, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World, options: { path?: string; permissions?: readonly string[]; mode?: 'FULL' | 'READ_ONLY'; command?: (operation: string, input: unknown) => unknown } = {}) {
  const h = client(state, options.command);
  mount(<FormsScreen route={ROUTE} />, h, { permissions: options.permissions ?? FORMER, path: options.path ?? PATH, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

const rowOf = (code: string): HTMLElement => document.querySelector(`tr[data-form="${code}"]`) as HTMLElement;
const dialog = (): HTMLElement => screen.getByRole('dialog');
const field = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;
const type = (id: string, value: string): void => {
  fireEvent.change(field(id), { target: { value } });
};
const press = (name: string): void => {
  fireEvent.click(within(dialog()).getByRole('button', { name }));
};
const action = (name: string): HTMLElement | null => document.querySelector(`button[data-action="${name}"]`);

const four = () => [form(1, '03.a/TT'), form(2, '04.a/TT'), form(3, '04.b/TT'), form(4, '05.a/TT')];

describe('FormsScreen (PAY-14): the Treasury forms of a request', () => {
  it('asks for a request when the address names none', async () => {
    open(world(), { path: '/pay/pay-14' });
    expect((await screen.findByTestId('no-request')).textContent).toBe(vi_['pay.forms.none']);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['pay.forms.title']);
    expect(screen.getByText(text('pay.forms.footer', { id: 'PAY-14', req: 'FR-PAY-14' }))).toBeTruthy();
  });

  it('UI-PAY-14: shows the four forms, the ones that stand with their template revision, legal basis and hash, and says which are still to be drawn', async () => {
    open(world({ forms: [form(1, '03.a/TT'), form(9, '03.a/TT', { status: 'SUPERSEDED', template_revision: 1 }), form(3, '04.b/TT')] }));
    await screen.findByTestId('forms');
    const first = rowOf('03.a/TT');
    expect(first.getAttribute('data-state')).toBe('standing');
    expect(within(first).getByTestId('template').textContent).toBe(text('pay.forms.template', { code: 'PAY-ND254-03a', revision: 2 }));
    expect(within(first).getByTestId('basis').textContent).toContain('254/2025');
    expect(within(first).getByTestId('hash').textContent).toBe('1'.repeat(16));
    expect(within(rowOf('04.a/TT')).getByTestId('template').textContent).toBe(vi_['pay.forms.notDrawn']);
    expect(rowOf('04.a/TT').getAttribute('data-state')).toBe('missing');
    expect(screen.getByTestId('missing').textContent).toBe(text('pay.forms.missing', { forms: '04.a/TT, 05.a/TT' }));
    expect(screen.getByTestId('request-no').textContent).toBe('DNTT-001');
    expect(screen.getByTestId('contract').textContent).toBe('HD-A-001');
    expect(screen.getByTestId('net').textContent).toBe('2.100.000.000');
    expect(within(screen.getByTestId('history')).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByTestId('history').textContent).toContain(vi_['pay.forms.status.superseded']);
    expect(within(first).getByRole('button', { name: vi_['pay.forms.action.regenerate'] })).toBeTruthy();
    expect(within(rowOf('04.a/TT')).getByRole('button', { name: vi_['pay.forms.action.generate'] })).toBeTruthy();
    expect(action('send')).toBeNull();
  });

  it('AC-ST-PAY-005-1: draws a form with the place the accountant writes, asks for the place in words, and says the forms are drawn', async () => {
    const h = open(world(), { command: () => answer({ forms: [form(1, '03.a/TT')] }) });
    await screen.findByTestId('forms');
    fireEvent.click(within(rowOf('03.a/TT')).getByRole('button', { name: vi_['pay.forms.action.generate'] }));
    expect(within(dialog()).getByTestId('generate-forms').textContent).toBe(vi_['pay.forms.name.f03a']);
    press(vi_['pay.forms.generate.submit']);
    expect(await within(dialog()).findByText(vi_['pay.payment.problem.required'])).toBeTruthy();
    expect(commandsOf(h, 'generatePaymentForms')).toEqual([]);
    type('generate-place', 'Cao Bằng');
    press(vi_['pay.forms.generate.submit']);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsOf(h, 'generatePaymentForms')[0]).toMatchObject({ path: { id: paymentId(1) }, body: { form_codes: ['03.a/TT'], place: 'Cao Bằng' } });
    expect(screen.getByTestId('done').textContent).toBe(vi_['pay.forms.done.generated']);
  });

  it('draws all four, or the ones that are missing, and names the form whose template waits for its confirmation', async () => {
    const h = open(world({ forms: [form(1, '03.a/TT')] }), { command: () => refusal('TEMPLATE_UNCONFIRMED', { form_code: '05.a/TT' }) });
    await screen.findByTestId('forms');
    fireEvent.click(action('generate-missing') as HTMLElement);
    expect(within(dialog()).getByTestId('generate-forms').textContent).toBe(['04.a/TT', '04.b/TT', '05.a/TT'].map((code) => vi_[`pay.forms.name.f${code.slice(0, 2)}${code.slice(3, 4)}` as keyof typeof vi_]).join(' · '));
    type('generate-place', 'Cao Bằng');
    press(vi_['pay.forms.generate.submit']);
    expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(text('pay.forms.error.unconfirmed', { form: '05.a/TT' }));
    expect(commandsOf(h, 'generatePaymentForms')[0]?.body.form_codes).toEqual(['04.a/TT', '04.b/TT', '05.a/TT']);
    press(vi_['pay.forms.dialog.cancel']);
    fireEvent.click(action('generate-all') as HTMLElement);
    type('generate-place', 'Cao Bằng');
    press(vi_['pay.forms.generate.submit']);
    await waitFor(() => expect(commandsOf(h, 'generatePaymentForms')).toHaveLength(2));
    expect(commandsOf(h, 'generatePaymentForms')[1]?.body.form_codes).toEqual(['03.a/TT', '04.a/TT', '04.b/TT', '05.a/TT']);
  });

  it('puts the refusal of a form out of force into words', async () => {
    open(world(), { command: () => refusal('TEMPLATE_NOT_EFFECTIVE', { form_code: '04.b/TT' }) });
    await screen.findByTestId('forms');
    fireEvent.click(within(rowOf('04.b/TT')).getByRole('button', { name: vi_['pay.forms.action.generate'] }));
    type('generate-place', 'Cao Bằng');
    press(vi_['pay.forms.generate.submit']);
    expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(text('pay.forms.error.notEffective', { form: '04.b/TT' }));
  });

  it('AC-ST-PAY-005-2: offers the record of the send only when the server allows it, with the forms that stand, the day and the number entered', async () => {
    const withSend = world({ payments: [checked(1, {}, { send_treasury: true })], forms: four() });
    const h = open(withSend, { command: () => answer({ status: 'SENT_TREASURY', resource_version: 3 }) });
    await screen.findByTestId('forms');
    expect(screen.queryByTestId('missing')).toBeNull();
    fireEvent.click(action('send') as HTMLElement);
    press(vi_['pay.forms.send.submit']);
    expect(await within(dialog()).findByText(vi_['pay.payment.problem.required'])).toBeTruthy();
    type('send-day', '2999-01-01');
    press(vi_['pay.forms.send.submit']);
    expect(await within(dialog()).findByText(vi_['pay.payment.problem.date'])).toBeTruthy();
    expect(commandsOf(h, 'markPaymentSentToTreasury')).toEqual([]);
    type('send-day', '2026-07-24');
    type('send-ref', 'KB-2026-0001');
    press(vi_['pay.forms.send.submit']);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsOf(h, 'markPaymentSentToTreasury')[0]).toMatchObject({
      path: { id: paymentId(1) },
      ifMatchVersion: 1,
      body: { treasury_submitted_on: '2026-07-24', treasury_ref: 'KB-2026-0001', form_instance_ids: [formId(1), formId(2), formId(3), formId(4)] },
    });
    expect(screen.getByTestId('done').textContent).toBe(vi_['pay.forms.done.sent']);
  });

  it('puts the refusal of the send into words, naming the forms that are lacking', async () => {
    open(world({ payments: [checked(1, {}, { send_treasury: true })], forms: four() }), { command: () => refusal('FORMS_NOT_GENERATED', { missing_form_codes: ['05.a/TT'] }) });
    await screen.findByTestId('forms');
    fireEvent.click(action('send') as HTMLElement);
    type('send-day', '2026-07-24');
    press(vi_['pay.forms.send.submit']);
    expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(text('pay.forms.error.formsMissing', { missing: '05.a/TT' }));
  });

  it('shows the day and the number of a request that was sent, and no command to a reader or in a read-only session', async () => {
    const sent = checked(1, { status: 'SENT_TREASURY', treasury_submitted_on: '2026-07-24', treasury_ref: 'KB-2026-0001', forms_standing: ['03.a/TT'] }, { generate_forms: false });
    open(world({ payments: [sent], forms: four() }));
    await screen.findByTestId('forms');
    expect(screen.getByTestId('sent-on').textContent).toBe('2026-07-24');
    expect(screen.getByTestId('ref').textContent).toBe('KB-2026-0001');
    expect(screen.queryByTestId('paid-on')).toBeNull();
    expect(screen.queryByTestId('missing')).toBeNull();
    expect(document.querySelectorAll('button[data-action]')).toHaveLength(0);
    cleanup();
    // Once the Treasury has confirmed the payment and the request is settled, the day it counts from is shown.
    open(world({ payments: [checked(1, { status: 'SETTLED', treasury_submitted_on: '2026-07-24', treasury_paid_on: '2026-07-25' }, { generate_forms: false })], forms: four() }));
    await screen.findByTestId('forms');
    expect(screen.getByTestId('paid-on').textContent).toBe('2026-07-25');
    cleanup();
    open(world({ forms: four() }), { permissions: READER, mode: 'READ_ONLY' });
    await screen.findByTestId('forms');
    expect(document.querySelectorAll('button[data-action]')).toHaveLength(0);
  });

  it('shows the states of a request that is not there, of a refusal and of a failed read, and never half a screen', async () => {
    open(world({ payments: [] }));
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    cleanup();
    open(world({ forms: new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c', extensions: {} }) }));
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    cleanup();
    open(world({ forms: new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c', extensions: {} }) }));
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    expect(screen.queryByTestId('forms')).toBeNull();
  });
});
