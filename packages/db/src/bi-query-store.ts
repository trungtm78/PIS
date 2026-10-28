import { randomUUID } from 'node:crypto';
import { DISBURSEMENT_DIMENSIONS, DomainError } from '@machvon/kernel';
import type { GroupSums, MeasurePlan } from '@machvon/kernel';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ROWS = 500;
/** The label of the group that has no value in the dimension: it is shown, so that the children add up to the parent. */
export const UNCLASSIFIED_KEY = null;

export type FilterOperator = 'eq' | 'in' | 'gte' | 'lte';
export interface QueryFilter {
  field: string;
  operator: FilterOperator;
  value: unknown;
}

/** A row predicate of an access policy, as the kernel validated it; compiled here to a condition over the snapshot lines. */
export type PolicyNode = Record<string, unknown>;

export interface AggregateInput {
  snapshotId: string;
  plan: MeasurePlan;
  /** The dimension to group by; none gives the total. */
  dimension?: string | undefined;
  filters: readonly QueryFilter[];
  /** The projects the reader may read: a line of a project outside it is not counted. */
  projects: ScopeBuilder;
  /** The row predicates of the applicable policies: a line is counted when any of them allows it (within the scope of the reader). */
  policies: readonly PolicyNode[];
}

export interface AggregateRow extends GroupSums {
  key: string | null;
  label: string | null;
}

export interface SnapshotVersion {
  /** The snapshot of BI: the version of the dataset for a period. It is what a query is pinned to and what the API calls `snapshot_id`. */
  datasetVersionId: string;
  datasetId: string;
  /** The frozen close snapshot of DIS the version was made from: its lines are what the query reads. */
  sourceSnapshotId: string;
  periodCode: string;
  periodId: string;
  qualityBadge: string;
  excludedQuarantineRows: number;
  versionStatus: string;
  builtAt: string;
  /** The frozen version of the period now, if it is another than the one asked: new data is available (the banner), the figures stay on the version asked. */
  newerSnapshotId: string | null;
}

export interface ContextRow {
  id: string;
  metricVersionId: string;
  snapshotId: string;
  asOfPeriod: string;
  scopeHash: string;
  filters: QueryFilter[];
  dimensionPath: string[];
  expiresAt: string;
  parentContextId: string | null;
  createdBy: string | null;
}

