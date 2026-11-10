import { ApiError } from '@machvon/api-client';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { NO_FILTER, PAGE_SIZE, mostUrgent, queryOf, toDirectiveDetail, toDirectivePage, toLookup, toMeetingDetail, toMeetingPage, toReport, toSummary, toWidget } from './model';
import type { DirectiveDetail, DirectiveLine, FilterState, LookupOption, MeetingDetail, MeetingLine, Page, Report, Summary, Widget } from './model';

/** What these screens show depends on the scope of the membership that is signed in, not only on the tenant: the membership is part of every key. */
export function useScopeKey(): readonly ['dir', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['dir', tenant?.id, tenant?.membershipId];
}

/** A read that is null when the record is not there for the caller (a 404: another tenant, or outside the scope); any other failure is the failure of the read, never "nothing". */
function useRecord<T>(name: string, id: string | undefined, operation: string, parse: (raw: unknown) => T | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<T | null>({
    queryKey: [...key, name, id ?? ''],
    queryFn: async () => {
      try {
        return parse(await client.read(operation as never, { path: { id: id ?? '' } } as never)) ?? null;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: key[1] !== undefined && id !== undefined,
    retry: false,
  });
}

export const useMeetingDetail = (id: string | undefined) => useRecord<MeetingDetail>('meeting', id, 'getSteeringMeeting', toMeetingDetail);
export const useDirectiveDetail = (id: string | undefined) => useRecord<DirectiveDetail>('directive', id, 'getDirective', toDirectiveDetail);

export interface MeetingFilter {
  unitId: string;
  meetingType: string;
  from: string;
  to: string;
}
export const NO_MEETING_FILTER: MeetingFilter = { unitId: '', meetingType: '', from: '', to: '' };

/** One page of the meetings, the latest first, narrowed by the filter; the cursor is the one the server gave for the page before. */
export function useMeetingPage(filter: MeetingFilter, cursor: string | undefined, limit: number = PAGE_SIZE) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Page<MeetingLine>>({
    queryKey: [...key, 'meetings', filter, cursor ?? '', limit],
    queryFn: async () => {
      const query: Record<string, string | number> = { limit };
      if (filter.unitId !== '') query.unit_id = filter.unitId;
      if (filter.meetingType !== '') query.meeting_type = filter.meetingType;
      if (filter.from !== '') query.from = filter.from;
      if (filter.to !== '') query.to = filter.to;
      if (cursor !== undefined) query.cursor = cursor;
      return toMeetingPage(await client.read('listSteeringMeetings' as never, { query } as never));
    },
    enabled: key[1] !== undefined,
    retry: false,
    placeholderData: (previous) => previous,
  });
}

/** The directives of a filter, page after page ("more" asks the next one): the board's columns and lists. */
export function useDirectiveList(filter: FilterState, limit: number = PAGE_SIZE, enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  return useInfiniteQuery<Page<DirectiveLine>, Error, { pages: Page<DirectiveLine>[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'directives', filter, limit],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => toDirectivePage(await client.read('listDirectives' as never, { query: queryOf(filter, { limit, ...(pageParam === undefined ? {} : { cursor: pageParam }) }) } as never)),
    getNextPageParam: (last) => last.nextCursor,
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

const OVERDUE_FILTER: FilterState = { ...NO_FILTER, overdue: true };

/** The directive DIR-04 shows when it is opened without one (a typed address, the menu): the most urgent of the scope; the overdue ones are read first, the open ones only when none is overdue. */
export function useDefaultDirective(enabled: boolean): { directive: DirectiveLine | undefined; isLoading: boolean } {
  const overdue = useDirectiveList(OVERDUE_FILTER, 20, enabled);
  const lateFound = mostUrgent(overdue.data?.pages.flatMap((page) => page.items) ?? []);
  const settled = overdue.isSuccess || overdue.isError;
  const others = useDirectiveList(NO_FILTER, 50, enabled && settled && lateFound === undefined);
  const found = lateFound ?? mostUrgent(others.data?.pages.flatMap((page) => page.items) ?? []);
  const isLoading = enabled && found === undefined && (overdue.isLoading || (settled && others.isLoading));
  return { directive: found, isLoading };
}

/** The counts of the scope by the status a reader sees, with the formula of each number; the summary narrows by unit, project and meeting only. */
export function useSummary(filter: Pick<FilterState, 'unitId' | 'projectId' | 'meetingId'>) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Summary | null>({
    queryKey: [...key, 'summary', filter],
    queryFn: async () => {
      const query: Record<string, string> = {};
      if (filter.unitId !== '') query.unit_id = filter.unitId;
      if (filter.projectId !== '') query.project_id = filter.projectId;
      if (filter.meetingId !== '') query.meeting_id = filter.meetingId;
      return toSummary(await client.read('getDirectiveSummary' as never, { query } as never)) ?? null;
    },
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** The directives of a period as the input of the next report. */
export function useReport(period: { from: string; to: string }, filter: Pick<FilterState, 'unitId' | 'projectId'>, enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Report | null>({
    queryKey: [...key, 'report', period, filter],
    queryFn: async () => {
      const query: Record<string, string> = { from: period.from, to: period.to };
      if (filter.unitId !== '') query.unit_id = filter.unitId;
      if (filter.projectId !== '') query.project_id = filter.projectId;
      return toReport(await client.read('getDirectivesForReport' as never, { query } as never)) ?? null;
    },
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** The data of the dashboard widget: the counts and the oldest overdue directives. */
export function useWidget() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Widget | null>({
    queryKey: [...key, 'widget'],
    queryFn: async () => toWidget(await client.read('getDirectiveWidget' as never, {} as never)) ?? null,
    enabled: key[1] !== undefined,
    retry: false,
  });
}

function useLookup(name: string, operation: string, kind: 'unit' | 'project' | 'member', enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<LookupOption[]>({
    queryKey: [...key, 'lookup', name],
    queryFn: async () => ((await client.readAll(operation as 'get_resources_project')) as unknown[]).flatMap((raw) => toLookup(raw, kind)).sort((a, b) => a.label.localeCompare(b.label, 'vi')),
    enabled: enabled && key[1] !== undefined,
    retry: false,
    staleTime: 60_000,
  });
}

export const useUnitOptions = (enabled = true) => useLookup('units', 'get_resources_organization_unit', 'unit', enabled);
export const useProjectOptions = (enabled = true) => useLookup('projects', 'get_resources_project', 'project', enabled);
export const useMemberOptions = (enabled = true) => useLookup('members', 'get_resources_membership', 'member', enabled);

/** The meetings for a filter that picks one (the first two hundred, the latest first). */
export function useMeetingOptions(enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<LookupOption[]>({
    queryKey: [...key, 'lookup', 'meetings'],
    queryFn: async () => toMeetingPage(await client.read('listSteeringMeetings' as never, { query: { limit: 200 } } as never)).items.map((meeting) => ({ id: meeting.id, label: `${meeting.code} · ${meeting.title}` })),
    enabled: enabled && key[1] !== undefined,
    retry: false,
    staleTime: 60_000,
  });
}

export interface CommandInput {
  /** The record the path names; the commands that create a meeting have none. */
  id?: string;
  body: Record<string, unknown>;
  /** The version the `If-Match` carries, for the commands of a versioned record. */
  version?: number;
}

/** The commands of the lane, one hook for all: one idempotency attempt per intention (the same payload is the same attempt), every cached read refreshed on success. */
export function useDirCommand(operation: string) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<unknown, Error, CommandInput>({
    mutationFn: async (input) => {
      const attempt = attempts.current.forPayload({ operation, ...input });
      const request: Record<string, unknown> = { body: input.body, attempt };
      if (input.id !== undefined) request.path = { id: input.id };
      if (input.version !== undefined) request.ifMatchVersion = input.version;
      return client.command(operation as never, request as never);
    },
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
