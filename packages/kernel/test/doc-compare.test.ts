import { DomainError } from '../src/errors';
import { MAX_COMPARE_CELLS, compareUnits, wordDiff, wordSimilarity } from '../src/index';
import type { CompareUnit } from '../src/index';
import { createHash } from 'node:crypto';

const unit = (seq: number, text: string, kind = 'PARAGRAPH', key = `para${seq}`): CompareUnit => ({
  citationId: `cit_${String(seq).padStart(20, '0')}`,
  kind,
  locatorKey: key,
  label: key,
  text,
  textSha256: createHash('sha256').update(text).digest('hex'),
  seq,
});

const ops = (before: CompareUnit[], after: CompareUnit[]): string[] => compareUnits(before, after).entries.map((entry) => entry.op);

describe('words', () => {
  it('measures how much of its words one text shares with another', () => {
    expect(wordSimilarity('a b c d', 'a b c d')).toBe(1);
    expect(wordSimilarity('a b', 'c d')).toBe(0);
    expect(wordSimilarity('a b c', 'a b d')).toBeCloseTo(0.5);
    expect(wordSimilarity('', '')).toBe(1);
  });

  it('diffs two texts word by word and joins neighbouring words of one kind', () => {
    expect(wordDiff('giá trị hợp đồng là 100 tỷ', 'giá trị hợp đồng là 120 tỷ')).toEqual([
      { op: 'EQUAL', text: 'giá trị hợp đồng là' },
      { op: 'REMOVED', text: '100' },
      { op: 'ADDED', text: '120' },
      { op: 'EQUAL', text: 'tỷ' },
    ]);
    expect(wordDiff('', 'mới')).toEqual([{ op: 'ADDED', text: 'mới' }]);
  });

  it('shows a very long unit as removed and added whole rather than diffing it', () => {
    const long = Array.from({ length: 1600 }, (_, index) => `w${index}`).join(' ');
    expect(wordDiff(long, `${long} more`)).toEqual([
      { op: 'REMOVED', text: long },
      { op: 'ADDED', text: `${long} more` },
    ]);
  });
});

describe('comparing by sequence', () => {
  it('finds nothing in two equal versions', () => {
    const result = compareUnits([unit(1, 'a a'), unit(2, 'b b')], [unit(1, 'a a'), unit(2, 'b b')]);
    expect(result.mode).toBe('SEQUENCE');
    expect(result.summary).toEqual({ equal: 2, added: 0, removed: 0, changed: 0 });
  });

  it('marks an inserted unit and a deleted unit where they sit', () => {
    expect(ops([unit(1, 'một'), unit(2, 'hai')], [unit(1, 'một'), unit(2, 'chen vào đây'), unit(3, 'hai')])).toEqual(['EQUAL', 'ADDED', 'EQUAL']);
    expect(ops([unit(1, 'một'), unit(2, 'hai khác hẳn'), unit(3, 'ba')], [unit(1, 'một'), unit(2, 'ba')])).toEqual(['EQUAL', 'REMOVED', 'EQUAL']);
  });

  it('pairs a replaced unit with the one that says much the same and shows its words', () => {
    const result = compareUnits(
      [unit(1, 'Điều 1'), unit(2, 'Giá trị hợp đồng là 100 tỷ đồng chưa gồm thuế'), unit(3, 'Điều 3')],
      [unit(1, 'Điều 1'), unit(2, 'Giá trị hợp đồng là 120 tỷ đồng chưa gồm thuế'), unit(3, 'Điều 3')],
    );
    expect(result.summary).toEqual({ equal: 2, added: 0, removed: 0, changed: 1 });
    const changed = result.entries[1];
    expect(changed?.op).toBe('CHANGED');
    expect(changed?.before?.seq).toBe(2);
    expect(changed?.after?.seq).toBe(2);
    expect(changed?.words?.filter((segment) => segment.op !== 'EQUAL')).toEqual([
      { op: 'REMOVED', text: '100' },
      { op: 'ADDED', text: '120' },
    ]);
  });

  it('keeps a replaced unit that shares too little as one removed and one added', () => {
    expect(ops([unit(1, 'hoàn toàn khác nhau ở đây')], [unit(1, 'chẳng liên quan gì tới nhau cả')])).toEqual(['REMOVED', 'ADDED']);
  });

  it('compares an empty version with a full one', () => {
    expect(compareUnits([], [unit(1, 'x y')]).summary).toEqual({ equal: 0, added: 1, removed: 0, changed: 0 });
    expect(compareUnits([unit(1, 'x y')], []).summary).toEqual({ equal: 0, added: 0, removed: 1, changed: 0 });
    expect(compareUnits([], []).entries).toEqual([]);
  });

  it('refuses a comparison that would cost more than the bound', () => {
    const side = (prefix: string): CompareUnit[] => Array.from({ length: Math.ceil(Math.sqrt(MAX_COMPARE_CELLS)) + 10 }, (_, index) => unit(index + 1, `${prefix} ${index}`));
    let error: unknown;
    try {
      compareUnits(side('left'), side('right'));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('DOC_COMPARE_TOO_LARGE');
    expect((error as DomainError).status).toBe(422);
  });
});

describe('comparing a workbook by cell', () => {
  const cell = (sheet: string, ref: string, text: string, seq: number): CompareUnit => unit(seq, text, 'SHEET_CELL', `${sheet}!${ref}`);

  it('compares by the place of the cell, in sheet, row and column order', () => {
    const before = [cell('Dự toán', 'A1', 'Hạng mục', 1), cell('Dự toán', 'B1', '100', 2), cell('Dự toán', 'A2', 'Móng', 3), cell('Tổng', 'A1', 'Cộng', 4)];
    const after = [cell('Dự toán', 'A1', 'Hạng mục', 1), cell('Dự toán', 'B1', '120', 2), cell('Dự toán', 'B2', '55', 3), cell('Tổng', 'A1', 'Cộng', 4)];
    const result = compareUnits(before, after);
    expect(result.mode).toBe('CELLS');
    expect(result.entries.map((entry) => [(entry.after ?? entry.before)?.locatorKey, entry.op])).toEqual([
      ['Dự toán!A1', 'EQUAL'],
      ['Dự toán!B1', 'CHANGED'],
      ['Dự toán!A2', 'REMOVED'],
      ['Dự toán!B2', 'ADDED'],
      ['Tổng!A1', 'EQUAL'],
    ]);
    expect(result.summary).toEqual({ equal: 2, added: 1, removed: 1, changed: 1 });
  });

  it('orders columns past Z after Z', () => {
    const result = compareUnits([cell('S', 'AA1', 'x', 1)], [cell('S', 'Z1', 'y', 1), cell('S', 'AA1', 'x', 2)]);
    expect(result.entries.map((entry) => (entry.after ?? entry.before)?.locatorKey)).toEqual(['S!Z1', 'S!AA1']);
  });

  it('falls back to the sequence when a version mixes cells with paragraphs', () => {
    expect(compareUnits([cell('S', 'A1', 'x', 1)], [unit(1, 'x')]).mode).toBe('SEQUENCE');
  });
});
