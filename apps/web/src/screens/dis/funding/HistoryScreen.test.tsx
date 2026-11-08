import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '@machvon/api-client';
import vi from '../../../i18n/vi.json';
import HistoryScreen from './HistoryScreen';
import { PROJECT, READER, client, history, mount, routeOf } from './test-support';

const ROUTE = routeOf('DIS-29', 'FR-DIS-29');
const KEY = `project=${PROJECT}&class=EQUITY&tier=ALL&measure=DISBURSED&grain=MONTH&year=2026&ordinal=3`;

afterEach(cleanup);

const open = (world: Parameters<typeof client>[0] = {}, path = `/dis/dis-29?${KEY}`) => {
  const h = client(world);
  mount(<HistoryScreen route={ROUTE} />, h, READER, path);
  return h;
};

describe('DIS-29: the conversion history of a period', () => {
  it('shows the estimates in the order of their day, the change between them, then the actual with the estimate it replaced and the difference', async () => {
    const h = open();
    expect(await screen.findByRole('heading', { name: /Lịch sử chuyển đổi của một kỳ/ })).toBeTruthy();
    const rows = (await screen.findAllByRole('row')).slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0] as HTMLElement).getByText('100.000.000')).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText('20.000.000')).toBeTruthy();
    const actual = rows[2] as HTMLElement;
    expect(within(actual).getByText('Số thực')).toBeTruthy();
    expect(within(actual).getByText('125.000.000')).toBeTruthy();
    expect(within(actual).getByText('120.000.000')).toBeTruthy();
    expect(within(actual).getByText('5.000.000')).toBeTruthy();
    expect(within(actual).getByText('Số thực của kỳ đã về')).toBeTruthy();
    expect(screen.getByText(/chỉ thêm, không sửa, không xóa/)).toBeTruthy();
    expect(h.read).toHaveBeenCalledWith('getFundingFigureHistory', expect.objectContaining({ query: expect.objectContaining({ project_id: PROJECT, class_code: 'EQUITY', period_grain: 'MONTH', plan_year: 2026, period_ordinal: 3 }) }));
  });

  it('shows the project, the class and the period in the context bar, and offers no way to edit or delete a step', async () => {
    open();
    await screen.findAllByRole('row');
    expect(screen.getByText('DA-2026-001')).toBeTruthy();
    expect(screen.getByText('Tháng 3 / 2026')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Sửa|Xóa|Rút/ })).toBeNull();
  });

  it('lists the batches that still wait apart from the history, with a way to the queue', async () => {
    open({ history: history({ pending: [{ batch_id: 'b', figure_kind: 'ESTIMATE', period_ordinal: 3, amount_vnd: '130.000.000'.replace(/\./g, ''), status: 'SUBMITTED', as_of_date: '2026-04-02' }] }) });
    const pending = await screen.findByTestId('pending');
    expect(within(pending).getByText(/130\.000\.000/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Đến các lô đang chờ' }).getAttribute('href')).toBe('/dis/dis-28?status=SUBMITTED');
  });

  it('says how to open the history when the address names no period, and reads nothing', async () => {
    const h = open({}, '/dis/dis-29');
    expect(await screen.findByTestId('missing-key')).toBeTruthy();
    expect(h.read).not.toHaveBeenCalledWith('getFundingFigureHistory', expect.anything());
  });

  it('is empty when the period has neither history nor waiting batch, and shows the card of a refusal or a failure', async () => {
    open({ history: history({ history: [], pending: [] }) });
    expect(await screen.findByText(vi['states.empty.title'])).toBeTruthy();
    cleanup();
    open({ history: new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c' }) });
    expect(await screen.findByText(vi['states.error.title'])).toBeTruthy();
    cleanup();
    open({ history: new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }) });
    expect(await screen.findByText(vi['states.denied.title'])).toBeTruthy();
  });
});