interface Sql {
  [column: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export class Params {
  readonly values: unknown[];
  constructor(first: unknown[]) {
    this.values = first;
  }

  add(value: unknown): number {
    this.values.push(value);
    return this.values.length;
  }
}

function dimensionOf(field: string): { column: string; kind: 'uuid' | 'text' } {
  const dimension = DISBURSEMENT_DIMENSIONS[field];
  if (dimension === undefined) throw new DomainError('DIMENSION_NOT_IN_DATASET', 422, field);
  return dimension;
}

function valueFor(kind: 'uuid' | 'text', value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '' || value.length > 120 || (kind === 'uuid' && !UUID.test(value))) throw invalid(`filters.${field}`);
  return kind === 'uuid' ? value.toLowerCase() : value;
}

function filterSql(filter: QueryFilter, params: Params): string {
  const { column, kind } = dimensionOf(filter.field);
  const cast = kind === 'uuid' ? 'uuid' : 'text';
  if (filter.operator === 'eq') return `l.${column} = $${params.add(valueFor(kind, filter.value, filter.field))}::${cast}`;
  if (filter.operator === 'in') {
    if (!Array.isArray(filter.value) || filter.value.length === 0 || filter.value.length > 100) throw invalid(`filters.${filter.field}`);
    return `l.${column} = any($${params.add(filter.value.map((item) => valueFor(kind, item, filter.field)))}::${cast}[])`;
  }
  // An order only means something for text (a bucket, a level); ids are not ordered.
  if (kind !== 'text') throw invalid(`filters.${filter.field}`);
  return `l.${column} ${filter.operator === 'gte' ? '>=' : '<='} $${params.add(valueFor(kind, filter.value, filter.field))}::text`;
}

/** A predicate of a policy as a condition on the lines. `unit_in_scope` is true: the scope of the reader is applied to every line anyway. */
export function policySql(node: PolicyNode, params: Params, depth = 0): string {
  if (depth > 6) throw new DomainError('PREDICATE_NOT_ALLOWED', 422, 'row_predicate');
  const op = node.op;
  const args = Array.isArray(node.args) ? (node.args as PolicyNode[]) : [];
  switch (op) {
    case 'unit_in_scope':
      return 'true';
    case 'eq':
    case 'ne': {
      const { column, kind } = dimensionOf(String(node.field));
      return `l.${column}${op === 'eq' ? ' = ' : ' is distinct from '}$${params.add(kind === 'uuid' ? valueFor(kind, node.value, String(node.field)) : String(node.value))}::${kind}`;
    }
    case 'in': {
      const { column, kind } = dimensionOf(String(node.field));
      const values = (Array.isArray(node.values) ? node.values : []).map((item) => (kind === 'uuid' ? valueFor(kind, item, String(node.field)) : String(item)));
      return `l.${column} = any($${params.add(values)}::${kind}[])`;
    }
    case 'and':
    case 'or':
      return `(${args.map((child) => policySql(child, params, depth + 1)).join(op === 'and' ? ' and ' : ' or ')})`;
    case 'not':
      return `not (${policySql(args[0] as PolicyNode, params, depth + 1)})`;
    default:
      throw new DomainError('PREDICATE_NOT_ALLOWED', 422, 'row_predicate');
  }
}

/**
 * The queries of BI over a frozen snapshot (ST-BI-004, BI F3): the SQL is written here from the allowlists of the dataset (the columns of a snapshot line, the dimensions it offers), the tenant is filtered by row level
 * security and the scope of the reader on the project of every line, and a policy only ever narrows. The sums are exact (decimal text), the groups are of one dimension, and a line with no value in it is kept as a group of
 * its own so that the children add up to the parent.
 */
export class BiQueryStore {
  /** The version of the dataset a snapshot of BI names (the frozen one, or one a later build replaced, which still serves a drill that was opened on it). */
  async versionOfSnapshot(tx: TenantTx, datasetCode: string, snapshotId: string): Promise<SnapshotVersion | undefined> {
    const rows = await tx.query<Sql>(
      `select v.id as version_id, v.dataset_id, v.source_snapshot_id, v.as_of_period, v.reporting_period_id, v.quality_badge, v.excluded_quarantine_rows::text as excluded, v.status, v.built_at,
              (select nv.id from machvon.bi_dataset_version nv where nv.tenant_id = v.tenant_id and nv.dataset_id = v.dataset_id and nv.as_of_period = v.as_of_period and nv.status = 'FROZEN' and nv.id <> v.id limit 1) as newer
         from machvon.bi_dataset_version v join machvon.bi_dataset d on d.tenant_id = v.tenant_id and d.id = v.dataset_id
        where d.dataset_code = $1 and v.id = $2::uuid and v.status in ('FROZEN', 'SUPERSEDED') limit 1`,
      [datasetCode, snapshotId],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      datasetVersionId: row.version_id,
      datasetId: row.dataset_id,
      sourceSnapshotId: row.source_snapshot_id,
      periodCode: row.as_of_period,
      periodId: row.reporting_period_id,
      qualityBadge: row.quality_badge,
      excludedQuarantineRows: Number(row.excluded),
      versionStatus: row.status,
      builtAt: new Date(row.built_at).toISOString(),
      newerSnapshotId: row.newer,
    };
  }

  /** The frozen version of the dataset for a period now. */
  async latestSnapshotOfPeriod(tx: TenantTx, periodCode: string): Promise<string | undefined> {
    const rows = await tx.query<{ id: string }>(
      "select v.id from machvon.bi_dataset_version v join machvon.bi_dataset d on d.tenant_id = v.tenant_id and d.id = v.dataset_id where d.dataset_code = 'DS-DISB' and v.as_of_period = $1 and v.status = 'FROZEN' limit 1",
      [periodCode],
    );
    return rows[0]?.id;
  }

