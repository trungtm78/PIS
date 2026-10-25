import type { useTranslation } from '../../../i18n';
import type { Check, ClosureCheck, Command, CompletionCheck, FormProblem, GateStatus, Problem, ProblemView } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function commandLabel(t: Translate, command: Command): string {
  switch (command) {
    case 'submit':
      return t('ctr.workspace.submit.action');
    case 'return':
      return t('ctr.workspace.return.action');
    case 'sign':
      return t('ctr.workspace.sign.action');
    case 'activate':
      return t('ctr.workspace.activate.action');
    case 'complete':
      return t('ctr.workspace.complete.action');
    case 'close':
      return t('ctr.workspace.close.action');
    case 'cancel':
      return t('ctr.workspace.cancel.action');
  }
}

export function checkLabel(t: Translate, check: Check): string {
  switch (check.key) {
    case 'boq':
      return t('ctr.workspace.check.boq');
    case 'guarantee':
      return t('ctr.workspace.check.guarantee');
    case 'permitGate':
      return t('ctr.workspace.check.permitGate');
    case 'capital':
      return t('ctr.workspace.check.capital');
    case 'project':
      return t('ctr.workspace.check.project');
  }
}

/** The state of a check in words: met, not met, or not asked of this contract. */
export function checkState(t: Translate, check: Check): string {
  if (check.ok === undefined) return t('ctr.workspace.check.notRequired');
  return check.ok ? t('ctr.workspace.check.met') : t('ctr.workspace.check.unmet');
}

export function completionCheckLabel(t: Translate, check: CompletionCheck): string {
  switch (check.key) {
    case 'acceptance':
      return t('ctr.workspace.completion.acceptance');
    case 'ncr':
      return t('ctr.workspace.completion.ncr');
    case 'measurement':
      return t('ctr.workspace.completion.measurement');
  }
}

export function closureCheckLabel(t: Translate, check: ClosureCheck): string {
  switch (check.key) {
    case 'settlement':
      return t('ctr.workspace.closure.settlement');
    case 'advance':
      return t('ctr.workspace.closure.advance');
    case 'retention':
      return t('ctr.workspace.closure.retention');
  }
}

export function gateLabel(t: Translate, status: GateStatus): string {
  switch (status) {
    case 'NOT_REQUIRED':
      return t('ctr.workspace.gate.notRequired');
    case 'PASSED':
      return t('ctr.workspace.gate.passed');
    case 'PASSED_WITH_WAIVER':
      return t('ctr.workspace.gate.waived');
    case 'BLOCKED':
      return t('ctr.workspace.gate.blocked');
  }
}

export function formProblemMessage(t: Translate, problem: FormProblem): string {
  switch (problem) {
    case 'required':
      return t('ctr.workspace.problem.required');
    case 'date':
      return t('ctr.workspace.problem.date');
    case 'future':
      return t('ctr.workspace.problem.future');
    case 'beforeSigning':
      return t('ctr.workspace.problem.beforeSigning');
    case 'uuid':
      return t('ctr.workspace.problem.uuid');
    case 'tooLong':
      return t('ctr.workspace.problem.tooLong');
    case 'evidence':
      return t('ctr.workspace.problem.evidence');
    case 'extension':
      return t('ctr.workspace.problem.extension');
    case 'confirm':
      return t('ctr.workspace.problem.confirm');
  }
}

function baseMessage(t: Translate, problem: Problem): string {
  switch (problem) {
    case 'conflictActor':
      return t('ctr.workspace.error.conflictActor');
    case 'conflictReviewer':
      return t('ctr.workspace.error.conflictReviewer');
    case 'selfApproval':
      return t('ctr.workspace.error.selfApproval');
    case 'delegation':
      return t('ctr.workspace.error.delegation');
    case 'noRule':
      return t('ctr.workspace.error.noRule');
    case 'guaranteeMissing':
      return t('ctr.workspace.error.guaranteeMissing');
    case 'decisionDocument':
      return t('ctr.workspace.error.decisionDocument');
    case 'noGuarantee':
      return t('ctr.workspace.error.noGuarantee');
    case 'gateBlocked':
      return t('ctr.workspace.error.gateBlocked');
    case 'fundFailed':
      return t('ctr.workspace.error.fundFailed');
    case 'projectStage':
      return t('ctr.workspace.error.projectStage');
    case 'boqMismatch':
      return t('ctr.workspace.error.boqMismatch');
    case 'jvShares':
      return t('ctr.workspace.error.jvShares');
    case 'capitalPlan':
      return t('ctr.workspace.error.capitalPlan');
    case 'ceiling':
      return t('ctr.workspace.error.ceiling');
    case 'contractor':
      return t('ctr.workspace.error.contractor');
    case 'documentNotClean':
      return t('ctr.workspace.error.documentNotClean');
    case 'completionAcceptance':
      return t('ctr.workspace.error.completionAcceptance');
    case 'openCriticalNcr':
      return t('ctr.workspace.error.openCriticalNcr');
    case 'measurementPending':
      return t('ctr.workspace.error.measurementPending');
    case 'settlementNotClosed':
      return t('ctr.workspace.error.settlementNotClosed');
    case 'advanceOutstanding':
      return t('ctr.workspace.error.advanceOutstanding');
    case 'retentionUnresolved':
      return t('ctr.workspace.error.retentionUnresolved');
    case 'stateInvalid':
      return t('ctr.workspace.error.stateInvalid');
    case 'versionConflict':
      return t('ctr.workspace.error.versionConflict');
    case 'validation':
      return t('ctr.workspace.error.validation');
    case 'notFound':
      return t('ctr.workspace.error.notFound');
    case 'denied':
      return t('ctr.workspace.error.denied');
    case 'session':
      return t('ctr.workspace.error.session');
    case 'general':
      return t('ctr.workspace.error.general');
  }
}

/** What a refusal of a command says; the permit types that block the gate, or the cause the capital gave, follow it when there are any. */
export function problemMessage(t: Translate, view: ProblemView): string {
  const base = baseMessage(t, view.problem);
  return view.detail.length === 0 ? base : `${base} ${t('ctr.workspace.error.detail', { detail: view.detail.join(', ') })}`;
}
