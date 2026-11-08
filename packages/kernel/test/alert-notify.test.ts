import { DomainError } from '../src/errors';
import {
  ALERT_CHANNELS,
  alertNotifyDefaults,
  alertNotifyPolicyOf,
  assertPushPayloadSafe,
  assertValidAlertProfile,
  buildPushPayload,
  composeDigest,
  effectiveAlertProfile,
  emptyAlertProfile,
  planNotification,
  quietAt,
  validateAlertProfile,
  weekdayInZone,
} from '../src/alert-notify';
import type { AlertProfile, DigestInputRow, NotifyContext, NotifyOccasion } from '../src/alert-notify';
import { builtInDefault, validateRuleParams } from '../src/governance-rules';

const policy = alertNotifyDefaults();
const at = (iso: string): Date => new Date(iso);
// Friday 2027-10-15: 10:00 in Vietnam is 03:00 UTC, 22:00 is 15:00 UTC; Saturday 10:00 is 03:00 UTC on the 16th.
const FRI_10 = at('2027-10-15T03:00:00Z');
const FRI_22 = at('2027-10-15T15:00:00Z');
const SAT_10 = at('2027-10-16T03:00:00Z');
const MON_0630 = '2027-10-17T23:30:00.000Z';
const refusal = (run: () => unknown): DomainError => {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
};

const context = (over: Partial<NotifyContext> = {}): NotifyContext => ({ now: FRI_10, profile: effectiveAlertProfile(policy, null), sentToday: 0, urgentThisHour: 0, consent: {}, ...over });
const occasion = (over: Partial<NotifyOccasion> = {}): NotifyOccasion => ({ kind: 'NEW_ITEM', severity: 'ACTION', claimBreached: false, typeMayBreakQuiet: false, ...over });
const pushOf = (plan: ReturnType<typeof planNotification>): ReturnType<typeof planNotification>['deliveries'][number] | undefined => plan.deliveries.find((delivery) => delivery.channel === 'PUSH');

describe('the notification policy (G2-5)', () => {
  it('is the built-in default of the rule type and passes its own schema and parser', () => {
    const found = builtInDefault('ALERT_NOTIFY_POLICY', 'DEFAULT');
    expect(found?.unverified).toBe(true);
    expect(alertNotifyPolicyOf(found?.params)).toEqual(policy);
    expect(validateRuleParams('ALERT_NOTIFY_POLICY', found?.params)).toEqual(found?.params);
  });

  it('refuses a policy that takes the bell out, pushes an item to be watched, or has no quiet window', () => {
    const channels = (over: Record<string, unknown>): unknown => ({ ...policy, default_channels: { ...policy.default_channels, ...over } });
    expect(refusal(() => alertNotifyPolicyOf(channels({ ACTION: ['PUSH'] }))).detail).toBe('default_channels.ACTION');
    expect(refusal(() => alertNotifyPolicyOf(channels({ WATCH: ['IN_APP', 'PUSH'] }))).detail).toBe('default_channels.WATCH');
    expect(refusal(() => alertNotifyPolicyOf(channels({ URGENT: ['IN_APP', 'IN_APP'] }))).detail).toBe('default_channels.URGENT');
    expect(refusal(() => alertNotifyPolicyOf({ ...policy, quiet_to: policy.quiet_from })).detail).toBe('quiet_to');
    expect(refusal(() => alertNotifyPolicyOf({ ...policy, time_zone: 'Mars/Base' })).detail).toBe('time_zone');
    expect(refusal(() => alertNotifyPolicyOf({ ...policy, push_cap_per_day: 101 })).detail).toBe('push_cap_per_day');
  });
});

