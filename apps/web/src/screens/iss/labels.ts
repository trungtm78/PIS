import type { useTranslation } from '../../i18n';
import type { FieldProblem, Phase, ProblemView, Severity } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function severityLabel(t: Translate, severity: Severity): string {
  switch (severity) {
    case 'LOW':
      return t('iss.severity.low.text');
    case 'MEDIUM':
      return t('iss.severity.medium.text');
    case 'HIGH':
      return t('iss.severity.high.text');
    case 'CRITICAL':
      return t('iss.severity.critical.text');
  }
}

export function phaseLabel(t: Translate, phase: Phase): string {
  switch (phase) {
    case 'draft':
      return t('iss.sla.phase.draft.text');
    case 'scheduled':
      return t('iss.sla.phase.scheduled.text');
    case 'inForce':
      return t('iss.sla.phase.inForce.text');
    case 'ended':
      return t('iss.sla.phase.ended.text');
  }
}

export function fieldProblemMessage(t: Translate, problem: FieldProblem): string {
  switch (problem) {
    case 'required':
      return t('iss.field.required.error');
    case 'invalidCode':
      return t('iss.field.invalidCode.error');
    case 'invalidNumber':
      return t('iss.field.invalidNumber.error');
    case 'resolveOrder':
      return t('iss.field.resolveOrder.error');
    case 'levelOrder':
      return t('iss.field.levelOrder.error');
    case 'invalidDate':
      return t('iss.field.invalidDate.error');
    case 'past':
      return t('iss.field.past.error');
    case 'untilOrder':
      return t('iss.field.untilOrder.error');
    case 'rejected':
      return t('iss.field.rejected.error');
  }
}

export function problemMessage(t: Translate, problem: ProblemView): string {
  switch (problem.reason) {
    case 'overlap':
      return t('iss.problem.overlap.error');
    case 'stateInvalid':
      return t('iss.problem.stateInvalid.error');
    case 'validation':
      return t('iss.problem.validation.error');
    case 'denied':
      return t('iss.problem.denied.error');
    case 'notFound':
      return t('iss.problem.notFound.error');
    case 'general':
      return t('iss.problem.general.error');
  }
}
