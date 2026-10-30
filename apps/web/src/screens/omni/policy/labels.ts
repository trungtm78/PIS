import type { Translator } from '../../../i18n';
import type { PolicyProblem, PolicyStatus, Priority, ProblemView, ReplyField } from './model';

type T = Translator['t'];

export function statusLabel(t: T, value: PolicyStatus): string {
  switch (value) {
    case 'Draft':
      return t('omni.policy.status.draft');
    case 'Published':
      return t('omni.policy.status.published');
    case 'Superseded':
      return t('omni.policy.status.superseded');
  }
}

export function statusPill(value: PolicyStatus): string {
  return value === 'Published' ? 'pill ok' : value === 'Draft' ? 'pill warn' : 'pill gray';
}

export function priorityLabel(t: T, value: Priority): string {
  switch (value) {
    case 'HIGH':
      return t('omni.policy.priority.high');
    case 'NORMAL':
      return t('omni.policy.priority.normal');
    case 'LOW':
      return t('omni.policy.priority.low');
  }
}

export function channelLabel(t: T, value: string): string {
  switch (value) {
    case 'EMAIL':
      return t('omni.policy.channel.email');
    case 'SMS':
      return t('omni.policy.channel.sms');
    case 'ZALO_OA':
      return t('omni.policy.channel.zalo');
    case 'WHATSAPP':
      return t('omni.policy.channel.whatsapp');
    default:
      return value;
  }
}

export function classificationLabel(t: T, value: string): string {
  switch (value) {
    case 'PUBLIC':
      return t('omni.reply.class.public');
    case 'INTERNAL':
      return t('omni.reply.class.internal');
    default:
      return value;
  }
}

export function policyProblemMessage(t: T, problem: PolicyProblem): string {
  switch (problem) {
    case 'calendar':
      return t('omni.policy.form.calendar.invalid');
    case 'firstResponse':
      return t('omni.policy.form.first.invalid');
    case 'resolution':
      return t('omni.policy.form.resolution.invalid');
    case 'ruleUnit':
      return t('omni.policy.rule.unit.invalid');
  }
}

export function problemMessage(t: T, problem: ProblemView, scope: 'policy' | 'reply'): string {
  switch (problem.reason) {
    case 'invalid':
      return scope === 'policy' ? t('omni.policy.problem.invalid') : t('omni.reply.problem.invalid');
    case 'calendar':
      return t('omni.policy.problem.calendar');
    case 'taken':
      return t('omni.reply.problem.taken');
    case 'state':
      return t('omni.policy.problem.state');
    case 'conflict':
      return t('omni.policy.problem.conflict');
    case 'denied':
      return t('omni.policy.problem.denied');
    case 'notFound':
      return t('omni.policy.problem.notFound');
    case 'session':
      return t('omni.policy.problem.session');
    case 'general':
      return t('omni.policy.problem.general');
  }
}

/** The reason a field of the reply form is refused for, written next to the field. */
export function replyFieldMessage(t: T, field: ReplyField, reason: 'invalid' | 'variable' | 'class'): string {
  if (reason === 'variable') return t('omni.reply.field.body.variable');
  if (reason === 'class') return t('omni.reply.field.class.invalid');
  switch (field) {
    case 'code':
      return t('omni.reply.field.code.invalid');
    case 'title':
      return t('omni.reply.field.title.invalid');
    case 'bodyText':
      return t('omni.reply.field.body.invalid');
    case 'channels':
      return t('omni.reply.field.channels.invalid');
    case 'classification':
      return t('omni.reply.field.class.invalid');
  }
}
