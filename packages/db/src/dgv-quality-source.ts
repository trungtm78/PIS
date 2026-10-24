import { DomainError, validateQualityExpression } from '@machvon/kernel';
import type { FieldType, QualityDimension, QualityExpr, QualitySourceShape } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

const SAMPLE_LIMIT = 50;
const SQL_TYPE: Readonly<Record<FieldType, string>> = { uuid: 'uuid', text: 'text', numeric: 'numeric' };
const COMPARATOR_SQL = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' } as const;

/** The state of a snapshot as its owner module records it: what a run needs to know to trust it. */
export interface SnapshotState {
  id: string;
  status: string;
  payloadSha256: string | null;
  rowCount: number;
  /** When the snapshot says its figures are as of. */
  asOf: string;
  /** Whether the definitions that the figures stand on are signed (D03); null when the source has no such notion. */
  definitionStatus: string | null;
}

/**
 * Where the rows of a dataset come from. A rule is written over the fields of one source relation and compiled to a query over exactly
 * that relation and exactly one snapshot of it, so a rule can neither read another table nor another snapshot. R1 has one source: the
 * lines of a frozen DIS period snapshot; the sources of the other producers are added with their snapshots.
 */
export interface QualitySource {
  code: string;
  producerModule: string;
  shape: QualitySourceShape;
  /** The relation whose rows are measured (schema-qualified); it has `tenant_id`, a column naming the snapshot, and the fields of `shape`. */
  relation: string;
  snapshotColumn: string;
  /** The relation of the snapshots, with `id`, `as_of_at` and the status and digest columns. */
  snapshotRelation: string;
  /** For each field that may be checked as a reference: the table (schema-qualified, keyed by `tenant_id` and `id`) it must exist in. */
  referenceTables: Readonly<Record<string, string>>;
  /** Snapshot statuses whose rows are final. */
  finalStatuses: readonly string[];
}

export const DIS_PERIOD_SNAPSHOT_SOURCE: QualitySource = {
  code: 'DIS_PERIOD_SNAPSHOT',
  producerModule: 'DIS',
  shape: {
    fields: {
      project_id: 'uuid',
      unit_id: 'uuid',
      fund_source_version_id: 'uuid',
      report_revision_id: 'uuid',
      plan_version_id: 'uuid',
      bucket: 'text',
      budget_level: 'text',
      treasury_coverage: 'text',
      rate_null_reason: 'text',
      plan_pm_assigned_vnd: 'numeric',
      plan_local_added_vnd: 'numeric',
      plan_total_vnd: 'numeric',
      disbursed_treasury_vnd: 'numeric',
      disbursed_reported_vnd: 'numeric',
      period_delta_vnd: 'numeric',
      registered_month_vnd: 'numeric',
      forecast_eac_vnd: 'numeric',
      ctmtqg_subset_vnd: 'numeric',
      rate_pm_pct: 'numeric',
      rate_total_pct: 'numeric',
    },
    references: new Set(['project_id', 'unit_id', 'fund_source_version_id', 'report_revision_id', 'plan_version_id']),
  },
  relation: 'machvon.period_snapshot_line',
  snapshotColumn: 'snapshot_id',
  snapshotRelation: 'machvon.period_snapshot',
  referenceTables: {
    project_id: 'machvon.project',
    unit_id: 'machvon.organization_unit',
    fund_source_version_id: 'machvon.master_record_version',
    report_revision_id: 'machvon.report_revision',
    plan_version_id: 'machvon.plan_version',
  },
  finalStatuses: ['FROZEN', 'SUPERSEDED'],
};

const SOURCES: readonly QualitySource[] = [DIS_PERIOD_SNAPSHOT_SOURCE];

/** The source of the datasets a module produces, or undefined while that module has no snapshot to measure. */
export function qualitySourceOf(producerModule: string): QualitySource | undefined {
  return SOURCES.find((source) => source.producerModule === producerModule);
}

interface SnapshotRow {
  id: string;
  status: string;
  payload_sha256: string | null;
  row_count: number;
  as_of: string;
  definition_status: string | null;
}

/** The snapshot with this id, or undefined when the tenant has none. */
export async function loadSnapshot(tx: TenantTx, source: QualitySource, snapshotId: string): Promise<SnapshotState | undefined> {
  const rows = await tx.query<SnapshotRow>(
    `select s.id, s.status, s.payload_sha256, s.row_count, to_char(s.as_of_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as as_of, s.definition_status
       from ${source.snapshotRelation} s where s.id = $1::uuid`,
    [snapshotId],
  );
  const row = rows[0];
  return row === undefined
    ? undefined
    : { id: row.id, status: row.status, payloadSha256: row.payload_sha256, rowCount: row.row_count, asOf: row.as_of, definitionStatus: row.definition_status };
}

/** How many rows the snapshot actually has in the measured relation: a snapshot whose rows are not all there is not measured. */
export async function countSnapshotRows(tx: TenantTx, source: QualitySource, snapshotId: string): Promise<number> {
  const rows = await tx.query<{ total: string }>(`select count(*)::text as total from ${source.relation} l where l.${source.snapshotColumn} = $1::uuid`, [snapshotId]);
  return Number(rows[0]?.total ?? 0);
}

class Compiler {
  readonly params: unknown[];
  private readonly source: QualitySource;

  constructor(source: QualitySource, snapshotId: string) {
    this.source = source;
    this.params = [snapshotId];
  }

  private param(value: unknown, type: FieldType): string {
    this.params.push(value);
    return `$${this.params.length}::${SQL_TYPE[type]}`;
  }

