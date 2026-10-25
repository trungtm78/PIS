import { randomUUID } from 'node:crypto';
import { DomainError, EXECUTOR_KINDS, MAX_BLOCKER_NOTE, STAGE_CODES, stageIssues, stageStatusOf, vietnamDateOf } from '@machvon/kernel';
import type { ExecutorKind, StageCode, StageMode, StageStatus } from '@machvon/kernel';
import type { AuditWriter } from './audit-writer.ts';
import { LndLandSource } from './lnd-land-source.ts';
import { dateOf, lowerId, textOf } from './lnd-values.ts';
import { enqueueOutbox } from './outbox.ts';
import type { OutboxEventInput } from './outbox.ts';
import type { TenantTx } from './tenant-database.ts';

const RESOURCE_TYPE = 'land_stage_progress';
const CLASSIFICATION = 'INTERNAL';
/** The type of the event that asks ISS for an issue about a late stage (the common contract of the issue intake, ISS-11). */
export const STAGE_LATE_EVENT = 'lnd.stage.late.v1';

/** What an executing unit reports of one stage of one section (the body of `reportLandStageProgress`). */
export interface StageReport {
  projectId: string;
  sectionId: string;
  planId?: string | undefined;
  stageCode: StageCode;
  executorKind: ExecutorKind;
  executorUnitId: string;
  mode: StageMode;
  parcelsTotal: number;
  parcelsDone: number;
  plannedStart?: string | undefined;
  plannedEnd?: string | undefined;
  actualStart?: string | undefined;
  actualEnd?: string | undefined;
  evidenceDocumentVersionId?: string | undefined;
  blockerNote?: string | undefined;
}

export interface StageReportOptions {
  /** The Vietnam date of the report: a stage is late against it, and an actual date cannot be after it. */
  today: string;
  /**
   * The caller reaches the executing unit and not the project: the stage must already be assigned to that unit by the people of the project, and the report cannot move it
   * to another. A caller that reaches the project assigns and reassigns the executor with the report.
   */
  assignedOnly: boolean;
}

/** The late event of a stage that just became late, ready for the outbox. */
export type StageLateEvent = Omit<OutboxEventInput, 'correlationId'>;

export interface ReportedStage {
  id: string;
  projectId: string;
  sectionId: string;
  stageCode: StageCode;
  executorKind: ExecutorKind;
  executorUnitId: string;
  /** The unit the stage was assigned to before this report; null when the report created the stage. */
  previousExecutorUnitId: string | null;
  status: StageStatus;
  previousStatus: StageStatus | null;
  parcelsTotal: number;
  parcelsDone: number;
  progressPct: string;
  evidenceDocumentVersionId: string | null;
  version: number;
  created: boolean;
  /** Set when this report took the stage into LATE: the event that asks ISS for one issue. */
  lateEvent: StageLateEvent | null;
}

interface ExistingSql {
  id: string;
  mode: StageMode;
  status: StageStatus;
  executor_unit_id: string;
  version: string;
}

interface StageSql {
  id: string;
  project_id: string;
  section_id: string;
  plan_id: string | null;
  stage_code: StageCode;
  executor_kind: ExecutorKind;
  executor_unit_id: string;
  executor_unit_name: string;
  mode: StageMode;
  planned_start: string | null;
  planned_end: string | null;
  actual_start: string | null;
  actual_end: string | null;
  parcels_total: number;
  parcels_done: number;
  progress_pct: string;
  last_reported_at: string | null;
  evidence_document_version_id: string | null;
  status: StageStatus;
  blocker_issue_id: string | null;
  blocker_note: string | null;
  version: string;
}

/** A stage as the overview shows it: the facts of the table, with the name of the executing unit and no more. */
export interface StageLine {
  id: string;
  projectId: string;
  sectionId: string;
  planId: string | null;
  stageCode: StageCode;
  executorKind: ExecutorKind;
  executorUnitId: string;
  executorUnitName: string;
  mode: StageMode;
  plannedStart: string | null;
  plannedEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  parcelsTotal: number;
  parcelsDone: number;
  progressPct: string;
  lastReportedAt: string | null;
  evidenceDocumentVersionId: string | null;
  status: StageStatus;
  blockerIssueId: string | null;
  blockerNote: string | null;
  version: number;
}

