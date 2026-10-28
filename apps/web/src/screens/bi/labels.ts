import type { Translator } from '../../i18n';
import type { Badge, BuildReason, VersionStatus } from './dataset-model';
import type { GranteeKind, PolicyProblemKind, PolicyReason, PolicyStatus } from './policy-model';
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

export function badgeLabel(t: T, badge: Badge): string {
  switch (badge) {
    case 'NOT_ASSESSED':
      return t('bi.dataset.badge.notAssessed');
    case 'PASSED':
      return t('bi.dataset.badge.passed');
    case 'WARNING':
      return t('bi.dataset.badge.warning');
    case 'FAILED':
      return t('bi.dataset.badge.failed');
    case 'STALE':
      return t('bi.dataset.badge.stale');
  }
}

export function versionStatusLabel(t: T, status: VersionStatus): string {
  switch (status) {
    case 'BUILDING':
      return t('bi.dataset.status.building');
    case 'FROZEN':
      return t('bi.dataset.status.frozen');
    case 'SUPERSEDED':
      return t('bi.dataset.status.superseded');
    case 'FAILED':
      return t('bi.dataset.status.failed');
  }
}

export function refreshLabel(t: T, policy: string): string {
  return policy === 'ON_SNAPSHOT_FROZEN' ? t('bi.dataset.refresh.onFrozen') : policy === 'SCHEDULED' ? t('bi.dataset.refresh.scheduled') : policy;
}

export function sourceKindLabel(t: T, kind: string): string {
  return kind === 'PERIOD_SNAPSHOT' ? t('bi.dataset.source.periodSnapshot') : kind;
}

export function buildProblemMessage(t: T, reason: BuildReason): string {
  switch (reason) {
    case 'running':
      return t('bi.dataset.refused.running');
    case 'notFrozen':
      return t('bi.dataset.refused.notFrozen');
    case 'invalid':
      return t('bi.dataset.refused.invalid');
    case 'denied':
      return t('bi.dataset.refused.denied');
    case 'notFound':
      return t('bi.dataset.refused.notFound');
    case 'session':
      return t('bi.dataset.refused.session');
    case 'general':
      return t('bi.dataset.refused.general');
  }
}

export function granteeKindLabel(t: T, kind: GranteeKind): string {
  switch (kind) {
    case 'ROLE':
      return t('bi.policy.grantee.role');
    case 'UNIT_TREE':
      return t('bi.policy.grantee.unitTree');
    case 'MEMBERSHIP':
      return t('bi.policy.grantee.membership');
  }
}

export function policyStatusLabel(t: T, status: PolicyStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('bi.policy.status.draft');
    case 'ACTIVE':
      return t('bi.policy.status.active');
    case 'RETIRED':
      return t('bi.policy.status.retired');
  }
}

export function policyFieldMessage(t: T, kind: PolicyProblemKind): string {
  switch (kind) {
    case 'required':
      return t('bi.policy.problem.required');
    case 'invalidId':
      return t('bi.policy.problem.invalidId');
    case 'invalidName':
      return t('bi.policy.problem.invalidName');
    case 'needsCondition':
      return t('bi.policy.problem.needsCondition');
    case 'bothMasks':
      return t('bi.policy.problem.bothMasks');
  }
}

export function policyRefusalMessage(t: T, reason: PolicyReason, field: string): string {
  switch (reason) {
    case 'predicate':
      return t('bi.policy.refused.predicate');
    case 'dimension':
      return t('bi.policy.refused.dimension', { field });
    case 'invalid':
      return t('bi.policy.refused.invalid', { field });
    case 'denied':
      return t('bi.policy.refused.denied');
    case 'session':
      return t('bi.policy.refused.session');
    case 'general':
      return t('bi.policy.refused.general');
  }
}
