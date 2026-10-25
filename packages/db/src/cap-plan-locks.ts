import { DomainError, addDecimal, subtractDecimal } from '@machvon/kernel';
import type { LineBucket, PlanKind, PlanStatus } from './cap-plan-reads.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * What the approval and the publication of a capital plan share (ST-CAP-003): the one lock order of the capital, the reads under the locks,
 * and the write of the allocated total. The order is the one the drafting of ST-CAP-002 keeps: the plan row first, then the appropriation
 * rows by their ids, then the balance rows in the order of `lockLedgerRows`. Two commands that lock in this order never wait for each other
 * in a cycle, whichever order they name their rows in.
 */

/** The transaction setting that lets the allocated total of an appropriation change (V1360); it is dropped again right after the write. */
export const ALLOCATION_WRITE_SETTING = 'app.cap_allocation_write';

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** A plan row as the approval and the publication read it under the lock. */
export interface PlanRow {
  id: string;
  planCode: string;
  planKind: PlanKind;
  planYear: number | null;
  periodFromYear: number;
  periodToYear: number;
  scopeUnitId: string;
  revision: number;
  status: PlanStatus;
  version: number;
  supersedesId: string | null;
  createdBy: string;
  submittedBy: string | null;
  approvedBy: string | null;
  decisionDocumentId: string | null;
  effectiveAt: string | null;
  updatedAt: string;
}

interface PlanSql {
  id: string;
  plan_code: string;
  plan_kind: PlanKind;
  plan_year: number | null;
  period_from_year: number;
  period_to_year: number;
  scope_unit_id: string;
  revision: number;
  status: PlanStatus;
  version: string;
  supersedes_id: string | null;
  created_by: string;
  submitted_by: string | null;
  approved_by: string | null;
  decision_document_id: string | null;
  effective_at: string | null;
  updated_at: string;
}

const PLAN_COLUMNS = `id, plan_code, plan_kind, plan_year, period_from_year, period_to_year, scope_unit_id, revision, status, version::text as version, supersedes_id,
  created_by, submitted_by, approved_by, decision_document_id, to_char(effective_at at time zone 'UTC', ${ISO}) as effective_at,
  to_char(updated_at at time zone 'UTC', ${ISO}) as updated_at`;

const toPlanRow = (row: PlanSql): PlanRow => ({
  id: row.id,
  planCode: row.plan_code,
  planKind: row.plan_kind,
  planYear: row.plan_year,
  periodFromYear: row.period_from_year,
  periodToYear: row.period_to_year,
  scopeUnitId: row.scope_unit_id,
  revision: row.revision,
  status: row.status,
  version: Number(row.version),
  supersedesId: row.supersedes_id,
  createdBy: row.created_by,
  submittedBy: row.submitted_by,
  approvedBy: row.approved_by,
  decisionDocumentId: row.decision_document_id,
  effectiveAt: row.effective_at,
  updatedAt: row.updated_at,
});

