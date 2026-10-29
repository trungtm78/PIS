import { randomUUID } from 'node:crypto';
import { DomainError, INCIDENT_SLA_HOURS, assertAssignable, assertRerunPassed, assertVerifiable, assertWorkStep, maskReference, versionConflict } from '@machvon/kernel';
import type { ExceptionDecision, IncidentDecision, IncidentStatus, IncidentWorkStatus, RuleSeverity } from '@machvon/kernel';
import { DATASET_VISIBLE } from './dgv-dataset-store.ts';
import type { DatasetViewer } from './dgv-dataset-store.ts';
import { assertTimestampCursor } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';

const TIME = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export interface IncidentRecord {
  id: string;
  title: string;
  datasetId: string;
  datasetCode: string;
  ruleCode: string;
  dimension: string;
  severity: RuleSeverity;
  status: IncidentStatus;
  ownerId: string;
  ownerName: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  dueAt: string;
  slaHours: number | null;
  rootCause: string | null;
  remediation: string | null;
  resolvedAt: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  closedAt: string | null;
  reopenedCount: number;
  slaBreachedAt: string | null;
  /** The run of the rule that failed; none for an incident that is about a reconciliation. */
  runId: string | null;
  /** The reconciliation the incident is about; none for an incident of a rule. */
  reconciliationId: string | null;
  createdAt: string;
  version: number;
  /** The ordering key of the list and of its cursor: the moment of creation to the microsecond. */
  sortKey: string;
}

export interface IncidentEventRecord {
  id: string;
  kind: string;
  actorId: string | null;
  actorName: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  note: string | null;
  occurredAt: string;
}

export interface IncidentFilters {
  datasetId?: string | undefined;
  status?: string | undefined;
  severity?: string | undefined;
  assigneeId?: string | undefined;
  overdue?: boolean | undefined;
}

export interface ExceptionRecord {
  id: string;
  runId: string;
  datasetId: string;
  datasetCode: string;
  incidentId: string | null;
  ruleVersionId: string | null;
  /** The record that failed; its values are hidden (`masked`) from whoever may not see the dataset. */
  recordReference: unknown;
  evidence: unknown;
  masked: boolean;
  ownerId: string;
  reason: string;
  status: 'OPEN' | 'RESOLVED' | 'WAIVED';
  decision: ExceptionDecision | null;
  decidedBy: string | null;
  decidedAt: string | null;
  waiverReason: string | null;
  waiverExpiresAt: string | null;
  reopenedFromId: string | null;
  createdAt: string;
  version: number;
  sortKey: string;
}

export interface ExceptionFilters {
  datasetId?: string | undefined;
  status?: string | undefined;
  incidentId?: string | undefined;
}

interface IncidentRow {
  id: string;
  title: string | null;
  dataset_id: string;
  dataset_code: string;
  rule_code: string;
  dimension: string;
  severity: RuleSeverity;
  status: IncidentStatus;
  owner_id: string;
  owner_name: string | null;
  assignee_user_id: string | null;
  assignee_name: string | null;
  due_at: string;
  sla_hours: number | null;
  root_cause: string | null;
  remediation: string | null;
  resolved_at: string | null;
  verified_by: string | null;
  verified_at: string | null;
  closed_at: string | null;
  reopened_count: number;
  sla_breached_at: string | null;
  run_id: string | null;
  reconciliation_id: string | null;
  created_at: string;
  version: string;
  sort_key: string;
}

/** The incident `i` with the dataset of its run, the rule it failed and the readable names of its owner and handler. A dataset the viewer may not see is not here (DATASET_VISIBLE over `d`). */
const FROM = `machvon.quality_incident i
  left join machvon.quality_run r on r.tenant_id = i.tenant_id and r.id = i.run_id
  left join machvon.reconciliation_run rc on rc.tenant_id = i.tenant_id and rc.id = i.reconciliation_id
  join machvon.dataset d on d.tenant_id = i.tenant_id and d.id = coalesce(r.dataset_id, rc.dataset_id)
  left join machvon.quality_rule_version v on v.tenant_id = i.tenant_id and v.id = i.rule_id
  left join machvon.tenant_user_directory own on own.tenant_id = i.tenant_id and own.membership_id = i.owner_id
  left join machvon.tenant_user_directory asg on asg.tenant_id = i.tenant_id and asg.membership_id = i.assignee_user_id`;

