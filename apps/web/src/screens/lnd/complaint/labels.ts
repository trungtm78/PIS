import type { useTranslation } from '../../../i18n';
import type { CommandProblem, ComplaintChannel, ComplaintStatus, ComplaintSubject, FormProblem } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function complaintChannelLabel(t: Translate, channel: ComplaintChannel): string {
  switch (channel) {
    case 'IN_PERSON':
      return t('lnd.complaintChannel.inPerson.label');
    case 'LETTER':
      return t('lnd.complaintChannel.letter.label');
    case 'PORTAL':
      return t('lnd.complaintChannel.portal.label');
    case 'MEETING':
      return t('lnd.complaintChannel.meeting.label');
  }
}

export function complaintSubjectLabel(t: Translate, subject: ComplaintSubject): string {
  switch (subject) {
    case 'PRICE':
      return t('lnd.complaintSubject.price.label');
    case 'AREA':
      return t('lnd.complaintSubject.area.label');
    case 'ELIGIBILITY':
      return t('lnd.complaintSubject.eligibility.label');
    case 'RESETTLEMENT':
      return t('lnd.complaintSubject.resettlement.label');
    case 'PROCEDURE':
      return t('lnd.complaintSubject.procedure.label');
    case 'OTHER':
      return t('lnd.complaintSubject.other.label');
  }
}

export function complaintStatusLabel(t: Translate, status: ComplaintStatus): string {
  switch (status) {
    case 'RECEIVED':
      return t('lnd.complaintStatus.received.label');
    case 'UNDER_REVIEW':
      return t('lnd.complaintStatus.underReview.label');
    case 'RESOLVED_ACCEPTED':
      return t('lnd.complaintStatus.resolvedAccepted.label');
    case 'RESOLVED_REJECTED':
      return t('lnd.complaintStatus.resolvedRejected.label');
    case 'ESCALATED':
      return t('lnd.complaintStatus.escalated.label');
    case 'CLOSED':
      return t('lnd.complaintStatus.closed.label');
  }
}

export function formProblemMessage(t: Translate, problem: FormProblem): string {
  switch (problem) {
    case 'required':
      return t('lnd.field.required.error');
    case 'tooLong':
      return t('lnd.field.tooLong.error');
    case 'invalid':
      return t('lnd.field.invalid.error');
    case 'future':
      return t('lnd.complaints.field.future.error');
    case 'early':
      return t('lnd.complaints.field.early.error');
  }
}

/** The sentence for a refusal of a command; a problem the screen has no sentence for is the general one. */
export function commandProblemMessage(t: Translate, problem: CommandProblem): string {
  switch (problem) {
    case 'householdNotFound':
      return t('lnd.complaints.problem.householdNotFound.error');
    case 'stateInvalid':
      return t('lnd.complaints.problem.stateInvalid.error');
    case 'documentRequired':
      return t('lnd.complaints.problem.documentRequired.error');
    case 'documentNotClean':
      return t('lnd.complaints.problem.documentNotClean.error');
    case 'ruleUnconfirmed':
      return t('lnd.complaints.problem.ruleUnconfirmed.error');
    case 'versionConflict':
      return t('lnd.problem.versionConflict.error');
    case 'scopeDenied':
      return t('lnd.complaints.problem.scopeDenied.error');
    case 'validation':
      return t('lnd.problem.validation.error');
    case 'notFound':
      return t('lnd.problem.notFound.error');
    case 'general':
      return t('lnd.problem.general.error');
  }
}
