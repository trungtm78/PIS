import type { TenantName } from '../../suite';
import { fixtureId } from './support';
import type { Marker } from './support';

/** The group digit of the procurement package workflow fragment in the ids of its fixtures. */
const GROUP = 5;

/** The families of ids: the packages, the workflows, the visits of the steps, the checklist items, the evidence, the exceptions and the log rows. */
const FAMILY = { package: 1, workflow: 2, visit: 3, item: 4, evidence: 5, exception: 6, log: 7 } as const;

/**
 * The workflows the isolation suite seeds, each for one command or read, so that a command of the owner changes the workflow of its own case only:
 * `read` (the page of the package and its timeline), `complete` (an open item that asks for an attestation), `assign` (an open item to give a holder), `advance` (a step without items), `return` (a step after two others),
 * `hold`, `resume` (a workflow on hold), `owner` (no holder yet), `request` (asks for an exception), `decide` (an exception waits for the decision of someone else) and `cancel`.
 */
export type WorkflowRole = 'read' | 'complete' | 'assign' | 'advance' | 'return' | 'hold' | 'resume' | 'owner' | 'request' | 'decide' | 'cancel';

/** The steps of the frozen definition of the fixtures, in order. */
export type WorkflowStepCode = 'PLAN_SELECTION' | 'DOC_PREPARE' | 'BID_INVITATION';
export type WorkflowItemCode = 'PLAN_NOTE' | 'PLAN_EXTRA';

export interface WorkflowVisitFixture {
  id: string;
  visit: number;
  stepCode: WorkflowStepCode;
  /** The instant the package entered the step, and the day (in Vietnam) that instant falls on. */
  enteredAt: string;
  enteredOn: string;
  dueOn: string;
  /** Whether the package has left the step (every visit but the last one is closed). */
  closed: boolean;
}

export interface WorkflowItemFixture {
  id: string;
  code: WorkflowItemCode;
  /** Done by the maker with an attestation (the note of the completion and of the evidence are distinctive), or still open. */
  done: boolean;
}

export interface WorkflowLogFixture {
  id: string;
  kind: 'ASSIGN_OWNER' | 'HOLD' | 'EXCEPTION_REQUESTED';
  at: string;
  reason: string;
}

export interface WorkflowFixture {
  role: WorkflowRole;
  packageId: string;
  packageCode: string;
  packageTitle: string;
  workflowId: string;
  status: 'IN_PROGRESS' | 'ON_HOLD';
  currentVisit: number;
  currentStep: WorkflowStepCode;
  visits: readonly WorkflowVisitFixture[];
  /** The items of the open visit (the visits behind it hold none). */
  items: readonly WorkflowItemFixture[];
  ownerAssigned: boolean;
  holdReason: string | null;
  heldAt: string | null;
  /** The notes of the item that is done. */
  completion: { evidenceId: string; note: string; evidenceNote: string } | null;
  /** The exception that waits for a decision, asked for by the maker on the open visit. */
  exception: { id: string; reason: string; requestedAt: string } | null;
  logs: readonly WorkflowLogFixture[];
  lastActivityAt: string;
  lastActivityOn: string;
}

export interface WorkflowFixtures {
  /** A package that has no workflow and is still a draft, so that starting it is refused without writing anything. */
  start: { packageId: string; packageCode: string; packageTitle: string };
  workflows: Readonly<Record<WorkflowRole, WorkflowFixture>>;
  /** The frozen definition every workflow of the tenant carries (the params of a PROCUREMENT_WORKFLOW rule) and the words that make it distinctive. */
  definition: Record<string, unknown>;
  names: { definition: string; steps: Readonly<Record<WorkflowStepCode, string>>; items: Readonly<Record<WorkflowItemCode, string>> };
}

export const WORKFLOW_ROLES: readonly WorkflowRole[] = ['read', 'complete', 'assign', 'advance', 'return', 'hold', 'resume', 'owner', 'request', 'decide', 'cancel'];

/** The steps with the days the visits are seeded on: every day is fixed and in the past, so that the workflows are live and late whatever the day the suite runs on. */
const STEP_PLAN: ReadonlyArray<{ code: WorkflowStepCode; enteredAt: string; enteredOn: string; dueOn: string }> = [
  { code: 'PLAN_SELECTION', enteredAt: '2026-02-02T02:00:00Z', enteredOn: '2026-02-02', dueOn: '2026-02-09' },
  { code: 'DOC_PREPARE', enteredAt: '2026-02-09T02:00:00Z', enteredOn: '2026-02-09', dueOn: '2026-02-16' },
  { code: 'BID_INVITATION', enteredAt: '2026-02-16T02:00:00Z', enteredOn: '2026-02-16', dueOn: '2026-02-23' },
];

