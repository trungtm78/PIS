import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { harness } from '../sas/test-support';
import AvcPolicyScreen from './AvcPolicyScreen';
import { ME, OTHER, mount, routeOf } from './test-support';

const ROUTE = routeOf('CAP-17', 'FR-CAP-17');
const ADMIN = ['capital.read', 'capital.avc.manage', 'organization_unit.read'];
const APPROVER = ['capital.read', 'capital.avc.approve'];
const BOTH = ['capital.read', 'capital.avc.manage', 'capital.avc.approve'];
const READER = ['capital.read', 'organization_unit.read'];
const UNIT = '00000000-0000-4000-8000-0000000000a1';
const problem = (code: string, status = 422, detail?: string) => new ApiError({ status, code, correlationId: 'c', ...(detail === undefined ? {} : { detail }), extensions: {} });

const policy = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  policy_code: `AVC-${n}`,
  revision: 1,
  scope_kind: 'TENANT',
  scope_ref_id: null,
  scope_value: null,
  control_object: 'ALLOCATION_LINE',
  warn_pct: '90.00',
  block_pct: '100.00',
  include_reservations: true,
  legal_basis: 'Quyết định 12/QĐ-UBND',
  effective_from: '2026-01-01',
  effective_until: null,
  status: 'PUBLISHED',
  approved_by: OTHER,
  created_by: OTHER,
  created_at: '2026-01-01T00:00:00Z',
  version: 2,
  ...overrides,
});

interface State {
  policies: Array<Record<string, unknown>>;
  preview: Record<string, unknown> | Error;
  failing: Map<string, unknown>;
}

const state = (overrides: Partial<State> = {}): State => ({
  policies: [
    policy(3, { status: 'DRAFT', created_by: OTHER, version: 1, revision: 2, scope_kind: 'UNIT', scope_ref_id: UNIT, warn_pct: '80.00', block_pct: '95.00', control_object: 'APPROPRIATION', include_reservations: false, approved_by: null }),
    policy(2, { scope_kind: 'FUND_SOURCE', scope_value: 'NSTW-DTPT', effective_until: '2026-12-31' }),
    policy(1, { scope_kind: 'PROJECT_GROUP', scope_value: 'A' }),
  ],
  preview: { policy_id: policy(3).id, control_object: 'ALLOCATION_LINE', total: 7, ok: 4, warn: 2, block: 1, as_of: '2026-10-25T00:00:00Z' },
  failing: new Map(),
  ...overrides,
});

function client(current: State, command: (operation: string, input: unknown) => unknown = () => ({})) {
  const h = harness((operation) => {
    if (current.failing.has(operation)) return current.failing.get(operation) as Error;
    if (operation === 'previewAvcPolicy') return current.preview;
    return new Error(`unexpected read ${operation}`);
  }, command);
  (h.client as unknown as { readAll: (operation: string) => Promise<unknown[]> }).readAll = vi.fn((operation: string) => {
    if (current.failing.has(operation)) return Promise.reject(current.failing.get(operation));
    switch (operation) {
      case 'listAvcPolicies':
        return Promise.resolve(current.policies);
      case 'get_resources_organization_unit':
        return Promise.resolve([{ id: UNIT, code: 'BQL1', name: 'Ban quản lý 1' }]);
      case 'searchMasterRecords':
        return Promise.resolve([{ version_id: 'f1', business_key: 'NSTW-DTPT', label: 'Ngân sách trung ương', status: 'EFFECTIVE', attributes: { category: 'NSTW', relation: 'ADDITIVE' } }]);
      default:
        return Promise.reject(new Error(`unexpected readAll ${operation}`));
    }
  });
  return h;
}

afterEach(cleanup);

const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('tr[data-policy-id]'));
const ready = () => waitFor(() => expect(rows().length).toBeGreaterThan(0));
const form = () => within(screen.getByRole('form', { name: vi_['cap.avc.form.aria'] }));
const set = (label: string, value: string): void => {
  fireEvent.change(form().getByLabelText(label), { target: { value } });
};
const fillValid = (): void => {
  set(vi_['cap.avc.form.code.label'], 'AVC-NEW');
  set(vi_['cap.avc.form.basis.label'], 'Quyết định 99/QĐ-UBND');
  set(vi_['cap.avc.form.from.label'], '2027-01-01');
};
const cellText = (row: HTMLElement | undefined, index: number): string => row?.querySelectorAll('td')[index]?.textContent ?? '';

