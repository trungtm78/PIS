import type { useTranslation } from '../../i18n';
import type { ImportResultKind, ImportStatus, ProblemView, RowOutcome, SourceKind } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function sourceKindLabel(t: Translate, kind: SourceKind): string {
  return kind === 'STATEMENT_FILE' ? t('pay.import.sourceKind.statementFile.text') : t('pay.import.sourceKind.exportFile.text');
}

export function importStatusLabel(t: Translate, status: ImportStatus): string {
  return status === 'APPLIED' ? t('pay.import.status.applied.text') : t('pay.import.status.partial.text');
}

export function outcomeLabel(t: Translate, outcome: RowOutcome): string {
  switch (outcome) {
    case 'NEW':
      return t('pay.import.outcome.new.text');
    case 'DUPLICATE':
      return t('pay.import.outcome.duplicate.text');
    case 'CONFLICT':
      return t('pay.import.outcome.conflict.text');
    case 'ERROR':
      return t('pay.import.outcome.error.text');
  }
}

/** The verdict on an adapter, in words; a verdict the screen does not know is shown as it came. */
export function adapterStatusLabel(t: Translate, status: string): string {
  switch (status) {
    case 'PROPOSED':
      return t('pay.import.adapterStatus.proposed.text');
    case 'VERIFIED':
      return t('pay.import.adapterStatus.verified.text');
    case 'MOCK':
      return t('pay.import.adapterStatus.mock.text');
    case 'MISSING':
      return t('pay.import.adapterStatus.missing.text');
    default:
      return status;
  }
}

export function connectorStatusLabel(t: Translate, status: string): string {
  switch (status) {
    case 'ACTIVE':
      return t('pay.import.connectorStatus.active.text');
    case 'PAUSED':
      return t('pay.import.connectorStatus.paused.text');
    case 'FAILED':
      return t('pay.import.connectorStatus.failed.text');
    default:
      return status;
  }
}

export function itemStatusLabel(t: Translate, status: 'OPEN' | 'RESOLVED'): string {
  return status === 'OPEN' ? t('pay.import.itemStatus.open.text') : t('pay.import.itemStatus.resolved.text');
}

/** Why a row went to the quarantine, in words; a code the screen does not know is shown with the code. */
export function rowErrorLabel(t: Translate, code: string | null): string {
  switch (code) {
    case 'MISSING_DOCUMENT_NO':
      return t('pay.import.rowError.documentNoMissing.text');
    case 'DOCUMENT_NO_INVALID':
      return t('pay.import.rowError.documentNoInvalid.text');
    case 'DOCUMENT_DATE_INVALID':
      return t('pay.import.rowError.documentDateInvalid.text');
    case 'PROJECT_CODE_INVALID':
      return t('pay.import.rowError.projectCodeInvalid.text');
    case 'OFFICE_CODE_INVALID':
      return t('pay.import.rowError.officeCodeInvalid.text');
    case 'AMOUNT_INVALID':
      return t('pay.import.rowError.amountInvalid.text');
    case 'CONFIRMED_AT_INVALID':
      return t('pay.import.rowError.confirmedAtInvalid.text');
    case 'DIRECTION_INVALID':
      return t('pay.import.rowError.directionInvalid.text');
    case 'REFUND_UNSUPPORTED':
      return t('pay.import.rowError.refundUnsupported.text');
    case 'CROSSWALK_MISSING':
      return t('pay.import.rowError.crosswalkMissing.text');
    case 'CROSSWALK_TARGET_INVALID':
      return t('pay.import.rowError.crosswalkTargetInvalid.text');
    case 'PROJECT_NOT_FOUND':
      return t('pay.import.rowError.projectNotFound.text');
    case 'BUSINESS_KEY_INVALID':
      return t('pay.import.rowError.businessKeyInvalid.text');
    case 'MEASURE_INVALID':
      return t('pay.import.rowError.measureInvalid.text');
    default:
      return t('pay.import.rowError.unknown.text', { code: code ?? '' });
  }
}

