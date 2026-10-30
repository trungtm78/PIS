import type { Translator } from '../../../i18n';
import type { Channel, Classification, Priority, ProblemView, WorkflowStatus } from './model';

type T = Translator['t'];

export function classificationLabel(t: T, value: Classification): string {
  switch (value) {
    case 'PUBLIC':
      return t('not.workflow.classification.public');
    case 'INTERNAL':
      return t('not.workflow.classification.internal');
    case 'CONFIDENTIAL':
      return t('not.workflow.classification.confidential');
    case 'PERSONAL':
      return t('not.workflow.classification.personal');
  }
}

export function priorityLabel(t: T, value: string): string {
  switch (value as Priority) {
    case 'CRITICAL':
      return t('not.workflow.priority.critical');
    case 'HIGH':
      return t('not.workflow.priority.high');
    case 'NORMAL':
      return t('not.workflow.priority.normal');
    case 'LOW':
      return t('not.workflow.priority.low');
    default:
      return value;
  }
}

export function channelLabel(t: T, value: string): string {
  switch (value as Channel) {
    case 'IN_APP':
      return t('not.workflow.channel.inApp');
    case 'EMAIL':
      return t('not.workflow.channel.email');
    case 'SMS':
      return t('not.workflow.channel.sms');
    case 'PUSH_FCM':
      return t('not.workflow.channel.pushFcm');
    case 'PUSH_APNS':
      return t('not.workflow.channel.pushApns');
    default:
      return value;
  }
}

export function purposeLabel(t: T, value: string): string {
  switch (value) {
    case 'OPERATIONAL':
      return t('not.workflow.purpose.operational');
    case 'SECURITY':
      return t('not.workflow.purpose.security');
    case 'REMINDER':
      return t('not.workflow.purpose.reminder');
    case 'ANNOUNCEMENT':
      return t('not.workflow.purpose.announcement');
    case 'DIGEST':
      return t('not.workflow.purpose.digest');
    case 'SUPPORT_CONVERSATION':
      return t('not.workflow.purpose.support');
    default:
      return value;
  }
}

export function statusLabel(t: T, value: WorkflowStatus): string {
  switch (value) {
    case 'Draft':
      return t('not.workflow.status.draft');
    case 'Published':
      return t('not.workflow.status.published');
    case 'Superseded':
      return t('not.workflow.status.superseded');
    case 'Retired':
      return t('not.workflow.status.retired');
  }
}

export function statusPill(value: WorkflowStatus): string {
  return value === 'Published' ? 'pill' : value === 'Draft' ? 'pill warn' : 'pill gray';
}

export function problemMessage(t: T, problem: ProblemView): string {
  switch (problem.reason) {
    case 'eventType':
      return t('not.workflow.problem.eventType');
    case 'definition':
      return problem.field === undefined ? t('not.workflow.problem.definition') : t('not.workflow.problem.definitionAt', { field: problem.field });
    case 'self':
      return t('not.workflow.problem.self');
    case 'conflict':
      return t('not.workflow.problem.conflict');
    case 'notDraft':
      return t('not.workflow.problem.notDraft');
    case 'invalid':
      return problem.field === undefined ? t('not.workflow.problem.invalid') : t('not.workflow.problem.invalidAt', { field: problem.field });
    case 'denied':
      return t('not.workflow.problem.denied');
    case 'notFound':
      return t('not.workflow.problem.notFound');
    case 'session':
      return t('not.workflow.problem.session');
    case 'general':
      return t('not.workflow.problem.general');
  }
}
