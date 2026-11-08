import type { Translator } from '../../../i18n';
import type { FieldProblem, MappingStatus, MethodKind, Problem, ProblemKind, SubjectType } from './mapping-model';
import { findingKey } from './mapping-model';

type T = Translator['t'];

/** Every key is written out in its `t(...)` call so that the i18n check sees it in use. */
export function subjectLabel(t: T, subject: SubjectType): string {
  switch (subject) {
    case 'PROJECT':
      return t('egp.mapping.subject.project');
    case 'PLAN':
      return t('egp.mapping.subject.plan');
    case 'PACKAGE':
      return t('egp.mapping.subject.package');
    case 'NOTICE':
      return t('egp.mapping.subject.notice');
    case 'RESULT':
      return t('egp.mapping.subject.result');
    case 'CONTRACT':
      return t('egp.mapping.subject.contract');
    case 'CONTRACTOR':
      return t('egp.mapping.subject.contractor');
  }
}

export function statusLabel(t: T, status: MappingStatus): string {
  switch (status) {
    case 'PROPOSED':
      return t('egp.mapping.status.proposed');
    case 'ACTIVE':
      return t('egp.mapping.status.active');
    case 'REJECTED':
      return t('egp.mapping.status.rejected');
    case 'RETIRED':
      return t('egp.mapping.status.retired');
  }
}

export function methodLabel(t: T, kind: MethodKind): string {
  switch (kind) {
    case 'IMPORT':
      return t('egp.mapping.method.import');
    case 'RULE':
      return t('egp.mapping.method.rule');
    case 'MANUAL':
      return t('egp.mapping.method.manual');
    case 'SUGGESTION':
      return t('egp.mapping.method.suggestion');
  }
}

export function invalidText(t: T, problem: FieldProblem): string {
  switch (problem) {
    case 'required':
      return t('egp.mapping.invalid.required');
    case 'tooLong':
      return t('egp.mapping.invalid.tooLong');
    case 'control':
      return t('egp.mapping.invalid.control');
    case 'day':
      return t('egp.mapping.invalid.day');
    case 'range':
      return t('egp.mapping.invalid.range');
    case 'confidence':
      return t('egp.mapping.invalid.confidence');
    case 'contractor':
      return t('egp.mapping.invalid.contractor');
  }
}

/** The explanation of a finding of `validateEgpMapping` that the server lists (`egp.mapping.error.<code in camel case>`); an unknown code is said in general words. */
export function findingText(t: T, code: string): string {
  switch (findingKey(code)) {
    case 'subjectTypeInvalid':
      return t('egp.mapping.error.subjectTypeInvalid');
    case 'externalTypeMismatch':
      return t('egp.mapping.error.externalTypeMismatch');
    case 'sourceSystemInvalid':
      return t('egp.mapping.error.sourceSystemInvalid');
    case 'subjectIdInvalid':
      return t('egp.mapping.error.subjectIdInvalid');
    case 'externalCodeInvalid':
      return t('egp.mapping.error.externalCodeInvalid');
    case 'dayInvalid':
      return t('egp.mapping.error.dayInvalid');
    case 'validRangeInvalid':
      return t('egp.mapping.error.validRangeInvalid');
    case 'matchMethodInvalid':
      return t('egp.mapping.error.matchMethodInvalid');
    case 'confidenceInvalid':
      return t('egp.mapping.error.confidenceInvalid');
    case 'confidenceNotAllowed':
      return t('egp.mapping.error.confidenceNotAllowed');
    case 'contractorByTaxCodeOnly':
      return t('egp.mapping.error.contractorByTaxCodeOnly');
    default:
      return t('egp.mapping.problem.validation');
  }
}

function fieldProblemText(t: T, field: NonNullable<Problem['field']>): string {
  switch (field) {
    case 'ourCode':
      return t('egp.mapping.problem.field.ourCode');
    case 'projectCode':
      return t('egp.mapping.problem.field.projectCode');
    case 'externalCode':
      return t('egp.mapping.problem.field.externalCode');
    case 'validFrom':
      return t('egp.mapping.problem.field.validFrom');
    case 'validUntil':
      return t('egp.mapping.problem.field.validUntil');
    case 'confidence':
      return t('egp.mapping.problem.field.confidence');
    case 'method':
      return t('egp.mapping.problem.field.method');
    case 'reason':
      return t('egp.mapping.problem.field.reason');
  }
}

function kindText(t: T, kind: ProblemKind): string {
  switch (kind) {
    case 'externalCodeTaken':
      return t('egp.mapping.problem.taken');
    case 'subjectHasOtherCode':
      return t('egp.mapping.problem.otherCode');
    case 'unchanged':
      return t('egp.mapping.problem.unchanged');
    case 'alreadyProposed':
      return t('egp.mapping.problem.waiting');
    case 'duplicate':
      return t('egp.mapping.problem.duplicate');
    case 'selfApproval':
      return t('egp.mapping.problem.self');
    case 'versionConflict':
      return t('egp.mapping.problem.version');
    case 'stateInvalid':
      return t('egp.mapping.problem.state');
    case 'validation':
      return t('egp.mapping.problem.validation');
    case 'forbidden':
      return t('egp.mapping.problem.forbidden');
    case 'notFound':
      return t('egp.mapping.problem.notFound');
    case 'general':
      return t('egp.mapping.problem.general');
  }
}

/** What a refusal says: the named reason, or for a validation the field it names. */
export function problemText(t: T, problem: Problem): string {
  if (problem.kind === 'validation' && problem.field !== undefined) return fieldProblemText(t, problem.field);
  return kindText(t, problem.kind);
}
