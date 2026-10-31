import { createHash } from 'node:crypto';
import { DomainError } from './errors.ts';
import { asUuid } from './tenant-context.ts';

/**
 * The release flags of the platform (ST-SAS-020, SAS 3.11, SAS-20): a flag decides which code path a tenant runs while a release is staged. It never grants a commercial entitlement (BR-R07: a flag can only
 * switch more off, not give a right) and is read next to the entitlements, not instead of them. Pure functions of their input.
 */
export const FLAG_STATUSES = ['Off', 'Rollout', 'On', 'Retired'] as const;
export type FlagStatus = (typeof FLAG_STATUSES)[number];

/**
 * The flags the code declares. A flag is rolled out by its key, so the key is part of the code and not typed in a screen; the database holds the rollout of each (a migration writes the flags declared here as Off).
 */
export const DECLARED_FLAGS: ReadonlyArray<{ key: string; description: string }> = [
  { key: 'sas.silo_promotion', description: 'Promotion of a tenant from the shared placement to a silo of its own (SAS-23)' },
  { key: 'sas.tenant_restore_in_place', description: 'Restore of a tenant in place at a recovery point, for a Suspended tenant (SAS-21)' },
];

export const FLAG_COHORT_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}$/;
const MAX_COHORTS = 20;
const MAX_TENANTS = 500;
const REASON_MIN = 10;
const REASON_MAX = 2000;

export interface FlagRollout {
  /** The cohorts of tenants the flag is on for: a tenant is in the cohort named like its region. */
  cohorts: string[];
  /** Tenants named one by one. */
  tenantIds: string[];
  /** The share of tenants, 0 to 100, chosen by a stable bucket of the flag and the tenant: the same tenant stays in or out as the share grows. */
  percentage: number;
}

export const NO_ROLLOUT: FlagRollout = { cohorts: [], tenantIds: [], percentage: 0 };

export interface FlagUpdate {
  status: FlagStatus;
  rollout: FlagRollout;
  reason: string;
}

const refused = (field: string): DomainError => new DomainError('FLAG_RULE_INVALID', 422, field);

/** The rollout a body names, in the shape the flag keeps; a rollout that is not the shape of the contract is refused. */
function rolloutOf(raw: unknown): FlagRollout {
  if (raw === undefined) return NO_ROLLOUT;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw refused('rollout');
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) if (key !== 'tenant_cohorts' && key !== 'tenant_ids' && key !== 'percentage') throw refused(`rollout.${key}`);
  const cohorts = body.tenant_cohorts === undefined ? [] : body.tenant_cohorts;
  if (!Array.isArray(cohorts) || cohorts.length > MAX_COHORTS || cohorts.some((cohort) => typeof cohort !== 'string' || !FLAG_COHORT_PATTERN.test(cohort))) throw refused('rollout.tenant_cohorts');
  const ids = body.tenant_ids === undefined ? [] : body.tenant_ids;
  const tenantIds = Array.isArray(ids) ? ids.map((id) => asUuid(id)) : [];
  if (!Array.isArray(ids) || ids.length > MAX_TENANTS || tenantIds.some((id) => id === undefined)) throw refused('rollout.tenant_ids');
  const percentage = body.percentage === undefined ? 0 : body.percentage;
  if (typeof percentage !== 'number' || !Number.isInteger(percentage) || percentage < 0 || percentage > 100) throw refused('rollout.percentage');
  return { cohorts: [...new Set(cohorts as string[])].sort(), tenantIds: [...new Set(tenantIds as string[])].sort(), percentage };
}

/** Whether a rollout names anyone: a cohort, a tenant or a share above nothing. */
export const rolloutNamesAnyone = (rollout: FlagRollout): boolean => rollout.cohorts.length > 0 || rollout.tenantIds.length > 0 || rollout.percentage > 0;

/**
 * What an update says. `Rollout` names whom the flag is on for and must name someone; `Off`, `On` and `Retired` name no one (the rollout is empty, so a flag that is on for everybody is not also "on for a pilot").
 * The reason is 10 to 2000 characters. Every refusal is 422 `FLAG_RULE_INVALID` with the field.
 */
export function assertFlagUpdate(raw: { status?: unknown; rollout?: unknown; reason?: unknown }): FlagUpdate {
  const status = FLAG_STATUSES.find((candidate) => candidate === raw.status);
  if (status === undefined) throw refused('status');
  const reason = typeof raw.reason === 'string' ? raw.reason.normalize('NFC').trim() : '';
  if (reason.length < REASON_MIN || reason.length > REASON_MAX) throw refused('reason');
  const rollout = rolloutOf(raw.rollout);
  if (status === 'Rollout' && !rolloutNamesAnyone(rollout)) throw refused('rollout');
  if (status !== 'Rollout' && (rolloutNamesAnyone(rollout) || (raw.rollout !== undefined && Object.keys(raw.rollout as object).length > 0))) throw refused('rollout');
  return { status, rollout: status === 'Rollout' ? rollout : NO_ROLLOUT, reason };
}

/** A retired flag is final: the code path it decided is no longer in the code, so it is changed no more. */
export function assertFlagChangeable(current: FlagStatus): void {
  if (current === 'Retired') throw refused('status');
}

export interface FlagState {
  key: string;
  status: FlagStatus;
  rollout: FlagRollout;
}

export interface FlagTenant {
  id: string;
  /** The region of the placement of the tenant, which is the cohort it belongs to. */
  region: string;
}

/** The bucket 0 to 99 a tenant falls in for a flag: a stable hash of both, so the same tenant is in or out whatever else changes. */
export function rolloutBucket(key: string, tenantId: string): number {
  const digest = createHash('sha256').update(`${key}:${tenantId.toLowerCase()}`).digest();
  return digest.readUInt32BE(0) % 100;
}

/** Whether the flag is on for the tenant. `On` is on for everyone; `Off` and `Retired` for no one; `Rollout` for a tenant named, in a cohort named, or in the share of the percentage. */
export function flagEnabled(flag: FlagState, tenant: FlagTenant): boolean {
  switch (flag.status) {
    case 'On':
      return true;
    case 'Off':
    case 'Retired':
      return false;
    case 'Rollout':
      return flag.rollout.tenantIds.includes(tenant.id.toLowerCase()) || flag.rollout.cohorts.includes(tenant.region) || rolloutBucket(flag.key, tenant.id) < flag.rollout.percentage;
  }
}
