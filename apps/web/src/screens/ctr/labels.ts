import type { useTranslation } from '../../i18n';
import { CONTRACT_STATUSES } from './model';
import type { AdvanceCategory, ContractStatus, ContractType, FieldProblem, PartyProblem, PartyRole, ProblemView } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

/** The status of a contract (CTR section 4). */
export function statusLabel(t: Translate, status: ContractStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('ctr.status.draft.label');
    case 'IN_REVIEW':
      return t('ctr.status.inReview.label');
    case 'SIGNED':
      return t('ctr.status.signed.label');
    case 'ACTIVE':
      return t('ctr.status.active.label');
    case 'SUSPENDED':
      return t('ctr.status.suspended.label');
    case 'TERMINATED':
      return t('ctr.status.terminated.label');
    case 'COMPLETED':
      return t('ctr.status.completed.label');
    case 'CLOSED':
      return t('ctr.status.closed.label');
    case 'CANCELLED':
      return t('ctr.status.cancelled.label');
  }
}

/** A status that arrives as text: the word of the screen for a status it knows, the text itself for one it does not. */
export function statusText(t: Translate, status: string): string {
  return (CONTRACT_STATUSES as readonly string[]).includes(status) ? statusLabel(t, status as ContractStatus) : status;
}

export function typeLabel(t: Translate, type: ContractType): string {
  switch (type) {
    case 'LUMP_SUM':
      return t('ctr.type.lumpSum.label');
    case 'UNIT_PRICE':
      return t('ctr.type.unitPrice.label');
    case 'ADJUSTABLE_PRICE':
      return t('ctr.type.adjustablePrice.label');
    case 'TIME_BASED':
      return t('ctr.type.timeBased.label');
    case 'COST_PLUS_FEE':
      return t('ctr.type.costPlusFee.label');
    case 'EPC':
      return t('ctr.type.epc.label');
    case 'ESTIMATE_BASED':
      return t('ctr.type.estimateBased.label');
  }
}

/** The group of contracts that an advance ceiling applies to (CXN-02). */
export function advanceLabel(t: Translate, category: AdvanceCategory): string {
  switch (category) {
    case 'CONSTRUCTION':
      return t('ctr.advance.construction.label');
    case 'EQUIPMENT':
      return t('ctr.advance.equipment.label');
    case 'CONSULTING':
      return t('ctr.advance.consulting.label');
    case 'EPC':
      return t('ctr.advance.epc.label');
    case 'LAND_CLEARANCE':
      return t('ctr.advance.landClearance.label');
    case 'OTHER':
      return t('ctr.advance.other.label');
  }
}

export function roleLabel(t: Translate, role: PartyRole | 'SOLE'): string {
  switch (role) {
    case 'LEAD':
      return t('ctr.role.lead.label');
    case 'MEMBER':
      return t('ctr.role.member.label');
    case 'SOLE':
      return t('ctr.role.sole.label');
  }
}

/** The status of a revision of a contract; one the screen has no word for is shown as it is. */
export function revisionStatusLabel(t: Translate, status: string): string {
  switch (status) {
    case 'DRAFT':
      return t('ctr.revision.status.draft');
    case 'PENDING_EFFECTIVE':
      return t('ctr.revision.status.pendingEffective');
    case 'EFFECTIVE':
      return t('ctr.revision.status.effective');
    case 'SUPERSEDED':
      return t('ctr.revision.status.superseded');
    case 'REJECTED':
      return t('ctr.revision.status.rejected');
    default:
      return status;
  }
}

export function fieldProblemMessage(t: Translate, problem: FieldProblem, ceiling?: string): string {
  switch (problem) {
    case 'required':
      return t('ctr.field.required.error');
    case 'tooLong':
      return t('ctr.field.tooLong.error');
    case 'invalidAmount':
      return t('ctr.field.invalidAmount.error');
    case 'zeroAmount':
      return t('ctr.field.zeroAmount.error');
    case 'invalidId':
      return t('ctr.field.invalidId.error');
    case 'invalidDate':
      return t('ctr.field.invalidDate.error');
    case 'aboveCeiling':
      return t('ctr.field.aboveCeiling.error', { ceiling: ceiling ?? '' });
  }
}

export function partyProblemMessage(t: Translate, problem: PartyProblem): string {
  switch (problem) {
    case 'contractorRequired':
      return t('ctr.parties.problem.contractorRequired.error');
    case 'contractorTwice':
      return t('ctr.parties.problem.contractorTwice.error');
    case 'invalidShare':
      return t('ctr.parties.problem.invalidShare.error');
    case 'invalidAmount':
      return t('ctr.parties.problem.invalidAmount.error');
  }
}

/** The sentence for a refusal of a command; a problem the screen has no sentence for is the general one. `format` groups the ceiling the server named. */
export function problemMessage(t: Translate, problem: ProblemView, format: (amount: string) => string = (amount) => amount): string {
  switch (problem.reason) {
    case 'duplicateCode':
      return t('ctr.problem.duplicateCode.error');
    case 'exceedsCeiling':
      return problem.ceiling === undefined ? t('ctr.problem.exceedsCeilingUnknown.error') : t('ctr.problem.exceedsCeiling.error', { ceiling: format(problem.ceiling) });
    case 'planNotApproved':
      return t('ctr.problem.planNotApproved.error');
    case 'packageNotAwarded':
      return t('ctr.problem.packageNotAwarded.error');
    case 'contractorNotVerified':
      return t('ctr.problem.contractorNotVerified.error');
    case 'contractorRestricted':
      return t('ctr.problem.contractorRestricted.error');
    case 'shareNot100':
      return t('ctr.problem.shareNot100.error');
    case 'workMismatch':
      return t('ctr.problem.workMismatch.error');
    case 'stateInvalid':
      return t('ctr.problem.stateInvalid.error');
    case 'versionConflict':
      return t('ctr.problem.versionConflict.error');
    case 'validation':
      return problem.field === undefined ? t('ctr.problem.validation.error') : t('ctr.problem.validationField.error', { field: problem.field });
    case 'notFound':
      return t('ctr.problem.notFound.error');
    case 'denied':
      return t('ctr.problem.denied.error');
    case 'general':
      return t('ctr.problem.general.error');
  }
}
