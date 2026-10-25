import { describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { decisionConfirm, decisionTitle, doneNotice, overrideFieldMessage, overrideProblemMessage, overrideStatusLabel, overrideStatusTone } from './labels';
import { OVERRIDE_STATUSES } from './model';
import type { OverrideFieldProblem, OverrideProblem } from './model';

const t = (key: string, values?: Record<string, string | number>): string => {
  const text = (vi_ as Record<string, string>)[key];
  if (text === undefined) throw new Error(`no string for ${key}`);
  return Object.entries(values ?? {}).reduce((acc, [name, value]) => acc.replace(`{${name}}`, String(value)), text);
};

describe('SAS-25 override labels', () => {
  it('words and colours every state of an override', () => {
    expect(OVERRIDE_STATUSES.map((status) => overrideStatusLabel(t, status))).toEqual(['Chờ duyệt', 'Đang hiệu lực', 'Đã thu hồi', 'Đã hết hạn', 'Đã từ chối']);
    expect(OVERRIDE_STATUSES.map(overrideStatusTone)).toEqual(['warn', 'ok', 'gray', 'gray', 'red']);
  });

  it('words every problem of the form, and nothing for none', () => {
    const problems: OverrideFieldProblem[] = ['required', 'notDateTime', 'notNumber', 'limitNeedsEnabled', 'windowInvalid', 'alreadyEnded', 'tooLong', 'tooFarAhead', 'reasonLength'];
    const words = problems.map((problem) => overrideFieldMessage(t, problem));
    expect(new Set(words).size).toBe(problems.length);
    expect(words.every((word) => word.length > 0)).toBe(true);
    expect(overrideFieldMessage(t, undefined)).toBe('');
  });

  it('words every refusal of the server, naming the field of an invalid request', () => {
    const reasons: OverrideProblem['reason'][] = ['selfApproval', 'featureUnknown', 'stageDenied', 'conflict', 'invalid', 'denied', 'notFound', 'session', 'general'];
    const words = reasons.map((reason) => overrideProblemMessage(t, { reason, field: undefined }));
    expect(new Set(words).size).toBe(reasons.length);
    expect(overrideProblemMessage(t, { reason: 'invalid', field: 'valid_until' })).toContain('valid_until');
  });

  it('words the decision form and the notices of every action', () => {
    expect((['approve', 'reject', 'revoke'] as const).map((action) => decisionTitle(t, action, 'Báo cáo'))).toEqual(['Duyệt ghi đè của Báo cáo', 'Từ chối ghi đè của Báo cáo', 'Thu hồi ghi đè của Báo cáo']);
    expect((['approve', 'reject', 'revoke'] as const).map((action) => decisionConfirm(t, action))).toEqual(['Xác nhận duyệt', 'Xác nhận từ chối', 'Xác nhận thu hồi']);
    expect(new Set((['requested', 'approve', 'reject', 'revoke'] as const).map((notice) => doneNotice(t, notice))).size).toBe(4);
  });
});
