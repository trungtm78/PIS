import type { Translator } from '../../../i18n';
import type { FormProblem, ProblemView, TemplateStatus } from './model';

type T = Translator['t'];

export function channelLabel(t: T, channel: string): string {
  switch (channel) {
    case 'IN_APP':
      return t('not.template.channel.inApp');
    case 'EMAIL':
      return t('not.template.channel.email');
    case 'SMS':
      return t('not.template.channel.sms');
    case 'PUSH_FCM':
      return t('not.template.channel.pushFcm');
    case 'PUSH_APNS':
      return t('not.template.channel.pushApns');
    case 'ZALO_ZNS':
      return t('not.template.channel.zns');
    case 'ZALO_OA':
      return t('not.template.channel.zaloOa');
    case 'WHATSAPP':
      return t('not.template.channel.whatsapp');
    default:
      return channel;
  }
}

export function statusLabel(t: T, status: TemplateStatus): string {
  switch (status) {
    case 'Draft':
      return t('not.template.status.draft');
    case 'InReview':
      return t('not.template.status.inReview');
    case 'PendingProvider':
      return t('not.template.status.pendingProvider');
    case 'Active':
      return t('not.template.status.active');
    case 'Rejected':
      return t('not.template.status.rejected');
    case 'Retired':
      return t('not.template.status.retired');
  }
}

export function statusPill(status: TemplateStatus): string {
  switch (status) {
    case 'Active':
      return 'pill';
    case 'Draft':
    case 'InReview':
    case 'PendingProvider':
      return 'pill warn';
    case 'Rejected':
      return 'pill red';
    case 'Retired':
      return 'pill gray';
  }
}

export function typeLabel(t: T, type: string): string {
  switch (type) {
    case 'string':
      return t('not.template.type.string');
    case 'number':
      return t('not.template.type.number');
    case 'integer':
      return t('not.template.type.integer');
    case 'boolean':
      return t('not.template.type.boolean');
    case 'money':
      return t('not.template.type.money');
    default:
      return type;
  }
}

export function classificationLabel(t: T, value: string): string {
  switch (value) {
    case 'PUBLIC':
      return t('not.template.classification.public');
    case 'INTERNAL':
      return t('not.template.classification.internal');
    case 'CONFIDENTIAL':
      return t('not.template.classification.confidential');
    case 'PERSONAL':
      return t('not.template.classification.personal');
    default:
      return value;
  }
}

export function formProblemMessage(t: T, problem: FormProblem): string {
  switch (problem.field) {
    case 'code':
      return t('not.template.form.code.invalid');
    case 'body':
      return t('not.template.form.body.invalid');
    case 'subject':
      return t('not.template.form.subject.invalid');
    case 'variables':
      return t('not.template.form.variables.invalid');
    case 'undeclared':
      return t('not.template.form.undeclared.invalid', { name: problem.name });
    case 'classified':
      return t('not.template.form.classified.invalid', { name: problem.name });
    case 'pushVariable':
      return t('not.template.form.pushVariable.invalid', { name: problem.name });
    case 'pushLength':
      return t('not.template.form.pushLength.invalid');
  }
}

export function problemMessage(t: T, problem: ProblemView): string {
  switch (problem.reason) {
    case 'invalid':
      return problem.field === undefined ? t('not.template.problem.invalid') : t('not.template.problem.invalidAt', { field: problem.field });
    case 'classified':
      return t('not.template.problem.classified', { variable: problem.field ?? '' });
    case 'immutable':
      return t('not.template.problem.immutable');
    case 'providerPending':
      return t('not.template.problem.providerPending');
    case 'self':
      return t('not.template.problem.self');
    case 'conflict':
      return t('not.template.problem.conflict');
    case 'recipient':
      return t('not.template.problem.recipient');
    case 'account':
      return t('not.template.problem.account');
    case 'provider':
      return t('not.template.problem.provider');
    case 'denied':
      return t('not.template.problem.denied');
    case 'notFound':
      return t('not.template.problem.notFound');
    case 'session':
      return t('not.template.problem.session');
    case 'general':
      return t('not.template.problem.general');
  }
}
