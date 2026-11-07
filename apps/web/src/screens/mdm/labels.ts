import type { useTranslation } from '../../i18n';
import type { Tone } from '../../ui';
import type { AdapterStatus, ChangeKind, ChangeStatus, CrosswalkMethod, CrosswalkStatus, CursorStatus, FieldProblem, GlossaryStatus, ImportStatus, ProblemView, RecordStatus, TypeScope } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function recordStatusLabel(t: Translate, status: RecordStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('mdm.status.record.draft');
    case 'IN_REVIEW':
      return t('mdm.status.record.inReview');
    case 'APPROVED':
      return t('mdm.status.record.approved');
    case 'EFFECTIVE':
      return t('mdm.status.record.effective');
    case 'RETIRED':
      return t('mdm.status.record.retired');
    case 'MERGED':
      return t('mdm.status.record.merged');
  }
}

export function scopeLabel(t: Translate, scope: TypeScope): string {
  switch (scope) {
    case 'PLATFORM_ONLY':
      return t('mdm.scope.platformOnly.label');
    case 'PLATFORM_WITH_TENANT_EXTENSION':
      return t('mdm.scope.extension.label');
    case 'TENANT_ONLY':
      return t('mdm.scope.tenantOnly.label');
  }
}

export function scopeExplanation(t: Translate, scope: TypeScope): string {
  switch (scope) {
    case 'PLATFORM_ONLY':
      return t('mdm.scope.platformOnly.text');
    case 'PLATFORM_WITH_TENANT_EXTENSION':
      return t('mdm.scope.extension.text');
    case 'TENANT_ONLY':
      return t('mdm.scope.tenantOnly.text');
  }
}

export function changeStatusLabel(t: Translate, status: ChangeStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('mdm.status.change.draft');
    case 'IN_REVIEW':
      return t('mdm.status.change.inReview');
    case 'APPROVED':
      return t('mdm.status.change.approved');
    case 'REJECTED':
      return t('mdm.status.change.rejected');
    case 'APPLIED':
      return t('mdm.status.change.applied');
    case 'CANCELLED':
      return t('mdm.status.change.cancelled');
  }
}

export function changeKindLabel(t: Translate, kind: ChangeKind): string {
  switch (kind) {
    case 'CREATE':
      return t('mdm.kind.change.create');
    case 'UPDATE':
      return t('mdm.kind.change.update');
    case 'RETIRE':
      return t('mdm.kind.change.retire');
    case 'SUCCESSION':
      return t('mdm.kind.change.succession');
  }
}

export function fieldProblemMessage(t: Translate, problem: FieldProblem): string {
  switch (problem) {
    case 'required':
      return t('mdm.field.required.error');
    case 'tooLong':
      return t('mdm.field.tooLong.error');
    case 'tooShort':
      return t('mdm.field.tooShort.error');
    case 'invalidDate':
      return t('mdm.field.invalidDate.error');
    case 'order':
      return t('mdm.field.order.error');
    case 'invalidJson':
      return t('mdm.field.invalidJson.error');
    case 'invalidCode':
      return t('mdm.field.invalidCode.error');
    case 'invalidId':
      return t('mdm.field.invalidId.error');
    case 'definitionTooShort':
      return t('mdm.field.definitionTooShort.error');
  }
}

/** The sentence for a refusal of a command; a problem the screen has no sentence for is the general one. */
export function problemMessage(t: Translate, problem: ProblemView): string {
  switch (problem.reason) {
    case 'duplicateKey':
      return t('mdm.problem.duplicateKey.error');
    case 'policyLocked':
      return t('mdm.problem.policyLocked.error');
    case 'inUse':
      return t('mdm.problem.inUse.error');
    case 'overlap':
      return t('mdm.problem.overlap.error');
    case 'selfApproval':
      return t('mdm.problem.selfApproval.error');
    case 'versionConflict':
      return t('mdm.problem.versionConflict.error');
    case 'impactNotComputed':
      return t('mdm.problem.impactNotComputed.error');
    case 'notApproved':
      return t('mdm.problem.notApproved.error');
    case 'stageDenied':
      return t('mdm.problem.stageDenied.error');
    case 'validation':
      return problem.field === undefined ? t('mdm.problem.validation.error') : t('mdm.problem.validationField.error', { field: problem.field });
    case 'importHasErrors':
      return t('mdm.problem.importHasErrors.error');
    case 'importEmpty':
      return t('mdm.problem.importEmpty.error');
    case 'alreadyApplied':
      return t('mdm.problem.alreadyApplied.error');
    case 'fileRefused':
      return t('mdm.problem.fileRefused.error');
    case 'duplicateCrosswalk':
      return t('mdm.problem.duplicateCrosswalk.error');
    case 'duplicateTerm':
      return t('mdm.problem.duplicateTerm.error');
    case 'notOwner':
      return t('mdm.problem.notOwner.error');
    case 'notFound':
      return t('mdm.problem.notFound.error');
    case 'successionCycle':
      return t('mdm.problem.successionCycle.error');
    case 'denied':
      return t('mdm.problem.denied.error');
    case 'general':
      return t('mdm.problem.general.error');
  }
}

