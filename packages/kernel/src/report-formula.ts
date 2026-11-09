import { columnLetters } from './report-layout.ts';

/**
 * The small formula evaluator of the report engine (ENT-4b, R26). The grid of a form keeps its formulas live in the workbook (a total is `SUM(F5:F10)`, a rate is `IF(H5>0,ROUND(G5/H5*100,1),"")`), but a
 * writer that has no spreadsheet engine behind it (the PDF) must print the value the workbook will show. This module reads exactly the formulas the forms use and gives their value from the cells of the grid:
 * numbers, words, cell references, ranges inside SUM/MIN/MAX/AVERAGE/COUNT, + - * /, comparisons, and the functions SUM, MIN, MAX, AVERAGE, COUNT, ROUND, ABS, IF, IFERROR. Anything else is not guessed: the cell
 * has no value (`undefined`) and the caller reports it, so a wrong number is never printed.
 */

export type FormulaValue = number | string | null;

/** What the evaluator needs to know of a sheet: the value of one cell (null when it is empty). */
export type CellLookup = (row: number, col: number) => FormulaValue;

type Token = { kind: 'num'; value: number } | { kind: 'str'; value: string } | { kind: 'ref'; text: string } | { kind: 'name'; text: string } | { kind: 'op'; text: string };

const REF = /^\$?([A-Z]{1,3})\$?(\d{1,7})$/;

/** The number of a column name: A is 1, AA is 27. */
export function columnNumberOf(letters: string): number {
  let value = 0;
  for (const character of letters) value = value * 26 + (character.charCodeAt(0) - 64);
  return value;
}

class Unsupported extends Error {}

function tokenise(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const character = source.charAt(at);
    if (character === ' ') {
      at += 1;
    } else if (character === '"') {
      let end = at + 1;
      let value = '';
      for (;;) {
        if (end >= source.length) throw new Unsupported();
        if (source.charAt(end) === '"') {
          if (source.charAt(end + 1) === '"') {
            value += '"';
            end += 2;
            continue;
          }
          break;
        }
        value += source.charAt(end);
        end += 1;
      }
      tokens.push({ kind: 'str', value });
      at = end + 1;
    } else if (/[0-9.]/.test(character)) {
      const match = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(at));
      if (match === null) throw new Unsupported();
      tokens.push({ kind: 'num', value: Number(match[0]) });
      at += match[0].length;
    } else if (/[A-Za-z$]/.test(character)) {
      const match = /^[$A-Za-z][$A-Za-z0-9_.]*/.exec(source.slice(at));
      if (match === null) throw new Unsupported();
      const text = match[0].toUpperCase();
      tokens.push(REF.test(text) ? { kind: 'ref', text } : { kind: 'name', text });
      at += match[0].length;
    } else {
      const two = source.slice(at, at + 2);
      if (two === '<=' || two === '>=' || two === '<>') {
        tokens.push({ kind: 'op', text: two });
        at += 2;
      } else if ('+-*/(),:<>=&%'.includes(character)) {
        tokens.push({ kind: 'op', text: character });
        at += 1;
      } else {
        throw new Unsupported();
      }
    }
  }
  return tokens;
}

/** Excel rounds half away from zero; the small epsilon keeps 1.005 style products from falling the wrong way. */
export function roundHalfAway(value: number, places: number): number {
  const factor = 10 ** places;
  const scaled = Math.abs(value) * factor;
  const rounded = Math.floor(scaled + 0.5 + Number.EPSILON * scaled);
  return (Math.sign(value) * rounded) / factor;
}

type Operand = FormulaValue | Range;

interface Range {
  rows: number[];
  cols: number[];
}

const isRange = (operand: Operand): operand is Range => typeof operand === 'object' && operand !== null;

