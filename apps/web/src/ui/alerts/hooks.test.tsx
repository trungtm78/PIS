import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TENANT_A } from '../../test/render';
import { COUNTS_REFRESH_MS, useAlertAction, useAlertCounts, useAlertItems, useAssignees, useRefreshOnNotification, useSnoozedWork, useWorkClockPolicies } from './hooks';
import { toAlertItem } from './types';
import type { AlertItem } from './types';
import { ME, OTHER, alertsBackend, countsAnswer, failure, harness, hookWrapper, listAnswer, policiesAnswer, rawItem } from './test-support';

const theItem = (overrides: Record<string, unknown> = {}): AlertItem => {
  const parsed = toAlertItem(rawItem('w1', overrides));
  if (parsed === undefined) throw new Error('fixture');
  return parsed;
};
const mine = { counts: countsAnswer(2, 3, 1), list: listAnswer([rawItem('w1')]) };

afterEach(() => {
  vi.useRealTimers();
});

describe('useAlertCounts', () => {
  it('reads the counts of the view that is asked and parses them', async () => {
    const h = harness(alertsBackend({ mine, scope: { counts: countsAnswer(0, 9, 0, { view: 'scope' }), list: listAnswer([]) } }));
    const { wrapper } = hookWrapper(h);
    const own = renderHook(() => useAlertCounts('mine'), { wrapper });
    await waitFor(() => expect(own.result.current.data?.counts).toEqual({ urgent: 2, action: 3, watch: 1, total: 6 }));
    expect(h.read).toHaveBeenCalledWith('getMyWorkCounts', { query: { view: 'mine' } });
    const scope = renderHook(() => useAlertCounts('scope'), { wrapper });
    await waitFor(() => expect(scope.result.current.data?.counts.total).toBe(9));
  });

  it('is pending, not zero, before the first answer, and says denied for a 403', async () => {
    const h = harness(alertsBackend({ mine }));
    const { wrapper } = hookWrapper(h);
    const own = renderHook(() => useAlertCounts('mine'), { wrapper });
    expect(own.result.current.data).toBeUndefined();
    expect(own.result.current.isPending).toBe(true);
    const scope = renderHook(() => useAlertCounts('scope'), { wrapper });
    await waitFor(() => expect(scope.result.current.denied).toBe(true));
    expect(own.result.current.denied).toBe(false);
  });

  it('does not read while it is not enabled', async () => {
    const h = harness(alertsBackend({ mine }));
    const { wrapper } = hookWrapper(h);
    renderHook(() => useAlertCounts('mine', { enabled: false }), { wrapper });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.read).not.toHaveBeenCalled();
  });

  it('refreshes every 60 seconds', async () => {
    expect(COUNTS_REFRESH_MS).toBe(60_000);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = harness(alertsBackend({ mine }));
    const { wrapper } = hookWrapper(h);
    renderHook(() => useAlertCounts('mine'), { wrapper });
    await waitFor(() => expect(h.read).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COUNTS_REFRESH_MS + 100);
    });
    await waitFor(() => expect(h.read.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('refreshes when the window gets focus again', async () => {
    const h = harness(alertsBackend({ mine }));
    const { wrapper } = hookWrapper(h);
    const own = renderHook(() => useAlertCounts('mine'), { wrapper });
    await waitFor(() => expect(own.result.current.isSuccess).toBe(true));
    expect(h.read).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new Event('visibilitychange'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(h.read).toHaveBeenCalledTimes(2));
  });

  it('keeps the last good answer when a refresh fails', async () => {
    let fail = false;
    const h = harness((operation, input) => (fail ? failure(503) : alertsBackend({ mine })(operation, input)));
    const { wrapper } = hookWrapper(h);
    const own = renderHook(() => useAlertCounts('mine'), { wrapper });
    await waitFor(() => expect(own.result.current.isSuccess).toBe(true));
    fail = true;
    await act(async () => {
      await own.result.current.refetch();
    });
    await waitFor(() => expect(own.result.current.isError).toBe(true));
    expect(own.result.current.data?.counts.total).toBe(6);
  });
});

describe('useRefreshOnNotification', () => {
  it('asks for the counts again when a notification arrives in the inbox', async () => {
    const h = harness(alertsBackend({ mine }));
    const { wrapper, queries } = hookWrapper(h);
    const own = renderHook(
      () => {
        useRefreshOnNotification();
        return useAlertCounts('mine', { refreshMs: false });
      },
      { wrapper },
    );
    await waitFor(() => expect(own.result.current.isSuccess).toBe(true));
    expect(h.read).toHaveBeenCalledTimes(1);
    act(() => {
      queries.setQueryData(['my-notifications', TENANT_A.id], { pages: [], pageParams: [] });
    });
    await waitFor(() => expect(h.read).toHaveBeenCalledTimes(2));
  });

  it('ignores what is not the inbox', async () => {
    const h = harness(alertsBackend({ mine }));
    const { wrapper, queries } = hookWrapper(h);
    const own = renderHook(
      () => {
        useRefreshOnNotification();
        return useAlertCounts('mine', { refreshMs: false });
      },
      { wrapper },
    );
    await waitFor(() => expect(own.result.current.isSuccess).toBe(true));
    act(() => {
      queries.setQueryData(['something-else'], 1);
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.read).toHaveBeenCalledTimes(1);
  });
});

describe('useAlertItems and useAssignees', () => {
  it('reads the list of a view with its page size and the sources that failed', async () => {
    const h = harness(alertsBackend({ mine: { counts: mine.counts, list: listAnswer([rawItem('w1')], { unavailable_sources: ['ADVANCE'] }) } }));
    const { wrapper } = hookWrapper(h);
    const own = renderHook(() => useAlertItems('mine'), { wrapper });
    await waitFor(() => expect(own.result.current.data?.items).toHaveLength(1));
    expect(own.result.current.data?.unavailable_sources).toEqual(['ADVANCE']);
    expect(h.read).toHaveBeenCalledWith('getMyWork', { query: { view: 'mine', limit: 50 } });
  });

  it('reads the active staff to give an item to', async () => {
    const h = harness(alertsBackend({ mine }), undefined, () => [
      { id: OTHER, display_name: 'Trần Bình', status: 'Active', membership_type: 'STAFF' },
      { id: 'x', display_name: 'Đã nghỉ', status: 'Inactive', membership_type: 'STAFF' },
    ]);
    const { wrapper } = hookWrapper(h);
    const people = renderHook(() => useAssignees(true), { wrapper });
    await waitFor(() => expect(people.result.current.data).toEqual([{ id: OTHER, name: 'Trần Bình' }]));
  });
});

describe('useAlertAction', () => {
  it('claims with the target of the item and writes the new lifecycle into the list', async () => {
    const h = harness(alertsBackend({ mine }));
    const { wrapper } = hookWrapper(h);
    const both = renderHook(() => ({ items: useAlertItems('mine'), act: useAlertAction() }), { wrapper });
    await waitFor(() => expect(both.result.current.items.data?.items[0]?.lifecycle).toBe('NEW'));
    await act(async () => {
      await both.result.current.act.claim.mutateAsync(theItem());
    });
    expect(h.command).toHaveBeenCalledTimes(1);
    const [operation, input] = h.command.mock.calls[0] as [string, { body: unknown; attempt: unknown }];
    expect(operation).toBe('claimWork');
    expect(input.body).toEqual({ source: 'PERMIT', source_id: 'w1' });
    expect(input.attempt).toBeDefined();
    expect(both.result.current.act.me).toEqual({ id: ME, name: 'Nguyễn An' });
  });

  it('assigns with the person and the day, and snoozes with the moment and the reason', async () => {
    const h = harness(alertsBackend({ mine }));
    const { wrapper } = hookWrapper(h);
    const own = renderHook(() => useAlertAction(), { wrapper });
    await act(async () => {
      await own.result.current.assign.mutateAsync({ item: theItem(), assignee: { id: OTHER, name: 'Trần Bình' }, dueOn: '2999-01-02' });
      await own.result.current.snooze.mutateAsync({ item: theItem(), until: '2999-01-01T01:00:00.000Z', reasonCode: 'OTHER', note: '  Chờ hồ sơ bổ sung  ' });
    });
    expect(h.command.mock.calls[0]?.[0]).toBe('assignWork');
    expect((h.command.mock.calls[0]?.[1] as { body: unknown }).body).toEqual({ source: 'PERMIT', source_id: 'w1', assignee_id: OTHER, due_on: '2999-01-02' });
    expect(h.command.mock.calls[1]?.[0]).toBe('snoozeWork');
    expect((h.command.mock.calls[1]?.[1] as { body: unknown }).body).toEqual({ source: 'PERMIT', source_id: 'w1', snooze_until: '2999-01-01T01:00:00.000Z', reason_code: 'OTHER', reason: 'Chờ hồ sơ bổ sung' });
  });

  it('sends a reason code and no note when the reason needs none, and writes the snooze into the cached item', async () => {
    const h = harness(alertsBackend({ mine }));
    const { wrapper } = hookWrapper(h);
    const both = renderHook(() => ({ items: useAlertItems('mine'), act: useAlertAction() }), { wrapper });
    await waitFor(() => expect(both.result.current.items.data?.items[0]?.snooze).toBeNull());
    await act(async () => {
      await both.result.current.act.snooze.mutateAsync({ item: theItem(), until: '2999-01-01T01:00:00.000Z', reasonCode: 'ON_LEAVE' });
    });
    expect((h.command.mock.calls[0]?.[1] as { body: unknown }).body).toEqual({ source: 'PERMIT', source_id: 'w1', snooze_until: '2999-01-01T01:00:00.000Z', reason_code: 'ON_LEAVE' });
  });

  it('pauses the clock with the reason, the person who allowed it and the day, and resumes it', async () => {
    const h = harness(alertsBackend({ mine }));
    const { wrapper } = hookWrapper(h);
    const own = renderHook(() => useAlertAction(), { wrapper });
    await act(async () => {
      await own.result.current.pause.mutateAsync({ item: theItem(), allowedBy: { id: OTHER, name: 'Trần Bình' }, reasonCode: 'WAITING_EXTERNAL_PARTY', reason: ' Chờ chủ đầu tư ', until: '2999-01-01T01:00:00.000Z' });
      await own.result.current.resume.mutateAsync({ item: theItem() });
    });
    expect(h.command.mock.calls[0]?.[0]).toBe('pauseWorkClock');
    expect((h.command.mock.calls[0]?.[1] as { body: unknown }).body).toEqual({ source: 'PERMIT', source_id: 'w1', reason_code: 'WAITING_EXTERNAL_PARTY', reason: 'Chờ chủ đầu tư', allowed_by_id: OTHER, paused_until: '2999-01-01T01:00:00.000Z' });
    expect(h.command.mock.calls[1]?.[0]).toBe('resumeWorkClock');
    expect((h.command.mock.calls[1]?.[1] as { body: unknown }).body).toEqual({ source: 'PERMIT', source_id: 'w1' });
  });

  it('keeps the same idempotency key for a retry of the same claim after a lost answer', async () => {
    let calls = 0;
    const h = harness(alertsBackend({ mine }), () => {
      calls += 1;
      return calls === 1 ? failure(503) : {};
    });
    const { wrapper } = hookWrapper(h);
    const own = renderHook(() => useAlertAction(), { wrapper });
    await act(async () => {
      await own.result.current.claim.mutateAsync(theItem()).catch(() => undefined);
    });
    await act(async () => {
      await own.result.current.claim.mutateAsync(theItem());
    });
    const first = (h.command.mock.calls[0]?.[1] as { attempt: unknown }).attempt;
    const second = (h.command.mock.calls[1]?.[1] as { attempt: unknown }).attempt;
    expect(second).toBe(first);
  });
});

describe('useWorkClockPolicies and useSnoozedWork', () => {
  it('reads the policy and parses the reasons and the limits', async () => {
    const h = harness(alertsBackend({ mine }, policiesAnswer({ snooze: { reasons: ['A_REASON', 'OTHER'], max_consecutive: 3 } })));
    const { wrapper } = hookWrapper(h);
    const own = renderHook(() => useWorkClockPolicies(), { wrapper });
    await waitFor(() => expect(own.result.current.data).toBeDefined());
    expect(h.read).toHaveBeenCalledWith('getWorkClockPolicies');
    expect(own.result.current.data?.snooze).toMatchObject({ reasons: ['A_REASON', 'OTHER'], max_consecutive: 3, max_days_by_severity: { URGENT: 0, ACTION: 3, WATCH: 14 }, note_required_for: ['OTHER'] });
    expect(own.result.current.data?.clock).toMatchObject({ max_pause_days: 10 });
  });

  it('is an error, not a made-up policy, when the answer has no usable snooze policy', async () => {
    const h = harness(alertsBackend({ mine }, { policies: [] }));
    const { wrapper } = hookWrapper(h);
    const own = renderHook(() => useWorkClockPolicies(), { wrapper });
    await waitFor(() => expect(own.result.current.isError).toBe(true));
    expect(own.result.current.data).toBeUndefined();
  });

  it('reads the snoozed work and says denied for a 403', async () => {
    const row = { source: 'PERMIT', source_id: 'w1', kind: 'PERMIT_EXPIRY', title: 'Giấy phép', subtitle: null, severity: 'WATCH', due_on: '2999-12-31', target: { screen: 'PRJ-19', id: 'w1' }, snooze: { id: 's1', by: { id: ME, name: 'Nguyễn An' }, until: '2999-01-01T01:00:00Z', at: '2026-11-07T01:00:00Z', reason_code: 'ON_LEAVE', note: null, ordinal: 1, of: 2, final: false, policy_version: 'builtin' }, snooze_count: 1 };
    const ok = harness((operation) => (operation === 'getSnoozedWork' ? { items: [row, { nonsense: true }], count: 1, truncated: false, unavailable_sources: ['ISSUE'], policy_version: 'builtin', as_of: '2026-11-07T02:00:00Z' } : new Error('unexpected')));
    const first = renderHook(() => useSnoozedWork(), { wrapper: hookWrapper(ok).wrapper });
    await waitFor(() => expect(first.result.current.data).toBeDefined());
    expect(first.result.current.data?.items).toHaveLength(1);
    expect(first.result.current.data).toMatchObject({ count: 1, unavailable_sources: ['ISSUE'], policy_version: 'builtin' });
    const denied = harness(() => failure(403, 'FORBIDDEN'));
    const second = renderHook(() => useSnoozedWork(), { wrapper: hookWrapper(denied).wrapper });
    await waitFor(() => expect(second.result.current.denied).toBe(true));
  });
});
