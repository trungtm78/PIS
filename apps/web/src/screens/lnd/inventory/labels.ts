import type { useTranslation } from '../../../i18n';
import type { CommandProblem, FormProblem, InventoryStatus, ItemKind, Outcome } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function itemKindLabel(t: Translate, kind: ItemKind): string {
  switch (kind) {
    case 'LAND':
      return t('lnd.itemKind.land.label');
    case 'HOUSE':
      return t('lnd.itemKind.house.label');
    case 'STRUCTURE':
      return t('lnd.itemKind.structure.label');
    case 'CROP':
      return t('lnd.itemKind.crop.label');
    case 'TREE':
      return t('lnd.itemKind.tree.label');
    case 'GRAVE':
      return t('lnd.itemKind.grave.label');
    case 'BUSINESS_LOSS':
      return t('lnd.itemKind.businessLoss.label');
    case 'OTHER':
      return t('lnd.itemKind.other.label');
  }
}

export function inventoryStatusLabel(t: Translate, status: InventoryStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('lnd.inventoryStatus.draft.label');
    case 'CONFIRMED':
      return t('lnd.inventoryStatus.confirmed.label');
    case 'DISPUTED':
      return t('lnd.inventoryStatus.disputed.label');
    case 'SUPERSEDED':
      return t('lnd.inventoryStatus.superseded.label');
  }
}

export function outcomeLabel(t: Translate, outcome: Outcome): string {
  switch (outcome) {
    case 'CONFIRMED':
      return t('lnd.inventoryOutcome.confirmed.label');
    case 'DISPUTED':
      return t('lnd.inventoryOutcome.disputed.label');
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
      return t('lnd.field.future.error');
    case 'beforeSurvey':
      return t('lnd.inventory.field.beforeSurvey.error');
  }
}

/** The sentence for a refusal of a command; a problem the screen has no sentence for is the general one. */
export function commandProblemMessage(t: Translate, problem: CommandProblem): string {
  switch (problem) {
    case 'priceDecision':
      return t('lnd.inventory.problem.priceDecision.error');
    case 'parcelNotLinked':
      return t('lnd.inventory.problem.parcelNotLinked.error');
    case 'selfApproval':
      return t('lnd.inventory.problem.selfApproval.error');
    case 'stateInvalid':
      return t('lnd.inventory.problem.stateInvalid.error');
    case 'versionConflict':
      return t('lnd.problem.versionConflict.error');
    case 'documentNotClean':
      return t('lnd.problem.documentNotClean.error');
    case 'validation':
      return t('lnd.problem.validation.error');
    case 'notFound':
      return t('lnd.problem.notFound.error');
    case 'denied':
      return t('lnd.problem.denied.error');
    case 'general':
      return t('lnd.problem.general.error');
  }
}
