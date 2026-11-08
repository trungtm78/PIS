import { randomUUID } from 'node:crypto';
import {
  DomainError,
  assertClassAndTier,
  assertEstimateAllowed,
  assertFigurePlanYear,
  assertNegativeExplained,
  assertOrdinal,
  assertPeriodAccepts,
  assertPhasing,
  assertGrainSum,
  currentAsOf,
  fundingPeriodRange,
  isFigureBasis,
  isFigureGrain,
  isStoredFigureKind,
  monthsOfQuarter,
  nonNegativeVnd,
  parseFundingPack,
  periodHistory,
  signedFigureVnd,
  vietnamDateOf,
  versionConflict,
  yearPlanOf,
} from '@machvon/kernel';
import type { FigureBasis, FigureBook, FigureGrain, FigureHistoryEntry, FigurePeriodStatus, FundingPack, Provenance, StoredFigure, StoredFigureKind } from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/** The resource type of the audit rows and the events of a figure batch. */
export const FIGURE_RESOURCE = 'plan_figure';
export const FUNDING_TAXONOMY_TYPE = 'FUNDING_TAXONOMY';

/** The calendar of reporting periods each pack reads the status of its months, quarters and years from (the enterprise has a calendar of its own, section 5.1). */
export const FIGURE_CALENDAR: Readonly<Record<string, string>> = { PUBLIC: 'DEFAULT', ENTERPRISE: 'ENTERPRISE' };

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const stateInvalid = (current: string): DomainError => new DomainError('FIGURE_STATE_INVALID', 409, 'status', { extensions: { figure_status: current } });
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (value: string): boolean => DAY.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const MAX_ENTRIES = 12;

interface FigureSql {
  id: string;
  batch_id: string;
  project_id: string;
  project_code: string;
  taxonomy_pack: string;
  taxonomy_version: number;
  bucket: string;
  budget_level: string;
  measure: StoredFigure['measure'];
  figure_kind: StoredFigureKind;
  period_grain: FigureGrain;
  plan_year: number;
  period_ordinal: number;
  reporting_period_id: string | null;
  amount_vnd: string;
  basis: FigureBasis;
  flash: boolean;
  as_of_date: string;
  revision: number;
  supersedes_id: string | null;
  status: StoredFigure['status'];
  converted_from_id: string | null;
  estimate_amount_vnd: string | null;
  conversion_reason: StoredFigure['conversionReason'];
  adjusts_plan_year: number | null;
  adjusts_ordinal: number | null;
  decision_document_id: string | null;
  explanation: string | null;
  prepared_by: string;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  version: string;
}

const COLUMNS = `f.id, f.batch_id, f.project_id, p.code as project_code, f.taxonomy_pack, f.taxonomy_version, f.bucket, f.budget_level, f.measure, f.figure_kind, f.period_grain, f.plan_year, f.period_ordinal::int as period_ordinal,
  f.reporting_period_id, f.amount_vnd::text as amount_vnd, f.basis, f.flash, f.as_of_date::text as as_of_date, f.revision, f.supersedes_id, f.status, f.converted_from_id, f.estimate_amount_vnd::text as estimate_amount_vnd,
  f.conversion_reason, f.adjusts_plan_year, f.adjusts_ordinal::int as adjusts_ordinal, f.decision_document_id, f.explanation, f.prepared_by, f.approved_by,
  to_char(f.approved_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as approved_at, to_char(f.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at, f.version::text as version`;

const toStored = (row: FigureSql): StoredFigure => ({
  id: row.id,
  classCode: row.bucket,
  tierCode: row.budget_level,
  measure: row.measure,
  kind: row.figure_kind,
  grain: row.period_grain,
  planYear: row.plan_year,
  ordinal: row.period_ordinal,
  amountVnd: row.amount_vnd,
  basis: row.basis,
  asOfDate: row.as_of_date,
  revision: row.revision,
  status: row.status,
  flash: row.flash,
  adjusts: row.adjusts_plan_year === null || row.adjusts_ordinal === null ? null : { planYear: row.adjusts_plan_year, ordinal: row.adjusts_ordinal },
  convertedFromId: row.converted_from_id,
  estimateAmountVnd: row.estimate_amount_vnd,
  conversionReason: row.conversion_reason,
});

/** One figure of a batch as the reads give it. */
export interface FigureRow extends StoredFigure {
  batchId: string;
  projectId: string;
  projectCode: string;
  taxonomyPack: string;
  taxonomyVersion: number;
  reportingPeriodId: string | null;
  supersedesId: string | null;
  decisionDocumentId: string | null;
  explanation: string | null;
  preparedBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  version: number;
}

const toRow = (row: FigureSql): FigureRow => ({
  ...toStored(row),
  batchId: row.batch_id,
  projectId: row.project_id,
  projectCode: row.project_code,
  taxonomyPack: row.taxonomy_pack,
  taxonomyVersion: row.taxonomy_version,
  reportingPeriodId: row.reporting_period_id,
  supersedesId: row.supersedes_id,
  decisionDocumentId: row.decision_document_id,
  explanation: row.explanation,
  preparedBy: row.prepared_by,
  approvedBy: row.approved_by,
  approvedAt: row.approved_at,
  createdAt: row.created_at,
  version: Number(row.version),
});

