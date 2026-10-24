import { describe, expect, it } from 'vitest';
import vectors from '../../../../../../packages/contracts/test-vectors/doa-matrix.json';
import { bandRows, draftFindings, formatVnd, parseVnd, resolveDoa, submitFindings, unitPathsOf } from './engine';
import type { DoaMatrixRecord, DoaQuery, DoaRuleInput } from './engine';

type DraftRow = [string, string, string, string | null];

const matrices = vectors.matrices as unknown as Record<string, DoaMatrixRecord>;
const pathsOf = (without?: string): Map<string, string> => new Map(Object.entries(vectors.unitPaths).filter(([unit]) => unit !== without));
const ruleOf = ([document_type, unit_id, amount_min_vnd, amount_max_vnd]: DraftRow): DoaRuleInput => ({ document_type, unit_id, amount_min_vnd, amount_max_vnd, approver_role_id: 'ROLE' });
const codesOf = (found: Array<{ field: string; code: string }>): string[] => found.map((entry) => `${entry.field}:${entry.code}`);
const chosen = (names: string[]): DoaMatrixRecord[] => names.map((name) => matrices[name] as DoaMatrixRecord);

describe('the rules of the matrix on the screen give the answers of the server (shared vectors)', () => {
  it.each(vectors.resolutions)('resolves: $name', ({ matrices: names, query, expected }) => {
    expect(resolveDoa(chosen(names), pathsOf(), query as DoaQuery)).toEqual({ ok: true, resolution: expected });
  });

  it.each(vectors.refused)('does not resolve: $name', ({ matrices: names, query, pathsWithout, code, detail }) => {
    const failure = code === 'DOA_RULE_NOT_FOUND' ? 'notFound' : detail === 'unit_id' ? 'unit' : 'amount';
    expect(resolveDoa(chosen(names), pathsOf(pathsWithout), query as DoaQuery)).toEqual({ ok: false, failure });
  });

  it.each(vectors.drafts)('finds in a draft and in a submission: $name', ({ rules, draft, submit }) => {
    const content = (rules as DraftRow[]).map(ruleOf);
    expect(codesOf(draftFindings(content))).toEqual(draft);
    expect(codesOf(submitFindings(content))).toEqual(submit);
  });
});

describe('the band chart', () => {
  const rows = (rules: DraftRow[]) => bandRows(rules.map(ruleOf));

  it('shows three bands that run from 0 to no end without any gap', () => {
    const [row] = rows([['FX', 'province', '0', '5000000000'], ['FX', 'province', '5000000000', '25000000000'], ['FX', 'province', '25000000000', null]]);
    expect(row?.segments.map((segment) => [segment.kind, segment.from, segment.to, segment.index, segment.overlaps])).toEqual([
      ['band', '0', '5000000000', 0, false],
      ['band', '5000000000', '25000000000', 1, false],
      ['band', '25000000000', null, 2, false],
    ]);
  });

  it('shows the gap between two bands, the gap before the first band and the gap after the last as segments of their own', () => {
    const [row] = rows([['FX', 'province', '10', '20'], ['FX', 'province', '30', '40']]);
    expect(row?.segments.map((segment) => [segment.kind, segment.from, segment.to])).toEqual([
      ['gap', '0', '10'],
      ['band', '10', '20'],
      ['gap', '20', '30'],
      ['band', '30', '40'],
      ['gap', '40', null],
    ]);
  });

  it('marks a band that overlaps the one before it, in any order of entry', () => {
    const [row] = rows([['FX', 'province', '5', null], ['FX', 'province', '0', '9']]);
    expect(row?.segments.map((segment) => [segment.kind, segment.index, segment.overlaps])).toEqual([
      ['band', 1, false],
      ['band', 0, true],
    ]);
  });

  it('keeps a row for each document type and unit, and leaves a band that cannot be read out of the chart', () => {
    const result = rows([['FX', 'province', '0', null], ['PAY', 'province', '0', null], ['FX', 'department', '0', null], ['FX', 'board', 'x', null], ['FX', 'board', '9', '9']]);
    expect(result.map((row) => `${row.documentType}/${row.unitId}`)).toEqual(['FX/province', 'PAY/province', 'FX/department']);
  });
});

describe('unit paths from the parent links', () => {
  it('builds the path of each unit from the root, and stops at a loop', () => {
    const paths = unitPathsOf([
      { id: 'a', parent_id: null },
      { id: 'b', parent_id: 'a' },
      { id: 'c', parent_id: 'b' },
      { id: 'x', parent_id: 'y' },
      { id: 'y', parent_id: 'x' },
      { id: 'o', parent_id: 'missing' },
    ]);
    expect(paths.get('a')).toBe('/a/');
    expect(paths.get('c')).toBe('/a/b/c/');
    expect(paths.get('x')).toBe('/y/x/');
    expect(paths.get('o')).toBe('/missing/o/');
  });
});

describe('amounts', () => {
  it('reads whole VND exactly and formats them with the separators of the language', () => {
    expect(parseVnd('5000000000')).toBe(5_000_000_000n);
    expect(parseVnd('5.5')).toBeUndefined();
    expect(formatVnd('5000000000', 'en')).toBe('5,000,000,000');
    expect(formatVnd('5000000000', 'vi')).toBe('5.000.000.000');
    expect(formatVnd('999999999999999999999999', 'en')).toBe('999,999,999,999,999,999,999,999');
    expect(formatVnd('12.5', 'en')).toBe('12.5');
  });
});