describe('the profile of a person (G2-5)', () => {
  const profile = (over: Partial<AlertProfile> = {}): AlertProfile => ({ ...emptyAlertProfile(), ...over });

  it('accepts what the policy allows and lays the choices of the person over it, saying whose each value is', () => {
    expect(validateAlertProfile(profile(), policy)).toEqual([]);
    const chosen = profile({ channels: { URGENT: ['IN_APP', 'PUSH', 'SMS'] }, quiet: { from: '22:00', to: '06:00', weekends: false, timeZone: 'Asia/Ho_Chi_Minh' }, push_cap_per_day: 3, push_min_severity: 'URGENT', digest_at: '08:00' });
    expect(validateAlertProfile(chosen, policy)).toEqual([]);
    const effective = effectiveAlertProfile(policy, chosen);
    expect(effective.channels.URGENT).toEqual(['IN_APP', 'PUSH', 'SMS']);
    expect(effective.channels.ACTION).toEqual(['IN_APP', 'PUSH']);
    expect(effective).toMatchObject({ pushCapPerDay: 3, pushMinSeverity: 'URGENT', digestAt: '08:00', quiet: { from: '22:00', weekends: false } });
    expect(effective.own).toEqual({ channels: true, quiet: true, digestAt: true, pushMinSeverity: true, pushCapPerDay: true, groupSameRoot: false });
    expect(effectiveAlertProfile(policy, null).own).toEqual({ channels: false, quiet: false, digestAt: false, pushMinSeverity: false, pushCapPerDay: false, groupSameRoot: false });
  });

  it('takes the quiet hours the person set in the notification preferences when the alert profile has none', () => {
    const effective = effectiveAlertProfile(policy, null, { from: '20:00', to: '07:00', timeZone: 'Asia/Ho_Chi_Minh' });
    expect(effective.quiet).toEqual({ from: '20:00', to: '07:00', weekends: true, timeZone: 'Asia/Ho_Chi_Minh' });
    expect(effective.own.quiet).toBe(false);
    expect(effectiveAlertProfile(policy, profile({ quiet: { from: '23:00', to: '05:00', weekends: false, timeZone: 'Asia/Bangkok' } }), { from: '20:00', to: '07:00', timeZone: 'Asia/Ho_Chi_Minh' }).quiet.from).toBe('23:00');
  });

  it('never lets a person take the bell out, push an item to be watched, raise the cap above the policy or ask for a lower threshold than the floor', () => {
    const codes = (over: Partial<AlertProfile>, rule = policy): string[] => validateAlertProfile(profile(over), rule).map((defect) => `${defect.field}:${defect.code}`);
    expect(codes({ channels: { URGENT: ['PUSH'] } })).toEqual(['channels.URGENT:BELL_REQUIRED']);
    expect(codes({ channels: { WATCH: ['IN_APP', 'SMS'] } })).toEqual(['channels.WATCH:WATCH_NOT_PUSHED']);
    expect(codes({ channels: { ACTION: ['IN_APP', 'IN_APP'] } })).toEqual(['channels.ACTION:DUPLICATE']);
    expect(codes({ channels: { ACTION: ['IN_APP', 'FAX'] } })).toEqual(['channels.ACTION:UNSUPPORTED']);
    expect(codes({ push_cap_per_day: 6 })).toEqual(['push_cap_per_day:ABOVE_POLICY']);
    expect(codes({ push_cap_per_day: -1 })).toEqual(['push_cap_per_day:MALFORMED']);
    expect(codes({ push_min_severity: 'ACTION' }, { ...policy, push_min_severity_floor: 'URGENT' })).toEqual(['push_min_severity:ABOVE_POLICY']);
    expect(codes({ quiet: { from: '21:00', to: '21:00', weekends: true, timeZone: 'Asia/Ho_Chi_Minh' } })).toEqual(['quiet.to:SAME_TIME']);
    expect(codes({ quiet: { from: '25:00', to: '06:00', weekends: true, timeZone: 'Nowhere/None' } })).toEqual(['quiet.from:MALFORMED', 'quiet.time_zone:UNSUPPORTED']);
    expect(codes({ digest_at: '7:30' })).toEqual(['digest_at:MALFORMED']);
    expect(refusal(() => assertValidAlertProfile(profile({ push_cap_per_day: 50 }), policy))).toMatchObject({ code: 'ALERT_PROFILE_INVALID', detail: 'push_cap_per_day' });
  });
});

