import { DomainError, CRITICAL_SCORE, LOW_SCORE_MAX, riskLevelOf, trendOf, versionConflict } from '@machvon/kernel';
import type { RiskAlertType, RiskLevel, RiskSignalKind, Trend } from '@machvon/kernel';
import { idOf, textOf } from './prj-accountability-support.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import { lockProject } from './prj-stage-support.ts';
import type { StageScopes } from './prj-stage-support.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The storage of the risk register scored from live signals (MR-1, MR.02): the lines of `project_risk_signal`, their append-only history, and the alerts that a score crossing a line of the rule raises. The job
 * `risk-rescore` writes through the methods marked "job"; the board, the project view and the alerts are read in the scope of the caller, and an alert is acknowledged by a person with a note.
 */

export const RISK_SIGNAL_RESOURCE = 'project_risk_signal';
export const RISK_ALERT_RESOURCE = 'project_risk_alert';
const HISTORY_PER_PROJECT = 120;
const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";

export interface SignalLine {
  id: string;
  projectId: string;
  signalKind: RiskSignalKind;
  status: 'ACTIVE' | 'CLEARED';
  likelihood: number;
  impact: number;
  score: number;
  evidence: Record<string, unknown>;
  ruleVersion: string;
  ruleUnverified: boolean;
  firstScoredOn: string;
  lastScoredOn: string;
  clearedOn: string | null;
  version: number;
}

interface LineSql {
  id: string;
  project_id: string;
  signal_kind: RiskSignalKind;
  status: 'ACTIVE' | 'CLEARED';
  likelihood: number;
  impact: number;
  score: number;
  evidence: Record<string, unknown>;
  rule_version: string;
  rule_unverified: boolean;
  first_scored_on: string;
  last_scored_on: string;
  cleared_on: string | null;
  version: string;
}

const LINE_COLUMNS = `s.id, s.project_id, s.signal_kind, s.status, s.likelihood::int as likelihood, s.impact::int as impact, s.score::int as score, s.evidence, s.rule_version, s.rule_unverified,
  s.first_scored_on::text as first_scored_on, s.last_scored_on::text as last_scored_on, s.cleared_on::text as cleared_on, s.version::text as version`;

const lineOf = (row: LineSql): SignalLine => ({
  id: row.id,
  projectId: row.project_id,
  signalKind: row.signal_kind,
  status: row.status,
  likelihood: row.likelihood,
  impact: row.impact,
  score: row.score,
  evidence: row.evidence,
  ruleVersion: row.rule_version,
  ruleUnverified: row.rule_unverified,
  firstScoredOn: row.first_scored_on,
  lastScoredOn: row.last_scored_on,
  clearedOn: row.cleared_on,
  version: Number(row.version),
});

export interface LineWrite {
  projectId: string;
  kind: RiskSignalKind;
  likelihood: number;
  impact: number;
  evidence: Record<string, unknown>;
  ruleVersion: string;
  ruleUnverified: boolean;
  today: string;
}

export interface HistoryWrite {
  projectId: string;
  signalId: string;
  kind: RiskSignalKind;
  likelihood: number;
  impact: number;
  priorScore: number | null;
  status: 'ACTIVE' | 'CLEARED';
  evidence: Record<string, unknown>;
  ruleVersion: string;
  today: string;
  actor: string;
}

export interface AlertWrite {
  projectId: string;
  alertType: RiskAlertType;
  subject: { kind: 'SIGNAL'; signalId: string; signalKind: RiskSignalKind } | { kind: 'REGISTER'; riskId: string };
  score: number;
  priorScore: number;
  threshold: number;
  ruleVersion: string;
  ruleUnverified: boolean;
  today: string;
  actor: string;
}

export interface RaisedAlert {
  id: string;
  projectId: string;
  alertType: RiskAlertType;
  subjectKind: 'SIGNAL' | 'REGISTER';
  subjectId: string;
  score: number;
  priorScore: number;
  threshold: number;
}

export interface RegisterCritical {
  riskId: string;
  projectId: string;
  score: number;
  priorScore: number;
}

export interface BoardFilter {
  kind: RiskSignalKind | 'REGISTER' | undefined;
  level: RiskLevel | undefined;
  limit: number;
  after: { code: string; id: string } | undefined;
}