/** The plan as it stands, without a lock: what a command reads to decide whom to authorize and which rows to lock. A plan of another tenant does not exist. */
export async function peekPlan(tx: TenantTx, planId: string): Promise<PlanRow> {
  const rows = await tx.query<PlanSql>(`select ${PLAN_COLUMNS} from machvon.capital_plan where id = $1::uuid`, [planId]);
  if (rows[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
  return toPlanRow(rows[0]);
}

/** Locks plan rows in the order of their ids (`FOR UPDATE`) and returns them in that order; a row that does not exist is left out. */
export async function lockPlans(tx: TenantTx, ids: readonly string[]): Promise<PlanRow[]> {
  const rows = await tx.query<PlanSql>(`select ${PLAN_COLUMNS} from machvon.capital_plan where id = any($1::uuid[]) order by id for update`, [[...ids]]);
  return rows.map(toPlanRow);
}

/** The plan revisions of a plan code that are PUBLISHED (the unique partial index allows one), other than `exceptId`. */
export async function publishedRevisions(tx: TenantTx, planCode: string, exceptId: string): Promise<string[]> {
  const rows = await tx.query<{ id: string }>("select id from machvon.capital_plan where plan_code = $1 and status = 'PUBLISHED' and id <> $2::uuid order by id", [planCode, exceptId]);
  return rows.map((row) => row.id);
}

export async function unitOf(tx: TenantTx, unitId: string): Promise<{ id: string; path: string }> {
  const rows = await tx.query<{ id: string; path: string }>('select id, path from machvon.organization_unit where id = $1::uuid', [unitId]);
  if (rows[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
  return rows[0];
}

/** One line of a plan as the approval and the publication judge it. */
export interface FlowLine {
  id: string;
  planVersionId: string;
  projectId: string;
  appropriationId: string | null;
  bucket: LineBucket;
  sourceYear: number;
  amountVnd: string;
}

interface FlowLineSql {
  id: string;
  plan_version_id: string;
  project_id: string | null;
  appropriation_id: string | null;
  bucket: LineBucket;
  source_year: number;
  amount_vnd: string;
}

/** Every line of a plan whatever the scope of the caller: the approver and the publisher judge the plan as a whole. In the order of the line ids. */
export async function flowLines(tx: TenantTx, planId: string): Promise<FlowLine[]> {
  const rows = await tx.query<FlowLineSql>(
    `select al.id, al.plan_version_id, al.project_id, al.appropriation_id, al.bucket, al.source_year, al.amount_vnd::text as amount_vnd
       from machvon.allocation_line al join machvon.plan_version pv on pv.tenant_id = al.tenant_id and pv.id = al.plan_version_id
      where pv.capital_plan_id = $1::uuid order by al.id`,
    [planId],
  );
  return rows.map((row) => ({
    id: row.id,
    planVersionId: row.plan_version_id,
    // A line of a plan that was drafted by the command always names its project; the legacy shape of V002 may not.
    projectId: row.project_id ?? '',
    appropriationId: row.appropriation_id,
    bucket: row.bucket,
    sourceYear: row.source_year,
    amountVnd: row.amount_vnd,
  }));
}

/** The business key of a line: the same project, appropriation, bucket and source year in two revisions is the same line. */
export const lineKey = (line: Pick<FlowLine, 'projectId' | 'appropriationId' | 'bucket' | 'sourceYear'>): string => `${line.projectId}|${line.appropriationId ?? ''}|${line.bucket}|${line.sourceYear}`;

export const appropriationIdsOf = (lines: readonly FlowLine[]): string[] => [...new Set(lines.flatMap((line) => (line.appropriationId === null ? [] : [line.appropriationId])))].sort();

/** The sum of the lines per appropriation, exactly. */
export function sumByAppropriation(lines: readonly FlowLine[]): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of lines) {
    if (line.appropriationId !== null) sums.set(line.appropriationId, addDecimal(sums.get(line.appropriationId) ?? '0', line.amountVnd));
  }
  return sums;
}

/** What the lines of a revision add to the allocated total of each appropriation: its own lines less the lines of the revision it replaces (ST-CAP-002: a revision counts only the difference). */
export function contributionOf(own: readonly FlowLine[], base: readonly FlowLine[]): Map<string, string> {
  const result = sumByAppropriation(own);
  for (const [id, amount] of sumByAppropriation(base)) result.set(id, subtractDecimal(result.get(id) ?? '0', amount));
  return result;
}

/** An appropriation row under the lock. */
export interface LockedAppropriation {
  id: string;
  status: string;
  planYear: number;
  amountVnd: string;
  allocatedTotalVnd: string;
}

/** Locks the appropriations in the order of their ids, whichever order the lines name them in. */
export async function lockAppropriationRows(tx: TenantTx, ids: readonly string[]): Promise<Map<string, LockedAppropriation>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.query<{ id: string; status: string; plan_year: number; amount_vnd: string; allocated_total_vnd: string }>(
    'select id, status, plan_year, amount_vnd::text as amount_vnd, allocated_total_vnd::text as allocated_total_vnd from machvon.appropriation where id = any($1::uuid[]) order by id for update',
    [[...ids]],
  );
  return new Map(rows.map((row) => [row.id, { id: row.id, status: row.status, planYear: row.plan_year, amountVnd: row.amount_vnd, allocatedTotalVnd: row.allocated_total_vnd }]));
}

/** A year that is soft-closed or locked takes no plan command (ST-CAP-008 keeps the year control; a year without a control row is open). */
export { assertYearsOpen } from './cap-fiscal-year-guard.ts';

/** The years a plan draws on: its own year, and the years of the appropriations of its lines. */
export function yearsOf(plan: PlanRow, appropriations: ReadonlyMap<string, LockedAppropriation>): number[] {
  return [...new Set([...(plan.planYear === null ? [] : [plan.planYear]), ...[...appropriations.values()].map((appropriation) => appropriation.planYear)])];
}

/** The move of the allocated total of one appropriation. */
export interface AllocatedMove {
  id: string;
  amountVnd: string;
  allocatedBeforeVnd: string;
  allocatedAfterVnd: string;
}

/** Writes allocated totals under the setting that V1360 asks for, and drops the setting at once. Only the allocation commands of the capital call this. */
export async function writeAllocatedTotals(tx: TenantTx, moves: readonly AllocatedMove[], actor: string): Promise<void> {
  if (moves.length === 0) return;
  await tx.query('select set_config($1, $2, true)', [ALLOCATION_WRITE_SETTING, 'on']);
  for (const move of moves) {
    await tx.query('update machvon.appropriation set allocated_total_vnd = $2::numeric, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid', [move.id, move.allocatedAfterVnd, actor]);
  }
  await tx.query('select set_config($1, $2, true)', [ALLOCATION_WRITE_SETTING, 'off']);
}

/** The status of every plan version of a plan follows the plan, so that the guard of the lines (only a DRAFT version has editable lines) holds in the database. */
export async function setVersionStatus(tx: TenantTx, planId: string, status: PlanStatus, actor: string): Promise<void> {
  await tx.query('update machvon.plan_version set status = $2, updated_at = now(), updated_by = $3::uuid, version = version + 1 where capital_plan_id = $1::uuid', [planId, status, actor]);
}
