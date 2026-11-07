import { HOME_OPEN_WARNING_STATUSES } from './home-store.ts';
import type { ActiveOverride, RagBand, RagColor, RagEvaluation, UnitFacts } from '@machvon/kernel';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/** A unit with what is known of it on the day of a snapshot. */
export interface UnitReadingInput {
  unitId: string;
  code: string;
  name: string;
  facts: UnitFacts;
}

export interface StoredScore {
  weekStart: string;
  unitId: string;
  snapshotId: string;
  asOfDate: string;
  score: number | null;
  band: RagBand;
  coveragePct: number;
  criticalWarnings: number | null;
  overdueExplanations: number | null;
  breakdown: Record<string, unknown>;
  ruleVersions: Record<string, number>;
  unverified: boolean;
  computedAt: string;
}

export interface OverrideLine {
  id: string;
  unitId: string;
  action: 'SET' | 'REVOKE';
  band: RagColor | null;
  ruleBand: RagBand | null;
  until: string | null;
  reason: string;
  actor: { id: string; name: string };
  at: string;
}

const ISO = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const countOf = (value: string | undefined): number => Number(value ?? 0);

interface ScoreSql {
  week_start: string;
  unit_id: string;
  snapshot_id: string;
  as_of_date: string;
  score: string | null;
  band: RagBand;
  coverage_pct: string;
  critical_warnings: number | null;
  overdue_explanations: number | null;
  breakdown: Record<string, unknown>;
  rule_versions: Record<string, number>;
  unverified: boolean;
  computed_at: string;
}

const SCORE_COLUMNS = `s.week_start::text as week_start, s.unit_id, s.snapshot_id, s.as_of_date::text as as_of_date, s.score::text as score, s.band, s.coverage_pct::text as coverage_pct, s.critical_warnings, s.overdue_explanations,
  s.breakdown, s.rule_versions, s.unverified, ${ISO('s.computed_at')} as computed_at`;

const toScore = (row: ScoreSql): StoredScore => ({
  weekStart: row.week_start,
  unitId: row.unit_id,
  snapshotId: row.snapshot_id,
  asOfDate: row.as_of_date,
  score: row.score === null ? null : Number(row.score),
  band: row.band,
  coveragePct: Number(row.coverage_pct),
  criticalWarnings: row.critical_warnings,
  overdueExplanations: row.overdue_explanations,
  breakdown: row.breakdown,
  ruleVersions: row.rule_versions,
  unverified: row.unverified,
  computedAt: row.computed_at,
});

/**
 * What the explainable colour of a unit is made of (G3-2): the facts of each unit on the day of a snapshot (read from the lines of the snapshot and the open work of DIS), the weekly rows with the breakdown of the score,
 * and the overrides of people. The colour itself is judged by the kernel (`evaluateRag`); this store reads and writes, and a count it cannot read is an error, never zero.
 */
