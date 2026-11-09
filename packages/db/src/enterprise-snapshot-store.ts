import { randomUUID } from 'node:crypto';
import {
  DomainError,
  builtInPack,
  completenessOf,
  completenessProjectOf,
  enterpriseSnapshotHash,
  fundingPeriodRange,
  parseFundingPack,
  projectRowsFromBook,
  versionConflict,
  vietnamDateOf,
} from '@machvon/kernel';
import type { Completeness, CompletenessProject, EnterpriseSnapshotView, FigurePeriodRef, FundingPack, SnapshotFigure, SnapshotIndicator } from '@machvon/kernel';
import { DisPeriodStore } from './dis-period-store.ts';
import type { PeriodRow } from './dis-period-store.ts';
import { FIGURE_CALENDAR, FndFigureStore } from './fnd-figure-store.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/** The snapshot kind of an enterprise period close: no reader of the public edition looks for it. */
export const ENTERPRISE_SNAPSHOT_KIND = 'ENTERPRISE_CLOSE';
export const ENTERPRISE_PACK = 'ENTERPRISE';
/** The version of the set of figures an enterprise snapshot holds (the rows of `enterpriseRowsOf` and the indicator figures). */
export const ENTERPRISE_METRIC_SET_VERSION = 'ENT-SNAPSHOT-R1';
export const ENTERPRISE_SNAPSHOT_BUILD_METRIC = 'ent_snapshot_build_total';
export const ENTERPRISE_SNAPSHOT_FREEZE_METRIC = 'ent_snapshot_freeze_total';
const MAX_PROJECTS = 5000;

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const iso = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export type EnterpriseSnapshotStatus = 'BUILDING' | 'FROZEN' | 'SUPERSEDED' | 'FAILED';

export interface EnterpriseSnapshotRow {
  id: string;
  periodId: string;
  periodCode: string;
  status: EnterpriseSnapshotStatus;
  asOfAt: string;
  asOfDate: string;
  definitionStatus: string;
  rowCount: number;
  figureCount: number;
  indicatorCount: number;
  payloadSha256: string | null;
  taxonomyPack: string;
  taxonomyVersion: number;
  taxonomyRuleId: string | null;
  hashSchema: number;
  revision: number;
  supersedesId: string | null;
  frozenBy: string | null;
  frozenAt: string | null;
  createdAt: string;
  createdBy: string;
  version: number;
}

interface SnapshotSql {
  id: string;
  period_id: string;
  period_code: string;
  status: EnterpriseSnapshotStatus;
  as_of_at: string;
  as_of_date: string;
  definition_status: string;
  row_count: number;
  figure_count: string;
  indicator_count: string;
  payload_sha256: string | null;
  taxonomy_pack: string;
  taxonomy_version: number;
  taxonomy_rule_id: string | null;
  hash_schema: number;
  revision: number;
  supersedes_id: string | null;
  frozen_by: string | null;
  frozen_at: string | null;
  created_at: string;
  created_by: string;
  version: string;
}

const COLUMNS = `s.id, s.period_id, rp.code as period_code, s.status, ${iso('s.as_of_at')} as as_of_at, s.as_of_date::text as as_of_date, s.definition_status, s.row_count, s.payload_sha256, s.taxonomy_pack, s.taxonomy_version,
  s.taxonomy_rule_id, s.hash_schema, s.revision, s.supersedes_id, s.frozen_by, ${iso('s.frozen_at')} as frozen_at, ${iso('s.created_at')} as created_at, s.created_by, s.version::text as version,
  (select count(*) from machvon.period_snapshot_figure f where f.tenant_id = s.tenant_id and f.snapshot_id = s.id)::text as figure_count,
  (select count(*) from machvon.period_snapshot_indicator i where i.tenant_id = s.tenant_id and i.snapshot_id = s.id)::text as indicator_count`;
const FROM = `machvon.period_snapshot s join machvon.reporting_period rp on rp.tenant_id = s.tenant_id and rp.id = s.period_id`;

