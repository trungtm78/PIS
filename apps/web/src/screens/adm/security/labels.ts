import type { Translator } from '../../../i18n';
import type { Tone } from '../../../ui';
import type { CertificateKind, CertificateStatus, FieldProblem, PolicyStatus, ProblemView } from './model';

type T = Translator['t'];

// Every key is written out so the i18n check can see it is in use.
export function kindLabel(t: T, kind: CertificateKind): string {
  return kind === 'PERSONAL' ? t('adm.certificates.kind.personal') : t('adm.certificates.kind.organization');
}

export function certificateStatusLabel(t: T, status: CertificateStatus): string {
  switch (status) {
    case 'Active':
      return t('adm.certificates.status.active');
    case 'Expired':
      return t('adm.certificates.status.expired');
    case 'Revoked':
      return t('adm.certificates.status.revoked');
    case 'Suspended':
      return t('adm.certificates.status.suspended');
  }
}

export function policyStatusLabel(t: T, status: PolicyStatus): string {
  switch (status) {
    case 'Draft':
      return t('adm.securityPolicy.status.draft');
    case 'Published':
      return t('adm.securityPolicy.status.published');
    case 'Superseded':
      return t('adm.securityPolicy.status.superseded');
  }
}

export function certificateFieldMessage(t: T, problem: FieldProblem): string {
  switch (problem) {
    case 'required':
      return t('adm.certificates.field.required');
    case 'tooLong':
      return t('adm.certificates.field.tooLong');
    case 'tooShort':
      return t('adm.certificates.field.tooShort');
    case 'range':
    case 'order':
      return t('adm.certificates.field.required');
  }
}

export function policyFieldMessage(t: T, problem: FieldProblem): string {
  switch (problem) {
    case 'required':
      return t('adm.securityPolicy.field.required');
    case 'range':
      return t('adm.securityPolicy.field.range');
    case 'order':
      return t('adm.securityPolicy.field.order');
    case 'tooLong':
      return t('adm.securityPolicy.field.tooLong');
    case 'tooShort':
      return t('adm.securityPolicy.field.required');
  }
}

export function certificateProblemMessage(t: T, problem: ProblemView): string {
  switch (problem.reason) {
    case 'certificateInvalid':
      return problem.field === 'valid_from' ? t('adm.certificates.error.notYetValid') : t('adm.certificates.error.invalid');
    case 'certificateExpired':
      return t('adm.certificates.error.expired');
    case 'certificateDuplicate':
      return t('adm.certificates.error.duplicate');
    case 'conflict':
      return t('adm.certificates.error.conflict');
    case 'stage':
      return t('adm.certificates.error.stage');
    case 'invalid':
      return t('adm.certificates.error.invalidRequest');
    case 'denied':
      return t('adm.certificates.error.denied');
    case 'notFound':
      return t('adm.certificates.error.notFound');
    case 'session':
      return t('adm.certificates.error.session');
    default:
      return t('adm.certificates.error.general');
  }
}

export function policyProblemMessage(t: T, problem: ProblemView): string {
  switch (problem.reason) {
    case 'policyInvalid':
      return problem.field === 'mfa_required_roles'
        ? t('adm.securityPolicy.error.roles')
        : problem.field === 'ip_allowlist'
          ? t('adm.securityPolicy.error.allowlist')
          : t('adm.securityPolicy.error.limits');
    case 'selfApproval':
      return t('adm.securityPolicy.error.selfApproval');
    case 'conflict':
      return t('adm.securityPolicy.error.conflict');
    case 'stage':
      return t('adm.securityPolicy.error.stage');
    case 'invalid':
      return t('adm.securityPolicy.error.invalidRequest');
    case 'denied':
      return t('adm.securityPolicy.error.denied');
    case 'notFound':
      return t('adm.securityPolicy.error.notFound');
    case 'session':
      return t('adm.securityPolicy.error.session');
    default:
      return t('adm.securityPolicy.error.general');
  }
}

/** The tone of the status pill of a certificate. */
export function certificateTone(status: CertificateStatus): Tone {
  switch (status) {
    case 'Active':
      return 'success';
    case 'Expired':
    case 'Revoked':
      return 'danger';
    case 'Suspended':
      return 'warning';
  }
}

/** The tone of the status pill of a version of the security policy. */
export function policyStatusTone(status: PolicyStatus): Tone {
  switch (status) {
    case 'Draft':
      return 'warning';
    case 'Published':
      return 'success';
    case 'Superseded':
      return 'neutral';
  }
}
