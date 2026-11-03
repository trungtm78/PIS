import { AlertEvaluator, CollectingTelemetry } from '../src/alerts';
import type { AlertRule } from '../src/alerts';
import {
  FAST_BURN,
  SLOW_BURN,
  SLO_BUDGET_EXHAUSTED_ALERT,
  SLO_FAST_BURN_ALERT,
  SLO_OBJECTIVE,
  SLO_SERVICES,
  SLO_SLOW_BURN_ALERT,
  budgetReport,
  budgetStatus,
  burnRateOver,
  evaluateBurn,
  isBadResponse,
  minuteOf,
  reportSlo,
} from '../src/slo';
import type { DeclaredOutage, SliBucket } from '../src/slo';

const NOW = minuteOf(new Date('2026-11-03T08:00:00Z'));
const DAY = 1440;
const THIRTY_DAYS = 30 * DAY;
const TRAFFIC = 1000;

/** One bucket for each minute of `[from, to]`, each with `total` requests of which `bad(minute)` failed. */
function traffic(from: number, to: number, bad: (minute: number) => number = () => 0, total = TRAFFIC): SliBucket[] {
  const buckets: SliBucket[] = [];
  for (let minute = from; minute <= to; minute += 1) buckets.push({ minute, total, bad: bad(minute) });
  return buckets;
}

describe('isBadResponse (ST-KERNEL-052: the SLI counts 5xx and timeouts of valid requests)', () => {
  it('counts a server error and a timeout, and nothing a client or the platform answered on purpose', () => {
    expect(isBadResponse({ status: 500, timedOut: false })).toBe(true);
    expect(isBadResponse({ status: 503, timedOut: false })).toBe(true);
    expect(isBadResponse({ status: 200, timedOut: true })).toBe(true);
    for (const status of [200, 201, 204, 304, 400, 401, 403, 404, 409, 422, 429]) expect(isBadResponse({ status, timedOut: false })).toBe(false);
  });
});

describe('burnRateOver and evaluateBurn', () => {
  it('is the error ratio of the window divided by the share of failures the objective allows', () => {
    const buckets = traffic(NOW - 59, NOW, () => 14.4);
    expect(burnRateOver(buckets, NOW, 60)).toBe(14.4);
    expect(burnRateOver(buckets, NOW, 5)).toBe(14.4);
  });

  it('is 0 for a window with no requests, and looks only at the minutes inside the window', () => {
    expect(burnRateOver([], NOW, 60)).toBe(0);
    const old = traffic(NOW - 200, NOW - 61, () => TRAFFIC);
    expect(burnRateOver(old, NOW, 60)).toBe(0);
    const edge = [{ minute: NOW - 60, total: 100, bad: 100 }, { minute: NOW, total: 100, bad: 0 }];
    expect(burnRateOver(edge, NOW, 60)).toBe(0);
    expect(burnRateOver([{ minute: NOW + 1, total: 100, bad: 100 }], NOW, 60)).toBe(0);
  });

  it('fires at exactly 14.4 times the allowed rate in both windows, and not below it', () => {
    const atRate = traffic(NOW - 59, NOW, () => 14.4);
    expect(evaluateBurn(atRate, FAST_BURN, NOW)).toMatchObject({ longRate: 14.4, shortRate: 14.4, firing: true });
    const below = traffic(NOW - 59, NOW, () => 14.3);
    expect(evaluateBurn(below, FAST_BURN, NOW).firing).toBe(false);
  });

  it('needs both windows: an hour that is hot but a last five minutes that are quiet has stopped, and a last five minutes alone is a blip', () => {
    const stopped = traffic(NOW - 59, NOW, (minute) => (minute <= NOW - 5 ? 200 : 0));
    expect(evaluateBurn(stopped, FAST_BURN, NOW)).toMatchObject({ firing: false });
    expect(evaluateBurn(stopped, FAST_BURN, NOW).longRate).toBeGreaterThan(FAST_BURN.burnRate);
    expect(evaluateBurn(stopped, FAST_BURN, NOW).shortRate).toBe(0);
    const blip = traffic(NOW - 59, NOW, (minute) => (minute === NOW ? 100 : 0));
    expect(evaluateBurn(blip, FAST_BURN, NOW).shortRate).toBeGreaterThan(FAST_BURN.burnRate);
    expect(evaluateBurn(blip, FAST_BURN, NOW).longRate).toBeLessThan(FAST_BURN.burnRate);
    expect(evaluateBurn(blip, FAST_BURN, NOW).firing).toBe(false);
  });

  it('has a slow rule on longer windows for a leak that the fast rule does not see', () => {
    const leak = traffic(NOW - 359, NOW, () => 6);
    expect(evaluateBurn(leak, FAST_BURN, NOW).firing).toBe(false);
    expect(evaluateBurn(leak, SLOW_BURN, NOW)).toMatchObject({ longRate: 6, shortRate: 6, firing: true });
  });
});

