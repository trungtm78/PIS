import assert from 'node:assert/strict';
import { test } from 'node:test';
import { textsOf } from './texts.ts';

const table = { plain: 'Ban quản lý dự án', two: 'Biên bản {0} ngày {1}', twice: '{0} và {0}', dollar: 'Giá {0}' } as const;
const tx = textsOf(table);

test('a text without arguments is returned as it is', () => {
  assert.equal(tx('plain'), 'Ban quản lý dự án');
});

test('placeholders are replaced by the arguments in order, as a template literal would', () => {
  assert.equal(tx('two', 'BB-01', '2026-03-01'), 'Biên bản BB-01 ngày 2026-03-01');
  assert.equal(tx('two', 7, null), 'Biên bản 7 ngày null');
  assert.equal(tx('twice', 'A'), 'A và A');
});

test('an argument is never read as a replacement pattern', () => {
  assert.equal(tx('dollar', '$&$1'), 'Giá $&$1');
});
