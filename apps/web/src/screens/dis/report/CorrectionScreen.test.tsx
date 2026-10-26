import { ApiError } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import CorrectionScreen from './CorrectionScreen';
import { CORRECTOR, MAKER, REPORT, client, fxCells, mount, reportRecord, routeOf, world } from './test-support';

const ROUTE = routeOf('DIS-08', 'FR-DIS-08');
const PATH = `/dis/dis-08?report=${REPORT}`;
const MADE = '00000000-0000-4000-8000-0000000000f2';
const REASON = 'The Treasury corrected a payment of March.';

afterEach(cleanup);

const returned = (extra: Record<string, unknown> = {}) => reportRecord({ status: 'RETURNED', version: 3, review: null, ...extra });
const open = (record: Record<string, unknown>, options: { permissions?: readonly string[] | undefined; command?: (operation: string, input: unknown) => unknown } = {}) => {
  const h = client(world({ details: { [REPORT]: record } }), options.command ?? (() => ({ status: 'DRAFT', resource_version: 1, resource_id: MADE })));
  mount(<CorrectionScreen route={ROUTE} />, h, { permissions: 'permissions' in options ? options.permissions : CORRECTOR, path: PATH });
  return h;
};
const sent = (h: { command: { mock: { calls: unknown[][] } } }) => h.command.mock.calls[0]?.[1] as { path: { id: string }; body: Record<string, unknown>; ifMatchVersion: number };
const cell = (id: string) => screen.getByLabelText(vi_['dis.reportCorrection.cells.cumulative.label'].replace('{cell}', id));

