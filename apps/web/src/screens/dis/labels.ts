import type { useTranslation } from '../../i18n';
import type { FieldProblem, PeriodMove, PeriodStatus, ProblemReason, ReopenScope, ReopenStatus } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

/** The word for a status: the API has three statuses and no "Closed", and the screen says the same three, always in words. */
export function statusLabel(t: Translate, status: PeriodStatus): string {
  switch (status) {
    case 'OPEN':
      return t('dis.calendar.status.open.text');
    case 'SOFT_CLOSED':
      return t('dis.calendar.status.softClosed.text');
    case 'LOCKED':
      return t('dis.calendar.status.locked.text');
  }
}

/** The colour of a status; it only supports the word and never replaces it. */
export function statusTone(status: PeriodStatus): 'green' | 'warn' | 'gray' {
  switch (status) {
    case 'OPEN':
      return 'green';
    case 'SOFT_CLOSED':
      return 'warn';
    case 'LOCKED':
      return 'gray';
  }
}

export function reopenScopeLabel(t: Translate, scope: ReopenScope): string {
  return scope === 'PERIOD' ? t('dis.calendar.reopenScope.period.text') : t('dis.calendar.reopenScope.projects.text');
}

export function reopenStatusLabel(t: Translate, status: ReopenStatus): string {
  switch (status) {
    case 'REQUESTED':
      return t('dis.calendar.reopenStatus.requested.text');
    case 'APPROVED':
      return t('dis.calendar.reopenStatus.approved.text');
    case 'REJECTED':
      return t('dis.calendar.reopenStatus.rejected.text');
    case 'EXPIRED':
      return t('dis.calendar.reopenStatus.expired.text');
    case 'CLOSED':
      return t('dis.calendar.reopenStatus.closed.text');
  }
}

export function moveLabel(t: Translate, move: PeriodMove): string {
  return move === 'softClose' ? t('dis.calendar.softClose.action') : t('dis.calendar.lock.action');
}

export function fieldProblemMessage(t: Translate, problem: FieldProblem): string {
  switch (problem) {
    case 'required':
      return t('dis.calendar.field.required.error');
    case 'tooShort':
      return t('dis.calendar.field.tooShort.error');
    case 'tooLong':
      return t('dis.calendar.field.tooLong.error');
    case 'invalidYear':
      return t('dis.calendar.field.invalidYear.error');
  }
}

/** The sentence for a refusal of a command; a problem the screen has no sentence for is the general one. */
export function problemMessage(t: Translate, reason: ProblemReason): string {
  switch (reason) {
    case 'overlap':
      return t('dis.calendar.problem.overlap.error');
    case 'noCalendar':
      return t('dis.calendar.problem.noCalendar.error');
    case 'beforeDeadline':
      return t('dis.calendar.problem.beforeDeadline.error');
    case 'stateInvalid':
      return t('dis.calendar.problem.stateInvalid.error');
    case 'versionConflict':
      return t('dis.calendar.problem.versionConflict.error');
    case 'notFound':
      return t('dis.calendar.problem.notFound.error');
    case 'validation':
      return t('dis.calendar.problem.validation.error');
    case 'denied':
      return t('dis.calendar.problem.denied.error');
    case 'general':
      return t('dis.calendar.problem.general.error');
  }
}
