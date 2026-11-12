import { createHash, randomUUID } from 'node:crypto';
import { DomainError, canonicalJson, sha256Hex } from '@machvon/kernel';
import type { pwfSchedule } from '@machvon/kernel';
import { PrjBaselineStore } from './prj-baseline-store.ts';
import { loadTasks, pinsOf, writeScheduleDays } from './pwf-schedule-support.ts';
import type { PinnedCalendar, TaskRow } from './pwf-schedule-support.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * Publishing a schedule (PWF-2, R28, R32, BR-PWF-28): one transaction, under the lock of the project the caller holds, writes the version of the schedule (hashes of its input and result, the calendar version of each year, the
 * critical path and what changed), the new days of the tasks, the first baseline when there is none, the milestones that are tasks, and the workflow's own version; a proposal that was based on an older version is superseded.
 */

export type ScheduleKind = 'INITIAL' | 'ADOPTION' | 'RESCHEDULE' | 'PROGRESS';

const MILESTONE_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/;
const MILESTONE_REASON = 'Moved by the schedule of the project workflow';
const CANCELLED_REASON = 'Cancelled with its task in the project workflow';

/** The code a milestone task has as a row of `project_milestone` (30 characters at most: a longer code keeps its head and a hash of the whole). */
export function milestoneCodeOf(taskCode: string): string {
  if (taskCode.length <= 30) return taskCode;
  return `${taskCode.slice(0, 21)}_${createHash('sha256').update(taskCode).digest('hex').slice(0, 8)}`;
}

export interface TaskLogInput {
  workflowId: string;
  taskId?: string | null;
  kind: string;
  actor: string;
  reason?: string | null | undefined;
  subject?: Record<string, unknown>;
}

/** Appends one fact to the log of the workflow (ids, codes and days; the reason is the one the person gave). */
export async function logWorkflow(tx: TenantTx, entry: TaskLogInput): Promise<void> {
  await tx.query(
    `insert into machvon.project_task_log (tenant_id, id, workflow_id, task_id, kind, actor, reason, subject)
     values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6, $7::jsonb)`,
    [randomUUID(), entry.workflowId, entry.taskId ?? null, entry.kind, entry.actor, entry.reason ?? null, JSON.stringify(entry.subject ?? {})],
  );
}

interface MilestoneSql {
  id: string;
  status: string;
  planned_date: string;
}

/**
 * Makes the milestone tasks of a workflow the milestones of the project (R28): a task takes the milestone of its code that the project already has (a row is never copied), else a milestone is made with the first day of the
 * schedule as its baseline day; a milestone that moves later than it was is a move of a date and goes through the baseline hook of PRJ (counted, deviation looked at again); a done or cancelled task closes its milestone.
 */
export async function syncMilestones(tx: TenantTx, projectId: string, tasks: readonly TaskRow[], actor: string, today: string, baseline: PrjBaselineStore, firstPublication = false): Promise<void> {
  const linked = new Set<string>();
  for (const task of tasks) {
    if (task.kind !== 'MILESTONE' || task.excluded || !task.tracked) continue;
    const code = milestoneCodeOf(task.code);
    if (!MILESTONE_CODE.test(code)) throw new DomainError('PWF_SCHEDULE_INVALID', 422, 'task_code');
    let milestoneId = task.milestoneId;
    if (milestoneId === null) {
      if (task.plannedFinish === null) continue;
      const found = await tx.query<MilestoneSql>('select id, status, planned_date::text as planned_date from machvon.project_milestone where project_id = $1::uuid and code = $2', [projectId, code]);
      if (found[0] !== undefined) {
        milestoneId = found[0].id;
        linked.add(task.id);
      } else {
        milestoneId = randomUUID();
        await tx.query(
          `insert into machvon.project_milestone (tenant_id, id, project_id, code, name, baseline_date, planned_date, status, created_by, updated_by)
           values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4, $5::date, $5::date, 'PLANNED', $6::uuid, $6::uuid)`,
          [milestoneId, projectId, code, task.name.padEnd(2, '.'), task.baselineFinish ?? task.plannedFinish, actor],
        );
      }
      await tx.query('update machvon.project_task set milestone_id = $2::uuid where id = $1::uuid', [task.id, milestoneId]);
    }
    // A milestone the project already had keeps its day when the workflow is attached: attaching moves nothing the baseline, the risk signals and the reports already read (R28). Later schedules move it, as a move of a date.
    if (firstPublication && linked.has(task.id)) continue;
    const [row] = await tx.query<MilestoneSql>('select id, status, planned_date::text as planned_date from machvon.project_milestone where id = $1::uuid for update', [milestoneId]);
    if (row === undefined) continue;
    if (task.status === 'CANCELLED') {
      if (row.status !== 'DONE' && row.status !== 'CANCELLED') await tx.query(`update machvon.project_milestone set status = 'CANCELLED', status_reason = $2, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid`, [row.id, CANCELLED_REASON, actor]);
      continue;
    }
    if (task.status === 'DONE') {
      if (row.status !== 'DONE' && row.status !== 'CANCELLED' && task.actualFinish !== null) {
        await tx.query(`update machvon.project_milestone set status = 'DONE', actual_date = $2::date, status_reason = null, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid`, [row.id, task.actualFinish, actor]);
      }
      continue;
    }
    if (task.plannedFinish === null || row.planned_date === task.plannedFinish || (row.status !== 'PLANNED' && row.status !== 'DELAYED')) continue;
    const later = task.plannedFinish > row.planned_date;
    await tx.query(
      `update machvon.project_milestone set planned_date = $2::date, status = $3, status_reason = $4, updated_at = now(), updated_by = $5::uuid, version = version + 1 where id = $1::uuid`,
      [row.id, task.plannedFinish, later ? 'DELAYED' : row.status, later || row.status === 'DELAYED' ? MILESTONE_REASON : null, actor],
    );
    if (later) await baseline.afterMilestoneMove(tx, { id: projectId }, { milestoneId: row.id, code, fromDate: row.planned_date, toDate: task.plannedFinish, reason: MILESTONE_REASON }, actor, today);
  }
}

