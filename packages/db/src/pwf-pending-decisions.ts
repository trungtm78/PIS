import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';
import { withScoreScope } from './pwf-score-support.ts';
import type { ScoreUnits } from './pwf-score-support.ts';

/** The kinds of record of the project workflow that wait for a decision of a second person, outside the approval engine of ADM. */
export type PwfPendingKind = 'pwf.task.completion' | 'pwf.task.exception' | 'pwf.reschedule' | 'pwf.score.adjustment';

/** One record that waits for the reader to decide it, with what they read before deciding. Codes and values, never a sentence. */
export interface PwfPendingDecision {
  kind: PwfPendingKind;
  resourceType: string;
  resourceId: string;
  /** The version the command of the decision is sent under (`If-Match`): of the task, of the exception, of the adjustment, or the version of the workflow the proposal was made on. */
  version: number;
  submittedAt: string;
  initiatorName: string | null;
  subjectName: string | null;
  unit: { id: string; code: string | null; name: string | null } | null;
  project: { id: string; code: string; name: string } | null;
  period: { from: string; to: string; status: string } | null;
  facts: Array<{ code: string; value: string | number | null }>;
  body: string | null;
  target: { screen: string; id: string };
}

export interface PwfPendingViewer {
  membershipId: string;
  /** The projects the reader may decide in, by the permission of each command: completions and exceptions (`pwf.task.approve`), proposals of a new schedule (`pwf.schedule.approve`). */
  taskApprove: ScopeBuilder;
  scheduleApprove: ScopeBuilder;
  /** The units whose adjustments of scores the reader may decide (`staff_score.approve`); empty reads none. */
  scoreUnits: ScoreUnits;
}

const ISO = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const PERSON = (alias: string, member: string): string => `(select d.display_name from machvon.tenant_user_directory d where d.tenant_id = ${alias}.tenant_id and d.membership_id = ${member})`;
const PLACE = 'p.id as project_id, p.code as project_code, p.name as project_name, ou.id as unit_id, ou.code as unit_code, ou.name as unit_name';

interface PlaceSql {
  project_id: string;
  project_code: string;
  project_name: string | null;
  unit_id: string;
  unit_code: string | null;
  unit_name: string | null;
}

const placeOf = (row: PlaceSql): Pick<PwfPendingDecision, 'project' | 'unit'> => ({
  project: { id: row.project_id, code: row.project_code, name: row.project_name ?? row.project_code },
  unit: { id: row.unit_id, code: row.unit_code, name: row.unit_name },
});

const numberOf = (value: string | null): number | null => (value === null ? null : Number(value));

/**
 * What waits for one person to decide in the project workflow, read for the unified approval inbox (PWF 20.9, lane fix12). These records are not tasks of the approval engine: nobody is assigned, and whoever holds the
 * permission of the command in the scope of the record decides. The read answers exactly what the command would accept from this reader: the same permission in the same scope, and never the reader's own request
 * (the commands refuse it with `SELF_APPROVAL_DENIED`, `MAKER_IS_APPROVER` or, for the person a score is about, `STAFF_SCORE_ADJUSTMENT_INVALID`). The command judges again when the decision is sent.
 */
