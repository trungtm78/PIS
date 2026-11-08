import { DECISION_RULE_CODE, DECISION_RULE_TYPE, decisionPolicyOf } from '@machvon/kernel';
import type { DecisionOutcome, DecisionPolicy, DecisionSubjectKind } from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import { policyVersionOf } from './home-work-policy.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const ISO = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
export const DECISION_RESOURCE = 'analytics_decision';
export const DECISION_LIST_MAX = 100;

export interface DecisionPolicyReading {
  policy: DecisionPolicy;
  version: string;
  unverified: boolean;
}

export interface NewDecision {
  subjectKind: DecisionSubjectKind;
  metricCode: string | null;
  unitId: string | null;
  workSource: string | null;
  workSourceId: string | null;
  subjectTitle: string | null;
  decisionKind: string;
  reason: string;
  figures: Record<string, unknown>;
  figuresSha256: string;
  snapshotId: string | null;
  asOfDate: string | null;
  ruleVersions: Record<string, string>;
  unverified: boolean;
  followUpOwnerId: string | null;
  followUpDue: string | null;
  decidedBy: string;
}

export interface AnalyticsDecisionRow {
  id: string;
  subjectKind: DecisionSubjectKind;
  metricCode: string | null;
  unitId: string | null;
  unitName: string | null;
  workSource: string | null;
  workSourceId: string | null;
  subjectTitle: string | null;
  decisionKind: string;
  reason: string;
  figures: Record<string, unknown>;
  figuresSha256: string;
  snapshotId: string | null;
  asOfDate: string | null;
  ruleVersions: Record<string, string>;
  unverified: boolean;
  followUpOwner: { id: string; name: string } | null;
  followUpDue: string | null;
  decidedBy: { id: string; name: string };
  decidedAt: string;
  latestOutcome: DecisionOutcome | null;
  outcomeCount: number;
}

export interface OutcomeRow {
  id: string;
  decisionId: string;
  outcome: DecisionOutcome;
  note: string;
  supersededBy: string | null;
  actor: { id: string; name: string };
  at: string;
}

export interface DecisionFilter {
  subjectKind?: DecisionSubjectKind | undefined;
  metricCode?: string | undefined;
  decisionKind?: string | undefined;
  decidedBy?: string | undefined;
  workSource?: string | undefined;
  workSourceId?: string | undefined;
  /** Only the decisions whose follow-up is not closed (a day set, the latest outcome is not RESOLVED or SUPERSEDED). */
  openFollowUp?: boolean | undefined;
  /** The opaque cursor of the page before: `<decided_at>|<id>`. */
  cursor?: string | undefined;
  limit: number;
}

interface Sql {
  id: string;
  subject_kind: DecisionSubjectKind;
  metric_code: string | null;
  unit_id: string | null;
  unit_name: string | null;
  work_source: string | null;
  work_source_id: string | null;
  subject_title: string | null;
  decision_kind: string;
  reason: string;
  figures: Record<string, unknown>;
  figures_sha256: string;
  snapshot_id: string | null;
  as_of_date: string | null;
  rule_versions: Record<string, string>;
  unverified: boolean;
  follow_up_owner_id: string | null;
  follow_up_owner_name: string | null;
  follow_up_due: string | null;
  decided_by: string;
  decided_by_name: string | null;
  decided_at: string;
  latest_outcome: DecisionOutcome | null;
  outcome_count: string;
}

const COLUMNS = `d.id, d.subject_kind, d.metric_code, d.unit_id, u.name as unit_name, d.work_source, d.work_source_id, d.subject_title, d.decision_kind, d.reason, d.figures, d.figures_sha256, d.snapshot_id,
  d.as_of_date::text as as_of_date, d.rule_versions, d.unverified, d.follow_up_owner_id, fo.display_name as follow_up_owner_name, d.follow_up_due::text as follow_up_due, d.decided_by, db.display_name as decided_by_name,
  ${ISO('d.decided_at')} as decided_at, lo.outcome as latest_outcome, coalesce(oc.n, 0)::text as outcome_count`;

