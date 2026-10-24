import type { Translator } from '../../../i18n';
import type { DraftProblem, Failure, Threshold } from './problems';
import { groupDigits } from './rules';
import type { FieldProblem } from './rules';
import type { CancelCode, ChecklistKey, Circulation, DocumentStatus, EffectStatus, RecipientKind, SigningMode, Urgency } from './types';

type T = Translator['t'];

// Every key is written out so the i18n check can see it is in use.
export function statusLabel(t: T, status: DocumentStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('doc.draft.status.draft');
    case 'IN_REVIEW':
      return t('doc.draft.status.inReview');
    case 'SUBMITTED':
      return t('doc.draft.status.submitted');
    case 'SIGNED':
      return t('doc.draft.status.signed');
    case 'NUMBERED':
      return t('doc.draft.status.numbered');
    case 'SEALED':
      return t('doc.draft.status.sealed');
    case 'ISSUED':
      return t('doc.draft.status.issued');
    case 'DELIVERED':
      return t('doc.draft.status.delivered');
    case 'ACKNOWLEDGED':
      return t('doc.draft.status.acknowledged');
    case 'FILED':
      return t('doc.draft.status.filed');
    case 'ARCHIVED':
      return t('doc.draft.status.archived');
    case 'CANCELLED':
      return t('doc.draft.status.cancelled');
    case 'RECALLED':
      return t('doc.draft.status.recalled');
    case 'REPLACED':
      return t('doc.draft.status.replaced');
    case 'CORRECTED':
      return t('doc.draft.status.corrected');
  }
}

/** The mark that goes with a state so that it is never told by colour alone. */
export function statusMark(status: DocumentStatus): string {
  switch (status) {
    case 'DRAFT':
      return '✎';
    case 'IN_REVIEW':
    case 'SUBMITTED':
      return '⏳';
    case 'SIGNED':
    case 'NUMBERED':
    case 'SEALED':
      return '✔';
    case 'ISSUED':
    case 'DELIVERED':
    case 'ACKNOWLEDGED':
    case 'FILED':
    case 'ARCHIVED':
      return '✓✓';
    case 'CANCELLED':
      return '✖';
    case 'RECALLED':
    case 'REPLACED':
    case 'CORRECTED':
      return '⚠';
  }
}

export function effectLabel(t: T, effect: EffectStatus): string {
  switch (effect) {
    case 'PENDING':
      return t('doc.draft.effect.pending');
    case 'EFFECTIVE':
      return t('doc.draft.effect.effective');
    case 'RECALLED':
      return t('doc.draft.effect.recalled');
    case 'REPLACED':
      return t('doc.draft.effect.replaced');
    case 'CORRECTED':
      return t('doc.draft.effect.corrected');
    case 'EXPIRED':
      return t('doc.draft.effect.expired');
  }
}

export function urgencyLabel(t: T, urgency: Urgency): string {
  switch (urgency) {
    case 'NORMAL':
      return t('doc.draft.urgency.normal');
    case 'KHAN':
      return t('doc.draft.urgency.khan');
    case 'THUONG_KHAN':
      return t('doc.draft.urgency.thuongKhan');
    case 'HOA_TOC':
      return t('doc.draft.urgency.hoaToc');
  }
}

export function circulationLabel(t: T, circulation: Circulation): string {
  return circulation === 'PUBLIC' ? t('doc.draft.circulation.public') : t('doc.draft.circulation.internal');
}

export function signingModeLabel(t: T, mode: SigningMode): string {
  switch (mode) {
    case 'DIRECT':
      return t('doc.draft.mode.direct');
    case 'KT':
      return t('doc.draft.mode.kt');
    case 'TM':
      return t('doc.draft.mode.tm');
    case 'TL':
      return t('doc.draft.mode.tl');
    case 'TUQ':
      return t('doc.draft.mode.tuq');
  }
}

export function recipientKindLabel(t: T, kind: RecipientKind): string {
  switch (kind) {
    case 'EXTERNAL_AGENCY':
      return t('doc.draft.recipient.external');
    case 'INTERNAL_UNIT':
      return t('doc.draft.recipient.internal');
    case 'PERSON':
      return t('doc.draft.recipient.person');
  }
}

export function checklistLabel(t: T, key: ChecklistKey): string {
  switch (key) {
    case 'national_title':
      return t('doc.review.checklist.nationalTitle');
    case 'motto':
      return t('doc.review.checklist.motto');
    case 'agency_name':
      return t('doc.review.checklist.agencyName');
    case 'number_symbol':
      return t('doc.review.checklist.numberSymbol');
    case 'summary':
      return t('doc.review.checklist.summary');
    case 'body':
      return t('doc.review.checklist.body');
    case 'signer_title':
      return t('doc.review.checklist.signerTitle');
    case 'recipients':
      return t('doc.review.checklist.recipients');
  }
}

export function cancelCodeLabel(t: T, code: CancelCode): string {
  switch (code) {
    case 'CANCELLED_BY_DRAFTER':
      return t('doc.draft.cancel.drafter');
    case 'REJECTED_BY_LEADER':
      return t('doc.draft.cancel.leader');
    case 'SUPERSEDED_BEFORE_ISSUE':
      return t('doc.draft.cancel.superseded');
    case 'SOURCE_WITHDRAWN':
      return t('doc.draft.cancel.source');
  }
}

