import { randomUUID } from 'node:crypto';
import { DomainError, asUuid, compareDecimal } from '@machvon/kernel';
import { assertYearsOpen } from './cap-plan-locks.ts';
import { DRAFTABLE_PROJECT_STATUSES } from './cap-plan-store.ts';
import { LINE_BUCKETS } from './cap-plan-reads.ts';
import type { LineBucket } from './cap-plan-reads.ts';
import { DisPeriodStore } from './dis-period-store.ts';
import { assertTimestampCursor, timestampKey } from './keyset.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export const SCHEDULE_KINDS = ['REGISTERED', 'FORECAST', 'WEEKLY_COMMITMENT'] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];
export const SCHEDULE_GRAINS = ['WEEK', 'MONTH'] as const;
export type ScheduleGrain = (typeof SCHEDULE_GRAINS)[number];
const BUDGET_LEVELS = ['CENTRAL', 'LOCAL'] as const;
type ScheduleBudgetLevel = (typeof BUDGET_LEVELS)[number];

/** Month 13 is the adjustment period that follows the year: January of the next year, when the year still takes payments [CXN-31]. */
export const ADJUSTMENT_MONTH = 13;
const MIN_YEAR = 1990;
const MAX_YEAR = 2100;
const MAX_ASSUMPTION = 2000;
const WHOLE_VND = /^(0|[1-9]\d*)(\.0+)?$/;
const MAX_DIGITS = 24;
/** The rate of achievement is kept to four decimals: 300 paid of 800 registered is 0.3750. */
const RATE_DIGITS = 4n;

export interface ScheduleInput {
  projectId: string;
  allocationLineId?: string | undefined;
  planYear: number;
  granularity: ScheduleGrain;
  periodId?: string | undefined;
  month?: number | undefined;
  kind: ScheduleKind;
  bucket: LineBucket;
  budgetLevel: ScheduleBudgetLevel;
  amountVnd: string;
  ctmtqgSubsetVnd?: string | undefined;
  assumption?: string | undefined;
  /** The accepted report this registration was taken from (the registration for next month that a report carries, ST-DIS-017). */
  sourceReportRevisionId?: string | undefined;
}

export interface ScheduleRegistered {
  id: string;
  version: number;
  revision: number;
  supersedesId: string | null;
  projectId: string;
  planYear: number;
  granularity: ScheduleGrain;
  month: number | null;
  periodId: string | null;
  kind: ScheduleKind;
  bucket: LineBucket;
  budgetLevel: ScheduleBudgetLevel;
  amountVnd: string;
  ctmtqgSubsetVnd: string | null;
  /** What the replaced revision said, when there was one: the audit trail shows the change, not only the new value. */
  previousAmountVnd: string | null;
}

/** What was paid on a monthly registration, and how much of it that is. Registered money is never added to the paid. */
export interface ScheduleAchievement {
  disbursedVnd: string;
  /** The paid over the registered to four decimals; null when nothing was registered (the screen says "no registration"). */
  rate: string | null;
}

export interface ScheduleRow {
  id: string;
  project: { id: string; code: string; name: string };
  allocationLineId: string | null;
  planYear: number;
  granularity: ScheduleGrain;
  month: number | null;
  period: { id: string; code: string } | null;
  bucket: LineBucket;
  budgetLevel: ScheduleBudgetLevel;
  kind: ScheduleKind;
  amountVnd: string;
  ctmtqgSubsetVnd: string | null;
  assumption: string | null;
  revision: number;
  isCurrent: boolean;
  supersedesId: string | null;
  createdAtKey: string;
  /** Present on the monthly registrations only (and only the current ones). */
  achievement: ScheduleAchievement | null;
}

export interface ScheduleFilter {
  projectId?: string | undefined;
  planYear?: number | undefined;
  kind?: ScheduleKind | undefined;
  granularity?: ScheduleGrain | undefined;
  month?: number | undefined;
  /** Every revision instead of the current one of each key. */
  history?: boolean | undefined;
}

interface SqlRow {
  id: string;
  project_id: string;
  project_code: string;
  project_name: string;
  allocation_line_id: string | null;
  plan_year: number;
  granularity: ScheduleGrain;
  month: number | null;
  period_id: string | null;
  period_code: string | null;
  bucket: LineBucket;
  budget_level: ScheduleBudgetLevel;
  kind: ScheduleKind;
  amount_vnd: string;
  ctmtqg_subset_vnd: string | null;
  assumption: string | null;
  revision: number;
  is_current: boolean;
  supersedes_id: string | null;
  created_at_key: string;
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

function amountOf(value: unknown, field: string): string {
  if (typeof value !== 'string' || !WHOLE_VND.test(value)) throw invalid(field);
  const whole = value.split('.')[0] as string;
  if (whole.length > MAX_DIGITS) throw invalid(field);
  return whole;
}

function yearOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_YEAR || value > MAX_YEAR) throw invalid('plan_year');
  return value;
}

