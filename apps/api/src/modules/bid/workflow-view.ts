import { PERMISSIONS } from '@machvon/contracts';
import type { BidWorkflowDetail, BidWorkflowPackageRow } from '@machvon/db';
import { effectivePermissions, holdsPermission } from '@machvon/kernel';
import type { EffectiveAccess, ProcessTree, ResourceRef, TimelineEntry } from '@machvon/kernel';

type Reach = BidWorkflowPackageRow['reach'];
type Names = ReadonlyMap<string, string>;

const refsOf = (reach: Reach, projectId: string): ResourceRef[] => [reach.ownerUnit, ...(reach.investorUnit === null ? [] : [reach.investorUnit])].map((unit) => ({ ownerUnitPath: unit.path, ownerUnitId: unit.id, projectId }));

/** Whether the caller holds `permission` over the project the package lies in (the server judges the command again). */
export function holds(access: EffectiveAccess, permission: string, reach: Reach, projectId: string, now: Date): boolean {
  return refsOf(reach, projectId).some((ref) => holdsPermission(effectivePermissions(access, now, ref), permission));
}

export const person = (id: string | null | undefined, names: Names): Record<string, unknown> | null => (id === null || id === undefined ? null : { id, name: names.get(id) ?? null });

/** A package of a list, a board or a node, as the screens read it: an allowlist; the caller's possible commands are told so the screen offers no button the server would refuse. */
export function rowDto(row: BidWorkflowPackageRow, access: EffectiveAccess, now: Date): Record<string, unknown> {
  const running = row.status === 'IN_PROGRESS' || row.status === 'ON_HOLD';
  const may = (permission: string): boolean => holds(access, permission, row.reach, row.projectId, now);
  return {
    package_id: row.packageId,
    package_code: row.packageCode,
    title: row.title,
    value_vnd: row.valueVnd,
    method: row.method,
    project: { id: row.projectId, code: row.projectCode, name: row.projectName },
    unit: { id: row.unitId, name: row.unitName },
    workflow_id: row.workflowId,
    status: row.status,
    step: row.currentStep === null ? null : { code: row.currentStep, name: row.currentStepName, order: row.stepOrder ?? 0, of: row.stepsTotal ?? 0 },
    visit: row.visit,
    entered_on: row.enteredOn,
    days_in_step: row.daysInStep === null ? null : { calendar_days: row.daysInStep.calendarDays, working_days: row.daysInStep.workingDays },
    due_on: row.dueOn,
    countdown: row.countdown === null ? null : { days_left: row.countdown.daysLeft, due_on: row.countdown.dueOn },
    late: row.late,
    late_days: row.lateDays,
    hold_reason: row.holdReason,
    owner: row.ownerId === null ? null : { id: row.ownerId, name: row.ownerName },
    last_activity_on: row.lastActivityOn,
    stalled: row.stalled,
    progress_percent: row.progress === null ? null : row.progress.percent,
    open_required_items: row.openRequiredItems,
    substate: row.substate,
    sparkline: row.sparkline.map((one) => ({ step_code: one.stepCode, days: one.days })),
    version: row.version,
    actions: {
      start: row.workflowId === null && may(PERMISSIONS.startPackageWorkflow),
      advance: row.status === 'IN_PROGRESS' && may(PERMISSIONS.advancePackageStep),
      hold: row.status === 'IN_PROGRESS' && may(PERMISSIONS.holdPackageWorkflow),
      resume: row.status === 'ON_HOLD' && may(PERMISSIONS.resumePackageWorkflow),
      assign_owner: running && may(PERMISSIONS.assignPackageWorkflowOwner),
      return: row.status === 'IN_PROGRESS' && (row.stepOrder ?? 0) > 1 && may(PERMISSIONS.returnPackageStep),
      cancel: running && may(PERMISSIONS.cancelPackageWorkflow),
    },
  };
}

export function entryDto(entry: TimelineEntry, names: Names): Record<string, unknown> {
  return {
    id: entry.id,
    kind: entry.kind,
    at: entry.at,
    day: entry.day,
    from_step: entry.from,
    to_step: entry.to,
    actor: person(entry.actor, names),
    spent_calendar_days: entry.spentCalendarDays,
    spent_working_days: entry.spentWorkingDays,
    reason: entry.reason,
    evidence: entry.evidence.map((one) => ({ kind: one.kind, document_id: one.documentId, milestone_kind: one.milestoneKind, reference: one.reference })),
    subject: entry.subject,
    state_change: entry.stateChange,
  };
}