  private column(field: string): string {
    // The name has been checked against the fields of the source by the validator; the lookup is the second check.
    if (!Object.hasOwn(this.source.shape.fields, field)) throw new DomainError('EXPRESSION_NOT_ALLOWED', 422, 'expression_ast');
    return `l.${field}`;
  }

  private typeOf(field: string): FieldType {
    return this.source.shape.fields[field] as FieldType;
  }

  /** The predicate that is true for a row that passes: two-valued, a comparison with an absent value is false, never unknown. */
  predicate(node: QualityExpr): string {
    switch (node.op) {
      case 'not_null':
        return `(${this.column(node.field)} is not null)`;
      case 'not_blank':
        return `(${this.column(node.field)} is not null and btrim(${this.column(node.field)}) <> '')`;
      case 'is_null':
        return `(${this.column(node.field)} is null)`;
      case 'compare':
        return `coalesce(${this.column(node.field)} ${COMPARATOR_SQL[node.cmp]} ${this.param(node.value, this.typeOf(node.field))}, false)`;
      case 'compare_fields':
        return `coalesce(${this.column(node.left)} ${COMPARATOR_SQL[node.cmp]} ${this.column(node.right)}, false)`;
      case 'between':
        return `coalesce(${this.column(node.field)} between ${this.param(node.min, 'numeric')} and ${this.param(node.max, 'numeric')}, false)`;
      case 'in': {
        const type = this.typeOf(node.field);
        this.params.push(node.values);
        return `coalesce(${this.column(node.field)} = any($${this.params.length}::${SQL_TYPE[type]}[]), false)`;
      }
      case 'reference_exists': {
        const table = this.source.referenceTables[node.field];
        if (table === undefined) throw new DomainError('EXPRESSION_NOT_ALLOWED', 422, 'expression_ast');
        return `(${this.column(node.field)} is null or exists (select 1 from ${table} r where r.tenant_id = l.tenant_id and r.id = ${this.column(node.field)}))`;
      }
      case 'and':
        return `(${node.args.map((arg) => this.predicate(arg)).join(' and ')})`;
      case 'or':
        return `(${node.args.map((arg) => this.predicate(arg)).join(' or ')})`;
      case 'not':
        return `(not ${this.predicate(node.arg)})`;
      case 'unique':
      case 'snapshot_age_within':
        throw new DomainError('EXPRESSION_NOT_ALLOWED', 422, 'expression_ast');
    }
  }

  uniqueKey(fields: readonly string[]): { partition: string; hasNull: string } {
    const columns = fields.map((field) => this.column(field));
    return { partition: columns.join(', '), hasNull: columns.map((column) => `${column} is null`).join(' or ') };
  }
}

export interface Evaluation {
  evaluated: number;
  passed: number;
  failed: number;
  /** The ids of up to 50 rows that failed (opaque keys of the source relation; no value of the row). */
  sampleIds: string[];
}

interface CountRow {
  evaluated: string;
  passed: string;
}

const evaluationOf = (counts: CountRow | undefined, sampleIds: string[]): Evaluation => {
  const evaluated = Number(counts?.evaluated ?? 0);
  const passed = Number(counts?.passed ?? 0);
  return { evaluated, passed, failed: evaluated - passed, sampleIds };
};

/**
 * Measures one rule over the rows of one snapshot. The expression is validated again against the source before it is compiled (a stored
 * rule is data, and data can be altered); the query reads the relation of the source and the one snapshot, with the values as parameters.
 */
export async function evaluateExpression(tx: TenantTx, source: QualitySource, dimension: QualityDimension, stored: unknown, snapshotId: string): Promise<Evaluation> {
  const { ast } = validateQualityExpression(dimension, stored, source.shape);
  const compiler = new Compiler(source, snapshotId);
  const scope = `from ${source.relation} l where l.${source.snapshotColumn} = $1::uuid`;
  if (ast.op === 'snapshot_age_within') {
    const rows = await tx.query<CountRow>(
      `select count(*)::text as evaluated, (count(*) filter (where now() - s.as_of_at <= $2::integer * interval '1 second'))::text as passed from ${source.snapshotRelation} s where s.id = $1::uuid`,
      [snapshotId, ast.seconds],
    );
    return evaluationOf(rows[0], []);
  }
  if (ast.op === 'unique') {
    const key = compiler.uniqueKey(ast.fields);
    const inner = `select l.id, count(*) over (partition by ${key.partition}) as group_size, (${key.hasNull}) as has_null ${scope}`;
    const rows = await tx.query<CountRow>(`select count(*)::text as evaluated, (count(*) filter (where k.group_size = 1 or k.has_null))::text as passed from (${inner}) k`, compiler.params);
    const evaluation = evaluationOf(rows[0], []);
    if (evaluation.failed > 0) {
      const samples = await tx.query<{ id: string }>(`select k.id::text as id from (${inner}) k where k.group_size > 1 and not k.has_null order by k.id limit ${SAMPLE_LIMIT}`, compiler.params);
      evaluation.sampleIds = samples.map((row) => row.id);
    }
    return evaluation;
  }
  const predicate = compiler.predicate(ast);
  const rows = await tx.query<CountRow>(`select count(*)::text as evaluated, (count(*) filter (where ${predicate}))::text as passed ${scope}`, compiler.params);
  const evaluation = evaluationOf(rows[0], []);
  if (evaluation.failed > 0) {
    const samples = await tx.query<{ id: string }>(`select l.id::text as id ${scope} and not ${predicate} order by l.id limit ${SAMPLE_LIMIT}`, compiler.params);
    evaluation.sampleIds = samples.map((row) => row.id);
  }
  return evaluation;
}
