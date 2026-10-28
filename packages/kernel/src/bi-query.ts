import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { DomainError } from './errors.ts';
import type { MetricDefinition, MetricNode, NullPolicy, NullReason } from './bi-metric.ts';
import { ratioOfSums } from './bi-metric.ts';

/**
 * The query of BI (ST-BI-004, BI 3 F3, F4): a metric over one frozen snapshot, cut by a dimension of its dataset, the figures from sums. The server writes the query from allowlists (the fields a metric may read,
 * the dimensions a dataset offers); nothing a caller sends is a piece of SQL. A figure that cannot be given is null with its reason, never 0.
 */

/** The fields a metric of the disbursement dataset may read, and the column of a snapshot line each one is. */
export const DISBURSEMENT_FIELDS: Readonly<Record<string, string>> = {
  GIAI_NGAN: 'disbursed_treasury_vnd',
  GIAI_NGAN_BAO_CAO: 'disbursed_reported_vnd',
  KE_HOACH_TTG: 'plan_pm_assigned_vnd',
  KE_HOACH_DIA_PHUONG: 'plan_local_added_vnd',
  KE_HOACH_TONG: 'plan_total_vnd',
  CTMTQG: 'ctmtqg_subset_vnd',
  DU_AN: 'project_id',
  DON_VI: 'unit_id',
};

/** The dimensions of the disbursement dataset, and the column of a snapshot line each one cuts by. */
export const DISBURSEMENT_DIMENSIONS: Readonly<Record<string, { column: string; kind: 'uuid' | 'text' }>> = {
  unit: { column: 'unit_id', kind: 'uuid' },
  project: { column: 'project_id', kind: 'uuid' },
  fund_source: { column: 'fund_source_version_id', kind: 'uuid' },
  budget_level: { column: 'budget_level', kind: 'text' },
  bucket: { column: 'bucket', kind: 'text' },
};

/** The fields that are identifiers: they are counted apart, never added. */
const IDENTIFIER_FIELDS: ReadonlySet<string> = new Set(['DU_AN', 'DON_VI']);

export type MeasureKind = 'ADDITIVE' | 'RATIO' | 'DISTINCT';

/** What the query adds up for a metric: a column summed (or counted apart), and for a ratio the second column its denominator is. */
export interface MeasurePlan {
  kind: MeasureKind;
  numeratorColumn: string;
  denominatorColumn: string | null;
  /** What a group with no line is: no data, or zero when the metric says so. */
  nullPolicy: NullPolicy;
}

const notComputable = (): DomainError => new DomainError('VALIDATION_FAILED', 422, 'metric_version_id');

function columnOf(node: MetricNode | null, aggregate: 'sum' | 'count_distinct'): string {
  const call = node as { op?: unknown; args?: unknown } | null;
  const arg = Array.isArray(call?.args) ? (call.args[0] as { op?: unknown; name?: unknown } | undefined) : undefined;
  if (call?.op !== aggregate || (call.args as unknown[]).length !== 1 || arg?.op !== 'field' || typeof arg.name !== 'string') throw notComputable();
  const column = DISBURSEMENT_FIELDS[arg.name];
  // An identifier is counted, never summed (sum(uuid) is not a thing, and the database would say so as a server error).
  if (column === undefined || (aggregate === 'sum' && IDENTIFIER_FIELDS.has(arg.name))) throw notComputable();
  return column;
}

/**
 * What a metric needs of the snapshot lines. A ratio is the sum of one field over the sum of another, an additive metric (and a semi-additive one, within one snapshot) is the sum of a field, a distinct metric
 * counts the distinct values of a field. A metric that reads a field the dataset does not have, or is built another way, cannot be queried.
 */
export function measurePlanOf(metric: Pick<MetricDefinition, 'aggregationType' | 'expressionAst' | 'numeratorAst' | 'denominatorAst'> & { nullPolicy?: NullPolicy }): MeasurePlan {
  const nullPolicy = metric.nullPolicy ?? 'NULL_NOT_ZERO';
  switch (metric.aggregationType) {
    case 'ratio':
      return { kind: 'RATIO', numeratorColumn: columnOf(metric.numeratorAst, 'sum'), denominatorColumn: columnOf(metric.denominatorAst, 'sum'), nullPolicy };
    case 'additive':
    case 'semi_additive':
      return { kind: 'ADDITIVE', numeratorColumn: columnOf(metric.expressionAst, 'sum'), denominatorColumn: null, nullPolicy };
    case 'distinct':
      return { kind: 'DISTINCT', numeratorColumn: columnOf(metric.expressionAst, 'count_distinct'), denominatorColumn: null, nullPolicy };
  }
}

