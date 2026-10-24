import type { ProjectStatus } from './prj-project-store.ts';

/**
 * The transition table of the PIMA life cycle of a project (PRJ 3.1 section 4, K5): the one place that says which stage may follow which,
 * and by what. A pair that is not in the table is refused whoever asks, a closed, rejected or cancelled project leads nowhere, and the
 * workflow engine that will drive the approvals calls the commands that guard these edges instead of writing a status itself. The same
 * table is kept as data in the master type PROJECT_STAGE (`allowed_next`); a test holds the two together.
 */

/** The commands of the module that move a project, and the events its system consumers answer. */
export const STAGE_COMMANDS = ['startProjectImplementation', 'suspendProject', 'resumeProject', 'completeProject', 'closeProject', 'cancelProject'] as const;
export type StageCommand = (typeof STAGE_COMMANDS)[number];

export const PLAN_PUBLISHED_EVENT = 'capital.plan_published.v1';
export const SETTLEMENT_CLOSED_EVENT = 'settlement.closed.v1';

export interface StageTransition {
  from: ProjectStatus;
  to: ProjectStatus;
  /** The command that makes the move, or the event type that the system consumer answers. */
  by: string;
  actor: 'MEMBER' | 'SYSTEM';
}

const member = (from: ProjectStatus, to: ProjectStatus, by: string): StageTransition => ({ from, to, by, actor: 'MEMBER' });
const system = (from: ProjectStatus, to: ProjectStatus, by: string): StageTransition => ({ from, to, by, actor: 'SYSTEM' });

export const STAGE_TRANSITIONS: readonly StageTransition[] = [
  member('CONCEPT', 'APPRAISAL', 'submitProjectForAppraisal'),
  member('APPRAISAL', 'PIPELINE', 'decideProjectAppraisal'),
  member('APPRAISAL', 'REJECTED', 'decideProjectAppraisal'),
  member('APPRAISAL', 'CONCEPT', 'decideProjectAppraisal'),
  system('PIPELINE', 'BUDGETED', PLAN_PUBLISHED_EVENT),
  member('BUDGETED', 'IMPLEMENTATION', 'startProjectImplementation'),
  member('IMPLEMENTATION', 'SUSPENDED', 'suspendProject'),
  member('SUSPENDED', 'IMPLEMENTATION', 'resumeProject'),
  member('IMPLEMENTATION', 'COMPLETED', 'completeProject'),
  system('COMPLETED', 'SETTLED', SETTLEMENT_CLOSED_EVENT),
  member('SETTLED', 'CLOSED', 'closeProject'),
  member('CONCEPT', 'CANCELLED', 'cancelProject'),
  member('APPRAISAL', 'CANCELLED', 'cancelProject'),
  member('PIPELINE', 'CANCELLED', 'cancelProject'),
  member('BUDGETED', 'CANCELLED', 'cancelProject'),
];

/** The order of the stages as the master data of PROJECT_STAGE numbers them (the rule that requires the national code names a stage to start from). */
export const STAGE_SEQUENCE: Readonly<Record<ProjectStatus, number>> = {
  CONCEPT: 1,
  APPRAISAL: 2,
  PIPELINE: 3,
  BUDGETED: 4,
  IMPLEMENTATION: 5,
  SUSPENDED: 6,
  COMPLETED: 7,
  SETTLED: 8,
  CLOSED: 9,
  REJECTED: 10,
  CANCELLED: 11,
};

/** The stages from which a project does not move any more. */
export const TERMINAL_STAGES: readonly ProjectStatus[] = ['CLOSED', 'REJECTED', 'CANCELLED'];

/** The stages a project may move to from `from`, by any command or event. */
export function stagesAfter(from: ProjectStatus): ProjectStatus[] {
  return [...new Set(STAGE_TRANSITIONS.filter((edge) => edge.from === from).map((edge) => edge.to))];
}

/** Whether the table has the pair. A stage never leads to itself, and a terminal stage leads nowhere. */
export function isTransitionAllowed(from: ProjectStatus, to: ProjectStatus): boolean {
  return STAGE_TRANSITIONS.some((edge) => edge.from === from && edge.to === to);
}

/** The edge that a command (or an event) makes from a stage; undefined when it makes none from there. */
export function edgeBy(by: string, from: ProjectStatus): StageTransition | undefined {
  return STAGE_TRANSITIONS.find((edge) => edge.by === by && edge.from === from);
}

/** The edges that a member's command of this module makes from a stage: what the board offers on a card. */
export function commandEdgesFrom(from: ProjectStatus): Array<StageTransition & { by: StageCommand }> {
  return STAGE_TRANSITIONS.filter((edge): edge is StageTransition & { by: StageCommand } => edge.from === from && (STAGE_COMMANDS as readonly string[]).includes(edge.by));
}
