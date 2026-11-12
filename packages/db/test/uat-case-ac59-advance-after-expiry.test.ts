import { AuditWriter } from '../src/audit-writer';
import { CtrGuaranteeExpiry } from '../src/ctr-guarantee-expiry';
import { CtrGuaranteeStore } from '../src/ctr-guarantee-store';
import type { ContractScopes } from '../src/ctr-contract-store';
import { PayAdvanceStore } from '../src/pay-advance-store';
import type { TenantTx } from '../src/tenant-database';
import { memberId } from './support/authz-fixtures';
import { AcceptanceWorld } from './support/acceptance-fixtures';
import type { SeededContract } from './support/acceptance-fixtures';

/**
 * UAT-AC59, the part of the case that sits in PAY and in the replacement of a guarantee (docs/uat/ctr/uat.json, CTR-05): once the job guarantee-expiry has made the advance guarantee EXPIRED
 * (2026-12-02), a new advance on the contract is refused 422 ADVANCE_GUARANTEE_REQUIRED, and only a guarantee that is registered and verified anew makes an advance possible again; an ACTIVE guarantee
 * is replaced only by extendGuarantee, which makes a pending replacement and never an automatic extension. The reminders and the issue of the lapse are proven in
 * apps/api/test/ctr/uat-case-ac59-guarantee-expiry.test.ts.
 */
jest.setTimeout(600_000);

