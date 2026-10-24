/**
 * What an event of usage adds to: a meter is something that is measured (messages sent, tokens used, queries run), and a counter is
 * what the plan limits (several meters can feed one counter: every message channel counts against the messages of the plan).
 * A correction is its own meter (`<meter>_correction`) and takes away from the counter of the meter it corrects: usage events are
 * insert-only and never negative (SAS.md BR-SAS-15), so a mistake is made good by a later event, not by an edit.
 */
export interface UsageMeter {
  code: string;
  unit: string;
  /** The counter the meter feeds (`usage_counter.feature_code`). */
  counter: string;
  direction: 'ADD' | 'SUBTRACT';
}

const BASE_METERS: ReadonlyArray<Pick<UsageMeter, 'code' | 'unit' | 'counter'>> = [
  { code: 'notification.zns', unit: 'message', counter: 'notification.messages' },
  { code: 'notification.sms', unit: 'message', counter: 'notification.messages' },
  { code: 'notification.email', unit: 'message', counter: 'notification.messages' },
  { code: 'ai.tokens', unit: 'token', counter: 'ai.tokens' },
  { code: 'storage.gb_day', unit: 'gb_day', counter: 'storage.gb_day' },
  { code: 'bi.query', unit: 'query', counter: 'bi.queries' },
];

export const CORRECTION_SUFFIX = '_correction';

/** Every meter of the catalogue: each base meter and its correction. */
export const USAGE_METERS: readonly UsageMeter[] = BASE_METERS.flatMap((meter) => [
  { ...meter, direction: 'ADD' as const },
  { ...meter, code: `${meter.code}${CORRECTION_SUFFIX}`, direction: 'SUBTRACT' as const },
]);

const BY_CODE: ReadonlyMap<string, UsageMeter> = new Map(USAGE_METERS.map((meter) => [meter.code, meter]));

export function usageMeterOf(code: string): UsageMeter | undefined {
  return BY_CODE.get(code);
}

/**
 * The plan feature whose limit a counter is held against, or undefined when the counter has no limit: messages are limited by the
 * campaign feature of the plan and tokens by the AI feature; storage and query counts are only reported.
 */
export const LIMITING_FEATURE: Readonly<Record<string, string>> = {
  'notification.messages': 'notification.campaign',
  'ai.tokens': 'ai.analysis',
};

export interface UsageWindow {
  start: Date;
  end: Date;
}

/** The calendar month (UTC) an event falls in: counters are kept per month, and an invoice period is a month or more of them. */
export function usageWindowOf(at: Date): UsageWindow {
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();
  return { start: new Date(Date.UTC(year, month, 1)), end: new Date(Date.UTC(year, month + 1, 1)) };
}