  /** The sums of the groups of the snapshot, one dimension at a time, in the scope of the reader. */
  async aggregate(tx: TenantTx, input: AggregateInput): Promise<AggregateRow[]> {
    const params = new Params([input.snapshotId]);
    const scope = input.projects(2);
    for (const value of scope.params) params.add(value);
    const conditions = ['l.snapshot_id = $1::uuid', scope.sql, ...input.filters.map((filter) => filterSql(filter, params))];
    if (input.policies.length > 0) conditions.push(`(${input.policies.map((policy) => policySql(policy, params)).join(' or ')})`);
    const { plan } = input;
    // The columns come from the allowlist of the dataset (kernel), never from the request.
    const measures =
      plan.kind === 'DISTINCT'
        ? `null::text as numerator, null::text as denominator, case when count(l.${plan.numeratorColumn}) = 0 then null else count(distinct l.${plan.numeratorColumn})::text end as distinct_count, count(*)::text as line_count`
        : `sum(l.${plan.numeratorColumn})::text as numerator, ${plan.denominatorColumn === null ? 'null::text' : `sum(l.${plan.denominatorColumn})::text`} as denominator, null::text as distinct_count, count(*)::text as line_count`;
    let keyed = 'null::text as key, null::text as label';
    let grouping = '';
    if (input.dimension !== undefined) {
      const { column } = dimensionOf(input.dimension);
      const label = input.dimension === 'unit' ? 'min(lu.name)' : input.dimension === 'project' ? 'min(p.code)' : `l.${column}::text`;
      keyed = `l.${column}::text as key, ${label} as label`;
      grouping = `group by l.${column} order by l.${column}::text nulls last`;
    }
    const rows = await tx.query<Sql>(
      `select ${keyed}, ${measures}
         from machvon.period_snapshot_line l join ${SCOPE_FROM} on p.tenant_id = l.tenant_id and p.id = l.project_id
         left join machvon.organization_unit lu on lu.tenant_id = l.tenant_id and lu.id = l.unit_id
        where ${conditions.join(' and ')} ${grouping} limit ${MAX_ROWS + 1}`,
      params.values,
    );
    return rows.map((row) => ({ key: row.key, label: row.label, numerator: row.numerator, denominator: row.denominator, distinct: row.distinct_count, lines: row.line_count }));
  }

  /** Whether the reader may still read a unit the context names: it is in a unit they hold, or lines of projects they read are of it. */
  async unitStillReadable(tx: TenantTx, snapshotId: string, unitId: string, projects: ScopeBuilder, units: ScopeBuilder): Promise<boolean> {
    const own = units(2);
    const byUnit = await tx.query("select 1 from machvon.organization_unit u where u.id = $1::uuid and " + own.sql, [unitId, ...own.params]);
    if (byUnit.length > 0) return true;
    const scope = projects(3);
    const byProject = await tx.query(`select 1 from machvon.period_snapshot_line l join ${SCOPE_FROM} on p.tenant_id = l.tenant_id and p.id = l.project_id where l.snapshot_id = $1::uuid and l.unit_id = $2::uuid and ${scope.sql} limit 1`, [snapshotId, unitId, ...scope.params]);
    return byProject.length > 0;
  }

  async requesterOf(tx: TenantTx, membershipId: string): Promise<{ roleIds: string[]; unitIds: string[] }> {
    const roles = await tx.query<{ role_id: string }>("select distinct role_id from machvon.role_grant where membership_id = $1::uuid and status = 'Active' and effective_from <= now() and (effective_until is null or now() < effective_until)", [membershipId]);
    const units = await tx.query<{ id: string }>(
      `select a.id from machvon.membership m join machvon.organization_unit u on u.tenant_id = m.tenant_id and u.id = m.organization_id
         join machvon.organization_unit a on a.tenant_id = u.tenant_id and u.path like a.path || '%' where m.id = $1::uuid`,
      [membershipId],
    );
    return { roleIds: roles.map((row) => row.role_id), unitIds: units.map((row) => row.id) };
  }

