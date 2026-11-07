import type { Translator } from '../../../i18n';
import type { Tone } from '../../../ui';
import type { Finding, ResolveFailure } from './engine';
import type { DoaStatus, FieldProblem, ProblemView } from './model';

type T = Translator['t'];

// Every key is written out so the i18n check can see it is in use.
export function statusLabel(t: T, status: DoaStatus): string {
  switch (status) {
    case 'Draft':
      return t('adm.doa.status.draft');
    case 'PendingApproval':
      return t('adm.doa.status.pendingApproval');
    case 'Published':
      return t('adm.doa.status.published');
    case 'Superseded':
      return t('adm.doa.status.superseded');
    case 'Rejected':
      return t('adm.doa.status.rejected');
  }
}

export function fieldMessage(t: T, problem: FieldProblem): string {
  switch (problem) {
    case 'required':
      return t('adm.doa.field.required');
    case 'tooShort':
      return t('adm.doa.field.tooShort');
    case 'tooLong':
      return t('adm.doa.field.tooLong');
    case 'order':
      return t('adm.doa.field.order');
    case 'tooMany':
      return t('adm.doa.field.tooMany');
    case 'unit':
      return t('adm.doa.field.unit');
    case 'role':
      return t('adm.doa.field.role');
  }
}

const RULE_FIELD = /^rules\[(\d+)\]/;

/** The row of the form a finding is about, counted from 1, or an empty text for a finding about the version as a whole. */
export function rowOfFinding(finding: Finding): string {
  const match = RULE_FIELD.exec(finding.field);
  return match === null ? '' : String(Number(match[1]) + 1);
}

/** The sentence for a finding (the codes of `draftFindings` and `submitFindings` and of the checks the server adds); an unknown code says only that the matrix is invalid. */
export function findingMessage(t: T, finding: Finding): string {
  const params = { row: rowOfFinding(finding) };
  switch (finding.code) {
    case 'DOCUMENT_TYPE_REQUIRED':
      return t('adm.doa.error.documentTypeRequired', params);
    case 'AMOUNT_INVALID':
      return t('adm.doa.error.amountInvalid', params);
    case 'RANGE_INVALID':
      return t('adm.doa.error.rangeInvalid', params);
    case 'OVERLAP':
      return t('adm.doa.error.overlap', params);
    case 'GAP':
      return t('adm.doa.error.gap', params);
    case 'NOT_FROM_ZERO':
      return t('adm.doa.error.notFromZero', params);
    case 'NOT_TO_INFINITY':
      return t('adm.doa.error.notToInfinity', params);
    case 'NO_RULES':
      return t('adm.doa.error.noRules', params);
    case 'DATE_INVALID':
      return t('adm.doa.error.dateInvalid', params);
    case 'NOT_AFTER_CURRENT':
      return t('adm.doa.error.notAfterCurrent', params);
    case 'UNIT_UNKNOWN':
      return t('adm.doa.error.unitUnknown', params);
    case 'ROLE_UNKNOWN':
      return t('adm.doa.error.roleUnknown', params);
    default:
      return t('adm.doa.problem.matrixInvalid');
  }
}

export function problemMessage(t: T, problem: ProblemView): string {
  switch (problem.reason) {
    case 'matrixInvalid':
      return t('adm.doa.problem.matrixInvalid');
    case 'selfApproval':
      return t('adm.doa.problem.selfApproval');
    case 'conflict':
      return t('adm.doa.problem.conflict');
    case 'notDraft':
      return t('adm.doa.problem.notDraft');
    case 'stateInvalid':
      return t('adm.doa.problem.stateInvalid');
    case 'invalid':
      return t('adm.doa.problem.invalid');
    case 'notFound':
      return t('adm.doa.problem.notFound');
    case 'denied':
      return t('adm.doa.problem.denied');
    case 'session':
      return t('adm.doa.problem.session');
    case 'general':
      return t('adm.doa.problem.general');
  }
}

export function previewFailureMessage(t: T, failure: ResolveFailure): string {
  switch (failure) {
    case 'amount':
      return t('adm.doa.preview.amountInvalid');
    case 'unit':
      return t('adm.doa.preview.unitUnknown');
    case 'notFound':
      return t('adm.doa.preview.notFound');
  }
}

/** The tone of the status pill of a version of the matrix. */
export function statusTone(status: DoaStatus): Tone {
  switch (status) {
    case 'Draft':
      return 'neutral';
    case 'PendingApproval':
      return 'warning';
    case 'Published':
      return 'success';
    case 'Superseded':
      return 'neutral';
    case 'Rejected':
      return 'danger';
  }
}