describe('DIS-08 the correction of a report', () => {
  it('shows the figures of the revision that is corrected beside the new ones, the reason that is required, and the way back', async () => {
    open(returned());
    expect(await screen.findByRole('heading', { level: 1, name: vi_['dis.reportCorrection.page.title'] })).toBeTruthy();
    expect((await screen.findByTestId('previous-CURRENT_YEAR:LOCAL')).textContent).toBe('200.000.000');
    expect(screen.getByTestId('previous-total').textContent).toBe('420.000.000');
    expect(screen.getByTestId('new-total').textContent).toBe('420.000.000');
    expect(screen.getByRole('link', { name: vi_['dis.reportCorrection.cancel.action'] }).getAttribute('href')).toBe(`/dis/dis-07?report=${REPORT}`);
  });

  it('AC-ST-DIS-006-2: asks for the reason before anything is sent, then sends the reason alone when no cell changed and leads to the new draft', async () => {
    const user = userEvent.setup();
    const h = open(returned());
    const form = await screen.findByTestId('correction-form');
    await user.click(within(form).getByRole('button', { name: vi_['dis.reportCorrection.submit.action'] }));
    expect(h.command).not.toHaveBeenCalled();
    expect(within(form).getByText(vi_['dis.reportCorrection.reason.required.error'])).toBeTruthy();
    await user.type(within(form).getByLabelText(vi_['dis.reportCorrection.reason.label']), 'too short');
    await user.click(within(form).getByRole('button', { name: vi_['dis.reportCorrection.submit.action'] }));
    expect(within(form).getByText(vi_['dis.reportCorrection.reason.tooShort.error'])).toBeTruthy();
    await user.clear(within(form).getByLabelText(vi_['dis.reportCorrection.reason.label']));
    await user.type(within(form).getByLabelText(vi_['dis.reportCorrection.reason.label']), REASON);
    await user.click(within(form).getByRole('button', { name: vi_['dis.reportCorrection.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('post_reports_id_corrections');
    expect(sent(h)).toMatchObject({ path: { id: REPORT }, ifMatchVersion: 3, body: { amendment_reason: REASON } });
    expect(sent(h).body).not.toHaveProperty('funding_lines');
    expect((await screen.findByTestId('location')).textContent).toBe(`/dis/dis-04?report=${MADE}`);
  });

  it('sends only the cells that changed, shows the change against the period before in words and colour, and asks the explanation of a fall', async () => {
    const user = userEvent.setup();
    const cells = fxCells().map((entry) => (entry.bucket === 'CURRENT_YEAR' && entry.budget_level === 'LOCAL' ? { ...entry, previous_cumulative_vnd: '200000000', delta_vnd: '0' } : entry));
    const h = open(returned({ funding_lines: cells }));
    const form = await screen.findByTestId('correction-form');
    expect(screen.queryByLabelText(vi_['dis.reportCorrection.explanation.label'])).toBeNull();
    const local = cell('Vốn năm NSĐP');
    await user.clear(local);
    await user.type(local, '150000000');
    expect(screen.getByTestId('change-CURRENT_YEAR:LOCAL').textContent).toBe('-50.000.000');
    expect(screen.getByTestId('new-total').textContent).toBe('370.000.000');
    expect(screen.getByTestId('change-CURRENT_YEAR:LOCAL').className).toContain('dis-fall');
    await user.type(within(form).getByLabelText(vi_['dis.reportCorrection.reason.label']), REASON);
    await user.type(await screen.findByLabelText(vi_['dis.reportCorrection.explanation.label']), 'short');
    await user.click(within(form).getByRole('button', { name: vi_['dis.reportCorrection.submit.action'] }));
    expect(h.command).not.toHaveBeenCalled();
    expect(within(form).getByText(vi_['dis.reportProblem.explanation.tooShort'])).toBeTruthy();
    await user.clear(screen.getByLabelText(vi_['dis.reportCorrection.explanation.label']));
    await user.type(screen.getByLabelText(vi_['dis.reportCorrection.explanation.label']), 'The payment was returned by the Treasury.');
    await user.click(within(form).getByRole('button', { name: vi_['dis.reportCorrection.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(sent(h).body).toEqual({
      amendment_reason: REASON,
      funding_lines: [{ bucket: 'CURRENT_YEAR', budget_level: 'LOCAL', cumulative_vnd: '150000000', next_month_vnd: '5000000' }],
      negative_delta_explanation: 'The payment was returned by the Treasury.',
    });
  });

  it('refuses a cell that is not an amount before sending', async () => {
    const user = userEvent.setup();
    const h = open(returned());
    const form = await screen.findByTestId('correction-form');
    const local = cell('Vốn năm NSĐP');
    await user.clear(local);
    await user.type(local, '12abc');
    await user.type(within(form).getByLabelText(vi_['dis.reportCorrection.reason.label']), REASON);
    await user.click(within(form).getByRole('button', { name: vi_['dis.reportCorrection.submit.action'] }));
    expect(h.command).not.toHaveBeenCalled();
    expect(await within(form).findByText(vi_['dis.reportProblem.cell.invalid'])).toBeTruthy();
  });

  it('tells in words that a revision is waiting already, and leads to it', async () => {
    const user = userEvent.setup();
    open(returned(), { command: () => new ApiError({ status: 409, code: 'REVISION_PENDING_EXISTS', correlationId: 'c', extensions: { report_id: MADE } }) });
    const form = await screen.findByTestId('correction-form');
    await user.type(within(form).getByLabelText(vi_['dis.reportCorrection.reason.label']), REASON);
    await user.click(within(form).getByRole('button', { name: vi_['dis.reportCorrection.submit.action'] }));
    const refusal = await screen.findByTestId('correction-refusal');
    expect(refusal.textContent).toContain(vi_['dis.reportProblem.pendingExists']);
    expect(within(refusal).getByRole('link', { name: vi_['dis.reportCorrection.pending.link'] }).getAttribute('href')).toBe(`/dis/dis-04?report=${MADE}`);
    expect((within(form).getByLabelText(vi_['dis.reportCorrection.reason.label']) as HTMLTextAreaElement).value).toBe(REASON);
  });

  it('tells in words that a locked period takes no correction, and that the server wanted a reason', async () => {
    const user = userEvent.setup();
    let code = 'PERIOD_LOCKED';
    open(returned(), { command: () => new ApiError({ status: code === 'PERIOD_LOCKED' ? 409 : 422, code, correlationId: 'c' }) });
    const form = await screen.findByTestId('correction-form');
    await user.type(within(form).getByLabelText(vi_['dis.reportCorrection.reason.label']), REASON);
    await user.click(within(form).getByRole('button', { name: vi_['dis.reportCorrection.submit.action'] }));
    expect((await screen.findByTestId('correction-refusal')).textContent).toContain(vi_['dis.reportProblem.periodLocked']);
    code = 'CORRECTION_REASON_REQUIRED';
    await user.click(within(form).getByRole('button', { name: vi_['dis.reportCorrection.submit.action'] }));
    await waitFor(() => expect(screen.getByTestId('correction-refusal').textContent).toContain(vi_['dis.reportProblem.reasonRequired']));
  });

  it('is not offered for a report that cannot be corrected, nor to a person who may not correct', async () => {
    open(reportRecord({ status: 'SUBMITTED', review: null }));
    expect((await screen.findByTestId('correction-not-allowed')).textContent).toBe(vi_['dis.reportCorrection.notAllowed.text']);
    expect(screen.queryByTestId('correction-form')).toBeNull();
    cleanup();
    open(returned(), { permissions: MAKER });
    expect((await screen.findByTestId('correction-not-allowed')).textContent).toBe(vi_['dis.reportCorrection.notAllowed.text']);
    expect(screen.getByRole('link', { name: vi_['dis.reportCorrection.detail.link'] }).getAttribute('href')).toBe(`/dis/dis-07?report=${REPORT}`);
  });
});
