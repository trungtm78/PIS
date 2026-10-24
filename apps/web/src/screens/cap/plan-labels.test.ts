import { describe, expect, it } from 'vitest';
import en from '../../i18n/en.json';
import vi_ from '../../i18n/vi.json';
import { bucketLabel, gridProblemMessage, kindLabel, planFormProblemMessage, planProblemMessage, planStatusLabel, proposalProblemMessage } from './plan-labels';
import { BUCKETS, PLAN_KINDS, PLAN_STATUSES } from './plan-model';
import type { GridProblem, PlanFormProblem, PlanProblemReason, ProposalProblem } from './plan-model';

const vi = (key: string, params: Record<string, string | number> = {}): string => (vi_ as Record<string, string>)[key]?.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`)) ?? `?${key}`;
const t = ((key: string, params?: Record<string, string | number>) => vi(key, params)) as Parameters<typeof kindLabel>[0];

describe('the words of the planning screens', () => {
  it('names the kinds, statuses and buckets, each in both languages', () => {
    expect(PLAN_KINDS.map((kind) => kindLabel(t, kind))).toEqual(['Kế hoạch năm', 'Kế hoạch trung hạn']);
    expect(PLAN_STATUSES.map((status) => planStatusLabel(t, status))).toEqual(['Nháp', 'Chờ duyệt', 'Đã duyệt', 'Đã công bố', 'Đã thay thế', 'Bị từ chối']);
    expect(BUCKETS.map((bucket) => bucketLabel(t, bucket))).toEqual(['Vốn năm', 'Vốn kéo dài', 'Khác']);
    expect(en['cap.planStatus.inReview.label']).toBe('In review');
  });

  it('has a sentence for every problem of a form and of the grid', () => {
    const proposal: ProposalProblem[] = ['required', 'invalidAmount', 'subsetExceeds', 'exceedsRemaining'];
    const plan: PlanFormProblem[] = ['required', 'invalidYear', 'tooLong', 'periodOrder'];
    const grid: GridProblem[] = ['invalidAmount', 'subsetExceeds'];
    for (const message of [...proposal.map((problem) => proposalProblemMessage(t, problem)), ...plan.map((problem) => planFormProblemMessage(t, problem)), ...grid.map((problem) => gridProblemMessage(t, problem))]) {
      expect(message.startsWith('?')).toBe(false);
      expect(message.length).toBeGreaterThan(5);
    }
  });

  it('has a sentence for every refusal of a command, with the amount that was available when the ceiling was exceeded', () => {
    const reasons: PlanProblemReason[] = [
      'ceilingExceeded', 'subsetExceeds', 'planNotDraft', 'yearLocked', 'stageInvalid', 'appropriationNotPublished', 'planCodeDuplicate', 'versionConflict', 'notAllowed', 'validation', 'notFound', 'denied', 'general',
    ];
    const messages = reasons.map((reason) => planProblemMessage(t, { reason, field: undefined, availableVnd: undefined }, 'vi'));
    expect(new Set(messages).size).toBe(reasons.length);
    expect(messages.every((message) => !message.startsWith('?'))).toBe(true);
    expect(planProblemMessage(t, { reason: 'ceilingExceeded', field: undefined, availableVnd: '5000000000' }, 'vi')).toBe('Nguồn chỉ còn 5.000.000.000 đồng; không thể phân bổ quá số này.');
    expect(planProblemMessage(t, { reason: 'validation', field: 'amount_vnd', availableVnd: undefined }, 'vi')).toBe('Trường amount_vnd chưa hợp lệ.');
  });
});