/** The sums of a group as the database gives them: text, or null when no line had a figure. */
export interface GroupSums {
  numerator: string | null;
  denominator: string | null;
  distinct: string | null;
  /** How many lines the group has: none is different from lines that have no figure. */
  lines?: string | null;
}

export interface Figure {
  /** An additive or distinct metric: the whole number; a ratio: the percent with two decimals. Null with its reason when it cannot be given. */
  value: string | null;
  numerator: string | null;
  denominator: string | null;
  nullReason: NullReason | null;
}

const WHOLE = /^-?(0|[1-9]\d*)$/;

/** The figure of a group. A group with no figure is NO_DATA, a ratio over a denominator of zero NOT_APPLICABLE; neither is zero. */
export function figureOf(plan: MeasurePlan, sums: GroupSums): Figure {
  // A metric that says no lines is zero is zero when there is no line at all; lines with no figure are still no data.
  if (sums.lines === '0' && plan.nullPolicy === 'ZERO_IF_NO_ROWS') {
    return plan.kind === 'RATIO' ? { value: '0.00', numerator: '0', denominator: '0', nullReason: null } : { value: '0', numerator: null, denominator: null, nullReason: null };
  }
  if (plan.kind === 'DISTINCT') return sums.distinct === null ? { value: null, numerator: null, denominator: null, nullReason: 'NO_DATA' } : { value: sums.distinct, numerator: null, denominator: null, nullReason: null };
  if (plan.kind === 'ADDITIVE') return sums.numerator === null ? { value: null, numerator: null, denominator: null, nullReason: 'NO_DATA' } : { value: sums.numerator, numerator: null, denominator: null, nullReason: null };
  if (sums.numerator === null || sums.denominator === null) return { value: null, numerator: sums.numerator, denominator: sums.denominator, nullReason: 'NO_DATA' };
  const ratio = ratioOfSums([{ numerator: sums.numerator, denominator: sums.denominator }], 'NULL_NOT_ZERO');
  return { value: ratio.percent, numerator: ratio.numerator, denominator: ratio.denominator, nullReason: ratio.nullReason };
}

export interface QueryReconciliation {
  reconcilesToParent: boolean;
  nonAdditiveReason: string | null;
}

/**
 * Whether the children add up to the parent. The sums of an additive metric do; a ratio does through its numerators and denominators (the ratio of the parent is made from their sums, never from the ratios of the
 * children); a distinct count does not when one thing is in two groups: each group counts it and the total counts it once.
 */
export function reconcile(plan: MeasurePlan, children: readonly GroupSums[], parent: GroupSums): QueryReconciliation {
  const sum = (values: ReadonlyArray<string | null>): bigint => values.reduce<bigint>((total, value) => (value !== null && WHOLE.test(value) ? total + BigInt(value) : total), 0n);
  if (plan.kind === 'DISTINCT') {
    const same = sum(children.map((child) => child.distinct)) === sum([parent.distinct]);
    return same ? { reconcilesToParent: true, nonAdditiveReason: null } : { reconcilesToParent: false, nonAdditiveReason: 'DISTINCT_NOT_ADDITIVE' };
  }
  const numerators = sum(children.map((child) => child.numerator)) === sum([parent.numerator]);
  const denominators = plan.kind === 'RATIO' ? sum(children.map((child) => child.denominator)) === sum([parent.denominator]) : true;
  return numerators && denominators ? { reconcilesToParent: true, nonAdditiveReason: null } : { reconcilesToParent: false, nonAdditiveReason: 'CHILDREN_DO_NOT_ADD_UP' };
}

// ---- the token of a drill ------------------------------------------------------------------------------------------------------------------

export const BI_DRILL_TTL_SECONDS = 1800;
const PURPOSE = 'bi-drill:';
const MIN_KEY_BYTES = 32;

