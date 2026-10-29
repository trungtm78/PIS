import { DomainError } from './errors.ts';

/**
 * Quality incidents and exceptions (ST-DGV-003, DGV.md F4, BR-DGV-05, BR-DGV-06): an incident opened by a failed rule is given to someone, worked through acknowledged and in progress to resolved, and closed only by
 * another person after a run that passes; a record that failed may be waived for a while, and the waiver ends by itself. Nobody skips a step and nobody verifies their own work.
 */
export const INCIDENT_STATUSES = ['OPEN', 'ASSIGNED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED_PENDING_VERIFICATION', 'CLOSED', 'REOPENED'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export const INCIDENT_WORK_STATUSES = ['ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED_PENDING_VERIFICATION'] as const;
export type IncidentWorkStatus = (typeof INCIDENT_WORK_STATUSES)[number];
export const INCIDENT_DECISIONS = ['CLOSE', 'REOPEN'] as const;
export type IncidentDecision = (typeof INCIDENT_DECISIONS)[number];

const invalidState = (status: IncidentStatus): DomainError => new DomainError('INCIDENT_STATE_INVALID', 409, 'status', { extensions: { incident_status: status } });

/** Where an incident may be given (or given again) to a handler: before it is resolved. */
const ASSIGNABLE: readonly IncidentStatus[] = ['OPEN', 'REOPENED', 'ASSIGNED', 'ACKNOWLEDGED', 'IN_PROGRESS'];

export function assertAssignable(status: IncidentStatus): void {
  if (!ASSIGNABLE.includes(status)) throw invalidState(status);
}

/** The step the handler may take from each state (a reopened incident goes back to the handler it had). */
const NEXT_WORK: Readonly<Partial<Record<IncidentStatus, IncidentWorkStatus>>> = {
  ASSIGNED: 'ACKNOWLEDGED',
  REOPENED: 'ACKNOWLEDGED',
  ACKNOWLEDGED: 'IN_PROGRESS',
  IN_PROGRESS: 'RESOLVED_PENDING_VERIFICATION',
};

/** 409 `INCIDENT_STATE_INVALID` unless `to` is the next step from `from`; returns the step. */
export function assertWorkStep(from: IncidentStatus, to: IncidentWorkStatus): IncidentWorkStatus {
  if (NEXT_WORK[from] !== to) throw invalidState(from);
  return to;
}

/** The step the handler may take now, or none. */
export const nextWorkStep = (status: IncidentStatus): IncidentWorkStatus | undefined => NEXT_WORK[status];

const MIN_TEXT = 10;

/**
 * Resolving needs the cause and the measure taken (the cause first, and the fix upstream): 422 `ROOT_CAUSE_REQUIRED` naming the field that is missing. The words are judged after they are trimmed; the trimmed words are returned.
 */
export function resolutionText(input: { rootCause: string | undefined; remediation: string | undefined }): { rootCause: string; remediation: string } {
  const rootCause = (input.rootCause ?? '').normalize('NFC').trim();
  const remediation = (input.remediation ?? '').normalize('NFC').trim();
  if (rootCause.length < MIN_TEXT) throw new DomainError('ROOT_CAUSE_REQUIRED', 422, 'root_cause');
  if (remediation.length < MIN_TEXT) throw new DomainError('ROOT_CAUSE_REQUIRED', 422, 'remediation');
  return { rootCause, remediation };
}

/** Who may verify (BR-DGV-05): not the one who handled the incident (403 `SELF_APPROVAL_DENIED`), and only an incident that waits for it. */
export function assertVerifiable(input: { status: IncidentStatus; assigneeUserId: string | null; verifierUserId: string }): void {
  if (input.status !== 'RESOLVED_PENDING_VERIFICATION') throw invalidState(input.status);
  if (input.assigneeUserId !== null && input.assigneeUserId === input.verifierUserId) throw new DomainError('SELF_APPROVAL_DENIED', 403);
}

export interface RerunEvidence {
  /** When the incident was resolved. */
  resolvedAt: string;
  /** The latest finished run of the dataset after that moment, and what it found for the rule of the incident. */
  rerun: { finishedAt: string; result: 'PASS' | 'WARN' | 'FAIL' | 'ERROR' } | undefined;
}

/** 422 `RERUN_NOT_PASSED` unless a run finished after the resolution and the rule passed in it (not warned, not failed, not unmeasured). */
export function assertRerunPassed(evidence: RerunEvidence): void {
  if (evidence.rerun === undefined || evidence.rerun.finishedAt <= evidence.resolvedAt || evidence.rerun.result !== 'PASS') throw new DomainError('RERUN_NOT_PASSED', 422);
}

// ---- waivers (BR-DGV-06) ----------------------------------------------------------------------------------------------------------------

/** The longest a record may be waived for, in days (a working assumption until the data owner signs the governance rules). */
export const MAX_WAIVER_DAYS = 180;
export const EXCEPTION_DECISIONS = ['RESOLVED', 'WAIVED'] as const;
export type ExceptionDecision = (typeof EXCEPTION_DECISIONS)[number];

/**
 * What a decision on an exception needs: a reason of at least ten characters; a waiver also an end, after now and at most 180 days on, and the one who decides is not the owner of the exception (403
 * `SELF_APPROVAL_DENIED`). The reason is judged after it is trimmed and returned so.
 */
export function judgeExceptionDecision(input: { decision: ExceptionDecision; reason: string; waiverExpiresAt: Date | undefined; now: Date; ownerUserId: string; deciderUserId: string }): { reason: string; waiverExpiresAt: Date | undefined } {
  if (input.deciderUserId === input.ownerUserId) throw new DomainError('SELF_APPROVAL_DENIED', 403);
  const reason = input.reason.normalize('NFC').trim();
  if (reason.length < MIN_TEXT) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
  if (input.decision === 'RESOLVED') {
    if (input.waiverExpiresAt !== undefined) throw new DomainError('VALIDATION_FAILED', 422, 'waiver_expires_at');
    return { reason, waiverExpiresAt: undefined };
  }
  const end = input.waiverExpiresAt;
  if (end === undefined || Number.isNaN(end.getTime()) || end.getTime() <= input.now.getTime() || end.getTime() > input.now.getTime() + MAX_WAIVER_DAYS * 86_400_000) {
    throw new DomainError('VALIDATION_FAILED', 422, 'waiver_expires_at');
  }
  return { reason, waiverExpiresAt: end };
}

// ---- what a reader without the rights to the dataset sees ----------------------------------------------------------------------------

/** A value of a record reference with all but its last four characters hidden (a national id 012345672345 reads `***2345`); a short value is hidden whole. */
export function maskValue(value: string): string {
  const characters = [...value];
  return characters.length <= 4 ? '***' : `***${characters.slice(-4).join('')}`;
}

/** The reference of a record or the evidence of an exception with every value masked and the structure kept: the keys say what was looked at, the values are what the dataset protects. */
export function maskReference(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskReference);
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, maskReference(inner)]));
  if (typeof value === 'string') return maskValue(value);
  if (typeof value === 'number' || typeof value === 'boolean') return maskValue(String(value));
  return value;
}