const toSnapshot = (row: SnapshotSql): EnterpriseSnapshotRow => ({
  id: row.id,
  periodId: row.period_id,
  periodCode: row.period_code,
  status: row.status,
  asOfAt: row.as_of_at,
  asOfDate: row.as_of_date,
  definitionStatus: row.definition_status,
  rowCount: row.row_count,
  figureCount: Number(row.figure_count),
  indicatorCount: Number(row.indicator_count),
  payloadSha256: row.payload_sha256,
  taxonomyPack: row.taxonomy_pack,
  taxonomyVersion: row.taxonomy_version,
  taxonomyRuleId: row.taxonomy_rule_id,
  hashSchema: row.hash_schema,
  revision: row.revision,
  supersedesId: row.supersedes_id,
  frozenBy: row.frozen_by,
  frozenAt: row.frozen_at,
  createdAt: row.created_at,
  createdBy: row.created_by,
  version: Number(row.version),
});

export interface WaitingBatch {
  projectId: string;
  projectCode: string;
  batchId: string;
}

/** What the people who prepare an enterprise close need to see before they build: who has not submitted, which batches still wait for their checker, and the period the snapshot would be about. */
export interface Readiness {
  period: { id: string; code: string; status: string; grain: string; planYear: number; ordinal: number };
  pack: { code: string; version: number; unverified: boolean };
  completeness: Completeness;
  waitingBatches: WaitingBatch[];
  /** Whether a frozen snapshot of the period exists and, if so, whether an approved reopening since its freeze allows a new revision. */
  frozen: { id: string; revision: number; payloadSha256: string | null } | null;
  rebuildAllowed: boolean;
}

export interface EnterpriseBuildInput {
  period: PeriodRow;
  asOfAt: Date;
  actor: string;
  /** The projects the builder may see: an enterprise snapshot holds the whole tenant, so only a person who sees every project builds one. */
  scope: ScopeBuilder;
}

const plainValue = (value: string): string => (value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value);

/** The month, quarter or year a reporting period of the enterprise calendar stands for; 422 `period_id` when it is of another calendar or its dates are not those of a month, a quarter or a year. */
export function periodRefOf(period: PeriodRow): FigurePeriodRef {
  if (period.calendarCode !== FIGURE_CALENDAR[ENTERPRISE_PACK]) throw new DomainError('VALIDATION_FAILED', 422, 'period_id');
  if (period.periodType !== 'MONTH' && period.periodType !== 'QUARTER' && period.periodType !== 'YEAR') throw new DomainError('VALIDATION_FAILED', 422, 'period_id');
  const endMonth = Number(period.endDate.slice(5, 7));
  const ordinal = period.periodType === 'MONTH' ? endMonth : period.periodType === 'QUARTER' ? Math.ceil(endMonth / 3) : 0;
  const ref: FigurePeriodRef = { grain: period.periodType, planYear: period.fiscalYear, ordinal };
  const range = fundingPeriodRange(ref);
  if (range.start !== period.startDate || range.end !== period.endDate) throw new DomainError('VALIDATION_FAILED', 422, 'period_id');
  return ref;
}

interface ProjectUnit {
  id: string;
  code: string;
  unitId: string;
  unitCode: string;
}

/**
 * The enterprise period snapshot (ENT-3a, docs/ent-snapshot.md): built from the accepted figures of the funding model (`plan_figure_revision` and the year plans of CAP) and the figures of the indicator dictionary
 * (`ind_figure`) once the period is locked, refused with the list of the units that have not submitted when something is missing, reviewed while it is BUILDING, and frozen by somebody else with the hash of everything it
 * holds. A frozen snapshot never changes; the only way to a new one is a reopening of the period approved after the freeze (reason, different approver: the existing period reopening), and the new snapshot is the
 * next revision that supersedes the old one, whose hash stays what it was.
 */
export class EnterpriseSnapshotStore {
  private readonly figureStore = new FndFigureStore();
  private readonly periods = new DisPeriodStore();

  async find(tx: TenantTx, id: string, lock = false): Promise<EnterpriseSnapshotRow | undefined> {
    const [row] = await tx.query<SnapshotSql>(`select ${COLUMNS} from ${FROM} where s.id = $1::uuid and s.snapshot_kind = $2${lock ? ' for update of s' : ''}`, [id, ENTERPRISE_SNAPSHOT_KIND]);
    return row === undefined ? undefined : toSnapshot(row);
  }

