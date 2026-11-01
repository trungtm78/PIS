import type { Translator } from '../../i18n';
import type { GranteeKind, ShareProblem, ShareReason, ShareRight, ShareState } from './share-model';

type T = Translator['t'];

export function granteeKindLabel(t: T, kind: GranteeKind): string {
  switch (kind) {
    case 'USER':
      return t('bi.share.kind.user');
    case 'ROLE':
      return t('bi.share.kind.role');
    case 'UNIT':
      return t('bi.share.kind.unit');
  }
}

export const rightLabel = (t: T, right: ShareRight): string => (right === 'EDIT' ? t('bi.share.right.edit') : t('bi.share.right.view'));

export const shareStateLabel = (t: T, state: ShareState): string => (state === 'ACTIVE' ? t('bi.share.status.active') : t('bi.share.status.revoked'));

export const shareProblemMessage = (t: T, problem: ShareProblem): string => (problem === 'required' ? t('bi.share.grantee.required') : t('bi.share.grantee.invalid'));

export function shareRefusalMessage(t: T, reason: ShareReason): string {
  switch (reason) {
    case 'outOfTenant':
      return t('bi.share.refusal.outOfTenant');
    case 'duplicate':
      return t('bi.share.refusal.duplicate');
    case 'self':
      return t('bi.share.refusal.self');
    case 'ended':
      return t('bi.share.refusal.ended');
    case 'conflict':
      return t('bi.share.refusal.conflict');
    case 'scope':
      return t('bi.share.refusal.scope');
    case 'notFound':
      return t('bi.share.refusal.notFound');
    case 'general':
      return t('bi.share.refusal.general');
  }
}