describe('quiet hours of a person (G2-5)', () => {
  const quiet = effectiveAlertProfile(policy, null).quiet;

  it('are the evenings, the nights and the weekends on the wall clock of the person', () => {
    expect(weekdayInZone(SAT_10, 'Asia/Ho_Chi_Minh')).toBe(6);
    expect(weekdayInZone(FRI_10, 'Asia/Ho_Chi_Minh')).toBe(5);
    expect(quietAt(FRI_10, quiet)).toEqual({ quiet: false });
    expect(quietAt(at('2027-10-15T14:00:00Z'), quiet).quiet).toBe(true);
    expect(quietAt(at('2027-10-15T22:30:00Z'), { ...quiet, weekends: false })).toEqual({ quiet: true, endsAt: new Date('2027-10-15T23:30:00.000Z') });
    // Friday evening runs into the weekend: the quiet ends on Monday at the end of the night.
    expect(quietAt(FRI_22, quiet)).toEqual({ quiet: true, endsAt: new Date(MON_0630) });
    expect(quietAt(SAT_10, quiet).quiet).toBe(true);
    expect(quietAt(SAT_10, { ...quiet, weekends: false })).toEqual({ quiet: false });
  });
});

describe('what to do about telling one person of one alert (G2-5)', () => {
  it('sends an alert to be acted on by push in the day and keeps it out of the digest', () => {
    const plan = planNotification(occasion(), context());
    expect(plan.inApp).toBe(true);
    expect(pushOf(plan)).toMatchObject({ decision: 'SEND_NOW', holdUntil: null, bypass: null, inQuiet: false });
    expect(plan.digest).toBe(false);
  });

  it('never pushes an item to be watched: only the bell and the digest', () => {
    const plan = planNotification(occasion({ severity: 'WATCH' }), context());
    expect(plan.deliveries).toEqual([]);
    expect(plan.digest).toBe(true);
    const asked = planNotification(occasion({ severity: 'WATCH' }), context({ profile: effectiveAlertProfile(policy, null) }));
    expect(asked.deliveries.some((delivery) => delivery.decision === 'SEND_NOW')).toBe(false);
  });

  it('holds a push in the quiet hours until they end and puts the item in the digest', () => {
    const plan = planNotification(occasion(), context({ now: FRI_22 }));
    expect(pushOf(plan)).toMatchObject({ decision: 'HOLD_QUIET', holdUntil: MON_0630 });
    expect(plan.digest).toBe(true);
    expect(plan.inApp).toBe(true);
  });

  it('lets an urgent alert break the quiet hours only when its type allows it and nobody took it up in time', () => {
    const urgent = (over: Partial<NotifyOccasion>): ReturnType<typeof planNotification> => planNotification(occasion({ severity: 'URGENT', ...over }), context({ now: FRI_22 }));
    expect(pushOf(urgent({ typeMayBreakQuiet: true, claimBreached: true }))).toMatchObject({ decision: 'SEND_NOW', bypass: 'URGENT_UNCLAIMED', inQuiet: true });
    expect(pushOf(urgent({ typeMayBreakQuiet: true, claimBreached: false }))?.decision).toBe('HOLD_QUIET');
    expect(pushOf(urgent({ typeMayBreakQuiet: false, claimBreached: true }))?.decision).toBe('HOLD_QUIET');
    expect(pushOf(planNotification(occasion({ severity: 'ACTION', typeMayBreakQuiet: true, claimBreached: true }), context({ now: FRI_22 })))?.decision).toBe('HOLD_QUIET');
  });

  it('sends the urgent alerts above the cap, or beyond the third of the hour, as one grouped notice and sends the others to the digest', () => {
    const capped = context({ sentToday: 5 });
    expect(pushOf(planNotification(occasion({ severity: 'URGENT' }), capped))?.decision).toBe('SEND_GROUPED');
    expect(pushOf(planNotification(occasion({ severity: 'URGENT' }), context({ urgentThisHour: 3 })))?.decision).toBe('SEND_GROUPED');
    expect(pushOf(planNotification(occasion({ severity: 'URGENT' }), context({ urgentThisHour: 2 })))?.decision).toBe('SEND_NOW');
    const spilled = planNotification(occasion({ severity: 'ACTION' }), capped);
    expect(pushOf(spilled)?.decision).toBe('SKIP_CAP');
    expect(spilled.digest).toBe(true);
  });

  it('keeps the threshold of the person, and asks for the consent that SMS and Zalo need', () => {
    const urgentOnly = context({ profile: effectiveAlertProfile(policy, { ...emptyAlertProfile(), push_min_severity: 'URGENT' }) });
    expect(pushOf(planNotification(occasion({ severity: 'ACTION' }), urgentOnly))?.decision).toBe('SKIP_THRESHOLD');
    expect(pushOf(planNotification(occasion({ severity: 'URGENT' }), urgentOnly))?.decision).toBe('SEND_NOW');
    const sms = effectiveAlertProfile(policy, { ...emptyAlertProfile(), channels: { URGENT: ['IN_APP', 'SMS', 'ZALO'] } });
    const noConsent = planNotification(occasion({ severity: 'URGENT' }), context({ profile: sms }));
    expect(noConsent.deliveries.map((delivery) => `${delivery.channel}:${delivery.decision}`)).toEqual(['SMS:SKIP_CONSENT', 'ZALO:SKIP_CONSENT']);
    const consented = planNotification(occasion({ severity: 'URGENT' }), context({ profile: sms, consent: { SMS: true } }));
    expect(consented.deliveries.map((delivery) => `${delivery.channel}:${delivery.decision}`)).toEqual(['SMS:SEND_NOW', 'ZALO:SKIP_CONSENT']);
  });

  it('does not hold or cap e-mail, which is read when the person chooses to', () => {
    const mail = effectiveAlertProfile(policy, { ...emptyAlertProfile(), channels: { ACTION: ['IN_APP', 'EMAIL'] } });
    const plan = planNotification(occasion(), context({ now: FRI_22, profile: mail, sentToday: 50 }));
    expect(plan.deliveries).toEqual([{ channel: 'EMAIL', decision: 'SEND_NOW', holdUntil: null, bypass: null, inQuiet: false }]);
  });

  it('always keeps the bell, whatever the time, the cap, the severity, the consent and the threshold (every combination)', () => {
    const profiles = [effectiveAlertProfile(policy, null), effectiveAlertProfile(policy, { ...emptyAlertProfile(), push_min_severity: 'URGENT', push_cap_per_day: 0 })];
    for (const severity of ['URGENT', 'ACTION', 'WATCH'] as const) {
      for (const now of [FRI_10, FRI_22, SAT_10]) {
        for (const sentToday of [0, 5, 99]) {
          for (const profile of profiles) {
            for (const claimBreached of [true, false]) {
              const plan = planNotification(occasion({ severity, claimBreached, typeMayBreakQuiet: true }), { now, profile, sentToday, urgentThisHour: 9, consent: {} });
              expect(plan.inApp).toBe(true);
              for (const delivery of plan.deliveries) {
                // A notice that interrupts and is sent in the quiet hours always carries the reason that allowed it.
                if (delivery.inQuiet) expect(delivery.bypass).toBe('URGENT_UNCLAIMED');
                if (severity === 'WATCH') expect(delivery.decision).not.toBe('SEND_NOW');
              }
            }
          }
        }
      }
    }
  });
});

