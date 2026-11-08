import { permissionCovered } from './anti-escalation.ts';
import type { EffectiveAccess, GrantView } from './effective-access.ts';
import { DomainError } from './errors.ts';
import { intersectPeriodCodes, validatePeriodCodes } from './iam-period-scope.ts';

/**
 * An administrator acting on behalf of a person (IAM-2): when the person cannot act (absence, a lost device) an administrator may do what the person could do for a few hours, under a recorded reason, with the approval of a
 * second person, and every audit row written meanwhile says that it was done as them (the actor is the administrator, `on_behalf_of_id` is the person). It is data entry only: what decides, signs or approves is never done on
 * behalf of someone; the administration of access is never done on behalf of anyone either. This is the part that needs no data.
 */

/** The longest an acting grant lasts, counted from its approval. */
export const ACTING_MAX_HOURS = 8;
/** A request that nobody approved within this many hours is dead. */
export const ACTING_REQUEST_TTL_HOURS = 24;
export const ACTING_REASON_MIN = 20;
export const ACTING_REASON_MAX = 1000;
/** The last word of a permission that is a decision: these are never done on behalf of someone (BR-ADM-02, the decision is personal). */
export const ACTING_DECISION_VERBS = ['approve', 'decide', 'sign', 'certify', 'accept', 'reject', 'return', 'issue', 'review', 'verify', 'confirm', 'lock', 'publish', 'finalize'] as const;
const ADMINISTRATIVE_PREFIXES = ['iam.', 'adm.', 'system.'] as const;
const HOUR_MS = 3_600_000;
const PERMISSION = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export interface ActingRequest {
  permissions: readonly string[];
  hours: number;
  reason: string;
  periodCodes?: readonly string[] | undefined;
}

export interface ActingDefect {
  field: string;
  code: 'REQUIRED' | 'MALFORMED' | 'DUPLICATE' | 'WILDCARD' | 'ADMINISTRATIVE' | 'DECISION' | 'TOO_LONG' | 'TOO_SHORT' | 'OVERLAP' | 'TOO_MANY';
}

/** Whether a permission is one that is done on behalf of someone: not administrative, not a decision. */
export function actingAllowsPermission(permission: string): 'OK' | 'MALFORMED' | 'WILDCARD' | 'ADMINISTRATIVE' | 'DECISION' {
  if (permission.endsWith('*')) return 'WILDCARD';
  if (!PERMISSION.test(permission)) return 'MALFORMED';
  if (ADMINISTRATIVE_PREFIXES.some((prefix) => permission.startsWith(prefix))) return 'ADMINISTRATIVE';
  const last = permission.slice(permission.lastIndexOf('.') + 1);
  return (ACTING_DECISION_VERBS as readonly string[]).includes(last) ? 'DECISION' : 'OK';
}

/** Every defect of a request to act on behalf of a person, in the order of the fields; none when it is valid. */
export function validateActingRequest(request: ActingRequest): ActingDefect[] {
  const defects: ActingDefect[] = [];
  const add = (field: string, code: ActingDefect['code']): void => void defects.push({ field, code });
  if (request.permissions.length === 0) add('permissions', 'REQUIRED');
  const seen = new Set<string>();
  request.permissions.forEach((permission, index) => {
    const field = `permissions[${index}]`;
    const verdict = actingAllowsPermission(permission);
    if (verdict !== 'OK') add(field, verdict);
    else if (seen.has(permission)) add(field, 'DUPLICATE');
    seen.add(permission);
  });
  if (!Number.isInteger(request.hours) || request.hours < 1) add('hours', 'REQUIRED');
  else if (request.hours > ACTING_MAX_HOURS) add('hours', 'TOO_LONG');
  const reason = request.reason.trim();
  if (reason.length < ACTING_REASON_MIN) add('reason', 'TOO_SHORT');
  else if (reason.length > ACTING_REASON_MAX) add('reason', 'TOO_LONG');
  if (request.periodCodes !== undefined) defects.push(...validatePeriodCodes(request.periodCodes));
  return defects;
}

