import { useSession } from '../../session/SessionContext';
import type { ScreenProps } from '../../routes/types';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ConnectorsWorkspace } from './ConnectorsWorkspace';
import { useConnectors } from './connectors/hooks';
import { READ_INTEGRATION_PERMISSION } from './connectors/model';

// A tenant without a connector still gets the form: an empty register is not the "empty" state of the screen.
const NEVER_EMPTY = (): boolean => false;

/** ADM-09: the integration connectors of the tenant and the honest status of each adapter (ST-ADM-018). */
export default function ConnectorsScreen({ route }: ScreenProps) {
  const { permissions } = useSession();
  const canRead = permissions === undefined || permissions.includes(READ_INTEGRATION_PERMISSION);
  const list = useConnectors(canRead);
  const queryState = useScreenState({ isLoading: list.isLoading, error: list.error ?? undefined, data: list.data, isEmpty: NEVER_EMPTY });
  // Without adm.integration.read nothing is requested and the screen is denied, not empty.
  const state = canRead ? queryState : 'denied';
  return (
    <StateBoundary state={state} onRetry={() => void list.refetch()}>
      <ConnectorsWorkspace route={route} connectors={list.data ?? []} />
    </StateBoundary>
  );
}
