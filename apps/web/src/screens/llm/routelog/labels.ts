import type { useTranslation } from '../../../i18n';
import type { ReconciliationStatus, RunProblem, VarianceDirection } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function statusLabel(t: Translate, status: ReconciliationStatus): string {
  switch (status) {
    case 'VARIANCE':
      return t('llm.routelog.rec.status.variance');
    case 'RECONCILED':
      return t('llm.routelog.rec.status.reconciled');
  }
}

export function directionLabel(t: Translate, direction: VarianceDirection): string {
  switch (direction) {
    case 'none':
      return t('llm.routelog.rec.dir.none');
    case 'higher':
      return t('llm.routelog.rec.dir.higher');
    case 'lower':
      return t('llm.routelog.rec.dir.lower');
  }
}

export function problemMessage(t: Translate, problem: RunProblem): string {
  switch (problem.reason) {
    case 'periodOpen':
      return t('llm.routelog.problem.periodOpen');
    case 'currency':
      return t('llm.routelog.problem.currency');
    case 'duplicate':
      return t('llm.routelog.problem.duplicate');
    case 'scope':
      return t('llm.routelog.problem.scope');
    case 'validation':
      return t('llm.routelog.problem.validation', { field: problem.detail });
    case 'general':
      return t('llm.routelog.problem.general');
  }
}