describe('the words of a push (G2-5, R7)', () => {
  it('is a fixed sentence, a count and a path, and nothing of the item', () => {
    const payload = buildPushPayload({ kind: 'GROUP', severity: 'URGENT', count: 4, link: '/home/my-work?view=mine' });
    expect(Object.keys(payload).sort()).toEqual(['body', 'collapse_key', 'count', 'kind', 'link', 'severity', 'title']);
    expect(payload.body).toBe('Bạn có 4 việc khẩn. Mở ứng dụng để xem.');
    expect(payload.title.startsWith('Khẩn: ')).toBe(true);
    expect(payload.collapse_key).toBe('alert-group-urgent');
    assertPushPayloadSafe(payload);
    // The only digits in the words are the count.
    expect((payload.title + payload.body).replace(/4/g, '').match(/[0-9]/)).toBeNull();
    expect(buildPushPayload({ kind: 'ITEM', severity: 'ACTION', count: 100_000, link: '/home/my-work' }).count).toBe(999);
    expect(buildPushPayload({ kind: 'ITEM', severity: 'ACTION', count: 0, link: '/home/my-work' }).count).toBe(1);
  });

  it('refuses a link that is not a plain path and a payload that carries more than the words', () => {
    expect(refusal(() => buildPushPayload({ kind: 'ITEM', severity: 'ACTION', count: 1, link: 'https://example.com/pay?amount=1200000000' })).detail).toBe('link');
    expect(refusal(() => buildPushPayload({ kind: 'ITEM', severity: 'ACTION', count: 1, link: '/home/my-work?name=Nguyen Van A' })).detail).toBe('link');
    const payload = buildPushPayload({ kind: 'ITEM', severity: 'ACTION', count: 1, link: '/home/my-work' });
    expect(refusal(() => assertPushPayloadSafe({ ...payload, body: 'Hợp đồng A: thanh toán 1.200.000.000 đồng' })).detail).toBe('payload');
    expect(refusal(() => assertPushPayloadSafe({ ...payload, amount: '1200000000' } as never)).detail).toBe('payload');
    expect(refusal(() => assertPushPayloadSafe({ ...payload, title: 'Nguyễn Văn A' })).detail).toBe('payload');
    expect(refusal(() => buildPushPayload({ kind: 'SMS' as never, severity: 'ACTION', count: 1, link: '/home' })).detail).toBe('kind');
  });

  it('has a channel list that the profile screen can show', () => {
    expect(ALERT_CHANNELS).toEqual(['IN_APP', 'PUSH', 'EMAIL', 'SMS', 'ZALO']);
  });
});

