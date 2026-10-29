import type { useTranslation } from '../../../i18n';
import type { Problem, StepDifference, StepProblem, VersionStatus } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

/** The words for a defect code of the server (BR-ADM-05); a code this screen does not know is said as the code itself, with the path beside it. */
export function defectLabel(t: Translate, code: string): string {
  switch (code) {
    case 'NOT_AN_OBJECT':
      return t('adm.workflow.defect.notObject');
    case 'UNKNOWN_FIELD':
      return t('adm.workflow.defect.unknownField');
    case 'BUSINESS_TYPE_UNKNOWN':
      return t('adm.workflow.defect.businessType');
    case 'STEPS_REQUIRED':
      return t('adm.workflow.defect.stepsRequired');
    case 'TOO_MANY_STEPS':
      return t('adm.workflow.defect.tooManySteps');
    case 'STEP_ID_INVALID':
      return t('adm.workflow.defect.stepIdInvalid');
    case 'STEP_ID_DUPLICATE':
      return t('adm.workflow.defect.stepIdDuplicate');
    case 'STEP_NAME_INVALID':
      return t('adm.workflow.defect.stepName');
    case 'ASSIGNEE_RULE_REQUIRED':
      return t('adm.workflow.defect.ruleRequired');
    case 'ASSIGNEE_TYPE_INVALID':
      return t('adm.workflow.defect.ruleType');
    case 'ROLE_CODE_REQUIRED':
      return t('adm.workflow.defect.roleCode');
    case 'UNIT_REQUIRED':
      return t('adm.workflow.defect.unit');
    case 'MEMBERS_REQUIRED':
      return t('adm.workflow.defect.members');
    case 'MEMBERS_DUPLICATE':
      return t('adm.workflow.defect.membersDuplicate');
    case 'DOA_TAKES_NO_OPERANDS':
      return t('adm.workflow.defect.doaOperands');
    case 'UNEXPECTED_OPERAND':
      return t('adm.workflow.defect.unexpected');
    case 'MIN_APPROVALS_INVALID':
      return t('adm.workflow.defect.minApprovals');
    case 'MIN_APPROVALS_EXCEEDS_APPROVERS':
      return t('adm.workflow.defect.minExceeds');
    case 'SLA_INVALID':
      return t('adm.workflow.defect.sla');
    case 'ON_TIMEOUT_INVALID':
      return t('adm.workflow.defect.onTimeout');
    case 'ESCALATE_TO_REQUIRED':
      return t('adm.workflow.defect.escalateTo');
    case 'RETURN_TARGET_INVALID':
      return t('adm.workflow.defect.returnTarget');
    case 'TERMINAL_REQUIRED':
      return t('adm.workflow.defect.terminal');
    case 'COMMAND_REQUIRED':
      return t('adm.workflow.defect.commandRequired');
    case 'COMMAND_NOT_REGISTERED':
      return t('adm.workflow.defect.commandNotRegistered');
    default:
      return code;
  }
}

export function statusLabel(t: Translate, status: VersionStatus): string {
  switch (status) {
    case 'Draft':
      return t('adm.workflow.status.draft');
    case 'Published':
      return t('adm.workflow.status.published');
    case 'Superseded':
      return t('adm.workflow.status.superseded');
    case 'Retired':
      return t('adm.workflow.status.retired');
  }
}

export function statusTone(status: VersionStatus): 'green' | 'gray' | 'warn' {
  return status === 'Published' ? 'green' : status === 'Draft' ? 'warn' : 'gray';
}

export function businessTypeLabel(t: Translate, code: string): string {
  switch (code) {
    case 'report.accept':
      return t('adm.workflow.type.reportAccept');
    case 'plan.publish':
      return t('adm.workflow.type.planPublish');
    case 'payment.approve':
      return t('adm.workflow.type.paymentApprove');
    case 'contract.change':
      return t('adm.workflow.type.contractChange');
    case 'period.reopen':
      return t('adm.workflow.type.periodReopen');
    default:
      return code;
  }
}

export function ruleTypeLabel(t: Translate, type: string): string {
  switch (type) {
    case 'DOA':
      return t('adm.workflow.rule.doa');
    case 'ROLE_IN_UNIT':
      return t('adm.workflow.rule.role');
    case 'SPECIFIC':
      return t('adm.workflow.rule.specific');
    default:
      return type;
  }
}

export function timeoutLabel(t: Translate, timeout: string): string {
  switch (timeout) {
    case 'REMIND':
      return t('adm.workflow.timeout.remind');
    case 'ESCALATE':
      return t('adm.workflow.timeout.escalate');
    case 'EXPIRE':
      return t('adm.workflow.timeout.expire');
    default:
      return timeout;
  }
}

export function fieldLabel(t: Translate, field: string): string {
  switch (field) {
    case 'name':
      return t('adm.workflow.field.name');
    case 'assignee':
      return t('adm.workflow.field.assignee');
    case 'minApprovals':
      return t('adm.workflow.field.minApprovals');
    case 'slaHours':
      return t('adm.workflow.field.sla');
    case 'onTimeout':
      return t('adm.workflow.field.onTimeout');
    case 'allowReturnTo':
      return t('adm.workflow.field.returnTo');
    default:
      return field;
  }
}

export function stepProblemMessage(t: Translate, problem: StepProblem): string {
  switch (problem) {
    case 'idInvalid':
      return t('adm.workflow.problem.idInvalid');
    case 'idDuplicate':
      return t('adm.workflow.problem.idDuplicate');
    case 'nameRequired':
      return t('adm.workflow.problem.nameRequired');
    case 'numberInvalid':
      return t('adm.workflow.problem.numberInvalid');
  }
}

export function diffLabel(t: Translate, difference: StepDifference): string {
  switch (difference.kind) {
    case 'ADDED':
      return t('adm.workflow.diff.added', { id: difference.id });
    case 'REMOVED':
      return t('adm.workflow.diff.removed', { id: difference.id });
    case 'MOVED':
      return t('adm.workflow.diff.moved', { id: difference.id });
    case 'CHANGED':
      return t('adm.workflow.diff.changed', { id: difference.id, fields: difference.fields.map((field) => fieldLabel(t, field)).join(', ') });
  }
}

export function problemMessage(t: Translate, problem: Problem): string {
  switch (problem) {
    case 'invalidDefinition':
      return t('adm.workflow.error.invalid');
    case 'versionConflict':
      return t('adm.workflow.error.versionConflict');
    case 'notDraft':
      return t('adm.workflow.error.notDraft');
    case 'selfPublish':
      return t('adm.workflow.error.selfPublish');
    case 'denied':
      return t('adm.workflow.error.denied');
    case 'notFound':
      return t('adm.workflow.error.notFound');
    case 'validation':
      return t('adm.workflow.error.validation');
    case 'general':
      return t('adm.workflow.error.general');
  }
}
