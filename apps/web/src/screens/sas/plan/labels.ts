import type { Translator } from '../../../i18n';
import type { BillingCycle, ExpiredBehavior, FeatureProblem, FieldProblem, GraceBehavior, LimitKind, PlanStatus, ProblemView, VatCategory } from './model';

type T = Translator['t'];

/** The name of a plan is a label key for the seeded plan and plain text for the plans that are authored here. */
export function planName(t: T, name: string): string {
  return name === 'sas.plan.standard.name' ? t('sas.plan.standard.name') : name;
}

export function statusLabel(t: T, status: PlanStatus): string {
  switch (status) {
    case 'Draft':
      return t('sas.plan.status.draft');
    case 'Published':
      return t('sas.plan.status.published');
    case 'Retired':
      return t('sas.plan.status.retired');
  }
}

export function cycleLabel(t: T, cycle: BillingCycle): string {
  switch (cycle) {
    case 'MONTHLY':
      return t('sas.plan.cycle.monthly');
    case 'QUARTERLY':
      return t('sas.plan.cycle.quarterly');
    case 'ANNUAL':
      return t('sas.plan.cycle.annual');
    case 'CONTRACT_TERM':
      return t('sas.plan.cycle.contractTerm');
  }
}

export function vatLabel(t: T, vat: VatCategory): string {
  switch (vat) {
    case 'NOT_SUBJECT':
      return t('sas.plan.vat.notSubject');
    case 'VAT_0':
      return t('sas.plan.vat.zero');
    case 'VAT_5':
      return t('sas.plan.vat.five');
    case 'VAT_8':
      return t('sas.plan.vat.eight');
    case 'VAT_10':
      return t('sas.plan.vat.ten');
  }
}

export function limitKindLabel(t: T, kind: LimitKind): string {
  switch (kind) {
    case 'BOOLEAN':
      return t('sas.plan.kind.boolean');
    case 'QUOTA':
      return t('sas.plan.kind.quota');
    case 'METERED':
      return t('sas.plan.kind.metered');
  }
}

/** What a feature does while the licence is in its grace window. */
export function graceLabel(t: T, behavior: GraceBehavior): string {
  switch (behavior) {
    case 'ALLOW':
      return t('sas.plan.grace.allow');
    case 'READ_ONLY':
      return t('sas.plan.grace.readOnly');
    case 'DENY':
      return t('sas.plan.grace.deny');
  }
}

/** What a feature does after the licence has ended. */
export function expiredLabel(t: T, behavior: ExpiredBehavior): string {
  switch (behavior) {
    case 'READ_ONLY':
      return t('sas.plan.expired.readOnly');
    case 'EXPORT_ONLY':
      return t('sas.plan.expired.exportOnly');
    case 'DENY':
      return t('sas.plan.expired.deny');
  }
}

/** The limit of a feature in words: a switch has none, a quota is a number, a meter says what it counts. */
export function limitText(t: T, feature: { limitKind: LimitKind; limitValue: string | null; meter: string | null }): string {
  switch (feature.limitKind) {
    case 'BOOLEAN':
      return feature.limitValue === '0' ? t('sas.plan.limit.off') : t('sas.plan.limit.on');
    case 'QUOTA':
      return feature.limitValue ?? t('sas.plan.limit.none');
    case 'METERED':
      return feature.limitValue === null ? t('sas.plan.limit.metered', { meter: feature.meter ?? '' }) : t('sas.plan.limit.meteredCap', { meter: feature.meter ?? '', cap: feature.limitValue });
  }
}

export function fieldProblemMessage(t: T, problem: FieldProblem): string {
  switch (problem) {
    case 'required':
      return t('sas.plan.field.required');
    case 'format':
      return t('sas.plan.field.format');
    case 'tooLong':
      return t('sas.plan.field.tooLong');
    case 'notAmount':
      return t('sas.plan.field.notAmount');
  }
}

export function featureProblemMessage(t: T, problem: FeatureProblem): string {
  switch (problem) {
    case 'duplicate':
      return t('sas.plan.feature.duplicate');
    case 'limitRequired':
      return t('sas.plan.feature.limitRequired');
    case 'limitInvalid':
      return t('sas.plan.feature.limitInvalid');
    case 'meterRequired':
      return t('sas.plan.feature.meterRequired');
    case 'meterInvalid':
      return t('sas.plan.feature.meterInvalid');
    case 'meterNotAllowed':
      return t('sas.plan.feature.meterNotAllowed');
    case 'expiredWider':
      return t('sas.plan.feature.expiredWider');
  }
}

/** The field a server problem names, in the words of the form (`features[2].meter` becomes "feature 3, meter"). */
export function problemFieldText(t: T, field: string | undefined): string | undefined {
  if (field === undefined) return undefined;
  const feature = /^features\[(\d+)\]\.(\w+)$/.exec(field);
  if (feature !== null) return t('sas.plan.problem.featureField', { row: Number(feature[1]) + 1, field: feature[2] ?? '' });
  return field;
}

export function problemMessage(t: T, problem: ProblemView): string {
  switch (problem.reason) {
    case 'planInvalid': {
      const where = problemFieldText(t, problem.field);
      return where === undefined ? t('sas.plan.problem.planInvalid') : t('sas.plan.problem.planInvalidAt', { field: where, reason: problem.serverReason ?? '' });
    }
    case 'immutable':
      return t('sas.plan.problem.immutable');
    case 'conflict':
      return t('sas.plan.problem.conflict');
    case 'invalid':
      return t('sas.plan.problem.invalid');
    case 'denied':
      return t('sas.plan.problem.denied');
    case 'notFound':
      return t('sas.plan.problem.notFound');
    case 'session':
      return t('sas.plan.problem.session');
    case 'general':
      return t('sas.plan.problem.general');
  }
}
