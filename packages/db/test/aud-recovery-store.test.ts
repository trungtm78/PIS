import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { EffectiveAccess, MetricsSink, Scope } from '@machvon/kernel';
import { engagementScope } from '../src/aud-engagement-store';
import { AUD_RECOVERY_MISMATCH_EVENT, AUD_RECOVERY_MISMATCH_METRIC, AudRecoveryReconcileJob } from '../src/aud-recovery-reconcile-job';
import { AudRecommendationStore, recommendationScope } from '../src/aud-recommendation-store';
import { AuditWriter } from '../src/audit-writer';
import { AudRecoveryStore } from '../src/aud-recovery-store';
import type { NewLink } from '../src/aud-recovery-store';
import { OVERVIEW_ENGAGEMENTS_LIMIT } from '../src/aud-recovery-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const recommendations = new AudRecommendationStore();
const store = new AudRecoveryStore();

const ACCOUNTANT = 1;
const OTHER = 2;
const FAMILY = 0x97;
const DECISION = id(FAMILY, 10);
const EVIDENCE = id(FAMILY, 11);
const EVIDENCE_PENDING = id(FAMILY, 12);
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const TODAY = '2026-10-26';
const NOW = new Date('2026-10-26T03:00:00Z');
const WORKER = '00000000-0000-4000-8000-000000000000';

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A, member = ACCOUNTANT): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string; extensions?: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

const accessOf = (member: number, permissions: readonly string[], scope: Scope): EffectiveAccess => ({
  membershipId: memberId(member),
  scopeVersion: 1,
  membershipActive: true,
  grants: [{ roleCode: 'AUD', rank: 30, permissions, scope, status: 'Active', effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveUntil: null }],
});
const READ = 'aud.read';
const EXECUTE = 'aud.recommendation.execute';
const RECORD = 'aud.recovery.record';
const all = accessOf(ACCOUNTANT, [READ, EXECUTE, RECORD], { kind: 'TENANT' });
const seeAll = recommendationScope(all, READ, EXECUTE, NOW);
const everything = engagementScope(all, READ, NOW);
const nothing = engagementScope(accessOf(ACCOUNTANT, [READ, RECORD], { kind: 'UNIT_ONLY', refIds: [id(0x7f, 99)] }), READ, NOW);
const nowhere = recommendationScope(accessOf(OTHER, [READ, EXECUTE], { kind: 'UNIT_ONLY', refIds: [id(0x7f, 99)] }), READ, EXECUTE, NOW);

let counter = 0;
interface Seeded {
  engagementId: string;
  conclusionId: string;
  recommendationId: string;
}

/** An engagement that is followed up, its conclusion, and one recommendation of the kind, the amount and the status asked for (the rows are written as the owner of the database). */
async function seed(options: { type?: string; amount?: string | null; status?: string; recovered?: string; disputeOutcome?: string } = {}): Promise<Seeded> {
  counter += 1;
  const engagementId = randomUUID();
  const conclusionId = randomUUID();
  const recommendationId = randomUUID();
  const type = options.type ?? 'FINANCIAL_RECOVERY';
  const status = options.status ?? 'ASSIGNED';
  const amount = options.amount === undefined ? '800000000' : options.amount;
  await owner(
    `insert into machvon.audit_engagement (tenant_id, id, engagement_code, engagement_type, authority_kind, authority_name, decision_document_id, title, period_from, period_to, coordinator_user_id, status, started_on, classification, created_by, updated_by, version)
     values ($1, $2, $3, 'STATE_AUDIT', 'STATE_AUDIT_OFFICE', 'State Audit Office', $4, 'Audit of the bridge', date '2025-01-01', date '2025-12-31', $5, 'FOLLOW_UP', date '2026-10-01', 'CONFIDENTIAL', $5, $5, 3)`,
    [TENANT_A, engagementId, `RC-${counter}`, DECISION, memberId(ACCOUNTANT)],
  );
  await owner(
    `insert into machvon.audit_conclusion (tenant_id, id, engagement_id, conclusion_kind, conclusion_document_id, revision, issued_on, received_on, summary, total_financial_vnd, status, created_by, updated_by, version)
     values ($1, $2, $3, 'AUDIT_REPORT', $4, 1, date '2026-10-10', date '2026-10-15', 'The audit found payments above the approved volumes.', 2000000000, 'RECEIVED', $5, $5, 1)`,
    [TENANT_A, conclusionId, engagementId, DECISION, memberId(ACCOUNTANT)],
  );
  await owner(
    `insert into machvon.audit_recommendation (tenant_id, id, conclusion_id, rec_code, rec_type, description, amount_vnd, status, owner_unit_id, due_on, dispute_outcome, created_by, updated_by, version)
     values ($1, $2, $3, $4, $5, 'Recover what was paid above the volume.', $6::numeric, 'OPEN', null, null, null, $7, $7, 1)`,
    [TENANT_A, recommendationId, conclusionId, `R-${counter}`, type, amount, memberId(ACCOUNTANT)],
  );
  // The edges of the status are the table's: the recommendation is walked to the status asked for, as the system would.
  const steps: Record<string, string[]> = {
    OPEN: [],
    ASSIGNED: ['assigned'],
    IN_PROGRESS: ['assigned', 'working'],
    CLOSED: ['assigned', 'working', 'reported', 'closed'],
    CANCELLED: ['cancelled'],
  };
  for (const step of steps[status] ?? []) {
    if (step === 'assigned') await owner("update machvon.audit_recommendation set status = 'ASSIGNED', owner_unit_id = $2, due_on = date '2026-12-01' where id = $1", [recommendationId, unitId(DEPARTMENT)]);
    if (step === 'working') await owner("update machvon.audit_recommendation set status = 'IN_PROGRESS' where id = $1", [recommendationId]);
    if (step === 'reported') await owner("update machvon.audit_recommendation set status = 'PENDING_VERIFICATION', submitted_by = $2 where id = $1", [recommendationId, memberId(OTHER)]);
    if (step === 'closed') await owner("update machvon.audit_recommendation set status = 'CLOSED', verified_by = $2, verified_at = now() where id = $1", [recommendationId, memberId(ACCOUNTANT)]);
    if (step === 'cancelled') await owner("update machvon.audit_recommendation set status = 'CANCELLED' where id = $1", [recommendationId]);
  }
  if (options.disputeOutcome !== undefined) await owner('update machvon.audit_recommendation set dispute_outcome = $2 where id = $1', [recommendationId, options.disputeOutcome]);
  if (options.recovered !== undefined) await ledger(recommendationId, options.recovered);
  return { engagementId, conclusionId, recommendationId };
}

