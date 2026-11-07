import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t as translate } from '../../../i18n';
import DefinitionScreen from './DefinitionScreen';
import { ME, SOMEONE, client, mount, route, world } from './test-support';
import type { World } from './test-support';

const ROUTE = route('BID-31', 'FR-BID-31');
const text = (key: string, params: Record<string, string | number> = {}): string => translate(key, params);
const READER = ['adm.governance.read'];
const MANAGER = ['adm.governance.read', 'adm.governance.manage'];
const APPROVER = ['adm.governance.read', 'adm.governance.approve'];
const OK = { operation_id: 'o', status: 'DRAFT', resource_version: 1 };
const version = (n: number, over: Record<string, unknown> = {}) => ({ id: `00000000-0000-4000-8000-0070000000${n}0`.slice(0, 36), version: n, status: 'SUBMITTED', params: {}, effective_from: '2026-12-01', effective_to: null, reason: 'Tăng thời hạn thẩm định', created_by: SOMEONE, submitted_by: SOMEONE, approved_by: null, resource_version: 2, ...over });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World, permissions: readonly string[] = READER, command: (operation: string, input: unknown) => unknown = () => OK, mode?: 'FULL' | 'READ_ONLY') {
  const h = client(state, command);
  mount(<DefinitionScreen route={ROUTE} />, h, { permissions, path: '/bid/bid-31', ...(mode === undefined ? {} : { mode }) });
  return h;
}

