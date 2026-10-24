/** The permission that reads the usage of the caller's own tenant (x-permission of getMyUsage), and the one that reads any tenant on the control plane (getTenantUsage). */
export const READ_USAGE_PERMISSION = 'subscription.read';
export const READ_TENANT_USAGE_PERMISSION = 'system.tenant.read';

export interface MeterRow {
  counter: string;
  unit: string;
  used: string;
  limit: string | undefined;
}

export interface SeatRow {
  used: number;
  limit: number | undefined;
}

export interface UsageEventRow {
  id: string;
  meter: string;
  externalEventKey: string;
  quantity: string;
  unit: string;
  occurredAt: string;
  sourceReference: string;
}

export interface UsageSummary {
  asOf: string;
  windowStart: string;
  windowEnd: string;
  meters: MeterRow[];
  seats: SeatRow;
  guestSeats: SeatRow;
  /** Only the control plane read has them. */
  recentEvents: UsageEventRow[] | undefined;
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);

function toSeat(raw: unknown): SeatRow {
  const row: Raw = isRecord(raw) ? raw : {};
  return { used: count(row.used), limit: typeof row.limit === 'number' && Number.isFinite(row.limit) ? row.limit : undefined };
}

function toEvent(raw: unknown): UsageEventRow | undefined {
  const row: Raw = isRecord(raw) ? raw : {};
  if (typeof row.id !== 'string') return undefined;
  return {
    id: row.id,
    meter: text(row.meter),
    externalEventKey: text(row.external_event_key),
    quantity: text(row.quantity),
    unit: text(row.unit),
    occurredAt: text(row.occurred_at),
    sourceReference: text(row.source_reference),
  };
}

export function toUsage(raw: unknown): UsageSummary {
  const view: Raw = isRecord(raw) ? raw : {};
  const meters = Array.isArray(view.meters) ? view.meters : [];
  return {
    asOf: text(view.as_of),
    windowStart: text(view.window_start),
    windowEnd: text(view.window_end),
    meters: meters.flatMap((entry): MeterRow[] => {
      const row: Raw = isRecord(entry) ? entry : {};
      return typeof row.counter === 'string' ? [{ counter: row.counter, unit: text(row.unit), used: text(row.used) || '0', limit: typeof row.limit === 'string' ? row.limit : undefined }] : [];
    }),
    seats: toSeat(view.seats),
    guestSeats: toSeat(view.guest_seats),
    recentEvents: Array.isArray(view.recent_events) ? view.recent_events.flatMap((entry) => toEvent(entry) ?? []) : undefined,
  };
}

export type Level = 'ok' | 'near' | 'full' | 'over' | 'none';

/** How much of a limit is used, as a whole percentage (rounded down), or undefined when there is no limit to measure against or it is zero. */
export function shareOf(used: string | number, limit: string | number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  const [usedValue, limitValue] = [Number(used), Number(limit)];
  if (!Number.isFinite(usedValue) || !Number.isFinite(limitValue) || limitValue <= 0) return undefined;
  return Math.floor((usedValue / limitValue) * 100);
}

/**
 * Where a counter stands against its limit, in words and not by colour alone: below 90 percent it is fine, from 90 it is near, at the limit it is full (the
 * next one is refused), above it it is over (the limit was lowered under what is in use, or what is used was counted after the fact).
 */
export function levelOf(used: string | number, limit: string | number | undefined): Level {
  if (limit === undefined) return 'none';
  const [usedValue, limitValue] = [Number(used), Number(limit)];
  if (!Number.isFinite(usedValue) || !Number.isFinite(limitValue)) return 'none';
  if (usedValue > limitValue) return 'over';
  if (usedValue === limitValue) return 'full';
  return usedValue / limitValue >= 0.9 ? 'near' : 'ok';
}