/** The paid over the registered, to four decimals, half up and exact (never a float); null when nothing was registered. */
export function achievementRate(disbursedVnd: string, registeredVnd: string): string | null {
  const registered = BigInt(registeredVnd);
  if (registered === 0n) return null;
  const scale = 10n ** RATE_DIGITS;
  const scaled = (BigInt(disbursedVnd) * scale * 2n + registered) / (registered * 2n);
  const whole = scaled / scale;
  const fraction = (scaled % scale).toString().padStart(Number(RATE_DIGITS), '0');
  return `${whole}.${fraction}`;
}

const SELECT = `select s.id, s.project_id, p.code as project_code, p.name as project_name, s.allocation_line_id, s.plan_year, s.granularity, s.month, s.period_id,
    rp.code as period_code, s.bucket, s.budget_level, s.kind, s.amount_vnd::text as amount_vnd, s.ctmtqg_subset_vnd::text as ctmtqg_subset_vnd, s.assumption,
    s.revision, s.is_current, s.supersedes_id, ${timestampKey('s.created_at')} as created_at_key
  from machvon.disbursement_schedule_line s
  join machvon.project p on p.tenant_id = s.tenant_id and p.id = s.project_id
  join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
  left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id
  left join machvon.reporting_period rp on rp.tenant_id = s.tenant_id and rp.id = s.period_id`;

const toRow = (row: SqlRow, achievement: ScheduleAchievement | null): ScheduleRow => ({
  id: row.id,
  project: { id: row.project_id, code: row.project_code, name: row.project_name },
  allocationLineId: row.allocation_line_id,
  planYear: row.plan_year,
  granularity: row.granularity,
  month: row.month,
  period: row.period_id === null ? null : { id: row.period_id, code: row.period_code ?? '' },
  bucket: row.bucket,
  budgetLevel: row.budget_level,
  kind: row.kind,
  amountVnd: row.amount_vnd,
  ctmtqgSubsetVnd: row.ctmtqg_subset_vnd,
  assumption: row.assumption,
  revision: row.revision,
  isCurrent: row.is_current,
  supersedesId: row.supersedes_id,
  createdAtKey: row.created_at_key,
  achievement,
});

/**
 * The disbursement schedule (ST-CAP-009, CAP 3.1 F7, BR-CAP-08): what a project promises to pay in a month (REGISTERED), what it expects to pay
 * (FORECAST, with its assumption) and what it commits to pay in a week (WEEKLY_COMMITMENT). A registration is a promise and never money paid: it
 * is not added to the ledger or to any balance. A new registration of the same key is a new revision that takes the place of the current one; the
 * old row stays, so what was promised and when can be compared with what was paid. One advisory lock per key makes the revision number and the
 * single current row hold under concurrent requests; the unique indexes of V1364 are the last word.
 */
export class CapScheduleStore {
  private readonly periods = new DisPeriodStore();

