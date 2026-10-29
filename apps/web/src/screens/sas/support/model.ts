import { ApiError } from '@machvon/api-client';

/** The permissions of SAS-19 (x-permission of the operations in openapi.json): the operator asks, the people of the tenant read, decide and revoke. */
export const REQUEST_PERMISSION = 'system.support.request';
export const DECIDE_PERMISSION = 'tenant.support.approve';
export const READ_PERMISSION = 'support_access_grant.read';

export const MIN_MINUTES = 15;
export const MAX_MINUTES = 480;
export const MIN_REASON = 10;
export const MAX_REASON = 2000;
export const DEFAULT_MINUTES = 60;

/** The modules of the product a grant can name (the tags of openapi.json that hold tenant data). */
export const MODULE_CODES: readonly string[] = ['ADM', 'AST', 'AUD', 'BI', 'BID', 'CAP', 'CTR', 'DGV', 'DIS', 'DOC', 'IAM', 'ISS', 'LLM', 'LND', 'MDM', 'MNE', 'NOT', 'OMNI', 'PAY', 'PMT', 'PRJ', 'QMS', 'SAS'];

export type GrantStatus = 'Requested' | 'Approved' | 'Active' | 'Expired' | 'Revoked' | 'Rejected';
export type AccessMode = 'READ_ONLY' | 'READ_WRITE';

export interface GrantView {
  id: string;
  ticketReference: string;
  operatorId: string;
  accessMode: AccessMode;
  status: GrantStatus;
  /** The judgment of the server at the time of the read: the operator is let in now. */
  inForce: boolean;
  modules: string[];
  resourceIds: string[];
  durationMinutes: number;
  requestReason: string;
  requestedAt: string;
  startsAt: string | undefined;
  expiresAt: string;
  approvedBy: string | undefined;
  secondApproverId: string | undefined;
  revokedAt: string | undefined;
  revokeReason: string | undefined;
  version: number;
}

export interface GrantPage {
  items: GrantView[];
  nextCursor: string | undefined;
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const optional = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
const STATUSES: readonly string[] = ['Requested', 'Approved', 'Active', 'Expired', 'Revoked', 'Rejected'];

export function toGrant(raw: unknown): GrantView | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string') return undefined;
  const scope = isRecord(raw.scope) ? raw.scope : {};
  return {
    id: raw.id,
    ticketReference: text(raw.ticket_reference),
    operatorId: text(raw.operator_id),
    accessMode: raw.access_mode === 'READ_WRITE' ? 'READ_WRITE' : 'READ_ONLY',
    status: STATUSES.includes(text(raw.status)) ? (raw.status as GrantStatus) : 'Requested',
    inForce: raw.in_force === true,
    modules: strings(scope.modules),
    resourceIds: strings(scope.resource_ids),
    durationMinutes: typeof raw.duration_minutes === 'number' ? raw.duration_minutes : 0,
    requestReason: text(raw.request_reason),
    requestedAt: text(raw.requested_at),
    startsAt: optional(raw.starts_at),
    expiresAt: text(raw.expires_at),
    approvedBy: optional(raw.approved_by),
    secondApproverId: optional(raw.second_approver_id),
    revokedAt: optional(raw.revoked_at),
    revokeReason: optional(raw.revoke_reason),
    version: typeof raw.version === 'number' ? raw.version : 1,
  };
}

export function toGrantPage(raw: unknown): GrantPage {
  const view: Raw = isRecord(raw) ? raw : {};
  return {
    items: Array.isArray(view.items) ? view.items.flatMap((item) => toGrant(item) ?? []) : [],
    nextCursor: typeof view.next_cursor === 'string' ? view.next_cursor : undefined,
  };
}

/** How many people must approve the grant: one for a read, two different people for a write. */
export const approvalsNeeded = (grant: Pick<GrantView, 'accessMode'>): 1 | 2 => (grant.accessMode === 'READ_WRITE' ? 2 : 1);
export const approvalsGiven = (grant: Pick<GrantView, 'approvedBy' | 'secondApproverId'>): number => (grant.approvedBy === undefined ? 0 : grant.secondApproverId === undefined ? 1 : 2);

const OPEN: readonly GrantStatus[] = ['Requested', 'Approved', 'Active'];
/** A request that waits can be decided on, except by somebody who already gave the first approval of a write (the server refuses them too). */
export const canDecide = (grant: GrantView, membershipId: string | undefined): boolean => grant.status === 'Requested' && (membershipId === undefined || membershipId !== grant.approvedBy);
export const canRevoke = (grant: GrantView): boolean => OPEN.includes(grant.status);

export const isReasonValid = (reason: string): boolean => reason.trim().length >= MIN_REASON && reason.trim().length <= MAX_REASON;
export const isMinutesValid = (minutes: number): boolean => Number.isInteger(minutes) && minutes >= MIN_MINUTES && minutes <= MAX_MINUTES;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isTenantIdValid = (value: string): boolean => UUID.test(value.trim());

export type ProblemReason = 'selfApproval' | 'grantState' | 'ticket' | 'conflict' | 'invalid' | 'denied' | 'notFound' | 'session' | 'general';

export interface ProblemView {
  reason: ProblemReason;
  field: string | undefined;
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  SELF_APPROVAL_DENIED: 'selfApproval',
  SUPPORT_GRANT_INVALID: 'grantState',
  TICKET_NOT_FOUND: 'ticket',
  VERSION_CONFLICT: 'conflict',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  RESOURCE_NOT_FOUND: 'notFound',
  SESSION_EXPIRED: 'session',
};

export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail };
}
