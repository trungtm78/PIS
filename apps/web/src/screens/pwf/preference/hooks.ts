import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { useBandPreview } from '../bands/hooks';
import { usePwfCommand, usePwfKey } from '../hooks';
import { MY_TASKS_PAGE, PREFERENCE_UNIT, bodyOf, formOf, isDirty, ladderOf, problemsOf, setsLevel, viewOf, withLevel } from './model';
import type { Level, MyTaskPage, PreferenceBody, PreferenceForm, PreferenceView } from './model';

/** What the person set for their own reminders, with the official ladder in force beside it. */
export function usePreference(enabled: boolean) {
  const client = useApiClient();
  const key = usePwfKey();
  return useQuery<PreferenceView>({
    queryKey: [...key, 'preference'],
    queryFn: async () => viewOf(await client.read('getDeadlinePreference', {})),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

export interface SavePreferenceInput {
  /** The version the person saw (the `If-Match` of the call); 0 when nothing was ever saved. */
  version: number;
  body: PreferenceBody;
}

/** Saves the personal setting under the version the person saw; what the module reads is read again on success. */
export function useSavePreference() {
  const client = useApiClient();
  return usePwfCommand<SavePreferenceInput>((input, attempt) => client.command('setDeadlinePreference', { body: input.body, ifMatchVersion: input.version, attempt }));
}

/** The tasks of the person by deadline, a page after another: the official colour, and their own colour when it differs, with the real due date. */
export function useMyTasks(enabled: boolean) {
  const client = useApiClient();
  const key = usePwfKey();
  return useInfiniteQuery<MyTaskPage, Error, { pages: MyTaskPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'my-tasks'],
    initialPageParam: undefined,
    queryFn: ({ pageParam }) => client.read('getMyTasks', { query: { limit: MY_TASKS_PAGE, ...(pageParam === undefined ? {} : { cursor: pageParam }) } }),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled: enabled && key[1] !== undefined,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/** What the person is editing: the form, what is wrong with it, and whether it differs from what the server holds. A new version of the setting (after a save or a reload) builds the draft again from the key of the caller. */
export function usePreferenceDraft(view: PreferenceView) {
  const [form, setForm] = useState<PreferenceForm>(() => formOf(view));
  const problems = problemsOf(form, view.official);
  return {
    form,
    problems,
    dirty: isDirty(form, view),
    ladder: ladderOf(form, view.official),
    setLevel: (level: Level, text: string): void => setForm((current) => withLevel(current, level, text)),
    setReminders: (text: string): void => setForm((current) => ({ ...current, reminders: text })),
    body: () => bodyOf(form),
  };
}

/** The server's reading of the personal ladder, asked only for a good ladder that sets a level of its own (there is nothing to confirm for a person who follows the official one). */
export function usePersonalConfirmation(form: PreferenceForm, ladder: ReturnType<typeof ladderOf>, enabled: boolean) {
  return useBandPreview(ladder, PREFERENCE_UNIT, enabled && setsLevel(form));
}
