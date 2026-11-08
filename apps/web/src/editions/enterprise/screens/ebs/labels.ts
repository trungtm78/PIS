import type { Translator } from '../../../../i18n';
import { failureCode } from '../shared/format';
import { commonErrorText } from '../shared/parts';
import type { Difference, DifferenceState, PreviewRow, ResolutionKind, Run } from './model';

type T = Translator['t'];

export function healthLabel(t: T, status: string): string {
  switch (status) {
    case 'FRESH':
      return t('ebs.health.state.fresh');
    case 'AGING':
      return t('ebs.health.state.aging');
    case 'STALE':
      return t('ebs.health.state.stale');
    default:
      return t('ebs.health.state.never');
  }
}

export function healthExplain(t: T, status: string): string {
  switch (status) {
    case 'FRESH':
      return t('ebs.health.explain.fresh');
    case 'AGING':
      return t('ebs.health.explain.aging');
    case 'STALE':
      return t('ebs.health.explain.stale');
    default:
      return t('ebs.health.explain.never');
  }
}

export function runStatusLabel(t: T, status: Run['status']): string {
  switch (status) {
    case 'IMPORTING':
      return t('ebs.run.status.importing');
    case 'APPLIED':
      return t('ebs.run.status.applied');
    case 'FAILED':
      return t('ebs.run.status.failed');
  }
}

export function resolutionLabel(t: T, kind: ResolutionKind): string {
  switch (kind) {
    case 'OURS_WRONG':
      return t('ebs.resolution.kind.oursWrong');
    case 'EBS_WRONG':
      return t('ebs.resolution.kind.ebsWrong');
    case 'TIMING':
      return t('ebs.resolution.kind.timing');
    case 'WAIVED':
      return t('ebs.resolution.kind.waived');
  }
}

export function resolutionHint(t: T, kind: ResolutionKind): string {
  switch (kind) {
    case 'OURS_WRONG':
      return t('ebs.resolution.hint.oursWrong');
    case 'EBS_WRONG':
      return t('ebs.resolution.hint.ebsWrong');
    case 'TIMING':
      return t('ebs.resolution.hint.timing');
    case 'WAIVED':
      return t('ebs.resolution.hint.waived');
  }
}

export const measureLabel = (t: T, measure: Difference['measure']): string => (measure === 'DISBURSED_VND' ? t('ebs.measure.disbursed') : t('ebs.measure.committed'));
export const differenceKindLabel = (t: T, kind: Difference['difference_kind']): string => (kind === 'AMOUNT_MISMATCH' ? t('ebs.difference.kind.mismatch') : t('ebs.difference.kind.missingOurs'));
export const stateLabel = (t: T, state: DifferenceState): string => (state === 'OPEN' ? t('ebs.difference.state.open') : t('ebs.difference.state.resolved'));

export function rowStatusLabel(t: T, status: PreviewRow['status']): string {
  switch (status) {
    case 'VALID':
      return t('ebs.preview.status.valid');
    case 'ERROR':
      return t('ebs.preview.status.error');
    case 'DUPLICATE':
      return t('ebs.preview.status.duplicate');
    case 'CONFLICT':
      return t('ebs.preview.status.conflict');
  }
}

/** The reason a row of the file was refused, in words; a code this screen does not know is shown as the server wrote it. */
export function rowCodeLabel(t: T, code: string | null): string {
  switch (code) {
    case null:
      return '–';
    case 'REQUIRED':
      return t('ebs.row.code.required');
    case 'CODE_INVALID':
      return t('ebs.row.code.codeInvalid');
    case 'PERIOD_INVALID':
      return t('ebs.row.code.periodInvalid');
    case 'DATE_INVALID':
      return t('ebs.row.code.dateInvalid');
    case 'AMOUNT_INVALID':
      return t('ebs.row.code.amountInvalid');
    case 'ROW_DUPLICATE':
      return t('ebs.row.code.duplicate');
    case 'ROW_CONFLICT':
      return t('ebs.row.code.conflict');
    default:
      return code;
  }
}

/** What the apply would do with a valid row (the dry run says it). */
export function rowOutcomeLabel(t: T, outcome: string | null): string {
  switch (outcome) {
    case 'RECORD':
      return t('ebs.preview.outcome.record');
    case 'RECORD_PROJECT_UNKNOWN':
      return t('ebs.preview.outcome.unknownProject');
    default:
      return outcome ?? '–';
  }
}

export function columnWord(t: T, column: string): string {
  switch (column) {
    case 'project_code':
      return t('ebs.column.projectCode');
    case 'period':
      return t('ebs.column.period');
    case 'extract_date':
      return t('ebs.column.extractDate');
    case 'disbursed_vnd':
      return t('ebs.column.disbursed');
    case 'committed_vnd':
      return t('ebs.column.committed');
    default:
      return column;
  }
}

/** The refusal of an import, a reconciliation or an explanation in the words of the person; the codes of the common ones come from the shared words. */
export function ebsErrorText(t: T, error: unknown): string {
  switch (failureCode(error)) {
    case 'EBS_LAYOUT_VERSION_UNKNOWN':
      return t('ebs.error.layoutUnknown.text');
    case 'EBS_CONNECTION_DISABLED':
      return t('ebs.error.disabled.text');
    case 'EBS_ITEM_STATE_INVALID':
      return t('ebs.error.itemState.text');
    case 'IMPORT_FILE_ALREADY_APPLIED':
      return t('ebs.error.alreadyApplied.text');
    case 'IMPORT_HAS_ERRORS':
      return t('ebs.error.hasErrors.text');
    case 'IMPORT_SCHEMA_INVALID':
      return t('ebs.error.schema.text');
    case 'IMPORT_EMPTY':
      return t('ebs.error.empty.text');
    case 'FILE_NOT_CLEAN':
      return t('ebs.error.infected.text');
    case 'FILE_TYPE_NOT_ALLOWED':
      return t('ebs.error.fileType.text');
    case 'SCAN_PENDING':
      return t('ebs.error.scanPending.text');
    case 'CALENDAR_NOT_EFFECTIVE':
      return t('ebs.error.calendar.text');
    default:
      return commonErrorText(t, error);
  }
}
