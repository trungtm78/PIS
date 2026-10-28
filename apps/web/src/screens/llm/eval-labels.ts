import type { Translator } from '../../i18n';
import type { DatasetProblem, DatasetSource, MetricName, ProfileProblem, ProfileStatus, PromptProblem, PromptStatus, RouteGate, RunStatus } from './eval-model';

type T = Translator['t'];

export function promptStatusLabel(t: T, status: PromptStatus): string {
  return { DRAFT: t('llm.promptStatus.draft'), APPROVED: t('llm.promptStatus.approved'), RETIRED: t('llm.promptStatus.retired') }[status];
}

export function profileStatusLabel(t: T, status: ProfileStatus): string {
  return {
    DRAFT: t('llm.profileStatus.draft'),
    EVAL_PENDING: t('llm.profileStatus.evalPending'),
    PUBLISHED: t('llm.profileStatus.published'),
    SUPERSEDED: t('llm.profileStatus.superseded'),
    ROLLED_BACK: t('llm.profileStatus.rolledBack'),
  }[status];
}

export function runStatusLabel(t: T, status: RunStatus): string {
  return {
    PENDING_SIGNATURE: t('llm.runStatus.pending'),
    SIGNED_PASS: t('llm.runStatus.signedPass'),
    SIGNED_FAIL: t('llm.runStatus.signedFail'),
    FAILED: t('llm.runStatus.failed'),
    SUPERSEDED: t('llm.runStatus.superseded'),
  }[status];
}

export function gateLabel(t: T, gate: RouteGate): string {
  return {
    NONE: t('llm.gate.none'),
    UNSIGNED: t('llm.gate.unsigned'),
    FAILED_RUN: t('llm.gate.failedRun'),
    SIGNED_PASS: t('llm.gate.signedPass'),
    SIGNED_FAIL: t('llm.gate.signedFail'),
    PASS_OVER_FAILED_METRICS: t('llm.gate.passOverFailed'),
  }[gate];
}

export function metricLabel(t: T, metric: MetricName | string): string {
  const known: Record<string, string> = {
    citation_precision: t('llm.metric.citationPrecision'),
    unsupported_claim_rate: t('llm.metric.unsupportedClaimRate'),
    injection_resistance: t('llm.metric.injectionResistance'),
    schema_valid_rate: t('llm.metric.schemaValidRate'),
  };
  return known[metric] ?? metric;
}

export function datasetSourceLabel(t: T, source: DatasetSource): string {
  return { SYNTHETIC: t('llm.datasetSource.synthetic'), ANONYMISED: t('llm.datasetSource.anonymised') }[source];
}

export function effortLabel(t: T, effort: string): string {
  const known: Record<string, string> = { low: t('llm.effort.low'), medium: t('llm.effort.medium'), high: t('llm.effort.high') };
  return known[effort] ?? effort;
}

export function toolLabel(t: T, tool: string): string {
  const known: Record<string, string> = {
    search_documents: t('llm.tool.searchDocuments'),
    read_document: t('llm.tool.readDocument'),
    lookup_master_data: t('llm.tool.lookupMasterData'),
    read_project_summary: t('llm.tool.readProjectSummary'),
    read_contract_summary: t('llm.tool.readContractSummary'),
  };
  return known[tool] ?? tool;
}

export function evalProblemMessage(t: T, problem: PromptProblem | DatasetProblem | ProfileProblem): string {
  return {
    required: t('llm.problem.required'),
    invalidHash: t('llm.eval.problem.invalidHash'),
    invalidKey: t('llm.eval.problem.invalidKey'),
    invalidJson: t('llm.eval.problem.invalidJson'),
    invalidSchema: t('llm.eval.problem.invalidSchema'),
    needsCases: t('llm.eval.problem.needsCases'),
    tooManyCases: t('llm.eval.problem.tooManyCases'),
    invalidCase: t('llm.eval.problem.invalidCase'),
    caseTooHigh: t('llm.eval.problem.caseTooHigh'),
    invalidNumber: t('llm.problem.invalidNumber'),
    needsModel: t('llm.problem.needsModel'),
    needsRoute: t('llm.eval.problem.needsRoute'),
    internationalPublicOnly: t('llm.problem.internationalPublicOnly'),
    routeAboveBaseline: t('llm.eval.problem.routeAboveBaseline'),
  }[problem];
}
