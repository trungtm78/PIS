import type { SnoozeDetail, WorkPolicies, WorkRow } from '@machvon/db';
import type { ClockView, ExistingClock, ItemClocks, PauseSpan } from '@machvon/kernel';

/** One pause of the clocks of an item, as the API shows it: from when, until when, why, who allowed it and who asked. */
export const pauseView = (span: PauseSpan): Record<string, unknown> => ({
  from: span.from,
  until: span.until,
  resumed_at: span.resumedAt,
  reason_code: span.reasonCode,
  reason: span.reason,
  allowed_by: span.allowedBy,
  by: span.by,
});

const clockView = (clock: ClockView | null): Record<string, unknown> | null => (clock === null ? null : { state: clock.state, started_at: clock.started_at, due_at: clock.due_at, met_at: clock.met_at });

/** The two clocks of an item (time to take it up, time to resolve it), the pause that holds now and whether it has to be taken up again. `basis` says what they were counted on, so an absent clock is never read as "no deadline". */
export const clocksView = (clocks: ItemClocks): Record<string, unknown> => ({
  basis: clocks.basis,
  claim: clockView(clocks.claim),
  resolve: clockView(clocks.resolve),
  paused: clocks.paused === null ? null : pauseView(clocks.paused),
  needs_reclaim: clocks.needsReclaim === null ? null : { since: clocks.needsReclaim.since },
});

/** A postponement that holds: who put the item off, until when, why, which one of the series (and how many are allowed) and the version of the rule that allowed it. */
export const snoozeView = (snooze: SnoozeDetail, policies: WorkPolicies | null): Record<string, unknown> => ({
  id: snooze.id,
  by: snooze.by,
  until: snooze.until,
  at: snooze.at,
  reason_code: snooze.reasonCode,
  note: snooze.note,
  ordinal: snooze.ordinal,
  of: policies?.snooze.max_consecutive ?? null,
  final: snooze.final,
  policy_version: snooze.policyVersion,
});

/** The clock a module already keeps, wrapped as it is (nothing about it changed): what starts it, what stops it, what pauses it. */
export const existingClockView = (clock: ExistingClock): Record<string, unknown> => ({
  code: clock.code,
  module: clock.module,
  basis: clock.basis,
  starts: clock.starts,
  stops: clock.stops,
  pauses: clock.pauses,
  migrated: clock.migrated,
});

/** The fields of an item that come from the clocks and the decisions about it: shown by the list of the work of a person and by the list of what is put off. */
export function clockFields(row: WorkRow, policies: WorkPolicies | null): Record<string, unknown> {
  return {
    started_at: row.startedAt,
    expected_action: row.expectedAction,
    clock_type: row.clockType,
    clocks: row.clocks === null ? null : clocksView(row.clocks),
    needs_reclaim: row.clocks?.needsReclaim != null,
    snooze: row.snooze === null ? null : snoozeView(row.snooze, policies),
    snooze_count: row.consecutiveSnoozes,
    pause: row.clocks?.paused == null ? null : pauseView(row.clocks.paused),
    pauses: row.pauses.map(pauseView),
    reminders:
      row.reminders === null
        ? null
        : { sent: row.reminders.sent, last_at: row.reminders.lastAt, next_at: row.reminders.nextAt, due: row.reminders.due, exhausted: row.reminders.exhausted, every_working_hours: row.reminders.cadenceWorkingHours },
    notices: row.notices.map((notice) => ({ kind: notice.kind, at: notice.at })),
    existing_clock: row.existingClock === null ? null : existingClockView(row.existingClock),
    policy_version: row.policyVersion,
  };
}
