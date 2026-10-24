import type { useTranslation } from '../../i18n';
import { fieldProblemMessage } from './labels';
import type { SuccessionKind, SuccessionProblem, StructureState } from './succession-model';

type Translate = ReturnType<typeof useTranslation>['t'];

/** The name of a kind of succession; the code itself (MERGE, SPLIT, ...) is shown beside it on the connectors. */
export function successionKindLabel(t: Translate, kind: SuccessionKind): string {
  switch (kind) {
    case 'MERGE':
      return t('mdm.value.successionKind.merge');
    case 'SPLIT':
      return t('mdm.value.successionKind.split');
    case 'RENAME':
      return t('mdm.value.successionKind.rename');
    case 'RELEVEL':
      return t('mdm.value.successionKind.relevel');
    case 'ABOLISH_LEVEL':
      return t('mdm.value.successionKind.abolishLevel');
  }
}

/** Where an entry stood on a date. */
export function structureStateLabel(t: Translate, state: StructureState): string {
  switch (state) {
    case 'IN_FORCE':
      return t('mdm.structure.state.inForce');
    case 'SUCCEEDED':
      return t('mdm.structure.state.succeeded');
    case 'NOT_STARTED':
      return t('mdm.structure.state.notStarted');
    case 'ENDED':
      return t('mdm.structure.state.ended');
  }
}

export function successionProblemMessage(t: Translate, problem: SuccessionProblem): string {
  switch (problem) {
    case 'invalidShare':
      return t('mdm.succession.invalidShare.error');
    case 'sameEntry':
      return t('mdm.succession.sameEntry.error');
    default:
      return fieldProblemMessage(t, problem);
  }
}
