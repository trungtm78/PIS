import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import AppropriationBookScreen from './AppropriationBookScreen';
import { APPROVER, DOCUMENT, EXTENSION, FUND_NSDP, FUND_NSTW, PLANNER, PROGRAM_NTM, READER, client, line, mount, routeOf, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('CAP-16', 'FR-CAP-16');
const problem = (code: string, status = 422, detail?: string) => new ApiError({ status, code, correlationId: 'c', detail, extensions: {} });

afterEach(cleanup);

const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('tr[data-appropriation-id]'));
const ready = () => waitFor(() => expect(rows().length).toBeGreaterThan(0));
const cell = (row: HTMLElement | undefined, index: number): string => row?.querySelectorAll('th, td')[index]?.textContent ?? '';
// The filters and the form share the words of some labels (the plan year, the origin, the level): the form is looked in on its own.
const formScope = () => within(document.querySelector<HTMLElement>('form.cap-form') ?? document.body);
const set = (label: string, value: string): void => {
  fireEvent.change(formScope().getByLabelText(label), { target: { value } });
};
const click = (name: string): void => {
  fireEvent.click(screen.getByRole('button', { name }));
};
const answer = { operation_id: 'o', status: 'DRAFT', resource_version: 1, resource_id: '00000000-0000-4000-8000-000000000999' };

