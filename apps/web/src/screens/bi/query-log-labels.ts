import type { Translator } from '../../i18n';
import type { RunMode, RunStatus } from './query-log-model';

type T = Translator['t'];

export function runStatusLabel(t: T, status: RunStatus): string {
  switch (status) {
    case 'QUEUED':
      return t('bi.log.status.queued');
    case 'RUNNING':
      return t('bi.log.status.running');
    case 'COMPLETED':
      return t('bi.log.status.completed');
    case 'DENIED':
      return t('bi.log.status.denied');
    case 'FAILED':
      return t('bi.log.status.failed');
    case 'TIMEOUT':
      return t('bi.log.status.timeout');
    case 'CANCELLED':
      return t('bi.log.status.cancelled');
  }
}

export const runModeLabel = (t: T, mode: RunMode): string => (mode === 'SYNC' ? t('bi.log.mode.sync') : t('bi.log.mode.async'));