const COLUMNS = `i.id, i.title, d.id as dataset_id, d.dataset_code, coalesce(v.code, rc.recon_code) as rule_code, coalesce(v.dimension, 'RECONCILIATION') as dimension, i.reconciliation_id, i.severity, i.status, i.owner_id, own.display_name as owner_name, i.assignee_user_id, asg.display_name as assignee_name,
  ${TIME('i.due_at')} as due_at, i.sla_hours, i.root_cause, i.remediation, ${TIME('i.resolved_at')} as resolved_at, i.verified_by, ${TIME('i.verified_at')} as verified_at, ${TIME('i.closed_at')} as closed_at,
  i.reopened_count, ${TIME('i.sla_breached_at')} as sla_breached_at, i.run_id, ${TIME('i.created_at')} as created_at, i.version::text as version, to_char(i.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as sort_key`;

const toIncident = (row: IncidentRow): IncidentRecord => ({
  id: row.id,
  title: row.title ?? `${row.dataset_code} / ${row.rule_code}`,
  datasetId: row.dataset_id,
  datasetCode: row.dataset_code,
  ruleCode: row.rule_code,
  dimension: row.dimension,
  severity: row.severity,
  status: row.status,
  ownerId: row.owner_id,
  ownerName: row.owner_name,
  assigneeId: row.assignee_user_id,
  assigneeName: row.assignee_name,
  dueAt: row.due_at,
  slaHours: row.sla_hours,
  rootCause: row.root_cause,
  remediation: row.remediation,
  resolvedAt: row.resolved_at,
  verifiedBy: row.verified_by,
  verifiedAt: row.verified_at,
  closedAt: row.closed_at,
  reopenedCount: row.reopened_count,
  slaBreachedAt: row.sla_breached_at,
  runId: row.run_id,
  reconciliationId: row.reconciliation_id,
  createdAt: row.created_at,
  version: Number(row.version),
  sortKey: row.sort_key,
});

interface ExceptionRow {
  id: string;
  run_id: string;
  dataset_id: string;
  dataset_code: string;
  incident_id: string | null;
  rule_version_id: string | null;
  record_reference: unknown;
  evidence: unknown;
  visible: boolean;
  owner_id: string;
  reason: string;
  status: 'OPEN' | 'RESOLVED' | 'WAIVED';
  decision: ExceptionDecision | null;
  decided_by: string | null;
  decided_at: string | null;
  waiver_reason: string | null;
  waiver_expires_at: string | null;
  reopened_from_id: string | null;
  created_at: string;
  version: string;
  sort_key: string;
}

/** The exception `e` with the dataset of its run; `visible` says whether the viewer may see that dataset ($1 the membership of the viewer, $2 the codes of its roles). */
const EXCEPTION_FROM = `machvon.quality_exception e
  join machvon.quality_run r on r.tenant_id = e.tenant_id and r.id = e.run_id
  join machvon.dataset d on d.tenant_id = r.tenant_id and d.id = r.dataset_id`;
const EXCEPTION_COLUMNS = `e.id, e.run_id, d.id as dataset_id, d.dataset_code, e.incident_id, e.rule_version_id, e.record_reference, e.evidence, ${DATASET_VISIBLE} as visible, e.owner_id, e.reason, e.status, e.decision, e.decided_by,
  ${TIME('e.decided_at')} as decided_at, e.waiver_reason, ${TIME('e.waiver_expires_at')} as waiver_expires_at, e.reopened_from_id, ${TIME('e.created_at')} as created_at, e.version::text as version,
  to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as sort_key`;

