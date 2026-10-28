import type { Translator } from '../../i18n';
import type { Capability, Classification, LlmReason, ModelProblem, ModelStatus, PolicyProblem, PolicyStatus, ProviderProblem, ProviderStatus, Route } from './llm-model';

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
    case 'matrixInvalid':
      return t('llm.reason.matrixInvalid');
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

export function problemMessage(t: T, problem: ProviderProblem | ModelProblem | PolicyProblem): string {
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
  }[problem];
}
