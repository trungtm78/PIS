import { DomainError } from '@machvon/kernel';
import type { pwfKpi } from '@machvon/kernel';
import { PERIOD_COLUMNS, toPeriod } from './pwf-score-store.ts';
import type { PeriodRow } from './pwf-score-store.ts';
import { enterScoreScope, notFound, numberOf, scoreIdOf, unitReached, withScoreScope } from './pwf-score-support.ts';
import type { ScoreScope, ScoreUnits } from './pwf-score-support.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The reads of the scores of staff (PWF-3, R33). Every read puts the reach of the caller into the transaction first (`enterScoreScope`), so the database shows only the lines of the person, of the units the
 * caller may read and, for the human resources, of the tenant; this file then narrows by what the screen asks. What the caller sees of the tasks behind a point is judged again on the project of each task
 * (source authorisation): a point of a task outside the reach of the caller keeps its figures and loses the task.
 */

export interface Viewer {
  membershipId: string;
  /** The units of `staff_score.read_unit` or `read_hr` (`*` for the human resources). */
  readUnits: ScoreUnits;
  adjustUnits: ScoreUnits;
  reviewUnits: ScoreUnits;
  today: string;
}

export interface LineSummary {
  id: string;
  periodId: string;
  membershipId: string;
  displayName: string;
  unitIdAtPeriod: string;
  unitCode: string;
  unitName: string | null;
  scoreComputed: number | null;
  scoreAdjusted: number | null;
  rating: string | null;
  state: 'RATED' | 'NOT_RATED' | 'SMALL_SAMPLE';
  ratedTaskCount: number;
  effectiveWeight: number;
  hasAdjustment: boolean;
  hasOpenResponse: boolean;
  periodStatus: PeriodRow['status'];
  periodFrom: string;
  periodTo: string;
}

interface LineSql {
  id: string;
  period_id: string;
  membership_id: string;
  display_name: string | null;
  unit_id_at_period: string;
  unit_code: string;
  unit_name: string | null;
  score_computed: string | null;
  score_adjusted: string | null;
  rating: string | null;
  state: LineSummary['state'];
  rated_task_count: number;
  effective_weight: string;
  has_adjustment: boolean;
  has_open_response: boolean;
  period_status: PeriodRow['status'];
  period_from: string;
  period_to: string;
}

const NAME = (member: string): string => `(select d.display_name from machvon.tenant_user_directory d where d.tenant_id = l.tenant_id and d.membership_id = ${member})`;

const LINE_COLUMNS = `l.id, l.period_id, l.membership_id, ${NAME('l.membership_id')} as display_name, l.unit_id_at_period, (select u.code from machvon.organization_unit u where u.tenant_id = l.tenant_id and u.id = l.unit_id_at_period) as unit_code, (select u.name from machvon.organization_unit u where u.tenant_id = l.tenant_id and u.id = l.unit_id_at_period) as unit_name, l.score_computed::text as score_computed, l.score_adjusted::text as score_adjusted, l.rating, l.state,
  l.rated_task_count, l.effective_weight::text as effective_weight,
  exists (select 1 from machvon.staff_score_adjustment a where a.tenant_id = l.tenant_id and a.line_id = l.id and a.status = 'APPROVED') as has_adjustment,
  exists (select 1 from machvon.staff_score_response r where r.tenant_id = l.tenant_id and r.line_id = l.id and r.status = 'OPEN') as has_open_response,
  p.status as period_status, p.period_from::text as period_from, p.period_to::text as period_to`;

const LINE_FROM = 'machvon.staff_score_line l join machvon.staff_score_period p on p.tenant_id = l.tenant_id and p.id = l.period_id';

