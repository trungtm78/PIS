import type { Translator } from '../../../i18n';
import type { ProblemReason } from './problems';
import type { ReasonProblem } from './rules';
import type { DocumentStatus, Effect } from './types';

type T = Translator['t'];

// Every key is written out so the i18n check can see it is in use.
export function statusLabel(t: T, status: DocumentStatus): string {
  switch (status) {
    case 'ISSUED':
      return t('doc.recall.status.issued');
    case 'DELIVERED':
      return t('doc.recall.status.delivered');
    case 'ACKNOWLEDGED':
      return t('doc.recall.status.acknowledged');
    case 'FILED':
      return t('doc.recall.status.filed');
    case 'ARCHIVED':
      return t('doc.recall.status.archived');
    case 'RECALLED':
      return t('doc.recall.status.recalled');
    case 'NUMBERED':
      return t('doc.recall.status.numbered');
    case 'SEALED':
      return t('doc.recall.status.sealed');
    case 'OTHER':
      return t('doc.recall.status.other');
  }
}

export function effectLabel(t: T, effect: Effect): string {
  switch (effect) {
    case 'PENDING':
      return t('doc.recall.effect.pending');
    case 'EFFECTIVE':
      return t('doc.recall.effect.effective');
    case 'RECALLED':
      return t('doc.recall.effect.recalled');
    case 'OTHER':
      return t('doc.recall.effect.other');
  }
}

/** The colour class of the status pill: a recalled document is a red flag, a document in force is plain, one still on its way is a warning. */
export function statusPill(status: DocumentStatus): string {
  switch (status) {
    case 'RECALLED':
      return 'pill red';
    case 'NUMBERED':
    case 'SEALED':
      return 'pill warn';
    default:
      return 'pill';
  }
}

export function reasonMessage(t: T, problem: ReasonProblem): string {
  switch (problem) {
    case 'required':
      return t('doc.recall.reason.problem.required');
    case 'tooShort':
      return t('doc.recall.reason.problem.tooShort');
    case 'tooLong':
      return t('doc.recall.reason.problem.tooLong');
  }
}

export function problemMessage(t: T, reason: ProblemReason): string {
  switch (reason) {
    case 'conflict':
      return t('doc.recall.problem.conflict');
    case 'state':
      return t('doc.recall.problem.state');
    case 'basis':
      return t('doc.recall.problem.basis');
    case 'selfApproval':
      return t('doc.recall.problem.selfApproval');
    case 'approver':
      return t('doc.recall.problem.approver');
    case 'invalid':
      return t('doc.recall.problem.invalid');
    case 'notFound':
      return t('doc.recall.problem.notFound');
    case 'denied':
      return t('doc.recall.problem.denied');
    case 'session':
      return t('doc.recall.problem.session');
    case 'general':
      return t('doc.recall.problem.general');
  }
}
