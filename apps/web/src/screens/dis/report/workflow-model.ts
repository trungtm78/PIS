import type { StepperStatus, StepperStep } from '../../../ui';

/** The steps of the approval of a report as `getReportWorkflow` answers them (WF-1): the rule in force, the instance the report had last and each step with its deadline and the people it was given to. */
export type StepState = 'WAITING' | 'CURRENT' | 'DONE' | 'CANCELLED';
export type WorkflowMode = 'SINGLE_DECISION' | 'STAGED';

export interface WorkflowTask {
  taskId: string;
  assigneeId: string;
  assigneeName: string | null;
  status: string;
  decision: string | null;
  decidedAt: string | null;
  dueAt: string;
  overdueReminders: number;
  escalatedAt: string | null;
}

export interface WorkflowStep {
  id: string;
  kind: string;
  name: string;
  state: StepState;
  slaWorkingHours: number;
  dueAt: string | null;
  overdue: boolean;
  tasks: WorkflowTask[];
}

export interface ReportWorkflow {
  mode: WorkflowMode;
  ruleVersion: number;
  /** The status of the instance the report had last, or null when it has none (the default definition runs no instance). */
  instanceStatus: string | null;
  steps: WorkflowStep[];
}

const STATES: readonly StepState[] = ['WAITING', 'CURRENT', 'DONE', 'CANCELLED'];
const DAY_MS = 86_400_000;
const WORKING_DAY_HOURS = 8;

const record = (value: unknown): Record<string, unknown> | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function taskOf(raw: unknown): WorkflowTask | undefined {
  const task = record(raw);
  const assignee = record(task?.assignee);
  if (task === undefined || assignee === undefined || typeof task.task_id !== 'string' || typeof assignee.id !== 'string') return undefined;
  return {
    taskId: task.task_id,
    assigneeId: assignee.id,
    assigneeName: text(assignee.name),
    status: text(task.status) ?? '',
    decision: text(task.decision),
    decidedAt: text(task.decided_at),
    dueAt: text(task.due_at) ?? '',
    overdueReminders: typeof task.overdue_reminders === 'number' ? task.overdue_reminders : 0,
    escalatedAt: text(task.escalated_at),
  };
}

function stepOf(raw: unknown): WorkflowStep | undefined {
  const step = record(raw);
  if (step === undefined || typeof step.id !== 'string' || typeof step.name !== 'string') return undefined;
  const state = STATES.find((candidate) => candidate === step.status);
  if (state === undefined) return undefined;
  return {
    id: step.id,
    kind: text(step.kind) ?? '',
    name: step.name,
    state,
    slaWorkingHours: typeof step.sla_working_hours === 'number' ? step.sla_working_hours : 0,
    dueAt: text(step.due_at),
    overdue: step.overdue === true,
    tasks: Array.isArray(step.tasks) ? step.tasks.flatMap((task) => taskOf(task) ?? []) : [],
  };
}

/** The workflow of a report from the answer of the server; an answer that is not one is no workflow. */
export function toWorkflow(raw: unknown): ReportWorkflow | undefined {
  const body = record(raw);
  if (body === undefined || !Array.isArray(body.steps)) return undefined;
  const mode: WorkflowMode | undefined = body.mode === 'STAGED' ? 'STAGED' : body.mode === 'SINGLE_DECISION' ? 'SINGLE_DECISION' : undefined;
  if (mode === undefined) return undefined;
  return { mode, ruleVersion: typeof body.rule_version === 'number' ? body.rule_version : 0, instanceStatus: text(record(body.instance)?.status), steps: body.steps.flatMap((step) => stepOf(step) ?? []) };
}

/** The screen shows the steps when the tenant runs the staged approval or the report went through an instance; on the default definition the one decision is what it always was. */
export const showsSteps = (workflow: ReportWorkflow): boolean => workflow.mode === 'STAGED' || workflow.instanceStatus !== null;

const STATUS_OF: Readonly<Record<StepState, StepperStatus>> = { DONE: 'done', CURRENT: 'current', WAITING: 'upcoming', CANCELLED: 'skipped' };

/** The days a step is given: its working hours counted in days of 8 hours, at least one. */
export const plannedDaysOf = (slaWorkingHours: number): number => Math.max(1, Math.ceil(slaWorkingHours / WORKING_DAY_HOURS));

/** The steps for the stepper of the kit: a current step past its deadline is late by whole days (at least one). */
export function stepperOf(steps: readonly WorkflowStep[], now: Date, label: (step: WorkflowStep) => string): StepperStep[] {
  return steps.map((step) => {
    const late = step.state === 'CURRENT' && step.overdue && step.dueAt !== null;
    return {
      code: step.id,
      label: label(step),
      status: late ? 'late' : STATUS_OF[step.state],
      current: step.state === 'CURRENT',
      plannedDays: plannedDaysOf(step.slaWorkingHours),
      ...(late && step.dueAt !== null ? { lateDays: Math.max(1, Math.floor((now.getTime() - Date.parse(step.dueAt)) / DAY_MS)) } : {}),
    };
  });
}
