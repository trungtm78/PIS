import type { Translator } from '../../../i18n';
import type { Conclusion, EvaluatorKind, FormProblem, Kind, Refusal, Status } from './model';

type T = Translator['t'];

export function kindLabel(t: T, kind: Kind): string {
  switch (kind) {
    case 'INITIAL':
      return t('mne.evaluation.kind.initial');
    case 'MIDTERM':
      return t('mne.evaluation.kind.midterm');
    case 'FINAL':
      return t('mne.evaluation.kind.final');
    case 'IMPACT':
      return t('mne.evaluation.kind.impact');
    case 'AD_HOC':
      return t('mne.evaluation.kind.adhoc');
  }
}

export function statusLabel(t: T, status: Status): string {
  switch (status) {
    case 'PLANNED':
      return t('mne.evaluation.status.planned');
    case 'IN_PROGRESS':
      return t('mne.evaluation.status.inProgress');
    case 'SUBMITTED':
      return t('mne.evaluation.status.submitted');
    case 'APPROVED':
      return t('mne.evaluation.status.approved');
    case 'RETURNED':
      return t('mne.evaluation.status.returned');
  }
}

export function conclusionLabel(t: T, conclusion: Conclusion): string {
  switch (conclusion) {
    case 'SATISFACTORY':
      return t('mne.evaluation.conclusion.satisfactory');
    case 'PARTIALLY_SATISFACTORY':
      return t('mne.evaluation.conclusion.partial');
    case 'UNSATISFACTORY':
      return t('mne.evaluation.conclusion.unsatisfactory');
  }
}

export function evaluatorLabel(t: T, kind: EvaluatorKind): string {
  return kind === 'INTERNAL' ? t('mne.evaluation.evaluator.internal') : t('mne.evaluation.evaluator.consultant');
}

export function fieldProblem(t: T, problem: FormProblem | undefined): string | undefined {
  switch (problem) {
    case undefined:
      return undefined;
    case 'required':
      return t('mne.evaluation.field.required.error');
    case 'invalid':
      return t('mne.evaluation.field.invalid.error');
    case 'future':
      return t('mne.evaluation.field.future.error');
    case 'short':
      return t('mne.evaluation.field.short.error');
  }
}

export function refusalLabel(t: T, refusal: Refusal): string {
  switch (refusal.problem) {
    case 'stage':
      if (refusal.windowPassed) return t('mne.evaluation.problem.window');
      return refusal.kind === null || refusal.projectStatus === null ? t('mne.evaluation.problem.state') : t('mne.evaluation.problem.stage', { kind: kindLabel(t, refusal.kind), stage: refusal.projectStatus });
    case 'selfApproval':
      return t('mne.evaluation.problem.selfApproval');
    case 'versionConflict':
      return t('mne.evaluation.problem.versionConflict');
    case 'validation':
      return t('mne.evaluation.problem.validation');
    case 'scopeDenied':
      return t('mne.evaluation.problem.scopeDenied');
    case 'notFound':
      return t('mne.evaluation.problem.notFound');
    case 'general':
      return t('mne.evaluation.problem.general');
  }
}