const toException = (row: ExceptionRow): ExceptionRecord => ({
  id: row.id,
  runId: row.run_id,
  datasetId: row.dataset_id,
  datasetCode: row.dataset_code,
  incidentId: row.incident_id,
  ruleVersionId: row.rule_version_id,
  // The record that failed belongs to the dataset: whoever may not see the dataset sees the shape of it and none of the values.
  recordReference: row.visible ? row.record_reference : maskReference(row.record_reference),
  evidence: row.visible ? row.evidence : maskReference(row.evidence),
  masked: !row.visible,
  ownerId: row.owner_id,
  reason: row.visible ? row.reason : maskReference(row.reason) as string,
  status: row.status,
  decision: row.decision,
  decidedBy: row.decided_by,
  decidedAt: row.decided_at,
  waiverReason: row.visible || row.waiver_reason === null ? row.waiver_reason : (maskReference(row.waiver_reason) as string),
  waiverExpiresAt: row.waiver_expires_at,
  reopenedFromId: row.reopened_from_id,
  createdAt: row.created_at,
  version: Number(row.version),
  sortKey: row.sort_key,
});

/**
 * Serialises whoever opens, reopens or looks for the incident of a rule on a dataset (a failed run, the end of a waiver): they take this lock to the end of their transaction, so that a dataset has one incident at a time
 * for a rule whichever of them comes first.
 */
export async function lockIncidentOf(tx: TenantTx, datasetId: string, ruleCode: string): Promise<void> {
  await tx.query("select pg_advisory_xact_lock(hashtextextended('dgv.incident:' || current_setting('app.tenant_id') || ':' || $1::text || ':' || $2::text, 0))", [datasetId, ruleCode]);
}

const event = async (tx: TenantTx, input: { incidentId: string; kind: string; actor: string | null; from: string | null; to: string | null; note: string | null }): Promise<void> => {
  await tx.query(
    `insert into machvon.quality_incident_event (tenant_id, id, incident_id, event_kind, actor_user_id, from_status, to_status, note)
     values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, $3::uuid, $4, $5, $6)`,
    [input.incidentId, input.kind, input.actor, input.from, input.to, input.note],
  );
};

export interface SweepResult {
  breached: IncidentRecord[];
  reopened: Array<{ exceptionId: string; reopenedFromId: string; incidentId: string | null; incident: IncidentRecord | undefined }>;
}

/**
 * The table gateway of the quality incidents and exceptions (ST-DGV-003, DGV.md F4). Every write moves an incident along its chain at the version it was read at and leaves an event; the database says the same
 * (trigger `quality_incident_guard`). The people here are the memberships of the tenant, as everywhere in the data governance module. Who may do what is the business of the controller.
 */
export class DgvIncidentStore {
  async find(tx: TenantTx, id: string, viewer: DatasetViewer): Promise<IncidentRecord | undefined> {
    const [row] = await tx.query<IncidentRow>(`select ${COLUMNS} from ${FROM} where i.id = $3::uuid and ${DATASET_VISIBLE}`, [viewer.membershipId, [...viewer.roleCodes], id]);
    return row === undefined ? undefined : toIncident(row);
  }

