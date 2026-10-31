import { assertProductDecision, nextProductStatus } from '../src/dgv-product';
import type { ProductDecisionInput } from '../src/dgv-product';

const refusal = (run: () => unknown): { code: string; detail: string | undefined; status: number } => {
  try {
    run();
  } catch (error) {
    const known = error as { code: string; detail?: string; status: number };
    return { code: known.code, detail: known.detail, status: known.status };
  }
  throw new Error('it was allowed');
};
const OWNER = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000a2';
const TODAY = '2026-10-31';
const CERTIFY: ProductDecisionInput = { decision: 'CERTIFIED', reason: 'The contract is published and the run passed.', evidenceRefs: [{ run_id: 'r1' }], expiresOn: '2027-06-30' };

describe('the status a decision leads to', () => {
  it.each([
    ['NOT_ASSESSED', 'PROVISIONAL'],
    ['NOT_ASSESSED', 'CERTIFIED'],
    ['PROVISIONAL', 'CERTIFIED'],
    ['CERTIFIED', 'CERTIFIED'],
    ['CERTIFIED', 'REVOKED'],
  ] as const)('goes from %s with %s', (current, decision) => {
    expect(nextProductStatus(current, decision)).toBe(decision);
  });

  it.each([
    ['NOT_ASSESSED', 'REVOKED'],
    ['PROVISIONAL', 'PROVISIONAL'],
    ['PROVISIONAL', 'REVOKED'],
    ['CERTIFIED', 'PROVISIONAL'],
    ['REVOKED', 'CERTIFIED'],
    ['REVOKED', 'PROVISIONAL'],
    ['REVOKED', 'REVOKED'],
  ] as const)('refuses %s with %s (409), a revoked product being final', (current, decision) => {
    expect(refusal(() => nextProductStatus(current, decision))).toMatchObject({ code: 'PRODUCT_STATE_INVALID', status: 409 });
  });
});

describe('what a decision needs', () => {
  it('lets somebody other than the owner certify with evidence and a day in the future', () => {
    expect(() => assertProductDecision(CERTIFY, OWNER, OTHER, TODAY)).not.toThrow();
  });

  it('refuses the owner certifying or lifting their own product to provisional (403), and lets them revoke it', () => {
    expect(refusal(() => assertProductDecision(CERTIFY, OWNER, OWNER, TODAY))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
    const provisional: ProductDecisionInput = { decision: 'PROVISIONAL', reason: 'Awaiting the first run.', evidenceRefs: [], expiresOn: undefined };
    expect(refusal(() => assertProductDecision(provisional, OWNER, OWNER.toUpperCase(), TODAY)).code).toBe('SELF_APPROVAL_DENIED');
    const revoke: ProductDecisionInput = { decision: 'REVOKED', reason: 'The source was withdrawn.', evidenceRefs: [], expiresOn: undefined };
    expect(() => assertProductDecision(revoke, OWNER, OWNER, TODAY)).not.toThrow();
  });

  it('wants a reason of 10 to 2000 characters', () => {
    for (const reason of ['', '         x', 'x'.repeat(2001)]) expect(refusal(() => assertProductDecision({ ...CERTIFY, reason }, OWNER, OTHER, TODAY))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
    expect(() => assertProductDecision({ ...CERTIFY, reason: 'x'.repeat(2000) }, OWNER, OTHER, TODAY)).not.toThrow();
  });

  it('wants a certification to name its evidence: at least one record, at most 500, each a small object', () => {
    for (const evidenceRefs of [[], Array.from({ length: 501 }, () => ({})), ['text'], [null], [[1]], [{ blob: 'x'.repeat(5000) }]]) {
      expect(refusal(() => assertProductDecision({ ...CERTIFY, evidenceRefs }, OWNER, OTHER, TODAY))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'evidence_refs' });
    }
    expect(() => assertProductDecision({ ...CERTIFY, evidenceRefs: Array.from({ length: 500 }, () => ({ run_id: 'r' })) }, OWNER, OTHER, TODAY)).not.toThrow();
  });

  it('wants a certification to run out on a real day after today', () => {
    for (const expiresOn of [undefined, '2026-10-31', '2026-10-30', '2027-02-30', '2027-13-01', '30/06/2027', '2027-6-30']) {
      expect(refusal(() => assertProductDecision({ ...CERTIFY, expiresOn }, OWNER, OTHER, TODAY))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'certification_expires_on' });
    }
    expect(() => assertProductDecision({ ...CERTIFY, expiresOn: '2026-11-01' }, OWNER, OTHER, TODAY)).not.toThrow();
  });

  it('names no day for a decision that is not a certification, and asks no evidence of it', () => {
    const provisional: ProductDecisionInput = { decision: 'PROVISIONAL', reason: 'Awaiting the first run.', evidenceRefs: [], expiresOn: undefined };
    expect(() => assertProductDecision(provisional, OWNER, OTHER, TODAY)).not.toThrow();
    expect(refusal(() => assertProductDecision({ ...provisional, expiresOn: '2027-06-30' }, OWNER, OTHER, TODAY))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'certification_expires_on' });
    expect(refusal(() => assertProductDecision({ ...provisional, decision: 'REVOKED', expiresOn: '2027-06-30' }, OWNER, OTHER, TODAY)).detail).toBe('certification_expires_on');
  });
});