describe('DefinitionScreen (BID-31): the workflow definitions', () => {
  it('shows the steps of the method with their roles, days, evidence and checklist, with the provenance of the default and its flag', async () => {
    const h = open(world());
    expect(await screen.findByRole('list', { name: text('prc1.def.steps.label') })).toBeInTheDocument();
    expect(h.read).toHaveBeenCalledWith('getEffectiveGovernanceRule', { query: { rule_type: 'PROCUREMENT_WORKFLOW', code: 'OPEN_BIDDING' } });
    expect(screen.getByText('1. Lập kế hoạch lựa chọn nhà thầu')).toBeInTheDocument();
    expect(screen.getAllByText('PROCUREMENT_OFFICER · chuẩn 10 ngày làm việc').length).toBeGreaterThan(0);
    expect(screen.getAllByText(text('prc1.def.makerChecker.name')).length).toBeGreaterThan(0);
    expect(screen.getByText(text('prc1.def.unverified.name'))).toBeInTheDocument();
    expect(screen.getByText('Luật Đấu thầu 22/2023/QH15')).toBeInTheDocument();
    expect(screen.getByText(text('prc1.audit.definition.default'))).toBeInTheDocument();
    expect(screen.getByTestId('no-versions')).toBeInTheDocument();
  });

  it('shows another method when its tab is chosen', async () => {
    const h = open(world());
    await screen.findByRole('list', { name: text('prc1.def.steps.label') });
    await userEvent.click(screen.getByRole('tab', { name: text('prc1.method.directPurchase.name') }));
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('getEffectiveGovernanceRule', { query: { rule_type: 'PROCUREMENT_WORKFLOW', code: 'DIRECT_PURCHASE' } }));
  });

  it('offers no editor to a reader, and none in read-only mode', async () => {
    open(world());
    await screen.findByRole('list', { name: text('prc1.def.steps.label') });
    expect(screen.queryByRole('button', { name: text('prc1.def.edit.action') })).not.toBeInTheDocument();
    cleanup();
    open(world(), MANAGER, () => OK, 'READ_ONLY');
    await screen.findByRole('list', { name: text('prc1.def.steps.label') });
    expect(screen.queryByRole('button', { name: text('prc1.def.edit.action') })).not.toBeInTheDocument();
  });

  it('drafts a new version from the edited steps: the changed days and order go to the server, with the day it starts and the reason', async () => {
    const h = open(world(), MANAGER);
    await userEvent.click(await screen.findByRole('button', { name: text('prc1.def.edit.action') }));
    const form = screen.getByRole('form', { name: text('prc1.def.editor.label') });
    const days = within(form).getByLabelText(text('prc1.def.days.label'), { selector: '#prc1-s-DOC_PREPARE-days' });
    fireEvent.change(days, { target: { value: '18' } });
    await userEvent.click(within(form).getByRole('button', { name: text('prc1.def.down.label', { name: 'Lập hồ sơ mời thầu' }) }));
    const save = within(form).getByRole('button', { name: text('prc1.def.save.action') });
    expect(save).toBeDisabled();
    fireEvent.change(within(form).getByLabelText(text('prc1.def.from.label')), { target: { value: '2026-12-01' } });
    await userEvent.type(within(form).getByLabelText(text('prc1.dialog.reason.label')), 'Thẩm định cần thêm thời gian');
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    const [operation, input] = h.command.mock.calls[0] as [string, { body: { rule_type: string; code: string; effective_from: string; reason: string; params: { steps: Array<{ code: string; standard_working_days: number }> } } }];
    expect(operation).toBe('createGovernanceRuleDraft');
    expect(input.body).toMatchObject({ rule_type: 'PROCUREMENT_WORKFLOW', code: 'OPEN_BIDDING', effective_from: '2026-12-01', reason: 'Thẩm định cần thêm thời gian' });
    expect(input.body.params.steps.map((step) => step.code)).toEqual(['PLAN_SELECTION', 'DOC_APPRAISE', 'DOC_PREPARE']);
    expect(input.body.params.steps.find((step) => step.code === 'DOC_PREPARE')?.standard_working_days).toBe(18);
  });

  it('names the refusal of a definition that is not valid', async () => {
    open(world(), MANAGER, () => new ApiError({ status: 422, code: 'GOVERNANCE_RULE_PARAMS_INVALID', correlationId: 'c' }));
    await userEvent.click(await screen.findByRole('button', { name: text('prc1.def.edit.action') }));
    const form = screen.getByRole('form', { name: text('prc1.def.editor.label') });
    fireEvent.change(within(form).getByLabelText(text('prc1.def.from.label')), { target: { value: '2026-12-01' } });
    await userEvent.type(within(form).getByLabelText(text('prc1.dialog.reason.label')), 'Thử một giá trị');
    await userEvent.click(within(form).getByRole('button', { name: text('prc1.def.save.action') }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(text('prc1.error.params.text'));
  });

  it('lets the maker submit a draft, and keeps the maker and the submitter from approving it', async () => {
    const own = version(2, { status: 'SUBMITTED', created_by: ME, submitted_by: ME });
    const state = world({ versions: [own] });
    const h = open(state, ['adm.governance.read', 'adm.governance.manage', 'adm.governance.approve']);
    const row = (await screen.findByText('Tăng thời hạn thẩm định')).closest('tr') as HTMLElement;
    const approve = within(row).getByRole('button', { name: text('prc1.def.approve.action') });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAttribute('title', text('prc1.def.approve.self'));
    cleanup();
    const other = world({ versions: [version(2)] });
    const h2 = open(other, APPROVER);
    const row2 = (await screen.findByText('Tăng thời hạn thẩm định')).closest('tr') as HTMLElement;
    await userEvent.click(within(row2).getByRole('button', { name: text('prc1.def.approve.action') }));
    await userEvent.type(within(screen.getByRole('dialog')).getByLabelText(new RegExp(text('prc1.dialog.reason.label'))), 'Đã rà soát');
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: text('prc1.def.approve.action') }));
    await waitFor(() => expect(h2.command).toHaveBeenCalledWith('approveGovernanceRule', expect.objectContaining({ ifMatchVersion: 2, body: { reason: 'Đã rà soát' } })));
    expect(h.command).not.toHaveBeenCalled();
  });

  it('submits a draft under its version', async () => {
    const draft = version(3, { status: 'DRAFT', created_by: ME, submitted_by: null });
    const h = open(world({ versions: [draft] }), MANAGER);
    const row = (await screen.findByText('Tăng thời hạn thẩm định')).closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: text('prc1.def.submit.action') }));
    await userEvent.type(within(screen.getByRole('dialog')).getByLabelText(new RegExp(text('prc1.dialog.reason.label'))), 'Trình duyệt');
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: text('prc1.def.submit.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('submitGovernanceRule', expect.objectContaining({ path: { ruleId: draft.id }, ifMatchVersion: 2 })));
  });

  it('loading, error and denied are the standard states', async () => {
    const h = client(world());
    h.read.mockImplementation(() => new Promise(() => undefined));
    mount(<DefinitionScreen route={ROUTE} />, h, { permissions: READER, path: '/bid/bid-31' });
    expect(await screen.findByRole('status', { name: text('states.loading.label') })).toBeInTheDocument();
    cleanup();
    open(world({ failing: new Map([['getEffectiveGovernanceRule', { error: new Error('down'), times: Infinity }]]) }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text('states.error.title'));
    cleanup();
    open(world({ failing: new Map([['getEffectiveGovernanceRule', { error: new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }), times: Infinity }]]) }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text('states.denied.title'));
  });
});