  /**
   * Registers the amount for the key as the next revision. Judged in this order: shape 422, the project in the scope of the caller 404 (outside it,
   * or of another tenant, it does not exist), its stage 422 PROJECT_STAGE_INVALID, the year 409 FISCAL_YEAR_LOCKED, the line 422, the period
   * (a locked one 409 PERIOD_LOCKED unless a reopening that was approved covers the project).
   */
  async register(tx: TenantTx, input: ScheduleInput, actor: string, scope: ScopeBuilder, now: Date): Promise<ScheduleRegistered> {
    const shaped = this.shape(input);
    const predicate = scope(2);
    const projects = await tx.query<{ id: string; status: string }>(`select p.id, p.status from ${SCOPE_FROM} where p.id = $1::uuid and ${predicate.sql} for share of p`, [shaped.projectId, ...predicate.params]);
    const project = projects[0];
    if (project === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (!DRAFTABLE_PROJECT_STATUSES.includes(project.status)) throw new DomainError('PROJECT_STAGE_INVALID', 422, 'project_id');
    await assertYearsOpen(tx, [shaped.planYear]);
    if (shaped.allocationLineId !== undefined) await this.assertLineOfProject(tx, shaped.allocationLineId, shaped.projectId);
    await this.assertPeriodOpen(tx, shaped, now);

    // One writer at a time for a key: the current row is flipped and the next revision written under the same lock.
    await tx.query("select pg_advisory_xact_lock(hashtextextended('cap_schedule:' || current_setting('app.tenant_id') || ':' || $1::text, 0))", [this.keyOf(shaped)]);
    const current = (
      await tx.query<{ id: string; revision: number; amount_vnd: string }>(
        `select id, revision, amount_vnd::text as amount_vnd from machvon.disbursement_schedule_line
          where project_id = $1::uuid and plan_year = $2::integer and granularity = $3 and month is not distinct from $4::smallint and period_id is not distinct from $5::uuid
            and bucket = $6 and budget_level = $7 and kind = $8 and is_current for update`,
        [shaped.projectId, shaped.planYear, shaped.granularity, shaped.month ?? null, shaped.periodId ?? null, shaped.bucket, shaped.budgetLevel, shaped.kind],
      )
    )[0];
    const revision = (current?.revision ?? 0) + 1;
    const id = randomUUID();
    if (current !== undefined) await tx.query('update machvon.disbursement_schedule_line set is_current = false, updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid', [current.id, actor]);
    await tx.query(
      `insert into machvon.disbursement_schedule_line
         (tenant_id, id, project_id, allocation_line_id, plan_year, granularity, period_id, month, bucket, budget_level, kind, amount_vnd, ctmtqg_subset_vnd, assumption,
          revision, is_current, supersedes_id, source_report_revision_id, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::integer, $5, $6::uuid, $7::smallint, $8, $9, $10, $11::numeric, $12::numeric, $13,
               $14::integer, true, $15::uuid, $17::uuid, $16::uuid, $16::uuid)`,
      [
        id,
        shaped.projectId,
        shaped.allocationLineId ?? null,
        shaped.planYear,
        shaped.granularity,
        shaped.periodId ?? null,
        shaped.month ?? null,
        shaped.bucket,
        shaped.budgetLevel,
        shaped.kind,
        shaped.amountVnd,
        shaped.ctmtqgSubsetVnd ?? null,
        shaped.assumption ?? null,
        revision,
        current?.id ?? null,
        actor,
        shaped.sourceReportRevisionId ?? null,
      ],
    );
    return {
      id,
      version: 1,
      revision,
      supersedesId: current?.id ?? null,
      projectId: shaped.projectId,
      planYear: shaped.planYear,
      granularity: shaped.granularity,
      month: shaped.month ?? null,
      periodId: shaped.periodId ?? null,
      kind: shaped.kind,
      bucket: shaped.bucket,
      budgetLevel: shaped.budgetLevel,
      amountVnd: shaped.amountVnd,
      ctmtqgSubsetVnd: shaped.ctmtqgSubsetVnd ?? null,
      previousAmountVnd: current?.amount_vnd ?? null,
    };
  }

  /**
   * Registers the amount for the key as `register` does, unless the registration now in force for the key was taken from a report that is newer than `source` (a later week, or a later revision of the same
   * week): an old delivery of an older report must not replace what a newer report said. The order is judged under the lock of the key, so it cannot change between the check and the write. Undefined when
   * the registration in force is the newer one and nothing was written.
   */
  async registerUnlessNewer(tx: TenantTx, input: ScheduleInput, source: { endDate: string; revision: number }, actor: string, scope: ScopeBuilder, now: Date): Promise<ScheduleRegistered | undefined> {
    const shaped = this.shape(input);
    await tx.query("select pg_advisory_xact_lock(hashtextextended('cap_schedule:' || current_setting('app.tenant_id') || ':' || $1::text, 0))", [this.keyOf(shaped)]);
    const [current] = await tx.query<{ end_date: string; revision: number }>(
      `select rp.end_date::text as end_date, r.revision
         from machvon.disbursement_schedule_line s
         join machvon.report_revision r on r.tenant_id = s.tenant_id and r.id = s.source_report_revision_id
         join machvon.reporting_period rp on rp.tenant_id = r.tenant_id and rp.id = r.period_id
        where s.project_id = $1::uuid and s.plan_year = $2::integer and s.granularity = $3 and s.month is not distinct from $4::smallint and s.period_id is not distinct from $5::uuid
          and s.bucket = $6 and s.budget_level = $7 and s.kind = $8 and s.is_current`,
      [shaped.projectId, shaped.planYear, shaped.granularity, shaped.month ?? null, shaped.periodId ?? null, shaped.bucket, shaped.budgetLevel, shaped.kind],
    );
    if (current !== undefined && (current.end_date > source.endDate || (current.end_date === source.endDate && current.revision > source.revision))) return undefined;
    return this.register(tx, input, actor, scope, now);
  }

  /** The registrations of the projects in the scope of the caller, newest first; the current one of each key unless `history` asks for all. */
  async list(tx: TenantTx, filter: ScheduleFilter, scope: ScopeBuilder, request: { limit: number; after: { code: string; id: string } | undefined }): Promise<ScheduleRow[]> {
    assertTimestampCursor(request.after?.code);
    if (request.after !== undefined && asUuid(request.after.id) === undefined) throw invalid('cursor');
    const predicate = scope(10);
    const rows = await tx.query<SqlRow>(
      `${SELECT}
        where ($1::uuid is null or s.project_id = $1::uuid) and ($2::integer is null or s.plan_year = $2::integer) and ($3::text is null or s.kind = $3)
          and ($4::text is null or s.granularity = $4) and ($5::smallint is null or s.month = $5::smallint) and ($6::boolean or s.is_current)
          and ($7::text is null or (${timestampKey('s.created_at')}, s.id) < ($7::text, $8::uuid)) and ${predicate.sql}
        order by s.created_at desc, s.id desc limit $9`,
      [filter.projectId ?? null, filter.planYear ?? null, filter.kind ?? null, filter.granularity ?? null, filter.month ?? null, filter.history === true, request.after?.code ?? null, request.after?.id ?? null, request.limit, ...predicate.params],
    );
    const paid = await this.disbursed(tx, rows.filter((row) => row.kind === 'REGISTERED' && row.granularity === 'MONTH' && row.is_current));
    return rows.map((row) => {
      const counted = row.kind === 'REGISTERED' && row.granularity === 'MONTH' && row.is_current;
      const disbursedVnd = paid.get(achievementKey(row.project_id, row.plan_year, row.month ?? 0, row.bucket, row.budget_level)) ?? '0';
      return toRow(row, counted ? { disbursedVnd, rate: achievementRate(disbursedVnd, row.amount_vnd) } : null);
    });
  }

  private shape(input: ScheduleInput): ScheduleInput {
    const projectId = asUuid(input.projectId);
    if (projectId === undefined) throw invalid('project_id');
    const planYear = yearOf(input.planYear);
    if (!SCHEDULE_GRAINS.includes(input.granularity)) throw invalid('granularity');
    if (!SCHEDULE_KINDS.includes(input.kind)) throw invalid('kind');
    if (!LINE_BUCKETS.includes(input.bucket)) throw invalid('bucket');
    if (!BUDGET_LEVELS.includes(input.budgetLevel)) throw invalid('budget_level');
    // A registration is monthly and a weekly commitment weekly; a forecast may be either.
    if (input.kind === 'REGISTERED' && input.granularity !== 'MONTH') throw invalid('granularity');
    if (input.kind === 'WEEKLY_COMMITMENT' && input.granularity !== 'WEEK') throw invalid('granularity');
    let month: number | undefined;
    let periodId: string | undefined;
    if (input.granularity === 'MONTH') {
      if (input.periodId !== undefined) throw invalid('period_id');
      if (typeof input.month !== 'number' || !Number.isInteger(input.month) || input.month < 1 || input.month > ADJUSTMENT_MONTH) throw invalid('month');
      month = input.month;
    } else {
      if (input.month !== undefined) throw invalid('month');
      periodId = asUuid(input.periodId);
      if (periodId === undefined) throw invalid('period_id');
    }
    const allocationLineId = input.allocationLineId === undefined ? undefined : asUuid(input.allocationLineId);
    if (input.allocationLineId !== undefined && allocationLineId === undefined) throw invalid('allocation_line_id');
    const amountVnd = amountOf(input.amountVnd, 'amount_vnd');
    const ctmtqgSubsetVnd = input.ctmtqgSubsetVnd === undefined ? undefined : amountOf(input.ctmtqgSubsetVnd, 'ctmtqg_subset_vnd');
    if (ctmtqgSubsetVnd !== undefined && compareDecimal(ctmtqgSubsetVnd, amountVnd) > 0) throw new DomainError('SUBSET_EXCEEDS_PARENT', 422, 'ctmtqg_subset_vnd');
    const assumption = this.assumptionOf(input);
    const sourceReportRevisionId = input.sourceReportRevisionId === undefined ? undefined : asUuid(input.sourceReportRevisionId);
    if (input.sourceReportRevisionId !== undefined && sourceReportRevisionId === undefined) throw invalid('source_report_revision_id');
    return { projectId, allocationLineId, planYear, granularity: input.granularity, periodId, month, kind: input.kind, bucket: input.bucket, budgetLevel: input.budgetLevel, amountVnd, ctmtqgSubsetVnd, assumption, sourceReportRevisionId };
  }

  /** A forecast says what it rests on; the other kinds carry no assumption. */
  private assumptionOf(input: ScheduleInput): string | undefined {
    const text = input.assumption === undefined ? '' : input.assumption.trim();
    // eslint-disable-next-line no-control-regex
    if (text.length > MAX_ASSUMPTION || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw invalid('assumption');
    if (input.kind === 'FORECAST') {
      if (text === '') throw invalid('assumption');
      return text;
    }
    if (text !== '') throw invalid('assumption');
    return undefined;
  }

  private keyOf(input: ScheduleInput): string {
    return [input.projectId, input.planYear, input.granularity, input.month ?? '', input.periodId ?? '', input.bucket, input.budgetLevel, input.kind].join('|');
  }

  /** The line named must be a line of this project (a line of another project, or of another tenant, is no line for it). */
  private async assertLineOfProject(tx: TenantTx, lineId: string, projectId: string): Promise<void> {
    const found = await tx.query('select 1 from machvon.allocation_line where id = $1::uuid and project_id = $2::uuid', [lineId, projectId]);
    if (found.length === 0) throw invalid('allocation_line_id');
  }

  /**
   * A weekly row names its period, a monthly row stands for the monthly period of that month when the calendar has one (month 13 has none). A
   * period that is locked takes nothing (409 PERIOD_LOCKED), unless a reopening that was approved covers the project and its window is open.
   */
  private async assertPeriodOpen(tx: TenantTx, input: ScheduleInput, now: Date): Promise<void> {
    if (input.granularity === 'WEEK') {
      const period = await this.periods.find(tx, input.periodId as string);
      if (period === undefined || period.periodType !== 'WEEK') throw invalid('period_id');
      if (period.status === 'LOCKED') await this.periods.judge(tx, period.id, input.projectId, now);
      return;
    }
    if ((input.month as number) === ADJUSTMENT_MONTH) return;
    const monthStart = `${input.planYear}-${String(input.month).padStart(2, '0')}-01`;
    const rows = await tx.query<{ id: string }>("select id from machvon.reporting_period where period_type = 'MONTH' and start_date = $1::date and status = 'LOCKED'", [monthStart]);
    for (const row of rows) await this.periods.judge(tx, row.id, input.projectId, now);
  }

  /**
   * What was paid for the monthly registrations of a page: the DISBURSE entries of the capital ledger that no reversal undid, in the month of the
   * registration by Vietnam time (month 13: January of the next year), on the project, the source group (bucket of the line, budget level of the
   * appropriation) of the registration.
   */
  private async disbursed(tx: TenantTx, rows: readonly SqlRow[]): Promise<Map<string, string>> {
    const paid = new Map<string, string>();
    if (rows.length === 0) return paid;
    const found = await tx.query<{ project_id: string; plan_year: number; month: number; bucket: string; budget_level: string; amount: string }>(
      `with paid as (
         select e.project_id, e.plan_year, al.bucket, a.budget_level, e.amount_vnd,
                (e.posted_at at time zone 'Asia/Ho_Chi_Minh')::date as day
           from machvon.capital_ledger_entry e
           join machvon.allocation_line al on al.tenant_id = e.tenant_id and al.id = e.allocation_line_id
           join machvon.appropriation a on a.tenant_id = e.tenant_id and a.id = e.appropriation_id
          where e.entry_type = 'DISBURSE' and e.project_id = any($1::uuid[]) and e.plan_year = any($2::integer[])
            and not exists (select 1 from machvon.capital_ledger_entry r where r.tenant_id = e.tenant_id and r.reversal_of_id = e.id)
       )
       select project_id, plan_year, case when extract(year from day) = plan_year then extract(month from day)::int else ${ADJUSTMENT_MONTH} end as month,
              bucket, budget_level, sum(amount_vnd)::text as amount
         from paid
        where extract(year from day) = plan_year or (extract(year from day) = plan_year + 1 and extract(month from day) = 1)
        group by 1, 2, 3, 4, 5`,
      [[...new Set(rows.map((row) => row.project_id))], [...new Set(rows.map((row) => row.plan_year))]],
    );
    for (const row of found) paid.set(achievementKey(row.project_id, row.plan_year, row.month, row.bucket, row.budget_level), row.amount);
    return paid;
  }
}

const achievementKey = (projectId: string, planYear: number, month: number, bucket: string, budgetLevel: string): string => `${projectId}:${planYear}:${month}:${bucket}:${budgetLevel}`;
