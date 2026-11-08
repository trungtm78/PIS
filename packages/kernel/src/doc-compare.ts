import { DomainError } from './errors.ts';

/**
 * The comparison of two versions of a document (DOC-2, PD.02): a text diff of the units the extraction read. A text document is compared as a sequence (a longest common subsequence of units, then the units
 * that were replaced are paired by how much of their words they share and shown word by word); a workbook is compared cell by cell, by the place of the cell. Pure, and bounded: a comparison that would cost
 * more than the bound is refused (422 DOC_COMPARE_TOO_LARGE) rather than left to run.
 */

export interface CompareUnit {
  citationId: string;
  kind: string;
  locatorKey: string;
  label: string;
  text: string;
  textSha256: string;
  seq: number;
}

export type CompareOp = 'EQUAL' | 'ADDED' | 'REMOVED' | 'CHANGED';

export interface WordSegment {
  op: 'EQUAL' | 'ADDED' | 'REMOVED';
  text: string;
}

export interface CompareEntry {
  op: CompareOp;
  before: CompareUnit | null;
  after: CompareUnit | null;
  /** The words of a changed unit: what stayed, what left and what came in, in reading order. */
  words: WordSegment[] | null;
}

export interface CompareSummary {
  equal: number;
  added: number;
  removed: number;
  changed: number;
}

export interface CompareResult {
  mode: 'SEQUENCE' | 'CELLS';
  entries: CompareEntry[];
  summary: CompareSummary;
}

/** The most cells of the table of a sequence comparison (after the common head and tail are cut off): 4000 by 4000 units. */
export const MAX_COMPARE_CELLS = 16_000_000;
/** The most words per side of the word diff of one unit; a longer unit is shown as removed and added whole. */
export const MAX_WORD_DIFF_WORDS = 1500;
/** How much of its words a replaced unit must share with the one before it to count as the same unit, changed. */
export const PAIRING_SIMILARITY = 0.4;

const words = (text: string): string[] => (text === '' ? [] : text.split(' '));

/** A longest-common-subsequence diff of two arrays under an equality; returns the operations in order. */
function lcsOps<T>(left: readonly T[], right: readonly T[], same: (a: T, b: T) => boolean): Array<{ op: 'EQUAL' | 'REMOVED' | 'ADDED'; i: number; j: number }> {
  let head = 0;
  while (head < left.length && head < right.length && same(left[head] as T, right[head] as T)) head += 1;
  let tail = 0;
  while (tail < left.length - head && tail < right.length - head && same(left[left.length - 1 - tail] as T, right[right.length - 1 - tail] as T)) tail += 1;
  const n = left.length - head - tail;
  const m = right.length - head - tail;
  if (n * m > MAX_COMPARE_CELLS) throw new DomainError('DOC_COMPARE_TOO_LARGE', 422, 'versions', { extensions: { units_before: left.length, units_after: right.length } });
  const ops: Array<{ op: 'EQUAL' | 'REMOVED' | 'ADDED'; i: number; j: number }> = [];
  for (let k = 0; k < head; k += 1) ops.push({ op: 'EQUAL', i: k, j: k });
  // table[a][b]: the length of the longest common subsequence of left[head+a..] and right[head+b..]
  const width = m + 1;
  const table = new Uint16Array((n + 1) * width);
  for (let a = n - 1; a >= 0; a -= 1) {
    for (let b = m - 1; b >= 0; b -= 1) {
      table[a * width + b] = same(left[head + a] as T, right[head + b] as T) ? (table[(a + 1) * width + b + 1] as number) + 1 : Math.max(table[(a + 1) * width + b] as number, table[a * width + b + 1] as number);
    }
  }
  let a = 0;
  let b = 0;
  while (a < n || b < m) {
    if (a < n && b < m && same(left[head + a] as T, right[head + b] as T)) {
      ops.push({ op: 'EQUAL', i: head + a, j: head + b });
      a += 1;
      b += 1;
    } else if (b >= m || (a < n && (table[(a + 1) * width + b] as number) >= (table[a * width + b + 1] as number))) {
      ops.push({ op: 'REMOVED', i: head + a, j: -1 });
      a += 1;
    } else {
      ops.push({ op: 'ADDED', i: -1, j: head + b });
      b += 1;
    }
  }
  for (let k = 0; k < tail; k += 1) ops.push({ op: 'EQUAL', i: left.length - tail + k, j: right.length - tail + k });
  return ops;
}

/** How much of its words a text shares with another: the words in common over the words in either (0 to 1). */
export function wordSimilarity(left: string, right: string): number {
  const a = new Set(words(left));
  const b = new Set(words(right));
  if (a.size === 0 && b.size === 0) return 1;
  let common = 0;
  for (const word of a) if (b.has(word)) common += 1;
  return common / (a.size + b.size - common);
}

/** The words of a changed unit, word by word; a unit too long to diff is shown as one removed and one added segment. */
export function wordDiff(before: string, after: string): WordSegment[] {
  const left = words(before);
  const right = words(after);
  if (left.length > MAX_WORD_DIFF_WORDS || right.length > MAX_WORD_DIFF_WORDS) {
    return [
      ...(before === '' ? [] : [{ op: 'REMOVED' as const, text: before }]),
      ...(after === '' ? [] : [{ op: 'ADDED' as const, text: after }]),
    ];
  }
  const segments: WordSegment[] = [];
  for (const entry of lcsOps(left, right, (a, b) => a === b)) {
    const text = entry.op === 'ADDED' ? (right[entry.j] as string) : (left[entry.i] as string);
    const last = segments[segments.length - 1];
    if (last !== undefined && last.op === entry.op) last.text = `${last.text} ${text}`;
    else segments.push({ op: entry.op, text });
  }
  return segments;
}

