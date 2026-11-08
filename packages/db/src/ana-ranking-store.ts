import { RANKING_RULE_CODE, RANKING_RULE_TYPE, rankingModelOf } from '@machvon/kernel';
import type { AnnotationStatus, ApprovedAnnotation, ComplaintStatus, OpenComplaint, RankMetricCode, RankingModel, UnitMeasures } from '@machvon/kernel';
import { AnalyticsRagStore } from './analytics-rag-store.ts';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import { policyVersionOf } from './home-work-policy.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const ISO = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
export const ANNOTATION_RESOURCE = 'ranking_annotation';
export const COMPLAINT_RESOURCE = 'ranking_complaint';

export interface RankingModelReading {
  model: RankingModel;
  version: string;
  unverified: boolean;
}

interface Person {
  id: string;
  name: string;
}
export interface AnnotationRow {
  id: string;
  unitId: string;
  unitCode: string | null;
  unitName: string | null;
  reasonCode: string;
  metricCodes: RankMetricCode[];
  evidence: string;
  validFrom: string;
  validTo: string;
  status: AnnotationStatus;
  proposedBy: Person;
  proposedAt: string;
  decidedBy: Person | null;
  decidedAt: string | null;
  decisionNote: string | null;
}
export interface ComplaintRow {
  id: string;
  unitId: string;
  unitCode: string | null;
  unitName: string | null;
  metricCode: RankMetricCode;
  asOfDate: string;
  snapshotId: string | null;
  claim: string;
  claimedValue: string | null;
  status: ComplaintStatus;
  filedBy: Person;
  filedAt: string;
  dueOn: string;
  reviewer: Person | null;
  reviewStartedAt: string | null;
  resolvedBy: Person | null;
  resolvedAt: string | null;
  resolution: string | null;
}

interface AnnotationSql {
  id: string;
  unit_id: string;
  unit_code: string | null;
  unit_name: string | null;
  reason_code: string;
  metric_codes: RankMetricCode[];
  evidence: string;
  valid_from: string;
  valid_to: string;
  status: AnnotationStatus;
  proposed_by: string;
  proposed_name: string | null;
  proposed_at: string;
  decided_by: string | null;
  decided_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
}
interface ComplaintSql {
  id: string;
  unit_id: string;
  unit_code: string | null;
  unit_name: string | null;
  metric_code: RankMetricCode;
  as_of_date: string;
  snapshot_id: string | null;
  claim: string;
  claimed_value: string | null;
  status: ComplaintStatus;
  filed_by: string;
  filed_name: string | null;
  filed_at: string;
  due_on: string;
  reviewer_id: string | null;
  reviewer_name: string | null;
  review_started_at: string | null;
  resolved_by: string | null;
  resolved_name: string | null;
  resolved_at: string | null;
  resolution: string | null;
}

const person = (id: string | null, name: string | null): Person | null => (id === null ? null : { id, name: name ?? '' });

const ANNOTATION_SELECT = `select a.id, a.unit_id, u.code as unit_code, u.name as unit_name, a.reason_code, a.metric_codes, a.evidence, a.valid_from::text as valid_from, a.valid_to::text as valid_to, a.status,
  a.proposed_by, pd.display_name as proposed_name, ${ISO('a.proposed_at')} as proposed_at, a.decided_by, dd.display_name as decided_name, ${ISO('a.decided_at')} as decided_at, a.decision_note
  from machvon.ranking_annotation a
  join machvon.organization_unit u on u.tenant_id = a.tenant_id and u.id = a.unit_id
  left join machvon.tenant_user_directory pd on pd.tenant_id = a.tenant_id and pd.membership_id = a.proposed_by
  left join machvon.tenant_user_directory dd on dd.tenant_id = a.tenant_id and dd.membership_id = a.decided_by`;