describe('AppropriationBookScreen (CAP-16): the book of the capital assigned to the province', () => {
  it('lists each appropriation by fund source, year, origin and level with its decision, its amounts in millions and Con lai (UI-CAP-16, AC-ST-CAP-001-1, UAT-AC220)', async () => {
    mount(<AppropriationBookScreen route={ROUTE} />, client(world()), { permissions: READER });
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['cap.book.page.title']);
    const headers = Array.from(document.querySelectorAll('th[scope="col"]')).map((header) => header.textContent);
    expect(headers).toEqual([
      vi_['cap.book.column.fund'],
      vi_['cap.book.column.year'],
      vi_['cap.book.column.origin'],
      vi_['cap.book.column.level'],
      vi_['cap.book.column.decision'],
      vi_['cap.book.column.amount'],
      vi_['cap.book.column.allocated'],
      vi_['cap.book.column.remaining'],
      vi_['cap.book.column.status'],
      vi_['cap.book.column.actions'],
    ]);
    // The fund source and the plan year are the pinned columns.
    expect(Array.from(document.querySelectorAll('thead .cap-pin')).length).toBe(2);
    expect(rows().map((row) => row.getAttribute('data-origin'))).toEqual(['PM_ASSIGNED', 'PM_ASSIGNED', 'LOCAL_ADDED', 'CENTRAL_SUPPORT', 'REVENUE_INCREASE']);
    // The Prime Minister assigned line: 10,000 million, 6,000 allocated, 4,000 left; the decision is cited by its symbol and date.
    const first = rows()[0];
    expect(cell(first, 0)).toContain('NSTW-DTPT');
    expect(cell(first, 1)).toBe('2026');
    expect(cell(first, 2)).toContain(vi_['cap.origin.pmAssigned.label']);
    expect(cell(first, 3)).toBe(vi_['cap.level.central.label']);
    expect(cell(first, 4)).toContain('1/QD-TTg ngày 2026-01-15');
    expect([cell(first, 5), cell(first, 6), cell(first, 7)]).toEqual(['10.000', '6.000', '4.000']);
    expect(cell(first, 8)).toBe(vi_['cap.status.published.label']);
    // Millions are exact to the dong, and the exact dong are on the cell.
    const draft = rows().find((row) => row.getAttribute('data-appropriation-id') === line(5).id);
    expect(cell(draft, 5)).toBe('1.234,56789');
    expect(draft?.querySelector('[data-vnd="1234567890"]')?.getAttribute('title')).toBe('1.234.567.890');
    // The totals count the published lines only, as sums of integers.
    const totals = Array.from(screen.getByTestId('totals').querySelectorAll('td')).map((total) => total.textContent);
    expect(totals.slice(0, 3)).toEqual(['49.000', '31.000', '18.000']);
  });

  it('separates the origins: central support and revenue increase are lines of their own (AC-ST-CAP-001-2, UAT-AC235)', async () => {
    mount(<AppropriationBookScreen route={ROUTE} />, client(world()), { permissions: READER });
    await ready();
    fireEvent.change(screen.getByLabelText(vi_['cap.book.origin.label']), { target: { value: 'CENTRAL_SUPPORT' } });
    expect(rows().map((row) => cell(row, 2))).toEqual([vi_['cap.origin.centralSupport.label']]);
    expect(Array.from(screen.getByTestId('totals').querySelectorAll('td')).map((total) => total.textContent).slice(0, 3)).toEqual(['20.000', '20.000', '0']);
    fireEvent.change(screen.getByLabelText(vi_['cap.book.origin.label']), { target: { value: 'REVENUE_INCREASE' } });
    expect(rows().map((row) => cell(row, 2))).toEqual([vi_['cap.origin.revenueIncrease.label']]);
    expect(Array.from(screen.getByTestId('totals').querySelectorAll('td')).map((total) => total.textContent).slice(0, 3)).toEqual(['15.000', '5.000', '10.000']);
  });

  it('filters by year, origin and budget level, and says when nothing matches', async () => {
    mount(<AppropriationBookScreen route={ROUTE} />, client(world()), { permissions: READER });
    await ready();
    expect(within(screen.getByLabelText(vi_['cap.book.year.label'])).getAllByRole('option').map((option) => option.textContent)).toEqual([vi_['cap.book.filter.all'], '2026', '2025']);
    fireEvent.change(screen.getByLabelText(vi_['cap.book.year.label']), { target: { value: '2025' } });
    expect(rows()).toHaveLength(2);
    fireEvent.change(screen.getByLabelText(vi_['cap.book.level.label']), { target: { value: 'CENTRAL' } });
    expect(rows().map((row) => row.getAttribute('data-origin'))).toEqual(['CENTRAL_SUPPORT']);
    fireEvent.change(screen.getByLabelText(vi_['cap.book.origin.label']), { target: { value: 'LOCAL_ADDED' } });
    expect(screen.getByTestId('no-match').textContent).toBe(vi_['cap.book.noMatch.notice']);
  });

  it('offers the registration to a planner only, and nothing to change to a reader or to a tenant that is read only', async () => {
    mount(<AppropriationBookScreen route={ROUTE} />, client(world()), { permissions: PLANNER });
    await ready();
    expect(screen.getByRole('button', { name: vi_['cap.book.register.action'] })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: vi_['cap.book.revise.action'] }).length).toBe(4);
    expect(screen.queryByRole('button', { name: vi_['cap.book.approve.action'] })).toBeNull();
    cleanup();
    mount(<AppropriationBookScreen route={ROUTE} />, client(world()), { permissions: READER });
    await ready();
    expect(screen.queryByRole('button', { name: vi_['cap.book.register.action'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['cap.book.revise.action'] })).toBeNull();
    expect(screen.getByText(vi_['cap.readOnly.denied.notice'])).toBeTruthy();
    cleanup();
    mount(<AppropriationBookScreen route={ROUTE} />, client(world()), { permissions: PLANNER, mode: 'READ_ONLY' });
    await ready();
    expect(screen.queryByRole('button', { name: vi_['cap.book.register.action'] })).toBeNull();
    expect(screen.getByText(vi_['cap.readOnly.frozen.notice'])).toBeTruthy();
  });

  it('shows the standard states: loading, empty, denied and failed', async () => {
    mount(<AppropriationBookScreen route={ROUTE} />, client(world({ lines: [] })), { permissions: READER });
    await waitFor(() => expect(screen.getByText(vi_['states.empty.title'])).toBeTruthy());
    cleanup();
    mount(<AppropriationBookScreen route={ROUTE} />, client(world({ failing: new Map([['listAppropriations', problem('SCOPE_DENIED', 403)]]) })), { permissions: READER });
    await waitFor(() => expect(screen.getByText(vi_['states.denied.title'])).toBeTruthy());
    cleanup();
    mount(<AppropriationBookScreen route={ROUTE} />, client(world({ failing: new Map([['listAppropriations', new Error('boom')]]) })), { permissions: READER });
    await waitFor(() => expect(screen.getByText(vi_['states.error.title'])).toBeTruthy());
    cleanup();
    mount(<AppropriationBookScreen route={ROUTE} />, client(world()), { permissions: READER });
    expect(screen.getByLabelText(vi_['states.loading.label'])).toBeTruthy();
  });

  describe('registering', () => {
    const open = async (state: World = world(), command: (operation: string, input: unknown) => unknown = () => answer) => {
      const h = client(state, command);
      mount(<AppropriationBookScreen route={ROUTE} />, h, { permissions: PLANNER });
      await ready();
      click(vi_['cap.book.register.action']);
      await waitFor(() => expect(within(formScope().getByLabelText(vi_['cap.form.fund.label'])).getAllByRole('option').length).toBeGreaterThan(1));
      return h;
    };

    it('offers the fund sources in force that add to the others, and sends the exact VND of an amount typed in millions (TK-CAP-001-3)', async () => {
      const h = await open();
      const options = (label: string) => within(screen.getByLabelText(label)).getAllByRole('option').map((option) => option.textContent);
      // A subset of a parent source and a source that is retired are not offered.
      expect(options(vi_['cap.form.fund.label'])).toEqual([vi_['cap.form.choose.option'], 'NSTW-DTPT · Ngân sách trung ương đầu tư phát triển', 'NSDP-DTPT · Ngân sách địa phương đầu tư phát triển']);
      await waitFor(() => expect(options(vi_['cap.form.program.label'])).toEqual([vi_['cap.form.choose.option'], 'NTM · Nông thôn mới']));
      set(vi_['cap.form.fund.label'], FUND_NSDP);
      set(vi_['cap.form.program.label'], PROGRAM_NTM);
      set(vi_['cap.form.year.label'], '2027');
      set(vi_['cap.form.origin.label'], 'LOCAL_ADDED');
      set(vi_['cap.form.level.label'], 'LOCAL');
      set(vi_['cap.form.amount.label'], '1234,5');
      expect(screen.getByTestId('exact-amount').textContent).toBe('Sẽ ghi 1.234.500.000 đồng.');
      set(vi_['cap.form.decision.label'], DOCUMENT.toUpperCase());
      set(vi_['cap.form.authority.label'], ' Hội đồng nhân dân tỉnh ');
      click(vi_['cap.form.submit.action']);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      const [operation, input] = h.command.mock.calls[0] as [string, { body: Record<string, unknown>; ifMatchVersion?: number }];
      expect(operation).toBe('registerAppropriation');
      expect(input.body).toEqual({
        fund_source_version_id: FUND_NSDP,
        plan_year: 2027,
        origin: 'LOCAL_ADDED',
        budget_level: 'LOCAL',
        amount_vnd: '1234500000',
        decision_document_id: DOCUMENT,
        issuing_authority: 'Hội đồng nhân dân tỉnh',
        source_year: 2027,
        program_master_version_id: PROGRAM_NTM,
      });
      expect(input.ifMatchVersion).toBeUndefined();
      // The panel closes once the draft is saved.
      await waitFor(() => expect(formScope().queryByLabelText(vi_['cap.form.fund.label'])).toBeNull());
    });

    it('names what is wrong and sends nothing, and never reads a grouped amount as another one', async () => {
      const h = await open();
      click(vi_['cap.form.submit.action']);
      expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toEqual(expect.arrayContaining([vi_['cap.field.required.error']]));
      set(vi_['cap.form.fund.label'], FUND_NSTW);
      set(vi_['cap.form.year.label'], '26');
      set(vi_['cap.form.amount.label'], '10.000');
      expect(screen.getByTestId('exact-amount').textContent).toBe(vi_['cap.form.amountExact.empty']);
      set(vi_['cap.form.decision.label'], 'QD-1');
      set(vi_['cap.form.authority.label'], 'a');
      click(vi_['cap.form.submit.action']);
      const messages = screen.getAllByRole('alert').map((alert) => alert.textContent);
      expect(messages).toEqual(expect.arrayContaining([vi_['cap.field.invalidYear.error'], vi_['cap.field.invalidAmount.error'], vi_['cap.field.invalidId.error'], vi_['cap.field.tooShort.error']]));
      expect(h.command).not.toHaveBeenCalled();
    });

    it('asks a carry-over for its source year, its extension document and the day the extension ends', async () => {
      const h = await open();
      expect(formScope().queryByLabelText(vi_['cap.form.extension.label'])).toBeNull();
      set(vi_['cap.form.fund.label'], FUND_NSTW);
      set(vi_['cap.form.year.label'], '2027');
      set(vi_['cap.form.origin.label'], 'CARRYOVER');
      set(vi_['cap.form.amount.label'], '500');
      set(vi_['cap.form.decision.label'], DOCUMENT);
      set(vi_['cap.form.authority.label'], 'Ủy ban nhân dân tỉnh');
      click(vi_['cap.form.submit.action']);
      expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toEqual(expect.arrayContaining([vi_['cap.field.required.error']]));
      set(vi_['cap.form.sourceYear.label'], '2026');
      set(vi_['cap.form.extension.label'], EXTENSION);
      set(vi_['cap.form.extendedTo.label'], '2027-12-31');
      click(vi_['cap.form.submit.action']);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect((h.command.mock.calls[0] as [string, { body: Record<string, unknown> }])[1].body).toMatchObject({ origin: 'CARRYOVER', source_year: 2026, extension_document_id: EXTENSION, extended_to: '2027-12-31', amount_vnd: '500000000' });
    });

    it('says why the server refused, and keeps the form open', async () => {
      const refused = async (code: string, status: number, message: string, detail?: string) => {
        cleanup();
        await open(world(), () => {
          throw problem(code, status, detail);
        });
        set(vi_['cap.form.fund.label'], FUND_NSTW);
        set(vi_['cap.form.year.label'], '2027');
        set(vi_['cap.form.amount.label'], '500');
        set(vi_['cap.form.decision.label'], DOCUMENT);
        set(vi_['cap.form.authority.label'], 'Thủ tướng Chính phủ');
        click(vi_['cap.form.submit.action']);
        await waitFor(() => expect(screen.getByTestId('problem').textContent).toBe(message));
        expect(formScope().getByLabelText(vi_['cap.form.fund.label'])).toBeTruthy();
      };
      await refused('DECISION_REQUIRED', 422, vi_['cap.problem.decisionRequired.error']);
      await refused('APPROPRIATION_DUPLICATE', 409, vi_['cap.problem.duplicate.error']);
      await refused('FISCAL_YEAR_LOCKED', 409, vi_['cap.problem.yearLocked.error']);
      await refused('MASTER_NOT_EFFECTIVE', 422, vi_['cap.problem.masterNotEffectiveField.error'].replace('{field}', 'fund_source_version_id'), 'fund_source_version_id');
      await refused('SUBSET_SOURCE_NOT_ADDITIVE', 422, vi_['cap.problem.subsetSource.error']);
      await refused('SOMETHING_NEW', 500, vi_['cap.problem.general.error']);
    });

    it('closes the form on cancel', async () => {
      await open();
      click(vi_['cap.form.cancel.action']);
      expect(formScope().queryByLabelText(vi_['cap.form.fund.label'])).toBeNull();
    });
  });

  describe('revising', () => {
    it('starts from the published appropriation, keeps what identifies it, and refuses a value below the allocated total (AC-ST-CAP-001-3, UAT-PLAN-59)', async () => {
      const h = client(world(), () => {
        throw problem('APPROPRIATION_BELOW_ALLOCATED', 422, 'amount_vnd');
      });
      mount(<AppropriationBookScreen route={ROUTE} />, h, { permissions: PLANNER });
      await ready();
      fireEvent.click(within(rows()[0] as HTMLElement).getByRole('button', { name: vi_['cap.book.revise.action'] }));
      await waitFor(() => expect(within(formScope().getByLabelText(vi_['cap.form.fund.label'])).getAllByRole('option').length).toBeGreaterThan(1));
      expect(screen.getByRole('form', { name: 'Điều chỉnh giá trị giao của NSTW-DTPT, năm 2026' })).toBeTruthy();
      // The fund source, the year, the origin and the level are locked; the amount, the document and the authority change.
      expect(formScope().getByLabelText(vi_['cap.form.fund.label']).matches(':disabled')).toBe(true);
      expect(formScope().getByLabelText(vi_['cap.form.year.label']).matches(':disabled')).toBe(true);
      expect((formScope().getByLabelText(vi_['cap.form.amount.label']) as HTMLInputElement).value).toBe('10000');
      expect((formScope().getByLabelText(vi_['cap.form.decision.label']) as HTMLInputElement).value).toBe('');
      set(vi_['cap.form.amount.label'], '5000');
      set(vi_['cap.form.decision.label'], DOCUMENT);
      click(vi_['cap.form.submit.action']);
      await waitFor(() => expect(screen.getByTestId('problem').textContent).toBe(vi_['cap.problem.belowAllocated.error']));
      const [operation, input] = h.command.mock.calls[0] as [string, { body: Record<string, unknown> }];
      expect(operation).toBe('registerAppropriation');
      expect(input.body).toMatchObject({ supersedes_id: line(1).id, amount_vnd: '5000000000', plan_year: 2026, origin: 'PM_ASSIGNED' });
      // The list is as it was: the refusal changed nothing.
      expect(cell(rows()[0], 5)).toBe('10.000');
    });
  });

  describe('deciding', () => {
    const draftOf = (overrides: Record<string, unknown> = {}) => line(9, { status: 'DRAFT', version: 1, approved_by: null, created_by: '00000000-0000-4000-8000-0000000000f1', ...overrides });

    it('lets an approver who is not the planner approve with a reason, using the version they saw (UAT-AC223)', async () => {
      const h = client(world({ lines: [draftOf()] }), () => ({ ...answer, status: 'PUBLISHED', resource_version: 2 }));
      mount(<AppropriationBookScreen route={ROUTE} />, h, { permissions: APPROVER });
      await ready();
      fireEvent.click(screen.getByRole('button', { name: vi_['cap.book.approve.action'] }));
      const submit = screen.getByRole('button', { name: vi_['cap.book.decision.approve.action'] });
      expect((submit as HTMLButtonElement).disabled).toBe(true);
      fireEvent.change(screen.getByLabelText(vi_['cap.book.reason.approve.label']), { target: { value: 'ok' } });
      expect((submit as HTMLButtonElement).disabled).toBe(true);
      fireEvent.change(screen.getByLabelText(vi_['cap.book.reason.approve.label']), { target: { value: ' Đối chiếu với quyết định giao ' } });
      fireEvent.click(submit);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]).toEqual([
        'decideAppropriation',
        expect.objectContaining({ path: { id: line(9).id }, body: { decision: 'approve', reason: 'Đối chiếu với quyết định giao' }, ifMatchVersion: 1 }),
      ]);
      await waitFor(() => expect(screen.queryByTestId('decision-row')).toBeNull());
    });

    it('rejects with a reason, and can cancel a decision that was started', async () => {
      const h = client(world({ lines: [draftOf()] }), () => ({ ...answer, status: 'REJECTED', resource_version: 2 }));
      mount(<AppropriationBookScreen route={ROUTE} />, h, { permissions: APPROVER });
      await ready();
      fireEvent.click(screen.getByRole('button', { name: vi_['cap.book.reject.action'] }));
      fireEvent.click(screen.getByRole('button', { name: vi_['cap.book.decision.cancel.action'] }));
      expect(screen.queryByTestId('decision-row')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: vi_['cap.book.reject.action'] }));
      fireEvent.change(screen.getByLabelText(vi_['cap.book.reason.reject.label']), { target: { value: 'Sai nguồn vốn' } });
      fireEvent.click(screen.getByRole('button', { name: vi_['cap.book.decision.reject.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect((h.command.mock.calls[0] as [string, { body: Record<string, unknown> }])[1].body).toEqual({ decision: 'reject', reason: 'Sai nguồn vốn' });
    });

    it('does not offer the planner their own draft to approve, and says so (SELF_APPROVAL_DENIED is the server\'s last word)', async () => {
      const own = draftOf({ created_by: '00000000-0000-4000-8000-000000000001' });
      mount(<AppropriationBookScreen route={ROUTE} />, client(world({ lines: [own] })), { permissions: [...APPROVER, ...PLANNER] });
      await ready();
      expect(screen.queryByRole('button', { name: vi_['cap.book.approve.action'] })).toBeNull();
      expect(screen.getByText(vi_['cap.book.ownDraft.notice'])).toBeTruthy();
    });

    it('says why the server refused the decision', async () => {
      const refused = async (code: string, status: number, message: string) => {
        cleanup();
        mount(
          <AppropriationBookScreen route={ROUTE} />,
          client(world({ lines: [draftOf()] }), () => {
            throw problem(code, status);
          }),
          { permissions: APPROVER },
        );
        await ready();
        fireEvent.click(screen.getByRole('button', { name: vi_['cap.book.approve.action'] }));
        fireEvent.change(screen.getByLabelText(vi_['cap.book.reason.approve.label']), { target: { value: 'Đã đối chiếu' } });
        fireEvent.click(screen.getByRole('button', { name: vi_['cap.book.decision.approve.action'] }));
        await waitFor(() => expect(screen.getByTestId('problem').textContent).toBe(message));
      };
      await refused('SELF_APPROVAL_DENIED', 403, vi_['cap.problem.selfApproval.error']);
      await refused('VERSION_CONFLICT', 409, vi_['cap.problem.versionConflict.error']);
      await refused('STAGE_TRANSITION_DENIED', 409, vi_['cap.problem.stateInvalid.error']);
      await refused('APPROPRIATION_BELOW_ALLOCATED', 422, vi_['cap.problem.belowAllocated.error']);
      await refused('RESOURCE_NOT_FOUND', 404, vi_['cap.problem.notFound.error']);
    });
  });
});
