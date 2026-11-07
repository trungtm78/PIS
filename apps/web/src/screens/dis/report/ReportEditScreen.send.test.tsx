import { ApiError } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { t } from '../../../i18n';
import vi_ from '../../../i18n/vi.json';
import { MAKER, REPORT, client, mount, reportRecord, routeOf, world } from './test-support';
import type { World } from './test-support';
import ReportEditScreen from './ReportEditScreen';

const ROUTE = routeOf('DIS-04', 'FR-DIS-04');
const PATH = `/dis/dis-04?report=${REPORT}`;
const SUBMITTER = [...MAKER, 'report.submit'];
const RECEIPT = {
  operation_id: '00000000-0000-4000-8000-0000000000aa',
  status: 'SUBMITTED',
  resource_version: 5,
  resource_id: REPORT,
  is_late: false,
  submitted_at: '2027-01-08T09:00:00.000Z',
  payload_hash: 'abcdef0123456789'.repeat(4),
  period_delta_vnd: null,
  warnings: [],
};
const answer = (operation: string): unknown => (operation === 'post_reports_id_submit' ? RECEIPT : { status: 'DRAFT', resource_version: 4 });

afterEach(cleanup);

const open = (record: Record<string, unknown> = reportRecord(), command: (operation: string, input: unknown) => unknown = answer, permissions: readonly string[] = SUBMITTER, details: World['details'] = {}) => {
  const h = client(world({ details: { [REPORT]: record, ...details } }), command);
  mount(<ReportEditScreen route={ROUTE} />, h, { permissions, path: PATH });
  return h;
};

const text = (id: string): string => screen.getByTestId(id).textContent ?? '';
const cellInput = (cell: string): HTMLInputElement => document.getElementById(`cell-${cell}`) as HTMLInputElement;
const typeInto = async (user: ReturnType<typeof userEvent.setup>, input: HTMLInputElement, value: string) => {
  await user.clear(input);
  await user.type(input, value);
};

describe('DIS-04 status strip and marks', () => {
  it('puts the state, the period and the deadline with its countdown on a strip above the form, and says what to do first', async () => {
    open();
    const strip = await screen.findByTestId('status-strip');
    expect(strip.textContent).toContain(vi_['dis.reportStatus.draft']);
    expect(strip.textContent).toContain('2027-W01');
    await waitFor(() => expect(text('strip-deadline')).toMatch(/^Hạn 10:00 09\/01\/2099 · còn \d+ ngày$/));
    expect(text('strip-next')).toBe(t('dis.wr.next.finishDraft'));
  });

  it('says a deadline that has passed in words, and the unit of every amount on the block of funds', async () => {
    const state = world({ details: { [REPORT]: reportRecord() } });
    state.periods = state.periods.map((period) => ({ ...period, deadline_at: '2020-01-10T10:00:00.000Z' }));
    mount(<ReportEditScreen route={ROUTE} />, client(state), { permissions: MAKER, path: PATH });
    await waitFor(() => expect(text('strip-deadline')).toMatch(/^Hạn 17:00 10\/01\/2020 · quá hạn \d+ ngày$/));
    expect(screen.getByText(t('ui.unitChip.label', { unit: t('dis.wr.unit') }))).toBeTruthy();
  });

  it('tells a person who corrects a report that was sent back the reason and what is to be fixed, taken from the report it corrects, and marks the cell the review names', async () => {
    const PARENT = '00000000-0000-4000-8000-0000000000e1';
    const parent = reportRecord({
      id: PARENT,
      status: 'RETURNED',
      returned_reason: 'Số kéo dài chưa khớp Kho bạc',
      decisions: [{ id: 'd1', decision: 'RETURNED', reason: 'Số kéo dài chưa khớp Kho bạc', evidence_ids: [], return_items: ['Đối chiếu vốn kéo dài NSTW'], due_at: '2027-01-12T10:00:00.000Z', decided_by: 'x', decided_at: '2027-01-09T03:00:00.000Z' }],
    });
    const draft = reportRecord({ revision: 2, supersedes_id: PARENT, review: { blocking: false, errors: [], warnings: [{ code: 'CELL_FELL', field: 'funding_lines[2].cumulative_vnd', values: {} }] } });
    open(draft, answer, MAKER, { [PARENT]: parent });
    const box = await screen.findByTestId('returned-box');
    expect(box.textContent).toContain('Số kéo dài chưa khớp Kho bạc');
    expect(box.textContent).toContain('Đối chiếu vốn kéo dài NSTW');
    expect(text('returned-due')).toBe(t('dis.wr.returned.due', { due: '17:00 12/01/2027' }));
    expect(text('strip-next')).toBe(t('dis.wr.next.finishDraft'));
    const marked = document.querySelector('[data-cell="CARRYOVER:CENTRAL"]');
    expect(marked?.className).toContain('dis-wr-cell--marked');
    expect(marked?.textContent).toContain(t('dis.wr.mark.text'));
    expect(document.querySelector('[data-cell="CURRENT_YEAR:CENTRAL"]')?.className).not.toContain('marked');
  });

  it('gathers the errors at the top with a link to each field, moves the focus there, and the link leads to the field', async () => {
    const user = userEvent.setup();
    const h = open(reportRecord(), answer, MAKER);
    await screen.findByTestId('report-facts');
    expect(screen.queryByTestId('error-summary')).toBeNull();
    await user.clear(cellInput('CURRENT_YEAR:CENTRAL'));
    await typeInto(user, cellInput('CURRENT_YEAR:LOCAL'), '12abc');
    await user.click(screen.getByRole('button', { name: vi_['dis.reportEdit.save.action'] }));
    const summary = await screen.findByTestId('error-summary');
    expect(document.activeElement).toBe(summary);
    expect(summary.textContent).toContain(t('dis.wr.summary.title', { count: 2 }));
    await user.click(within(summary).getByRole('link', { name: new RegExp(vi_['dis.reportProblem.cell.required']) }));
    expect(document.activeElement).toBe(cellInput('CURRENT_YEAR:CENTRAL'));
    expect(h.command).not.toHaveBeenCalled();
  });
});

