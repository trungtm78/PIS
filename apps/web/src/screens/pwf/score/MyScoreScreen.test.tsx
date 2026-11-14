import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../../../test/axe';
import { mount } from '../../sas/test-support';
import type { Answer } from '../test/fixtures';
import MyScoreScreen from './MyScoreScreen';
import { LINE_ID, OWN_ONLY, adjustment, comparison, contribution, kpiResult, line, myScore, refusal, response, routeOf, serve, text, uuid } from './test/fixtures';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const route = routeOf('PWF-11');

interface Setup {
  mine?: Answer;
  compare?: Answer;
  permissions?: readonly string[];
  commands?: Record<string, Answer>;
  results?: Answer;
}

const open = (setup: Setup = {}) => {
  const h = serve(
    {
      getMyStaffScore: setup.mine ?? { items: [myScore()], next_cursor: null, as_of: '2026-11-12T03:00:00.000Z' },
      compareStaffScoreLines: setup.compare ?? comparison(),
      listTaskKpiResults: setup.results ?? { items: [kpiResult(1)], next_cursor: null, as_of: '2026-11-12T03:00:00.000Z' },
    },
    setup.commands ?? { submitStaffScoreResponse: { operation_id: uuid(9), status: 'OPEN', resource_version: 1 } },
  );
  mount(<MyScoreScreen route={route} />, h, setup.permissions ?? OWN_ONLY, '/pwf/pwf-11');
  return h;
};

const page = (...items: ReturnType<typeof myScore>[]) => ({ items, next_cursor: null, as_of: '2026-11-12T03:00:00.000Z' });

