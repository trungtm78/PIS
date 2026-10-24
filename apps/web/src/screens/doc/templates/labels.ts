import type { Translator } from '../../../i18n';
import type { ProblemView } from './problems';
import type { FieldProblem } from './rules';
import type { TemplateGroup, TemplateStatus } from './types';

type T = Translator['t'];

// Every key is written out so the i18n check can see it is in use.
export function groupLabel(t: T, group: TemplateGroup): string {
  switch (group) {
    case 'DECISION':
      return t('doc.templates.group.decision');
    case 'OFFICIAL_LETTER':
      return t('doc.templates.group.officialLetter');
    case 'REPORT_DISBURSEMENT':
      return t('doc.templates.group.reportDisbursement');
    case 'REPORT_MONITORING':
      return t('doc.templates.group.reportMonitoring');
    case 'TREASURY_FORM':
      return t('doc.templates.group.treasuryForm');
    case 'SETTLEMENT_FORM':
      return t('doc.templates.group.settlementForm');
    case 'AUDIT_FOLLOWUP':
      return t('doc.templates.group.auditFollowup');
    case 'OTHER':
      return t('doc.templates.group.other');
  }
}

export function statusLabel(t: T, status: TemplateStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('doc.templates.state.draft');
    case 'IN_REVIEW':
      return t('doc.templates.state.inReview');
    case 'PUBLISHED':
      return t('doc.templates.state.published');
    case 'SUPERSEDED':
      return t('doc.templates.state.superseded');
    case 'RETIRED':
      return t('doc.templates.state.retired');
  }
}

export function fieldProblemMessage(t: T, problem: FieldProblem): string {
  switch (problem) {
    case 'required':
      return t('doc.templates.field.required');
    case 'tooShort':
      return t('doc.templates.field.tooShort');
    case 'tooLong':
      return t('doc.templates.field.tooLong');
    case 'uuid':
      return t('doc.templates.field.uuid');
  }
}

export function problemMessage(t: T, problem: ProblemView): string {
  switch (problem.reason) {
    case 'conflict':
      return t('doc.templates.problem.conflict.text');
    case 'selfApproval':
      return t('doc.templates.problem.selfApproval.text');
    case 'stateInvalid':
      return t('doc.templates.problem.stateInvalid.text');
    case 'rangeOverlap':
      return t('doc.templates.problem.rangeOverlap.text');
    case 'referenceRequired':
      return t('doc.templates.problem.referenceRequired.text');
    case 'invalid':
      return t('doc.templates.problem.invalid.text');
    case 'notFound':
      return t('doc.templates.problem.notFound.text');
    case 'denied':
      return t('doc.templates.problem.denied.text');
    case 'session':
      return t('doc.templates.problem.session.text');
    case 'general':
      return t('doc.templates.problem.general.text');
  }
}