  async list(tx: TenantTx, filter: { periodId?: string | undefined; status?: string | undefined }, limit: number): Promise<EnterpriseSnapshotRow[]> {
    const rows = await tx.query<SnapshotSql>(
      `select ${COLUMNS} from ${FROM}
        where s.snapshot_kind = $1 and ($2::uuid is null or s.period_id = $2::uuid) and ($3::text is null or s.status = $3)
        order by s.created_at desc, s.id desc limit $4`,
      [ENTERPRISE_SNAPSHOT_KIND, filter.periodId ?? null, filter.status ?? null, limit],
    );
    return rows.map(toSnapshot);
  }

  /** The frozen snapshot that is the official figure of a period (the latest revision), or none. */
  async frozenOf(tx: TenantTx, periodId: string): Promise<EnterpriseSnapshotRow | undefined> {
    const [row] = await tx.query<SnapshotSql>(`select ${COLUMNS} from ${FROM} where s.period_id = $1::uuid and s.snapshot_kind = $2 and s.status = 'FROZEN' order by s.revision desc limit 1`, [periodId, ENTERPRISE_SNAPSHOT_KIND]);
    return row === undefined ? undefined : toSnapshot(row);
  }

  /**
   * The frozen snapshot a report of a period reads: the official snapshot of the enterprise period whose dates are those given (a month, a quarter or a year of the enterprise calendar), or none. The report engine does
   * not know the id of a reporting period, only the dates of the form's period.
   */
  async frozenForDates(tx: TenantTx, periodType: 'MONTH' | 'QUARTER' | 'YEAR', start: string, end: string): Promise<EnterpriseSnapshotRow | undefined> {
    const [row] = await tx.query<SnapshotSql>(
      `select ${COLUMNS} from ${FROM}
        where rp.calendar_code = $1 and rp.period_type = $2 and rp.start_date = $3::date and rp.end_date = $4::date and s.snapshot_kind = $5 and s.status = 'FROZEN'
        order by s.revision desc limit 1`,
      [FIGURE_CALENDAR[ENTERPRISE_PACK], periodType, start, end, ENTERPRISE_SNAPSHOT_KIND],
    );
    return row === undefined ? undefined : toSnapshot(row);
  }

  // -- what the builder reads -------------------------------------------------------------------------------------------------------------------------------------------------------------------

  /** The projects of the pack with figures in the plan year, with the unit each one is attributed to at the end of the period (a project transferred later stays with the unit it had). */
  private async projectUnits(tx: TenantTx, ids: readonly string[], period: PeriodRow): Promise<ProjectUnit[]> {
    if (ids.length === 0) return [];
    const rows = await tx.query<{ id: string; code: string; unit_id: string; unit_code: string | null }>(
      `select p.id, p.code, p.owner_unit_id as unit_id, u.code as unit_code from machvon.project p left join machvon.organization_unit u on u.tenant_id = p.tenant_id and u.id = p.owner_unit_id where p.id = any($1::uuid[])`,
      [[...ids]],
    );
    const moved = await tx.query<{ project_id: string; from_unit_id: string; from_code: string | null }>(
      `select distinct on (t.project_id) t.project_id, t.from_unit_id, u.code as from_code
         from machvon.project_transfer t left join machvon.organization_unit u on u.tenant_id = t.tenant_id and u.id = t.from_unit_id
        where t.status = 'APPLIED' and t.transfer_scope = 'OWNER_UNIT' and t.effective_date > $1::date and t.project_id = any($2::uuid[])
        order by t.project_id, t.effective_date, t.applied_at, t.id`,
      [period.endDate, [...ids]],
    );
    const before = new Map(moved.map((row) => [row.project_id, row]));
    return rows
      .map((row) => {
        const earlier = before.get(row.id);
        return { id: row.id, code: row.code, unitId: earlier?.from_unit_id ?? row.unit_id, unitCode: (earlier === undefined ? row.unit_code : earlier.from_code) ?? row.unit_id };
      })
      .sort((left, right) => left.code.localeCompare(right.code) || left.id.localeCompare(right.id));
  }