export interface BoardItem {
  origin: 'SIGNAL' | 'REGISTER';
  id: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  kind: string;
  title: string | null;
  likelihood: number;
  impact: number;
  score: number;
  level: RiskLevel;
  previousScore: number | null;
  trend: Trend;
  scoredOn: string;
  evidence: Record<string, unknown>;
  ownerMembershipId: string | null;
  ownerName: string | null;
  alertOpen: boolean;
  ruleUnverified: boolean | null;
  rankKey: string;
}

export interface Board {
  items: BoardItem[];
  /** The live lines and risks of the whole scope by band, whatever the filter and the page. */
  counts: { total: number; critical: number; medium: number; low: number; openAlerts: number };
}

export interface HistoryRow {
  id: string;
  subjectKind: 'SIGNAL' | 'REGISTER';
  signalId: string | null;
  riskId: string | null;
  signalKind: string | null;
  source: 'JOB' | 'MANUAL';
  scoredOn: string;
  likelihood: number;
  impact: number;
  score: number;
  level: RiskLevel;
  priorScore: number | null;
  status: string | null;
  evidence: Record<string, unknown>;
  ruleVersion: string | null;
  scoredAt: string;
}

export interface AlertView {
  id: string;
  projectId: string;
  projectCode: string;
  alertType: RiskAlertType;
  subjectKind: 'SIGNAL' | 'REGISTER';
  subjectId: string;
  signalKind: string | null;
  score: number;
  priorScore: number;
  threshold: number;
  ruleVersion: string;
  ruleUnverified: boolean;
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
  raisedOn: string;
  acknowledgedAt: string | null;
  acknowledgeNote: string | null;
  resolvedOn: string | null;
  version: number;
}

interface AlertSql {
  id: string;
  project_id: string;
  project_code: string;
  alert_type: RiskAlertType;
  subject_kind: 'SIGNAL' | 'REGISTER';
  subject_id: string;
  signal_kind: string | null;
  score: number;
  prior_score: number;
  threshold: number;
  rule_version: string;
  rule_unverified: boolean;
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
  raised_on: string;
  acknowledged_at: string | null;
  acknowledge_note: string | null;
  resolved_on: string | null;
  version: string;
}

const ALERT_COLUMNS = `a.id, a.project_id, p.code as project_code, a.alert_type, a.subject_kind, a.subject_id, a.signal_kind, a.score::int as score, a.prior_score::int as prior_score, a.threshold, a.rule_version, a.rule_unverified,
  a.status, a.raised_on::text as raised_on, to_char(a.acknowledged_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as acknowledged_at, a.acknowledge_note, a.resolved_on::text as resolved_on, a.version::text as version`;

const alertOf = (row: AlertSql): AlertView => ({
  id: row.id,
  projectId: row.project_id,
  projectCode: row.project_code,
  alertType: row.alert_type,
  subjectKind: row.subject_kind,
  subjectId: row.subject_id,
  signalKind: row.signal_kind,
  score: row.score,
  priorScore: row.prior_score,
  threshold: row.threshold,
  ruleVersion: row.rule_version,
  ruleUnverified: row.rule_unverified,
  status: row.status,
  raisedOn: row.raised_on,
  acknowledgedAt: row.acknowledged_at,
  acknowledgeNote: row.acknowledge_note,
  resolvedOn: row.resolved_on,
  version: Number(row.version),
});

/** The score range of a band, from the same constants that give the band its name (the database never repeats a threshold). */
function bandRange(level: RiskLevel): [number, number] {
  return level === 'CRITICAL' ? [CRITICAL_SCORE, 25] : level === 'MEDIUM' ? [LOW_SCORE_MAX + 1, CRITICAL_SCORE - 1] : [1, LOW_SCORE_MAX];
}

export class RiskSignalStore {
  // ---- the job -------------------------------------------------------------------------------------------------------------------------------------------------------------------

  /** The line of a project and a kind, locked for the pass. */
  async lockLine(tx: TenantTx, projectId: string, kind: RiskSignalKind): Promise<SignalLine | undefined> {
    const rows = await tx.query<LineSql>(`select ${LINE_COLUMNS} from machvon.project_risk_signal s where s.project_id = $1::uuid and s.signal_kind = $2 for update`, [projectId, kind]);
    return rows[0] === undefined ? undefined : lineOf(rows[0]);
  }

