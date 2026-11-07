import type { Translator } from '../../i18n';
import type { CertReason, CertStatus, Move } from './certification-model';

type T = Translator['t'];

/** The four words of a certification state; never colour alone. */
export function certStatusLabel(t: T, status: CertStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('govc.bi.status.draft');
    case 'CONFIRMED':
      return t('govc.bi.status.confirmed');
    case 'CERTIFIED':
      return t('govc.bi.status.certified');
    case 'OBSOLETE':
      return t('govc.bi.status.obsolete');
  }
}

export function moveLabel(t: T, move: Move): string {
  switch (move) {
    case 'CONFIRM':
      return t('govc.bi.move.confirm');
    case 'CERTIFY':
      return t('govc.bi.move.certify');
    case 'RETURN':
      return t('govc.bi.move.return');
    case 'OBSOLETE':
      return t('govc.bi.move.obsolete');
  }
}

/** What the dialog tells the person will happen, before they confirm. */
export function moveEffect(t: T, move: Move): string {
  switch (move) {
    case 'CONFIRM':
      return t('govc.bi.effect.confirm');
    case 'CERTIFY':
      return t('govc.bi.effect.certify');
    case 'RETURN':
      return t('govc.bi.effect.return');
    case 'OBSOLETE':
      return t('govc.bi.effect.obsolete');
  }
}

/** The refusal of the server in words, with the field it names when it names one. */
export function certProblemMessage(t: T, reason: CertReason, field: string): string {
  switch (reason) {
    case 'selfApproval':
      return t('govc.bi.refused.selfApproval');
    case 'stage':
      return t('govc.bi.refused.stage');
    case 'notFound':
      return t('govc.bi.refused.notFound');
    case 'invalid':
      return t('govc.bi.refused.invalid', { field });
    case 'denied':
      return t('govc.bi.refused.denied');
    case 'session':
      return t('govc.bi.refused.session');
    case 'general':
      return t('govc.bi.refused.general');
  }
}
