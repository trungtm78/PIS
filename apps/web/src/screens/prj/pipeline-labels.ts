import type { useTranslation } from '../../i18n';
import type { GuardKey, GuardState, StageFieldProblem, StageOperation, StageProblemReason } from './pipeline-model';

type Translate = ReturnType<typeof useTranslation>['t'];

/** The name of a move, as a verb the confirmation offers. */
export function moveLabel(t: Translate, operation: StageOperation): string {
  switch (operation) {
    case 'startProjectImplementation':
      return t('prj.move.start.label');
    case 'suspendProject':
      return t('prj.move.suspend.label');
    case 'resumeProject':
      return t('prj.move.resume.label');
    case 'completeProject':
      return t('prj.move.complete.label');
    case 'closeProject':
      return t('prj.move.close.label');
    case 'cancelProject':
      return t('prj.move.cancel.label');
  }
}

/** What a guard of a move asks for. */
export function guardLabel(t: Translate, key: GuardKey): string {
  switch (key) {
    case 'DECISION_DOCUMENT':
      return t('prj.guard.decision.label');
    case 'INVESTMENT_DECISION_DOCUMENT':
      return t('prj.guard.investmentDecision.label');
    case 'NATIONAL_CODE':
      return t('prj.guard.nationalCode.label');
    case 'OPEN_OBLIGATIONS':
      return t('prj.guard.openObligations.label');
  }
}

/** The state of a guard in words: a state is never told by colour alone. */
export function guardStateLabel(t: Translate, state: GuardState): string {
  switch (state) {
    case 'MET':
      return t('prj.guard.met.state');
    case 'UNMET':
      return t('prj.guard.unmet.state');
    case 'WARNING':
      return t('prj.guard.warning.state');
    case 'INPUT_REQUIRED':
      return t('prj.guard.input.state');
  }
}

/** The label of the field that takes the document of a guard. */
export function documentFieldLabel(t: Translate, key: GuardKey): string {
  return key === 'INVESTMENT_DECISION_DOCUMENT' ? t('prj.guard.investmentDecision.field') : t('prj.guard.decision.field');
}

export function stageFieldProblemMessage(t: Translate, problem: StageFieldProblem): string {
  switch (problem) {
    case 'reasonRequired':
      return t('prj.board.reasonRequired.error');
    case 'reasonShort':
      return t('prj.board.reasonShort.error');
    case 'reasonLong':
      return t('prj.board.reasonLong.error');
    case 'documentRequired':
      return t('prj.board.documentRequired.error');
    case 'documentInvalid':
      return t('prj.board.documentInvalid.error');
    case 'dateInvalid':
      return t('prj.board.dateInvalid.error');
  }
}

/** The sentence for a refusal of a stage command; a failure the screen has no sentence for is the general one. */
export function stageProblemMessage(t: Translate, reason: StageProblemReason): string {
  switch (reason) {
    case 'transitionDenied':
      return t('prj.stageProblem.transitionDenied.error');
    case 'decisionRequired':
      return t('prj.stageProblem.decisionRequired.error');
    case 'nationalCodeRequired':
      return t('prj.stageProblem.nationalCodeRequired.error');
    case 'nationalCodeFormat':
      return t('prj.stageProblem.nationalCodeFormat.error');
    case 'openObligations':
      return t('prj.stageProblem.openObligations.error');
    case 'versionConflict':
      return t('prj.problem.versionConflict.error');
    case 'validation':
      return t('prj.problem.validation.error');
    case 'notFound':
      return t('prj.problem.notFound.error');
    case 'denied':
      return t('prj.problem.denied.error');
    case 'general':
      return t('prj.problem.general.error');
  }
}
