import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { adjustment, line, response, row } from './test/fixtures';
import { ME, OTHER, uuid } from './test/fixtures';
import {
  EMPTY_ADJUSTMENT,
  EMPTY_HANDLE,
  EMPTY_PERIOD,
  SCORE_PERMISSIONS,
  actionsOf,
  adjustmentBody,
  boardOrder,
  changeBetween,
  decisionBody,
  describeScoreProblem,
  effectiveScore,
  exportBlob,
  handleBody,
  hasAdjustedScore,
  isRestricted,
  isScoreConflict,
  lineLink,
  mayDo,
  mayWrite,
  periodBody,
  periodLink,
  pointsProblem,
  responseProblem,
  ratedSamplesDiffer,
  rankingBlock,
  scoreText,
  validateAdjustment,
  validateHandle,
  validatePeriod,
} from './model';

const limits = { ceiling: 10, reasonMin: 20 };
const refusal = (code: string, status = 422, detail?: string) => new ApiError({ status, code, correlationId: 'c', extensions: {}, ...(detail === undefined ? {} : { detail }) });

describe('what a score figure says', () => {
  it('shows the adjusted score only when an approved adjustment moved it, and the effective score is the adjusted one', () => {
    expect(hasAdjustedScore({ score_computed: 80, score_adjusted: null })).toBe(false);
    expect(hasAdjustedScore({ score_computed: 80, score_adjusted: 80 })).toBe(false);
    expect(hasAdjustedScore({ score_computed: 80, score_adjusted: 83 })).toBe(true);
    expect(effectiveScore({ score_computed: 80, score_adjusted: 83 })).toBe(83);
    expect(effectiveScore({ score_computed: 80, score_adjusted: null })).toBe(80);
    expect(effectiveScore({ score_computed: null, score_adjusted: null })).toBeNull();
  });

  it('writes a score with at most two decimals and a dash for no score', () => {
    expect(scoreText(null)).toBe('–');
    expect(scoreText(82)).toBe('82');
    expect(scoreText(82.5)).toBe('82.5');
    expect(scoreText(82.25)).toBe('82.25');
  });

  it('knows a contribution of a task the viewer may not read by its missing id', () => {
    expect(isRestricted({ task_id: null })).toBe(true);
    expect(isRestricted({ task_id: uuid(1) })).toBe(false);
  });
});

describe('the order of a scoreboard (BR-PWF-36)', () => {
  it('numbers only the rated, highest first, and lists a small sample or an unrated person after them with no place', () => {
    const rows = [row(1, { score_computed: 70 }), row(2, { state: 'SMALL_SAMPLE', rating: null, score_computed: 99, rated_task_count: 2 }), row(3, { score_computed: 90 }), row(4, { state: 'NOT_RATED', rating: null, score_computed: null })];
    const ordered = boardOrder(rows, true);
    expect(ordered.map((item) => [item.row.display_name, item.place])).toEqual([
      ['Người 3', 1],
      ['Người 1', 2],
      ['Người 2', null],
      ['Người 4', null],
    ]);
  });

  it('ranks by the adjusted score when there is one', () => {
    const rows = [row(1, { score_computed: 80, score_adjusted: 75, has_adjustment: true }), row(2, { score_computed: 78 })];
    expect(boardOrder(rows, true).map((item) => item.row.display_name)).toEqual(['Người 2', 'Người 1']);
  });

  it('gives no place to anybody when the rated people were judged on different numbers of tasks, and keeps the order given', () => {
    const rows = [row(1, { score_computed: 70, rated_task_count: 6 }), row(2, { score_computed: 90, rated_task_count: 9 })];
    expect(boardOrder(rows, true).map((item) => [item.row.display_name, item.place])).toEqual([['Người 1', null], ['Người 2', null]]);
    expect(rankingBlock(rows, true)).toBe('incomparable');
  });

  it('gives no place while the population is incomplete (the pages are cut by id, not by score)', () => {
    const rows = [row(1, { score_computed: 70 }), row(2, { score_computed: 90 })];
    expect(boardOrder(rows, false).every((item) => item.place === null)).toBe(true);
    expect(rankingBlock(rows, false)).toBe('partial');
    expect(rankingBlock(rows, true)).toBeNull();
  });

  it('says rated samples differ only for two rated people on different numbers of tasks: a small sample is not rated and is listed without a place anyway', () => {
    expect(ratedSamplesDiffer([row(1), row(2)])).toBe(false);
    expect(ratedSamplesDiffer([row(1), row(2, { rated_task_count: 9 })])).toBe(true);
    expect(ratedSamplesDiffer([row(1), row(2, { state: 'SMALL_SAMPLE', rating: null, rated_task_count: 2 })])).toBe(false);
  });
});

