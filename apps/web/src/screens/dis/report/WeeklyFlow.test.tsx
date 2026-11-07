import { ApiError } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { t } from '../../../i18n';
import vi_ from '../../../i18n/vi.json';
import { MAKER, PERIOD, PROJECT, REPORT, client, mount, reportRecord, routeOf, world } from './test-support';
import ProgressScreen from './ProgressScreen';
import ReportCreateScreen from './ReportCreateScreen';
import ReviewScreen from './ReviewScreen';

const SUBMITTER = [...MAKER, 'report.submit'];
const RECEIPT = {
  operation_id: '00000000-0000-4000-8000-0000000000aa',
  status: 'SUBMITTED',
  resource_version: 4,
  resource_id: REPORT,
  is_late: true,
  submitted_at: '2027-01-11T09:30:00.000Z',
  payload_hash: '0123456789abcdef'.repeat(4),
  period_delta_vnd: '120000000',
  warnings: [],
};
const finding = (code: string, field: string) => ({ code, field, values: {} });

afterEach(cleanup);

const show = (screen_: ReactElement, path: string, record: Record<string, unknown>, command: (operation: string, input: unknown) => unknown = () => RECEIPT, permissions: readonly string[] = SUBMITTER) => {
  const h = client(world({ details: { [REPORT]: record } }), command);
  mount(screen_, h, { permissions, path });
  return h;
};
const text = (id: string): string => screen.getByTestId(id).textContent ?? '';

