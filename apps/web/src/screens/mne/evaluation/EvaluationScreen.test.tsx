import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { harness, mount, routeOf } from '../test-support';
import type { Harness } from '../test-support';
import EvaluationScreen from './EvaluationScreen';
import { EMPTY_DECIDE, EMPTY_PLAN, EMPTY_SUBMIT, canPlan, decideBody, findingLine, submitFormOf, describeRefusal, holds, planBody, submitBody, toEvaluation, validateDecide, validatePlan, validateSubmit, vietnamToday } from './model';

const ROUTE = routeOf('MNE-08', 'FR-MNE-08');
const PLANNER = ['mne.read', 'mne.evaluation.manage'];
const DECIDER = ['mne.read', 'mne.evaluation.approve'];
const READER = ['mne.read'];
const text = (key: string, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

const uuid = (n: number): string => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const PROJECT = uuid(11);
const PROJECTS = [
  { id: PROJECT, code: 'DA-001', name: 'Cầu qua sông' },
  { id: uuid(12), code: 'DA-002', name: 'Đường tỉnh lộ' },
];
const evaluation = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid(20 + n),
  project: { id: PROJECT, code: 'DA-001', name: 'Cầu qua sông' },
  evaluation_kind: 'MIDTERM',
  evaluator_kind: 'INTERNAL',
  evaluator_name: 'Phòng MNE',
  scope_text: 'Đánh giá giữa kỳ các hạng mục chính',
  planned_date: '2026-12-01',
  status: 'PLANNED',
  findings: [],
  conclusion: null,
  recommendations_text: null,
  completed_date: null,
  report_document_id: null,
  mne_report_id: null,
  submitted_by: null,
  submitted_at: null,
  decided_by: null,
  decided_at: null,
  decision_reason: null,
  created_at: '2026-10-25T01:00:00.000Z',
  actions: { submit: true, decide: false },
  version: 1,
  ...overrides,
});
const OK = { operation_id: 'o', status: 'SUBMITTED', resource_version: 2, resource_id: 'x' };
const NEWLINE = String.fromCharCode(10);

afterEach(cleanup);

function open(options: { rows?: unknown[]; permissions?: readonly string[]; mode?: 'FULL' | 'READ_ONLY'; path?: string; command?: (operation: string, input: unknown) => unknown; failing?: boolean } = {}): Harness & { readAll: ReturnType<typeof vi.fn> } {
  const h = harness((operation) => new Error(`unexpected read ${operation}`), options.command ?? (() => OK));
  const readAll = vi.fn((operation: string, input?: { query?: { project_id?: string; status?: string } }) => {
    if (operation === 'listMneEvaluationProjects') return Promise.resolve(PROJECTS);
    if (operation !== 'listMneEvaluations') return Promise.reject(new Error(`unexpected readAll ${operation}`));
    if (options.failing === true) return Promise.reject(new Error('listMneEvaluations failed'));
    const query = input?.query ?? {};
    return Promise.resolve((options.rows ?? []).filter((row) => (query.project_id === undefined || (row as ReturnType<typeof evaluation>).project.id === query.project_id) && (query.status === undefined || (row as ReturnType<typeof evaluation>).status === query.status)));
  });
  (h.client as unknown as { readAll: typeof readAll }).readAll = readAll;
  mount(<EvaluationScreen route={ROUTE} />, h, { permissions: options.permissions ?? PLANNER, ...(options.mode === undefined ? {} : { mode: options.mode }) }, options.path ?? '/mne/mne-08');
  return Object.assign(h, { readAll });
}
const dialog = (): HTMLElement => screen.getByRole('dialog');
const fill = (label: string, value: string): void => {
  fireEvent.change(within(dialog()).getByLabelText(label), { target: { value } });
};
const sent = (h: Harness) => h.command.mock.calls.map(([name, input]) => ({ name, ...(input as { body?: Record<string, unknown>; path?: { id: string }; ifMatchVersion?: number }) }));

