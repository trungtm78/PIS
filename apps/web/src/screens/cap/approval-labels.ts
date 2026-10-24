import type { useTranslation } from '../../i18n';
import { vndText } from './model';
import type { ApprovalProblemView, BelowCommittedLine, ImpactRow, PublishProblem, ReasonProblem } from './approval-model';
import type { PlanStatus } from './plan-model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function reasonProblemMessage(t: Translate, problem: ReasonProblem): string {
  switch (problem) {
    case 'required':
      return t('cap.approval.reason.required.error');
    case 'tooShort':
      return t('cap.approval.reason.tooShort.error');
    case 'tooLong':
      return t('cap.approval.reason.tooLong.error');
  }
}

export function publishProblemMessage(t: Translate, problem: PublishProblem): string {
  switch (problem) {
    case 'required':
      return t('cap.approval.document.required.error');
    case 'invalidId':
      return t('cap.approval.document.invalid.error');
    case 'invalidDate':
      return t('cap.approval.effective.invalid.error');
  }
}

export function impactKindLabel(t: Translate, kind: ImpactRow['kind']): string {
  switch (kind) {
    case 'NEW':
      return t('cap.approval.kind.new.label');
    case 'CHANGED':
      return t('cap.approval.kind.changed.label');
    case 'SAME':
      return t('cap.approval.kind.same.label');
    case 'DROPPED':
      return t('cap.approval.kind.dropped.label');
  }
}

/** The sentence that confirms the decision that was just taken. */
export function decisionDoneNotice(t: Translate, decision: 'approve' | 'reject' | 'return'): string {
  switch (decision) {
    case 'approve':
      return t('cap.approval.done.approve.notice');
    case 'reject':
      return t('cap.approval.done.reject.notice');
    case 'return':
      return t('cap.approval.done.return.notice');
  }
}

/** The sentence that says where a revision stands and what comes next. */
export function stateNotice(t: Translate, status: PlanStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('cap.approval.state.draft.notice');
    case 'IN_REVIEW':
      return t('cap.approval.state.inReview.notice');
    case 'APPROVED':
      return t('cap.approval.state.approved.notice');
    case 'PUBLISHED':
      return t('cap.approval.state.published.notice');
    case 'SUPERSEDED':
      return t('cap.approval.state.superseded.notice');
    case 'REJECTED':
      return t('cap.approval.state.rejected.notice');
  }
}

/** The line a refusal of the publication names: the project when the plan shows it, else the line. */
export function belowCommittedText(t: Translate, line: BelowCommittedLine, projectOf: (lineId: string) => string | undefined, locale: string): string {
  return t('cap.approvalProblem.belowCommitted.line', {
    project: projectOf(line.lineId) ?? line.lineId,
    allocated: vndText(line.allocatedVnd, locale),
    minimum: vndText(line.minimumVnd, locale),
    committed: vndText(line.committedVnd, locale),
    disbursed: vndText(line.disbursedVnd, locale),
  });
}

/** The sentence for a refusal of a command of the approval; a refusal the screen has no sentence for is the general one. */
export function approvalProblemMessage(t: Translate, problem: ApprovalProblemView): string {
  switch (problem.reason) {
    case 'selfApproval':
      return t('cap.approvalProblem.selfApproval.error');
    case 'decisionRequired':
      return t('cap.approvalProblem.decisionRequired.error');
    case 'notApproved':
      return t('cap.approvalProblem.notApproved.error');
    case 'notDraft':
      return t('cap.approvalProblem.notDraft.error');
    case 'notInReview':
      return t('cap.approvalProblem.notInReview.error');
    case 'belowCommitted':
      return t('cap.approvalProblem.belowCommitted.error');
    case 'nationalCode':
      return t('cap.approvalProblem.nationalCode.error', { count: problem.projectCount });
    case 'yearLocked':
      return t('cap.approvalProblem.yearLocked.error');
    case 'versionConflict':
      return t('cap.approvalProblem.versionConflict.error');
    case 'planChanged':
      return t('cap.approvalProblem.planChanged.error');
    case 'stageInvalid':
      return t('cap.approvalProblem.stageInvalid.error');
    case 'notPublished':
      return t('cap.approvalProblem.notPublished.error');
    case 'noLines':
      return t('cap.approvalProblem.noLines.error');
    case 'denied':
      return t('cap.approvalProblem.denied.error');
    case 'notFound':
      return t('cap.approvalProblem.notFound.error');
    case 'validation':
      return problem.field === undefined ? t('cap.approvalProblem.validation.error') : t('cap.approvalProblem.validationField.error', { field: problem.field });
    case 'general':
      return t('cap.approvalProblem.general.error');
  }
}
