import type { Translator } from '../../../i18n';
import type { AuditOutcome, ExportProblem, FilterProblem, ProblemView, SealReason } from './model';

type T = Translator['t'];

// Every key is written out so the i18n check can see it is in use.
export function outcomeLabel(t: T, outcome: AuditOutcome): string {
  switch (outcome) {
    case 'SUCCESS':
      return t('adm.audit.outcome.success');
    case 'DENIED':
      return t('adm.audit.outcome.denied');
    case 'FAILED':
      return t('adm.audit.outcome.failed');
  }
}

/** The pill of an outcome: a refusal is red, a failure amber, a success the plain pill. */
export function outcomePill(outcome: AuditOutcome): string {
  switch (outcome) {
    case 'SUCCESS':
      return 'pill';
    case 'DENIED':
      return 'pill red';
    case 'FAILED':
      return 'pill warn';
  }
}

export function sealReasonLabel(t: T, reason: SealReason): string {
  switch (reason) {
    case 'ROOT_MISMATCH':
      return t('adm.audit.seal.reason.root');
    case 'SEAL_HASH_MISMATCH':
      return t('adm.audit.seal.reason.hash');
    case 'CHAIN_LINK_MISMATCH':
      return t('adm.audit.seal.reason.link');
    case 'UNSEALED_ROW_IN_GAP':
      return t('adm.audit.seal.reason.gap');
  }
}

export function filterMessage(t: T, problem: FilterProblem): string {
  switch (problem) {
    case 'invalid':
      return t('adm.audit.filter.invalid.error');
    case 'order':
      return t('adm.audit.filter.order.error');
    case 'tooLong':
      return t('adm.audit.filter.tooLong.error');
  }
}

export function exportFieldMessage(t: T, problem: ExportProblem): string {
  switch (problem) {
    case 'required':
      return t('adm.audit.export.required.error');
    case 'invalid':
      return t('adm.audit.export.invalid.error');
    case 'order':
      return t('adm.audit.export.order.error');
    case 'range':
      return t('adm.audit.export.range.error');
  }
}

export function problemMessage(t: T, problem: ProblemView): string {
  switch (problem.reason) {
    case 'rangeTooLarge':
      return t('adm.audit.problem.rangeTooLarge');
    case 'invalid':
      return t('adm.audit.problem.invalid');
    case 'denied':
      return t('adm.audit.problem.denied');
    case 'notClean':
      return t('adm.audit.problem.notClean');
    case 'session':
      return t('adm.audit.problem.session');
    case 'general':
      return t('adm.audit.problem.general');
  }
}