const ROLES: ReadonlyArray<{ role: WorkflowRole; visit: number; onHold?: true; ownerAssigned?: true; doneNote?: true; exception?: true }> = [
  { role: 'read', visit: 1, ownerAssigned: true, doneNote: true },
  { role: 'complete', visit: 1 },
  { role: 'assign', visit: 1 },
  { role: 'advance', visit: 2 },
  { role: 'return', visit: 3 },
  { role: 'hold', visit: 2 },
  { role: 'resume', visit: 2, onHold: true },
  { role: 'owner', visit: 2 },
  { role: 'request', visit: 2 },
  { role: 'decide', visit: 1, exception: true },
  { role: 'cancel', visit: 2 },
];

/** What the definition says about each item of the first step: the note must be attested (a kind of evidence that needs no document), the extra paper may be left open. */
export const WORKFLOW_ITEM_RULES: Readonly<Record<WorkflowItemCode, { required: boolean; evidenceKinds: readonly string[]; evidenceRequired: boolean }>> = {
  PLAN_NOTE: { required: true, evidenceKinds: ['ATTESTATION'], evidenceRequired: true },
  PLAN_EXTRA: { required: false, evidenceKinds: [], evidenceRequired: false },
};

function definitionOf(label: string): { params: Record<string, unknown>; names: WorkflowFixtures['names'] } {
  const names: WorkflowFixtures['names'] = {
    definition: `${label} procurement workflow for open bidding`,
    steps: { PLAN_SELECTION: `${label} plan selection`, DOC_PREPARE: `${label} document preparation`, BID_INVITATION: `${label} bid invitation` },
    items: { PLAN_NOTE: `${label} note of the plan`, PLAN_EXTRA: `${label} extra paper of the plan` },
  };
  const step = (code: WorkflowStepCode, checklist: readonly Record<string, unknown>[]): Record<string, unknown> => ({
    code,
    name: names.steps[code],
    entry_condition: `${label} entry condition of ${code}`,
    exit_condition: `${label} exit condition of ${code}`,
    responsible_role: 'PROCUREMENT_OFFICER',
    standard_working_days: 5,
    evidence_kinds: [],
    maker_checker: false,
    checklist,
  });
  const item = (code: WorkflowItemCode, due: number): Record<string, unknown> => ({
    code,
    name: names.items[code],
    required: WORKFLOW_ITEM_RULES[code].required,
    owner_role: 'PROCUREMENT_OFFICER',
    due_offset_working_days: due,
    evidence_kinds: [...WORKFLOW_ITEM_RULES[code].evidenceKinds],
    evidence_required: WORKFLOW_ITEM_RULES[code].evidenceRequired,
  });
  return {
    names,
    params: {
      method: 'OPEN_BIDDING',
      name: names.definition,
      stalled_after_working_days: 10,
      checklist_warn_days: 3,
      steps: [
        step('PLAN_SELECTION', [
          item('PLAN_NOTE', 3),
          item('PLAN_EXTRA', 4),
        ]),
        step('DOC_PREPARE', []),
        step('BID_INVITATION', []),
      ],
    },
  };
}

