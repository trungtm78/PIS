import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { PLATFORM_TENANT, harness, mount } from '../test-support';
import { OverridesPanel } from './OverridesPanel';

const TENANT = '00000000-0000-4000-8000-0000000000a1';
const ME = PLATFORM_TENANT.membershipId;
const OTHER = '00000000-0000-4000-8000-0000000000e8';
const MANAGER = ['system.tenant.read', 'system.billing.manage'];
const READER = ['system.tenant.read'];

const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  feature_code: 'ai.analysis',
  enabled: false,
  reason: 'Tạm dừng do vượt ngân sách AI',
  valid_from: '2026-10-26T00:00:00.000Z',
  valid_until: '2026-11-26T00:00:00.000Z',
  status: 'PendingApproval',
  requested_by: OTHER,
  version: 1,
  ...extra,
});

const answerWith = (items: unknown[], next: string | null = null) => (operation: string) => (operation === 'listTenantEntitlementOverrides' ? { items, next_cursor: next } : new Error('unexpected'));
const open = (items: unknown[], permissions: readonly string[] = MANAGER) => {
  const h = harness(answerWith(items));
  mount(<OverridesPanel tenantId={TENANT} canManage={permissions.includes('system.billing.manage')} membershipId={ME} />, h, permissions);
  return h;
};
const inRow = async (id: string): Promise<HTMLElement> => {
  await screen.findByRole('table');
  return document.querySelector(`tr[data-override-id="${id}"]`) as HTMLElement;
};
const later = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 16);

afterEach(cleanup);

