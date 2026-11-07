import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { t } from '../../../i18n';
import vi_ from '../../../i18n/vi.json';
import { MAKER, PLAN_VERSION, READER, REPORT, client, fxCells, mount, reportRecord, routeOf, world } from './test-support';
import ReportEditScreen from './ReportEditScreen';

const ROUTE = routeOf('DIS-04', 'FR-DIS-04');
const PATH = `/dis/dis-04?report=${REPORT}`;

afterEach(cleanup);

const open = (record: Record<string, unknown> = reportRecord(), command: (operation: string, input: unknown) => unknown = () => ({ status: 'DRAFT', resource_version: 4 }), permissions: readonly string[] | undefined = MAKER, mode?: 'FULL' | 'READ_ONLY') => {
  const h = client(world({ details: { [REPORT]: record } }), command);
  mount(<ReportEditScreen route={ROUTE} />, h, { permissions, path: PATH, ...(mode === undefined ? {} : { mode }) });
  return h;
};

const text = (id: string): string => screen.getByTestId(id).textContent ?? '';
const cellInput = (cell: string): HTMLInputElement => document.getElementById(`cell-${cell}`) as HTMLInputElement;
const ctmtqgInput = (cell: string): HTMLInputElement => document.getElementById(`ctmtqg-${cell}`) as HTMLInputElement;
const typeInto = async (user: ReturnType<typeof userEvent.setup>, input: HTMLInputElement, value: string) => {
  await user.clear(input);
  await user.type(input, value);
};

