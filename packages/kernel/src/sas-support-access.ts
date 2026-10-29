import { DomainError } from './errors.ts';

/**
 * Controlled support access (ST-SAS-015, SAS.md 3.9, BR-SAS-16): a Support Operator asks, with a ticket, to read (or read and write) the data of one tenant for a
 * few hours; the tenant, and for a write two different people of the tenant, consent; every request of the operator while the grant is in force is audited as an
 * impersonation. The rules below are pure: the store keeps the rows, the guard of the API asks `isSupportGrantLive` on every request.
 */

export const SUPPORT_MIN_MINUTES = 15;
export const SUPPORT_MAX_MINUTES = 480;
/** The longest a grant lasts, whatever was asked (also a CHECK of the table). */
export const SUPPORT_MAX_WINDOW_MS = 8 * 3_600_000;
/** A request that nobody decided on lapses after this long: the operator asks again. */
export const SUPPORT_REQUEST_LAPSE_MS = 7 * 86_400_000;
/** How far ahead an approval may put the start of the access. */
export const SUPPORT_START_LEAD_MS = 7 * 86_400_000;
export const SUPPORT_MIN_REASON = 10;
export const SUPPORT_MAX_REASON = 2000;

export type SupportAccessMode = 'READ_ONLY' | 'READ_WRITE';
export type SupportGrantStatus = 'Requested' | 'Approved' | 'Active' | 'Expired' | 'Revoked' | 'Rejected';

export const OPEN_SUPPORT_STATUSES: readonly SupportGrantStatus[] = ['Requested', 'Approved', 'Active'];

export interface SupportRequestInput {
  ticketReference: string;
  modules: readonly string[];
  resourceIds: readonly string[];
  accessMode: string;
  durationMinutes: number;
  reason: string;
}

const MODULE_CODE = /^[A-Za-z][A-Za-z0-9]{1,15}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TICKET = /^[A-Za-z0-9][A-Za-z0-9._\-/]{2,63}$/;

/** The fields of a request that cannot be accepted (the contract refuses most of them already; this is the rule the store relies on). */
export function supportRequestDefects(input: SupportRequestInput): string[] {
  const defects: string[] = [];
  if (!TICKET.test(input.ticketReference.trim())) defects.push('ticket_reference');
  if (input.modules.length === 0 || input.modules.length > 40 || new Set(input.modules.map((module) => module.toLowerCase())).size !== input.modules.length || !input.modules.every((module) => MODULE_CODE.test(module))) defects.push('scope.modules');
  if (input.resourceIds.length > 100 || !input.resourceIds.every((id) => UUID.test(id))) defects.push('scope.resource_ids');
  if (input.accessMode !== 'READ_ONLY' && input.accessMode !== 'READ_WRITE') defects.push('access_mode');
  if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < SUPPORT_MIN_MINUTES || input.durationMinutes > SUPPORT_MAX_MINUTES) defects.push('duration_minutes');
  const reason = input.reason.trim();
  if (reason.length < SUPPORT_MIN_REASON || reason.length > SUPPORT_MAX_REASON) defects.push('reason');
  return defects;
}

/** What the rules need to know of a grant. */
export interface SupportGrantFacts {
  status: SupportGrantStatus;
  accessMode: SupportAccessMode;
  operatorId: string;
  ownerApprovedBy: string | null;
  secondApproverId: string | null;
  durationMinutes: number;
  requestedAt: Date;
  startsAt: Date | null;
  expiresAt: Date;
  revokedAt: Date | null;
}

/** Whether both approvals a grant needs are given: one for a read, two different people for a write. */
export function isFullyApproved(grant: Pick<SupportGrantFacts, 'accessMode' | 'ownerApprovedBy' | 'secondApproverId'>): boolean {
  if (grant.ownerApprovedBy === null) return false;
  return grant.accessMode === 'READ_ONLY' || (grant.secondApproverId !== null && grant.secondApproverId !== grant.ownerApprovedBy);
}

/** Whether the grant lets its operator in at `now`: approved by everybody it needs, not revoked, inside its window. The status column is bookkeeping; this is the judgment. */
export function isSupportGrantLive(grant: SupportGrantFacts, now: Date): boolean {
  if (grant.status !== 'Approved' && grant.status !== 'Active') return false;
  if (grant.revokedAt !== null || grant.startsAt === null || !isFullyApproved(grant)) return false;
  return grant.startsAt.getTime() <= now.getTime() && now.getTime() < grant.expiresAt.getTime();
}

/** The state the grant should be shown in at `now`, from the facts (the lifecycle job writes the same). */
export function supportStatusAt(grant: SupportGrantFacts, now: Date): SupportGrantStatus {
  switch (grant.status) {
    case 'Requested':
      return now.getTime() - grant.requestedAt.getTime() >= SUPPORT_REQUEST_LAPSE_MS ? 'Expired' : 'Requested';
    case 'Approved':
    case 'Active':
      if (grant.startsAt === null) return grant.status;
      if (now.getTime() >= grant.expiresAt.getTime()) return 'Expired';
      return now.getTime() >= grant.startsAt.getTime() ? 'Active' : 'Approved';
    default:
      return grant.status;
  }
}

