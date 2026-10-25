import type { useTranslation } from '../../../i18n';
import type { CommandProblem, FormProblem, HouseholdStatus, LegalBasis, RightKind } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function householdStatusLabel(t: Translate, status: HouseholdStatus): string {
  switch (status) {
    case 'REGISTERED':
      return t('lnd.householdStatus.registered.label');
    case 'INVENTORIED':
      return t('lnd.householdStatus.inventoried.label');
    case 'PLAN_LISTED':
      return t('lnd.householdStatus.planListed.label');
    case 'COMPENSATED':
      return t('lnd.householdStatus.compensated.label');
    case 'RESETTLED':
      return t('lnd.householdStatus.resettled.label');
    case 'CLOSED':
      return t('lnd.householdStatus.closed.label');
    case 'DISPUTED':
      return t('lnd.householdStatus.disputed.label');
  }
}

export function legalBasisLabel(t: Translate, basis: LegalBasis): string {
  switch (basis) {
    case 'PUBLIC_TASK_LAND_LAW':
      return t('lnd.legalBasis.publicTask.label');
    case 'LEGAL_OBLIGATION':
      return t('lnd.legalBasis.legalObligation.label');
    case 'CONSENT':
      return t('lnd.legalBasis.consent.label');
  }
}

export function rightKindLabel(t: Translate, kind: RightKind): string {
  switch (kind) {
    case 'OWNER':
      return t('lnd.rightKind.owner.label');
    case 'USER':
      return t('lnd.rightKind.user.label');
    case 'LESSEE':
      return t('lnd.rightKind.lessee.label');
    case 'OCCUPANT_NO_TITLE':
      return t('lnd.rightKind.occupant.label');
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
    case 'past':
      return t('lnd.households.field.past.error');
  }
}

/** The sentence for a refusal of a command or of the reading; a problem the screen has no sentence for is the general one. */
export function commandProblemMessage(t: Translate, problem: CommandProblem): string {
  switch (problem) {
    case 'legalBasisRequired':
      return t('lnd.households.problem.legalBasis.error');
    case 'consentRequired':
      return t('lnd.households.problem.consent.error');
    case 'householdDuplicate':
      return t('lnd.households.problem.duplicate.error');
    case 'linkDuplicate':
      return t('lnd.households.problem.linkDuplicate.error');
    case 'shareExceeded':
      return t('lnd.households.problem.share.error');
    case 'documentNotClean':
      return t('lnd.problem.documentNotClean.error');
    case 'sealUnavailable':
      return t('lnd.households.problem.seal.error');
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