  /** The incident locked for a change, when the viewer may see its dataset. */
  async lock(tx: TenantTx, id: string, viewer: DatasetViewer): Promise<IncidentRecord> {
    const [row] = await tx.query<IncidentRow>(`select ${COLUMNS} from ${FROM} where i.id = $3::uuid and ${DATASET_VISIBLE} for update of i`, [viewer.membershipId, [...viewer.roleCodes], id]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return toIncident(row);
  }

  /** The incidents of the datasets the viewer may see, the latest first; `overdue` is those past their due time that are not closed (the figure of the dashboards). */
  async list(tx: TenantTx, viewer: DatasetViewer, filters: IncidentFilters, page: { limit: number; after: { code: string; id: string } | undefined }): Promise<IncidentRecord[]> {
    assertTimestampCursor(page.after?.code);
    const rows = await tx.query<IncidentRow>(
      `select ${COLUMNS} from ${FROM}
        where ${DATASET_VISIBLE} and ($3::uuid is null or d.id = $3::uuid) and ($4::text is null or i.status = $4) and ($5::text is null or i.severity = $5) and ($6::uuid is null or i.assignee_user_id = $6::uuid)
          and ($7::boolean is null or ((i.status <> 'CLOSED' and i.due_at < now()) = $7::boolean))
          and ($8::timestamptz is null or (i.created_at, i.id) < ($8::timestamptz, $9::uuid))
        order by i.created_at desc, i.id desc limit $10::int`,
      [viewer.membershipId, [...viewer.roleCodes], filters.datasetId ?? null, filters.status ?? null, filters.severity ?? null, filters.assigneeId ?? null, filters.overdue ?? null, page.after?.code ?? null, page.after?.id ?? null, page.limit],
    );
    return rows.map(toIncident);
  }

  async events(tx: TenantTx, incidentId: string): Promise<IncidentEventRecord[]> {
    const rows = await tx.query<{ id: string; event_kind: string; actor_user_id: string | null; actor_name: string | null; from_status: string | null; to_status: string | null; note: string | null; occurred_at: string }>(
      `select e.id, e.event_kind, e.actor_user_id, a.display_name as actor_name, e.from_status, e.to_status, e.note, ${TIME('e.occurred_at')} as occurred_at
         from machvon.quality_incident_event e left join machvon.tenant_user_directory a on a.tenant_id = e.tenant_id and a.membership_id = e.actor_user_id
        where e.incident_id = $1::uuid order by e.occurred_at, e.id`,
      [incidentId],
    );
    return rows.map((row) => ({ id: row.id, kind: row.event_kind, actorId: row.actor_user_id, actorName: row.actor_name, fromStatus: row.from_status, toStatus: row.to_status, note: row.note, occurredAt: row.occurred_at }));
  }

  /** The incident at the version the caller read (409 `VERSION_CONFLICT` otherwise): judged first, so that a stale screen is told to read again before anything about the state. */
  assertVersion(incident: { version: number }, expectedVersion: number): void {
    if (incident.version !== expectedVersion) throw versionConflict(incident.version);
  }

  /** Gives the incident to a handler, due at `dueAt` (again, while it is not resolved): the status is ASSIGNED, a mark of lateness starts over, and the step is written. */
  async assign(tx: TenantTx, incident: IncidentRecord, input: { expectedVersion: number; assigneeId: string; dueAt: Date; note: string | undefined; actor: string }): Promise<void> {
    this.assertVersion(incident, input.expectedVersion);
    assertAssignable(incident.status);
    await tx.query(
      `update machvon.quality_incident set status = 'ASSIGNED', assignee_user_id = $2::uuid, due_at = $3::timestamptz, sla_breached_at = null, version = version + 1 where id = $1::uuid`,
      [incident.id, input.assigneeId, input.dueAt.toISOString()],
    );
    await event(tx, { incidentId: incident.id, kind: 'ASSIGNED', actor: input.actor, from: incident.status, to: 'ASSIGNED', note: input.note ?? null });
  }

  /** The handler's next step; resolving writes the cause, the measure and the moment. */
  async advance(tx: TenantTx, incident: IncidentRecord, input: { expectedVersion: number; to: IncidentWorkStatus; rootCause: string | undefined; remediation: string | undefined; note: string | undefined; actor: string; at: Date }): Promise<void> {
    this.assertVersion(incident, input.expectedVersion);
    assertWorkStep(incident.status, input.to);
    if (input.to === 'RESOLVED_PENDING_VERIFICATION') {
      await tx.query(`update machvon.quality_incident set status = $2, root_cause = $3, remediation = $4, resolved_at = $5::timestamptz, version = version + 1 where id = $1::uuid`, [incident.id, input.to, input.rootCause, input.remediation, input.at.toISOString()]);
    } else {
      await tx.query('update machvon.quality_incident set status = $2, version = version + 1 where id = $1::uuid', [incident.id, input.to]);
    }
    await event(tx, { incidentId: incident.id, kind: 'STATUS_CHANGED', actor: input.actor, from: incident.status, to: input.to, note: input.note ?? null });
  }

  /**
   * What the latest run of the dataset found for the rule of the incident after it was resolved: the run that finished last, with the result of the rule in it (none when the rule was not in that run).
   */
  async rerunEvidence(tx: TenantTx, incident: IncidentRecord): Promise<{ resolvedAt: string; rerun: { finishedAt: string; result: 'PASS' | 'WARN' | 'FAIL' | 'ERROR' } | undefined }> {
    if (incident.reconciliationId !== null) return this.reconciliationEvidence(tx, incident);
    const [run] = await tx.query<{ finished_at: string; result: 'PASS' | 'WARN' | 'FAIL' | 'ERROR' | null }>(
      `select ${TIME('r.finished_at')} as finished_at,
              case when r.status = 'FAILED' then 'ERROR' else (select res.result from machvon.quality_rule_result res join machvon.quality_rule_version rv on rv.tenant_id = res.tenant_id and rv.id = res.rule_version_id
                where res.run_id = r.id and rv.code = $2 and rv.contract_id = (select x.contract_id from machvon.quality_incident qi join machvon.quality_rule_version x on x.tenant_id = qi.tenant_id and x.id = qi.rule_id where qi.id = $3::uuid) limit 1) end as result
         from machvon.quality_run r
        where r.dataset_id = $1::uuid and r.status in ('COMPLETED', 'FAILED') and r.finished_at is not null and r.finished_at > $4::timestamptz
        order by r.finished_at desc, r.id desc limit 1`,
      [incident.datasetId, incident.ruleCode, incident.id, incident.resolvedAt],
    );
    return { resolvedAt: incident.resolvedAt ?? '', rerun: run === undefined ? undefined : { finishedAt: run.finished_at, result: run.result ?? 'ERROR' } };
  }

  /** For an incident about a reconciliation: the latest reconciliation of the same code and period made after the resolution; matched (or within the tolerance) is a pass. */
  private async reconciliationEvidence(tx: TenantTx, incident: IncidentRecord): Promise<{ resolvedAt: string; rerun: { finishedAt: string; result: 'PASS' | 'WARN' | 'FAIL' | 'ERROR' } | undefined }> {
    const [run] = await tx.query<{ created_at: string; result: string }>(
      `select ${TIME('n.created_at')} as created_at, n.result
         from machvon.reconciliation_run n join machvon.reconciliation_run o on o.tenant_id = n.tenant_id and o.recon_code = n.recon_code and o.as_of_period = n.as_of_period and o.dataset_id is not distinct from n.dataset_id and o.id = $1::uuid
        where n.created_at > $2::timestamptz order by n.created_at desc, n.id desc limit 1`,
      [incident.reconciliationId, incident.resolvedAt],
    );
    return { resolvedAt: incident.resolvedAt ?? '', rerun: run === undefined ? undefined : { finishedAt: run.created_at, result: run.result === 'DIFFERENT' ? 'FAIL' : 'PASS' } };
  }

  /** CLOSE (only another person, after a run that passes) or REOPEN (the work was not enough: the handler keeps the incident). */
  async verify(tx: TenantTx, incident: IncidentRecord, input: { expectedVersion: number; decision: IncidentDecision; note: string; verifier: string; at: Date }): Promise<void> {
    this.assertVersion(incident, input.expectedVersion);
    assertVerifiable({ status: incident.status, assigneeUserId: incident.assigneeId, verifierUserId: input.verifier });
    if (input.decision === 'CLOSE') {
      // The rerun is read after the version and the state are known: a run that finished while the incident waited is the evidence.
      assertRerunPassed(await this.rerunEvidence(tx, incident));
      await tx.query(
        `update machvon.quality_incident set status = 'CLOSED', verified_by = $2::uuid, verified_at = $3::timestamptz, closed_at = $3::timestamptz, version = version + 1 where id = $1::uuid`,
        [incident.id, input.verifier, input.at.toISOString()],
      );
      await event(tx, { incidentId: incident.id, kind: 'VERIFIED', actor: input.verifier, from: incident.status, to: 'CLOSED', note: input.note });
      return;
    }
    await tx.query(`update machvon.quality_incident set status = 'REOPENED', reopened_count = reopened_count + 1, sla_breached_at = null, version = version + 1 where id = $1::uuid`, [incident.id]);
    await event(tx, { incidentId: incident.id, kind: 'REOPENED', actor: input.verifier, from: incident.status, to: 'REOPENED', note: input.note });
  }

  // ---- exceptions ----------------------------------------------------------------------------------------------------------------

  async findException(tx: TenantTx, id: string, viewer: DatasetViewer): Promise<ExceptionRecord | undefined> {
    const [row] = await tx.query<ExceptionRow>(`select ${EXCEPTION_COLUMNS} from ${EXCEPTION_FROM} where e.id = $3::uuid`, [viewer.membershipId, [...viewer.roleCodes], id]);
    return row === undefined ? undefined : toException(row);
  }

  /** The exception locked for a decision. The viewer is given the record masked when the dataset is not theirs, and may decide all the same: deciding needs the right to review, not to read the rows. */
  async lockException(tx: TenantTx, id: string, viewer: DatasetViewer): Promise<ExceptionRecord> {
    const [row] = await tx.query<ExceptionRow>(`select ${EXCEPTION_COLUMNS} from ${EXCEPTION_FROM} where e.id = $3::uuid for update of e`, [viewer.membershipId, [...viewer.roleCodes], id]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return toException(row);
  }

  async listExceptions(tx: TenantTx, viewer: DatasetViewer, filters: ExceptionFilters, page: { limit: number; after: { code: string; id: string } | undefined }): Promise<ExceptionRecord[]> {
    assertTimestampCursor(page.after?.code);
    const rows = await tx.query<ExceptionRow>(
      `select ${EXCEPTION_COLUMNS} from ${EXCEPTION_FROM}
        where ($3::uuid is null or d.id = $3::uuid) and ($4::text is null or e.status = $4) and ($5::uuid is null or e.incident_id = $5::uuid) and ($6::timestamptz is null or (e.created_at, e.id) < ($6::timestamptz, $7::uuid))
        order by e.created_at desc, e.id desc limit $8::int`,
      [viewer.membershipId, [...viewer.roleCodes], filters.datasetId ?? null, filters.status ?? null, filters.incidentId ?? null, page.after?.code ?? null, page.after?.id ?? null, page.limit],
    );
    return rows.map(toException);
  }

  /** Resolves or waives an OPEN exception at the version read (409 `EXCEPTION_STATE_INVALID` when it was decided). */
  async decide(tx: TenantTx, exception: ExceptionRecord, input: { expectedVersion: number; decision: ExceptionDecision; reason: string; waiverExpiresAt: Date | undefined; decider: string; at: Date }): Promise<void> {
    this.assertVersion(exception, input.expectedVersion);
    if (exception.status !== 'OPEN') throw new DomainError('EXCEPTION_STATE_INVALID', 409, 'status', { extensions: { exception_status: exception.status } });
    await tx.query(
      `update machvon.quality_exception set status = $2, decision = $2, decided_by = $3::uuid, decided_at = $4::timestamptz, waiver_reason = $5, waiver_expires_at = $6::timestamptz, version = version + 1 where id = $1::uuid`,
      [exception.id, input.decision, input.decider, input.at.toISOString(), input.reason, input.waiverExpiresAt?.toISOString() ?? null],
    );
  }

  // ---- the job (BR-DGV-05, BR-DGV-06) --------------------------------------------------------------------------------------------

  /**
   * One pass at the time `now`: the incidents that are not resolved and are past their due time are marked once as having broken their SLA; the waivers that have ended are followed by a new OPEN exception that points
   * at the waived one, once, and the closed incident of it is reopened (counted) and its handler told. Running it again changes nothing.
   */
  async sweep(tx: TenantTx, now: Date, actor: string): Promise<SweepResult> {
    const stamp = now.toISOString();
    const breachedRows = await tx.query<{ id: string }>(
      `update machvon.quality_incident set sla_breached_at = $1::timestamptz, version = version + 1
        where status in ('OPEN', 'ASSIGNED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'REOPENED') and due_at < $1::timestamptz and sla_breached_at is null returning id`,
      [stamp],
    );
    const breached: IncidentRecord[] = [];
    for (const { id } of breachedRows) {
      await event(tx, { incidentId: id, kind: 'SLA_BREACHED', actor: null, from: null, to: null, note: null });
      const incident = await this.system(tx, id);
      if (incident !== undefined) breached.push(incident);
    }
    const ended = await tx.query<{ id: string; run_id: string; record_reference: unknown; owner_id: string; reason: string; rule_version_id: string | null; incident_id: string | null; evidence: unknown }>(
      `select e.id, e.run_id, e.record_reference, e.owner_id, e.reason, e.rule_version_id, e.incident_id, e.evidence
         from machvon.quality_exception e
        where e.status = 'WAIVED' and e.waiver_expires_at < $1::timestamptz
          and not exists (select 1 from machvon.quality_exception n where n.tenant_id = e.tenant_id and n.reopened_from_id = e.id)
        order by e.waiver_expires_at, e.id for update of e`,
      [stamp],
    );
    const reopened: SweepResult['reopened'] = [];
    for (const old of ended) {
      const id = randomUUID();
      // The incident the exception goes back to: its own when that is still being worked or can be reopened, but if it is closed and a later failure of the same rule on the same dataset opened another one, that one (a
      // dataset has one incident at a time for a rule, ST-DGV-002): the old one is left closed.
      let target = old.incident_id === null ? undefined : await this.system(tx, old.incident_id);
      if (target !== undefined && target.status === 'CLOSED' && target.reconciliationId === null) {
        await lockIncidentOf(tx, target.datasetId, target.ruleCode);
        const active = await this.activeFor(tx, target);
        if (active !== undefined) target = active;
      }
      await tx.query(
        `insert into machvon.quality_exception (tenant_id, id, run_id, record_reference, owner_id, reason, status, evidence, rule_version_id, incident_id, reopened_from_id)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::jsonb, $4::uuid, $5, 'OPEN', $6::jsonb, $7::uuid, $8::uuid, $9::uuid)`,
        [id, old.run_id, JSON.stringify(old.record_reference), old.owner_id, old.reason, JSON.stringify(old.evidence), old.rule_version_id, target?.id ?? old.incident_id, old.id],
      );
      let incident = target;
      if (target !== undefined && target.status === 'CLOSED') {
        await tx.query(
          `update machvon.quality_incident set status = 'REOPENED', reopened_count = reopened_count + 1, verified_by = null, verified_at = null, closed_at = null, sla_breached_at = null, version = version + 1 where id = $1::uuid`,
          [target.id],
        );
        await event(tx, { incidentId: target.id, kind: 'REOPENED', actor, from: 'CLOSED', to: 'REOPENED', note: 'waiver_expired' });
        incident = await this.system(tx, target.id);
      }
      reopened.push({ exceptionId: id, reopenedFromId: old.id, incidentId: target?.id ?? old.incident_id, incident });
    }
    return { breached, reopened };
  }

  /** The incident that is not closed for the same rule (the same code of the same contract) on the same dataset as this one, if a later failure opened one. */
  private async activeFor(tx: TenantTx, closed: IncidentRecord): Promise<IncidentRecord | undefined> {
    const [row] = await tx.query<{ id: string }>(
      `select i.id from machvon.quality_incident i
         join machvon.quality_run r on r.tenant_id = i.tenant_id and r.id = i.run_id
         join machvon.quality_rule_version v on v.tenant_id = i.tenant_id and v.id = i.rule_id
        where i.status <> 'CLOSED' and r.dataset_id = $1::uuid and v.code = $2 and v.contract_id = (select x.contract_id from machvon.quality_rule_version x join machvon.quality_incident q on q.tenant_id = x.tenant_id and q.rule_id = x.id where q.id = $3::uuid)
        order by i.created_at, i.id limit 1`,
      [closed.datasetId, closed.ruleCode, closed.id],
    );
    return row === undefined ? undefined : this.system(tx, row.id);
  }

  /** An incident as the system reads it, whatever the dataset (the job answers to nobody's rights). */
  private async system(tx: TenantTx, id: string): Promise<IncidentRecord | undefined> {
    const [row] = await tx.query<IncidentRow>(`select ${COLUMNS} from ${FROM} where i.id = $1::uuid`, [id]);
    return row === undefined ? undefined : toIncident(row);
  }

  /** The SLA, in hours, of a severity (BR-DGV-05). */
  slaHours(severity: RuleSeverity): number {
    return INCIDENT_SLA_HOURS[severity];
  }
}
