import type { ProjectWorkflowTemplate } from './project-workflow.ts';

/**
 * The quality of the schedule logic of a template (BR-PWF-19, after the checks of DCMA 14 points that need no percentages): flags for the person who writes the template, never a refusal. A flag names a task and what is
 * doubtful about it; the screen of the template shows them next to the findings of the schema.
 */

export const QUALITY_FLAG_CODES = ['MISSING_PREDECESSOR', 'MISSING_SUCCESSOR', 'LEAD', 'HARD_CONSTRAINT', 'LONG_TASK', 'NEGATIVE_FLOAT'] as const;
export type QualityFlagCode = (typeof QUALITY_FLAG_CODES)[number];

export interface QualityFlag {
  code: QualityFlagCode;
  task: string | null;
  detail: string | null;
}

/** A task longer than this many working days is hard to measure the progress of (DCMA: 44 working days, two months). */
export const LONG_TASK_WORKING_DAYS = 44;
const HARD_CONSTRAINTS: readonly string[] = ['MSO', 'MFO', 'SNLT', 'FNLT'];

/** The flags of a template, in the order of its tasks. NEGATIVE_FLOAT needs dates and is added by the caller that has a schedule. */
export function templateQualityFlags(template: ProjectWorkflowTemplate): QualityFlag[] {
  const flags: QualityFlag[] = [];
  const hasSuccessor = new Set(template.tasks.flatMap((one) => one.predecessors.map((link) => link.task)));
  const firstCode = template.tasks[0]?.code;
  const lastCode = template.tasks[template.tasks.length - 1]?.code;
  for (const one of template.tasks) {
    // The first task starts the project and the last one ends it: neither needs the link it lacks by nature.
    if (one.predecessors.length === 0 && one.code !== firstCode) flags.push({ code: 'MISSING_PREDECESSOR', task: one.code, detail: null });
    if (!hasSuccessor.has(one.code) && one.code !== lastCode) flags.push({ code: 'MISSING_SUCCESSOR', task: one.code, detail: null });
    for (const link of one.predecessors) if (link.lagWorkingDays < 0) flags.push({ code: 'LEAD', task: one.code, detail: link.task });
    if (one.constraint !== null && HARD_CONSTRAINTS.includes(one.constraint.kind)) flags.push({ code: 'HARD_CONSTRAINT', task: one.code, detail: one.constraint.kind });
    if (one.durationWorkingDays > LONG_TASK_WORKING_DAYS) flags.push({ code: 'LONG_TASK', task: one.code, detail: String(one.durationWorkingDays) });
  }
  return flags;
}
