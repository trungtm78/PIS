import type { useTranslation } from '../../../i18n';
import type { ImportProblem, ImportRow } from './import-model';
import type { DiffStatus, FieldProblem, MilestoneKind, MilestoneSource, Problem, ProblemView } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function milestoneLabel(t: Translate, kind: MilestoneKind): string {
  switch (kind) {
    case 'INVITATION_PUBLISHED':
      return t('bid.milestone.invitation.label');
    case 'CLARIFICATION_DEADLINE':
      return t('bid.milestone.clarification.label');
    case 'BID_CLOSING':
      return t('bid.milestone.closing.label');
    case 'BID_OPENING':
      return t('bid.milestone.opening.label');
    case 'EVALUATION_DONE':
      return t('bid.milestone.evaluation.label');
    case 'RESULT_APPROVED':
      return t('bid.milestone.approved.label');
    case 'RESULT_PUBLISHED':
      return t('bid.milestone.published.label');
    case 'CONTRACT_SIGNED':
      return t('bid.milestone.contract.label');
  }
}

export function sourceLabel(t: Translate, source: MilestoneSource): string {
  return source === 'IMPORT' ? t('bid.milestone.source.import') : t('bid.milestone.source.manual');
}

export function diffStatusLabel(t: Translate, status: DiffStatus): string {
  switch (status) {
    case 'IN_SYNC':
      return t('bid.link.status.inSync');
    case 'DIFFERENT':
      return t('bid.link.status.different');
    case 'MISSING_EXTERNAL':
      return t('bid.link.status.missing');
  }
}

export function fieldProblemMessage(t: Translate, problem: FieldProblem): string {
  switch (problem) {
    case 'required':
      return t('bid.milestone.field.required');
    case 'date':
      return t('bid.milestone.field.date');
    case 'future':
      return t('bid.milestone.field.future');
    case 'noDate':
      return t('bid.milestone.field.noDate');
  }
}

export function problemMessage(t: Translate, view: ProblemView): string {
  const problem: Problem = view.problem;
  switch (problem) {
    case 'orderInvalid':
      return view.earlier !== undefined && view.later !== undefined
        ? t('bid.milestone.problem.order', { earlier: milestoneLabel(t, view.earlier), later: milestoneLabel(t, view.later) })
        : t('bid.milestone.problem.orderPlain');
    case 'versionConflict':
      return t('bid.milestone.problem.conflict');
    case 'packageState':
      return t('bid.milestone.problem.state');
    case 'validation':
      return t('bid.milestone.problem.validation');
    case 'notFound':
      return t('bid.milestone.problem.notFound');
    case 'denied':
      return t('bid.milestone.problem.denied');
    case 'session':
      return t('bid.milestone.problem.session');
    case 'general':
      return t('bid.milestone.problem.general');
  }
}

export function importProblemMessage(t: Translate, problem: ImportProblem): string {
  switch (problem) {
    case 'alreadyApplied':
      return t('bid.import.problem.alreadyApplied');
    case 'hasErrors':
      return t('bid.import.problem.hasErrors');
    case 'hashMismatch':
      return t('bid.import.problem.hashMismatch');
    case 'schemaInvalid':
      return t('bid.import.problem.schemaInvalid');
    case 'empty':
      return t('bid.import.problem.empty');
    case 'fileRefused':
      return t('bid.import.problem.fileRefused');
    case 'notFound':
      return t('bid.import.problem.notFound');
    case 'denied':
      return t('bid.import.problem.denied');
    case 'general':
      return t('bid.import.problem.general');
  }
}

/** What a row of the file said or would do, in words: the reason it was refused, or what the apply does with it. */
export function importRowMessage(t: Translate, row: ImportRow): string {
  if (row.code !== null) {
    switch (row.code) {
      case 'PACKAGE_NOT_FOUND':
        return t('bid.import.row.notFound');
      case 'PACKAGE_STATE_INVALID':
        return t('bid.import.row.state');
      case 'PACKAGE_AMBIGUOUS':
        return t('bid.import.row.ambiguous');
      case 'EXTERNAL_CODE_TAKEN':
      case 'EXTERNAL_CODE_CONFLICT':
        return t('bid.import.row.codeTaken');
      case 'MILESTONE_KIND_INVALID':
        return t('bid.import.row.kind');
      case 'ACTUAL_AT_INVALID':
        return t('bid.import.row.date');
      case 'ACTUAL_AT_IN_FUTURE':
        return t('bid.import.row.future');
      case 'MILESTONE_ORDER_INVALID':
        return t('bid.import.row.order');
      case 'ROW_DUPLICATE':
        return t('bid.import.row.duplicate');
      case 'PACKAGE_CODE_EMPTY':
      case 'EXTERNAL_CODE_EMPTY':
        return t('bid.import.row.empty');
      case 'CODE_INVALID':
        return t('bid.import.row.invalid');
      default:
        return t('bid.import.row.other', { code: row.code });
    }
  }
  switch (row.outcome) {
    case 'CREATE':
      return t('bid.import.row.create');
    case 'FILL':
      return t('bid.import.row.fill');
    case 'UNCHANGED':
      return t('bid.import.row.unchanged');
    case 'MILESTONE_MISMATCH':
      return t('bid.import.row.milestoneMismatch');
    case 'CODE_MISMATCH':
      return t('bid.import.row.codeMismatch');
    default:
      return row.status === 'DUPLICATE' ? t('bid.import.row.repeat') : row.status === 'CONFLICT' ? t('bid.import.row.conflict') : t('bid.import.row.valid');
  }
}
