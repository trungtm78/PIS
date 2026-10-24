import { describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { badgeLabel, badgeTone, classificationLabel, fieldProblemMessage, freshnessLabel, problemMessage, statusLabel } from './labels';
import { CLASSIFICATION_LIST } from './model';
import type { FieldProblem, ProblemReason, QualityBadge, DatasetStatus } from './model';

const catalogue = vi_ as Record<string, string>;
const t = (key: string, params?: Record<string, string | number>): string => {
  const template = catalogue[key];
  if (template === undefined) throw new Error(`missing key ${key}`);
  return Object.entries(params ?? {}).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), template);
};

describe('labels of the dataset screens', () => {
  it('words every classification, status and badge with a key of the catalogue', () => {
    expect(CLASSIFICATION_LIST.map((item) => classificationLabel(t, item))).toEqual(['Công khai', 'Nội bộ', 'Mật', 'Dữ liệu cá nhân', 'Dữ liệu quan trọng, cốt lõi']);
    const statuses: DatasetStatus[] = ['DRAFT', 'ACTIVE', 'DEPRECATED', 'RETIRED'];
    expect(statuses.map((item) => statusLabel(t, item))).toEqual(['Nháp', 'Đang dùng', 'Sắp ngừng', 'Đã ngừng']);
    const badges: QualityBadge[] = ['NOT_ASSESSED', 'PASSED', 'WARNING', 'FAILED', 'STALE'];
    expect(badges.map((item) => badgeLabel(t, item))).toEqual(['Chưa đánh giá', 'Đạt', 'Cảnh báo', 'Không đạt', 'Dữ liệu cũ']);
  });

  it('colours "not assessed" neutral, never green or red (BR-DGV-01)', () => {
    expect(badgeTone('NOT_ASSESSED')).toBe('gray');
    expect(badgeTone('PASSED')).toBe('green');
    expect(badgeTone('FAILED')).toBe('red');
    expect(badgeTone('WARNING')).toBe('warn');
    expect(badgeTone('STALE')).toBe('warn');
  });

  it('writes a freshness in the largest exact unit', () => {
    expect([172_800, 7_200, 5_400, 45].map((seconds) => freshnessLabel(t, seconds))).toEqual(['2 ngày', '2 giờ', '90 phút', '45 giây']);
  });

  it('words every field problem and every refusal', () => {
    const problems: FieldProblem[] = ['required', 'tooShort', 'tooLong', 'invalidNumber', 'invalidModule', 'sameAsOwner'];
    expect(new Set(problems.map((item) => fieldProblemMessage(t, item))).size).toBe(problems.length);
    const reasons: ProblemReason[] = ['ownerStewardSame', 'duplicateCode', 'versionConflict', 'validation', 'notFound', 'retired', 'denied', 'general'];
    expect(new Set(reasons.map((reason) => problemMessage(t, { reason, field: undefined }))).size).toBe(reasons.length);
    expect(problemMessage(t, { reason: 'validation', field: 'title' })).toBe('Dữ liệu nhập chưa hợp lệ ở trường title.');
  });
});
