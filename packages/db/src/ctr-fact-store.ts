import { createHash } from 'node:crypto';
import { DomainError, REPORT_SUMS, SUM_KEYS, hasControlChar, spreadByWeight } from '@machvon/kernel';
import type { ConcentrationInput, ContractFact, CtrReportCode, SumKey, Sums } from '@machvon/kernel';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The reader of the contract fact and the keeper of its frozen snapshots (CA-1, part 2; eng-review R12, R16, R17). One query serves the portfolio, the reports and the exports, over a live source (the view
 * `contract_fact`) or a frozen one (the rows of a `contract_fact_snapshot`, read back as the type of the view): the filters, the scope, the sort and the sums are the same fragments whichever it is. The names of tables,
 * columns and sorts are constants of this file (allowlists); everything a caller sends is a parameter.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export interface FactFilters {
  unit?: string[] | undefined;
  project?: string[] | undefined;
  contractor?: string[] | undefined;
  status?: string[] | undefined;
  type?: string[] | undefined;
  fund?: string[] | undefined;
  /** A piece of the code, the title, the project or the contractor name (case does not matter). */
  text?: string | undefined;
}

export interface FactSource {
  /** The day the time-dependent columns are judged on (a live reading), or the as-of day of the frozen snapshot. */
  asOf: string;
  /** A frozen snapshot of the fact to read instead of the live view. */
  snapshotId?: string | undefined;
}

export interface FactQuery extends FactSource {
  /** The scope of the reader over contracts (`contract.read`) and the scope of the ledger (`ledger.read`). */
  scope: ScopeBuilder;
  ledgerScope: ScopeBuilder;
  filters: FactFilters;
}

export type SortKind = 'text' | 'numeric' | 'date' | 'int';

/** The columns a list may be sorted by; the sort key is `coalesce(expression, sentinel)`, so that a missing figure sorts first and the keyset of the cursor never meets a null. */
export const FACT_SORTS: Readonly<Record<string, { sql: string; kind: SortKind; notNull?: true }>> = {
  code: { sql: 'c.code', kind: 'text', notNull: true },
  title: { sql: 'c.title', kind: 'text' },
  project_code: { sql: 'p.code', kind: 'text', notNull: true },
  contractor_name: { sql: 'k.legal_name', kind: 'text' },
  unit_name: { sql: 'ou.name', kind: 'text', notNull: true },
  contract_status: { sql: 'c.contract_status', kind: 'text', notNull: true },
  contract_value_vnd: { sql: 'c.contract_value_vnd', kind: 'numeric', notNull: true },
  original_value_vnd: { sql: 'c.original_value_vnd', kind: 'numeric' },
  approved_change_delta_vnd: { sql: 'c.approved_change_delta_vnd', kind: 'numeric' },
  accepted_vnd: { sql: 'c.accepted_vnd', kind: 'numeric', notNull: true },
  paid_vnd: { sql: 'c.paid_vnd', kind: 'numeric', notNull: true },
  winning_bid_vnd: { sql: 'c.winning_bid_vnd', kind: 'numeric' },
  advance_outstanding_vnd: { sql: 'c.advance_outstanding_vnd', kind: 'numeric' },
  retention_held_vnd: { sql: 'c.retention_held_vnd', kind: 'numeric' },
  days_late: { sql: 'c.days_late', kind: 'int' },
  original_due_date: { sql: 'c.original_due_date', kind: 'date' },
  max_change_tier: { sql: 'c.max_change_tier', kind: 'int' },
};

const SENTINEL: Readonly<Record<SortKind, string>> = { text: "''", numeric: "'-1e30'::numeric", date: "'0001-01-01'::date", int: '-1' };
const CAST: Readonly<Record<SortKind, string>> = { text: 'text', numeric: 'numeric', date: 'date', int: 'integer' };

export interface FactCursor {
  sort: string;
  direction: 'asc' | 'desc';
  value: string;
  id: string;
}

export interface FactPage {
  sort: string;
  direction: 'asc' | 'desc';
  limit: number;
  after?: FactCursor | undefined;
}

