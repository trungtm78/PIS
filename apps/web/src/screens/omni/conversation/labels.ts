import type { Translator } from '../../../i18n';
import type { Tone } from '../../../ui';
import type { ConversationStatus, ProblemView } from './model';

type T = Translator['t'];

export function statusLabel(t: T, value: ConversationStatus): string {
  switch (value) {
    case 'New':
      return t('omni.inbox.status.new');
    case 'Assigned':
      return t('omni.inbox.status.assigned');
    case 'InProgress':
      return t('omni.inbox.status.inProgress');
    case 'PendingCustomer':
      return t('omni.inbox.status.pending');
    case 'Resolved':
      return t('omni.inbox.status.resolved');
    case 'Closed':
      return t('omni.inbox.status.closed');
  }
}

/** The tone of the pill of a conversation: a new one waits for a first answer (blue), one in work is green, one that is over is plain. */
export function statusTone(value: ConversationStatus): Tone {
  switch (value) {
    case 'New':
      return 'info';
    case 'Resolved':
    case 'Closed':
      return 'neutral';
    default:
      return 'success';
  }
}

export function statusPill(value: ConversationStatus): string {
  switch (value) {
    case 'New':
      return 'pill warn';
    case 'Resolved':
    case 'Closed':
      return 'pill';
    default:
      return 'pill ok';
  }
}

export function channelLabel(t: T, value: string): string {
  switch (value) {
    case 'EMAIL':
      return t('omni.inbox.channel.email');
    case 'SMS':
      return t('omni.inbox.channel.sms');
    case 'ZALO_OA':
    case 'ZALO_ZNS':
      return t('omni.inbox.channel.zalo');
    case 'WHATSAPP':
      return t('omni.inbox.channel.whatsapp');
    default:
      return value;
  }
}

export function problemMessage(t: T, problem: ProblemView): string {
  switch (problem.reason) {
    case 'invalid':
      return t('omni.inbox.problem.invalid');
    case 'notEligible':
      return t('omni.inbox.problem.notEligible');
    case 'state':
      return t('omni.inbox.problem.state');
    case 'conflict':
      return t('omni.inbox.problem.conflict');
    case 'denied':
      return t('omni.inbox.problem.denied');
    case 'notFound':
      return t('omni.inbox.problem.notFound');
    case 'session':
      return t('omni.inbox.problem.session');
    case 'general':
      return t('omni.inbox.problem.general');
  }
}
