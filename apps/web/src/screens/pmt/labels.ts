import type { useTranslation } from '../../i18n';
import type { Applicability, Category, FieldProblem, Phase, ProblemView } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function categoryLabel(t: Translate, category: Category): string {
  switch (category) {
    case 'ENVIRONMENT':
      return t('pmt.category.environment.text');
    case 'DESIGN_APPRAISAL':
      return t('pmt.category.designAppraisal.text');
    case 'FIRE_SAFETY':
      return t('pmt.category.fireSafety.text');
    case 'CONSTRUCTION_PERMIT':
      return t('pmt.category.constructionPermit.text');
    case 'LAND':
      return t('pmt.category.land.text');
    case 'TRAFFIC':
      return t('pmt.category.traffic.text');
    case 'WATER_RESOURCES':
      return t('pmt.category.waterResources.text');
    case 'OTHER':
      return t('pmt.category.other.text');
  }
}

export function phaseLabel(t: Translate, phase: Phase): string {
  switch (phase) {
    case 'draft':
      return t('pmt.type.phase.draft.text');
    case 'scheduled':
      return t('pmt.type.phase.scheduled.text');
    case 'inForce':
      return t('pmt.type.phase.inForce.text');
    case 'ended':
      return t('pmt.type.phase.ended.text');
  }
}

/** The condition of a version in words: every project, or the groups, the kinds of works and the size it is limited to. */
export function applicabilityText(t: Translate, applies: Applicability): string {
  const parts = [
    applies.projectGroupKeys.length === 0 ? null : t('pmt.type.applies.groups.text', { keys: applies.projectGroupKeys.join(', ') }),
    applies.workTypes.length === 0 ? null : t('pmt.type.applies.works.text', { keys: applies.workTypes.join(', ') }),
    applies.minTotalInvestmentVnd === null ? null : t('pmt.type.applies.min.text', { amount: applies.minTotalInvestmentVnd }),
    applies.maxTotalInvestmentVnd === null ? null : t('pmt.type.applies.max.text', { amount: applies.maxTotalInvestmentVnd }),
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? t('pmt.type.applies.all.text') : parts.join(' · ');
}

export function fieldProblemMessage(t: Translate, problem: FieldProblem): string {
  switch (problem) {
    case 'required':
      return t('pmt.field.required.error');
    case 'invalidCode':
      return t('pmt.field.invalidCode.error');
    case 'tooLong':
      return t('pmt.field.tooLong.error');
    case 'invalidReference':
      return t('pmt.field.invalidReference.error');
    case 'invalidDate':
      return t('pmt.field.invalidDate.error');
    case 'past':
      return t('pmt.field.past.error');
    case 'untilOrder':
      return t('pmt.field.untilOrder.error');
    case 'laterEnd':
      return t('pmt.field.laterEnd.error');
    case 'invalidNumber':
      return t('pmt.field.invalidNumber.error');
    case 'invalidKeys':
      return t('pmt.field.invalidKeys.error');
    case 'invalidAmount':
      return t('pmt.field.invalidAmount.error');
    case 'amountOrder':
      return t('pmt.field.amountOrder.error');
    case 'rejected':
      return t('pmt.field.rejected.error');
  }
}

export function problemMessage(t: Translate, problem: ProblemView): string {
  switch (problem.reason) {
    case 'overlap':
      return t('pmt.problem.overlap.error');
    case 'inUse':
      return t('pmt.problem.inUse.error');
    case 'legalBasis':
      return t('pmt.problem.legalBasis.error');
    case 'validation':
      return t('pmt.problem.validation.error');
    case 'denied':
      return t('pmt.problem.denied.error');
    case 'notFound':
      return t('pmt.problem.notFound.error');
    case 'general':
      return t('pmt.problem.general.error');
  }
}
