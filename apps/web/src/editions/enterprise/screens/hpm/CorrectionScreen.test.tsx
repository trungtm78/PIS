import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../../../i18n';
import { HPM_ADMIN, HPM_READER, hpmClient, hpmConnection, hpmCorrection, hpmRoute, mount, uuid } from '../shared/test-support';
import type { HpmWorld } from '../shared/test-support';
import CorrectionScreen from './CorrectionScreen';

const word = (key: string, params: Record<string, string | number> = {}): string => translator.t(key, params);
const route = hpmRoute('HPM-02');
const problem = (code: string, status: number) => new ApiError({ status, code, correlationId: 'c' });

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
  vi.restoreAllMocks();
});

function mountWith(options: { world?: Partial<HpmWorld>; permissions?: string[]; mode?: 'FULL' | 'READ_ONLY'; command?: (operation: string, input: unknown) => unknown } = {}) {
  const world: HpmWorld = { connection: hpmConnection(), pushes: [], corrections: [hpmCorrection(1), hpmCorrection(2, { state: 'APPROVED', decided_by_name: 'Pham Van Cuong', decided_at: '2026-11-07T02:00:00.000Z', version: 2 }, { may_decide: false })], ...options.world };
  const h = hpmClient(world, options.command);
  mount(<CorrectionScreen route={route} />, h, { permissions: options.permissions ?? HPM_ADMIN, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return { h, world };
}

describe('CorrectionScreen (HPM-02): the corrections that let an accepted period be replaced', () => {
  it('UI-HPM-02: lists the corrections with the period, the reopening, the reason, the state and who proposed and decided', async () => {
    mountWith();
    expect(await screen.findByRole('heading', { level: 1, name: word('hpm.correction.page.title') })).toBeTruthy();
    const table = await screen.findByRole('table', { name: word('hpm.correction.section.title') });
    expect(within(table).getAllByText(/HPM-MONTHLY · 2026-M09/).length).toBe(2);
    expect(within(table).getByText(uuid(701))).toBeTruthy();
    expect(within(table).getAllByText('Tran Van Binh').length).toBe(2);
    expect(within(table).getByText(/Pham Van Cuong/)).toBeTruthy();
  });

  it('offers the decision only where the server says the caller may (never to the proposer or on a decided correction)', async () => {
    mountWith();
    await screen.findByTestId(`decide-${uuid(301)}`);
    expect(screen.queryByTestId(`decide-${uuid(302)}`)).toBeNull();
    cleanup();
    mountWith({ world: { corrections: [hpmCorrection(1, {}, { may_decide: false })] } });
    await screen.findByRole('table');
    expect(screen.queryByTestId(`decide-${uuid(301)}`)).toBeNull();
  });

  it('decides with a reason of ten characters under the version it saw, and says what was decided', async () => {
    const { h } = mountWith();
    fireEvent.click(await screen.findByTestId(`decide-${uuid(301)}`));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Tran Van Binh');
    const confirm = within(dialog).getByRole('button', { name: word('hpm.correction.decide.confirm.approve') });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'The invoice is attached and the reopening is in force' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect(h.command.mock.calls[0]?.[0]).toBe('decideHpmCorrection');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: uuid(301) }, ifMatchVersion: 1, body: { decision: 'APPROVE', reason: 'The invoice is attached and the reopening is in force' } });
    expect((await screen.findByTestId('action-receipt')).textContent).toBe(word('hpm.correction.decide.done.approved'));
  });

  it('can reject, and a conflict of version reads the list again', async () => {
    const command = vi.fn((): unknown => problem('VERSION_CONFLICT', 409));
    const { h } = mountWith({ command });
    fireEvent.click(await screen.findByTestId(`decide-${uuid(301)}`));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByTestId('decision-reject'));
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'The period stays as it was accepted' } });
    fireEvent.click(within(dialog).getByRole('button', { name: word('hpm.correction.decide.confirm.reject') }));
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect((h.command.mock.calls[0]?.[1] as { body: { decision: string } }).body.decision).toBe('REJECT');
    await waitFor(() => expect(h.read.mock.calls.filter((call) => call[0] === 'listHpmCorrections').length).toBeGreaterThanOrEqual(2));
    expect(within(dialog).getByRole('alert')).toBeTruthy();
  });

  it('proposes a correction: refuses an invalid form first, then sends the body with the reopening and the reason', async () => {
    const { h } = mountWith();
    fireEvent.click(await screen.findByTestId('propose-button'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: word('hpm.correction.propose.confirm') }));
    expect(h.command).not.toHaveBeenCalled();
    expect(dialog.querySelector('.ui-dialog__error')?.textContent).toBe(word('ent.error.validation.text'));
    fireEvent.change(screen.getByTestId('correction-layout'), { target: { value: 'HPM-MONTHLY' } });
    fireEvent.change(screen.getByTestId('correction-period'), { target: { value: '2026-M09' } });
    fireEvent.change(screen.getByTestId('correction-reopen'), { target: { value: uuid(750).toUpperCase() } });
    fireEvent.change(screen.getByTestId('correction-reason'), { target: { value: 'A late invoice changed the executed value' } });
    fireEvent.click(within(dialog).getByRole('button', { name: word('hpm.correction.propose.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect(h.command.mock.calls[0]?.[0]).toBe('proposeHpmCorrection');
    expect((h.command.mock.calls[0]?.[1] as { body: Record<string, unknown> }).body).toEqual({ layout_code: 'HPM-MONTHLY', period: '2026-M09', from_revision: 1, period_reopen_id: uuid(750), reason: 'A late invoice changed the executed value' });
    expect((await screen.findByTestId('action-receipt')).textContent).toBe(word('hpm.correction.propose.done'));
  });

  it('filters by state and says why the list is empty when nothing is in that state', async () => {
    mountWith();
    await screen.findByRole('table');
    fireEvent.change(screen.getByTestId('correction-filter'), { target: { value: 'CONSUMED' } });
    await waitFor(() => expect(screen.getByTestId('correction-empty').textContent).toBe(word('hpm.correction.empty.filtered')));
  });

  it('does not show the table, and says so through the standard empty state, when there is no correction at all', async () => {
    mountWith({ world: { corrections: [] } });
    await waitFor(() => expect(screen.queryByRole('table')).toBeNull());
    expect(await screen.findByRole('status')).toBeTruthy();
  });

  it('hides the actions from a reader and in a read-only workspace, and offers a retry when the read fails', async () => {
    mountWith({ permissions: HPM_READER, world: { connection: hpmConnection({}, { may_propose_correction: false, may_decide_correction: false }), corrections: [hpmCorrection(1, {}, { may_decide: false })] } });
    await screen.findByRole('table');
    expect(screen.queryByTestId('propose-button')).toBeNull();
    expect(screen.getByTestId('readonly-note')).toBeTruthy();
    cleanup();
    mountWith({ mode: 'READ_ONLY' });
    await screen.findByRole('table');
    expect(screen.queryByTestId('propose-button')).toBeNull();
    expect(screen.queryByTestId(`decide-${uuid(301)}`)).toBeNull();
    cleanup();
    const failing = { listHpmCorrections: { error: problem('SERVICE_UNAVAILABLE', 503), times: 1 } };
    const { h } = mountWith({ world: { failing } });
    fireEvent.click(await screen.findByRole('button', { name: word('states.retry.action') }));
    await screen.findByRole('table');
    expect(h.read.mock.calls.filter((call) => call[0] === 'listHpmCorrections').length).toBeGreaterThanOrEqual(2);
  });
});