describe('who may do what on a line', () => {
  const requested = adjustment(1, { requested_by: uuid(71) });

  it('lets the person scored respond and never decide, and hides the flags from them', () => {
    const mine = line({ membership_id: ME, can_respond: true, flags: ['CANCELLED_SHARE_HIGH'] });
    const actions = actionsOf(mine, ME, Object.values(SCORE_PERMISSIONS), false);
    expect(actions.respond).toBe(true);
    expect(actions.seeFlags).toBe(false);
    expect(actions.decideAdjustment(requested)).toBe(false);
    expect(actions.handleResponse(response(1))).toBe(false);
  });

  it('lets an approver who is not the person scored and not the maker decide a requested adjustment and handle an open response', () => {
    const theirs = line({ membership_id: OTHER, can_respond: false, can_request_adjustment: true });
    const actions = actionsOf(theirs, ME, [SCORE_PERMISSIONS.approve, SCORE_PERMISSIONS.review], false);
    expect(actions.decideAdjustment(requested)).toBe(true);
    expect(actions.decideAdjustment(adjustment(2, { requested_by: ME }))).toBe(false);
    expect(actions.decideAdjustment(adjustment(3, { status: 'APPROVED' }))).toBe(false);
    expect(actions.handleResponse(response(1))).toBe(true);
    expect(actions.handleResponse(response(2, { status: 'HANDLED' }))).toBe(false);
    expect(actions.requestAdjustment).toBe(true);
    expect(actions.seeFlags).toBe(true);
  });

  it('gives a frozen (read-only) session no button that writes, and nobody without the right the approval or the flags', () => {
    const theirs = line({ membership_id: OTHER, can_request_adjustment: true });
    const frozen = actionsOf(theirs, ME, Object.values(SCORE_PERMISSIONS), true);
    expect(frozen.requestAdjustment).toBe(false);
    expect(frozen.decideAdjustment(requested)).toBe(false);
    const plain = actionsOf(theirs, ME, [SCORE_PERMISSIONS.readUnit], false);
    expect(plain.decideAdjustment(requested)).toBe(false);
    expect(plain.seeFlags).toBe(false);
  });

  it('judges a right only when the session says what is held', () => {
    expect(mayDo(undefined, SCORE_PERMISSIONS.manage)).toBe(true);
    expect(mayDo([], SCORE_PERMISSIONS.manage)).toBe(false);
    expect(mayWrite(undefined, SCORE_PERMISSIONS.manage, true)).toBe(false);
  });
});

describe('the refusals of the server in the words of the module', () => {
  it.each([
    ['VERSION_CONFLICT', 'versionConflict'],
    ['SELF_APPROVAL_DENIED', 'selfApproval'],
    ['STAFF_SCORE_PERIOD_OVERLAP', 'periodOverlap'],
    ['STAFF_SCORE_SHARE_INVALID', 'shareInvalid'],
    ['CALENDAR_NOT_EFFECTIVE', 'calendarNotEffective'],
    ['STAFF_SCORE_PERIOD_LOCKED', 'periodLocked'],
    ['STAFF_SCORE_ADJUSTMENT_INVALID', 'adjustmentInvalid'],
    ['STAFF_SCORE_RESPONSE_WINDOW_CLOSED', 'windowClosed'],
    ['WORKFLOW_ALREADY_RUNNING', 'inWorkflow'],
    ['VALIDATION_FAILED', 'validation'],
    ['SCOPE_DENIED', 'denied'],
  ])('maps %s to %s', (code, kind) => {
    expect(describeScoreProblem(refusal(code)).kind).toBe(kind);
  });

  it('keeps the field the server named, treats a 404 as not found and anything else as general', () => {
    expect(describeScoreProblem(refusal('STAFF_SCORE_ADJUSTMENT_INVALID', 422, 'points')).field).toBe('points');
    expect(describeScoreProblem(refusal('SOMETHING_NEW', 404)).kind).toBe('notFound');
    expect(describeScoreProblem(refusal('SOMETHING_NEW', 500)).kind).toBe('general');
    expect(describeScoreProblem(new Error('x')).kind).toBe('general');
    expect(isScoreConflict(describeScoreProblem(refusal('VERSION_CONFLICT', 409)))).toBe(true);
    expect(isScoreConflict(describeScoreProblem(refusal('SELF_APPROVAL_DENIED', 403)))).toBe(false);
  });
});

