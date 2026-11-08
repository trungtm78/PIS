import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { translator } from '../../../i18n';
import base from '../../../i18n/vi.json';
import RegisterScreen from './RegisterScreen';
import { ALL, READER, client, duplicate, figures, mount, policy, registerLine, registerPage, routeOf, uuid } from '../shared/test/vnd-test-support';
import type { World } from '../shared/test/vnd-test-support';

const word = (key: string): string => (base as Record<string, string>)[key] ?? key;
const problem = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });
const route = routeOf('VND-01', 'FR-VND-01');

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
});

const indicator = (code: string, over: Record<string, unknown> = {}) => ({ code, name: `Indicator ${code}`, formula: `Formula of ${code}`, source: `Source of ${code}`, unverified: true, numerator: 3, denominator: 4, pct: 75, ...over });
const controls = (indicators: unknown[] = [indicator('VENDOR_INDEPENDENCE_CHECKED'), indicator('VENDOR_RISK_GRADED', { numerator: 2, denominator: 0, pct: null }), indicator('VENDOR_SUBCONTRACT_PAID', { numerator: 5, denominator: 9, pct: null, unverified: false })]) => ({ indicators, as_of: '2026-11-08T03:00:00.000Z' });
const queue = (items: unknown[] = [duplicate(1), duplicate(2, { status: 'DISMISSED', decision_reason: 'Two entities' })]) => ({ items, policy: policy('VENDOR_DUPLICATE_SIGNALS'), as_of: '2026-11-08T03:00:00.000Z' });

function open(over: Partial<World['answers']> = {}, permissions: string[] = READER, command?: (operation: string, input: unknown) => unknown, failing?: World['failing']) {
  const world: World = { answers: { listVendorRegister: registerPage([registerLine(1)]), getVendorFigures: figures(), getVendorControlFigures: controls(), listVendorDuplicates: queue(), ...over }, ...(failing === undefined ? {} : { failing }) };
  const h = client(world, command);
  mount(<RegisterScreen route={route} />, h, { permissions });
  return { h, world };
}

describe('RegisterScreen (VND-01): the indicators of the controls (getVendorControlFigures)', () => {
  it('shows each indicator with its number, numerator and denominator, and an "i" with its formula and source; a zero denominator is a dash', async () => {
    open();
    const panel = await screen.findByTestId('control-figures');
    await within(panel).findByTestId('control-VENDOR_INDEPENDENCE_CHECKED');
    const tile = (code: string): HTMLElement => within(panel).getByTestId(`control-${code}`).closest('article') as HTMLElement;
    expect(tile('VENDOR_INDEPENDENCE_CHECKED').textContent).toContain('75%');
    expect(tile('VENDOR_INDEPENDENCE_CHECKED').textContent).toContain('3');
    expect(tile('VENDOR_RISK_GRADED').querySelector('.ui-kpi__value')?.textContent).toBe('–');
    expect(tile('VENDOR_SUBCONTRACT_PAID').querySelector('.ui-kpi__value')?.textContent).toBe('5');
    expect(within(tile('VENDOR_INDEPENDENCE_CHECKED')).getByText(word('vnd.flag.unverified.badge'))).toBeTruthy();
    expect(within(tile('VENDOR_SUBCONTRACT_PAID')).queryByText(word('vnd.flag.unverified.badge'))).toBeNull();
    fireEvent.click(within(tile('VENDOR_INDEPENDENCE_CHECKED')).getByRole('button', { name: /Indicator VENDOR_INDEPENDENCE_CHECKED/ }));
    expect(await screen.findByText('Formula of VENDOR_INDEPENDENCE_CHECKED')).toBeTruthy();
    expect(screen.getByText('Source of VENDOR_INDEPENDENCE_CHECKED')).toBeTruthy();
  });

  it('says there is nothing to show when no indicator is registered', async () => {
    open({ getVendorControlFigures: controls([]) });
    expect(await screen.findByTestId('controls-empty')).toBeTruthy();
  });

  it('says an error with a retry that reads again', async () => {
    const { h } = open({}, READER, undefined, { getVendorControlFigures: { times: 1, error: problem(500, 'INTERNAL') } });
    const error = await screen.findByTestId('controls-error');
    fireEvent.click(within(error).getByRole('button', { name: word('ui.common.retry') }));
    await screen.findByTestId('control-VENDOR_INDEPENDENCE_CHECKED');
    expect(h.read.mock.calls.filter(([operation]) => operation === 'getVendorControlFigures')).toHaveLength(2);
  });

  it('says the scope is too narrow on a refusal, and shows no number', async () => {
    open({ getVendorControlFigures: problem(403, 'SCOPE_DENIED') });
    expect(await screen.findByTestId('controls-hidden')).toBeTruthy();
    expect(screen.queryByTestId('control-VENDOR_INDEPENDENCE_CHECKED')).toBeNull();
  });
});

