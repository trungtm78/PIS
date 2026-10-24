import type { useTranslation } from '../../i18n';
import type { DueState, EventKind, FieldProblem, IssueSource, IssueStatus, ProblemView } from './issue-model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function statusLabel(t: Translate, status: IssueStatus): string {
  switch (status) {
    case 'OPEN':
      return t('iss.status.open.text');
    case 'ASSIGNED':
      return t('iss.status.assigned.text');
    case 'IN_PROGRESS':
      return t('iss.status.inProgress.text');
    case 'ESCALATED':
      return t('iss.status.escalated.text');
    case 'PENDING_VERIFICATION':
      return t('iss.status.pendingVerification.text');
    case 'CLOSED':
      return t('iss.status.closed.text');
    case 'REOPENED':
      return t('iss.status.reopened.text');
  }
}

export function sourceLabel(t: Translate, source: IssueSource): string {
  switch (source) {
    case 'MANUAL':
      return t('iss.source.manual.text');
    case 'LND':
      return t('iss.source.lnd.text');
    case 'PMT':
      return t('iss.source.pmt.text');
    case 'QMS':
      return t('iss.source.qms.text');
    case 'PAY':
      return t('iss.source.pay.text');
    case 'CTR':
      return t('iss.source.ctr.text');
    case 'DIS':
      return t('iss.source.dis.text');
    case 'AST':
      return t('iss.source.ast.text');
    case 'AUD':
      return t('iss.source.aud.text');
    case 'PRJ':
      return t('iss.source.prj.text');
  }
}

export function dueLabel(t: Translate, state: DueState): string {
  switch (state) {
    case 'closed':
      return t('iss.due.closed.badge');
    case 'overdue':
      return t('iss.due.overdue.badge');
    case 'dueSoon':
      return t('iss.due.dueSoon.badge');
    case 'onTrack':
      return t('iss.due.onTrack.badge');
  }
}

/** What the timeline says about one event; the names and the units are the ones the event carries. */
export function eventLabel(t: Translate, kind: EventKind, names: { from: string; to: string }): string {
  switch (kind) {
    case 'CREATED':
      return t('iss.event.created.text');
    case 'ASSIGNED':
      return t('iss.event.assigned.text', { to: names.to });
    case 'REASSIGNED':
      return t('iss.event.reassigned.text', { from: names.from, to: names.to });
    case 'TRANSFERRED':
      return t('iss.event.transferred.text', { from: names.from, to: names.to });
    case 'STARTED':
      return t('iss.event.started.text');
    case 'COMMENTED':
      return t('iss.event.commented.text');
    case 'EVIDENCE_ADDED':
      return t('iss.event.evidenceAdded.text');
    case 'EXTENSION_REQUESTED':
      return t('iss.event.extensionRequested.text');
    case 'EXTENDED':
      return t('iss.event.extended.text');
    case 'ESCALATED':
      return t('iss.event.escalated.text');
    case 'ESCALATION_ACCEPTED':
      return t('iss.event.escalationAccepted.text');
    case 'VERIFICATION_REQUESTED':
      return t('iss.event.verificationRequested.text');
    case 'CLOSED':
      return t('iss.event.closed.text');
    case 'REOPENED':
      return t('iss.event.reopened.text');
    case 'SLA_BREACHED':
      return t('iss.event.slaBreached.text');
    case 'SOURCE_UPDATED':
      return t('iss.event.sourceUpdated.text');
  }
}

export function issueFieldMessage(t: Translate, problem: FieldProblem): string {
  switch (problem) {
    case 'required':
      return t('iss.field.required.error');
    case 'tooLong':
      return t('iss.field.tooLong.error');
    case 'invalidLatitude':
      return t('iss.field.invalidLatitude.error');
    case 'invalidLongitude':
      return t('iss.field.invalidLongitude.error');
    case 'invalidAccuracy':
      return t('iss.field.invalidAccuracy.error');
    case 'consentRequired':
      return t('iss.field.consentRequired.error');
    case 'pairRequired':
      return t('iss.field.pairRequired.error');
    case 'rejected':
      return t('iss.field.rejected.error');
  }
}

export function issueProblemMessage(t: Translate, problem: ProblemView): string {
  switch (problem.reason) {
    case 'noPolicy':
      return t('iss.issueProblem.noPolicy.error');
    case 'duplicateSource':
      return t('iss.issueProblem.duplicateSource.error');
    case 'stateInvalid':
      return t('iss.issueProblem.stateInvalid.error');
    case 'assigneeOutOfScope':
      return t('iss.issueProblem.assigneeOutOfScope.error');
    case 'documentNotClean':
      return t('iss.issueProblem.documentNotClean.error');
    case 'evidenceRequired':
      return t('iss.issueProblem.evidenceRequired.error');
    case 'selfApproval':
      return t('iss.issueProblem.selfApproval.error');
    case 'extensionLimit':
      return t('iss.issueProblem.extensionLimit.error');
    case 'escalationLevel':
      return t('iss.issueProblem.escalationLevel.error');
    case 'taskForceNotActive':
      return t('iss.issueProblem.taskForceNotActive.error');
    case 'escalationState':
      return t('iss.issueProblem.escalationState.error');
    case 'reopenWindow':
      return t('iss.issueProblem.reopenWindow.error');
    case 'versionConflict':
      return t('iss.issueProblem.versionConflict.error');
    case 'operationConflict':
      return t('iss.issueProblem.operationConflict.error');
    case 'validation':
      return t('iss.issueProblem.validation.error');
    case 'denied':
      return t('iss.issueProblem.denied.error');
    case 'notFound':
      return t('iss.issueProblem.notFound.error');
    case 'general':
      return t('iss.issueProblem.general.error');
  }
}