describe('SAS-25 overrides (ST-SAS-009, UI-SAS-25)', () => {
  it('shows each override with its feature, its setting, its window, its state and who asked and who approved (AC-ST-SAS-009-3)', async () => {
    open([
      row('o1'),
      row('o2', { feature_code: 'member.seats', enabled: true, limit_value: '150.5', status: 'Active', requested_by: ME, approved_by: OTHER, version: 2 }),
      row('o3', { status: 'Rejected', version: 2 }),
    ]);
    const first = await inRow('o1');
    expect(within(first).getByText(vi_['sas.overrides.setting.off'])).toBeTruthy();
    expect(within(first).getByText(vi_['sas.overrides.status.pending'])).toBeTruthy();
    expect(within(first).getByText(vi_['sas.overrides.people.requested'].replace('{person}', OTHER.slice(0, 8)))).toBeTruthy();
    const second = await inRow('o2');
    expect(within(second).getByText(vi_['sas.overrides.setting.onLimit'].replace('{limit}', '150.5'))).toBeTruthy();
    expect(within(second).getByText(vi_['sas.overrides.status.active'])).toBeTruthy();
    expect(within(second).getByText(vi_['sas.overrides.people.requested'].replace('{person}', vi_['sas.overrides.people.you']))).toBeTruthy();
    expect(within(second).getByText(vi_['sas.overrides.people.approved'].replace('{person}', OTHER.slice(0, 8)))).toBeTruthy();
    expect(within(await inRow('o3')).getByText(vi_['sas.overrides.status.rejected'])).toBeTruthy();
  });

  it('says so when the tenant has no override, and keeps the request form', async () => {
    open([]);
    expect(await screen.findByText(vi_['sas.overrides.empty'])).toBeTruthy();
    expect(screen.getByRole('form', { name: vi_['sas.overrides.form.aria'] })).toBeTruthy();
  });

  it('offers a request of someone else to approve or reject, and the own request to nobody to decide (UAT-AC158)', async () => {
    open([row('o1'), row('o2', { requested_by: ME })]);
    const others = await inRow('o1');
    expect(within(others).getByRole('button', { name: vi_['sas.overrides.approve.action'] })).toBeTruthy();
    expect(within(others).getByRole('button', { name: vi_['sas.overrides.reject.action'] })).toBeTruthy();
    const own = await inRow('o2');
    expect(within(own).queryByRole('button', { name: vi_['sas.overrides.approve.action'] })).toBeNull();
    expect(within(own).queryByRole('button', { name: vi_['sas.overrides.reject.action'] })).toBeNull();
    expect(within(own).getByText(vi_['sas.overrides.self.notice'])).toBeTruthy();
    // The one who asked may still withdraw it.
    expect(within(own).getByRole('button', { name: vi_['sas.overrides.revoke.action'] })).toBeTruthy();
  });

  it('approves with a reason, against the version that was read, and reads the list again (UAT-AC157)', async () => {
    const user = userEvent.setup();
    let reads = 0;
    const h = harness((operation) => {
      reads += 1;
      return operation === 'listTenantEntitlementOverrides' ? { items: [row('o1', { version: 4 })], next_cursor: null } : new Error('unexpected');
    });
    mount(<OverridesPanel tenantId={TENANT} canManage membershipId={ME} />, h, MANAGER);
    await user.click(within(await inRow('o1')).getByRole('button', { name: vi_['sas.overrides.approve.action'] }));
    const form = screen.getByRole('form', { name: vi_['sas.overrides.decision.aria'] });
    // A reason is needed.
    await user.click(within(form).getByRole('button', { name: vi_['sas.overrides.decision.confirm.approve'] }));
    expect(within(form).getByText(vi_['sas.overrides.fieldError.reasonLength'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.type(within(form).getByLabelText(vi_['sas.overrides.decision.reason']), 'Đã kiểm tra ngân sách AI');
    await user.click(within(form).getByRole('button', { name: vi_['sas.overrides.decision.confirm.approve'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith('decideEntitlementOverride', expect.objectContaining({ path: { overrideId: 'o1' }, ifMatchVersion: 4, body: { decision: 'approve', reason: 'Đã kiểm tra ngân sách AI', evidence_ids: [] } }));
    expect(await screen.findByText(vi_['sas.overrides.done.approved'])).toBeTruthy();
    expect(screen.queryByRole('form', { name: vi_['sas.overrides.decision.aria'] })).toBeNull();
    await waitFor(() => expect(reads).toBeGreaterThan(1));
  });

  it('rejects a request and revokes an override in force', async () => {
    const user = userEvent.setup();
    const h = open([row('o1'), row('o2', { status: 'Active', approved_by: OTHER, version: 3 })]);
    await user.click(within(await inRow('o1')).getByRole('button', { name: vi_['sas.overrides.reject.action'] }));
    await user.type(screen.getByLabelText(vi_['sas.overrides.decision.reason']), 'Không đủ căn cứ để ghi đè');
    await user.click(screen.getByRole('button', { name: vi_['sas.overrides.decision.confirm.reject'] }));
    expect(await screen.findByText(vi_['sas.overrides.done.rejected'])).toBeTruthy();
    expect(h.command).toHaveBeenLastCalledWith('decideEntitlementOverride', expect.objectContaining({ body: expect.objectContaining({ decision: 'reject' }) }));

    await user.click(within(await inRow('o2')).getByRole('button', { name: vi_['sas.overrides.revoke.action'] }));
    await user.type(screen.getByLabelText(vi_['sas.overrides.decision.reason']), 'Hết nhu cầu ghi đè này');
    await user.click(screen.getByRole('button', { name: vi_['sas.overrides.decision.confirm.revoke'] }));
    expect(await screen.findByText(vi_['sas.overrides.done.revoked'])).toBeTruthy();
    expect(h.command).toHaveBeenLastCalledWith('revokeEntitlementOverride', expect.objectContaining({ path: { overrideId: 'o2' }, ifMatchVersion: 3, body: { reason: 'Hết nhu cầu ghi đè này' } }));
  });

  it('lets the person change their mind before confirming', async () => {
    const user = userEvent.setup();
    const h = open([row('o1')]);
    await user.click(within(await inRow('o1')).getByRole('button', { name: vi_['sas.overrides.approve.action'] }));
    await user.click(screen.getByRole('button', { name: vi_['sas.overrides.decision.cancel.action'] }));
    expect(screen.queryByRole('form', { name: vi_['sas.overrides.decision.aria'] })).toBeNull();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('tells the person when the server refuses a decision, in the words of the refusal, and drops the decision form', async () => {
    const user = userEvent.setup();
    const cases: Array<[string, string]> = [
      ['SELF_APPROVAL_DENIED', 'sas.overrides.problem.selfApproval'],
      ['VERSION_CONFLICT', 'sas.overrides.problem.conflict'],
      ['STAGE_TRANSITION_DENIED', 'sas.overrides.problem.stageDenied'],
    ];
    for (const [code, key] of cases) {
      const h = harness(answerWith([row('o1')]), () => new ApiError({ status: 409, code, correlationId: 'c' }));
      mount(<OverridesPanel tenantId={TENANT} canManage membershipId={ME} />, h, MANAGER);
      await user.click(within(await inRow('o1')).getByRole('button', { name: vi_['sas.overrides.approve.action'] }));
      await user.type(screen.getByLabelText(vi_['sas.overrides.decision.reason']), 'Đã kiểm tra ngân sách AI');
      await user.click(screen.getByRole('button', { name: vi_['sas.overrides.decision.confirm.approve'] }));
      expect(await screen.findByText(vi_[key as keyof typeof vi_])).toBeTruthy();
      expect(screen.queryByRole('form', { name: vi_['sas.overrides.decision.aria'] })).toBeNull();
      cleanup();
    }
  });

  it('asks for an override: validates first, then sends the request and clears the form', async () => {
    const user = userEvent.setup();
    const h = open([]);
    const form = await screen.findByRole('form', { name: vi_['sas.overrides.form.aria'] });
    await user.click(within(form).getByRole('button', { name: vi_['sas.overrides.request.action'] }));
    expect(within(form).getAllByRole('alert').length).toBeGreaterThanOrEqual(3);
    expect(h.command).not.toHaveBeenCalled();

    await user.selectOptions(within(form).getByLabelText(vi_['sas.overrides.field.feature']), 'ai.analysis');
    fireEvent.change(within(form).getByLabelText(vi_['sas.overrides.field.from']), { target: { value: later(1) } });
    fireEvent.change(within(form).getByLabelText(vi_['sas.overrides.field.until']), { target: { value: later(30) } });
    await user.type(within(form).getByLabelText(vi_['sas.overrides.field.reason']), 'Tạm dừng do vượt ngân sách AI');
    await user.click(within(form).getByRole('button', { name: vi_['sas.overrides.request.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith(
      'requestEntitlementOverride',
      expect.objectContaining({ path: { tenantId: TENANT }, body: expect.objectContaining({ feature_code: 'ai.analysis', enabled: false, reason: 'Tạm dừng do vượt ngân sách AI' }) }),
    );
    expect(await screen.findByText(vi_['sas.overrides.done.requested'])).toBeTruthy();
    expect((within(screen.getByRole('form', { name: vi_['sas.overrides.form.aria'] })).getByLabelText(vi_['sas.overrides.field.reason']) as HTMLTextAreaElement).value).toBe('');
  });

  it('sends a limit with a feature that is on, and refuses a limit with one that is off', async () => {
    const user = userEvent.setup();
    const h = open([]);
    const form = await screen.findByRole('form', { name: vi_['sas.overrides.form.aria'] });
    await user.selectOptions(within(form).getByLabelText(vi_['sas.overrides.field.feature']), 'member.seats');
    await user.type(within(form).getByLabelText(vi_['sas.overrides.field.limit']), '150');
    fireEvent.change(within(form).getByLabelText(vi_['sas.overrides.field.from']), { target: { value: later(1) } });
    fireEvent.change(within(form).getByLabelText(vi_['sas.overrides.field.until']), { target: { value: later(30) } });
    await user.type(within(form).getByLabelText(vi_['sas.overrides.field.reason']), 'Thêm chỗ cho đợt tuyển dụng');
    await user.click(within(form).getByRole('button', { name: vi_['sas.overrides.request.action'] }));
    expect(within(form).getByText(vi_['sas.overrides.fieldError.limitNeedsEnabled'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.click(within(form).getByLabelText(vi_['sas.overrides.field.enabled']));
    await user.click(within(form).getByRole('button', { name: vi_['sas.overrides.request.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith('requestEntitlementOverride', expect.objectContaining({ body: expect.objectContaining({ feature_code: 'member.seats', enabled: true, limit_value: '150' }) }));
  });

  it('shows the refusal of a request that the client could not foresee', async () => {
    const user = userEvent.setup();
    const h = harness(answerWith([]), () => new ApiError({ status: 422, code: 'FEATURE_UNKNOWN', correlationId: 'c', detail: 'feature_code' }));
    mount(<OverridesPanel tenantId={TENANT} canManage membershipId={ME} />, h, MANAGER);
    const form = await screen.findByRole('form', { name: vi_['sas.overrides.form.aria'] });
    await user.selectOptions(within(form).getByLabelText(vi_['sas.overrides.field.feature']), 'reporting');
    fireEvent.change(within(form).getByLabelText(vi_['sas.overrides.field.from']), { target: { value: later(1) } });
    fireEvent.change(within(form).getByLabelText(vi_['sas.overrides.field.until']), { target: { value: later(30) } });
    await user.type(within(form).getByLabelText(vi_['sas.overrides.field.reason']), 'Tạm dừng báo cáo để kiểm tra');
    await user.click(within(form).getByRole('button', { name: vi_['sas.overrides.request.action'] }));
    expect(await screen.findByText(vi_['sas.overrides.problem.featureUnknown'])).toBeTruthy();
  });

  it('only shows the overrides to a reader who may not manage them: no form, no actions', async () => {
    open([row('o1')], READER);
    const first = await inRow('o1');
    expect(within(first).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('form', { name: vi_['sas.overrides.form.aria'] })).toBeNull();
    expect(screen.getByText(vi_['sas.overrides.form.denied'])).toBeTruthy();
    expect(screen.queryByText(vi_['sas.overrides.col.actions'])).toBeNull();
  });

  it('loads further pages on request', async () => {
    const user = userEvent.setup();
    const h = harness((operation, input) => {
      if (operation !== 'listTenantEntitlementOverrides') return new Error('unexpected');
      const cursor = (input as { query?: { cursor?: string } }).query?.cursor;
      return cursor === undefined ? { items: [row('o1')], next_cursor: 'c1' } : { items: [row('o2')], next_cursor: null };
    });
    mount(<OverridesPanel tenantId={TENANT} canManage membershipId={ME} />, h, MANAGER);
    await inRow('o1');
    expect(document.querySelector('tr[data-override-id="o2"]')).toBeNull();
    await user.click(screen.getByRole('button', { name: vi_['sas.overrides.more.action'] }));
    expect(await inRow('o2')).toBeTruthy();
    expect(screen.queryByRole('button', { name: vi_['sas.overrides.more.action'] })).toBeNull();
  });

  it('shows the loading, signed-out, denied, offline and error states of the list while the request form stays', async () => {
    const failing = [
      [401, 'SESSION_EXPIRED', 'states.signedOut.title'],
      [403, 'SCOPE_DENIED', 'states.denied.title'],
      [0, NETWORK_ERROR_CODE, 'states.offline.title'],
      [500, 'INTERNAL_ERROR', 'states.error.title'],
    ] as const;
    mount(<OverridesPanel tenantId={TENANT} canManage membershipId={ME} />, harness(answerWith([])), MANAGER);
    expect(screen.getByRole('status')).toBeTruthy();
    await screen.findByText(vi_['sas.overrides.empty']);
    cleanup();
    for (const [status, code, key] of failing) {
      mount(<OverridesPanel tenantId={TENANT} canManage membershipId={ME} />, harness(() => new ApiError({ status, code, correlationId: 'c' })), MANAGER);
      expect(await screen.findByText(vi_[key as keyof typeof vi_])).toBeTruthy();
      expect(screen.getByRole('form', { name: vi_['sas.overrides.form.aria'] })).toBeTruthy();
      cleanup();
    }
  });

  it('retries the list from the error state', async () => {
    const user = userEvent.setup();
    let reads = 0;
    const h = harness(() => {
      reads += 1;
      return reads === 1 ? new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }) : { items: [row('o1')], next_cursor: null };
    });
    mount(<OverridesPanel tenantId={TENANT} canManage membershipId={ME} />, h, MANAGER);
    await screen.findByText(vi_['states.error.title']);
    await user.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    expect(await inRow('o1')).toBeTruthy();
  });

  it('reads nothing until a tenant is chosen', async () => {
    const h = harness(answerWith([]));
    mount(<OverridesPanel tenantId={undefined} canManage membershipId={ME} />, h, MANAGER);
    await screen.findByRole('form', { name: vi_['sas.overrides.form.aria'] });
    expect(h.read).not.toHaveBeenCalled();
    expect(within(screen.getByRole('form', { name: vi_['sas.overrides.form.aria'] })).getByRole('button', { name: vi_['sas.overrides.request.action'] }).hasAttribute('disabled')).toBe(true);
  });
});
