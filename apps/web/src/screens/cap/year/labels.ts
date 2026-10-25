import type { Translator } from '../../../i18n';
import type { FieldProblem, ProblemView, YearStatus } from './model';

type T = Translator['t'];

export function statusLabel(t: T, status: YearStatus): string {
  switch (status) {
    case 'OPEN':
      return t('cap.year.status.open');
    case 'SOFT_CLOSED':
      return t('cap.year.status.softClosed');
    case 'LOCKED':
      return t('cap.year.status.locked');
  }
}

export function fieldProblemMessage(t: T, problem: FieldProblem): string {
  switch (problem) {
    case 'closeReasonLength':
      return t('cap.year.fieldError.closeReason');
    case 'reopenReasonLength':
      return t('cap.year.fieldError.reopenReason');
    case 'hoursInvalid':
      return t('cap.year.fieldError.hours');
  }
}

/** Why the server refused, in the words of the screen; a close that is stopped by plans or reservations says how many. */
export function problemMessage(t: T, problem: ProblemView): string {
  switch (problem.reason) {
    case 'plansPending':
      return t('cap.year.problem.plansPending', { count: problem.blockers });
    case 'reservationsActive':
      return t('cap.year.problem.reservationsActive', { count: problem.blockers });
    case 'alreadyLocked':
      return t('cap.year.problem.alreadyLocked');
    case 'alreadySoftClosed':
      return t('cap.year.problem.alreadySoftClosed');
    case 'notLocked':
      return t('cap.year.problem.notLocked');
    case 'selfApproval':
      return t('cap.year.problem.selfApproval');
    case 'reasonRequired':
      return t('cap.year.problem.reasonRequired');
    case 'conflict':
      return t('cap.year.problem.conflict');
    case 'invalid':
      return problem.field === undefined ? t('cap.year.problem.invalid') : t('cap.year.problem.invalidAt', { field: problem.field });
    case 'denied':
      return t('cap.year.problem.denied');
    case 'notFound':
      return t('cap.year.problem.notFound');
    case 'session':
      return t('cap.year.problem.session');
    case 'general':
      return t('cap.year.problem.general');
  }
}