/** What a code of a row of a bulk import file says (the codes are the server's; a code that is not known is shown as it is). */
export function rowErrorLabel(t: Translate, code: string): string {
  switch (code) {
    case 'REQUIRED':
      return t('mdm.import.error.required.text');
    case 'INVALID_FORMAT':
      return t('mdm.import.error.invalidFormat.text');
    case 'TOO_LONG':
      return t('mdm.import.error.tooLong.text');
    case 'INVALID_DATE':
      return t('mdm.import.error.invalidDate.text');
    case 'INVALID_RANGE':
      return t('mdm.import.error.invalidRange.text');
    case 'DUPLICATE_IN_FILE':
      return t('mdm.import.error.duplicateInFile.text');
    case 'DUPLICATE_KEY':
      return t('mdm.import.error.duplicateKey.text');
    case 'PARENT_NOT_FOUND':
      return t('mdm.import.error.parentNotFound.text');
    case 'PARENT_CYCLE':
      return t('mdm.import.error.parentCycle.text');
    case 'PARENT_SKIPPED':
      return t('mdm.import.error.parentSkipped.text');
    case 'REFERENCE_SKIPPED':
      return t('mdm.import.error.referenceSkipped.text');
    case 'INVALID_VALUE':
      return t('mdm.import.error.invalidValue.text');
    case 'POLICY_LOCKED':
      return t('mdm.import.error.policyLocked.text');
    case 'CROSSWALK_MISSING':
      return t('mdm.import.error.crosswalkMissing.text');
    case 'SUBSET_SOURCE_NOT_ADDITIVE':
      return t('mdm.import.error.subsetNotAdditive.text');
    default:
      return t('mdm.import.error.other.text', { code });
  }
}

/** The part of an entry that a row error is about, in the words of the screen. */
export function rowFieldLabel(t: Translate, field: string): string {
  switch (field) {
    case 'business_key':
      return t('mdm.import.field.key.text');
    case 'label':
      return t('mdm.import.field.label.text');
    case 'valid_from':
      return t('mdm.import.field.validFrom.text');
    case 'valid_until':
      return t('mdm.import.field.validUntil.text');
    case 'parent_key':
      return t('mdm.import.field.parent.text');
    case 'legal_basis':
      return t('mdm.import.field.legalBasis.text');
    default:
      return field.startsWith('attributes.') ? t('mdm.import.field.attribute.text', { name: field.slice('attributes.'.length) }) : field;
  }
}

export function importStatusLabel(t: Translate, status: ImportStatus): string {
  switch (status) {
    case 'STAGED':
      return t('mdm.import.status.staged.text');
    case 'VALIDATED':
      return t('mdm.import.status.validated.text');
    case 'IN_REVIEW':
      return t('mdm.import.status.inReview.text');
    case 'APPLIED':
      return t('mdm.import.status.applied.text');
    case 'FAILED':
      return t('mdm.import.status.failed.text');
    case 'CANCELLED':
      return t('mdm.import.status.cancelled.text');
  }
}

export function crosswalkStatusLabel(t: Translate, status: CrosswalkStatus): string {
  return status === 'ACTIVE' ? t('mdm.crosswalk.status.active.text') : t('mdm.crosswalk.status.retired.text');
}

export function crosswalkMethodLabel(t: Translate, method: CrosswalkMethod): string {
  switch (method) {
    case 'MANUAL':
      return t('mdm.crosswalk.method.manual.text');
    case 'IMPORT':
      return t('mdm.crosswalk.method.import.text');
    case 'RULE':
      return t('mdm.crosswalk.method.rule.text');
  }
}

/** What the verdict on the adapter of a connector says: only VERIFIED is a format the agency has confirmed. */
export function adapterLabel(t: Translate, status: AdapterStatus): string {
  switch (status) {
    case 'VERIFIED':
      return t('mdm.cursor.adapter.verified.pill');
    case 'PROPOSED':
      return t('mdm.cursor.adapter.proposed.pill');
    case 'MOCK':
      return t('mdm.cursor.adapter.mock.pill');
    case 'MISSING':
      return t('mdm.cursor.adapter.missing.pill');
  }
}

export function glossaryStatusLabel(t: Translate, status: GlossaryStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('mdm.glossary.status.draft.text');
    case 'IN_REVIEW':
      return t('mdm.glossary.status.inReview.text');
    case 'APPROVED':
      return t('mdm.glossary.status.approved.text');
    case 'PUBLISHED':
      return t('mdm.glossary.status.published.text');
    case 'DEPRECATED':
      return t('mdm.glossary.status.deprecated.text');
    case 'REJECTED':
      return t('mdm.glossary.status.rejected.text');
  }
}

export function cursorStatusLabel(t: Translate, status: CursorStatus): string {
  switch (status) {
    case 'ACTIVE':
      return t('mdm.cursor.status.active.text');
    case 'PAUSED':
      return t('mdm.cursor.status.paused.text');
    case 'FAILED':
      return t('mdm.cursor.status.failed.text');
  }
}

/** The tone of the status pill of a master data record: in force is green, waiting for a decision amber, approved blue, closed grey. */
export function recordStatusTone(status: RecordStatus): Tone {
  switch (status) {
    case 'EFFECTIVE':
      return 'success';
    case 'IN_REVIEW':
      return 'warning';
    case 'APPROVED':
      return 'info';
    case 'DRAFT':
    case 'RETIRED':
    case 'MERGED':
      return 'neutral';
  }
}
