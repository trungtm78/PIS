import type { useTranslation } from '../../../i18n';
import type { CommandProblem, ExecutorKind, FormProblem, ItemKind, PlanStatus } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function executorKindLabel(t: Translate, kind: ExecutorKind): string {
  switch (kind) {
    case 'PROJECT_OWNER':
      return t('lnd.executorKind.projectOwner.label');
    case 'LAND_FUND_CENTRE':
      return t('lnd.executorKind.landFundCentre.label');
    case 'DISTRICT_BOARD':
      return t('lnd.executorKind.districtBoard.label');
  }
}

export function planStatusLabel(t: Translate, status: PlanStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('lnd.planStatus.draft.label');
    case 'POSTING':
      return t('lnd.planStatus.posting.label');
    case 'POSTING_CLOSED':
      return t('lnd.planStatus.postingClosed.label');
    case 'APPROVED':
      return t('lnd.planStatus.approved.label');
    case 'PAYING':
      return t('lnd.planStatus.paying.label');
    case 'COMPLETED':
      return t('lnd.planStatus.completed.label');
    case 'CANCELLED':
      return t('lnd.planStatus.cancelled.label');
    case 'REVISED':
      return t('lnd.planStatus.revised.label');
  }
}

export function planItemKindLabel(t: Translate, kind: ItemKind): string {
  switch (kind) {
    case 'COMPENSATION_LAND':
      return t('lnd.planItemKind.compensationLand.label');
    case 'COMPENSATION_ASSET':
      return t('lnd.planItemKind.compensationAsset.label');
    case 'SUPPORT_LIVELIHOOD':
      return t('lnd.planItemKind.supportLivelihood.label');
    case 'SUPPORT_RELOCATION':
      return t('lnd.planItemKind.supportRelocation.label');
    case 'SUPPORT_TRAINING':
      return t('lnd.planItemKind.supportTraining.label');
    case 'RESETTLEMENT_LAND':
      return t('lnd.planItemKind.resettlementLand.label');
    case 'RESETTLEMENT_HOUSE':
      return t('lnd.planItemKind.resettlementHouse.label');
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
  }
}

/** The sentence for a refusal of a command; a problem the screen has no sentence for is the general one. */
export function commandProblemMessage(t: Translate, problem: CommandProblem): string {
  switch (problem) {
    case 'codeDuplicate':
      return t('lnd.plans.problem.codeDuplicate.error');
    case 'stateInvalid':
      return t('lnd.plans.problem.stateInvalid.error');
    case 'notConfirmed':
      return t('lnd.plans.problem.notConfirmed.error');
    case 'versionConflict':
      return t('lnd.problem.versionConflict.error');
    case 'scopeDenied':
      return t('lnd.plans.problem.scopeDenied.error');
    case 'validation':
      return t('lnd.problem.validation.error');
    case 'notFound':
      return t('lnd.problem.notFound.error');
    case 'general':
      return t('lnd.problem.general.error');
  }
}
