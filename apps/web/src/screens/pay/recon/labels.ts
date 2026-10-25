import type { useTranslation } from '../../../i18n';
import type { ItemKind, ItemStatus, ReconProblem, Refusal, Resolution } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function kindLabel(t: Translate, kind: ItemKind): string {
  switch (kind) {
    case 'AMOUNT_MISMATCH':
      return t('pay.recon.kind.amountMismatch');
    case 'UNMATCHED_TRANSACTION':
      return t('pay.recon.kind.unmatchedTransaction');
    case 'MISSING_CONFIRMATION':
      return t('pay.recon.kind.missingConfirmation');
    case 'DUPLICATE_CONFLICT':
      return t('pay.recon.kind.duplicateConflict');
    case 'ADVANCE_OVERDUE':
      return t('pay.recon.kind.advanceOverdue');
  }
}

export function itemStatusLabel(t: Translate, status: ItemStatus): string {
  switch (status) {
    case 'OPEN':
      return t('pay.recon.status.open');
    case 'EXPLAINED':
      return t('pay.recon.status.explained');
    case 'RESOLVED':
      return t('pay.recon.status.resolved');
    case 'WRITTEN_OFF_APPROVED':
      return t('pay.recon.status.writtenOff');
  }
}

/** The name of a resolution on the buttons and in the dialogs. */
export function resolutionLabel(t: Translate, resolution: Resolution): string {
  switch (resolution) {
    case 'EXPLAINED':
      return t('pay.item.action.explain');
    case 'RESOLVED':
      return t('pay.item.action.resolve');
    case 'WRITTEN_OFF':
      return t('pay.item.action.writeOff');
  }
}

export function problemMessage(t: Translate, problem: ReconProblem): string {
  switch (problem) {
    case 'required':
      return t('pay.recon.problem.required');
    case 'tooLong':
      return t('pay.recon.problem.tooLong');
    case 'uuid':
      return t('pay.recon.problem.uuid');
    case 'invalid':
      return t('pay.recon.problem.invalid');
    case 'past':
      return t('pay.recon.problem.past');
  }
}

/** What a refusal says. A match that did not agree is not worded here: it is shown with the two figures and the difference that was opened (see the match dialog). */
export function refusalMessage(t: Translate, refusal: Refusal): string {
  switch (refusal.problem) {
    case 'mismatch':
      return t('pay.recon.error.mismatch');
    case 'alreadyMatched':
      return t('pay.recon.error.alreadyMatched');
    case 'paymentState':
      return t('pay.recon.error.paymentState');
    case 'itemState':
      return t('pay.recon.error.itemState');
    case 'approvalRequired':
      return t('pay.recon.error.approvalRequired');
    case 'selfApproval':
      return t('pay.recon.error.selfApproval');
    case 'planYear':
      return t('pay.recon.error.planYear');
    case 'notClean':
      return t('pay.recon.error.notClean');
    case 'versionConflict':
      return t('pay.recon.error.versionConflict');
    case 'validation':
      return t('pay.recon.error.validation');
    case 'notFound':
      return t('pay.recon.error.notFound');
    case 'denied':
      return t('pay.recon.error.denied');
    case 'session':
      return t('pay.recon.error.session');
    case 'general':
      return t('pay.recon.error.general');
  }
}