/** The figures that were written together and move together: the four quarters of a phasing, the months of an estimate. */
export interface FigureBatch {
  batchId: string;
  projectId: string;
  projectCode: string;
  taxonomyPack: string;
  classCode: string;
  tierCode: string;
  measure: StoredFigure['measure'];
  kind: StoredFigureKind;
  grain: FigureGrain;
  planYear: number;
  basis: FigureBasis;
  status: StoredFigure['status'];
  asOfDate: string;
  explanation: string | null;
  decisionDocumentId: string | null;
  preparedBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  version: number;
  entries: FigureRow[];
}

function toBatch(rows: readonly FigureRow[]): FigureBatch {
  const first = rows[0] as FigureRow;
  return {
    batchId: first.batchId,
    projectId: first.projectId,
    projectCode: first.projectCode,
    taxonomyPack: first.taxonomyPack,
    classCode: first.classCode,
    tierCode: first.tierCode,
    measure: first.measure,
    kind: first.kind,
    grain: first.grain,
    planYear: first.planYear,
    basis: first.basis,
    status: first.status,
    asOfDate: first.asOfDate,
    explanation: first.explanation,
    decisionDocumentId: first.decisionDocumentId,
    preparedBy: first.preparedBy,
    approvedBy: first.approvedBy,
    approvedAt: first.approvedAt,
    createdAt: first.createdAt,
    version: first.version,
    entries: [...rows].sort((left, right) => left.ordinal - right.ordinal || left.revision - right.revision),
  };
}

export interface FigureProposal {
  projectId: string;
  classCode: string;
  tierCode: string;
  measure: StoredFigure['measure'];
  kind: StoredFigureKind;
  grain: FigureGrain;
  planYear: number;
  /** The basis of an actual (REPORTED by default); the other kinds have the one basis of their kind. */
  basis?: FigureBasis | undefined;
  asOfDate: string;
  entries: ReadonlyArray<{ ordinal: number; amountVnd: string }>;
  explanation?: string | undefined;
  decisionDocumentId?: string | undefined;
  /** The month a late adjustment corrects; the adjustment is booked in the period named by the entry. */
  adjusts?: { planYear: number; ordinal: number } | undefined;
  sourceReportRevisionId?: string | undefined;
  flash?: boolean | undefined;
  erpBatchId?: string | undefined;
}

export interface ResolvedPack {
  pack: FundingPack;
  ruleId: string | null;
  version: number;
  unverified: boolean;
  /** Formula, source, as-of and legal status of the numbers of the pack (those of the default, or of the type when a rule of the tenant decided). */
  provenance: Provenance | null;
}

export interface FigureFilter {
  projectId?: string | undefined;
  status?: StoredFigure['status'] | undefined;
  kind?: StoredFigureKind | undefined;
  planYear?: number | undefined;
  measure?: StoredFigure['measure'] | undefined;
}

/** What a command did, for the audit row and the event: ids, counts and codes, never an amount. */
export interface FigureResult {
  batchId: string;
  projectId: string;
  projectCode: string;
  classCode: string;
  tierCode: string;
  measure: string;
  kind: StoredFigureKind;
  grain: FigureGrain;
  planYear: number;
  count: number;
  fromStatus: string;
  status: StoredFigure['status'];
  version: number;
  conversions: number;
  figureIds: string[];
}

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";

/**
 * The stored figures of the funding model (FND-1, docs/fnd-funding-model.md sections 5.2, 7.3, 8): the phased plan, the estimates, the actuals and (for a measure other than DISBURSED) the year plan, as append-only
 * revisions. A person prepares a batch (a draft), submits it, and somebody else accepts it (maker is not checker); accepting an actual converts the estimate it replaces, in one transaction, keeping the link and the
 * amount of the estimate. Nothing is updated in place and nothing is deleted: a correction is a new revision that supersedes the old one. The identities (sum of months and quarters, phasing against the year plan,
 * no estimate after the actual, no write into a locked period) are judged by the kernel before a row is written and again at the acceptance.
 */
export class FndFigureStore {
  private readonly policy = new GovernancePolicyPort();

  /** The pack of the tenant on a day: the approved rule of the code (with its version) or the built-in default. */
  async resolvePack(tx: TenantTx, packCode: string, asOf: string): Promise<ResolvedPack> {
    const resolved = await this.policy.require(tx, FUNDING_TAXONOMY_TYPE, packCode, asOf);
    return { pack: parseFundingPack(packCode, resolved.params), ruleId: resolved.ruleId, version: resolved.version, unverified: resolved.unverified, provenance: resolved.provenance };
  }

  // -- the books -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  /** The status and the id of the reporting period of a month, a quarter or a year in the calendar of the pack; null when the calendar has no such period (nothing locks what is not defined). */
  async periodOf(tx: TenantTx, packCode: string, grain: FigureGrain, planYear: number, ordinal: number): Promise<{ id: string; status: FigurePeriodStatus } | null> {
    const range = fundingPeriodRange({ grain, planYear, ordinal });
    const [row] = await tx.query<{ id: string; status: FigurePeriodStatus }>(
      `select id, status from machvon.reporting_period where calendar_code = $1 and period_type = $2 and start_date = $3::date and end_date = $4::date limit 1`,
      [FIGURE_CALENDAR[packCode] ?? packCode, grain, range.start, range.end],
    );
    return row ?? null;
  }

