import type { useTranslation } from '../../../i18n';
import type { FormProblem, InspectionResult, InspectionStatus, InspectionType, Outcome, Problem, SignerRole } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function typeLabel(t: Translate, type: InspectionType): string {
  switch (type) {
    case 'MATERIAL_ENTRY':
      return t('qms.inspection.type.materialEntry');
    case 'CONCEALED_WORK':
      return t('qms.inspection.type.concealedWork');
    case 'CONSTRUCTION_STAGE':
      return t('qms.inspection.type.constructionStage');
    case 'PART_ACCEPTANCE':
      return t('qms.inspection.type.partAcceptance');
    case 'COMPLETION':
      return t('qms.inspection.type.completion');
    case 'SAFETY':
      return t('qms.inspection.type.safety');
    case 'OTHER':
      return t('qms.inspection.type.other');
  }
}

export function statusLabel(t: Translate, status: InspectionStatus): string {
  switch (status) {
    case 'REQUESTED':
      return t('qms.inspection.status.requested');
    case 'SCHEDULED':
      return t('qms.inspection.status.scheduled');
    case 'RESULT_RECORDED':
      return t('qms.inspection.status.resultRecorded');
    case 'CANCELLED':
      return t('qms.inspection.status.cancelled');
  }
}

export function resultLabel(t: Translate, result: InspectionResult): string {
  switch (result) {
    case 'PASS':
      return t('qms.inspection.result.pass');
    case 'FAIL':
      return t('qms.inspection.result.fail');
    case 'CONDITIONAL':
      return t('qms.inspection.result.conditional');
  }
}

export function outcomeLabel(t: Translate, outcome: Outcome): string {
  switch (outcome) {
    case 'PASS':
      return t('qms.inspection.outcome.pass');
    case 'FAIL':
      return t('qms.inspection.outcome.fail');
    case 'NA':
      return t('qms.inspection.outcome.na');
  }
}

export function roleLabel(t: Translate, role: SignerRole): string {
  switch (role) {
    case 'CONTRACTOR':
      return t('qms.inspection.role.contractor');
    case 'SUPERVISOR':
      return t('qms.inspection.role.supervisor');
    case 'OWNER':
      return t('qms.inspection.role.owner');
    case 'DESIGNER':
      return t('qms.inspection.role.designer');
  }
}

export function formProblemMessage(t: Translate, problem: FormProblem): string {
  switch (problem) {
    case 'required':
      return t('qms.inspection.problem.required');
    case 'date':
      return t('qms.inspection.problem.date');
    case 'uuid':
      return t('qms.inspection.problem.uuid');
    case 'tooLong':
      return t('qms.inspection.problem.tooLong');
    case 'past':
      return t('qms.inspection.problem.past');
    case 'noParticipant':
      return t('qms.inspection.problem.noParticipant');
    case 'unanswered':
      return t('qms.inspection.problem.unanswered');
    case 'passWithFailed':
      return t('qms.inspection.problem.passWithFailed');
    case 'noFailed':
      return t('qms.inspection.problem.noFailed');
    case 'conditionUnstated':
      return t('qms.inspection.problem.conditionUnstated');
  }
}

/** What a refusal of a command says. */
export function problemMessage(t: Translate, problem: Problem): string {
  switch (problem) {
    case 'permitGate':
      return t('qms.inspection.error.permitGate');
    case 'contractState':
      return t('qms.inspection.error.contractState');
    case 'duplicate':
      return t('qms.inspection.error.duplicate');
    case 'regime':
      return t('qms.inspection.error.regime');
    case 'inspectionState':
      return t('qms.inspection.error.inspectionState');
    case 'checklistInvalid':
      return t('qms.inspection.error.checklistInvalid');
    case 'checklistMissing':
      return t('qms.inspection.error.checklistMissing');
    case 'checklistContradicts':
      return t('qms.inspection.error.checklistContradicts');
    case 'checklistCondition':
      return t('qms.inspection.error.checklistCondition');
    case 'versionConflict':
      return t('qms.inspection.error.versionConflict');
    case 'validation':
      return t('qms.inspection.error.validation');
    case 'notFound':
      return t('qms.inspection.error.notFound');
    case 'denied':
      return t('qms.inspection.error.denied');
    case 'session':
      return t('qms.inspection.error.session');
    case 'general':
      return t('qms.inspection.error.general');
  }
}