const COMPLAINT_SELECT = `select c.id, c.unit_id, u.code as unit_code, u.name as unit_name, c.metric_code, c.as_of_date::text as as_of_date, c.snapshot_id, c.claim, c.claimed_value::text as claimed_value, c.status,
  c.filed_by, fd.display_name as filed_name, ${ISO('c.filed_at')} as filed_at, c.due_on::text as due_on, c.reviewer_id, rd.display_name as reviewer_name, ${ISO('c.review_started_at')} as review_started_at,
  c.resolved_by, sd.display_name as resolved_name, ${ISO('c.resolved_at')} as resolved_at, c.resolution
  from machvon.ranking_complaint c
  join machvon.organization_unit u on u.tenant_id = c.tenant_id and u.id = c.unit_id
  left join machvon.tenant_user_directory fd on fd.tenant_id = c.tenant_id and fd.membership_id = c.filed_by
  left join machvon.tenant_user_directory rd on rd.tenant_id = c.tenant_id and rd.membership_id = c.reviewer_id
  left join machvon.tenant_user_directory sd on sd.tenant_id = c.tenant_id and sd.membership_id = c.resolved_by`;

const toAnnotation = (row: AnnotationSql): AnnotationRow => ({
  id: row.id,
  unitId: row.unit_id,
  unitCode: row.unit_code,
  unitName: row.unit_name,
  reasonCode: row.reason_code,
  metricCodes: row.metric_codes,
  evidence: row.evidence,
  validFrom: row.valid_from,
  validTo: row.valid_to,
  status: row.status,
  proposedBy: person(row.proposed_by, row.proposed_name) as Person,
  proposedAt: row.proposed_at,
  decidedBy: person(row.decided_by, row.decided_name),
  decidedAt: row.decided_at,
  decisionNote: row.decision_note,
});
const toComplaint = (row: ComplaintSql): ComplaintRow => ({
  id: row.id,
  unitId: row.unit_id,
  unitCode: row.unit_code,
  unitName: row.unit_name,
  metricCode: row.metric_code,
  asOfDate: row.as_of_date,
  snapshotId: row.snapshot_id,
  claim: row.claim,
  claimedValue: row.claimed_value,
  status: row.status,
  filedBy: person(row.filed_by, row.filed_name) as Person,
  filedAt: row.filed_at,
  dueOn: row.due_on,
  reviewer: person(row.reviewer_id, row.reviewer_name),
  reviewStartedAt: row.review_started_at,
  resolvedBy: person(row.resolved_by, row.resolved_name),
  resolvedAt: row.resolved_at,
  resolution: row.resolution,
});

/**
 * The inputs and the notes of the multi-measure ranking (G3-8): the measures of each unit on the latest frozen snapshot (the facts the early-warning score reads, plus the physical progress of the frozen earned value of
 * its projects), the approved annotations, the open complaints, and the two lists with their lifecycle. The arithmetic is the kernel's; this reads and writes. A reader sees the notes and complaints of the units they may
 * read and their own.
 */
export class AnaRankingStore {
  private readonly rag = new AnalyticsRagStore();

  private readonly port: GovernancePolicyPort;

  constructor(port: GovernancePolicyPort = new GovernancePolicyPort()) {
    this.port = port;
  }

  async model(tx: TenantTx, asOf: string | Date): Promise<RankingModelReading> {
    const rule = await this.port.require(tx, RANKING_RULE_TYPE, RANKING_RULE_CODE, asOf);
    return { model: rankingModelOf(rule.params), version: policyVersionOf(rule), unverified: rule.unverified };
  }

