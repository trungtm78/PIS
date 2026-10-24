import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { useDoaMatrices, useRoleOptions } from './doa/hooks';
import { DoaWorkspace } from './DoaWorkspace';
import { useOrgUnits } from './org-tree/hooks';

// A tenant without a matrix still gets the form: an empty register is not the "empty" state of the screen.
const NEVER_EMPTY = (): boolean => false;
const NONE: never[] = [];

/** ADM-15: the delegation-of-authority matrix of the tenant (ST-ADM-011). */
export default function DoaMatrixScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const list = useDoaMatrices();
  const units = useOrgUnits();
  const roles = useRoleOptions();
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data, isEmpty: NEVER_EMPTY });
  return (
    <StateBoundary state={state} onRetry={() => void list.refetch()}>
      {units.isError || roles.isError ? (
        // The units and the roles fill the choices of a rule: without them a draft cannot be written, so the screen says why.
        <p className="callout warning" role="alert">
          {t('adm.doa.options.error')}
        </p>
      ) : null}
      <DoaWorkspace route={route} matrices={list.data ?? NONE} units={units.data ?? NONE} roles={roles.data ?? NONE} />
    </StateBoundary>
  );
}
