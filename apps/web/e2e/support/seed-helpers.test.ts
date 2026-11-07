import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codeOf, mondayOf, monthEnd, monthStart, seqCode, shiftDate, taxCode, vietnamDate, vnd, vndMillions } from '../hdsd/seed/context.ts';

test('a business code is made from a Vietnamese name without marks', () => {
  assert.equal(codeOf('Phường Nùng Trí Cao'), 'PHUONG-NUNG-TRI-CAO');
  assert.equal(codeOf('  Đường tỉnh 205 (Km0 - Km12) '), 'DUONG-TINH-205-KM0-KM12');
});

test('running codes carry the prefix, the year and a fixed width', () => {
  assert.equal(seqCode('KH', 7), 'KH-007');
  assert.equal(seqCode('KH', 12, { year: 2026, width: 4 }), 'KH-2026-0012');
});

test('amounts are whole dong in a string', () => {
  assert.equal(vnd(150), '150000000000');
  assert.equal(vnd(0.5), '500000000');
  assert.equal(vndMillions(250), '250000000');
});

test('a tax code has ten digits and is stable', () => {
  assert.match(taxCode(1), /^\d{10}$/u);
  assert.equal(taxCode(5), taxCode(5));
  assert.notEqual(taxCode(5), taxCode(6));
});

test('dates shift across month and year ends', () => {
  assert.equal(shiftDate('2026-12-30', 3), '2027-01-02');
  assert.equal(shiftDate('2026-03-01', -1), '2026-02-28');
  assert.equal(mondayOf('2026-11-08'), '2026-11-02');
  assert.equal(mondayOf('2026-11-02'), '2026-11-02');
  assert.equal(monthStart('2026-11-18', -2), '2026-09-01');
  assert.equal(monthEnd('2026-11-18', -1), '2026-10-31');
  assert.equal(monthEnd('2026-01-15'), '2026-01-31');
});

test('the day in Vietnam is seven hours ahead of UTC', () => {
  assert.equal(vietnamDate(new Date('2026-11-07T17:15:00Z')), '2026-11-08');
  assert.equal(vietnamDate(new Date('2026-11-07T16:59:00Z')), '2026-11-07');
});
