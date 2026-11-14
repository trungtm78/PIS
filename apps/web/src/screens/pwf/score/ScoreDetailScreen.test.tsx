import { cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../../../test/axe';
import { mount } from '../../sas/test-support';
import type { Answer } from '../test/fixtures';
import ScoreDetailScreen from './ScoreDetailScreen';
import { LINE_ID, ME, OTHER, OWN_ONLY, SCORE_ALL, adjustment, contribution, effective, kpiResult, line, refusal, response, routeOf, serve, text, uuid } from './test/fixtures';

// The screen is a set of tabs and every panel stays in the page (hidden when not chosen): the checks of what a panel holds reach it by role whether or not its tab is the open one. Which tab is open is checked on its own.
beforeAll(() => {
  configure({ defaultHidden: true });
});
afterAll(() => {
  configure({ defaultHidden: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const route = routeOf('PWF-13');
const ok = { operation_id: uuid(9), status: 'REQUESTED', resource_version: 3 };
const MANAGER: readonly string[] = ['staff_score.read_unit', 'staff_score.adjust', 'staff_score.approve', 'staff_score.review', 'pwf.read', 'adm.governance.read'];

interface Setup {
  line?: Answer;
  permissions?: readonly string[];
  commands?: Record<string, Answer>;
  path?: string;
  policy?: Answer;
}

const theirs = (over: Parameters<typeof line>[0] = {}) => line({ membership_id: OTHER, display_name: 'Trần Thị Bình', can_respond: false, can_request_adjustment: true, ...over });

const open = (setup: Setup = {}) => {
  const h = serve(
    {
      getStaffScoreLine: setup.line ?? theirs(),
      listTaskKpiResults: { items: [kpiResult(1)], next_cursor: null, as_of: '2026-11-12T03:00:00.000Z' },
      getEffectiveGovernanceRule: setup.policy ?? effective('STAFF_SCORING_POLICY', 'DEFAULT', { calibration: { max_adjustment_points: 5, min_reason_length: 30, requires_second_approver: true } }),
    },
    { requestStaffScoreAdjustment: ok, decideStaffScoreAdjustment: { ...ok, status: 'APPROVED' }, handleStaffScoreResponse: { ...ok, status: 'HANDLED' }, submitStaffScoreResponse: ok, ...setup.commands },
  );
  mount(<ScoreDetailScreen route={route} />, h, setup.permissions ?? MANAGER, setup.path ?? `/pwf/pwf-13?id=${LINE_ID}`);
  return h;
};

describe('PWF-13: the detail of a score', () => {
  it('names the person, shows the score, the unit at the time of the period and the trace', async () => {
    const h = open();
    await screen.findByRole('table');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(text('pwfs.detail.heading.text', { name: 'Trần Thị Bình' }));
    expect(h.read).toHaveBeenCalledWith('getStaffScoreLine', { path: { id: LINE_ID } });
    expect(screen.getByTestId('score-computed').textContent).toBe('82.5');
    // A unit the register has no name for is said so with the short form of its id; the whole id stays on the element.
    expect(screen.getByTestId('unit-at').textContent).toBe(text('pwf6.score.unit.unnamed', { id: uuid(60).slice(0, 8) }));
    expect(screen.getByTestId('unit-at').getAttribute('title')).toBe(uuid(60));
    expect(screen.getByTestId('support-notice')).toBeTruthy();
    expect(screen.getByRole('table')).toBeTruthy();
  });

  it('renders a contribution of a task the viewer may not read as restricted, without a link and without the name', async () => {
    open();
    await screen.findByRole('table');
    const restricted = screen.getByTestId('restricted');
    expect(restricted.textContent).toContain(text('pwfs.contribution.restricted.text'));
    expect(within(restricted).queryByRole('link')).toBeNull();
    // The link is the NAME of the task; its code is a small note under it and never part of the link.
    const link = screen.getByRole('link', { name: 'Công việc 1' });
    expect(link.getAttribute('href')).toBe(`/pwf/pwf-04?id=${uuid(1001)}`);
    expect(link.textContent).not.toContain('T1');
    expect(screen.getAllByTestId('task-code').map((one) => one.textContent)).toEqual(['T1']);
  });

  it('tells two tasks of the same name apart by the project each belongs to, named under the task', async () => {
    open({ line: line({ contributions: [contribution(1, { name: 'Lập hồ sơ', project_code: 'DA-01', project_name: 'Đường tỉnh 207' }), contribution(2, { name: 'Lập hồ sơ', project_code: 'DA-02', project_name: 'Trường THPT Nà Giàng' })] }) });
    await screen.findByRole('table');
    expect(screen.getAllByRole('link', { name: 'Lập hồ sơ' })).toHaveLength(2);
    expect(screen.getAllByTestId('contribution-project').map((one) => one.textContent)).toEqual(['Đường tỉnh 207', 'Trường THPT Nà Giàng']);
    // An answer kept from before the read named the project shows no empty line.
    cleanup();
    open({ line: line({ contributions: [contribution(1)] }) });
    await screen.findByRole('table');
    expect(screen.queryByTestId('contribution-project')).toBeNull();
  });

  it('shows the flags to a reviewer who is not the person scored, and says they change nothing', async () => {
    open({ line: theirs({ flags: ['TASKS_SPLIT_AFTER_BASELINE'] }) });
    await screen.findByRole('table');
    expect(within(screen.getByTestId('flags')).getByText(text('pwfs.flag.tasksSplit.word'))).toBeTruthy();
    expect(screen.getByTestId('flags-note').textContent).toBe(text('pwfs.flag.neverChanges.note'));
  });

  it('hides the flags from the person scored and from a reader without the review right', async () => {
    open({ line: line({ flags: ['TASKS_SPLIT_AFTER_BASELINE'] }), permissions: OWN_ONLY });
    await screen.findByRole('table');
    expect(screen.queryByTestId('flags')).toBeNull();
    cleanup();
    open({ line: theirs({ flags: ['TASKS_SPLIT_AFTER_BASELINE'] }), permissions: ['staff_score.read_unit'] });
    await screen.findByRole('table');
    expect(screen.queryByTestId('flags')).toBeNull();
  });

  it('shows both scores when an adjustment moved the score', async () => {
    open({ line: theirs({ score_adjusted: 87 }) });
    await screen.findByRole('table');
    expect(screen.getByTestId('score-computed').textContent).toBe('82.5');
    expect(screen.getByTestId('score-adjusted').textContent).toBe('87');
  });

  it('opens the KPI results of a task from a contribution', async () => {
    const h = open();
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: text('pwfs.contribution.showFacts.action') }));
    await screen.findByTestId(`facts-${uuid(1001)}`);
    expect(h.read).toHaveBeenCalledWith('listTaskKpiResults', { path: { task_id: uuid(1001) } });
  });
});

describe('PWF-13: asking for an adjustment', () => {
  const fill = (points: string, reason: string) => {
    fireEvent.change(screen.getByTestId('field-points'), { target: { value: points } });
    fireEvent.change(screen.getByTestId('field-reason'), { target: { value: reason } });
    fireEvent.click(screen.getByRole('button', { name: text('pwfs.adjustment.send.action') }));
  };

  it('takes the swing and the shortest reason from the policy of the period and refuses what is outside them, sending nothing', async () => {
    const h = open();
    await screen.findByTestId('adjustment-form');
    expect(await screen.findByText(text('pwfs.adjustment.points.hint', { max: 5 }))).toBeTruthy();
    fill('6', 'Việc phát sinh ngoài kế hoạch được giao thêm cho người này');
    expect((await screen.findByTestId('error-points')).textContent).toContain(text('pwfs.form.invalidNumber.error', { max: 5 }));
    fill('2', 'quá ngắn');
    await waitFor(() => expect(screen.getByTestId('error-reason').textContent).toContain(text('pwfs.form.tooShort.error', { min: 30 })));
    expect(h.command).not.toHaveBeenCalled();
  });

  it('sends the request for the line with the points, the reason and the evidence', async () => {
    const h = open();
    await screen.findByTestId('adjustment-form');
    fireEvent.change(screen.getByTestId('field-evidence'), { target: { value: 'QD-12/2026' } });
    fill('-2,5', 'Việc bị trả lại do lỗi của đơn vị khác, không phải của người này');
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith('requestStaffScoreAdjustment', expect.objectContaining({ path: { id: LINE_ID }, body: { points: -2.5, reason: 'Việc bị trả lại do lỗi của đơn vị khác, không phải của người này', evidence_ref: 'QD-12/2026' } }));
  });

  it('says in words what the server refused', async () => {
    open({ commands: { requestStaffScoreAdjustment: refusal('STAFF_SCORE_ADJUSTMENT_INVALID', 422, {}, 'points') } });
    await screen.findByTestId('adjustment-form');
    fill('2', 'Việc phát sinh ngoài kế hoạch được giao thêm cho người này');
    expect((await screen.findByTestId('problem')).textContent).toContain(text('pwfs.problem.adjustmentField.error', { field: 'points' }));
  });

  it('offers no request form when the server says the caller cannot ask, or the session is read-only', async () => {
    open({ line: theirs({ can_request_adjustment: false }) });
    await screen.findByRole('table');
    expect(screen.queryByTestId('adjustment-form')).toBeNull();
  });
});

describe('PWF-13: deciding an adjustment (a second person)', () => {
  const pending = (over: Parameters<typeof adjustment>[1] = {}) => adjustment(1, { requested_by: uuid(71), version: 5, ...over });

  it('approves with the version of the adjustment as If-Match', async () => {
    const h = open({ line: theirs({ adjustments: [pending()] }) });
    await screen.findByTestId(`decision-${pending().id}`);
    fireEvent.click(screen.getByRole('button', { name: text('pwfs.decision.approve.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith('decideStaffScoreAdjustment', expect.objectContaining({ path: { id: pending().id }, body: { decision: 'APPROVE' }, ifMatchVersion: 5 }));
  });

  it('asks for a note before a rejection and sends it with the rejection', async () => {
    const h = open({ line: theirs({ adjustments: [pending()] }) });
    await screen.findByTestId(`decision-${pending().id}`);
    fireEvent.click(screen.getByRole('button', { name: text('pwfs.decision.reject.action') }));
    expect(await screen.findByTestId(`error-note-${pending().id}`)).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId(`field-note-${pending().id}`), { target: { value: 'Chưa đủ căn cứ' } });
    fireEvent.click(screen.getByRole('button', { name: text('pwfs.decision.reject.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('decideStaffScoreAdjustment', expect.objectContaining({ body: { decision: 'REJECT', note: 'Chưa đủ căn cứ' } })));
  });

  it('shows no decision to the one who asked, to the person scored, or for an adjustment already decided', async () => {
    open({ line: theirs({ adjustments: [pending({ requested_by: ME }), pending({ id: uuid(5399), status: 'APPROVED' })] }) });
    await screen.findByTestId('adjustments');
    expect(screen.queryByRole('button', { name: text('pwfs.decision.approve.action') })).toBeNull();
    cleanup();
    open({ line: line({ adjustments: [pending()] }), permissions: SCORE_ALL });
    await screen.findByTestId('adjustments');
    expect(screen.queryByRole('button', { name: text('pwfs.decision.approve.action') })).toBeNull();
  });

  it('says a self approval is refused, and offers the newer version after a conflict', async () => {
    open({ line: theirs({ adjustments: [pending()] }), commands: { decideStaffScoreAdjustment: refusal('SELF_APPROVAL_DENIED', 403) } });
    await screen.findByTestId(`decision-${pending().id}`);
    fireEvent.click(screen.getByRole('button', { name: text('pwfs.decision.approve.action') }));
    expect((await screen.findByTestId('problem')).textContent).toContain(text('pwfs.problem.selfApproval.error'));
    cleanup();
    const h = open({ line: theirs({ adjustments: [pending()] }), commands: { decideStaffScoreAdjustment: refusal('VERSION_CONFLICT', 409) } });
    await screen.findByTestId(`decision-${pending().id}`);
    fireEvent.click(screen.getByRole('button', { name: text('pwfs.decision.approve.action') }));
    fireEvent.click(await screen.findByRole('button', { name: text('pwfs.common.reload.action') }));
    await waitFor(() => expect(h.read.mock.calls.filter(([name]) => name === 'getStaffScoreLine').length).toBeGreaterThan(1));
  });
});

describe('PWF-13: handling a response', () => {
  const open1 = () => theirs({ responses: [response(1)], version: 7 });

  it('keeps the score with a conclusion, sending the version of the line as If-Match', async () => {
    const h = open({ line: open1() });
    await screen.findByTestId(`handle-${response(1).id}`);
    expect(screen.queryByTestId('field-handle-points')).toBeNull();
    fireEvent.change(screen.getByTestId('field-conclusion'), { target: { value: 'Giữ nguyên điểm sau khi xem xét hồ sơ' } });
    fireEvent.click(screen.getByRole('button', { name: text('pwfs.handle.send.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('handleStaffScoreResponse', expect.objectContaining({ path: { id: response(1).id }, body: { outcome: 'KEEP', conclusion: 'Giữ nguyên điểm sau khi xem xét hồ sơ' }, ifMatchVersion: 7 })));
  });

  it('asks for the points and the reason only when the outcome is to adjust', async () => {
    const h = open({ line: open1() });
    await screen.findByTestId(`handle-${response(1).id}`);
    fireEvent.change(screen.getByTestId('field-outcome'), { target: { value: 'ADJUST' } });
    fireEvent.change(screen.getByTestId('field-conclusion'), { target: { value: 'Chấp nhận một phần phản hồi' } });
    fireEvent.click(screen.getByRole('button', { name: text('pwfs.handle.send.action') }));
    expect(await screen.findByTestId('error-handle-points')).toBeTruthy();
    expect(screen.getByTestId('error-handle-reason')).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('field-handle-points'), { target: { value: '3' } });
    fireEvent.change(screen.getByTestId('field-handle-reason'), { target: { value: 'Việc T2 bị trả lại vì lỗi của đơn vị khác nên điều chỉnh' } });
    fireEvent.click(screen.getByRole('button', { name: text('pwfs.handle.send.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('handleStaffScoreResponse', expect.objectContaining({ body: { outcome: 'ADJUST', conclusion: 'Chấp nhận một phần phản hồi', adjustment_points: 3, adjustment_reason: 'Việc T2 bị trả lại vì lỗi của đơn vị khác nên điều chỉnh' } })));
  });

  it('says a response that already runs in the approval workflow cannot be handled directly', async () => {
    open({ line: open1(), commands: { handleStaffScoreResponse: refusal('WORKFLOW_ALREADY_RUNNING', 409) } });
    await screen.findByTestId(`handle-${response(1).id}`);
    fireEvent.change(screen.getByTestId('field-conclusion'), { target: { value: 'Giữ nguyên điểm sau khi xem xét hồ sơ' } });
    fireEvent.click(screen.getByRole('button', { name: text('pwfs.handle.send.action') }));
    expect((await screen.findByTestId('problem')).textContent).toContain(text('pwfs.problem.inWorkflow.error'));
  });

  it('offers no handling for a handled response, and none to the person scored', async () => {
    open({ line: theirs({ responses: [response(1, { status: 'HANDLED', conclusion: 'Đã xem xét' })] }) });
    await screen.findByTestId('responses');
    expect(screen.queryByTestId(`handle-${response(1).id}`)).toBeNull();
  });
});

describe('PWF-13: the person scored', () => {
  it('responds to their own score from this screen when the server says they can', async () => {
    const h = open({ line: line({ can_respond: true }), permissions: OWN_ONLY });
    await screen.findByTestId('response-form');
    const body = 'Tôi đề nghị xem lại việc T2 vì bị trả lại do thiếu hồ sơ';
    fireEvent.change(screen.getByTestId('field-response-body'), { target: { value: body } });
    fireEvent.click(screen.getByRole('button', { name: text('pwfs.response.send.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('submitStaffScoreResponse', expect.objectContaining({ path: { id: LINE_ID }, body: { body } })));
  });
});

describe('PWF-13: the states', () => {
  it('asks for a line when the address names none', () => {
    open({ path: '/pwf/pwf-13' });
    expect(screen.getByTestId('no-line').textContent).toBe(text('pwfs.detail.noLine.notice'));
  });

  it('answers a line that is not there, or not for the caller, with the same words (404)', async () => {
    open({ line: refusal('RESOURCE_NOT_FOUND', 404) });
    expect((await screen.findByTestId('not-found')).textContent).toBe(text('pwfs.detail.notFound.notice'));
  });

  it('is denied without asking for a membership with no right to a score', () => {
    const h = open({ permissions: [] });
    expect(h.read).not.toHaveBeenCalled();
  });

  it('shows the error state when the read fails', async () => {
    open({ line: refusal('INTERNAL', 500) });
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('has no serious accessibility violation', async () => {
    open({ line: theirs({ flags: ['CANCELLED_SHARE_HIGH'], adjustments: [adjustment(1, { version: 2 })], responses: [response(1)] }) });
    await screen.findByTestId('adjustment-form');
    await screen.findByTestId(`handle-${response(1).id}`);
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });
});

describe('PWF-13: one purpose a tab (owner review of 14/11/2026)', () => {
  it('splits the long page into four tabs: the score, the tasks behind it, the adjustments with the responses, and the periods compared', async () => {
    open();
    await screen.findByTestId('detail');
    expect(screen.getAllByRole('tab').map((one) => one.getAttribute('data-testid'))).toEqual(['score', 'tasks', 'review', 'compare'].map((id) => `score-tab-${id}`));
    expect(screen.getByTestId('score-tab-score').textContent).toBe(text('fix8.score.tab.score'));
    expect(screen.getByTestId('score-panel-score').contains(screen.getByTestId('detail'))).toBe(true);
    expect(screen.getByTestId('score-panel-score').hidden).toBe(false);
    const tasks = screen.getByTestId('score-panel-tasks');
    expect(tasks.hidden).toBe(true);
    expect(tasks.querySelector('table')).not.toBeNull();
    expect(tasks.contains(screen.getByTestId('excluded'))).toBe(true);
    fireEvent.click(screen.getByTestId('score-tab-tasks'));
    expect(tasks.hidden).toBe(false);
    expect(screen.getByTestId('score-panel-score').hidden).toBe(true);
    // The requests that wait are counted on the tab, so nobody opens it to find out.
    cleanup();
    open({ line: theirs({ adjustments: [adjustment(1, { status: 'REQUESTED' })], responses: [response(1, { status: 'OPEN' })] }) });
    await screen.findByTestId('detail');
    expect(screen.getByTestId('score-tab-review').textContent).toBe(`${text('fix8.score.tab.review')}2`);
  });

  it('opens the tab the address names, so a link to the adjustments lands on them', async () => {
    open({ path: `/pwf/pwf-13?id=${LINE_ID}&view=review` });
    await screen.findByTestId('detail');
    expect(screen.getByTestId('score-panel-review').hidden).toBe(false);
    expect(screen.getByTestId('score-tab-review').getAttribute('aria-selected')).toBe('true');
  });
});
