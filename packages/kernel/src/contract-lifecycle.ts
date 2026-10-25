import { DomainError } from './errors.ts';
import { activeGrants } from './effective-access.ts';
import type { EffectiveAccess } from './effective-access.ts';
import { permissionMatches } from './permission.ts';
import { scopeContains } from './scope.ts';
import type { ResourceRef } from './scope.ts';

/**
 * The life of a contract (CTR section 4, ST-CTR-004): one table says which command moves a contract from which status to which, whoever asks, and everything else is
 * 409 `CONTRACT_STATE_INVALID`. The database holds the same edges (V1380) as the last word for a statement that bypasses the commands.
 */
export const CONTRACT_STATUSES = ['DRAFT', 'IN_REVIEW', 'SIGNED', 'ACTIVE', 'SUSPENDED', 'TERMINATED', 'COMPLETED', 'CLOSED', 'CANCELLED'] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const CONTRACT_COMMANDS = [
  'submitContractForReview',
  'returnContractDraft',
  'recordContractSigning',
  'activateContract',
  'suspendContract',
  'resumeContract',
  'terminateContract',
  'completeContract',
  'closeContract',
  'cancelContractDraft',
] as const;
export type ContractCommand = (typeof CONTRACT_COMMANDS)[number];

interface Edge {
  from: readonly ContractStatus[];
  to: ContractStatus;
}

export const CONTRACT_TRANSITIONS: Readonly<Record<ContractCommand, Edge>> = {
  submitContractForReview: { from: ['DRAFT'], to: 'IN_REVIEW' },
  returnContractDraft: { from: ['IN_REVIEW'], to: 'DRAFT' },
  recordContractSigning: { from: ['IN_REVIEW'], to: 'SIGNED' },
  activateContract: { from: ['SIGNED'], to: 'ACTIVE' },
  suspendContract: { from: ['ACTIVE'], to: 'SUSPENDED' },
  resumeContract: { from: ['SUSPENDED'], to: 'ACTIVE' },
  terminateContract: { from: ['SIGNED', 'ACTIVE', 'SUSPENDED'], to: 'TERMINATED' },
  completeContract: { from: ['ACTIVE'], to: 'COMPLETED' },
  closeContract: { from: ['COMPLETED', 'TERMINATED'], to: 'CLOSED' },
  cancelContractDraft: { from: ['DRAFT', 'IN_REVIEW'], to: 'CANCELLED' },
};

/** Where a command takes a contract that is in `from`; undefined when the command does not apply to that status. */
export function contractTransition(command: ContractCommand, from: ContractStatus): ContractStatus | undefined {
  const edge = CONTRACT_TRANSITIONS[command];
  return edge.from.includes(from) ? edge.to : undefined;
}

/** The status a command leads to, or 409 `CONTRACT_STATE_INVALID` with the status the contract is in. */
export function assertContractTransition(command: ContractCommand, from: ContractStatus): ContractStatus {
  const to = contractTransition(command, from);
  if (to === undefined) throw new DomainError('CONTRACT_STATE_INVALID', 409, 'status', { extensions: { contract_status: from, command } });
  return to;
}

/** The statuses from which a contract has been signed: the signature, its date and its document are on the record. */
export const SIGNED_STATUSES: readonly ContractStatus[] = ['SIGNED', 'ACTIVE', 'SUSPENDED', 'TERMINATED', 'COMPLETED', 'CLOSED'];

// ---- what activation needs ------------------------------------------------------------------------------------------------------------

/**
 * The groups of advance a contract belongs to (CTR table `contract.advance_category`) that works under a building permit: the activation of such a contract waits for the gate
 * `CONTRACT_ACTIVATION` of the permits (BR-CTR-14). The others do not build.
 */
export const PERMIT_GATED_CATEGORIES: readonly string[] = ['CONSTRUCTION', 'EPC'];

/**
 * The groups that are exempt from the performance guarantee (BR-CTR-10, "when the rule requires"). The rule that decides this is not configured anywhere yet, so the exemption
 * is a working assumption: land clearance is not a contract of procurement and consulting contracts are not secured by a bank guarantee here.
 */
export const GUARANTEE_EXEMPT_CATEGORIES: readonly string[] = ['CONSULTING', 'LAND_CLEARANCE'];

export const requiresPermitGate = (advanceCategory: string): boolean => PERMIT_GATED_CATEGORIES.includes(advanceCategory);
export const requiresPerformanceGuarantee = (advanceCategory: string): boolean => !GUARANTEE_EXEMPT_CATEGORIES.includes(advanceCategory);

/** The DoA document type under which the signing and the activation of a contract are approved (ADM matrix, BR-CTR-15). */
export const CONTRACT_DOA_DOCUMENT_TYPE = 'CTR_CONTRACT';

export const MAX_LIFECYCLE_TEXT = 2000;

// ---- who may decide -------------------------------------------------------------------------------------------------------------------

export interface LifecycleActors {
  /** Who drafted the contract. */
  createdBy: string | null;
  /** Who sent it to review, while it is in review. */
  submittedBy: string | null;
}

/**
 * Whether the actor is one of the people whose work they would be approving (BR-CTR-15, maker is not checker): the one who drafted the contract, or the one who sent it to
 * review. Identifiers are compared as the lower-case text the database writes.
 */
export function isMakerOf(actor: string, actors: LifecycleActors): boolean {
  const who = actor.toLowerCase();
  return [actors.createdBy, actors.submittedBy].some((maker) => maker !== null && maker.toLowerCase() === who);
}

/** 403 `SELF_APPROVAL_DENIED` for a maker who approves their own work. */
export function assertNotMaker(actor: string, actors: LifecycleActors): void {
  if (isMakerOf(actor, actors)) throw new DomainError('SELF_APPROVAL_DENIED', 403);
}

/**
 * Whether the caller holds `permission` with a rank that reaches `requiredRank` over a place that contains the contract: the delegation limit of the DoA matrix is a role (and
 * every role above it), so a leader below the band of the contract may not sign it (403 `SCOPE_DENIED`) and a higher one may.
 */
export function withinDelegation(access: EffectiveAccess, now: Date, permission: string, place: ResourceRef, requiredRank: number): boolean {
  return activeGrants(access, now).some(
    (grant) => grant.rank >= requiredRank && grant.permissions.some((held) => permissionMatches(held, permission)) && scopeContains(grant.scope, place),
  );
}

// ---- the declaration of conflict at the signing --------------------------------------------------------------------------------------

export type ConflictVerdict = 'FREE' | 'BLOCKED';

/**
 * What the conflict of interest of the two people at the signing means (BR-CTR-13). The one who signs is never in conflict (blocked, the decision of the authority cannot
 * change that); when the one who reviewed was, the signature of someone else is valid only with the decision that dealt with it on the record.
 */
export function signingConflict(input: { signerInConflict: boolean; reviewerInConflict: boolean; decisionRef: string | undefined }): ConflictVerdict {
  if (input.signerInConflict) return 'BLOCKED';
  if (input.reviewerInConflict && (input.decisionRef === undefined || input.decisionRef.trim() === '')) return 'BLOCKED';
  return 'FREE';
}