export const timelineDto = (value: { days: ReadonlyArray<{ day: string; entries: readonly TimelineEntry[]; stateChanges: number; checklistDone: number }>; summary: BidWorkflowDetail['workflow'] extends null ? never : NonNullable<BidWorkflowDetail['workflow']>['summary']; gantt: NonNullable<BidWorkflowDetail['workflow']>['gantt']; empty: boolean; asOf: string }, names: Names): Record<string, unknown> => ({
  days: value.days.map((day) => ({ day: day.day, entries: day.entries.map((entry) => entryDto(entry, names)), state_changes: day.stateChanges, checklist_done: day.checklistDone })),
  summary: value.summary.map((one) => ({ step_code: one.stepCode, order: one.order, days: one.days, basis: one.basis, standard_working_days: one.standardWorkingDays, days_over: one.daysOver, current: one.current })),
  gantt: value.gantt.map((one) => ({ step_code: one.stepCode, order: one.order, planned: one.planned === null ? null : { start_on: one.planned.startOn, end_on: one.planned.endOn }, actual: one.actual === null ? null : { start_on: one.actual.startOn, end_on: one.actual.endOn, open: one.actual.open } })),
  empty: value.empty,
  as_of: value.asOf,
});

/** The ids of the people a detail names, so one lookup gives all their names. */
export function peopleOf(detail: BidWorkflowDetail): string[] {
  const workflow = detail.workflow;
  if (workflow === null) return [];
  const ids: Array<string | null> = [workflow.ownerId];
  for (const item of workflow.checklist) ids.push(item.completedBy, item.ownerId);
  for (const one of workflow.exceptions) ids.push(one.requestedBy, one.decidedBy);
  for (const one of workflow.history) ids.push(one.enteredBy, one.exitedBy);
  for (const entry of workflow.timeline) ids.push(entry.actor);
  return ids.filter((id): id is string => id !== null);
}

export function detailDto(detail: BidWorkflowDetail, access: EffectiveAccess, names: Names, now: Date): Record<string, unknown> {
  const workflow = detail.workflow;
  const may = (permission: string): boolean => holds(access, permission, detail.reach, detail.projectId, now);
  const running = workflow !== null && (workflow.status === 'IN_PROGRESS' || workflow.status === 'ON_HOLD');
  return {
    package: { id: detail.packageId, code: detail.packageCode, title: detail.title, value_vnd: detail.valueVnd, method: detail.method, status: detail.packageStatus },
    project: { id: detail.projectId, code: detail.projectCode, name: detail.projectName },
    unit_name: detail.unitName,
    workflow:
      workflow === null
        ? null
        : {
            id: workflow.id,
            status: workflow.status,
            step: workflow.currentStep === null ? null : { code: workflow.currentStep, name: workflow.currentStepName, visit: workflow.currentVisit ?? 0, standard_working_days: workflow.standardWorkingDays },
            owner: person(workflow.ownerId, names),
            hold_reason: workflow.holdReason,
            held_at: workflow.heldAt,
            started_at: workflow.startedAt,
            ended_at: workflow.endedAt,
            end_reason: workflow.endReason,
            last_activity_on: workflow.lastActivityOn,
            definition: { rule_version: workflow.definitionRuleVersion, hash: workflow.definitionHash, unverified: workflow.definitionRuleVersion === 0 },
            entered_on: workflow.enteredOn,
            due_on: workflow.dueOn,
            countdown: workflow.countdown === null ? null : { days_left: workflow.countdown.daysLeft, due_on: workflow.countdown.dueOn },
            days_in_step: workflow.daysInStep === null ? null : { calendar_days: workflow.daysInStep.calendarDays, working_days: workflow.daysInStep.workingDays },
            late: workflow.late,
            progress: {
              steps_total: workflow.progress.stepsTotal,
              steps_done: workflow.progress.stepsDone,
              current_order: workflow.progress.currentOrder,
              items_required: workflow.progress.itemsRequired,
              items_required_done: workflow.progress.itemsRequiredDone,
              percent: workflow.progress.percent,
            },
            blockers: workflow.blockers.map((one) => ({ reason: one.reason, count: one.count, detail: one.detail })),
            steps: workflow.steps.map((one) => ({ code: one.code, name: one.name, order: one.order, standard_working_days: one.standardWorkingDays, responsible_role: one.responsibleRole, entry_condition: one.entryCondition, exit_condition: one.exitCondition, maker_checker: one.makerChecker, evidence_kinds: one.evidenceKinds, milestone_kind: one.milestoneKind })),
            checklist: workflow.checklist.map((one) => ({
              id: one.id,
              code: one.code,
              name: one.name,
              required: one.required,
              status: one.status,
              due_on: one.dueOn,
              completed_at: one.completedAt,
              completed_by: person(one.completedBy, names),
              completed_via: one.completedVia,
              owner: person(one.ownerId, names),
              evidence_required: one.evidenceRequired,
              allowed_kinds: one.allowedKinds,
              milestone_kind: one.milestoneKind,
              evidence: one.evidence.map((evidence) => ({ kind: evidence.kind, document_id: evidence.documentId, milestone_kind: evidence.milestoneKind, reference: evidence.reference })),
              version: one.version,
            })),
            exceptions: workflow.exceptions.map((one) => ({ id: one.id, kind: one.kind, status: one.status, reason: one.reason, requested_by: person(one.requestedBy, names), requested_at: one.requestedAt, decided_by: person(one.decidedBy, names), decided_at: one.decidedAt, decision_note: one.decisionNote, step_code: one.stepCode })),
            history: workflow.history.map((one) => ({ visit: one.visit, step_code: one.stepCode, entered_at: one.enteredAt, entered_by: person(one.enteredBy, names), entry_kind: one.entryKind, exited_at: one.exitedAt, exited_by: person(one.exitedBy, names), exit_kind: one.exitKind, due_on: one.dueOn, note: one.note })),
            links: {
              milestones: workflow.links.milestones.map((one) => ({ id: one.id, kind: one.kind, actual_at: one.actualAt, planned_at: one.plannedAt, source: one.source })),
              petitions: workflow.links.petitions,
              result: workflow.links.result,
              contract: workflow.links.contract,
            },
            timeline: timelineDto({ days: groupDays(workflow.timeline), summary: workflow.summary, gantt: workflow.gantt, empty: workflow.timeline.length === 0, asOf: detail.asOf }, names),
            version: workflow.version,
          },
    ...(workflow === null ? { startable: detail.startable ?? false, definition_steps: (detail.definitionSteps ?? []).map((one) => ({ code: one.code, name: one.name, order: one.order, standard_working_days: one.standardWorkingDays })) } : {}),
    actions: {
      start: workflow === null && (detail.startable ?? false) && may(PERMISSIONS.startPackageWorkflow),
      advance: workflow?.status === 'IN_PROGRESS' && may(PERMISSIONS.advancePackageStep),
      hold: workflow?.status === 'IN_PROGRESS' && may(PERMISSIONS.holdPackageWorkflow),
      resume: workflow?.status === 'ON_HOLD' && may(PERMISSIONS.resumePackageWorkflow),
      assign_owner: running && may(PERMISSIONS.assignPackageWorkflowOwner),
      work: workflow?.status === 'IN_PROGRESS' && may(PERMISSIONS.completePackageChecklistItem),
      return: workflow?.status === 'IN_PROGRESS' && (workflow.progress.currentOrder ?? 0) > 1 && may(PERMISSIONS.returnPackageStep),
      request_exception: workflow?.status === 'IN_PROGRESS' && may(PERMISSIONS.requestPackageStepException),
      decide_exception: running && workflow.exceptions.some((one) => one.status === 'REQUESTED') && may(PERMISSIONS.decidePackageStepException),
      cancel: running && may(PERMISSIONS.cancelPackageWorkflow),
    },
    as_of: detail.asOf,
  };
}

