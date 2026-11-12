import type { Translator } from '../../../i18n';
import type { AdoptReadiness, AdoptTask, Treatment } from './model';

type T = Translator['t'];

export function treatmentWord(t: T, treatment: Treatment | AdoptTask['treatment']): string {
  switch (treatment) {
    case 'TRACKED':
      return t('pwf.start.treatment.tracked.word');
    case 'NOT_TRACKED':
      return t('pwf.start.treatment.notTracked.word');
    case 'DONE':
      return t('pwf.start.treatment.done.word');
    case 'IN_PROGRESS':
      return t('pwf.start.treatment.inProgress.word');
    case 'EXCLUDED':
      return t('pwf.start.treatment.excluded.word');
  }
}

export function readinessText(t: T, readiness: AdoptReadiness, pending: number): string {
  switch (readiness) {
    case 'noDryRun':
      return t('pwf.start.ready.noDryRun.notice');
    case 'stale':
      return t('pwf.start.ready.stale.notice');
    case 'pending':
      return t('pwf.start.ready.pending.notice', { count: pending });
    case 'ready':
      return t('pwf.start.ready.ready.notice');
  }
}
