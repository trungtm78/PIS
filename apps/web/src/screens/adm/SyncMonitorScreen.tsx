import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { useCursors } from '../mdm/hooks';
import { READ_INTEGRATION_PERMISSION } from './connectors/model';
import { useInboxEvents } from './inbox/hooks';
import { SyncMonitorWorkspace } from './SyncMonitorWorkspace';

const READ_CURSOR_PERMISSION = 'integration_cursor.read';
// A tenant with no event still shows where each connector has read to: an empty inbox is not the "empty" state of the screen.
const NEVER_EMPTY = (): boolean => false;
const NONE: never[] = [];

/** ADM-10: where each connector has read to and which inbound events wait, failed or died (ST-ADM-018). */
export default function SyncMonitorScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const canRead = permissions === undefined || permissions.includes(READ_INTEGRATION_PERMISSION);
  const canReadCursors = permissions === undefined || permissions.includes(READ_CURSOR_PERMISSION);
  const events = useInboxEvents(canRead);
  // The positions come from the master data cursors (their own permission); the events are the screen's own data, so it stays usable without them and says so.
  const cursors = useCursors(canRead && canReadCursors);
  const queryState = useScreenState({ isLoading: events.isLoading, error: events.error ?? undefined, data: events.data, isEmpty: NEVER_EMPTY });
  // Without adm.integration.read nothing is requested and the screen is denied, not empty.
  const state = canRead ? queryState : 'denied';
  return (
    <StateBoundary state={state} onRetry={() => void events.refetch()}>
      {cursors.isError || !canReadCursors ? (
        <p className="callout warning" role="alert">
          {t('adm.sync.cursors.error')}
        </p>
      ) : null}
      <SyncMonitorWorkspace route={route} cursors={cursors.data ?? NONE} events={events.data ?? NONE} />
    </StateBoundary>
  );
}