const STAGE_COLUMNS = `g.id, g.project_id, g.section_id, g.plan_id, g.stage_code, g.executor_kind, g.executor_unit_id, eu.name as executor_unit_name, g.mode,
  g.planned_start::text as planned_start, g.planned_end::text as planned_end, g.actual_start::text as actual_start, g.actual_end::text as actual_end,
  g.parcels_total, g.parcels_done, g.progress_pct::text as progress_pct, to_char(g.last_reported_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as last_reported_at,
  g.evidence_document_version_id, g.status, g.blocker_issue_id, g.blocker_note, g.version::text as version`;

const toLine = (row: StageSql): StageLine => ({
  id: row.id,
  projectId: row.project_id,
  sectionId: row.section_id,
  planId: row.plan_id,
  stageCode: row.stage_code,
  executorKind: row.executor_kind,
  executorUnitId: row.executor_unit_id,
  executorUnitName: row.executor_unit_name,
  mode: row.mode,
  plannedStart: row.planned_start,
  plannedEnd: row.planned_end,
  actualStart: row.actual_start,
  actualEnd: row.actual_end,
  parcelsTotal: row.parcels_total,
  parcelsDone: row.parcels_done,
  progressPct: row.progress_pct,
  lastReportedAt: row.last_reported_at,
  evidenceDocumentVersionId: row.evidence_document_version_id,
  status: row.status,
  blockerIssueId: row.blocker_issue_id,
  blockerNote: row.blocker_note,
  version: Number(row.version),
});

/** The members of the issue intake's common contract for a stage that became late: the stage, a code that names it, and the project. Nothing a person said. */
export function stageLateEvent(stage: { id: string; projectId: string; ownerUnitId: string; sectionCode: string; stageCode: string; executorKind: string; plannedEnd: string | null; version: number }, tenantId: string, now: Date): StageLateEvent {
  return {
    aggregateType: RESOURCE_TYPE,
    aggregateId: stage.id,
    aggregateVersion: stage.version,
    type: STAGE_LATE_EVENT,
    schemaVersion: 1,
    payload: {
      tenant_id: tenantId,
      source_ref_id: stage.id,
      reference_code: `${stage.sectionCode}-${stage.stageCode}`,
      project_id: stage.projectId,
      owner_unit_id: stage.ownerUnitId,
      stage_id: stage.id,
      stage_code: stage.stageCode,
      executor_kind: stage.executorKind,
      planned_end: stage.plannedEnd,
      status: 'LATE',
      occurred_at: now.toISOString(),
      source_module: 'LND',
    },
    eventKey: `${RESOURCE_TYPE}:${stage.id}:late:${stage.version}`,
  };
}

/** The issue that a late stage opened is remembered on the stage (the intake calls this in the transaction that opens it); the stage keeps the latest. */
export async function linkStageIssue(tx: TenantTx, stageId: string, issueId: string): Promise<void> {
  await tx.query('update machvon.land_stage_progress set blocker_issue_id = $2::uuid where id = $1::uuid', [stageId, issueId]);
}

/** One section of the overview with the facts counted from the parcels that lie in it. */
export interface SectionProgress {
  id: string;
  code: string;
  name: string;
  status: string;
  requiredAreaM2: string;
  handedAreaM2: string;
  targetDate: string | null;
  parcels: number;
  parcelsNoticed: number;
  parcelsPaid: number;
  parcelsHandedOver: number;
}

export interface ProgressOverview {
  projectId: string;
  /** Counted from the rows of LND (mode NATIVE): the sections, the parcels, the households, the plans and the payments of the project. */
  totals: {
    sections: number;
    sectionsHandedOver: number;
    requiredAreaM2: string;
    handedAreaM2: string;
    parcels: number;
    parcelsNoticed: number;
    parcelsPaid: number;
    parcelsHandedOver: number;
    households: number;
    plansPosted: number;
    paymentsPaid: number;
    paymentsTotal: number;
    lateStages: number;
  };
  parcelsByStatus: Record<string, number>;
  sections: SectionProgress[];
  stages: StageLine[];
}

interface CountsSql {
  sections: string;
  sections_handed_over: string;
  required_area_m2: string;
  handed_area_m2: string;
}

