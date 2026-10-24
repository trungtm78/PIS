import { randomUUID } from 'node:crypto';
import type { MetricsSink, ProviderSigningKey } from '@machvon/kernel';
import { signTreasuryCallback } from '../src/pay-treasury-callback';
import type { TreasuryCallbackFields } from '../src/pay-treasury-callback';
import { PayTreasuryTransactionStore } from '../src/pay-treasury-transaction-store';
import type { ManualConfirmationInput, TreasuryCallbackInput } from '../src/pay-treasury-transaction-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId } from './support/authz-fixtures';
import { seedPayWorld, seedPaymentRequest } from './support/pay-fixtures';
import type { PayWorld } from './support/pay-fixtures';

const harness = new AuthzHarness();
const store = new PayTreasuryTransactionStore();

const MAKER = 1;
const CHECKER = 2;
const FAMILY = 0x92;
const NOW = new Date('2026-10-24T03:00:00.000Z');
const SECRET = Buffer.from('treasury-mock-secret');
const KEYS: ProviderSigningKey[] = [{ keyId: 'mock-1', secret: SECRET }];

let world: PayWorld;
let counter = 0;

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A, member = CHECKER): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await owner<{ n: string }>(sql, params))[0]?.n);

/** A scope over given projects, as the compiled grants of a caller would be: `p` is the project alias of the queries. */
const scopeOf = (...projects: string[]): ScopeBuilder => (first) => ({ sql: `p.id = any($${first}::uuid[])`, params: [projects] });
const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number };
    return { code: e.code ?? '', status: e.status ?? 0 };
  }
  throw new Error('expected a refusal');
}

class CountingMetrics implements MetricsSink {
  readonly counted: string[] = [];

  increment(name: string): void {
    this.counted.push(name);
  }

  gauge(): void {
    // not used by the store
  }
}

/** A payment request in SENT_TREASURY of project A, drafted and sent by the maker. */
async function request(spec: { status?: string; netVnd?: string; project?: string; contract?: string; createdBy?: number | null; submittedBy?: number | null } = {}): Promise<string> {
  counter += 1;
  const requestId = id(FAMILY, 100 + counter);
  await seedPaymentRequest(harness.database.adminUrl, TENANT_A, {
    id: requestId,
    project: spec.project ?? world.projectA,
    contract: spec.contract ?? world.contractA,
    acceptance: id(FAMILY, 200 + counter),
    netVnd: spec.netVnd ?? '1000000',
    createdBy: spec.createdBy === undefined ? MAKER : spec.createdBy,
    submittedBy: spec.submittedBy === undefined ? MAKER : spec.submittedBy,
    ...(spec.status === undefined ? {} : { status: spec.status }),
  });
  return requestId;
}

const confirmation = (paymentRequestId: string, extra: Partial<ManualConfirmationInput> = {}): ManualConfirmationInput => {
  counter += 1;
  return {
    paymentRequestId,
    documentNo: `CT-M-${counter}`,
    documentDate: '2026-10-15',
    amountVnd: '1000000',
    confirmedAt: '2026-10-16T02:00:00Z',
    evidenceDocumentVersionId: world.evidence,
    actor: memberId(CHECKER),
    scope: everything,
    now: NOW,
    ...extra,
  };
};

const fieldsOf = (extra: Partial<TreasuryCallbackFields> = {}): TreasuryCallbackFields => {
  counter += 1;
  return {
    providerEventId: `evt-${counter}-${randomUUID().slice(0, 8)}`,
    provider: 'KBNN_MOCK',
    documentNo: `CT-C-${counter}`,
    documentDate: '2026-10-15',
    projectCode: world.projectCodeA,
    amountVnd: '4200000',
    direction: 'PAYMENT',
    confirmedAt: '2026-10-16T02:00:00.000Z',
    ...extra,
  };
};

