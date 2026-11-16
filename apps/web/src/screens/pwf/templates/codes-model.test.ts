import { describe, expect, it } from 'vitest';
import { provisionalCode, workflowCodeFrom } from './codes-model';
import { CODE_PATTERN } from './template-model';

/*
 * The vectors below are the ones of the kernel test (packages/kernel/test/project-workflow-table.test.ts, "workflowCodeFrom (R63)"): the web repeats the rule because it may not import the kernel, and the two must
 * give the same code for the same name. A vector changed there is changed here.
 */
describe('workflowCodeFrom (R63), the vectors of the kernel', () => {
  it.each([
    ['Khảo sát hiện trạng', 'KHAO_SAT_HIEN_TRANG'],
    ['Thẩm định, phê duyệt (đợt 2)', 'THAM_DINH_PHE_DUYET_DOT_2'],
    ['Đấu thầu', 'DAU_THAU'],
    ['2 bước đầu', 'C_2_BUOC_DAU'],
    ['a', 'CODE'],
    ['   ', 'CODE'],
  ])('%s becomes %s', (name, code) => {
    expect(workflowCodeFrom(name)).toBe(code);
  });

  it('cuts at 40 characters and never ends on an underscore', () => {
    const code = workflowCodeFrom('Lập hồ sơ và dự toán công trình sửa chữa đường giao thông địa phương');
    expect(code.length).toBeLessThanOrEqual(40);
    expect(code).toMatch(/^[A-Z][A-Z0-9_]{1,39}$/);
    expect(code.endsWith('_')).toBe(false);
  });

  it('adds a number to a code that is taken, within 40 characters', () => {
    expect(workflowCodeFrom('Thẩm định', ['THAM_DINH'])).toBe('THAM_DINH_2');
    expect(workflowCodeFrom('Thẩm định', ['THAM_DINH', 'THAM_DINH_2'])).toBe('THAM_DINH_3');
    const long = 'A'.repeat(60);
    const second = workflowCodeFrom(long, [workflowCodeFrom(long)]);
    expect(second).toHaveLength(40);
    expect(second.endsWith('_2')).toBe(true);
  });

  it('always gives a valid code that is not taken, and the same one for the same input', () => {
    const names = ['', 'đ', 'Đường tỉnh 207', '___', '  Lập   dự toán  ', '123', 'Ký HĐ & bàn giao', 'x'.repeat(90), 'Ã¢Ê', '日本語'];
    for (const name of names) {
      const taken = names.map((one) => workflowCodeFrom(one));
      const code = workflowCodeFrom(name, taken);
      expect(code).toMatch(CODE_PATTERN);
      expect(taken).not.toContain(code);
      expect(workflowCodeFrom(name, taken)).toBe(code);
    }
  });
});

describe('the provisional code of a row that has no name yet', () => {
  it('is a valid code no row has', () => {
    expect(provisionalCode([])).toBe('NEW_1');
    expect(provisionalCode(['NEW_1', 'NEW_2', 'T1'])).toBe('NEW_3');
    expect(provisionalCode(['NEW_1'])).toMatch(CODE_PATTERN);
  });
});
