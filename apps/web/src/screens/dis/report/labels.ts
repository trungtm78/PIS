import type { Translator } from '../../../i18n';
import type { Finding } from './detail-parts';
import type { Basis, CellKey, CellProblem, FormProblem, ReportProblem, ReportStatus } from './model';
import { formatVnd } from './money';
import { cellOfFinding } from './step-model';
import type { StepKey, VolumeProblem } from './step-model';

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
    case 'selfApproval':
      return t('dis.reportProblem.selfApproval');
    case 'pendingExists':
      return t('dis.reportProblem.pendingExists');
    case 'reasonRequired':
      return t('dis.reportProblem.reasonRequired');
    case 'versionConflict':
      return t('dis.reportProblem.versionConflict');
    case 'scopeDenied':
      return t('dis.reportProblem.scopeDenied');
    case 'validation':
      return t('dis.reportProblem.validation');
    case 'notFound':
      return t('dis.reportProblem.notFound');
    case 'fileInfected':
      return t('dis.reportProblem.fileInfected');
    case 'fileType':
      return t('dis.reportProblem.fileType');
    case 'fileTooLarge':
      return t('dis.reportProblem.fileTooLarge');
    case 'scanPending':
      return t('dis.reportProblem.scanPending');
    case 'hashMismatch':
      return t('dis.reportProblem.hashMismatch');
    case 'general':
      return t('dis.reportProblem.general');
  }
}

export function stepLabel(t: T, key: StepKey): string {
  switch (key) {
    case 'progress':
      return t('dis.reportSteps.progress.link');
    case 'cells':
      return t('dis.reportSteps.cells.link');
    case 'registration':
      return t('dis.reportSteps.registration.link');
    case 'review':
      return t('dis.reportSteps.review.link');
  }
}

export function volumeProblemMessage(t: T, problem: VolumeProblem): string {
  switch (problem) {
    case 'required':
      return t('dis.progress.problem.required');
    case 'invalid':
      return t('dis.progress.problem.invalid');
    case 'range':
      return t('dis.progress.problem.range');
  }
}

/** The sentence of one finding of the review, with its figures written the way a person reads them. */
export function findingMessage(t: T, finding: Finding): string {
  const value = (name: string): string => formatVnd(finding.values[name] ?? '0');
  const cell = cellOfFinding(finding);
  const cellName = cell === undefined ? '' : cellLabel(t, cell);
  switch (finding.code) {
    case 'REVISION_IMMUTABLE':
      return t('dis.review.finding.immutable.text');
    case 'PERIOD_LOCKED':
      return t('dis.review.finding.periodLocked.text');
    case 'PLAN_VERSION_NOT_EFFECTIVE':
      return t('dis.review.finding.planNotEffective.text');
    case 'SUBSET_EXCEEDS_PARENT':
      return finding.field.endsWith('next_month_ctmtqg_subset_vnd')
        ? t('dis.review.finding.subsetNext.text', { subset: value('subset_vnd'), parent: value('parent_vnd'), cell: cellName })
        : t('dis.review.finding.subset.text', { subset: value('subset_vnd'), parent: value('parent_vnd'), cell: cellName });
    case 'NEGATIVE_DELTA_EXPLANATION_REQUIRED':
      return t('dis.review.finding.fall.text');
    case 'VALIDATION_FAILED':
      return finding.field.startsWith('narrative') ? t('dis.review.finding.causes.text') : t('dis.review.finding.volumes.text');
    case 'VOLUME_EXCEEDS_ALLOCATION':
      return finding.values.ratio_pct === null || finding.values.ratio_pct === undefined
        ? t('dis.review.finding.volumeNoCapital.text', { construction: value('construction_vnd') })
        : t('dis.review.finding.volumeExceeds.text', { construction: value('construction_vnd'), ratio: finding.values.ratio_pct, allocated: value('allocated_vnd') });
    case 'TREASURY_GAP':
      return finding.values.gap_pct === null || finding.values.gap_pct === undefined
        ? t('dis.review.finding.treasuryNone.text', { reported: value('reported_vnd') })
        : t('dis.review.finding.treasuryGap.text', { reported: value('reported_vnd'), pct: finding.values.gap_pct, treasury: value('treasury_vnd') });
    case 'NEXT_MONTH_EMPTY_WITH_CAPITAL_LEFT':
      return t('dis.review.finding.nextMonth.text', { remaining: value('remaining_vnd') });
    default:
      return t('dis.review.finding.other.text', { code: finding.code });
  }
}
