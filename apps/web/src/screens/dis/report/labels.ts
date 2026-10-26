import type { Translator } from '../../../i18n';
import type { Basis, CellKey, CellProblem, FormProblem, ReportProblem, ReportStatus } from './model';

type T = Translator['t'];

// Every key is written out so the i18n check can see it is in use.
export function reportStatusLabel(t: T, status: ReportStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('dis.reportStatus.draft');
    case 'SUBMITTED':
      return t('dis.reportStatus.submitted');
    case 'UNDER_REVIEW':
      return t('dis.reportStatus.underReview');
    case 'ACCEPTED':
      return t('dis.reportStatus.accepted');
    case 'RETURNED':
      return t('dis.reportStatus.returned');
    case 'AMENDMENT_REQUESTED':
      return t('dis.reportStatus.amendmentRequested');
    case 'WITHDRAWN':
      return t('dis.reportStatus.withdrawn');
    case 'SUPERSEDED':
      return t('dis.reportStatus.superseded');
  }
}

/** The label of a cell as the paper form names it: the source and the budget. */
export function cellLabel(t: T, cell: CellKey): string {
  if (cell.bucket === 'CURRENT_YEAR') return cell.level === 'CENTRAL' ? t('dis.reportCell.currentYearCentral') : t('dis.reportCell.currentYearLocal');
  if (cell.bucket === 'CARRYOVER') return cell.level === 'CENTRAL' ? t('dis.reportCell.carryoverCentral') : t('dis.reportCell.carryoverLocal');
  return cell.level === 'CENTRAL' ? t('dis.reportCell.otherCentral') : t('dis.reportCell.otherLocal');
}

export function basisLabel(t: T, basis: Basis): string {
  switch (basis) {
    case 'PERIOD':
      return t('dis.reportBasis.period');
    case 'YTD':
      return t('dis.reportBasis.ytd');
    case 'PROJECT_TO_DATE':
      return t('dis.reportBasis.projectToDate');
  }
}

export function cellProblemMessage(t: T, problem: CellProblem): string {
  switch (problem) {
    case 'required':
      return t('dis.reportProblem.cell.required');
    case 'invalid':
      return t('dis.reportProblem.cell.invalid');
    case 'exceeds':
      return t('dis.reportProblem.cell.exceeds');
    case 'notAllowed':
      return t('dis.reportProblem.cell.notAllowed');
  }
}

export function formProblemMessage(t: T, problem: FormProblem): string {
  switch (problem) {
    case 'tooShort':
      return t('dis.reportProblem.explanation.tooShort');
    case 'tooLong':
      return t('dis.reportProblem.explanation.tooLong');
    case 'invalid':
      return t('dis.reportProblem.explanation.invalid');
  }
}

/** What a screen says of a command that was refused. */
export function reportProblemMessage(t: T, problem: ReportProblem): string {
  switch (problem) {
    case 'draftExists':
      return t('dis.reportProblem.draftExists');
    case 'reportExists':
      return t('dis.reportProblem.reportExists');
    case 'periodLocked':
      return t('dis.reportProblem.periodLocked');
    case 'planNotEffective':
      return t('dis.reportProblem.planNotEffective');
    case 'stageInvalid':
      return t('dis.reportProblem.stageInvalid');
    case 'subsetExceeds':
      return t('dis.reportProblem.subsetExceeds');
    case 'immutable':
      return t('dis.reportProblem.immutable');
    case 'versionConflict':
      return t('dis.reportProblem.versionConflict');
    case 'scopeDenied':
      return t('dis.reportProblem.scopeDenied');
    case 'validation':
      return t('dis.reportProblem.validation');
    case 'notFound':
      return t('dis.reportProblem.notFound');
    case 'general':
      return t('dis.reportProblem.general');
  }
}