  /** The pack of a snapshot exactly as it was built: the rule version it names, or the built-in default when no rule of the tenant decided. */
  async packOf(tx: TenantTx, row: Pick<EnterpriseSnapshotRow, 'taxonomyRuleId' | 'taxonomyPack'>): Promise<FundingPack> {
    if (row.taxonomyRuleId === null) return builtInPack(row.taxonomyPack as 'ENTERPRISE');
    const [rule] = await tx.query<{ params: Record<string, unknown> }>('select params from machvon.governance_rule where id = $1::uuid', [row.taxonomyRuleId]);
    if (rule === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'taxonomy_rule_id');
    return parseFundingPack(row.taxonomyPack, rule.params);
  }

  /** The figures in force of the dictionary for the period and the projects: the greatest revision of each (project, indicator). */
  private async indicatorsOf(tx: TenantTx, periodId: string, units: ReadonlyMap<string, string>): Promise<SnapshotIndicator[]> {
    if (units.size === 0) return [];
    const rows = await tx.query<{ id: string; project_id: string; indicator_code: string; value: string; unit: string; definition_version: number; revision: number }>(
      `select distinct on (f.project_id, f.indicator_code) f.id, f.project_id, f.indicator_code, f.value::text as value, f.unit, f.definition_version, f.revision
         from machvon.ind_figure f where f.period_id = $1::uuid and f.project_id = any($2::uuid[])
        order by f.project_id, f.indicator_code, f.revision desc`,
      [periodId, [...units.keys()]],
    );
    return rows.map((row) => ({ projectId: row.project_id, unitId: units.get(row.project_id) as string, indicatorCode: row.indicator_code, value: plainValue(row.value), unit: row.unit, definitionVersion: row.definition_version, revision: row.revision, sourceFigureId: row.id }));
  }

  /** The batches of actuals that were handed in and wait for their checker, for the projects named: they are not in the books yet, so they explain a gap to the people who look at the list. */
  private async waitingBatches(tx: TenantTx, projectIds: readonly string[], planYear: number): Promise<WaitingBatch[]> {
    if (projectIds.length === 0) return [];
    const rows = await tx.query<{ project_id: string; code: string; batch_id: string }>(
      `select distinct f.project_id, p.code, f.batch_id from machvon.plan_figure_revision f join machvon.project p on p.tenant_id = f.tenant_id and p.id = f.project_id
        where f.taxonomy_pack = $1 and f.figure_kind = 'ACTUAL' and f.status = 'SUBMITTED' and f.plan_year = $2::int and f.project_id = any($3::uuid[]) order by p.code, f.batch_id`,
      [ENTERPRISE_PACK, planYear, [...projectIds]],
    );
    return rows.map((row) => ({ projectId: row.project_id, projectCode: row.code, batchId: row.batch_id }));
  }

  private async gather(tx: TenantTx, period: PeriodRow, scope: ScopeBuilder, asOfAt: Date) {
    if (scope(1).sql !== 'true') throw new DomainError('SCOPE_DENIED', 403, 'scope');
    const ref = periodRefOf(period);
    const asOf = vietnamDateOf(asOfAt);
    const resolved = await this.figureStore.resolvePack(tx, ENTERPRISE_PACK, asOf);
    if (resolved.pack.packCode !== ENTERPRISE_PACK) throw new DomainError('VALIDATION_FAILED', 422, 'taxonomy_pack');
    const found = await this.figureStore.projects(tx, ENTERPRISE_PACK, ref.planYear, scope, MAX_PROJECTS);
    const projects = await this.projectUnits(tx, found.map((one) => one.id), period);
    const books = await this.figureStore.loadBooks(tx, projects.map((one) => one.id), resolved);
    const query = { period: ref, asOf, view: 'AS_REPORTED' as const };
    const judged: CompletenessProject[] = [];
    const rows: SnapshotFigure[] = [];
    for (const project of projects) {
      const book = books.get(project.id);
      if (book === undefined) continue;
      judged.push(completenessProjectOf(book, { projectId: project.id, projectCode: project.code, unitId: project.unitId, unitCode: project.unitCode }, query));
      rows.push(...projectRowsFromBook(book, { projectId: project.id, unitId: project.unitId }, query));
    }
    return { ref, asOf, resolved, projects, completeness: completenessOf(judged), rows };
  }