const toSummary = (row: LineSql): LineSummary => ({
  id: row.id,
  periodId: row.period_id,
  membershipId: row.membership_id,
  displayName: row.display_name ?? '',
  unitIdAtPeriod: row.unit_id_at_period,
  unitCode: row.unit_code,
  unitName: row.unit_name ?? null,
  scoreComputed: numberOf(row.score_computed),
  scoreAdjusted: numberOf(row.score_adjusted),
  rating: row.rating,
  state: row.state,
  ratedTaskCount: row.rated_task_count,
  effectiveWeight: Number(row.effective_weight),
  hasAdjustment: row.has_adjustment,
  hasOpenResponse: row.has_open_response,
  periodStatus: row.period_status,
  periodFrom: row.period_from,
  periodTo: row.period_to,
});

export interface DetailContribution {
  taskCode: string;
  taskId: string | null;
  name: string;
  fraction: number;
  weight: number;
  score: number;
  spans: Array<{ role: pwfKpi.AssignmentRole; validFrom: string; validTo: string | null; sharePct: number }>;
}

export interface AdjustmentView {
  id: string;
  lineId: string;
  points: number;
  reason: string;
  evidenceRef: string | null;
  status: 'REQUESTED' | 'APPROVED' | 'REJECTED';
  requestedBy: string;
  requestedByName: string | null;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  version: number;
}

export interface ResponseView {
  id: string;
  lineId: string;
  body: string;
  status: 'OPEN' | 'HANDLED';
  submittedAt: string;
  handledBy: string | null;
  handledByName: string | null;
  handledAt: string | null;
  conclusion: string | null;
  approvalInstanceId: string | null;
}

export interface LineDetail extends LineSummary {
  contributions: DetailContribution[];
  excluded: Array<{ taskCode: string; reason: string }>;
  flags: Array<{ code: string; taskCodes: string[] }>;
  adjustments: AdjustmentView[];
  responses: ResponseView[];
  policyCode: string;
  policyVersion: number;
  snapshotHash: string | null;
  responseUntil: string | null;
  canRequestAdjustment: boolean;
  canRespond: boolean;
  version: number;
  isSubject: boolean;
}

interface DetailSql extends LineSql {
  contributions: Array<{ task_id: string; task_code: string; name: string; project_id: string; fraction: number; weight: number; score: number; spans: Array<{ role: pwfKpi.AssignmentRole; valid_from: string; valid_to: string | null; share_pct: number }> }>;
  excluded: Array<{ task_id: string; task_code: string; reason: string }>;
  policy_code: string;
  policy_version: number;
  snapshot_hash: string | null;
  response_until: string | null;
  version: number;
}

interface AdjustmentSql {
  id: string;
  line_id: string;
  points: string;
  reason: string;
  evidence_ref: string | null;
  status: AdjustmentView['status'];
  requested_by: string;
  requested_by_name?: string | null;
  decided_by: string | null;
  decided_by_name?: string | null;
  decided_at: string | null;
  version: number;
}

interface ResponseSql {
  id: string;
  line_id: string;
  body: string;
  status: ResponseView['status'];
  submitted_at: string;
  handled_by: string | null;
  handled_by_name?: string | null;
  handled_at: string | null;
  conclusion: string | null;
  approval_instance_id: string | null;
}

const ISO = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
/** The name of a person from the directory of the tenant, for a row of the alias `alias`. */
const PERSON = (alias: string, member: string): string => `(select d.display_name from machvon.tenant_user_directory d where d.tenant_id = ${alias}.tenant_id and d.membership_id = ${member})`;

export const toAdjustment = (row: AdjustmentSql): AdjustmentView => ({
  id: row.id,
  lineId: row.line_id,
  points: Number(row.points),
  reason: row.reason,
  evidenceRef: row.evidence_ref,
  status: row.status,
  requestedBy: row.requested_by,
  requestedByName: row.requested_by_name ?? null,
  decidedBy: row.decided_by,
  decidedByName: row.decided_by_name ?? null,
  decidedAt: row.decided_at,
  version: row.version,
});