type FieldKind = 'text' | 'text-cast' | 'bool' | 'int';
/** [key of the fact, SQL, how it comes out]: the select list and the mapper are made from this one table. */
const FIELDS: ReadonlyArray<readonly [keyof ContractFact, string, FieldKind]> = [
  ['id', 'c.id', 'text-cast'],
  ['code', 'c.code', 'text'],
  ['title', 'c.title', 'text'],
  ['contractStatus', 'c.contract_status', 'text'],
  ['contractType', 'c.contract_type', 'text'],
  ['projectId', 'c.project_id', 'text-cast'],
  ['projectCode', 'p.code', 'text'],
  ['projectName', 'p.name', 'text'],
  ['packageId', 'c.package_id', 'text-cast'],
  ['contractorId', 'c.contractor_id', 'text-cast'],
  ['contractorName', 'k.legal_name', 'text'],
  ['isJointVenture', 'c.is_joint_venture', 'bool'],
  ['unitId', 'c.unit_id', 'text-cast'],
  ['unitName', 'ou.name', 'text'],
  ['investorId', 'c.investor_id', 'text-cast'],
  ['fundSourceVersionId', 'c.fund_source_version_id', 'text-cast'],
  ['signedOn', 'c.signed_on', 'text-cast'],
  ['originalDueDate', 'c.original_due_date', 'text-cast'],
  ['completedOn', 'c.completed_on', 'text-cast'],
  ['terminatedOn', 'c.terminated_on', 'text-cast'],
  ['approvedExtensionDays', 'c.approved_extension_days', 'int'],
  ['milestoneCount', 'c.milestone_count', 'int'],
  ['milestonePastDueCount', 'c.milestone_past_due_count', 'int'],
  ['contractValueVnd', 'c.contract_value_vnd', 'text-cast'],
  ['originalValueVnd', 'c.original_value_vnd', 'text-cast'],
  ['approvedChangeDeltaVnd', 'c.approved_change_delta_vnd', 'text-cast'],
  ['approvedChangeCount', 'c.approved_change_count', 'int'],
  ['maxChangeTier', 'c.max_change_tier', 'int'],
  ['maxCumulativeVariationPct', 'c.max_cumulative_variation_pct', 'text-cast'],
  ['winningBidVnd', 'c.winning_bid_vnd', 'text-cast'],
  ['bidderCount', 'c.bidder_count', 'int'],
  ['requestedVnd', 'c.requested_vnd', 'text-cast'],
  ['acceptedVnd', 'c.accepted_vnd', 'text-cast'],
  ['paidVnd', 'c.paid_vnd', 'text-cast'],
  ['advancePaidVnd', 'c.advance_paid_vnd', 'text-cast'],
  ['advanceRecoveredVnd', 'c.advance_recovered_vnd', 'text-cast'],
  ['retentionWithheldVnd', 'c.retention_withheld_vnd', 'text-cast'],
  ['retentionReleasedVnd', 'c.retention_released_vnd', 'text-cast'],
  ['guaranteeRequiredVnd', 'c.guarantee_required_vnd', 'text-cast'],
  ['guaranteeValidVnd', 'c.guarantee_valid_vnd', 'text-cast'],
  ['guaranteeNextExpiryOn', 'c.guarantee_next_expiry_on', 'text-cast'],
  ['measuredVnd', 'c.measured_vnd', 'text-cast'],
  ['firstAdvanceOn', 'c.first_advance_on', 'text-cast'],
  ['lastAcceptanceOn', 'c.last_acceptance_on', 'text-cast'],
  ['acceptanceToRequestDaysMax', 'c.acceptance_to_request_days_max', 'int'],
  ['requestToTreasuryDaysMax', 'c.request_to_treasury_days_max', 'int'],
  ['paymentsSentCount', 'c.payments_sent_count', 'int'],
  ['openNcrCount', 'c.open_ncr_count', 'int'],
  ['projectOpenIssueCount', 'c.project_open_issue_count', 'int'],
  ['auditFindingCount', 'c.audit_finding_count', 'int'],
  ['daysLate', 'c.days_late', 'int'],
  ['asOfDate', 'c.as_of_date', 'text-cast'],
];

const alias = (key: string): string => `f_${key}`;
const SELECT_LIST = FIELDS.map(([key, sql, kind]) => `${sql}${kind === 'text-cast' ? '::text' : ''} as "${alias(key)}"`).join(',\n         ');

type Row = Record<string, unknown>;

function toFact(row: Row, ledgerOk: boolean): ContractFact {
  const fact: Record<string, unknown> = { ledgerOk };
  for (const [key, , kind] of FIELDS) {
    const value = row[alias(key)];
    fact[key] = value === undefined || value === null ? null : kind === 'int' ? Number(value) : value;
  }
  // The columns that are never null in the view: a missing one is the database's mistake, not a figure of zero.
  fact.isJointVenture = row[alias('isJointVenture')] === true;
  for (const key of ['approvedExtensionDays', 'milestoneCount', 'milestonePastDueCount', 'approvedChangeCount', 'paymentsSentCount', 'openNcrCount', 'projectOpenIssueCount', 'auditFindingCount']) fact[key] = Number(fact[key] ?? 0);
  return fact as unknown as ContractFact;
}

const LIVE_SOURCE = 'machvon.contract_fact';
const joinsOf = (source: string): string => `${source} c
         join machvon.project p on p.tenant_id = c.tenant_id and p.id = c.project_id
         join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
         left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id
         left join machvon.contractor k on k.tenant_id = c.tenant_id and k.id = c.contractor_id`;

const uuidList = (values: string[] | undefined, field: string): string[] | undefined => {
  if (values === undefined) return undefined;
  if (values.length === 0 || values.length > 200 || values.some((value) => !UUID.test(value))) throw invalid(field);
  return values.map((value) => value.toLowerCase());
};

const wordList = (values: string[] | undefined, field: string, allowed: readonly string[]): string[] | undefined => {
  if (values === undefined) return undefined;
  if (values.length === 0 || values.some((value) => !allowed.includes(value))) throw invalid(field);
  return values;
};

export const CONTRACT_STATUS_VALUES = ['DRAFT', 'IN_REVIEW', 'SIGNED', 'ACTIVE', 'SUSPENDED', 'TERMINATED', 'COMPLETED', 'CLOSED', 'CANCELLED'] as const;
export const CONTRACT_TYPE_VALUES = ['LUMP_SUM', 'UNIT_PRICE', 'ADJUSTABLE_PRICE', 'TIME_BASED', 'COST_PLUS_FEE', 'EPC', 'ESTIMATE_BASED'] as const;
const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (char) => `\\${char}`);

interface Assembled {
  from: string;
  where: string[];
  params: unknown[];
  ledger: string;
  /** Sets the day the view judges time-dependent columns on, for the transaction. */
  asOf: string;
}