  /** Whether a reopening of the period was approved after the freeze of the snapshot named: the only way to a new revision. */
  private async reopenedSince(tx: TenantTx, periodId: string, frozenAt: string): Promise<string | undefined> {
    const [row] = await tx.query<{ id: string }>(
      `select id from machvon.period_reopen where period_id = $1::uuid and approved_by is not null and decided_at > $2::timestamptz order by decided_at desc limit 1`,
      [periodId, frozenAt],
    );
    return row?.id;
  }

  /** The readiness of a period for the close, without writing anything. */
  async readiness(tx: TenantTx, period: PeriodRow, scope: ScopeBuilder, now: Date): Promise<Readiness> {
    const built = await this.gather(tx, period, scope, now);
    const missing = built.completeness.missingUnits.flatMap((unit) => unit.projects.map((project) => project.projectId));
    const frozen = await this.frozenOf(tx, period.id);
    const reopened = frozen === undefined || frozen.frozenAt === null ? undefined : await this.reopenedSince(tx, period.id, frozen.frozenAt);
    return {
      period: { id: period.id, code: period.code, status: period.status, grain: built.ref.grain, planYear: built.ref.planYear, ordinal: built.ref.ordinal },
      pack: { code: built.resolved.pack.packCode, version: built.resolved.version, unverified: built.resolved.unverified },
      completeness: built.completeness,
      waitingBatches: await this.waitingBatches(tx, missing, built.ref.planYear),
      frozen: frozen === undefined ? null : { id: frozen.id, revision: frozen.revision, payloadSha256: frozen.payloadSha256 },
      rebuildAllowed: frozen === undefined || reopened !== undefined,
    };
  }