const FROM = `machvon.analytics_decision d
  left join machvon.organization_unit u on u.tenant_id = d.tenant_id and u.id = d.unit_id
  left join machvon.tenant_user_directory db on db.tenant_id = d.tenant_id and db.membership_id = d.decided_by
  left join machvon.tenant_user_directory fo on fo.tenant_id = d.tenant_id and fo.membership_id = d.follow_up_owner_id
  left join lateral (select o.outcome from machvon.analytics_decision_outcome o where o.tenant_id = d.tenant_id and o.decision_id = d.id order by o.created_at desc, o.id desc limit 1) lo on true
  left join lateral (select count(*) as n from machvon.analytics_decision_outcome o where o.tenant_id = d.tenant_id and o.decision_id = d.id) oc on true`;

const toRow = (row: Sql): AnalyticsDecisionRow => ({
  id: row.id,
  subjectKind: row.subject_kind,
  metricCode: row.metric_code,
  unitId: row.unit_id,
  unitName: row.unit_name,
  workSource: row.work_source,
  workSourceId: row.work_source_id,
  subjectTitle: row.subject_title,
  decisionKind: row.decision_kind,
  reason: row.reason,
  figures: row.figures,
  figuresSha256: row.figures_sha256,
  snapshotId: row.snapshot_id,
  asOfDate: row.as_of_date,
  ruleVersions: row.rule_versions,
  unverified: row.unverified,
  followUpOwner: row.follow_up_owner_id === null ? null : { id: row.follow_up_owner_id, name: row.follow_up_owner_name ?? '' },
  followUpDue: row.follow_up_due,
  decidedBy: { id: row.decided_by, name: row.decided_by_name ?? '' },
  decidedAt: row.decided_at,
  latestOutcome: row.latest_outcome,
  outcomeCount: Number(row.outcome_count),
});

/**
 * The decision log (G3-6): decisions with the figures frozen at their moment, and the outcomes added later. It reads and writes; what a decision means is the kernel's (`checkDecision`). A reader sees the decisions
 * they made, the decisions about the units they may read, and (with a grant on the whole tenant) the decisions that name no unit; a person who may not read a decision gets no row, never a refusal that names it.
 */
export class AnaDecisionStore {
  private readonly port: GovernancePolicyPort;

  constructor(port: GovernancePolicyPort = new GovernancePolicyPort()) {
    this.port = port;
  }

  async policy(tx: TenantTx, asOf: string | Date): Promise<DecisionPolicyReading> {
    const rule = await this.port.require(tx, DECISION_RULE_TYPE, DECISION_RULE_CODE, asOf);
    return { policy: decisionPolicyOf(rule.params), version: policyVersionOf(rule), unverified: rule.unverified };
  }

  async memberExists(tx: TenantTx, membershipId: string): Promise<boolean> {
    const [row] = await tx.query<{ n: string }>('select count(*)::text as n from machvon.membership where id = $1::uuid', [membershipId]);
    return Number(row?.n ?? 0) > 0;
  }

  async insert(tx: TenantTx, input: NewDecision): Promise<{ id: string; decidedAt: string }> {
    const [row] = await tx.query<{ id: string; decided_at: string }>(
      `insert into machvon.analytics_decision (tenant_id, subject_kind, metric_code, unit_id, work_source, work_source_id, subject_title, decision_kind, reason, figures, figures_sha256, snapshot_id, as_of_date,
                                               rule_versions, unverified, follow_up_owner_id, follow_up_due, decided_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3::uuid, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::uuid, $12::date, $13::jsonb, $14, $15::uuid, $16::date, $17::uuid)
       returning id, ${ISO('decided_at')} as decided_at`,
      [
        input.subjectKind,
        input.metricCode,
        input.unitId,
        input.workSource,
        input.workSourceId,
        input.subjectTitle,
        input.decisionKind,
        input.reason,
        JSON.stringify(input.figures),
        input.figuresSha256,
        input.snapshotId,
        input.asOfDate,
        JSON.stringify(input.ruleVersions),
        input.unverified,
        input.followUpOwnerId,
        input.followUpDue,
        input.decidedBy,
      ],
    );
    const inserted = row as { id: string; decided_at: string };
    return { id: inserted.id, decidedAt: inserted.decided_at };
  }

