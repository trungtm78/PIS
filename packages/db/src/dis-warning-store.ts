import { randomUUID } from 'node:crypto';
import { DomainError, OPEN_WARNING_STATUSES, assertFourEyes, dedupeKeyOf, evaluateRule, expectedRatePct, inForce, nextWarningStatus, vietnamDateOf, versionConflict } from '@machvon/kernel';
import type { ProjectFacts, RuleDraft, Violation, WarningAction, WarningMetric, WarningSeverity, WarningStatus } from '@machvon/kernel';
import { DisPeriodStore } from './dis-period-store.ts';
import type { SnapshotRow } from './dis-snapshot-store.ts';
import { DisSnapshotStore } from './dis-snapshot-store.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export const WARNING_RULE_RESOURCE = 'early_warning_rule';
export const WARNING_RESOURCE = 'early_warning';
/** The gauge of the warnings that are still to be handled, by severity (ST-DIS-012). */
export const DIS_WARNING_OPEN_METRIC = 'dis_warning_open_gauge';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const iso = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const OPEN_SQL = OPEN_WARNING_STATUSES.map((status) => `'${status}'`).join(', ');
/** The reports that count as handed in for a period: the project has told the period what it disbursed (a draft, a returned or a withdrawn report has not). */
const HANDED_IN = "'SUBMITTED', 'UNDER_REVIEW', 'ACCEPTED', 'AMENDMENT_REQUESTED', 'SUPERSEDED'";

export type RuleStatus = 'DRAFT' | 'PUBLISHED' | 'RETIRED';

export interface RuleRow {
  id: string;
  ruleCode: string;
  name: string;
  metricCode: WarningMetric;
  comparator: string;
  threshold: Record<string, unknown>;
  severity: WarningSeverity;
  scopeKind: string;
  autoExplanation: boolean;
  legalBasis: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  revision: number;
  status: RuleStatus;
  approvedBy: string | null;
  createdBy: string;
  createdAt: string;
  version: number;
}

interface RuleSql {
  id: string;
  rule_code: string;
  name: string;
  metric_code: WarningMetric;
  comparator: string;
  threshold_json: Record<string, unknown>;
  severity: WarningSeverity;
  scope_kind: string;
  auto_explanation: boolean;
  legal_basis: string;
  effective_from: string;
  effective_until: string | null;
  revision: number;
  status: RuleStatus;
  approved_by: string | null;
  created_by: string;
  created_at: string;
  version: string;
}

const RULE_COLUMNS = `r.id, r.rule_code, r.name, r.metric_code, r.comparator, r.threshold_json, r.severity, r.scope_kind, r.auto_explanation, r.legal_basis, r.effective_from::text as effective_from,
  r.effective_until::text as effective_until, r.revision, r.status, r.approved_by, r.created_by, ${iso('r.created_at')} as created_at, r.version::text as version`;

const toRule = (row: RuleSql): RuleRow => ({
  id: row.id,
  ruleCode: row.rule_code,
  name: row.name,
  metricCode: row.metric_code,
  comparator: row.comparator,
  threshold: row.threshold_json,
  severity: row.severity,
  scopeKind: row.scope_kind,
  autoExplanation: row.auto_explanation,
  legalBasis: row.legal_basis,
  effectiveFrom: row.effective_from,
  effectiveUntil: row.effective_until,
  revision: row.revision,
  status: row.status,
  approvedBy: row.approved_by,
  createdBy: row.created_by,
  createdAt: row.created_at,
  version: Number(row.version),
});

export interface WarningRow {
  id: string;
  ruleId: string;
  ruleCode: string;
  ruleName: string;
  projectId: string | null;
  projectCode: string | null;
  projectName: string | null;
  unitId: string | null;
  periodId: string;
  snapshotId: string;
  severity: WarningSeverity;
  observed: Record<string, unknown>;
  dedupeKey: string;
  status: WarningStatus;
  ownerMembershipId: string | null;
  explanationRequestId: string | null;
  resolutionReason: string | null;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  acknowledgementNote: string | null;
  closedBy: string | null;
  openedAt: string;
  closedAt: string | null;
  version: number;
}

