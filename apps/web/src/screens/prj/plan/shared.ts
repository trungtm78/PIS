import type { Translator } from '../../../i18n';
import type { Tone } from '../../../ui';
import type { FormProblem, MilestoneStatus, PlanProblem } from './model';

type T = Translator['t'];

export function problemMessage(t: T, problem: PlanProblem): string {
  switch (problem) {
    case 'componentDuplicate':
      return t('prj.plan.problem.componentDuplicate');
    case 'milestoneDuplicate':
      return t('prj.plan.problem.milestoneDuplicate');
    case 'cycle':
      return t('prj.plan.problem.cycle');
    case 'stateInvalid':
      return t('prj.plan.problem.stateInvalid');
    case 'versionConflict':
      return t('prj.plan.problem.versionConflict');
    case 'scopeDenied':
      return t('prj.plan.problem.scopeDenied');
    case 'stageClosed':
      return t('prj.plan.problem.stageClosed');
    case 'validation':
      return t('prj.plan.problem.validation');
    case 'notFound':
      return t('prj.plan.problem.notFound');
    case 'general':
      return t('prj.plan.problem.general');
  }
}

export function fieldMessage(t: T, problem: FormProblem | undefined): string | undefined {
  if (problem === undefined) return undefined;
  return problem === 'required' ? t('prj.plan.field.required.error') : t('prj.plan.field.invalid.error');
}

export function milestoneStatusLabel(t: T, status: MilestoneStatus): string {
  switch (status) {
    case 'PLANNED':
      return t('prj.mile.status.planned');
    case 'DONE':
      return t('prj.mile.status.done');
    case 'DELAYED':
      return t('prj.mile.status.delayed');
    case 'CANCELLED':
      return t('prj.mile.status.cancelled');
  }
}

/** The tone of the pill of a milestone: done is green, delayed is amber, cancelled is grey, planned is blue (the label says it in words). */
export const milestoneTone = (status: MilestoneStatus): Tone => (status === 'DONE' ? 'success' : status === 'DELAYED' ? 'warning' : status === 'CANCELLED' ? 'neutral' : 'info');
