import type { Translator } from '../../../i18n';
import type { ControlObject, FieldProblem, PolicyRow, PolicyStatus, ProblemReason, ScopeKind } from './model';

type T = Translator['t'];

// Every key is written out so the i18n check can see it is in use.
export function scopeKindLabel(t: T, kind: ScopeKind): string {
  switch (kind) {
    case 'TENANT':
      return t('cap.avc.scopeKind.tenant');
    case 'FUND_SOURCE':
      return t('cap.avc.scopeKind.fund');
    case 'UNIT':
      return t('cap.avc.scopeKind.unit');
    case 'PROJECT_GROUP':
      return t('cap.avc.scopeKind.group');
  }
}

/** The scope of a policy in words; a unit is named when the screen knows its name. */
export function scopeText(t: T, policy: Pick<PolicyRow, 'scopeKind' | 'scopeRefId' | 'scopeValue'>, unitName: (id: string) => string | undefined): string {
  switch (policy.scopeKind) {
    case 'TENANT':
      return t('cap.avc.scope.tenant');
    case 'FUND_SOURCE':
      return t('cap.avc.scope.fund', { value: policy.scopeValue ?? '' });
    case 'UNIT':
      return t('cap.avc.scope.unit', { value: (policy.scopeRefId === null ? undefined : unitName(policy.scopeRefId)) ?? policy.scopeRefId ?? '' });
    case 'PROJECT_GROUP':
      return t('cap.avc.scope.group', { value: policy.scopeValue ?? '' });
  }
}

export function objectLabel(t: T, object: ControlObject): string {
  switch (object) {
    case 'ALLOCATION_LINE':
      return t('cap.avc.object.line');
    case 'APPROPRIATION':
      return t('cap.avc.object.appropriation');
  }
}

/** What the preview counts, in the plural the sentence needs. */
export function countedLabel(t: T, object: ControlObject): string {
  switch (object) {
    case 'ALLOCATION_LINE':
      return t('cap.avc.preview.counted.line');
    case 'APPROPRIATION':
      return t('cap.avc.preview.counted.appropriation');
  }
}

export function statusLabel(t: T, status: PolicyStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('cap.avc.status.draft');
    case 'PUBLISHED':
      return t('cap.avc.status.published');
    case 'RETIRED':
      return t('cap.avc.status.retired');
  }
}

export function periodText(t: T, policy: Pick<PolicyRow, 'effectiveFrom' | 'effectiveUntil'>): string {
  return policy.effectiveUntil === null ? t('cap.avc.period.open', { from: policy.effectiveFrom }) : t('cap.avc.period.closed', { from: policy.effectiveFrom, until: policy.effectiveUntil });
}

export function fieldProblemMessage(t: T, problem: FieldProblem): string {
  switch (problem) {
    case 'required':
      return t('cap.avc.field.required');
    case 'format':
      return t('cap.avc.field.format');
    case 'notPercentage':
      return t('cap.avc.field.notPercentage');
    case 'above100':
      return t('cap.avc.field.above100');
    case 'warnAboveBlock':
      return t('cap.avc.field.warnAboveBlock');
    case 'tooShort':
      return t('cap.avc.field.tooShort');
    case 'beforeStart':
      return t('cap.avc.field.beforeStart');
    case 'notDate':
      return t('cap.avc.field.notDate');
  }
}

export function problemMessage(t: T, reason: ProblemReason): string {
  switch (reason) {
    case 'threshold':
      return t('cap.avc.problem.threshold');
    case 'invalid':
      return t('cap.avc.problem.invalid');
    case 'selfApproval':
      return t('cap.avc.problem.selfApproval');
    case 'state':
      return t('cap.avc.problem.state');
    case 'overlap':
      return t('cap.avc.problem.overlap');
    case 'conflict':
      return t('cap.avc.problem.conflict');
    case 'denied':
      return t('cap.avc.problem.denied');
    case 'notFound':
      return t('cap.avc.problem.notFound');
    case 'session':
      return t('cap.avc.problem.session');
    case 'general':
      return t('cap.avc.problem.general');
  }
}
