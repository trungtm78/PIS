import { DomainError } from './errors.ts';
import { assertFourEyes } from './four-eyes.ts';

/**
 * The certification of a data product (ST-DGV-009, DGV 3.1 F9, DGV-18, UAT-AC495). A product is NOT_ASSESSED until somebody other than its owner decides: PROVISIONAL (trusted for now), CERTIFIED (only with
 * evidence, a day it runs out and, in the store, every dataset of the product on a published contract and a passing run) or REVOKED. A certification that runs out becomes PROVISIONAL by itself; a revoked product is
 * never certified again. Pure functions of their input.
 */
export const PRODUCT_STATUSES = ['NOT_ASSESSED', 'PROVISIONAL', 'CERTIFIED', 'REVOKED'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];
export const PRODUCT_DECISIONS = ['CERTIFIED', 'PROVISIONAL', 'REVOKED'] as const;
export type ProductDecision = (typeof PRODUCT_DECISIONS)[number];

export const MAX_EVIDENCE = 500;
/** One piece of evidence is a small record (a link, a run, a document), not a payload. */
export const MAX_EVIDENCE_BYTES = 4096;
const REASON_MIN = 10;
const REASON_MAX = 2000;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface ProductDecisionInput {
  decision: ProductDecision;
  reason: string;
  evidenceRefs: readonly unknown[];
  expiresOn: string | undefined;
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

function isDay(value: string): boolean {
  const match = DAY.exec(value);
  if (match === null) return false;
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** The status a decision leads to from the current one, or 409 `PRODUCT_STATE_INVALID`: a certification is renewed, a certified product is revoked, a revoked one is final. */
export function nextProductStatus(current: ProductStatus, decision: ProductDecision): ProductStatus {
  const allowed: Record<ProductStatus, readonly ProductDecision[]> = {
    NOT_ASSESSED: ['PROVISIONAL', 'CERTIFIED'],
    PROVISIONAL: ['CERTIFIED'],
    CERTIFIED: ['CERTIFIED', 'REVOKED'],
    REVOKED: [],
  };
  if (!allowed[current].includes(decision)) throw new DomainError('PRODUCT_STATE_INVALID', 409, 'decision', { extensions: { status: current } });
  return decision;
}

/**
 * What a decision needs of its own, before the datasets are looked at: the reason (10 to 2000 characters); the person is not the owner of the product when the decision lifts it (CERTIFIED, PROVISIONAL: 403
 * `SELF_APPROVAL_DENIED`; an owner may withdraw their own product); a certification names its evidence (at least one small record, at most 500) and a day it runs out that is after `today`; the other
 * decisions name no day.
 */
export function assertProductDecision(input: ProductDecisionInput, ownerId: string, actorId: string, today: string): void {
  if (input.decision !== 'REVOKED') assertFourEyes(ownerId, actorId);
  const reason = input.reason.trim();
  if (reason.length < REASON_MIN || reason.length > REASON_MAX) throw invalid('reason');
  if (input.evidenceRefs.length > MAX_EVIDENCE) throw invalid('evidence_refs');
  for (const item of input.evidenceRefs) {
    if (typeof item !== 'object' || item === null || Array.isArray(item) || JSON.stringify(item).length > MAX_EVIDENCE_BYTES) throw invalid('evidence_refs');
  }
  if (input.decision === 'CERTIFIED') {
    if (input.evidenceRefs.length < 1) throw invalid('evidence_refs');
    if (input.expiresOn === undefined || !isDay(input.expiresOn) || input.expiresOn <= today) throw invalid('certification_expires_on');
  } else if (input.expiresOn !== undefined) {
    throw invalid('certification_expires_on');
  }
}
