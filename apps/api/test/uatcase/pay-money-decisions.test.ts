import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AdvanceAlertController, AdvanceController, AdvanceReadsController } from '../../src/modules/pay/advance.controller';
import { PaymentClaimController } from '../../src/modules/pay/payment-claim.controller';
import { PaymentRequestController, PaymentRequestReadsController } from '../../src/modules/pay/payment-request.controller';
import { TENANT_A, memberId } from '../../../../packages/db/test/support/authz-fixtures';
import { AcceptanceWorld } from '../../../../packages/db/test/support/acceptance-fixtures';
import type { SeededContract } from '../../../../packages/db/test/support/acceptance-fixtures';
import { seedAs, seedContractor } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';
import { assertStatus, callerOf, expectCheckFails } from '../uat/uat-kit';
import type { Reply } from '../uat/uat-kit';

jest.setTimeout(480_000);

/**
 * The money rules of PAY over HTTP, as the design cases of the UAT plan state them: the rounding of a recovery over the lines of a request (UAT-AC324), the cap of an advance (UAT-AC326)
 * and the recovery of a joint venture member by member (UAT-AC327). The fixture follows the case data in the scale of the test world: a recovery of 100 over lines of gross 1bn and 2bn,
 * a contract of 10bn (construction) and one of 1bn (consulting), a joint venture of 6bn and 4bn.
 */