export const ADJUSTMENT_COLUMNS = `a.id, a.line_id, a.points::text as points, a.reason, a.evidence_ref, a.status, a.requested_by, ${PERSON('a', 'a.requested_by')} as requested_by_name, a.decided_by, ${PERSON('a', 'a.decided_by')} as decided_by_name, ${ISO('a.decided_at')} as decided_at, a.version`;
export const RESPONSE_COLUMNS = `r.id, r.line_id, r.body, r.status, ${ISO('r.submitted_at')} as submitted_at, r.handled_by, ${PERSON('r', 'r.handled_by')} as handled_by_name, ${ISO('r.handled_at')} as handled_at, r.conclusion, r.approval_instance_id`;

export const toResponse = (row: ResponseSql): ResponseView => ({
  id: row.id,
  lineId: row.line_id,
  body: row.body,
  status: row.status,
  submittedAt: row.submitted_at,
  handledBy: row.handled_by,
  handledByName: row.handled_by_name ?? null,
  handledAt: row.handled_at,
  conclusion: row.conclusion,
  approvalInstanceId: row.approval_instance_id,
});

export interface PageOf<T> {
  items: T[];
  next: { code: string; id: string } | null;
}

export interface PeriodView extends PeriodRow {
  lineCount: number;
  openResponseCount: number;
}

export class PwfScoreReads {
  /** The periods the caller reaches: the ones of a unit they read, and the ones that hold a line of a unit they read. */
  async periods(tx: TenantTx, scope: ScoreScope, filter: { scopeUnitId?: string | undefined; status?: string | undefined }, page: { limit: number; after?: { code: string; id: string } | undefined }): Promise<PageOf<PeriodView> & { total: number }> {
    return withScoreScope(tx, scope, async () => {
      const unitId = filter.scopeUnitId === undefined ? null : scoreIdOf(filter.scopeUnitId, 'scope_unit_id');
      const after = page.after;
      if (after !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(after.code)) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
      const where = `($1::uuid is null or p.scope_unit_id = $1::uuid) and ($2::text is null or p.status = $2::text)
        and ($3 = '*' or p.scope_unit_id::text = any(string_to_array($3, ',')) or exists (select 1 from machvon.staff_score_line l where l.tenant_id = p.tenant_id and l.period_id = p.id))`;
      const [counted, rows] = await Promise.all([
        tx.query<{ total: string }>(`select count(*)::text as total from machvon.staff_score_period p where ${where}`, [unitId, filter.status ?? null, scope.units]),
        tx.query<PeriodSql>(
          `select ${PERIOD_COLUMNS}, ${COUNTS} from machvon.staff_score_period p where ${where} and ($4::date is null or (p.period_from, p.id) < ($4::date, $5::uuid)) order by p.period_from desc, p.id desc limit $6`,
          [unitId, filter.status ?? null, scope.units, after?.code ?? null, after?.id ?? null, page.limit + 1],
        ),
      ]);
      const shown = rows.slice(0, page.limit);
      const last = shown[shown.length - 1];
      return { items: shown.map(toView), next: rows.length > shown.length && last !== undefined ? { code: last.period_from, id: last.id } : null, total: Number(counted[0]?.total ?? 0) };
    });
  }

  /** One period, if the caller reaches it (its unit, or a line of a unit they read): the counts are of what the caller can see. */
  async period(tx: TenantTx, scope: ScoreScope, periodId: string): Promise<PeriodView> {
    const id = scoreIdOf(periodId, 'id');
    return withScoreScope(tx, scope, async () => {
      const rows = await tx.query<PeriodSql>(
        `select ${PERIOD_COLUMNS}, ${COUNTS} from machvon.staff_score_period p
          where p.id = $1::uuid and ($2 = '*' or p.scope_unit_id::text = any(string_to_array($2, ',')) or exists (select 1 from machvon.staff_score_line l where l.tenant_id = p.tenant_id and l.period_id = p.id))`,
        [id, scope.units],
      );
      if (rows[0] === undefined) throw notFound();
      return toView(rows[0]);
    });
  }

