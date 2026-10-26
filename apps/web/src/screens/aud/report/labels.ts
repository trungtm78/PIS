import type { Translator } from '../../../i18n';
import { REJECT_CODES } from './model';
import type { RejectCode, ReportProblem, ReportStatus } from './model';

type T = Translator['t'];

// Every key is written out so the i18n check can see it is in use.
export function reportStatusLabel(t: T, status: ReportStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('aud.reportStatus.draft');
    case 'ISSUE_REQUESTED':
      return t('aud.reportStatus.issueRequested');
    case 'ISSUED':
      return t('aud.reportStatus.issued');
    case 'REJECTED':
      return t('aud.reportStatus.rejected');
    case 'RECALLED':
      return t('aud.reportStatus.recalled');
  }
}

const isRejectCode = (code: string): code is RejectCode => (REJECT_CODES as readonly string[]).includes(code);

/** Why DOC did not issue a report, in words; a reason the screen does not know is "another reason" (the code stays at hand in the title of the cell). */
export function rejectReasonLabel(t: T, code: string): string {
  if (!isRejectCode(code)) return t('aud.reportReject.other');
  switch (code) {
    case 'DOC_TEMPLATE_MISSING':
      return t('aud.reportReject.templateMissing');
    case 'TEMPLATE_NOT_EFFECTIVE':
      return t('aud.reportReject.templateNotEffective');
    case 'PAYLOAD_HASH_MISMATCH':
      return t('aud.reportReject.hashMismatch');
    case 'PAYLOAD_SCHEMA_INVALID':
      return t('aud.reportReject.schemaInvalid');
    case 'STATE_SECRET_NOT_SUPPORTED':
      return t('aud.reportReject.stateSecret');
  }
}

/** What a dialog says of a command that was refused; the count says how many recommendations are still open. */
export function reportProblemMessage(t: T, problem: ReportProblem, open?: number): string {
  switch (problem) {
    case 'exists':
      return t('aud.reportProblem.exists');
    case 'engagementState':
      return t('aud.reportProblem.engagementState');
    case 'conclusionReplaced':
      return t('aud.reportProblem.conclusionReplaced');
    case 'templateMissing':
      return t('aud.reportProblem.templateMissing');
    case 'providerUnavailable':
      return t('aud.reportProblem.providerUnavailable');
    case 'openRecommendations':
      return t('aud.reportProblem.openRecommendations', { count: open ?? 0 });
    case 'reportMissing':
      return t('aud.reportProblem.reportMissing');
    case 'versionConflict':
      return t('aud.reportProblem.versionConflict');
    case 'scopeDenied':
      return t('aud.reportProblem.scopeDenied');
    case 'validation':
      return t('aud.reportProblem.validation');
    case 'notFound':
      return t('aud.reportProblem.notFound');
    case 'general':
      return t('aud.reportProblem.general');
  }
}
