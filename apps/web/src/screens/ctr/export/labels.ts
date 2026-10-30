import type { useTranslation } from '../../../i18n';
import type { FormProblem, Problem, Scope, Status } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function scopeLabel(t: Translate, scope: Scope): string {
  switch (scope) {
    case 'PERFORMANCE':
      return t('ctr.export.scope.performance');
    case 'VIOLATION':
      return t('ctr.export.scope.violation');
    case 'BOTH':
      return t('ctr.export.scope.both');
  }
}

export function statusLabel(t: Translate, status: Status): string {
  switch (status) {
    case 'GENERATED':
      return t('ctr.export.status.generated');
    case 'SUBMITTED_EXTERNALLY':
      return t('ctr.export.status.submitted');
    case 'CONFIRMED':
      return t('ctr.export.status.confirmed');
    case 'FAILED':
      return t('ctr.export.status.failed');
  }
}

export function formProblemMessage(t: Translate, problem: FormProblem): string {
  switch (problem) {
    case 'required':
      return t('ctr.export.problem.required');
    case 'day':
      return t('ctr.export.problem.day');
    case 'order':
      return t('ctr.export.problem.order');
    case 'tooLong':
      return t('ctr.export.problem.tooLong');
    case 'future':
      return t('ctr.export.problem.future');
  }
}

export function problemMessage(t: Translate, problem: Problem): string {
  switch (problem) {
    case 'empty':
      return t('ctr.export.error.empty');
    case 'tooMany':
      return t('ctr.export.error.tooMany');
    case 'state':
      return t('ctr.export.error.state');
    case 'validation':
      return t('ctr.export.error.validation');
    case 'denied':
      return t('ctr.export.error.denied');
    case 'notFound':
      return t('ctr.export.error.notFound');
    case 'session':
      return t('ctr.export.error.session');
    case 'general':
      return t('ctr.export.error.general');
  }
}