  /** Every line of the tenant that stood before the pass, by project and kind, so the pass reads them once. */
  async linesOf(tx: TenantTx, projectIds: readonly string[]): Promise<Map<string, SignalLine>> {
    if (projectIds.length === 0) return new Map();
    const rows = await tx.query<LineSql>(`select ${LINE_COLUMNS} from machvon.project_risk_signal s where s.project_id = any($1::uuid[])`, [[...projectIds]]);
    return new Map(rows.map((row) => [`${row.project_id}:${row.signal_kind}`, lineOf(row)]));
  }

  /** A line that is new, or one that was cleared and is open again: the score, the evidence and the rule that decided. A second runner that got there first leaves the line as it is (undefined). */
  async open(tx: TenantTx, write: LineWrite, existing: SignalLine | undefined): Promise<SignalLine | undefined> {
    if (existing === undefined) {
      const rows = await tx.query<LineSql>(
        `insert into machvon.project_risk_signal as s (tenant_id, project_id, signal_kind, status, likelihood, impact, evidence, rule_version, rule_unverified, first_scored_on, last_scored_on)
         values (${TENANT}, $1::uuid, $2, 'ACTIVE', $3, $4, $5::jsonb, $6, $7, $8::date, $8::date)
         on conflict (tenant_id, project_id, signal_kind) do nothing
         returning ${LINE_COLUMNS}`,
        [write.projectId, write.kind, write.likelihood, write.impact, JSON.stringify(write.evidence), write.ruleVersion, write.ruleUnverified, write.today],
      );
      return rows[0] === undefined ? undefined : lineOf(rows[0]);
    }
    const rows = await tx.query<LineSql>(
      `update machvon.project_risk_signal as s set status = 'ACTIVE', likelihood = $2, impact = $3, evidence = $4::jsonb, rule_version = $5, rule_unverified = $6, last_scored_on = $7::date, cleared_on = null,
              updated_at = now(), version = version + 1
        where s.id = $1::uuid returning ${LINE_COLUMNS}`,
      [existing.id, write.likelihood, write.impact, JSON.stringify(write.evidence), write.ruleVersion, write.ruleUnverified, write.today],
    );
    return rows[0] === undefined ? undefined : lineOf(rows[0]);
  }

  /** A line that is active whose score or evidence moved. */
  async rescore(tx: TenantTx, existing: SignalLine, write: LineWrite): Promise<SignalLine> {
    const rows = await tx.query<LineSql>(
      `update machvon.project_risk_signal as s set likelihood = $2, impact = $3, evidence = $4::jsonb, rule_version = $5, rule_unverified = $6, last_scored_on = $7::date, updated_at = now(), version = version + 1
        where s.id = $1::uuid returning ${LINE_COLUMNS}`,
      [existing.id, write.likelihood, write.impact, JSON.stringify(write.evidence), write.ruleVersion, write.ruleUnverified, write.today],
    );
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return lineOf(row);
  }

  /** A line whose signal fell below the opening line: it goes back to likelihood 1 and says the day. */
  async clear(tx: TenantTx, existing: SignalLine, write: LineWrite): Promise<SignalLine> {
    const rows = await tx.query<LineSql>(
      `update machvon.project_risk_signal as s set status = 'CLEARED', likelihood = 1, impact = $2, evidence = $3::jsonb, rule_version = $4, rule_unverified = $5, last_scored_on = $6::date, cleared_on = $6::date,
              updated_at = now(), version = version + 1
        where s.id = $1::uuid returning ${LINE_COLUMNS}`,
      [existing.id, write.impact, JSON.stringify(write.evidence), write.ruleVersion, write.ruleUnverified, write.today],
    );
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return lineOf(row);
  }

  /** The line was read again and nothing moved: only the day it was last looked at (and what it was read from) is kept, once a day, with no new version. */
  async touch(tx: TenantTx, existing: SignalLine, write: LineWrite): Promise<void> {
    if (existing.lastScoredOn >= write.today) return;
    await tx.query(`update machvon.project_risk_signal set last_scored_on = $2::date, evidence = $3::jsonb, updated_at = now() where id = $1::uuid`, [existing.id, write.today, JSON.stringify(write.evidence)]);
  }