  // -- build ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  /**
   * Builds a snapshot of a locked period and keeps it BUILDING for review. Refused when the period is not locked (409 `PERIOD_STATE_INVALID`), when a frozen snapshot exists and no reopening was approved after its freeze
   * (409 `SNAPSHOT_FROZEN`), and when an input point has not submitted (422 `ENTERPRISE_SNAPSHOT_INCOMPLETE`, with the list of the missing units). A build that was never frozen is replaced by the new one.
   */
  async build(tx: TenantTx, input: EnterpriseBuildInput): Promise<{ snapshot: EnterpriseSnapshotRow; projects: number; indicators: number; discardedId: string | null; reopenId: string | null }> {
    const { period } = input;
    if (input.scope(1).sql !== 'true') throw new DomainError('SCOPE_DENIED', 403, 'scope');
    periodRefOf(period);
    if (period.status !== 'LOCKED') throw new DomainError('PERIOD_STATE_INVALID', 409, 'period_id', { extensions: { period_status: period.status } });
    const [turn] = await tx.query<{ taken: boolean }>(`select pg_try_advisory_xact_lock(hashtextextended(current_setting('app.tenant_id', true) || ':ent-snapshot:' || $1, 0)) as taken`, [period.id]);
    if (turn?.taken !== true) throw new DomainError('SNAPSHOT_BUILD_IN_PROGRESS', 409, 'period_id');
    const frozen = await this.frozenOf(tx, period.id);
    let reopenId: string | null = null;
    if (frozen !== undefined) {
      const reopened = frozen.frozenAt === null ? undefined : await this.reopenedSince(tx, period.id, frozen.frozenAt);
      if (reopened === undefined) throw new DomainError('SNAPSHOT_FROZEN', 409, 'period_id', { extensions: { snapshot_status: frozen.status, payload_sha256: frozen.payloadSha256, snapshot_id: frozen.id, reopen_required: true } });
      reopenId = reopened;
    }
    const built = await this.gather(tx, period, input.scope, input.asOfAt);
    if (!built.completeness.complete || built.completeness.plannedCells === 0) {
      const missing = built.completeness.missingUnits.flatMap((unit) => unit.projects.map((project) => project.projectId));
      throw new DomainError('ENTERPRISE_SNAPSHOT_INCOMPLETE', 422, 'period_id', {
        extensions: {
          planned_cells: built.completeness.plannedCells,
          projects: built.completeness.projects,
          missing_units: built.completeness.missingUnits.map((unit) => ({
            unit_id: unit.unitId,
            unit_code: unit.unitCode,
            projects: unit.projects.map((project) => ({ project_id: project.projectId, project_code: project.projectCode, cells: project.cells.map((cell) => ({ class_code: cell.classCode, tier_code: cell.tierCode, measure: cell.measure, months: cell.months })) })),
          })),
          waiting_batches: (await this.waitingBatches(tx, missing, built.ref.planYear)).map((batch) => ({ project_id: batch.projectId, project_code: batch.projectCode, batch_id: batch.batchId })),
        },
      });
    }
    const unitOf = new Map(built.projects.map((project) => [project.id, project.unitId]));
    const indicators = await this.indicatorsOf(tx, period.id, unitOf);
    const [discarded] = await tx.query<{ id: string }>(
      `update machvon.period_snapshot set status = 'FAILED', updated_at = now(), updated_by = $3::uuid, version = version + 1
        where period_id = $1::uuid and snapshot_kind = $2 and status = 'BUILDING' returning id`,
      [period.id, ENTERPRISE_SNAPSHOT_KIND, input.actor],
    );
    const [last] = await tx.query<{ revision: number }>(`select coalesce(max(revision), 0)::int as revision from machvon.period_snapshot where period_id = $1::uuid and snapshot_kind = $2 and status in ('FROZEN', 'SUPERSEDED')`, [period.id, ENTERPRISE_SNAPSHOT_KIND]);
    const id = randomUUID();
    const definitionStatus = built.resolved.unverified ? 'PROPOSED_PENDING_SIGNOFF' : 'SIGNED';
    await tx.query(
      `insert into machvon.period_snapshot
         (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, taxonomy_pack, taxonomy_rule_id, taxonomy_version, hash_schema, revision, created_by, updated_by, version)
       values (${TENANT}, $1::uuid, $2::uuid, $3, $4::timestamptz, $5::date, $5::date, 'BUILDING', $6, $7, $8::int, $9, $10::uuid, $11::int, 2, $12::int, $13::uuid, $13::uuid, 1)`,
      [id, period.id, ENTERPRISE_SNAPSHOT_KIND, input.asOfAt.toISOString(), period.endDate, ENTERPRISE_METRIC_SET_VERSION, definitionStatus, built.rows.length + indicators.length, ENTERPRISE_PACK, built.resolved.ruleId, Math.max(1, built.resolved.version), (last?.revision ?? 0) + 1, input.actor],
    );
    if (built.rows.length > 0) {
      await tx.query(
        `insert into machvon.period_snapshot_figure (tenant_id, id, snapshot_id, project_id, unit_id, bucket, budget_level, measure, figure_kind, grain, plan_year, ordinal, amount_vnd, null_reason, basis, source_figure_id)
         select ${TENANT}, gen_random_uuid(), $1::uuid, x."projectId", x."unitId", x."classCode", x."tierCode", x.measure, x."figureKind", x.grain, x."planYear", x.ordinal, x."amountVnd", x."nullReason", x.basis, x."sourceFigureId"
           from jsonb_to_recordset($2::jsonb) as x("projectId" uuid, "unitId" uuid, "classCode" text, "tierCode" text, measure text, "figureKind" text, grain text, "planYear" int, ordinal smallint, "amountVnd" numeric, "nullReason" text, basis text, "sourceFigureId" uuid)`,
        [id, JSON.stringify(built.rows)],
      );
    }
    if (indicators.length > 0) {
      await tx.query(
        `insert into machvon.period_snapshot_indicator (tenant_id, id, snapshot_id, project_id, unit_id, indicator_code, value, unit, definition_version, revision, source_figure_id)
         select ${TENANT}, gen_random_uuid(), $1::uuid, x."projectId", x."unitId", x."indicatorCode", x.value, x.unit, x."definitionVersion", x.revision, x."sourceFigureId"
           from jsonb_to_recordset($2::jsonb) as x("projectId" uuid, "unitId" uuid, "indicatorCode" text, value numeric, unit text, "definitionVersion" int, revision int, "sourceFigureId" uuid)`,
        [id, JSON.stringify(indicators)],
      );
    }
    const snapshot = (await this.find(tx, id)) as EnterpriseSnapshotRow;
    return { snapshot, projects: built.projects.length, indicators: indicators.length, discardedId: discarded?.id ?? null, reopenId };
  }