describe('EvaluationScreen (MNE-08): the investment evaluation of a project', () => {
  it('UI-MNE-08: lists the evaluations with the project, the kind, the evaluator, the status and the conclusion in words', async () => {
    open({
      rows: [
        evaluation(1),
        evaluation(2, { evaluation_kind: 'FINAL', evaluator_kind: 'INDEPENDENT_CONSULTANT', status: 'APPROVED', conclusion: 'PARTIALLY_SATISFACTORY', completed_date: '2026-10-20', mne_report_id: uuid(90), actions: { submit: false, decide: false } }),
        evaluation(3, { status: 'RETURNED', decision_reason: 'Thiếu phát hiện về tiến độ' }),
      ],
    });
    const table = await screen.findByTestId('evaluations');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['mne.evaluation.page.title']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain('DA-001');
    expect(rows[0]?.textContent).toContain(vi_['mne.evaluation.kind.midterm']);
    expect(rows[0]?.textContent).toContain(vi_['mne.evaluation.status.planned']);
    expect(rows[0]?.textContent).toContain('2026-12-01');
    expect(rows[1]?.textContent).toContain(vi_['mne.evaluation.kind.final']);
    expect(rows[1]?.textContent).toContain(vi_['mne.evaluation.evaluator.consultant']);
    expect(rows[1]?.textContent).toContain(vi_['mne.evaluation.conclusion.partial']);
    expect(within(rows[1] as HTMLElement).getByTestId('linked').textContent).toContain(vi_['mne.evaluation.linked']);
    expect(within(rows[2] as HTMLElement).getByTestId('return-reason').textContent).toContain('Thiếu phát hiện về tiến độ');
    expect(screen.getByText(text('mne.evaluation.footer.reference', { id: 'MNE-08', req: 'FR-MNE-08' }))).toBeTruthy();
  });

  it('narrows the list by project and by status, and says in words that nothing is there', async () => {
    const h = open({ rows: [evaluation(1), evaluation(2, { status: 'SUBMITTED' })] });
    await screen.findByTestId('evaluations');
    fireEvent.change(screen.getByLabelText(vi_['mne.evaluation.column.status']), { target: { value: 'SUBMITTED' } });
    await waitFor(() => expect(within(screen.getByTestId('evaluations')).getAllByRole('row')).toHaveLength(2));
    fireEvent.change(await screen.findByLabelText(vi_['mne.evaluation.field.project']), { target: { value: uuid(12) } });
    expect((await screen.findByTestId('empty')).textContent).toBe(vi_['mne.evaluation.empty.notice']);
    expect(h.readAll.mock.calls.filter((call) => call[0] === 'listMneEvaluations').some((call) => (call[1] as { query: { project_id?: string } }).query.project_id === uuid(12))).toBe(true);
    fireEvent.change(screen.getByLabelText(vi_['mne.evaluation.field.project']), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(vi_['mne.evaluation.column.status']), { target: { value: '' } });
    expect(await screen.findByTestId('evaluations')).toBeTruthy();
  });

  it('AC-ST-MNE-009-2: plans an evaluation with the project, the kind, the evaluator, the scope and the day, and asks for them before it asks the server', async () => {
    const h = open();
    fireEvent.click(await screen.findByRole('button', { name: vi_['mne.evaluation.plan.action'] }));
    fireEvent.click(within(dialog()).getByRole('button', { name: vi_['mne.evaluation.plan.submit'] }));
    expect((await within(dialog()).findAllByText(vi_['mne.evaluation.field.required.error'])).length).toBe(5);
    fill(vi_['mne.evaluation.field.scope'], 'short');
    fill(vi_['mne.evaluation.field.planned'], '2026-12-01');
    fill(vi_['mne.evaluation.field.name'], 'x');
    expect(within(dialog()).getByText(vi_['mne.evaluation.field.short.error'])).toBeTruthy();
    expect(within(dialog()).getAllByText(vi_['mne.evaluation.field.invalid.error']).length).toBe(1);
    expect(h.command).not.toHaveBeenCalled();
    fill(vi_['mne.evaluation.field.project'], PROJECT);
    fill(vi_['mne.evaluation.field.kind'], 'AD_HOC');
    fill(vi_['mne.evaluation.field.evaluatorKind'], 'INDEPENDENT_CONSULTANT');
    fill(vi_['mne.evaluation.field.name'], '  Công ty tư vấn A  ');
    fill(vi_['mne.evaluation.field.scope'], '  Đánh giá đột xuất các hạng mục  ');
    fill(vi_['mne.evaluation.field.planned'], '2026-12-01');
    fireEvent.click(within(dialog()).getByRole('button', { name: vi_['mne.evaluation.plan.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(sent(h)[0]).toMatchObject({
      name: 'planMneEvaluation',
      body: { project_id: PROJECT, evaluation_kind: 'AD_HOC', evaluator_kind: 'INDEPENDENT_CONSULTANT', evaluator_name: 'Công ty tư vấn A', scope_text: 'Đánh giá đột xuất các hạng mục', planned_date: '2026-12-01' },
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('opens the plan on the project that is filtered', async () => {
    open({ path: `/mne/mne-08?project=${uuid(12)}` });
    fireEvent.click(await screen.findByRole('button', { name: vi_['mne.evaluation.plan.action'] }));
    await waitFor(() => expect((within(dialog()).getByLabelText(vi_['mne.evaluation.field.project']) as HTMLSelectElement).options.length).toBeGreaterThan(1));
    expect((within(dialog()).getByLabelText(vi_['mne.evaluation.field.project']) as HTMLSelectElement).value).toBe(uuid(12));
  });

  it.each([
    [{ evaluation_kind: 'FINAL', project_status: 'IMPLEMENTATION' }, text('mne.evaluation.problem.stage', { kind: vi_['mne.evaluation.kind.final'], stage: 'IMPLEMENTATION' })],
    [{ evaluation_kind: 'INITIAL', project_status: 'IMPLEMENTATION', reason: 'INITIAL_WINDOW_PASSED' }, vi_['mne.evaluation.problem.window']],
    [{}, vi_['mne.evaluation.problem.state']],
  ])('UAT-PLAN-74: says in words why the stage of the project refuses the kind (%j)', async (extensions, message) => {
    open({ command: () => new ApiError({ status: 409, code: 'STAGE_TRANSITION_DENIED', correlationId: 'c', extensions }) });
    fireEvent.click(await screen.findByRole('button', { name: vi_['mne.evaluation.plan.action'] }));
    await waitFor(() => expect((within(dialog()).getByLabelText(vi_['mne.evaluation.field.project']) as HTMLSelectElement).options.length).toBeGreaterThan(1));
    fill(vi_['mne.evaluation.field.project'], PROJECT);
    fill(vi_['mne.evaluation.field.kind'], 'FINAL');
    fill(vi_['mne.evaluation.field.name'], 'Phòng MNE');
    fill(vi_['mne.evaluation.field.scope'], 'Đánh giá kết thúc dự án');
    fill(vi_['mne.evaluation.field.planned'], '2026-12-01');
    fireEvent.click(within(dialog()).getByRole('button', { name: vi_['mne.evaluation.plan.submit'] }));
    expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(message);
  });

  it('AC-ST-MNE-009-1: submits an evaluation with a finding for each line, the conclusion, the recommendations and the day, and asks for the conclusion and the day first', async () => {
    const h = open({ rows: [evaluation(1)] });
    fireEvent.click(await screen.findByRole('button', { name: text('mne.evaluation.submit.aria', { project: 'DA-001', kind: vi_['mne.evaluation.kind.midterm'] }) }));
    fireEvent.click(within(dialog()).getByRole('button', { name: vi_['mne.evaluation.submit.submit'] }));
    expect((await within(dialog()).findAllByText(vi_['mne.evaluation.field.required.error'])).length).toBe(2);
    expect(h.command).not.toHaveBeenCalled();
    fill(vi_['mne.evaluation.field.completed'], '2999-01-01');
    fill(vi_['mne.evaluation.field.document'], 'not-an-id');
    expect(within(dialog()).getByText(vi_['mne.evaluation.field.future.error'])).toBeTruthy();
    expect(within(dialog()).getByText(vi_['mne.evaluation.field.invalid.error'])).toBeTruthy();
    fill(vi_['mne.evaluation.field.findings'], 'Tiến độ đúng kế hoạch\n\n  Chất lượng đạt yêu cầu  \n');
    fill(vi_['mne.evaluation.field.conclusion'], 'SATISFACTORY');
    fill(vi_['mne.evaluation.field.recommendations'], ' Giữ nhịp thi công ');
    fill(vi_['mne.evaluation.field.completed'], '2026-10-30');
    fill(vi_['mne.evaluation.field.document'], uuid(31).toUpperCase());
    fireEvent.click(within(dialog()).getByRole('button', { name: vi_['mne.evaluation.submit.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(sent(h)[0]).toMatchObject({
      name: 'submitMneEvaluation',
      path: { id: uuid(21) },
      ifMatchVersion: 1,
      body: { findings: [{ text: 'Tiến độ đúng kế hoạch' }, { text: 'Chất lượng đạt yêu cầu' }], conclusion: 'SATISFACTORY', completed_date: '2026-10-30', recommendations_text: 'Giữ nhịp thi công', report_document_id: uuid(31) },
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('submits a returned evaluation again from what it said, so that what is not changed is not lost', async () => {
    const findings = [{ text: 'Tiến độ đúng kế hoạch' }, { topic: 'Chất lượng', note: 'Đạt' }];
    const h = open({
      rows: [evaluation(1, { status: 'RETURNED', decision_reason: 'Thiếu căn cứ', findings, conclusion: 'PARTIALLY_SATISFACTORY', recommendations_text: 'Giữ nhịp', completed_date: '2026-10-20', report_document_id: uuid(31) })],
    });
    fireEvent.click(await screen.findByRole('button', { name: text('mne.evaluation.submit.aria', { project: 'DA-001', kind: vi_['mne.evaluation.kind.midterm'] }) }));
    expect((within(dialog()).getByLabelText(vi_['mne.evaluation.field.conclusion']) as HTMLSelectElement).value).toBe('PARTIALLY_SATISFACTORY');
    expect((within(dialog()).getByLabelText(vi_['mne.evaluation.field.completed']) as HTMLInputElement).value).toBe('2026-10-20');
    expect((within(dialog()).getByLabelText(vi_['mne.evaluation.field.document']) as HTMLInputElement).value).toBe(uuid(31));
    fill(vi_['mne.evaluation.field.conclusion'], 'SATISFACTORY');
    fireEvent.click(within(dialog()).getByRole('button', { name: vi_['mne.evaluation.submit.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(sent(h)[0]?.body).toEqual({ findings, conclusion: 'SATISFACTORY', completed_date: '2026-10-20', recommendations_text: 'Giữ nhịp', report_document_id: uuid(31) });
  });

  it('shows the content of the submission to who decides it', async () => {
    open({
      permissions: DECIDER,
      rows: [
        evaluation(1, {
          status: 'SUBMITTED',
          conclusion: 'SATISFACTORY',
          findings: [{ text: 'Tiến độ đúng kế hoạch' }],
          recommendations_text: 'Giữ nhịp thi công',
          completed_date: '2026-10-30',
          report_document_id: uuid(31),
          actions: { submit: false, decide: true },
        }),
      ],
    });
    fireEvent.click(await screen.findByRole('button', { name: text('mne.evaluation.decide.aria', { project: 'DA-001', kind: vi_['mne.evaluation.kind.midterm'] }) }));
    expect(within(dialog()).getByTestId('submission-scope').textContent).toBe('Đánh giá giữa kỳ các hạng mục chính');
    expect(within(dialog()).getByTestId('submission-findings').textContent).toBe('Tiến độ đúng kế hoạch');
    expect(within(dialog()).getByTestId('submission-recommendations').textContent).toBe('Giữ nhịp thi công');
    expect(within(dialog()).getByTestId('submission-completed').textContent).toBe('2026-10-30');
    expect(within(dialog()).getByTestId('submission-document').textContent).toBe(uuid(31));
  });

  it('shows the reason an evaluation was returned in the dialog that submits it again', async () => {
    open({ rows: [evaluation(1, { status: 'RETURNED', decision_reason: 'Thiếu phát hiện về tiến độ' })] });
    fireEvent.click(await screen.findByRole('button', { name: text('mne.evaluation.submit.aria', { project: 'DA-001', kind: vi_['mne.evaluation.kind.midterm'] }) }));
    expect(within(dialog()).getByTestId('returned-reason').textContent).toBe(text('mne.evaluation.submit.returned', { reason: 'Thiếu phát hiện về tiến độ' }));
  });

  it('AC-ST-MNE-009-1: decides a submitted evaluation, approving it or returning it with the reason, and offers the button to who may decide', async () => {
    const h = open({ permissions: DECIDER, rows: [evaluation(1, { status: 'SUBMITTED', conclusion: 'UNSATISFACTORY', findings: [{ text: 'a' }, { text: 'b' }], actions: { submit: false, decide: true } }), evaluation(2, { status: 'SUBMITTED', actions: { submit: false, decide: false } })] });
    await screen.findByTestId('evaluations');
    expect(screen.getAllByRole('button', { name: /^Quyết định đánh giá/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: text('mne.evaluation.decide.aria', { project: 'DA-001', kind: vi_['mne.evaluation.kind.midterm'] }) }));
    expect(within(dialog()).getByTestId('to-decide').textContent).toBe(text('mne.evaluation.decide.conclusion', { conclusion: vi_['mne.evaluation.conclusion.unsatisfactory'], findings: 2 }));
    fireEvent.click(within(dialog()).getByRole('button', { name: vi_['mne.evaluation.decide.submit'] }));
    expect((await within(dialog()).findAllByText(vi_['mne.evaluation.field.required.error'])).length).toBe(2);
    fill(vi_['mne.evaluation.field.decision'], 'return');
    fill(vi_['mne.evaluation.field.reason'], 'abc');
    expect(within(dialog()).getByText(vi_['mne.evaluation.field.short.error'])).toBeTruthy();
    fill(vi_['mne.evaluation.field.reason'], '  Kết luận chưa đủ căn cứ  ');
    fireEvent.click(within(dialog()).getByRole('button', { name: vi_['mne.evaluation.decide.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(sent(h)[0]).toMatchObject({ name: 'decideMneEvaluation', path: { id: uuid(21) }, ifMatchVersion: 1, body: { decision: 'return', reason: 'Kết luận chưa đủ căn cứ' } });
  });

  it('tells a submitted evaluation without a conclusion apart, and approves one', async () => {
    const h = open({ permissions: DECIDER, rows: [evaluation(1, { status: 'SUBMITTED', actions: { submit: false, decide: true } })] });
    fireEvent.click(await screen.findByRole('button', { name: text('mne.evaluation.decide.aria', { project: 'DA-001', kind: vi_['mne.evaluation.kind.midterm'] }) }));
    expect(within(dialog()).getByTestId('to-decide').textContent).toBe(vi_['mne.evaluation.decide.noConclusion']);
    fill(vi_['mne.evaluation.field.decision'], 'approve');
    fill(vi_['mne.evaluation.field.reason'], 'Đủ căn cứ để phê duyệt');
    fireEvent.click(within(dialog()).getByRole('button', { name: vi_['mne.evaluation.decide.submit'] }));
    await waitFor(() => expect(sent(h)[0]?.body).toEqual({ decision: 'approve', reason: 'Đủ căn cứ để phê duyệt' }));
  });

  it.each([
    ['SELF_APPROVAL_DENIED', 403, vi_['mne.evaluation.problem.selfApproval']],
    ['VERSION_CONFLICT', 409, vi_['mne.evaluation.problem.versionConflict']],
    ['VALIDATION_FAILED', 422, vi_['mne.evaluation.problem.validation']],
    ['SCOPE_DENIED', 403, vi_['mne.evaluation.problem.scopeDenied']],
    ['RESOURCE_NOT_FOUND', 404, vi_['mne.evaluation.problem.notFound']],
    ['INTERNAL', 500, vi_['mne.evaluation.problem.general']],
  ] as const)('says in words why the server refused to decide with %s', async (code, status, message) => {
    open({ permissions: DECIDER, rows: [evaluation(1, { status: 'SUBMITTED', actions: { submit: false, decide: true } })], command: () => new ApiError({ status, code, correlationId: 'c' }) });
    fireEvent.click(await screen.findByRole('button', { name: text('mne.evaluation.decide.aria', { project: 'DA-001', kind: vi_['mne.evaluation.kind.midterm'] }) }));
    fill(vi_['mne.evaluation.field.decision'], 'approve');
    fill(vi_['mne.evaluation.field.reason'], 'Đủ căn cứ để phê duyệt');
    fireEvent.click(within(dialog()).getByRole('button', { name: vi_['mne.evaluation.decide.submit'] }));
    expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(message);
  });

  it('keeps the dialog, its form and its refusal when the evaluation was moved by somebody else, and sends the version the form was loaded from until it is opened again', async () => {
    const rows = [evaluation(1)];
    let moved = false;
    const h = open({
      rows,
      // Somebody else moves the evaluation on the first call; a call after that is judged by the version it carries.
      command: (_operation, input) => {
        if (!moved) {
          moved = true;
          (rows[0] as { version: number }).version = 2;
          return new ApiError({ status: 409, code: 'VERSION_CONFLICT', correlationId: 'c' });
        }
        return (input as { ifMatchVersion: number }).ifMatchVersion === (rows[0] as { version: number }).version ? OK : new ApiError({ status: 409, code: 'VERSION_CONFLICT', correlationId: 'c' });
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: text('mne.evaluation.submit.aria', { project: 'DA-001', kind: vi_['mne.evaluation.kind.midterm'] }) }));
    fill(vi_['mne.evaluation.field.conclusion'], 'SATISFACTORY');
    fill(vi_['mne.evaluation.field.completed'], '2026-10-30');
    fireEvent.click(within(dialog()).getByRole('button', { name: vi_['mne.evaluation.submit.submit'] }));
    expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_['mne.evaluation.problem.versionConflict']);
    await waitFor(() => expect(h.readAll.mock.calls.filter((call) => call[0] === 'listMneEvaluations').length).toBeGreaterThanOrEqual(2));
    fireEvent.click(within(dialog()).getByRole('button', { name: vi_['mne.evaluation.submit.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    // The form still says what it said; the version is the one it was loaded from, so a change in the meantime is a conflict and never an overwrite.
    expect([sent(h)[0]?.ifMatchVersion, sent(h)[1]?.ifMatchVersion]).toEqual([1, 1]);
    fireEvent.click(within(dialog()).getByRole('button', { name: vi_['mne.evaluation.dialog.cancel'] }));
    fireEvent.click(await screen.findByRole('button', { name: text('mne.evaluation.submit.aria', { project: 'DA-001', kind: vi_['mne.evaluation.kind.midterm'] }) }));
    fill(vi_['mne.evaluation.field.conclusion'], 'SATISFACTORY');
    fill(vi_['mne.evaluation.field.completed'], '2026-10-30');
    fireEvent.click(within(dialog()).getByRole('button', { name: vi_['mne.evaluation.submit.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(3));
    expect(sent(h)[2]?.ifMatchVersion).toBe(2);
  });

  it('gives a reader the list and no button, takes no command in the read-only mode, and says so to who may not read', async () => {
    open({ permissions: READER, rows: [evaluation(1, { actions: { submit: false, decide: false } })] });
    await screen.findByTestId('evaluations');
    expect(screen.queryByRole('button', { name: vi_['mne.evaluation.plan.action'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['mne.evaluation.submit.action'] })).toBeNull();
    cleanup();
    open({ mode: 'READ_ONLY', rows: [evaluation(1)] });
    await screen.findByTestId('evaluations');
    expect(screen.queryByRole('button', { name: vi_['mne.evaluation.plan.action'] })).toBeNull();
    expect(screen.queryByRole('button', { name: text('mne.evaluation.submit.aria', { project: 'DA-001', kind: vi_['mne.evaluation.kind.midterm'] }) })).toBeNull();
    cleanup();
    open({ permissions: [] });
    expect((await screen.findByTestId('no-read')).textContent).toBe(vi_['mne.evaluation.read.denied']);
  });

  it('offers a retry when the evaluations could not be read', async () => {
    const h = open({ failing: true });
    fireEvent.click(await screen.findByRole('button', { name: vi_['states.retry.action'] }));
    await waitFor(() => expect(h.readAll.mock.calls.filter((call) => call[0] === 'listMneEvaluations').length).toBeGreaterThanOrEqual(2));
  });
});

describe('the model of MNE-08', () => {
  it('reads an evaluation and leaves out what is not one', () => {
    expect(toEvaluation(undefined)).toBeUndefined();
    expect(toEvaluation({ id: 'a' })).toBeUndefined();
    expect(toEvaluation(evaluation(1, { evaluation_kind: 'ODD' }))).toBeUndefined();
    expect(toEvaluation(evaluation(1, { status: 'ODD' }))).toBeUndefined();
    expect(toEvaluation(evaluation(1, { version: '1' }))).toBeUndefined();
    expect(toEvaluation(evaluation(1, { project: { id: PROJECT } }))).toMatchObject({ projectCode: '', projectName: '' });
    expect(toEvaluation(evaluation(1, { findings: 'x', conclusion: 'ODD', evaluator_name: undefined, scope_text: undefined, actions: undefined }))).toMatchObject({
      findings: [],
      conclusion: null,
      evaluatorName: '',
      scopeText: '',
      mayChange: false,
      mayDecide: false,
    });
  });

  it('writes the findings as lines and reads the lines back as the findings', () => {
    expect(findingLine({ text: 'a finding' })).toBe('a finding');
    expect(findingLine({ text: '{not an object' })).toBe(JSON.stringify({ text: '{not an object' }));
    // A text that the lines could not give back as it is stays an object: a line break, a margin, nothing.
    for (const odd of ['first' + NEWLINE + 'second', ' padded ', '', '   ']) {
      const line = findingLine({ text: odd });
      expect(line).toBe(JSON.stringify({ text: odd }));
      expect(submitBody({ ...EMPTY_SUBMIT, conclusion: 'SATISFACTORY', completedDate: '2026-10-30', findings: line }).findings).toEqual([{ text: odd }]);
    }
    expect(findingLine({ topic: 'a', note: 'b' })).toBe(JSON.stringify({ topic: 'a', note: 'b' }));
    const base = toEvaluation(evaluation(1, { findings: [{ text: 'one' }, { topic: 'two' }, { text: '{three' }], conclusion: 'UNSATISFACTORY' }));
    if (base === undefined) throw new Error('not an evaluation');
    const form = submitFormOf(base);
    expect(form).toMatchObject({ conclusion: 'UNSATISFACTORY', recommendations: '', completedDate: '', reportDocument: '' });
    expect(submitBody({ ...form, completedDate: '2026-10-30' }).findings).toEqual([{ text: 'one' }, { topic: 'two' }, { text: '{three' }]);
    // A line that begins with a brace and is not an object is a text.
    expect(submitBody({ ...EMPTY_SUBMIT, conclusion: 'SATISFACTORY', completedDate: '2026-10-30', findings: ['{broken', '[1, 2]', '{"a":1}'].join(NEWLINE) }).findings).toEqual([{ text: '{broken' }, { text: '[1, 2]' }, { a: 1 }]);
  });

  it('holds the right to plan only outside the read-only mode', () => {
    expect(holds(undefined, 'x')).toBe(true);
    expect(holds(['y'], 'x')).toBe(false);
    expect(canPlan(['mne.evaluation.manage'], 'FULL')).toBe(true);
    expect(canPlan(['mne.evaluation.manage'], 'READ_ONLY')).toBe(false);
    expect(canPlan(['mne.read'], 'FULL')).toBe(false);
    expect(canPlan(undefined, undefined)).toBe(true);
  });

  it('validates the plan, the submission and the decision, and builds the bodies', () => {
    const plan = { ...EMPTY_PLAN, projectId: 'p', kind: 'FINAL', evaluatorName: ' AB ', scopeText: ' 0123456789 ', plannedDate: '2026-12-01' };
    expect(validatePlan(plan)).toEqual({});
    expect(validatePlan(EMPTY_PLAN)).toEqual({ projectId: 'required', kind: 'required', evaluatorName: 'required', scopeText: 'required', plannedDate: 'required' });
    expect(validatePlan({ ...plan, kind: 'ODD', evaluatorKind: 'ODD', evaluatorName: 'x', scopeText: 'x'.repeat(2001), plannedDate: 'soon' })).toEqual({
      kind: 'invalid',
      evaluatorKind: 'invalid',
      evaluatorName: 'invalid',
      scopeText: 'invalid',
      plannedDate: 'invalid',
    });
    expect(planBody(plan)).toEqual({ project_id: 'p', evaluation_kind: 'FINAL', evaluator_kind: 'INTERNAL', evaluator_name: 'AB', scope_text: '0123456789', planned_date: '2026-12-01' });

    const today = '2026-10-31';
    const filled = { ...EMPTY_SUBMIT, conclusion: 'SATISFACTORY', completedDate: today };
    expect(validateSubmit(filled, today)).toEqual({});
    expect(validateSubmit(EMPTY_SUBMIT, today)).toEqual({ conclusion: 'required', completedDate: 'required' });
    expect(validateSubmit({ ...filled, conclusion: 'GOOD', completedDate: '2026-11-01', recommendations: 'x'.repeat(2001), reportDocument: 'x' }, today)).toEqual({
      conclusion: 'invalid',
      completedDate: 'future',
      recommendations: 'invalid',
      reportDocument: 'invalid',
    });
    expect(validateSubmit({ ...filled, completedDate: '2026-02-30' }, today)).toEqual({ completedDate: 'invalid' });
    expect(submitBody(filled)).toEqual({ findings: [], conclusion: 'SATISFACTORY', completed_date: today });

    expect(validateDecide({ decision: 'approve', reason: 'Đủ căn cứ' })).toEqual({});
    expect(validateDecide(EMPTY_DECIDE)).toEqual({ decision: 'required', reason: 'required' });
    expect(validateDecide({ decision: 'x', reason: 'abcd' })).toEqual({ decision: 'required', reason: 'short' });
    expect(validateDecide({ decision: 'return', reason: 'x'.repeat(2001) })).toEqual({ reason: 'invalid' });
    expect(decideBody({ decision: 'approve', reason: ' Đủ căn cứ ' })).toEqual({ decision: 'approve', reason: 'Đủ căn cứ' });
    expect(decideBody({ decision: 'return', reason: 'Chưa đủ' }).decision).toBe('return');
  });

  it('reads the refusal of the server and counts the day in Vietnam', () => {
    expect(describeRefusal(new Error('boom'))).toEqual({ problem: 'general', kind: null, projectStatus: null, windowPassed: false });
    expect(describeRefusal(new ApiError({ status: 409, code: 'STAGE_TRANSITION_DENIED', correlationId: 'c', extensions: { evaluation_kind: 'FINAL', project_status: 'CLOSED' } }))).toEqual({ problem: 'stage', kind: 'FINAL', projectStatus: 'CLOSED', windowPassed: false });
    expect(describeRefusal(new ApiError({ status: 418, code: 'TEAPOT', correlationId: 'c' })).problem).toBe('general');
    expect(vietnamToday(new Date('2026-10-31T16:59:59Z'))).toBe('2026-10-31');
    expect(vietnamToday(new Date('2026-10-31T17:00:00Z'))).toBe('2026-11-01');
  });
});