class Parser {
  private at = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly lookup: CellLookup,
  ) {}

  done(): boolean {
    return this.at >= this.tokens.length;
  }

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }

  private takeOp(text: string): boolean {
    const next = this.peek();
    if (next?.kind === 'op' && next.text === text) {
      this.at += 1;
      return true;
    }
    return false;
  }

  /** The value of a scalar operand (a range is not one). */
  private scalar(operand: Operand): FormulaValue {
    if (isRange(operand)) throw new Unsupported();
    return operand;
  }

  private numberOf(operand: Operand): number {
    const value = this.scalar(operand);
    if (value === null || value === '') return 0;
    if (typeof value === 'number') return value;
    throw new Unsupported();
  }

  expression(): Operand {
    return this.comparison();
  }

  private comparison(): Operand {
    const left = this.concatenation();
    const next = this.peek();
    if (next?.kind === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(next.text)) {
      this.at += 1;
      const right = this.concatenation();
      const a = this.scalar(left);
      const b = this.scalar(right);
      const both = typeof a === 'string' || typeof b === 'string' ? [String(a ?? ''), String(b ?? '')] : [a ?? 0, b ?? 0];
      const [x, y] = both as [string | number, string | number];
      const result = next.text === '=' ? x === y : next.text === '<>' ? x !== y : next.text === '<' ? x < y : next.text === '>' ? x > y : next.text === '<=' ? x <= y : x >= y;
      return result ? 1 : 0;
    }
    return left;
  }

  private concatenation(): Operand {
    let left = this.additive();
    while (this.takeOp('&')) {
      const right = this.additive();
      left = `${String(this.scalar(left) ?? '')}${String(this.scalar(right) ?? '')}`;
    }
    return left;
  }

  private additive(): Operand {
    let left = this.term();
    for (;;) {
      if (this.takeOp('+')) left = this.numberOf(left) + this.numberOf(this.term());
      else if (this.takeOp('-')) left = this.numberOf(left) - this.numberOf(this.term());
      else return left;
    }
  }

  private term(): Operand {
    let left = this.unary();
    for (;;) {
      if (this.takeOp('*')) left = this.numberOf(left) * this.numberOf(this.unary());
      else if (this.takeOp('/')) {
        const divisor = this.numberOf(this.unary());
        if (divisor === 0) throw new Unsupported();
        left = this.numberOf(left) / divisor;
      } else return left;
    }
  }

  private unary(): Operand {
    if (this.takeOp('-')) return -this.numberOf(this.unary());
    if (this.takeOp('+')) return this.numberOf(this.unary());
    const value = this.primary();
    return this.takeOp('%') ? this.numberOf(value) / 100 : value;
  }

  private primary(): Operand {
    const token = this.peek();
    if (token === undefined) throw new Unsupported();
    this.at += 1;
    if (token.kind === 'num') return token.value;
    if (token.kind === 'str') return token.value;
    if (token.kind === 'ref') {
      const here = REF.exec(token.text) as RegExpExecArray;
      const col = columnNumberOf(here[1] as string);
      const row = Number(here[2]);
      if (this.takeOp(':')) {
        const end = this.peek();
        if (end?.kind !== 'ref') throw new Unsupported();
        this.at += 1;
        const there = REF.exec(end.text) as RegExpExecArray;
        const rows = rangeOf(row, Number(there[2]));
        const cols = rangeOf(col, columnNumberOf(there[1] as string));
        return { rows, cols };
      }
      return this.lookup(row, col);
    }
    if (token.kind === 'op' && token.text === '(') {
      const inner = this.expression();
      if (!this.takeOp(')')) throw new Unsupported();
      return inner;
    }
    if (token.kind === 'name') {
      if (!this.takeOp('(')) throw new Unsupported();
      const args: Array<() => Operand> = [];
      if (!this.takeOp(')')) {
        for (;;) {
          // The arguments are read lazily in order: IF and IFERROR must not evaluate the branch they do not take.
          const start = this.at;
          this.skipArgument();
          const end = this.at;
          args.push(() => this.evaluateSpan(start, end));
          if (this.takeOp(')')) break;
          if (!this.takeOp(',')) throw new Unsupported();
        }
      }
      return this.call(token.text, args);
    }
    throw new Unsupported();
  }

  /** Moves past one argument without evaluating it: up to the comma or the closing bracket at the same depth. */
  private skipArgument(): void {
    let depth = 0;
    for (;;) {
      const token = this.peek();
      if (token === undefined) throw new Unsupported();
      if (token.kind === 'op' && token.text === '(') depth += 1;
      if (token.kind === 'op' && token.text === ')') {
        if (depth === 0) return;
        depth -= 1;
      }
      if (token.kind === 'op' && token.text === ',' && depth === 0) return;
      this.at += 1;
    }
  }

  private evaluateSpan(start: number, end: number): Operand {
    const inner = new Parser(this.tokens.slice(start, end), this.lookup);
    const value = inner.expression();
    if (!inner.done()) throw new Unsupported();
    return value;
  }

  private numbersOf(args: Array<() => Operand>): number[] {
    const out: number[] = [];
    for (const arg of args) {
      const operand = arg();
      if (isRange(operand)) {
        for (const row of operand.rows) for (const col of operand.cols) {
          const value = this.lookup(row, col);
          if (typeof value === 'number') out.push(value);
        }
      } else if (typeof operand === 'number') {
        out.push(operand);
      } else if (operand !== null && operand !== '') {
        throw new Unsupported();
      }
    }
    return out;
  }

  private call(name: string, args: Array<() => Operand>): Operand {
    switch (name) {
      case 'SUM':
        return this.numbersOf(args).reduce((sum, value) => sum + value, 0);
      case 'MIN': {
        const values = this.numbersOf(args);
        return values.length === 0 ? 0 : Math.min(...values);
      }
      case 'MAX': {
        const values = this.numbersOf(args);
        return values.length === 0 ? 0 : Math.max(...values);
      }
      case 'AVERAGE': {
        const values = this.numbersOf(args);
        if (values.length === 0) throw new Unsupported();
        return values.reduce((sum, value) => sum + value, 0) / values.length;
      }
      case 'COUNT':
        return this.numbersOf(args).length;
      case 'ABS': {
        if (args.length !== 1) throw new Unsupported();
        return Math.abs(this.numberOf((args[0] as () => Operand)()));
      }
      case 'ROUND': {
        if (args.length !== 2) throw new Unsupported();
        const places = this.numberOf((args[1] as () => Operand)());
        if (!Number.isInteger(places) || places < -6 || places > 10) throw new Unsupported();
        return roundHalfAway(this.numberOf((args[0] as () => Operand)()), places);
      }
      case 'IF': {
        if (args.length < 2 || args.length > 3) throw new Unsupported();
        const condition = this.scalar((args[0] as () => Operand)());
        const truthy = typeof condition === 'number' ? condition !== 0 : condition !== null && condition !== '';
        if (truthy) return (args[1] as () => Operand)();
        return args[2] === undefined ? 0 : args[2]();
      }
      case 'IFERROR': {
        if (args.length !== 2) throw new Unsupported();
        try {
          return (args[0] as () => Operand)();
        } catch (failure) {
          if (failure instanceof Unsupported) return (args[1] as () => Operand)();
          throw failure;
        }
      }
      default:
        throw new Unsupported();
    }
  }
}

const rangeOf = (from: number, to: number): number[] => {
  const low = Math.min(from, to);
  const high = Math.max(from, to);
  if (high - low > 100_000) throw new Unsupported();
  return Array.from({ length: high - low + 1 }, (_, index) => low + index);
};

/**
 * The value of a formula (without the leading `=`) over the cells of a sheet; `undefined` when the formula uses something this evaluator does not know, or divides by zero, so that the caller can say so instead of
 * printing a number that the workbook would not show.
 */
export function evaluateFormula(formula: string, lookup: CellLookup): FormulaValue | undefined {
  try {
    const parser = new Parser(tokenise(formula.startsWith('=') ? formula.slice(1) : formula), lookup);
    const value = parser.expression();
    if (!parser.done() || isRange(value)) return undefined;
    return value;
  } catch (failure) {
    if (failure instanceof Unsupported) return undefined;
    throw failure;
  }
}

/** The A1 name of a cell, for the messages of a caller that reports a formula it could not evaluate. */
export const a1 = (row: number, col: number): string => `${columnLetters(col)}${row}`;
