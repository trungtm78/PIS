import { CRITICAL_SCORE, assertRiskClosure, assertRiskEntry, assertRiskLive, assertRiskMove, isCritical, riskLevelOf, riskScore } from '../src/prj-risk';

const refusal = (run: () => unknown): { code: string; detail: string | undefined; status: number } => {
  try {
    run();
  } catch (error) {
    const known = error as { code: string; detail?: string; status: number };
    return { code: known.code, detail: known.detail, status: known.status };
  }
  throw new Error('it was allowed');
};
const UUID = '00000000-0000-4000-8000-0000000000a1';
const ENTRY = {
  code: 'RK-01',
  category_master_version_id: UUID,
  title: 'Mặt bằng chậm bàn giao',
  description: 'Hộ dân chưa nhận tiền bồi thường',
  likelihood: 4,
  impact: 5,
  owner_membership_id: UUID,
  mitigation: 'Họp dân hằng tuần',
  due_date: '2026-12-31',
};

describe('the risks of a project (ST-PRJ-010, BR-PRJ-07, PRJ-16)', () => {
  it('UAT-AC209: scores a risk of likelihood 4 and impact 5 as 20, which is critical', () => {
    expect(riskScore(4, 5)).toBe(20);
    expect(riskLevelOf(20)).toBe('CRITICAL');
    expect(isCritical(20)).toBe(true);
  });

  it('puts the scores of 1 to 5 in the low band, 6 to 14 in the medium one and 15 and more in the critical one, at the edges of each', () => {
    expect([1, 5].map(riskLevelOf)).toEqual(['LOW', 'LOW']);
    expect([6, 14].map(riskLevelOf)).toEqual(['MEDIUM', 'MEDIUM']);
    expect([CRITICAL_SCORE, 25].map(riskLevelOf)).toEqual(['CRITICAL', 'CRITICAL']);
    expect([riskScore(3, 5), riskScore(2, 7 - 2)].map(isCritical)).toEqual([true, false]);
    const everyScore = new Set<number>();
    for (let likelihood = 1; likelihood <= 5; likelihood += 1) for (let impact = 1; impact <= 5; impact += 1) everyScore.add(riskScore(likelihood, impact));
    expect(Math.min(...everyScore)).toBe(1);
    expect(Math.max(...everyScore)).toBe(25);
  });

  it('takes a risk with a code, a group, words, a likelihood and an impact from 1 to 5, an owner, a mitigation and a day; it starts open', () => {
    expect(assertRiskEntry({ ...ENTRY, code: ' RK-01 ', title: '  Mặt bằng chậm bàn giao  ', linked_issue_id: UUID.toUpperCase() })).toMatchObject({ code: 'RK-01', title: 'Mặt bằng chậm bàn giao', status: 'OPEN', linkedIssueId: UUID, likelihood: 4, impact: 5, dueDate: '2026-12-31' });
    expect(assertRiskEntry({ ...ENTRY, status: 'ESCALATED' }).status).toBe('ESCALATED');
    expect(assertRiskEntry(ENTRY).linkedIssueId).toBeUndefined();
  });

  it('refuses what is not a risk: a code, an id, words that are too short or too long, a scale out of 1 to 5, a day that is not real, a status a risk is not written with', () => {
    const detail = (overrides: Record<string, unknown>) => refusal(() => assertRiskEntry({ ...ENTRY, ...overrides }));
    for (const code of [undefined, '', '-x', 'a b', 'x'.repeat(31)]) expect(detail({ code }).detail).toBe('code');
    expect(detail({ category_master_version_id: 'x' }).detail).toBe('category_master_version_id');
    expect(detail({ owner_membership_id: 5 }).detail).toBe('owner_membership_id');
    expect(detail({ linked_issue_id: 'x' }).detail).toBe('linked_issue_id');
    for (const title of [undefined, 'ab', 'x'.repeat(301)]) expect(detail({ title }).detail).toBe('title');
    for (const description of ['', 'x'.repeat(2001)]) expect(detail({ description }).detail).toBe('description');
    for (const mitigation of [' ', 'x'.repeat(2001)]) expect(detail({ mitigation }).detail).toBe('mitigation');
    for (const value of [0, 6, 2.5, '3', undefined]) {
      expect(detail({ likelihood: value }).detail).toBe('likelihood');
      expect(detail({ impact: value }).detail).toBe('impact');
    }
    for (const due_date of [undefined, '2026-02-30', '31/12/2026']) expect(detail({ due_date }).detail).toBe('due_date');
    for (const status of ['CLOSED', 'ACCEPTED', 'LOST']) expect(detail({ status }).detail).toBe('status');
    expect(detail({ title: 'ab' })).toEqual({ code: 'VALIDATION_FAILED', detail: 'title', status: 422 });
  });

  it('ends a risk closed or accepted, with a reason of 10 to 2000 characters', () => {
    expect(assertRiskClosure({ status: 'CLOSED', closed_reason: '  Đã bàn giao mặt bằng  ' })).toEqual({ status: 'CLOSED', reason: 'Đã bàn giao mặt bằng' });
    expect(assertRiskClosure({ status: 'ACCEPTED', closed_reason: 'x'.repeat(2000) }).status).toBe('ACCEPTED');
    expect(refusal(() => assertRiskClosure({ status: 'OPEN', closed_reason: 'x'.repeat(10) })).detail).toBe('status');
    for (const closed_reason of [undefined, 'x'.repeat(9), 'x'.repeat(2001)]) expect(refusal(() => assertRiskClosure({ status: 'CLOSED', closed_reason })).detail).toBe('closed_reason');
  });

  it('moves a risk on towards escalation and never back, and moves an ended risk no more', () => {
    expect(() => assertRiskMove('OPEN', 'OPEN')).not.toThrow();
    expect(() => assertRiskMove('OPEN', 'ESCALATED')).not.toThrow();
    expect(() => assertRiskMove('MITIGATING', 'ESCALATED')).not.toThrow();
    expect(refusal(() => assertRiskMove('ESCALATED', 'MITIGATING'))).toEqual({ code: 'RISK_STATE_INVALID', detail: 'status', status: 409 });
    expect(refusal(() => assertRiskMove('MITIGATING', 'OPEN')).code).toBe('RISK_STATE_INVALID');
    for (const ended of ['CLOSED', 'ACCEPTED'] as const) {
      expect(refusal(() => assertRiskMove(ended, 'OPEN')).code).toBe('RISK_STATE_INVALID');
      expect(refusal(() => assertRiskLive(ended)).code).toBe('RISK_STATE_INVALID');
    }
    expect(() => assertRiskLive('ESCALATED')).not.toThrow();
  });
});