/** The FROM and WHERE of a query over the fact: the source, the scope of the reader, the filters; and the predicate of the ledger. Parameters are numbered in the order they are added. */
function assemble(query: FactQuery, withLedger = true): Assembled {
  const params: unknown[] = [];
  const next = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  let source = LIVE_SOURCE;
  if (query.snapshotId !== undefined) {
    if (!UUID.test(query.snapshotId)) throw invalid('snapshot_id');
    source = `(select r.* from machvon.contract_fact_snapshot_contract s cross join lateral jsonb_populate_record(null::machvon.contract_fact, s.fact) r where s.snapshot_id = ${next(query.snapshotId.toLowerCase())}::uuid)`;
  }
  const where: string[] = [];
  const scope = query.scope(params.length + 1);
  params.push(...scope.params);
  where.push(scope.sql);
  // The ledger predicate's parameters are added only for a query that reads the predicate: a parameter no statement refers to is an error of the database.
  const ledger = withLedger ? query.ledgerScope(params.length + 1) : { sql: 'false', params: [] as unknown[] };
  params.push(...ledger.params);
  const filters = query.filters;
  const units = uuidList(filters.unit, 'unit');
  if (units !== undefined) where.push(`exists (select 1 from machvon.organization_unit su where su.tenant_id = ou.tenant_id and su.id = any(${next(units)}::uuid[]) and starts_with(ou.path, su.path))`);
  const projects = uuidList(filters.project, 'project');
  if (projects !== undefined) where.push(`c.project_id = any(${next(projects)}::uuid[])`);
  const contractors = uuidList(filters.contractor, 'contractor');
  if (contractors !== undefined) {
    const list = next(contractors);
    where.push(`(c.contractor_id = any(${list}::uuid[]) or exists (select 1 from machvon.contract_party cp where cp.tenant_id = c.tenant_id and cp.contract_id = c.id and cp.status = 'ACTIVE' and cp.contractor_id = any(${list}::uuid[])))`);
  }
  const statuses = wordList(filters.status, 'status', CONTRACT_STATUS_VALUES);
  if (statuses !== undefined) where.push(`c.contract_status = any(${next(statuses)}::text[])`);
  const types = wordList(filters.type, 'type', CONTRACT_TYPE_VALUES);
  if (types !== undefined) where.push(`c.contract_type = any(${next(types)}::text[])`);
  const funds = uuidList(filters.fund, 'fund');
  if (funds !== undefined) where.push(`c.fund_source_version_id = any(${next(funds)}::uuid[])`);
  if (filters.text !== undefined) {
    const needle = filters.text.trim();
    if (needle.length < 1 || needle.length > 100 || hasControlChar(needle)) throw invalid('text');
    const like = next(`%${escapeLike(needle.toLowerCase())}%`);
    where.push(`(lower(c.code) like ${like} or lower(coalesce(c.title, '')) like ${like} or lower(p.code) like ${like} or lower(p.name) like ${like} or lower(coalesce(k.legal_name, '')) like ${like})`);
  }
  return { from: joinsOf(source), where, params, ledger: ledger.sql, asOf: query.asOf };
}

async function pinDay(tx: TenantTx, asOf: string): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw invalid('as_of');
  await tx.query("select set_config('app.contract_fact_as_of', $1, true)", [asOf]);
}

/** The group a contract falls in for a breakdown (what the totals of the groups are cut by); the keys are those of `BREAKDOWN_KEYS`. */
const BREAKDOWN_SQL: Readonly<Record<string, string>> = {
  bidder_band: "case when c.bidder_count is null then 'UNKNOWN' when c.bidder_count = 1 then 'ONE' when c.bidder_count <= 3 then 'TWO_THREE' else 'FOUR_PLUS' end",
  contract_status: 'c.contract_status',
  delay_band: "case when c.days_late is null then 'NOT_APPLICABLE' when c.days_late = 0 then 'NOT_LATE' when c.days_late <= 30 then 'LATE_1_30' when c.days_late <= 90 then 'LATE_31_90' else 'LATE_OVER_90' end",
  age_bucket:
    "case when c.advance_paid_vnd > 0 and c.first_advance_on is not null then (case when c.as_of_date - c.first_advance_on <= 90 then 'UP_TO_90' when c.as_of_date - c.first_advance_on <= 180 then 'D91_180' when c.as_of_date - c.first_advance_on <= 365 then 'D181_365' else 'OVER_365' end) else null end",
  change_tier: "case when c.max_change_tier is null then 'NONE' else 'TIER_' || c.max_change_tier end",
};

/** How each sum is made. `l` is the predicate of the ledger (the contracts the reader may see the ledger of); a sum with no contract is NULL for a maximum and 0 for a sum. */
const SUM_SQL: Readonly<Record<SumKey, (l: string) => string>> = {
  contract_value: () => 'coalesce(sum(c.contract_value_vnd), 0)',
  original_value: () => 'coalesce(sum(c.original_value_vnd), 0)',
  change_delta: () => 'coalesce(sum(c.approved_change_delta_vnd), 0)',
  change_count: () => 'coalesce(sum(c.approved_change_count), 0)',
  requested: (l) => `coalesce(sum(c.requested_vnd) filter (where ${l}), 0)`,
  accepted: (l) => `coalesce(sum(c.accepted_vnd) filter (where ${l}), 0)`,
  paid: (l) => `coalesce(sum(c.paid_vnd) filter (where ${l}), 0)`,
  measured: (l) => `coalesce(sum(c.measured_vnd) filter (where ${l}), 0)`,
  advance_paid: (l) => `coalesce(sum(c.advance_paid_vnd) filter (where ${l} and c.advance_paid_vnd > 0), 0)`,
  advance_recovered: (l) => `coalesce(sum(c.advance_recovered_vnd) filter (where ${l} and c.advance_paid_vnd > 0), 0)`,
  advance_rows: (l) => `count(*) filter (where ${l} and c.advance_paid_vnd > 0)`,
  retention_withheld: (l) => `coalesce(sum(c.retention_withheld_vnd) filter (where ${l} and c.retention_withheld_vnd > 0), 0)`,
  retention_released: (l) => `coalesce(sum(c.retention_released_vnd) filter (where ${l} and c.retention_withheld_vnd > 0), 0)`,
  retention_rows: (l) => `count(*) filter (where ${l} and c.retention_withheld_vnd > 0)`,
  bid_contract: () => 'coalesce(sum(c.original_value_vnd) filter (where c.winning_bid_vnd is not null), 0)',
  bid_price: () => 'coalesce(sum(c.winning_bid_vnd), 0)',
  bid_rows: () => 'count(*) filter (where c.winning_bid_vnd is not null)',
  guarantee_required: () => 'coalesce(sum(c.guarantee_required_vnd) filter (where c.guarantee_required_vnd > 0), 0)',
  guarantee_valid: () => 'coalesce(sum(coalesce(c.guarantee_valid_vnd, 0)) filter (where c.guarantee_required_vnd > 0), 0)',
  guarantee_rows: () => 'count(*) filter (where c.guarantee_required_vnd > 0)',
  single_bidder: () => 'count(*) filter (where c.bidder_count = 1)',
  bidder_known: () => 'count(*) filter (where c.bidder_count is not null)',
  extension_days: () => 'coalesce(sum(c.approved_extension_days), 0)',
  milestones: () => 'coalesce(sum(c.milestone_count), 0)',
  milestones_past_due: () => 'coalesce(sum(c.milestone_past_due_count), 0)',
  max_days_late: () => 'max(c.days_late)',
  max_age_days: (l) => `max(c.as_of_date - c.first_advance_on) filter (where ${l} and c.advance_paid_vnd > 0 and c.first_advance_on is not null)`,
  max_acceptance_to_request: () => 'max(c.acceptance_to_request_days_max)',
  max_request_to_treasury: () => 'max(c.request_to_treasury_days_max)',
  max_tier: () => 'max(c.max_change_tier)',
  max_cumulative_variation: () => 'max(c.max_cumulative_variation_pct)',
};

