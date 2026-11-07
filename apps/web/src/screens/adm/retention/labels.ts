import type { Translator } from '../../../i18n';
import type { Tone } from '../../../ui';
import type { DraftProblem, EndAction, FindingCode, HoldKind, HoldScopeKind, PolicyStatus, ProblemView, RecordKind, RetentionBasis } from './model';

type T = Translator['t'];

// Every key is written out so the i18n check can see it is in use.
export function kindLabel(t: T, kind: RecordKind | undefined): string {
  switch (kind) {
    case 'BUSINESS':
      return t('adm.retention.kind.business');
    case 'TECHNICAL':
      return t('adm.retention.kind.technical');
    case undefined:
      return t('adm.retention.kind.unknown');
  }
}

export function basisLabel(t: T, basis: RetentionBasis): string {
  switch (basis) {
    case 'FROM_CREATED':
      return t('adm.retention.basis.created');
    case 'FROM_CLOSED':
      return t('adm.retention.basis.closed');
    case 'FROM_CONTRACT_END':
      return t('adm.retention.basis.contractEnd');
    case 'PERMANENT':
      return t('adm.retention.basis.permanent');
  }
}

export function endActionLabel(t: T, action: EndAction): string {
  switch (action) {
    case 'REVIEW_FOR_DESTRUCTION':
      return t('adm.retention.endAction.review');
    case 'ARCHIVE_TRANSFER':
      return t('adm.retention.endAction.archive');
    case 'AUTO_PURGE_TECHNICAL':
      return t('adm.retention.endAction.purge');
  }
}

export function statusLabel(t: T, status: PolicyStatus): string {
  switch (status) {
    case 'Draft':
      return t('adm.retention.status.draft');
    case 'Published':
      return t('adm.retention.status.published');
    case 'Superseded':
      return t('adm.retention.status.superseded');
  }
}

/** A draft waits (amber), the version in force is the plain pill, a replaced one is grey. */
export function statusPill(status: PolicyStatus): string {
  switch (status) {
    case 'Draft':
      return 'pill warn';
    case 'Published':
      return 'pill';
    case 'Superseded':
      return 'pill gray';
  }
}

export function holdKindLabel(t: T, kind: HoldKind): string {
  switch (kind) {
    case 'INSPECTION':
      return t('adm.retention.hold.kind.inspection');
    case 'AUDIT':
      return t('adm.retention.hold.kind.audit');
    case 'LITIGATION':
      return t('adm.retention.hold.kind.litigation');
    case 'INVESTIGATION':
      return t('adm.retention.hold.kind.investigation');
    case 'CONTRACT_END':
      return t('adm.retention.hold.kind.contractEnd');
  }
}

export function holdScopeLabel(t: T, kind: HoldScopeKind): string {
  switch (kind) {
    case 'TENANT':
      return t('adm.retention.hold.scope.tenant');
    case 'UNIT':
      return t('adm.retention.hold.scope.unit');
    case 'PROJECT':
      return t('adm.retention.hold.scope.project');
    case 'CONTRACT':
      return t('adm.retention.hold.scope.contract');
    case 'RESOURCE':
      return t('adm.retention.hold.scope.resource');
  }
}

/** The sentence for a mistake in the form or a finding of the server (the same rules, the same words). */
export function problemOfDraft(t: T, problem: DraftProblem): string {
  switch (problem) {
    case 'required':
      return t('adm.retention.field.required');
    case 'classUnknown':
      return t('adm.retention.error.classUnknown');
    case 'classFormat':
      return t('adm.retention.error.classFormat');
    case 'endAction':
      return t('adm.retention.error.endAction');
    case 'basis':
      return t('adm.retention.error.basis');
    case 'yearsRequired':
      return t('adm.retention.error.yearsRequired');
    case 'yearsNotAllowed':
      return t('adm.retention.error.yearsNotAllowed');
    case 'yearsRange':
      return t('adm.retention.error.yearsRange');
    case 'legalBasis':
      return t('adm.retention.error.legalBasis');
    case 'date':
      return t('adm.retention.error.date');
  }
}

export function findingMessage(t: T, code: FindingCode): string {
  switch (code) {
    case 'CLASS_FORMAT':
      return t('adm.retention.error.classFormat');
    case 'CLASS_UNKNOWN':
      return t('adm.retention.error.classUnknown');
    case 'END_ACTION_NOT_ALLOWED':
      return t('adm.retention.error.endAction');
    case 'BASIS_NOT_ALLOWED':
      return t('adm.retention.error.basis');
    case 'YEARS_REQUIRED':
      return t('adm.retention.error.yearsRequired');
    case 'YEARS_NOT_ALLOWED':
      return t('adm.retention.error.yearsNotAllowed');
    case 'YEARS_RANGE':
      return t('adm.retention.error.yearsRange');
    case 'LEGAL_BASIS_REQUIRED':
      return t('adm.retention.error.legalBasis');
    case 'DATE_INVALID':
      return t('adm.retention.error.date');
    case 'DATE_FUTURE':
      return t('adm.retention.error.dateFuture');
    case 'BELOW_PLATFORM_BASELINE':
      return t('adm.retention.error.belowBaseline');
  }
}

export function problemMessage(t: T, problem: ProblemView): string {
  switch (problem.reason) {
    case 'invalid':
      return t('adm.retention.problem.invalid');
    case 'conflict':
      return t('adm.retention.problem.conflict');
    case 'selfApproval':
      return t('adm.retention.problem.selfApproval');
    case 'notFound':
      return t('adm.retention.problem.notFound');
    case 'denied':
      return t('adm.retention.problem.denied');
    case 'session':
      return t('adm.retention.problem.session');
    case 'general':
      return t('adm.retention.problem.general');
  }
}

/** The tone of the status pill of a version of the policy: a draft waits (amber), the version in force is green, a replaced one grey. */
export function statusTone(status: PolicyStatus): Tone {
  switch (status) {
    case 'Draft':
      return 'warning';
    case 'Published':
      return 'success';
    case 'Superseded':
      return 'neutral';
  }
}