/**
 * The progress of land clearance by stage (ST-LND-010, LND 3.4): the stages that an executing unit reports, tracked from outside with evidence (mode TRACKED_EXTERNAL),
 * and the overview of a project, whose counts are read from the rows of LND and not kept anywhere else (mode NATIVE has no row of its own: its progress is the parcels). A
 * report creates the stage or updates it, and a stage that is behind its planned end is LATE; the late event asks ISS for one issue about it.
 */
export class LndStageProgressStore {
  private readonly source: LndLandSource;

  constructor(source: LndLandSource = new LndLandSource()) {
    this.source = source;
  }

  async report(tx: TenantTx, input: StageReport, actor: string, options: StageReportOptions): Promise<ReportedStage> {
    // The progress of a stage that LND counts itself is read from its data and not written by a report.
    if (input.mode !== 'TRACKED_EXTERNAL') throw new DomainError('NATIVE_STAGE_READONLY', 422, 'mode');
    if (!(STAGE_CODES as readonly string[]).includes(input.stageCode)) throw new DomainError('VALIDATION_FAILED', 422, 'stage_code');
    if (!(EXECUTOR_KINDS as readonly string[]).includes(input.executorKind)) throw new DomainError('VALIDATION_FAILED', 422, 'executor_kind');
    const plannedStart = input.plannedStart === undefined ? null : dateOf(input.plannedStart, 'planned_start');
    const plannedEnd = input.plannedEnd === undefined ? null : dateOf(input.plannedEnd, 'planned_end');
    const actualStart = input.actualStart === undefined ? null : dateOf(input.actualStart, 'actual_start');
    const actualEnd = input.actualEnd === undefined ? null : dateOf(input.actualEnd, 'actual_end');
    const blockerNote = input.blockerNote === undefined ? null : textOf(input.blockerNote, 'blocker_note', 1, MAX_BLOCKER_NOTE);
    const [issue] = stageIssues({
      parcelsTotal: input.parcelsTotal,
      parcelsDone: input.parcelsDone,
      plannedStart,
      plannedEnd,
      actualStart,
      actualEnd,
      tracked: true,
      hasEvidence: input.evidenceDocumentVersionId !== undefined,
      today: options.today,
    });
    if (issue !== undefined) {
      throw new DomainError(issue.problem === 'PARCELS_DONE_EXCEEDS_TOTAL' ? 'PARCELS_DONE_EXCEEDS_TOTAL' : 'VALIDATION_FAILED', 422, issue.field, { extensions: { reason: issue.problem } });
    }
    const projectId = lowerId(input.projectId);
    const sectionId = lowerId(input.sectionId);
    const planId = input.planId === undefined ? null : lowerId(input.planId);
    const executorUnitId = lowerId(input.executorUnitId);
    const evidenceId = input.evidenceDocumentVersionId === undefined ? null : lowerId(input.evidenceDocumentVersionId);

    const existing = (
      await tx.query<ExistingSql>(
        `select id, mode, status, executor_unit_id, version::text as version from machvon.land_stage_progress
          where project_id = $4::uuid and section_id = $1::uuid and stage_code = $2 and plan_id is not distinct from $3::uuid for update`,
        [sectionId, input.stageCode, planId, projectId],
      )
    )[0];
    if (existing?.mode === 'NATIVE') throw new DomainError('NATIVE_STAGE_READONLY', 422, 'stage_code');
    // The unit that executes a stage reports on the stages it was given and cannot hand one to another unit or take one that nobody gave it.
    if (options.assignedOnly && (existing === undefined || existing.executor_unit_id !== executorUnitId)) throw new DomainError('SCOPE_DENIED', 403);

    if ((await this.source.sectionOfProject(tx, projectId, sectionId)) === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'section_id');
    if (planId !== null) await this.source.assertPlanOfProject(tx, planId, projectId, 'plan_id');
    if ((await this.source.unitRef(tx, executorUnitId)) === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'executor_unit_id');
    if (evidenceId !== null) await this.source.assertCleanDocumentVersion(tx, evidenceId, 'evidence_document_version_id');

    const status = stageStatusOf({ parcelsTotal: input.parcelsTotal, parcelsDone: input.parcelsDone, plannedEnd, actualStart, actualEnd, blocked: blockerNote !== null }, options.today);
    const id = existing?.id ?? randomUUID();
    const version = existing === undefined ? 1 : Number(existing.version) + 1;
    const columns = [
      id,
      input.executorKind,
      executorUnitId,
      plannedStart,
      plannedEnd,
      actualStart,
      actualEnd,
      input.parcelsTotal,
      input.parcelsDone,
      actor,
      evidenceId,
      status,
      blockerNote,
    ];
    if (existing === undefined) {
      await tx.query(
        `insert into machvon.land_stage_progress
           (tenant_id, id, project_id, section_id, plan_id, stage_code, executor_kind, executor_unit_id, mode, planned_start, planned_end, actual_start, actual_end,
            parcels_total, parcels_done, last_reported_by, last_reported_at, evidence_document_version_id, status, blocker_note, version, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $14::uuid, $15::uuid, $16::uuid, $17, $2, $3::uuid, 'TRACKED_EXTERNAL', $4::date, $5::date, $6::date, $7::date,
                 $8::int, $9::int, $10::uuid, now(), $11::uuid, $12, $13, 1, $10::uuid, $10::uuid)`,
        [...columns, projectId, sectionId, planId, input.stageCode],
      );
    } else {
      await tx.query(
        `update machvon.land_stage_progress
            set executor_kind = $2, executor_unit_id = $3::uuid, planned_start = $4::date, planned_end = $5::date, actual_start = $6::date, actual_end = $7::date,
                parcels_total = $8::int, parcels_done = $9::int, last_reported_by = $10::uuid, last_reported_at = now(), evidence_document_version_id = $11::uuid,
                status = $12, blocker_note = $13, version = $14::bigint, updated_at = now(), updated_by = $10::uuid
          where id = $1::uuid`,
        [...columns, version],
      );
    }
    const progress = (await tx.query<{ progress_pct: string }>('select progress_pct::text as progress_pct from machvon.land_stage_progress where id = $1::uuid', [id]))[0];
    const becameLate = status === 'LATE' && existing?.status !== 'LATE';
    const lateEvent = becameLate ? await this.lateEventOf(tx, id, version) : null;
    return {
      id,
      projectId,
      sectionId,
      stageCode: input.stageCode,
      executorKind: input.executorKind,
      executorUnitId,
      previousExecutorUnitId: existing?.executor_unit_id ?? null,
      status,
      previousStatus: existing?.status ?? null,
      parcelsTotal: input.parcelsTotal,
      parcelsDone: input.parcelsDone,
      progressPct: progress?.progress_pct ?? '0.00',
      evidenceDocumentVersionId: evidenceId,
      version,
      created: existing === undefined,
      lateEvent,
    };
  }

