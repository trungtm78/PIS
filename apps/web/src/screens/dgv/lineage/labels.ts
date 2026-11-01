import type { Translator } from '../../../i18n';
import type { Direction, LineageReason, NodeKind, QueryProblem } from './model';

type T = Translator['t'];

export function kindLabel(t: T, kind: NodeKind): string {
  switch (kind) {
    case 'SOURCE_SYSTEM':
      return t('dgv.lin.kind.source');
    case 'IMPORT_BATCH':
      return t('dgv.lin.kind.batch');
    case 'TABLE':
      return t('dgv.lin.kind.table');
    case 'RECORD':
      return t('dgv.lin.kind.record');
    case 'DATASET':
      return t('dgv.lin.kind.dataset');
    case 'DATASET_VERSION':
      return t('dgv.lin.kind.version');
    case 'METRIC_VERSION':
      return t('dgv.lin.kind.metric');
    case 'DASHBOARD_VERSION':
      return t('dgv.lin.kind.dashboard');
    case 'EXPORT':
      return t('dgv.lin.kind.export');
  }
}

export const directionLabel = (t: T, direction: Direction): string => (direction === 'upstream' ? t('dgv.lin.direction.up') : t('dgv.lin.direction.down'));

export const queryProblemMessage = (t: T, problem: QueryProblem): string => (problem === 'required' ? t('dgv.lin.ref.required') : t('dgv.lin.ref.invalid'));

export function reasonMessage(t: T, reason: LineageReason): string {
  switch (reason) {
    case 'notFound':
      return t('dgv.lin.reason.notFound');
    case 'scope':
      return t('dgv.lin.reason.scope');
    case 'invalid':
      return t('dgv.lin.reason.invalid');
    case 'general':
      return t('dgv.lin.reason.general');
  }
}
