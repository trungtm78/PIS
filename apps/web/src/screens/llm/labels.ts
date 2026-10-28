import type { Translator } from '../../i18n';
import type { BudgetPeriod, BudgetProblem, BudgetScope, CachedSemantics, Capability, Classification, KeyProblem, KeyScope, KeyStatus, LlmReason, ModelProblem, ModelStatus, PolicyProblem, PolicyStatus, PriceProblem, ProviderProblem, ProviderStatus, ReservationStatus, Route } from './llm-model';

type T = Translator['t'];

export function classificationLabel(t: T, level: Classification): string {
  return {
    PUBLIC: t('llm.classification.public'),
    INTERNAL: t('llm.classification.internal'),
    CONFIDENTIAL: t('llm.classification.confidential'),
    PERSONAL: t('llm.classification.personal'),
    IMPORTANT_CORE: t('llm.classification.importantCore'),
  }[level];
}

export function routeLabel(t: T, route: Route): string {
  return { DOMESTIC_HOSTED: t('llm.route.domestic'), SELF_HOSTED: t('llm.route.selfHosted'), INTERNATIONAL: t('llm.route.international') }[route];
}

export function providerStatusLabel(t: T, status: ProviderStatus): string {
  return { PROPOSED: t('llm.providerStatus.proposed'), ACTIVE: t('llm.providerStatus.active'), SUSPENDED: t('llm.providerStatus.suspended'), RETIRED: t('llm.providerStatus.retired') }[status];
}

export function modelStatusLabel(t: T, status: ModelStatus): string {
  return {
    PROPOSED: t('llm.modelStatus.proposed'),
    EVAL_PENDING: t('llm.modelStatus.evalPending'),
    APPROVED: t('llm.modelStatus.approved'),
    SUSPENDED: t('llm.modelStatus.suspended'),
    RETIRED: t('llm.modelStatus.retired'),
  }[status];
}

export function policyStatusLabel(t: T, status: PolicyStatus): string {
  return { DRAFT: t('llm.policyStatus.draft'), PUBLISHED: t('llm.policyStatus.published'), SUPERSEDED: t('llm.policyStatus.superseded') }[status];
}

export function capabilityLabel(t: T, capability: Capability): string {
  return { json_schema: t('llm.capability.jsonSchema'), tools: t('llm.capability.tools'), vision: t('llm.capability.vision'), reasoning: t('llm.capability.reasoning') }[capability];
}

/** What a refusal of the server means for the person, in words; the levels of a weakened baseline are named, nothing else of the server is shown. */
export function refusalMessage(t: T, reason: LlmReason, detail: string): string {
  switch (reason) {
    case 'internationalPublicOnly':
      return t('llm.reason.internationalPublicOnly');
    case 'needsD07':
      return t('llm.reason.needsD07');
    case 'needsAgreement':
      return t('llm.reason.needsAgreement');
    case 'selfApproval':
      return t('llm.reason.selfApproval');
    case 'duplicateProvider':
      return t('llm.reason.duplicateProvider');
    case 'duplicateModel':
      return t('llm.reason.duplicateModel');
    case 'aboveProvider':
      return t('llm.reason.aboveProvider');
    case 'aliasDuplicate':
      return t('llm.reason.aliasDuplicate');
    case 'keyState':
      return t('llm.reason.keyState');
    case 'modelNotApproved':
      return t('llm.reason.modelNotApproved');
    case 'unavailable':
      return t('llm.reason.unavailable');
    case 'budgetDuplicate':
      return t('llm.reason.budgetDuplicate');
    case 'childExceeds':
      return t('llm.reason.childExceeds');
    case 'priceOverlap':
      return t('llm.reason.priceOverlap');
    case 'sourceRequired':
      return t('llm.reason.sourceRequired');
    case 'reservationState':
      return t('llm.reason.reservationState');
    case 'matrixInvalid':
      return t('llm.reason.matrixInvalid');
    case 'promptImmutable':
      return t('llm.reason.promptImmutable');
    case 'evalRequired':
      return t('llm.reason.evalRequired');
    case 'evalMissing':
      return t('llm.reason.evalMissing');
    case 'evalNotPassed':
      return t('llm.reason.evalNotPassed');
    case 'evalNotFinished':
      return t('llm.reason.evalNotFinished');
    case 'unsupportedParameter':
      return t('llm.reason.unsupportedParameter');
    case 'routeNotAllowed':
      return t('llm.reason.routeNotAllowed');
    case 'toolNotReadOnly':
      return t('llm.reason.toolNotReadOnly');
    case 'weakensBaseline':
      return t('llm.reason.weakensBaseline', { levels: detail });
    case 'stale':
      return t('llm.reason.stale');
    case 'state':
      return t('llm.reason.state');
    case 'invalid':
      return t('llm.reason.invalid');
    case 'denied':
      return t('llm.reason.denied');
    case 'session':
      return t('llm.reason.session');
    case 'general':
      return t('llm.reason.general');
  }
}