describe('DIS-06 sending from the review', () => {
  const path = `/dis/dis-06?report=${REPORT}`;
  const open = (record: Record<string, unknown> = reportRecord(), command?: (operation: string, input: unknown) => unknown, permissions?: readonly string[]) =>
    show(<ReviewScreen route={routeOf('DIS-06', 'FR-DIS-06')} />, path, record, command, permissions);
  const sendButton = (): HTMLButtonElement => screen.getByRole('button', { name: t('dis.wr.send.action') }) as HTMLButtonElement;

  it('has the strip of the report on top and the button of the sending at the foot', async () => {
    open();
    expect((await screen.findByTestId('status-strip')).textContent).toContain(vi_['dis.reportStatus.draft']);
    expect(sendButton().disabled).toBe(false);
  });

  it('blocks the sending while the review has an error, and for a person who may not submit, and shows no button for a report that was handed in', async () => {
    open(reportRecord({ review: { blocking: true, errors: [finding('CELL_REQUIRED', 'funding_lines[0].cumulative_vnd')], warnings: [] } }));
    await screen.findByTestId('review-errors');
    expect(sendButton().disabled).toBe(true);
    expect(sendButton().getAttribute('aria-describedby')).toBe('review-status');
    cleanup();
    open(reportRecord(), undefined, MAKER);
    await screen.findByTestId('review-status');
    expect(sendButton().disabled).toBe(true);
    cleanup();
    open(reportRecord({ status: 'SUBMITTED', review: null }));
    await screen.findByTestId('review-status');
    expect(screen.queryByRole('button', { name: t('dis.wr.send.action') })).toBeNull();
  });

  it('asks first with the project, the period, the total, the warnings that do not stop it and the deadline; looking again sends nothing', async () => {
    const user = userEvent.setup();
    const h = open(reportRecord({ review: { blocking: false, errors: [], warnings: [finding('RATIO_OVER', 'funding_lines')] } }));
    await screen.findByTestId('review-status');
    await user.click(sendButton());
    const dialog = await screen.findByRole('dialog', { name: t('dis.wr.send.title') });
    expect(dialog.textContent).toContain('DA-2027-001 · Cầu qua sông');
    expect(dialog.textContent).toContain('2027-W01');
    expect(dialog.textContent).toContain(t('dis.wr.send.total.value', { amount: '420.000.000' }));
    expect(dialog.textContent).toContain(t('dis.wr.send.warnings.value', { count: 1 }));
    await waitFor(() => expect(dialog.textContent).toContain('10:00 09/01/2099'));
    await user.click(within(dialog).getByRole('button', { name: t('dis.wr.send.cancel') }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('hands the report in under its version and gives the receipt with the code, the time, the recipient and the next step, and says it was late', async () => {
    const user = userEvent.setup();
    const h = open();
    await screen.findByTestId('review-status');
    await user.click(sendButton());
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: t('dis.wr.send.confirm') }));
    expect(await screen.findByTestId('receipt')).toBeTruthy();
    expect(h.command).toHaveBeenCalledTimes(1);
    expect(h.command.mock.calls[0]?.[0]).toBe('post_reports_id_submit');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: REPORT }, ifMatchVersion: 3 });
    expect(text('receipt-code')).toBe('BN-01234567');
    expect(text('receipt-time')).toBe('16:30 11/01/2027');
    expect(text('receipt-recipient')).toBe('Cao Bang');
    expect(text('receipt-next')).toBe(t('dis.wr.receipt.next'));
    expect(screen.getByText(t('dis.wr.receipt.late.value'))).toBeTruthy();
  });

  it('tells the refusal in words, with no receipt, and the report stays', async () => {
    const user = userEvent.setup();
    open(reportRecord(), () => new ApiError({ status: 409, code: 'VERSION_CONFLICT', correlationId: 'c' }));
    await screen.findByTestId('review-status');
    await user.click(sendButton());
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: t('dis.wr.send.confirm') }));
    expect((await screen.findByTestId('send-refusal')).textContent).toBe(vi_['dis.reportProblem.versionConflict']);
    expect(screen.queryByTestId('receipt')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('DIS-03 the strip, the sections and the errors at the top', () => {
  const path = `/dis/dis-03?report=${REPORT}`;
  const open = (record: Record<string, unknown> = reportRecord(), permissions: readonly string[] = MAKER) => show(<ProgressScreen route={routeOf('DIS-03', 'FR-DIS-03')} />, path, record, () => ({ status: 'DRAFT', resource_version: 4 }), permissions);

  it('shows the strip, the unit of the amounts, and a bar with the save as the main action and the way back', async () => {
    open();
    expect((await screen.findByTestId('status-strip')).textContent).toContain(vi_['dis.reportStatus.draft']);
    expect(screen.getByText(t('ui.unitChip.label', { unit: t('dis.wr.unit') }))).toBeTruthy();
    const bar = within(screen.getByRole('group', { name: t('ui.stickyActions.label') }));
    expect(bar.getByRole('button', { name: vi_['dis.progress.save.action'] })).toBeTruthy();
    expect(bar.getByRole('link', { name: t('dis.wr.back.action') }).getAttribute('href')).toBe('/dis/dis-01');
    expect(bar.getByRole('link', { name: t('dis.wr.progress.next.action') }).getAttribute('href')).toBe(`/dis/dis-04?report=${REPORT}`);
  });

  it('gathers the errors at the top and the focus goes there; a link leads to the field', async () => {
    const user = userEvent.setup();
    open(reportRecord({ progress: null }));
    await screen.findByTestId('report-facts');
    await user.click(screen.getByRole('button', { name: vi_['dis.progress.save.action'] }));
    const summary = await screen.findByTestId('error-summary');
    expect(document.activeElement).toBe(summary);
    const links = within(summary).getAllByRole('link');
    expect(links.length).toBeGreaterThan(0);
    await user.click(links[0] as HTMLElement);
    expect((document.activeElement as HTMLElement).id).toMatch(/^volume-/);
  });

  it('shows a report that was handed in as read only with the way back as the only action', async () => {
    open(reportRecord({ status: 'SUBMITTED' }));
    await screen.findByTestId('readonly-note');
    const bar = within(screen.getByRole('group', { name: t('ui.stickyActions.label') }));
    expect(bar.queryByRole('button', { name: vi_['dis.progress.save.action'] })).toBeNull();
    expect(bar.getByRole('link', { name: t('dis.wr.back.action') })).toBeTruthy();
  });
});

describe('DIS-02 the choice of the period and the project', () => {
  const open = () => {
    const h = client(world(), () => ({ status: 'DRAFT', resource_id: REPORT, resource_version: 1 }));
    mount(<ReportCreateScreen route={routeOf('DIS-02', 'FR-DIS-02')} />, h, { permissions: MAKER, path: '/dis/dis-02' });
    return h;
  };

  it('says the status and the deadline of the period that is chosen, and has the way back next to the main action', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByTestId('create-note');
    expect(screen.queryByTestId('create-deadline')).toBeNull();
    await user.selectOptions(screen.getByLabelText(vi_['dis.reportCreate.year.label']), '2027');
    await user.selectOptions(screen.getByLabelText(vi_['dis.reportCreate.period.label']), PERIOD);
    expect((await screen.findByTestId('create-deadline')).textContent).toMatch(/^Hạn 10:00 09\/01\/2099 · còn \d+ ngày$/);
    expect(screen.getByRole('link', { name: t('dis.wr.back.action') }).getAttribute('href')).toBe('/dis/dis-01');
  });

  it('gathers the missing period and project at the top and sends nothing', async () => {
    const user = userEvent.setup();
    const h = open();
    await screen.findByTestId('create-note');
    await user.click(screen.getByRole('button', { name: vi_['dis.reportCreate.submit.action'] }));
    const summary = await screen.findByTestId('error-summary');
    expect(summary.textContent).toContain(vi_['dis.reportCreate.period.required']);
    expect(summary.textContent).toContain(vi_['dis.reportCreate.project.required']);
    await user.selectOptions(screen.getByLabelText(vi_['dis.reportCreate.project.label']), PROJECT);
    expect(h.command).not.toHaveBeenCalled();
  });
});