  /** The lines of a period the caller reaches, in pages; `state` and `unitId` narrow them. */
  async lines(tx: TenantTx, scope: ScoreScope, periodId: string, filter: { state?: string | undefined; unitId?: string | undefined }, page: { limit: number; after?: { code: string; id: string } | undefined }): Promise<PageOf<LineSummary> & { total: number }> {
    const id = scoreIdOf(periodId, 'id');
    return withScoreScope(tx, scope, async () => {
      await this.period(tx, scope, id);
      const unitId = filter.unitId === undefined ? null : scoreIdOf(filter.unitId, 'unit_id');
      if (filter.state !== undefined && !['RATED', 'NOT_RATED', 'SMALL_SAMPLE'].includes(filter.state)) throw new DomainError('VALIDATION_FAILED', 422, 'state');
      const where = 'l.period_id = $1::uuid and l.erased_at is null and ($2::text is null or l.state = $2::text) and ($3::uuid is null or l.unit_id_at_period = $3::uuid)';
      const [counted, rows] = await Promise.all([
        tx.query<{ total: string }>(`select count(*)::text as total from machvon.staff_score_line l where ${where}`, [id, filter.state ?? null, unitId]),
        tx.query<LineSql>(`select ${LINE_COLUMNS} from ${LINE_FROM} where ${where} and ($4::uuid is null or l.id > $4::uuid) order by l.id limit $5`, [id, filter.state ?? null, unitId, page.after?.id ?? null, page.limit + 1]),
      ]);
      const shown = rows.slice(0, page.limit);
      const last = shown[shown.length - 1];
      return { items: shown.map(toSummary), next: rows.length > shown.length && last !== undefined ? { code: last.period_from, id: last.id } : null, total: Number(counted[0]?.total ?? 0) };
    });
  }

  /** The scores of the caller themselves: only periods that were locked (a draft is not the person's to see yet), the newest first. */
  async mine(tx: TenantTx, membershipId: string, page: { limit: number; after?: { code: string; id: string } | undefined }): Promise<PageOf<{ period: PeriodRow; line: LineSummary }>> {
    return withScoreScope(tx, { units: '', subject: membershipId }, async () => {
      const after = page.after;
      if (after !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(after.code)) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
      const rows = await tx.query<LineSql>(
        `select ${LINE_COLUMNS} from ${LINE_FROM}
          where l.membership_id = $1::uuid and l.erased_at is null and p.status in ('LOCKED', 'OFFICIAL') and ($2::date is null or (p.period_from, l.id) < ($2::date, $3::uuid))
          order by p.period_from desc, l.id desc limit $4`,
        [membershipId, after?.code ?? null, after?.id ?? null, page.limit + 1],
      );
      const shown = rows.slice(0, page.limit);
      const last = shown[shown.length - 1];
      const periods = shown.length === 0 ? [] : await tx.query<PeriodSql>(`select ${PERIOD_COLUMNS} from machvon.staff_score_period p where p.id = any($1::uuid[])`, [[...new Set(shown.map((row) => row.period_id))]]);
      const byId = new Map(periods.map((row) => [row.id, toPeriod(row)] as const));
      return {
        items: shown.map((row) => ({ line: toSummary(row), period: byId.get(row.period_id) as PeriodRow })),
        next: rows.length > shown.length && last !== undefined ? { code: last.period_from, id: last.id } : null,
      };
    });
  }

