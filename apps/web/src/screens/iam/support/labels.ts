import type { useTranslation } from '../../../i18n';
import { DESCRIPTION_MAX, DESCRIPTION_MIN, SUBJECT_MAX, SUBJECT_MIN } from './model';
import type { Category, FieldProblem, Priority, ProblemView, Status, TicketField } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function categoryLabel(t: Translate, category: Category): string {
  switch (category) {
    case 'ACCESS':
      return t('iam.support.category.access.label');
    case 'DATA':
      return t('iam.support.category.data.label');
    case 'BILLING':
      return t('iam.support.category.billing.label');
    case 'INCIDENT':
      return t('iam.support.category.incident.label');
    case 'HOWTO':
      return t('iam.support.category.howto.label');
    case 'OTHER':
      return t('iam.support.category.other.label');
  }
}

export function priorityLabel(t: Translate, priority: Priority): string {
  switch (priority) {
    case 'P1':
      return t('iam.support.priority.p1.label');
    case 'P2':
      return t('iam.support.priority.p2.label');
    case 'P3':
      return t('iam.support.priority.p3.label');
    case 'P4':
      return t('iam.support.priority.p4.label');
  }
}

export function statusLabel(t: Translate, status: Status): string {
  switch (status) {
    case 'Open':
      return t('iam.support.status.open.label');
    case 'InProgress':
      return t('iam.support.status.inProgress.label');
    case 'WaitingCustomer':
      return t('iam.support.status.waitingCustomer.label');
    case 'Resolved':
      return t('iam.support.status.resolved.label');
    case 'Closed':
      return t('iam.support.status.closed.label');
  }
}

export function fieldMessage(t: Translate, field: TicketField, problem: FieldProblem): string {
  const min = field === 'subject' ? SUBJECT_MIN : DESCRIPTION_MIN;
  const max = field === 'subject' ? SUBJECT_MAX : DESCRIPTION_MAX;
  switch (problem) {
    case 'required':
      return t('iam.support.field.required.error');
    case 'tooShort':
      return t('iam.support.field.tooShort.error', { min });
    case 'tooLong':
      return t('iam.support.field.tooLong.error', { max });
    case 'invalidText':
      return t('iam.support.field.invalidText.error');
  }
}

/** The sentence for a refusal of the command; a problem the screen has no sentence for is the general one. */
export function problemMessage(t: Translate, problem: ProblemView): string {
  switch (problem.reason) {
    case 'validation':
      return t('iam.support.problem.validation.error');
    case 'denied':
      return t('iam.support.problem.denied.error');
    case 'general':
      return t('iam.support.problem.general.error');
  }
}