describe('PWF-11: my score', () => {
  it('offers the older periods when the person has more than a page of them, and asks for them with the cursor', async () => {
    const h = open({ mine: { items: [myScore()], next_cursor: 'older', as_of: '2026-11-12T03:00:00.000Z' } });
    fireEvent.click(await screen.findByRole('button', { name: text('pwfs.my.more.action') }));
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('getMyStaffScore', expect.objectContaining({ query: expect.objectContaining({ cursor: 'older' }) })));
  });

  it('shows the score of the period with its rating, the policy it follows, the hash and the day responses are accepted until', async () => {
    open();
    const card = await screen.findByTestId('my-period');
    expect(within(card).getByTestId('score-computed').textContent).toBe('82.5');
    // The grade is said in words; its code stays on the element.
    expect(within(card).getByTestId('rating').textContent).toBe(text('pwf6.grade.good.word'));
    expect(within(card).getByTestId('rating').getAttribute('data-rating')).toBe('GOOD');
    expect(within(card).getByTestId('policy-basis').textContent).toBe(text('pwf6.score.policy.text', { version: text('pwf6.version.numbered.text', { version: 2 }) }));
    expect(within(card).getByTestId('window').textContent).toBe('15/01/2027');
    expect(within(card).getByTestId('hash').textContent).toBe('ab12cd34ef56ab12');
    expect(screen.getByTestId('support-notice').textContent).toContain(text('pwfs.common.support.note'));
  });

  it('traces the score to tasks: the share, the weight, the score, the assignment span, and says "restricted" for a task it may not open', async () => {
    open();
    const card = await screen.findByTestId('my-period');
    const link = within(card).getByRole('link', { name: /T1/ });
    expect(link.getAttribute('href')).toBe(`/pwf/pwf-04?id=${uuid(1001)}`);
    expect(within(card).getAllByText(text('pwfs.contribution.span.text', { role: text('pwf.role.responsible.word'), from: '01/10/2026', to: text('pwfs.contribution.open.text'), share: 50 })).length).toBeGreaterThan(0);
    expect(within(card).getAllByText('50%')).toHaveLength(2);
    expect(within(card).getByTestId('restricted').textContent).toContain(text('pwfs.contribution.restricted.text'));
    expect(within(card).getByTestId('excluded').textContent).toContain(text('pwfs.excluded.noShare.word'));
  });

  it('opens the facts behind a task: the KPI results with their formula, the hash and the inputs', async () => {
    const h = open();
    const card = await screen.findByTestId('my-period');
    fireEvent.click(within(card).getByRole('button', { name: text('pwfs.contribution.showFacts.action') }));
    const facts = await screen.findByTestId(`facts-${uuid(1001)}`);
    expect(h.read).toHaveBeenCalledWith('listTaskKpiResults', { path: { task_id: uuid(1001) } });
    expect(within(facts).getByText('PWF_TASK_DEVIATION_DAYS')).toBeTruthy();
    expect(within(facts).getByText('baselineDueFirst')).toBeTruthy();
    expect(within(facts).getByText('2026-12-08')).toBeTruthy();
  });

  it('explains the score with the "i": the formula, the policy, the hash of the snapshot and the version', async () => {
    open();
    await screen.findByTestId('my-period');
    fireEvent.click(screen.getAllByRole('button', { name: new RegExp(text('pwfs.info.name.text')) })[0] as HTMLElement);
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText(text('pwfs.info.formula.text'))).toBeTruthy();
    expect(within(panel).getByText(text('pwfs.info.source.text', { policy: 'DEFAULT', hash: 'ab12cd34ef56' }))).toBeTruthy();
    expect(within(panel).getByText(text('pwf6.score.policy.text', { version: text('pwf6.version.numbered.text', { version: 2 }) }))).toBeTruthy();
  });

  it('says "not enough data" instead of a rating for a small sample, and shows the number', async () => {
    open({ mine: page(myScore({ line: line({ state: 'SMALL_SAMPLE', rating: null, score_computed: 91, rated_task_count: 2, effective_weight: 2 }) })) });
    const card = await screen.findByTestId('my-period');
    expect(within(card).getByText(text('pwfs.state.smallSample.word'))).toBeTruthy();
    expect(within(card).getByTestId('state-hint').textContent).toBe(text('pwfs.state.smallSample.hint'));
    expect(within(card).queryByTestId('rating')).toBeNull();
    expect(within(card).getByTestId('score-computed').textContent).toBe('91');
  });

  it('shows both the computed and the adjusted score, and every adjustment with its reason and decision', async () => {
    open({
      mine: page(myScore({ line: line({ score_computed: 82.5, score_adjusted: 85.5, adjustments: [adjustment(1, { status: 'APPROVED', decided_by: uuid(72), decided_at: '2027-01-08T02:00:00.000Z' }), adjustment(2, { points: -2, status: 'REJECTED', reason: 'Đề nghị không đủ căn cứ để điều chỉnh', decided_by: uuid(72), decided_at: '2027-01-08T03:00:00.000Z' })] }) })),
    });
    await screen.findByTestId('my-period');
    expect(screen.getByTestId('score-computed').textContent).toBe('82.5');
    expect(screen.getByTestId('score-adjusted').textContent).toBe('85.5');
    const list = screen.getByTestId('adjustments');
    expect(within(list).getByText(text('pwfs.adjustment.approved.word'))).toBeTruthy();
    expect(within(list).getByText(text('pwfs.adjustment.rejected.word'))).toBeTruthy();
    expect(within(list).getByText('+3')).toBeTruthy();
    expect(within(list).getByText('Đề nghị không đủ căn cứ để điều chỉnh')).toBeTruthy();
  });

  it('never shows the flags of the reviewers to the person scored, even when the line carries them', async () => {
    open({ mine: page(myScore({ line: line({ flags: ['CANCELLED_SHARE_HIGH'] }) })) });
    await screen.findByTestId('my-period');
    expect(screen.queryByTestId('flags')).toBeNull();
    expect(screen.queryByText(text('pwfs.flag.cancelledShare.word'))).toBeNull();
  });

  it('compares the periods, with the change between two rated ones', async () => {
    open();
    const table = await screen.findByTestId('comparison');
    expect(within(table).getByText('+15.5')).toBeTruthy();
    expect(screen.queryByTestId('no-ranking')).toBeNull();
  });

  it('says periods are not ranked against each other when their samples differ', async () => {
    open({ compare: comparison({ sample_sizes_differ: true }) });
    expect((await screen.findByTestId('no-ranking')).textContent).toBe(text('pwfs.compare.noRanking.note'));
  });

  it('shows the responses with their status and the conclusion of a handled one', async () => {
    open({ mine: page(myScore({ line: line({ responses: [response(1), response(2, { status: 'HANDLED', conclusion: 'Giữ nguyên điểm sau khi xem xét', handled_at: '2027-01-09T02:00:00.000Z', approval_instance_id: uuid(88) })] }) })) });
    const list = await screen.findByTestId('responses');
    expect(within(list).getByText(text('pwfs.response.open.word'))).toBeTruthy();
    expect(within(list).getByText(text('pwfs.response.handled.word'))).toBeTruthy();
    expect(within(list).getByTestId('conclusion').textContent).toContain('Giữ nguyên điểm sau khi xem xét');
    expect(within(list).getByText(text('pwfs.response.workflow.text'))).toBeTruthy();
  });
});