  /** The measures of every unit of the scope on the snapshot; the physical progress is the earned value over the budget of the projects of the unit whose frozen EVM result is whole. */
  async measures(tx: TenantTx, snapshotId: string, unitScope: ScopeBuilder, now: Date): Promise<UnitMeasures[]> {
    const readings = await this.rag.unitReadings(tx, snapshotId, unitScope, now);
    if (readings.length === 0) return [];
    const physical = await tx.query<{ unit_id: string; ev: string | null; bac: string | null; n: string }>(
      `select l.unit_id, sum((r.figures->>'evVnd')::numeric)::text as ev, sum((r.figures->>'bacVnd')::numeric)::text as bac, count(*)::text as n
         from (select distinct unit_id, project_id from machvon.period_snapshot_line where snapshot_id = $1::uuid and bucket = 'CURRENT_YEAR') l
         join machvon.evm_frozen_result r on r.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid and r.snapshot_id = $1::uuid and r.project_id = l.project_id
        where r.figures->>'status' = 'OK' and r.figures->>'evVnd' is not null and r.figures->>'bacVnd' is not null and l.unit_id = any($2::uuid[])
        group by l.unit_id`,
      [snapshotId, readings.map((reading) => reading.unitId)],
    );
    const byUnit = new Map(physical.map((row) => [row.unit_id, row]));
    return readings.map((reading): UnitMeasures => {
      const progress = byUnit.get(reading.unitId);
      return {
        unitId: reading.unitId,
        code: reading.code,
        name: reading.name,
        projects: reading.facts.projects,
        projectsWithoutData: reading.facts.projectsWithoutData,
        planPmVnd: reading.facts.planPmVnd,
        treasuryVnd: reading.facts.treasuryVnd,
        criticalWarnings: reading.facts.criticalWarnings,
        overdueExplanations: reading.facts.overdueExplanations,
        evVnd: progress === undefined || progress.ev === null ? null : progress.ev.split('.')[0] ?? null,
        bacVnd: progress === undefined || progress.bac === null ? null : progress.bac.split('.')[0] ?? null,
        physicalProjects: progress === undefined ? 0 : Number(progress.n),
      };
    });
  }

  /** The notes a person approved that hold on the day, for the ranking. */
  async approvedAnnotations(tx: TenantTx, today: string): Promise<ApprovedAnnotation[]> {
    const rows = await tx.query<{ id: string; unit_id: string; reason_code: string; metric_codes: string[]; valid_from: string; valid_to: string }>(
      `select id, unit_id, reason_code, metric_codes, valid_from::text as valid_from, valid_to::text as valid_to from machvon.ranking_annotation where status = 'APPROVED' and valid_from <= $1::date and valid_to >= $1::date order by id`,
      [today],
    );
    return rows.map((row) => ({ id: row.id, unitId: row.unit_id, reasonCode: row.reason_code, metricCodes: row.metric_codes, validFrom: row.valid_from, validTo: row.valid_to }));
  }

  async openComplaints(tx: TenantTx): Promise<OpenComplaint[]> {
    const rows = await tx.query<{ id: string; unit_id: string; metric_code: string; status: string }>(`select id, unit_id, metric_code, status from machvon.ranking_complaint where status in ('FILED', 'UNDER_REVIEW') order by id`);
    return rows.map((row) => ({ id: row.id, unitId: row.unit_id, metricCode: row.metric_code, status: row.status }));
  }

  /** The visibility of a note or a complaint: the units the reader may read, and what the reader made. */
  private visible(alias: string, ownerColumn: string, unitScope: ScopeBuilder, membershipId: string, first: number): { sql: string; params: unknown[] } {
    const scope = unitScope(first + 1);
    return { sql: `(${alias}.${ownerColumn} = $${first}::uuid or exists (select 1 from machvon.organization_unit u where u.id = ${alias}.unit_id and ${scope.sql}))`, params: [membershipId, ...scope.params] };
  }

  async annotations(tx: TenantTx, filter: { status?: string | undefined; unitId?: string | undefined }, unitScope: ScopeBuilder, membershipId: string, limit: number): Promise<AnnotationRow[]> {
    const visible = this.visible('a', 'proposed_by', unitScope, membershipId, 4);
    const rows = await tx.query<AnnotationSql>(`${ANNOTATION_SELECT} where ($1::text is null or a.status = $1) and ($2::uuid is null or a.unit_id = $2::uuid) and ${visible.sql} order by a.proposed_at desc, a.id desc limit $3`, [filter.status ?? null, filter.unitId ?? null, limit, ...visible.params]);
    return rows.map(toAnnotation);
  }

  async findAnnotation(tx: TenantTx, id: string, unitScope: ScopeBuilder, membershipId: string, lock = false): Promise<AnnotationRow | undefined> {
    const visible = this.visible('a', 'proposed_by', unitScope, membershipId, 2);
    const [row] = await tx.query<AnnotationSql>(`${ANNOTATION_SELECT} where a.id = $1::uuid and ${visible.sql}${lock ? ' for update of a' : ''}`, [id, ...visible.params]);
    return row === undefined ? undefined : toAnnotation(row);
  }