describe('DIS-04 sending', () => {
  it('keeps the button away from a person who may not submit, and from a report that was handed in', async () => {
    open(reportRecord(), answer, MAKER);
    await screen.findByTestId('report-facts');
    expect(screen.queryByRole('button', { name: t('dis.wr.send.action') })).toBeNull();
    cleanup();
    open(reportRecord({ status: 'SUBMITTED' }));
    await screen.findByTestId('report-facts');
    expect(screen.queryByRole('button', { name: t('dis.wr.send.action') })).toBeNull();
  });

  it('asks first, naming the period and the total, and sends nothing when the person looks again', async () => {
    const user = userEvent.setup();
    const h = open();
    await screen.findByTestId('report-facts');
    await user.click(screen.getByRole('button', { name: t('dis.wr.send.action') }));
    const dialog = await screen.findByRole('dialog', { name: t('dis.wr.send.title') });
    expect(dialog.textContent).toContain('2027-W01');
    expect(dialog.textContent).toContain(t('dis.wr.send.total.value', { amount: '420.000.000' }));
    expect(dialog.textContent).toContain('DA-2027-001');
    await user.click(within(dialog).getByRole('button', { name: t('dis.wr.send.cancel') }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('does not ask while a cell has an error: the errors are told and nothing is sent', async () => {
    const user = userEvent.setup();
    const h = open();
    await screen.findByTestId('report-facts');
    await user.clear(cellInput('OTHER:LOCAL'));
    await user.click(screen.getByRole('button', { name: t('dis.wr.send.action') }));
    expect(await screen.findByTestId('error-summary')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('saves what is typed and then hands the report in under the version of the save, and gives the receipt: code, time, who receives it, what is next', async () => {
    const user = userEvent.setup();
    const h = open();
    await screen.findByTestId('report-facts');
    await typeInto(user, cellInput('OTHER:LOCAL'), '25.000.000');
    await user.click(screen.getByRole('button', { name: t('dis.wr.send.action') }));
    const dialog = await screen.findByRole('dialog', { name: t('dis.wr.send.title') });
    expect(dialog.textContent).toContain(t('dis.wr.send.total.value', { amount: '425.000.000' }));
    await user.click(within(dialog).getByRole('button', { name: t('dis.wr.send.confirm') }));
    expect(await screen.findByTestId('receipt')).toBeTruthy();
    expect(h.command.mock.calls.map((call) => call[0])).toEqual(['post_reports_id_revisions', 'post_reports_id_submit']);
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ ifMatchVersion: 3 });
    expect(h.command.mock.calls[1]?.[1]).toMatchObject({ path: { id: REPORT }, ifMatchVersion: 4 });
    expect(text('receipt-code')).toBe('BN-ABCDEF01');
    expect(text('receipt-time')).toBe('16:00 08/01/2027');
    expect(text('receipt-recipient')).toBe('Cao Bang');
    expect(text('receipt-next')).toBe(t('dis.wr.receipt.next'));
    expect(screen.getByRole('link', { name: t('dis.wr.receipt.list') }).getAttribute('href')).toBe('/dis/dis-01');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: t('dis.wr.send.action') })).toBeNull();
  });

  it('tells the refusal of the sending in words, keeps the form and does not show a receipt', async () => {
    const user = userEvent.setup();
    const h = open(reportRecord(), (operation) => (operation === 'post_reports_id_submit' ? new ApiError({ status: 403, code: 'SELF_APPROVAL_DENIED', correlationId: 'c' }) : answer(operation)));
    await screen.findByTestId('report-facts');
    await user.click(screen.getByRole('button', { name: t('dis.wr.send.action') }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: t('dis.wr.send.confirm') }));
    expect((await screen.findByTestId('send-refusal')).textContent).toBe(vi_['dis.reportProblem.selfApproval']);
    expect(screen.queryByTestId('receipt')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(h.command.mock.calls.map((call) => call[0])).toEqual(['post_reports_id_revisions', 'post_reports_id_submit']);
    expect(cellInput('CURRENT_YEAR:CENTRAL').value).toBe('100.000.000');
  });
});
