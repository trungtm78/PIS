import type { Translator } from '../../../i18n';
import type { Tone } from '../../../ui';
import type { InboxStatus, ProblemView } from './model';

type T = Translator['t'];

// Every key is written out so the i18n check can see it is in use.
export function inboxStatusLabel(t: T, status: InboxStatus): string {
  switch (status) {
    case 'RECEIVED':
      return t('adm.sync.status.received');
    case 'PROCESSING':
      return t('adm.sync.status.processing');
    case 'PROCESSED':
      return t('adm.sync.status.processed');
    case 'FAILED':
      return t('adm.sync.status.failed');
    case 'DEAD':
      return t('adm.sync.status.dead');
  }
}

/** A dead event is red, a failed one amber, one that is done the plain pill, one that waits grey. */
export function inboxStatusPill(status: InboxStatus): string {
  switch (status) {
    case 'DEAD':
      return 'pill red';
    case 'FAILED':
      return 'pill warn';
    case 'PROCESSED':
      return 'pill';
    case 'RECEIVED':
    case 'PROCESSING':
      return 'pill gray';
  }
}

export function problemMessage(t: T, problem: ProblemView): string {
  switch (problem.reason) {
    case 'stateInvalid':
      return t('adm.sync.problem.stateInvalid');
    case 'conflict':
      return t('adm.sync.problem.conflict');
    case 'notFound':
      return t('adm.sync.problem.notFound');
    case 'denied':
      return t('adm.sync.problem.denied');
    case 'invalid':
      return t('adm.sync.problem.invalid');
    case 'session':
      return t('adm.sync.problem.session');
    case 'general':
      return t('adm.sync.problem.general');
  }
}

/** The tone of the status pill of an inbound event: dead is red, failed amber, done green, waiting grey. */
export function inboxStatusTone(status: InboxStatus): Tone {
  switch (status) {
    case 'DEAD':
      return 'danger';
    case 'FAILED':
      return 'warning';
    case 'PROCESSED':
      return 'success';
    case 'RECEIVED':
    case 'PROCESSING':
      return 'neutral';
  }
}