export function keyScopeLabel(t: T, scope: KeyScope): string {
  return { TENANT: t('llm.keyScope.tenant'), UNIT: t('llm.keyScope.unit'), PROJECT: t('llm.keyScope.project'), SERVICE: t('llm.keyScope.service') }[scope];
}

export function keyStatusLabel(t: T, status: KeyStatus): string {
  return { ACTIVE: t('llm.keyStatus.active'), ROTATING: t('llm.keyStatus.rotating'), REVOKED: t('llm.keyStatus.revoked') }[status];
}

export function budgetScopeLabel(t: T, scope: BudgetScope): string {
  return { TENANT: t('llm.budgetScope.tenant'), UNIT: t('llm.budgetScope.unit'), PROJECT: t('llm.budgetScope.project'), USER: t('llm.budgetScope.user') }[scope];
}

export function budgetPeriodLabel(t: T, period: BudgetPeriod): string {
  return { MONTH: t('llm.budgetPeriod.month'), QUARTER: t('llm.budgetPeriod.quarter'), YEAR: t('llm.budgetPeriod.year') }[period];
}

export function cachedSemanticsLabel(t: T, semantics: CachedSemantics): string {
  return { INCLUDED_IN_INPUT: t('llm.cached.included'), SEPARATE: t('llm.cached.separate') }[semantics];
}

export function reservationStatusLabel(t: T, status: ReservationStatus): string {
  return {
    RESERVED: t('llm.reservation.reserved'),
    SETTLED: t('llm.reservation.settled'),
    RELEASED: t('llm.reservation.released'),
    PENDING_RECONCILE: t('llm.reservation.pending'),
    EXCEPTION: t('llm.reservation.exception'),
  }[status];
}

export function financeProblemMessage(t: T, problem: BudgetProblem | PriceProblem): string {
  return {
    required: t('llm.problem.required'),
    invalidReference: t('llm.problem.invalidReference'),
    invalidAmount: t('llm.problem.invalidAmount'),
    invalidPercent: t('llm.problem.invalidPercent'),
    invalidNumber: t('llm.problem.invalidNumber'),
    invalidDate: t('llm.problem.invalidDate'),
    invalidCurrency: t('llm.problem.invalidCurrency'),
    invalidRate: t('llm.problem.invalidRate'),
    invalidSource: t('llm.problem.invalidSource'),
    invalidFx: t('llm.problem.invalidFx'),
  }[problem];
}

export function problemMessage(t: T, problem: ProviderProblem | ModelProblem | PolicyProblem | KeyProblem): string {
  return {
    required: t('llm.problem.required'),
    invalidCode: t('llm.problem.invalidCode'),
    invalidCountry: t('llm.problem.invalidCountry'),
    notVietnam: t('llm.problem.notVietnam'),
    internationalPublicOnly: t('llm.problem.internationalPublicOnly'),
    invalidDocument: t('llm.problem.invalidDocument'),
    invalidNumber: t('llm.problem.invalidNumber'),
    outputAboveWindow: t('llm.problem.outputAboveWindow'),
    aboveProvider: t('llm.problem.aboveProvider'),
    needsD07: t('llm.problem.needsD07'),
    invalidDate: t('llm.problem.invalidDate'),
    importantCore: t('llm.problem.importantCore'),
    invalidAlias: t('llm.problem.invalidAlias'),
    pastDate: t('llm.problem.pastDate'),
    needsModel: t('llm.problem.needsModel'),
  }[problem];
}
