import type { Translator } from '../../../i18n';
import type { Classification, ContactStatus, IdentityChannel, IdentityStatus, Method, ProblemView } from './model';

type T = Translator['t'];

export function classificationLabel(t: T, value: Classification): string {
  switch (value) {
    case 'CITIZEN':
      return t('omni.contact.class.citizen');
    case 'CONTRACTOR_STAFF':
      return t('omni.contact.class.contractor');
    case 'AGENCY_STAFF':
      return t('omni.contact.class.agency');
    case 'OTHER':
      return t('omni.contact.class.other');
  }
}

export function channelLabel(t: T, value: IdentityChannel): string {
  switch (value) {
    case 'PHONE':
      return t('omni.contact.channel.phone');
    case 'EMAIL':
      return t('omni.contact.channel.email');
    case 'ZALO':
      return t('omni.contact.channel.zalo');
    case 'WHATSAPP':
      return t('omni.contact.channel.whatsapp');
  }
}

export function contactStatusLabel(t: T, value: ContactStatus): string {
  switch (value) {
    case 'Unverified':
      return t('omni.contact.status.unverified');
    case 'Verified':
      return t('omni.contact.status.verified');
    case 'Merged':
      return t('omni.contact.status.merged');
    case 'Blocked':
      return t('omni.contact.status.blocked');
  }
}

export function identityStatusLabel(t: T, value: IdentityStatus): string {
  switch (value) {
    case 'Pending':
      return t('omni.contact.identity.pending');
    case 'Verified':
      return t('omni.contact.identity.verified');
    case 'Revoked':
      return t('omni.contact.identity.revoked');
  }
}

export function methodLabel(t: T, value: Method): string {
  switch (value) {
    case 'OTP':
      return t('omni.contact.method.otp');
    case 'PROVIDER_VERIFIED':
      return t('omni.contact.method.provider');
    case 'ADMIN_DOCUMENT':
      return t('omni.contact.method.document');
  }
}

export function problemMessage(t: T, problem: ProblemView, locale: string): string {
  switch (problem.reason) {
    case 'invalid':
      return problem.field === undefined ? t('omni.contact.problem.invalid') : t('omni.contact.problem.invalidAt', { field: problem.field });
    case 'taken':
      return t('omni.contact.problem.taken');
    case 'otp':
      return problem.lockedUntil === undefined ? t('omni.contact.problem.otp') : t('omni.contact.problem.locked', { until: new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(new Date(problem.lockedUntil)) });
    case 'ambiguous':
      return t('omni.contact.problem.ambiguous');
    case 'unverified':
      return t('omni.contact.problem.unverified');
    case 'state':
      return t('omni.contact.problem.state');
    case 'conflict':
      return t('omni.contact.problem.conflict');
    case 'denied':
      return t('omni.contact.problem.denied');
    case 'notFound':
      return t('omni.contact.problem.notFound');
    case 'session':
      return t('omni.contact.problem.session');
    case 'general':
      return t('omni.contact.problem.general');
  }
}