  /** The visibility predicate: the reader's own decisions, those of the units they may read, and those that name no unit when their grant is on the whole tenant. */
  private visible(unitScope: ScopeBuilder, membershipId: string, wholeTenant: boolean, first: number): { sql: string; params: unknown[] } {
    const scope = unitScope(first + 1);
    return {
      sql: `(d.decided_by = $${first}::uuid or d.follow_up_owner_id = $${first}::uuid or (d.unit_id is null and ${wholeTenant ? 'true' : 'false'}) or (d.unit_id is not null and exists (select 1 from machvon.organization_unit u where u.id = d.unit_id and ${scope.sql})))`,
      params: [membershipId, ...scope.params],
    };
  }

  async find(tx: TenantTx, id: string, unitScope: ScopeBuilder, membershipId: string, wholeTenant: boolean): Promise<AnalyticsDecisionRow | undefined> {
    const visible = this.visible(unitScope, membershipId, wholeTenant, 2);
    const [row] = await tx.query<Sql>(`select ${COLUMNS} from ${FROM} where d.id = $1::uuid and ${visible.sql}`, [id, ...visible.params]);
    return row === undefined ? undefined : toRow(row);
  }

  async list(tx: TenantTx, filter: DecisionFilter, unitScope: ScopeBuilder, membershipId: string, wholeTenant: boolean, today: string): Promise<{ rows: AnalyticsDecisionRow[]; nextCursor: string | null }> {
    const visible = this.visible(unitScope, membershipId, wholeTenant, 12);
    const [cursorAt, cursorId] = filter.cursor === undefined ? [null, null] : filter.cursor.split('|');
    const rows = await tx.query<Sql>(
      `select ${COLUMNS} from ${FROM}
        where ($1::text is null or d.subject_kind = $1) and ($2::text is null or d.metric_code = $2) and ($3::text is null or d.decision_kind = $3) and ($4::uuid is null or d.decided_by = $4::uuid)
          and ($5::text is null or d.work_source = $5) and ($6::text is null or d.work_source_id = $6)
          and (not $7::boolean or (d.follow_up_due is not null and coalesce(lo.outcome, 'STILL_OPEN') not in ('RESOLVED', 'SUPERSEDED') and $8::date is not null))
          and ($10::timestamptz is null or (d.decided_at, d.id) < ($10::timestamptz, $11::uuid))
          and ${visible.sql}
        order by d.decided_at desc, d.id desc limit $9`,
      [filter.subjectKind ?? null, filter.metricCode ?? null, filter.decisionKind ?? null, filter.decidedBy ?? null, filter.workSource ?? null, filter.workSourceId ?? null, filter.openFollowUp === true, today, filter.limit + 1, cursorAt ?? null, cursorId ?? null, ...visible.params],
    );
    const page = rows.slice(0, filter.limit).map(toRow);
    const last = page[page.length - 1];
    return { rows: page, nextCursor: rows.length > filter.limit && last !== undefined ? `${last.decidedAt}|${last.id}` : null };
  }

  async outcomes(tx: TenantTx, decisionId: string): Promise<OutcomeRow[]> {
    const rows = await tx.query<{ id: string; decision_id: string; outcome: DecisionOutcome; note: string; superseded_by: string | null; actor_membership_id: string; actor_name: string | null; created_at: string }>(
      `select o.id, o.decision_id, o.outcome, o.note, o.superseded_by, o.actor_membership_id, d.display_name as actor_name, ${ISO('o.created_at')} as created_at
         from machvon.analytics_decision_outcome o left join machvon.tenant_user_directory d on d.tenant_id = o.tenant_id and d.membership_id = o.actor_membership_id
        where o.decision_id = $1::uuid order by o.created_at, o.id`,
      [decisionId],
    );
    return rows.map((row) => ({ id: row.id, decisionId: row.decision_id, outcome: row.outcome, note: row.note, supersededBy: row.superseded_by, actor: { id: row.actor_membership_id, name: row.actor_name ?? '' }, at: row.created_at }));
  }

  async insertOutcome(tx: TenantTx, input: { decisionId: string; outcome: DecisionOutcome; note: string; supersededBy: string | null; actor: string }): Promise<{ id: string }> {
    const [row] = await tx.query<{ id: string }>(
      `insert into machvon.analytics_decision_outcome (tenant_id, decision_id, outcome, note, superseded_by, actor_membership_id)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4::uuid, $5::uuid) returning id`,
      [input.decisionId, input.outcome, input.note, input.supersededBy, input.actor],
    );
    return { id: (row as { id: string }).id };
  }
}
