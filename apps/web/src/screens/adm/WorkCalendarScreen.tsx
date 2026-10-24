import type { ScreenProps } from '../../routes/types';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { useWorkCalendars } from './calendar/hooks';
import { WorkCalendarWorkspace } from './WorkCalendarWorkspace';

// A tenant without a calendar still gets the form: an empty register is not the "empty" state of the screen.
const NEVER_EMPTY = (): boolean => false;

/** ADM-07: the working calendars of the tenant (ST-ADM-010). */
export default function WorkCalendarScreen({ route }: ScreenProps) {
  const list = useWorkCalendars();
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data, isEmpty: NEVER_EMPTY });
  return (
    <StateBoundary state={state} onRetry={() => void list.refetch()}>
      <WorkCalendarWorkspace route={route} versions={list.data ?? []} />
    </StateBoundary>
  );
}
