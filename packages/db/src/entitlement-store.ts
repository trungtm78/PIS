import { randomUUID } from 'node:crypto';
import { DomainError, activeOverride, allowedFeature, entitlementsHash, licenseModeAt } from '@machvon/kernel';
import type { FeatureEntry, OperationKind, Override, TenantAccessPolicy, TenantContext } from '@machvon/kernel';
import type { EntitlementCache, EntitlementSnapshot } from './entitlement-cache.ts';
import { enqueueOutbox } from './outbox.ts';
import type { TenantDatabase, TenantTx } from './tenant-database.ts';

export type EntitlementCause = 'PROVISIONING' | 'SUBSCRIPTION_CHANGE' | 'OVERRIDE' | 'LICENSE_CHANGE' | 'TENANT_STATUS' | 'EXPIRY';

export interface RecordEntitlementInput {
  cause: EntitlementCause;
  planVersionId: string;
  features: readonly FeatureEntry[];
  subscriptionId?: string;
  correlationId?: string;
}

export interface EntitlementStoreOptions {
  /** Cache lifetime; default 60 seconds (BR-SAS-10). */
  ttlSeconds?: number;
  now?: () => Date;
}

export const ENTITLEMENT_CHANGED_EVENT = 'sas.entitlement.changed.v1';
const DEFAULT_TTL_SECONDS = 60;

const LATEST_VERSION_ID_SQL = 'select id from machvon.entitlement_version order by version_no desc limit 1';
const LATEST_VERSION_SQL = 'select id, version_no, entitlements_hash, features_json from machvon.entitlement_version order by version_no desc limit 1';
const OVERRIDES_SQL = "select feature_code, enabled, limit_value, valid_from, valid_until, status from machvon.entitlement_override where status = 'Active'";
// A superseded or draft revision says nothing about the tenant today. Of the others the one that counts is, in this order: one
// that has started (a renewal that starts later must not replace the license that is valid now; without any started revision
// the one that starts soonest is returned, which the kernel judges as not licensed yet), then one still in force (not revoked and
// before its grace end, so a new license outranks a revoked or an ended one whatever their serials are), then the latest start.
// Serials are independent of each other and every first revision is 1, so the revision number only breaks a final tie.
// $1 is the clock of the store. The mode follows the clock (`licenseModeAt`), so a license is Grace or Expired from its dates
// whether or not the status job has stored the label yet.
const LICENSE_SQL = `select status, valid_from, valid_until, grace_until from machvon.license_revision
  where status not in ('Draft', 'Superseded')
  order by (valid_from <= $1::timestamptz) desc,
           (status <> 'Revoked' and $1::timestamptz < grace_until) desc,
           case when valid_from <= $1::timestamptz then valid_from end desc nulls last,
           valid_from asc,
           revision desc, serial desc
  limit 1`;
const LATEST_SOURCE_SQL = 'select plan_version_id, subscription_id, features_json from machvon.entitlement_version order by version_no desc limit 1';
const RUNTIME_SQL = 'select access_policy from machvon.tenant_runtime($1::uuid)';
const NEXT_VERSION_SQL = `select coalesce(max(version_no), 0) + 1 as version_no, nullif(current_setting('app.tenant_id', true), '') as tenant_id
  from machvon.entitlement_version`;
const LOCK_SQL = "select pg_advisory_xact_lock(hashtextextended('entitlement:' || current_setting('app.tenant_id'), 0))";
const INSERT_VERSION_SQL = `insert into machvon.entitlement_version
    (tenant_id, id, version_no, subscription_id, plan_version_id, features_json, entitlements_hash, cause, effective_from)
  values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2, $3, $4::jsonb, $5, $6, now())`;

interface VersionRow {
  id: string;
  version_no: string;
  entitlements_hash: string;
  features_json: unknown;
}

interface OverrideRow {
  feature_code: string;
  enabled: boolean;
  limit_value: string | null;
  valid_from: Date;
  valid_until: Date;
  status: string;
}

const LIMIT_KINDS = ['BOOLEAN', 'QUOTA', 'METERED'];
const GRACE_BEHAVIOURS = ['ALLOW', 'READ_ONLY', 'DENY'];
const EXPIRED_BEHAVIOURS = ['READ_ONLY', 'EXPORT_ONLY', 'DENY'];
const TENANT_POLICIES: readonly TenantAccessPolicy[] = ['FULL', 'READ_ONLY_EXPORT', 'NO_ACCESS'];

// A stored feature list that is not what record() wrote is data corruption: a plain error becomes 500 INTERNAL_ERROR and is logged.
function malformed(): Error {
  return new Error('malformed entitlement features');
}

