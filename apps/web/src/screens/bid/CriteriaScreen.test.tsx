import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import CriteriaScreen from './CriteriaScreen';
import { APPROVER, BOTH, PLANNER, READER, client, mount, packageId, passFail, routeOf, scored, version, versionId, world } from './criteria-test-support';

const ROUTE = routeOf('BID-04', 'FR-BID-04');
const OK = { operation_id: 'o', status: 'DRAFT', resource_version: 1, resource_id: versionId(9) };
const problem = (code: string, status = 422, extensions: Record<string, unknown> = {}, detail?: string) =>
  new ApiError({ status, code, correlationId: 'c', extensions, ...(detail === undefined ? {} : { detail }) });

afterEach(cleanup);

const form = () => screen.findByTestId('criteria-form');
const send = () => userEvent.click(screen.getByRole('button', { name: vi_['bid.criteria.form.submit.action'] }));
const rows = () => screen.getAllByTestId('criterion-row');
const within_ = (row: HTMLElement, label: string) => within(row).getByLabelText(label);
const set = (row: HTMLElement, label: string, value: string): void => {
  fireEvent.change(within_(row, label), { target: { value } });
};

function fillRow(row: HTMLElement, values: { code: string; name: string; weight: string; scale?: string; threshold?: string; evidence?: string }): void {
  set(row, vi_['bid.criteria.row.code'], values.code);
  set(row, vi_['bid.criteria.row.name'], values.name);
  set(row, vi_['bid.criteria.row.weight'], values.weight);
  if (values.scale !== undefined) set(row, vi_['bid.criteria.row.scale'], values.scale);
  if (values.threshold !== undefined) set(row, vi_['bid.criteria.row.threshold'], values.threshold);
  if (values.evidence !== undefined) set(row, vi_['bid.criteria.row.evidence'], values.evidence);
}