  // ---- the contexts of a drill -------------------------------------------------------------------------------------------------------------

  async insertContext(
    tx: TenantTx,
    input: { metricVersionId: string; snapshotId: string; asOfPeriod: string; scopeHash: string; filters: readonly QueryFilter[]; dimensionPath: readonly string[]; unit: string; parentContextId: string | null; createdBy: string; ttlSeconds: number },
  ): Promise<string> {
    const id = randomUUID();
    await tx.query(
      `insert into machvon.drill_context (tenant_id, id, subject_scope_hash, metric_version_id, snapshot_id, filters_ast, path, as_of, expires_at, as_of_period, dimension_path, unit, currency, parent_context_id, created_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3::uuid, $4::uuid, $5::jsonb, $6::jsonb, now(), now() + make_interval(secs => $7::int), $8, $6::jsonb, $9, $10, $11::uuid, $12::uuid)`,
      [id, input.scopeHash, input.metricVersionId, input.snapshotId, JSON.stringify(input.filters), JSON.stringify(input.dimensionPath), input.ttlSeconds, input.asOfPeriod, input.unit, input.unit === 'VND' ? 'VND' : null, input.parentContextId, input.createdBy],
    );
    return id;
  }

  async findContext(tx: TenantTx, id: string): Promise<ContextRow | undefined> {
    const rows = await tx.query<Sql>(
      `select id, metric_version_id, snapshot_id, as_of_period, subject_scope_hash, filters_ast, dimension_path, expires_at, parent_context_id, created_by from machvon.drill_context where id = $1::uuid`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      id: row.id,
      metricVersionId: row.metric_version_id,
      snapshotId: row.snapshot_id,
      asOfPeriod: row.as_of_period,
      scopeHash: row.subject_scope_hash,
      filters: row.filters_ast,
      dimensionPath: row.dimension_path ?? [],
      expiresAt: new Date(row.expires_at).toISOString(),
      parentContextId: row.parent_context_id,
      createdBy: row.created_by,
    };
  }

  /** The contexts a person made, the newest first (the read of the contexts is for the person's own). */
  async contextsOf(tx: TenantTx, membershipId: string, limit: number): Promise<ContextRow[]> {
    const rows = await tx.query<{ id: string }>('select id from machvon.drill_context where created_by = $1::uuid order by created_at desc, id desc limit $2', [membershipId, limit]);
    const found: ContextRow[] = [];
    for (const row of rows) {
      const context = await this.findContext(tx, row.id);
      if (context !== undefined) found.push(context);
    }
    return found;
  }

  async recordRun(
    tx: TenantTx,
    run: { requestedBy: string; metricVersionIds: readonly string[]; asOfPeriod: string; datasetVersionId: string; scopeHash: string; drillContextId: string | null; status: 'COMPLETED' | 'DENIED' | 'FAILED'; servedFromCache: boolean; durationMs: number; rowCount: number | null; errorCode: string | null },
  ): Promise<void> {
    await tx.query(
      `insert into machvon.bi_query_run (tenant_id, id, requested_by, metric_version_ids, as_of_period, dataset_version_id, scope_hash, drill_context_id, mode, status, served_from_cache, duration_ms, row_count, cost_units, error_code)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::jsonb, $4, $5::uuid, $6, $7::uuid, 'SYNC', $8, $9, $10::int, $11::int, $12::numeric, $13)`,
      [randomUUID(), run.requestedBy, JSON.stringify(run.metricVersionIds), run.asOfPeriod, run.datasetVersionId, run.scopeHash, run.drillContextId, run.status, run.servedFromCache, run.durationMs, run.rowCount, run.rowCount ?? 0, run.errorCode],
    );
  }

  get maxRows(): number {
    return MAX_ROWS;
  }
}