export function eventLabel(t: T, kind: string): string {
  switch (kind) {
    case 'CREATED':
      return t('doc.draft.event.created');
    case 'REVIEW_REQUESTED':
      return t('doc.draft.event.reviewRequested');
    case 'REVIEW_APPROVED':
      return t('doc.draft.event.reviewApproved');
    case 'RETURNED':
      return t('doc.draft.event.returned');
    case 'CANCELLED':
      return t('doc.draft.event.cancelled');
    case 'LEADER_SIGNED':
      return t('doc.draft.event.leaderSigned');
    case 'NUMBERED':
      return t('doc.draft.event.numbered');
    case 'SEALED':
      return t('doc.draft.event.sealed');
    case 'ISSUED':
      return t('doc.draft.event.issued');
    case 'RECALLED':
      return t('doc.draft.event.recalled');
    case 'NUMBER_VOIDED':
      return t('doc.draft.event.numberVoided');
    default:
      return t('doc.draft.event.other');
  }
}

/** The explanation of one field of a draft that failed the checks, by the field the server named. */
export function failureMessage(t: T, failure: Failure): string {
  switch (failure.code) {
    case 'RECIPIENTS_REQUIRED':
      return t('doc.draft.failure.recipients');
    case 'SIGNER_REQUIRED':
      return t('doc.draft.failure.signer');
    case 'DELEGATION_REQUIRED':
      return t('doc.draft.failure.delegation');
    case 'TEMPLATE_NOT_EFFECTIVE':
      return t('doc.draft.failure.template');
    case 'PAYLOAD_FIELD_REQUIRED':
      return t('doc.draft.failure.field', { field: failure.field.replace(/^payload\./, '') });
    case 'CHECK_NOT_CONFIRMED':
      return t('doc.draft.failure.check', { item: failure.field.replace(/^format_checklist\./, '') });
    default:
      return t('doc.draft.failure.other', { field: failure.field });
  }
}

/** Why the signer is not authorised, with the band that decided when the server named it. */
export function authorityMessage(t: T, reason: string | undefined, threshold: Threshold | undefined): string {
  const band =
    threshold === undefined || threshold.amountMinVnd === null
      ? ''
      : ` ${t('doc.draft.authority.band', {
          min: groupDigits(threshold.amountMinVnd),
          max: threshold.amountMaxVnd === null ? t('doc.draft.authority.noLimit') : groupDigits(threshold.amountMaxVnd),
        })}`;
  switch (reason) {
    case 'ROLE_NOT_HELD':
      return `${t('doc.draft.authority.role')}${band}`;
    case 'DOA_RULE_NOT_FOUND':
      return t('doc.draft.authority.noRule');
    case 'SIGNER_INACTIVE':
      return t('doc.draft.authority.inactive');
    case 'DELEGATION_MISSING':
      return t('doc.draft.authority.delegationMissing');
    case 'DELEGATION_EXPIRED':
      return t('doc.draft.authority.delegationExpired');
    case 'DELEGATION_INVALID':
      return t('doc.draft.authority.delegationInvalid');
    case 'DELEGATOR_NOT_AUTHORIZED':
      return `${t('doc.draft.authority.delegator')}${band}`;
    default:
      return t('doc.draft.authority.general');
  }
}

/** The message of a failed command. */
export function problemMessage(t: T, problem: DraftProblem): string {
  switch (problem.reason) {
    case 'conflict':
      return t('doc.draft.problem.conflict');
    case 'state':
      return t('doc.draft.problem.state');
    case 'formatCheck':
      return t('doc.draft.problem.formatCheck');
    case 'notAuthorised':
      return authorityMessage(t, problem.authority, problem.threshold);
    case 'stateSecret':
      return t('doc.draft.problem.stateSecret');
    case 'templateNotEffective':
      return t('doc.draft.problem.template');
    case 'payloadInvalid':
      return t('doc.draft.problem.payload');
    case 'selfApproval':
      return t('doc.draft.problem.selfApproval');
    case 'subjectRef':
      return t('doc.draft.problem.subject');
    case 'numberAllocated':
      return t('doc.draft.problem.numberAllocated');
    case 'invalid':
      return t('doc.draft.problem.invalid');
    case 'notFound':
      return t('doc.draft.problem.notFound');
    case 'denied':
      return t('doc.draft.problem.denied');
    case 'session':
      return t('doc.draft.problem.session');
    case 'duplicate':
      return t('doc.draft.problem.duplicate');
    case 'general':
      return t('doc.draft.problem.general');
  }
}

/** The message under a field whose value the form refuses. */
export function fieldProblemMessage(t: T, problem: FieldProblem): string {
  switch (problem.code) {
    case 'REQUIRED':
      return t('doc.draft.field.required');
    case 'TOO_SHORT':
      return t('doc.draft.field.tooShort');
    case 'TOO_LONG':
      return t('doc.draft.field.tooLong');
    case 'INVALID':
      return t('doc.draft.field.invalid');
    case 'DELEGATION_REQUIRED':
      return t('doc.draft.field.delegationRequired');
    case 'DELEGATION_NOT_ALLOWED':
      return t('doc.draft.field.delegationNotAllowed');
  }
}