export interface FactSnapshotRow {
  id: string;
  periodSnapshotId: string;
  periodId: string;
  periodCode: string;
  revision: number;
  latestRevision: number;
  /** An older revision of a period that has a newer one: what it says is no longer the newest. */
  stale: boolean;
  supersedesId: string | null;
  cutoffDate: string;
  asOfDate: string;
  contractCount: number;
  rowCount: number;
  payloadSha256: string;
  builtAt: string;
}

interface SnapshotSql {
  id: string;
  period_snapshot_id: string;
  period_id: string;
  period_code: string;
  revision: number;
  latest_revision: number;
  supersedes_id: string | null;
  cutoff_date: string;
  as_of_date: string;
  contract_count: number;
  row_count: number;
  payload_sha256: string;
  built_at: string | Date;
}

const SNAPSHOT_SELECT = `select s.id, s.period_snapshot_id, s.period_id, p.code as period_code, s.revision, s.supersedes_id, s.cutoff_date::text as cutoff_date, s.as_of_date::text as as_of_date,
  s.contract_count, s.row_count, s.payload_sha256, s.built_at,
  (select max(x.revision) from machvon.contract_fact_snapshot x where x.tenant_id = s.tenant_id and x.period_id = s.period_id) as latest_revision
  from machvon.contract_fact_snapshot s join machvon.reporting_period p on p.tenant_id = s.tenant_id and p.id = s.period_id`;

const toSnapshot = (row: SnapshotSql): FactSnapshotRow => ({
  id: row.id,
  periodSnapshotId: row.period_snapshot_id,
  periodId: row.period_id,
  periodCode: row.period_code,
  revision: Number(row.revision),
  latestRevision: Number(row.latest_revision),
  stale: Number(row.revision) < Number(row.latest_revision),
  supersedesId: row.supersedes_id,
  cutoffDate: row.cutoff_date,
  asOfDate: row.as_of_date,
  contractCount: Number(row.contract_count),
  rowCount: Number(row.row_count),
  payloadSha256: row.payload_sha256.trim(),
  builtAt: new Date(row.built_at).toISOString(),
});

const BATCH = 1000;

export interface FactGroupSums {
  key: string;
  sums: Sums;
}

/** The pieces of one contract that the builder of a snapshot reads (money as text), one line per active party made from them. */
interface BuildRow {
  fact_text: string;
  id: string;
  contractor_id: string;
  project_id: string;
  unit_id: string;
  investor_id: string | null;
  fund_source_version_id: string | null;
  contract_status: string;
  contract_type: string;
  contract_value_vnd: string;
  original_value_vnd: string;
  approved_change_delta_vnd: string;
  winning_bid_vnd: string | null;
  requested_vnd: string;
  accepted_vnd: string;
  paid_vnd: string;
  advance_paid_vnd: string;
  advance_recovered_vnd: string;
  advance_outstanding_vnd: string;
  retention_withheld_vnd: string;
  retention_released_vnd: string;
  retention_held_vnd: string;
  guarantee_required_vnd: string | null;
  guarantee_valid_vnd: string | null;
  bidder_count: number | null;
  days_late: number | null;
}

interface PartySql {
  contract_id: string;
  contractor_id: string;
  share_pct: string;
  role: string;
}

export interface SnapshotLine {
  contractId: string;
  contractorId: string;
  isLead: boolean;
  sharePct: string;
  values: Record<string, string | number | null>;
}

const MONEY_FIELDS = ['contract_value_vnd', 'active_value_vnd', 'original_value_vnd', 'approved_change_delta_vnd', 'winning_bid_vnd', 'bid_variance_vnd', 'requested_vnd', 'accepted_vnd', 'paid_vnd', 'advance_paid_vnd', 'advance_recovered_vnd', 'advance_outstanding_vnd', 'retention_withheld_vnd', 'retention_released_vnd', 'retention_held_vnd', 'guarantee_required_vnd', 'guarantee_valid_vnd'] as const;

/**
 * The lines of DS-CTR of one contract: one per ACTIVE party (the contractor of the contract when it has no party), the money of the contract spread over them by `share_pct` with the largest remainder (whole dong,
 * the lines add up to the contract exactly), the flags and the days late on the lead line only. Pure: the same row and parties give the same lines.
 */
