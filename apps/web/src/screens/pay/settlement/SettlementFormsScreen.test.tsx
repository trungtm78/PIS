import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import SettlementFormsScreen from './SettlementFormsScreen';
import { calendarOf, describeRefusal, formsOf, generateBody, stageOf, standing, toSettlementForm, validateGenerate } from './forms-model';
import { toSettlement } from './model';
import { READER, answer, client, commandsOf, formRecord, mount, routeOf, sent, settlement, settlementId, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('PAY-16', 'FR-PAY-16');
const FORMER = ['settlement_revision.read', 'settlement.forms.generate'];
const text = (key: string, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);
const verified = (n: number, overrides: Record<string, unknown> = {}) => sent(n, { status: 'VERIFIED', verified_on: '2026-10-20', actions: { refresh: false }, ...overrides });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-26T05:00:00Z'));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function open(state: World, options: { path?: string; permissions?: readonly string[]; mode?: 'FULL' | 'READ_ONLY'; command?: (operation: string, input: unknown) => unknown } = {}) {
  const h = client(state, options.command);
  mount(<SettlementFormsScreen route={ROUTE} />, h, { permissions: options.permissions ?? FORMER, path: options.path ?? '/pay/pay-16', ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}
const dialog = (): HTMLElement => screen.getByRole('dialog');
const check = (code: string): void => {
  fireEvent.click(within(dialog()).getByLabelText(new RegExp(code.replace('/', '\\/'))));
};

describe('SettlementFormsScreen (PAY-16): the forms of a settlement and the calendar', () => {
  it('UI-PAY-16, AC-ST-PAY-012-2: lists the settlements that wait for their verification by their last day, with the days left and the stage of the reminders', async () => {
    open(
      world({
        settlements: [
          sent(1, { verification_due_on: '2026-11-20' }),
          sent(2, { verification_due_on: '2026-10-30', status: 'VERIFYING' }),
          sent(3, { verification_due_on: '2026-10-20' }),
          sent(4, { verification_due_on: '2027-03-30' }),
          settlement(5),
          verified(6),
        ],
      }),
    );
    const table = await screen.findByTestId('calendar');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['pay.sform.title']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => row.getAttribute('data-settlement'))).toEqual([settlementId(3), settlementId(2), settlementId(1), settlementId(4)]);
    expect(rows.map((row) => within(row).getByTestId('left').textContent)).toEqual(['-6', '4', '25', '155']);
    expect(rows.map((row) => within(row).getByTestId('stage').textContent)).toEqual([vi_['pay.sform.stage.overdue'], vi_['pay.sform.stage.t7'], vi_['pay.sform.stage.t30'], vi_['pay.sform.stage.later']]);
    expect(within(rows[0] as HTMLElement).getByTestId('stage').className).toContain('warning');
    expect(within(rows[2] as HTMLElement).getByTestId('stage').className).not.toContain('warning');
    expect(within(rows[0] as HTMLElement).getByTestId('submitted').textContent).toBe('2026-10-01');
    expect(within(rows[0] as HTMLElement).getByTestId('due').textContent).toBe('2026-10-20');
    expect((within(rows[0] as HTMLElement).getByTestId('settlement-link') as HTMLAnchorElement).getAttribute('href')).toBe(`/pay/pay-15?settlement=${settlementId(3)}`);
    expect(screen.getByText(text('pay.sform.footer', { id: 'PAY-16', req: 'FR-PAY-16' }))).toBeTruthy();
  });

  it('says in words that nothing waits for its verification, and offers only the verified settlements that have forms', async () => {
    open(
      world({
        settlements: [
          verified(1),
          verified(2, { settlement_scope: 'ANNUAL', fiscal_year: 2026 }),
          verified(3, { settlement_scope: 'CONTRACT', contract: { id: settlementId(9), code: 'HD-1' } }),
          settlement(4),
        ],
      }),
    );
    expect((await screen.findByTestId('calendar-empty')).textContent).toBe(vi_['pay.sform.calendar.empty']);
    const pick = screen.getByLabelText(vi_['pay.sform.forms.pick']) as HTMLSelectElement;
    expect(Array.from(pick.options).map((option) => option.value)).toEqual(['', settlementId(1), settlementId(2)]);
    expect(Array.from(pick.options)[2]?.textContent).toContain(`${vi_['pay.sform.forms.year']} 2026`);
    expect(screen.getByTestId('choose').textContent).toBe(vi_['pay.sform.forms.notice']);
  });

  it('shows the forms of the settlement chosen, the ones that stand first, with the template, the legal basis and the hash, and tells the decision from the others', async () => {
    const forms = new Map([[settlementId(1), [formRecord(1, '01/QTDA'), formRecord(2, '10/QTDA'), formRecord(3, '01/QTDA', { status: 'SUPERSEDED' })]]]);
    open(world({ settlements: [verified(1)], forms }), { path: `/pay/pay-16?settlement=${settlementId(1)}` });
    const table = await screen.findByTestId('forms');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => [row.getAttribute('data-form'), row.getAttribute('data-status')])).toEqual([
      ['01/QTDA', 'GENERATED'],
      ['10/QTDA', 'GENERATED'],
      ['01/QTDA', 'SUPERSEDED'],
    ]);
    expect(within(rows[0] as HTMLElement).getByTestId('template').textContent).toBe('PAY-QT-01QTDA · 1');
    expect(within(rows[0] as HTMLElement).getByTestId('basis').textContent).toBe('Thông tư 96/2021/TT-BTC');
    expect(within(rows[0] as HTMLElement).getByTestId('hash').textContent).toBe('a'.repeat(12));
    expect(within(rows[0] as HTMLElement).getByTestId('form-status').textContent).toBe(vi_['pay.sform.status.generated']);
    expect(within(rows[2] as HTMLElement).getByTestId('form-status').className).toContain('warning');
    expect(within(rows[0] as HTMLElement).queryByTestId('decision-note')).toBeNull();
    expect(within(rows[1] as HTMLElement).getByTestId('decision-note').textContent).toContain(vi_['pay.sform.decision.note']);
    expect(screen.getByTestId('standing').textContent).toBe(text('pay.sform.standing', { n: 2 }));
  });

  it('says that no form was drawn yet, and that a settlement outside the scope is not there', async () => {
    open(world({ settlements: [verified(1)], forms: new Map([[settlementId(1), []]]) }), { path: `/pay/pay-16?settlement=${settlementId(1)}` });
    expect((await screen.findByTestId('forms-empty')).textContent).toBe(vi_['pay.sform.forms.empty']);
    cleanup();
    open(world({ settlements: [verified(1)] }), { path: `/pay/pay-16?settlement=${settlementId(1)}` });
    expect((await screen.findByTestId('forms-missing')).textContent).toBe(vi_['pay.sform.forms.missing']);
  });

  it('AC-ST-PAY-012-1: draws the forms chosen of the scope of the settlement, in the order of the list, with the place, and tells that the forms were drawn', async () => {
    const h = open(world({ settlements: [verified(1)], forms: new Map([[settlementId(1), []]]) }), { path: `/pay/pay-16?settlement=${settlementId(1)}`, command: () => answer({ status: 'VERIFIED' }) });
    fireEvent.click(await screen.findByRole('button', { name: vi_['pay.sform.generate.action'] }));
    expect(within(dialog()).getAllByRole('checkbox')).toHaveLength(12);
    fireEvent.click(within(dialog()).getByRole('button', { name: vi_['pay.sform.generate.submit'] }));
    expect(await within(dialog()).findByText(vi_['pay.sform.problem.codes'])).toBeTruthy();
    expect(within(dialog()).getByText(vi_['pay.sform.problem.place'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    check('10/QTDA');
    check('01/QTDA');
    check('10/QTDA');
    check('10/QTDA');
    fireEvent.change(within(dialog()).getByLabelText(vi_['pay.sform.field.place']), { target: { value: 'x'.repeat(101) } });
    fireEvent.click(within(dialog()).getByRole('button', { name: vi_['pay.sform.generate.submit'] }));
    expect(await within(dialog()).findByText(vi_['pay.sform.problem.placeLong'])).toBeTruthy();
    fireEvent.change(within(dialog()).getByLabelText(vi_['pay.sform.field.place']), { target: { value: ' Cao Bằng ' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: vi_['pay.sform.generate.submit'] }));
    await waitFor(() => expect(commandsOf(h, 'generateSettlementForms')).toHaveLength(1));
    expect(commandsOf(h, 'generateSettlementForms')[0]).toMatchObject({ path: { id: settlementId(1) }, body: { form_codes: ['01/QTDA', '10/QTDA'], place: 'Cao Bằng' } });
    expect((await screen.findByTestId('done')).textContent).toBe(vi_['pay.sform.done']);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the forms of a settlement named in the address although the list does not hold it, and draws them', async () => {
    // The list read does not hold this settlement (it is past the pages read): only the read of one settlement knows it.
    open(world({ settlements: [verified(1)], listed: [], forms: new Map([[settlementId(1), []]]) }), { path: `/pay/pay-16?settlement=${settlementId(1)}` });
    fireEvent.click(await screen.findByRole('button', { name: vi_['pay.sform.generate.action'] }));
    expect(dialog()).toBeTruthy();
    expect((screen.getByLabelText(vi_['pay.sform.forms.pick']) as HTMLSelectElement).value).toBe(settlementId(1));
  });

  it('offers the five forms of a year for a settlement of a year', async () => {
    open(world({ settlements: [verified(2, { settlement_scope: 'ANNUAL', fiscal_year: 2026 })], forms: new Map([[settlementId(2), []]]) }), { path: `/pay/pay-16?settlement=${settlementId(2)}` });
    fireEvent.click(await screen.findByRole('button', { name: vi_['pay.sform.generate.action'] }));
    expect(within(dialog()).getAllByRole('checkbox').map((box) => box.parentElement?.textContent?.trim())).toEqual(['01/QTNĐ', '02/QTNĐ', '03/QTNĐ', '04/QTNĐ', '05/QTNĐ']);
    fireEvent.click(within(dialog()).getByRole('button', { name: vi_['pay.sform.dialog.cancel'] }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each([
    ['TEMPLATE_UNCONFIRMED', 422, { form_code: '02/QTDA' }, text('pay.sform.error.templateUnconfirmed', { form: '02/QTDA' })],
    ['TEMPLATE_NOT_EFFECTIVE', 422, { form_code: '01/QTDA' }, text('pay.sform.error.templateNotEffective', { form: '01/QTDA' })],
    ['SETTLEMENT_STATE_INVALID', 409, {}, vi_['pay.sform.error.stateInvalid']],
    ['VALIDATION_FAILED', 422, {}, vi_['pay.sform.error.validation']],
    ['PROVIDER_UNAVAILABLE', 503, {}, vi_['pay.sform.error.unavailable']],
    ['RESOURCE_NOT_FOUND', 404, {}, vi_['pay.sform.error.notFound']],
    ['SCOPE_DENIED', 403, {}, vi_['pay.sform.error.denied']],
    ['SESSION_EXPIRED', 401, {}, vi_['pay.sform.error.session']],
    ['INTERNAL', 500, {}, vi_['pay.sform.error.general']],
  ] as const)('says in words why the server refused with %s', async (code, status, extensions, message) => {
    open(world({ settlements: [verified(1)], forms: new Map([[settlementId(1), []]]) }), {
      path: `/pay/pay-16?settlement=${settlementId(1)}`,
      command: () => new ApiError({ status, code, correlationId: 'c', extensions }),
    });
    fireEvent.click(await screen.findByRole('button', { name: vi_['pay.sform.generate.action'] }));
    check('01/QTDA');
    fireEvent.change(within(dialog()).getByLabelText(vi_['pay.sform.field.place']), { target: { value: 'Cao Bằng' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: vi_['pay.sform.generate.submit'] }));
    expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(message);
  });

  it('shows a reader the calendar and the forms and no button, takes no command in the read-only mode, and says so to who may not read', async () => {
    open(world({ settlements: [verified(1)], forms: new Map([[settlementId(1), [formRecord(1, '01/QTDA')]]]) }), { permissions: READER, path: `/pay/pay-16?settlement=${settlementId(1)}` });
    await screen.findByTestId('forms');
    expect(screen.queryByRole('button', { name: vi_['pay.sform.generate.action'] })).toBeNull();
    cleanup();
    open(world({ settlements: [verified(1)], forms: new Map([[settlementId(1), []]]) }), { mode: 'READ_ONLY', path: `/pay/pay-16?settlement=${settlementId(1)}` });
    await screen.findByTestId('forms-empty');
    expect(screen.queryByRole('button', { name: vi_['pay.sform.generate.action'] })).toBeNull();
    cleanup();
    open(world(), { permissions: [] });
    expect((await screen.findByTestId('no-read')).textContent).toBe(vi_['pay.sform.read.denied']);
  });

  it('offers a retry when the settlements could not be read, and lets the person change the settlement', async () => {
    const h = open(world({ failing: new Set(['get_resources_settlement_revision']) }));
    fireEvent.click(await screen.findByRole('button', { name: vi_['states.retry.action'] }));
    await waitFor(() => expect((h.client.readAll as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((call) => call[0] === 'get_resources_settlement_revision').length).toBeGreaterThanOrEqual(2));
    cleanup();
    open(world({ settlements: [verified(1), verified(2)], forms: new Map([[settlementId(1), [formRecord(1, '01/QTDA')]], [settlementId(2), []]]) }), { path: `/pay/pay-16?settlement=${settlementId(1)}` });
    await screen.findByTestId('forms');
    fireEvent.change(screen.getByLabelText(vi_['pay.sform.forms.pick']), { target: { value: settlementId(2) } });
    expect(await screen.findByTestId('forms-empty')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(vi_['pay.sform.forms.pick']), { target: { value: '' } });
    expect(await screen.findByTestId('choose')).toBeTruthy();
  });
});

describe('the model of PAY-16', () => {
  it('names the forms of each scope, and none for a contract', () => {
    expect(formsOf('ANNUAL')).toHaveLength(5);
    expect(formsOf('PROJECT')).toHaveLength(12);
    expect(formsOf('CONTRACT')).toEqual([]);
  });

  it('puts a settlement at a stage of the reminders by the days left', () => {
    const today = '2026-10-26';
    expect(stageOf('2026-10-25', today)).toBe('OVERDUE');
    expect(stageOf('2026-10-26', today)).toBe('T7');
    expect(stageOf('2026-11-02', today)).toBe('T7');
    expect(stageOf('2026-11-03', today)).toBe('T30');
    expect(stageOf('2026-11-25', today)).toBe('T30');
    expect(stageOf('2026-11-26', today)).toBe('LATER');
    expect(stageOf('soon', today)).toBeUndefined();
  });

  it('keeps in the calendar only the settlements with a deadline that wait for it', () => {
    const lines = ['SUBMITTED', 'VERIFYING', 'VERIFIED', 'DRAFT'].map((status, n) => toSettlement(sent(n + 1, { status, verification_due_on: '2026-11-0' + (n + 1) })));
    const noDay = toSettlement(sent(7, { verification_due_on: null }));
    const odd = toSettlement(sent(8, { verification_due_on: 'x' }));
    const found = calendarOf([...lines, noDay, odd].flatMap((line) => (line === undefined ? [] : [line])), '2026-10-26');
    expect(found.map((line) => line.dueOn)).toEqual(['2026-11-01', '2026-11-02']);
  });

  it('validates the form against the scope and builds the body in the order of the list', () => {
    expect(validateGenerate({ codes: [], place: '' }, 'PROJECT')).toEqual({ codes: 'codes', place: 'place' });
    expect(validateGenerate({ codes: ['01/QTNĐ'], place: 'x' }, 'PROJECT')).toEqual({ codes: 'codes' });
    expect(validateGenerate({ codes: ['01/QTDA'], place: 'x'.repeat(101) }, 'PROJECT')).toEqual({ place: 'placeLong' });
    expect(validateGenerate({ codes: ['01/QTDA'], place: ' Cao Bằng ' }, 'PROJECT')).toEqual({});
    expect(validateGenerate({ codes: ['01/QTDA'], place: 'x' }, 'CONTRACT')).toEqual({ codes: 'codes' });
    expect(generateBody({ codes: ['10/QTDA', '01/QTDA'], place: ' Cao Bằng ' }, 'PROJECT')).toEqual({ form_codes: ['01/QTDA', '10/QTDA'], place: 'Cao Bằng' });
  });

  it('reads a form and the refusal of the server', () => {
    expect(toSettlementForm(undefined)).toBeUndefined();
    expect(toSettlementForm({ id: 'a', form_code: '01/QTDA', status: 'ODD' })).toBeUndefined();
    expect(toSettlementForm({ id: 'a', form_code: '01/QTDA', status: 'REQUESTED' })).toEqual({ id: 'a', formCode: '01/QTDA', status: 'REQUESTED', templateCode: null, templateRevision: null, legalBasis: '', fileSha256: null, generatedAt: null });
    const forms = [formRecord(1, '01/QTDA'), formRecord(2, '02/QTDA', { status: 'SUPERSEDED' })].flatMap((raw) => toSettlementForm(raw) ?? []);
    expect(standing(forms).map((form) => form.formCode)).toEqual(['01/QTDA']);
    expect(describeRefusal(new Error('boom'))).toEqual({ problem: 'general', formCode: null });
    expect(describeRefusal(new ApiError({ status: 422, code: 'TEMPLATE_UNCONFIRMED', correlationId: 'c', extensions: { form_code: '02/QTDA' } }))).toEqual({ problem: 'templateUnconfirmed', formCode: '02/QTDA' });
    expect(describeRefusal(new ApiError({ status: 418, code: 'TEAPOT', correlationId: 'c', extensions: {} }))).toEqual({ problem: 'general', formCode: null });
  });
});