  /**
   * The books of the projects for the engine: the accepted (and superseded) revisions, the year plans of CAP of the pack (the first published version of a year is `PLAN_YEAR`, each later one `PLAN_ADJUSTED`, effective on
   * the Vietnam day of its publication), the total investment of the baselines, and the years that are closed.
   */
  async loadBooks(tx: TenantTx, projectIds: readonly string[], resolved: ResolvedPack): Promise<Map<string, FigureBook>> {
    const ids = [...projectIds];
    const books = new Map<string, { figures: StoredFigure[]; tmdt: Array<{ effectiveOn: string; amountVnd: string }> }>(ids.map((id) => [id, { figures: [], tmdt: [] }]));
    if (ids.length === 0) return new Map();
    const packCode = resolved.pack.packCode;
    const stored = await tx.query<FigureSql>(
      `select ${COLUMNS} from machvon.plan_figure_revision f join machvon.project p on p.tenant_id = f.tenant_id and p.id = f.project_id
        where f.project_id = any($1::uuid[]) and f.taxonomy_pack = $2 and f.status in ('ACCEPTED', 'SUPERSEDED')`,
      [ids, packCode],
    );
    for (const row of stored) books.get(row.project_id)?.figures.push(toStored(row));
    const plans = await tx.query<{ project_id: string; plan_version_id: string; fiscal_year: number; revision: number; effective_on: string; bucket: string; budget_level: string; amount: string }>(
      `select pv.project_id, pv.id as plan_version_id, pv.fiscal_year, pv.revision, ((pv.effective_at at time zone 'Asia/Ho_Chi_Minh')::date)::text as effective_on, al.bucket, al.budget_level, sum(al.amount_vnd)::text as amount
         from machvon.plan_version pv join machvon.allocation_line al on al.tenant_id = pv.tenant_id and al.plan_version_id = pv.id
        where pv.project_id = any($1::uuid[]) and pv.status in ('PUBLISHED', 'SUPERSEDED') and pv.effective_at is not null and al.budget_level is not null and al.taxonomy_pack = $2
        group by pv.project_id, pv.id, pv.fiscal_year, pv.revision, pv.effective_at, al.bucket, al.budget_level
        order by pv.project_id, pv.fiscal_year, pv.effective_at, pv.revision`,
      [ids, packCode],
    );
    const seen = new Set<string>();
    for (const row of plans) {
      const cell = `${row.project_id}|${row.fiscal_year}|${row.bucket}|${row.budget_level}`;
      const first = !seen.has(cell);
      seen.add(cell);
      books.get(row.project_id)?.figures.push({
        id: row.plan_version_id,
        classCode: row.bucket,
        tierCode: row.budget_level,
        measure: 'DISBURSED',
        kind: first ? 'PLAN_YEAR' : 'PLAN_ADJUSTED',
        grain: 'YEAR',
        planYear: row.fiscal_year,
        ordinal: 0,
        amountVnd: row.amount,
        basis: 'PLAN_DECISION',
        asOfDate: row.effective_on,
        revision: row.revision,
        status: 'ACCEPTED',
      });
    }
    const baselines = await tx.query<{ project_id: string; effective_on: string; amount: string }>(
      `select project_id, ((taken_at at time zone 'Asia/Ho_Chi_Minh')::date)::text as effective_on, total_investment_vnd::text as amount from machvon.project_baseline where project_id = any($1::uuid[]) order by project_id, version`,
      [ids],
    );
    for (const row of baselines) books.get(row.project_id)?.tmdt.push({ effectiveOn: row.effective_on, amountVnd: row.amount });
    const closed = await tx.query<{ fiscal_year: number }>(`select distinct fiscal_year from machvon.reporting_period where calendar_code = $1 and period_type = 'YEAR' and status = 'LOCKED' and fiscal_year is not null`, [FIGURE_CALENDAR[packCode] ?? packCode]);
    const yearsClosed = new Set(closed.map((row) => row.fiscal_year));
    return new Map([...books.entries()].map(([id, held]) => [id, { pack: resolved.pack, figures: held.figures, tmdt: held.tmdt, yearsClosed }]));
  }

  // -- reads ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  /** A batch with its figures; 404 outside the scope of the caller. */
  async find(tx: TenantTx, batchId: string, scope: ScopeBuilder, lock = false): Promise<FigureBatch | undefined> {
    const visible = scope(2);
    const rows = await tx.query<FigureSql>(`select ${COLUMNS} from ${SCOPE_FROM} join machvon.plan_figure_revision f on f.tenant_id = p.tenant_id and f.project_id = p.id where f.batch_id = $1::uuid and ${visible.sql}${lock ? ' for update of f' : ''}`, [batchId, ...visible.params]);
    return rows.length === 0 ? undefined : toBatch(rows.map(toRow));
  }