  async insertAnnotation(tx: TenantTx, input: { unitId: string; reasonCode: string; metricCodes: readonly string[]; evidence: string; validFrom: string; validTo: string; actor: string }): Promise<{ id: string }> {
    const [row] = await tx.query<{ id: string }>(
      `insert into machvon.ranking_annotation (tenant_id, unit_id, reason_code, metric_codes, evidence, valid_from, valid_to, proposed_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3::text[], $4, $5::date, $6::date, $7::uuid) returning id`,
      [input.unitId, input.reasonCode, [...input.metricCodes], input.evidence, input.validFrom, input.validTo, input.actor],
    );
    return { id: (row as { id: string }).id };
  }

  async moveAnnotation(tx: TenantTx, id: string, status: AnnotationStatus, actor: string, note: string): Promise<void> {
    await tx.query(`update machvon.ranking_annotation set status = $2, decided_by = $3::uuid, decided_at = now(), decision_note = $4 where id = $1::uuid`, [id, status, actor, note]);
  }

  async complaints(tx: TenantTx, filter: { status?: string | undefined; unitId?: string | undefined }, unitScope: ScopeBuilder, membershipId: string, limit: number): Promise<ComplaintRow[]> {
    const visible = this.visible('c', 'filed_by', unitScope, membershipId, 4);
    const rows = await tx.query<ComplaintSql>(`${COMPLAINT_SELECT} where ($1::text is null or c.status = $1) and ($2::uuid is null or c.unit_id = $2::uuid) and ${visible.sql} order by c.filed_at desc, c.id desc limit $3`, [filter.status ?? null, filter.unitId ?? null, limit, ...visible.params]);
    return rows.map(toComplaint);
  }

  async findComplaint(tx: TenantTx, id: string, unitScope: ScopeBuilder, membershipId: string, lock = false): Promise<ComplaintRow | undefined> {
    const visible = this.visible('c', 'filed_by', unitScope, membershipId, 2);
    const [row] = await tx.query<ComplaintSql>(`${COMPLAINT_SELECT} where c.id = $1::uuid and ${visible.sql}${lock ? ' for update of c' : ''}`, [id, ...visible.params]);
    return row === undefined ? undefined : toComplaint(row);
  }

  async insertComplaint(tx: TenantTx, input: { unitId: string; metricCode: string; asOfDate: string; snapshotId: string | null; claim: string; claimedValue: string | null; dueOn: string; actor: string }): Promise<{ id: string }> {
    const [row] = await tx.query<{ id: string }>(
      `insert into machvon.ranking_complaint (tenant_id, unit_id, metric_code, as_of_date, snapshot_id, claim, claimed_value, due_on, filed_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3::date, $4::uuid, $5, $6::numeric, $7::date, $8::uuid) returning id`,
      [input.unitId, input.metricCode, input.asOfDate, input.snapshotId, input.claim, input.claimedValue, input.dueOn, input.actor],
    );
    return { id: (row as { id: string }).id };
  }

  async startReview(tx: TenantTx, id: string, actor: string): Promise<void> {
    await tx.query(`update machvon.ranking_complaint set status = 'UNDER_REVIEW', reviewer_id = $2::uuid, review_started_at = now() where id = $1::uuid`, [id, actor]);
  }

  async resolveComplaint(tx: TenantTx, id: string, status: ComplaintStatus, actor: string, resolution: string): Promise<void> {
    await tx.query(`update machvon.ranking_complaint set status = $2, resolved_by = $3::uuid, resolved_at = now(), resolution = $4 where id = $1::uuid`, [id, status, actor, resolution]);
  }

  async snapshotOfDay(tx: TenantTx, day: string): Promise<string | null> {
    const [row] = await tx.query<{ id: string }>(`select id from machvon.period_snapshot where status = 'FROZEN' and snapshot_kind = 'PERIOD_CLOSE' and as_of_date = $1::date order by frozen_at desc limit 1`, [day]);
    return row?.id ?? null;
  }
}