  // -- the rows ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  /** The figures and the indicator figures a snapshot holds, as the reader and the hash take them. */
  async rowsOf(tx: TenantTx, snapshotId: string): Promise<{ figures: SnapshotFigure[]; indicators: SnapshotIndicator[] }> {
    const figures = await tx.query<{ project_id: string; unit_id: string; bucket: string; budget_level: string; measure: string; figure_kind: string; grain: string; plan_year: number; ordinal: number; amount_vnd: string | null; null_reason: string | null; basis: SnapshotFigure['basis']; source_figure_id: string | null }>(
      `select project_id, unit_id, bucket, budget_level, measure, figure_kind, grain, plan_year, ordinal::int as ordinal, amount_vnd::text as amount_vnd, null_reason, basis, source_figure_id
         from machvon.period_snapshot_figure where snapshot_id = $1::uuid`,
      [snapshotId],
    );
    const indicators = await tx.query<{ project_id: string; unit_id: string; indicator_code: string; value: string; unit: string; definition_version: number; revision: number; source_figure_id: string }>(
      `select project_id, unit_id, indicator_code, value::text as value, unit, definition_version, revision, source_figure_id from machvon.period_snapshot_indicator where snapshot_id = $1::uuid`,
      [snapshotId],
    );
    return {
      figures: figures.map((row) => ({ projectId: row.project_id, unitId: row.unit_id, classCode: row.bucket, tierCode: row.budget_level, measure: row.measure, figureKind: row.figure_kind, grain: row.grain, planYear: row.plan_year, ordinal: row.ordinal, amountVnd: row.amount_vnd, nullReason: row.null_reason, basis: row.basis, sourceFigureId: row.source_figure_id })),
      indicators: indicators.map((row) => ({ projectId: row.project_id, unitId: row.unit_id, indicatorCode: row.indicator_code, value: plainValue(row.value), unit: row.unit, definitionVersion: row.definition_version, revision: row.revision, sourceFigureId: row.source_figure_id })),
    };
  }

  private async hashOf(tx: TenantTx, row: EnterpriseSnapshotRow): Promise<{ hash: string; figures: SnapshotFigure[]; indicators: SnapshotIndicator[] }> {
    const held = await this.rowsOf(tx, row.id);
    const pack = await this.packOf(tx, row);
    const hash = enterpriseSnapshotHash({
      periodId: row.periodId,
      snapshotKind: ENTERPRISE_SNAPSHOT_KIND,
      asOfDate: row.asOfDate,
      metricSetVersion: ENTERPRISE_METRIC_SET_VERSION,
      definitionStatus: row.definitionStatus,
      taxonomyPack: row.taxonomyPack,
      taxonomyVersion: row.taxonomyVersion,
      actualsPrecedence: pack.actualsPrecedence,
      figures: held.figures,
      indicators: held.indicators,
    });
    return { hash, ...held };
  }

  /** The snapshot loaded for the one reader: the identity, the period, the pack as it was built, the figures and the indicator figures. */
  async view(tx: TenantTx, row: EnterpriseSnapshotRow): Promise<EnterpriseSnapshotView> {
    const [period] = await tx.query<{ period_type: string; fiscal_year: number; end_date: string }>('select period_type, fiscal_year, end_date::text as end_date from machvon.reporting_period where id = $1::uuid', [row.periodId]);
    if (period === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'period_id');
    const endMonth = Number(period.end_date.slice(5, 7));
    const grain = period.period_type === 'QUARTER' ? 'QUARTER' : period.period_type === 'YEAR' ? 'YEAR' : 'MONTH';
    const held = await this.rowsOf(tx, row.id);
    return {
      snapshotId: row.id,
      revision: row.revision,
      payloadSha256: row.payloadSha256,
      periodId: row.periodId,
      period: { grain, planYear: period.fiscal_year, ordinal: grain === 'MONTH' ? endMonth : grain === 'QUARTER' ? Math.ceil(endMonth / 3) : 0 },
      asOfDate: vietnamDateOf(new Date(row.asOfAt)),
      pack: await this.packOf(tx, row),
      taxonomyVersion: row.taxonomyVersion,
      figures: held.figures,
      indicators: held.indicators,
    };
  }

