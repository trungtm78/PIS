import type { MilestoneDates } from './procurement-file.ts';

/**
 * The sealed proposal and the declaration of conflict of interest (ST-BID-004, BID 3 F3 and BR-BID-03): a proposal is received while the bids are open, its contents stay
 * sealed until the opening of the bids of its package, and a member of the evaluation team reads them only when no conflict stands between them and the bidder.
 */

export const PROPOSAL_PARTS = ['LEGAL', 'TECHNICAL', 'FINANCIAL', 'OTHER'] as const;
export type ProposalPart = (typeof PROPOSAL_PARTS)[number];

export const PROPOSAL_STATUSES = ['RECEIVED', 'SUPERSEDED', 'WITHDRAWN'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const CONFLICT_DECISIONS = ['ALLOWED', 'RECUSED', 'BLOCKED'] as const;
export type ConflictDecision = (typeof CONFLICT_DECISIONS)[number];

export const MAX_PROPOSAL_FILES = 500;
export const MAX_FILE_TITLE = 200;
export const MAX_RELATION_TEXT = 2000;
export const MIN_CONFLICT_REASON = 20;
/** A clerk may log a proposal a little ahead of the clocks of the server: the time it was handed in is not in the future beyond this. */
export const RECEIPT_CLOCK_SKEW_MS = 5 * 60_000;

/** The moment a milestone counts from: the day it happened when it has, else the day it is planned for. */
export function milestoneMoment(dates: MilestoneDates | undefined): string | null {
  if (dates === undefined) return null;
  return dates.actualAt ?? dates.plannedAt;
}

export type ReceiptRefusal = 'BID_OPENING_UNSET' | 'BID_CLOSED' | 'SUBMITTED_IN_FUTURE';

/**
 * Whether a proposal handed in at `submittedAt` may be received at `now`. Without a date for the opening there is no moment to unseal the proposal at, so none is received
 * (fail closed); once the bids are opened none is received, whatever time the clerk says it was handed in; and one handed in after the closing is late. When the package has
 * no closing of its own, the opening is the closing.
 */
export function receiptRefusal(window: { openingAt: string | null; closingAt: string | null }, submittedAt: string, now: Date): ReceiptRefusal | undefined {
  if (window.openingAt === null) return 'BID_OPENING_UNSET';
  const handedIn = Date.parse(submittedAt);
  if (handedIn > now.getTime() + RECEIPT_CLOCK_SKEW_MS) return 'SUBMITTED_IN_FUTURE';
  if (now.getTime() >= Date.parse(window.openingAt)) return 'BID_CLOSED';
  if (handedIn > Date.parse(window.closingAt ?? window.openingAt)) return 'BID_CLOSED';
  return undefined;
}

export interface DeclarationFacts {
  hasConflict: boolean;
  decision: ConflictDecision | null;
  /** The contractor the relation is with; without it the conflict is with the whole package. */
  contractorId: string | null;
}

/** UNDECLARED: nothing declared yet. CLEAR: no conflict, or none with this contractor. PENDING: a conflict nobody has decided. */
export type ConflictStanding = 'UNDECLARED' | 'CLEAR' | 'ALLOWED' | 'PENDING' | 'RECUSED' | 'BLOCKED';

/**
 * What the declaration of a member means for the proposal of one contractor. A conflict that is not decided yet shuts the member out of what it covers; ALLOWED opens it;
 * RECUSED shuts out the bids of the contractor the relation is with (all of them when none is named); BLOCKED shuts out the whole package.
 */
export function conflictStanding(declaration: DeclarationFacts | undefined, contractorId: string): ConflictStanding {
  if (declaration === undefined) return 'UNDECLARED';
  if (!declaration.hasConflict) return 'CLEAR';
  if (declaration.decision === 'ALLOWED') return 'ALLOWED';
  if (declaration.decision === 'BLOCKED') return 'BLOCKED';
  const covers = declaration.contractorId === null || declaration.contractorId.toLowerCase() === contractorId.toLowerCase();
  if (!covers) return 'CLEAR';
  return declaration.decision === 'RECUSED' ? 'RECUSED' : 'PENDING';
}

/** What a declaration says about the member for the package as a whole, as the approver sees it. */
export function declarationStanding(declaration: DeclarationFacts): Exclude<ConflictStanding, 'UNDECLARED'> {
  if (!declaration.hasConflict) return 'CLEAR';
  return declaration.decision ?? 'PENDING';
}

/** Whether the member may open the proposal: no conflict, or one that was allowed. */
export const standingOpens = (standing: ConflictStanding): boolean => standing === 'CLEAR' || standing === 'ALLOWED';

/**
 * FULL: everything of the proposal. METADATA: the contractor, the time it was received and the number of files, never the price or a file. DECLARATION_REQUIRED: the
 * member would see it but has not declared. HIDDEN: it does not exist for the caller.
 */
export type ProposalView = 'FULL' | 'METADATA' | 'DECLARATION_REQUIRED' | 'HIDDEN';

export interface ViewFacts {
  status: ProposalStatus;
  released: boolean;
  /** The caller holds the evaluation right over the project of the package. */
  evaluator: boolean;
  /** The caller holds the right to receive proposals over the project of the package. */
  clerk: boolean;
  standing: ConflictStanding;
}

/**
 * What a caller sees of a proposal (BR-BID-03). The clerk who receives proposals sees their metadata at all times, the replaced ones included, and nothing more. A member of
 * the evaluation team sees the live proposal only from the moment it is released and only when no conflict stands in the way; before that, for them it does not exist.
 */
export function proposalView(facts: ViewFacts): ProposalView {
  const evaluation = evaluatorView(facts);
  if (evaluation === 'FULL') return 'FULL';
  if (facts.clerk) return 'METADATA';
  return evaluation;
}

function evaluatorView(facts: ViewFacts): ProposalView {
  if (!facts.evaluator || facts.status !== 'RECEIVED' || !facts.released) return 'HIDDEN';
  if (facts.standing === 'UNDECLARED') return 'DECLARATION_REQUIRED';
  return standingOpens(facts.standing) ? 'FULL' : 'HIDDEN';
}
