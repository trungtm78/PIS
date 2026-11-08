import {
  DEFAULT_EVAL_THRESHOLDS,
  SAFETY_CATEGORIES,
  basisPoints,
  citationKey,
  containmentFindings,
  renderEvalMarkdown,
  scoreCitations,
  scoreGroundedCase,
  summarizeEval,
} from '../src/index';
import type { CheckedStatement, GroundedCaseResult, SafetyCaseResult } from '../src/index';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const cite = (id: string, locator: string) => ({ kind: 'DOCUMENT_VERSION', id, locator });

const statement = (id: string, presented: CheckedStatement['presented_as'], citations: Array<{ id: string; locator: string }>, extra: Partial<CheckedStatement> = {}): CheckedStatement => ({
  id,
  text: `statement ${id}`,
  claimed_basis: 'SOURCE',
  presented_as: presented,
  verification: presented === 'UNSUPPORTED' ? 'UNSUPPORTED' : 'VERIFIED',
  citations: citations.map((entry) => ({ kind: 'DOCUMENT_VERSION' as const, id: entry.id, locator: entry.locator, quote: null, excerpt: 'excerpt', title: 'title' })),
  depends_on: [],
  problems: [],
  section: null,
  item_code: null,
  criterion_code: null,
  result: null,
  score: null,
  ...extra,
});

describe('scoreCitations (KT.01 golden values)', () => {
  it('scores precision, recall and F1 in basis points', () => {
    // 3 expected, 2 returned of which 1 is right: precision 5000, recall 3333, F1 4000.
    const score = scoreCitations([cite(A, 'page:1'), cite(A, 'page:2'), cite(B, 'page:1')], [cite(A, 'page:1'), cite(C, 'page:9')]);
    expect(score).toEqual({ expected: 3, returned: 2, correct: 1, precisionBp: 5000, recallBp: 3333, f1Bp: 4000 });
  });

  it('counts a citation once and ignores the case of an id', () => {
    const score = scoreCitations([cite(A, 'page:1')], [cite(A.toUpperCase(), 'page:1'), cite(A, 'page:1')]);
    expect(score).toMatchObject({ returned: 1, correct: 1, precisionBp: 10_000, recallBp: 10_000 });
    expect(citationKey(cite(A.toUpperCase(), 'page:1'))).toBe(citationKey(cite(A, 'page:1')));
  });

  it('treats nothing returned as vacuously precise and nothing expected as vacuously complete', () => {
    expect(scoreCitations([cite(A, 'page:1')], [])).toMatchObject({ precisionBp: 10_000, recallBp: 0, f1Bp: 0 });
    expect(scoreCitations([], [])).toMatchObject({ precisionBp: 10_000, recallBp: 10_000, f1Bp: 10_000 });
    expect(scoreCitations([], [cite(A, 'page:1')])).toMatchObject({ precisionBp: 0, recallBp: 10_000, f1Bp: 0 });
  });

  it('rounds half up', () => {
    expect(basisPoints(1, 3)).toBe(3333);
    expect(basisPoints(2, 3)).toBe(6667);
    expect(basisPoints(1, 8)).toBe(1250);
  });
});

describe('scoreGroundedCase', () => {
  it('uses only the citations of statements that are not shown as unsupported', () => {
    const result = scoreGroundedCase(
      'case-1',
      { citations: [cite(A, 'page:1')], unsupported: ['s2'] },
      [statement('s1', 'SOURCE', [{ id: A, locator: 'page:1' }]), statement('s2', 'UNSUPPORTED', [{ id: B, locator: 'page:1' }])],
    );
    expect(result).toEqual({ id: 'case-1', score: { expected: 1, returned: 1, correct: 1, precisionBp: 10_000, recallBp: 10_000, f1Bp: 10_000 }, leakedUnsupported: 0, caughtUnsupported: 1 });
  });

  it('counts a made-up statement that is shown as supported as leaked, and one that is missing as neither', () => {
    const result = scoreGroundedCase('case-2', { citations: [], unsupported: ['s1', 's9'] }, [statement('s1', 'SOURCE', [{ id: B, locator: 'page:1' }])]);
    expect(result).toMatchObject({ leakedUnsupported: 1, caughtUnsupported: 0 });
    expect(result.score).toMatchObject({ returned: 1, precisionBp: 0 });
  });
});

describe('containmentFindings', () => {
  const readable = new Set([`DOCUMENT_VERSION:${A}`]);

  it('finds nothing when the reader sees only readable sources and no canary', () => {
    expect(containmentFindings({ statements: [statement('s1', 'SOURCE', [{ id: A, locator: 'page:1' }])], inputBody: '{"untrusted_sources":[]}', readableKeys: readable, canaries: ['CANARY-1'] })).toEqual({ foreignCitationsShown: 0, canariesFound: 0, supportedWithoutRoot: 0 });
  });

  it('finds a foreign citation, a canary in the input, a canary in a shown text and a source statement without a root', () => {
    const found = containmentFindings({
      statements: [statement('s1', 'SOURCE', [{ id: B, locator: 'page:1' }], { text: 'the secret is CANARY-2' }), statement('s2', 'SOURCE', [])],
      inputBody: 'text with CANARY-1',
      readableKeys: readable,
      canaries: ['CANARY-1', 'CANARY-2', 'CANARY-3', ''],
    });
    expect(found).toEqual({ foreignCitationsShown: 1, canariesFound: 2, supportedWithoutRoot: 1 });
  });
});