function build(tenant: TenantName): WorkflowFixtures {
  const label = tenant === 'TNT-A' ? 'Alpha' : 'Beta';
  const prefix = tenant === 'TNT-A' ? 'ALPHA' : 'BETA';
  const code = (seq: number): string => `${prefix}-PKGWF-${String(seq).padStart(2, '0')}`;
  const entries = ROLES.map((entry, index) => {
    const seq = index + 1;
    const plan = STEP_PLAN.slice(0, entry.visit);
    const current = plan[plan.length - 1];
    if (current === undefined) throw new Error(`The workflow fixture ${entry.role} has no step`);
    const visits = plan.map(
      (one, position): WorkflowVisitFixture => ({
        id: fixtureId(tenant, GROUP, FAMILY.visit, seq * 10 + position + 1),
        visit: position + 1,
        stepCode: one.code,
        enteredAt: one.enteredAt,
        enteredOn: one.enteredOn,
        dueOn: one.dueOn,
        closed: position + 1 < entry.visit,
      }),
    );
    // Only the first step has a checklist in the definition, so the items are those of a workflow that is still at its first step.
    const items: WorkflowItemFixture[] =
      entry.visit === 1
        ? [
            { id: fixtureId(tenant, GROUP, FAMILY.item, seq * 10 + 1), code: 'PLAN_NOTE', done: entry.doneNote === true },
            { id: fixtureId(tenant, GROUP, FAMILY.item, seq * 10 + 2), code: 'PLAN_EXTRA', done: false },
          ]
        : [];
    const holdReason = entry.onHold === true ? `${label} hold reason: the funding letter of the package is awaited` : null;
    const heldAt = entry.onHold === true ? '2026-02-12T03:00:00Z' : null;
    const exception = entry.exception === true ? { id: fixtureId(tenant, GROUP, FAMILY.exception, seq), reason: `${label} exception reason: the note of the plan comes with the next paper`, requestedAt: '2026-02-04T03:00:00Z' } : null;
    const logs: WorkflowLogFixture[] = [];
    if (entry.ownerAssigned === true) logs.push({ id: fixtureId(tenant, GROUP, FAMILY.log, seq * 10 + 1), kind: 'ASSIGN_OWNER', at: '2026-02-02T03:00:00Z', reason: `${label} owner note: the planner holds the package` });
    if (holdReason !== null && heldAt !== null) logs.push({ id: fixtureId(tenant, GROUP, FAMILY.log, seq * 10 + 2), kind: 'HOLD', at: heldAt, reason: holdReason });
    if (exception !== null) logs.push({ id: fixtureId(tenant, GROUP, FAMILY.log, seq * 10 + 3), kind: 'EXCEPTION_REQUESTED', at: exception.requestedAt, reason: exception.reason });
    const fixture: WorkflowFixture = {
      role: entry.role,
      packageId: fixtureId(tenant, GROUP, FAMILY.package, seq),
      packageCode: code(seq),
      packageTitle: `${label} workflow package ${entry.role}`,
      workflowId: fixtureId(tenant, GROUP, FAMILY.workflow, seq),
      status: entry.onHold === true ? 'ON_HOLD' : 'IN_PROGRESS',
      currentVisit: entry.visit,
      currentStep: current.code,
      visits,
      items,
      ownerAssigned: entry.ownerAssigned === true,
      holdReason,
      heldAt,
      completion: entry.doneNote === true ? { evidenceId: fixtureId(tenant, GROUP, FAMILY.evidence, seq * 10 + 1), note: `${label} completion note: the plan note was written and checked`, evidenceNote: `${label} attestation: the planner confirms the note of the plan` } : null,
      exception,
      logs,
      lastActivityAt: current.enteredAt,
      lastActivityOn: current.enteredOn,
    };
    return [entry.role, fixture] as const;
  });
  const workflows = Object.fromEntries(entries) as Record<WorkflowRole, WorkflowFixture>;
  const startSeq = ROLES.length + 1;
  const definition = definitionOf(label);
  return {
    start: { packageId: fixtureId(tenant, GROUP, FAMILY.package, startSeq), packageCode: code(startSeq), packageTitle: `${label} workflow package start` },
    workflows,
    definition: definition.params,
    names: definition.names,
  };
}

export const WORKFLOW_FIXTURES: Readonly<Record<TenantName, WorkflowFixtures>> = {
  'TNT-A': build('TNT-A'),
  'TNT-B': build('TNT-B'),
};

/** Every id and every distinctive text of the workflow fixtures of a tenant: none of them may reach an answer given to the other tenant. */
export function workflowMarkers(tenant: TenantName): Marker[] {
  const fixtures = WORKFLOW_FIXTURES[tenant];
  const markers: Marker[] = [
    { kind: 'package workflow start package id', value: fixtures.start.packageId },
    { kind: 'package workflow start package code', value: fixtures.start.packageCode },
    { kind: 'package workflow start package title', value: fixtures.start.packageTitle },
    { kind: 'package workflow definition name', value: fixtures.names.definition },
  ];
  for (const name of Object.values(fixtures.names.steps)) markers.push({ kind: 'package workflow step name', value: name });
  for (const name of Object.values(fixtures.names.items)) markers.push({ kind: 'package workflow item name', value: name });
  for (const workflow of Object.values(fixtures.workflows)) {
    markers.push(
      { kind: 'package workflow package id', value: workflow.packageId },
      { kind: 'package workflow package code', value: workflow.packageCode },
      { kind: 'package workflow package title', value: workflow.packageTitle },
      { kind: 'package workflow id', value: workflow.workflowId },
    );
    for (const visit of workflow.visits) markers.push({ kind: 'package workflow visit id', value: visit.id });
    for (const item of workflow.items) markers.push({ kind: 'package workflow item id', value: item.id });
    for (const log of workflow.logs) markers.push({ kind: 'package workflow log id', value: log.id }, { kind: 'package workflow log reason', value: log.reason });
    if (workflow.holdReason !== null) markers.push({ kind: 'package workflow hold reason', value: workflow.holdReason });
    if (workflow.completion !== null) markers.push({ kind: 'package workflow evidence id', value: workflow.completion.evidenceId }, { kind: 'package workflow completion note', value: workflow.completion.note }, { kind: 'package workflow evidence note', value: workflow.completion.evidenceNote });
    if (workflow.exception !== null) markers.push({ kind: 'package step exception id', value: workflow.exception.id }, { kind: 'package step exception reason', value: workflow.exception.reason });
  }
  return markers;
}
