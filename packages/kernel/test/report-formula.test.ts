import { evaluateFormula, roundHalfAway } from '../src/index.ts';
import type { FormulaValue } from '../src/index.ts';

/** A sheet as a map "row:col" to value; A is column 1. */
const sheet =
  (cells: Record<string, FormulaValue>) =>
  (row: number, col: number): FormulaValue =>
    cells[`${row}:${col}`] ?? null;

describe('the formula evaluator of the report engine', () => {
  const cells = sheet({ '5:6': 10, '6:6': 20, '7:6': 5, '5:7': 4, '5:8': 0, '6:7': 'word', '9:1': 3 });

  it('sums ranges and lists of ranges, ignoring words and empty cells', () => {
    expect(evaluateFormula('SUM(F5:F7)', cells)).toBe(35);
    expect(evaluateFormula('SUM(F5:F6,F7:F7)', cells)).toBe(35);
    expect(evaluateFormula('SUM(F5:G7)', cells)).toBe(39);
  });

  it('does arithmetic with the usual precedence and treats an empty cell as zero', () => {
    expect(evaluateFormula('F5+F6*2', cells)).toBe(50);
    expect(evaluateFormula('(F5+F6)*2', cells)).toBe(60);
    expect(evaluateFormula('F5-F10', cells)).toBe(10);
    expect(evaluateFormula('-F5', cells)).toBe(-10);
    expect(evaluateFormula('F5/F7', cells)).toBe(2);
  });

  it('evaluates the rate formula of the forms: empty when the denominator is not above zero', () => {
    const rate = 'IF(F6>0,ROUND(F5/F6*100,1),"")';
    expect(evaluateFormula(rate, cells)).toBe(50);
    expect(evaluateFormula('IF(H5>0,ROUND(F5/H5*100,1),"")', cells)).toBe('');
    expect(evaluateFormula('IF(F10>0,1,"")', cells)).toBe('');
  });

  it('rounds half away from zero like the workbook', () => {
    expect(roundHalfAway(2.5, 0)).toBe(3);
    expect(roundHalfAway(-2.5, 0)).toBe(-3);
    expect(roundHalfAway(1.005, 2)).toBe(1.01);
    expect(evaluateFormula('ROUND(F5/F7*1.25,0)', cells)).toBe(3);
  });

  it('knows MIN, MAX, AVERAGE, COUNT, ABS and IFERROR', () => {
    expect(evaluateFormula('MIN(F5:F7)', cells)).toBe(5);
    expect(evaluateFormula('MAX(F5:F7)', cells)).toBe(20);
    expect(evaluateFormula('AVERAGE(F5:F6)', cells)).toBe(15);
    expect(evaluateFormula('COUNT(F5:G7)', cells)).toBe(4);
    expect(evaluateFormula('ABS(F5-F6)', cells)).toBe(10);
    expect(evaluateFormula('IFERROR(F5/H5,0)', cells)).toBe(0);
  });

  it('does not guess: an unknown function, a division by zero or a word in arithmetic has no value', () => {
    expect(evaluateFormula('VLOOKUP(F5,F5:F6,1)', cells)).toBeUndefined();
    expect(evaluateFormula('F5/H5', cells)).toBeUndefined();
    expect(evaluateFormula('G6+1', cells)).toBeUndefined();
    expect(evaluateFormula('SUM(F5:F6', cells)).toBeUndefined();
    expect(evaluateFormula('F5 $ 2', cells)).toBeUndefined();
  });

  it('takes a leading equals sign, a percent and a text join', () => {
    expect(evaluateFormula('=F5', cells)).toBe(10);
    expect(evaluateFormula('50%', cells)).toBe(0.5);
    expect(evaluateFormula('"a"&"b"', cells)).toBe('ab');
  });
});
