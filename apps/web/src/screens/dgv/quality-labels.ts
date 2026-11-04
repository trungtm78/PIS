import type { useTranslation } from '../../i18n';
import { durationOf } from './quality-model';
import type { ActionOnFail, Comparator, Dimension, Operator, Overall, QualityProblem, RuleProblem, RuleResult, RuleStatus, RunProblem, RunStatus, Severity, Trigger } from './quality-model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function dimensionLabel(t: Translate, dimension: Dimension): string {
  switch (dimension) {
    case 'COMPLETENESS':
      return t('dgv.quality.dimension.completeness.text');
    case 'UNIQUENESS':
      return t('dgv.quality.dimension.uniqueness.text');
    case 'VALIDITY':
      return t('dgv.quality.dimension.validity.text');
    case 'CONSISTENCY':
      return t('dgv.quality.dimension.consistency.text');
    case 'TIMELINESS':
      return t('dgv.quality.dimension.timeliness.text');
    case 'ACCURACY':
      return t('dgv.quality.dimension.accuracy.text');
    case 'INTEGRITY':
      return t('dgv.quality.dimension.integrity.text');
  }
}

export function resultLabel(t: Translate, result: RuleResult): string {
  switch (result) {
    case 'PASS':
      return t('dgv.quality.result.pass.text');
    case 'WARN':
      return t('dgv.quality.result.warn.text');
    case 'FAIL':
      return t('dgv.quality.result.fail.text');
    case 'ERROR':
      return t('dgv.quality.result.error.text');
  }
}

/** The colour of a rule result; a rule that could not be measured is neither green nor red. */
export function resultTone(result: RuleResult): 'green' | 'warn' | 'red' | 'gray' {
  switch (result) {
    case 'PASS':
      return 'green';
    case 'WARN':
      return 'warn';
    case 'FAIL':
      return 'red';
    case 'ERROR':
      return 'gray';
  }
}

export function overallLabel(t: Translate, overall: Overall): string {
  switch (overall) {
    case 'PASSED':
      return t('dgv.badge.passed.text');
    case 'WARNING':
      return t('dgv.badge.warning.text');
    case 'FAILED':
      return t('dgv.badge.failed.text');
  }
}

export function actionLabel(t: Translate, action: ActionOnFail): string {
  switch (action) {
    case 'QUARANTINE':
      return t('dgv.quality.action.quarantine.text');
    case 'HARD_BLOCK':
      return t('dgv.quality.action.hardBlock.text');
    case 'WARN':
      return t('dgv.quality.action.warn.text');
  }
}

export function severityLabel(t: Translate, severity: Severity): string {
  switch (severity) {
    case 'LOW':
      return t('dgv.quality.severity.low.text');
    case 'MEDIUM':
      return t('dgv.quality.severity.medium.text');
    case 'HIGH':
      return t('dgv.quality.severity.high.text');
    case 'CRITICAL':
      return t('dgv.quality.severity.critical.text');
  }
}

export function ruleStatusLabel(t: Translate, status: RuleStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('dgv.quality.ruleStatus.draft.text');
    case 'APPROVED':
      return t('dgv.quality.ruleStatus.approved.text');
    case 'SUPERSEDED':
      return t('dgv.quality.ruleStatus.superseded.text');
  }
}

export function runStatusLabel(t: Translate, status: RunStatus): string {
  switch (status) {
    case 'RUNNING':
      return t('dgv.quality.runStatus.running.text');
    case 'COMPLETED':
      return t('dgv.quality.runStatus.completed.text');
    case 'FAILED':
      return t('dgv.quality.runStatus.failed.text');
  }
}

export function triggerLabel(t: Translate, trigger: Trigger): string {
  switch (trigger) {
    case 'SNAPSHOT_FROZEN':
      return t('dgv.quality.trigger.snapshotFrozen.text');
    case 'IMPORT_BATCH':
      return t('dgv.quality.trigger.importBatch.text');
    case 'SCHEDULE':
      return t('dgv.quality.trigger.schedule.text');
    case 'MANUAL':
      return t('dgv.quality.trigger.manual.text');
  }
}

export function operatorLabel(t: Translate, operator: Operator): string {
  switch (operator) {
    case 'not_null':
      return t('dgv.quality.operator.notNull.text');
    case 'not_blank':
      return t('dgv.quality.operator.notBlank.text');
    case 'is_null':
      return t('dgv.quality.operator.isNull.text');
    case 'compare':
      return t('dgv.quality.operator.compare.text');
    case 'between':
      return t('dgv.quality.operator.between.text');
    case 'in':
      return t('dgv.quality.operator.in.text');
    case 'compare_fields':
      return t('dgv.quality.operator.compareFields.text');
    case 'unique':
      return t('dgv.quality.operator.unique.text');
    case 'reference_exists':
      return t('dgv.quality.operator.referenceExists.text');
    case 'snapshot_age_within':
      return t('dgv.quality.operator.snapshotAge.text');
  }
}

