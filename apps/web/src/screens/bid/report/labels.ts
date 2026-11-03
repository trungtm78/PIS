import type { useTranslation } from '../../../i18n';
import type { AwaitingStanding, FormProblem, NotCoveredReason, Problem, ReportStatus, Stage } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function statusLabel(t: Translate, status: ReportStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('bid.report.status.draft');
    case 'SIGNED_OFF':
      return t('bid.report.status.signedOff');
    case 'ISSUE_REQUESTED':
      return t('bid.report.status.issueRequested');
    case 'ISSUED':
      return t('bid.report.status.issued');
    case 'SUPERSEDED':
      return t('bid.report.status.superseded');
  }
}

/** The tone of the badge of a status: issued minutes are good news, minutes DOC refused need someone, the rest wait or were replaced. */
export function statusTone(status: ReportStatus): 'ok' | 'warning' | 'danger' | 'plain' {
  switch (status) {
    case 'ISSUED':
      return 'ok';
    case 'SIGNED_OFF':
      return 'danger';
    case 'SUPERSEDED':
      return 'plain';
    case 'DRAFT':
    case 'ISSUE_REQUESTED':
      return 'warning';
  }
}

export function stageLabel(t: Translate, stage: Stage): string {
  switch (stage) {
    case 'signing':
      return t('bid.report.stage.signing');
    case 'doc':
      return t('bid.report.stage.doc');
    case 'issued':
      return t('bid.report.stage.issued');
    case 'superseded':
      return t('bid.report.stage.superseded');
    case 'refused':
      return t('bid.report.stage.refused');
  }
}

export function standingLabel(t: Translate, standing: AwaitingStanding): string {
  switch (standing) {
    case 'UNDECLARED':
      return t('bid.report.awaiting.undeclared');
    case 'PENDING':
      return t('bid.report.awaiting.pending');
    case 'CLEAR':
    case 'ALLOWED':
      return t('bid.report.awaiting.unsigned');
  }
}

export function notCoveredLabel(t: Translate, reason: NotCoveredReason): string {
  switch (reason) {
    case 'NOT_SELECTED':
      return t('bid.report.notCovered.notSelected');
    case 'NO_ANALYSIS_RUN':
      return t('bid.report.notCovered.noRun');
    case 'CRITERIA_VERSION_MISMATCH':
      return t('bid.report.notCovered.mismatch');
  }
}

export function formProblemMessage(t: Translate, problem: FormProblem): string {
  switch (problem) {
    case 'required':
      return t('bid.report.problem.required');
    case 'tooShort':
      return t('bid.report.problem.tooShort');
    case 'tooLong':
      return t('bid.report.problem.tooLong');
    case 'noRun':
      return t('bid.report.problem.noRun');
  }
}

/** What a refusal of a command says; the count is the findings nobody decided when the report was refused for them. */
export function problemMessage(t: Translate, problem: Problem, count = 0): string {
  switch (problem) {
    case 'unreviewed':
      return t('bid.report.error.unreviewed', { count });
    case 'criteriaMismatch':
      return t('bid.report.error.criteriaMismatch');
    case 'runNotCompleted':
      return t('bid.report.error.runNotCompleted');
    case 'undeclared':
      return t('bid.report.error.undeclared');
    case 'alreadySigned':
      return t('bid.report.error.alreadySigned');
    case 'notDraft':
      return t('bid.report.error.notDraft');
    case 'outOfDate':
      return t('bid.report.error.outOfDate');
    case 'versionConflict':
      return t('bid.report.error.versionConflict');
    case 'templateMissing':
      return t('bid.report.error.templateMissing');
    case 'docUnavailable':
      return t('bid.report.error.docUnavailable');
    case 'validation':
      return t('bid.report.error.validation');
    case 'notFound':
      return t('bid.report.error.notFound');
    case 'denied':
      return t('bid.report.error.denied');
    case 'session':
      return t('bid.report.error.session');
    case 'general':
      return t('bid.report.error.general');
  }
}