describe('the forms', () => {
  it('asks for a response of at least twenty characters', () => {
    expect(responseProblem('')).toBe('required');
    expect(responseProblem('quá ngắn')).toBe('tooShort');
    expect(responseProblem('x'.repeat(20))).toBeUndefined();
    expect(responseProblem('x'.repeat(2001))).toBe('tooLong');
  });

  it('takes points as a signed number inside the swing and refuses zero', () => {
    expect(pointsProblem('', 10)).toBe('required');
    expect(pointsProblem('abc', 10)).toBe('invalidNumber');
    expect(pointsProblem('0', 10)).toBe('invalidNumber');
    expect(pointsProblem('11', 10)).toBe('invalidNumber');
    expect(pointsProblem('-10', 10)).toBeUndefined();
    expect(pointsProblem('+2,5', 10)).toBeUndefined();
  });

  it('checks an adjustment request and builds its body without an empty evidence', () => {
    expect(Object.keys(validateAdjustment(EMPTY_ADJUSTMENT, limits)).sort()).toEqual(['points', 'reason']);
    const form = { points: '-2,5', reason: 'Việc bị trả lại do lỗi của đơn vị khác', evidenceRef: '' };
    expect(validateAdjustment(form, limits)).toEqual({});
    expect(adjustmentBody(form)).toEqual({ points: -2.5, reason: 'Việc bị trả lại do lỗi của đơn vị khác' });
    expect(adjustmentBody({ ...form, evidenceRef: ' QD-12 ' })).toMatchObject({ evidence_ref: 'QD-12' });
    expect(validateAdjustment({ ...form, evidenceRef: 'x'.repeat(301) }, limits).evidenceRef).toBe('tooLong');
    expect(validateAdjustment({ ...form, reason: 'ngắn' }, limits).reason).toBe('tooShort');
  });

  it('needs a note for a rejection and a note of at least five characters when one is given', () => {
    expect(decisionBody('REJECT', '')).toBe('required');
    expect(decisionBody('REJECT', 'abc')).toBe('tooShort');
    expect(decisionBody('APPROVE', '')).toEqual({ decision: 'APPROVE' });
    expect(decisionBody('APPROVE', '  Đồng ý  ')).toEqual({ decision: 'APPROVE', note: 'Đồng ý' });
  });

  it('asks for the points and the reason of an adjustment only when the outcome is ADJUST', () => {
    expect(Object.keys(validateHandle(EMPTY_HANDLE, limits))).toEqual(['conclusion']);
    const adjust = { outcome: 'ADJUST' as const, conclusion: 'Chấp nhận một phần', points: '', reason: '' };
    expect(Object.keys(validateHandle(adjust, limits)).sort()).toEqual(['points', 'reason']);
    expect(handleBody({ outcome: 'KEEP', conclusion: ' Giữ nguyên điểm ', points: '5', reason: 'ignored' })).toEqual({ outcome: 'KEEP', conclusion: 'Giữ nguyên điểm' });
    expect(handleBody({ ...adjust, points: '3', reason: 'Việc phát sinh ngoài kế hoạch' })).toEqual({ outcome: 'ADJUST', conclusion: 'Chấp nhận một phần', adjustment_points: 3, adjustment_reason: 'Việc phát sinh ngoài kế hoạch' });
  });

  it('checks the draft period: a unit id, two days in order and a policy code', () => {
    expect(Object.keys(validatePeriod(EMPTY_PERIOD)).sort()).toEqual(['from', 'to', 'unitId']);
    const form = { unitId: uuid(60), from: '2026-10-01', to: '2026-12-31', policy: 'DEFAULT' };
    expect(validatePeriod(form)).toEqual({});
    expect(validatePeriod({ ...form, to: '2026-09-30' }).to).toBe('invalidDay');
    expect(validatePeriod({ ...form, from: '2026-02-30' }).from).toBe('invalidDay');
    // A day that matches the shape but is no date at all must be a refusal, never an exception thrown while the form is drawn.
    for (const bad of ['2026-13-01', '2026-00-10', '2026-01-32', '2026-01-00', '0000-00-00', '2026-99-99']) {
      expect(() => validatePeriod({ ...form, from: bad })).not.toThrow();
      expect(validatePeriod({ ...form, from: bad }).from).toBe('invalidDay');
      expect(validatePeriod({ ...form, to: bad }).to).toBe('invalidDay');
    }
    expect(validatePeriod({ ...form, policy: 'default' }).policy).toBe('required');
    expect(periodBody({ ...form, unitId: ` ${uuid(60).toUpperCase()} ` })).toEqual({ scope_unit_id: uuid(60), period_from: '2026-10-01', period_to: '2026-12-31', policy_code: 'DEFAULT' });
  });
});

describe('the comparison of periods', () => {
  const point = (state: 'RATED' | 'SMALL_SAMPLE', score: number) => ({ period_id: uuid(1), period_from: '2026-01-01', period_to: '2026-03-31', period_status: 'OFFICIAL' as const, score_computed: score, score_adjusted: null, rating: state === 'RATED' ? 'GOOD' : null, state, rated_task_count: 5, effective_weight: 5 });

  it('says the change only between two rated periods', () => {
    expect(changeBetween(point('RATED', 70), point('RATED', 82.5))).toBe(12.5);
    expect(changeBetween(point('RATED', 90), point('RATED', 70))).toBe(-20);
    expect(changeBetween(undefined, point('RATED', 70))).toBeNull();
    expect(changeBetween(point('SMALL_SAMPLE', 70), point('RATED', 80))).toBeNull();
    expect(changeBetween(point('RATED', 70), point('SMALL_SAMPLE', 80))).toBeNull();
  });
});

describe('links and files', () => {
  it('links a line and a period by id', () => {
    expect(lineLink(uuid(1))).toBe(`/pwf/pwf-13?id=${uuid(1)}`);
    expect(periodLink(uuid(2))).toBe(`/pwf/pwf-14?id=${uuid(2)}`);
  });

  it('makes a file of the base64 an export answers with', async () => {
    const blob = exportBlob({ content_base64: btoa('xlsx-bytes'), content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    expect(blob?.type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(blob?.size).toBe(10);
  });
});