describe('budgetStatus', () => {
  it('has 43.2 minutes of budget in 30 days at 99.9 percent, all of it left when nothing failed', () => {
    const status = budgetStatus({ buckets: traffic(NOW - THIRTY_DAYS + 1, NOW), nowMinute: NOW });
    expect(status).toMatchObject({ objective: SLO_OBJECTIVE, budgetMinutes: 43.2, consumedMinutes: 0, remainingMinutes: 43.2, remainingPercent: 100, availability: 1, exhausted: false, breached: false });
  });

  it('counts a minute of failures as the share of the requests of that minute that failed', () => {
    const status = budgetStatus({ buckets: [{ minute: NOW, total: 200, bad: 50 }, { minute: NOW - 1, total: 0, bad: 0 }], nowMinute: NOW });
    expect(status.consumedMinutes).toBe(0.25);
  });

  it('forgets what is older than the window', () => {
    const buckets = [{ minute: NOW - THIRTY_DAYS, total: 100, bad: 100 }, { minute: NOW - THIRTY_DAYS + 1, total: 100, bad: 100 }];
    expect(budgetStatus({ buckets, nowMinute: NOW }).consumedMinutes).toBe(1);
  });

  it('is exhausted at exactly the budget and breached only above it', () => {
    // An objective of 50 percent over one day leaves 720 minutes, so that the budget can be reached exactly.
    const half = { objective: 0.5, windowDays: 1, nowMinute: NOW, buckets: [] };
    expect(budgetStatus({ ...half, outages: [{ startMinute: NOW - 719, minutes: 719, reason: 'one short' }] })).toMatchObject({ exhausted: false, breached: false });
    expect(budgetStatus({ ...half, outages: [{ startMinute: NOW - 719, minutes: 720, reason: 'exactly' }] })).toMatchObject({ budgetMinutes: 720, consumedMinutes: 720, remainingMinutes: 0, exhausted: true, breached: false, exhaustedSinceMinute: NOW });
    expect(budgetStatus({ ...half, outages: [{ startMinute: NOW - 720, minutes: 721, reason: 'one over' }] })).toMatchObject({ exhausted: true, breached: true });
    const under = budgetStatus({ buckets: traffic(NOW - 42, NOW, () => TRAFFIC), nowMinute: NOW });
    expect(under).toMatchObject({ consumedMinutes: 43, exhausted: false, breached: false });
    const over = budgetStatus({ buckets: traffic(NOW - 43, NOW, () => TRAFFIC), nowMinute: NOW });
    expect(over).toMatchObject({ consumedMinutes: 44, exhausted: true, breached: true });
  });

  it('says since when the budget has been spent: the minute the running total reached it', () => {
    const buckets = traffic(NOW - 99, NOW, (minute) => (minute > NOW - 60 ? TRAFFIC : 0));
    const status = budgetStatus({ buckets, nowMinute: NOW });
    expect(status.exhaustedSinceMinute).toBe(NOW - 59 + 43);
    expect(budgetStatus({ buckets: traffic(NOW - 9, NOW), nowMinute: NOW }).exhaustedSinceMinute).toBeUndefined();
  });

  it('AC-ST-KERNEL-052-3 UAT-AC173: a DR drill outage of 4 hours counts fully against the budget, whatever traffic the buckets show, and the breach is reported', () => {
    const drill: DeclaredOutage = { startMinute: NOW - 240, minutes: 240, reason: 'DR drill' };
    // Requests that were answered from a cache during the drill must not make the outage smaller.
    const status = budgetStatus({ buckets: traffic(NOW - THIRTY_DAYS + 1, NOW), outages: [drill], nowMinute: NOW });
    expect(status.consumedMinutes).toBe(240);
    expect(status.remainingMinutes).toBeCloseTo(43.2 - 240, 6);
    expect(status.breached).toBe(true);
    expect(status.exhausted).toBe(true);
    expect(status.availability).toBeCloseTo(1 - 240 / THIRTY_DAYS, 5);
    expect(status.availability).toBeLessThan(SLO_OBJECTIVE);
    expect(status.remainingPercent).toBeLessThan(0);
    // The outage is not counted twice where the buckets also show failures.
    const both = budgetStatus({ buckets: traffic(NOW - 239, NOW - 200, () => TRAFFIC), outages: [drill], nowMinute: NOW });
    expect(both.consumedMinutes).toBe(240);
  });

  it('counts the part of an outage that lies inside the window', () => {
    const status = budgetStatus({ buckets: [], outages: [{ startMinute: NOW - THIRTY_DAYS - 100, minutes: 111, reason: 'early' }], nowMinute: NOW });
    expect(status.consumedMinutes).toBe(10);
    expect(budgetStatus({ buckets: [], outages: [{ startMinute: NOW + 5, minutes: 10, reason: 'future' }], nowMinute: NOW }).consumedMinutes).toBe(0);
  });
});

