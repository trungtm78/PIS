import { ApiError } from '@machvon/api-client';

export const SHARE_PATH = '/bi/bi-17';
export const SHARE_PERMISSION = 'bi.dashboard.share';

export const GRANTEE_KINDS = ['USER', 'ROLE', 'UNIT'] as const;
export type GranteeKind = (typeof GRANTEE_KINDS)[number];
export const SHARE_RIGHTS = ['VIEW', 'EDIT'] as const;
export type ShareRight = (typeof SHARE_RIGHTS)[number];
export type ShareState = 'ACTIVE' | 'REVOKED';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => allowed.find((candidate) => candidate === value) ?? fallback;

export interface Share {
  id: string;
  kind: GranteeKind;
  granteeId: string;
  granteeName: string | null;
  permission: ShareRight;
  status: ShareState;
  revokedAt: string | null;
  createdAt: string;
  version: number;
}

/** A share as the dashboard lists it to its owner; a row without an id is dropped. */
export function toShare(raw: unknown): Share | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string') return undefined;
  return {
    id: raw.id,
    kind: oneOf(raw.grantee_kind, GRANTEE_KINDS, 'USER'),
    granteeId: typeof raw.grantee_ref_id === 'string' ? raw.grantee_ref_id : '',
    granteeName: typeof raw.grantee_name === 'string' ? raw.grantee_name : null,
    permission: oneOf(raw.permission, SHARE_RIGHTS, 'VIEW'),
    status: raw.status === 'REVOKED' ? 'REVOKED' : 'ACTIVE',
    revokedAt: typeof raw.revoked_at === 'string' ? raw.revoked_at : null,
    createdAt: typeof raw.created_at === 'string' ? raw.created_at : '',
    version: typeof raw.version === 'number' ? raw.version : 1,
  };
}

export interface ShareForm {
  kind: GranteeKind;
  granteeId: string;
  permission: ShareRight;
}

export const EMPTY_SHARE: ShareForm = { kind: 'USER', granteeId: '', permission: 'VIEW' };

export type ShareProblem = 'required' | 'invalid';

export function validateShare(form: ShareForm): { granteeId?: ShareProblem } {
  const id = form.granteeId.trim();
  if (id === '') return { granteeId: 'required' };
  return UUID.test(id) ? {} : { granteeId: 'invalid' };
}

export const shareBody = (form: ShareForm): { grantee_kind: GranteeKind; grantee_ref_id: string; permission: ShareRight } => ({
  grantee_kind: form.kind,
  grantee_ref_id: form.granteeId.trim().toLowerCase(),
  permission: form.permission,
});

export type ShareReason = 'outOfTenant' | 'duplicate' | 'self' | 'ended' | 'conflict' | 'scope' | 'notFound' | 'general';

/** What the refusal is, by the code of the server: a share to one that is not of the tenant, to one that has a share, to the owner, to a share that ended. */
export function describeShareProblem(error: unknown): ShareReason {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'GRANTEE_OUT_OF_TENANT':
      return 'outOfTenant';
    case 'STAGE_TRANSITION_DENIED':
      return 'duplicate';
    case 'VALIDATION_FAILED':
      return 'self';
    case 'SHARE_STATE_INVALID':
      return 'ended';
    case 'VERSION_CONFLICT':
      return 'conflict';
    case 'SCOPE_DENIED':
      return 'scope';
    case 'RESOURCE_NOT_FOUND':
      return 'notFound';
    default:
      return 'general';
  }
}