describe('DIS-04 enter disbursement by source', () => {
  it('AC-ST-DIS-003-1 / UAT-AC240 / FX-DIS-001: shows the six cells, what the plan allocated to each, and the total of 420 million with the CTMTQG of 40 million apart and not added', async () => {
    open();
    expect(await screen.findByRole('heading', { level: 1, name: vi_['dis.reportEdit.page.title'] })).toBeTruthy();
    await screen.findByTestId('report-facts');
    expect(text('fact-project')).toBe('DA-2027-001 · Cầu qua sông');
    expect(text('fact-period')).toBe(vi_['dis.reportEdit.period.value'].replace('{code}', '2027-W01').replace('{start}', '2027-01-04').replace('{end}', '2027-01-10'));
    expect(text('fact-plan')).toBe(vi_['dis.reportEdit.plan.value'].replace('{year}', '2027').replace('{revision}', '2'));
    expect(text('fact-status')).toBe(vi_['dis.reportStatus.draft']);
    expect(cellInput('CURRENT_YEAR:CENTRAL').value).toBe('100.000.000');
    expect(cellInput('CURRENT_YEAR:LOCAL').value).toBe('200.000.000');
    expect(cellInput('OTHER:CENTRAL').value).toBe('0');
    expect(ctmtqgInput('CURRENT_YEAR:CENTRAL').value).toBe('40.000.000');
    expect(ctmtqgInput('CURRENT_YEAR:LOCAL').value).toBe('');
    expect(text('allocated-CURRENT_YEAR:CENTRAL')).toBe('500.000.000');
    expect(text('allocated-OTHER:LOCAL')).toBe('0');
    expect(text('total-cumulative')).toBe('420.000.000');
    expect(text('total-ctmtqg')).toBe('40.000.000');
    expect(text('total-allocated')).toBe('850.000.000');
    // The source that has no CTMTQG has no row for it.
    expect(document.getElementById('ctmtqg-OTHER:CENTRAL')).toBeNull();
    expect(document.getElementById('ctmtqg-OTHER:LOCAL')).toBeNull();
    // The CTMTQG has a block of its own in each of the two sources that take it, and the third source says it does not apply.
    expect(screen.getAllByRole('heading', { name: vi_['dis.reportEdit.ctmtqg.label'] })).toHaveLength(2);
    expect(screen.getAllByText(t('ui.fundMatrix.na'))).toHaveLength(1);
    expect(screen.getByText(vi_['dis.reportEdit.ctmtqg.note'])).toBeTruthy();
  });

  it('adds up as it is typed: the total moves with the cells and never with the CTMTQG', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByTestId('report-facts');
    await typeInto(user, cellInput('OTHER:CENTRAL'), '10.000.000');
    expect(text('total-cumulative')).toBe('430.000.000');
    await typeInto(user, ctmtqgInput('CURRENT_YEAR:CENTRAL'), '60.000.000');
    expect(text('total-ctmtqg')).toBe('60.000.000');
    expect(text('total-cumulative')).toBe('430.000.000');
    // A cell that is left is written with its dots.
    await user.clear(cellInput('CARRYOVER:LOCAL'));
    await user.type(cellInput('CARRYOVER:LOCAL'), '1250000');
    expect(cellInput('CARRYOVER:LOCAL').value).toBe('1250000');
    await user.tab();
    expect(cellInput('CARRYOVER:LOCAL').value).toBe('1.250.000');
  });

  it('shows what the period before had reached and the change, a fall in a warning tone with the note and the box for the explanation', async () => {
    const user = userEvent.setup();
    const cells = fxCells();
    cells[0] = { ...(cells[0] as Record<string, unknown>), previous_cumulative_vnd: '150000000', delta_vnd: '-50000000' };
    cells[1] = { ...(cells[1] as Record<string, unknown>), previous_cumulative_vnd: '100000000', delta_vnd: '100000000' };
    open(reportRecord({ funding_lines: cells }));
    await screen.findByTestId('report-facts');
    expect(text('previous-CURRENT_YEAR:CENTRAL')).toBe('150.000.000');
    expect(text('previous-CARRYOVER:LOCAL')).toBe(vi_['dis.reportEdit.none.text']);
    expect(text('delta-CURRENT_YEAR:CENTRAL')).toBe('-50.000.000');
    expect(screen.getByTestId('delta-CURRENT_YEAR:CENTRAL').className).toContain('dis-fall');
    expect(text('delta-CURRENT_YEAR:LOCAL')).toBe('100.000.000');
    expect(text('fall-note')).toBe(vi_['dis.reportEdit.fall.note']);
    expect(screen.getByLabelText(vi_['dis.reportEdit.explanation.label'])).toBeTruthy();
    // Raising the cell to the level of the period before takes the note away.
    await typeInto(user, cellInput('CURRENT_YEAR:CENTRAL'), '150.000.000');
    expect(screen.queryByTestId('fall-note')).toBeNull();
    expect(screen.queryByLabelText(vi_['dis.reportEdit.explanation.label'])).toBeNull();
  });

  it('saves all six cells under the version of the report and takes the person to the draft that was saved (DIS-18)', async () => {
    const user = userEvent.setup();
    const h = open();
    await screen.findByTestId('report-facts');
    await typeInto(user, cellInput('OTHER:LOCAL'), '25.000.000');
    await user.selectOptions(screen.getByLabelText(vi_['dis.reportEdit.basis.label']), 'PERIOD');
    await user.click(screen.getByRole('button', { name: vi_['dis.reportEdit.save.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('post_reports_id_revisions');
    const sent = h.command.mock.calls[0]?.[1] as { path: { id: string }; ifMatchVersion: number; body: { measurement_basis: string; plan_version_id: string; funding_lines: Array<Record<string, unknown>> } };
    expect(sent).toMatchObject({ path: { id: REPORT }, ifMatchVersion: 3, body: { measurement_basis: 'PERIOD', plan_version_id: PLAN_VERSION } });
    expect(sent.body.funding_lines).toHaveLength(6);
    expect(sent.body.funding_lines[5]).toMatchObject({ bucket: 'OTHER', budget_level: 'LOCAL', cumulative_vnd: '25000000' });
    expect(sent.body.funding_lines[0]).toMatchObject({ cumulative_vnd: '100000000', ctmtqg_subset_vnd: '40000000', next_month_vnd: '0' });
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(`/dis/dis-18?report=${REPORT}`));
  });

  it('AC-ST-DIS-003-2 / UAT-AC02 / FX-DIS-006: a CTMTQG of 120 million against a cell of 100 million is told on the CTMTQG field before anything is sent, and the draft stays', async () => {
    const user = userEvent.setup();
    const h = open();
    await screen.findByTestId('report-facts');
    await typeInto(user, ctmtqgInput('CURRENT_YEAR:CENTRAL'), '120.000.000');
    await user.click(screen.getByRole('button', { name: vi_['dis.reportEdit.save.action'] }));
    expect(await screen.findByText(vi_['dis.reportProblem.cell.exceeds'])).toBeTruthy();
    expect(ctmtqgInput('CURRENT_YEAR:CENTRAL').getAttribute('aria-invalid')).toBe('true');
    expect(ctmtqgInput('CURRENT_YEAR:CENTRAL').getAttribute('aria-describedby')).toBe('ctmtqg-CURRENT_YEAR:CENTRAL-error');
    expect(h.command).not.toHaveBeenCalled();
    expect(screen.getByTestId('location').textContent).toBe(`/dis/dis-04?report=${REPORT}`);
  });

  it('tells a cell with nothing in it, one that is not an amount, and an explanation that is too short, and sends nothing', async () => {
    const user = userEvent.setup();
    const cells = fxCells();
    cells[3] = { ...(cells[3] as Record<string, unknown>), previous_cumulative_vnd: '150000000', delta_vnd: '-150000000' };
    const h = open(reportRecord({ funding_lines: cells, negative_delta_explanation: 'The Treasury returned a payment.' }));
    await screen.findByTestId('report-facts');
    await user.clear(cellInput('CURRENT_YEAR:CENTRAL'));
    await typeInto(user, cellInput('CURRENT_YEAR:LOCAL'), '12abc');
    await typeInto(user, ctmtqgInput('CARRYOVER:CENTRAL'), '5');
    await typeInto(user, cellInput('CARRYOVER:CENTRAL'), '1');
    await typeInto(user, ctmtqgInput('CARRYOVER:CENTRAL'), '5');
    await user.clear(screen.getByLabelText(vi_['dis.reportEdit.explanation.label']));
    await user.type(screen.getByLabelText(vi_['dis.reportEdit.explanation.label']), 'short');
    await user.click(screen.getByRole('button', { name: vi_['dis.reportEdit.save.action'] }));
    expect(await screen.findByText(vi_['dis.reportProblem.cell.required'])).toBeTruthy();
    expect(screen.getByText(vi_['dis.reportProblem.cell.invalid'])).toBeTruthy();
    expect(screen.getByText(vi_['dis.reportProblem.cell.exceeds'])).toBeTruthy();
    expect(screen.getByText(vi_['dis.reportProblem.explanation.tooShort'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  const REFUSALS: Array<[string, string]> = [
    ['VERSION_CONFLICT', vi_['dis.reportProblem.versionConflict']],
    ['REVISION_IMMUTABLE', vi_['dis.reportProblem.immutable']],
    ['PERIOD_LOCKED', vi_['dis.reportProblem.periodLocked']],
    ['SCOPE_DENIED', vi_['dis.reportProblem.scopeDenied']],
    ['VALIDATION_FAILED', vi_['dis.reportProblem.validation']],
    ['RESOURCE_NOT_FOUND', vi_['dis.reportProblem.notFound']],
    ['SOMETHING_ELSE', vi_['dis.reportProblem.general']],
  ];

  it.each(REFUSALS)('tells the refusal %s in words and keeps what was typed', async (code, message) => {
    const user = userEvent.setup();
    open(reportRecord(), () => new ApiError({ status: 409, code, correlationId: 'c' }));
    await screen.findByTestId('report-facts');
    await typeInto(user, cellInput('OTHER:LOCAL'), '7');
    await user.click(screen.getByRole('button', { name: vi_['dis.reportEdit.save.action'] }));
    expect((await screen.findByTestId('refusal')).textContent).toBe(message);
    expect(cellInput('OTHER:LOCAL').value).toBe('7');
    expect(screen.getByTestId('location').textContent).toBe(`/dis/dis-04?report=${REPORT}`);
  });

  it('marks the cell the server named when it refuses the CTMTQG of a cell', async () => {
    const user = userEvent.setup();
    open(reportRecord(), () => new ApiError({ status: 422, code: 'SUBSET_EXCEEDS_PARENT', correlationId: 'c', detail: 'funding_lines[0].ctmtqg_subset_vnd' }));
    await screen.findByTestId('report-facts');
    await typeInto(user, cellInput('OTHER:LOCAL'), '7');
    await user.click(screen.getByRole('button', { name: vi_['dis.reportEdit.save.action'] }));
    expect(await screen.findByText(vi_['dis.reportProblem.subsetExceeds'])).toBeTruthy();
    expect(ctmtqgInput('CURRENT_YEAR:CENTRAL').getAttribute('aria-invalid')).toBe('true');
    expect(screen.queryByTestId('refusal')).toBeNull();
  });

  it('shows a report that was handed in as read only: no button, no field to type in, and the words that say why', async () => {
    open(reportRecord({ status: 'SUBMITTED' }));
    await screen.findByTestId('report-facts');
    expect(text('readonly-note')).toBe(vi_['dis.reportEdit.readonly.note']);
    expect(text('fact-status')).toBe(vi_['dis.reportStatus.submitted']);
    expect(cellInput('CURRENT_YEAR:CENTRAL').disabled).toBe(true);
    expect(ctmtqgInput('CURRENT_YEAR:CENTRAL').disabled).toBe(true);
    expect((screen.getByLabelText(vi_['dis.reportEdit.basis.label']) as HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: vi_['dis.reportEdit.save.action'] })).toBeNull();
  });

  it('shows a draft to a person who may not edit it, and in a tenant that is read only, as read only', async () => {
    open(reportRecord(), undefined, READER);
    await screen.findByTestId('report-facts');
    expect(text('readonly-note')).toBe(vi_['dis.reportEdit.denied.note']);
    expect(cellInput('CURRENT_YEAR:CENTRAL').disabled).toBe(true);
    expect(screen.queryByRole('button', { name: vi_['dis.reportEdit.save.action'] })).toBeNull();
    cleanup();
    open(reportRecord(), undefined, MAKER, 'READ_ONLY');
    await screen.findByTestId('report-facts');
    expect(screen.queryByRole('button', { name: vi_['dis.reportEdit.save.action'] })).toBeNull();
  });

  it('with none chosen asks for one, and says the report is not there for one that is not found (the same words as a report of another scope)', async () => {
    mount(<ReportEditScreen route={ROUTE} />, client(world()), { permissions: MAKER, path: '/dis/dis-04' });
    expect((await screen.findByTestId('report-choose')).textContent).toBe(vi_['dis.reportEdit.choose.text']);
    cleanup();
    mount(<ReportEditScreen route={ROUTE} />, client(world()), { permissions: MAKER, path: PATH });
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
  });

  it('shows a loading state first, then the denied, signed-out, offline and error states', async () => {
    const failing = (error: Error) => {
      const state = world({ details: { [REPORT]: reportRecord() } });
      state.failing.set('getReportRevision', error);
      return client(state);
    };
    mount(<ReportEditScreen route={ROUTE} />, failing(new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' })), { permissions: MAKER, path: PATH });
    expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    cleanup();
    mount(<ReportEditScreen route={ROUTE} />, failing(new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' })), { permissions: MAKER, path: PATH });
    expect(await screen.findByText(vi_['states.signedOut.title'])).toBeTruthy();
    cleanup();
    mount(<ReportEditScreen route={ROUTE} />, failing(new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' })), { permissions: MAKER, path: PATH });
    expect(await screen.findByText(vi_['states.offline.title'])).toBeTruthy();
    cleanup();
    mount(<ReportEditScreen route={ROUTE} />, failing(new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' })), { permissions: MAKER, path: PATH });
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
  });
});