/** A line the ledger holds already (as a PAY recovery that was linked before), written as the owner of the database so that the trigger moves the recovered amount. */
const ledger = (recommendationId: string, amount: string, sourceKind = 'PAY_RECOVERY') =>
  owner(
    `insert into machvon.audit_recovery_link (tenant_id, id, recommendation_id, source_kind, source_id, amount_vnd, recorded_on, recorded_by)
     values ($1, gen_random_uuid(), $2::uuid, $3, gen_random_uuid(), $4::numeric, date '2026-10-01', $5::uuid)`,
    [TENANT_A, recommendationId, sourceKind, amount, memberId(ACCOUNTANT)],
  );

const state = async (recommendationId: string) =>
  (await owner<{ status: string; recovered: string; reopened: boolean; verified_by: string | null }>(
    'select status, recovered_vnd::text as recovered, reopened_at is not null as reopened, verified_by from machvon.audit_recommendation where id = $1',
    [recommendationId],
  ))[0] as { status: string; recovered: string; reopened: boolean; verified_by: string | null };
const lines = (recommendationId: string) =>
  owner<{ amount: string; reversal_of_id: string | null; source_kind: string }>('select amount_vnd::text as amount, reversal_of_id, source_kind from machvon.audit_recovery_link where recommendation_id = $1 order by recorded_at, id', [recommendationId]);

const manual = (extra: Partial<NewLink> = {}): NewLink => ({ sourceKind: 'MANUAL_EVIDENCE', sourceId: undefined, amountVnd: '300000000', recordedOn: '2026-10-20', evidenceDocumentId: EVIDENCE, today: TODAY, ...extra });
const link = (recommendationId: string, input: NewLink = manual(), member = ACCOUNTANT) =>
  as((tx) => recommendations.lock(tx, recommendationId, seeAll).then((row) => store.link(tx, row, input, memberId(member))), TENANT_A, member);
const lockLink = (linkId: string, seen = seeAll, acts = everything) => as((tx) => store.lockLink(tx, linkId, seen, acts));
const reverse = (linkId: string, reason: string | null = 'The voucher was entered twice.') =>
  as((tx) => store.lockLink(tx, linkId, seeAll, everything).then((target) => store.reverse(tx, target, { reason: reason ?? undefined, today: TODAY }, memberId(ACCOUNTANT))));

const facts = (recommendationId: string, extra: Partial<{ recoveryId: string; amountVnd: string; sourceKind: 'PAY_RECOVERY' | 'PAY_DEDUCTION'; day: string }> = {}) => ({
  recoveryId: randomUUID(),
  recommendationId,
  amountVnd: '500000000',
  sourceKind: 'PAY_RECOVERY' as const,
  day: '2026-10-20',
  ...extra,
});
const recorded = (fact: ReturnType<typeof facts>, eventId = randomUUID()) => as((tx) => store.applyPayRecovery(tx, fact, eventId, WORKER));
const reversed = (fact: ReturnType<typeof facts>, eventId = randomUUID()) => as((tx) => store.applyPayReversal(tx, fact, eventId, WORKER));