export function linesOfContract(row: BuildRow, parties: ReadonlyArray<{ contractorId: string; sharePct: string; role: string }>): SnapshotLine[] {
  const big = (value: string | null): bigint | null => (value === null ? null : BigInt(value));
  const bidVariance = row.winning_bid_vnd === null ? null : (BigInt(row.original_value_vnd) - BigInt(row.winning_bid_vnd)).toString();
  const money: Record<(typeof MONEY_FIELDS)[number], string | null> = {
    contract_value_vnd: row.contract_value_vnd,
    active_value_vnd: row.contract_status === 'ACTIVE' ? row.contract_value_vnd : '0',
    original_value_vnd: row.original_value_vnd,
    approved_change_delta_vnd: row.approved_change_delta_vnd,
    winning_bid_vnd: row.winning_bid_vnd,
    bid_variance_vnd: bidVariance,
    requested_vnd: row.requested_vnd,
    accepted_vnd: row.accepted_vnd,
    paid_vnd: row.paid_vnd,
    // An advance or retention the contract never had is no figure, not a zero.
    advance_paid_vnd: BigInt(row.advance_paid_vnd) > 0n ? row.advance_paid_vnd : null,
    advance_recovered_vnd: BigInt(row.advance_paid_vnd) > 0n ? row.advance_recovered_vnd : null,
    advance_outstanding_vnd: BigInt(row.advance_paid_vnd) > 0n ? row.advance_outstanding_vnd : null,
    retention_withheld_vnd: BigInt(row.retention_withheld_vnd) > 0n ? row.retention_withheld_vnd : null,
    retention_released_vnd: BigInt(row.retention_withheld_vnd) > 0n ? row.retention_released_vnd : null,
    retention_held_vnd: BigInt(row.retention_withheld_vnd) > 0n ? row.retention_held_vnd : null,
    guarantee_required_vnd: row.guarantee_required_vnd !== null && BigInt(row.guarantee_required_vnd) > 0n ? row.guarantee_required_vnd : null,
    guarantee_valid_vnd: row.guarantee_required_vnd !== null && BigInt(row.guarantee_required_vnd) > 0n ? (row.guarantee_valid_vnd ?? '0') : null,
  };
  const active = parties.length === 0 ? [{ contractorId: row.contractor_id, sharePct: '100.0000', role: 'SOLE' }] : [...parties];
  // The same contractor named twice is one party (its shares add up), as the concentration reads it.
  const weights = new Map<string, bigint>();
  for (const party of active) {
    const [whole = '0', fraction = ''] = party.sharePct.split('.');
    weights.set(party.contractorId, (weights.get(party.contractorId) ?? 0n) + BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, '0').slice(0, 4)));
  }
  const keys = [...weights.keys()];
  const lead = active.find((party) => party.role === 'LEAD' || party.role === 'SOLE')?.contractorId ?? [...keys].sort()[0] ?? row.contractor_id;
  const list = keys.map((key) => ({ key, weight: weights.get(key) as bigint }));
  const total = list.reduce((acc, item) => acc + item.weight, 0n);
  const spreads = new Map<string, Map<string, bigint>>();
  for (const field of MONEY_FIELDS) {
    const amount = big(money[field]);
    if (amount === null) continue;
    spreads.set(field, new Map(spreadByWeight(amount, list).map((part) => [part.key, part.amount])));
  }
  const bidderCount = row.bidder_count;
  return keys.map((key) => {
    const isLead = key === lead;
    const values: Record<string, string | number | null> = {};
    for (const field of MONEY_FIELDS) values[field] = spreads.get(field)?.get(key)?.toString() ?? null;
    values.single_bidder_flag = isLead && bidderCount !== null ? (bidderCount === 1 ? 1 : 0) : null;
    values.bidder_known_flag = isLead && bidderCount !== null ? 1 : null;
    values.days_late = isLead ? row.days_late : null;
    // The share is what the party holds of the contract in percent (numeric(7,4)); when the shares do not add up to 100 it is still the share of the value that was spread.
    const share = total === 0n ? 0n : ((weights.get(key) as bigint) * 1_000_000n) / total;
    return { contractId: row.id, contractorId: key, isLead, sharePct: `${share / 10_000n}.${String(share % 10_000n).padStart(4, '0')}`, values };
  });
}

export class CtrFactStore {
  // ---- reading --------------------------------------------------------------------------------------------------------------------------------------

