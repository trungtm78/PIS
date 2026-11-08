import { ApiError } from '@machvon/api-client';
import type { Translator } from '../../i18n';
import type { InfoFormulaLabels } from '../../ui';
import type { DirectiveLine, DirectiveStatus, MeetingType, Policy } from './model';

type T = Translator['t'];

/** The words of a status a reader sees; each key is written out so the i18n check can see it is in use. */
export function statusLabel(t: T, status: DirectiveStatus): string {
  switch (status) {
    case 'OPEN':
      return t('dir.status.open.label');
    case 'IN_PROGRESS':
      return t('dir.status.inProgress.label');
    case 'DONE':
      return t('dir.status.done.label');
    case 'OVERDUE':
      return t('dir.status.overdue.label');
    case 'CANCELLED':
      return t('dir.status.cancelled.label');
  }
}

export function meetingTypeLabel(t: T, type: MeetingType): string {
  switch (type) {
    case 'WEEKLY':
      return t('dir.type.weekly.label');
    case 'MONTHLY':
      return t('dir.type.monthly.label');
    case 'QUARTERLY':
      return t('dir.type.quarterly.label');
    case 'EXTRAORDINARY':
      return t('dir.type.extraordinary.label');
    case 'SITE_VISIT':
      return t('dir.type.siteVisit.label');
    case 'OTHER':
      return t('dir.type.other.label');
  }
}

/** Where a directive stands on its clock, in a few words: "2 days left", "Due today", "Overdue 3 days", "Overdue 8 days · unit head informed"; nothing for an ended one. */
export function clockText(t: T, line: Pick<DirectiveLine, 'phase' | 'daysToDue' | 'overdueDays'>): string {
  switch (line.phase) {
    case 'DUE_LATER':
    case 'DUE_SOON':
      return t('dir.clock.left.text', { days: line.daysToDue ?? 0 });
    case 'DUE_TODAY':
      return t('dir.clock.today.text');
    case 'OVERDUE':
      return t('dir.clock.late.text', { days: line.overdueDays ?? 0 });
    case 'ESCALATED':
      return t('dir.clock.escalated.text', { days: line.overdueDays ?? 0 });
    case 'ENDED':
      return '';
  }
}

/** The event types of the timeline. */
export function eventLabel(t: T, type: string): string {
  switch (type) {
    case 'CREATED':
      return t('dir.event.created.label');
    case 'ASSIGNED':
      return t('dir.event.assigned.label');
    case 'PROGRESS':
      return t('dir.event.progress.label');
    case 'EXTENSION_REQUESTED':
      return t('dir.event.extensionRequested.label');
    case 'EXTENSION_APPROVED':
      return t('dir.event.extensionApproved.label');
    case 'EXTENSION_REJECTED':
      return t('dir.event.extensionRejected.label');
    case 'CLOSED':
      return t('dir.event.closed.label');
    case 'CANCELLED':
      return t('dir.event.cancelled.label');
    case 'REOPENED':
      return t('dir.event.reopened.label');
    default:
      return type;
  }
}

export function extensionStatusLabel(t: T, status: 'REQUESTED' | 'APPROVED' | 'REJECTED'): string {
  switch (status) {
    case 'REQUESTED':
      return t('dir.extension.status.requested');
    case 'APPROVED':
      return t('dir.extension.status.approved');
    case 'REJECTED':
      return t('dir.extension.status.rejected');
  }
}

/** The words of a refusal of a command: what to do about it, never the code alone. A conflict of versions says to read again (the screen does). */
export function errorText(t: T, error: unknown, policy?: Policy): string {
  if (!(error instanceof ApiError)) return t('dir.error.failed.text');
  switch (error.code) {
    case 'SELF_APPROVAL_DENIED':
      return t('dir.error.selfApproval.text');
    case 'VERSION_CONFLICT':
      return t('dir.error.versionConflict.text');
    case 'DIRECTIVE_STATE_INVALID':
      return t('dir.error.stateInvalid.text');
    case 'DIRECTIVE_EVIDENCE_REQUIRED':
      return t('dir.error.evidenceRequired.text');
    case 'DIRECTIVE_EXTENSION_INVALID':
      return t('dir.error.extensionInvalid.text', { days: policy?.maxExtensionDays ?? 0 });
    case 'DIRECTIVE_EXTENSION_LIMIT':
      return t('dir.error.extensionLimit.text', { count: policy?.maxExtensions ?? 0 });
    case 'DIRECTIVE_EXTENSION_PENDING':
      return t('dir.error.extensionPending.text');
    case 'DIRECTIVE_EXTENSION_STATE_INVALID':
      return t('dir.error.extensionState.text');
    case 'DECISION_DOCUMENT_REQUIRED':
      return t('dir.error.document.text');
    case 'SCOPE_DENIED':
      return t('dir.error.scope.text');
    case 'VALIDATION_FAILED':
      return t('dir.error.validation.text');
    case 'RESOURCE_NOT_FOUND':
      return t('dir.error.notFound.text');
    default:
      return error.status === 403 ? t('dir.error.forbidden.text') : t('dir.error.refused.text', { code: error.code });
  }
}

/** The words of the "i" of a figure. */
export function infoLabels(t: T, name: string): InfoFormulaLabels {
  return {
    open: t('dir.info.open.label', { name }),
    close: t('dir.info.close.label'),
    formula: t('dir.info.formula.label'),
    numerator: t('dir.info.numerator.label'),
    denominator: t('dir.info.denominator.label'),
    exclusions: t('dir.info.exclusions.label'),
    source: t('dir.info.source.label'),
    asOf: t('dir.info.asOf.label'),
    owner: t('dir.info.owner.label'),
    version: t('dir.info.version.label'),
    unverified: t('dir.info.unverified.text'),
  };
}

/** Which version of the policy the numbers were counted with, in words. */
export function policyVersionText(t: T, policy: Policy): string {
  return policy.source === 'DEFAULT' ? t('dir.policy.default.text') : t('dir.policy.rule.text', { version: policy.version ?? 0 });
}