/** The timeline entries of a detail grouped by day, newest day first (the order of the screen). */
function groupDays(entries: readonly TimelineEntry[]): Array<{ day: string; entries: TimelineEntry[]; stateChanges: number; checklistDone: number }> {
  const days = new Map<string, TimelineEntry[]>();
  for (const entry of entries) days.set(entry.day, [...(days.get(entry.day) ?? []), entry]);
  return [...days.entries()]
    .sort((left, right) => right[0].localeCompare(left[0]))
    .map(([day, list]) => ({ day, entries: [...list].reverse(), stateChanges: list.filter((entry) => entry.stateChange).length, checklistDone: list.filter((entry) => entry.kind === 'CHECKLIST_DONE').length }));
}

export function treeDto(tree: ProcessTree, extras: { truncated: boolean; asOf: string; running: number; late: number; stalled: number; onHold: number; noOwner: number; medianDays: number | null }): Record<string, unknown> {
  return {
    period: tree.period,
    total: { count: tree.totalCount, value_vnd: tree.totalValueVnd },
    nodes: tree.nodes.map((node) => ({
      id: node.id,
      parent_id: node.parentId,
      kind: node.kind,
      method: node.method,
      step_code: node.stepCode,
      substate: node.substate,
      terminal: node.terminal,
      label: node.label,
      order: node.order,
      count: node.count,
      value_vnd: node.valueVnd,
      share_count_bp: node.shareCountBp,
      share_value_bp: node.shareValueBp,
      median_days: node.medianDays,
      median_basis: node.medianBasis,
      late_count: node.lateCount,
      path: [...node.path],
      route: [...node.route],
    })),
    edges: tree.edges.map((edge) => ({ from: edge.from, to: edge.to, kind: edge.kind, count: edge.count })),
    kpis: { running: extras.running, late: extras.late, stalled: extras.stalled, on_hold: extras.onHold, no_owner: extras.noOwner, median_days: extras.medianDays },
    truncated: extras.truncated,
    as_of: extras.asOf,
  };
}