const callbackOf = (fields: TreasuryCallbackFields, extra: Partial<TreasuryCallbackInput> = {}): TreasuryCallbackInput => ({
  ...fields,
  signature: signTreasuryCallback(SECRET, fields),
  keys: KEYS,
  payloadReference: `tenants/${TENANT_A}/webhook/${fields.providerEventId}`,
  actor: memberId(CHECKER),
  ...extra,
});

const receive = (input: TreasuryCallbackInput, metrics?: MetricsSink) => as((tx) => store.receiveCallback(tx, { ...input, ...(metrics === undefined ? {} : { metrics }) }));

describe('PayTreasuryTransactionStore (manual confirmation, callback and reads, ST-PAY-006)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: 1, path: '/u1/' },
        { n: 2, path: '/u2/' },
      ]);
      await harness.seedMembership(tenant, MAKER, 1);
      await harness.seedMembership(tenant, CHECKER, 1);
    }
    world = await seedPayWorld(harness.database.adminUrl, TENANT_A, FAMILY, MAKER, 1, 2);
    await seedPayWorld(harness.database.adminUrl, TENANT_B, FAMILY, MAKER, 1, 2);
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('confirmManually', () => {
    it('records the confirmation with its evidence and leaves the request to the match when the amount is the net', async () => {
      const requestId = await request({ netVnd: '1000000' });
      const input = confirmation(requestId);
      const done = await as((tx) => store.confirmManually(tx, input));
      expect(done).toMatchObject({ projectId: world.projectA, paymentRequestId: requestId, documentNo: input.documentNo, amountVnd: '1000000', netVnd: '1000000', matchStatus: 'UNMATCHED', mismatchItemId: null });
      const [stored] = await owner<Record<string, unknown>>(
        `select provider, source_kind, direction, match_status, payment_request_id, contract_id, project_id, amount_vnd::text as amount_vnd, document_no, document_date::text as document_date,
                evidence_document_version_id, external_id, created_by, confirmed_at
           from machvon.treasury_transaction where id = $1`,
        [done.transactionId],
      );
      expect(stored).toMatchObject({
        provider: 'MANUAL',
        source_kind: 'MANUAL_CONFIRMED',
        direction: 'PAYMENT',
        match_status: 'UNMATCHED',
        payment_request_id: requestId,
        contract_id: world.contractA,
        project_id: world.projectA,
        amount_vnd: '1000000',
        document_date: '2026-10-15',
        evidence_document_version_id: world.evidence,
        external_id: `MANUAL|${input.documentNo}|2026-10-15|${world.projectCodeA}`,
        created_by: memberId(CHECKER),
      });
      expect((stored?.confirmed_at as Date).toISOString()).toBe('2026-10-16T02:00:00.000Z');
      // The request itself does not move: settling it is the work of the match.
      expect((await owner<{ status: string }>('select status from machvon.payment_request where id = $1', [requestId]))[0]?.status).toBe('SENT_TREASURY');
      expect(await count('select count(*)::text as n from machvon.reconciliation_item where payment_request_id = $1', [requestId])).toBe(0);
    });

    it('puts a different amount in EXCEPTION and opens an AMOUNT_MISMATCH item with both figures, an owner and a due time, and never picks the larger one', async () => {
      const requestId = await request({ netVnd: '2000000' });
      const done = await as((tx) => store.confirmManually(tx, confirmation(requestId, { amountVnd: '2000500' })));
      expect(done).toMatchObject({ matchStatus: 'EXCEPTION', amountVnd: '2000500', netVnd: '2000000' });
      expect(done.mismatchItemId).not.toBeNull();
      const [item] = await owner<Record<string, unknown>>(
        `select kind, internal_amount_vnd::text as internal, confirmed_amount_vnd::text as confirmed, difference_vnd::text as difference, owner_membership_id, due_at, status,
                project_id, contract_id, payment_request_id, treasury_transaction_id
           from machvon.reconciliation_item where id = $1`,
        [done.mismatchItemId],
      );
      expect(item).toMatchObject({
        kind: 'AMOUNT_MISMATCH',
        internal: '2000000',
        confirmed: '2000500',
        difference: '500',
        owner_membership_id: memberId(CHECKER),
        status: 'OPEN',
        project_id: world.projectA,
        contract_id: world.contractA,
        payment_request_id: requestId,
        treasury_transaction_id: done.transactionId,
      });
      expect((item?.due_at as Date).toISOString()).toBe(new Date(NOW.getTime() + 259_200_000).toISOString());
      // A smaller figure is a mismatch too: the difference is signed.
      const lower = await request({ netVnd: '3000000' });
      const smaller = await as((tx) => store.confirmManually(tx, confirmation(lower, { amountVnd: '2999999' })));
      expect((await owner<{ difference: string }>('select difference_vnd::text as difference from machvon.reconciliation_item where id = $1', [smaller.mismatchItemId]))[0]?.difference).toBe('-1');
    });

    it.each([
      ['DRAFT', 'PAYMENT_STATE_INVALID', 409],
      ['SUBMITTED', 'PAYMENT_STATE_INVALID', 409],
      ['SETTLED', 'PAYMENT_STATE_INVALID', 409],
    ])('refuses a request in %s with %s', async (status, code, httpStatus) => {
      const requestId = await request({ status });
      expect(await refusal(as((tx) => store.confirmManually(tx, confirmation(requestId))))).toEqual({ code, status: httpStatus });
    });

    it('refuses the person who drafted or sent the request (SELF_APPROVAL_DENIED) and writes nothing', async () => {
      const drafted = await request({ createdBy: CHECKER, submittedBy: MAKER });
      const sent = await request({ createdBy: MAKER, submittedBy: CHECKER });
      for (const requestId of [drafted, sent]) {
        expect(await refusal(as((tx) => store.confirmManually(tx, confirmation(requestId))))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
        expect(await count('select count(*)::text as n from machvon.treasury_transaction where payment_request_id = $1', [requestId])).toBe(0);
      }
    });

    it('judges a request that has no author on record by the people it does have', async () => {
      const requestId = await request({ createdBy: null, submittedBy: null });
      expect((await as((tx) => store.confirmManually(tx, confirmation(requestId)))).matchStatus).toBe('UNMATCHED');
    });

    it('does not see a request of another project or tenant, or one that does not exist: 404 for all three', async () => {
      const other = await request({ project: world.projectB, contract: world.contractB });
      const own = await request();
      expect(await refusal(as((tx) => store.confirmManually(tx, confirmation(other, { scope: scopeOf(world.projectA) }))))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => store.confirmManually(tx, confirmation(randomUUID()))))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => store.confirmManually(tx, confirmation(own)), TENANT_B))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      // Inside the scope it works.
      expect((await as((tx) => store.confirmManually(tx, confirmation(other, { scope: scopeOf(world.projectB) })))).projectId).toBe(world.projectB);
    });

    it('needs evidence that exists and is clean', async () => {
      const requestId = await request();
      for (const evidence of [world.infectedEvidence, randomUUID()]) {
        expect(await refusal(as((tx) => store.confirmManually(tx, confirmation(requestId, { evidenceDocumentVersionId: evidence }))))).toEqual({ code: 'VALIDATION_FAILED', status: 422 });
      }
      expect(await count('select count(*)::text as n from machvon.treasury_transaction where payment_request_id = $1', [requestId])).toBe(0);
    });

    it('refuses a second confirmation of a request that has one, and the same voucher confirmed for another request (TREASURY_TRANSACTION_DUPLICATE)', async () => {
      const requestId = await request();
      const first = confirmation(requestId);
      await as((tx) => store.confirmManually(tx, first));
      expect(await refusal(as((tx) => store.confirmManually(tx, confirmation(requestId))))).toEqual({ code: 'TREASURY_TRANSACTION_DUPLICATE', status: 409 });
      const another = await request();
      expect(await refusal(as((tx) => store.confirmManually(tx, confirmation(another, { documentNo: first.documentNo }))))).toEqual({ code: 'TREASURY_TRANSACTION_DUPLICATE', status: 409 });
      expect(await count('select count(*)::text as n from machvon.treasury_transaction where payment_request_id = $1', [another])).toBe(0);
    });

    it('lets a request in EXCEPTION be confirmed again once its first confirmation was a mistake that was written off (the old one stays)', async () => {
      const requestId = await request({ netVnd: '500' });
      await as((tx) => store.confirmManually(tx, confirmation(requestId, { amountVnd: '900' })));
      const second = await as((tx) => store.confirmManually(tx, confirmation(requestId, { amountVnd: '500' })));
      expect(second.matchStatus).toBe('UNMATCHED');
      expect(await count('select count(*)::text as n from machvon.treasury_transaction where payment_request_id = $1', [requestId])).toBe(2);
    });

    it('confirms one request once when two people confirm at the same moment', async () => {
      const requestId = await request();
      const outcomes = await Promise.allSettled([as((tx) => store.confirmManually(tx, confirmation(requestId))), as((tx) => store.confirmManually(tx, confirmation(requestId)))]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const failed = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult;
      expect(failed.reason).toMatchObject({ code: 'TREASURY_TRANSACTION_DUPLICATE', status: 409 });
      expect(await count('select count(*)::text as n from machvon.treasury_transaction where payment_request_id = $1', [requestId])).toBe(1);
    });

    it.each([
      ['an empty voucher number', { documentNo: '  ' }, 'document_no'],
      ['a voucher number with the key separator', { documentNo: 'CT|1' }, 'document_no'],
      ['a voucher date that does not exist', { documentDate: '2026-02-30' }, 'document_date'],
      ['an amount with a fraction', { amountVnd: '10.5' }, 'amount_vnd'],
      ['an amount of zero', { amountVnd: '0' }, 'amount_vnd'],
      ['a booking time that does not read', { confirmedAt: 'tomorrow' }, 'confirmed_at'],
    ])('refuses %s as 422 naming the field', async (_name, extra, field) => {
      const requestId = await request();
      const failure = await refusal(as((tx) => store.confirmManually(tx, confirmation(requestId, extra))));
      expect(failure).toEqual({ code: 'VALIDATION_FAILED', status: 422 });
      await expect(as((tx) => store.confirmManually(tx, confirmation(requestId, extra)))).rejects.toMatchObject({ detail: field });
    });
  });

  describe('receiveCallback (adapter MOCK) (AC-ST-PAY-006-3)', () => {
    it('creates exactly one transaction when the same event is delivered twice, and answers the first result the second time (AC-ST-PAY-006-3)', async () => {
      const input = callbackOf(fieldsOf());
      const first = await receive(input);
      const second = await receive(input);
      expect(first).toMatchObject({ matchStatus: 'UNMATCHED', duplicate: false });
      expect(second).toEqual({ transactionId: first.transactionId, matchStatus: 'UNMATCHED', duplicate: true });
      expect(await count("select count(*)::text as n from machvon.treasury_transaction where provider_event_id = $1", [input.providerEventId])).toBe(1);
      expect(await count("select count(*)::text as n from machvon.integration_event_inbox where provider = 'KBNN_MOCK' and event_key = $1", [input.providerEventId])).toBe(1);
      const [stored] = await owner<Record<string, unknown>>(
        `select source_kind, provider, direction, amount_vnd::text as amount_vnd, document_no, project_id, match_status, external_id, created_by from machvon.treasury_transaction where id = $1`,
        [first.transactionId],
      );
      expect(stored).toMatchObject({ source_kind: 'CALLBACK_MOCK', provider: 'KBNN_MOCK', direction: 'PAYMENT', amount_vnd: '4200000', project_id: world.projectA, match_status: 'UNMATCHED', created_by: memberId(CHECKER) });
      expect(stored?.external_id).toBe(`KBNN_MOCK|${input.documentNo}|2026-10-15|${world.projectCodeA}`);
      const [inbox] = await owner<{ status: string; payload_reference: string }>("select status, payload_reference from machvon.integration_event_inbox where event_key = $1", [input.providerEventId]);
      expect(inbox).toEqual({ status: 'PROCESSED', payload_reference: input.payloadReference });
    });

    it('creates one transaction when two copies of the same event arrive at the same moment (AC-ST-PAY-006-3)', async () => {
      const input = callbackOf(fieldsOf());
      const [one, two] = await Promise.all([receive(input), receive(input)]);
      expect([one.duplicate, two.duplicate].sort()).toEqual([false, true]);
      expect(one.transactionId).toBe(two.transactionId);
      expect(await count('select count(*)::text as n from machvon.treasury_transaction where provider_event_id = $1', [input.providerEventId])).toBe(1);
    });

    it('answers the first result for the same voucher under a new event id, and again when that new event repeats (dedupe by business key) (AC-ST-PAY-006-3)', async () => {
      const original = fieldsOf();
      const first = await receive(callbackOf(original));
      const resent = callbackOf({ ...original, providerEventId: `resent-${randomUUID().slice(0, 8)}` });
      const second = await receive(resent);
      expect(second).toEqual({ transactionId: first.transactionId, matchStatus: 'UNMATCHED', duplicate: true });
      expect(await receive(resent)).toEqual(second);
      expect(await count("select count(*)::text as n from machvon.treasury_transaction where external_id = $1", [`KBNN_MOCK|${original.documentNo}|2026-10-15|${world.projectCodeA}`])).toBe(1);
      expect((await owner<{ error_code: string }>('select error_code from machvon.integration_event_inbox where event_key = $1', [resent.providerEventId]))[0]?.error_code).toBe('DUPLICATE_BUSINESS_KEY');
    });

    it('refuses the same voucher with other content (the original is never altered) and an event id reused for other content (409)', async () => {
      const original = fieldsOf();
      const first = await receive(callbackOf(original));
      const other = callbackOf({ ...original, providerEventId: `other-${randomUUID().slice(0, 8)}`, amountVnd: '4200001' });
      expect(await refusal(receive(other))).toEqual({ code: 'TREASURY_TRANSACTION_DUPLICATE', status: 409 });
      const reused = callbackOf({ ...original, amountVnd: '4200002' });
      expect(await refusal(receive(reused))).toEqual({ code: 'TREASURY_TRANSACTION_DUPLICATE', status: 409 });
      expect((await owner<{ amount_vnd: string }>('select amount_vnd::text as amount_vnd from machvon.treasury_transaction where id = $1', [first.transactionId]))[0]?.amount_vnd).toBe('4200000');
      expect(await count("select count(*)::text as n from machvon.integration_event_inbox where event_key = $1", [other.providerEventId])).toBe(0);
    });

    it('refuses a bad, missing or foreign signature as 401 SIGNATURE_INVALID and leaves no trace', async () => {
      const fields = fieldsOf();
      const metrics = new CountingMetrics();
      const attempts: TreasuryCallbackInput[] = [
        callbackOf(fields, { signature: 'a'.repeat(64) }),
        callbackOf(fields, { signature: '' }),
        callbackOf(fields, { keys: [{ keyId: 'other', secret: Buffer.from('another-secret') }] }),
        callbackOf(fields, { keys: [] }),
        callbackOf(fields, { keys: [{ keyId: 'empty', secret: Buffer.alloc(0) }] }),
        // The signature covers the fields: a changed amount does not verify.
        callbackOf(fields, { amountVnd: '1' }),
      ];
      for (const attempt of attempts) expect(await refusal(receive(attempt, metrics))).toEqual({ code: 'SIGNATURE_INVALID', status: 401 });
      expect(metrics.counted.filter((name) => name === 'webhook_signature_failures_total')).toHaveLength(attempts.length);
      expect(await count('select count(*)::text as n from machvon.integration_event_inbox where event_key = $1', [fields.providerEventId])).toBe(0);
      expect(await count('select count(*)::text as n from machvon.treasury_transaction where provider_event_id = $1', [fields.providerEventId])).toBe(0);
    });

    it('verifies against any of the keys in force, so a provider can rotate its key', async () => {
      const fields = fieldsOf();
      const rotated = callbackOf(fields, { keys: [{ keyId: 'old', secret: Buffer.from('retired-secret') }, ...KEYS] });
      expect((await receive(rotated)).duplicate).toBe(false);
    });

    it.each([
      ['a refund', { direction: 'REFUND' }, 'direction'],
      ['an unknown project', { projectCode: 'NO-SUCH-PROJECT' }, 'project_code'],
      ['the reserved provider of the files', { provider: 'KBNN_FILE' }, 'provider'],
      ['the reserved provider of manual confirmations', { provider: 'MANUAL' }, 'provider'],
      ['a provider name that is not a name', { provider: 'bad provider!' }, 'provider'],
      ['an amount with a fraction', { amountVnd: '12.5' }, 'amount_vnd'],
      ['a voucher date that does not exist', { documentDate: '2026-13-01' }, 'document_date'],
      ['a booking time that does not read', { confirmedAt: 'soon' }, 'confirmed_at'],
      ['a voucher number with the key separator', { documentNo: 'A|B' }, 'document_no'],
    ])('refuses %s as 422 naming the field, with its inbox row rolled back so the provider can send it again', async (_name, extra, field) => {
      const fields = fieldsOf(extra);
      const input = callbackOf(fields);
      await expect(receive(input)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: field });
      expect(await count('select count(*)::text as n from machvon.integration_event_inbox where event_key = $1', [fields.providerEventId])).toBe(0);
    });
  });

  describe('reads', () => {
    it('lists the transactions of the projects in scope, the latest booked first, in pages, and finds one only inside the scope', async () => {
      const a: Array<{ transactionId: string }> = [];
      for (const hour of [1, 2, 3]) a.push(await receive(callbackOf(fieldsOf({ projectCode: world.projectCodeA, confirmedAt: `2026-11-01T0${hour}:00:00.000Z` }))));
      const b = await receive(callbackOf(fieldsOf({ projectCode: world.projectCodeB, confirmedAt: '2026-11-01T05:00:00.000Z' })));
      const onlyA = await as((tx) => store.list(tx, scopeOf(world.projectA), { limit: 3, after: undefined }));
      expect(onlyA.map((row) => row.id)).toEqual([...a].reverse().map((created) => created.transactionId));
      expect(onlyA[0]).toMatchObject({ projectId: world.projectA, projectCode: world.projectCodeA, sourceKind: 'CALLBACK_MOCK', direction: 'PAYMENT', matchStatus: 'UNMATCHED', amountVnd: '4200000', confirmedAt: '2026-11-01T03:00:00.000000Z' });
      const next = await as((tx) => store.list(tx, everything, { limit: 2, after: { code: onlyA[0]?.confirmedAtKey ?? '', id: onlyA[0]?.id ?? '' } }));
      expect(next).toHaveLength(2);
      expect((next[0]?.confirmedAtKey ?? '') <= (onlyA[0]?.confirmedAtKey ?? '')).toBe(true);
      const ofB = await as((tx) => store.list(tx, scopeOf(world.projectB), { limit: 50, after: undefined }));
      expect(ofB.every((row) => row.projectId === world.projectB)).toBe(true);
      expect(ofB.map((row) => row.id)).toContain(b.transactionId);
      expect((await as((tx) => store.find(tx, scopeOf(world.projectA), a[0]?.transactionId ?? '')))?.id).toBe(a[0]?.transactionId);
      expect(await as((tx) => store.find(tx, scopeOf(world.projectA), b.transactionId))).toBeUndefined();
      expect(await as((tx) => store.find(tx, everything, b.transactionId), TENANT_B)).toBeUndefined();
      await expect(as((tx) => store.find(tx, everything, 'not-a-uuid'))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('lists nothing for a scope that holds no project', async () => {
      expect(await as((tx) => store.list(tx, () => ({ sql: 'false', params: [] }), { limit: 10, after: undefined }))).toEqual([]);
    });
  });
});
