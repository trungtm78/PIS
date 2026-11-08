import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatFigure, resolveFigures, figureIds } from './figures.mjs';
import { decimalToWords, integerToWords, numbersToSpeech } from './numbers.mjs';

test('whole numbers are spoken with the Vietnamese rules for linh, mốt, tư, lăm and mười', () => {
  const cases = {
    0: 'không',
    5: 'năm',
    10: 'mười',
    11: 'mười một',
    14: 'mười bốn',
    15: 'mười lăm',
    19: 'mười chín',
    20: 'hai mươi',
    21: 'hai mươi mốt',
    24: 'hai mươi tư',
    25: 'hai mươi lăm',
    100: 'một trăm',
    105: 'một trăm linh năm',
    110: 'một trăm mười',
    205: 'hai trăm linh năm',
    999: 'chín trăm chín mươi chín',
    1000: 'một nghìn',
    1005: 'một nghìn không trăm linh năm',
    1010: 'một nghìn không trăm mười',
    2026: 'hai nghìn không trăm hai mươi sáu',
    10500: 'mười nghìn năm trăm',
    1000000: 'một triệu',
    1250000: 'một triệu hai trăm năm mươi nghìn',
    1000005: 'một triệu không trăm linh năm',
    1000000000: 'một tỷ',
    1286000000: 'một tỷ hai trăm tám mươi sáu triệu',
    1000000005: 'một tỷ không trăm linh năm',
  };
  for (const [number, words] of Object.entries(cases)) assert.equal(integerToWords(number), words, number);
});

test('a decimal reads the digits after the comma one by one', () => {
  assert.equal(decimalToWords('72,5'), 'bảy mươi hai phẩy năm');
  assert.equal(decimalToWords('0,05'), 'không phẩy không năm');
  assert.equal(decimalToWords('128,4'), 'một trăm hai mươi tám phẩy bốn');
});

test('a text keeps its words and has its numbers spelled; codes with a hyphen are left alone', () => {
  assert.equal(numbersToSpeech('Có 19 báo cáo và 72,5% số liệu.'), 'Có mười chín báo cáo và bảy mươi hai phẩy năm phần trăm số liệu.');
  assert.equal(numbersToSpeech('Màn BID-24 mở ra.'), 'Màn BID-24 mở ra.');
  assert.equal(numbersToSpeech('Không có số nào.'), 'Không có số nào.');
  assert.throws(() => integerToWords('12a'), /not a whole number/u);
});

test('a figure is shown with digits and spoken with words, and each kind has its unit', () => {
  assert.deepEqual(formatFigure('percent', 72.5, 1), { display: '72,5%', speech: 'bảy mươi hai phẩy năm phần trăm' });
  assert.deepEqual(formatFigure('money-billion', 128.4, 1), { display: '128,4 tỷ đồng', speech: 'một trăm hai mươi tám phẩy bốn tỷ đồng' });
  assert.deepEqual(formatFigure('days', 7, 0), { display: '7 ngày', speech: 'bảy ngày' });
  assert.deepEqual(formatFigure('count', 38, 0), { display: '38', speech: 'ba mươi tám' });
  assert.deepEqual(formatFigure('text', 'Cao Bằng', 0), { display: 'Cao Bằng', speech: 'Cao Bằng' });
  assert.equal(formatFigure('count', -3, 0).speech, 'âm ba');
  assert.throws(() => formatFigure('percent', null, 1), /needs a number/u);
  assert.throws(() => formatFigure('weight', 1, 0), /unknown figure kind/u);
});

test('placeholders come from the data manifest only: a missing value is an error and a sample is never used at record time', () => {
  const declarations = { 'rate-pm': { kind: 'percent', sample: 50, digits: 1 }, late: { kind: 'count', sample: 3 } };
  const manifest = { figures: { 'rate-pm': { value: 62.4 } } };
  const text = 'Tỷ lệ {{figure:rate-pm}}, trễ {{figure:late}} gói.';
  assert.deepEqual(figureIds(text), ['rate-pm', 'late']);
  assert.throws(() => resolveFigures(text, declarations, manifest, 'display'), /figure late has no value in the data manifest/u);
  assert.equal(resolveFigures('Tỷ lệ {{figure:rate-pm}}.', declarations, manifest, 'display'), 'Tỷ lệ 62,4%.');
  assert.equal(resolveFigures('Tỷ lệ {{figure:rate-pm}}.', declarations, manifest, 'speech'), 'Tỷ lệ sáu mươi hai phẩy bốn phần trăm.');
  assert.equal(resolveFigures(text, declarations, undefined, 'sample'), 'Tỷ lệ 50,0%, trễ 3 gói.');
  assert.throws(() => resolveFigures('{{figure:unknown}}', declarations, manifest), /not declared/u);
});
