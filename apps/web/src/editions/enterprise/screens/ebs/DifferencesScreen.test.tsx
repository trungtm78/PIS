import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../../../i18n';
import { EBS_ADMIN, EBS_READER, difference, ebsClient, ebsConnection, ebsRoute, mount, uuid } from '../shared/test-support';
import type { EbsWorld } from '../shared/test-support';
import DifferencesScreen from './DifferencesScreen';

const word = (key: string, params: Record<string, string | number> = {}): string => translator.t(key, params);
const route = ebsRoute('EBS-02');
const problem = (code: string, status: number) => new ApiError({ status, code, correlationId: 'c' });

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
  vi.restoreAllMocks();
});

const reconciled = () => ({ operation_id: 'o', status: 'RECONCILED', resource_version: 0, examined: 5, differences: 3, opened: 2, refreshed: 1, unchanged: 0, settled_already: 0, no_owner: 0, items: [] });

function mountWith(options: { world?: Partial<EbsWorld>; permissions?: string[]; mode?: 'FULL' | 'READ_ONLY'; command?: (operation: string, input: unknown) => unknown } = {}) {
  const world: EbsWorld = {
    connection: ebsConnection(),
    differences: [
      difference(1),
      difference(2, { measure: 'COMMITTED_VND', difference_kind: 'MISSING_OURS', ours: null, delta: null, overdue: true, due_at: '2026-11-01T16:59:59.999Z' }),
      difference(3, { state: 'RESOLVED', resolution: { kind: 'TIMING', resolved_by: uuid(7), resolved_by_name: 'Pham Van Cuong', resolved_at: '2026-11-07T02:00:00.000Z', reason: 'Booked next month', evidence_ref: null, review_on: '2026-12-01' }, delta: '-50', version: 2 }, { may_resolve: false, may_reassign: false }),
    ],
    ...options.world,
  };
  const h = ebsClient(world, options.command ?? ((operation) => (operation === 'reconcileEbs' ? reconciled() : { operation_id: 'o', status: 'OK', resource_version: 6 })));
  mount(<DifferencesScreen route={route} />, h, { permissions: options.permissions ?? EBS_ADMIN, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return { h, world };
}

describe('DifferencesScreen (EBS-02): the differences with Oracle EBS by project code', () => {
  it('UI-EBS-02: lists each difference with the project, the period, the measure, both figures, the signed gap, the owner, the due day and the state', async () => {
    mountWith();
    expect(await screen.findByRole('heading', { level: 1, name: word('ebs.differences.page.title') })).toBeTruthy();
    const table = await screen.findByRole('table', { name: word('ebs.differences.section.title') });
    expect(within(table).getAllByText('EBS-P001').length).toBeGreaterThan(0);
    expect(screen.getByTestId(`delta-${uuid(401)}`).getAttribute('data-sign')).toBe('PLUS');
    expect(within(table).getAllByText('Pham Van Cuong').length).toBe(2);
    expect(within(table).getByText(word('ebs.differences.overdue.badge'))).toBeTruthy();
    expect(screen.getAllByText(word('ent.acceptance.pending.badge')).length).toBeGreaterThan(0);
    expect(screen.getByTestId('difference-counts').textContent).toContain('2');
  });

  it('offers to resolve and reassign only where the server says the caller may, and never on a settled difference', async () => {
    mountWith();
    await screen.findByTestId(`resolve-${uuid(401)}`);
    expect(screen.getByTestId(`reassign-${uuid(401)}`)).toBeTruthy();
    fireEvent.change(screen.getByTestId('filter-state'), { target: { value: 'RESOLVED' } });
    await screen.findByTestId(`delta-${uuid(403)}`);
    expect(screen.getByTestId(`delta-${uuid(403)}`).getAttribute('data-sign')).toBe('MINUS');
    expect(screen.queryByTestId(`resolve-${uuid(403)}`)).toBeNull();
    expect(screen.queryByTestId(`reassign-${uuid(403)}`)).toBeNull();
    cleanup();
    mountWith({ world: { differences: [difference(1, {}, { may_resolve: false, may_reassign: false })] } });
    await screen.findByRole('table');
    expect(screen.queryByTestId(`resolve-${uuid(401)}`)).toBeNull();
  });

  it('explains a difference: a correction needs its evidence, a timing difference needs the day it is looked at again, and the body carries what the kind needs', async () => {
    const { h } = mountWith();
    fireEvent.click(await screen.findByTestId(`resolve-${uuid(401)}`));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: word('ebs.resolve.dialog.confirm') }));
    expect(h.command).not.toHaveBeenCalled();
    expect(dialog.querySelector('.ui-dialog__error')?.textContent).toBe(word('ent.error.validation.text'));
    fireEvent.change(within(dialog).getByTestId('resolve-reason'), { target: { value: 'The payment was booked in the wrong month' } });
    fireEvent.change(within(dialog).getByTestId('resolve-evidence'), { target: { value: 'TICKET-77' } });
    expect(within(dialog).queryByTestId('resolve-review')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: word('ebs.resolve.dialog.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect(h.command.mock.calls[0]?.[0]).toBe('resolveEbsDifference');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: uuid(401) }, ifMatchVersion: 1, body: { kind: 'OURS_WRONG', reason: 'The payment was booked in the wrong month', evidence_ref: 'TICKET-77' } });
    expect((await screen.findByTestId('action-receipt')).textContent).toBe(word('ebs.differences.resolve.done'));
  });

  it('asks for the review day for a timing difference and sends it, without an evidence it does not need', async () => {
    const { h } = mountWith();
    fireEvent.click(await screen.findByTestId(`resolve-${uuid(401)}`));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByTestId('kind-TIMING'));
    expect(within(dialog).queryByTestId('resolve-evidence')).toBeNull();
    fireEvent.change(within(dialog).getByTestId('resolve-reason'), { target: { value: 'The payment will be booked next month' } });
    fireEvent.click(within(dialog).getByRole('button', { name: word('ebs.resolve.dialog.confirm') }));
    expect(h.command).not.toHaveBeenCalled();
    const day = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    fireEvent.change(within(dialog).getByTestId('resolve-review'), { target: { value: day } });
    fireEvent.click(within(dialog).getByRole('button', { name: word('ebs.resolve.dialog.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect((h.command.mock.calls[0]?.[1] as { body: Record<string, unknown> }).body).toEqual({ kind: 'TIMING', reason: 'The payment will be booked next month', review_on: day });
  });

  it('says why the server refused (a maker cannot settle) and reads again after a conflict of version', async () => {
    const command = vi.fn((): unknown => problem('VERSION_CONFLICT', 409));
    const { h } = mountWith({ command });
    fireEvent.click(await screen.findByTestId(`resolve-${uuid(401)}`));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByTestId('resolve-reason'), { target: { value: 'The payment was booked in the wrong month' } });
    fireEvent.change(within(dialog).getByTestId('resolve-evidence'), { target: { value: 'TICKET-77' } });
    fireEvent.click(within(dialog).getByRole('button', { name: word('ebs.resolve.dialog.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    await waitFor(() => expect(h.read.mock.calls.filter((call) => call[0] === 'listEbsDifferences').length).toBeGreaterThanOrEqual(2));
    expect(dialog.querySelector('.ui-dialog__error')?.textContent).not.toBe('');
  });

  it('hands a difference to another person: the owner must be an id, and the command carries the version it saw', async () => {
    const { h } = mountWith();
    fireEvent.click(await screen.findByTestId(`reassign-${uuid(401)}`));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: word('ebs.reassign.dialog.confirm') }));
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByTestId('reassign-owner'), { target: { value: uuid(8).toUpperCase() } });
    fireEvent.click(within(dialog).getByRole('button', { name: word('ebs.reassign.dialog.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect(h.command.mock.calls[0]?.[0]).toBe('reassignEbsDifference');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: uuid(401) }, ifMatchVersion: 1, body: { owner_id: uuid(8) } });
    expect((await screen.findByTestId('action-receipt')).textContent).toBe(word('ebs.differences.reassign.done'));
  });

  it('runs the comparison for a period and says what it found; a period that is not YYYY-MM is refused before sending', async () => {
    const { h } = mountWith();
    fireEvent.click(await screen.findByTestId('reconcile-button'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByTestId('reconcile-period'), { target: { value: '2026-M10' } });
    fireEvent.click(within(dialog).getByRole('button', { name: word('ebs.reconcile.dialog.confirm') }));
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByTestId('reconcile-period'), { target: { value: '2026-10' } });
    fireEvent.click(within(dialog).getByRole('button', { name: word('ebs.reconcile.dialog.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect(h.command.mock.calls[0]?.[0]).toBe('reconcileEbs');
    expect((h.command.mock.calls[0]?.[1] as { body: Record<string, unknown> }).body).toEqual({ period: '2026-10' });
    expect((await screen.findByTestId('reconcile-result')).textContent).toContain('5');
  });

  it('filters by state, project, period and overdue, and says why the list is empty', async () => {
    const { h } = mountWith();
    await screen.findByRole('table');
    fireEvent.change(screen.getByTestId('filter-state'), { target: { value: 'RESOLVED' } });
    await waitFor(() => expect(h.read.mock.calls.some((call) => call[0] === 'listEbsDifferences' && (call[1] as { query?: { state?: string } }).query?.state === 'RESOLVED')).toBe(true));
    fireEvent.change(screen.getByTestId('filter-project'), { target: { value: 'EBS-P009' } });
    fireEvent.change(screen.getByTestId('filter-period'), { target: { value: '2026-10' } });
    fireEvent.click(screen.getByTestId('filter-overdue'));
    await waitFor(() => expect(h.read.mock.calls.some((call) => call[0] === 'listEbsDifferences' && (call[1] as { query?: Record<string, unknown> }).query?.project_code === 'EBS-P009')).toBe(true));
    cleanup();
    mountWith({ world: { differences: [] } });
    await waitFor(() => expect(screen.queryByRole('table')).toBeNull());
    expect(await screen.findByRole('status')).toBeTruthy();
  });

  it('hides the actions from a reader and in a read-only workspace; the service error has a retry', async () => {
    mountWith({ permissions: EBS_READER, world: { connection: ebsConnection({}, { may_reconcile: false, may_import: false, may_switch: false, may_preview: false }), differences: [difference(1, {}, { may_resolve: false, may_reassign: false })] } });
    await screen.findByRole('table');
    expect(screen.queryByTestId('reconcile-button')).toBeNull();
    expect(screen.queryByTestId(`resolve-${uuid(401)}`)).toBeNull();
    expect(screen.getByTestId('readonly-note')).toBeTruthy();
    cleanup();
    mountWith({ mode: 'READ_ONLY' });
    await screen.findByRole('table');
    expect(screen.queryByTestId('reconcile-button')).toBeNull();
    expect(screen.queryByTestId(`resolve-${uuid(401)}`)).toBeNull();
    cleanup();
    const { h } = mountWith({ world: { failing: { listEbsDifferences: { error: problem('SERVICE_UNAVAILABLE', 503), times: 1 } } } });
    fireEvent.click(await screen.findByRole('button', { name: word('states.retry.action') }));
    await screen.findByRole('table');
    expect(h.read.mock.calls.filter((call) => call[0] === 'listEbsDifferences').length).toBeGreaterThanOrEqual(2);
  });
});
