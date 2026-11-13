import type { Translator } from '../../../i18n';
import type { FormProblem } from '../model';
import type { Adjustment, FlagCode, LineState, PeriodStatus, ScoreProblem, ScoreResponse } from './model';

type T = Translator['t'];

// Each key is written out in a switch so that the i18n check can see it is in use.

export function lineStateWord(t: T, state: LineState): string {
  switch (state) {
    case 'RATED':
      return t('pwfs.state.rated.word');
    case 'SMALL_SAMPLE':
      return t('pwfs.state.smallSample.word');
    case 'NOT_RATED':
      return t('pwfs.state.notRated.word');
  }
}

/** Why a person has no rating: said in words wherever the rating would have been, never an empty cell. */
export function lineStateHint(t: T, state: LineState): string | undefined {
  switch (state) {
    case 'RATED':
      return undefined;
    case 'SMALL_SAMPLE':
      return t('pwfs.state.smallSample.hint');
    case 'NOT_RATED':
      return t('pwfs.state.notRated.hint');
  }
}

export function periodStatusWord(t: T, status: PeriodStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('pwfs.status.draft.word');
    case 'LOCKED':
      return t('pwfs.status.locked.word');
    case 'OFFICIAL':
      return t('pwfs.status.official.word');
  }
}

export function periodStatusHint(t: T, status: PeriodStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('pwfs.status.draft.hint');
    case 'LOCKED':
      return t('pwfs.status.locked.hint');
    case 'OFFICIAL':
      return t('pwfs.status.official.hint');
  }
}

export function flagWord(t: T, code: FlagCode): string {
  switch (code) {
    case 'CANCELLED_SHARE_HIGH':
      return t('pwfs.flag.cancelledShare.word');
    case 'TASKS_SPLIT_AFTER_BASELINE':
      return t('pwfs.flag.tasksSplit.word');
    case 'BASELINE_REVISED_IN_PERIOD':
      return t('pwfs.flag.baselineRevised.word');
    case 'ASSIGNEE_CHANGED_NEAR_DUE':
      return t('pwfs.flag.assigneeChanged.word');
  }
}

export function flagHint(t: T, code: FlagCode): string {
  switch (code) {
    case 'CANCELLED_SHARE_HIGH':
      return t('pwfs.flag.cancelledShare.hint');
    case 'TASKS_SPLIT_AFTER_BASELINE':
      return t('pwfs.flag.tasksSplit.hint');
    case 'BASELINE_REVISED_IN_PERIOD':
      return t('pwfs.flag.baselineRevised.hint');
    case 'ASSIGNEE_CHANGED_NEAR_DUE':
      return t('pwfs.flag.assigneeChanged.hint');
  }
}

/** The reason a task was left out of a score; a reason the screens have no word for is said with its code so that nothing is hidden. */
export function excludedReasonWord(t: T, reason: string): string {
  switch (reason) {
    case 'NO_SHARE':
      return t('pwfs.excluded.noShare.word');
    case 'NO_SCORE':
      return t('pwfs.excluded.noScore.word');
    case 'CANCELLED_IGNORED':
      return t('pwfs.excluded.cancelledIgnored.word');
    case 'CANCELLED_APPROVED':
      return t('pwfs.excluded.cancelledApproved.word');
    case 'EXCLUDED':
      return t('pwfs.excluded.excluded.word');
    case 'NOT_STARTED':
      return t('pwfs.excluded.notStarted.word');
    default:
      return t('pwfs.excluded.other.word', { reason });
  }
}

export function adjustmentStatusWord(t: T, status: Adjustment['status']): string {
  switch (status) {
    case 'REQUESTED':
      return t('pwfs.adjustment.requested.word');
    case 'APPROVED':
      return t('pwfs.adjustment.approved.word');
    case 'REJECTED':
      return t('pwfs.adjustment.rejected.word');
  }
}

export function responseStatusWord(t: T, status: ScoreResponse['status']): string {
  return status === 'OPEN' ? t('pwfs.response.open.word') : t('pwfs.response.handled.word');
}

export function scoreProblemText(t: T, problem: ScoreProblem): string {
  switch (problem.kind) {
    case 'versionConflict':
      return t('pwfs.problem.versionConflict.error');
    case 'selfApproval':
      return t('pwfs.problem.selfApproval.error');
    case 'periodOverlap':
      return t('pwfs.problem.periodOverlap.error');
    case 'shareInvalid':
      return t('pwfs.problem.shareInvalid.error');
    case 'calendarNotEffective':
      return t('pwfs.problem.calendarNotEffective.error');
    case 'periodLocked':
      return t('pwfs.problem.periodLocked.error');
    case 'adjustmentInvalid':
      return problem.field === undefined ? t('pwfs.problem.adjustmentInvalid.error') : t('pwfs.problem.adjustmentField.error', { field: problem.field });
    case 'windowClosed':
      return t('pwfs.problem.windowClosed.error');
    case 'inWorkflow':
      return t('pwfs.problem.inWorkflow.error');
    case 'validation':
      return problem.field === undefined ? t('pwfs.problem.validation.error') : t('pwfs.problem.validationField.error', { field: problem.field });
    case 'notFound':
      return t('pwfs.problem.notFound.error');
    case 'denied':
      return t('pwfs.problem.denied.error');
    case 'general':
      return t('pwfs.problem.general.error');
  }
}

/** A form problem in words; the limits are those of the field being said. */
export function scoreFormProblem(t: T, problem: FormProblem, limits: { min?: number; max?: number } = {}): string {
  switch (problem) {
    case 'required':
      return t('pwfs.form.required.error');
    case 'tooShort':
      return t('pwfs.form.tooShort.error', { min: limits.min ?? 0 });
    case 'tooLong':
      return t('pwfs.form.tooLong.error', { max: limits.max ?? 0 });
    case 'invalidDay':
      return t('pwfs.form.invalidDay.error');
    case 'invalidNumber':
      return t('pwfs.form.invalidNumber.error', { max: limits.max ?? 0 });
    case 'pickOne':
      return t('pwfs.form.pickOne.error');
  }
}

export function operationWord(t: T, code: string): string {
  switch (code) {
    case 'DAYS_DEVIATION':
      return t('pwfs.operation.daysDeviation.word');
    case 'ON_TIME_RATE':
      return t('pwfs.operation.onTimeRate.word');
    case 'AMOUNT_VARIANCE_PCT':
      return t('pwfs.operation.amountVariance.word');
    case 'RETURN_COUNT':
      return t('pwfs.operation.returnCount.word');
    case 'EVIDENCE_COMPLETENESS':
      return t('pwfs.operation.evidence.word');
    case 'RESCHEDULE_COUNT':
      return t('pwfs.operation.reschedule.word');
    default:
      return code;
  }
}

export function unitOfValueWord(t: T, unit: string): string {
  switch (unit) {
    case 'PERCENT':
      return t('pwfs.valueUnit.percent.word');
    case 'VND':
      return t('pwfs.valueUnit.vnd.word');
    case 'COUNT':
      return t('pwfs.valueUnit.count.word');
    case 'DAYS':
      return t('pwfs.valueUnit.days.word');
    case 'RATIO':
      return t('pwfs.valueUnit.ratio.word');
    default:
      return unit;
  }
}

export function directionWord(t: T, direction: string): string {
  return direction === 'LOWER_IS_BETTER' ? t('pwfs.direction.lower.word') : t('pwfs.direction.higher.word');
}
