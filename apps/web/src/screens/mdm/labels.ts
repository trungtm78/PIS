import type { useTranslation } from '../../i18n';
import type { ChangeKind, ChangeStatus, FieldProblem, ProblemView, RecordStatus, TypeScope } from './model';

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
    case 'denied':
      return t('mdm.problem.denied.error');
    case 'general':
      return t('mdm.problem.general.error');
  }
}
