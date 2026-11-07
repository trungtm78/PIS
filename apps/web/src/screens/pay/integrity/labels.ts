import type { Translator } from '../../../i18n';
import type { ExceptionStatus, Outcome } from './model';

type T = Translator['t'];

/** Every key is written out, so that the i18n check can see it is in use. */
export function codeLabel(t: T, code: string): string {
  switch (code) {
    case 'DUPLICATE_CLAIM':
      return t('govd.integrity.code.duplicate');
    case 'UNIT_PRICE_OUTLIER':
      return t('govd.integrity.code.price');
    case 'QUANTITY_VS_DIARY':
      return t('govd.integrity.code.diary');
    case 'EXCEEDS_CONTRACT':
      return t('govd.integrity.code.contract');
    case 'EXCEEDS_PLAN':
      return t('govd.integrity.code.plan');
    case 'EXCEEDS_ACCEPTED':
      return t('govd.integrity.code.accepted');
    default:
      return code;
  }
}

/** What a finding means for the reader, in one sentence (the formula of the rule is under it). */
export function codeMeaning(t: T, code: string): string {
  switch (code) {
    case 'DUPLICATE_CLAIM':
      return t('govd.integrity.meaning.duplicate');
    case 'UNIT_PRICE_OUTLIER':
      return t('govd.integrity.meaning.price');
    case 'QUANTITY_VS_DIARY':
      return t('govd.integrity.meaning.diary');
    case 'EXCEEDS_CONTRACT':
      return t('govd.integrity.meaning.contract');
    case 'EXCEEDS_PLAN':
      return t('govd.integrity.meaning.plan');
    case 'EXCEEDS_ACCEPTED':
      return t('govd.integrity.meaning.accepted');
    default:
      return '';
  }
}

export function outcomeLabel(t: T, outcome: Outcome | string): string {
  switch (outcome) {
    case 'PASSED':
      return t('govd.integrity.outcome.passed');
    case 'SIGNALS':
      return t('govd.integrity.outcome.signals');
    case 'BLOCKED':
      return t('govd.integrity.outcome.blocked');
    case 'PARTIAL':
      return t('govd.integrity.outcome.partial');
    default:
      return outcome;
  }
}

export function statusLabel(t: T, status: ExceptionStatus): string {
  switch (status) {
    case 'REQUESTED':
      return t('govd.integrity.exception.status.requested');
    case 'APPROVED':
      return t('govd.integrity.exception.status.approved');
    case 'REJECTED':
      return t('govd.integrity.exception.status.rejected');
    case 'REVOKED':
      return t('govd.integrity.exception.status.revoked');
    case 'USED':
      return t('govd.integrity.exception.status.used');
    case 'EXPIRED':
      return t('govd.integrity.exception.status.expired');
  }
}

export function ceilingLabel(t: T, ceiling: string): string {
  switch (ceiling) {
    case 'EXCEEDS_PLAN':
      return t('govd.integrity.code.plan');
    case 'EXCEEDS_CONTRACT':
      return t('govd.integrity.code.contract');
    case 'EXCEEDS_ACCEPTED':
      return t('govd.integrity.code.accepted');
    default:
      return ceiling;
  }
}

export function sourceLabel(t: T, source: string): string {
  switch (source) {
    case 'DIARY':
      return t('govd.integrity.source.diary');
    case 'PRICES':
      return t('govd.integrity.source.prices');
    case 'DUPLICATES':
      return t('govd.integrity.source.duplicates');
    case 'CEILINGS':
      return t('govd.integrity.source.ceilings');
    default:
      return source;
  }
}

export function figureLabel(t: T, key: string): string {
  switch (key) {
    case 'priceVnd':
      return t('govd.integrity.figure.priceVnd');
    case 'projectedRequestedVnd':
      return t('govd.integrity.figure.projectedRequestedVnd');
    case 'projectedCashOutVnd':
      return t('govd.integrity.figure.projectedCashOutVnd');
    case 'overByVnd':
      return t('govd.integrity.figure.overByVnd');
    case 'basis':
      return t('govd.integrity.figure.basis');
    case 'allocatedVnd':
      return t('govd.integrity.figure.allocatedVnd');
    case 'disbursedVnd':
      return t('govd.integrity.figure.disbursedVnd');
    case 'inFlightVnd':
      return t('govd.integrity.figure.inFlightVnd');
    case 'netVnd':
      return t('govd.integrity.figure.netVnd');
    case 'availableVnd':
      return t('govd.integrity.figure.availableVnd');
    case 'acceptedVnd':
      return t('govd.integrity.figure.acceptedVnd');
    case 'projectedClaimedVnd':
      return t('govd.integrity.figure.projectedClaimedVnd');
    case 'matched':
      return t('govd.integrity.figure.matched');
    case 'grossVnd':
      return t('govd.integrity.figure.grossVnd');
    case 'otherGrossVnd':
      return t('govd.integrity.figure.otherGrossVnd');
    case 'unitPrice':
      return t('govd.integrity.figure.unitPrice');
    case 'contractUnitPrice':
      return t('govd.integrity.figure.contractUnitPrice');
    case 'contractDeviationPct':
      return t('govd.integrity.figure.contractDeviationPct');
    case 'peerMedian':
      return t('govd.integrity.figure.peerMedian');
    case 'peerCount':
      return t('govd.integrity.figure.peerCount');
    case 'reasons':
      return t('govd.integrity.figure.reasons');
    case 'reason':
      return t('govd.integrity.figure.reason');
    case 'workingDays':
      return t('govd.integrity.figure.workingDays');
    case 'daysWithDiary':
      return t('govd.integrity.figure.daysWithDiary');
    case 'measured':
      return t('govd.integrity.figure.measured');
    case 'recorded':
      return t('govd.integrity.figure.recorded');
    default:
      return key;
  }
}
