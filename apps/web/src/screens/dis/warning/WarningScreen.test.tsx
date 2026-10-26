import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { WARNING_APPROVER, WARNING_HANDLER, WARNING_MANAGER, WARNING_READER, client, mount, routeOf, world } from '../report/test-support';
import WarningScreen from './WarningScreen';

const ROUTE = routeOf('DIS-20', 'FR-DIS-20');
const RULE = (n: number) => `00000000-0000-4000-8000-00000000a${String(n).padStart(3, '0')}`;
const WARNING = (n: number) => `00000000-0000-4000-8000-00000000b${String(n).padStart(3, '0')}`;
const ALL = [...WARNING_MANAGER, ...WARNING_APPROVER, ...WARNING_HANDLER];

afterEach(cleanup);

const ruleRecord = (n: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: RULE(n),
  rule_code: 'EW-01',
  name: 'Tỷ lệ giải ngân thấp hơn đường kỳ vọng',
  metric_code: 'YTD_RATE_GAP',
  comparator: 'GTE',
  threshold_json: { points: '10', critical_points: '20' },
  severity: 'WARNING',
  scope_kind: 'PROJECT',
  auto_explanation: false,
  legal_basis: 'DIS BR-DIS-13 [giả định, chờ phòng Tài chính xác nhận]',
  effective_from: '2027-01-01',
  effective_until: null,
  revision: 1,
  status: 'PUBLISHED',
  approved_by: '00000000-0000-4000-8000-000000000002',
  created_by: '00000000-0000-4000-8000-000000000001',
  created_at: '2027-01-02T03:00:00.000Z',
  version: 2,
  ...over,
});
const warningRecord = (n: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: WARNING(n),
  rule_id: RULE(1),
  rule_code: 'EW-01',
  rule_name: 'Tỷ lệ giải ngân thấp hơn đường kỳ vọng',
  project: { id: '00000000-0000-4000-8000-000000000041', code: 'P-A-002', name: 'Cầu qua sông' },
  unit_id: '00000000-0000-4000-8000-000000000051',
  period_id: '00000000-0000-4000-8000-000000000042',
  snapshot_id: '00000000-0000-4000-8000-0000000000d1',
  severity: 'WARNING',
  observed: { metric: 'YTD_RATE_GAP', observed_pct: '22.0000', expected_pct: '45.0000', gap_points: '23.0000' },
  dedupe_key: 'EW-01|P-A-002|2027',
  status: 'OPEN',
  owner_membership_id: null,
  explanation_request_id: null,
  resolution_reason: null,
  acknowledged_by: null,
  acknowledged_at: null,
  acknowledgement_note: null,
  closed_by: null,
  opened_at: '2027-06-15T03:00:00.000Z',
  closed_at: null,
  version: 1,
  ...over,
});

