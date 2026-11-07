import { DomainError } from '@machvon/kernel';
import type { DatasetAdapter, DatasetSourceKind } from '@machvon/kernel';
import { SCOPE_FROM } from './prj-project-store.ts';

/**
 * Where the lines of a dataset are read from (CA-1): one reader per kind of source, written here as fixed fragments of SQL (the names of tables and columns are constants of this file and of the adapters, never
 * a string a caller sent). The query store takes everything that is specific to a dataset from its source, so a dataset is made queryable by registering its adapter (kernel) and its source (here).
 *
 * Every source offers the same alias contract to the fragments of the store: the lines are `l`, the project of a line and the units its scope is judged by are `p`, `ou` and `iu` (the `SCOPE_FROM` of the
 * project store), and a line is pinned to the frozen snapshot of the source by `l.<snapshotColumn>`.
 */
export interface QuerySource {
  kind: DatasetSourceKind;
  /** The table of the lines, with its schema. */
  linesTable: string;
  /** The column of a line that names the snapshot of the source it belongs to. */
  snapshotColumn: string;
  /** What follows the lines in the `from`: the join to the project (for the scope of the reader) and whatever the labels of the dimensions read. */
  joinsSql: string;
  /** What a group is called on a screen, by dimension; the column of the dimension when it has no name of its own. */
  labelSql: (dimension: string, column: string) => string;
  /** An expression over the version of the dataset `v` that is the number of lines its source snapshot has (what a query over it costs is judged from it). */
  sourceRowsSql: string;
  /** The row count a snapshot of the source says it has, by `$1`; and the lines found for it, by `$1`. For the reproduction of a metric. */
  storedRowsSql: string;
  countedRowsSql: string;
}

/** The lines of a frozen close snapshot of DIS: one line per project, unit, funding source and bucket. */
export const PERIOD_SNAPSHOT_SOURCE: QuerySource = Object.freeze<QuerySource>({
  kind: 'PERIOD_SNAPSHOT',
  linesTable: 'machvon.period_snapshot_line',
  snapshotColumn: 'snapshot_id',
  joinsSql: `join ${SCOPE_FROM} on p.tenant_id = l.tenant_id and p.id = l.project_id
         left join machvon.organization_unit lu on lu.tenant_id = l.tenant_id and lu.id = l.unit_id`,
  labelSql: (dimension, column) => (dimension === 'unit' ? 'min(lu.name)' : dimension === 'project' ? 'min(p.code)' : `l.${column}::text`),
  sourceRowsSql: 'coalesce((select ps.row_count from machvon.period_snapshot ps where ps.tenant_id = v.tenant_id and ps.id = v.source_snapshot_id), 0)',
  storedRowsSql: 'select row_count from machvon.period_snapshot where id = $1::uuid',
  countedRowsSql: 'select count(*)::text as n from machvon.period_snapshot_line where snapshot_id = $1::uuid',
});

/**
 * The lines of the contract fact frozen with a close snapshot of DIS (CA-1, part 2): one line per contract per active party, money already attributed to the party by the largest remainder. The lines are pinned
 * by the snapshot of DIS the contract fact belongs to (`period_snapshot_id`), which is also the source snapshot of the version of the dataset, so a version and its lines can never disagree about which snapshot they are.
 */
export const CONTRACT_FACT_SOURCE: QuerySource = Object.freeze<QuerySource>({
  kind: 'CONTRACT_FACT',
  linesTable: 'machvon.contract_fact_snapshot_line',
  snapshotColumn: 'period_snapshot_id',
  joinsSql: `join ${SCOPE_FROM} on p.tenant_id = l.tenant_id and p.id = l.project_id
         left join machvon.organization_unit lu on lu.tenant_id = l.tenant_id and lu.id = l.unit_id
         left join machvon.contractor lk on lk.tenant_id = l.tenant_id and lk.id = l.contractor_id`,
  labelSql: (dimension, column) => (dimension === 'unit' ? 'min(lu.name)' : dimension === 'project' ? 'min(p.code)' : dimension === 'contractor' ? 'min(lk.legal_name)' : `l.${column}::text`),
  sourceRowsSql: 'coalesce((select s.row_count from machvon.contract_fact_snapshot s where s.tenant_id = v.tenant_id and s.period_snapshot_id = v.source_snapshot_id), 0)',
  storedRowsSql: 'select row_count from machvon.contract_fact_snapshot where period_snapshot_id = $1::uuid',
  countedRowsSql: 'select count(*)::text as n from machvon.contract_fact_snapshot_line where period_snapshot_id = $1::uuid',
});

/**
 * The readers that exist: the lines of a close snapshot of DIS and the lines of the contract fact frozen with one. A dataset whose kind has no reader here is refused with `DATASET_SOURCE_UNAVAILABLE`, and nothing
 * else about the engine has to change when a reader is added.
 */
const SOURCES: Partial<Record<DatasetSourceKind, QuerySource>> = {
  PERIOD_SNAPSHOT: PERIOD_SNAPSHOT_SOURCE,
  CONTRACT_FACT: CONTRACT_FACT_SOURCE,
};

/** Whether the lines of a kind of source can be read in this build. */
export const hasQuerySource = (kind: DatasetSourceKind): boolean => SOURCES[kind] !== undefined;

/** The reader of the source of a dataset, or 422 `DATASET_SOURCE_UNAVAILABLE` when the dataset is registered and its source is not yet there. */
export function querySourceOf(adapter: DatasetAdapter): QuerySource {
  const source = SOURCES[adapter.sourceKind];
  if (source === undefined) throw new DomainError('DATASET_SOURCE_UNAVAILABLE', 422, 'snapshot_id', { extensions: { dataset_code: adapter.code, source_kind: adapter.sourceKind } });
  return source;
}