function featureOf(value: unknown): FeatureEntry {
  if (typeof value !== 'object' || value === null) throw malformed();
  const row = value as Record<string, unknown>;
  const { featureCode, limitKind, limitValue, graceBehavior, expiredBehavior } = row;
  if (
    typeof featureCode !== 'string' ||
    typeof limitKind !== 'string' ||
    !LIMIT_KINDS.includes(limitKind) ||
    typeof graceBehavior !== 'string' ||
    !GRACE_BEHAVIOURS.includes(graceBehavior) ||
    typeof expiredBehavior !== 'string' ||
    !EXPIRED_BEHAVIOURS.includes(expiredBehavior) ||
    (limitValue !== undefined && typeof limitValue !== 'number')
  ) {
    throw malformed();
  }
  return {
    featureCode,
    limitKind: limitKind as FeatureEntry['limitKind'],
    ...(limitValue === undefined ? {} : { limitValue }),
    graceBehavior: graceBehavior as FeatureEntry['graceBehavior'],
    expiredBehavior: expiredBehavior as FeatureEntry['expiredBehavior'],
  };
}

function featuresOf(json: unknown): FeatureEntry[] {
  if (!Array.isArray(json)) throw malformed();
  return json.map(featureOf);
}

function overrideOf(row: OverrideRow): Override {
  return {
    featureCode: row.feature_code,
    enabled: row.enabled,
    ...(row.limit_value === null ? {} : { limitValue: Number(row.limit_value) }),
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    status: row.status,
  };
}

/**
 * The limit in force of each feature that has one, as text, for the usage screens (SAS-11): the limit of the override in force when it names one, else the
 * number of the plan for a quota or a metered feature. A switch (BOOLEAN) has no limit to show, whatever number the plan stores for it. Reads inside the
 * transaction the caller opened for the tenant, like the control plane does.
 */
export async function effectiveLimits(tx: TenantTx, now: Date): Promise<ReadonlyMap<string, string>> {
  const [version] = await tx.query<VersionRow>(LATEST_VERSION_SQL);
  const features = version === undefined ? [] : featuresOf(version.features_json);
  const overrides = (await tx.query<OverrideRow>(OVERRIDES_SQL)).map(overrideOf);
  const limits = new Map<string, string>();
  for (const code of new Set([...features.map((feature) => feature.featureCode), ...overrides.map((override) => override.featureCode)])) {
    const entry = features.find((feature) => feature.featureCode === code);
    const value = activeOverride(overrides, code, now)?.limitValue ?? (entry !== undefined && entry.limitKind !== 'BOOLEAN' ? entry.limitValue : undefined);
    if (value !== undefined) limits.set(code, String(value));
  }
  return limits;
}

/**
 * Adds the next entitlement version of the tenant of `tx` and the `sas.entitlement.changed.v1` event in the same transaction. Versions are insert-only;
 * concurrent callers take the tenant's advisory lock, so numbers have no gap or duplicate. A function and not only a method of the store: what changes a
 * tenant's plan (a subscription, a job of the tenant) records a version without needing the cache that the store reads through.
 */
export async function recordEntitlementVersion(tx: TenantTx, input: RecordEntitlementInput): Promise<{ versionNo: number; hash: string }> {
  await tx.query(LOCK_SQL);
  const [next] = await tx.query<{ version_no: string; tenant_id: string | null }>(NEXT_VERSION_SQL);
  if (next === undefined || next.tenant_id === null) throw new DomainError('TENANT_CONTEXT_INVALID', 400);
  const versionNo = Number(next.version_no);
  const hash = entitlementsHash(input.features);
  await tx.query(INSERT_VERSION_SQL, [versionNo, input.subscriptionId ?? null, input.planVersionId, JSON.stringify(input.features), hash, input.cause]);
  const correlationId = input.correlationId ?? randomUUID();
  await enqueueOutbox(tx, {
    aggregateType: 'tenant',
    aggregateId: next.tenant_id,
    aggregateVersion: versionNo,
    type: ENTITLEMENT_CHANGED_EVENT,
    schemaVersion: 1,
    payload: { tenant_id: next.tenant_id, version_no: versionNo, entitlements_hash: hash },
    eventKey: `entitlement:${next.tenant_id}:${versionNo}`,
    correlationId,
  });
  return { versionNo, hash };
}

/**
 * Records a new version with the features of the latest one: the source of the change is not the plan (a license was issued or revoked, the tenant changed state,
 * an override was decided or ended), but every such change tells the sessions of the tenant through `sas.entitlement.changed.v1`.
 */
