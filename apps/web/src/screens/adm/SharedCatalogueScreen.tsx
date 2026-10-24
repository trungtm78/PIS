import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { useRecords } from '../mdm/hooks';
import { mayOpenCatalogues } from './catalogues/model';
import { SharedCatalogueWorkspace } from './SharedCatalogueWorkspace';

const NONE: never[] = [];

/** ADM-05: the shared catalogues of the tenant, read from master data and linked to its routes by permission (ST-ADM-019). */
export default function SharedCatalogueScreen({ route }: ScreenProps) {
  const { permissions } = useSession();
  const canOpen = mayOpenCatalogues(permissions);
  // Without the permission to read master data nothing is requested and the screen is denied, not empty.
  const records = useRecords(undefined, canOpen);
  const queryState = useScreenState({ isLoading: records.isLoading, error: records.error ?? undefined, data: records.data });
  const state = canOpen ? queryState : 'denied';
  return (
    <StateBoundary state={state} onRetry={() => void records.refetch()}>
      <SharedCatalogueWorkspace route={route} records={records.data ?? NONE} />
    </StateBoundary>
  );
}