/** What a token names: ids only, no figure and no name. The context it points at is kept by the server. */
export interface BiDrillClaims {
  v: 1;
  tid: string;
  ctx_id: string;
  scope_hash: string;
  metric_version_id: string;
  snapshot_id: string;
  as_of_period: string;
  iat: number;
  exp: number;
  kid: string;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);
const invalid = (): DomainError => new DomainError('DRILL_TOKEN_INVALID', 400);

/** The key of one tenant, from the key of the application and the id of the key: a token of tenant A is not good under the key of tenant B, and a key can be turned by a new id. */
export function tenantDrillKey(rootKey: Buffer, tenantId: string, kid: string): Buffer {
  if (rootKey.length < MIN_KEY_BYTES) throw new Error('key too short');
  return createHmac('sha256', rootKey).update(`${PURPOSE}key:${tenantId}:${kid}`).digest();
}

const mac = (payloadPart: string, key: Buffer): Buffer => createHmac('sha256', key).update(PURPOSE).update(payloadPart).digest();

export function signBiDrill(claims: Omit<BiDrillClaims, 'v' | 'iat' | 'exp' | 'kid'>, rootKey: Buffer, kid: string, now: () => number = nowSeconds): string {
  const issued = now();
  const full: BiDrillClaims = { v: 1, ...claims, iat: issued, exp: issued + BI_DRILL_TTL_SECONDS, kid };
  const payloadPart = Buffer.from(JSON.stringify(full), 'utf8').toString('base64url');
  return `${payloadPart}.${mac(payloadPart, tenantDrillKey(rootKey, claims.tid, kid)).toString('base64url')}`;
}

const text = (value: unknown): value is string => typeof value === 'string' && value !== '';

/**
 * Reads a token back, old or not: the shape and the signature under the key of the tenant the token names are judged, the age is not. Anything that was altered, signed for another tenant or key, made for another
 * purpose or is not a token is `400 DRILL_TOKEN_INVALID` that says nothing of why. The caller judges that the tenant is the one of the session before it judges the age.
 */
export function parseBiDrill(token: string, rootKey: Buffer): BiDrillClaims {
  if (token.length > 2000) throw invalid();
  const parts = token.split('.');
  const payloadPart = parts[0];
  const signaturePart = parts[1];
  if (parts.length !== 2 || !payloadPart || !signaturePart) throw invalid();
  let record: Record<string, unknown> | null;
  try {
    record = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as Record<string, unknown> | null;
  } catch {
    throw invalid();
  }
  if (typeof record !== 'object' || record === null || record.v !== 1 || !text(record.tid) || !text(record.ctx_id) || !text(record.scope_hash) || !text(record.metric_version_id) || !text(record.snapshot_id) || !text(record.as_of_period) || !text(record.kid) || typeof record.iat !== 'number' || typeof record.exp !== 'number') {
    throw invalid();
  }
  const expected = mac(payloadPart, tenantDrillKey(rootKey, record.tid, record.kid));
  const actual = Buffer.from(signaturePart, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw invalid();
  return record as unknown as BiDrillClaims;
}

/** The refusal of a token that is good and old: the context to ask again for is in the body. */
export const expiredBiDrill = (claims: BiDrillClaims): DomainError => new DomainError('SNAPSHOT_EXPIRED', 409, undefined, { extensions: { snapshot_id: claims.snapshot_id, as_of_period: claims.as_of_period } });

// ---- the key of the cache ------------------------------------------------------------------------------------------------------------------

/** The scope a person queries in, as a hash: who, the version of their grants, and what those grants let them read now (not shared between scopes). */
export function biScopeHash(input: { membershipId: string; scopeVersion: number; grants: string }): string {
  return createHash('sha256').update(`bi|${input.membershipId}|${input.scopeVersion}|${input.grants}`).digest('hex');
}

/** `t:{tenant}:bi:{metric_versions}:{filters_hash}:{snapshot_id}:{scope_hash}` — a cached answer is shared by nobody whose tenant, snapshot, query or scope differs (BR-BI-07). */
export function queryCacheKey(input: { tenantId: string; metricVersionIds: readonly string[]; filtersHash: string; snapshotId: string; scopeHash: string }): string {
  return `t:${input.tenantId}:bi:${[...input.metricVersionIds].sort().join(',')}:${input.filtersHash}:${input.snapshotId}:${input.scopeHash}`;
}
