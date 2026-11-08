import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '@machvon/api-client';
import vi from '../../../i18n/vi.json';
import FundingBoardScreen from './FundingBoardScreen';
import { READER, board, client, mount, routeOf } from './test-support';

const ROUTE = routeOf('DIS-27', 'FR-DIS-27');

afterEach(cleanup);

const open = (world: Parameters<typeof client>[0] = {}, path = '/dis/dis-27') => {
  const h = client(world);
  mount(<FundingBoardScreen route={ROUTE} />, h, READER, path);
  return h;
};

describe('DIS-27: the figures of the funding model and their indicators', () => {
  it('shows the rates with their numerator and denominator, the figures of the cells with a dash for what nobody has, and the flags of a flash figure and of a missing month', async () => {
    const h = open();
    expect(await screen.findByRole('heading', { name: /Số liệu vốn theo kỳ/ })).toBeTruthy();
    const tile = (await screen.findByText('Tỷ lệ thực hiện năm')).closest('.ui-kpi') as HTMLElement;
    expect(within(tile).getByText('12,50%')).toBeTruthy();
    expect(within(tile).getByText('125.000.000 / 1.000.000.000')).toBeTruthy();
    // A rate with nothing to divide by is a dash with its reason, never 0%.
    const period = screen.getByText('Tỷ lệ thực hiện của kỳ').closest('.ui-kpi') as HTMLElement;
    expect(within(period).getByTestId('reason-RATE_PERIOD').textContent).toContain('Chưa có mẫu số');
    expect(within(period).queryByText('0,00%')).toBeNull();
    // The structure of the classes is one tile for each class.
    expect(screen.getByText('Tỷ trọng nhóm vốn: EQUITY')).toBeTruthy();
    const table = screen.getByRole('table');
    const row = within(table).getByText('DA-2026-001').closest('tr') as HTMLElement;
    expect(within(row).getByText('Vốn chủ sở hữu')).toBeTruthy();
    expect(within(row).getAllByText(/1\.000\.000\.000/).length).toBeGreaterThan(0);
    expect(within(row).getByText(/sổ chưa chốt/)).toBeTruthy();
    expect(within(row).getByText(/thiếu tháng 1/)).toBeTruthy();
    // A class nobody has a figure of is not a row of dashes.
    expect(within(table).queryByText('Vốn vay')).toBeNull();
    expect(h.read).toHaveBeenCalledWith('getFundingFigureBoard', expect.objectContaining({ query: expect.objectContaining({ period_grain: 'MONTH', view: 'AS_REPORTED' }) }));
  });

  it('AC-ST-DIS-026-3 / UI-DIS-27: puts the "i" on every number: the formula, the terms, the source, the day it is as of, and the pack with its version, flagged unverified', async () => {
    open();
    const tile = (await screen.findByText('Tỷ lệ thực hiện năm')).closest('.ui-kpi') as HTMLElement;
    await userEvent.click(within(tile).getByRole('button', { name: /Công thức, nguồn và ngày của Tỷ lệ thực hiện năm/ }));
    const panel = await screen.findByRole('dialog', { name: 'Tỷ lệ thực hiện năm' });
    expect(within(panel).getByText(/Lũy kế từ đầu năm chia kế hoạch năm đang hiệu lực/)).toBeTruthy();
    expect(within(panel).getByText('Lũy kế từ đầu năm')).toBeTruthy();
    expect(within(panel).getByText('Kế hoạch năm đang hiệu lực')).toBeTruthy();
    expect(within(panel).getByText('2026-03-31')).toBeTruthy();
    expect(within(panel).getByText('Gói ENTERPRISE, phiên bản 0')).toBeTruthy();
    expect(within(panel).getByText(/chưa kiểm chứng/)).toBeTruthy();
    // The headers of the columns carry theirs too.
    const headers = screen.getByTestId('header-info');
    expect(within(headers).getAllByRole('button').length).toBe(8);
    expect(screen.getByTestId('unverified')).toBeTruthy();
  });

  it('shows the totals as the sum of the parts, with the remaining of the year and the conversion as a dash when nobody has it', async () => {
    open();
    const totals = await screen.findByTestId('totals');
    expect(within(totals).getByText('Còn lại của năm').nextElementSibling?.textContent).toBe('875.000.000');
    expect(within(totals).getByText('Chênh lệch số thực và số ước').nextElementSibling?.textContent).toBe('–');
  });

  it('reads the pack that is in force and offers its measures and periods; a change of the period asks for the figures again with the new query', async () => {
    const h = open();
    await screen.findByRole('heading', { name: /Số liệu vốn theo kỳ/ });
    await userEvent.selectOptions(screen.getByLabelText('Cấp kỳ'), 'QUARTER');
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('getFundingFigureBoard', expect.objectContaining({ query: expect.objectContaining({ period_grain: 'QUARTER' }) })));
    await userEvent.selectOptions(screen.getByLabelText('Cách đọc'), 'RESTATED');
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('getFundingFigureBoard', expect.objectContaining({ query: expect.objectContaining({ view: 'RESTATED' }) })));
    await userEvent.selectOptions(screen.getByLabelText('Thước đo'), 'EXECUTED');
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('getFundingFigureBoard', expect.objectContaining({ query: expect.objectContaining({ measure: 'EXECUTED' }) })));
  });

  it('opens on the period and the project named in the address', async () => {
    const h = open({}, '/dis/dis-27?grain=YEAR&year=2025&view=RESTATED&project=00000000-0000-4000-8000-0005000000b1');
    await screen.findByRole('heading', { name: /Số liệu vốn theo kỳ/ });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('getFundingFigureBoard', expect.objectContaining({ query: expect.objectContaining({ period_grain: 'YEAR', plan_year: '2025', period_ordinal: '0', view: 'RESTATED', project_id: '00000000-0000-4000-8000-0005000000b1' }) })));
  });

  it('says so when the list of projects is cut, and links each row to its history', async () => {
    open({ board: board({ truncated: true }) });
    expect(await screen.findByTestId('truncated')).toBeTruthy();
    const link = screen.getAllByRole('link', { name: 'Lịch sử' })[0] as HTMLAnchorElement;
    expect(link.getAttribute('href')).toMatch(/^\/dis\/dis-29\?project=.*&class=EQUITY&tier=ALL&measure=DISBURSED&grain=MONTH&year=[0-9]{4}&ordinal=[0-9]+$/);
  });

  describe('the states of design.md', () => {
    it('is loading while the answer is on its way, and never shows a number then', () => {
      const h = client({});
      h.read.mockImplementation(() => new Promise(() => undefined));
      mount(<FundingBoardScreen route={ROUTE} />, h, READER, '/dis/dis-27');
      expect(screen.queryByTestId('totals')).toBeNull();
      expect(screen.getByRole('heading', { name: /Số liệu vốn theo kỳ/ })).toBeTruthy();
    });

    it('is empty when the scope has no figures, with the standard card', async () => {
      open({ board: board({ projects: [], totals: { money: [], rates: [] } }) });
      expect(await screen.findByText(vi['states.empty.title'])).toBeTruthy();
    });

    it.each([
      [new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }), vi['states.denied.title']],
      [new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), vi['states.error.title']],
      [new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), vi['states.signedOut.title']],
    ])('shows the card of a refusal or a failure of the read (%#)', async (error, words) => {
      open({ board: error });
      expect(await screen.findByText(words)).toBeTruthy();
    });

  });
});
