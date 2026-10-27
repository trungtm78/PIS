import type { Translator } from '../../i18n';
import type { Aggregate, Aggregation, FieldProblem, MetricOrigin, MetricStatus, NullPolicy, ProblemView } from './bi-model';

type T = Translator['t'];

export function aggregationLabel(t: T, aggregation: Aggregation): string {
  switch (aggregation) {
    case 'additive':
      return t('bi.metric.aggregation.additive');
    case 'semi_additive':
      return t('bi.metric.aggregation.semiAdditive');
    case 'ratio':
      return t('bi.metric.aggregation.ratio');
    case 'distinct':
      return t('bi.metric.aggregation.distinct');
  }
}

export function statusLabel(t: T, status: MetricStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('bi.metric.status.draft');
    case 'IN_REVIEW':
      return t('bi.metric.status.inReview');
    case 'CERTIFIED':
      return t('bi.metric.status.certified');
    case 'SUPERSEDED':
      return t('bi.metric.status.superseded');
    case 'RETIRED':
      return t('bi.metric.status.retired');
  }
}

export function originLabel(t: T, origin: MetricOrigin): string {
  return origin === 'PLATFORM_CODE' ? t('bi.metric.origin.platform') : t('bi.metric.origin.tenant');
}

export function nullPolicyLabel(t: T, policy: NullPolicy): string {
  return policy === 'NULL_NOT_ZERO' ? t('bi.metric.nullPolicy.notZero') : t('bi.metric.nullPolicy.zeroIfNoRows');
}

export function aggregateLabel(t: T, aggregate: Aggregate): string {
  switch (aggregate) {
    case 'sum':
      return t('bi.metric.aggregate.sum');
    case 'count':
      return t('bi.metric.aggregate.count');
    case 'count_distinct':
      return t('bi.metric.aggregate.countDistinct');
    case 'min':
      return t('bi.metric.aggregate.min');
    case 'max':
      return t('bi.metric.aggregate.max');
  }
}

export function fieldProblemMessage(t: T, problem: FieldProblem): string {
  switch (problem) {
    case 'required':
      return t('bi.metric.problem.required');
    case 'invalidCode':
      return t('bi.metric.problem.invalidCode');
    case 'invalidField':
      return t('bi.metric.problem.invalidField');
    case 'invalidDimension':
      return t('bi.metric.problem.invalidDimension');
    case 'invalidId':
      return t('bi.metric.problem.invalidId');
    case 'invalidDate':
      return t('bi.metric.problem.invalidDate');
  }
}

/** What a refusal of the server says, with the field it names when it names one. */
export function problemMessage(t: T, problem: ProblemView): string {
  switch (problem.reason) {
    case 'ratio':
      return t('bi.metric.refused.ratio');
    case 'expression':
      return t('bi.metric.refused.expression');
    case 'platformReadOnly':
      return t('bi.metric.refused.platformReadOnly');
    case 'dimension':
      return t('bi.metric.refused.dimension', { field: problem.field ?? '' });
    case 'invalid':
      return t('bi.metric.refused.invalid', { field: problem.field ?? '' });
    case 'denied':
      return t('bi.metric.refused.denied');
    case 'session':
      return t('bi.metric.refused.session');
    case 'general':
      return t('bi.metric.refused.general');
  }
}
