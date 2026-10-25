import { assertNotProposer } from './contract-halt.ts';
import { DomainError } from './errors.ts';

/**
 * A non-conformance of the work under a contract and the actions that put it right (ST-QMS-006, QMS 3.3, BR-QMS-07): how serious it is, where it stands, what the actions say about where it stands, and who
 * may verify an action or close the non-conformance. Pure functions of their input, kept apart from the database so the cases of the supervisor run without one.
 */

export const NCR_SEVERITIES = ['MINOR', 'MAJOR', 'CRITICAL'] as const;
export type NcrSeverity = (typeof NCR_SEVERITIES)[number];

export const NCR_SOURCE_KINDS = ['INSPECTION', 'MATERIAL_TEST', 'SUPERVISOR_REMARK', 'SELF_REPORT', 'AUDIT'] as const;
export type NcrSourceKind = (typeof NCR_SOURCE_KINDS)[number];

export const NCR_STATUSES = ['OPEN', 'ACTION_ASSIGNED', 'ACTION_SUBMITTED', 'VERIFIED', 'CLOSED', 'REOPENED'] as const;
export type NcrStatus = (typeof NCR_STATUSES)[number];

export const ACTION_STATUSES = ['ASSIGNED', 'SUBMITTED', 'REJECTED', 'VERIFIED'] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export const ACTION_VERIFICATIONS = ['VERIFIED', 'REJECTED'] as const;
export type ActionVerification = (typeof ACTION_VERIFICATIONS)[number];

/** A serious non-conformance holds back the quality acceptance until it is closed (BR-QMS-07). */
export const blocksAcceptance = (severity: NcrSeverity): boolean => severity === 'CRITICAL';

/** The statuses in which an action can still be added to a non-conformance: it is not verified as a whole and not closed. */
const ASSIGNABLE: readonly NcrStatus[] = ['OPEN', 'ACTION_ASSIGNED', 'ACTION_SUBMITTED', 'REOPENED'];
export const canAssignAction = (status: NcrStatus): boolean => ASSIGNABLE.includes(status);

/** An action can be answered with evidence while it waits for it: assigned, or rejected by the verifier. */
export const canSubmitEvidence = (status: ActionStatus): boolean => status === 'ASSIGNED' || status === 'REJECTED';

/** An action is verified, or rejected, once it was submitted. */
export const canVerify = (status: ActionStatus): boolean => status === 'SUBMITTED';

/**
 * Where a non-conformance stands from its actions: with no action it stays as it was raised (or reopened); while one waits for evidence (assigned or rejected) it is ACTION_ASSIGNED; when all the
 * rest are submitted or verified it is ACTION_SUBMITTED; and when every action is verified it is VERIFIED, ready to close. A status that ended (closed) is not recomputed.
 */
export function statusFromActions(current: NcrStatus, actions: readonly ActionStatus[]): NcrStatus {
  if (current === 'CLOSED' || actions.length === 0) return current;
  if (actions.some((status) => status === 'ASSIGNED' || status === 'REJECTED')) return 'ACTION_ASSIGNED';
  return actions.every((status) => status === 'VERIFIED') ? 'VERIFIED' : 'ACTION_SUBMITTED';
}

/** A non-conformance closes from VERIFIED only, and a closed one is reopened; every other move is 409 `NCR_STATE_INVALID`. */
export function assertNcrTransition(from: NcrStatus, command: 'close' | 'reopen'): NcrStatus {
  if (command === 'close' && from === 'VERIFIED') return 'CLOSED';
  if (command === 'reopen' && from === 'CLOSED') return 'REOPENED';
  throw new DomainError('NCR_STATE_INVALID', 409, 'id', { extensions: { status: from } });
}

/** The close needs every action verified (422 `CORRECTIVE_ACTION_OPEN`), and at least one, so that a non-conformance is never closed on nothing. */
export function assertActionsVerified(actions: readonly ActionStatus[]): void {
  if (actions.length === 0 || actions.some((status) => status !== 'VERIFIED')) {
    throw new DomainError('CORRECTIVE_ACTION_OPEN', 422, 'id', { extensions: { open_actions: actions.filter((status) => status !== 'VERIFIED').length, actions: actions.length } });
  }
}

/** The person who verifies an action is not who carried it out, nor who is responsible for the non-conformance (BR-QMS-07). */
export function assertIndependentVerifier(actor: string, actionOwner: string, ncrOwner: string): void {
  assertNotProposer(actor, [actionOwner, ncrOwner]);
}

/** The person who closes a non-conformance is none of the people who put it right: the owner of the non-conformance and the owners of its actions. */
export function assertIndependentCloser(actor: string, ncrOwner: string, actionOwners: readonly string[]): void {
  assertNotProposer(actor, [ncrOwner, ...actionOwners]);
}