  /** The batches of the figures in the scope of the caller, newest first, filtered; every batch whole. */
  async list(tx: TenantTx, filter: FigureFilter, scope: ScopeBuilder, limit: number): Promise<FigureBatch[]> {
    const visible = scope(7);
    const batchIds = await tx.query<{ batch_id: string }>(
      `select f.batch_id from ${SCOPE_FROM} join machvon.plan_figure_revision f on f.tenant_id = p.tenant_id and f.project_id = p.id
        where ($1::uuid is null or f.project_id = $1::uuid) and ($2::text is null or f.status = $2) and ($3::text is null or f.figure_kind = $3) and ($4::int is null or f.plan_year = $4::int) and ($5::text is null or f.measure = $5)
          and ${visible.sql}
        group by f.batch_id order by max(f.created_at) desc, f.batch_id desc limit $6`,
      [filter.projectId ?? null, filter.status ?? null, filter.kind ?? null, filter.planYear ?? null, filter.measure ?? null, limit, ...visible.params],
    );
    if (batchIds.length === 0) return [];
    const rows = await tx.query<FigureSql>(`select ${COLUMNS} from machvon.plan_figure_revision f join machvon.project p on p.tenant_id = f.tenant_id and p.id = f.project_id where f.batch_id = any($1::uuid[])`, [batchIds.map((row) => row.batch_id)]);
    const grouped = new Map<string, FigureRow[]>();
    for (const row of rows) grouped.set(row.batch_id, [...(grouped.get(row.batch_id) ?? []), toRow(row)]);
    return batchIds.flatMap((row) => {
      const held = grouped.get(row.batch_id);
      return held === undefined ? [] : [toBatch(held)];
    });
  }