export interface ApprovalPatch {
  status: SupportGrantStatus;
  ownerApprovedBy: string;
  secondApproverId: string | null;
  startsAt: Date | null;
  expiresAt: Date | null;
}

/**
 * What one approval does to a grant. Only a Requested grant is approved (409 SUPPORT_GRANT_INVALID); the operator never approves their own (403 SELF_APPROVAL_DENIED), and for a
 * write the second approval comes from somebody other than the first (403 SELF_APPROVAL_DENIED). The window of the access is fixed by the approval that completes the grant: it starts
 * when the approver says (not before now, at most a week ahead) or now, and lasts what was asked for, never more than eight hours.
 */
export function approvalPatch(grant: SupportGrantFacts, approverId: string, now: Date, startsAt?: Date): ApprovalPatch {
  if (grant.status !== 'Requested' || supportStatusAt(grant, now) !== 'Requested') throw new DomainError('SUPPORT_GRANT_INVALID', 409, 'status');
  if (approverId === grant.operatorId) throw new DomainError('SELF_APPROVAL_DENIED', 403);
  const needsSecond = grant.accessMode === 'READ_WRITE';
  if (needsSecond && grant.ownerApprovedBy === null) {
    return { status: 'Requested', ownerApprovedBy: approverId, secondApproverId: null, startsAt: null, expiresAt: null };
  }
  if (needsSecond && approverId === grant.ownerApprovedBy) throw new DomainError('SELF_APPROVAL_DENIED', 403);
  const start = startsAt === undefined || startsAt.getTime() < now.getTime() ? now : startsAt;
  if (start.getTime() - now.getTime() > SUPPORT_START_LEAD_MS) throw new DomainError('VALIDATION_FAILED', 422, 'starts_at');
  const expiresAt = new Date(start.getTime() + Math.min(grant.durationMinutes * 60_000, SUPPORT_MAX_WINDOW_MS));
  return {
    status: start.getTime() <= now.getTime() ? 'Active' : 'Approved',
    ownerApprovedBy: needsSecond ? (grant.ownerApprovedBy as string) : approverId,
    secondApproverId: needsSecond ? approverId : null,
    startsAt: start,
    expiresAt,
  };
}

/** A grant is revoked while it is still open: asked for, approved or in force (409 SUPPORT_GRANT_INVALID otherwise). */
export function assertRevocable(grant: Pick<SupportGrantFacts, 'status'>): void {
  if (!OPEN_SUPPORT_STATUSES.includes(grant.status)) throw new DomainError('SUPPORT_GRANT_INVALID', 409, 'status');
}

/** One operation of the contract, as far as the scope of a grant needs to know it. */
export interface SupportOperation {
  id: string;
  permission: string;
  module: string | undefined;
  method: string;
  plane: string;
  stepUp: boolean;
}

// The audit trail of the tenant (its reads and its export) is the tenant's own record of what the operator does: no grant gives it to the operator.
// Nor do they give what reads across modules without asking each one (the global search, the home screen, the sync of the mobile client): their results are not narrowed by the modules of a grant.
const WITHHELD_PREFIXES = ['tenant.support.', 'system.', 'audit.', 'audit_event.', 'search.', 'home.', 'sync.'];

/**
 * The permissions a grant gives the operator: those of the operations of the modules it names, on the tenant plane, and for a read-only grant only the operations that read (GET). What
 * the tenant approves for itself (`tenant.support.*`), the control plane (`system.*`), the audit trail of the tenant (`audit.*`, `audit_event.*`: its reads and its export), what reads across modules (`search.*`, `home.*`, `sync.*`) and what asks for a second factor are never given: an operator cannot approve, extend or revoke
 * their own access, and does not reach the grants of roles.
 */
export function supportPermissions(operations: readonly SupportOperation[], modules: readonly string[], mode: SupportAccessMode): string[] {
  const named = new Set(modules.map((module) => module.toLowerCase()));
  const permissions = new Set<string>();
  for (const operation of operations) {
    if (operation.plane !== 'tenant' || operation.stepUp || operation.module === undefined || !named.has(operation.module.toLowerCase())) continue;
    if (WITHHELD_PREFIXES.some((prefix) => operation.permission.startsWith(prefix))) continue;
    if (mode === 'READ_ONLY' && operation.method.toUpperCase() !== 'GET') continue;
    permissions.add(operation.permission);
  }
  return [...permissions].sort();
}

/** Whether a grant that names resources reaches the request: its path holds one of them (a list, which holds none, is out of reach). A grant without resources reaches the whole module. */
export function reachesResource(path: string, resourceIds: readonly string[]): boolean {
  if (resourceIds.length === 0) return true;
  const named = new Set(resourceIds.map((id) => id.toLowerCase()));
  return path
    .split('?')[0]!
    .split('/')
    .some((segment) => named.has(segment.toLowerCase()));
}
