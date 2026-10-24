import type { useTranslation } from '../../i18n';
import type { AppropriationStatus, BudgetLevel, Category, FieldProblem, Origin, ProblemView } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

/** The origin of the capital (loại giao): who assigned it. */
export function originLabel(t: Translate, origin: Origin): string {
  switch (origin) {
    case 'PM_ASSIGNED':
      return t('cap.origin.pmAssigned.label');
    case 'LOCAL_ADDED':
      return t('cap.origin.localAdded.label');
    case 'CARRYOVER':
      return t('cap.origin.carryover.label');
    case 'CENTRAL_SUPPORT':
      return t('cap.origin.centralSupport.label');
    case 'REVENUE_INCREASE':
      return t('cap.origin.revenueIncrease.label');
  }
}

export function levelLabel(t: Translate, level: BudgetLevel): string {
  return level === 'CENTRAL' ? t('cap.level.central.label') : t('cap.level.local.label');
}

export function statusLabel(t: Translate, status: AppropriationStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('cap.status.draft.label');
    case 'APPROVED':
      return t('cap.status.approved.label');
    case 'PUBLISHED':
      return t('cap.status.published.label');
    case 'SUPERSEDED':
      return t('cap.status.superseded.label');
    case 'REJECTED':
      return t('cap.status.rejected.label');
  }
}

/** The category of a fund source: the nodes of the tree of CAP-04. */
export function categoryLabel(t: Translate, category: Category): string {
  switch (category) {
    case 'NSTW':
      return t('cap.category.nstw.label');
    case 'NSDP':
      return t('cap.category.nsdp.label');
    case 'ODA':
      return t('cap.category.oda.label');
    case 'CTMTQG':
      return t('cap.category.ctmtqg.label');
    case 'OTHER':
      return t('cap.category.other.label');
  }
}

export function fieldProblemMessage(t: Translate, problem: FieldProblem): string {
  switch (problem) {
    case 'required':
      return t('cap.field.required.error');
    case 'invalidYear':
      return t('cap.field.invalidYear.error');
    case 'invalidAmount':
      return t('cap.field.invalidAmount.error');
    case 'invalidId':
      return t('cap.field.invalidId.error');
    case 'invalidDate':
      return t('cap.field.invalidDate.error');
    case 'tooShort':
      return t('cap.field.tooShort.error');
    case 'tooLong':
      return t('cap.field.tooLong.error');
    case 'sourceYear':
      return t('cap.field.sourceYear.error');
  }
}

/** The sentence for a refusal of a command; a problem the screen has no sentence for is the general one. */
export function problemMessage(t: Translate, problem: ProblemView): string {
  switch (problem.reason) {
    case 'belowAllocated':
      return t('cap.problem.belowAllocated.error');
    case 'decisionRequired':
      return t('cap.problem.decisionRequired.error');
    case 'extensionRequired':
      return t('cap.problem.extensionRequired.error');
    case 'duplicate':
      return t('cap.problem.duplicate.error');
    case 'revisionPending':
      return t('cap.problem.revisionPending.error');
    case 'selfApproval':
      return t('cap.problem.selfApproval.error');
    case 'versionConflict':
      return t('cap.problem.versionConflict.error');
    case 'stateInvalid':
      return t('cap.problem.stateInvalid.error');
    case 'yearLocked':
      return t('cap.problem.yearLocked.error');
    case 'masterNotEffective':
      return problem.field === undefined ? t('cap.problem.masterNotEffective.error') : t('cap.problem.masterNotEffectiveField.error', { field: problem.field });
    case 'subsetSource':
      return t('cap.problem.subsetSource.error');
    case 'notAllowed':
      return t('cap.problem.notAllowed.error');
    case 'validation':
      return problem.field === undefined ? t('cap.problem.validation.error') : t('cap.problem.validationField.error', { field: problem.field });
    case 'notFound':
      return t('cap.problem.notFound.error');
    case 'denied':
      return t('cap.problem.denied.error');
    case 'general':
      return t('cap.problem.general.error');
  }
}