describe('PWF-11: the response to the score', () => {
  it('refuses a response shorter than twenty characters, in words, and sends nothing', async () => {
    const h = open();
    await screen.findByTestId('response-form');
    fireEvent.change(screen.getByTestId('field-response-body'), { target: { value: 'ngắn quá' } });
    fireEvent.click(screen.getByRole('button', { name: text('pwfs.response.send.action') }));
    expect((await screen.findByTestId('error-response-body')).textContent).toContain(text('pwfs.form.tooShort.error', { min: 20 }));
    expect(h.command).not.toHaveBeenCalled();
  });

  it('sends a response of the person for their own line, once, and clears the form', async () => {
    const h = open();
    await screen.findByTestId('response-form');
    const body = 'Tôi đề nghị xem lại việc T2 vì bị trả lại do thiếu hồ sơ';
    fireEvent.change(screen.getByTestId('field-response-body'), { target: { value: body } });
    fireEvent.click(screen.getByRole('button', { name: text('pwfs.response.send.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith('submitStaffScoreResponse', expect.objectContaining({ path: { id: LINE_ID }, body: { body } }));
    await waitFor(() => expect((screen.getByTestId('field-response-body') as HTMLTextAreaElement).value).toBe(''));
  });

  it('says the window is closed when the server refuses, and keeps the text', async () => {
    open({ commands: { submitStaffScoreResponse: refusal('STAFF_SCORE_RESPONSE_WINDOW_CLOSED', 422) } });
    await screen.findByTestId('response-form');
    const body = 'Tôi đề nghị xem lại việc T2 vì bị trả lại do thiếu hồ sơ';
    fireEvent.change(screen.getByTestId('field-response-body'), { target: { value: body } });
    fireEvent.click(screen.getByRole('button', { name: text('pwfs.response.send.action') }));
    expect((await screen.findByTestId('problem')).textContent).toContain(text('pwfs.problem.windowClosed.error'));
    expect((screen.getByTestId('field-response-body') as HTMLTextAreaElement).value).toBe(body);
  });

  it('offers no form when the server says the person cannot respond', async () => {
    open({ mine: page(myScore({ line: line({ can_respond: false }) })) });
    expect((await screen.findByTestId('response-closed')).textContent).toBe(text('pwfs.my.responseClosed.note'));
    expect(screen.queryByTestId('response-form')).toBeNull();
  });
});

describe('PWF-11: the states', () => {
  it('shows the denied state to a membership that holds no right to a score, without asking the server', () => {
    const h = open({ permissions: [] });
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('shows the empty state when there is no period yet', async () => {
    open({ mine: page() });
    expect(await screen.findByText(text('states.empty.title'))).toBeTruthy();
  });

  it('shows the error state when the read fails', async () => {
    open({ mine: refusal('INTERNAL', 500) });
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('shows the denied state when the server refuses the scope', async () => {
    open({ mine: refusal('SCOPE_DENIED', 403) });
    expect(await screen.findByText(text('states.denied.title'))).toBeTruthy();
  });

  it('has no serious accessibility violation', async () => {
    open({ mine: page(myScore({ line: line({ adjustments: [adjustment(1, { status: 'APPROVED' })], responses: [response(1)], contributions: [contribution(1), contribution(2, { task_id: null, name: '' })] }) })) });
    await screen.findByTestId('my-period');
    await screen.findByTestId('comparison');
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });
});