describe('CriteriaScreen (BID-04): the evaluation criteria of a package', () => {
  it('shows the versions of the package newest first with their state in words, and the criteria of the version in force with the sum of its weights (UI-BID-04)', async () => {
    const draft = version(2, { status: 'DRAFT', approved_at: null, weights_sum: null, criteria: [passFail('R1')], version: 1 });
    mount(<CriteriaScreen route={ROUTE} />, client(world({ versions: [draft, version(1)] })), { permissions: READER });
    const table = await screen.findByTestId('versions');
    const lines = within(table).getAllByRole('row').slice(1);
    expect(lines.map((line) => line.getAttribute('data-version-id'))).toEqual([versionId(2), versionId(1)]);
    expect(within(lines[0] as HTMLElement).getByTestId('criteria-status').textContent).toBe(vi_['bid.criteria.status.draft.label']);
    expect(within(lines[1] as HTMLElement).getByTestId('criteria-status').textContent).toBe(vi_['bid.criteria.status.approved.label']);
    expect(within(lines[0] as HTMLElement).getByText(vi_['bid.criteria.weights.none.text'])).toBeTruthy();
    // The version in force is the one shown, not the newest.
    const detail = screen.getByTestId('version-detail');
    expect(detail.getAttribute('data-version-id')).toBe(versionId(1));
    expect(within(detail).getByRole('heading', { name: 'Tiêu chí của bản 1' })).toBeTruthy();
    expect(within(detail).getByText('Căn cứ: Luật Đấu thầu 22/2023/QH15')).toBeTruthy();
    const criteria = within(screen.getByTestId('criteria')).getAllByRole('row');
    expect(within(criteria[1] as HTMLElement).getByText('C1')).toBeTruthy();
    expect(within(criteria[1] as HTMLElement).getByText(vi_['bid.criteria.kind.scored.label'])).toBeTruthy();
    expect(within(criteria[1] as HTMLElement).getByText('Báo cáo tài chính đã kiểm toán')).toBeTruthy();
    expect(within(criteria[5] as HTMLElement).getByText(vi_['bid.criteria.kind.passFail.label'])).toBeTruthy();
    expect(within(criteria[5] as HTMLElement).getByText(vi_['bid.criteria.mandatory.yes.text'])).toBeTruthy();
    expect(screen.getByTestId('weights-sum').textContent).toBe('100');
    expect(document.querySelector('[data-screen-id="BID-04"]')).toBeTruthy();
    // A reader neither drafts nor approves: no form, no approval, and the note says why.
    expect(screen.queryByTestId('criteria-form')).toBeNull();
    expect(screen.getByTestId('read-only').textContent).toBe(vi_['bid.criteria.readonly.notice']);
    expect(screen.queryByRole('button', { name: vi_['bid.criteria.approve.action'] })).toBeNull();
  });

  it('shows another version when asked, and the package chosen in the address or in the list (UI-BID-04)', async () => {
    const second = { ...version(3), package: { ...version(1).package, id: packageId(2), code: 'GT-2' } };
    const h = client(world({ versions: [version(2, { status: 'SUPERSEDED' }), version(1), second] }));
    mount(<CriteriaScreen route={ROUTE} />, h, { permissions: READER, path: `/bid/bid-04?package=${packageId(2)}` });
    expect((await screen.findByTestId('version-detail')).getAttribute('data-version-id')).toBe(versionId(3));
    expect((screen.getByLabelText(vi_['bid.criteria.package.label']) as HTMLSelectElement).value).toBe(packageId(2));
    fireEvent.change(screen.getByLabelText(vi_['bid.criteria.package.label']), { target: { value: packageId(1) } });
    await waitFor(() => expect(screen.getByTestId('version-detail').getAttribute('data-version-id')).toBe(versionId(1)));
    await userEvent.click(screen.getByRole('button', { name: 'Xem bản 2' }));
    expect(screen.getByTestId('version-detail').getAttribute('data-version-id')).toBe(versionId(2));
    expect(within(screen.getByTestId('versions')).getByText(vi_['bid.criteria.status.superseded.label'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('falls back to the first package when the one in the address is not one of the packages', async () => {
    mount(<CriteriaScreen route={ROUTE} />, client(world()), { permissions: READER, path: '/bid/bid-04?package=00000000-0000-4000-8000-00000000dead' });
    expect((await screen.findByTestId('version-detail')).getAttribute('data-version-id')).toBe(versionId(1));
  });

  it('says in words that the package has no criteria yet and offers the planner the first version (UI-BID-04)', async () => {
    mount(<CriteriaScreen route={ROUTE} />, client(world({ versions: [] })), { permissions: PLANNER });
    expect((await screen.findByTestId('no-versions')).textContent).toBe(vi_['bid.criteria.versions.empty.text']);
    expect(await form()).toBeTruthy();
    expect(screen.queryByTestId('replaces-draft')).toBeNull();
    expect(screen.queryByRole('button', { name: /Bắt đầu từ bản/ })).toBeNull();
  });

  it('shows the empty, error and loading states of the packages and of the versions', async () => {
    const none = mount(<CriteriaScreen route={ROUTE} />, client(world({ packages: [] })), { permissions: READER });
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    none.unmount();
    const failing = mount(<CriteriaScreen route={ROUTE} />, client(world({ failing: new Set(['get_resources_procurement_package']) })), { permissions: READER });
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    failing.unmount();
    mount(<CriteriaScreen route={ROUTE} />, client(world({ failing: new Set(['get_resources_criteria_version']) })), { permissions: READER });
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    expect(screen.getByLabelText(vi_['bid.criteria.package.label'])).toBeTruthy();
  });

  describe('the approval', () => {
    const draft = (overrides: Record<string, unknown> = {}) => version(2, { status: 'DRAFT', approved_at: null, version: 1, ...overrides });

    it('approves a draft with the version it was read at, tells it is done and offers no approval to a planner who may not approve (UI-BID-04)', async () => {
      const h = client(world({ versions: [draft(), version(1)] }), () => ({ ...OK, status: 'APPROVED', resource_version: 2 }));
      mount(<CriteriaScreen route={ROUTE} />, h, { permissions: APPROVER });
      await screen.findByTestId('versions');
      await userEvent.click(screen.getByRole('button', { name: 'Xem bản 2' }));
      await userEvent.click(screen.getByRole('button', { name: vi_['bid.criteria.approve.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('approveCriteriaVersion');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: versionId(2) }, ifMatchVersion: 1 });
      expect((await screen.findByTestId('approved')).textContent).toBe(vi_['bid.criteria.approve.done.notice']);
    });

    it('offers no approval for a version that is not a draft, to a reader or to a planner without the right to approve', async () => {
      mount(<CriteriaScreen route={ROUTE} />, client(world({ versions: [draft(), version(1)] })), { permissions: PLANNER });
      await screen.findByTestId('versions');
      await userEvent.click(screen.getByRole('button', { name: 'Xem bản 2' }));
      expect(screen.queryByRole('button', { name: vi_['bid.criteria.approve.action'] })).toBeNull();
      cleanup();
      mount(<CriteriaScreen route={ROUTE} />, client(world({ versions: [draft(), version(1)] })), { permissions: APPROVER });
      await screen.findByTestId('versions');
      expect(screen.queryByRole('button', { name: vi_['bid.criteria.approve.action'] })).toBeNull();
    });

    it.each([
      ['SELF_APPROVAL_DENIED', 403, 'bid.criteria.problem.selfApproval.error'],
      ['CRITERIA_LOCKED_BY_RUN', 409, 'bid.criteria.problem.lockedByRun.error'],
      ['CRITERIA_STATE_INVALID', 409, 'bid.criteria.problem.stateInvalid.error'],
      ['VERSION_CONFLICT', 409, 'bid.criteria.problem.versionConflict.error'],
      ['PACKAGE_STATE_INVALID', 409, 'bid.criteria.problem.packageState.error'],
      ['PROHIBITED_CRITERION', 422, 'bid.criteria.problem.prohibited.error'],
      ['RESOURCE_NOT_FOUND', 404, 'bid.criteria.problem.notFound.error'],
      ['SCOPE_DENIED', 403, 'bid.criteria.problem.denied.error'],
    ] as const)('says in words why the server refused the approval with %s', async (code, status, key) => {
      const h = client(world({ versions: [draft()] }), () => {
        throw problem(code, status, { criterion_code: 'C2' });
      });
      mount(<CriteriaScreen route={ROUTE} />, h, { permissions: APPROVER });
      await screen.findByTestId('versions');
      await userEvent.click(screen.getByRole('button', { name: vi_['bid.criteria.approve.action'] }));
      const refusal = await screen.findByTestId('approve-refusal');
      expect(refusal.textContent).toBe((vi_ as Record<string, string>)[key]?.replace('{code}', 'C2'));
      expect(screen.queryByTestId('approved')).toBeNull();
    });

    it('says the general sentence for a failure it has no sentence for', async () => {
      const h = client(world({ versions: [draft()] }), () => {
        throw new Error('offline');
      });
      mount(<CriteriaScreen route={ROUTE} />, h, { permissions: APPROVER });
      await screen.findByTestId('versions');
      await userEvent.click(screen.getByRole('button', { name: vi_['bid.criteria.approve.action'] }));
      expect((await screen.findByTestId('approve-refusal')).textContent).toBe(vi_['bid.criteria.problem.general.error']);
    });
  });

  describe('the editor', () => {
    it('names every empty field and sends nothing (UI-BID-04)', async () => {
      const h = client(world(), () => OK);
      mount(<CriteriaScreen route={ROUTE} />, h, { permissions: PLANNER });
      await form();
      await send();
      expect(screen.getAllByText(vi_['bid.criteria.field.required.error']).length).toBeGreaterThanOrEqual(4);
      expect(h.command).not.toHaveBeenCalled();
    });

    it('shows the running total of the weights while typing, refuses a total that is not 100 before sending, and sends the allowlisted body once it is (UI-BID-04, AC-ST-BID-003-1)', async () => {
      const h = client(world({ versions: [] }), () => OK);
      mount(<CriteriaScreen route={ROUTE} />, h, { permissions: PLANNER });
      await form();
      const total = () => screen.getByTestId('running-total');
      expect(total().textContent).toBe('Σ trọng số: 0 / 100');
      fireEvent.change(screen.getByLabelText(vi_['bid.criteria.form.basis.label']), { target: { value: ' Luật Đấu thầu 22/2023/QH15 ' } });
      fillRow(rows()[0] as HTMLElement, { code: 'C1', name: 'Kinh nghiệm thi công', weight: '60', threshold: '5', evidence: 'Hợp đồng tương tự\nBiên bản nghiệm thu' });
      expect(total().textContent).toBe('Σ trọng số: 60 / 100');
      await userEvent.click(screen.getByRole('button', { name: vi_['bid.criteria.row.add'] }));
      fillRow(rows()[1] as HTMLElement, { code: 'C2', name: 'Năng lực tài chính', weight: '30', scale: '20' });
      expect(total().textContent).toBe('Σ trọng số: 90 / 100');
      expect(total().getAttribute('data-complete')).toBe('false');
      await send();
      expect((await screen.findByTestId('rows-error')).textContent).toBe(vi_['bid.criteria.field.weightTotal.error'].replace('{total}', '100'));
      expect(h.command).not.toHaveBeenCalled();

      await userEvent.click(screen.getByRole('button', { name: vi_['bid.criteria.row.add'] }));
      const third = rows()[2] as HTMLElement;
      set(third, vi_['bid.criteria.row.kind'], 'PASS_FAIL');
      set(third, vi_['bid.criteria.row.code'], 'R1');
      set(third, vi_['bid.criteria.row.name'], 'Có giấy phép kinh doanh');
      expect(within(third).queryByLabelText(vi_['bid.criteria.row.weight'])).toBeNull();
      fireEvent.click(within_(third, vi_['bid.criteria.row.mandatory']));
      set(rows()[1] as HTMLElement, vi_['bid.criteria.row.weight'], '40');
      expect(total().textContent).toBe('Σ trọng số: 100 / 100');
      expect(total().getAttribute('data-complete')).toBe('true');
      await send();
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('createCriteriaVersion');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({
        body: {
          package_id: packageId(1),
          legal_basis: 'Luật Đấu thầu 22/2023/QH15',
          criteria_json: {
            criteria: [
              { code: 'C1', name: 'Kinh nghiệm thi công', kind: 'SCORED', weight: 60, max_score: 10, threshold: 5, mandatory: false, required_evidence: ['Hợp đồng tương tự', 'Biên bản nghiệm thu'] },
              { code: 'C2', name: 'Năng lực tài chính', kind: 'SCORED', weight: 40, max_score: 20, threshold: null, mandatory: false, required_evidence: [] },
              { code: 'R1', name: 'Có giấy phép kinh doanh', kind: 'PASS_FAIL', mandatory: true, required_evidence: [] },
            ],
          },
        },
      });
      expect((await screen.findByTestId('saved')).textContent).toBe(vi_['bid.criteria.form.saved.notice']);
      // The form starts over for the next revision.
      expect(rows()).toHaveLength(1);
      expect((within_(rows()[0] as HTMLElement, vi_['bid.criteria.row.code']) as HTMLInputElement).value).toBe('');
    });

    it('says there is no total to add up when no criterion is scored, and keeps one row, the limit of rows and removing a row', async () => {
      mount(<CriteriaScreen route={ROUTE} />, client(world({ versions: [] }), () => OK), { permissions: PLANNER });
      await form();
      expect((screen.getByRole('button', { name: vi_['bid.criteria.row.remove'] }) as HTMLButtonElement).disabled).toBe(true);
      await userEvent.click(screen.getByRole('button', { name: vi_['bid.criteria.row.add'] }));
      expect(rows()).toHaveLength(2);
      for (const row of rows()) set(row, vi_['bid.criteria.row.kind'], 'PASS_FAIL');
      expect(screen.getByTestId('running-total').textContent).toBe(vi_['bid.criteria.total.none.text']);
      await userEvent.click(screen.getAllByRole('button', { name: vi_['bid.criteria.row.remove'] })[0] as HTMLElement);
      expect(rows()).toHaveLength(1);
    });

    it('starts the next revision from the version shown, and says which draft it takes the place of', async () => {
      const draft = version(2, { status: 'DRAFT', approved_at: null, version: 1, criteria: [scored('X1', 100)] });
      mount(<CriteriaScreen route={ROUTE} />, client(world({ versions: [draft, version(1)] }), () => OK), { permissions: BOTH });
      await form();
      expect(screen.getByTestId('replaces-draft').textContent).toBe('Bản nháp 2 đang có sẽ được thay bằng bản mới này.');
      await userEvent.click(screen.getByRole('button', { name: 'Bắt đầu từ bản 1' }));
      expect(rows()).toHaveLength(5);
      expect((within_(rows()[0] as HTMLElement, vi_['bid.criteria.row.code']) as HTMLInputElement).value).toBe('C1');
      expect((within_(rows()[0] as HTMLElement, vi_['bid.criteria.row.weight']) as HTMLInputElement).value).toBe('40');
      expect((within_(rows()[0] as HTMLElement, vi_['bid.criteria.row.evidence']) as HTMLTextAreaElement).value).toBe('Báo cáo tài chính đã kiểm toán');
      expect((screen.getByLabelText(vi_['bid.criteria.form.basis.label']) as HTMLTextAreaElement).value).toBe('Luật Đấu thầu 22/2023/QH15');
      expect(screen.getByTestId('running-total').textContent).toBe('Σ trọng số: 100 / 100');
      expect((within_(rows()[4] as HTMLElement, vi_['bid.criteria.row.kind']) as HTMLSelectElement).value).toBe('PASS_FAIL');
    });

    it('says the criterion and the legal basis when the server refuses a criterion nobody may ask for (AC-ST-BID-003-3), and lets the planner correct it', async () => {
      let refuse = true;
      const h = client(world({ versions: [] }), () => {
        if (refuse) throw problem('PROHIBITED_CRITERION', 422, { criterion_code: 'C1', legal_basis: 'Luật Đấu thầu 22/2023/QH15 và Nghị định 214/2025/NĐ-CP' });
        return OK;
      });
      mount(<CriteriaScreen route={ROUTE} />, h, { permissions: PLANNER });
      await form();
      fireEvent.change(screen.getByLabelText(vi_['bid.criteria.form.basis.label']), { target: { value: 'Luật Đấu thầu' } });
      fillRow(rows()[0] as HTMLElement, { code: 'C1', name: 'Giám đốc là người địa phương', weight: '100' });
      await send();
      const refusal = await screen.findByTestId('create-refusal');
      expect(refusal.getAttribute('data-reason')).toBe('prohibited');
      expect(within(refusal).getByText('Tiêu chí C1 thuộc loại không được đặt ra cho nhà thầu. Bộ tiêu chí chưa được lưu.')).toBeTruthy();
      expect(within(refusal).getByText('Căn cứ pháp lý: Luật Đấu thầu 22/2023/QH15 và Nghị định 214/2025/NĐ-CP')).toBeTruthy();
      expect(screen.queryByTestId('saved')).toBeNull();
      refuse = false;
      set(rows()[0] as HTMLElement, vi_['bid.criteria.row.name'], 'Kinh nghiệm thi công');
      expect(screen.queryByTestId('create-refusal')).toBeNull();
      await send();
      expect(await screen.findByTestId('saved')).toBeTruthy();
    });

    it('says the sum the server counted when it refuses the weights', async () => {
      const h = client(world({ versions: [] }), () => {
        throw problem('CRITERIA_WEIGHT_INVALID', 422, { weights_sum: 90 });
      });
      mount(<CriteriaScreen route={ROUTE} />, h, { permissions: PLANNER });
      await form();
      fireEvent.change(screen.getByLabelText(vi_['bid.criteria.form.basis.label']), { target: { value: 'Luật Đấu thầu' } });
      fillRow(rows()[0] as HTMLElement, { code: 'C1', name: 'Kinh nghiệm thi công', weight: '100' });
      await send();
      expect((await screen.findByTestId('create-refusal')).textContent).toBe('Trọng số cộng được 90, phải đúng 100. Bộ tiêu chí chưa được lưu.');
    });

    it('names the field the server found wrong, and the general sentence for anything else', async () => {
      let failure: unknown = problem('VALIDATION_FAILED', 422, {}, 'criteria_json.criteria.0.weight');
      const h = client(world({ versions: [] }), () => {
        throw failure;
      });
      mount(<CriteriaScreen route={ROUTE} />, h, { permissions: PLANNER });
      await form();
      fireEvent.change(screen.getByLabelText(vi_['bid.criteria.form.basis.label']), { target: { value: 'Luật Đấu thầu' } });
      fillRow(rows()[0] as HTMLElement, { code: 'C1', name: 'Kinh nghiệm thi công', weight: '100' });
      await send();
      expect((await screen.findByTestId('create-refusal')).textContent).toBe('Số liệu chưa hợp lệ ở criteria_json.criteria.0.weight.');
      failure = problem('VALIDATION_FAILED');
      fireEvent.change(screen.getByLabelText(vi_['bid.criteria.form.basis.label']), { target: { value: 'Luật Đấu thầu 2023' } });
      await send();
      await waitFor(() => expect(screen.getByTestId('create-refusal').textContent).toBe(vi_['bid.criteria.problem.validation.error']));
      failure = new Error('offline');
      fireEvent.change(screen.getByLabelText(vi_['bid.criteria.form.basis.label']), { target: { value: 'Luật Đấu thầu 2024' } });
      await send();
      await waitFor(() => expect(screen.getByTestId('create-refusal').textContent).toBe(vi_['bid.criteria.problem.general.error']));
    });

    it('is not there for someone who may not draft criteria, nor in a read-only session', async () => {
      mount(<CriteriaScreen route={ROUTE} />, client(world()), { permissions: BOTH, mode: 'READ_ONLY' });
      await screen.findByTestId('versions');
      expect(screen.queryByTestId('criteria-form')).toBeNull();
      expect(screen.getByTestId('read-only')).toBeTruthy();
      cleanup();
      mount(<CriteriaScreen route={ROUTE} />, client(world()), { permissions: APPROVER });
      await screen.findByTestId('versions');
      expect(screen.queryByTestId('criteria-form')).toBeNull();
    });

    it('offers everything when the session carries no list of permissions (the server decides)', async () => {
      const draft = version(2, { status: 'DRAFT', approved_at: null, version: 1 });
      mount(<CriteriaScreen route={ROUTE} />, client(world({ versions: [draft] })), { permissions: undefined });
      expect(await form()).toBeTruthy();
      expect(screen.getByRole('button', { name: vi_['bid.criteria.approve.action'] })).toBeTruthy();
    });
  });
});