  /** The transition history of one period of one key (7.3): the estimates that were ever accepted in order, then the actual, each linked to what it replaced, and the batches still waiting (the plan has its own lineage). */
  async history(
    tx: TenantTx,
    key: { projectId: string; classCode: string; tierCode: string; measure: StoredFigure['measure']; grain: FigureGrain; planYear: number; ordinal: number; packCode: string },
    scope: ScopeBuilder,
  ): Promise<{ history: FigureHistoryEntry[]; pending: FigureRow[]; projectCode: string }> {
    const visible = scope(9);
    const rows = await tx.query<FigureSql>(
      `select ${COLUMNS} from ${SCOPE_FROM} join machvon.plan_figure_revision f on f.tenant_id = p.tenant_id and f.project_id = p.id
        where f.project_id = $1::uuid and f.bucket = $2 and f.budget_level = $3 and f.measure = $4 and f.period_grain = $5 and f.plan_year = $6::int and f.period_ordinal = $7::int and f.taxonomy_pack = $8 and f.figure_kind in ('ESTIMATE', 'ACTUAL') and ${visible.sql}
        order by f.as_of_date, f.revision`,
      [key.projectId, key.classCode, key.tierCode, key.measure, key.grain, key.planYear, key.ordinal, key.packCode, ...visible.params],
    );
    if (rows.length === 0) {
      const [project] = await tx.query<{ code: string }>(`select p.code from ${SCOPE_FROM} where p.id = $1::uuid and ${scope(2).sql}`, [key.projectId, ...scope(2).params]);
      if (project === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      return { history: [], pending: [], projectCode: project.code };
    }
    const figures = rows.map(toRow);
    return { history: periodHistory(figures), pending: figures.filter((one) => one.status === 'DRAFT' || one.status === 'SUBMITTED'), projectCode: (rows[0] as FigureSql).project_code };
  }

  /** The projects in the scope of the caller that have figures of the pack for a plan year (a stored revision, or a published year plan of CAP in the pack), by code; `project` names one. */
  async projects(tx: TenantTx, packCode: string, planYear: number, scope: ScopeBuilder, limit: number, project?: string): Promise<Array<{ id: string; code: string; name: string }>> {
    const visible = scope(5);
    return tx.query<{ id: string; code: string; name: string }>(
      `select p.id, p.code, p.name from ${SCOPE_FROM}
        where ($1::uuid is null or p.id = $1::uuid) and ${visible.sql}
          and ($1::uuid is not null or exists (select 1 from machvon.plan_figure_revision f where f.tenant_id = p.tenant_id and f.project_id = p.id and f.taxonomy_pack = $2 and f.plan_year = $3::int and f.status in ('ACCEPTED', 'SUPERSEDED'))
               or exists (select 1 from machvon.plan_version pv join machvon.allocation_line al on al.tenant_id = pv.tenant_id and al.plan_version_id = pv.id
                           where pv.tenant_id = p.tenant_id and pv.project_id = p.id and pv.fiscal_year = $3::int and pv.status in ('PUBLISHED', 'SUPERSEDED') and al.taxonomy_pack = $2))
        order by p.code collate "C", p.id limit $4`,
      [project ?? null, packCode, planYear, limit, ...visible.params],
    );
  }

  // -- writes -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  private async lockProject(tx: TenantTx, projectId: string, scope: ScopeBuilder): Promise<{ id: string; code: string }> {
    const visible = scope(2);
    const [row] = await tx.query<{ id: string; code: string }>(`select p.id, p.code from ${SCOPE_FROM} where p.id = $1::uuid and ${visible.sql} for share of p`, [projectId, ...visible.params]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return row;
  }

  /** The figures of the cell the batch is about, as the engine reads them (every status that was ever accepted). */
  private async cellFigures(tx: TenantTx, projectId: string, classCode: string, tierCode: string, measure: string, resolved: ResolvedPack): Promise<StoredFigure[]> {
    const books = await this.loadBooks(tx, [projectId], resolved);
    return (books.get(projectId)?.figures ?? []).filter((figure) => figure.classCode === classCode && figure.tierCode === tierCode && figure.measure === measure);
  }

  /**
   * Judges a batch against the pack and the identities, for a proposal and again for an acceptance: the sums of the phasing against the year plan in force, the quarter against its months, the estimate against an actual
   * that is in, the period against its lock. `entries` are the figures of the batch; the other figures of the cell are read from the books.
   */
  private async judge(tx: TenantTx, input: { kind: StoredFigureKind; grain: FigureGrain; planYear: number; basis: FigureBasis; classCode: string; tierCode: string; measure: string; projectId: string; asOfDate: string; adjusts: { planYear: number; ordinal: number } | null }, entries: ReadonlyArray<{ ordinal: number; amountVnd: string }>, resolved: ResolvedPack): Promise<Map<number, string | null>> {
    const periods = new Map<number, string | null>();
    if (input.grain !== 'YEAR') {
      for (const entry of entries) {
        const period = await this.periodOf(tx, resolved.pack.packCode, input.grain, input.planYear, entry.ordinal);
        // I2 locks what happened (estimates and actuals); a plan revision carries its own knowledge date and rewrites no history, so a phasing may be revised while a month is locked.
        if (period !== null && (input.kind === 'ESTIMATE' || input.kind === 'ACTUAL')) assertPeriodAccepts(period.status, input.kind, 'period_ordinal');
        periods.set(entry.ordinal, period?.id ?? null);
      }
    }
    const figures = await this.cellFigures(tx, input.projectId, input.classCode, input.tierCode, input.measure, resolved);
    if (input.kind === 'ESTIMATE') {
      for (const entry of entries) assertEstimateAllowed(figures.some((figure) => figure.kind === 'ACTUAL' && figure.basis !== 'ADJUSTMENT' && figure.grain === input.grain && figure.planYear === input.planYear && figure.ordinal === entry.ordinal && figure.status !== 'DRAFT' && figure.status !== 'SUBMITTED' && figure.status !== 'WITHDRAWN'));
    }
    if (input.kind === 'PLAN_QUARTER' || input.kind === 'PLAN_MONTH') {
      const plan = yearPlanOf(figures, input.planYear, input.asOfDate).inForce;
      const phased = (kind: StoredFigureKind, grain: FigureGrain): Map<number, string> => {
        const map = new Map<number, string>();
        const count = grain === 'QUARTER' ? 4 : 12;
        for (let ordinal = 1; ordinal <= count; ordinal += 1) {
          const found = currentAsOf(figures.filter((figure) => figure.kind === kind && figure.grain === grain && figure.planYear === input.planYear && figure.ordinal === ordinal), input.asOfDate);
          if (found !== undefined) map.set(ordinal, found.amountVnd);
        }
        return map;
      };
      const quarters = input.kind === 'PLAN_QUARTER' ? new Map(entries.map((entry) => [entry.ordinal, entry.amountVnd])) : phased('PLAN_QUARTER', 'QUARTER');
      const months = input.kind === 'PLAN_MONTH' ? new Map(entries.map((entry) => [entry.ordinal, entry.amountVnd])) : phased('PLAN_MONTH', 'MONTH');
      if (resolved.pack.phasingMustSum) {
        const full = input.kind === 'PLAN_QUARTER' ? 4 : 12;
        if (entries.length !== full) throw invalid('entries');
      }
      assertPhasing(resolved.pack.phasingMustSum, { planInForceVnd: plan, quarters, months });
    }
    if (input.kind === 'ACTUAL' && input.grain === 'QUARTER') {
      for (const entry of entries) {
        const monthly = monthsOfQuarter(entry.ordinal).map((month) => currentAsOf(figures.filter((figure) => figure.kind === 'ACTUAL' && figure.grain === 'MONTH' && figure.basis === input.basis && figure.planYear === input.planYear && figure.ordinal === month), input.asOfDate)?.amountVnd ?? null);
        assertGrainSum({ quarterVnd: entry.amountVnd, monthVnds: monthly });
      }
    }
    return periods;
  }

  /**
   * A draft batch (7.3): validated against the pack of the tenant (class and tier, measure, grain, kind and basis), the period (a locked period takes nothing, a soft-closed one no estimate), the identities, and written as
   * revision numbers of its keys, each superseding the figure that is current for its key. 404 for a project outside the scope, 422 `FUNDING_CLASS_UNKNOWN`, `VALIDATION_FAILED`, `PHASING_SUM_MISMATCH`, `GRAIN_SUM_MISMATCH`,
   * `ESTIMATE_AFTER_ACTUAL`, `NEGATIVE_DELTA_EXPLANATION_REQUIRED`, 409 `FIGURE_PERIOD_LOCKED`.
   */
  async propose(tx: TenantTx, input: FigureProposal, packCode: string, actor: string, scope: ScopeBuilder, now: Date): Promise<FigureResult> {
    const today = vietnamDateOf(now);
    const resolved = await this.resolvePack(tx, packCode, today);
    const { pack } = resolved;
    const project = await this.lockProject(tx, input.projectId, scope);
    assertClassAndTier(pack, input.classCode, input.tierCode);
    if (!pack.measures.includes(input.measure)) throw invalid('measure');
    if (!isStoredFigureKind(input.kind)) throw invalid('figure_kind');
    if (!isFigureGrain(input.grain) || !pack.periodGrains.includes(input.grain)) throw invalid('period_grain');
    assertFigurePlanYear(input.planYear);
    if (!isDay(input.asOfDate)) throw invalid('as_of_date');
    if (input.entries.length === 0 || input.entries.length > MAX_ENTRIES) throw invalid('entries');
    const ordinals = new Set<number>();
    for (const entry of input.entries) {
      assertOrdinal(input.grain, entry.ordinal, 'entries.period_ordinal');
      if (ordinals.has(entry.ordinal)) throw invalid('entries.period_ordinal');
      ordinals.add(entry.ordinal);
    }
    const pairing: Record<StoredFigureKind, FigureGrain | null> = { PLAN_YEAR: 'YEAR', PLAN_ADJUSTED: 'YEAR', PLAN_QUARTER: 'QUARTER', PLAN_MONTH: 'MONTH', ESTIMATE: null, ACTUAL: null };
    if (pairing[input.kind] !== null && pairing[input.kind] !== input.grain) throw invalid('period_grain');
    if ((input.kind === 'PLAN_YEAR' || input.kind === 'PLAN_ADJUSTED') && input.measure === 'DISBURSED') throw invalid('figure_kind');
    if (input.kind === 'PLAN_ADJUSTED' && input.decisionDocumentId === undefined) throw invalid('decision_document_id');
    const basis: FigureBasis = input.kind === 'ACTUAL' ? (input.basis ?? 'REPORTED') : input.kind === 'ESTIMATE' ? 'OWNER_ESTIMATE' : 'PLAN_DECISION';
    if (!isFigureBasis(basis) || (input.kind === 'ACTUAL' && !['REPORTED', 'ERP', 'TREASURY', 'ADJUSTMENT', 'OPENING_BALANCE'].includes(basis))) throw invalid('basis');
    if (input.kind === 'ACTUAL') {
      // The actual of a pack headed by the Treasury comes from the Treasury and the reports of DIS, not from this command.
      if (pack.actualsPrecedence === 'TREASURY_HEADLINE') throw invalid('figure_kind');
      if ((basis === 'OPENING_BALANCE') !== (input.grain === 'YEAR')) throw invalid('period_grain');
      if (basis === 'ADJUSTMENT' && (input.adjusts === undefined || input.grain !== 'MONTH')) throw invalid('adjusts');
      if (basis !== 'ADJUSTMENT' && input.adjusts !== undefined) throw invalid('adjusts');
      if (basis !== 'ERP' && (input.flash === true || input.erpBatchId !== undefined)) throw invalid('basis');
    } else if (input.adjusts !== undefined || input.flash === true || input.erpBatchId !== undefined) {
      throw invalid('adjusts');
    }
    if (input.kind === 'ACTUAL' && basis !== 'OPENING_BALANCE' && input.asOfDate > today) throw invalid('as_of_date');
    if (basis === 'ADJUSTMENT' && input.adjusts !== undefined) {
      assertFigurePlanYear(input.adjusts.planYear, 'adjusts.plan_year');
      assertOrdinal('MONTH', input.adjusts.ordinal, 'adjusts.period_ordinal');
      const booked = input.entries[0] as { ordinal: number };
      if (input.entries.length !== 1 || input.adjusts.planYear * 12 + input.adjusts.ordinal >= input.planYear * 12 + booked.ordinal) throw invalid('adjusts');
    }
    const explanation = input.explanation === undefined ? null : input.explanation.normalize('NFC').trim();
    if (explanation !== null && (explanation.length < 20 || explanation.length > 2000)) throw invalid('explanation');
    if (basis === 'ADJUSTMENT' && explanation === null) throw invalid('explanation');
    const amounts = input.entries.map((entry) => ({ ordinal: entry.ordinal, amountVnd: input.kind === 'ACTUAL' && basis !== 'OPENING_BALANCE' ? signedFigureVnd(entry.amountVnd, 'entries.amount_vnd') : nonNegativeVnd(entry.amountVnd, 'entries.amount_vnd') }));
    for (const entry of amounts) if (input.kind === 'ACTUAL') assertNegativeExplained(entry.amountVnd, explanation);

    const periods = await this.judge(tx, { kind: input.kind, grain: input.grain, planYear: input.planYear, basis, classCode: input.classCode, tierCode: input.tierCode, measure: input.measure, projectId: input.projectId, asOfDate: input.asOfDate, adjusts: input.adjusts ?? null }, amounts, resolved);
    const adjustsPeriod = input.adjusts === undefined ? null : await this.periodOf(tx, packCode, 'MONTH', input.adjusts.planYear, input.adjusts.ordinal);
    const batchId = randomUUID();
    const ids: string[] = [];
    for (const entry of amounts) {
      const id = randomUUID();
      ids.push(id);
      const [last] = await tx.query<{ revision: number; id: string }>(
        `select max(revision)::int as revision, null::uuid as id from machvon.plan_figure_revision
          where project_id = $1::uuid and taxonomy_pack = $2 and bucket = $3 and budget_level = $4 and measure = $5 and figure_kind = $6 and period_grain = $7 and plan_year = $8::int and period_ordinal = $9::int and basis = $10
            and adjusts_plan_year is not distinct from $11::int and adjusts_ordinal is not distinct from $12::int`,
        [input.projectId, packCode, input.classCode, input.tierCode, input.measure, input.kind, input.grain, input.planYear, entry.ordinal, basis, input.adjusts?.planYear ?? null, input.adjusts?.ordinal ?? null],
      );
      const [current] = await tx.query<{ id: string }>(
        `select id from machvon.plan_figure_revision
          where project_id = $1::uuid and taxonomy_pack = $2 and bucket = $3 and budget_level = $4 and measure = $5 and figure_kind = $6 and period_grain = $7 and plan_year = $8::int and period_ordinal = $9::int and basis = $10
            and adjusts_plan_year is not distinct from $11::int and adjusts_ordinal is not distinct from $12::int and status = 'ACCEPTED'`,
        [input.projectId, packCode, input.classCode, input.tierCode, input.measure, input.kind, input.grain, input.planYear, entry.ordinal, basis, input.adjusts?.planYear ?? null, input.adjusts?.ordinal ?? null],
      );
      const revision = (last?.revision ?? 0) + 1;
      await tx.query(
        `insert into machvon.plan_figure_revision
           (tenant_id, id, batch_id, project_id, taxonomy_pack, taxonomy_rule_id, taxonomy_version, bucket, budget_level, measure, figure_kind, period_grain, plan_year, period_ordinal, reporting_period_id, amount_vnd, basis, flash,
            as_of_date, revision, supersedes_id, status, adjusts_plan_year, adjusts_ordinal, adjusts_period_id, source_report_revision_id, erp_batch_id, decision_document_id, explanation, prepared_by, created_at, updated_at, updated_by)
         values (${TENANT}, $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::int, $7, $8, $9, $10, $11, $12::int, $13::int, $14::uuid, $15::numeric, $16, $17, $18::date, $19::int, $20::uuid, 'DRAFT', $21::int, $22::int, $23::uuid,
                 $24::uuid, $25::uuid, $26::uuid, $27, $28::uuid, $29::timestamptz, $29::timestamptz, $28::uuid)`,
        [
          id, batchId, input.projectId, packCode, resolved.ruleId, resolved.version, input.classCode, input.tierCode, input.measure, input.kind, input.grain, input.planYear, entry.ordinal, periods.get(entry.ordinal) ?? null, entry.amountVnd, basis, input.flash === true,
          input.asOfDate, revision, current?.id ?? null, input.adjusts?.planYear ?? null, input.adjusts?.ordinal ?? null, adjustsPeriod?.id ?? null, input.sourceReportRevisionId ?? null, input.erpBatchId ?? null, input.decisionDocumentId ?? null, explanation, actor, now.toISOString(),
        ],
      );
    }
    return { batchId, projectId: input.projectId, projectCode: project.code, classCode: input.classCode, tierCode: input.tierCode, measure: input.measure, kind: input.kind, grain: input.grain, planYear: input.planYear, count: amounts.length, fromStatus: 'NONE', status: 'DRAFT', version: 1, conversions: 0, figureIds: ids };
  }

  private async lockBatch(tx: TenantTx, batchId: string, expectedVersion: number, scope: ScopeBuilder): Promise<FigureBatch> {
    const found = await this.find(tx, batchId, scope, true);
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (found.version !== expectedVersion) throw versionConflict(found.version);
    return found;
  }

  private result(batch: FigureBatch, from: string, status: StoredFigure['status'], conversions = 0): FigureResult {
    return {
      batchId: batch.batchId,
      projectId: batch.projectId,
      projectCode: batch.projectCode,
      classCode: batch.classCode,
      tierCode: batch.tierCode,
      measure: batch.measure,
      kind: batch.kind,
      grain: batch.grain,
      planYear: batch.planYear,
      count: batch.entries.length,
      fromStatus: from,
      status,
      version: batch.version + 1,
      conversions,
      figureIds: batch.entries.map((entry) => entry.id),
    };
  }

  private async move(tx: TenantTx, batch: FigureBatch, from: StoredFigure['status'], to: StoredFigure['status'], actor: string, now: Date): Promise<void> {
    await tx.query(
      `update machvon.plan_figure_revision set status = $3, updated_at = $4::timestamptz, updated_by = $5::uuid, version = version + 1
        where batch_id = $1::uuid and status = $2`,
      [batch.batchId, from, to, now.toISOString(), actor],
    );
  }

  /** The preparer hands the draft in (DRAFT to SUBMITTED). 403 `SCOPE_DENIED` for anybody else, 409 `FIGURE_STATE_INVALID`. */
  async submit(tx: TenantTx, batchId: string, expectedVersion: number, actor: string, scope: ScopeBuilder, now: Date): Promise<FigureResult> {
    const batch = await this.lockBatch(tx, batchId, expectedVersion, scope);
    if (batch.status !== 'DRAFT') throw stateInvalid(batch.status);
    if (batch.preparedBy !== actor) throw new DomainError('SCOPE_DENIED', 403);
    await this.move(tx, batch, 'DRAFT', 'SUBMITTED', actor, now);
    return this.result(batch, 'DRAFT', 'SUBMITTED');
  }

  /** The preparer takes a draft or a submitted batch back for good (to WITHDRAWN). */
  async withdraw(tx: TenantTx, batchId: string, expectedVersion: number, actor: string, scope: ScopeBuilder, now: Date): Promise<FigureResult> {
    const batch = await this.lockBatch(tx, batchId, expectedVersion, scope);
    if (batch.status !== 'DRAFT' && batch.status !== 'SUBMITTED') throw stateInvalid(batch.status);
    if (batch.preparedBy !== actor) throw new DomainError('SCOPE_DENIED', 403);
    const from = batch.status;
    await this.move(tx, batch, from, 'WITHDRAWN', actor, now);
    return this.result(batch, from, 'WITHDRAWN');
  }

  /** The checker sends a submitted batch back to the preparer (SUBMITTED to DRAFT); not by the preparer (403 `SELF_APPROVAL_DENIED`). The reason is in the audit row. */
  async sendBack(tx: TenantTx, batchId: string, expectedVersion: number, actor: string, scope: ScopeBuilder, now: Date): Promise<FigureResult> {
    const batch = await this.lockBatch(tx, batchId, expectedVersion, scope);
    if (batch.status !== 'SUBMITTED') throw stateInvalid(batch.status);
    if (batch.preparedBy === actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    await this.move(tx, batch, 'SUBMITTED', 'DRAFT', actor, now);
    return this.result(batch, 'SUBMITTED', 'DRAFT');
  }

  /**
   * The checker accepts a submitted batch, never the one who prepared it (403 `SELF_APPROVAL_DENIED`). In one transaction, for each figure: the identities and the lock of the period are judged again; the figure that was
   * current for its key is superseded; an actual that finds an accepted estimate of its key converts it (the link, the amount of the estimate and the reason are written on the actual, the estimate is superseded). A
   * current figure that is no longer the one the batch was written against is 409 `VERSION_CONFLICT`.
   */
  async accept(tx: TenantTx, batchId: string, expectedVersion: number, actor: string, packCode: string, scope: ScopeBuilder, now: Date): Promise<FigureResult> {
    const batch = await this.lockBatch(tx, batchId, expectedVersion, scope);
    if (batch.status !== 'SUBMITTED') throw stateInvalid(batch.status);
    if (batch.preparedBy === actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    const resolved = await this.resolvePack(tx, packCode, vietnamDateOf(now));
    const first = batch.entries[0] as FigureRow;
    const adjusts = first.adjusts ?? null;
    await this.judge(tx, { kind: batch.kind, grain: batch.grain, planYear: batch.planYear, basis: batch.basis, classCode: batch.classCode, tierCode: batch.tierCode, measure: batch.measure, projectId: batch.projectId, asOfDate: batch.asOfDate, adjusts }, batch.entries.map((entry) => ({ ordinal: entry.ordinal, amountVnd: entry.amountVnd })), resolved);
    let conversions = 0;
    const converted = new Map<string, { estimateId: string; amountVnd: string; reason: string }>();
    for (const entry of batch.entries) {
      const key = [batch.projectId, packCode, batch.classCode, batch.tierCode, batch.measure, batch.grain, batch.planYear, entry.ordinal];
      const current = await tx.query<{ id: string }>(
        `select id from machvon.plan_figure_revision
          where project_id = $1::uuid and taxonomy_pack = $2 and bucket = $3 and budget_level = $4 and measure = $5 and period_grain = $6 and plan_year = $7::int and period_ordinal = $8::int
            and figure_kind = $9 and basis = $10 and adjusts_plan_year is not distinct from $11::int and adjusts_ordinal is not distinct from $12::int and status = 'ACCEPTED' for update`,
        [...key, batch.kind, batch.basis, adjusts?.planYear ?? null, adjusts?.ordinal ?? null],
      );
      if ((current[0]?.id ?? null) !== entry.supersedesId) throw versionConflict(batch.version);
      if (current[0] !== undefined) {
        await tx.query(`update machvon.plan_figure_revision set status = 'SUPERSEDED', updated_at = $2::timestamptz, updated_by = $3::uuid, version = version + 1 where id = $1::uuid`, [current[0].id, now.toISOString(), actor]);
      }
      if (batch.kind === 'ACTUAL' && batch.basis !== 'ADJUSTMENT' && batch.basis !== 'OPENING_BALANCE') {
        const [estimate] = await tx.query<{ id: string; amount: string }>(
          `select id, amount_vnd::text as amount from machvon.plan_figure_revision
            where project_id = $1::uuid and taxonomy_pack = $2 and bucket = $3 and budget_level = $4 and measure = $5 and period_grain = $6 and plan_year = $7::int and period_ordinal = $8::int
              and figure_kind = 'ESTIMATE' and status = 'ACCEPTED' for update`,
          key,
        );
        if (estimate !== undefined) {
          converted.set(entry.id, { estimateId: estimate.id, amountVnd: estimate.amount, reason: current[0] === undefined ? 'PERIOD_ACTUAL_IN' : 'CORRECTION_IN_OPEN_PERIOD' });
          await tx.query(`update machvon.plan_figure_revision set status = 'SUPERSEDED', updated_at = $2::timestamptz, updated_by = $3::uuid, version = version + 1 where id = $1::uuid`, [estimate.id, now.toISOString(), actor]);
          conversions += 1;
        }
      }
    }
    // The acceptance and the conversion are one write of each figure: the guard lets the link to the estimate be written only at this move.
    for (const entry of batch.entries) {
      const link = converted.get(entry.id);
      await tx.query(
        `update machvon.plan_figure_revision set status = 'ACCEPTED', approved_by = $2::uuid, approved_at = $3::timestamptz, updated_at = $3::timestamptz, updated_by = $2::uuid, version = version + 1,
                converted_from_id = $4::uuid, estimate_amount_vnd = $5::numeric, conversion_reason = $6 where id = $1::uuid and status = 'SUBMITTED'`,
        [entry.id, actor, now.toISOString(), link?.estimateId ?? null, link?.amountVnd ?? null, link?.reason ?? null],
      );
    }
    return this.result(batch, 'SUBMITTED', 'ACCEPTED', conversions);
  }
}
