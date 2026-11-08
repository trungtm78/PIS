import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { itemKey, observationDecision } from '@machvon/kernel';
import { AlertFeedbackStore } from '../src/alert-feedback-store';
import { AlertFloodStore } from '../src/alert-flood-store';
import { AlertLadderStore } from '../src/alert-ladder-store';
import { AlertObservationStore } from '../src/alert-observation-store';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const observation = new AlertObservationStore();
const feedback = new AlertFeedbackStore();
const flood = new AlertFloodStore();
const ladders = new AlertLadderStore();

const ROOT = 1;
const REPORTER = 1;
const REVIEWER = 2;
const NOW = new Date('2027-10-15T03:00:00Z');
const LATER = new Date('2027-10-15T04:00:00Z');

const as = <T>(work: (tx: Parameters<Parameters<typeof harness.tenants.withTenant>[1]>[0]) => Promise<T>, tenant = TENANT_A, member = REPORTER): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);

async function admin(statements: Array<[string, unknown[]]>): Promise<void> {
  const client = new Client({ connectionString: harness.database.adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    for (const [sql, params] of statements) await client.query(sql, params);
  } finally {
    await client.end();
  }
}

const meta = (kind: string) => ({ kind, alertTypeCode: kind, severity: 'ACTION', causeKey: null });

/** The stores of the closing, the feedback, the flood and the channel ladder of the alert centre (lane GOV-10). */
describe('the stores of the alert operations', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
      await harness.seedMembership(tenant, REPORTER, ROOT);
      await harness.seedMembership(tenant, REVIEWER, ROOT);
    }
  }, 300_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the observation of alerts (G2-8)', () => {
    it('opens what a pass sees, closes what cleared with the count of decisions it had, and does it once per pass', async () => {
      const first = { source: 'ADVANCE', sourceId: 'a-1' };
      const second = { source: 'PERMIT', sourceId: 'p-1' };
      const opened = observationDecision({ produced: [first, second], known: [], answeredSources: new Set(['ADVANCE', 'PERMIT']), failedSources: new Set() });
      const metas = new Map([[itemKey('ADVANCE', 'a-1'), meta('ADVANCE')], [itemKey('PERMIT', 'p-1'), meta('PERMIT')]]);
      const one = await as((tx) => observation.apply(tx, opened, metas, NOW, 'pass-1'));
      expect(one).toMatchObject({ opened: 2, closed: 0 });
      // The same pass again records nothing new.
      expect((await as((tx) => observation.apply(tx, opened, metas, NOW, 'pass-1'))).opened).toBe(0);
      // One decision of a person on the advance.
      await admin([[`insert into machvon.work_action (tenant_id, source, source_id, action, actor_membership_id) values ($1, 'ADVANCE', 'a-1', 'CLAIM', $2)`, [TENANT_A, memberId(REPORTER)]]]);
      const known = await as((tx) => observation.known(tx));
      const closing = observationDecision({ produced: [], known, answeredSources: new Set(['ADVANCE', 'PERMIT']), failedSources: new Set() });
      const two = await as((tx) => observation.apply(tx, closing, metas, LATER, 'pass-2'));
      expect(two.closed).toBe(2);
      const rows = await as((tx) => observation.list(tx, { state: 'RESOLVED_BY_SYSTEM', limit: 10 }));
      expect(rows.map((row) => [row.sourceId, row.decisionsBeforeClose]).sort()).toEqual([['a-1', 1], ['p-1', 0]]);
      expect((await as((tx) => observation.list(tx, { withoutRecord: true, limit: 10 }))).map((row) => row.sourceId)).toEqual(['p-1']);
    });

    it('reopens an item whose condition came back, counts it, and never closes what a failing source may be hiding', async () => {
      const known = await as((tx) => observation.known(tx));
      const back = observationDecision({ produced: [{ source: 'ADVANCE', sourceId: 'a-1' }], known, answeredSources: new Set(['ADVANCE']), failedSources: new Set() });
      expect(back.reopen).toEqual([{ source: 'ADVANCE', sourceId: 'a-1' }]);
      const result = await as((tx) => observation.apply(tx, back, new Map([[itemKey('ADVANCE', 'a-1'), meta('ADVANCE')]]), new Date('2027-10-16T03:00:00Z'), 'pass-3'));
      expect(result.reopened).toBe(1);
      const [row] = await as((tx) => observation.list(tx, { reopened: true, limit: 10 }));
      expect(row).toMatchObject({ sourceId: 'a-1', state: 'OPEN', reopenCount: 1, closedAt: null, decisionsBeforeClose: null });
      // A pass in which the source failed closes nothing, whatever it produced.
      const unknown = observationDecision({ produced: [], known: await as((tx) => observation.known(tx)), answeredSources: new Set(), failedSources: new Set(['ADVANCE']) });
      expect(unknown.close).toEqual([]);
      expect((await as((tx) => observation.apply(tx, unknown, new Map(), new Date('2027-10-17T03:00:00Z'), 'pass-4'))).unknown).toBe(1);
    });

    it('measures the closing from the events, and keeps one tenant out of another', async () => {
      const summary = await as((tx) => observation.summary(tx, '2027-10-01', '2027-11-01'));
      expect(summary).toMatchObject({ closedBySystem: 2, reopened: 1, closedWithoutRecord: 1, openNow: 1 });
      expect(summary.medianHoursOpen).not.toBeNull();
      expect(summary.byType.find((entry) => entry.alertTypeCode === 'PERMIT')).toMatchObject({ closed: 1, withoutRecord: 1 });
      expect((await as((tx) => observation.summary(tx, '2027-10-01', '2027-11-01'), TENANT_B)).closedBySystem).toBe(0);
      expect((await as((tx) => observation.known(tx), TENANT_B))).toEqual([]);
    });
  });

  describe('the "this alert is wrong" report (G2-9)', () => {
    const report = { source: 'GUARANTEE', sourceId: 'g-1', alertTypeCode: 'GUARANTEE', severity: 'WATCH', reporter: memberId(REPORTER), reason: 'WRONG_DATA' };

    it('records a report once for a person and an item, and says so the second time', async () => {
      const made = await as((tx) => feedback.submit(tx, report));
      expect(made).toMatchObject({ status: 'PENDING', reason: 'WRONG_DATA', note: null, version: 1 });
      await expect(as((tx) => feedback.submit(tx, report))).rejects.toMatchObject({ code: 'ALERT_FEEDBACK_ALREADY_REPORTED', status: 409 });
      await expect(as((tx) => feedback.submit(tx, { ...report, sourceId: 'g-2', reason: 'OTHER' }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      const reported = await as((tx) => feedback.reportedBy(tx, memberId(REPORTER), [{ source: 'GUARANTEE', sourceId: 'g-1' }, { source: 'GUARANTEE', sourceId: 'g-3' }]));
      expect([...reported]).toEqual([`GUARANTEE\u0000g-1`]);
    });

    it('is reviewed by somebody else, with the version, and never decided twice', async () => {
      const [pending] = await as((tx) => feedback.queue(tx, { status: 'PENDING', limit: 10 }));
      const row = pending as NonNullable<typeof pending>;
      await expect(as((tx) => feedback.decide(tx, row.id, row.version, memberId(REPORTER), { move: 'ACCEPT_FOR_TUNING', proposalNote: 'raise the window' }))).rejects.toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
      await expect(as((tx) => feedback.decide(tx, row.id, 7, memberId(REVIEWER), { move: 'ACCEPT_FOR_TUNING' }), TENANT_A, REVIEWER)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      await expect(as((tx) => feedback.decide(tx, row.id, row.version, memberId(REVIEWER), { move: 'REJECT' }), TENANT_A, REVIEWER)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      const decided = await as((tx) => feedback.decide(tx, row.id, row.version, memberId(REVIEWER), { move: 'ACCEPT_FOR_TUNING', proposalNote: 'raise the window' }), TENANT_A, REVIEWER);
      expect(decided).toMatchObject({ status: 'ACCEPTED_FOR_TUNING', reviewerId: memberId(REVIEWER), proposalNote: 'raise the window', version: 2 });
      await expect(as((tx) => feedback.decide(tx, row.id, 2, memberId(REVIEWER), { move: 'REJECT', reviewNote: 'no' }), TENANT_A, REVIEWER)).rejects.toMatchObject({ code: 'ALERT_FEEDBACK_STATE_INVALID' });
      // The decided report is no longer "reported" on the item, and the same person can report it again.
      expect((await as((tx) => feedback.reportedBy(tx, memberId(REPORTER), [{ source: 'GUARANTEE', sourceId: 'g-1' }]))).size).toBe(0);
    });

    it('lets the reporter withdraw their own and marks a duplicate of a report of the same type', async () => {
      const mine = await as((tx) => feedback.submit(tx, { ...report, sourceId: 'g-9', reason: 'DUPLICATE' }));
      await expect(as((tx) => feedback.withdraw(tx, mine.id, mine.version, memberId(REVIEWER)), TENANT_A, REVIEWER)).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
      expect((await as((tx) => feedback.withdraw(tx, mine.id, mine.version, memberId(REPORTER)))).status).toBe('WITHDRAWN');
      const one = await as((tx) => feedback.submit(tx, { ...report, sourceId: 'g-10' }));
      const two = await as((tx) => feedback.submit(tx, { ...report, sourceId: 'g-11', reporter: memberId(REVIEWER) }), TENANT_A, REVIEWER);
      const marked = await as((tx) => feedback.decide(tx, two.id, two.version, memberId(REPORTER), { move: 'MARK_DUPLICATE', duplicateOfId: one.id }));
      expect(marked).toMatchObject({ status: 'DUPLICATE_OF', duplicateOfId: one.id });
    });

    it('counts the unhelpful share of a type against what was shown, and keeps tenants apart', async () => {
      const stats = await as((tx) => feedback.statsByType(tx, '2000-01-01', '2100-01-01'));
      const guarantee = stats.find((entry) => entry.alertTypeCode === 'GUARANTEE');
      expect(guarantee?.reports).toBeGreaterThanOrEqual(2);
      // Nothing of that type was shown (observed): there is no share, never zero.
      expect(guarantee?.share).toBeNull();
      expect(await as((tx) => feedback.queue(tx, { limit: 50 }), TENANT_B)).toEqual([]);
    });
  });

  describe('the storms (G2-11)', () => {
    it('reads the default policy as not confirmed and starts, keeps and ends a storm with its peak', async () => {
      const reading = await as((tx) => flood.policy(tx, '2027-10-15'));
      expect(reading).toMatchObject({ version: 'builtin', unverified: true, policy: { start_above: 10, end_below: 5 } });
      const start = await as((tx) => flood.observe(tx, memberId(REPORTER), { newInWindow: 12, grouped: 6, now: NOW, reading }));
      expect(start.change).toBe('STARTED');
      expect((await as((tx) => flood.current(tx, memberId(REPORTER)))).active).toBe(true);
      expect((await as((tx) => flood.observe(tx, memberId(REPORTER), { newInWindow: 8, grouped: 3, now: LATER, reading }))).change).toBe('NONE');
      expect((await as((tx) => flood.observe(tx, memberId(REPORTER), { newInWindow: 15, grouped: 9, now: LATER, reading }))).change).toBe('NONE');
      const end = await as((tx) => flood.observe(tx, memberId(REPORTER), { newInWindow: 2, grouped: 0, now: new Date('2027-10-15T05:00:00Z'), reading }));
      expect(end.change).toBe('ENDED');
      const [event] = await as((tx) => flood.list(tx, '2027-10-01', '2027-11-01', 10));
      expect(event).toMatchObject({ peakNew: 15, groupedCount: 9, endedAt: '2027-10-15T05:00:00.000Z' });
      expect(await as((tx) => flood.list(tx, '2027-10-01', '2027-11-01', 10), TENANT_B)).toEqual([]);
    });
  });

  describe('the channel ladder (G2-6)', () => {
    it('reads the built-in ladder of each severity as not confirmed', async () => {
      const urgent = await as((tx) => ladders.policy(tx, 'URGENT', '2027-10-15'));
      expect(urgent).toMatchObject({ version: 'builtin', unverified: true });
      expect(urgent.policy.rungs.map((rung) => rung.channel)).toEqual(['IN_APP', 'PUSH', 'ZALO', 'SMS']);
    });

    it('starts one ladder for an item and a person, records its rungs once, and reads the receipts back from the delivery engine', async () => {
      const reading = await as((tx) => ladders.policy(tx, 'URGENT', '2027-10-15'));
      const input = { source: 'ADVANCE', sourceId: 'ladder-1', recipient: memberId(REPORTER), severity: 'URGENT' as const, alertTypeCode: 'ADVANCE', reading, now: NOW };
      const run = await as((tx) => ladders.start(tx, input));
      expect(run).toMatchObject({ state: 'ACTIVE', policyVersion: 'builtin' });
      expect(await as((tx) => ladders.start(tx, input))).toBeUndefined();
      const runId = (run as NonNullable<typeof run>).id;
      const eventId = randomUUID();
      const rung = await as((tx) => ladders.recordRung(tx, { runId, index: 0, channel: 'IN_APP', now: NOW, outboxEventId: eventId, eventKey: `ladder:${runId}:0`, suppressed: null }));
      expect(rung.created).toBe(true);
      expect((await as((tx) => ladders.recordRung(tx, { runId, index: 0, channel: 'IN_APP', now: NOW, outboxEventId: eventId, eventKey: `ladder:${runId}:0`, suppressed: null }))).created).toBe(false);
      await as((tx) => ladders.recordRung(tx, { runId, index: 1, channel: 'PUSH', now: NOW, outboxEventId: null, eventKey: null, suppressed: 'NO_CONSENT' }));
      expect((await as((tx) => ladders.rungs(tx, runId))).map((entry) => [entry.channel, entry.state, entry.reason])).toEqual([['IN_APP', 'QUEUED', null], ['PUSH', 'SUPPRESSED', 'NO_CONSENT']]);
      // The event of the first rung met no notification yet: it stays queued; once the relay published it and nobody carried it for a while, it is NO_WORKFLOW.
      await admin([[`insert into machvon.outbox_event (tenant_id, id, aggregate_id, type, schema_version, payload, created_at, aggregate_type, aggregate_version, event_key, correlation_id, status, published_at)
                     values ($1, $2, $3, 'home.alert_ladder_in_app.v1', 1, '{}'::jsonb, $4, 'alert_ladder', 1, $5, $6, 'PUBLISHED', $4)`, [TENANT_A, eventId, runId, NOW.toISOString(), `ladder:${runId}:0`, randomUUID()]]]);
      expect(await as((tx) => ladders.syncReceipts(tx, runId, new Date(NOW.getTime() + 60_000)))).toBe(0);
      expect(await as((tx) => ladders.syncReceipts(tx, runId, new Date(NOW.getTime() + 11 * 60_000)))).toBe(1);
      expect((await as((tx) => ladders.rungs(tx, runId)))[0]).toMatchObject({ state: 'SUPPRESSED', reason: 'NO_WORKFLOW' });
      // A notification arrives late, is delivered and is read: the receipt moves forward to SEEN and the NO_WORKFLOW verdict is lifted.
      const workflow = randomUUID();
      const notification = randomUUID();
      await admin([
        [`insert into machvon.notification_instance (tenant_id, id, event_id, workflow_version_id, recipient_id, purpose, dedupe_key, expires_at, status, source_event_type, event_version, priority, ack_required, channel_plan, read_at, version)
          values ($1, $2, $3, $4, $5, 'OPERATIONAL', $6, $7, 'Read', 'home.alert_ladder_in_app.v1', 1, 'CRITICAL', false, ARRAY['IN_APP'], $8, 1)`,
          [TENANT_A, notification, eventId, workflow, memberId(REPORTER), `n1:${'a'.repeat(64)}`, new Date(NOW.getTime() + 86_400_000).toISOString(), new Date(NOW.getTime() + 20 * 60_000).toISOString()]],
      ]);
      expect(await as((tx) => ladders.syncReceipts(tx, runId, new Date(NOW.getTime() + 30 * 60_000)))).toBe(1);
      expect((await as((tx) => ladders.rungs(tx, runId)))[0]).toMatchObject({ state: 'SEEN', notificationId: notification, reason: null });
      // A state never moves back.
      expect(await as((tx) => ladders.syncReceipts(tx, runId, new Date(NOW.getTime() + 40 * 60_000)))).toBe(0);
    });

    it('finishes a ladder once, lists it with its rungs, and measures the delivery of urgent alerts', async () => {
      const [{ run }] = await as((tx) => ladders.forItem(tx, 'ADVANCE', 'ladder-1'));
      await as((tx) => ladders.finish(tx, run.id, { kind: 'DONE', by: 'RECEIPT' }, new Date(NOW.getTime() + 31 * 60_000)));
      expect((await as((tx) => ladders.require(tx, run.id))).state).toBe('DONE');
      // An ended ladder is not finished again, and a new one may start for the same item.
      await as((tx) => ladders.finish(tx, run.id, { kind: 'EXPIRED' }, new Date(NOW.getTime() + 32 * 60_000)));
      expect((await as((tx) => ladders.require(tx, run.id))).state).toBe('DONE');
      const reading = await as((tx) => ladders.policy(tx, 'URGENT', '2027-10-15'));
      expect(await as((tx) => ladders.start(tx, { source: 'ADVANCE', sourceId: 'ladder-1', recipient: memberId(REPORTER), severity: 'URGENT', alertTypeCode: 'ADVANCE', reading, now: LATER }))).toBeDefined();
      const kpi = await as((tx) => ladders.kpi(tx, '2027-10-01', '2027-11-01', 30));
      expect(kpi.urgent).toMatchObject({ runs: 2, receipted: 1, receiptedWithin: 1, withinMinutes: 30 });
      expect(kpi.byChannel.find((entry) => entry.channel === 'IN_APP')).toMatchObject({ seen: 1 });
      expect(kpi.byChannel.find((entry) => entry.channel === 'PUSH')).toMatchObject({ suppressed: 1, sent: 0 });
      expect((await as((tx) => ladders.kpi(tx, '2027-10-01', '2027-11-01', 30), TENANT_B)).runs).toBe(0);
      expect((await as((tx) => ladders.list(tx, { severity: 'URGENT', limit: 10, offset: 0 }))).length).toBe(2);
    });
  });
});