interface WarningSql {
  id: string;
  rule_id: string;
  rule_code: string;
  rule_name: string;
  project_id: string | null;
  project_code: string | null;
  project_name: string | null;
  unit_id: string | null;
  period_id: string;
  snapshot_id: string;
  severity: WarningSeverity;
  observed_json: Record<string, unknown>;
  dedupe_key: string;
  status: WarningStatus;
  owner_membership_id: string | null;
  explanation_request_id: string | null;
  resolution_reason: string | null;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  acknowledgement_note: string | null;
  closed_by: string | null;
  opened_at: string;
  closed_at: string | null;
  version: string;
}

const WARNING_FROM = `machvon.early_warning w
  join machvon.early_warning_rule r on r.tenant_id = w.tenant_id and r.id = w.rule_id
  left join machvon.project p on p.tenant_id = w.tenant_id and p.id = w.project_id`;
const WARNING_COLUMNS = `w.id, w.rule_id, r.rule_code, r.name as rule_name, w.project_id, p.code as project_code, p.name as project_name, w.unit_id, w.period_id, w.snapshot_id, w.severity, w.observed_json,
  w.dedupe_key, w.status, w.owner_membership_id, w.explanation_request_id, w.resolution_reason, w.acknowledged_by, ${iso('w.acknowledged_at')} as acknowledged_at, w.acknowledgement_note, w.closed_by,
  ${iso('w.opened_at')} as opened_at, ${iso('w.closed_at')} as closed_at, w.version::text as version`;

const toWarning = (row: WarningSql): WarningRow => ({
  id: row.id,
  ruleId: row.rule_id,
  ruleCode: row.rule_code,
  ruleName: row.rule_name,
  projectId: row.project_id,
  projectCode: row.project_code,
  projectName: row.project_name,
  unitId: row.unit_id,
  periodId: row.period_id,
  snapshotId: row.snapshot_id,
  severity: row.severity,
  observed: row.observed_json,
  dedupeKey: row.dedupe_key,
  status: row.status,
  ownerMembershipId: row.owner_membership_id,
  explanationRequestId: row.explanation_request_id,
  resolutionReason: row.resolution_reason,
  acknowledgedBy: row.acknowledged_by,
  acknowledgedAt: row.acknowledged_at,
  acknowledgementNote: row.acknowledgement_note,
  closedBy: row.closed_by,
  openedAt: row.opened_at,
  closedAt: row.closed_at,
  version: Number(row.version),
});

/** The rules that every tenant is given as drafts: the thresholds are the working assumption of the design, to be published once the finance office has signed them (DIS BR-DIS-13). */
const SEED_BASIS = 'DIS BR-DIS-13: ngưỡng là giả định làm việc, chờ phòng Tài chính xác nhận trước khi công bố';
export const SEED_RULES: readonly RuleDraft[] = [
  {
    ruleCode: 'EW-01',
    name: 'Tỷ lệ giải ngân lũy kế thấp hơn đường kỳ vọng',
    metricCode: 'YTD_RATE_GAP',
    comparator: 'GTE',
    threshold: { points: '10', critical_points: '20' },
    severity: 'WARNING',
    scopeKind: 'PROJECT',
    autoExplanation: false,
    legalBasis: SEED_BASIS,
    effectiveFrom: '2027-01-01',
    effectiveUntil: null,
  },
  {
    ruleCode: 'EW-02',
    name: 'Chưa gửi báo cáo sau hạn',
    metricCode: 'REPORT_OVERDUE',
    comparator: 'MISSING',
    threshold: { grace_days: 0, explanation_due_days: 3 },
    severity: 'CRITICAL',
    scopeKind: 'PROJECT',
    autoExplanation: true,
    legalBasis: SEED_BASIS,
    effectiveFrom: '2027-01-01',
    effectiveUntil: null,
  },
  {
    ruleCode: 'EW-05',
    name: 'Dự án có vốn nhưng chưa có mã dự án quốc gia',
    metricCode: 'NATIONAL_CODE_MISSING',
    comparator: 'MISSING',
    threshold: {},
    severity: 'WARNING',
    scopeKind: 'PROJECT',
    autoExplanation: false,
    legalBasis: `${SEED_BASIS} [CXN-01]`,
    effectiveFrom: '2027-01-01',
    effectiveUntil: null,
  },
  {
    ruleCode: 'EW-07',
    name: 'Giải ngân trong kỳ âm',
    metricCode: 'PERIOD_DELTA_NEGATIVE',
    comparator: 'LT',
    threshold: {},
    severity: 'WARNING',
    scopeKind: 'PROJECT',
    autoExplanation: false,
    legalBasis: SEED_BASIS,
    effectiveFrom: '2027-01-01',
    effectiveUntil: null,
  },
];

