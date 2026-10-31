import { ApiError } from '@machvon/api-client';

/** The permission of SAS-20 (x-permission of the flag operations): only the System Admin holds it. */
export const RELEASE_PERMISSION = 'system.release.manage';

export const STATUSES = ['Off', 'Rollout', 'On', 'Retired'] as const;
export type Status = (typeof STATUSES)[number];

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

export interface FlagView {
  key: string;
  description: string;
  status: Status;
  cohorts: string[];
  tenantIds: string[];
  percentage: number;
  revision: number;
  version: number;
  updatedAt: string;
}

function toFlag(raw: unknown): FlagView | undefined {
  const row = asRecord(raw);
  const key = text(row?.flag_key);
  const status = STATUSES.find((candidate) => candidate === row?.status);
  if (row === undefined || key === undefined || status === undefined || typeof row.revision !== 'number' || typeof row.version !== 'number') return undefined;
  const rollout = asRecord(row.rollout);
  return {
    key,
    description: text(row.description) ?? '',
    status,
    cohorts: strings(rollout?.tenant_cohorts),
    tenantIds: strings(rollout?.tenant_ids),
    percentage: typeof rollout?.percentage === 'number' ? rollout.percentage : 0,
    revision: row.revision,
    version: row.version,
    updatedAt: text(row.updated_at) ?? '',
  };
}

export const toFlags = (raw: unknown): FlagView[] => (Array.isArray(asRecord(raw)?.items) ? (asRecord(raw)?.items as unknown[]) : []).flatMap((item) => toFlag(item) ?? []);

type Mode = 'FULL' | 'READ_ONLY' | undefined;
export const holds = (permissions: readonly string[] | undefined, permission: string, mode: Mode): boolean => (permissions === undefined || permissions.includes(permission)) && mode !== 'READ_ONLY';

/** A retired flag is final. */
export const isChangeable = (flag: Pick<FlagView, 'status'>): boolean => flag.status !== 'Retired';

// ---- the editor --------------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'invalid';
export type FlagField = 'cohorts' | 'tenantIds' | 'percentage' | 'reason';

export interface FlagForm {
  status: Status;
  /** Cohort names separated by commas. */
  cohorts: string;
  /** Tenant identifiers separated by commas, spaces or line breaks. */
  tenantIds: string;
  percentage: string;
  reason: string;
}

export const formOfFlag = (flag: FlagView): FlagForm => ({
  status: flag.status,
  cohorts: flag.cohorts.join(', '),
  tenantIds: flag.tenantIds.join('\n'),
  percentage: flag.percentage === 0 ? '' : String(flag.percentage),
  reason: '',
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COHORT = /^[a-z0-9][a-z0-9-]{1,30}$/;
const split = (value: string, separator: RegExp): string[] => [...new Set(value.split(separator).map((item) => item.trim()).filter((item) => item !== ''))];

export const cohortsOf = (form: Pick<FlagForm, 'cohorts'>): string[] => split(form.cohorts, /,/);
export const tenantIdsOf = (form: Pick<FlagForm, 'tenantIds'>): string[] => split(form.tenantIds.toLowerCase(), /[\s,]+/);

/** What the screen can tell before it asks: a rollout names whom the flag is on for, the cohorts and the tenants are well formed, the share is a whole number up to 100, and the reason is real. */
export function validateFlag(form: FlagForm): Partial<Record<FlagField, FormProblem>> {
  const found: Partial<Record<FlagField, FormProblem>> = {};
  const reason = form.reason.trim();
  if (reason === '') found.reason = 'required';
  else if (reason.length < 10 || reason.length > 2000) found.reason = 'invalid';
  if (form.status !== 'Rollout') return found;
  const cohorts = cohortsOf(form);
  const ids = tenantIdsOf(form);
  const share = form.percentage.trim();
  if (cohorts.length > 20 || cohorts.some((cohort) => !COHORT.test(cohort))) found.cohorts = 'invalid';
  if (ids.length > 500 || ids.some((id) => !UUID.test(id))) found.tenantIds = 'invalid';
  if (share !== '' && !(/^\d{1,3}$/.test(share) && Number(share) <= 100)) found.percentage = 'invalid';
  if (found.cohorts === undefined && found.tenantIds === undefined && found.percentage === undefined && cohorts.length === 0 && ids.length === 0 && (share === '' || Number(share) === 0)) found.cohorts = 'required';
  return found;
}

export function flagBody(form: FlagForm): Record<string, unknown> {
  const reason = form.reason.trim();
  if (form.status !== 'Rollout') return { status: form.status, reason };
  const share = form.percentage.trim();
  return {
    status: 'Rollout',
    rollout: { tenant_cohorts: cohortsOf(form), tenant_ids: tenantIdsOf(form), ...(share === '' ? {} : { percentage: Number(share) }) },
    reason,
  };
}

// ---- what the server refuses ---------------------------------------------------------------------------------------------------

export type FlagProblem = 'rule' | 'versionConflict' | 'notFound' | 'scopeDenied' | 'validation' | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, FlagProblem>> = {
  FLAG_RULE_INVALID: 'rule',
  VERSION_CONFLICT: 'versionConflict',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'scopeDenied',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
};

export const describeFlag = (error: unknown): FlagProblem => (error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general');