const open = (options: { rules?: Array<Record<string, unknown>>; warnings?: Record<string, unknown> | ((query: Record<string, unknown>) => unknown); permissions?: readonly string[] | undefined; command?: (operation: string, input: unknown) => unknown; mode?: 'FULL' | 'READ_ONLY' } = {}) => {
  const h = client(world({ rules: options.rules ?? [ruleRecord(1)], warnings: options.warnings ?? { items: [warningRecord(1)], next_cursor: null } }), options.command ?? (() => ({ status: 'OK', resource_version: 2, resource_id: RULE(9) })));
  mount(<WarningScreen route={ROUTE} />, h, { permissions: 'permissions' in options ? options.permissions : ALL, path: '/dis/dis-20', ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
};
const sent = (h: { command: { mock: { calls: unknown[][] } } }, call = 0) => h.command.mock.calls[call] as [string, { body?: Record<string, unknown>; path?: { id: string }; ifMatchVersion?: number }];

describe('DIS-20 early-warning rules and warnings', () => {
  it('UI-DIS-20: lists the rules with their metric, threshold in words, severity, status and legal basis, and says what a draft would open on the latest frozen snapshot', async () => {
    open({ rules: [ruleRecord(1), ruleRecord(2, { revision: 2, status: 'DRAFT', approved_by: null, preview: { snapshot_id: 's', would_open: 3 }, threshold_json: { points: '15' } })] });
    expect(await screen.findByRole('heading', { level: 1, name: vi_['dis.warning.page.title'] })).toBeTruthy();
    const table = await screen.findByTestId('rules');
    const published = table.querySelector(`tr[data-rule="${RULE(1)}"]`) as HTMLElement;
    expect(within(published).getAllByText(vi_['dis.warning.metric.ytdRateGap']).length).toBeGreaterThanOrEqual(1);
    expect(within(published).getByText('Thấp hơn kỳ vọng từ 10 điểm %, nghiêm trọng từ 20 điểm')).toBeTruthy();
    expect(within(published).getByText(vi_['dis.warning.rule.status.published'])).toBeTruthy();
    expect(published.textContent).toContain('DIS BR-DIS-13 [giả định, chờ phòng Tài chính xác nhận]');
    expect(screen.getByTestId(`preview-${RULE(1)}`).textContent).toBe('—');
    const draft = table.querySelector(`tr[data-rule="${RULE(2)}"]`) as HTMLElement;
    expect(within(draft).getByText('Thấp hơn kỳ vọng từ 15 điểm %')).toBeTruthy();
    expect(within(draft).getByText(vi_['dis.warning.rule.status.draft'])).toBeTruthy();
    expect(screen.getByTestId(`preview-${RULE(2)}`).textContent).toBe('3 cảnh báo');
  });

  it('AC-ST-DIS-012-1 / UAT-AC252: lists the warnings with rule, project, severity, what was seen against what was expected, and the state in words', async () => {
    open({
      warnings: {
        items: [
          warningRecord(1),
          warningRecord(2, { status: 'RESOLVED', resolution_reason: 'AUTO_CLEARED', closed_at: '2027-06-20T03:00:00.000Z', severity: 'CRITICAL', observed: { metric: 'REPORT_OVERDUE', days_past_deadline: 2 }, rule_code: 'EW-02' }),
          warningRecord(3, { status: 'DISMISSED', resolution_reason: 'Dự án chuyển sang kế hoạch quý sau.', observed: { metric: 'PERIOD_DELTA_NEGATIVE', delta_vnd: '-20000000' }, rule_code: 'EW-07' }),
        ],
        next_cursor: null,
      },
    });
    const table = await screen.findByTestId('warnings');
    const first = table.querySelector(`tr[data-warning="${WARNING(1)}"]`) as HTMLElement;
    expect(Array.from(first.querySelectorAll('td')).slice(0, 5).map((cell) => cell.textContent)).toEqual([
      'EW-01Tỷ lệ giải ngân thấp hơn đường kỳ vọng',
      'P-A-002Cầu qua sông',
      vi_['dis.warning.severity.warning'],
      '22.0000% so với kỳ vọng 45.0000% (chênh 23.0000 điểm)',
      vi_['dis.warning.status.open'],
    ]);
    const cleared = table.querySelector(`tr[data-warning="${WARNING(2)}"]`) as HTMLElement;
    expect(within(cleared).getByText(vi_['dis.warning.severity.critical'])).toBeTruthy();
    expect(within(cleared).getByText('Trễ hạn 2 ngày, chưa có báo cáo')).toBeTruthy();
    expect(within(cleared).getByText(vi_['dis.warning.resolution.autoCleared'])).toBeTruthy();
    const dismissed = table.querySelector(`tr[data-warning="${WARNING(3)}"]`) as HTMLElement;
    expect(within(dismissed).getByText('Giải ngân trong kỳ -20.000.000 đồng')).toBeTruthy();
    expect(within(dismissed).getByText('Dự án chuyển sang kế hoạch quý sau.')).toBeTruthy();
    // A warning that is closed cannot be handled.
    expect(within(cleared).queryAllByRole('button')).toHaveLength(0);
    expect(within(dismissed).queryAllByRole('button')).toHaveLength(0);
  });

  it('acknowledges an open warning with a reason under the version shown, and says why when the reason is missing or too short', async () => {
    const user = userEvent.setup();
    const h = open({ command: () => ({ status: 'ACKNOWLEDGED', resource_version: 2, resource_id: WARNING(1) }) });
    const row = (await screen.findByTestId('warnings')).querySelector(`tr[data-warning="${WARNING(1)}"]`) as HTMLElement;
    await user.click(within(row).getByRole('button', { name: vi_['dis.warning.acknowledge.action'] }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: vi_['dis.warning.acknowledge.confirm.action'] }));
    expect(within(dialog).getByText(vi_['dis.warning.field.required.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.type(within(dialog).getByLabelText(vi_['dis.warning.field.reason.label']), 'ok');
    await user.click(within(dialog).getByRole('button', { name: vi_['dis.warning.acknowledge.confirm.action'] }));
    expect(within(dialog).getByText(vi_['dis.warning.field.invalid.error'])).toBeTruthy();
    await user.type(within(dialog).getByLabelText(vi_['dis.warning.field.reason.label']), ' Đã báo trưởng đơn vị.');
    await user.click(within(dialog).getByRole('button', { name: vi_['dis.warning.acknowledge.confirm.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(sent(h)).toEqual(['acknowledgeEarlyWarning', expect.objectContaining({ path: { id: WARNING(1) }, body: { reason: 'ok Đã báo trưởng đơn vị.' }, ifMatchVersion: 1 })]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('offers to dismiss an open or an acknowledged warning, and acknowledging only the open one; the refusal for a state that moved is told in words and keeps the dialog', async () => {
    const user = userEvent.setup();
    let failure: Error = new ApiError({ status: 409, code: 'WARNING_STATE_INVALID', correlationId: 'c' });
    open({
      warnings: { items: [warningRecord(1), warningRecord(2, { status: 'ACKNOWLEDGED' }), warningRecord(3, { status: 'EXPLANATION_REQUESTED' })], next_cursor: null },
      command: () => failure,
    });
    const table = await screen.findByTestId('warnings');
    const rowOf = (n: number) => table.querySelector(`tr[data-warning="${WARNING(n)}"]`) as HTMLElement;
    expect(within(rowOf(1)).getByRole('button', { name: vi_['dis.warning.acknowledge.action'] })).toBeTruthy();
    expect(within(rowOf(1)).getByRole('button', { name: vi_['dis.warning.dismiss.action'] })).toBeTruthy();
    expect(within(rowOf(2)).queryByRole('button', { name: vi_['dis.warning.acknowledge.action'] })).toBeNull();
    expect(within(rowOf(2)).getByRole('button', { name: vi_['dis.warning.dismiss.action'] })).toBeTruthy();
    expect(within(rowOf(3)).queryAllByRole('button')).toHaveLength(0);
    await user.click(within(rowOf(2)).getByRole('button', { name: vi_['dis.warning.dismiss.action'] }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(vi_['dis.warning.field.reason.label']), 'Đã có kế hoạch bù.');
    for (const [code, key] of [['WARNING_STATE_INVALID', 'stateInvalid'], ['VERSION_CONFLICT', 'versionConflict'], ['RESOURCE_NOT_FOUND', 'notFound']] as const) {
      failure = new ApiError({ status: 409, code, correlationId: 'c' });
      await user.click(within(dialog).getByRole('button', { name: vi_['dis.warning.dismiss.confirm.action'] }));
      await waitFor(() => expect(within(dialog).getByTestId('action-refusal').textContent).toBe(vi_[`dis.warning.problem.${key}`]));
    }
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('narrows the warnings by status, severity and rule, sending only what was chosen, and loads the next page on request', async () => {
    const user = userEvent.setup();
    const h = open({
      warnings: (query) => (query.cursor === undefined ? { items: [warningRecord(1)], next_cursor: 'next' } : { items: [warningRecord(2)], next_cursor: null }),
    });
    await screen.findByTestId('warnings');
    await user.click(screen.getByRole('button', { name: vi_['dis.warning.list.more.action'] }));
    await waitFor(() => expect(screen.getByTestId('warnings').querySelectorAll('tbody tr')).toHaveLength(2));
    expect(screen.queryByRole('button', { name: vi_['dis.warning.list.more.action'] })).toBeNull();
    await user.selectOptions(screen.getByLabelText(vi_['dis.warning.filter.status']), 'OPEN');
    await user.selectOptions(screen.getByLabelText(vi_['dis.warning.filter.severity']), 'CRITICAL');
    await user.selectOptions(screen.getByLabelText(vi_['dis.warning.filter.rule'], { selector: 'select' }), 'EW-01');
    await waitFor(() => {
      const queries = h.read.mock.calls.filter((call) => call[0] === 'listEarlyWarnings').map((call) => (call[1] as { query: Record<string, unknown> }).query);
      expect(queries).toContainEqual({ limit: 25, status: 'OPEN', severity: 'CRITICAL', rule_code: 'EW-01' });
    });
    const first = h.read.mock.calls.find((call) => call[0] === 'listEarlyWarnings');
    expect((first?.[1] as { query: Record<string, unknown> }).query).toEqual({ limit: 25 });
  });

  it('AC-ST-DIS-012-3 / UAT-PLAN-70: publishes a draft under the version shown for a person who may approve, and says in words that the author cannot publish their own rule', async () => {
    const user = userEvent.setup();
    let failure: Error | undefined = new ApiError({ status: 403, code: 'SELF_APPROVAL_DENIED', correlationId: 'c' });
    const h = open({ rules: [ruleRecord(1), ruleRecord(2, { revision: 2, status: 'DRAFT', approved_by: null, version: 1 })], command: () => failure ?? { status: 'PUBLISHED', resource_version: 2, resource_id: RULE(2) } });
    const draft = (await screen.findByTestId('rules')).querySelector(`tr[data-rule="${RULE(2)}"]`) as HTMLElement;
    expect(within((await screen.findByTestId('rules')).querySelector(`tr[data-rule="${RULE(1)}"]`) as HTMLElement).queryByRole('button', { name: vi_['dis.warning.rule.publish.action'] })).toBeNull();
    await user.click(within(draft).getByRole('button', { name: vi_['dis.warning.rule.publish.action'] }));
    await waitFor(() => expect(screen.getByTestId('publish-refusal').textContent).toBe(vi_['dis.warning.problem.selfApproval']));
    expect(sent(h)).toEqual(['publishEarlyWarningRule', expect.objectContaining({ path: { id: RULE(2) }, ifMatchVersion: 1 })]);
    failure = undefined;
    await user.click(within(draft).getByRole('button', { name: vi_['dis.warning.rule.publish.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
  });

  it('makes a new revision of a rule: the form starts from the words of the rule, is checked field by field, and sends the draft in the words of the contract', async () => {
    const user = userEvent.setup();
    const h = open({ command: () => ({ status: 'DRAFT', resource_version: 1, resource_id: RULE(9) }) });
    await screen.findByTestId('rules');
    await user.click(screen.getByRole('button', { name: vi_['dis.warning.rule.revise.action'] }));
    const form = await screen.findByTestId('rule-form');
    expect(within(form).getByRole('heading', { level: 2 }).textContent).toBe('Bản mới của quy tắc EW-01');
    expect((within(form).getByLabelText(vi_['dis.warning.field.points.label']) as HTMLInputElement).value).toBe('10');
    expect((within(form).getByLabelText(vi_['dis.warning.field.legal.label']) as HTMLInputElement).value).toContain('DIS BR-DIS-13');
    // A threshold that is not a number, and a critical threshold under the threshold, are told on their fields and nothing is sent.
    fireEvent.change(within(form).getByLabelText(vi_['dis.warning.field.points.label']), { target: { value: '0' } });
    fireEvent.change(within(form).getByLabelText(vi_['dis.warning.field.critical.label']), { target: { value: '0' } });
    await user.click(within(form).getByRole('button', { name: vi_['dis.warning.editor.save.action'] }));
    expect(within(form).getAllByText(vi_['dis.warning.field.invalid.error']).length).toBeGreaterThanOrEqual(2);
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText(vi_['dis.warning.field.points.label']), { target: { value: '15' } });
    fireEvent.change(within(form).getByLabelText(vi_['dis.warning.field.critical.label']), { target: { value: '25' } });
    await user.click(within(form).getByRole('button', { name: vi_['dis.warning.editor.save.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(sent(h)).toEqual([
      'createEarlyWarningRuleVersion',
      expect.objectContaining({
        body: {
          rule_code: 'EW-01',
          name: 'Tỷ lệ giải ngân thấp hơn đường kỳ vọng',
          metric_code: 'YTD_RATE_GAP',
          comparator: 'GTE',
          threshold_json: { points: '15', critical_points: '25' },
          severity: 'WARNING',
          scope_kind: 'PROJECT',
          auto_explanation: false,
          legal_basis: 'DIS BR-DIS-13 [giả định, chờ phòng Tài chính xác nhận]',
          effective_from: '2027-01-01',
        },
      }),
    ]);
    await waitFor(() => expect(screen.queryByTestId('rule-form')).toBeNull());
  });

  it('makes a new rule of a metric with its own threshold, and puts the 422 of the server on the field it names', async () => {
    const user = userEvent.setup();
    const h = open({ command: () => new ApiError({ status: 422, code: 'VALIDATION_FAILED', detail: 'threshold_json.grace_days', correlationId: 'c' }) });
    await screen.findByTestId('rules');
    await user.click(screen.getByRole('button', { name: vi_['dis.warning.rule.new.action'] }));
    const form = await screen.findByTestId('rule-form');
    await user.click(within(form).getByRole('button', { name: vi_['dis.warning.editor.save.action'] }));
    expect(within(form).getAllByText(vi_['dis.warning.field.required.error']).length).toBeGreaterThanOrEqual(3);
    await user.type(within(form).getByLabelText(vi_['dis.warning.field.code.label']), 'EW-02');
    await user.type(within(form).getByLabelText(vi_['dis.warning.field.name.label']), 'Chưa gửi báo cáo sau hạn');
    await user.selectOptions(within(form).getByLabelText(vi_['dis.warning.field.metric.label']), 'REPORT_OVERDUE');
    expect(within(form).queryByLabelText(vi_['dis.warning.field.points.label'])).toBeNull();
    await user.selectOptions(within(form).getByLabelText(vi_['dis.warning.field.severity.label']), 'CRITICAL');
    await user.click(within(form).getByLabelText(vi_['dis.warning.field.auto.label']));
    fireEvent.change(within(form).getByLabelText(vi_['dis.warning.field.from.label']), { target: { value: '2027-01-01' } });
    await user.type(within(form).getByLabelText(vi_['dis.warning.field.legal.label']), 'DIS BR-DIS-13');
    await user.click(within(form).getByRole('button', { name: vi_['dis.warning.editor.save.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(sent(h)[1].body).toMatchObject({ rule_code: 'EW-02', metric_code: 'REPORT_OVERDUE', comparator: 'MISSING', threshold_json: { grace_days: 0, explanation_due_days: 3 }, severity: 'CRITICAL', auto_explanation: true });
    await waitFor(() => expect(within(form).getByText(vi_['dis.warning.problem.validation'])).toBeTruthy());
  });

  it('says in words why the server refused a metric it does not compute, on the form and not on a field', async () => {
    const user = userEvent.setup();
    open({ command: () => new ApiError({ status: 422, code: 'METRIC_UNKNOWN', detail: 'metric_code', correlationId: 'c' }) });
    await screen.findByTestId('rules');
    await user.click(screen.getByRole('button', { name: vi_['dis.warning.rule.revise.action'] }));
    await user.click(await screen.findByRole('button', { name: vi_['dis.warning.editor.save.action'] }));
    expect((await screen.findByTestId('create-refusal')).textContent).toBe(vi_['dis.warning.problem.unknownMetric']);
  });

  it('shows each person only what they can do: a reader sees the rules and the warnings and no control; read-only mode too', async () => {
    open({ permissions: WARNING_READER, rules: [ruleRecord(1), ruleRecord(2, { status: 'DRAFT', approved_by: null })] });
    await screen.findByTestId('rules');
    expect(screen.queryAllByRole('button').filter((button) => /Công bố|Tạo|Tiếp nhận|Bỏ qua/.test(button.textContent ?? ''))).toHaveLength(0);
    cleanup();
    open({ permissions: ALL, mode: 'READ_ONLY', rules: [ruleRecord(1), ruleRecord(2, { status: 'DRAFT', approved_by: null })] });
    await screen.findByTestId('rules');
    expect(screen.queryByRole('button', { name: vi_['dis.warning.rule.new.action'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['dis.warning.rule.publish.action'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['dis.warning.acknowledge.action'] })).toBeNull();
    cleanup();
    open({ permissions: WARNING_HANDLER });
    await screen.findByTestId('rules');
    await screen.findByTestId('warnings');
    expect(screen.queryByRole('button', { name: vi_['dis.warning.rule.new.action'] })).toBeNull();
    expect(screen.getByRole('button', { name: vi_['dis.warning.acknowledge.action'] })).toBeTruthy();
  });

  it('is in each state of a screen: no rules, no warnings, and the refusal for a person who may not read them', async () => {
    open({ rules: [], warnings: { items: [], next_cursor: null } });
    expect((await screen.findByTestId('rules-none')).textContent).toBe(vi_['dis.warning.rules.empty.text']);
    cleanup();
    const h = client(world({ failing: new Map([['listEarlyWarningRules', new ApiError({ status: 403, code: 'FORBIDDEN', correlationId: 'c' })]]) }));
    mount(<WarningScreen route={ROUTE} />, h, { permissions: WARNING_READER, path: '/dis/dis-20' });
    expect(await screen.findByRole('heading', { level: 1, name: vi_['states.denied.title'] })).toBeTruthy();
  });
});