const SIGNING_KEY = randomBytes(32);
const ROOT = 1;
const CHECKER = 12; // verified the guarantees the advances are covered by
const MAKER = 11; // advance.request, advance.read, payment.create, payment.document.attach, payment.submit, payment_request.read
const TODAY = '2026-07-25';
const everything = { update: () => ({ sql: 'true', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const FAR_DEADLINE = '2099-12-31';

describe('the money rules of PAY over HTTP (decision cases)', () => {
  const fixtures = new AcceptanceWorld();
  const harness = fixtures.harness;
  let app: RunningApp;
  let counter = 0;
  const call = callerOf(() => app.baseUrl, SIGNING_KEY);

  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => fixtures.owner<R>(sql, params);
  const number = (): string => `DNTT-MD-${String((counter += 1)).padStart(4, '0')}`;
  const idOf = (reply: Reply): string => reply.json.resource_id as string;

  /** The shares of a recovery over the lines of a request, in the order of the lines of the contract. */
  const shareOfLines = async (requestId: string, contract: SeededContract): Promise<string[]> => {
    const lines = await rows<{ boq_item_id: string; advance_recovery_vnd: string }>('select boq_item_id, advance_recovery_vnd::text from machvon.payment_request_line where payment_request_id = $1::uuid', [requestId]);
    return contract.items.slice(0, 2).map((item) => lines.find((line) => line.boq_item_id === item)?.advance_recovery_vnd ?? 'missing');
  };

  /** What the ledger holds on a request: the lines add up to the header, none of them goes above its gross. */
  const assertSharesAdd = (shares: string[], header: string, grosses: string[]): void => {
    const total = shares.reduce((sum, share) => sum + BigInt(share), 0n);
    if (total !== BigInt(header)) throw new Error(`the lines add up to ${total}, the header says ${header}`);
    shares.forEach((share, at) => {
      if (BigInt(share) > BigInt(grosses[at] ?? '0')) throw new Error(`line ${at} recovers ${share}, above its gross ${grosses[at]}`);
    });
  };

  /** An advance row in the state the Treasury leaves it in. */
  async function paidAdvanceOf(contractId: string, partyId: string, amount: string, trancheNo: number, thresholdPct = '80', kind = 'GPMB'): Promise<string> {
    const id = randomUUID();
    await rows(
      `insert into machvon.contract_advance
         (tenant_id, id, contract_id, party_id, tranche_no, kind, amount_vnd, cap_vnd, status, paid_vnd, paid_on, recovery_threshold_pct, recovery_deadline, created_by, updated_by)
       values ($1, $2::uuid, $3::uuid, $4::uuid, $5, $8, $6::numeric, $6::numeric, 'PAID', $6::numeric, date '2026-07-01', $7::numeric, $9::date, $10::uuid, $10::uuid)`,
      [TENANT_A, id, contractId, partyId, trancheNo, amount, thresholdPct, kind, FAR_DEADLINE, memberId(MAKER)],
    );
    return id;
  }

  const createRequest = (target: { contractId: string; acceptanceId: string }) =>
    call('POST', '/payment-requests', {
      member: MAKER,
      body: { contract_id: target.contractId, request_kind: 'INTERIM', acceptance_id: target.acceptanceId, allocation_line_id: fixtures.lineId, request_no: number() },
    });

  async function attachInvoice(requestId: string): Promise<void> {
    const invoice = { document_version_id: (await fixtures.documentVersion()).id, doc_kind: 'INVOICE', invoice_no: `INV-${randomUUID().slice(0, 8)}`, invoice_date: '2026-07-01' };
    assertStatus(await call('POST', `/payment-requests/${requestId}/documents`, { member: MAKER, body: invoice }), 200);
  }

  beforeAll(async () => {
    await fixtures.start();
    for (const n of [MAKER, CHECKER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedRole(TENANT_A, 101, 'PAY_MONEY', ['advance.request', 'advance.read', 'payment.create', 'payment.document.attach', 'payment.submit', 'payment_request.read'], 30);
    await harness.seedGrants(TENANT_A, [{ n: 1, member: MAKER, role: 101, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [AdvanceController, AdvanceReadsController, AdvanceAlertController, PaymentRequestController, PaymentRequestReadsController, PaymentClaimController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 480_000);

  afterAll(async () => {
    if (app) await app.close();
    await fixtures.stop();
  }, 60_000);

  it('the check that sums the lines of a recovery goes red on a line that is off by one, or above its gross', () => {
    expectCheckFails(() => assertSharesAdd(['34', '66'], '101', ['1000', '2000']));
    expectCheckFails(() => assertSharesAdd(['34', '67'], '100', ['1000', '2000']));
    expectCheckFails(() => assertSharesAdd(['2000', '1'], '2001', ['1000', '2000']));
    assertSharesAdd(['34', '67'], '101', ['1000', '2000']);
  });

  it('UAT-AC324: a recovery of 100 over lines of gross 1:2 is 33 and 67, 101 is 34 and 67, the lines add up to the header, and a second run gives the same', async () => {
    const run = async (recovery: string): Promise<{ header: string; shares: string[] }> => {
      const contract = await fixtures.seedContract();
      await rows('update machvon.contract_party set work_value_vnd = 3000000000 where contract_id = $1::uuid', [contract.contractId]);
      const approved = await fixtures.approve(contract, [
        { item: 0, quantity: '1000' },
        { item: 1, quantity: '1000' },
      ]);
      // The advance left to recover is the recovery asked for, and its threshold is the whole work, so the whole of it falls on this request.
      await paidAdvanceOf(contract.contractId, contract.partyId, recovery, 1, '100');
      const made = await createRequest({ contractId: contract.contractId, acceptanceId: approved.acceptance.id });
      assertStatus(made, 200);
      const header = made.json.advance_recovery_vnd as string;
      const shares = await shareOfLines(idOf(made), contract);
      assertSharesAdd(shares, header, ['1000000000', '2000000000']);
      return { header, shares };
    };
    expect(await run('100')).toEqual({ header: '100', shares: ['33', '67'] });
    expect(await run('101')).toEqual({ header: '101', shares: ['34', '67'] });
    expect(await run('101')).toEqual({ header: '101', shares: ['34', '67'] });
  });

  describe('the cap of an advance', () => {
    /** A contract being performed in the category given, with a verified advance guarantee of 5bn. */
    async function contractOf(category: string, value: string): Promise<SeededContract> {
      const contract = await fixtures.seedContract();
      await rows('update machvon.contract set advance_category = $2, contract_value_vnd = $3::numeric, estimate_ceiling_vnd = null where id = $1::uuid', [contract.contractId, category, value]);
      await rows('update machvon.contract_party set work_value_vnd = $2::numeric where contract_id = $1::uuid', [contract.contractId, value]);
      const paper = (await fixtures.documentVersion()).id;
      await rows(
        `insert into machvon.guarantee
           (tenant_id, id, contract_id, kind, issuer, guarantee_no, amount_vnd, currency, valid_from, expires_at, status, verification_status, document_version_id, verified_by, verified_at, verification_method,
            verification_evidence_id, created_by, updated_by)
         values ($1, gen_random_uuid(), $2::uuid, 'ADVANCE', 'Bank', $3, 5000000000, 'VND', date '2026-01-02', now() + interval '1 year', 'ACTIVE', 'VERIFIED', $4::uuid, $5::uuid, now(), 'BANK_CONFIRMATION', $4::uuid, $6::uuid, $6::uuid)`,
        [TENANT_A, contract.contractId, `BL-${randomUUID().slice(0, 8)}`, paper, memberId(CHECKER), memberId(MAKER)],
      );
      return contract;
    }
    const ask = (contract: SeededContract, amount: string): Promise<Reply> =>
      call('POST', `/contracts/${contract.contractId}/advances`, { member: MAKER, body: { party_id: contract.partyId, kind: 'CONTRACT', amount_vnd: amount, allocation_line_id: fixtures.lineId } });
    const advancesOf = (contractId: string) => rows<{ status: string; amount: string }>('select status, amount_vnd::text as amount from machvon.contract_advance where contract_id = $1::uuid order by tranche_no', [contractId]);
    /** The version of the rule of the day for a category: what the advance must record as the rule that capped it. */
    const ruleOf = async (category: string): Promise<{ id: string; awaiting: boolean; cxn: string }> => {
      const [rule] = await rows<{ id: string; awaiting: boolean; cxn: string }>(
        `select v.id, (v.attributes ->> 'awaiting_confirmation')::boolean as awaiting, v.attributes ->> 'cxn' as cxn
           from machvon.master_record r join machvon.master_record_version v on v.master_record_id = r.id
          where r.master_type = 'PAY_ADVANCE_CAP' and r.business_key = $1 and v.published_at is not null order by v.revision desc limit 1`,
        [category],
      );
      if (rule === undefined) throw new Error(`no rule of the cap for ${category}`);
      return rule;
    };
    /** A refusal of the cap: the status, the code, the room, and the rule it was judged by, with the sign that the rule waits for its confirmation. */
    const assertCapRefusal = async (reply: Reply, category: string, capVnd: string, capPct: string): Promise<void> => {
      const rule = await ruleOf(category);
      assertStatus(reply, 422, 'ADVANCE_CAP_EXCEEDED');
      const wanted = { cap_vnd: capVnd, cap_pct: capPct, cap_rule_version_id: rule.id, rule_awaiting_confirmation: true, cxn: 'CXN-02' };
      for (const [member, value] of Object.entries(wanted)) {
        if (reply.json[member] !== value) throw new Error(`the refusal says ${member} = ${String(reply.json[member])}, expected ${String(value)}`);
      }
      if (!rule.awaiting || rule.cxn !== 'CXN-02') throw new Error('the rule of the cap is not marked as waiting for CXN-02');
    };
    /** An advance planned: it is told once that the rule waits for its confirmation, naming the version of the rule it was capped by. */
    const assertPlanned = async (reply: Reply, category: string, amount: string): Promise<void> => {
      assertStatus(reply, 200);
      const rule = await ruleOf(category);
      if (reply.json.amount_vnd !== amount || reply.json.status !== 'PLANNED') throw new Error(`the advance is ${String(reply.json.status)} for ${String(reply.json.amount_vnd)}`);
      if (reply.json.cap_rule_version_id !== rule.id) throw new Error('the advance does not name the version of the rule that capped it');
      expect(reply.json.warnings).toEqual([{ code: 'RULE_AWAITING_CONFIRMATION', detail: { cxn: 'CXN-02', cap_rule_version_id: rule.id } }]);
    };

    it('the check of a refusal of the cap goes red on a cap that is off by a dong or on a rule that is not the one of the day', async () => {
      const refusal: Reply = { status: 422, json: { code: 'ADVANCE_CAP_EXCEEDED', cap_vnd: '2000000000' } };
      await expect(assertCapRefusal(refusal, 'CONSTRUCTION', '2000000001', '20')).rejects.toThrow();
      await expect(assertCapRefusal({ status: 409, json: refusal.json }, 'CONSTRUCTION', '2000000000', '20')).rejects.toThrow();
      await expect(assertCapRefusal(refusal, 'CONSTRUCTION', '2000000000', '20')).rejects.toThrow('cap_pct');
    });

    it('UAT-AC326: the cap is 20 percent of a construction contract of 10bn to the dong, what is advanced already is taken off it, and a consulting contract of 1bn is capped at 30 percent; every refusal names the rule that is waiting for its confirmation', async () => {
      // Step 1: the amount that equals the cap is planned, and is told that the rule waits.
      const exact = await contractOf('CONSTRUCTION', '10000000000');
      await assertPlanned(await ask(exact, '2000000000'), 'CONSTRUCTION', '2000000000');

      // Step 2: one dong above the cap is 422, names the cap and the rule, and writes nothing.
      const over = await contractOf('CONSTRUCTION', '10000000000');
      await assertCapRefusal(await ask(over, '2000000001'), 'CONSTRUCTION', '2000000000', '20');
      expect(await advancesOf(over.contractId)).toEqual([]);

      // Step 3: a first tranche of 1.5bn is paid, so what is left is 500m: 600m is refused with that cap, nothing more is written.
      const second = await contractOf('CONSTRUCTION', '10000000000');
      await paidAdvanceOf(second.contractId, second.partyId, '1500000000', 1);
      await rows('update machvon.contract set advance_paid_vnd = 1500000000 where id = $1::uuid', [second.contractId]);
      await assertCapRefusal(await ask(second, '600000000'), 'CONSTRUCTION', '500000000', '20');
      expect(await advancesOf(second.contractId)).toEqual([{ status: 'PAID', amount: '1500000000' }]);
      await assertPlanned(await ask(second, '500000000'), 'CONSTRUCTION', '500000000');

      // Step 4: the consulting contract of 1bn takes 300m and refuses a dong more.
      const consulting = await contractOf('CONSULTING', '1000000000');
      const planned = await ask(consulting, '300000000');
      await assertPlanned(planned, 'CONSULTING', '300000000');
      expect(planned.json).toMatchObject({ cap_pct: '30', cap_vnd: '300000000' });
      const consultingOver = await contractOf('CONSULTING', '1000000000');
      await assertCapRefusal(await ask(consultingOver, '300000001'), 'CONSULTING', '300000000', '30');
      expect(await advancesOf(consultingOver.contractId)).toEqual([]);

      // The rule is the same on a second run of the same asks.
      const again = await contractOf('CONSTRUCTION', '10000000000');
      await assertCapRefusal(await ask(again, '2000000001'), 'CONSTRUCTION', '2000000000', '20');
    });
  });

  it('UAT-AC327: each member of a joint venture recovers on its own work and its own advance: the first is recovered in full at 80 percent of its work, and the second is not touched by it', async () => {
    const contract = await fixtures.seedContract();
    const second = randomUUID();
    const secondContractor = await seedContractor(harness);
    // M1 (lead) holds 60 percent of the value, 6bn of work; M2 40 percent, 4bn. The shares add up to a hundred at the end of the statement, so the two are written together.
    await rows(
      `with lead as (update machvon.contract_party set role = 'LEAD', share_pct = 60, work_value_vnd = 6000000000 where contract_id = $1::uuid returning 1)
       insert into machvon.contract_party (tenant_id, id, contract_id, contractor_id, role, share_pct, work_value_vnd, status, valid_from, created_by, updated_by)
       values ($2, $3::uuid, $1::uuid, $4::uuid, 'MEMBER', 40, 4000000000, 'ACTIVE', date '2026-01-02', $5::uuid, $5::uuid)`,
      [contract.contractId, TENANT_A, second, secondContractor, memberId(MAKER)],
    );
    await rows('update machvon.contract set advance_paid_vnd = 1500000000, is_joint_venture = true where id = $1::uuid', [contract.contractId]);
    const m1Advance = await paidAdvanceOf(contract.contractId, contract.partyId, '900000000', 1, '80');
    const m2Advance = await paidAdvanceOf(contract.contractId, second, '600000000', 1, '80');
    const advanceOf = async (id: string) => (await rows<{ recovered: string; status: string; outstanding: string }>('select recovered_vnd::text as recovered, status, outstanding_vnd::text as outstanding from machvon.contract_advance where id = $1::uuid', [id]))[0];

    let revision = 0;
    /** An approved measurement of one member's work, then the acceptance of it by the commands of CTR. */
    const approve = async (item: 0 | 1, quantity: string, party: string) => {
      revision += 1;
      const measurementId = randomUUID();
      const lineId = (await rows<{ id: string }>('select id from machvon.boq_line where contract_id = $1::uuid and boq_item_id = $2::uuid limit 1', [contract.contractId, contract.items[item]]))[0]?.id;
      const paper = (await fixtures.documentVersion()).id;
      await seedAs(harness, [
        [
          `insert into machvon.measurement
             (tenant_id, id, contract_id, contract_revision_id, boq_line_id, boq_item_id, party_id, period_id, quantity_period, quantity_cumulative, revision, status, evidence_refs, reference_no,
              created_by, updated_by, submitted_by, submitted_at, decided_by, decided_at, version)
           values ($1, $2, $3, $4, $5, $6, $7, (select id from machvon.reporting_period limit 1), $8::numeric, $8::numeric, $9, 'APPROVED', jsonb_build_array(jsonb_build_object('document_version_id', $10::text)), $11,
                   $12, $12, $12, now(), $13, now(), 1)`,
          [TENANT_A, measurementId, contract.contractId, contract.revisionId, lineId, contract.items[item], party, quantity, revision, paper, `NK-JV-${randomUUID().slice(0, 8)}`, memberId(1), memberId(3)],
        ],
      ]);
      const period = (await rows<{ id: string }>('select id from machvon.reporting_period limit 1'))[0]?.id as string;
      const drafted = await fixtures.as((tx) => fixtures.acceptances.create(tx, contract.contractId, { measurementIds: [measurementId], periodId: period, documentVersionId: paper }, memberId(1), everything, TODAY), 1);
      const sent = await fixtures.as((tx) => fixtures.acceptances.submit(tx, drafted.id, drafted.version, { signerRefs: [{ name: 'Owner', role: 'OWNER' }] }, memberId(2), everything), 2);
      return fixtures.as((tx) => fixtures.acceptances.decide(tx, sent.id, sent.version, { decision: 'approve', reason: 'Checked.', evidenceIds: [] }, memberId(3), everything), 3);
    };
    /** A payment request of an acceptance, drafted, given its invoice and sent; what the draft computed is returned. */
    const pay = async (acceptanceId: string): Promise<{ recovery: string; gross: string }> => {
      const made = await createRequest({ contractId: contract.contractId, acceptanceId });
      assertStatus(made, 200);
      const id = idOf(made);
      await attachInvoice(id);
      const sent = await call('POST', `/payment-requests/${id}/submit`, { member: MAKER, ifMatch: String(made.json.resource_version), body: { expected_gross_vnd: made.json.gross_vnd, expected_net_vnd: made.json.net_vnd } });
      assertStatus(sent, 200);
      expect(sent.json).toMatchObject({ status: 'SUBMITTED', advance_recovery_vnd: made.json.advance_recovery_vnd });
      return { recovery: made.json.advance_recovery_vnd as string, gross: made.json.gross_vnd as string };
    };

    // Payment 1: gross 2.4bn of M1, a half of its threshold of 4.8bn, so half of its advance: floor(900m x 2.4bn / 4.8bn) = 450m.
    expect(await pay((await approve(0, '2400', contract.partyId)).id)).toEqual({ recovery: '450000000', gross: '2400000000' });
    expect(await advanceOf(m1Advance)).toEqual({ recovered: '450000000', status: 'RECOVERING', outstanding: '450000000' });
    const midway = await call('GET', `/advances/${m1Advance}/recovery-plan`, { member: MAKER });
    assertStatus(midway, 200);
    expect(midway.json).toMatchObject({ target_recovered_vnd: '450000000', recovered_vnd: '450000000', outstanding_vnd: '450000000' });
    // Payment 2: the gross to date is 4.8bn, 80 percent of 6bn: another 450m, 900m in all, nothing outstanding, the advance of M1 recovered in full.
    expect(await pay((await approve(0, '2400', contract.partyId)).id)).toEqual({ recovery: '450000000', gross: '2400000000' });
    expect(await advanceOf(m1Advance)).toEqual({ recovered: '900000000', status: 'FULLY_RECOVERED', outstanding: '0' });
    expect(await advanceOf(m2Advance)).toEqual({ recovered: '0', status: 'PAID', outstanding: '600000000' });
    // Payment 3: M2 asks for 1bn of its 3.2bn threshold: floor(600m x 1bn / 3.2bn) = 187.5m, 412.5m outstanding, and the progress of M1 does not touch it.
    expect(await pay((await approve(1, '500', second)).id)).toEqual({ recovery: '187500000', gross: '1000000000' });
    expect(await advanceOf(m2Advance)).toEqual({ recovered: '187500000', status: 'RECOVERING', outstanding: '412500000' });
    expect(await advanceOf(m1Advance)).toEqual({ recovered: '900000000', status: 'FULLY_RECOVERED', outstanding: '0' });
    // Step 4: a further payment of M1 computes a recovery of nothing, and neither advance moves.
    expect(await pay((await approve(0, '100', contract.partyId)).id)).toEqual({ recovery: '0', gross: '100000000' });
    expect(await advanceOf(m1Advance)).toEqual({ recovered: '900000000', status: 'FULLY_RECOVERED', outstanding: '0' });
    expect(await advanceOf(m2Advance)).toEqual({ recovered: '187500000', status: 'RECOVERING', outstanding: '412500000' });
    expect(await rows<{ recovered: string }>('select advance_recovered_vnd::text as recovered from machvon.contract where id = $1::uuid', [contract.contractId])).toEqual([{ recovered: '1087500000' }]);
  });
});
