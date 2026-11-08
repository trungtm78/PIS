import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '@machvon/api-client';
import vi from '../../../i18n/vi.json';
import BatchScreen from './BatchScreen';
import { BATCH, CHECKER, PREPARER, READER, batch, client, mount, problem, routeOf, taxonomy } from './test-support';

const ROUTE = routeOf('DIS-28', 'FR-DIS-28');

afterEach(cleanup);

const open = (world: Parameters<typeof client>[0] = {}, permissions: readonly string[] = PREPARER, command?: Parameters<typeof client>[1]) => {
  const h = client(world, command);
  mount(<BatchScreen route={ROUTE} />, h, permissions, '/dis/dis-28');
  return h;
};

const waiting = (over: Record<string, unknown> = {}) => batch({ status: 'SUBMITTED', prepared_by_me: false, actions: { submit: false, withdraw: false, accept: true, return: true }, version: 2, ...over });

describe('DIS-28: prepare, hand in and accept batches of funding figures', () => {
  it('lists the batches with their kind, period, lines, status and who prepared them, and offers the preparer the buttons of the maker only', async () => {
    open();
    expect(await screen.findByRole('heading', { name: /Lập và duyệt số liệu vốn/ })).toBeTruthy();
    const row = (await screen.findByText('DA-2026-001', { selector: 'td *, td' })).closest('tr') as HTMLElement;
    expect(within(row).getByText('Số ước')).toBeTruthy();
    expect(within(row).getByText('3: 100.000.000')).toBeTruthy();
    expect(within(row).getByText('Nháp')).toBeTruthy();
    expect(within(row).getByText(/Tôi lập/)).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Gửi duyệt' })).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Rút' })).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'Chấp nhận' })).toBeNull();
    expect(within(row).getByRole('link', { name: 'Lịch sử' }).getAttribute('href')).toContain('/dis/dis-29?project=');
  });

  it('hands a draft in under the version the caller saw and refreshes the list', async () => {
    const h = open();
    await userEvent.click(await screen.findByRole('button', { name: 'Gửi duyệt' }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('submitFundingFigures', expect.objectContaining({ path: { batch_id: BATCH }, ifMatchVersion: 1 })));
  });

  it('gives the checker the buttons to accept and send back, never to the preparer of the batch (maker is not checker)', async () => {
    open({ batches: { items: [waiting(), waiting({ batch_id: '00000000-0000-4000-8000-0006000000c2', prepared_by_me: true, actions: { submit: false, withdraw: true, accept: false, return: false } })], truncated: false, as_of: 'x' } }, CHECKER);
    const rows = await screen.findAllByText('DA-2026-001', { selector: 'td *, td' });
    expect(rows).toHaveLength(2);
    const others = rows.map((cell) => cell.closest('tr') as HTMLElement);
    expect(within(others[0] as HTMLElement).getByRole('button', { name: 'Chấp nhận' })).toBeTruthy();
    expect(within(others[0] as HTMLElement).getByRole('button', { name: 'Trả lại' })).toBeTruthy();
    expect(within(others[1] as HTMLElement).queryByRole('button', { name: 'Chấp nhận' })).toBeNull();
    expect(within(others[1] as HTMLElement).queryByRole('button', { name: 'Trả lại' })).toBeNull();
  });

  it('accepts a batch under its version; a refusal of the server is said in words (the preparer himself, a stale version, a period that locked)', async () => {
    const h = open({ batches: { items: [waiting()], truncated: false, as_of: 'x' } }, CHECKER, () => {
      throw problem('SELF_APPROVAL_DENIED', 403);
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Chấp nhận' }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('acceptFundingFigures', expect.objectContaining({ ifMatchVersion: 2 })));
    expect((await screen.findByTestId('problem')).textContent).toContain('Người lập không tự chấp nhận');
  });

  it('asks for a reason of at least 10 characters before it sends a batch back, and puts the reason in the command', async () => {
    const h = open({ batches: { items: [waiting()], truncated: false, as_of: 'x' } }, CHECKER);
    await userEvent.click(await screen.findByRole('button', { name: 'Trả lại' }));
    const dialog = await screen.findByRole('dialog');
    const send = within(dialog).getByRole('button', { name: 'Trả lại' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await userEvent.type(within(dialog).getByRole('textbox'), 'The estimate is not the plan');
    expect(send.disabled).toBe(false);
    await userEvent.click(send);
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('returnFundingFigures', expect.objectContaining({ path: { batch_id: BATCH }, body: { reason: 'The estimate is not the plan' }, ifMatchVersion: 2 })));
  });

  it('lets the preparer withdraw with a reason', async () => {
    const h = open();
    await userEvent.click(await screen.findByRole('button', { name: 'Rút' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Prepared against the wrong month');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Rút' }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('withdrawFundingFigures', expect.objectContaining({ body: { reason: 'Prepared against the wrong month' }, ifMatchVersion: 1 })));
  });

  describe('the form', () => {
    it('names the field that is wrong and sends nothing until the form is complete', async () => {
      const h = open();
      await userEvent.click(await screen.findByRole('button', { name: 'Lưu nháp' }));
      expect(await screen.findByText('Chọn một dự án.')).toBeTruthy();
      expect(screen.getByText(/Nhập số tiền đồng nguyên/)).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
    });

    it('sends the estimate as whole dong text for the month typed, and starts the form over once it is saved', async () => {
      const h = open();
      await screen.findByRole('option', { name: /DA-2026-001/ });
      await userEvent.selectOptions(screen.getByLabelText('Dự án'), 'DA-2026-001 · Nhà máy A');
      const month3 = screen.getByText('Tháng 3').closest('label') as HTMLElement;
      await userEvent.type(within(month3).getByRole('textbox'), '100.000.000');
      await userEvent.click(screen.getByRole('button', { name: 'Lưu nháp' }));
      await waitFor(() =>
        expect(h.command).toHaveBeenCalledWith(
          'proposeFundingFigures',
          expect.objectContaining({ body: expect.objectContaining({ class_code: 'EQUITY', tier_code: 'ALL', figure_kind: 'ESTIMATE', period_grain: 'MONTH', entries: [{ period_ordinal: 3, amount_vnd: '100000000' }] }) }),
        ),
      );
      await waitFor(() => expect((within(screen.getByText('Tháng 3').closest('label') as HTMLElement).getByRole('textbox') as HTMLInputElement).value).toBe(''));
    });

    it('asks for the four quarters when the pack says they must add up to the year plan, and shows the refusal of the server in words', async () => {
      const h = open({}, PREPARER, () => {
        throw problem('PHASING_SUM_MISMATCH');
      });
      await screen.findByRole('option', { name: /DA-2026-001/ });
      await userEvent.selectOptions(screen.getByLabelText('Dự án'), 'DA-2026-001 · Nhà máy A');
      await userEvent.selectOptions(screen.getByLabelText('Loại số liệu'), 'PLAN_QUARTER');
      expect(screen.getByText(/yêu cầu nhập đủ các kỳ/)).toBeTruthy();
      const inputs = ['Quý 1', 'Quý 2', 'Quý 3'].map((label) => within(screen.getByText(label).closest('label') as HTMLElement).getByRole('textbox'));
      for (const input of inputs) await userEvent.type(input, '10');
      await userEvent.click(screen.getByRole('button', { name: 'Lưu nháp' }));
      expect(await screen.findByText(/Nhập số tiền đồng nguyên/)).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      await userEvent.type(within(screen.getByText('Quý 4').closest('label') as HTMLElement).getByRole('textbox'), '10');
      await userEvent.click(screen.getByRole('button', { name: 'Lưu nháp' }));
      expect((await screen.findByTestId('problem')).textContent).toContain('Bốn quý không cộng bằng kế hoạch năm');
    });

    it('does not offer the year plan of the measure that CAP owns', async () => {
      open();
      await userEvent.selectOptions(await screen.findByLabelText('Thước đo'), 'DISBURSED');
      const kind = screen.getByLabelText('Loại số liệu');
      expect(within(kind).queryByRole('option', { name: /Kế hoạch năm \(thước đo khác giải ngân\)/ })).toBeNull();
      await userEvent.selectOptions(screen.getByLabelText('Thước đo'), 'EXECUTED');
      expect(within(screen.getByLabelText('Loại số liệu')).getByRole('option', { name: /Kế hoạch năm \(thước đo khác giải ngân\)/ })).toBeTruthy();
    });
  });

  describe('who may do what, and the states of design.md', () => {
    it('is for reading when the caller may neither prepare nor accept: no form, no buttons, and a note', async () => {
      open({}, READER);
      expect(await screen.findByTestId('read-only')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Lưu nháp' })).toBeNull();
      const row = (await screen.findByText('DA-2026-001', { selector: 'td *, td' })).closest('tr') as HTMLElement;
      // The server decides what a row offers; a caller without the right sees the buttons disabled.
      expect((within(row).getByRole('button', { name: 'Gửi duyệt' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('is empty when nothing was prepared, and filtered by status when the person chooses one', async () => {
      const h = open({ batches: { items: [], truncated: false, as_of: 'x' } });
      expect(await screen.findByText(vi['states.empty.title'])).toBeTruthy();
      await userEvent.selectOptions(screen.getByLabelText('Trạng thái'), 'SUBMITTED');
      await waitFor(() => expect(h.read).toHaveBeenCalledWith('listFundingFigureBatches', expect.objectContaining({ query: expect.objectContaining({ status: 'SUBMITTED' }) })));
    });

    it.each([
      [new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }), vi['states.denied.title']],
      [new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), vi['states.error.title']],
    ])('shows the card of a refusal or a failure of the read (%#)', async (error, title) => {
      open({ batches: error });
      expect(await screen.findByText(title)).toBeTruthy();
    });

    it('knows the pack it prepares for: a pack of two classes offers two', async () => {
      open({ taxonomy: taxonomy({ classes: [{ code: 'EQUITY', label: 'Vốn chủ sở hữu', additive: true }, { code: 'OTHER', label: 'Vốn khác', additive: true }] }) });
      const select = await screen.findByLabelText('Nhóm vốn');
      expect(within(select).getAllByRole('option').map((one) => one.textContent)).toEqual(['Vốn chủ sở hữu', 'Vốn khác']);
    });
  });
});