  /** A page of the contracts in the scope of the reader, filtered, sorted by an allowed column and continued from a cursor; the facts carry whether the reader may see their ledger. */
  async page(tx: TenantTx, query: FactQuery, page: FactPage): Promise<{ facts: ContractFact[]; cursors: Array<{ value: string; id: string }> }> {
    const sort = FACT_SORTS[page.sort];
    if (sort === undefined) throw invalid('sort');
    if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 100_001) throw invalid('limit');
    await pinDay(tx, query.asOf);
    const built = assemble(query);
    const where = [...built.where];
    const params = [...built.params];
    // A column that is never null is sorted as it is (an index on it can serve the order); a nullable one sorts its missing figure first through a sentinel, so the keyset of the cursor never meets a null.
    const key = sort.notNull === true ? sort.sql : `coalesce(${sort.sql}, ${SENTINEL[sort.kind]})`;
    const op = page.direction === 'asc' ? '>' : '<';
    if (page.after !== undefined) {
      if (page.after.sort !== page.sort || page.after.direction !== page.direction || !UUID.test(page.after.id)) throw invalid('cursor');
      params.push(page.after.value, page.after.id);
      where.push(`(${key}, c.id) ${op} ($${params.length - 1}::${CAST[sort.kind]}, $${params.length}::uuid)`);
    }
    params.push(page.limit);
    const order = page.direction === 'asc' ? 'asc' : 'desc';
    // Two steps: the keys of the page (cheap: no figure of the fact is computed for the rows that are not on it), then the facts of those rows.
    const keys = await tx.query<{ id: string; sort_key: string; ledger_ok: boolean }>(
      `select c.id::text as id, ${key}::text as sort_key, (${built.ledger}) as ledger_ok
         from ${built.from}
        where ${where.join(' and ')}
        order by ${key} ${order}, c.id ${order} limit $${params.length}`,
      params,
    );
    if (keys.length === 0) return { facts: [], cursors: [] };
    const wanted = built.params.length + 1;
    // The predicate of the ledger is read here too, so that every parameter the scope took is used by the statement that was given it.
    const rows = await tx.query<Row>(`select ${SELECT_LIST}, (${built.ledger}) as ledger_ok from ${built.from} where ${built.where.join(' and ')} and c.id = any($${wanted}::uuid[])`, [...built.params, keys.map((one) => one.id)]);
    const byId = new Map(rows.map((row) => [String(row[alias('id')]), row]));
    const facts: ContractFact[] = [];
    for (const one of keys) {
      const row = byId.get(one.id);
      if (row !== undefined) facts.push(toFact(row, one.ledger_ok === true));
    }
    return { facts, cursors: keys.filter((one) => byId.has(one.id)).map((one) => ({ value: one.sort_key, id: one.id })) };
  }

  /** The sums of the contracts of the query (the ones a report reads), and, when a breakdown is named, of each group. A group that has no contract is not there. */
  async sums(tx: TenantTx, query: FactQuery, keys: readonly SumKey[], breakdown?: string): Promise<{ total: Sums; groups: FactGroupSums[] }> {
    await pinDay(tx, query.asOf);
    const built = assemble(query);
    const group = breakdown === undefined ? undefined : BREAKDOWN_SQL[breakdown];
    if (breakdown !== undefined && group === undefined) throw invalid('breakdown');
    const ledger = `(${built.ledger})`;
    const columns = keys.map((key) => `${SUM_SQL[key](ledger)}::text as s_${key}`).join(',\n         ');
    const common = `count(*)::int as rows, (count(*) filter (where ${ledger}))::int as ledger_rows${columns === '' ? '' : `,\n         ${columns}`}`;
    const toSums = (row: Row): Sums => {
      const sums: Record<string, unknown> = { rows: Number(row.rows), ledgerRows: Number(row.ledger_rows) };
      for (const key of SUM_KEYS) sums[key] = keys.includes(key) ? ((row[`s_${key}`] as string | null | undefined) ?? null) : null;
      return sums as unknown as Sums;
    };
    const totalRows = await tx.query<Row>(`select ${common} from ${built.from} where ${built.where.join(' and ')}`, built.params);
    const total = toSums(totalRows[0] as Row);
    if (group === undefined) return { total, groups: [] };
    const groupRows = await tx.query<Row>(`select ${group} as group_key, ${common} from ${built.from} where ${built.where.join(' and ')} group by 1`, built.params);
    return { total, groups: groupRows.filter((row) => row.group_key !== null).map((row) => ({ key: String(row.group_key), sums: toSums(row) })) };
  }

  /** The sums a report needs, by the catalogue. */
  reportSums(tx: TenantTx, query: FactQuery, code: Exclude<CtrReportCode, 'contractor-concentration'>, breakdown?: string): Promise<{ total: Sums; groups: FactGroupSums[] }> {
    return this.sums(tx, query, REPORT_SUMS[code], breakdown);
  }

  /** The ACTIVE contracts the concentration reads (a draft is not exposure and a closed contract no longer is), each with its active parties; two queries, so that no row carries a document of its own. */
  async concentrationInputs(tx: TenantTx, query: FactQuery): Promise<ConcentrationInput[]> {
    await pinDay(tx, query.asOf);
    const built = assemble(query, false);
    const where = `${built.where.join(' and ')} and c.contract_status = 'ACTIVE'`;
    const rows = await tx.query<{ id: string; status: string; value: string; investor: string | null; unit: string; fund: string | null; contractor: string; bidders: number | null }>(
      `select c.id::text as id, c.contract_status as status, c.contract_value_vnd::text as value, c.investor_id::text as investor, c.unit_id::text as unit, c.fund_source_version_id::text as fund,
              c.contractor_id::text as contractor, c.bidder_count as bidders
         from ${built.from} where ${where} order by c.id`,
      built.params,
    );
    const parties =
      query.snapshotId === undefined
        ? `select c.id::text as contract, cp.contractor_id::text as contractor, cp.share_pct::text as share from ${built.from}
             join machvon.contract_party cp on cp.tenant_id = c.tenant_id and cp.contract_id = c.id and cp.status = 'ACTIVE' where ${where}`
        : `select c.id::text as contract, l.contractor_id::text as contractor, l.share_pct::text as share from ${built.from}
             join machvon.contract_fact_snapshot_line l on l.tenant_id = c.tenant_id and l.snapshot_id = ${snapshotParam(built.params, query.snapshotId)}::uuid and l.contract_id = c.id where ${where}`;
    const partyRows = await tx.query<{ contract: string; contractor: string; share: string }>(parties, built.params);
    const byContract = new Map<string, Array<{ contractorId: string; sharePct: string; status: string }>>();
    for (const row of partyRows) byContract.set(row.contract, [...(byContract.get(row.contract) ?? []), { contractorId: row.contractor, sharePct: row.share, status: 'ACTIVE' }]);
    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      valueVnd: row.value,
      investorKey: row.investor,
      unitKey: row.unit,
      fundKey: row.fund,
      contractorId: row.contractor,
      parties: byContract.get(row.id) ?? [],
      bidderCount: row.bidders === null ? null : Number(row.bidders),
    }));
  }

  /** What the Investor awarded and has not yet contracted, by winning contractor (whole dong): the load that is coming. The scope is the one of the projects of the reader. */
  async pendingAwards(tx: TenantTx, projectScope: ScopeBuilder): Promise<Map<string, string>> {
    const predicate = projectScope(1);
    const rows = await tx.query<{ contractor: string; value: string }>(
      `select pr.winner_contractor_id::text as contractor, coalesce(sum(pr.award_price_vnd), 0)::text as value
         from machvon.procurement_result pr
         join machvon.procurement_package pk on pk.tenant_id = pr.tenant_id and pk.id = pr.package_id
         join machvon.project p on p.tenant_id = pk.tenant_id and p.id = pk.project_id
         join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
         left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id
        where pr.status = 'APPROVED' and pr.outcome = 'AWARDED' and pr.winner_contractor_id is not null and ${predicate.sql}
          and not exists (select 1 from machvon.contract c2 where c2.tenant_id = pr.tenant_id and c2.package_id = pr.package_id and c2.status <> 'CANCELLED')
        group by 1`,
      predicate.params,
    );
    return new Map(rows.map((row) => [row.contractor, row.value]));
  }

  /** The names of the groups of a concentration (units, investors, contractors, funds) by id; an id with no name is left out. */
  async namesOf(tx: TenantTx, ids: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)].filter((id) => UUID.test(id));
    if (unique.length === 0) return new Map();
    const rows = await tx.query<{ id: string; name: string }>(
      `select u.id::text as id, u.name from machvon.organization_unit u where u.id = any($1::uuid[])
       union all select k.id::text, k.legal_name from machvon.contractor k where k.id = any($1::uuid[])
       union all select m.id::text, m.label from machvon.master_record_version m where m.id = any($1::uuid[])`,
      [unique],
    );
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  // ---- snapshots ----------------------------------------------------------------------------------------------------------------------------------------

  /** A frozen contract fact by its id or by the snapshot of DIS it belongs to, with the revision it is and the newest revision of its period (R17). */
  async snapshot(tx: TenantTx, ref: { id?: string | undefined; periodSnapshotId?: string | undefined; periodCode?: string | undefined }): Promise<FactSnapshotRow | undefined> {
    const rows = await tx.query<SnapshotSql>(
      `${SNAPSHOT_SELECT}
        where ($1::uuid is null or s.id = $1::uuid) and ($2::uuid is null or s.period_snapshot_id = $2::uuid) and ($3::text is null or p.code = $3)
        order by s.revision desc, s.built_at desc limit 1`,
      [ref.id ?? null, ref.periodSnapshotId ?? null, ref.periodCode ?? null],
    );
    return rows[0] === undefined ? undefined : toSnapshot(rows[0]);
  }

  /** The newest fact frozen, whatever its period: what a live reading is told the latest frozen state is. */
  async latest(tx: TenantTx): Promise<FactSnapshotRow | undefined> {
    const rows = await tx.query<SnapshotSql>(`${SNAPSHOT_SELECT} order by s.built_at desc, s.revision desc limit 1`);
    return rows[0] === undefined ? undefined : toSnapshot(rows[0]);
  }

  /** The frozen facts, the period of the newest cut-off day first and, within a period, the newest revision first (the lineage reads down the page). */
  async recent(tx: TenantTx, periodCode: string | undefined, limit: number): Promise<FactSnapshotRow[]> {
    const rows = await tx.query<SnapshotSql>(`${SNAPSHOT_SELECT} where ($1::text is null or p.code = $1) order by s.as_of_date desc, s.revision desc limit $2`, [periodCode ?? null, limit]);
    return rows.map(toSnapshot);
  }

  /** The revisions of the fact of a period, newest first: the lineage (each says which one it replaced). */
  async lineage(tx: TenantTx, periodId: string): Promise<FactSnapshotRow[]> {
    const rows = await tx.query<SnapshotSql>(`${SNAPSHOT_SELECT} where s.period_id = $1::uuid order by s.revision desc`, [periodId]);
    return rows.map(toSnapshot);
  }

  /**
   * Freezes the contract fact with a frozen close snapshot of DIS (R16, R17): the fact of the cut-off day of that snapshot, whole, and the lines of DS-CTR made from it. The first freezing of a period is revision 1; a
   * later freezing of the same period (DIS replaced its snapshot) is the next revision and says which it replaces. Asking again for a snapshot that has its fact changes nothing. The hash is of the content.
   */
  async buildFor(tx: TenantTx, periodSnapshotId: string, actor: string): Promise<{ outcome: 'BUILT' | 'UNCHANGED'; snapshot: FactSnapshotRow }> {
    const source = await tx.query<{ id: string; period_id: string; status: string; snapshot_kind: string; as_of_date: string; treasury_cutoff_date: string }>(
      `select id, period_id, status, snapshot_kind, as_of_date::text as as_of_date, treasury_cutoff_date::text as treasury_cutoff_date
         from machvon.period_snapshot where id = $1::uuid and status = 'FROZEN' and snapshot_kind = 'PERIOD_CLOSE' and payload_sha256 is not null for share`,
      [periodSnapshotId],
    );
    const found = source[0];
    if (found === undefined) throw new DomainError('SOURCE_SNAPSHOT_NOT_FROZEN', 422, 'source_snapshot_id');
    await tx.query("select pg_advisory_xact_lock(hashtextextended('contract_fact_snapshot:' || current_setting('app.tenant_id', true) || ':' || $1, 0))", [found.period_id]);
    const existing = await this.snapshot(tx, { periodSnapshotId });
    if (existing !== undefined) return { outcome: 'UNCHANGED', snapshot: existing };
    const previous = await tx.query<{ id: string; revision: number }>('select id, revision from machvon.contract_fact_snapshot where period_id = $1::uuid order by revision desc limit 1', [found.period_id]);
    await pinDay(tx, found.as_of_date);
    const rows = await tx.query<BuildRow>(
      `select to_jsonb(c)::text as fact_text, c.id::text as id, c.contractor_id::text as contractor_id, c.project_id::text as project_id, c.unit_id::text as unit_id, c.investor_id::text as investor_id,
              c.fund_source_version_id::text as fund_source_version_id, c.contract_status, c.contract_type, c.contract_value_vnd::text as contract_value_vnd, c.original_value_vnd::text as original_value_vnd,
              c.approved_change_delta_vnd::text as approved_change_delta_vnd, c.winning_bid_vnd::text as winning_bid_vnd, c.requested_vnd::text as requested_vnd, c.accepted_vnd::text as accepted_vnd,
              c.paid_vnd::text as paid_vnd, c.advance_paid_vnd::text as advance_paid_vnd, c.advance_recovered_vnd::text as advance_recovered_vnd, c.advance_outstanding_vnd::text as advance_outstanding_vnd,
              c.retention_withheld_vnd::text as retention_withheld_vnd, c.retention_released_vnd::text as retention_released_vnd, c.retention_held_vnd::text as retention_held_vnd,
              c.guarantee_required_vnd::text as guarantee_required_vnd, c.guarantee_valid_vnd::text as guarantee_valid_vnd, c.bidder_count, c.days_late
         from machvon.contract_fact c order by c.id`,
    );
    const partyRows = await tx.query<PartySql>("select contract_id::text as contract_id, contractor_id::text as contractor_id, share_pct::text as share_pct, role from machvon.contract_party where status = 'ACTIVE' order by contract_id, contractor_id");
    const parties = new Map<string, PartySql[]>();
    for (const party of partyRows) parties.set(party.contract_id, [...(parties.get(party.contract_id) ?? []), party]);
    const lines = rows.flatMap((row) => linesOfContract(row, (parties.get(row.id) ?? []).map((party) => ({ contractorId: party.contractor_id, sharePct: party.share_pct, role: party.role }))));
    const hash = createHash('sha256');
    for (const row of rows) hash.update(`${row.fact_text}\n`);
    for (const line of lines) hash.update(`${JSON.stringify([line.contractId, line.contractorId, line.isLead, line.sharePct, line.values])}\n`);
    const id = (await tx.query<{ id: string }>('select gen_random_uuid()::text as id'))[0]?.id as string;
    await tx.query(
      `insert into machvon.contract_fact_snapshot (tenant_id, id, period_snapshot_id, period_id, revision, supersedes_id, cutoff_date, as_of_date, contract_count, row_count, payload_sha256, built_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::int, $5::uuid, $6::date, $7::date, $8::int, $9::int, $10, $11::uuid)`,
      [id, periodSnapshotId, found.period_id, (previous[0]?.revision ?? 0) + 1, previous[0]?.id ?? null, found.treasury_cutoff_date, found.as_of_date, rows.length, lines.length, hash.digest('hex'), actor],
    );
    for (let start = 0; start < rows.length; start += BATCH) {
      const batch = rows.slice(start, start + BATCH);
      await tx.query(
        `insert into machvon.contract_fact_snapshot_contract (tenant_id, snapshot_id, contract_id, fact)
         select nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, (x->>'id')::uuid, x from jsonb_array_elements($2::jsonb) x`,
        [id, `[${batch.map((row) => row.fact_text).join(',')}]`],
      );
    }
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (let start = 0; start < lines.length; start += BATCH) {
      const batch = lines.slice(start, start + BATCH).map((line) => {
        const row = byId.get(line.contractId) as BuildRow;
        return {
          contract_id: line.contractId,
          contractor_id: line.contractorId,
          is_lead: line.isLead,
          share_pct: line.sharePct,
          project_id: row.project_id,
          unit_id: row.unit_id,
          investor_id: row.investor_id,
          fund_source_version_id: row.fund_source_version_id,
          contract_status: row.contract_status,
          contract_type: row.contract_type,
          ...line.values,
        };
      });
      await tx.query(
        `insert into machvon.contract_fact_snapshot_line
           (tenant_id, snapshot_id, period_snapshot_id, contract_id, contractor_id, is_lead, share_pct, project_id, unit_id, investor_id, fund_source_version_id, contract_status, contract_type,
            contract_value_vnd, active_value_vnd, original_value_vnd, approved_change_delta_vnd, winning_bid_vnd, bid_variance_vnd, requested_vnd, accepted_vnd, paid_vnd,
            advance_paid_vnd, advance_recovered_vnd, advance_outstanding_vnd, retention_withheld_vnd, retention_released_vnd, retention_held_vnd, guarantee_required_vnd, guarantee_valid_vnd,
            single_bidder_flag, bidder_known_flag, days_late)
         select nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, x.contract_id, x.contractor_id, x.is_lead, x.share_pct, x.project_id, x.unit_id, x.investor_id, x.fund_source_version_id,
                x.contract_status, x.contract_type, x.contract_value_vnd, x.active_value_vnd, x.original_value_vnd, x.approved_change_delta_vnd, x.winning_bid_vnd, x.bid_variance_vnd, x.requested_vnd, x.accepted_vnd,
                x.paid_vnd, x.advance_paid_vnd, x.advance_recovered_vnd, x.advance_outstanding_vnd, x.retention_withheld_vnd, x.retention_released_vnd, x.retention_held_vnd, x.guarantee_required_vnd,
                x.guarantee_valid_vnd, x.single_bidder_flag, x.bidder_known_flag, x.days_late
           from jsonb_to_recordset($3::jsonb) as x(contract_id uuid, contractor_id uuid, is_lead boolean, share_pct numeric, project_id uuid, unit_id uuid, investor_id uuid, fund_source_version_id uuid,
                contract_status text, contract_type text, contract_value_vnd numeric, active_value_vnd numeric, original_value_vnd numeric, approved_change_delta_vnd numeric, winning_bid_vnd numeric,
                bid_variance_vnd numeric, requested_vnd numeric, accepted_vnd numeric, paid_vnd numeric, advance_paid_vnd numeric, advance_recovered_vnd numeric, advance_outstanding_vnd numeric,
                retention_withheld_vnd numeric, retention_released_vnd numeric, retention_held_vnd numeric, guarantee_required_vnd numeric, guarantee_valid_vnd numeric,
                single_bidder_flag smallint, bidder_known_flag smallint, days_late integer)`,
        [id, periodSnapshotId, JSON.stringify(batch)],
      );
    }
    const made = await this.snapshot(tx, { id });
    return { outcome: 'BUILT', snapshot: made as FactSnapshotRow };
  }
}

/** The parameter holding the snapshot id of a query that was assembled with one (the first parameter). */
function snapshotParam(params: unknown[], snapshotId: string): string {
  const index = params.indexOf(snapshotId.toLowerCase());
  if (index < 0) throw invalid('snapshot_id');
  return `$${index + 1}`;
}
