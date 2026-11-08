import type { Translator } from '../../../i18n';
import type { ArchiveProblem, FieldProblem } from './rules';
import type { DisposalBlocker, DossierStatus, RetentionClass, RuleSet, RuleStatus, StartBasis } from './types';

type T = Translator['t'];

export function dossierStatusLabel(t: T, status: DossierStatus): string {
  switch (status) {
    case 'OPEN':
      return t('doc.archive.status.open');
    case 'CLOSED':
      return t('doc.archive.status.closed');
    case 'HANDED_OVER':
      return t('doc.archive.status.handedOver');
    case 'ARCHIVED':
      return t('doc.archive.status.archived');
    case 'DISPOSAL_PROPOSED':
      return t('doc.archive.status.disposalProposed');
    case 'DISPOSED':
      return t('doc.archive.status.disposed');
  }
}

export function classLabel(t: T, code: RetentionClass): string {
  switch (code) {
    case 'PERMANENT':
      return t('doc.archive.class.permanent');
    case 'Y70':
      return t('doc.archive.class.y70');
    case 'Y20':
      return t('doc.archive.class.y20');
    case 'Y10':
      return t('doc.archive.class.y10');
    case 'Y5':
      return t('doc.archive.class.y5');
  }
}

export function ruleSetLabel(t: T, set: RuleSet): string {
  switch (set) {
    case 'TT74_2025_BTC':
      return t('doc.archive.ruleSet.tt74');
    case 'TT10_2022_BNV':
      return t('doc.archive.ruleSet.tt10');
    case 'TENANT_CUSTOM':
      return t('doc.archive.ruleSet.custom');
  }
}

export function startBasisLabel(t: T, basis: StartBasis): string {
  switch (basis) {
    case 'FROM_CLOSED':
      return t('doc.archive.basis.closed');
    case 'FROM_SETTLEMENT':
      return t('doc.archive.basis.settlement');
    case 'FROM_ISSUED':
      return t('doc.archive.basis.issued');
  }
}

export function ruleStatusLabel(t: T, status: RuleStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('doc.archive.ruleStatus.draft');
    case 'PUBLISHED':
      return t('doc.archive.ruleStatus.published');
    case 'SUPERSEDED':
      return t('doc.archive.ruleStatus.superseded');
  }
}

/** What stops the disposal of a dossier, in the words of the refusal of the same name. */
export function blockerMessage(t: T, blocker: DisposalBlocker): string {
  switch (blocker) {
    case 'DOSSIER_NOT_CLOSED':
      return problemMessage(t, 'notClosed');
    case 'RETENTION_PROVISIONAL':
      return problemMessage(t, 'provisional');
    case 'LEGAL_HOLD_ACTIVE':
      return problemMessage(t, 'hold');
    case 'RETENTION_NOT_EXPIRED':
      return problemMessage(t, 'notExpired');
  }
}

export function fieldMessage(t: T, problem: FieldProblem | undefined): string | undefined {
  switch (problem) {
    case undefined:
      return undefined;
    case 'required':
      return t('doc.archive.field.required.error');
    case 'invalid':
      return t('doc.archive.field.invalid.error');
    case 'tooShort':
      return t('doc.archive.field.tooShort.error');
    case 'tooLong':
      return t('doc.archive.field.tooLong.error');
  }
}

export function problemMessage(t: T, problem: ArchiveProblem): string {
  switch (problem) {
    case 'notClosed':
      return t('doc.archive.problem.notClosed');
    case 'provisional':
      return t('doc.archive.problem.provisional');
    case 'notExpired':
      return t('doc.archive.problem.notExpired');
    case 'hold':
      return t('doc.archive.problem.hold');
    case 'decisionDocument':
      return t('doc.archive.problem.decisionDocument');
    case 'transition':
      return t('doc.archive.problem.transition');
    case 'overlap':
      return t('doc.archive.problem.overlap');
    case 'state':
      return t('doc.archive.problem.state');
    case 'confirmationRef':
      return t('doc.archive.problem.confirmationRef');
    case 'legalBasis':
      return t('doc.archive.problem.legalBasis');
    case 'selfApproval':
      return t('doc.archive.problem.selfApproval');
    case 'conflict':
      return t('doc.archive.problem.conflict');
    case 'notOpen':
      return t('doc.archive.problem.notOpen');
    case 'empty':
      return t('doc.archive.problem.empty');
    case 'duplicateCode':
      return t('doc.archive.problem.duplicateCode');
    case 'notFileable':
      return t('doc.archive.problem.notFileable');
    case 'alreadyIn':
      return t('doc.archive.problem.alreadyIn');
    case 'letterState':
      return t('doc.archive.problem.letterState');
    case 'invalid':
      return t('doc.archive.problem.invalid');
    case 'scope':
      return t('doc.archive.problem.scope');
    case 'notFound':
      return t('doc.archive.problem.notFound');
    case 'general':
      return t('doc.archive.problem.general');
  }
}
