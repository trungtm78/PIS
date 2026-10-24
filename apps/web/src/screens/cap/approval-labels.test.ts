import { describe, expect, it } from 'vitest';
import en from '../../i18n/en.json';
import vi_ from '../../i18n/vi.json';
import { approvalProblemMessage, belowCommittedText, decisionDoneNotice, impactKindLabel, publishProblemMessage, reasonProblemMessage, stateNotice } from './approval-labels';
import type { ApprovalProblemReason } from './approval-model';
import { PLAN_STATUSES } from './plan-model';

const dictionary = (messages: Record<string, string>) => (key: string, params?: Record<string, string | number>): string => {
  const template = messages[key] ?? `?${key}`;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? `{${name}}`));
};
const tVi = dictionary(vi_ as Record<string, string>);
const tEn = dictionary(en as Record<string, string>);

const REASONS: ApprovalProblemReason[] = [
  'selfApproval',
  'decisionRequired',
  'notApproved',
  'notDraft',
  'notInReview',
  'belowCommitted',
  'nationalCode',
  'yearLocked',
  'versionConflict',
  'planChanged',
  'stageInvalid',
  'notPublished',
  'noLines',
  'denied',
  'notFound',
  'validation',
  'general',
];

describe('the words of the approval screens', () => {
  it.each([
    ['Vietnamese', tVi],
    ['English', tEn],
  ])('has a sentence in %s for every refusal, state, kind and form problem', (_name, t) => {
    const view = (reason: ApprovalProblemReason, field?: string) => ({ reason, field, lines: [], projectCount: 3 });
    for (const reason of REASONS) expect(approvalProblemMessage(t, view(reason)).startsWith('?')).toBe(false);
    expect(approvalProblemMessage(t, view('validation', 'reason'))).toContain('reason');
    expect(approvalProblemMessage(t, view('nationalCode'))).toContain('3');
    for (const status of PLAN_STATUSES) expect(stateNotice(t, status).startsWith('?')).toBe(false);
    for (const kind of ['NEW', 'CHANGED', 'SAME', 'DROPPED'] as const) expect(impactKindLabel(t, kind).startsWith('?')).toBe(false);
    for (const problem of ['required', 'tooShort', 'tooLong'] as const) expect(reasonProblemMessage(t, problem).startsWith('?')).toBe(false);
    for (const problem of ['required', 'invalidId', 'invalidDate'] as const) expect(publishProblemMessage(t, problem).startsWith('?')).toBe(false);
    for (const decision of ['approve', 'reject', 'return'] as const) expect(decisionDoneNotice(t, decision).startsWith('?')).toBe(false);
  });

  it('names the project of a line that fell below its floor, or the line when the plan does not show it', () => {
    const line = { lineId: 'l1', projectId: 'p', allocatedVnd: '8500000000', committedVnd: '6000000000', disbursedVnd: '3000000000', minimumVnd: '9000000000' };
    expect(belowCommittedText(tEn, line, () => 'DA-01', 'en')).toContain('DA-01');
    expect(belowCommittedText(tEn, line, () => undefined, 'en')).toContain('l1');
  });
});