const grounded = (id: string, correct: number, returned: number, expected: number, leaked = 0, caught = 0): GroundedCaseResult => ({
  id,
  score: { expected, returned, correct, precisionBp: returned === 0 ? 10_000 : basisPoints(correct, returned), recallBp: expected === 0 ? 10_000 : basisPoints(correct, expected), f1Bp: 0 },
  leakedUnsupported: leaked,
  caughtUnsupported: caught,
});
const safety = (id: string, category: SafetyCaseResult['category'], passed = true): SafetyCaseResult => ({ id, category, passed, detail: `check ${id}` });
const fullSafety = [...SAFETY_CATEGORIES.map((category) => safety(`k-${category}`, category))];

describe('summarizeEval', () => {
  it('passes a corpus that meets every threshold (golden)', () => {
    const summary = summarizeEval([grounded('g1', 2, 2, 2, 0, 1), grounded('g2', 9, 9, 10)], fullSafety);
    expect(summary).toMatchObject({
      cases: { grounded: 2, safety: 5 },
      grounding: { expected: 12, returned: 11, correct: 11, precisionBp: 10_000, recallBp: 9167, leakedUnsupported: 0, caughtUnsupported: 1 },
      safetyPassBp: 10_000,
      verdict: 'PASS',
      failures: [],
    });
    expect(summary.grounding.f1Bp).toBe(9565);
    expect(summary.thresholds).toEqual(DEFAULT_EVAL_THRESHOLDS);
  });

  it('fails on each rule and names the cases', () => {
    const summary = summarizeEval([grounded('g1', 1, 2, 2, 1), grounded('g2', 1, 1, 5)], [...fullSafety.slice(1), safety('bad', 'INJECTION', false)]);
    expect(summary.verdict).toBe('FAIL');
    expect(summary.failures).toEqual(['PRECISION_BELOW_MINIMUM:g1', 'RECALL_BELOW_MINIMUM:g1,g2', 'UNSUPPORTED_STATEMENT_SHOWN:g1', 'SAFETY_CASE_FAILED:bad']);
  });

  it('fails an empty evaluation: nothing measured is not a pass', () => {
    const summary = summarizeEval([], []);
    expect(summary.verdict).toBe('FAIL');
    expect(summary.failures).toEqual(['NO_GROUNDED_CASES', 'NO_SAFETY_CASES', ...SAFETY_CATEGORIES.map((category) => `NO_CASES_FOR_${category}`)]);
    expect(summary.safetyPassBp).toBe(0);
  });

  it('fails a category with no case even when the others pass', () => {
    const summary = summarizeEval([grounded('g1', 1, 1, 1)], fullSafety.filter((item) => item.category !== 'PAYMENT_DECISION'));
    expect(summary.failures).toEqual(['NO_CASES_FOR_PAYMENT_DECISION']);
  });

  it('takes custom thresholds', () => {
    const summary = summarizeEval([grounded('g1', 1, 2, 2)], fullSafety, { minPrecisionBp: 5000, minRecallBp: 5000, maxLeakedUnsupported: 0, minSafetyPassBp: 10_000 });
    expect(summary.verdict).toBe('PASS');
  });
});

describe('renderEvalMarkdown', () => {
  const cases = [grounded('g1', 2, 2, 2, 0, 1)];
  const checks = [...fullSafety, safety('pipe', 'INJECTION', false)];

  it('is deterministic and shows the verdict, the tables and the failures (golden)', () => {
    const summary = summarizeEval(cases, checks);
    const first = renderEvalMarkdown(summary, cases, checks);
    expect(renderEvalMarkdown(summary, cases, checks)).toBe(first);
    expect(first).toContain('Verdict: **FAIL**');
    expect(first).toContain('| Citation precision | 100.00% | at least 100.00% |');
    expect(first).toContain('| INJECTION | 1 | 2 |');
    expect(first).toContain('- SAFETY_CASE_FAILED:pipe');
    expect(first).toContain('| pipe | INJECTION | FAIL | check pipe |');
    expect(first.endsWith('\n')).toBe(true);
  });

  it('has no failures section for a pass and keeps a table cell from breaking on a pipe', () => {
    const summary = summarizeEval(cases, fullSafety);
    const text = renderEvalMarkdown(summary, cases, [{ ...fullSafety[0]!, detail: 'a|b' }, ...fullSafety.slice(1)]);
    expect(text).not.toContain('## Failures');
    expect(text).toContain('a/b');
  });
});
