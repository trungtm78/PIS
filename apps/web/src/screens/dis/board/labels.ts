import type { Translator } from '../../../i18n';
import type { BoardProject, DrillState } from './model';

type T = Translator['t'];

export function stateLabel(t: T, state: DrillState): string {
  switch (state) {
    case 'MUST_REPORT':
      return t('dis.board.state.mustReport');
    case 'SUBMITTED':
      return t('dis.board.state.submitted');
    case 'LATE_SUBMITTED':
      return t('dis.board.state.lateSubmitted');
    case 'DRAFT':
      return t('dis.board.state.draft');
    case 'NOT_STARTED':
      return t('dis.board.state.notStarted');
    case 'OVERDUE':
      return t('dis.board.state.overdue');
  }
}

export const projectState = (t: T, project: BoardProject): string => (project.state === 'SUBMITTED' ? t('dis.board.state.submitted') : project.state === 'DRAFT' ? t('dis.board.state.draft') : t('dis.board.state.notStarted'));
