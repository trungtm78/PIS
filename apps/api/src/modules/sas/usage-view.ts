import { LIMITING_FEATURE, USAGE_METERS, usageWindowOf } from '@machvon/kernel';
import type { SeatLimits, UsageCounterRow, UsageEventRow } from '@machvon/db';
import type { Schemas } from '../../contract-types';

type UsageSummary = Schemas['UsageSummary'];
type UsageEvent = Schemas['UsageEvent'];

/** What the usage screens are made of: the counters of the month, the limits in force, the seats and (control plane only) the latest events. */
export interface UsageInputs {
  now: Date;
  counters: readonly UsageCounterRow[];
  limits: ReadonlyMap<string, string>;
  seats: { staff: number; guests: number };
  seatLimits: SeatLimits;
  events?: readonly UsageEventRow[];
}

export const eventView = (row: UsageEventRow): UsageEvent => ({
  id: row.id,
  meter: row.meter,
  external_event_key: row.externalEventKey,
  quantity: row.quantity,
  unit: row.unit,
  occurred_at: row.occurredAt.toISOString(),
  source_reference: row.sourceReference,
  recorded_at: row.recordedAt.toISOString(),
});

// The counters in the order of the catalogue, each once, with the unit of the meters that feed it.
const COUNTERS: ReadonlyArray<{ counter: string; unit: string }> = [...new Map(USAGE_METERS.map((meter) => [meter.counter, { counter: meter.counter, unit: meter.unit }])).values()];

const seatView = (used: number, limit: number | null): UsageSummary['seats'] => ({ used, ...(limit === null ? {} : { limit }) });

/**
 * The usage of the month the clock is in: every counter of the catalogue (a counter nothing was added to is 0), the limit of the plan where one holds it
 * (messages against the campaign feature, tokens against the AI feature), and the seats against the lower of the licence and the plan.
 */
export function usageSummary(input: UsageInputs): UsageSummary {
  const window = usageWindowOf(input.now);
  const used = new Map(input.counters.filter((row) => row.windowStart.getTime() === window.start.getTime()).map((row) => [row.counter, row.used]));
  return {
    as_of: input.now.toISOString(),
    window_start: window.start.toISOString(),
    window_end: window.end.toISOString(),
    meters: COUNTERS.map(({ counter, unit }) => {
      const feature = LIMITING_FEATURE[counter];
      const limit = feature === undefined ? undefined : input.limits.get(feature);
      return { counter, unit, used: used.get(counter) ?? '0', ...(limit === undefined ? {} : { limit }) };
    }),
    seats: seatView(input.seats.staff, input.seatLimits.seats),
    guest_seats: seatView(input.seats.guests, input.seatLimits.guestSeats),
    ...(input.events === undefined ? {} : { recent_events: input.events.map(eventView) }),
  };
}
