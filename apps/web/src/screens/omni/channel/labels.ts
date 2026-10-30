import type { Translator } from '../../../i18n';
import type { AccountStatus, FormField, ProblemView } from './model';

type T = Translator['t'];

export function channelLabel(t: T, channel: string): string {
  switch (channel) {
    case 'EMAIL':
      return t('omni.channel.channel.email');
    case 'SMS':
      return t('omni.channel.channel.sms');
    case 'PUSH_FCM':
      return t('omni.channel.channel.pushFcm');
    case 'PUSH_APNS':
      return t('omni.channel.channel.pushApns');
    case 'ZALO_OA':
      return t('omni.channel.channel.zaloOa');
    case 'ZALO_ZNS':
      return t('omni.channel.channel.zaloZns');
    case 'WHATSAPP':
      return t('omni.channel.channel.whatsapp');
    default:
      return channel;
  }
}

export function statusLabel(t: T, status: AccountStatus): string {
  switch (status) {
    case 'PendingVerification':
      return t('omni.channel.status.pending');
    case 'Active':
      return t('omni.channel.status.active');
    case 'Disabled':
      return t('omni.channel.status.disabled');
    case 'CredentialExpired':
      return t('omni.channel.status.expired');
  }
}

export function statusPill(status: AccountStatus): string {
  switch (status) {
    case 'Active':
      return 'pill';
    case 'PendingVerification':
    case 'CredentialExpired':
      return 'pill warn';
    case 'Disabled':
      return 'pill gray';
  }
}

export function fieldProblemMessage(t: T, field: FormField): string {
  switch (field) {
    case 'externalAccountId':
      return t('omni.channel.form.externalAccountId.invalid');
    case 'displayName':
      return t('omni.channel.form.displayName.invalid');
    case 'credentialSecretRef':
      return t('omni.channel.form.credentialSecretRef.invalid');
    case 'webhookSecretRef':
      return t('omni.channel.form.webhookSecretRef.invalid');
  }
}

/** Why the last verification failed, in words; a code nobody here knows is shown as it came. */
export function verificationErrorLabel(t: T, code: string): string {
  switch (code) {
    case 'CREDENTIAL_INVALID':
      return t('omni.config.error.credentialInvalid');
    case 'WEBHOOK_REJECTED':
      return t('omni.config.error.webhookRejected');
    case 'PROVIDER_UNREACHABLE':
      return t('omni.config.error.unreachable');
    case 'PROVIDER_NOT_CONFIGURED':
      return t('omni.config.error.notConfigured');
    case 'VERIFICATION_REFUSED':
      return t('omni.config.error.refused');
    default:
      return code;
  }
}

export function problemMessage(t: T, problem: ProblemView): string {
  switch (problem.reason) {
    case 'invalid':
      return problem.field === undefined ? t('omni.channel.problem.invalid') : t('omni.channel.problem.invalidAt', { field: problem.field });
    case 'exists':
      return t('omni.channel.problem.exists');
    case 'state':
      return t('omni.channel.problem.state');
    case 'conflict':
      return t('omni.channel.problem.conflict');
    case 'denied':
      return t('omni.channel.problem.denied');
    case 'notFound':
      return t('omni.channel.problem.notFound');
    case 'session':
      return t('omni.channel.problem.session');
    case 'general':
      return t('omni.channel.problem.general');
  }
}
