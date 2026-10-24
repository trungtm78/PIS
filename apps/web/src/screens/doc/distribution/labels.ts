import type { Translator } from '../../../i18n';
import type { ProblemReason } from './problems';
import type { OverrideProblem } from './rules';
import type { Channel, DistributionStatus, DocumentStatus } from './types';

type T = Translator['t'];

// Every key is written out so the i18n check can see it is in use.
export function statusLabel(t: T, status: DocumentStatus): string {
  switch (status) {
    case 'SEALED':
      return t('doc.distribution.status.sealed');
    case 'ISSUED':
      return t('doc.distribution.status.issued');
    case 'DELIVERED':
      return t('doc.distribution.status.delivered');
    case 'ACKNOWLEDGED':
      return t('doc.distribution.status.acknowledged');
    case 'OTHER':
      return t('doc.distribution.status.other');
  }
}

export function distributionStatusLabel(t: T, status: DistributionStatus): string {
  switch (status) {
    case 'PENDING':
      return t('doc.distribution.rowStatus.pending');
    case 'SENT':
      return t('doc.distribution.rowStatus.sent');
    case 'DELIVERED':
      return t('doc.distribution.rowStatus.delivered');
    case 'ACKNOWLEDGED':
      return t('doc.distribution.rowStatus.acknowledged');
    case 'FAILED':
      return t('doc.distribution.rowStatus.failed');
    case 'CANCELLED':
      return t('doc.distribution.rowStatus.cancelled');
  }
}

/** The colour class of the pill of a row: a receipt is good, a failure needs a hand, the rest is on its way. */
export function distributionPill(status: DistributionStatus): string {
  switch (status) {
    case 'ACKNOWLEDGED':
    case 'DELIVERED':
      return 'pill';
    case 'FAILED':
      return 'pill red';
    case 'SENT':
    case 'PENDING':
      return 'pill warn';
    case 'CANCELLED':
      return 'pill gray';
  }
}

export function channelLabel(t: T, channel: Channel): string {
  switch (channel) {
    case 'INTERNAL':
      return t('doc.distribution.channel.internal');
    case 'EMAIL':
      return t('doc.distribution.channel.email');
    case 'PAPER_HANDOVER':
      return t('doc.distribution.channel.paper');
    case 'LGSP':
      return t('doc.distribution.channel.lgsp');
  }
}

/** The reason a row failed, in words when the code is one the server uses, otherwise the code itself. */
export function errorLabel(t: T, code: string): string {
  switch (code) {
    case 'PROVIDER_UNAVAILABLE':
      return t('doc.distribution.error.provider');
    case 'CHANNEL_ERROR':
      return t('doc.distribution.error.channel');
    case 'CHANNEL_NOT_SUPPORTED':
      return t('doc.distribution.error.unsupported');
    default:
      return code;
  }
}

export function overrideMessage(t: T, problem: OverrideProblem): string {
  switch (problem) {
    case 'required':
      return t('doc.distribution.reason.problem.required');
    case 'tooShort':
      return t('doc.distribution.reason.problem.tooShort');
    case 'tooLong':
      return t('doc.distribution.reason.problem.tooLong');
  }
}

export function problemMessage(t: T, reason: ProblemReason): string {
  switch (reason) {
    case 'conflict':
      return t('doc.distribution.problem.conflict');
    case 'state':
      return t('doc.distribution.problem.state');
    case 'signature':
      return t('doc.distribution.problem.signature');
    case 'incremental':
      return t('doc.distribution.problem.incremental');
    case 'chain':
      return t('doc.distribution.problem.chain');
    case 'time':
      return t('doc.distribution.problem.time');
    case 'revocation':
      return t('doc.distribution.problem.revocation');
    case 'template':
      return t('doc.distribution.problem.template');
    case 'recipient':
      return t('doc.distribution.problem.recipient');
    case 'channel':
      return t('doc.distribution.problem.channel');
    case 'distributionState':
      return t('doc.distribution.problem.distributionState');
    case 'receipt':
      return t('doc.distribution.problem.receipt');
    case 'invalid':
      return t('doc.distribution.problem.invalid');
    case 'notFound':
      return t('doc.distribution.problem.notFound');
    case 'denied':
      return t('doc.distribution.problem.denied');
    case 'session':
      return t('doc.distribution.problem.session');
    case 'general':
      return t('doc.distribution.problem.general');
  }
}
