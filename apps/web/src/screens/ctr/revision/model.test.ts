import { describe, expect, it } from 'vitest';
import { toBoqLine } from '../boq-model';
import { toContractView } from '../model';
import type { RevisionLine } from '../model';
import { boqLine, detail, revision as revisionFixture } from '../test-support';
import { DECISION_PATH, VERSIONS_PATH, decisionBody, decisionLink, diffLines, emptyDecision, evidenceIds, parseLines, timelineOf, validateDecision, versionsLink } from './model';
import type { DecisionForm } from './model';

const UUID = '00000000-0000-4000-8000-0000000000a1';
const TODAY = '2026-10-25';

const revisions = (): RevisionLine[] => {
  const view = toContractView(
    detail(1, {
      revisions: [
        revisionFixture(1, { id: 'r1', revision: 1, status: 'SUPERSEDED', amount_vnd: '10000000000', valid_from: '2026-01-02', valid_until: '2026-08-01', boq_total_vnd: '10000000000', boq_line_count: 2 }),
        revisionFixture(1, { id: 'r2', revision: 2, status: 'EFFECTIVE', kind: 'CHANGE_ORDER', amount_vnd: '10500000000', valid_from: '2026-08-01', supersedes_id: 'r1', change_request_id: 'c1', change_request_code: 'CO-001', boq_total_vnd: '10000000000', boq_line_count: 2 }),
        revisionFixture(1, { id: 'r3', revision: 3, status: 'PENDING_EFFECTIVE', kind: 'CHANGE_ORDER', amount_vnd: '10200000000', valid_from: '2026-12-01', supersedes_id: 'r2', change_request_id: 'c2', boq_total_vnd: '10200000000', boq_line_count: 2 }),
        revisionFixture(1, { id: 'r4', revision: 4, status: 'REJECTED', amount_vnd: '1' }),
        revisionFixture(1, { id: 'r5', revision: 5, status: 'DRAFT', amount_vnd: '2' }),
      ],
    }),
  );
  return view?.revisions ?? [];
};

describe('the addresses of the two screens', () => {
  it('names the change order and its project, and the contract', () => {
    expect(decisionLink('p1', 'c1')).toBe(`${DECISION_PATH}?project=p1&request=c1`);
    expect(versionsLink('k1')).toBe(`${VERSIONS_PATH}?id=k1`);
  });
});

describe('the timeline of the revisions of a contract', () => {
  it('reads what the server says of a revision: the end of its period, the one it follows, the change order that made it', () => {
    const [first, second] = revisions();
    expect(first).toMatchObject({ validUntil: '2026-08-01', supersedesId: null, changeRequest: null, retroactive: false });
    expect(second).toMatchObject({ validUntil: null, supersedesId: 'r1', changeRequest: { id: 'c1', code: 'CO-001' } });
  });

  it('puts them in order with how each stands and what it adds to the one it follows', () => {
    const entries = timelineOf([...revisions()].reverse());
    expect(entries.map((entry) => [entry.revision.revision, entry.standing, entry.deltaVnd])).toEqual([
      [1, 'OVER', null],
      [2, 'IN_FORCE', '500000000'],
      [3, 'WAITING', '-300000000'],
      [4, 'REJECTED', null],
      [5, 'DRAFT', null],
    ]);
  });

  it('says how much of the value the BOQ does not cover, for a revision that was decided', () => {
    const entries = timelineOf(revisions());
    expect(entries.map((entry) => entry.boqShortVnd)).toEqual([null, '500000000', null, null, null]);
  });

  it('leaves out what it cannot compute: a revision without the one it follows, a total that is not a number', () => {
    const [first] = timelineOf([{ ...revisions()[1]!, supersedesId: 'gone' }]);
    expect(first?.deltaVnd).toBeNull();
    const [unknown] = timelineOf([{ ...revisions()[1]!, boqTotalVnd: undefined }]);
    expect(unknown?.boqShortVnd).toBeNull();
  });
});

describe('the comparison of two BOQs', () => {
  const line = (key: string, quantity: string, price: string, amount: string, id = key) => {
    const parsed = toBoqLine(boqLine(1, { id, business_key: key, description: `Item ${key}`, quantity, unit_price: price, amount_vnd: amount }));
    if (parsed === undefined) throw new Error('line');
    return parsed;
  };

  it('tells what was added, taken out, re-priced and left as it was, by item', () => {
    const diff = diffLines([line('B01', '1', '9000000000', '9000000000'), line('B02', '500', '2000000', '1000000000'), line('B03', '1', '5', '5')], [line('B01', '1', '9000000000', '9000000000'), line('B02', '500', '2100000', '1050000000'), line('B04', '2', '3', '6')]);
    expect(diff.map((row) => [row.businessKey, row.change])).toEqual([
      ['B01', 'SAME'],
      ['B02', 'CHANGED'],
      ['B03', 'REMOVED'],
      ['B04', 'ADDED'],
    ]);
    expect(diff[1]).toMatchObject({ description: 'Item B02', before: { unitPrice: '2000000' }, after: { unitPrice: '2100000' } });
    expect(diff[2]?.after).toBeUndefined();
    expect(diff[3]?.before).toBeUndefined();
  });
});

