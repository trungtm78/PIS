import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import RegistrationScreen from './RegistrationScreen';
import { MAKER, READER, REPORT, client, mount, reportRecord, routeOf, world } from './test-support';

const ROUTE = routeOf('DIS-05', 'FR-DIS-05');
const PATH = `/dis/dis-05?report=${REPORT}`;

afterEach(cleanup);

const open = (record: Record<string, unknown> = reportRecord(), command: (operation: string, input: unknown) => unknown = () => ({ status: 'DRAFT', resource_version: 4 }), permissions: readonly string[] | undefined = MAKER, mode?: 'FULL' | 'READ_ONLY') => {
  const h = client(world({ details: { [REPORT]: record } }), command);
  mount(<RegistrationScreen route={ROUTE} />, h, { permissions, path: PATH, ...(mode === undefined ? {} : { mode }) });
  return h;
};
const text = (id: string): string => screen.getByTestId(id).textContent ?? '';
const next = (cell: string): HTMLInputElement => document.getElementById(`next-${cell}`) as HTMLInputElement;
const subset = (cell: string): HTMLInputElement => document.getElementById(`next-ctmtqg-${cell}`) as HTMLInputElement;
const type = async (user: ReturnType<typeof userEvent.setup>, field: HTMLInputElement, value: string) => {
  await user.clear(field);
  await user.type(field, value);
};

