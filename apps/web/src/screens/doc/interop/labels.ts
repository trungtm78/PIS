import type { useTranslation } from '../../../i18n';
import type { AdapterStatus, Direction, MessageStatus, Problem } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function statusLabel(t: Translate, status: MessageStatus): string {
  switch (status) {
    case 'QUEUED':
      return t('doc.interop.status.queued');
    case 'SENT':
      return t('doc.interop.status.sent');
    case 'ACKED':
      return t('doc.interop.status.acked');
    case 'REJECTED':
      return t('doc.interop.status.rejected');
    case 'FAILED':
      return t('doc.interop.status.failed');
    case 'DEAD':
      return t('doc.interop.status.dead');
    case 'RECEIVED':
      return t('doc.interop.status.received');
    case 'PROCESSED':
      return t('doc.interop.status.processed');
  }
}

/** The pill of a status: a message that arrived or was acknowledged is the plain pill, one that waits or failed for a while is amber, one that died or was refused is red. */
export function statusPill(status: MessageStatus): string {
  if (status === 'ACKED' || status === 'PROCESSED') return 'pill';
  return status === 'DEAD' || status === 'REJECTED' ? 'pill red' : 'pill warn';
}

export function directionLabel(t: Translate, direction: Direction): string {
  return direction === 'OUTBOUND' ? t('doc.interop.direction.outbound') : t('doc.interop.direction.inbound');
}

/** What the system knows of the adapter: only a VERIFIED one is a fact about the gateway of the agency; the others say so. */
export function adapterLabel(t: Translate, status: AdapterStatus): string {
  switch (status) {
    case 'VERIFIED':
      return t('doc.interop.adapter.verified');
    case 'PROPOSED':
      return t('doc.interop.adapter.proposed');
    case 'MOCK':
      return t('doc.interop.adapter.mock');
    case 'MISSING':
      return t('doc.interop.adapter.missing');
  }
}

/** The words of ADM-09: only a verified adapter is a plain pill; a mock one is red (it must not carry real letters), a proposed one amber, a missing one grey. */
export const adapterPill = (status: AdapterStatus): string => (status === 'VERIFIED' ? 'pill' : status === 'MOCK' ? 'pill red' : status === 'PROPOSED' ? 'pill warn' : 'pill gray');

/** What a refusal of the retry says. */
export function problemMessage(t: Translate, problem: Problem): string {
  switch (problem) {
    case 'versionConflict':
      return t('doc.interop.error.versionConflict');
    case 'stateInvalid':
      return t('doc.interop.error.stateInvalid');
    case 'notFound':
      return t('doc.interop.error.notFound');
    case 'denied':
      return t('doc.interop.error.denied');
    case 'session':
      return t('doc.interop.error.session');
    case 'general':
      return t('doc.interop.error.general');
  }
}