describe('the form of the decision', () => {
  const form = (overrides: Partial<DecisionForm> = {}): DecisionForm => ({ ...emptyDecision('500000000', TODAY), decision: 'approve', reason: 'Within the plan.', documentVersionId: UUID, ...overrides });

  it('starts from the assessment and today', () => {
    expect(emptyDecision('500000000', TODAY)).toEqual({ decision: '', reason: '', evidence: '', approvedDeltaVnd: '500000000', effectiveOn: TODAY, documentVersionId: '', boqLines: '' });
    expect(emptyDecision(null, TODAY).approvedDeltaVnd).toBe('');
  });

  it('asks for a decision first, and for nothing else until one is chosen', () => {
    expect(validateDecision(emptyDecision(null, TODAY), TODAY)).toEqual({ decision: 'choose' });
  });

  it('asks an approval for the reason, the document, the amount and the day', () => {
    expect(validateDecision(form(), TODAY)).toEqual({});
    expect(validateDecision(form({ reason: ' ', documentVersionId: '', approvedDeltaVnd: '', effectiveOn: '' }), TODAY)).toEqual({ reason: 'required', documentVersionId: 'required', approvedDeltaVnd: 'required', effectiveOn: 'required' });
    expect(validateDecision(form({ reason: 'x'.repeat(2001), documentVersionId: 'nope', approvedDeltaVnd: '1.5', effectiveOn: '2026-02-30' }), TODAY)).toEqual({ reason: 'tooLong', documentVersionId: 'uuid', approvedDeltaVnd: 'amount', effectiveOn: 'date' });
    expect(validateDecision(form({ effectiveOn: '2026-10-24' }), TODAY)).toEqual({ effectiveOn: 'past' });
    expect(validateDecision(form({ effectiveOn: TODAY }), TODAY)).toEqual({});
    expect(validateDecision(form({ approvedDeltaVnd: '-250000000' }), TODAY)).toEqual({});
  });

  it('asks a return or a rejection for the reason alone', () => {
    expect(validateDecision(form({ decision: 'return', documentVersionId: '', approvedDeltaVnd: '', effectiveOn: '' }), TODAY)).toEqual({});
    expect(validateDecision(form({ decision: 'reject', reason: '' }), TODAY)).toEqual({ reason: 'required' });
  });

  it('judges the evidence and the lines of the BOQ', () => {
    expect(validateDecision(form({ evidence: `${UUID}\n${UUID.toUpperCase()}, ${UUID}` }), TODAY)).toEqual({});
    expect(validateDecision(form({ evidence: 'nope' }), TODAY)).toEqual({ evidence: 'evidence' });
    expect(validateDecision(form({ evidence: Array.from({ length: 51 }, (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`).join(' ') }), TODAY)).toEqual({ evidence: 'evidence' });
    expect(validateDecision(form({ boqLines: '[{"business_key":"B01"}]' }), TODAY)).toEqual({});
    for (const bad of ['{', '[]', '{"a":1}', '[1]', '[[1]]', 'null']) expect(validateDecision(form({ boqLines: bad }), TODAY)).toEqual({ boqLines: 'json' });
    expect(validateDecision(form({ decision: 'reject', boqLines: '{' }), TODAY)).toEqual({});
  });

  it('reads the lines typed as JSON: none, a list, or nothing it can use', () => {
    expect(parseLines('  ')).toBeUndefined();
    expect(parseLines('[{"business_key":"B01"},{"business_key":"B02"}]')).toEqual([{ business_key: 'B01' }, { business_key: 'B02' }]);
    expect(parseLines('[{"a":1}')).toBeNull();
    expect(parseLines(JSON.stringify(Array.from({ length: 2001 }, () => ({}))))).toBeNull();
  });

  it('lists the evidence once each, in lower case', () => {
    expect(evidenceIds(form({ evidence: ` ${UUID.toUpperCase()};${UUID} ` }))).toEqual([UUID, UUID]);
  });

  it('writes the body: an approval with everything it needs, a return or a rejection with the reason alone', () => {
    expect(decisionBody(form({ reason: ' Within the plan. ', evidence: `${UUID}, ${UUID.toUpperCase()}`, approvedDeltaVnd: ' -0250 ', documentVersionId: UUID.toUpperCase() }), 'approve')).toEqual({
      decision: 'approve',
      reason: 'Within the plan.',
      evidence_ids: [UUID],
      approved_delta_vnd: '-250',
      effective_on: TODAY,
      decision_document_version_id: UUID,
    });
    expect(decisionBody(form({ boqLines: '[{"business_key":"B01"}]' }), 'approve').boq_lines).toEqual([{ business_key: 'B01' }]);
    expect(decisionBody(form({ decision: 'return', reason: 'Thin.' }), 'return')).toEqual({ decision: 'return', reason: 'Thin.', evidence_ids: [] });
    expect(decisionBody(form({ decision: 'reject', reason: 'No.' }), 'reject')).toEqual({ decision: 'reject', reason: 'No.', evidence_ids: [] });
  });
});