/** What an open difference is about, in words. */
export function differenceLabel(t: Translate, code: string): string {
  switch (code) {
    case 'DUPLICATE_CONFLICT':
      return t('pay.import.difference.duplicateConflict.text');
    case 'CROSSWALK_MISSING':
      return t('pay.import.difference.crosswalkMissing.text');
    case 'CROSSWALK_TARGET_INVALID':
      return t('pay.import.difference.crosswalkTargetInvalid.text');
    case 'PROJECT_NOT_FOUND':
      return t('pay.import.difference.projectNotFound.text');
    default:
      return t('pay.import.difference.unknown.text', { code });
  }
}

/** The name of a field of a row, as the quarantine shows what was read. */
export function fieldLabel(t: Translate, field: string): string {
  switch (field) {
    case 'document_no':
      return t('pay.import.field.documentNo.label');
    case 'document_date':
      return t('pay.import.field.documentDate.label');
    case 'project_code':
      return t('pay.import.field.projectCode.label');
    case 'treasury_office_code':
      return t('pay.import.field.officeCode.label');
    case 'amount_vnd':
      return t('pay.import.field.amount.label');
    case 'confirmed_at':
      return t('pay.import.field.confirmedAt.label');
    case 'direction':
      return t('pay.import.field.direction.label');
    case 'payee_account':
      return t('pay.import.field.account.label');
    default:
      return field;
  }
}

/** The line that tells what an import did, for the notice under the form. */
export function answerMessage(t: Translate, result: ImportResultKind, counts: { total: number; new: number; duplicate: number; conflict: number; error: number }): string {
  switch (result) {
    case 'APPLIED':
      return t('pay.import.answer.applied.notice', { total: counts.total, created: counts.new, duplicate: counts.duplicate });
    case 'PARTIALLY_APPLIED':
      return t('pay.import.answer.partial.notice', { total: counts.total, created: counts.new, duplicate: counts.duplicate, conflict: counts.conflict, error: counts.error });
    case 'ALREADY_IMPORTED':
      return t('pay.import.answer.already.notice', { total: counts.total });
  }
}

export function fieldErrorMessage(t: Translate, error: 'required' | 'invalid' | 'layout'): string {
  return error === 'invalid' ? t('pay.import.fieldError.invalid.text') : t('pay.import.fieldError.required.text');
}

/** The names of the required columns that a file lacks, as a person reads them. */
export function missingText(t: Translate, missing: readonly string[]): string {
  return missing.map((field) => fieldLabel(t, field)).join(', ');
}

/** Why the file field refuses: no file picked, or a file without the columns of the layout (which are named). */
export function fileErrorMessage(t: Translate, error: 'required' | 'invalid' | 'layout', missing: readonly string[]): string {
  return error === 'layout' ? t('pay.import.fileError.layout.text', { columns: missingText(t, missing) }) : t('pay.import.fileError.required.text');
}

export function problemMessage(t: Translate, problem: ProblemView): string {
  switch (problem.reason) {
    case 'hashMismatch':
      return t('pay.import.problem.hashMismatch.error');
    case 'schemaInvalid':
      return t('pay.import.problem.schemaInvalid.error');
    case 'fileNotClean':
      return t('pay.import.problem.fileNotClean.error');
    case 'scanPending':
      return t('pay.import.problem.scanPending.error');
    case 'notFound':
      return t('pay.import.problem.notFound.error');
    case 'denied':
      return t('pay.import.problem.denied.error');
    case 'connectorStopped':
      return t('pay.import.problem.connectorStopped.error');
    case 'fileType':
      return t('pay.import.problem.fileType.error');
    case 'tooLarge':
      return t('pay.import.problem.tooLarge.error');
    case 'validation':
      return problem.field === undefined ? t('pay.import.problem.validation.error') : t('pay.import.problem.validationField.error', { field: problem.field });
    case 'general':
      return t('pay.import.problem.general.error');
  }
}