const fixtures = new AcceptanceWorld();
const guarantees = new CtrGuaranteeStore();
const advances = new PayAdvanceStore();
const REGISTRAR = 1;
const VERIFIER = 3;
const everything: ContractScopes = { update: () => ({ sql: 'true', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const at = (day: string): Date => new Date(`${day}T06:00:00+07:00`);
const as = <T>(work: (tx: TenantTx) => Promise<T>, member = REGISTRAR): Promise<T> => fixtures.as(work, member);
const owner = fixtures.owner.bind(fixtures);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; extensions?: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

/** A contract in force whose advance cap is 2,000,000,000, with the paper of its guarantees. */
async function contractOf(): Promise<{ contract: SeededContract; paper: string }> {
  const contract = await fixtures.seedContract();
  await owner("update machvon.contract set advance_category = 'CONSTRUCTION', contract_value_vnd = 10000000000::numeric, estimate_ceiling_vnd = null where id = $1::uuid", [contract.contractId]);
  await owner('update machvon.contract_party set work_value_vnd = 10000000000::numeric where contract_id = $1::uuid', [contract.contractId]);
  return { contract, paper: (await fixtures.documentVersion()).id };
}

let counter = 0;
/** An advance guarantee of 2,000,000,000 registered by one person and verified by another: ACTIVE until the instant given. */
async function activeGuarantee(contract: SeededContract, paper: string, expiresAt: string): Promise<string> {
  counter += 1;
  const registered = await as((tx) =>
    guarantees.register(tx, contract.contractId, { kind: 'ADVANCE', issuer: 'Bank', guaranteeNo: `BL-${contract.code}-${counter}`, amountVnd: '2000000000', validFrom: '2026-03-01', expiresAt, documentVersionId: paper }, memberId(REGISTRAR), everything, at('2026-10-24')),
  );
  const verified = await as(
    (tx) => guarantees.verify(tx, registered.id, 1, { outcome: 'VERIFIED', method: 'Confirmation letter', evidenceDocumentVersionId: paper }, memberId(VERIFIER), everything, at('2026-10-24')),
    VERIFIER,
  );
  return verified.id;
}

const request = (contract: SeededContract, day: string) =>
  as((tx) => advances.request(tx, contract.contractId, { partyId: contract.partyId, kind: 'CONTRACT', amountVnd: '1000000000', allocationLineId: fixtures.lineId }, memberId(REGISTRAR), everything, at(day)));
const runJob = (day: string) => as((tx) => new CtrGuaranteeExpiry(new AuditWriter(fixtures.harness.tenants)).run(tx, memberId(REGISTRAR), at(day)));
const guaranteeRow = async (id: string) => (await owner<{ status: string; version: string; extended_from_id: string | null; verification_status: string }>('select status, version::text as version, extended_from_id, verification_status from machvon.guarantee where id = $1::uuid', [id]))[0];

describe('UAT-AC59: after the advance guarantee has lapsed a new advance is refused, and a guarantee is replaced only by a new one', () => {
  beforeAll(() => fixtures.start(), 240_000);

  afterAll(() => fixtures.stop(), 60_000);

  it('UAT-AC59: 2026-12-02 the job makes the advance guarantee EXPIRED and requestAdvance answers 422 ADVANCE_GUARANTEE_REQUIRED; only a guarantee registered and verified anew, or the replacement of extendGuarantee once verified, lets it through', async () => {
    const lapsing = await contractOf();
    const lapsingGuarantee = await activeGuarantee(lapsing.contract, lapsing.paper, '2026-12-01T16:59:00Z');
    const extended = await contractOf();
    const extendedGuarantee = await activeGuarantee(extended.contract, extended.paper, '2026-12-01T16:59:00Z');

    // 2026-11-24: nothing is wrong yet, an advance would be planned on the guarantee (the control of the refusal below).
    expect(await request(extended.contract, '2026-11-24')).toMatchObject({ view: { status: 'PLANNED', guaranteeId: extendedGuarantee } });
    // The accountant extends one of the two before the day: extendGuarantee is the one thing that makes a replacement, the old paper leaves, the new one waits for its check.
    const replacement = await as((tx) =>
      guarantees.extend(tx, extendedGuarantee, 2, { newExpiresAt: '2027-06-30T16:59:00Z', newGuaranteeNo: 'BL-EXTENDED', documentVersionId: extended.paper }, memberId(REGISTRAR), everything, at('2026-11-25')),
    );
    expect(replacement).toMatchObject({ status: 'PENDING_VERIFICATION', supersededId: extendedGuarantee });
    expect(await guaranteeRow(extendedGuarantee)).toMatchObject({ status: 'SUPERSEDED' });
    expect(await guaranteeRow(replacement.id)).toMatchObject({ status: 'PENDING_VERIFICATION', extended_from_id: extendedGuarantee });

    // 2026-12-02: the job runs; the lapsing guarantee, and nothing else, becomes EXPIRED and is not replaced by itself.
    await runJob('2026-12-02');
    expect(await guaranteeRow(lapsingGuarantee)).toMatchObject({ status: 'EXPIRED', verification_status: 'VERIFIED' });
    expect(await owner('select 1 from machvon.guarantee where contract_id = $1::uuid', [lapsing.contract.contractId])).toHaveLength(1);
    const refused = await refusal(request(lapsing.contract, '2026-12-02'));
    expect(refused).toMatchObject({ code: 'ADVANCE_GUARANTEE_REQUIRED', status: 422, extensions: { reason: 'NOT_ACTIVE' } });
    // Nothing was planned by the refused request.
    expect(await owner("select 1 from machvon.contract_advance where contract_id = $1::uuid", [lapsing.contract.contractId])).toHaveLength(0);
    // An expired guarantee cannot be extended: it has to be registered anew.
    expect(
      await refusal(as((tx) => guarantees.extend(tx, lapsingGuarantee, 3, { newExpiresAt: '2028-06-30T16:59:00Z', newGuaranteeNo: 'BL-LATE', documentVersionId: lapsing.paper }, memberId(REGISTRAR), everything, at('2026-12-02')))),
    ).toMatchObject({ status: 409 });
    // The replacement of an extension is verified like any guarantee; the lapsed contract needs a guarantee registered and verified anew.
    await as((tx) => guarantees.verify(tx, replacement.id, 1, { outcome: 'VERIFIED', method: 'Confirmation letter', evidenceDocumentVersionId: extended.paper }, memberId(VERIFIER), everything, at('2026-12-02')), VERIFIER);
    const renewed = await activeGuarantee(lapsing.contract, lapsing.paper, '2027-12-01T16:59:00Z');
    expect(await request(lapsing.contract, '2026-12-02')).toMatchObject({ view: { status: 'PLANNED', guaranteeId: renewed } });
  });

  it('negative control: the checks of this suite go red on an answer that is wrong on purpose', async () => {
    const lapsing = await contractOf();
    await activeGuarantee(lapsing.contract, lapsing.paper, '2026-12-01T16:59:00Z');
    // The guarantee still ACTIVE on 2026-12-01: asserting the refusal there must fail, so the refusal above is not a refusal of anything else.
    await expect(refusal(request(lapsing.contract, '2026-12-01'))).rejects.toThrow('expected a refusal');
  });
});