async function seedReplica(statements: Array<[string, unknown[]]>): Promise<void> {
  const client = new Client({ connectionString: harness.database.adminUrl });
  await client.connect();
  try {
    // The tables this story only reads (documents) are seeded with the foreign keys they have to other modules switched off.
    await client.query('set session_replication_role = replica');
    for (const [sql, params] of statements) await client.query(sql, params);
  } finally {
    await client.end();
  }
}

describe('AudRecoveryStore (the ledger of recoveries, ST-AUD-004)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: '/u1/' },
        { n: DEPARTMENT, path: '/u1/u2/', parent: ROOT },
        { n: ELSEWHERE, path: '/u3/' },
      ]);
    }
    for (const n of [ACCOUNTANT, OTHER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await seedReplica([
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
         values ($1, $2, 'REFERENCE', 'QD', 'Decision to audit the bridge', '12/QD-KTNN', '2026-01-15', 'EFFECTIVE', 'INTERNAL', $5, $5),
                ($1, $3, 'ATTACHMENT', 'BC', 'The voucher of the Treasury', null, null, 'EFFECTIVE', 'INTERNAL', $5, $5),
                ($1, $4, 'ATTACHMENT', 'BC', 'A voucher not in force', null, null, 'PENDING', 'INTERNAL', $5, $5)`,
        [TENANT_A, DECISION, EVIDENCE, EVIDENCE_PENDING, memberId(ACCOUNTANT)],
      ],
    ]);
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the ledger at the table', () => {
    it('only grows: a line is neither changed nor deleted, whoever writes, and a mistake is a line of the opposite sign', async () => {
      const made = await seed({ recovered: '100000000' });
      await expect(owner("update machvon.audit_recovery_link set amount_vnd = 5 where recommendation_id = $1", [made.recommendationId])).rejects.toMatchObject({ code: '23514', constraint: 'audit_recovery_link_append_only' });
      await expect(owner('delete from machvon.audit_recovery_link where recommendation_id = $1', [made.recommendationId])).rejects.toMatchObject({ code: '23514', constraint: 'audit_recovery_link_append_only' });
      expect((await lines(made.recommendationId)).length).toBe(1);
    });

    it('moves what was recovered with each line in the same transaction, and refuses a line that would pass the amount recommended or take it below nothing', async () => {
      const made = await seed({ amount: '400000000', recovered: '300000000' });
      expect((await state(made.recommendationId)).recovered).toBe('300000000');
      await expect(ledger(made.recommendationId, '100000001')).rejects.toMatchObject({ code: '23514', constraint: 'audit_recommendation_recovery_chk' });
      await ledger(made.recommendationId, '100000000');
      expect((await state(made.recommendationId)).recovered).toBe('400000000');
      await expect(ledger(made.recommendationId, '1')).rejects.toMatchObject({ code: '23514' });
      expect((await lines(made.recommendationId)).length).toBe(2);
      const other = await seed({ amount: '400000000' });
      await expect(owner('update machvon.audit_recommendation set recovered_vnd = -1 where id = $1', [other.recommendationId])).rejects.toMatchObject({ code: '23514' });
    });

    it('takes a line only for a financial recommendation', async () => {
      const made = await seed({ type: 'PROCESS_CORRECTION', amount: null });
      await expect(ledger(made.recommendationId, '5')).rejects.toMatchObject({ code: '23514', constraint: 'audit_recovery_link_financial_guard' });
    });
  });

  describe('linking by hand (AC-ST-AUD-004-1, AC-ST-AUD-004-2)', () => {
    it('AC-ST-AUD-004-1: 500,000,000 from PAY, delivered twice, and 300,000,000 linked by hand make 800,000,000: nothing is left to recover and the rates carry their numerator and denominator', async () => {
      const made = await seed({ status: 'IN_PROGRESS' });
      const first = facts(made.recommendationId, { amountVnd: '500000000' });
      const eventId = randomUUID();
      expect(await recorded(first, eventId)).toMatchObject({ outcome: 'linked', recoveredVnd: '500000000', reopened: false });
      expect(await recorded(first, eventId)).toEqual({ outcome: 'duplicate' });
      // the same recovery under another event is not another recovery
      expect(await recorded(first, randomUUID())).toEqual({ outcome: 'duplicate' });
      const done = await link(made.recommendationId, manual({ amountVnd: '300000000', sourceKind: 'TREASURY_REMITTANCE', sourceId: randomUUID() }));
      expect(done).toMatchObject({ recoveredVnd: '800000000', remainingVnd: '0' });
      expect((await lines(made.recommendationId)).map((line) => [line.amount, line.source_kind])).toEqual([
        ['500000000', 'PAY_RECOVERY'],
        ['300000000', 'TREASURY_REMITTANCE'],
      ]);
      expect(await owner('select evidence_document_id from machvon.audit_recovery_link where recommendation_id = $1 and source_kind = $2', [made.recommendationId, 'TREASURY_REMITTANCE'])).toEqual([{ evidence_document_id: EVIDENCE }]);
      expect(await owner("select owner_kind, document_id, note from machvon.audit_evidence where owner_id = $1", [made.recommendationId])).toEqual([{ owner_kind: 'RECOMMENDATION', document_id: EVIDENCE, note: 'RECOVERY' }]);
      const summary = await as((tx) => store.summary(tx, made.engagementId, everything));
      expect(summary).toMatchObject({
        engagementId: made.engagementId,
        amountVnd: '800000000',
        recoveredVnd: '800000000',
        remainingVnd: '0',
        moneyRate: { numerator: '800000000', denominator: '800000000', percent: '100.00' },
        countRate: { numerator: '0', denominator: '1', percent: '0.00' },
        recommendations: [{ recommendationId: made.recommendationId, amountVnd: '800000000', recoveredVnd: '800000000', remainingVnd: '0', lineCount: 2 }],
        exceptions: [],
      });
    });

    it('refuses a recommendation that is not financial (422), one that was cancelled (409), a source of PAY entered by hand, a zero amount and a day in the future (422)', async () => {
      const process = await seed({ type: 'PROCESS_CORRECTION', amount: null });
      expect(await refusal(link(process.recommendationId))).toMatchObject({ code: 'RECOMMENDATION_NOT_FINANCIAL', status: 422 });
      const cancelled = await seed({ status: 'CANCELLED' });
      expect(await refusal(link(cancelled.recommendationId))).toMatchObject({ code: 'RECOMMENDATION_STATE_INVALID', status: 409 });
      const made = await seed();
      for (const sourceKind of ['PAY_RECOVERY', 'PAY_DEDUCTION'] as const) {
        expect(await refusal(link(made.recommendationId, manual({ sourceKind })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'source_kind' });
      }
      expect(await refusal(link(made.recommendationId, manual({ amountVnd: '0' })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'amount_vnd' });
      expect(await refusal(link(made.recommendationId, manual({ amountVnd: '12.5' })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'amount_vnd' });
      expect(await refusal(link(made.recommendationId, manual({ recordedOn: '2026-10-27' })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'recorded_on' });
      expect((await lines(made.recommendationId)).length).toBe(0);
    });

    it('needs the document that proves a line entered by hand (422 EVIDENCE_REQUIRED for a missing one, one not in force or one of another tenant)', async () => {
      const made = await seed();
      for (const evidenceDocumentId of [undefined, EVIDENCE_PENDING, randomUUID()]) {
        expect(await refusal(link(made.recommendationId, manual({ evidenceDocumentId })))).toMatchObject({ code: 'EVIDENCE_REQUIRED', status: 422, detail: 'evidence_document_id' });
      }
      expect((await state(made.recommendationId)).recovered).toBe('0');
    });

    it('links a source once (409 RECOVERY_SOURCE_ALREADY_LINKED) and refuses a line over the amount with the figures (409 RECOVERY_EXCEEDS_RECOMMENDATION)', async () => {
      const made = await seed({ amount: '400000000' });
      const source = randomUUID();
      await link(made.recommendationId, manual({ sourceKind: 'TREASURY_REMITTANCE', sourceId: source, amountVnd: '100000000' }));
      expect(await refusal(link(made.recommendationId, manual({ sourceKind: 'TREASURY_REMITTANCE', sourceId: source, amountVnd: '50000000' })))).toMatchObject({ code: 'RECOVERY_SOURCE_ALREADY_LINKED', status: 409 });
      expect(await refusal(link(made.recommendationId, manual({ amountVnd: '300000001' })))).toMatchObject({
        code: 'RECOVERY_EXCEEDS_RECOMMENDATION',
        status: 409,
        extensions: { amount_vnd: '400000000', recovered_vnd: '100000000', line_vnd: '300000001', remaining_vnd: '300000000', excess_vnd: '1' },
      });
      expect((await state(made.recommendationId)).recovered).toBe('100000000');
    });

    it('AC-ST-AUD-004-2: two accountants posting 80,000,000 at once on 400,000,000 with 300,000,000 recovered are served one after the other: exactly one gets 409, the table is never violated', async () => {
      const made = await seed({ amount: '400000000', recovered: '300000000' });
      const attempts = await Promise.allSettled([link(made.recommendationId, manual({ amountVnd: '80000000' }), ACCOUNTANT), link(made.recommendationId, manual({ amountVnd: '80000000' }), OTHER)]);
      expect(attempts.filter((attempt) => attempt.status === 'fulfilled').length).toBe(1);
      const failed = attempts.find((attempt) => attempt.status === 'rejected') as PromiseRejectedResult;
      expect(failed.reason).toMatchObject({ code: 'RECOVERY_EXCEEDS_RECOMMENDATION', status: 409, extensions: { remaining_vnd: '20000000', excess_vnd: '60000000' } });
      expect((await state(made.recommendationId)).recovered).toBe('380000000');
    });
  });

  describe('reversing (AC-ST-AUD-004-2)', () => {
    it('AC-ST-AUD-004-2: a reversal adds a line of -80,000,000 and deletes nothing; the same line is not reversed twice, and a reversal is not reversed', async () => {
      const made = await seed({ amount: '400000000', recovered: '300000000' });
      const added = await link(made.recommendationId, manual({ amountVnd: '80000000' }));
      const target = (await lines(made.recommendationId)).length;
      expect(target).toBe(2);
      const done = await reverse(added.id);
      expect(done).toMatchObject({ recoveredVnd: '300000000', reopened: false });
      expect((await lines(made.recommendationId)).map((line) => [line.amount, line.reversal_of_id === added.id])).toEqual([
        ['300000000', false],
        ['80000000', false],
        ['-80000000', true],
      ]);
      expect(await refusal(reverse(added.id))).toMatchObject({ code: 'RECOVERY_ALREADY_REVERSED', status: 409 });
      expect(await refusal(reverse(done.id))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'link' });
      expect(await owner('select note from machvon.audit_recovery_link where id = $1', [done.id])).toEqual([{ note: 'The voucher was entered twice.' }]);
      // the amount is free again
      await link(made.recommendationId, manual({ amountVnd: '100000000' }));
      expect((await state(made.recommendationId)).recovered).toBe('400000000');
    });

    it('asks for the reason in words, does not find a line outside the scope (404) and tells a caller who may not act (403)', async () => {
      const made = await seed({ amount: '400000000' });
      const added = await link(made.recommendationId, manual({ amountVnd: '80000000' }));
      expect(await refusal(reverse(added.id, 'short'))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
      expect(await refusal(reverse(added.id, null))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
      expect(await refusal(lockLink(added.id, nowhere))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(lockLink(randomUUID()))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(lockLink(added.id, seeAll, nothing))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(as((tx) => store.lockLink(tx, added.id, seeAll, everything), TENANT_B))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect((await state(made.recommendationId)).recovered).toBe('80000000');
    });

    it('sends a closed recommendation that is no longer recovered in full back to work, and says when', async () => {
      const made = await seed({ status: 'CLOSED', amount: '800000000' });
      const first = await link(made.recommendationId, manual({ amountVnd: '500000000' }));
      await link(made.recommendationId, manual({ amountVnd: '300000000' }));
      expect(await state(made.recommendationId)).toMatchObject({ status: 'CLOSED', recovered: '800000000', reopened: false });
      const done = await reverse(first.id);
      expect(done).toMatchObject({ recoveredVnd: '300000000', reopened: true });
      expect(await state(made.recommendationId)).toEqual({ status: 'IN_PROGRESS', recovered: '300000000', reopened: true, verified_by: null });
    });

    it('does not reopen the recommendation of an engagement that is closed: the line is the truth of the money and the engagement is not reopened by a reversal', async () => {
      const made = await seed({ status: 'CLOSED', amount: '800000000' });
      const line = await link(made.recommendationId, manual({ amountVnd: '800000000' }));
      await owner("update machvon.audit_engagement set status = 'CLOSED', closed_on = date '2026-10-26' where id = $1", [made.engagementId]);
      expect((await reverse(line.id)).reopened).toBe(false);
      expect(await state(made.recommendationId)).toMatchObject({ status: 'CLOSED', recovered: '0', reopened: false });
    });

    it('does not reopen a recommendation closed on an accepted dispute, nor one that is not closed', async () => {
      const accepted = await seed({ status: 'CLOSED', amount: '800000000', disputeOutcome: 'ACCEPTED_BY_AUTHORITY' });
      const line = await link(accepted.recommendationId, manual({ amountVnd: '300000000' }));
      await reverse(line.id);
      expect(await state(accepted.recommendationId)).toMatchObject({ status: 'CLOSED', recovered: '0', reopened: false });
      const working = await seed({ status: 'IN_PROGRESS' });
      const other = await link(working.recommendationId, manual({ amountVnd: '300000000' }));
      expect((await reverse(other.id)).reopened).toBe(false);
      expect((await state(working.recommendationId)).status).toBe('IN_PROGRESS');
    });
  });

  describe('the events of PAY (AC-ST-AUD-004-1, AC-ST-AUD-004-3)', () => {
    it('AC-ST-AUD-004-3: a reversal of PAY, delivered twice, adds one negative line, recovered falls to 500,000,000 and a closed recommendation goes back to IN_PROGRESS', async () => {
      const made = await seed({ status: 'CLOSED', amount: '800000000' });
      const second = facts(made.recommendationId, { amountVnd: '300000000', sourceKind: 'PAY_DEDUCTION' });
      await recorded(facts(made.recommendationId, { amountVnd: '500000000' }));
      await recorded(second);
      expect((await state(made.recommendationId)).recovered).toBe('800000000');
      const eventId = randomUUID();
      const outcome = await reversed(second, eventId);
      expect(outcome).toMatchObject({ outcome: 'reversed', recoveredVnd: '500000000', reopened: true });
      expect(await reversed(second, eventId)).toEqual({ outcome: 'duplicate' });
      // another delivery of the same reversal under another event id finds the line reversed already
      expect(await reversed(second, randomUUID())).toEqual({ outcome: 'duplicate' });
      expect((await lines(made.recommendationId)).map((line) => line.amount)).toEqual(['500000000', '300000000', '-300000000']);
      expect(await state(made.recommendationId)).toMatchObject({ status: 'IN_PROGRESS', recovered: '500000000', reopened: true });
      expect(await owner('select source_event_id, source_kind from machvon.audit_recovery_link where recommendation_id = $1 and amount_vnd < 0', [made.recommendationId])).toEqual([{ source_event_id: eventId, source_kind: 'PAY_DEDUCTION' }]);
    });

    it('keeps what the ledger cannot take as an exception, once for each event: a recovery over the amount, a reversal never linked, a recommendation that takes no money', async () => {
      const made = await seed({ amount: '400000000', recovered: '300000000' });
      const over = facts(made.recommendationId, { amountVnd: '200000000' });
      const eventId = randomUUID();
      expect(await recorded(over, eventId)).toEqual({ outcome: 'exception', kind: 'OVER_RECOVERY' });
      expect(await recorded(over, eventId)).toEqual({ outcome: 'exception', kind: 'OVER_RECOVERY' });
      expect((await state(made.recommendationId)).recovered).toBe('300000000');
      expect(await reversed(facts(made.recommendationId, { amountVnd: '100000000' }))).toEqual({ outcome: 'exception', kind: 'UNMATCHED_REVERSAL' });
      const process = await seed({ type: 'REFERRAL', amount: null });
      expect(await recorded(facts(process.recommendationId))).toEqual({ outcome: 'exception', kind: 'NOT_APPLICABLE' });
      const cancelled = await seed({ status: 'CANCELLED' });
      expect(await recorded(facts(cancelled.recommendationId))).toEqual({ outcome: 'exception', kind: 'NOT_APPLICABLE' });
      expect(await owner('select kind, status, amount_vnd::text as amount from machvon.audit_recovery_exception where recommendation_id = $1 order by kind', [made.recommendationId])).toEqual([
        { kind: 'OVER_RECOVERY', status: 'OPEN', amount: '200000000' },
        { kind: 'UNMATCHED_REVERSAL', status: 'OPEN', amount: '100000000' },
      ]);
      const summary = await as((tx) => store.summary(tx, made.engagementId, everything));
      expect(summary?.exceptions.map((entry) => [entry.kind, entry.recCode, entry.amountVnd, entry.sourceKind])).toEqual([
        ['OVER_RECOVERY', expect.any(String), '200000000', 'PAY_RECOVERY'],
        ['UNMATCHED_REVERSAL', expect.any(String), '100000000', 'PAY_RECOVERY'],
      ]);
    });

    it('ignores an event about a recommendation that is not in the tenant, including one of another tenant', async () => {
      expect(await recorded(facts(randomUUID()))).toEqual({ outcome: 'ignored' });
      expect(await reversed(facts(randomUUID()))).toEqual({ outcome: 'ignored' });
      const made = await seed();
      expect(await as((tx) => store.applyPayRecovery(tx, facts(made.recommendationId), randomUUID(), WORKER), TENANT_B)).toEqual({ outcome: 'ignored' });
    });
  });

  describe('reading', () => {
    it('lists the lines of an engagement oldest first with what was recovered up to each and what is left after it, and says which were reversed', async () => {
      const made = await seed({ amount: '400000000' });
      const first = await link(made.recommendationId, manual({ amountVnd: '100000000' }));
      await link(made.recommendationId, manual({ amountVnd: '50000000' }));
      await reverse(first.id);
      const listed = await as((tx) => store.listLinks(tx, made.engagementId, everything));
      expect(listed.map((line) => [line.amountVnd, line.cumulativeVnd, line.remainingVnd, line.reversed, line.reversalOfId === null])).toEqual([
        ['100000000', '100000000', '300000000', true, true],
        ['50000000', '150000000', '250000000', false, true],
        ['-100000000', '50000000', '350000000', false, false],
      ]);
      expect(listed[0]).toMatchObject({ recommendationId: made.recommendationId, sourceKind: 'MANUAL_EVIDENCE', evidenceDocumentId: EVIDENCE, recordedBy: memberId(ACCOUNTANT) });
      expect(await as((tx) => store.listLinks(tx, made.engagementId, nothing))).toEqual([]);
      expect(await as((tx) => store.listLinks(tx, made.engagementId, everything), TENANT_B)).toEqual([]);
    });

    it('sums the money of an engagement over its financial recommendations that are not cancelled, and counts the closed of those that are not cancelled', async () => {
      const made = await seed({ amount: '800000000', recovered: '200000000' });
      await owner("insert into machvon.audit_recommendation (tenant_id, id, conclusion_id, rec_code, rec_type, description, amount_vnd, status, created_by, updated_by, version) values ($1, gen_random_uuid(), $2, 'R-X1', 'FINANCIAL_ADJUSTMENT', 'Adjust the next payment of the contract.', 400000000, 'OPEN', $3, $3, 1)", [TENANT_A, made.conclusionId, memberId(ACCOUNTANT)]);
      await owner("insert into machvon.audit_recommendation (tenant_id, id, conclusion_id, rec_code, rec_type, description, amount_vnd, status, created_by, updated_by, version) values ($1, gen_random_uuid(), $2, 'R-X2', 'FINANCIAL_RECOVERY', 'Recover a payment that was cancelled later.', 100000000, 'CANCELLED', $3, $3, 1)", [TENANT_A, made.conclusionId, memberId(ACCOUNTANT)]);
      await owner("insert into machvon.audit_recommendation (tenant_id, id, conclusion_id, rec_code, rec_type, description, status, created_by, updated_by, version) values ($1, gen_random_uuid(), $2, 'R-X3', 'REFERRAL', 'Refer the file to the investigating agency.', 'OPEN', $3, $3, 1)", [TENANT_A, made.conclusionId, memberId(ACCOUNTANT)]);
      const summary = await as((tx) => store.summary(tx, made.engagementId, everything));
      expect(summary).toMatchObject({
        amountVnd: '1200000000',
        recoveredVnd: '200000000',
        remainingVnd: '1000000000',
        moneyRate: { numerator: '200000000', denominator: '1200000000', percent: '16.67' },
        countRate: { numerator: '0', denominator: '3', percent: '0.00' },
      });
      expect(summary?.recommendations.map((line) => line.amountVnd)).toEqual(['800000000', '400000000']);
      expect(await as((tx) => store.summary(tx, made.engagementId, nothing))).toBeUndefined();
      expect(await as((tx) => store.summary(tx, randomUUID(), everything))).toBeUndefined();
      const empty = await seed({ type: 'REFERRAL', amount: null });
      expect((await as((tx) => store.summary(tx, empty.engagementId, everything)))?.moneyRate).toEqual({ numerator: '0', denominator: '0', percent: null });
    });

    it('gives the figures of the overview over what the caller reaches: the engagements being worked, what is open and overdue, the money and the rates', async () => {
      await owner('delete from machvon.audit_recovery_exception');
      const before = await as((tx) => store.overview(tx, everything, TODAY));
      const made = await seed({ status: 'IN_PROGRESS', amount: '800000000' });
      await owner("update machvon.audit_recommendation set due_on = date '2026-10-01' where id = $1", [made.recommendationId]);
      await link(made.recommendationId, manual({ amountVnd: '200000000' }));
      await owner("update machvon.audit_engagement set status = 'ONGOING' where id = $1", [made.engagementId]);
      const after = await as((tx) => store.overview(tx, everything, TODAY));
      expect(after.engagementsOngoing).toBe(before.engagementsOngoing + 1);
      expect(after.engagementsFollowUp).toBe(before.engagementsFollowUp);
      expect(after.recommendationsOpen).toBe(before.recommendationsOpen + 1);
      expect(after.recommendationsOverdue).toBeGreaterThanOrEqual(1);
      expect(BigInt(after.recoveredVnd) - BigInt(before.recoveredVnd)).toBe(200000000n);
      // the watch list names the engagement with what is open and overdue in it and its money, the ones with the most overdue first
      expect(after.engagements.find((entry) => entry.id === made.engagementId)).toEqual({
        id: made.engagementId,
        code: expect.any(String),
        title: 'Audit of the bridge',
        status: 'ONGOING',
        recommendationsOpen: 1,
        recommendationsOverdue: 1,
        amountVnd: '800000000',
        recoveredVnd: '200000000',
      });
      expect(after.engagements.length).toBeLessThanOrEqual(OVERVIEW_ENGAGEMENTS_LIMIT);
      expect(after.engagements[0]?.recommendationsOverdue).toBeGreaterThanOrEqual(after.engagements[after.engagements.length - 1]?.recommendationsOverdue ?? 0);
      expect(await as((tx) => store.overview(tx, nothing, TODAY))).toMatchObject({ engagementsOngoing: 0, engagementsFollowUp: 0, recommendationsOpen: 0, amountVnd: '0', moneyRate: { percent: null }, engagements: [] });
      expect(await as((tx) => store.overview(tx, everything, TODAY), TENANT_B)).toMatchObject({ recommendationsOpen: 0, amountVnd: '0' });
    });
  });

  describe('the nightly reconciliation (aud-recovery-reconcile, UAT-AC438)', () => {
    const gauges: Array<{ name: string; value: number; labels: Record<string, string> | undefined }> = [];
    const metrics: MetricsSink = { increment: () => undefined, gauge: (name, value, labels) => void gauges.push({ name, value, labels }) };
    const job = new AudRecoveryReconcileJob(new AuditWriter(harness.tenants), metrics);
    const run = (now = new Date('2026-10-26T19:00:00Z')) => as((tx) => job.run(tx, WORKER, now));

    it('finds the recovered amounts equal to their ledgers after the lines, a reversal included, and sets the gauge to nothing', async () => {
      const made = await seed({ amount: '400000000' });
      const first = await link(made.recommendationId, manual({ amountVnd: '100000000' }));
      await link(made.recommendationId, manual({ amountVnd: '50000000' }));
      await reverse(first.id);
      const result = await run();
      expect(result.mismatches).toEqual([]);
      expect(result.checked).toBeGreaterThan(0);
      expect(gauges.at(-1)).toMatchObject({ name: AUD_RECOVERY_MISMATCH_METRIC, value: 0, labels: { tenant_id: TENANT_A } });
    });

    it('reports a recommendation that differs from its ledger on the gauge, in an audit row and in an event once a day, and corrects nothing', async () => {
      const made = await seed({ amount: '400000000' });
      await link(made.recommendationId, manual({ amountVnd: '100000000' }));
      // a recovered amount that moved without its line: the ledger says 100,000,000 and the recommendation 130,000,000
      await owner('update machvon.audit_recommendation set recovered_vnd = 130000000 where id = $1', [made.recommendationId]);
      const result = await run();
      expect(result.mismatches).toEqual([{ recommendationId: made.recommendationId, recCode: expect.any(String), engagementId: made.engagementId, recoveredVnd: '130000000', ledgerVnd: '100000000', differenceVnd: '30000000' }]);
      expect(gauges.at(-1)).toMatchObject({ name: AUD_RECOVERY_MISMATCH_METRIC, value: 1 });
      expect((await state(made.recommendationId)).recovered).toBe('130000000');
      expect((await lines(made.recommendationId)).length).toBe(1);
      const audits = await owner<{ safe_diff: Record<string, unknown>; classification: string }>("select safe_diff, classification from machvon.audit_event where action = 'aud.recovery_mismatch_detected' and resource_id = $1", [made.recommendationId]);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ classification: 'CONFIDENTIAL', safe_diff: { recovered_vnd: '130000000', ledger_vnd: '100000000', difference_vnd: '30000000' } });
      const events = () => owner<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where type = $1 and aggregate_id = $2::uuid', [AUD_RECOVERY_MISMATCH_EVENT, made.recommendationId]);
      expect(await events()).toEqual([{ payload: expect.objectContaining({ recommendation_id: made.recommendationId, difference_vnd: '30000000', source_module: 'AUD' }) }]);
      // the same night again says the same, once
      await run();
      expect(await events()).toHaveLength(1);
      // put right by hand, the next night finds nothing
      await owner('update machvon.audit_recommendation set recovered_vnd = 100000000 where id = $1', [made.recommendationId]);
      expect((await run(new Date('2026-10-27T19:00:00Z'))).mismatches.filter((entry) => entry.recommendationId === made.recommendationId)).toEqual([]);
    });

    it('finds a recommendation that was given a recovered amount with no line at all', async () => {
      const made = await seed({ amount: '400000000' });
      await owner('update machvon.audit_recommendation set recovered_vnd = 5 where id = $1', [made.recommendationId]);
      const found = (await run(new Date('2026-10-28T19:00:00Z'))).mismatches.find((entry) => entry.recommendationId === made.recommendationId);
      expect(found).toMatchObject({ recoveredVnd: '5', ledgerVnd: '0', differenceVnd: '5' });
    });
  });
});