export function comparatorLabel(t: Translate, comparator: Comparator): string {
  switch (comparator) {
    case 'eq':
      return t('dgv.quality.comparator.eq.text');
    case 'ne':
      return t('dgv.quality.comparator.ne.text');
    case 'gt':
      return t('dgv.quality.comparator.gt.text');
    case 'gte':
      return t('dgv.quality.comparator.gte.text');
    case 'lt':
      return t('dgv.quality.comparator.lt.text');
    case 'lte':
      return t('dgv.quality.comparator.lte.text');
  }
}

/** Why a run could not be measured. */
export function failureLabel(t: Translate, code: string | null): string {
  switch (code) {
    case 'SNAPSHOT_CHANGED':
      return t('dgv.quality.failure.snapshotChanged.text');
    case 'SNAPSHOT_INCOMPLETE':
      return t('dgv.quality.failure.snapshotIncomplete.text');
    case 'SOURCE_NOT_SUPPORTED':
      return t('dgv.quality.failure.sourceNotSupported.text');
    case 'NO_RULE_MEASURED':
      return t('dgv.quality.failure.noRuleMeasured.text');
    case 'EXECUTION_FAILED':
      return t('dgv.quality.failure.executionFailed.text');
    default:
      return t('dgv.quality.failure.unknown.text');
  }
}

/** Why a rule could not be measured. */
export function ruleErrorLabel(t: Translate, code: string | null): string {
  switch (code) {
    case 'NO_ROWS_EVALUATED':
      return t('dgv.quality.ruleError.noRows.text');
    case 'EVALUATION_FAILED':
      return t('dgv.quality.ruleError.evaluationFailed.text');
    default:
      return t('dgv.quality.ruleError.unknown.text');
  }
}

/** A length of time in words ("2 days"), cut down to the unit it fills. */
export function durationLabel(t: Translate, seconds: number): string {
  const { unit, count } = durationOf(seconds);
  switch (unit) {
    case 'days':
      return t('dgv.freshness.days.text', { count });
    case 'hours':
      return t('dgv.freshness.hours.text', { count });
    case 'minutes':
      return t('dgv.freshness.minutes.text', { count });
    case 'seconds':
      return t('dgv.freshness.seconds.text', { count });
  }
}

export function ruleProblemMessage(t: Translate, problem: RuleProblem): string {
  switch (problem) {
    case 'required':
      return t('dgv.field.required.error');
    case 'tooShort':
      return t('dgv.field.tooShort.error');
    case 'tooLong':
      return t('dgv.field.tooLong.error');
    case 'invalidNumber':
      return t('dgv.field.invalidNumber.error');
    case 'invalidRate':
      return t('dgv.quality.field.invalidRate.error');
    case 'invalidList':
      return t('dgv.quality.field.invalidList.error');
    case 'warnNotBelowMin':
      return t('dgv.quality.field.warnNotBelowMin.error');
  }
}

export function runProblemMessage(t: Translate, problem: RunProblem): string {
  return problem === 'required' ? t('dgv.field.required.error') : t('dgv.quality.field.invalidId.error');
}

/** The sentence for a refusal of a command of the quality screens; a problem without a sentence of its own is the general one. */
export function qualityProblemMessage(t: Translate, problem: QualityProblem): string {
  switch (problem.reason) {
    case 'expressionNotAllowed':
      return t('dgv.quality.problem.expressionNotAllowed.error');
    case 'thresholdInvalid':
      return t('dgv.quality.problem.thresholdInvalid.error');
    case 'selfApproval':
      return t('dgv.quality.problem.selfApproval.error');
    case 'snapshotNotFound':
      return t('dgv.quality.problem.snapshotNotFound.error');
    case 'snapshotNotFrozen':
      return t('dgv.quality.problem.snapshotNotFrozen.error');
    case 'alreadyRunning':
      return t('dgv.quality.problem.alreadyRunning.error');
    case 'versionConflict':
      return t('dgv.quality.problem.versionConflict.error');
    case 'notDraft':
      return t('dgv.quality.problem.notDraft.error');
    case 'validation':
      return problem.field === undefined ? t('dgv.problem.validation.error') : t('dgv.problem.validationField.error', { field: problem.field });
    case 'notFound':
      return t('dgv.problem.notFound.error');
    case 'denied':
      return t('dgv.problem.denied.error');
    case 'general':
      return t('dgv.problem.general.error');
  }
}