describe('DIS-05 register next month', () => {
  it('shows the month, and for each cell what was allocated, what was disbursed, what is left and what is registered, the CTMTQG apart', async () => {
    open();
    expect(await screen.findByRole('heading', { level: 1, name: vi_['dis.registration.page.title'] })).toBeTruthy();
    await screen.findByTestId('report-facts');
    expect(text('registration-month')).toBe(vi_['dis.registration.month.text'].replace('{month}', '2').replace('{year}', '2027'));
    expect(text('allocated-CURRENT_YEAR:CENTRAL')).toBe('500.000.000');
    expect(text('reached-CURRENT_YEAR:CENTRAL')).toBe('100.000.000');
    expect(text('remaining-CURRENT_YEAR:CENTRAL')).toBe('400.000.000');
    expect(text('remaining-CARRYOVER:LOCAL')).toBe('-20.000.000');
    expect(next('CURRENT_YEAR:LOCAL').value).toBe('5.000.000');
    expect(next('OTHER:LOCAL').value).toBe('0');
    expect(subset('CURRENT_YEAR:CENTRAL').value).toBe('');
    expect(document.getElementById('next-ctmtqg-OTHER:CENTRAL')).toBeNull();
    expect([text('total-allocated'), text('total-reached'), text('total-remaining'), text('total-registered'), text('total-registered-ctmtqg')]).toEqual(['850.000.000', '420.000.000', '430.000.000', '5.000.000', '0']);
  });

  it('AC-ST-DIS-004-3: adds up as it is typed, the CTMTQG given apart and never added', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByTestId('report-facts');
    await type(user, next('CURRENT_YEAR:CENTRAL'), '300.000.000');
    await type(user, subset('CURRENT_YEAR:CENTRAL'), '100.000.000');
    expect(text('total-registered')).toBe('305.000.000');
    expect(text('total-registered-ctmtqg')).toBe('100.000.000');
  });

  it('saves the registration of the six cells with the CTMTQG, keeps the cumulative cells, and takes the person to the draft that was saved', async () => {
    const user = userEvent.setup();
    const h = open();
    await screen.findByTestId('report-facts');
    await type(user, next('CURRENT_YEAR:CENTRAL'), '300.000.000');
    await type(user, subset('CURRENT_YEAR:CENTRAL'), '100.000.000');
    await user.click(screen.getByRole('button', { name: vi_['dis.registration.save.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    const sent = h.command.mock.calls[0]?.[1] as { path: { id: string }; ifMatchVersion: number; body: { funding_lines: Array<Record<string, unknown>> } };
    expect(h.command.mock.calls[0]?.[0]).toBe('post_reports_id_revisions');
    expect([sent.path.id, sent.ifMatchVersion]).toEqual([REPORT, 3]);
    expect(sent.body.funding_lines[0]).toEqual({ bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: '100000000', ctmtqg_subset_vnd: '40000000', next_month_vnd: '300000000', next_month_ctmtqg_subset_vnd: '100000000' });
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(`/dis/dis-18?report=${REPORT}`));
  });

  it('tells a registration with nothing in it, one that is not an amount and a CTMTQG above it, and sends nothing', async () => {
    const user = userEvent.setup();
    const h = open();
    await screen.findByTestId('report-facts');
    await user.clear(next('CURRENT_YEAR:CENTRAL'));
    await type(user, next('CURRENT_YEAR:LOCAL'), '1x');
    await type(user, next('CARRYOVER:CENTRAL'), '10');
    await type(user, subset('CARRYOVER:CENTRAL'), '11');
    await user.click(screen.getByRole('button', { name: vi_['dis.registration.save.action'] }));
    expect(await screen.findByText(vi_['dis.reportProblem.cell.required'])).toBeTruthy();
    expect(screen.getByText(vi_['dis.reportProblem.cell.invalid'])).toBeTruthy();
    expect(screen.getByText(vi_['dis.reportProblem.cell.exceeds'])).toBeTruthy();
    expect(next('CURRENT_YEAR:LOCAL').getAttribute('aria-invalid')).toBe('true');
    expect(h.command).not.toHaveBeenCalled();
  });

  it('marks the cell the server named, and tells the other refusals in words', async () => {
    const user = userEvent.setup();
    open(reportRecord(), () => new ApiError({ status: 422, code: 'SUBSET_EXCEEDS_PARENT', correlationId: 'c', detail: 'funding_lines[0].next_month_ctmtqg_subset_vnd' }));
    await screen.findByTestId('report-facts');
    await user.click(screen.getByRole('button', { name: vi_['dis.registration.save.action'] }));
    expect(await screen.findByText(vi_['dis.reportProblem.subsetExceeds'])).toBeTruthy();
    expect(subset('CURRENT_YEAR:CENTRAL').getAttribute('aria-invalid')).toBe('true');
    expect(screen.queryByTestId('refusal')).toBeNull();
    cleanup();
    open(reportRecord(), () => new ApiError({ status: 422, code: 'SUBSET_EXCEEDS_PARENT', correlationId: 'c', detail: 'funding_lines[1].next_month_vnd' }));
    await screen.findByTestId('report-facts');
    await user.click(screen.getByRole('button', { name: vi_['dis.registration.save.action'] }));
    await waitFor(() => expect(next('CURRENT_YEAR:LOCAL').getAttribute('aria-invalid')).toBe('true'));
    cleanup();
    open(reportRecord(), () => new ApiError({ status: 409, code: 'VERSION_CONFLICT', correlationId: 'c' }));
    await screen.findByTestId('report-facts');
    await user.click(screen.getByRole('button', { name: vi_['dis.registration.save.action'] }));
    expect((await screen.findByTestId('refusal')).textContent).toBe(vi_['dis.reportProblem.versionConflict']);
  });

  it('shows a report that was handed in, and a draft the person may not edit, as read only', async () => {
    open(reportRecord({ status: 'SUBMITTED' }));
    await screen.findByTestId('report-facts');
    expect(text('readonly-note')).toBe(vi_['dis.registration.readonly.note']);
    expect(next('CURRENT_YEAR:CENTRAL').disabled).toBe(true);
    expect(screen.queryByRole('button', { name: vi_['dis.registration.save.action'] })).toBeNull();
    cleanup();
    open(reportRecord(), undefined, READER);
    await screen.findByTestId('report-facts');
    expect(text('readonly-note')).toBe(vi_['dis.registration.denied.note']);
    cleanup();
    open(reportRecord(), undefined, MAKER, 'READ_ONLY');
    await screen.findByTestId('report-facts');
    expect(screen.queryByRole('button', { name: vi_['dis.registration.save.action'] })).toBeNull();
  });

  it('does not tell a month for a period without a date, asks for a report when none is chosen, and shows the states', async () => {
    open(reportRecord({ period: { ...(reportRecord().period as Record<string, unknown>), end_date: '' } }));
    await screen.findByTestId('report-facts');
    expect(screen.queryByTestId('registration-month')).toBeNull();
    cleanup();
    mount(<RegistrationScreen route={ROUTE} />, client(world()), { permissions: MAKER, path: '/dis/dis-05' });
    expect((await screen.findByTestId('report-choose')).textContent).toBe(vi_['dis.registration.choose.text']);
    cleanup();
    const failing = (error: Error) => {
      const state = world({ details: { [REPORT]: reportRecord() } });
      state.failing.set('getReportRevision', error);
      return client(state);
    };
    mount(<RegistrationScreen route={ROUTE} />, failing(new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' })), { permissions: MAKER, path: PATH });
    expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    cleanup();
    mount(<RegistrationScreen route={ROUTE} />, failing(new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' })), { permissions: MAKER, path: PATH });
    expect(await screen.findByText(vi_['states.offline.title'])).toBeTruthy();
  });
});
