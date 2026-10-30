import type { Translator } from '../../../i18n';
import type { DeliveryStatus, Direction, ProblemView, Purpose } from './model';

type T = Translator['t'];

export function directionLabel(t: T, value: Direction): string {
  switch (value) {
    case 'INBOUND':
      return t('omni.thread.direction.inbound');
    case 'OUTBOUND':
      return t('omni.thread.direction.outbound');
    case 'INTERNAL_NOTE':
      return t('omni.thread.direction.note');
  }
}

export function deliveryLabel(t: T, value: DeliveryStatus): string {
  switch (value) {
    case 'Queued':
      return t('omni.thread.delivery.queued');
    case 'ProviderAccepted':
      return t('omni.thread.delivery.accepted');
    case 'Delivered':
      return t('omni.thread.delivery.delivered');
    case 'Read':
      return t('omni.thread.delivery.read');
    case 'Failed':
      return t('omni.thread.delivery.failed');
  }
}

export function purposeLabel(t: T, value: Purpose): string {
  switch (value) {
    case 'SUPPORT_CONVERSATION':
      return t('omni.thread.purpose.support');
    case 'OPERATIONAL':
      return t('omni.thread.purpose.operational');
    case 'REMINDER':
      return t('omni.thread.purpose.reminder');
  }
}

export function problemMessage(t: T, problem: ProblemView): string {
  switch (problem.reason) {
    case 'invalid':
      return t('omni.thread.problem.invalid');
    case 'consent':
      return t('omni.thread.problem.consent');
    case 'optIn':
      return t('omni.thread.problem.optIn');
    case 'window':
      return t('omni.thread.problem.window');
    case 'account':
      return t('omni.thread.problem.account');
    case 'unverified':
      return t('omni.thread.problem.unverified');
    case 'content':
      return t('omni.thread.problem.content');
    case 'template':
      return t('omni.thread.problem.template');
    case 'state':
      return t('omni.thread.problem.state');
    case 'contact':
      return t('omni.thread.problem.contact');
    case 'conflict':
      return t('omni.thread.problem.conflict');
    case 'denied':
      return t('omni.thread.problem.denied');
    case 'notFound':
      return t('omni.thread.problem.notFound');
    case 'session':
      return t('omni.thread.problem.session');
    case 'general':
      return t('omni.thread.problem.general');
  }
}