  /**
   * One line with everything behind it. The caller reaches it as the person it is about (once its period is locked) or as a reader of its unit; any other is not there (404). The tasks behind the points are shown
   * as they are to the person, and to a reader only where the reader may read the project of the task. Signals are for a reviewer and never for the person.
   */
  async line(tx: TenantTx, viewer: Viewer, lineId: string, projects: ScopeBuilder): Promise<LineDetail> {
    const id = scoreIdOf(lineId, 'id');
    const rows = await withScoreScope(tx, { units: viewer.readUnits, subject: viewer.membershipId }, () =>
      tx.query<DetailSql>(
        `select ${LINE_COLUMNS}, l.contributions, l.excluded, p.policy_code, p.policy_version, p.snapshot_hash, p.response_until::text as response_until, l.version
           from ${LINE_FROM} where l.id = $1::uuid and l.erased_at is null`,
        [id],
      ),
    );
    const row = rows[0];
    if (row === undefined) throw notFound();
    const isSubject = row.membership_id === viewer.membershipId;
    const reader = unitReached(viewer.readUnits, row.unit_id_at_period);
    // The person sees their own lines once locked; a reader of the unit sees a draft as well.
    if (!reader && !(isSubject && row.period_status !== 'DRAFT')) throw notFound();
    const scope = { units: viewer.readUnits, subject: viewer.membershipId };
    const [adjustments, responses] = await withScoreScope(tx, scope, () =>
      Promise.all([
        tx.query<AdjustmentSql>(`select ${ADJUSTMENT_COLUMNS} from machvon.staff_score_adjustment a where a.line_id = $1::uuid order by a.requested_at, a.id`, [id]),
        tx.query<ResponseSql>(`select ${RESPONSE_COLUMNS} from machvon.staff_score_response r where r.line_id = $1::uuid order by r.submitted_at, r.id`, [id]),
      ]),
    );
    const flags =
      !isSubject && unitReached(viewer.reviewUnits, row.unit_id_at_period)
        ? await withScoreScope(tx, { units: viewer.reviewUnits, subject: '' }, () =>
            tx.query<{ code: string; task_codes: string[] }>('select s.code, s.task_codes from machvon.staff_score_signal s where s.period_id = $1::uuid and s.membership_id = $2::uuid order by s.code', [row.period_id, row.membership_id]),
          )
        : [];
    const readable = isSubject ? undefined : await this.readableProjects(tx, projects, [...new Set(row.contributions.map((one) => one.project_id))]);
    const canWrite = row.period_status !== 'DRAFT';
    return {
      ...toSummary(row),
      contributions: row.contributions.map((one) => {
        const visible = readable === undefined || readable.has(one.project_id);
        return { taskCode: one.task_code, taskId: visible ? one.task_id : null, name: visible ? one.name : '', fraction: one.fraction, weight: one.weight, score: one.score, spans: one.spans.map((span) => ({ role: span.role, validFrom: span.valid_from, validTo: span.valid_to, sharePct: span.share_pct })) };
      }),
      excluded: row.excluded.map((one) => ({ taskCode: one.task_code, reason: one.reason })),
      flags: flags.map((one) => ({ code: one.code, taskCodes: one.task_codes })),
      adjustments: adjustments.map(toAdjustment),
      responses: responses.map(toResponse),
      policyCode: row.policy_code,
      policyVersion: row.policy_version,
      snapshotHash: row.snapshot_hash,
      responseUntil: row.response_until,
      canRequestAdjustment: canWrite && !isSubject && unitReached(viewer.adjustUnits, row.unit_id_at_period),
      canRespond: isSubject && row.period_status === 'LOCKED' && row.response_until !== null && viewer.today <= row.response_until,
      version: row.version,
      isSubject,
    };
  }

  /** The projects among `ids` the caller may read (the source authorisation of a point). */
  private async readableProjects(tx: TenantTx, projects: ScopeBuilder, ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const predicate = projects(2);
    const rows = await tx.query<{ id: string }>(`select p.id from ${SCOPE_FROM} where p.id = any($1::uuid[]) and ${predicate.sql}`, [[...ids], ...predicate.params]);
    return new Set(rows.map((row) => row.id));
  }

