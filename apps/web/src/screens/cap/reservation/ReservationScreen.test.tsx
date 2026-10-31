import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { client, line, mount, routeOf, world } from '../../prj/test-support';
import type { Harness } from '../../prj/test-support';
import ReservationScreen from './ReservationScreen';
import { EMPTY_CREATE, countdownOf, createBody, describeCreate, describeRelease, holds, toReservationPage, validReason, validateCreate } from './model';

const ROUTE = routeOf('CAP-18', 'FR-CAP-18');
const MANAGER = ['capital.reservation.manage', 'capital.read'];
const READER = ['capital.read'];
const LINE = '00000000-0000-4000-8000-0000000000a1';
const OK = { operation_id: 'o', status: 'ACTIVE', resource_version: 1, resource_id: 'x' };
const word = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);
const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();
const dayAfter = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const reservation = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-0000000000c${n}`,
  allocation_line_id: LINE,
  project: { id: line(1).id, code: 'DA-2026-001', name: 'Dự án số 1' },
  plan_year: 2026,
  purpose: 'CONTRACT_PENDING',
  reference_kind: null,
  reference_id: null,
  amount_vnd: '150000000',
  expires_at: inDays(10.5),
  status: 'ACTIVE',
  release_reason: null,
  avc_warning_acknowledged: false,
  created_at: '2026-10-01T00:00:00.000Z',
  created_by: '00000000-0000-4000-8000-000000000001',
  closed_at: null,
  closed_by: null,
  version: 1,
  ...overrides,
});
const page = (items: unknown[], next: string | null = null) => ({ items, next_cursor: next, as_of: '2026-10-31T00:00:00.000Z' });

afterEach(cleanup);

function open(pages: Array<Record<string, unknown>>, command: (operation: string, input: unknown) => unknown = () => OK, permissions: readonly string[] = MANAGER, path = '/cap/cap-18', failing?: Error): Harness {
  const h = client(world(), command);
  const base = h.read.getMockImplementation();
  let call = 0;
  h.read.mockImplementation((operation: string, input?: unknown) => {
    if (operation !== 'listFundReservations') return (base?.(operation, input) as Promise<unknown>) ?? Promise.reject(new Error(`unexpected read ${operation}`));
    if (failing !== undefined) return Promise.reject(failing);
    const found = pages[Math.min(call, pages.length - 1)];
    call += 1;
    return Promise.resolve(found);
  });
  mount(<ReservationScreen route={ROUTE} />, h, { permissions, path });
  return h;
}
const sent = (h: Harness) => h.command.mock.calls.map(([name, input]) => ({ name, ...(input as { path?: Record<string, string>; body?: Record<string, unknown>; ifMatchVersion?: number }) }));
const reads = (h: Harness): Array<{ query?: Record<string, unknown> }> => h.read.mock.calls.filter((call) => call[0] === 'listFundReservations').map((call) => call[1] as { query?: Record<string, unknown> });
const form = (): HTMLElement => screen.getByRole('form', { name: word('cap.reservation.form.title') });
const fill = (label: string, value: string): void => {
  fireEvent.change(within(form()).getByLabelText(label), { target: { value } });
};
const fillValid = (): void => {
  fill(word('cap.reservation.field.line.label'), LINE);
  fill(word('cap.reservation.field.amount.label'), '150.000.000');
  fill(word('cap.reservation.field.expires.label'), dayAfter(30));
};
const submit = (): void => {
  fireEvent.click(within(form()).getByRole('button', { name: word('cap.reservation.form.submit.action') }));
};

describe('ReservationScreen (CAP-18): the earmark of capital', () => {
  it('UI-CAP-18: lists the reservations with the project, purpose, amount, what is left of the time and the status in words', async () => {
    open([page([reservation(1), reservation(2, { status: 'RELEASED', release_reason: 'The contract was dropped.', purpose: 'LAND_CLEARANCE' }), reservation(3, { expires_at: inDays(0.3), purpose: 'ADVANCE_PENDING' }), reservation(4, { expires_at: inDays(-1) })])]);
    const table = await screen.findByTestId('reservations');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('cap.reservation.page.title'));
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(4);
    expect(rows[0]?.textContent).toContain('DA-2026-001');
    expect(rows[0]?.textContent).toContain(word('cap.reservation.purpose.contract'));
    expect(rows[0]?.textContent).toContain(word('cap.reservation.value.amount', { amount: (150000000).toLocaleString('vi') }));
    expect(rows[0]?.textContent).toContain(word('cap.reservation.status.active'));
    expect(within(rows[0] as HTMLElement).getByTestId('countdown').textContent).toBe(word('cap.reservation.countdown.days', { count: 10 }));
    expect(rows[1]?.textContent).toContain(word('cap.reservation.status.released'));
    expect(rows[1]?.textContent).toContain('The contract was dropped.');
    expect(within(rows[1] as HTMLElement).queryByTestId('countdown')).toBeNull();
    expect(within(rows[2] as HTMLElement).getByTestId('countdown').textContent).toMatch(/^Còn \d+ giờ$/);
    expect(within(rows[3] as HTMLElement).getByTestId('countdown').textContent).toBe(word('cap.reservation.countdown.over'));
    expect(within(rows[0] as HTMLElement).getByRole('button', { name: word('cap.reservation.release.action') })).toBeTruthy();
    expect(within(rows[1] as HTMLElement).queryByRole('button')).toBeNull();
  });

  it('shows a reader the list and no form and no button', async () => {
    open([page([reservation(1)])], () => OK, READER);
    await screen.findByTestId('reservations');
    expect(screen.queryByRole('form', { name: word('cap.reservation.form.title') })).toBeNull();
    expect(screen.queryByRole('button', { name: word('cap.reservation.release.action') })).toBeNull();
  });

  it('asks for the list by status, a page at a time, and says when there is none', async () => {
    const h = open([page([reservation(1)], 'cursor-1'), page([reservation(2)])]);
    await screen.findByTestId('reservations');
    fireEvent.click(await screen.findByRole('button', { name: word('cap.reservation.more.action') }));
    await waitFor(() => expect(within(screen.getByTestId('reservations')).getAllByRole('row')).toHaveLength(3));
    expect(reads(h).at(-1)?.query).toMatchObject({ cursor: 'cursor-1' });
    fireEvent.change(screen.getByLabelText(word('cap.reservation.filter.status.label')), { target: { value: 'EXPIRED' } });
    await waitFor(() => expect(reads(h).at(-1)?.query).toMatchObject({ status: 'EXPIRED' }));
    cleanup();
    open([page([])]);
    expect((await screen.findAllByText(word('states.empty.title'))).length).toBeGreaterThan(0);
  });

  it('asks for the line, the amount and the last day before it asks the server, then sends them with the end of the day in Vietnamese time', async () => {
    const h = open([page([])]);
    await screen.findByRole('form', { name: word('cap.reservation.form.title') });
    submit();
    expect(await within(form()).findAllByText(word('cap.reservation.field.required.error'))).toHaveLength(3);
    expect(h.command).not.toHaveBeenCalled();
    fill(word('cap.reservation.field.line.label'), 'not an identifier');
    fill(word('cap.reservation.field.amount.label'), '12.5x');
    fill(word('cap.reservation.field.expires.label'), '2020-01-01');
    submit();
    expect(await within(form()).findAllByText(word('cap.reservation.field.invalid.error'))).toHaveLength(3);
    expect(h.command).not.toHaveBeenCalled();
    fillValid();
    fill(word('cap.reservation.field.referenceKind.label'), 'LAND_PLOT');
    submit();
    expect(await within(form()).findByText(word('cap.reservation.field.required.error'))).toBeTruthy();
    fill(word('cap.reservation.field.referenceId.label'), LINE);
    fireEvent.change(within(form()).getByLabelText(word('cap.reservation.field.purpose.label')), { target: { value: 'LAND_CLEARANCE' } });
    submit();
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(sent(h)[0]).toMatchObject({
      name: 'createFundReservation',
      body: { allocation_line_id: LINE, amount_vnd: '150000000', purpose: 'LAND_CLEARANCE', expires_at: new Date(`${dayAfter(30)}T23:59:59+07:00`).toISOString(), reference_kind: 'LAND_PLOT', reference_id: LINE },
    });
    expect(sent(h)[0]?.body).not.toHaveProperty('avc_acknowledged');
    expect((await screen.findByTestId('create-saved')).textContent).toBe(word('cap.reservation.form.saved'));
  });

  it('UAT-PLAN-10: tells in words the share the warning gives, asks for the acknowledgement, and sends it only for the request it was given for', async () => {
    let calls = 0;
    const h = open([page([])], () => {
      calls += 1;
      return calls === 1 ? new ApiError({ status: 422, code: 'AVC_WARNING_ACK_REQUIRED', correlationId: 'c', extensions: { consumption_pct: '100.00', warn_pct: '90.00', block_pct: '100.00' } }) : OK;
    });
    await screen.findByRole('form', { name: word('cap.reservation.form.title') });
    fillValid();
    submit();
    const refusal = await within(form()).findByTestId('create-refusal');
    expect(refusal.textContent).toBe(word('cap.reservation.problem.warn', { consumption: '100.00', warn: '90.00', block: '100.00' }));
    const ack = within(form()).getByLabelText(word('cap.reservation.field.ack.label')) as HTMLInputElement;
    expect(ack.checked).toBe(false);
    // A change of the request takes the acceptance away: the warning is read again for the new one.
    fireEvent.click(ack);
    fill(word('cap.reservation.field.amount.label'), '160000000');
    expect(within(form()).queryByLabelText(word('cap.reservation.field.ack.label'))).toBeNull();
    submit();
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    expect(sent(h)[1]?.body).not.toHaveProperty('avc_acknowledged');
    expect(sent(h)[1]?.body).toMatchObject({ amount_vnd: '160000000' });
  });

  it('sends the acknowledgement once the person has accepted the warning', async () => {
    let calls = 0;
    const h = open([page([])], () => {
      calls += 1;
      return calls === 1 ? new ApiError({ status: 422, code: 'AVC_WARNING_ACK_REQUIRED', correlationId: 'c', extensions: { consumption_pct: '95.00', warn_pct: '90.00', block_pct: '100.00' } }) : OK;
    });
    await screen.findByRole('form', { name: word('cap.reservation.form.title') });
    fillValid();
    submit();
    fireEvent.click(await within(form()).findByLabelText(word('cap.reservation.field.ack.label')));
    submit();
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    expect(sent(h)[1]?.body).toMatchObject({ avc_acknowledged: true, amount_vnd: '150000000' });
    expect((await screen.findByTestId('create-saved')).textContent).toBe(word('cap.reservation.form.saved'));
  });

  it.each([
    ['AVC_BLOCKED', 422, { consumption_pct: '110.00', warn_pct: '90.00', block_pct: '100.00' }, word('cap.reservation.problem.blocked', { consumption: '110.00', warn: '90.00', block: '100.00' })],
    ['FISCAL_YEAR_LOCKED', 409, {}, word('cap.reservation.problem.yearLocked')],
    ['SCOPE_DENIED', 403, {}, word('cap.reservation.problem.scopeDenied')],
    ['RESOURCE_NOT_FOUND', 404, {}, word('cap.reservation.problem.notFound')],
    ['VALIDATION_FAILED', 422, {}, word('cap.reservation.problem.validation')],
    ['INTERNAL', 500, {}, word('cap.reservation.problem.general')],
  ] as const)('says in words why the server refused with %s, and offers no acknowledgement for it', async (code, status, extensions, message) => {
    open([page([])], () => new ApiError({ status, code, correlationId: 'c', extensions }));
    await screen.findByRole('form', { name: word('cap.reservation.form.title') });
    fillValid();
    submit();
    expect((await within(form()).findByTestId('create-refusal')).textContent).toBe(message);
    expect(within(form()).queryByLabelText(word('cap.reservation.field.ack.label'))).toBeNull();
  });

  it('keeps the form as it was sent while the request is on its way: nothing can be edited and nothing sent twice', async () => {
    const h = open([page([])], () => new Promise(() => undefined));
    await screen.findByRole('form', { name: word('cap.reservation.form.title') });
    fillValid();
    submit();
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((within(form()).getByLabelText(word('cap.reservation.field.amount.label')) as HTMLInputElement).matches(':disabled')).toBe(true));
    fireEvent.click(within(form()).getByRole('button', { name: word('cap.reservation.form.submit.action') }));
    expect(h.command).toHaveBeenCalledTimes(1);
  });

  it('starts with the line the address names', async () => {
    open([page([])], () => OK, MANAGER, `/cap/cap-18?line=${LINE}`);
    await screen.findByRole('form', { name: word('cap.reservation.form.title') });
    expect((within(form()).getByLabelText(word('cap.reservation.field.line.label')) as HTMLInputElement).value).toBe(LINE);
  });

  it('releases an active reservation with a reason, against the version it read', async () => {
    const h = open([page([reservation(1, { version: 3 })])]);
    fireEvent.click(await screen.findByRole('button', { name: word('cap.reservation.release.action') }));
    const panel = await screen.findByRole('form', { name: word('cap.reservation.release.title') });
    fireEvent.click(within(panel).getByRole('button', { name: word('cap.reservation.release.submit.action') }));
    expect(await within(panel).findByText(word('cap.reservation.release.reason.error'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(panel).getByLabelText(word('cap.reservation.release.reason.label')), { target: { value: '  The contract was dropped.  ' } });
    fireEvent.click(within(panel).getByRole('button', { name: word('cap.reservation.release.submit.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(sent(h)[0]).toMatchObject({ name: 'releaseFundReservation', path: { id: reservation(1).id }, ifMatchVersion: 3, body: { reason: 'The contract was dropped.' } });
    await waitFor(() => expect(screen.queryByRole('form', { name: word('cap.reservation.release.title') })).toBeNull());
  });

  it.each([
    ['RESERVATION_NOT_ACTIVE', 409, 'notActive'],
    ['VERSION_CONFLICT', 409, 'stale'],
    ['SCOPE_DENIED', 403, 'scopeDenied'],
    ['RESOURCE_NOT_FOUND', 404, 'notFound'],
    ['VALIDATION_FAILED', 422, 'validation'],
    ['INTERNAL', 500, 'general'],
  ] as const)('says in words why the release was refused with %s, and keeps the form', async (code, status, problem) => {
    open([page([reservation(1)])], () => new ApiError({ status, code, correlationId: 'c' }));
    fireEvent.click(await screen.findByRole('button', { name: word('cap.reservation.release.action') }));
    const panel = await screen.findByRole('form', { name: word('cap.reservation.release.title') });
    fireEvent.change(within(panel).getByLabelText(word('cap.reservation.release.reason.label')), { target: { value: 'The contract was dropped.' } });
    fireEvent.click(within(panel).getByRole('button', { name: word('cap.reservation.release.submit.action') }));
    expect((await within(panel).findByTestId('release-refusal')).textContent).toBe(word(`cap.reservation.release.problem.${problem}`));
    fireEvent.click(within(panel).getByRole('button', { name: word('cap.reservation.cancel.action') }));
    await waitFor(() => expect(screen.queryByRole('form', { name: word('cap.reservation.release.title') })).toBeNull());
  });

  it('offers a retry when the list could not be read', async () => {
    const h = open([page([])], () => OK, MANAGER, '/cap/cap-18', new ApiError({ status: 500, code: 'INTERNAL', correlationId: 'c' }));
    fireEvent.click(await screen.findByRole('button', { name: word('states.retry.action') }));
    await waitFor(() => expect(reads(h).length).toBeGreaterThanOrEqual(2));
  });
});

describe('the model of CAP-18', () => {
  const NOW = new Date('2026-10-31T00:00:00Z');

  it('says what is left of the time: days while there are some, then hours, then over', () => {
    expect(countdownOf('2026-11-10T12:00:00Z', NOW)).toEqual({ kind: 'days', count: 10 });
    expect(countdownOf('2026-11-01T00:00:00Z', NOW)).toEqual({ kind: 'days', count: 1 });
    expect(countdownOf('2026-10-31T10:30:00Z', NOW)).toEqual({ kind: 'hours', count: 11 });
    expect(countdownOf('2026-10-31T00:00:01Z', NOW)).toEqual({ kind: 'hours', count: 1 });
    expect(countdownOf('2026-10-31T00:00:00Z', NOW)).toEqual({ kind: 'over' });
    expect(countdownOf('2020-01-01T00:00:00Z', NOW)).toEqual({ kind: 'over' });
    expect(countdownOf('not a time', NOW)).toEqual({ kind: 'over' });
  });

  it('reads a page and leaves out what is not a reservation', () => {
    expect(toReservationPage(undefined)).toEqual({ items: [], nextCursor: undefined });
    const read = toReservationPage({ items: [null, { id: 'x' }, reservation(1, { purpose: 'ODD' }), reservation(2, { status: 'ODD' }), reservation(3, { version: '1' }), reservation(4, { project: null, plan_year: null }), reservation(5)], next_cursor: 'c' });
    expect(read.items.map((item) => item.id)).toEqual([reservation(4).id, reservation(5).id]);
    expect(read.items[0]).toMatchObject({ project: null, planYear: 0 });
    expect(read.nextCursor).toBe('c');
  });

  it('validates the form: a line, whole VND, a last day after today and within 366 days, and a reference that is a kind with an id', () => {
    const good = { ...EMPTY_CREATE, lineId: LINE, amount: '1.500.000', expiresOn: '2026-12-31' };
    expect(validateCreate(good, '2026-10-31', NOW)).toEqual({});
    expect(validateCreate(EMPTY_CREATE, '2026-10-31', NOW)).toEqual({ lineId: 'required', amount: 'required', expiresOn: 'required' });
    expect(validateCreate({ ...good, lineId: 'x', amount: '0', expiresOn: '2026-10-31' }, '2026-10-31', NOW)).toEqual({ lineId: 'invalid', amount: 'invalid', expiresOn: 'invalid' });
    for (const expiresOn of ['2026-02-30', '2026-13-01', '31/12/2026', '2027-11-01']) expect(validateCreate({ ...good, expiresOn }, '2026-10-31', NOW)).toEqual({ expiresOn: 'invalid' });
    expect(validateCreate({ ...good, expiresOn: '2027-10-31' }, '2026-10-31', NOW)).toEqual({});
    // The last day is the end of that day in Vietnam, 17:00 UTC: a year from the moment of asking leaves the 31st of October of the next year in and the 1st of November out.
    expect(validateCreate({ ...good, amount: '10.5' }, '2026-10-31', NOW)).toEqual({});
    expect(validateCreate({ ...good, amount: '10,5x' }, '2026-10-31', NOW)).toEqual({ amount: 'invalid' });
    expect(validateCreate({ ...good, referenceKind: 'LAND_PLOT' }, '2026-10-31', NOW)).toEqual({ referenceId: 'required' });
    expect(validateCreate({ ...good, referenceId: LINE }, '2026-10-31', NOW)).toEqual({ referenceKind: 'required' });
    expect(validateCreate({ ...good, referenceKind: 'K'.repeat(51), referenceId: 'x' }, '2026-10-31', NOW)).toEqual({ referenceKind: 'invalid', referenceId: 'invalid' });
  });

  it('builds the body: the digits of the amount, the end of the last day in Vietnamese time, the reference only when it is given, the acknowledgement only when it was made', () => {
    const form = { ...EMPTY_CREATE, lineId: LINE.toUpperCase(), amount: ' 1.500.000 ', expiresOn: '2026-12-31', purpose: 'OTHER' as const };
    expect(createBody(form, false)).toEqual({ allocation_line_id: LINE, amount_vnd: '1500000', purpose: 'OTHER', expires_at: '2026-12-31T16:59:59.000Z' });
    expect(createBody({ ...form, referenceKind: ' LAND_PLOT ', referenceId: LINE.toUpperCase() }, true)).toMatchObject({ reference_kind: 'LAND_PLOT', reference_id: LINE, avc_acknowledged: true });
  });

  it('knows a right only outside the read-only mode, a reason of 5 to 2000 characters, and a failure that is not the server\'s', () => {
    expect(holds(['x'], 'x', 'FULL')).toBe(true);
    expect(holds(['x'], 'x', 'READ_ONLY')).toBe(false);
    expect(holds(undefined, 'x', undefined)).toBe(true);
    expect(validReason('abcd')).toBe(false);
    expect(validReason('  abcde  ')).toBe(true);
    expect(validReason('x'.repeat(2001))).toBe(false);
    expect(describeCreate(new Error('boom'))).toEqual({ problem: 'general', consumptionPct: undefined, warnPct: undefined, blockPct: undefined });
    expect(describeCreate(new ApiError({ status: 418, code: 'TEAPOT', correlationId: 'c' })).problem).toBe('general');
    expect(describeRelease(new Error('boom'))).toBe('general');
    expect(describeRelease(new ApiError({ status: 418, code: 'TEAPOT', correlationId: 'c' }))).toBe('general');
  });
});