describe('reportSlo', () => {
  const rule = (id: string): AlertRule => ({
    id,
    severity: 'critical',
    channel: 'operations',
    owner: 'platform-oncall',
    runbook: `docs/runbooks/alerts/${id}.md`,
    adapter: 'webhook',
    source: { type: 'event', code: id },
    summary: id,
  });
  const evaluator = (): AlertEvaluator => new AlertEvaluator([rule(SLO_FAST_BURN_ALERT), rule(SLO_SLOW_BURN_ALERT), rule(SLO_BUDGET_EXHAUSTED_ALERT)], () => new Date('2026-11-03T08:00:00Z'));

  it('AC-ST-KERNEL-052-1 UAT-NFR-AVAILABILITY-01: an injection that burns the budget faster than 14.4 times fires the fast-burn alert within 5 minutes of its start, and the dashboard shows about 3 minutes of budget consumed', () => {
    const telemetry = new CollectingTelemetry();
    const rules = evaluator();
    const start = NOW - 10;
    // A healthy month, then 3 minutes in which every request fails (a rate of 1000 times the allowed one), evaluated every minute.
    const history = traffic(NOW - THIRTY_DAYS + 1, start - 1);
    let firedAt: number | undefined;
    let shown = 0;
    for (let minute = start; minute <= NOW; minute += 1) {
      const injected = traffic(start, minute, (at) => (at < start + 3 ? TRAFFIC : 0));
      const { status } = reportSlo({ service: 'DIS', buckets: [...history, ...injected], nowMinute: minute, metrics: telemetry, alerts: telemetry });
      shown = status.consumedMinutes;
      const fired = rules.evaluate(telemetry.snapshot()).fired.some((alert) => alert.ruleId === SLO_FAST_BURN_ALERT);
      if (fired && firedAt === undefined) firedAt = minute;
    }
    expect(firedAt).toBeDefined();
    expect((firedAt as number) - start).toBeLessThan(5);
    expect(shown).toBe(3);
  });

  it('publishes the figures of the dashboard as gauges of the service: budget consumed and left, and the burn rate of each window', () => {
    const telemetry = new CollectingTelemetry();
    reportSlo({ service: 'PAY', buckets: traffic(NOW - 59, NOW, () => 14.4), nowMinute: NOW, metrics: telemetry, alerts: telemetry });
    const gauges = telemetry.snapshot().gauges;
    const value = (name: string, labels: Record<string, string>): number | undefined => gauges.find((gauge) => gauge.name === name && Object.entries(labels).every(([key, label]) => gauge.labels[key] === label))?.value;
    expect(value('slo_error_budget_consumed_minutes', { service: 'PAY' })).toBeCloseTo(0.864, 6);
    expect(value('slo_error_budget_remaining_percent', { service: 'PAY' })).toBeCloseTo(98, 1);
    expect(value('slo_burn_rate', { service: 'PAY', window: '60m' })).toBe(14.4);
    expect(value('slo_burn_rate', { service: 'PAY', window: '5m' })).toBe(14.4);
    expect(value('slo_burn_rate', { service: 'PAY', window: '360m' })).toBe(14.4);
    expect(value('slo_burn_rate', { service: 'PAY', window: '30m' })).toBe(14.4);
  });

  it('raises the slow-burn alert for a leak, and nothing for a healthy service', () => {
    const leak = new CollectingTelemetry();
    reportSlo({ service: 'CAP', buckets: traffic(NOW - 359, NOW, () => 6), nowMinute: NOW, metrics: leak, alerts: leak });
    expect(leak.snapshot().events).toEqual([SLO_SLOW_BURN_ALERT]);
    const healthy = new CollectingTelemetry();
    const report = reportSlo({ service: 'IAM', buckets: traffic(NOW - 359, NOW), nowMinute: NOW, metrics: healthy, alerts: healthy });
    expect(healthy.snapshot().events).toEqual([]);
    expect(report).toMatchObject({ fastBurn: false, slowBurn: false });
  });

  it('AC-ST-KERNEL-052-3 UAT-AC173: reports the breach of the SLO after a 4 hour DR drill, naming the service and the figures', () => {
    const raised: Array<{ code: string; context: Record<string, unknown> }> = [];
    const telemetry = new CollectingTelemetry();
    const alerts = { raise: (code: string, context: Record<string, unknown>): void => void raised.push({ code, context }) };
    const report = reportSlo({ service: 'DIS', buckets: [], outages: [{ startMinute: NOW - 240, minutes: 240, reason: 'DR drill' }], nowMinute: NOW, metrics: telemetry, alerts });
    expect(report.status.breached).toBe(true);
    expect(raised).toEqual([{ code: SLO_BUDGET_EXHAUSTED_ALERT, context: { service: 'DIS', consumedMinutes: 240, budgetMinutes: 43.2 } }]);
  });

  it('raises the budget alert as soon as the budget is spent, not only when it is overspent', () => {
    const telemetry = new CollectingTelemetry();
    const buckets = [...traffic(NOW - 43, NOW - 1, () => TRAFFIC), { minute: NOW, total: TRAFFIC, bad: 200 }];
    const report = reportSlo({ service: 'PRJ', buckets, nowMinute: NOW, metrics: telemetry, alerts: telemetry });
    expect(report.status).toMatchObject({ consumedMinutes: 43.2, exhausted: true, breached: false });
    expect(telemetry.snapshot().events).toContain(SLO_BUDGET_EXHAUSTED_ALERT);
  });

  it('covers the five core services', () => {
    expect([...SLO_SERVICES]).toEqual(['DIS', 'CAP', 'PAY', 'PRJ', 'IAM']);
  });
});