  /**
   * The scores of one person over the periods in a window, oldest first, for the comparison of periods. The reach is the one of the line: the person themselves (locked periods), or the readers of the units. The
   * samples differ when the states are not alike or one has more than twice the rated tasks of another: such periods are not ranked against each other.
   */
  async compare(tx: TenantTx, viewer: Viewer, membershipId: string, window: { from?: string | undefined; to?: string | undefined }): Promise<{ membershipId: string; points: LineSummary[]; samplesDiffer: boolean }> {
    const member = scoreIdOf(membershipId, 'membership_id');
    for (const [field, value] of [['from', window.from], ['to', window.to]] as const) if (value !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new DomainError('VALIDATION_FAILED', 422, field);
    const isSubject = member === viewer.membershipId;
    const rows = await withScoreScope(tx, { units: viewer.readUnits, subject: viewer.membershipId }, () =>
      tx.query<LineSql>(
        `select ${LINE_COLUMNS} from ${LINE_FROM}
          where l.membership_id = $1::uuid and l.erased_at is null and ($2::date is null or p.period_to >= $2::date) and ($3::date is null or p.period_from <= $3::date)
          order by p.period_from, l.id`,
        [member, window.from ?? null, window.to ?? null],
      ),
    );
    const points = rows.map(toSummary).filter((one) => unitReached(viewer.readUnits, one.unitIdAtPeriod) || (isSubject && one.periodStatus !== 'DRAFT'));
    if (points.length === 0 && !isSubject) throw notFound();
    const counts = points.map((one) => one.ratedTaskCount);
    const alike = points.every((one) => one.state === points[0]?.state) && (counts.length === 0 || Math.max(...counts) <= 2 * Math.max(1, Math.min(...counts)));
    return { membershipId: member, points, samplesDiffer: !alike };
  }

  /** The signals of a period for the reviewer, by person, in pages. */
  async signals(tx: TenantTx, reviewUnits: ScoreUnits, reviewer: string, periodId: string, page: { limit: number; after?: { code: string; id: string } | undefined }): Promise<PageOf<{ membershipId: string; displayName: string; flags: Array<{ code: string; taskCodes: string[] }> }>> {
    const id = scoreIdOf(periodId, 'id');
    return withScoreScope(tx, { units: reviewUnits, subject: '' }, async () => {
      const period = await tx.query<{ id: string }>('select id from machvon.staff_score_period p where p.id = $1::uuid', [id]);
      if (period[0] === undefined) throw notFound();
      const rows = await tx.query<{ membership_id: string; display_name: string | null; flags: Array<{ code: string; task_codes: string[] }> }>(
        `select s.membership_id, (select d.display_name from machvon.tenant_user_directory d where d.tenant_id = s.tenant_id and d.membership_id = s.membership_id) as display_name,
                jsonb_agg(jsonb_build_object('code', s.code, 'task_codes', s.task_codes) order by s.code) as flags
           from machvon.staff_score_signal s where s.period_id = $1::uuid and s.membership_id is not null and s.membership_id <> $4::uuid and ($2::uuid is null or s.membership_id > $2::uuid)
          group by s.membership_id, s.tenant_id order by s.membership_id limit $3`,
        [id, page.after?.id ?? null, page.limit + 1, scoreIdOf(reviewer, 'membership_id')],
      );
      const shown = rows.slice(0, page.limit);
      const last = shown[shown.length - 1];
      return {
        items: shown.map((row) => ({ membershipId: row.membership_id, displayName: row.display_name ?? '', flags: row.flags.map((flag) => ({ code: flag.code, taskCodes: flag.task_codes })) })),
        next: rows.length > shown.length && last !== undefined ? { code: '0', id: last.membership_id } : null,
      };
    });
  }

  /** Every line of a period the caller reaches, for the file: the figures and the state, never the tasks behind them. */
  async exportRows(tx: TenantTx, scope: ScoreScope, periodId: string): Promise<{ period: PeriodRow; rows: LineSummary[] }> {
    const id = scoreIdOf(periodId, 'id');
    return withScoreScope(tx, scope, async () => {
      const period = await this.period(tx, scope, id);
      const rows = await tx.query<LineSql>(`select ${LINE_COLUMNS} from ${LINE_FROM} where l.period_id = $1::uuid and l.erased_at is null order by l.unit_id_at_period, l.id`, [id]);
      return { period, rows: rows.map(toSummary) };
    });
  }

  /** The period by unit of the people at the time of it: counts and the mean, no names and no score of a person (the overview of the human resources). */
  async overview(tx: TenantTx, scope: ScoreScope, periodId: string): Promise<Array<{ unitId: string; unitCode: string; unitName: string; people: number; rated: number; smallSample: number; notRated: number; meanScore: number | null; adjustedCount: number; openResponseCount: number }>> {
    const id = scoreIdOf(periodId, 'id');
    return withScoreScope(tx, scope, async () => {
      await this.period(tx, scope, id);
      const rows = await tx.query<{ unit_id: string; code: string; name: string; people: string; rated: string; small: string; not_rated: string; mean: string | null; adjusted: string; open_responses: string }>(
        `select l.unit_id_at_period as unit_id, u.code, u.name, count(*)::text as people, (count(*) filter (where l.state = 'RATED'))::text as rated, (count(*) filter (where l.state = 'SMALL_SAMPLE'))::text as small,
                (count(*) filter (where l.state = 'NOT_RATED'))::text as not_rated, round(avg(l.score_computed), 2)::text as mean, (count(*) filter (where l.adjustment_points <> 0))::text as adjusted,
                (select count(*) from machvon.staff_score_response r join machvon.staff_score_line x on x.tenant_id = r.tenant_id and x.id = r.line_id where x.period_id = l.period_id and x.unit_id_at_period = l.unit_id_at_period and r.status = 'OPEN')::text as open_responses
           from machvon.staff_score_line l join machvon.organization_unit u on u.tenant_id = l.tenant_id and u.id = l.unit_id_at_period
          where l.period_id = $1::uuid and l.erased_at is null group by l.unit_id_at_period, l.period_id, u.code, u.name order by u.code`,
        [id],
      );
      return rows.map((row) => ({ unitId: row.unit_id, unitCode: row.code, unitName: row.name, people: Number(row.people), rated: Number(row.rated), smallSample: Number(row.small), notRated: Number(row.not_rated), meanScore: numberOf(row.mean), adjustedCount: Number(row.adjusted), openResponseCount: Number(row.open_responses) }));
    });
  }

  /** Whether the unit of a line is reached, for a caller that already holds the line (a decision on an adjustment or a response). */
  async lineUnit(tx: TenantTx, scope: ScoreScope, lineId: string): Promise<{ unitId: string; membershipId: string | null; periodStatus: PeriodRow['status'] } | undefined> {
    await enterScoreScope(tx, scope);
    const rows = await tx.query<{ unit_id_at_period: string; membership_id: string | null; status: PeriodRow['status'] }>(
      `select l.unit_id_at_period, l.membership_id, p.status from ${LINE_FROM} where l.id = $1::uuid`,
      [scoreIdOf(lineId, 'id')],
    );
    return rows[0] === undefined ? undefined : { unitId: rows[0].unit_id_at_period, membershipId: rows[0].membership_id, periodStatus: rows[0].status };
  }
}

interface PeriodSql {
  id: string;
  scope_unit_id: string;
  scope_unit_code: string | null;
  scope_unit_name: string | null;
  period_kind: PeriodRow['periodKind'];
  period_from: string;
  period_to: string;
  status: PeriodRow['status'];
  policy_code: string;
  policy_rule_id: string | null;
  policy_version: number;
  preview_hash: string | null;
  snapshot_hash: string | null;
  summary: PeriodRow['summary'];
  locked_by: string | null;
  locked_at: string | null;
  response_until: string | null;
  official_at: string | null;
  supersedes_period_id: string | null;
  version: number;
  line_count?: string;
  open_response_count?: string;
}

const COUNTS = `(select count(*) from machvon.staff_score_line l where l.tenant_id = p.tenant_id and l.period_id = p.id and l.erased_at is null)::text as line_count,
  (select count(*) from machvon.staff_score_response r join machvon.staff_score_line l on l.tenant_id = r.tenant_id and l.id = r.line_id where r.tenant_id = p.tenant_id and l.period_id = p.id and r.status = 'OPEN')::text as open_response_count`;

const toView = (row: PeriodSql): PeriodView => ({ ...toPeriod(row), lineCount: Number(row.line_count ?? 0), openResponseCount: Number(row.open_response_count ?? 0) });
