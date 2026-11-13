import { describe, expect, it } from 'vitest';
import { t } from '../../../i18n';
import { levelLabel, levelWord, officialText, problemText, refusalText } from './labels';
import type { PreferenceProblem, PreferenceRefusal } from './model';

describe('the words of the personal reminders', () => {
  it('says each level by its colour and its label, and the official number beside it', () => {
    expect(levelWord(t, 'green_days')).toBe('xanh');
    expect(levelWord(t, 'yellow_days')).toBe('vàng');
    expect(levelWord(t, 'red_days')).toBe('đỏ');
    expect(levelLabel(t, 'green_days')).toBe('Xanh: còn tới (ngày làm việc)');
    expect(levelLabel(t, 'yellow_days')).toBe('Vàng: còn tới (ngày làm việc)');
    expect(levelLabel(t, 'red_days')).toBe('Đỏ: còn tới (ngày làm việc)');
    const official = { green_days: null, yellow_days: 2, red_days: 0 };
    expect(officialText(t, 'yellow_days', official)).toBe('chính thức: 2');
    expect(officialText(t, 'red_days', official)).toBe('chính thức: 0');
    expect(officialText(t, 'green_days', official)).toBe('chính thức: không đặt mức xanh');
  });

  it('says each problem of the form in its own sentence, with the numbers it names', () => {
    const problems: [PreferenceProblem, string][] = [
      [{ path: 'green_days', kind: 'integer' }, 'Nhập số nguyên.'],
      [{ path: 'red_days', kind: 'range', min: -1, max: 3650 }, 'Nhập số nguyên từ -1 đến 3650.'],
      [{ path: 'green_days', kind: 'order' }, 'Mức xanh phải lớn hơn mức vàng.'],
      [{ path: 'yellow_days', kind: 'order' }, 'Mức vàng phải lớn hơn mức đỏ.'],
      [{ path: 'yellow_days', kind: 'notEarlier', official: 2 }, 'Mức của bạn không được muộn hơn mức chính thức (2). Chỉ được nhắc sớm hơn hoặc bằng.'],
      [{ path: 'reminder_days', kind: 'listSize', max: 6 }, 'Tối đa 6 mốc nhắc.'],
      [{ path: 'reminder_days', kind: 'listSize' }, 'Tối đa 6 mốc nhắc.'],
      [{ path: 'reminder_days', kind: 'reminderOrder' }, 'Các mốc nhắc phải giảm dần, mỗi mốc một lần.'],
      [{ path: 'reminder_days', kind: 'reminderNotEarlier', official: 0 }, 'Mốc nhắc không được nhỏ hơn mức đỏ chính thức (0).'],
    ];
    for (const [problem, sentence] of problems) expect(problemText(t, problem)).toBe(sentence);
  });

  it('says each refusal of the save in its own sentence', () => {
    const kinds: PreferenceRefusal['kind'][] = ['conflict', 'order', 'notEarlier', 'denied', 'validation', 'general'];
    const sentences = kinds.map((kind) => refusalText(t, { kind, field: undefined }));
    expect(new Set(sentences).size).toBe(kinds.length);
    expect(sentences[3]).toBe('Bạn không có quyền đặt nhắc hạn cho chính mình.');
    expect(sentences[4]).toBe('Cài đặt chưa hợp lệ. Hãy kiểm tra lại các số.');
  });
});