describe('budgetReport', () => {
  it('AC-ST-KERNEL-052-2 UAT-NFR-AVAILABILITY-01: says that the budget is spent, and since when, as the release pipeline reads it', () => {
    const spent = budgetStatus({ buckets: [], outages: [{ startMinute: NOW - 240, minutes: 240, reason: 'DR drill' }], nowMinute: NOW });
    const fine = budgetStatus({ buckets: traffic(NOW - 9, NOW), nowMinute: NOW });
    const report = budgetReport(
      [
        { service: 'DIS', status: spent },
        { service: 'CAP', status: fine },
      ],
      new Date('2026-11-03T08:00:00Z'),
    );
    expect(report).toEqual({
      generatedAt: '2026-11-03T08:00:00.000Z',
      exhausted: true,
      exhaustedAt: new Date((NOW - 240 + 43) * 60_000).toISOString(),
      services: [
        { service: 'DIS', consumedMinutes: 240, budgetMinutes: 43.2, remainingPercent: spent.remainingPercent, exhausted: true },
        { service: 'CAP', consumedMinutes: 0, budgetMinutes: 43.2, remainingPercent: 100, exhausted: false },
      ],
    });
  });

  it('names no moment while no service has spent its budget, and takes the earliest when several have', () => {
    const fine = budgetStatus({ buckets: [], nowMinute: NOW });
    expect(budgetReport([{ service: 'PAY', status: fine }], new Date('2026-11-03T08:00:00Z'))).toMatchObject({ exhausted: false });
    expect('exhaustedAt' in budgetReport([{ service: 'PAY', status: fine }], new Date())).toBe(false);
    const early = budgetStatus({ buckets: [], outages: [{ startMinute: NOW - 400, minutes: 100, reason: 'a' }], nowMinute: NOW });
    const late = budgetStatus({ buckets: [], outages: [{ startMinute: NOW - 100, minutes: 100, reason: 'b' }], nowMinute: NOW });
    const report = budgetReport([{ service: 'IAM', status: late }, { service: 'PRJ', status: early }], new Date());
    expect(report.exhaustedAt).toBe(new Date((NOW - 400 + 43) * 60_000).toISOString());
  });
});