export async function recordCurrentEntitlementVersion(tx: TenantTx, cause: EntitlementCause, correlationId?: string): Promise<{ versionNo: number; hash: string }> {
  // The lock comes first: another transaction may be recording a version, and this one has to copy the version that results.
  await tx.query(LOCK_SQL);
  const [latest] = await tx.query<{ plan_version_id: string; subscription_id: string | null; features_json: unknown }>(LATEST_SOURCE_SQL);
  if (latest === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
  return recordEntitlementVersion(tx, {
    cause,
    planVersionId: latest.plan_version_id,
    features: featuresOf(latest.features_json),
    ...(latest.subscription_id === null ? {} : { subscriptionId: latest.subscription_id }),
    ...(correlationId === undefined ? {} : { correlationId }),
  });
}

/**
 * Entitlements of a tenant: the latest `entitlement_version` plus its active overrides, the license status and the
 * tenant state, evaluated by the kernel `allowedFeature` (BR-SAS-10). Reads go through a per-tenant cache; a decision for a
 * risky command asks the database instead. A tenant with no version has no features at all, so gated features are off.
 */
export class EntitlementStore {
  private readonly database: TenantDatabase;
  private readonly cache: EntitlementCache;
  private readonly ttlSeconds: number;
  private readonly now: () => Date;

  constructor(database: TenantDatabase, cache: EntitlementCache, options: EntitlementStoreOptions = {}) {
    this.database = database;
    this.cache = cache;
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Takes the entitlement lock of the tenant the transaction acts as, held until the transaction ends. A caller that decides from
   * the versions it can see ("record the first one only when there is none") takes it first, so that two of them cannot both decide.
   */
  async lock(tx: TenantTx): Promise<void> {
    await tx.query(LOCK_SQL);
  }

  /** The id of the latest entitlement version of the tenant of `tx` (the version a license signs), or undefined when it has none. */
  async latestVersionId(tx: TenantTx): Promise<string | undefined> {
    const [row] = await tx.query<{ id: string }>(LATEST_VERSION_ID_SQL);
    return row?.id;
  }

  /** The snapshot of the caller's tenant, from the cache while it is fresh. */
  async current(ctx: TenantContext): Promise<EntitlementSnapshot> {
    const cached = await this.cache.get(ctx.tenantId);
    if (cached !== undefined) return cached;
    const snapshot = await this.database.withTenant(ctx, (tx) => this.readSnapshot(tx, ctx.tenantId));
    await this.cache.set(ctx.tenantId, snapshot, this.ttlSeconds);
    return snapshot;
  }

  /** Reads inside a transaction the caller opened for the tenant (the control plane reads another tenant this way); never cached. */
  currentIn(tx: TenantTx, tenantId: string): Promise<EntitlementSnapshot> {
    return this.readSnapshot(tx, tenantId);
  }

  async allowed(ctx: TenantContext, feature: string, operationKind: OperationKind, now: Date = this.now()): Promise<{ allowed: boolean; reason?: string }> {
    return this.judge(await this.current(ctx), feature, operationKind, now);
  }

  /** The same decision on fresh data, for commands that must not run on a stale answer (license, money, AI, campaigns). */
  async allowedFromDatabase(ctx: TenantContext, feature: string, operationKind: OperationKind, now: Date = this.now()): Promise<{ allowed: boolean; reason?: string }> {
    const snapshot = await this.database.withTenant(ctx, (tx) => this.readSnapshot(tx, ctx.tenantId));
    return this.judge(snapshot, feature, operationKind, now);
  }

  /** See `recordEntitlementVersion`. */
  record(tx: TenantTx, input: RecordEntitlementInput): Promise<{ versionNo: number; hash: string }> {
    return recordEntitlementVersion(tx, input);
  }

  /** See `recordCurrentEntitlementVersion`. */
  recordCurrent(tx: TenantTx, cause: EntitlementCause, correlationId?: string): Promise<{ versionNo: number; hash: string }> {
    return recordCurrentEntitlementVersion(tx, cause, correlationId);
  }

  private judge(snapshot: EntitlementSnapshot, feature: string, operationKind: OperationKind, now: Date): { allowed: boolean; reason?: string } {
    return allowedFeature({
      features: snapshot.features,
      overrides: snapshot.overrides,
      licenseMode: snapshot.licenseMode,
      tenantPolicy: snapshot.tenantPolicy,
      feature,
      operationKind,
      now,
    });
  }

  private async readSnapshot(tx: TenantTx, tenantId: string): Promise<EntitlementSnapshot> {
    const [version] = await tx.query<VersionRow>(LATEST_VERSION_SQL);
    const features = version === undefined ? [] : featuresOf(version.features_json);
    const overrides = (await tx.query<OverrideRow>(OVERRIDES_SQL)).map(overrideOf);
    const [license] = await tx.query<{ status: string; valid_from: Date; valid_until: Date; grace_until: Date }>(LICENSE_SQL, [this.now().toISOString()]);
    const [runtime] = await tx.query<{ access_policy: string }>(RUNTIME_SQL, [tenantId]);
    // A tenant without a license is FULL (the license issue is a later story); one without a tenant row, as in fixtures, is FULL too.
    const policy = TENANT_POLICIES.find((candidate) => candidate === runtime?.access_policy) ?? 'FULL';
    return {
      ...(version === undefined ? {} : { versionId: version.id }),
      versionNo: version === undefined ? 0 : Number(version.version_no),
      hash: version === undefined ? entitlementsHash([]) : version.entitlements_hash,
      features,
      overrides,
      licenseMode: license === undefined ? 'FULL' : licenseModeAt({ status: license.status, validFrom: license.valid_from, validUntil: license.valid_until, graceUntil: license.grace_until }, this.now()),
      tenantPolicy: policy,
    };
  }
}