export interface PublishRequest {
  workflow: { id: string; projectId: string; version: number; scheduleVersion: number };
  kind: ScheduleKind;
  result: pwfSchedule.ScheduleResult;
  calendars: readonly PinnedCalendar[];
  inputHash: string;
  changes: readonly pwfSchedule.ScheduleChange[];
  reason: string | null;
  proposedBy: string;
  approvedBy: string | null;
  today: string;
  /** The proposal this publication carries out, which is not superseded by it. */
  proposalId?: string | undefined;
  /** The workflow row keeps the pins of this publication (always: a reschedule may change them). */
  baseline?: PrjBaselineStore;
}

export interface Published {
  scheduleVersion: number;
  workflowVersion: number;
  resultHash: string;
  firstBaseline: boolean;
}

/** The hash of the days of a schedule: what two runs of the same input must agree on. */
export const resultHashOf = (result: pwfSchedule.ScheduleResult): string => sha256Hex(canonicalJson(result.tasks.map((task) => [task.code, task.state, task.start, task.finish, task.totalFloat, task.critical])));

export async function publishSchedule(tx: TenantTx, request: PublishRequest): Promise<Published> {
  const { workflow, result } = request;
  const scheduleVersion = workflow.scheduleVersion + 1;
  const firstBaseline = scheduleVersion === 1;
  const resultHash = resultHashOf(result);
  await tx.query(
    `insert into machvon.project_schedule_version (tenant_id, id, workflow_id, version, kind, input_hash, result_hash, calendar_versions, critical_path, changes, project_start, project_finish, reason, proposed_by, approved_by)
     values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::int, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::date, $11::date, $12, $13::uuid, $14::uuid)`,
    [randomUUID(), workflow.id, scheduleVersion, request.kind, request.inputHash, resultHash, JSON.stringify(pinsOf(request.calendars)), JSON.stringify(result.criticalPath), JSON.stringify(request.changes), result.projectStart, result.projectFinish, request.reason, request.proposedBy, request.approvedBy],
  );
  await writeScheduleDays(tx, workflow.id, result, scheduleVersion, firstBaseline);
  const rows = await loadTasks(tx, workflow.id);
  if (firstBaseline) {
    const baselineId = randomUUID();
    await tx.query(
      `insert into machvon.project_workflow_baseline (tenant_id, id, workflow_id, version, reason, planned_start, planned_finish, schedule_version, taken_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, 1, 'The first schedule of the workflow', $3::date, $4::date, 1, $5::uuid)`,
      [baselineId, workflow.id, result.projectStart, result.projectFinish, request.proposedBy],
    );
    await tx.query(
      `insert into machvon.project_task_baseline (tenant_id, baseline_id, task_id, start_day, finish_day)
       select nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, t.id, t.planned_start, t.planned_finish from machvon.project_task t where t.workflow_id = $2::uuid and t.planned_start is not null`,
      [baselineId, workflow.id],
    );
  }
  await syncMilestones(tx, workflow.projectId, rows, request.proposedBy, request.today, request.baseline ?? new PrjBaselineStore(), firstBaseline);
  const updated = await tx.query<{ version: number }>(
    `update machvon.project_workflow set schedule_version = $2::int, calendar_pins = $3::jsonb, version = version + 1, updated_at = now(), updated_by = $4::uuid where id = $1::uuid returning version`,
    [workflow.id, scheduleVersion, JSON.stringify(pinsOf(request.calendars)), request.approvedBy ?? request.proposedBy],
  );
  // A proposal that was computed on an older version of the workflow is no longer what the schedule is: it is superseded, so nobody approves a preview of a schedule that has gone (BR-PWF-28).
  await tx.query(
    `update machvon.project_reschedule_proposal set status = 'SUPERSEDED', decided_at = now(), version = version + 1 where workflow_id = $1::uuid and status = 'PROPOSED' and ($2::uuid is null or id <> $2::uuid)`,
    [workflow.id, request.proposalId ?? null],
  );
  return { scheduleVersion, workflowVersion: (updated[0] as { version: number }).version, resultHash, firstBaseline };
}