  async appendHistory(tx: TenantTx, write: HistoryWrite): Promise<void> {
    await tx.query(
      `insert into machvon.project_risk_score_history (tenant_id, project_id, subject_kind, signal_id, signal_kind, source, scored_on, likelihood, impact, prior_score, status, evidence, rule_version, scored_by)
       values (${TENANT}, $1::uuid, 'SIGNAL', $2::uuid, $3, 'JOB', $4::date, $5, $6, $7, $8, $9::jsonb, $10, $11::uuid)`,
      [write.projectId, write.signalId, write.kind, write.today, write.likelihood, write.impact, write.priorScore, write.status, JSON.stringify(write.evidence), write.ruleVersion, write.actor],
    );
  }

  /** The alert of a crossing, once for a subject, a type and a day (and one standing critical alert at a time): undefined when it was raised before. */
  async raiseAlert(tx: TenantTx, write: AlertWrite): Promise<RaisedAlert | undefined> {
    const signalId = write.subject.kind === 'SIGNAL' ? write.subject.signalId : null;
    const riskId = write.subject.kind === 'REGISTER' ? write.subject.riskId : null;
    const signalKind = write.subject.kind === 'SIGNAL' ? write.subject.signalKind : null;
    const rows = await tx.query<{ id: string; subject_id: string }>(
      `insert into machvon.project_risk_alert (tenant_id, project_id, alert_type, subject_kind, signal_id, risk_id, signal_kind, score, prior_score, threshold, rule_version, rule_unverified, raised_on, raised_by)
       values (${TENANT}, $1::uuid, $2, $3, $4::uuid, $5::uuid, $6, $7, $8, $9, $10, $11, $12::date, $13::uuid)
       on conflict do nothing returning id, subject_id`,
      [write.projectId, write.alertType, write.subject.kind, signalId, riskId, signalKind, write.score, write.priorScore, write.threshold, write.ruleVersion, write.ruleUnverified, write.today, write.actor],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return { id: row.id, projectId: write.projectId, alertType: write.alertType, subjectKind: write.subject.kind, subjectId: row.subject_id, score: write.score, priorScore: write.priorScore, threshold: write.threshold };
  }

  /**
   * The standing critical alerts whose subject is below the line again (a signal line that fell or was cleared, a register risk that was lowered or ended): they end with the day. The line is the one of the rule in force,
   * so a rule that raises the line ends the alerts that no longer reach it.
   */
  async resolveEnded(tx: TenantTx, criticalScore: number, today: string): Promise<string[]> {
    const rows = await tx.query<{ id: string }>(
      `update machvon.project_risk_alert a set status = 'RESOLVED', resolved_on = $2::date, version = a.version + 1
        where a.alert_type = 'RISK_SCORE_CRITICAL' and a.status <> 'RESOLVED'
          and (
            (a.subject_kind = 'SIGNAL' and exists (select 1 from machvon.project_risk_signal s where s.tenant_id = a.tenant_id and s.id = a.signal_id and (s.status = 'CLEARED' or s.score < $1::int)))
            or (a.subject_kind = 'REGISTER' and exists (select 1 from machvon.project_risk r where r.tenant_id = a.tenant_id and r.id = a.risk_id and (r.status in ('CLOSED', 'ACCEPTED') or r.score < $1::int)))
          )
        returning a.id`,
      [criticalScore, today],
    );
    return rows.map((row) => row.id);
  }

  /** The risks that people wrote that are live, in a project the rule scores, at or above the critical line and without a standing critical alert: what a pass raises an alert for. */
  async registerCritical(tx: TenantTx, statuses: readonly string[], criticalScore: number, limit: number): Promise<RegisterCritical[]> {
    const rows = await tx.query<{ risk_id: string; project_id: string; score: number; prior: number | null }>(
      `select r.id as risk_id, r.project_id, r.score::int as score,
              coalesce((select h.prior_score from machvon.project_risk_score_history h where h.tenant_id = r.tenant_id and h.risk_id = r.id order by h.scored_at desc, h.id desc limit 1), 0)::int as prior
         from machvon.project_risk r join machvon.project p on p.tenant_id = r.tenant_id and p.id = r.project_id
        where r.status in ('OPEN', 'MITIGATING', 'ESCALATED') and r.score >= $2::int and p.status = any($1::text[])
          and not exists (select 1 from machvon.project_risk_alert a where a.tenant_id = r.tenant_id and a.risk_id = r.id and a.alert_type = 'RISK_SCORE_CRITICAL' and a.status <> 'RESOLVED')
        order by r.score desc, r.id limit $3`,
      [[...statuses], criticalScore, limit],
    );
    return rows.map((row) => ({ riskId: row.risk_id, projectId: row.project_id, score: row.score, priorScore: Math.min(row.prior ?? 0, row.score - 1) }));
  }

  // ---- the reads -----------------------------------------------------------------------------------------------------------------------------------------------------------------

  /**
   * The board: the live lines scored from signals and the live risks of the register of PRJ-16, in the scope of the caller, the highest score first. Each item carries its score, its band, the score before the last move
   * (so the trend is the server's), the day it was scored and whether an alert is standing on it.
   */
  async board(tx: TenantTx, scope: ScopeBuilder, filter: BoardFilter): Promise<Board> {
    const predicate = scope(1);
    const params: unknown[] = [...predicate.params];
    const next = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const kind = filter.kind === undefined ? null : filter.kind;
    const range = filter.level === undefined ? null : bandRange(filter.level);
    const kindParam = next(kind);
    const lowParam = next(range === null ? null : range[0]);
    const highParam = next(range === null ? null : range[1]);
    const afterKey = next(filter.after?.code ?? null);
    const afterId = next(filter.after?.id ?? null);
    const limitParam = next(filter.limit);
    const signal = `select 'SIGNAL'::text as origin, s.id, p.id as project_id, p.code as project_code, p.name as project_name, s.signal_kind as kind, null::text as title, s.likelihood::int as likelihood, s.impact::int as impact, s.score::int as score,
        s.last_scored_on::text as scored_on, s.evidence, null::uuid as owner_membership_id, s.rule_unverified,
        (select h.prior_score::int from machvon.project_risk_score_history h where h.tenant_id = s.tenant_id and h.signal_id = s.id order by h.scored_at desc, h.id desc limit 1) as previous_score,
        exists (select 1 from machvon.project_risk_alert a where a.tenant_id = s.tenant_id and a.signal_id = s.id and a.status <> 'RESOLVED') as alert_open
       from ${SCOPE_FROM} join machvon.project_risk_signal s on s.tenant_id = p.tenant_id and s.project_id = p.id
      where s.status = 'ACTIVE' and ${predicate.sql}`;
    const register = `select 'REGISTER'::text as origin, r.id, p.id as project_id, p.code as project_code, p.name as project_name, 'REGISTER'::text as kind, r.title, r.likelihood::int as likelihood, r.impact::int as impact, r.score::int as score,
        (r.updated_at at time zone 'Asia/Ho_Chi_Minh')::date::text as scored_on, '{}'::jsonb as evidence, r.owner_membership_id, null::boolean as rule_unverified,
        (select h.prior_score::int from machvon.project_risk_score_history h where h.tenant_id = r.tenant_id and h.risk_id = r.id order by h.scored_at desc, h.id desc limit 1) as previous_score,
        exists (select 1 from machvon.project_risk_alert a where a.tenant_id = r.tenant_id and a.risk_id = r.id and a.status <> 'RESOLVED') as alert_open
       from ${SCOPE_FROM} join machvon.project_risk r on r.tenant_id = p.tenant_id and r.project_id = p.id
      where r.status in ('OPEN', 'MITIGATING', 'ESCALATED') and ${predicate.sql}`;
    const rows = await tx.query<{
      origin: 'SIGNAL' | 'REGISTER';
      id: string;
      project_id: string;
      project_code: string;
      project_name: string;
      kind: string;
      title: string | null;
      likelihood: number;
      impact: number;
      score: number;
      scored_on: string;
      evidence: Record<string, unknown>;
      owner_membership_id: string | null;
      rule_unverified: boolean | null;
      previous_score: number | null;
      alert_open: boolean;
      owner_name: string | null;
      rank_key: string;
    }>(
      `select * from (
         select u.*, d.display_name as owner_name, (lpad((100 - u.score)::text, 3, '0') || '|' || u.project_code || '|' || u.origin || '|' || u.id::text) collate "C" as rank_key
           from (${signal} union all ${register}) u
           left join machvon.tenant_user_directory d on d.tenant_id = ${TENANT} and d.membership_id = u.owner_membership_id
          where (${kindParam}::text is null or u.kind = ${kindParam}::text) and (${lowParam}::int is null or (u.score >= ${lowParam}::int and u.score <= ${highParam}::int))
       ) listed
       where (${afterKey}::text is null or (listed.rank_key, listed.id) > (${afterKey}::text collate "C", ${afterId}::uuid))
       order by listed.rank_key, listed.id limit ${limitParam}`,
      params,
    );
    const counts = await tx.query<{ total: string; critical: string; medium: string; low: string; alerts: string }>(
      `select count(*)::text as total, count(*) filter (where u.score >= ${CRITICAL_SCORE})::text as critical, count(*) filter (where u.score > ${LOW_SCORE_MAX} and u.score < ${CRITICAL_SCORE})::text as medium,
              count(*) filter (where u.score <= ${LOW_SCORE_MAX})::text as low, count(*) filter (where u.alert_open)::text as alerts
         from (${signal} union all ${register}) u`,
      predicate.params,
    );
    const total = counts[0];
    return {
      items: rows.map((row) => {
        const previous = row.previous_score;
        return {
          origin: row.origin,
          id: row.id,
          projectId: row.project_id,
          projectCode: row.project_code,
          projectName: row.project_name,
          kind: row.kind,
          title: row.title,
          likelihood: row.likelihood,
          impact: row.impact,
          score: row.score,
          level: riskLevelOf(row.score),
          previousScore: previous,
          trend: trendOf(previous, row.score),
          scoredOn: row.scored_on,
          evidence: row.evidence,
          ownerMembershipId: row.owner_membership_id,
          ownerName: row.owner_name,
          alertOpen: row.alert_open,
          ruleUnverified: row.rule_unverified,
          rankKey: row.rank_key,
        };
      }),
      counts: { total: Number(total?.total ?? 0), critical: Number(total?.critical ?? 0), medium: Number(total?.medium ?? 0), low: Number(total?.low ?? 0), openAlerts: Number(total?.alerts ?? 0) },
    };
  }

  /** The lines of a project in the scope of the caller, the history of every score in it (the latest first, at most 120 rows) and the alerts on it. A project out of sight is not found. */
  async projectView(tx: TenantTx, scope: ScopeBuilder, projectId: string): Promise<{ project: { id: string; code: string; name: string; status: string }; lines: SignalLine[]; history: HistoryRow[]; alerts: AlertView[] }> {
    const predicate = scope(2);
    const found = await tx.query<{ id: string; code: string; name: string; status: string }>(`select p.id, p.code, p.name, p.status from ${SCOPE_FROM} where p.id = $1::uuid and ${predicate.sql}`, [projectId, ...predicate.params]);
    const project = found[0];
    if (project === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const lines = await tx.query<LineSql>(`select ${LINE_COLUMNS} from machvon.project_risk_signal s where s.project_id = $1::uuid order by s.signal_kind`, [projectId]);
    const history = await tx.query<{
      id: string;
      subject_kind: 'SIGNAL' | 'REGISTER';
      signal_id: string | null;
      risk_id: string | null;
      signal_kind: string | null;
      source: 'JOB' | 'MANUAL';
      scored_on: string;
      likelihood: number;
      impact: number;
      score: number;
      prior_score: number | null;
      status: string | null;
      evidence: Record<string, unknown>;
      rule_version: string | null;
      scored_at: string;
    }>(
      `select h.id, h.subject_kind, h.signal_id, h.risk_id, h.signal_kind, h.source, h.scored_on::text as scored_on, h.likelihood::int as likelihood, h.impact::int as impact, h.score::int as score, h.prior_score::int as prior_score,
              h.status, h.evidence, h.rule_version, to_char(h.scored_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as scored_at
         from machvon.project_risk_score_history h where h.project_id = $1::uuid order by h.scored_at desc, h.id desc limit ${HISTORY_PER_PROJECT}`,
      [projectId],
    );
    const alerts = await tx.query<AlertSql>(`select ${ALERT_COLUMNS} from machvon.project_risk_alert a join machvon.project p on p.tenant_id = a.tenant_id and p.id = a.project_id where a.project_id = $1::uuid order by a.raised_at desc, a.id desc limit 50`, [projectId]);
    return {
      project,
      lines: lines.map(lineOf),
      history: history.map((row) => ({
        id: row.id,
        subjectKind: row.subject_kind,
        signalId: row.signal_id,
        riskId: row.risk_id,
        signalKind: row.signal_kind,
        source: row.source,
        scoredOn: row.scored_on,
        likelihood: row.likelihood,
        impact: row.impact,
        score: row.score,
        level: riskLevelOf(row.score),
        priorScore: row.prior_score,
        status: row.status,
        evidence: row.evidence,
        ruleVersion: row.rule_version,
        scoredAt: row.scored_at,
      })),
      alerts: alerts.map(alertOf),
    };
  }

  /** The alerts in the scope of the caller, the newest first, optionally of one status or one project. */
  async listAlerts(tx: TenantTx, scope: ScopeBuilder, filter: { status?: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED' | undefined; projectId?: string | undefined }, limit: number): Promise<AlertView[]> {
    const predicate = scope(1);
    const base = predicate.params.length;
    const rows = await tx.query<AlertSql>(
      `select ${ALERT_COLUMNS} from machvon.project_risk_alert a join ${SCOPE_FROM} on p.tenant_id = a.tenant_id and p.id = a.project_id
        where ${predicate.sql} and ($${base + 1}::text is null or a.status = $${base + 1}::text) and ($${base + 2}::uuid is null or a.project_id = $${base + 2}::uuid)
        order by a.raised_at desc, a.id desc limit $${base + 3}`,
      [...predicate.params, filter.status ?? null, filter.projectId ?? null, limit],
    );
    return rows.map(alertOf);
  }

  /** A person takes the alert in with a note: OPEN to ACKNOWLEDGED, under the version they saw; any other start is 409 `RISK_ALERT_STATE_INVALID`. */
  async acknowledge(tx: TenantTx, request: { alertId: string; expectedVersion: number; note: unknown; actor: string; scopes: StageScopes }): Promise<AlertView & { classification: string }> {
    const alertId = idOf(request.alertId, 'id');
    const found = await tx.query<{ project_id: string }>('select project_id from machvon.project_risk_alert where id = $1::uuid', [alertId]);
    if (found[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const project = await lockProject(tx, found[0].project_id, request.scopes);
    const rows = await tx.query<AlertSql>(`select ${ALERT_COLUMNS} from machvon.project_risk_alert a join machvon.project p on p.tenant_id = a.tenant_id and p.id = a.project_id where a.id = $1::uuid for update of a`, [alertId]);
    const held = rows[0];
    if (held === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const note = textOf(request.note, 'note', { min: 1, max: 2000, multiline: true });
    if (Number(held.version) !== request.expectedVersion) throw versionConflict(Number(held.version));
    if (held.status !== 'OPEN') throw new DomainError('RISK_ALERT_STATE_INVALID', 409, 'status', { extensions: { status: held.status } });
    const done = await tx.query<AlertSql>(
      `update machvon.project_risk_alert a set status = 'ACKNOWLEDGED', acknowledged_by = $2::uuid, acknowledged_at = now(), acknowledge_note = $3, version = a.version + 1 where a.id = $1::uuid
       returning a.id, a.project_id, $4::text as project_code, a.alert_type, a.subject_kind, a.subject_id, a.signal_kind, a.score::int as score, a.prior_score::int as prior_score, a.threshold, a.rule_version, a.rule_unverified, a.status,
                 a.raised_on::text as raised_on, to_char(a.acknowledged_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as acknowledged_at, a.acknowledge_note, a.resolved_on::text as resolved_on, a.version::text as version`,
      [alertId, request.actor, note, project.code],
    );
    const row = done[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { ...alertOf(row), classification: project.classification };
  }
}