describe('AvcPolicyScreen (CAP-17): the availability control policy', () => {
  it('lists the versions with their scope, object, thresholds in words, period and state, and previews the newest (UI-CAP-17, AC-ST-CAP-005-3)', async () => {
    mount(<AvcPolicyScreen route={ROUTE} />, client(state()), { permissions: READER });
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['cap.avc.page.title']);
    const [draft, fund, group] = rows();
    expect(cellText(draft, 0)).toBe(vi_['cap.avc.row.code'].replace('{code}', 'AVC-3').replace('{revision}', '2'));
    expect(cellText(draft, 1)).toBe(vi_['cap.avc.scope.unit'].replace('{value}', 'Ban quản lý 1'));
    expect(cellText(draft, 2)).toBe(vi_['cap.avc.object.appropriation']);
    expect(cellText(draft, 3)).toContain(vi_['cap.avc.thresholds.text'].replace('{warn}', '80.00').replace('{block}', '95.00'));
    expect(cellText(draft, 3)).toContain(vi_['cap.avc.reservations.apart']);
    expect(cellText(draft, 4)).toBe(vi_['cap.avc.period.open'].replace('{from}', '2026-01-01'));
    expect(cellText(draft, 5)).toBe(vi_['cap.avc.status.draft']);
    expect(cellText(fund, 1)).toBe(vi_['cap.avc.scope.fund'].replace('{value}', 'NSTW-DTPT'));
    expect(cellText(fund, 3)).toContain(vi_['cap.avc.reservations.counted']);
    expect(cellText(fund, 4)).toBe(vi_['cap.avc.period.closed'].replace('{from}', '2026-01-01').replace('{until}', '2026-12-31'));
    expect(cellText(group, 1)).toBe(vi_['cap.avc.scope.group'].replace('{value}', 'A'));
    expect(cellText(group, 5)).toBe(vi_['cap.avc.status.published']);
    // A reader sees the policies and the counts, and has no form.
    expect(screen.queryByRole('form', { name: vi_['cap.avc.form.aria'] })).toBeNull();
    expect(screen.getByText(vi_['cap.avc.form.denied'])).toBeTruthy();
    // The preview of the first policy says in words how many lines are in each state, not by colour alone.
    await waitFor(() => expect(screen.getByTestId('preview').querySelector('[data-state="block"]')).not.toBeNull());
    const preview = screen.getByTestId('preview');
    expect(preview.querySelector('[data-state="total"]')?.textContent).toBe(vi_['cap.avc.preview.total'].replace('{count}', '7').replace('{counted}', vi_['cap.avc.preview.counted.line']));
    expect(preview.querySelector('[data-state="ok"]')?.textContent).toBe(vi_['cap.avc.preview.ok'].replace('{count}', '4'));
    expect(preview.querySelector('[data-state="warn"]')?.textContent).toBe(vi_['cap.avc.preview.warn'].replace('{count}', '2'));
    expect(preview.querySelector('[data-state="block"]')?.textContent).toBe(vi_['cap.avc.preview.block'].replace('{count}', '1'));
  });

  it('previews the policy chosen from the list or from the picker, and says what an appropriation preview counts', async () => {
    const h = client(state());
    mount(<AvcPolicyScreen route={ROUTE} />, h, { permissions: READER });
    await ready();
    fireEvent.click(within(rows()[1] as HTMLElement).getByRole('button', { name: vi_['cap.avc.row.preview.action'] }));
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('previewAvcPolicy', { path: { id: policy(2).id } }));
    fireEvent.change(screen.getByLabelText(vi_['cap.avc.preview.select.label']), { target: { value: policy(1).id } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('previewAvcPolicy', { path: { id: policy(1).id } }));
  });

  it('names the counted object of an appropriation policy, and says the count is for the authority of the tenant when it is refused', async () => {
    const appropriation = state({ preview: { policy_id: policy(3).id, control_object: 'APPROPRIATION', total: 2, ok: 2, warn: 0, block: 0 } });
    mount(<AvcPolicyScreen route={ROUTE} />, client(appropriation), { permissions: READER });
    await waitFor(() => expect(screen.getByTestId('preview').textContent).toContain(vi_['cap.avc.preview.counted.appropriation']));
    cleanup();
    mount(<AvcPolicyScreen route={ROUTE} />, client(state({ preview: problem('SCOPE_DENIED', 403) })), { permissions: READER });
    expect(await screen.findByText(vi_['cap.avc.preview.denied'])).toBeTruthy();
  });

  it('says there is no policy to preview when none exists, and the empty state for a reader', async () => {
    mount(<AvcPolicyScreen route={ROUTE} />, client(state({ policies: [] })), { permissions: ADMIN });
    expect(await screen.findByText(vi_['cap.avc.preview.none'])).toBeTruthy();
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    expect(screen.getByRole('form', { name: vi_['cap.avc.form.aria'] })).toBeTruthy();
  });

  it('says the policies could not be read and reads them again on request', async () => {
    const current = state({ failing: new Map([['listAvcPolicies', new ApiError({ status: 503, code: 'UNAVAILABLE', correlationId: 'c' })]]) });
    mount(<AvcPolicyScreen route={ROUTE} />, client(current), { permissions: READER });
    fireEvent.click(await screen.findByRole('button', { name: vi_['states.retry.action'] }));
    current.failing.clear();
    fireEvent.click(await screen.findByRole('button', { name: vi_['states.retry.action'] }).catch(() => screen.getByRole('button', { name: vi_['states.retry.action'] })));
    await ready();
  });

  describe('drafting a policy (AC-ST-CAP-005-2)', () => {
    it('draws the two thresholds as bars with their percentages in words, and refuses a warning above the block, a block above 100 and what is not a percentage before sending', async () => {
      const h = client(state());
      mount(<AvcPolicyScreen route={ROUTE} />, h, { permissions: ADMIN });
      await ready();
      expect(screen.getByRole('img', { name: vi_['cap.avc.bars.aria'].replace('{warn}', '90').replace('{block}', '100') })).toBeTruthy();
      expect(screen.getByText(vi_['cap.avc.bars.warn'].replace('{warn}', '90').replace('{block}', '100'))).toBeTruthy();
      fillValid();
      set(vi_['cap.avc.form.warn.label'], '95');
      set(vi_['cap.avc.form.block.label'], '90');
      expect(screen.getByText(vi_['cap.avc.bars.ok'].replace('{warn}', '95'))).toBeTruthy();
      fireEvent.click(form().getByRole('button', { name: vi_['cap.avc.form.submit.action'] }));
      expect(within(screen.getByRole('form', { name: vi_['cap.avc.form.aria'] })).getByText(vi_['cap.avc.field.warnAboveBlock'])).toBeTruthy();
      set(vi_['cap.avc.form.warn.label'], '90');
      set(vi_['cap.avc.form.block.label'], '101');
      expect(form().getByText(vi_['cap.avc.field.above100'])).toBeTruthy();
      set(vi_['cap.avc.form.warn.label'], 'abc');
      expect(form().getByText(vi_['cap.avc.field.notPercentage'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
    });

    it('sends the draft with the thresholds as typed and says it must be published by another person', async () => {
      const h = client(state(), () => ({ operation_id: 'o', status: 'DRAFT', resource_version: 1, resource_id: policy(9).id, policy_code: 'AVC-NEW', revision: 1 }));
      mount(<AvcPolicyScreen route={ROUTE} />, h, { permissions: ADMIN });
      await ready();
      fillValid();
      set(vi_['cap.avc.form.warn.label'], '85.5');
      fireEvent.click(form().getByLabelText(vi_['cap.avc.form.reservations.label']));
      fireEvent.click(form().getByRole('button', { name: vi_['cap.avc.form.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('createAvcPolicyVersion');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({
        body: { policy_code: 'AVC-NEW', scope_kind: 'TENANT', control_object: 'ALLOCATION_LINE', warn_pct: '85.5', block_pct: '100', include_reservations: false, legal_basis: 'Quyết định 99/QĐ-UBND', effective_from: '2027-01-01' },
      });
      expect(await screen.findByText(vi_['cap.avc.done.created'].replace('{code}', 'AVC-NEW').replace('{revision}', '1'))).toBeTruthy();
      expect((form().getByLabelText(vi_['cap.avc.form.code.label']) as HTMLInputElement).value).toBe('');
    });

    it('asks for the unit, the fund source or the project group the scope names, and sends it', async () => {
      const h = client(state(), () => ({ operation_id: 'o', status: 'DRAFT', resource_version: 1, resource_id: policy(9).id }));
      mount(<AvcPolicyScreen route={ROUTE} />, h, { permissions: ADMIN });
      await ready();
      fillValid();
      set(vi_['cap.avc.form.scopeKind.label'], 'UNIT');
      fireEvent.click(form().getByRole('button', { name: vi_['cap.avc.form.submit.action'] }));
      expect(form().getByText(vi_['cap.avc.field.required'])).toBeTruthy();
      await waitFor(() => expect(form().getByLabelText(vi_['cap.avc.form.scopeUnit.label']).querySelectorAll('option').length).toBe(2));
      set(vi_['cap.avc.form.scopeUnit.label'], UNIT);
      fireEvent.click(form().getByRole('button', { name: vi_['cap.avc.form.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { scope_kind: 'UNIT', scope_ref_id: UNIT } });
      expect(await screen.findByText(vi_['cap.avc.done.created'].replace('{code}', 'AVC-NEW').replace('{revision}', '1'))).toBeTruthy();

      fillValid();
      set(vi_['cap.avc.form.scopeKind.label'], 'FUND_SOURCE');
      await waitFor(() => expect(form().getByLabelText(vi_['cap.avc.form.scopeFund.label']).querySelectorAll('option').length).toBe(2));
      set(vi_['cap.avc.form.scopeFund.label'], 'NSTW-DTPT');
      fireEvent.click(form().getByRole('button', { name: vi_['cap.avc.form.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
      expect(h.command.mock.calls[1]?.[1]).toMatchObject({ body: { scope_kind: 'FUND_SOURCE', scope_value: 'NSTW-DTPT' } });

      fillValid();
      set(vi_['cap.avc.form.scopeKind.label'], 'PROJECT_GROUP');
      set(vi_['cap.avc.form.scopeGroup.label'], 'QTQG');
      fireEvent.click(form().getByRole('button', { name: vi_['cap.avc.form.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(3));
      expect(h.command.mock.calls[2]?.[1]).toMatchObject({ body: { scope_kind: 'PROJECT_GROUP', scope_value: 'QTQG' } });
    });

    it('starts the next revision from a policy of the list: the same code, scope and object, and clears the form on request', async () => {
      mount(<AvcPolicyScreen route={ROUTE} />, client(state()), { permissions: ADMIN });
      await ready();
      fireEvent.click(within(rows()[1] as HTMLElement).getByRole('button', { name: vi_['cap.avc.row.revise.action'] }));
      expect((form().getByLabelText(vi_['cap.avc.form.code.label']) as HTMLInputElement).value).toBe('AVC-2');
      expect((form().getByLabelText(vi_['cap.avc.form.scopeKind.label']) as HTMLSelectElement).value).toBe('FUND_SOURCE');
      expect((form().getByLabelText(vi_['cap.avc.form.from.label']) as HTMLInputElement).value).toBe('');
      fireEvent.click(form().getByRole('button', { name: vi_['cap.avc.form.reset.action'] }));
      expect((form().getByLabelText(vi_['cap.avc.form.code.label']) as HTMLInputElement).value).toBe('');
    });

    it.each([
      ['AVC_THRESHOLD_INVALID', 422, 'cap.avc.problem.threshold'],
      ['VALIDATION_FAILED', 422, 'cap.avc.problem.invalid'],
      ['SCOPE_DENIED', 403, 'cap.avc.problem.denied'],
      ['SESSION_EXPIRED', 401, 'cap.avc.problem.session'],
      ['SOMETHING_ELSE', 500, 'cap.avc.problem.general'],
    ] as const)('says in words why the server refused the draft: %s', async (code, status, key) => {
      mount(<AvcPolicyScreen route={ROUTE} />, client(state(), () => problem(code, status)), { permissions: ADMIN });
      await ready();
      fillValid();
      fireEvent.click(form().getByRole('button', { name: vi_['cap.avc.form.submit.action'] }));
      expect((await screen.findByRole('alert')).textContent).toContain(vi_[key]);
    });

    it('shows no form to someone without the right, and nothing at all in a suspended tenant', async () => {
      mount(<AvcPolicyScreen route={ROUTE} />, client(state()), { permissions: APPROVER });
      await ready();
      expect(screen.getByText(vi_['cap.avc.form.denied'])).toBeTruthy();
      expect(screen.queryByRole('button', { name: vi_['cap.avc.row.revise.action'] })).toBeNull();
      cleanup();
      mount(<AvcPolicyScreen route={ROUTE} />, client(state()), { permissions: BOTH, mode: 'READ_ONLY' });
      await ready();
      expect(screen.getByText(vi_['cap.avc.frozen.notice'])).toBeTruthy();
      expect(screen.queryByRole('button', { name: vi_['cap.avc.row.publish.action'] })).toBeNull();
    });

    it('does not send twice while the first draft is on its way', async () => {
      let release: (value: unknown) => void = () => undefined;
      const h = client(state());
      h.command.mockImplementation(() => new Promise((resolve) => (release = resolve)));
      mount(<AvcPolicyScreen route={ROUTE} />, h, { permissions: ADMIN });
      await ready();
      fillValid();
      const submit = form().getByRole('button', { name: vi_['cap.avc.form.submit.action'] }) as HTMLButtonElement;
      fireEvent.click(submit);
      await waitFor(() => expect(submit.disabled).toBe(true));
      fireEvent.click(submit);
      expect(h.command).toHaveBeenCalledTimes(1);
      release({ operation_id: 'o', status: 'DRAFT', resource_version: 1, resource_id: policy(9).id });
    });
  });

  describe('publishing (AC-ST-CAP-005-2)', () => {
    it('offers the draft of someone else to a person who holds the right, and publishes it with the version that was read', async () => {
      const h = client(state(), () => ({ operation_id: 'o', status: 'PUBLISHED', resource_version: 2, resource_id: policy(3).id }));
      mount(<AvcPolicyScreen route={ROUTE} />, h, { permissions: APPROVER });
      await ready();
      expect(screen.getAllByRole('button', { name: vi_['cap.avc.row.publish.action'] })).toHaveLength(1);
      fireEvent.click(within(rows()[0] as HTMLElement).getByRole('button', { name: vi_['cap.avc.row.publish.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('publishAvcPolicy');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: policy(3).id }, ifMatchVersion: 1 });
      expect(await screen.findByText(vi_['cap.avc.done.published'].replace('{code}', 'AVC-3').replace('{revision}', '2'))).toBeTruthy();
    });

    it('does not offer a person their own draft, and a policy that is already published', async () => {
      const own = state({ policies: [policy(3, { status: 'DRAFT', created_by: ME, version: 1, approved_by: null }), policy(1)] });
      mount(<AvcPolicyScreen route={ROUTE} />, client(own), { permissions: BOTH });
      await ready();
      expect(screen.queryByRole('button', { name: vi_['cap.avc.row.publish.action'] })).toBeNull();
    });

    it.each([
      ['SELF_APPROVAL_DENIED', 403, 'cap.avc.problem.selfApproval'],
      ['AVC_POLICY_STATE_INVALID', 409, 'cap.avc.problem.state'],
      ['AVC_POLICY_OVERLAP', 409, 'cap.avc.problem.overlap'],
      ['VERSION_CONFLICT', 409, 'cap.avc.problem.conflict'],
      ['RESOURCE_NOT_FOUND', 404, 'cap.avc.problem.notFound'],
    ] as const)('says in words why the publication was refused: %s', async (code, status, key) => {
      mount(<AvcPolicyScreen route={ROUTE} />, client(state(), () => problem(code, status)), { permissions: APPROVER });
      await ready();
      fireEvent.click(screen.getByRole('button', { name: vi_['cap.avc.row.publish.action'] }));
      expect((await screen.findByRole('alert')).textContent).toContain(vi_[key]);
    });
  });
});
