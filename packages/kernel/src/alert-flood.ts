import { DomainError } from './errors.ts';

/**
 * Flood protection of the alert centre (GOV-10, roadmap G2-11), as pure rules. A person who gets more new alerts in a window than the policy allows is in a storm; for as long as it lasts, and while the number of new alerts of
 * the day is over its cap, the alerts below the urgent level that are new are shown as summary cards (one per cause, then one per source) instead of one by one. An urgent alert is never grouped away and never counted into a
 * cap. Nothing is dropped: a group lists every one of its members, and the list of the person still has each of them. The numbers are the policy `ALERT_FLOOD_POLICY` (starting values from the research of alarm
 * management, scaled from an operator to an office worker, not confirmed with the customer): the storm starts above `start_above` new alerts in the window and ends below `end_below`, a lower number, so that it does not flap.
 */

export const FLOOD_RULE_TYPE = 'ALERT_FLOOD_POLICY';
export const FLOOD_DIMENSIONS = ['CAUSE', 'PROJECT', 'SOURCE'] as const;
export type FloodDimension = (typeof FLOOD_DIMENSIONS)[number];

export interface FloodPolicy {
  window_minutes: number;
  start_above: number;
  end_below: number;
  max_new_per_day: number;
  group_by: FloodDimension[];
  min_group_size: number;
}

export const floodPolicyDefaults = (): FloodPolicy => ({ window_minutes: 60, start_above: 10, end_below: 5, max_new_per_day: 30, group_by: ['CAUSE', 'SOURCE'], min_group_size: 3 });

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** The params of an `ALERT_FLOOD_POLICY` rule, checked: the end of a storm is below its start, and a group has at least two members. */
export function floodPolicyOf(params: unknown): FloodPolicy {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) throw invalid('params');
  const record = params as Record<string, unknown>;
  const whole = (key: string, min: number, max: number): number => {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw invalid(key);
    return value;
  };
  const groupBy = record.group_by;
  if (!Array.isArray(groupBy) || groupBy.length === 0 || groupBy.length > FLOOD_DIMENSIONS.length || groupBy.some((entry) => !(FLOOD_DIMENSIONS as readonly string[]).includes(entry as string)) || new Set(groupBy).size !== groupBy.length) throw invalid('group_by');
  const policy: FloodPolicy = {
    window_minutes: whole('window_minutes', 5, 1440),
    start_above: whole('start_above', 1, 10_000),
    end_below: whole('end_below', 0, 10_000),
    max_new_per_day: whole('max_new_per_day', 1, 100_000),
    group_by: groupBy as FloodDimension[],
    min_group_size: whole('min_group_size', 2, 1000),
  };
  if (policy.end_below > policy.start_above) throw invalid('end_below');
  return policy;
}

export interface StormState {
  active: boolean;
  /** When the storm began (an ISO instant), null when there is none. */
  since: string | null;
}

export type StormChange = 'STARTED' | 'ENDED' | 'NONE';

/** The state of a storm after a look at the number of new alerts in the window: it starts above the start number, ends below the end number, and in between stays as it was (no flapping). */
export function stormTransition(previous: StormState, newInWindow: number, policy: Pick<FloodPolicy, 'start_above' | 'end_below'>, now: Date): { next: StormState; change: StormChange } {
  if (!previous.active) {
    if (newInWindow > policy.start_above) return { next: { active: true, since: now.toISOString() }, change: 'STARTED' };
    return { next: previous, change: 'NONE' };
  }
  if (newInWindow < policy.end_below) return { next: { active: false, since: null }, change: 'ENDED' };
  return { next: previous, change: 'NONE' };
}

export type FloodSeverity = 'URGENT' | 'ACTION' | 'WATCH';
const RANK: Readonly<Record<FloodSeverity, number>> = { URGENT: 0, ACTION: 1, WATCH: 2 };

export interface FloodItem {
  source: string;
  id: string;
  severity: FloodSeverity;
  causeKey: string | null;
  projectCode: string | null;
  /** The item was first seen inside the window of the storm (an item that has been there for days is not part of a flood of new ones). */
  isNew: boolean;
}

export interface FloodGroup {
  /** A stable key of the group: the dimension and the value it groups by. */
  key: string;
  dimension: FloodDimension;
  source: string | null;
  count: number;
  mostSevere: FloodSeverity;
  /** Every member, as `source` and `id`: a group hides nothing. */
  members: Array<{ source: string; id: string }>;
}

export interface FloodResult {
  /** Items that stay on their own (all urgent ones, all that are not new, and those that did not make a group). */
  singles: Array<{ source: string; id: string }>;
  groups: FloodGroup[];
}

const dimensionValue = (item: FloodItem, dimension: FloodDimension): string | null => {
  if (dimension === 'CAUSE') return item.causeKey;
  if (dimension === 'PROJECT') return item.projectCode;
  return item.source;
};

/**
 * Groups the items of one person's list. `protect` is on while a storm lasts or the new alerts of the day are over the cap; it groups only new items below the urgent level. With it off, only items of one cause
 * collapse (several alerts that say the same thing about the same record are one card), and only when there are at least `min_group_size` of them. The dimensions are tried in the order of the policy; an item goes to the
 * first group it fits.
 */
export function groupForFlood(items: readonly FloodItem[], policy: Pick<FloodPolicy, 'group_by' | 'min_group_size'>, protect: boolean): FloodResult {
  const candidates = items.filter((item) => item.severity !== 'URGENT' && (protect ? item.isNew : true));
  const taken = new Set<string>();
  const groups: FloodGroup[] = [];
  const dimensions: readonly FloodDimension[] = protect ? policy.group_by : policy.group_by.filter((dimension) => dimension === 'CAUSE');
  for (const dimension of dimensions) {
    const buckets = new Map<string, FloodItem[]>();
    for (const item of candidates) {
      if (taken.has(`${item.source}\u0000${item.id}`)) continue;
      const value = dimensionValue(item, dimension);
      if (value === null) continue;
      const key = dimension === 'SOURCE' ? value : `${value}`;
      const bucket = buckets.get(key) ?? [];
      bucket.push(item);
      buckets.set(key, bucket);
    }
    for (const [value, bucket] of [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (bucket.length < policy.min_group_size) continue;
      for (const item of bucket) taken.add(`${item.source}\u0000${item.id}`);
      groups.push({
        key: `${dimension}:${value}`,
        dimension,
        source: dimension === 'SOURCE' ? value : (bucket[0]?.source ?? null),
        count: bucket.length,
        mostSevere: bucket.reduce<FloodSeverity>((worst, item) => (RANK[item.severity] < RANK[worst] ? item.severity : worst), 'WATCH'),
        members: bucket.map((item) => ({ source: item.source, id: item.id })),
      });
    }
  }
  const singles = items.filter((item) => !taken.has(`${item.source}\u0000${item.id}`)).map((item) => ({ source: item.source, id: item.id }));
  return { singles, groups };
}

/** Whether protection is on: a storm is on, or the new alerts of the day are over the cap. */
export const floodProtects = (storm: StormState, newToday: number, policy: Pick<FloodPolicy, 'max_new_per_day'>): boolean => storm.active || newToday > policy.max_new_per_day;