/** 422 `ACTING_INVALID` naming the first field, with every defect as a member of the problem. */
export function assertValidActingRequest(request: ActingRequest): void {
  const defects = validateActingRequest(request);
  if (defects.length > 0) throw new DomainError('ACTING_INVALID', 422, defects[0]?.field, { extensions: { defects } });
}

/** The persons behind the memberships: one person may hold several memberships, and the rules below are about persons. */
export interface ActingParties {
  requesterUser: string;
  subjectUser: string;
}

/** 403 `ACTING_SELF_DENIED`: nobody acts on behalf of themselves (it would be a way around the second approver). */
export function assertActingParties(parties: ActingParties): void {
  if (parties.requesterUser === parties.subjectUser) throw new DomainError('ACTING_SELF_DENIED', 403, 'subject_membership_id');
}

/** 403 `SELF_APPROVAL_DENIED`: the approver is neither the one who asks nor the person acted for (maker is not checker, by the person). */
export function assertActingApprover(parties: ActingParties & { approverUser: string }): void {
  if (parties.approverUser === parties.requesterUser || parties.approverUser === parties.subjectUser) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'approver');
}

export type ActingStatus = 'Pending' | 'Approved' | 'Rejected' | 'Cancelled' | 'Revoked';
export type ActingPhase = 'PENDING' | 'REQUEST_LAPSED' | 'REJECTED' | 'CANCELLED' | 'ACTIVE' | 'ENDED' | 'REVOKED';

/** Where an acting grant stands by the clock: a request that waited too long is lapsed, an approved one is in force inside its window only, and a revoked one never is. */
export function actingPhase(grant: { status: ActingStatus; requestedAt: Date; validFrom: Date | null; validUntil: Date | null }, now: Date): ActingPhase {
  switch (grant.status) {
    case 'Pending':
      return now.getTime() >= grant.requestedAt.getTime() + ACTING_REQUEST_TTL_HOURS * HOUR_MS ? 'REQUEST_LAPSED' : 'PENDING';
    case 'Rejected':
      return 'REJECTED';
    case 'Cancelled':
      return 'CANCELLED';
    case 'Revoked':
      return 'REVOKED';
    case 'Approved':
      if (grant.validFrom === null || grant.validUntil === null) return 'ENDED';
      return now.getTime() >= grant.validFrom.getTime() && now.getTime() < grant.validUntil.getTime() ? 'ACTIVE' : 'ENDED';
  }
}

/** When an approved grant ends: the hours it was asked for, counted from the approval. */
export function actingWindow(approvedAt: Date, hours: number): { validFrom: Date; validUntil: Date } {
  return { validFrom: approvedAt, validUntil: new Date(approvedAt.getTime() + hours * HOUR_MS) };
}

/**
 * The access the administrator has while acting: the access of the person, narrowed to the permissions the grant lists (and to the periods it lists), nothing else. Of every grant of the person only the listed permissions
 * stay, with the scope of the grant; a grant that holds none of them is dropped. The membership stays the person's, so the scope version and the activity of the membership are theirs: a person who was suspended is not acted for.
 */
export function restrictAccessForActing(access: EffectiveAccess, permissions: readonly string[], periodCodes: readonly string[] | null | undefined): EffectiveAccess {
  const grants: GrantView[] = [];
  for (const grant of access.grants) {
    const kept = permissions.filter((permission) => permissionCovered(grant.permissions, permission));
    if (kept.length === 0) continue;
    const periods = intersectPeriodCodes(grant.periodCodes, periodCodes);
    if (periods !== undefined && periods.length === 0) continue;
    grants.push({ ...grant, permissions: kept, ...(periods === undefined ? {} : { periodCodes: periods }) });
  }
  return { ...access, grants };
}
