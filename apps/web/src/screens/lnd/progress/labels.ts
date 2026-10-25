import type { useTranslation } from '../../../i18n';
import type { ExecutorKind, FieldProblem, Problem, StageCode, StageMode, StageStatus } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function stageLabel(t: Translate, code: StageCode): string {
  switch (code) {
    case 'SURVEY':
      return t('lnd.stage.survey.label');
    case 'NOTICE':
      return t('lnd.stage.notice.label');
    case 'INVENTORY':
      return t('lnd.stage.inventory.label');
    case 'PLAN_DRAFT':
      return t('lnd.stage.planDraft.label');
    case 'PLAN_POSTING':
      return t('lnd.stage.planPosting.label');
    case 'PLAN_APPROVAL':
      return t('lnd.stage.planApproval.label');
    case 'PAYMENT':
      return t('lnd.stage.payment.label');
    case 'HANDOVER':
      return t('lnd.stage.handover.label');
    case 'ENFORCEMENT':
      return t('lnd.stage.enforcement.label');
  }
}

export function executorKindLabel(t: Translate, kind: ExecutorKind): string {
  switch (kind) {
    case 'PROJECT_OWNER':
      return t('lnd.executor.projectOwner.label');
    case 'LAND_FUND_CENTRE':
      return t('lnd.executor.landFundCentre.label');
    case 'DISTRICT_BOARD':
      return t('lnd.executor.districtBoard.label');
  }
}

export function modeLabel(t: Translate, mode: StageMode): string {
  return mode === 'NATIVE' ? t('lnd.mode.native.label') : t('lnd.mode.trackedExternal.label');
}

export function stageStatusLabel(t: Translate, status: StageStatus): string {
  switch (status) {
    case 'NOT_STARTED':
      return t('lnd.stageStatus.notStarted.label');
    case 'IN_PROGRESS':
      return t('lnd.stageStatus.inProgress.label');
    case 'DONE':
      return t('lnd.stageStatus.done.label');
    case 'BLOCKED':
      return t('lnd.stageStatus.blocked.label');
    case 'LATE':
      return t('lnd.stageStatus.late.label');
  }
}

export function fieldProblemMessage(t: Translate, problem: FieldProblem): string {
  switch (problem) {
    case 'required':
      return t('lnd.progress.field.required');
    case 'count':
      return t('lnd.progress.field.count');
    case 'exceeds':
      return t('lnd.progress.field.exceeds');
    case 'date':
      return t('lnd.progress.field.date');
    case 'order':
      return t('lnd.progress.field.order');
    case 'future':
      return t('lnd.progress.field.future');
    case 'endNeedsAll':
      return t('lnd.progress.field.endNeedsAll');
    case 'evidenceRequired':
      return t('lnd.progress.field.evidenceRequired');
    case 'evidenceInvalid':
      return t('lnd.progress.field.evidenceInvalid');
    case 'tooLong':
      return t('lnd.progress.field.tooLong');
  }
}

export function problemMessage(t: Translate, problem: Problem): string {
  switch (problem) {
    case 'exceeds':
      return t('lnd.progress.problem.exceeds');
    case 'nativeReadonly':
      return t('lnd.progress.problem.native');
    case 'documentNotClean':
      return t('lnd.progress.problem.document');
    case 'validation':
      return t('lnd.progress.problem.validation');
    case 'denied':
      return t('lnd.progress.problem.denied');
    case 'notFound':
      return t('lnd.progress.problem.notFound');
    case 'session':
      return t('lnd.progress.problem.session');
    case 'general':
      return t('lnd.progress.problem.general');
  }
}
