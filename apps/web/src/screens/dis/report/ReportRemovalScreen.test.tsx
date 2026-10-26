import { ApiError } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import ReportRemovalScreen from './ReportRemovalScreen';
import { MAKER, READER, REPORT, WITHDRAWER, client, mount, reportRecord, routeOf, world } from './test-support';

const ROUTE = routeOf('DIS-09', 'FR-DIS-09');
const PATH = `/dis/dis-09?report=${REPORT}`;
const REASON = 'The wrong period was reported by mistake.';

afterEach(cleanup);

const open = (record: Record<string, unknown>, options: { permissions?: readonly string[] | undefined; command?: (operation: string, input: unknown) => unknown; mode?: 'FULL' | 'READ_ONLY' } = {}) => {
  const h = client(world({ details: { [REPORT]: record } }), options.command ?? (() => ({ status: 'DRAFT', resource_version: 4 })));
  mount(<ReportRemovalScreen route={ROUTE} />, h, { permissions: 'permissions' in options ? options.permissions : WITHDRAWER, path: PATH, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
};
const draft = (extra: Record<string, unknown> = {}) => reportRecord({ status: 'DRAFT', version: 3, ...extra });
const submitted = (extra: Record<string, unknown> = {}) => reportRecord({ status: 'SUBMITTED', version: 2, review: null, submitted_by: '00000000-0000-4000-8000-0000000000aa', ...extra });
const sent = (h: { command: { mock: { calls: unknown[][] } } }) => h.command.mock.calls[0] as [string, { path: { id: string }; body?: Record<string, unknown>; ifMatchVersion: number }];

describe('DIS-09 confirm the deletion of a draft, the withdrawal of a report and the restore of a draft', () => {
  it('AC-ST-DIS-007-1 / UI-DIS-09: names the code, the period and the project of the draft before it is deleted (SRC-06), and asks the reason', async () => {
    open(draft());
    const facts = await screen.findByTestId('removal-facts');
    expect(within(facts).getByTestId('removal-code').textContent).toBe('DA-2027-001 / 2027-W01 / lần 1');
    expect(within(facts).getByTestId('removal-period').textContent).toContain('2027-W01');
    expect(within(facts).getByTestId('removal-project').textContent).toBe('DA-2027-001 · Cầu qua sông');
    expect(screen.getByRole('heading', { name: vi_['dis.reportRemoval.delete.title'] })).toBeTruthy();
    expect(screen.getByLabelText(vi_['dis.reportRemoval.reason.label'])).toBeTruthy();
  });

  it('AC-ST-DIS-007-1: deletes with a reason of at least 5 characters, under the version the screen showed, and leads back to the list', async () => {
    const user = userEvent.setup();
    const h = open(draft());
    const form = await screen.findByTestId('removal-form');
    await user.click(within(form).getByRole('button', { name: vi_['dis.reportRemoval.delete.action'] }));
    expect(h.command).not.toHaveBeenCalled();
    expect(within(form).getByText(vi_['dis.reportRemoval.reason.required.error'])).toBeTruthy();
    await user.type(within(form).getByLabelText(vi_['dis.reportRemoval.reason.label']), 'no');
    await user.click(within(form).getByRole('button', { name: vi_['dis.reportRemoval.delete.action'] }));
    expect(within(form).getByText(vi_['dis.reportRemoval.reason.tooShort.error'].replace('{min}', '5'))).toBeTruthy();
    await user.clear(within(form).getByLabelText(vi_['dis.reportRemoval.reason.label']));
    await user.type(within(form).getByLabelText(vi_['dis.reportRemoval.reason.label']), 'Started in the wrong week.');
    await user.click(within(form).getByRole('button', { name: vi_['dis.reportRemoval.delete.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(sent(h)).toEqual(['deleteDraftReport', expect.objectContaining({ path: { id: REPORT }, body: { reason: 'Started in the wrong week.' }, ifMatchVersion: 3 })]);
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/dis/dis-01'));
  });

  it('AC-ST-DIS-007-3: withdraws a report that was handed in with a reason of at least 20 characters, and leads to its detail', async () => {
    const user = userEvent.setup();
    const h = open(submitted());
    const form = await screen.findByTestId('removal-form');
    expect(screen.getByRole('heading', { name: vi_['dis.reportRemoval.withdraw.title'] })).toBeTruthy();
    await user.type(within(form).getByLabelText(vi_['dis.reportRemoval.reason.label']), 'too short a reason');
    await user.click(within(form).getByRole('button', { name: vi_['dis.reportRemoval.withdraw.action'] }));
    expect(h.command).not.toHaveBeenCalled();
    expect(within(form).getByText(vi_['dis.reportRemoval.reason.tooShort.error'].replace('{min}', '20'))).toBeTruthy();
    await user.clear(within(form).getByLabelText(vi_['dis.reportRemoval.reason.label']));
    await user.type(within(form).getByLabelText(vi_['dis.reportRemoval.reason.label']), REASON);
    await user.click(within(form).getByRole('button', { name: vi_['dis.reportRemoval.withdraw.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(sent(h)).toEqual(['withdrawReport', expect.objectContaining({ path: { id: REPORT }, body: { reason: REASON }, ifMatchVersion: 2 })]);
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(`/dis/dis-07?report=${REPORT}`));
  });

  it('tells in words that a report under review or in a locked period is not withdrawn, that it changed state, or that the version moved, and keeps what was typed', async () => {
    const user = userEvent.setup();
    let failure = new ApiError({ status: 409, code: 'PERIOD_LOCKED', correlationId: 'c' });
    open(submitted(), { command: () => failure });
    const form = await screen.findByTestId('removal-form');
    await user.type(within(form).getByLabelText(vi_['dis.reportRemoval.reason.label']), REASON);
    await user.click(within(form).getByRole('button', { name: vi_['dis.reportRemoval.withdraw.action'] }));
    expect((await screen.findByTestId('removal-refusal')).textContent).toBe(vi_['dis.reportRemoval.problem.periodLocked']);
    failure = new ApiError({ status: 409, code: 'REPORT_STATE_INVALID', correlationId: 'c' });
    await user.click(within(form).getByRole('button', { name: vi_['dis.reportRemoval.withdraw.action'] }));
    await waitFor(() => expect(screen.getByTestId('removal-refusal').textContent).toBe(vi_['dis.reportRemoval.problem.stateChanged']));
    failure = new ApiError({ status: 409, code: 'VERSION_CONFLICT', correlationId: 'c' });
    await user.click(within(form).getByRole('button', { name: vi_['dis.reportRemoval.withdraw.action'] }));
    await waitFor(() => expect(screen.getByTestId('removal-refusal').textContent).toBe(vi_['dis.reportRemoval.problem.versionConflict']));
    expect((within(form).getByLabelText(vi_['dis.reportRemoval.reason.label']) as HTMLTextAreaElement).value).toBe(REASON);
  });

  it('AC-ST-DIS-007-2: shows a draft that was deleted with its reason and the last day to restore it, and restores it on one click to its edit page', async () => {
    const user = userEvent.setup();
    const deletedAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const h = open(draft({ deleted: true, deleted_at: deletedAt, deleted_reason: 'Started in the wrong week.' }), { permissions: MAKER, command: () => ({ status: 'DRAFT', resource_version: 4 }) });
    const panel = await screen.findByTestId('restore-panel');
    expect(within(panel).getByTestId('restore-reason').textContent).toBe('Lý do đã xóa: Started in the wrong week.');
    expect(within(panel).getByTestId('restore-window').textContent).toMatch(/^Khôi phục được đến \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}\.$/);
    await user.click(within(panel).getByRole('button', { name: vi_['dis.reportRemoval.restore.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(sent(h)).toEqual(['restoreDraftReport', expect.objectContaining({ path: { id: REPORT }, ifMatchVersion: 3 })]);
    expect(sent(h)[1]).not.toHaveProperty('body');
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(`/dis/dis-04?report=${REPORT}`));
  });

  it('AC-ST-DIS-007-2: offers no restore after 30 days, and says in words when the server refuses it for the window or for the right of the person now', async () => {
    const user = userEvent.setup();
    open(draft({ deleted: true, deleted_at: new Date(Date.now() - 31 * 86_400_000).toISOString(), deleted_reason: 'Started in the wrong week.' }), { permissions: MAKER });
    expect((await screen.findByTestId('restore-window')).textContent).toBe(vi_['dis.reportRemoval.restore.expired.text']);
    expect(screen.queryByRole('button', { name: vi_['dis.reportRemoval.restore.action'] })).toBeNull();
    cleanup();
    let failure = new ApiError({ status: 422, code: 'RESTORE_WINDOW_EXPIRED', correlationId: 'c' });
    open(draft({ deleted: true, deleted_at: new Date(Date.now() - 2 * 86_400_000).toISOString(), deleted_reason: 'Started in the wrong week.' }), { permissions: MAKER, command: () => failure });
    await user.click(await screen.findByRole('button', { name: vi_['dis.reportRemoval.restore.action'] }));
    expect((await screen.findByTestId('removal-refusal')).textContent).toBe(vi_['dis.reportRemoval.problem.windowExpired']);
    failure = new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' });
    await user.click(screen.getByRole('button', { name: vi_['dis.reportRemoval.restore.action'] }));
    await waitFor(() => expect(screen.getByTestId('removal-refusal').textContent).toBe(vi_['dis.reportRemoval.problem.scopeDenied']));
  });

  it('shows no button to a reader, in a read-only tenant, for a report that was reviewed, or for a maker who may not withdraw', async () => {
    for (const [record, options] of [
      [draft(), { permissions: READER }],
      [draft(), { permissions: MAKER, mode: 'READ_ONLY' as const }],
      [reportRecord({ status: 'ACCEPTED', is_current: true, review: null }), { permissions: WITHDRAWER }],
      [submitted(), { permissions: MAKER }],
      [reportRecord({ status: 'UNDER_REVIEW', review: null }), { permissions: WITHDRAWER }],
    ] as const) {
      open(record, options);
      expect((await screen.findByTestId('removal-not-allowed')).textContent).toBe(vi_['dis.reportRemoval.notAllowed.text']);
      expect(screen.queryByTestId('removal-form')).toBeNull();
      expect(within(screen.getByTestId('removal-facts')).getByTestId('removal-project').textContent).toBe('DA-2027-001 · Cầu qua sông');
      cleanup();
    }
  });

  it('chooses a report first when none is named', async () => {
    const h = client(world());
    mount(<ReportRemovalScreen route={ROUTE} />, h, { permissions: MAKER, path: '/dis/dis-09' });
    expect((await screen.findByTestId('report-choose')).textContent).toBe(vi_['dis.reportRemoval.choose.text']);
  });
});
