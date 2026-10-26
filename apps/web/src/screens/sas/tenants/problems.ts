import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { PROVISION_FIELDS } from './rules';
import type { ProvisionField } from './rules';

/** Why a control-plane command failed, in the words of the SAS screens (the server's own `error.<CODE>` keys are not in this catalogue). */
export type ProblemReason =
  | 'codeTaken'
  | 'domainTaken'
  | 'planNotPublished'
  | 'placementUnavailable'
  | 'invalid'
  | 'fieldNotAllowed'
  | 'stateInvalid'
  | 'conflict'
  | 'notFound'
  | 'denied'
  | 'stepUp'
  | 'session'
  | 'offline'
  | 'general';

export interface ProblemView {
  reason: ProblemReason;
  /** The form field the problem belongs to, when the server (or the code) names one. */
  field: ProvisionField | undefined;
  currentVersion: number | undefined;
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  TENANT_CODE_TAKEN: 'codeTaken',
  DOMAIN_TAKEN: 'domainTaken',
  PLAN_NOT_PUBLISHED: 'planNotPublished',
  PLACEMENT_UNAVAILABLE: 'placementUnavailable',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  FIELD_NOT_ALLOWED: 'fieldNotAllowed',
  TENANT_STATE_INVALID: 'stateInvalid',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
};

// The field a code is about when the server names none.
const FIELD_BY_CODE: Readonly<Record<string, ProvisionField>> = {
  TENANT_CODE_TAKEN: 'code',
  DOMAIN_TAKEN: 'platform_subdomain',
  PLAN_NOT_PUBLISHED: 'plan_version_id',
  PLACEMENT_UNAVAILABLE: 'region',
};

const isField = (value: string | undefined): value is ProvisionField => value !== undefined && (PROVISION_FIELDS as readonly string[]).includes(value);

/** Maps an error of a tenant command to what the screen shows; unknown failures become the general message. */
export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined, currentVersion: undefined };
  if (error.code === 'VERSION_CONFLICT') {
    const current = error.extensions.current_version;
    return { reason: 'conflict', field: undefined, currentVersion: typeof current === 'number' ? current : undefined };
  }
  if (error.code === 'MFA_REQUIRED') return { reason: 'stepUp', field: undefined, currentVersion: undefined };
  if (error.code === 'SESSION_EXPIRED') return { reason: 'session', field: undefined, currentVersion: undefined };
  if (error.code === NETWORK_ERROR_CODE) return { reason: 'offline', field: undefined, currentVersion: undefined };
  return {
    reason: REASON_BY_CODE[error.code] ?? 'general',
    field: isField(error.detail) ? error.detail : FIELD_BY_CODE[error.code],
    currentVersion: undefined,
  };
}
