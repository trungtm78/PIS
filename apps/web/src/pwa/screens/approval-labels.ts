import type { Translator } from '../../i18n';
import { businessTypeLabel } from '../../screens/adm/approvals/labels';
import type { Bucket, Level } from './approval-detail-model';

type T = Translator['t'];

/** The name of a funding cell, "bucket, level"; every key is written out so the i18n check can see it is in use. */
export function cellTitle(t: T, bucket: Bucket, level: Level): string {
  const bucketName = bucket === 'CURRENT_YEAR' ? t('pwa2.report.bucket.currentYear') : bucket === 'CARRYOVER' ? t('pwa2.report.bucket.carryover') : t('pwa2.report.bucket.other');
  const levelName = level === 'CENTRAL' ? t('pwa2.report.level.central') : t('pwa2.report.level.local');
  return t('pwa2.report.cell.title', { bucket: bucketName, level: levelName });
}

/** The name of the kind of record of a task of the engine: the five of the tenant's workflows, and the response to a score (PWF), which the workflow list of ADM does not carry. Never the code. */
export function approvalTypeLabel(t: T, code: string): string {
  return code === 'score.response' ? t('fix12.inbox.kind.response') : businessTypeLabel(t, code);
}

/** The state of an approval task as the server names it. */
export function taskStatusLabel(t: T, status: string): string {
  switch (status) {
    case 'Pending':
      return t('pwa2.approvalDetail.taskStatus.pending');
    case 'Decided':
      return t('pwa2.approvalDetail.taskStatus.decided');
    case 'Reassigned':
      return t('pwa2.approvalDetail.taskStatus.reassigned');
    case 'Cancelled':
      return t('pwa2.approvalDetail.taskStatus.cancelled');
    default:
      return t('pwa2.approvalDetail.taskStatus.expired');
  }
}
