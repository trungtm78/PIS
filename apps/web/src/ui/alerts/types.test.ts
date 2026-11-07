import { describe, expect, it } from 'vitest';
import { rawItem } from './test-support';
import { toAlertCounts, toAlertItem, toPolicies, toSnoozedAnswer } from './types';

describe('toAlertItem: the fields of the clocks and the alert core', () => {
  it('keeps an item that has none of the new fields, with safe values', () => {
    const bare: Record<string, unknown> = rawItem('a1');
    for (const key of ['started_at', 'expected_action', 'clock_type', 'policy_version', 'clocks', 'needs_reclaim', 'snooze', 'snooze_count', 'pause', 'pauses', 'reminders', 'notices', 'existing_clock']) delete bare[key];
    const item = toAlertItem(bare);
    expect(item).toMatchObject({ clocks: null, snooze: null, snooze_count: 0, needs_reclaim: false, pause: null, pauses: [], reminders: null, notices: [], existing_clock: null, expected_action: null, clock_type: null, policy_version: null, started_at: null });
  });

  it('parses the clocks, the pause, the snooze, the reminders, the notices and the module clock', () => {
    const pause = { from: '2026-11-07T01:00:00Z', until: '2026-11-09T01:00:00Z', resumed_at: null, reason_code: 'FORCE_MAJEURE', reason: 'Mưa bão', allowed_by: { id: 'u2', name: 'Trần Bình' }, by: { id: 'u1', name: 'Nguyễn An' } };
    const item = toAlertItem(
      rawItem('c1', {
        source: 'CLOCK',
        kind: 'CLOCK_DEADLINE',
        clock_type: 'WEEKLY_REPORT',
        expected_action: 'Gửi báo cáo tuần',
        started_at: '2026-11-02T01:00:00Z',
        policy_version: 'v2',
        needs_reclaim: true,
        clocks: {
          basis: 'WORKING_TIME',
          claim: { state: 'MET_LATE', started_at: '2026-11-02T01:00:00Z', due_at: '2026-11-03T01:00:00Z', met_at: '2026-11-03T05:00:00Z' },
          resolve: { state: 'PAUSED', started_at: null, due_at: '2026-11-12T01:00:00Z', met_at: null },
          paused: pause,
          needs_reclaim: { since: '2026-11-06T01:00:00Z' },
        },
        pause,
        pauses: [pause, { nonsense: 1 }],
        snooze: { id: 's1', by: { id: 'u1', name: 'Nguyễn An' }, until: '2026-11-08T01:00:00Z', at: '2026-11-07T01:00:00Z', reason_code: 'OTHER', note: 'Chờ hồ sơ', ordinal: 2, of: 2, final: true, policy_version: 'builtin' },
        snooze_count: 2,
        reminders: { sent: 3, last_at: '2026-11-07T00:00:00Z', next_at: '2026-11-07T04:00:00Z', due: true, exhausted: false, every_working_hours: 4 },
        notices: [{ kind: 'REMINDER', at: '2026-11-07T00:00:00Z' }, { kind: 'SNOOZE_FINAL_NOTICE', at: '2026-11-07T01:00:00Z' }, { kind: 'UNKNOWN', at: 'x' }, 'x'],
        existing_clock: { code: 'DIS-20', module: 'DIS', basis: 'CALENDAR_DAYS', starts: 's', stops: 't', pauses: 'p', migrated: true },
      }),
    );
    expect(item).toMatchObject({ clock_type: 'WEEKLY_REPORT', expected_action: 'Gửi báo cáo tuần', policy_version: 'v2', needs_reclaim: true, snooze_count: 2 });
    expect(item?.clocks?.claim?.state).toBe('MET_LATE');
    expect(item?.clocks?.resolve?.state).toBe('PAUSED');
    expect(item?.clocks?.paused?.allowed_by?.name).toBe('Trần Bình');
    expect(item?.clocks?.needs_reclaim).toEqual({ since: '2026-11-06T01:00:00Z' });
    expect(item?.pauses).toHaveLength(1);
    expect(item?.snooze).toMatchObject({ ordinal: 2, of: 2, final: true, reason_code: 'OTHER', note: 'Chờ hồ sơ' });
    expect(item?.reminders).toMatchObject({ sent: 3, due: true, every_working_hours: 4 });
    expect(item?.notices.map((notice) => notice.kind)).toEqual(['REMINDER', 'SNOOZE_FINAL_NOTICE']);
    expect(item?.existing_clock).toMatchObject({ code: 'DIS-20', migrated: true });
  });

  it('drops a clock with no due moment, and a basis it does not know falls back to working time', () => {
    const item = toAlertItem(rawItem('c1', { clocks: { basis: 'MYSTERY', claim: { state: 'RUNNING' }, resolve: null } }));
    expect(item?.clocks).toEqual({ basis: 'WORKING_TIME', claim: null, resolve: null, paused: null, needs_reclaim: null });
  });

  it('reads the counts of what needs to be taken up again and of what is snoozed, and leaves them out when the API does not send them', () => {
    expect(toAlertCounts({ urgent: 1, action: 2, watch: 3, needs_reclaim: 4, snoozed: 5 })).toEqual({ urgent: 1, action: 2, watch: 3, total: 6, needs_reclaim: 4, snoozed: 5 });
    expect(toAlertCounts({ urgent: 1, action: 0, watch: 0 })).toEqual({ urgent: 1, action: 0, watch: 0, total: 1 });
  });
});

describe('toPolicies and toSnoozedAnswer', () => {
  it('is undefined for an answer without a usable snooze policy', () => {
    expect(toPolicies(null)).toBeUndefined();
    expect(toPolicies({ policies: [] })).toBeUndefined();
    expect(toPolicies({ policies: [{ type: 'SNOOZE_POLICY', params: { reasons: [], max_days_by_severity: {} } }] })).toBeUndefined();
  });

  it('tolerates a missing clock policy', () => {
    const answer = toPolicies({
      as_of: '2026-11-07T02:00:00Z',
      policies: [{ type: 'SNOOZE_POLICY', version: 'v2', unverified: true, params: { reasons: ['OTHER'], note_required_for: ['OTHER'], max_days_by_severity: { URGENT: 0, ACTION: 3, WATCH: 14 }, max_consecutive: 2, final_notifies_next_level: true } }],
    });
    expect(answer?.clock).toBeNull();
    expect(answer?.snooze).toMatchObject({ version: 'v2', unverified: true, max_consecutive: 2, final_notifies_next_level: true });
  });

  it('reads an empty list as an empty answer', () => {
    expect(toSnoozedAnswer(undefined)).toEqual({ items: [], count: 0, truncated: false, unavailable_sources: [], policy_version: null, as_of: null });
  });
});