describe('RegisterScreen (VND-01 and VND-02): the queue of suggested duplicates (listVendorDuplicates)', () => {
  it('lists the open suggestions of the whole register first, with links to both profiles, the signals and the "i" of the score', async () => {
    const { h } = open();
    const panel = await screen.findByTestId('duplicate-queue');
    await waitFor(() => expect(panel.querySelectorAll('tr[data-duplicate-id]').length).toBe(2));
    expect(h.read).toHaveBeenCalledWith('listVendorDuplicates', { query: { status: 'OPEN' } });
    const first = panel.querySelector('tr[data-duplicate-id]') as HTMLElement;
    expect(within(first).getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([`/vnd/vnd-02?contractor=${uuid('0001', 1)}`, `/vnd/vnd-02?contractor=${uuid('0001', 2)}`]);
    expect(first.textContent).toContain(word('vnd.signal.taxHead.name'));
    fireEvent.click(within(first).getByRole('button', { name: new RegExp(word('vnd.duplicates.figure.score.name')) }));
    expect(await screen.findByText('Formula of VENDOR_DUPLICATE_SIGNALS')).toBeTruthy();
  });

  it('reads another state when the filter changes', async () => {
    const { h } = open();
    await screen.findByTestId('duplicate-queue');
    fireEvent.change(screen.getByTestId('duplicate-status'), { target: { value: 'DISMISSED' } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listVendorDuplicates', { query: { status: 'DISMISSED' } }));
    fireEvent.change(screen.getByTestId('duplicate-status'), { target: { value: '' } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listVendorDuplicates', { query: {} }));
  });

  it('says there is no suggestion, an error with a retry, and a refusal of the scope', async () => {
    open({ listVendorDuplicates: queue([]) });
    expect(await screen.findByTestId('duplicate-queue-empty')).toBeTruthy();
    cleanup();
    open({}, READER, undefined, { listVendorDuplicates: { times: 1, error: problem(500, 'INTERNAL') } });
    const error = await screen.findByTestId('duplicates-error');
    fireEvent.click(within(error).getByRole('button', { name: word('ui.common.retry') }));
    await waitFor(() => expect(document.querySelectorAll('tr[data-duplicate-id]').length).toBe(2));
    cleanup();
    open({ listVendorDuplicates: problem(403, 'SCOPE_DENIED') });
    expect(await screen.findByTestId('duplicates-hidden')).toBeTruthy();
  });

  it('offers the decision only to a person who may decide, and only on an open suggestion', async () => {
    open({}, READER);
    await waitFor(() => expect(document.querySelectorAll('tr[data-duplicate-id]').length).toBe(2));
    expect(screen.queryByTestId('queue-dismiss')).toBeNull();
    cleanup();
    open({}, ALL);
    await waitFor(() => expect(document.querySelectorAll('tr[data-duplicate-id]').length).toBe(2));
    expect(screen.getAllByTestId('queue-dismiss')).toHaveLength(1);
    expect(screen.getAllByTestId('queue-merge')).toHaveLength(1);
  });

  it('dismisses a suggestion with a reason under the version that was read, and says it was recorded', async () => {
    const { h } = open({}, ALL, () => ({ operation_id: 'o', status: 'DISMISSED', resource_version: 2 }));
    await waitFor(() => expect(screen.getByTestId('queue-dismiss')).toBeTruthy());
    fireEvent.click(screen.getByTestId('queue-dismiss'));
    const form = screen.getByRole('dialog', { name: word('vnd.duplicates.dismiss.title') });
    fireEvent.change(within(form).getByLabelText(new RegExp(word('vnd.field.reason.label'))), { target: { value: 'Hai pháp nhân khác nhau' } });
    fireEvent.click(within(form).getByRole('button', { name: word('vnd.duplicates.dismiss.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('decideVendorDuplicate', { path: { id: uuid('0014', 1) }, ifMatchVersion: 1, body: { decision: 'DISMISSED', reason: 'Hai pháp nhân khác nhau' }, attempt: { key: expect.any(String) } }));
    expect(await screen.findByText(word('lookahead.vnd.duplicates.receipt'))).toBeTruthy();
  });

  it('keeps the dialog open and says the refusal when the server refuses', async () => {
    open({}, ALL, () => Promise.reject(problem(409, 'VERSION_CONFLICT')));
    await waitFor(() => expect(screen.getByTestId('queue-merge')).toBeTruthy());
    fireEvent.click(screen.getByTestId('queue-merge'));
    const form = screen.getByRole('dialog', { name: word('vnd.duplicates.merge.title') });
    fireEvent.change(within(form).getByLabelText(new RegExp(word('vnd.field.reason.label'))), { target: { value: 'Cùng mã số thuế và địa chỉ' } });
    fireEvent.click(within(form).getByRole('button', { name: word('vnd.duplicates.merge.confirm') }));
    expect(await within(form).findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(word('lookahead.vnd.duplicates.receipt'))).toBeNull();
  });
});