  /** The event of a stage that became late, with the project's owner unit and the code of its section; the tenant is the one of the transaction. */
  private async lateEventOf(tx: TenantTx, stageId: string, version: number): Promise<StageLateEvent> {
    const row = (
      await tx.query<{ tenant_id: string; project_id: string; owner_unit_id: string; section_code: string; stage_code: string; executor_kind: string; planned_end: string | null }>(
        `select g.tenant_id::text as tenant_id, g.project_id, p.owner_unit_id, s.code as section_code, g.stage_code, g.executor_kind, g.planned_end::text as planned_end
           from machvon.land_stage_progress g
           join machvon.project p on p.tenant_id = g.tenant_id and p.id = g.project_id
           join machvon.land_handover_section s on s.tenant_id = g.tenant_id and s.id = g.section_id
          where g.id = $1::uuid`,
        [stageId],
      )
    )[0];
    if (row === undefined) throw new Error('the stage vanished after its report');
    return stageLateEvent(
      { id: stageId, projectId: row.project_id, ownerUnitId: row.owner_unit_id, sectionCode: row.section_code, stageCode: row.stage_code, executorKind: row.executor_kind, plannedEnd: row.planned_end, version },
      row.tenant_id,
      new Date(),
    );
  }

  /**
   * The overview of a project, or of one of its sections: every figure is counted from the rows of LND at the moment of the read (the parcels and their statuses, the sections
   * and their areas, the plans, the payments and the households), and the stages are those that were reported. The project is the caller's to read; the households are only
   * counted, never named.
   */
  async overview(tx: TenantTx, projectId: string, sectionId: string | undefined): Promise<ProgressOverview> {
    const section = sectionId === undefined ? null : sectionId;
    const sections = await tx.query<{
      id: string;
      code: string;
      name: string;
      status: string;
      required_area_m2: string;
      handed_area_m2: string;
      target_date: string | null;
      parcels: string;
      noticed: string;
      paid: string;
      handed_over: string;
    }>(
      `select s.id, s.code, s.name, s.status, s.required_area_m2::text as required_area_m2, s.handed_area_m2::text as handed_area_m2, s.target_date::text as target_date,
              count(pc.id) as parcels, count(pc.id) filter (where pc.recovery_notice_on is not null) as noticed,
              count(pc.id) filter (where pc.status in ('PAID', 'HANDED_OVER')) as paid, count(pc.id) filter (where pc.status = 'HANDED_OVER') as handed_over
         from machvon.land_handover_section s
         left join machvon.land_parcel pc on pc.tenant_id = s.tenant_id and pc.section_id = s.id
        where s.project_id = $1::uuid and ($2::uuid is null or s.id = $2::uuid)
        group by s.tenant_id, s.id order by s.code, s.id`,
      [projectId, section],
    );
    const statuses = await tx.query<{ status: string; n: string }>(
      `select pc.status, count(*) as n from machvon.land_parcel pc
        where pc.project_id = $1::uuid and ($2::uuid is null or pc.section_id = $2::uuid) group by pc.status order by pc.status`,
      [projectId, section],
    );
    const sums = (
      await tx.query<CountsSql>(
        `select count(*) as sections, count(*) filter (where status = 'HANDED_OVER') as sections_handed_over,
                coalesce(sum(required_area_m2), 0)::text as required_area_m2, coalesce(sum(handed_area_m2), 0)::text as handed_area_m2
           from machvon.land_handover_section where project_id = $1::uuid and ($2::uuid is null or id = $2::uuid)`,
        [projectId, section],
      )
    )[0];
    const households = (await tx.query<{ n: string }>('select count(*) as n from machvon.affected_household where project_id = $1::uuid', [projectId]))[0];
    const plans = (
      await tx.query<{ posted: string }>(
        `select count(*) filter (where status in ('POSTING', 'POSTING_CLOSED', 'APPROVED', 'PAYING', 'COMPLETED')) as posted from machvon.compensation_plan
          where project_id = $1::uuid and ($2::uuid is null or section_id = $2::uuid)`,
        [projectId, section],
      )
    )[0];
    const payments = (
      await tx.query<{ paid: string; total: string }>(
        `select count(*) filter (where y.status = 'PAID') as paid, count(*) filter (where y.status <> 'CANCELLED') as total
           from machvon.compensation_payment y join machvon.compensation_plan c on c.tenant_id = y.tenant_id and c.id = y.plan_id
          where c.project_id = $1::uuid and ($2::uuid is null or c.section_id = $2::uuid)`,
        [projectId, section],
      )
    )[0];
    const stages = await tx.query<StageSql>(
      `select ${STAGE_COLUMNS} from machvon.land_stage_progress g
         join machvon.organization_unit eu on eu.tenant_id = g.tenant_id and eu.id = g.executor_unit_id
        where g.project_id = $1::uuid and ($2::uuid is null or g.section_id = $2::uuid)
        order by g.section_id, array_position(array['SURVEY','NOTICE','INVENTORY','PLAN_DRAFT','PLAN_POSTING','PLAN_APPROVAL','PAYMENT','HANDOVER','ENFORCEMENT'], g.stage_code), g.id`,
      [projectId, section],
    );
    const lines = stages.map(toLine);
    const progress = sections.map(
      (row): SectionProgress => ({
        id: row.id,
        code: row.code,
        name: row.name,
        status: row.status,
        requiredAreaM2: row.required_area_m2,
        handedAreaM2: row.handed_area_m2,
        targetDate: row.target_date,
        parcels: Number(row.parcels),
        parcelsNoticed: Number(row.noticed),
        parcelsPaid: Number(row.paid),
        parcelsHandedOver: Number(row.handed_over),
      }),
    );
    const total = (pick: (row: SectionProgress) => number): number => progress.reduce((sum, row) => sum + pick(row), 0);
    return {
      projectId,
      totals: {
        sections: Number(sums?.sections ?? 0),
        sectionsHandedOver: Number(sums?.sections_handed_over ?? 0),
        requiredAreaM2: sums?.required_area_m2 ?? '0',
        handedAreaM2: sums?.handed_area_m2 ?? '0',
        parcels: total((row) => row.parcels),
        parcelsNoticed: total((row) => row.parcelsNoticed),
        parcelsPaid: total((row) => row.parcelsPaid),
        parcelsHandedOver: total((row) => row.parcelsHandedOver),
        households: Number(households?.n ?? 0),
        plansPosted: Number(plans?.posted ?? 0),
        paymentsPaid: Number(payments?.paid ?? 0),
        paymentsTotal: Number(payments?.total ?? 0),
        lateStages: lines.filter((line) => line.status === 'LATE').length,
      },
      parcelsByStatus: Object.fromEntries(statuses.map((row) => [row.status, Number(row.n)])),
      sections: progress,
      stages: lines,
    };
  }
}