export class PwfPendingDecisionReads {
  async list(tx: TenantTx, viewer: PwfPendingViewer, limit: number): Promise<PwfPendingDecision[]> {
    const found = [...(await this.completions(tx, viewer, limit)), ...(await this.exceptions(tx, viewer, limit)), ...(await this.reschedules(tx, viewer, limit)), ...(await this.adjustments(tx, viewer, limit))];
    return found.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.resourceId.localeCompare(b.resourceId));
  }

  /** The tasks whose completion waits for a second person: the reader did no work on them (who started, attached evidence, ticked an item or asked for the completion is a maker). */
  private async completions(tx: TenantTx, viewer: PwfPendingViewer, limit: number): Promise<PwfPendingDecision[]> {
    const scope = viewer.taskApprove(3);
    if (scope.sql === 'false') return [];
    const rows = await tx.query<PlaceSql & { id: string; version: number; name: string; due_on: string | null; actual_finish: string | null; submitted_at: string | null; initiator: string | null; note: string | null }>(
      `select t.id, t.version, t.name, t.committed_finish::text as due_on, t.actual_finish::text as actual_finish, ${ISO('t.completion_requested_at')} as submitted_at, ${PERSON('t', 't.completion_requested_by')} as initiator,
              (select l.reason from machvon.project_task_log l where l.tenant_id = t.tenant_id and l.task_id = t.id and l.kind = 'COMPLETE_REQUESTED' order by l.at desc, l.id desc limit 1) as note, ${PLACE}
         from ${SCOPE_FROM}
         join machvon.project_task t on t.tenant_id = p.tenant_id and t.project_id = p.id
         join machvon.project_workflow w on w.tenant_id = t.tenant_id and w.id = t.workflow_id and w.status = 'ACTIVE'
        where t.status = 'AWAITING_APPROVAL' and t.tracked and not t.excluded and t.completion_requested_by is distinct from $1::uuid
          and not exists (select 1 from machvon.project_task_evidence e where e.tenant_id = t.tenant_id and e.task_id = t.id and e.attached_by = $1::uuid)
          and not exists (select 1 from machvon.project_task_checklist_item c where c.tenant_id = t.tenant_id and c.task_id = t.id and c.done_by = $1::uuid)
          and not exists (select 1 from machvon.project_task_log l where l.tenant_id = t.tenant_id and l.task_id = t.id and l.actor = $1::uuid and l.kind in ('START', 'COMPLETE_REQUESTED', 'COMPLETED'))
          and ${scope.sql}
        order by t.completion_requested_at, t.id limit $2::integer`,
      [viewer.membershipId, limit, ...scope.params],
    );
    return rows.map((row) => ({
      kind: 'pwf.task.completion',
      resourceType: 'project_task',
      resourceId: row.id,
      version: row.version,
      submittedAt: row.submitted_at ?? new Date(0).toISOString(),
      initiatorName: row.initiator,
      subjectName: null,
      ...placeOf(row),
      period: null,
      facts: [
        { code: 'TASK', value: row.name },
        { code: 'DUE_DATE', value: row.due_on },
        { code: 'ACTUAL_FINISH', value: row.actual_finish },
      ],
      body: row.note,
      target: { screen: 'PWF-04', id: row.id },
    }));
  }

  /** The exceptions of a task (a waived item or paper, a pause, a cancellation, a delay from outside) that somebody else asked for. */
  private async exceptions(tx: TenantTx, viewer: PwfPendingViewer, limit: number): Promise<PwfPendingDecision[]> {
    const scope = viewer.taskApprove(3);
    if (scope.sql === 'false') return [];
    const rows = await tx.query<PlaceSql & { id: string; version: number; kind: string; reason: string; valid_from: string; valid_to: string | null; items: string[]; submitted_at: string; initiator: string | null; task_id: string; name: string; due_on: string | null }>(
      `select x.id, x.version, x.kind, x.reason, x.valid_from::text as valid_from, x.valid_to::text as valid_to, x.items, ${ISO('x.requested_at')} as submitted_at, ${PERSON('x', 'x.requested_by')} as initiator,
              t.id as task_id, t.name, t.committed_finish::text as due_on, ${PLACE}
         from ${SCOPE_FROM}
         join machvon.project_task t on t.tenant_id = p.tenant_id and t.project_id = p.id
         join machvon.project_task_exception x on x.tenant_id = t.tenant_id and x.task_id = t.id
        where x.status = 'REQUESTED' and x.requested_by <> $1::uuid and ${scope.sql}
        order by x.requested_at, x.id limit $2::integer`,
      [viewer.membershipId, limit, ...scope.params],
    );
    return rows.map((row) => ({
      kind: 'pwf.task.exception',
      resourceType: 'project_task_exception',
      resourceId: row.id,
      version: row.version,
      submittedAt: row.submitted_at,
      initiatorName: row.initiator,
      subjectName: null,
      ...placeOf(row),
      period: null,
      facts: [
        { code: 'TASK', value: row.name },
        { code: 'EXCEPTION_KIND', value: row.kind },
        { code: 'DUE_DATE', value: row.due_on },
        { code: 'VALID_FROM', value: row.valid_from },
        { code: 'VALID_TO', value: row.valid_to },
        ...(Array.isArray(row.items) && row.items.length > 0 ? [{ code: 'WAIVED_ITEMS', value: row.items.length }] : []),
      ],
      body: row.reason,
      target: { screen: 'PWF-04', id: row.task_id },
    }));
  }

  /** The proposals of a new schedule of a running workflow that somebody else made. */
  private async reschedules(tx: TenantTx, viewer: PwfPendingViewer, limit: number): Promise<PwfPendingDecision[]> {
    const scope = viewer.scheduleApprove(3);
    if (scope.sql === 'false') return [];
    const rows = await tx.query<PlaceSql & { id: string; base_version: number; reason: string; submitted_at: string; initiator: string | null; shift_days: string | null; proposed_finish: string | null; changed: number }>(
      `select pr.id, pr.base_version, pr.reason, ${ISO('pr.proposed_at')} as submitted_at, ${PERSON('pr', 'pr.proposed_by')} as initiator,
              pr.preview ->> 'projectFinishShiftDays' as shift_days, pr.preview -> 'schedule' ->> 'projectFinish' as proposed_finish,
              case when jsonb_typeof(pr.preview -> 'changes') = 'array' then jsonb_array_length(pr.preview -> 'changes') else 0 end as changed, ${PLACE}
         from ${SCOPE_FROM}
         join machvon.project_workflow w on w.tenant_id = p.tenant_id and w.project_id = p.id and w.status = 'ACTIVE'
         join machvon.project_reschedule_proposal pr on pr.tenant_id = w.tenant_id and pr.workflow_id = w.id
        where pr.status = 'PROPOSED' and pr.proposed_by <> $1::uuid and ${scope.sql}
        order by pr.proposed_at, pr.id limit $2::integer`,
      [viewer.membershipId, limit, ...scope.params],
    );
    return rows.map((row) => ({
      kind: 'pwf.reschedule',
      resourceType: 'project_reschedule_proposal',
      resourceId: row.id,
      version: row.base_version,
      submittedAt: row.submitted_at,
      initiatorName: row.initiator,
      subjectName: null,
      ...placeOf(row),
      period: null,
      facts: [
        { code: 'PROPOSED_FINISH', value: row.proposed_finish },
        { code: 'FINISH_SHIFT_DAYS', value: numberOf(row.shift_days) },
        { code: 'CHANGED_TASKS', value: Number(row.changed) },
      ],
      body: row.reason,
      target: { screen: 'PWF-06', id: row.project_id },
    }));
  }

  /** The adjustments of a score that wait: asked for by somebody else, and not about the reader. Read inside the units the reader may decide in, as the command reads them. */
  private async adjustments(tx: TenantTx, viewer: PwfPendingViewer, limit: number): Promise<PwfPendingDecision[]> {
    if (viewer.scoreUnits === '') return [];
    const rows = await withScoreScope(tx, { units: viewer.scoreUnits, subject: '' }, () =>
      tx.query<{
        id: string; version: number; points: string; reason: string; submitted_at: string; initiator: string | null; line_id: string; subject: string | null; unit_id: string; unit_code: string | null; unit_name: string | null;
        score_computed: string | null; score_adjusted: string | null; rating: string | null; period_from: string; period_to: string; period_status: string;
      }>(
        `select a.id, a.version, a.points::text as points, a.reason, ${ISO('a.requested_at')} as submitted_at, ${PERSON('a', 'a.requested_by')} as initiator, l.id as line_id, ${PERSON('l', 'l.membership_id')} as subject,
                l.unit_id_at_period as unit_id,
                (select u.code from machvon.organization_unit u where u.tenant_id = l.tenant_id and u.id = l.unit_id_at_period) as unit_code,
                (select u.name from machvon.organization_unit u where u.tenant_id = l.tenant_id and u.id = l.unit_id_at_period) as unit_name,
                l.score_computed::text as score_computed, l.score_adjusted::text as score_adjusted, l.rating, sp.period_from::text as period_from, sp.period_to::text as period_to, sp.status as period_status
           from machvon.staff_score_adjustment a
           join machvon.staff_score_line l on l.tenant_id = a.tenant_id and l.id = a.line_id
           join machvon.staff_score_period sp on sp.tenant_id = l.tenant_id and sp.id = l.period_id
          where a.status = 'REQUESTED' and a.requested_by <> $1::uuid and l.membership_id is distinct from $1::uuid and l.erased_at is null and sp.status <> 'DRAFT'
          order by a.requested_at, a.id limit $2::integer`,
        [viewer.membershipId, limit],
      ),
    );
    return rows.map((row) => ({
      kind: 'pwf.score.adjustment',
      resourceType: 'staff_score_adjustment',
      resourceId: row.id,
      version: row.version,
      submittedAt: row.submitted_at,
      initiatorName: row.initiator,
      subjectName: row.subject,
      unit: { id: row.unit_id, code: row.unit_code, name: row.unit_name },
      project: null,
      period: { from: row.period_from, to: row.period_to, status: row.period_status },
      facts: [
        { code: 'POINTS', value: numberOf(row.points) },
        { code: 'SCORE_COMPUTED', value: numberOf(row.score_computed) },
        { code: 'SCORE_ADJUSTED', value: numberOf(row.score_adjusted) },
        { code: 'RATING', value: row.rating },
      ],
      body: row.reason,
      target: { screen: 'PWF-13', id: row.line_id },
    }));
  }
}