  /** Recomputes the hash of a frozen snapshot from the rows it holds and compares it with the one kept at the freeze. */
  async verify(tx: TenantTx, id: string): Promise<{ ok: boolean; expected: string | null; actual: string }> {
    const row = await this.find(tx, id);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const { hash } = await this.hashOf(tx, row);
    return { ok: row.payloadSha256 === hash, expected: row.payloadSha256, actual: hash };
  }

  // -- freeze -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  /**
   * Freezes a built snapshot with the hash of what it holds. Whoever froze it did not build it (403 `SELF_APPROVAL_DENIED`); the period is still locked and no reopening was approved since the build (409
   * `PERIOD_STATE_INVALID`, the figures may have moved: build again); a frozen or superseded snapshot is 409 `SNAPSHOT_FROZEN`. The frozen snapshot of the same period before it is SUPERSEDED, keeping its hash, and the
   * new one names it (`supersedes_id`) with the next revision number.
   */
  async freeze(tx: TenantTx, id: string, expectedVersion: number, actor: string, at: Date): Promise<{ snapshot: EnterpriseSnapshotRow; supersededId: string | null }> {
    const current = await this.find(tx, id, true);
    if (current === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (current.createdBy === actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    if (current.version !== expectedVersion) throw versionConflict(current.version);
    if (current.status === 'FROZEN' || current.status === 'SUPERSEDED') throw new DomainError('SNAPSHOT_FROZEN', 409, 'status', { extensions: { snapshot_status: current.status, payload_sha256: current.payloadSha256 } });
    if (current.status !== 'BUILDING') throw new DomainError('SNAPSHOT_NOT_BUILT', 409, 'status', { extensions: { snapshot_status: current.status } });
    const period = await this.periods.find(tx, current.periodId, 'share');
    if (period === undefined || period.status !== 'LOCKED') throw new DomainError('PERIOD_STATE_INVALID', 409, 'period_id', { extensions: { period_status: period?.status ?? null } });
    if ((await this.reopenedSince(tx, current.periodId, current.asOfAt)) !== undefined) throw new DomainError('PERIOD_STATE_INVALID', 409, 'period_id', { extensions: { period_status: period.status, reopened_since_build: true } });
    if (current.figureCount + current.indicatorCount !== current.rowCount) throw new DomainError('SNAPSHOT_NOT_BUILT', 409, 'row_count');
    const { hash } = await this.hashOf(tx, current);
    const [previous] = await tx.query<{ id: string }>(
      `update machvon.period_snapshot set status = 'SUPERSEDED', updated_at = now(), updated_by = $3::uuid, version = version + 1
        where period_id = $1::uuid and snapshot_kind = $2 and status = 'FROZEN' and id <> $4::uuid returning id`,
      [current.periodId, ENTERPRISE_SNAPSHOT_KIND, actor, id],
    );
    const [frozen] = await tx.query<{ id: string }>(
      `update machvon.period_snapshot
          set status = 'FROZEN', payload_sha256 = $2, frozen_by = $3::uuid, frozen_at = $4::timestamptz, supersedes_id = $5::uuid, updated_at = now(), updated_by = $3::uuid, version = version + 1
        where id = $1::uuid and status = 'BUILDING' returning id`,
      [id, hash, actor, at.toISOString(), previous?.id ?? null],
    );
    if (frozen === undefined) throw new DomainError('SNAPSHOT_NOT_BUILT', 409, 'status');
    return { snapshot: (await this.find(tx, id)) as EnterpriseSnapshotRow, supersededId: previous?.id ?? null };
  }

  /** The projects among `projectIds` that the caller may see (the scope of the permission), for a reader restricted to them. */
  async visibleProjects(tx: TenantTx, scope: ScopeBuilder, projectIds: readonly string[]): Promise<string[]> {
    if (projectIds.length === 0) return [];
    const visible = scope(2);
    const rows = await tx.query<{ id: string }>(`select p.id from ${SCOPE_FROM} where p.id = any($1::uuid[]) and ${visible.sql}`, [[...projectIds], ...visible.params]);
    return rows.map((row) => row.id);
  }
}