describe('the morning digest (G2-5)', () => {
  const row = (id: string, over: Partial<DigestInputRow> = {}): DigestInputRow => ({ source: 'ISSUE', id, title: `Item ${id}`, subtitle: null, severity: 'ACTION', dueOn: null, consequence: 'Consequence', firstSeenAt: null, target: { screen: 'ISS-09', id }, onBehalfOf: null, snoozed: false, ...over });
  const options = { today: '2027-10-15', lookaheadDays: 3, maxLines: 20, newSince: '2027-10-14T23:30:00.000Z' };

  it('lists each item once: overdue first, then due soon, then new since the last digest, then what waits for them as a deputy', () => {
    const digest = composeDigest(
      [
        row('late', { dueOn: '2027-10-10', severity: 'URGENT' }),
        row('soon', { dueOn: '2027-10-17' }),
        row('far', { dueOn: '2027-11-30', firstSeenAt: '2027-10-15T01:00:00.000Z' }),
        row('fresh', { firstSeenAt: '2027-10-15T01:00:00.000Z' }),
        row('old', { firstSeenAt: '2027-10-01T01:00:00.000Z' }),
        row('theirs', { onBehalfOf: 'A', dueOn: '2027-10-01' }),
        row('put-off', { dueOn: '2027-10-10', snoozed: true }),
      ],
      options,
    );
    expect(digest.sections.map((section) => [section.code, section.lines.map((line) => line.id)])).toEqual([
      ['OVERDUE', ['late']],
      ['DUE_SOON', ['soon']],
      ['NEW', ['far', 'fresh']],
      ['ON_BEHALF', ['theirs']],
    ]);
    expect(digest.total).toBe(5);
    expect(digest.omitted).toBe(0);
    expect(digest.sections[0]?.lines[0]).toMatchObject({ consequence: 'Consequence', action: { screen: 'ISS-09', id: 'late' } });
  });

  it('says how many lines did not fit instead of dropping them silently, and counts every line of a section', () => {
    const many = Array.from({ length: 8 }, (_, index) => row(`late-${index}`, { dueOn: '2027-10-01' }));
    const digest = composeDigest(many, { ...options, maxLines: 5 });
    expect(digest.sections[0]).toMatchObject({ code: 'OVERDUE', count: 8 });
    expect(digest.sections[0]?.lines).toHaveLength(5);
    expect(digest.omitted).toBe(3);
    expect(digest.total).toBe(8);
  });

  it('has no new section line when no digest was sent before, and shows everything seen as new', () => {
    const digest = composeDigest([row('a', { firstSeenAt: '2027-10-01T00:00:00.000Z' })], { ...options, newSince: null });
    expect(digest.sections.find((section) => section.code === 'NEW')?.count).toBe(1);
  });
});