function summaryOf(entries: readonly CompareEntry[]): CompareSummary {
  const summary: CompareSummary = { equal: 0, added: 0, removed: 0, changed: 0 };
  for (const entry of entries) {
    if (entry.op === 'EQUAL') summary.equal += 1;
    else if (entry.op === 'ADDED') summary.added += 1;
    else if (entry.op === 'REMOVED') summary.removed += 1;
    else summary.changed += 1;
  }
  return summary;
}

const changed = (before: CompareUnit, after: CompareUnit): CompareEntry => ({ op: 'CHANGED', before, after, words: wordDiff(before.text, after.text) });

/** The place of a cell for ordering: the sheet in the order sheets first appear, then row, then column. */
function cellPlace(key: string, sheetOrder: Map<string, number>): [number, number, number] {
  const [sheet = '', cell = 'A1'] = key.split('!');
  const letters = /^[A-Z]+/.exec(cell)?.[0] ?? 'A';
  let column = 0;
  for (const letter of letters) column = column * 26 + (letter.charCodeAt(0) - 64);
  return [sheetOrder.get(sheet) ?? Number.MAX_SAFE_INTEGER, Number(cell.slice(letters.length)), column];
}

function compareCells(before: readonly CompareUnit[], after: readonly CompareUnit[]): CompareEntry[] {
  const left = new Map(before.map((unit) => [unit.locatorKey, unit]));
  const right = new Map(after.map((unit) => [unit.locatorKey, unit]));
  const sheetOrder = new Map<string, number>();
  for (const unit of [...before, ...after]) {
    const sheet = unit.locatorKey.split('!')[0] ?? '';
    if (!sheetOrder.has(sheet)) sheetOrder.set(sheet, sheetOrder.size);
  }
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort((a, b) => {
    const [as, ar, ac] = cellPlace(a, sheetOrder);
    const [bs, br, bc] = cellPlace(b, sheetOrder);
    return as - bs || ar - br || ac - bc;
  });
  return keys.map((key): CompareEntry => {
    const was = left.get(key) ?? null;
    const is = right.get(key) ?? null;
    if (was !== null && is !== null) return was.textSha256 === is.textSha256 ? { op: 'EQUAL', before: was, after: is, words: null } : changed(was, is);
    return was !== null ? { op: 'REMOVED', before: was, after: null, words: null } : { op: 'ADDED', before: null, after: is, words: null };
  });
}

function compareSequences(before: readonly CompareUnit[], after: readonly CompareUnit[]): CompareEntry[] {
  const entries: CompareEntry[] = [];
  const ops = lcsOps(before, after, (a, b) => a.textSha256 === b.textSha256);
  let index = 0;
  while (index < ops.length) {
    const op = ops[index] as (typeof ops)[number];
    if (op.op === 'EQUAL') {
      entries.push({ op: 'EQUAL', before: before[op.i] as CompareUnit, after: after[op.j] as CompareUnit, words: null });
      index += 1;
      continue;
    }
    // A run of removed and added units between two equal ones: the units that say much the same are one unit, changed; the rest are removed or added.
    const removed: CompareUnit[] = [];
    const added: CompareUnit[] = [];
    while (index < ops.length && (ops[index] as (typeof ops)[number]).op !== 'EQUAL') {
      const run = ops[index] as (typeof ops)[number];
      if (run.op === 'REMOVED') removed.push(before[run.i] as CompareUnit);
      else added.push(after[run.j] as CompareUnit);
      index += 1;
    }
    let next = 0;
    for (const was of removed) {
      let found = -1;
      if (removed.length * added.length <= 10_000) {
        for (let candidate = next; candidate < added.length; candidate += 1) {
          if (wordSimilarity(was.text, (added[candidate] as CompareUnit).text) >= PAIRING_SIMILARITY) {
            found = candidate;
            break;
          }
        }
      }
      if (found < 0) {
        entries.push({ op: 'REMOVED', before: was, after: null, words: null });
        continue;
      }
      for (let skipped = next; skipped < found; skipped += 1) entries.push({ op: 'ADDED', before: null, after: added[skipped] as CompareUnit, words: null });
      entries.push(changed(was, added[found] as CompareUnit));
      next = found + 1;
    }
    for (let rest = next; rest < added.length; rest += 1) entries.push({ op: 'ADDED', before: null, after: added[rest] as CompareUnit, words: null });
  }
  return entries;
}

/**
 * Compares the units of two versions, in the reading order of each. When every unit of both is a cell of a sheet the comparison is by cell place; otherwise it is by sequence. Equal units are kept in the answer
 * (the screen folds them), so that a reader sees a change where it sits in the document.
 */
export function compareUnits(before: readonly CompareUnit[], after: readonly CompareUnit[]): CompareResult {
  const cells = before.length + after.length > 0 && [...before, ...after].every((unit) => unit.kind === 'SHEET_CELL');
  const entries = cells ? compareCells(before, after) : compareSequences(before, after);
  return { mode: cells ? 'CELLS' : 'SEQUENCE', entries, summary: summaryOf(entries) };
}