export interface Opened {
  id: string;
  ruleId: string;
  ruleCode: string;
  severity: WarningSeverity;
  projectId: string;
  unitId: string;
  dedupeKey: string;
  autoExplanation: boolean;
  explanationDueDays: number | null;
  observed: Record<string, unknown>;
}

export interface Cleared {
  id: string;
  ruleCode: string;
  projectId: string | null;
  dedupeKey: string;
}

export interface Evaluation {
  /** Why nothing was evaluated, when nothing was. */
  skipped: 'NOT_FROZEN' | 'NOT_CLOSE' | 'SUPERSEDED' | 'OLDER_PERIOD' | undefined;
  rules: number;
  opened: Opened[];
  updated: number;
  cleared: Cleared[];
}

interface FactsRow {
  project_id: string;
  unit_id: string;
  rate_total: string | null;
  plan_total: string;
  delta: string | null;
  has_code: boolean;
  handed_in: boolean;
}

const dayDifference = (later: string, earlier: string): number => Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);

/**
 * The early-warning rules and the warnings of DIS (ST-DIS-012, DIS 3 F7): rules are versioned data that someone other than the author publishes; after a close snapshot is frozen the published rules in
 * force are evaluated over its projects, a violation opens one warning (found again by its dedupe key and updated by the next snapshot), a violation that is gone closes it as AUTO_CLEARED, and a person
 * acknowledges or dismisses what is open, with a reason.
 */
export class DisWarningStore {
  private readonly snapshots = new DisSnapshotStore();
  private readonly periods = new DisPeriodStore();

  async findRule(tx: TenantTx, id: string, lock = false): Promise<RuleRow | undefined> {
    const [row] = await tx.query<RuleSql>(`select ${RULE_COLUMNS} from machvon.early_warning_rule r where r.id = $1::uuid${lock ? ' for update of r' : ''}`, [id]);
    return row === undefined ? undefined : toRule(row);
  }

  /** Every revision of every rule, by code and newest revision first. */
  async listRules(tx: TenantTx): Promise<RuleRow[]> {
    const rows = await tx.query<RuleSql>(`select ${RULE_COLUMNS} from machvon.early_warning_rule r order by r.rule_code, r.revision desc`);
    return rows.map(toRule);
  }

  /** A new revision of a rule (the first when the code is new), as a draft: nothing is evaluated by it before someone else publishes it. */
  async createRuleVersion(tx: TenantTx, draft: RuleDraft, actor: string): Promise<RuleRow> {
    await tx.query(`select pg_advisory_xact_lock(hashtextextended(current_setting('app.tenant_id', true) || ':warning-rule:' || $1, 0))`, [draft.ruleCode]);
    const [next] = await tx.query<{ revision: number }>('select coalesce(max(revision), 0) + 1 as revision from machvon.early_warning_rule where rule_code = $1', [draft.ruleCode]);
    const id = randomUUID();
    await tx.query(
      `insert into machvon.early_warning_rule
         (tenant_id, id, rule_code, name, metric_code, comparator, threshold_json, severity, scope_kind, auto_explanation, legal_basis, effective_from, effective_until, revision, status, created_by, updated_by, version)
       values (${TENANT}, $1::uuid, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11::date, $12::date, $13::int, 'DRAFT', $14::uuid, $14::uuid, 1)`,
      [id, draft.ruleCode, draft.name, draft.metricCode, draft.comparator, JSON.stringify(draft.threshold), draft.severity, draft.scopeKind, draft.autoExplanation, draft.legalBasis, draft.effectiveFrom, draft.effectiveUntil, (next as { revision: number }).revision, actor],
    );
    return (await this.findRule(tx, id)) as RuleRow;
  }

