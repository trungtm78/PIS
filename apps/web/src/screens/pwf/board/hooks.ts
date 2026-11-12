import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { usePwfKey } from '../hooks';
import type { DeadlineBoard, DeadlineCalendar, MilestoneList, Workload } from '../model';
import { MILESTONE_DAYS, WORKLOAD_WEEKS, boardQuery, calendarQuery, optionsOf } from './model';
import type { Filters, Option } from './model';

/** The board, a page after another: the totals and the counts of the colours are the server's, whatever page was read. It refreshes when the window is focused again. */
export function useBoard(filters: Filters, enabled: boolean) {
  const client = useApiClient();
  const key = usePwfKey();
  return useInfiniteQuery<DeadlineBoard, Error, { pages: DeadlineBoard[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'board', filters],
    initialPageParam: undefined,
    queryFn: ({ pageParam }) => client.read('getDeadlineBoard', { query: boardQuery(filters, pageParam) }),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled: enabled && key[1] !== undefined,
    // The filters stay on the screen while a changed filter is read: the board of before is kept until the new one arrives.
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

/** The month calendar; read only while its view is open. */
export function useCalendar(month: string, filters: Filters, enabled: boolean) {
  const client = useApiClient();
  const key = usePwfKey();
  return useQuery<DeadlineCalendar>({
    queryKey: [...key, 'calendar', month, filters.assignee, filters.unit],
    queryFn: () => client.read('getDeadlineCalendar', { query: calendarQuery(month, filters) }),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** The milestones of the next 30 days; read only while their view is open. */
export function useMilestones(filters: Filters, enabled: boolean) {
  const client = useApiClient();
  const key = usePwfKey();
  return useQuery<MilestoneList>({
    queryKey: [...key, 'milestones', filters.unit],
    queryFn: () => client.read('getUpcomingMilestones', { query: { days: MILESTONE_DAYS, ...(filters.unit === '' ? {} : { unit_id: filters.unit }) } }),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** The workload by person and week (display only); read only while its view is open. */
export function useWorkload(filters: Filters, enabled: boolean) {
  const client = useApiClient();
  const key = usePwfKey();
  return useQuery<Workload>({
    queryKey: [...key, 'workload', filters.unit],
    queryFn: () => client.read('getProjectWorkload', { query: { weeks: WORKLOAD_WEEKS, ...(filters.unit === '' ? {} : { unit_id: filters.unit }) } }),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** The units the caller may read, for the unit filter. A register that cannot be read leaves the list empty: the filter then takes the id of a unit typed in. */
export function useUnitOptions(enabled: boolean) {
  const client = useApiClient();
  const key = usePwfKey();
  return useQuery<Option[]>({
    queryKey: [...key, 'unit-options'],
    queryFn: async () => optionsOf(await client.readAll('get_resources_organization_unit'), ['name', 'code']),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** The people a task can be given to, for the person filter (the membership register in the scope of the caller). */
export function usePersonOptions(enabled: boolean) {
  const client = useApiClient();
  const key = usePwfKey();
  return useQuery<Option[]>({
    queryKey: [...key, 'person-options'],
    queryFn: async () => optionsOf(await client.readAll('get_resources_membership'), ['display_name', 'name', 'email']),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}
