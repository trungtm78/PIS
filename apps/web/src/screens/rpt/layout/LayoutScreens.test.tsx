import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LayoutEditorScreen from './LayoutEditorScreen';
import LayoutListScreen from './LayoutListScreen';
import { ALL, catalogue, demoEntry, entry, harness, mount, previewOf, routeOf } from '../test/support';
import { INTERNAL_RECEIVER, emptyState, fromParams, moveItem, problemOf, quickProblem, toParams } from './model';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const MANAGE = [...ALL, 'adm.governance.manage', 'adm.governance.approve'];
const TODAY = '2026-11-09';

describe('the model of the layout editor (R23)', () => {
  it('turns the form into the params of a REPORT_LAYOUT rule: closed lists, empty optional words left out, columns only with groups', () => {
    const state = { ...emptyState(TODAY), code: 'CFG_MY_VIEW', title: ' My view ', indicators: [{ code: 'PLAN_TOTAL', title: '', basis: '' }, { code: '', title: 'x', basis: '' }, { code: 'DISBURSED_TREASURY', title: 'Paid', basis: 'YEAR_TO_DATE' }] };
    expect(toParams(state)).toEqual({
      kind: 'INTERNAL',
      title: 'My view',
      period_kind: 'MONTH',
      money_scale: 'MILLION_VND',
      demo: false,
      receiver: INTERNAL_RECEIVER,
      indicators: [{ code: 'PLAN_TOTAL' }, { code: 'DISBURSED_TREASURY', title: 'Paid', basis: 'YEAR_TO_DATE' }],
      columns: [],
      groups: [],
      totals: true,
      signatures: ['PREPARER', 'APPROVER'],
    });
    const agency = { ...state, kind: 'AGENCY_REQUEST' as const, receiver: 'SO_XD', agencyName: 'Department', requestRef: 'Letter 12', groups: [{ key: 'a', title: 'A' }], columns: [{ key: 'project_name' as const, title: '' }] };
    expect(toParams(agency)).toMatchObject({ kind: 'AGENCY_REQUEST', receiver: 'SO_XD', agency: { name: 'Department', request_ref: 'Letter 12' }, columns: [{ key: 'project_name' }], groups: [{ key: 'a', title: 'A' }] });
  });

  it('reads the params back, moves items without losing any and names the field of a refusal', () => {
    const params = toParams({ ...emptyState(TODAY), title: 'T', indicators: [{ code: 'PLAN_TOTAL', title: 'Plan', basis: 'FULL_YEAR' }] });
    expect(fromParams('CFG_X', params, TODAY)).toMatchObject({ code: 'CFG_X', title: 'T', indicators: [{ code: 'PLAN_TOTAL', title: 'Plan', basis: 'FULL_YEAR' }] });
    expect(moveItem(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveItem(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    expect(moveItem(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
    expect(problemOf('indicators[0].code')).toBe('indicators');
    expect(problemOf('effective_from')).toBe('effective_from');
    expect(problemOf('something else')).toBe('other');
  });

  it('asks nothing of the server while the form is plainly incomplete', () => {
    const base = { ...emptyState(TODAY), code: 'CFG_OK', title: 'T', indicators: [{ code: 'PLAN_TOTAL', title: '', basis: '' }] };
    expect(quickProblem(base)).toBeUndefined();
    expect(quickProblem({ ...base, code: 'PVN_MONTHLY' })).toBe('code');
    expect(quickProblem({ ...base, title: ' ' })).toBe('title');
    expect(quickProblem({ ...base, indicators: [{ code: 'lower', title: '', basis: '' }] })).toBe('indicators');
    expect(quickProblem({ ...base, indicators: [] })).toBe('indicators');
    expect(quickProblem({ ...base, kind: 'AGENCY_REQUEST', receiver: 'X' })).toBe('agency');
  });
});

describe('RPT-08, the editor of a layout', () => {
  const route = routeOf('RPT-08', 'FR-RPT-08');

  it('shows the preview the server builds from the choices, and saves a draft version of the rule with the reason', async () => {
    const shown = { valid: true, problem: null, form_name: 'My view', status: 'READY', datasets: [], preview: previewOf(), issues: [] };
    const h = harness(() => ({}), (operation) => (operation === 'previewReportLayout' ? shown : { resource_id: 'r1' }));
    mount(<LayoutEditorScreen route={route} />, h, { permissions: MANAGE, path: '/rpt/rpt-08' });
    fireEvent.change(screen.getByTestId('field-code'), { target: { value: 'cfg_my_view' } });
    fireEvent.change(screen.getByTestId('field-title'), { target: { value: 'My view' } });
    fireEvent.change(screen.getByTestId('indicator-0-code'), { target: { value: 'plan_total' } });
    expect(await screen.findByTestId('preview-name', {}, { timeout: 3000 })).toBeTruthy();
    const previewCall = h.command.mock.calls.find((call) => call[0] === 'previewReportLayout');
    expect(previewCall?.[1]).toMatchObject({ body: { params: { title: 'My view', indicators: [{ code: 'PLAN_TOTAL' }] } } });
    // Without a reason nothing is sent; with one the draft is written under the rule type.
    fireEvent.click(screen.getByTestId('save'));
    expect(screen.getByTestId('save-error')).toBeTruthy();
    expect(h.command.mock.calls.some((call) => call[0] === 'createGovernanceRuleDraft')).toBe(false);
    fireEvent.change(screen.getByTestId('field-reason'), { target: { value: 'first layout for the monthly view' } });
    fireEvent.click(screen.getByTestId('save'));
    await waitFor(() => expect(h.command.mock.calls.some((call) => call[0] === 'createGovernanceRuleDraft')).toBe(true));
    const draftCall = h.command.mock.calls.find((call) => call[0] === 'createGovernanceRuleDraft');
    expect(draftCall?.[1]).toMatchObject({ body: { rule_type: 'REPORT_LAYOUT', code: 'CFG_MY_VIEW', reason: 'first layout for the monthly view' } });
  });

  it('says which field the server refused the layout for, next to the preview, and draws no form', async () => {
    const refused = { valid: false, problem: 'columns', form_name: null, status: null, datasets: [], preview: null, issues: [] };
    const h = harness(() => ({}), () => refused);
    mount(<LayoutEditorScreen route={route} />, h, { permissions: MANAGE, path: '/rpt/rpt-08' });
    fireEvent.change(screen.getByTestId('field-code'), { target: { value: 'CFG_ABC' } });
    fireEvent.change(screen.getByTestId('field-title'), { target: { value: 'T' } });
    fireEvent.change(screen.getByTestId('indicator-0-code'), { target: { value: 'PLAN_TOTAL' } });
    expect(await screen.findByTestId('preview-problem', {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.queryByTestId('preview-name')).toBeNull();
  });

  it('adds a project group with its first columns, lets the columns be ordered, and bounds the lists', async () => {
    const h = harness(() => ({}), () => ({ valid: true, problem: null, form_name: 'x', status: 'READY', datasets: ['projects_group_1'], preview: previewOf(), issues: [] }));
    mount(<LayoutEditorScreen route={route} />, h, { permissions: MANAGE, path: '/rpt/rpt-08' });
    fireEvent.click(screen.getByTestId('group-add'));
    expect(screen.getByTestId('column-0')).toBeTruthy();
    fireEvent.change(screen.getByTestId('column-add'), { target: { value: 'plan_year' } });
    expect(screen.getByTestId('column-2')).toBeTruthy();
    fireEvent.click(screen.getByTestId('column-2-up'));
    expect(screen.getByTestId('column-1').textContent).toContain('Kế hoạch năm');
    fireEvent.click(screen.getByTestId('column-1-remove'));
    expect(screen.queryByTestId('column-2')).toBeNull();
  });
});

describe('RPT-07, the configured layouts and their versions', () => {
  const route = routeOf('RPT-07', 'FR-RPT-07');
  const version = (over: Record<string, unknown> = {}) => ({
    id: '00000000-0000-4000-8000-000000000a01',
    rule_type: 'REPORT_LAYOUT',
    code: 'CFG_AGENCY_REQUEST',
    version: 1,
    unit_id: null,
    status: 'SUBMITTED',
    phase: 'SUBMITTED',
    params: {},
    effective_from: '2026-12-01',
    effective_to: null,
    reason: 'a new layout',
    created_by: 'u1',
    created_at: '2026-11-08T01:00:00.000Z',
    submitted_by: 'u2',
    submitted_at: '2026-11-08T02:00:00.000Z',
    approved_by: null,
    approved_at: null,
    retired_by: null,
    retired_at: null,
    retire_reason: null,
    resource_version: 3,
    ...over,
  });
  const answer = (operation: string): unknown => {
    if (operation === 'listReportCatalogue') return catalogue([entry({ code: 'DIS-WEEKLY' }), demoEntry({ code: 'CFG_AGENCY_REQUEST', name: 'Agency form', receiver: 'AGENCY', version: 'v0' }), entry({ code: 'CFG_INTERNAL_OVERVIEW', name: 'Internal', receiver: 'INTERNAL', version: 'v0' })]);
    if (operation === 'listGovernanceRuleVersions') return { items: [version()] };
    return {};
  };

  it('lists only the configured forms, never a form owned by code, and opens the versions of a code', async () => {
    const h = harness(answer);
    mount(<LayoutListScreen route={route} />, h, { permissions: MANAGE, path: '/rpt/rpt-07' });
    expect(await screen.findByTestId('versions-CFG_AGENCY_REQUEST')).toBeTruthy();
    expect(screen.getByTestId('versions-CFG_INTERNAL_OVERVIEW')).toBeTruthy();
    expect(screen.queryByTestId('versions-DIS-WEEKLY')).toBeNull();
    fireEvent.click(screen.getByTestId('versions-CFG_AGENCY_REQUEST'));
    expect(await screen.findByTestId('approve-1')).toBeTruthy();
    expect(screen.queryByTestId('submit-1')).toBeNull();
  });

  it('approves a submitted version with a reason and the version of the record as If-Match', async () => {
    const h = harness(answer);
    mount(<LayoutListScreen route={route} />, h, { permissions: MANAGE, path: '/rpt/rpt-07?code=CFG_AGENCY_REQUEST' });
    fireEvent.click(await screen.findByTestId('approve-1'));
    const reason = await screen.findByRole('textbox');
    fireEvent.change(reason, { target: { value: 'checked against the request' } });
    fireEvent.click(screen.getAllByRole('button').find((button) => button.className.includes('ui-button') && button.textContent === 'Duyệt' && button.closest('[role="dialog"]') !== null) as HTMLElement);
    await waitFor(() => expect(h.command.mock.calls.some((call) => call[0] === 'approveGovernanceRule')).toBe(true));
    expect(h.command.mock.calls.find((call) => call[0] === 'approveGovernanceRule')?.[1]).toMatchObject({ path: { ruleId: '00000000-0000-4000-8000-000000000a01' }, ifMatchVersion: 3, body: { reason: 'checked against the request' } });
  });

  it('shows no step to a person who may not make or approve a rule', async () => {
    const h = harness(answer);
    mount(<LayoutListScreen route={route} />, h, { permissions: ['rpt.read'], path: '/rpt/rpt-07?code=CFG_AGENCY_REQUEST' });
    expect(await screen.findByTestId('versions')).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId('approve-1')).toBeNull());
    expect(screen.queryByTestId('withdraw-1')).toBeNull();
  });
});