  /**
   * Publishes a draft under the version the screen showed: the person who wrote it does not (403 SELF_APPROVAL_DENIED), a rule that is not a draft is 409, a revision older than the one in force is
   * 409, and the revision that was in force is retired in the same step, so that one revision of a code is published at a time.
   */
  async publish(tx: TenantTx, id: string, expectedVersion: number, actor: string): Promise<{ rule: RuleRow; retiredId: string | null }> {
    // Two drafts of one code are published one after the other: the turn of the code is taken before anything is read, so that neither finds the other half way.
    const peeked = await this.findRule(tx, id);
    if (peeked === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await tx.query(`select pg_advisory_xact_lock(hashtextextended(current_setting('app.tenant_id', true) || ':warning-rule:' || $1, 0))`, [peeked.ruleCode]);
    const current = await this.findRule(tx, id, true);
    if (current === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (current.version !== expectedVersion) throw versionConflict(current.version);
    if (current.status !== 'DRAFT') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status', { extensions: { rule_status: current.status } });
    assertFourEyes(current.createdBy, actor);
    const [inForce] = await tx.query<{ id: string; revision: number }>(`select id, revision from machvon.early_warning_rule where rule_code = $1 and status = 'PUBLISHED' for update`, [current.ruleCode]);
    if (inForce !== undefined && inForce.revision > current.revision) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'revision', { extensions: { published_revision: inForce.revision } });
    if (inForce !== undefined) await tx.query(`update machvon.early_warning_rule set status = 'RETIRED', updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid`, [inForce.id, actor]);
    await tx.query(`update machvon.early_warning_rule set status = 'PUBLISHED', approved_by = $2::uuid, updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid`, [id, actor]);
    return { rule: (await this.findRule(tx, id)) as RuleRow, retiredId: inForce?.id ?? null };
  }

  /** Gives the tenant the four rules of the release as drafts, once: a code that has any revision is left as it is. Returns how many were made. */
  async ensureSeedRules(tx: TenantTx, actor: string): Promise<number> {
    let made = 0;
    for (const seed of SEED_RULES) {
      const [known] = await tx.query<{ n: string }>('select count(*)::text as n from machvon.early_warning_rule where rule_code = $1', [seed.ruleCode]);
      if (Number((known as { n: string }).n) > 0) continue;
      await this.createRuleVersion(tx, seed, actor);
      made += 1;
    }
    return made;
  }

  /** What the evaluation knows of every project of a snapshot, with a query for the whole snapshot and not one for each project. */
  private async factsOf(tx: TenantTx, snapshot: SnapshotRow, deadlineAt: string, now: Date, scope?: ScopeBuilder): Promise<Map<string, { unitId: string; facts: ProjectFacts }>> {
    const visible = scope === undefined ? undefined : scope(3);
    const rows = await tx.query<FactsRow>(
      `select l.project_id, min(l.unit_id::text) as unit_id,
              max(l.rate_total_pct) filter (where l.bucket = 'CURRENT_YEAR' and l.budget_level = 'CENTRAL')::text as rate_total,
              coalesce(sum(l.plan_total_vnd), 0)::text as plan_total, sum(l.period_delta_vnd)::text as delta, (p.national_project_code is not null) as has_code,
              exists (select 1 from machvon.report_revision r where r.tenant_id = l.tenant_id and r.period_id = $2::uuid and r.project_id = l.project_id and r.deleted_at is null and r.status in (${HANDED_IN})) as handed_in
         from machvon.period_snapshot_line l join machvon.project p on p.tenant_id = l.tenant_id and p.id = l.project_id
        where l.snapshot_id = $1::uuid${visible === undefined ? '' : ` and exists (select 1 from ${SCOPE_FROM} where p.id = l.project_id and ${visible.sql})`}
        group by l.project_id, l.tenant_id, p.national_project_code`,
      [snapshot.id, snapshot.periodId, ...(visible?.params ?? [])],
    );
    const expected = expectedRatePct(snapshot.treasuryCutoffDate);
    const pastDeadline = dayDifference(vietnamDateOf(now), vietnamDateOf(new Date(deadlineAt)));
    return new Map(
      rows.map((row) => [
        row.project_id,
        {
          unitId: row.unit_id,
          facts: {
            ratePct: row.rate_total,
            expectedPct: expected,
            reportHandedIn: row.handed_in,
            daysPastDeadline: pastDeadline,
            hasCapital: BigInt(row.plan_total) > 0n,
            hasNationalCode: row.has_code,
            periodDeltaVnd: row.delta,
          } satisfies ProjectFacts,
        },
      ]),
    );
  }

  private async rulesInForce(tx: TenantTx, day: string): Promise<RuleRow[]> {
    const rows = await tx.query<RuleSql>(`select ${RULE_COLUMNS} from machvon.early_warning_rule r where r.status = 'PUBLISHED' and r.scope_kind = 'PROJECT' order by r.rule_code`);
    return rows.map(toRule).filter((rule) => inForce(rule, day));
  }

  /**
   * Evaluates the published rules in force over a frozen close snapshot (the job `dis.warning-evaluate`, after `snapshot.frozen`): a violation opens one OPEN warning under its dedupe key, or updates the
   * one that is open (the figure, the severity, the snapshot it was seen in); a violation that is gone closes the warning as AUTO_CLEARED. A snapshot that is not frozen, is not a close figure or has
   * been replaced by a newer one is left alone: an older figure must not undo a newer one.
   */
  async evaluate(tx: TenantTx, snapshotId: string, now: Date, actor: string): Promise<Evaluation> {
    const none = (skipped: Evaluation['skipped']): Evaluation => ({ skipped, rules: 0, opened: [], updated: 0, cleared: [] });
    const snapshot = await this.snapshots.find(tx, snapshotId);
    if (snapshot === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'snapshot_id');
    if (snapshot.status === 'SUPERSEDED') return none('SUPERSEDED');
    if (snapshot.status !== 'FROZEN') return none('NOT_FROZEN');
    if (snapshot.snapshotKind !== 'PERIOD_CLOSE') return none('NOT_CLOSE');
    const period = await this.periods.find(tx, snapshot.periodId);
    if (period === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'period_id');
    // The warnings of a year are shared by its periods, so the evaluations of a year take turns, and an older period never overwrites what a newer one has said.
    await tx.query(`select pg_advisory_xact_lock(hashtextextended(current_setting('app.tenant_id', true) || ':warning-evaluate:' || $1, 0))`, [String(period.fiscalYear)]);
    const [newer] = await tx.query<{ id: string }>(
      `select s.id from machvon.period_snapshot s join machvon.reporting_period rp on rp.tenant_id = s.tenant_id and rp.id = s.period_id
        where s.status = 'FROZEN' and s.snapshot_kind = 'PERIOD_CLOSE' and rp.fiscal_year = $1 and rp.period_type = $2 and rp.end_date > $3::date limit 1`,
      [period.fiscalYear, period.periodType, period.endDate],
    );
    if (newer !== undefined) return none('OLDER_PERIOD');
    const rules = await this.rulesInForce(tx, snapshot.asOfDate);
    const subjects = await this.factsOf(tx, snapshot, period.deadlineAt, now);
    const violated: Array<{ rule: RuleRow; projectId: string; unitId: string; key: string; violation: Violation }> = [];
    for (const rule of rules) {
      for (const [projectId, subject] of subjects) {
        const violation = evaluateRule({ metricCode: rule.metricCode, severity: rule.severity, threshold: rule.threshold, autoExplanation: rule.autoExplanation }, subject.facts);
        if (violation !== null) violated.push({ rule, projectId, unitId: subject.unitId, key: dedupeKeyOf({ ruleCode: rule.ruleCode, metricCode: rule.metricCode }, projectId, period.fiscalYear, period.id), violation });
      }
    }
    const keys = violated.map((item) => item.key);
    const existing = new Set((await tx.query<{ dedupe_key: string }>(`select dedupe_key from machvon.early_warning where dedupe_key = any($1::text[]) and status in (${OPEN_SQL})`, [keys])).map((row) => row.dedupe_key));
    const fresh = violated.filter((item) => !existing.has(item.key));
    const kept = violated.filter((item) => existing.has(item.key));
    let updated = 0;
    if (kept.length > 0) {
      const rows = await tx.query<{ id: string }>(
        `update machvon.early_warning w set severity = v.severity, observed_json = v.observed, snapshot_id = $2::uuid, updated_at = now(), updated_by = $3::uuid, version = w.version + 1
           from jsonb_to_recordset($1::jsonb) as v(dedupe_key text, severity text, observed jsonb)
          where w.dedupe_key = v.dedupe_key and w.status in (${OPEN_SQL}) returning w.id`,
        [JSON.stringify(kept.map((item) => ({ dedupe_key: item.key, severity: item.violation.severity, observed: item.violation.observed }))), snapshot.id, actor],
      );
      updated = rows.length;
    }
    const opened: Opened[] = [];
    if (fresh.length > 0) {
      const inserted = await tx.query<{ id: string; dedupe_key: string }>(
        `insert into machvon.early_warning (tenant_id, id, rule_id, project_id, unit_id, period_id, snapshot_id, severity, observed_json, dedupe_key, status, created_by, updated_by)
         select ${TENANT}, gen_random_uuid(), v.rule_id, v.project_id, v.unit_id, $2::uuid, $3::uuid, v.severity, v.observed, v.dedupe_key, 'OPEN', $4::uuid, $4::uuid
           from jsonb_to_recordset($1::jsonb) as v(rule_id uuid, project_id uuid, unit_id uuid, severity text, observed jsonb, dedupe_key text)
         on conflict (tenant_id, dedupe_key) where status in (${OPEN_SQL}) do nothing returning id, dedupe_key`,
        [JSON.stringify(fresh.map((item) => ({ rule_id: item.rule.id, project_id: item.projectId, unit_id: item.unitId, severity: item.violation.severity, observed: item.violation.observed, dedupe_key: item.key }))), period.id, snapshot.id, actor],
      );
      const idOf = new Map(inserted.map((row) => [row.dedupe_key, row.id]));
      for (const item of fresh) {
        const id = idOf.get(item.key);
        if (id === undefined) continue;
        opened.push({
          id,
          ruleId: item.rule.id,
          ruleCode: item.rule.ruleCode,
          severity: item.violation.severity,
          projectId: item.projectId,
          unitId: item.unitId,
          dedupeKey: item.key,
          autoExplanation: item.violation.autoExplanation,
          explanationDueDays: item.violation.explanationDueDays,
          observed: item.violation.observed,
        });
      }
    }
    const perPeriod = (rule: RuleRow): boolean => rule.metricCode === 'REPORT_OVERDUE' || rule.metricCode === 'PERIOD_DELTA_NEGATIVE';
    const cleared = await tx.query<{ id: string; dedupe_key: string; project_id: string | null }>(
      `update machvon.early_warning w set status = 'RESOLVED', resolution_reason = 'AUTO_CLEARED', closed_at = now(), updated_at = now(), updated_by = $5::uuid, version = w.version + 1
        where w.status in (${OPEN_SQL}) and split_part(w.dedupe_key, '|', 3) = $4
          and (split_part(w.dedupe_key, '|', 1) = any($1::text[]) or (split_part(w.dedupe_key, '|', 1) = any($2::text[]) and split_part(w.dedupe_key, '|', 4) = $3))
          and w.dedupe_key <> all($6::text[])
        returning w.id, w.dedupe_key, w.project_id`,
      [rules.filter((rule) => !perPeriod(rule)).map((rule) => rule.ruleCode), rules.filter(perPeriod).map((rule) => rule.ruleCode), period.id, String(period.fiscalYear), actor, keys],
    );
    return {
      skipped: undefined,
      rules: rules.length,
      opened,
      updated,
      cleared: cleared.map((row) => ({ id: row.id, ruleCode: row.dedupe_key.split('|')[0] as string, projectId: row.project_id, dedupeKey: row.dedupe_key })),
    };
  }

  /** How many warnings a rule would open on the latest frozen close snapshot, without opening one (the preview of the policy editor). */
  async preview(tx: TenantTx, rule: Pick<RuleDraft, 'metricCode' | 'severity' | 'threshold' | 'autoExplanation'>, now: Date, scope?: ScopeBuilder): Promise<{ snapshotId: string | null; wouldOpen: number }> {
    const snapshot = await this.snapshots.latestFrozen(tx);
    if (snapshot === undefined) return { snapshotId: null, wouldOpen: 0 };
    const period = await this.periods.find(tx, snapshot.periodId);
    if (period === undefined) return { snapshotId: snapshot.id, wouldOpen: 0 };
    const subjects = await this.factsOf(tx, snapshot, period.deadlineAt, now, scope);
    let wouldOpen = 0;
    for (const subject of subjects.values()) if (evaluateRule(rule, subject.facts) !== null) wouldOpen += 1;
    return { snapshotId: snapshot.id, wouldOpen };
  }

  /** The warnings still to be handled, counted by severity: what the gauge reports. */
  async openCounts(tx: TenantTx): Promise<Array<{ severity: WarningSeverity; count: number }>> {
    const rows = await tx.query<{ severity: WarningSeverity; n: string }>(`select severity, count(*)::text as n from machvon.early_warning where status in (${OPEN_SQL}) group by severity`);
    return rows.map((row) => ({ severity: row.severity, count: Number(row.n) }));
  }

  async find(tx: TenantTx, id: string, scope?: ScopeBuilder, lock = false): Promise<WarningRow | undefined> {
    const visible = scope === undefined ? undefined : scope(2);
    const [row] = await tx.query<WarningSql>(
      `select ${WARNING_COLUMNS} from ${WARNING_FROM} where w.id = $1::uuid${visible === undefined ? '' : ` and exists (select 1 from ${SCOPE_FROM} where p.id = w.project_id and ${visible.sql})`}${lock ? ' for update of w' : ''}`,
      [id, ...(visible?.params ?? [])],
    );
    return row === undefined ? undefined : toWarning(row);
  }

  /** The warnings of the projects in scope, the newest first, a page at a time; the cursor is the day it was opened and the id. */
  async list(
    tx: TenantTx,
    scope: ScopeBuilder,
    filter: { status?: string | undefined; severity?: string | undefined; ruleCode?: string | undefined; projectId?: string | undefined; unitId?: string | undefined },
    page: { limit: number; after: { openedAt: string; id: string } | undefined },
  ): Promise<WarningRow[]> {
    const visible = scope(9);
    const rows = await tx.query<WarningSql>(
      `select ${WARNING_COLUMNS} from ${WARNING_FROM}
        where ($1::text is null or w.status = $1) and ($2::text is null or w.severity = $2) and ($3::text is null or r.rule_code = $3) and ($4::uuid is null or w.project_id = $4::uuid)
          and ($5::uuid is null or w.unit_id = $5::uuid) and ($6::timestamptz is null or (date_trunc('milliseconds', w.opened_at), w.id) < ($6::timestamptz, $7::uuid))
          and exists (select 1 from ${SCOPE_FROM} where p.id = w.project_id and ${visible.sql})
        order by date_trunc('milliseconds', w.opened_at) desc, w.id desc limit $8`,
      [filter.status ?? null, filter.severity ?? null, filter.ruleCode ?? null, filter.projectId ?? null, filter.unitId ?? null, page.after?.openedAt ?? null, page.after?.id ?? null, page.limit, ...visible.params],
    );
    return rows.map(toWarning);
  }

  /**
   * Acknowledges or dismisses a warning of a project in scope under the version the screen showed, with a reason: a warning outside the scope is 404, a version that moved is 409, a status that does
   * not allow the action is 409 WARNING_STATE_INVALID. An owner named for the warning must be a member of the tenant.
   */
  async handle(
    tx: TenantTx,
    id: string,
    action: WarningAction,
    input: { expectedVersion: number; actor: string; reason: string; ownerMembershipId?: string | undefined; scope: ScopeBuilder },
  ): Promise<{ before: WarningStatus; warning: WarningRow }> {
    const current = await this.find(tx, id, input.scope, true);
    if (current === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (current.version !== input.expectedVersion) throw versionConflict(current.version);
    const status = nextWarningStatus(current.status, action);
    if (input.ownerMembershipId !== undefined) {
      const [member] = await tx.query<{ id: string }>(`select id from machvon.membership where id = $1::uuid and status = 'Active'`, [input.ownerMembershipId]);
      if (member === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'owner_membership_id');
    }
    if (action === 'acknowledge') {
      await tx.query(
        `update machvon.early_warning set status = $2, acknowledged_by = $3::uuid, acknowledged_at = now(), acknowledgement_note = $4, owner_membership_id = coalesce($5::uuid, owner_membership_id), updated_at = now(), updated_by = $3::uuid, version = version + 1
          where id = $1::uuid`,
        [id, status, input.actor, input.reason, input.ownerMembershipId ?? null],
      );
    } else {
      await tx.query(
        `update machvon.early_warning set status = $2, resolution_reason = $4, closed_at = now(), closed_by = $3::uuid, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid`,
        [id, status, input.actor, input.reason],
      );
    }
    return { before: current.status, warning: (await this.find(tx, id)) as WarningRow };
  }
}