export class AnalyticsRagStore {
  /**
   * The units of the scope with what they hold: the projects and the sums of their lines in the snapshot (the year plan), and the critical warnings and overdue explanations open in them. `unitScope` is the units the
   * reader may read (alias `u`); a unit is read whole, whatever the projects the reader may read, because the colour of a unit is the unit's.
   */
  async unitReadings(tx: TenantTx, snapshotId: string, unitScope: ScopeBuilder, now: Date): Promise<UnitReadingInput[]> {
    const visible = unitScope(2);
    const units = await tx.query<{ id: string; code: string | null; name: string; projects: string; no_data: string; plan_pm: string; treasury: string | null; all_none: boolean }>(
      `select u.id, u.code, u.name, count(*)::text as projects, count(*) filter (where pp.all_none)::text as no_data, coalesce(sum(pp.plan_pm), 0)::text as plan_pm,
              sum(pp.treasury)::text as treasury, coalesce(bool_and(pp.all_none), true) as all_none
         from (select l.unit_id, l.project_id, sum(l.plan_pm_assigned_vnd) as plan_pm, sum(l.disbursed_treasury_vnd) as treasury, bool_and(l.treasury_coverage = 'NONE') as all_none
                 from machvon.period_snapshot_line l where l.snapshot_id = $1::uuid and l.bucket = 'CURRENT_YEAR' group by l.unit_id, l.project_id) pp
         join machvon.organization_unit u on u.id = pp.unit_id
        where ${visible.sql}
        group by u.id, u.code, u.name
        order by u.code nulls last, u.id`,
      [snapshotId, ...visible.params],
    );
    if (units.length === 0) return [];
    const ids = units.map((unit) => unit.id);
    const critical = await tx.query<{ unit_id: string; n: string }>(
      `select x.unit_id, count(*)::text as n from (
         select p.owner_unit_id as unit_id from machvon.early_warning w join machvon.project p on p.tenant_id = w.tenant_id and p.id = w.project_id where w.severity = 'CRITICAL' and w.status = any($1::text[])
         union all
         select w.unit_id from machvon.early_warning w where w.project_id is null and w.unit_id is not null and w.severity = 'CRITICAL' and w.status = any($1::text[])
       ) x where x.unit_id = any($2::uuid[]) group by x.unit_id`,
      [HOME_OPEN_WARNING_STATUSES, ids],
    );
    const overdueTest = `(e.status = 'OVERDUE' or (e.status in ('REQUESTED', 'RETURNED', 'RESPONDED') and e.due_at < $2::timestamptz))`;
    const overdue = await tx.query<{ unit_id: string; n: string }>(
      `select x.unit_id, count(*)::text as n from (
         select p.owner_unit_id as unit_id from machvon.explanation_request e join machvon.project p on p.tenant_id = e.tenant_id and p.id = e.project_id where ${overdueTest}
         union all
         select e.unit_id from machvon.explanation_request e where e.project_id is null and e.unit_id is not null and ${overdueTest}
       ) x where x.unit_id = any($1::uuid[]) group by x.unit_id`,
      [ids, now.toISOString()],
    );
    const criticalBy = new Map(critical.map((row) => [row.unit_id, countOf(row.n)]));
    const overdueBy = new Map(overdue.map((row) => [row.unit_id, countOf(row.n)]));
    return units.map((unit) => ({
      unitId: unit.id,
      code: unit.code ?? '',
      name: unit.name,
      facts: {
        projects: countOf(unit.projects),
        projectsWithoutData: countOf(unit.no_data),
        planPmVnd: unit.plan_pm,
        treasuryVnd: unit.all_none ? null : unit.treasury,
        criticalWarnings: criticalBy.get(unit.id) ?? 0,
        overdueExplanations: overdueBy.get(unit.id) ?? 0,
      },
    }));
  }

  /** Writes the rows of a week once: a unit that already has its row for the week keeps it (the week is frozen, so a second run of the job writes nothing). Returns how many rows were new. */
  async saveScores(
    tx: TenantTx,
    input: { weekStart: string; snapshotId: string; asOfDate: string; computedBy: string; versions: Record<string, number>; unverified: boolean; rows: ReadonlyArray<{ unitId: string; evaluation: RagEvaluation; facts: UnitFacts }> },
  ): Promise<number> {
    let written = 0;
    for (const row of input.rows) {
      const inserted = await tx.query<{ id: string }>(
        `insert into machvon.early_warning_score (tenant_id, week_start, unit_id, snapshot_id, as_of_date, score, band, coverage_pct, critical_warnings, overdue_explanations, breakdown, rule_versions, unverified, computed_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::date, $2::uuid, $3::uuid, $4::date, $5::numeric, $6, $7::numeric, $8::int, $9::int, $10::jsonb, $11::jsonb, $12, $13::uuid)
         on conflict (tenant_id, week_start, unit_id) do nothing returning id`,
        [
          input.weekStart,
          row.unitId,
          input.snapshotId,
          input.asOfDate,
          row.evaluation.score,
          row.evaluation.band,
          row.evaluation.coveragePct,
          row.facts.criticalWarnings,
          row.facts.overdueExplanations,
          JSON.stringify({ factors: row.evaluation.factors, reasons: row.evaluation.reasons.map((reason) => reason.code), facts: row.facts }),
          JSON.stringify(input.versions),
          input.unverified,
          input.computedBy,
        ],
      );
      written += inserted.length;
    }
    return written;
  }

  async hasWeek(tx: TenantTx, weekStart: string): Promise<boolean> {
    const rows = await tx.query<{ n: string }>('select count(*)::text as n from machvon.early_warning_score where week_start = $1::date', [weekStart]);
    return countOf(rows[0]?.n) > 0;
  }

  /** The rows of a week for the units the reader may read. */
  async scoresOfWeek(tx: TenantTx, weekStart: string, unitScope: ScopeBuilder): Promise<StoredScore[]> {
    const visible = unitScope(2);
    const rows = await tx.query<ScoreSql>(
      `select ${SCORE_COLUMNS} from machvon.early_warning_score s join machvon.organization_unit u on u.tenant_id = s.tenant_id and u.id = s.unit_id where s.week_start = $1::date and ${visible.sql} order by u.code nulls last, s.unit_id`,
      [weekStart, ...visible.params],
    );
    return rows.map(toScore);
  }