/** What one pass of the job did for a tenant. */
export interface StageLateResult {
  /** Stages that became LATE in this pass: each asks ISS for one issue through its event. */
  late: number;
}

/**
 * The job `land-stage-late` (ST-LND-010): a stage that is not done and whose planned end is behind the Vietnam date of the pass becomes LATE, once, with the event that the issue
 * intake of ISS answers by opening one issue (BR-ISS-07: not a second while that one is open). A stage already LATE is left alone, so a second pass the same day does nothing.
 * Reports that arrive after the day passed (R-LND-03) are judged by the same rule when they come. The pass takes the clock as an argument, so a test turns it by hand.
 */
export class LndStageLateJob {
  private readonly audit: Pick<AuditWriter, 'recordInTx'>;

  constructor(audit: Pick<AuditWriter, 'recordInTx'>) {
    this.audit = audit;
  }

  async run(tx: TenantTx, actor: string, now: Date): Promise<StageLateResult> {
    const today = vietnamDateOf(now);
    const correlationId = randomUUID();
    const due = await tx.query<{
      id: string;
      tenant_id: string;
      project_id: string;
      owner_unit_id: string;
      section_code: string;
      stage_code: string;
      executor_kind: string;
      planned_end: string;
      status: string;
      version: string;
    }>(
      `select g.id, g.tenant_id::text as tenant_id, g.project_id, p.owner_unit_id, s.code as section_code, g.stage_code, g.executor_kind, g.planned_end::text as planned_end, g.status, g.version::text as version
         from machvon.land_stage_progress g
         join machvon.project p on p.tenant_id = g.tenant_id and p.id = g.project_id
         join machvon.land_handover_section s on s.tenant_id = g.tenant_id and s.id = g.section_id
        where g.status in ('NOT_STARTED', 'IN_PROGRESS', 'BLOCKED') and g.planned_end < $1::date
        order by g.planned_end, g.id
        for update of g skip locked`,
      [today],
    );
    for (const stage of due) {
      const version = Number(stage.version) + 1;
      await tx.query(`update machvon.land_stage_progress set status = 'LATE', version = $2::bigint, updated_at = now(), updated_by = $3::uuid where id = $1::uuid`, [stage.id, version, actor]);
      await this.audit.recordInTx(tx, actor, {
        action: 'lnd.stage_late',
        resourceType: RESOURCE_TYPE,
        resourceId: stage.id,
        classification: CLASSIFICATION,
        diff: { project_id: stage.project_id, stage_code: stage.stage_code, from_status: stage.status, to_status: 'LATE', planned_end: stage.planned_end },
        correlationId,
        requestId: randomUUID(),
      });
      await enqueueOutbox(
        tx,
        {
          ...stageLateEvent(
            { id: stage.id, projectId: stage.project_id, ownerUnitId: stage.owner_unit_id, sectionCode: stage.section_code, stageCode: stage.stage_code, executorKind: stage.executor_kind, plannedEnd: stage.planned_end, version },
            stage.tenant_id,
            now,
          ),
          correlationId,
        },
      );
    }
    return { late: due.length };
  }
}