  /** The latest rows of each of the units, a number of weeks back from `weekStart` (inclusive), newest first, for the units the reader may read. */
  async history(tx: TenantTx, weekStart: string, weeks: number, unitScope: ScopeBuilder): Promise<StoredScore[]> {
    const visible = unitScope(3);
    const rows = await tx.query<ScoreSql>(
      `select ${SCORE_COLUMNS} from machvon.early_warning_score s join machvon.organization_unit u on u.tenant_id = s.tenant_id and u.id = s.unit_id
        where s.week_start <= $1::date and s.week_start > ($1::date - ($2::int * 7)) and ${visible.sql} order by s.week_start desc, u.code nulls last, s.unit_id`,
      [weekStart, weeks, ...visible.params],
    );
    return rows.map(toScore);
  }

  // ---- overrides ----------------------------------------------------------------------------------------------------------------------------------

  /** The override in force for each unit on the day: the latest line of the unit, when it is a SET whose last day has not passed. */
  async activeOverrides(tx: TenantTx, unitIds: readonly string[], today: string): Promise<Map<string, ActiveOverride & { ruleBand: RagBand | null }>> {
    const result = new Map<string, ActiveOverride & { ruleBand: RagBand | null }>();
    if (unitIds.length === 0) return result;
    const rows = await tx.query<{ unit_id: string; action: 'SET' | 'REVOKE'; band: RagColor | null; rule_band: RagBand | null; until: string | null; reason: string; actor_membership_id: string; actor_name: string | null; created_at: string }>(
      `select distinct on (o.unit_id) o.unit_id, o.action, o.band, o.rule_band, o.until::text as until, o.reason, o.actor_membership_id, d.display_name as actor_name, ${ISO('o.created_at')} as created_at
         from machvon.rag_override o left join machvon.tenant_user_directory d on d.tenant_id = o.tenant_id and d.membership_id = o.actor_membership_id
        where o.unit_id = any($1::uuid[]) order by o.unit_id, o.created_at desc, o.id desc`,
      [unitIds],
    );
    for (const row of rows) {
      if (row.action !== 'SET' || row.band === null || row.until === null || row.until < today) continue;
      result.set(row.unit_id, { band: row.band, reason: row.reason, until: row.until, by: row.actor_name ?? row.actor_membership_id, at: row.created_at, ruleBand: row.rule_band });
    }
    return result;
  }

  async overrideLog(tx: TenantTx, unitId: string, limit = 50): Promise<OverrideLine[]> {
    const rows = await tx.query<{ id: string; unit_id: string; action: 'SET' | 'REVOKE'; band: RagColor | null; rule_band: RagBand | null; until: string | null; reason: string; actor_membership_id: string; actor_name: string | null; created_at: string }>(
      `select o.id, o.unit_id, o.action, o.band, o.rule_band, o.until::text as until, o.reason, o.actor_membership_id, d.display_name as actor_name, ${ISO('o.created_at')} as created_at
         from machvon.rag_override o left join machvon.tenant_user_directory d on d.tenant_id = o.tenant_id and d.membership_id = o.actor_membership_id
        where o.unit_id = $1::uuid order by o.created_at desc, o.id desc limit $2`,
      [unitId, limit],
    );
    return rows.map((row) => ({ id: row.id, unitId: row.unit_id, action: row.action, band: row.band, ruleBand: row.rule_band, until: row.until, reason: row.reason, actor: { id: row.actor_membership_id, name: row.actor_name ?? '' }, at: row.created_at }));
  }

  async recordOverride(tx: TenantTx, input: { unitId: string; action: 'SET' | 'REVOKE'; band?: RagColor | undefined; ruleBand?: RagBand | undefined; until?: string | undefined; reason: string; actor: string }): Promise<{ id: string }> {
    const [row] = await tx.query<{ id: string }>(
      `insert into machvon.rag_override (tenant_id, unit_id, action, band, rule_band, until, reason, actor_membership_id)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4, $5::date, $6, $7::uuid) returning id`,
      [input.unitId, input.action, input.band ?? null, input.ruleBand ?? null, input.until ?? null, input.reason, input.actor],
    );
    return { id: (row as { id: string }).id };
  }

  /** The latest frozen snapshot of the kind before the week of the current one (the week before, or the nearest one earlier), for "what changed since last week". */
  async previousFrozenSnapshotId(tx: TenantTx, beforeDay: string): Promise<{ id: string; asOfDate: string } | undefined> {
    const [row] = await tx.query<{ id: string; as_of_date: string }>(
      `select s.id, s.as_of_date::text as as_of_date from machvon.period_snapshot s where s.status = 'FROZEN' and s.snapshot_kind = 'PERIOD_CLOSE' and s.as_of_date < $1::date order by s.as_of_date desc, s.frozen_at desc, s.id desc limit 1`,
      [beforeDay],
    );
    return row === undefined ? undefined : { id: row.id, asOfDate: row.as_of_date };
  }
}
