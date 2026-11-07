import { randomUUID } from 'node:crypto';
import { CapContractAvcStore } from '../src/cap-contract-avc-store';
import { CtrChangeChainStore } from '../src/ctr-change-chain-store';
import type { ChangeResult } from '../src/ctr-change-chain-store';
import { CtrChangeDecisionStore } from '../src/ctr-change-decision-store';
import type { DecisionHooks } from '../src/ctr-change-decision-store';
import { CtrChangeTierStore } from '../src/ctr-change-tier-store';
import type { ContractScopes } from '../src/ctr-contract-store';
import { HomeMoneySources } from '../src/home-money-sources';
import { DEFAULT_SEVERITY_RULES } from '../src/home-work-rules';
import type { SourceContext } from '../src/home-work-sources';
import { MoneyPolicyReader } from '../src/money-policy-reader';
import { PayAdvanceRecoveryReads } from '../src/pay-advance-recovery-reads';
import { PrjReserveStore } from '../src/prj-reserve-store';
import type { TenantTx } from '../src/tenant-database';
import { TENANT_A, contextFor, id, memberId } from './support/authz-fixtures';
import { everything, seedAs } from './support/bid-proposal-fixtures';
import { CapWorld } from './support/cap-fixtures';

const world = new CapWorld();
const harness = world.harness;
const chain = new CtrChangeChainStore();
const decisions = new CtrChangeDecisionStore();
const tiers = new CtrChangeTierStore();
const reserves = new PrjReserveStore();
const avc = new CapContractAvcStore();
const advances = new PayAdvanceRecoveryReads();
const FAMILY = 0xb4;
const MAKER = 1;
const EVALUATOR = 2;
const APPROVER = 3;
const DOCUMENT_MAKER = 4;
const CLEARER = 5;
const FUNDER = 6;
const CONTRACTOR = id(FAMILY, 10);
const DOCUMENT = id(FAMILY, 30);
const VERSION = id(FAMILY, 31);
const TODAY = '2026-07-20';
const contractScopes: ContractScopes = { update: () => ({ sql: 'true', params: [] }), read: () => ({ sql: 'true', params: [] }) };

let PROJECT = '';
let LINE = '';
let counter = 0;

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = MAKER): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; extensions?: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

const databaseRefusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    return (error as { message: string }).message;
  }
  throw new Error('expected the database to refuse');
};

interface Seeded {
  contractId: string;
  code: string;
  revisionId: string;
}

/** A contract being performed under revision 1 worth 10 billion. */
async function seedContract(): Promise<Seeded> {
  counter += 1;
  const contractId = randomUUID();
  const revisionId = randomUUID();
  const packageId = randomUUID();
  const code = `HD-G4-${String(counter).padStart(4, '0')}`;
  await seedAs(harness, [
    [
      `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, allocation_line_id) values ($1, $2, $3, $4, 100000000000, 'OPEN', 1, 'AWARDED', $5)`,
      [TENANT_A, packageId, PROJECT, `PKG-${code}`, LINE],
    ],
    [
      `insert into machvon.contract
         (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd, created_by, updated_by, signed_on, effective_from)
       values ($1, $2, $3, $4, $5, $6, 'UNIT_PRICE', 'VND', 'ACTIVE', 1, 'Contract', 'CONSTRUCTION', false, true, 10000000000, $7, $7, date '2026-01-01', date '2026-01-02')`,
      [TENANT_A, contractId, PROJECT, packageId, CONTRACTOR, code, memberId(MAKER)],
    ],
    [
      `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by)
       values ($1, $2, $3, 1, 10000000000, $4, date '2026-01-02', 'DRAFT', 'BASE', 1, $5, $5)`,
      [TENANT_A, revisionId, contractId, VERSION, memberId(MAKER)],
    ],
    [`update machvon.contract_revision set status = 'EFFECTIVE', decided_by = $2, decided_at = now() where id = $1::uuid`, [revisionId, memberId(MAKER)]],
    [`update machvon.contract set current_revision_id = $2 where id = $1::uuid`, [contractId, revisionId]],
  ]);
  return { contractId, code, revisionId };
}

/** A CO that was assessed (raised and promoted by the maker, assessed by the evaluator); the tiers of the change orders classify it when `classify` is on. */
async function evaluatedCo(contract: Seeded, delta: string, classify = true): Promise<{ co: ChangeResult; evaluated: ChangeResult }> {
  const event = await as((tx) => chain.create(tx, contract.contractId, { stage: 'EVENT', baselineRevisionId: contract.revisionId, reason: 'The owner instructed a change.', estimatedDeltaVnd: delta, scheduleImpactDays: 5 }, memberId(MAKER), contractScopes));
  const pco = await as((tx) => chain.promote(tx, event.id, 1, 'It is a change.', memberId(MAKER), contractScopes));
  const co = await as((tx) => chain.promote(tx, pco.id, 1, 'Priced.', memberId(MAKER), contractScopes));
  const increase = BigInt(delta) > 0n;
  const evaluated = await as(
    (tx) =>
      chain.evaluate(tx, co.id, 1, { evaluatedDeltaVnd: delta, scheduleImpactDays: 5, fundingImpactNote: 'Paid from the plan.', ...(increase ? { allocationLineId: LINE } : {}) }, memberId(EVALUATOR), contractScopes, {
        available: async () => undefined,
        ...(classify ? { classify: (facts) => tiers.classify(tx, facts, memberId(EVALUATOR), TODAY).then((outcome) => ({ tier: outcome.classification.tier, cumulativePct: outcome.classification.cumulativePct, checkRaised: outcome.checkRaised })) } : {}),
      }),
    EVALUATOR,
  );
  return { co, evaluated };
}

const gatedHooks = (): DecisionHooks =>
  ({
    authorise: async () => undefined,
    available: async () => undefined,
  }) as DecisionHooks;

const decide = (co: ChangeResult, version: number, member = APPROVER, withGate = true) =>
  as(
    (tx) =>
      decisions.decide(
        tx,
        co.id,
        version,
        { decision: 'approve', reason: 'The change is within the plan.', evidenceIds: [], effectiveOn: '2026-08-01', decisionDocumentVersionId: VERSION },
        memberId(member),
        contractScopes,
        TODAY,
        {
          ...gatedHooks(),
          ...(withGate ? { gate: (facts: { changeId: string; contractId: string; projectId: string; deltaVnd: string }) => tiers.gate(tx, facts, memberId(member), TODAY).then((outcome) => ({ authorityAmountVnd: outcome.classification.authorityAmountVnd })) } : {}),
        },
      ),
    member,
  );

async function risk(code: string, status = 'OPEN'): Promise<string> {
  const riskId = randomUUID();
  await seedAs(harness, [
    [
      `insert into machvon.project_risk (tenant_id, id, project_id, code, category_master_version_id, title, description, likelihood, impact, owner_membership_id, mitigation, due_date, status, created_by, updated_by)
       values ($1, $2, $3, $4, $5, 'Risk', 'Description', 3, 3, $6, 'Mitigation', date '2027-01-01', $7, $6, $6)`,
      [TENANT_A, riskId, PROJECT, `${code}-${randomUUID().slice(0, 6)}`, randomUUID(), memberId(MAKER), status],
    ],
  ]);
  return riskId;
}

const moneyContext = (tx: TenantTx): SourceContext => ({
  tx,
  membershipId: memberId(MAKER),
  now: new Date(`${TODAY}T03:00:00Z`),
  today: TODAY,
  view: 'scope',
  unitScope: everything,
  projectScope: everything,
  rules: DEFAULT_SEVERITY_RULES,
  counting: false,
});

describe('the money control of a public investment project (governance deepening, lane B2: G1-6, G1-7, G1-8, G1-11)', () => {
  beforeAll(async () => {
    await world.start();
    for (const n of [DOCUMENT_MAKER, CLEARER, FUNDER]) await harness.seedMembership(TENANT_A, n, 1);
    const published = await world.publishedLine();
    PROJECT = published.projectId;
    LINE = published.lineId;
    await seedAs(harness, [
      [`insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id) values ($1, $2, '0100000004', 'Lead Builders', 'VERIFIED', $3)`, [TENANT_A, CONTRACTOR, DOCUMENT]],
      [`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Decision', 'INTERNAL', $3, $3)`, [TENANT_A, DOCUMENT, memberId(DOCUMENT_MAKER)]],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/gov4/decision.pdf', repeat('b', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, VERSION, DOCUMENT],
      ],
    ]);
    await as((tx) => chain.setTiers(tx, PROJECT, 3, memberId(MAKER), everything));
  }, 240_000);

  afterAll(async () => {
    await world.stop();
  }, 60_000);

  describe('G1-7: the contingency and the management reserve', () => {
    it('keeps two funds apart, moves the balance only through the ledger, and refuses to take more than the balance', async () => {
      const filled = await as((tx) => reserves.fund(tx, PROJECT, { kind: 'CONTINGENCY', amountVnd: '2000000000', authorityDocumentVersionId: VERSION, reason: 'Allotted by the decision on the investment.' }, memberId(FUNDER), everything), FUNDER);
      expect(filled).toMatchObject({ kind: 'CONTINGENCY', balanceVnd: '2000000000', status: 'FUNDED' });
      const management = await as((tx) => reserves.fund(tx, PROJECT, { kind: 'MGMT_RESERVE', amountVnd: '500000000', authorityDocumentVersionId: VERSION, reason: 'Held by the level above.' }, memberId(FUNDER), everything), FUNDER);
      expect(management.fundId).not.toBe(filled.fundId);
      expect(await refusal(as((tx) => reserves.fund(tx, PROJECT, { kind: 'SLUSH', amountVnd: '1', authorityDocumentVersionId: VERSION, reason: 'x' }, memberId(FUNDER), everything), FUNDER))).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(await refusal(as((tx) => reserves.fund(tx, PROJECT, { kind: 'CONTINGENCY', amountVnd: '1', authorityDocumentVersionId: undefined, reason: 'x' }, memberId(FUNDER), everything), FUNDER))).toMatchObject({ code: 'DECISION_DOCUMENT_REQUIRED' });

      // The balance is the database's: a statement that moves it directly, or edits or removes an entry, is refused.
      expect(await databaseRefusal(owner('update machvon.reserve_fund set balance_vnd = balance_vnd + 1 where id = $1::uuid', [filled.fundId]))).toMatch(/moves only through an entry/);
      expect(await databaseRefusal(owner('update machvon.reserve_ledger_entry set reason = $2 where id = $1::uuid', [filled.ledgerEntryId, 'edited']))).toMatch(/append-only/);
      expect(await databaseRefusal(owner('delete from machvon.reserve_ledger_entry where id = $1::uuid', [filled.ledgerEntryId]))).toMatch(/append-only/);
      expect(await databaseRefusal(owner('truncate machvon.reserve_ledger_entry'))).toMatch(/append-only|permission/);
      // An entry that would take the balance below nothing is refused by the database too.
      expect(
        await databaseRefusal(
          owner(
            `insert into machvon.reserve_ledger_entry (tenant_id, fund_id, project_id, entry_kind, amount_vnd, risk_id, drawdown_id, reason, requested_by, approved_by)
             select tenant_id, id, project_id, 'DRAWDOWN', balance_vnd + 1, $2::uuid, gen_random_uuid(), 'over', $3::uuid, $4::uuid from machvon.reserve_fund where id = $1::uuid`,
            [filled.fundId, randomUUID(), memberId(MAKER), memberId(APPROVER)],
          ),
        ),
      ).toBeTruthy();
    });

    it('a drawdown is for one risk or one change order, decided by someone else, and posts an entry that keeps the balance after it', async () => {
      const openRisk = await risk('R-DD');
      const fund = (await owner<{ id: string; balance_vnd: string }>("select id, balance_vnd::text from machvon.reserve_fund where project_id = $1::uuid and kind = 'CONTINGENCY'", [PROJECT]))[0];
      const before = BigInt(fund?.balance_vnd ?? '0');
      expect(await refusal(as((tx) => reserves.requestDrawdown(tx, PROJECT, { kind: 'CONTINGENCY', amountVnd: '100000000', reason: 'No link.' }, memberId(MAKER), everything)))).toMatchObject({ code: 'RESERVE_LINK_REQUIRED' });
      expect(await refusal(as((tx) => reserves.requestDrawdown(tx, PROJECT, { kind: 'CONTINGENCY', amountVnd: '100000000', riskId: openRisk, changeRequestId: randomUUID(), reason: 'Both.' }, memberId(MAKER), everything)))).toMatchObject({ code: 'RESERVE_LINK_REQUIRED' });
      expect(await refusal(as((tx) => reserves.requestDrawdown(tx, PROJECT, { kind: 'CONTINGENCY', amountVnd: (before + 1n).toString(), riskId: openRisk, reason: 'Too much.' }, memberId(MAKER), everything)))).toMatchObject({ code: 'RESERVE_BALANCE_INSUFFICIENT' });
      expect(await refusal(as((tx) => reserves.requestDrawdown(tx, PROJECT, { kind: 'CONTINGENCY', amountVnd: '5', riskId: randomUUID(), reason: 'Not ours.' }, memberId(MAKER), everything)))).toMatchObject({ code: 'VALIDATION_FAILED' });

      const asked = await as((tx) => reserves.requestDrawdown(tx, PROJECT, { kind: 'CONTINGENCY', amountVnd: '300000000', riskId: openRisk, reason: 'The foundation is wetter than the survey said.' }, memberId(MAKER), everything));
      expect(asked).toMatchObject({ status: 'REQUESTED', version: 1, riskId: openRisk });
      // What is asked for and not decided is not free to be asked for again.
      expect(await refusal(as((tx) => reserves.requestDrawdown(tx, PROJECT, { kind: 'CONTINGENCY', amountVnd: (before - 299_999_999n).toString(), riskId: openRisk, reason: 'Again.' }, memberId(MAKER), everything)))).toMatchObject({ code: 'RESERVE_BALANCE_INSUFFICIENT' });

      const authorise = jest.fn(async () => undefined);
      expect(await refusal(as((tx) => reserves.decideDrawdown(tx, asked.id, 1, { decision: 'approve', reason: 'Own request.' }, memberId(MAKER), everything, authorise), MAKER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(as((tx) => reserves.decideDrawdown(tx, asked.id, 7, { decision: 'approve', reason: 'Stale.' }, memberId(APPROVER), everything, authorise), APPROVER))).toMatchObject({ code: 'VERSION_CONFLICT' });
      expect(await refusal(as((tx) => reserves.decideDrawdown(tx, asked.id, 1, { decision: 'maybe', reason: 'x' }, memberId(APPROVER), everything, authorise), APPROVER))).toMatchObject({ code: 'VALIDATION_FAILED' });
      const denied = await refusal(as((tx) => reserves.decideDrawdown(tx, asked.id, 1, { decision: 'approve', reason: 'No authority.' }, memberId(APPROVER), everything, async () => { throw Object.assign(new Error('SCOPE_DENIED'), { code: 'SCOPE_DENIED', status: 403 }); }), APPROVER));
      expect(denied).toMatchObject({ code: 'SCOPE_DENIED' });

      const approved = await as((tx) => reserves.decideDrawdown(tx, asked.id, 1, { decision: 'approve', reason: 'Confirmed by the supervisor.' }, memberId(APPROVER), everything, authorise), APPROVER);
      expect(authorise).toHaveBeenCalledWith({ kind: 'CONTINGENCY', amountVnd: '300000000', projectId: PROJECT });
      expect(approved).toMatchObject({ status: 'APPROVED', version: 2, balanceVnd: (before - 300_000_000n).toString() });
      const entry = (await owner<{ entry_kind: string; amount_vnd: string; balance_after_vnd: string; approved_by: string; requested_by: string; risk_id: string }>('select entry_kind, amount_vnd::text, balance_after_vnd::text, approved_by, requested_by, risk_id from machvon.reserve_ledger_entry where id = $1::uuid', [approved.ledgerEntryId]))[0];
      expect(entry).toMatchObject({ entry_kind: 'DRAWDOWN', amount_vnd: '300000000', balance_after_vnd: (before - 300_000_000n).toString(), approved_by: memberId(APPROVER), requested_by: memberId(MAKER), risk_id: openRisk });
      expect(await refusal(as((tx) => reserves.decideDrawdown(tx, asked.id, 2, { decision: 'approve', reason: 'Twice.' }, memberId(APPROVER), everything, authorise), APPROVER))).toMatchObject({ code: 'RESERVE_DRAWDOWN_STATE_INVALID', status: 409 });

      // A rejected request ends with its reason and moves nothing; the maker is not the checker in the database either.
      const second = await as((tx) => reserves.requestDrawdown(tx, PROJECT, { kind: 'CONTINGENCY', amountVnd: '1000', riskId: openRisk, reason: 'Small.' }, memberId(MAKER), everything));
      const rejected = await as((tx) => reserves.decideDrawdown(tx, second.id, 1, { decision: 'reject', reason: 'Not needed.' }, memberId(APPROVER), everything, authorise), APPROVER);
      expect(rejected).toMatchObject({ status: 'REJECTED', ledgerEntryId: null, balanceVnd: approved.balanceVnd });
      expect(await databaseRefusal(owner("update machvon.reserve_drawdown set decided_by = requested_by where id = $1::uuid", [second.id]))).toBeTruthy();
    });

    it('reads the contingency against the expected value of the open risks, says how many risks have no exposure yet, and the alert goes only below the cover', async () => {
      const a = await risk('R-EV-A');
      const b = await risk('R-EV-B');
      await as((tx) => reserves.setExposure(tx, a, { probabilityPct: '50', costImpactVnd: '2000000000' }, null, memberId(MAKER), everything));
      const set = await as((tx) => reserves.setExposure(tx, a, { probabilityPct: '50', costImpactVnd: '2000000000' }, 1, memberId(MAKER), everything));
      expect(set.version).toBe(2);
      expect(await refusal(as((tx) => reserves.setExposure(tx, a, { probabilityPct: '50', costImpactVnd: '1' }, 1, memberId(MAKER), everything)))).toMatchObject({ code: 'VERSION_CONFLICT' });
      expect(await refusal(as((tx) => reserves.setExposure(tx, a, { probabilityPct: '101', costImpactVnd: '1' }, null, memberId(MAKER), everything)))).toMatchObject({ code: 'VALIDATION_FAILED' });

      const view = await as((tx) => reserves.view(tx, PROJECT, everything, TODAY));
      expect(view?.funds.map((fund) => fund.kind)).toEqual(['CONTINGENCY', 'MGMT_RESERVE']);
      expect(view?.risks.find((line) => line.riskId === a)).toMatchObject({ probabilityPct: '50.00', costImpactVnd: '2000000000', expectedValueVnd: '1000000000' });
      // The risk with no exposure is counted, so the expected value is a lower bound and says so.
      expect(view?.risks.find((line) => line.riskId === b)).toMatchObject({ probabilityPct: null, expectedValueVnd: null });
      expect(view?.unassessedRiskCount).toBeGreaterThanOrEqual(1);
      expect(view?.policy).toMatchObject({ source: 'DEFAULT', version: null, coverAlertBelowPct: '100' });
      const balance = BigInt(view?.funds[0]?.balanceVnd ?? '0');
      const ev = BigInt(view?.expectedValueVnd ?? '0');
      expect(view?.contingencyCover?.covered).toBe(balance >= ev);
      expect(await as((tx) => reserves.view(tx, PROJECT, () => ({ sql: 'false', params: [] }), TODAY))).toBeUndefined();

      // Raise the exposure above the balance: the alert source names the project.
      await as((tx) => reserves.setExposure(tx, a, { probabilityPct: '100', costImpactVnd: (balance + 1_000_000_000n).toString() }, 2, memberId(MAKER), everything));
      const items = await as((tx) => new HomeMoneySources().reservesBelowRisk(moneyContext(tx)));
      expect(items.find((item) => item.id === `reserve:${PROJECT}`)).toMatchObject({ kind: 'RESERVE_BELOW_RISK_EV', severity: 'ACTION', status: 'BELOW', target: { screen: 'PRJ-22', id: PROJECT } });
      await as((tx) => reserves.setExposure(tx, a, { probabilityPct: '0', costImpactVnd: '1' }, 3, memberId(MAKER), everything));
      await as((tx) => reserves.setExposure(tx, b, { probabilityPct: '0', costImpactVnd: '1' }, null, memberId(MAKER), everything));
    });
  });

  describe('G1-8: the tiers of a change order', () => {
    it('classifies at the evaluation with the version of the rule, and the gate refuses an increase that has no source', async () => {
      const contract = await seedContract();
      const { co, evaluated } = await evaluatedCo(contract, '400000000');
      expect(evaluated).toMatchObject({ tier: 2, cumulativeVariationPct: '4.00', adjustmentCheckRaised: false });
      const row = (await owner<{ tier: number; cumulative_variation_pct: string; tier_rule_version: number | null; tier_rule_source: string }>('select tier, cumulative_variation_pct::text, tier_rule_version, tier_rule_source from machvon.change_request where id = $1::uuid', [co.id]))[0];
      expect(row).toMatchObject({ tier: 2, cumulative_variation_pct: '4.00', tier_rule_version: null, tier_rule_source: 'DEFAULT' });

      const refused = await refusal(decide(co, evaluated.version));
      expect(refused).toMatchObject({ code: 'CHANGE_FUNDING_REQUIRED', status: 422 });
      expect(refused.extensions).toMatchObject({ shortfall_vnd: '400000000', approved_drawdown_vnd: '0' });
      expect((await owner<{ status: string }>('select status from machvon.change_request where id = $1::uuid', [co.id]))[0]?.status).toBe('EVALUATED');
    });

    it('a drawdown approved for this change order pays the increase, and the DoA is asked for the larger of the change and the cumulative variation', async () => {
      const contract = await seedContract();
      const { co, evaluated } = await evaluatedCo(contract, '300000000');
      const asked = await as((tx) => reserves.requestDrawdown(tx, PROJECT, { kind: 'CONTINGENCY', amountVnd: '300000000', changeRequestId: co.id, reason: 'The change order is paid from the contingency.' }, memberId(MAKER), everything));
      await as((tx) => reserves.decideDrawdown(tx, asked.id, 1, { decision: 'approve', reason: 'Covered.' }, memberId(FUNDER), everything, async () => undefined), FUNDER);
      const view = await as((tx) => tiers.view(tx, co.id, everything, TODAY));
      expect(view).toMatchObject({ stage: 'CO', status: 'EVALUATED', approvedDrawdownVnd: '300000000', funding: { needsCover: true, covered: true, coveredBy: 'RESERVE' }, classification: { tier: 1 } });

      let authority = '';
      const done = await as(
        (tx) =>
          decisions.decide(tx, co.id, evaluated.version, { decision: 'approve', reason: 'Within the plan.', evidenceIds: [], effectiveOn: '2026-08-01', decisionDocumentVersionId: VERSION }, memberId(APPROVER), contractScopes, TODAY, {
            authorise: async (facts) => {
              authority = facts.amountVnd;
            },
            available: async () => undefined,
            gate: (facts) => tiers.gate(tx, facts, memberId(APPROVER), TODAY).then((outcome) => ({ authorityAmountVnd: outcome.classification.authorityAmountVnd })),
          }),
        APPROVER,
      );
      expect(done).toMatchObject({ status: 'APPROVED', approvedDeltaVnd: '300000000' });
      expect(authority).toBe('300000000');
      expect((await owner<{ tier: number }>('select tier from machvon.change_request where id = $1::uuid', [co.id]))[0]?.tier).toBe(1);

      // A second change order after this one: the cumulative variation (300m approved plus 200m) is what the authority is asked for.
      const next = await evaluatedCo(contract, '200000000');
      expect(next.evaluated).toMatchObject({ cumulativeVariationPct: '5.00', tier: 2 });
      const second = await as((tx) => reserves.requestDrawdown(tx, PROJECT, { kind: 'CONTINGENCY', amountVnd: '200000000', changeRequestId: next.co.id, reason: 'Second.' }, memberId(MAKER), everything));
      await as((tx) => reserves.decideDrawdown(tx, second.id, 1, { decision: 'approve', reason: 'Covered.' }, memberId(FUNDER), everything, async () => undefined), FUNDER);
      await as(
        (tx) =>
          decisions.decide(tx, next.co.id, next.evaluated.version, { decision: 'approve', reason: 'Within the plan.', evidenceIds: [], effectiveOn: '2026-09-01', decisionDocumentVersionId: VERSION }, memberId(APPROVER), contractScopes, TODAY, {
            authorise: async (facts) => {
              authority = facts.amountVnd;
            },
            available: async () => undefined,
            gate: (facts) => tiers.gate(tx, facts, memberId(APPROVER), TODAY).then((outcome) => ({ authorityAmountVnd: outcome.classification.authorityAmountVnd })),
          }),
        APPROVER,
      );
      expect(authority).toBe('500000000');
    });

    it('a cumulative variation at the threshold raises the check of the project adjustment and tells the audit; the approval waits for a clearing by someone outside the chain', async () => {
      const contract = await seedContract();
      const { co, evaluated } = await evaluatedCo(contract, '1100000000');
      expect(evaluated).toMatchObject({ tier: 3, cumulativeVariationPct: '11.00', adjustmentCheckRaised: true });
      const check = (await owner<{ status: string; cumulative_pct: string; threshold_pct: string; audit_notified_at: string | null }>('select status, cumulative_pct::text, threshold_pct::text, audit_notified_at::text from machvon.change_adjustment_check where change_request_id = $1::uuid', [co.id]))[0];
      expect(check).toMatchObject({ status: 'REQUIRED', cumulative_pct: '11.00', threshold_pct: '10.00' });
      expect(check?.audit_notified_at).not.toBeNull();

      const refused = await refusal(decide(co, evaluated.version));
      expect(refused).toMatchObject({ code: 'PROJECT_ADJUSTMENT_CHECK_REQUIRED', status: 422 });
      expect(refused.extensions).toMatchObject({ cumulative_pct: '11.00', threshold_pct: '10', check_status: 'REQUIRED', tier: 3 });

      const clear = (member: number, version = evaluated.version, document: string | null = VERSION) =>
        as((tx) => tiers.clear(tx, co.id, version, { basis: 'The investment decision was adjusted by the resolution.', decisionDocumentVersionId: document ?? undefined }, memberId(member), contractScopes, TODAY), member);
      expect(await refusal(clear(MAKER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
      expect(await refusal(clear(EVALUATOR))).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
      expect(await refusal(clear(DOCUMENT_MAKER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
      expect(await refusal(clear(CLEARER, 99))).toMatchObject({ code: 'VERSION_CONFLICT' });
      expect(await refusal(clear(CLEARER, evaluated.version, null))).toMatchObject({ code: 'DECISION_DOCUMENT_REQUIRED' });
      const cleared = await clear(CLEARER);
      expect(cleared).toMatchObject({ cumulativePct: '11.00', version: 2 });
      expect((await owner<{ status: string; cleared_by: string }>('select status, cleared_by from machvon.change_adjustment_check where change_request_id = $1::uuid', [co.id]))[0]).toMatchObject({ status: 'CLEARED', cleared_by: memberId(CLEARER) });

      // The adjustment is cleared and covers the increase as its source; the capital is still judged by the hook of CAP.
      const done = await decide(co, evaluated.version);
      expect(done).toMatchObject({ status: 'APPROVED', approvedDeltaVnd: '1100000000' });
    });

    it('a check that is not called for cannot be cleared, and a decrease needs no source', async () => {
      const contract = await seedContract();
      const small = await evaluatedCo(contract, '100000000');
      expect(await refusal(as((tx) => tiers.clear(tx, small.co.id, small.evaluated.version, { basis: 'Not needed.', decisionDocumentVersionId: VERSION }, memberId(CLEARER), contractScopes, TODAY), CLEARER))).toMatchObject({ code: 'ADJUSTMENT_CHECK_NOT_REQUIRED', status: 409 });
      const cut = await evaluatedCo(await seedContract(), '-200000000');
      expect(cut.evaluated).toMatchObject({ tier: 1 });
      expect(await decide(cut.co, cut.evaluated.version)).toMatchObject({ status: 'APPROVED', approvedDeltaVnd: '-200000000' });
      expect(await as((tx) => tiers.view(tx, randomUUID(), everything, TODAY))).toBeUndefined();
    });

    it('a policy the tenant approved is read through the port source and its version is kept on the request', async () => {
      const reader = new MoneyPolicyReader(async (_tx, type) =>
        type === 'CHANGE_ORDER_TIER'
          ? { version: 4, params: { bands: [{ tier: 1, maxAmountVnd: '1000000000', maxCumulativePct: '20' }, { tier: 2, maxAmountVnd: '2000000000', maxCumulativePct: '30' }], projectAdjustmentPct: '40', requireReserveCover: false } }
          : undefined,
      );
      const store = new CtrChangeTierStore(reader);
      const contract = await seedContract();
      const { co } = await evaluatedCo(contract, '1100000000', false);
      const outcome = await as((tx) => store.classify(tx, { changeId: co.id, contractId: contract.contractId, projectId: PROJECT, deltaVnd: '1100000000' }, memberId(EVALUATOR), TODAY));
      expect(outcome).toMatchObject({ classification: { tier: 2, forcesAdjustment: false }, policy: { version: 4, source: 'RULE', requireReserveCover: false }, funding: { needsCover: false } });
      expect((await owner<{ tier_rule_version: number; tier_rule_source: string }>('select tier_rule_version, tier_rule_source from machvon.change_request where id = $1::uuid', [co.id]))[0]).toMatchObject({ tier_rule_version: 4, tier_rule_source: 'RULE' });
      const broken = new MoneyPolicyReader(async () => ({ version: 5, params: { bands: [] } }));
      expect(await refusal(as((tx) => broken.get(tx, 'CHANGE_ORDER_TIER', TODAY)))).toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });

  describe('G1-6: the contract against its price and the estimate against the approved total', () => {
    it('shows the price in force, the pending increases, the capital line and each change order against it', async () => {
      const contract = await seedContract();
      await owner('update machvon.contract set accepted_total_vnd = 4000000000, requested_total_vnd = 4000000000, paid_total_vnd = 3000000000, advance_paid_vnd = 1000000000, advance_recovered_vnd = 400000000 where id = $1::uuid', [contract.contractId]);
      const pending = await evaluatedCo(contract, '700000000', false);
      const statement = await as((tx) => avc.contractStatement(tx, contract.contractId, everything, TODAY));
      expect(statement?.contract).toMatchObject({ id: contract.contractId, status: 'ACTIVE', projectId: PROJECT });
      expect(statement?.money).toMatchObject({
        currentPriceVnd: '10000000000',
        originalPriceVnd: '10000000000',
        approvedVariationVnd: '0',
        pendingIncreaseVnd: '700000000',
        remainingPayableVnd: '6000000000',
        advanceOutstandingVnd: '600000000',
        cashOutVnd: '3600000000',
        withinPrice: true,
        requestedPct: '40.00',
      });
      expect(statement?.line).toMatchObject({ allocationLineId: LINE });
      expect(statement?.changeOrders).toHaveLength(1);
      expect(statement?.changeOrders[0]).toMatchObject({ id: pending.co.id, deltaVnd: '700000000', allocationLineId: LINE });
      expect(await as((tx) => avc.contractStatement(tx, contract.contractId, () => ({ sql: 'false', params: [] }), TODAY))).toBeUndefined();
      expect(await refusal(as((tx) => avc.contractStatement(tx, 'not-an-id', everything, TODAY)))).toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('the estimate at completion above the approved total investment is OVER and raises the URGENT alert; the database still refuses a payment above the price', async () => {
      await owner('update machvon.project set total_investment_vnd = 1000 where id = $1::uuid', [PROJECT]);
      await seedContract();
      const statement = await as((tx) => avc.eacStatement(tx, PROJECT, everything, TODAY));
      expect(statement).toMatchObject({ projectId: PROJECT, method: 'CONTRACT_PRICES_PLUS_PENDING', control: { verdict: 'OVER', raisesAlert: true }, policy: { source: 'DEFAULT', eacAlertAbovePct: '0' } });
      expect(BigInt(statement?.control.overByVnd ?? '0')).toBeGreaterThan(0n);
      expect(BigInt(statement?.fundingGapVnd ?? '0')).toBeGreaterThanOrEqual(0n);
      const items = await as((tx) => new HomeMoneySources().eacExceeds(moneyContext(tx)));
      expect(items.find((item) => item.id === `eac:${PROJECT}`)).toMatchObject({ kind: 'EAC_EXCEEDS_TMDT', severity: 'URGENT', target: { screen: 'CAP-22', id: PROJECT }, consequence: expect.stringContaining('tổng mức') });
      await owner('update machvon.project set total_investment_vnd = 500000000000000 where id = $1::uuid', [PROJECT]);
      expect((await as((tx) => new HomeMoneySources().eacExceeds(moneyContext(tx)))).some((item) => item.id === `eac:${PROJECT}`)).toBe(false);
      expect((await as((tx) => avc.eacStatement(tx, PROJECT, everything, TODAY)))?.control.verdict).toBe('WITHIN');
      expect(await as((tx) => avc.eacStatement(tx, PROJECT, () => ({ sql: 'false', params: [] }), TODAY))).toBeUndefined();
      expect(await databaseRefusal(owner('update machvon.contract set paid_total_vnd = contract_value_vnd + 1 where id = (select id from machvon.contract where project_id = $1::uuid limit 1)', [PROJECT]))).toBeTruthy();
    });
  });

  describe('G1-11: the advance against what is left to pay', () => {
    async function advance(contractId: string, paid: string, recovered: string): Promise<string> {
      const partyId = randomUUID();
      const advanceId = randomUUID();
      await seedAs(harness, [
        [`insert into machvon.contract_party (tenant_id, id, contract_id, contractor_id, role, share_pct, work_value_vnd, status, valid_from, created_by, updated_by) values ($1, $2, $3, $4, 'LEAD', 100, 10000000000, 'ACTIVE', date '2026-01-02', $5, $5)`, [TENANT_A, partyId, contractId, CONTRACTOR, memberId(MAKER)]],
        [
          `insert into machvon.contract_advance (tenant_id, id, contract_id, party_id, tranche_no, kind, amount_vnd, cap_vnd, status, paid_vnd, recovered_vnd, paid_on, recovery_deadline, recovery_threshold_pct, created_by, updated_by)
           values ($1, $2, $3, $4, 1, 'GPMB', $5::numeric, $5::numeric, $6, $5::numeric, $7::numeric, date '2026-03-01', date '2026-04-01', 80, $8, $8)`,
          [TENANT_A, advanceId, contractId, partyId, paid, BigInt(recovered) === 0n ? 'PAID' : BigInt(recovered) === BigInt(paid) ? 'FULLY_RECOVERED' : 'RECOVERING', recovered, memberId(MAKER)],
        ],
        [`update machvon.contract set advance_paid_vnd = $2::numeric, advance_recovered_vnd = $3::numeric where id = $1::uuid`, [contractId, paid, recovered]],
      ]);
      return advanceId;
    }

    it('flags an advance the payments left cannot recover, shows the table, and keeps the policy as data in force on a day', async () => {
      const contract = await seedContract();
      await owner('update machvon.contract set accepted_total_vnd = 9800000000, requested_total_vnd = 9800000000 where id = $1::uuid', [contract.contractId]);
      const advanceId = await advance(contract.contractId, '500000000', '100000000');
      const position = await as((tx) => advances.positionOfContract(tx, contract.contractId, everything, TODAY));
      expect(position).toMatchObject({ outstandingVnd: '400000000', remainingPayableVnd: '200000000', exceedsRemaining: true, unrecoverableVnd: '200000000', finalPaymentRequiresFullRecovery: true, policy: { source: 'DEFAULT', toleranceVnd: '0' } });
      const items = await as((tx) => new HomeMoneySources().advancesExceedRemaining(moneyContext(tx)));
      expect(items.find((item) => item.id === `advance:${contract.contractId}`)).toMatchObject({ kind: 'ADVANCE_EXCEEDS_REMAINING', severity: 'URGENT', target: { screen: 'PAY-18', id: contract.contractId } });

      const table = await as((tx) => advances.table(tx, advanceId, everything, TODAY));
      expect(table?.advance).toMatchObject({ id: advanceId, outstandingVnd: '400000000' });
      expect(table?.rows.map((row) => row.kind)).toContain('PLANNED');
      expect(table?.position.contractId).toBe(contract.contractId);
      expect(await as((tx) => advances.table(tx, advanceId, () => ({ sql: 'false', params: [] }), TODAY))).toBeUndefined();

      // Enough left to pay: the alert goes.
      await owner('update machvon.contract set requested_total_vnd = 1000000000 where id = $1::uuid', [contract.contractId]);
      expect((await as((tx) => new HomeMoneySources().advancesExceedRemaining(moneyContext(tx)))).some((item) => item.id === `advance:${contract.contractId}`)).toBe(false);

      // The policy as data: a version of the cap with its days, its basis and whether it still waits for confirmation.
      const recordId = randomUUID();
      await harness.owner(TENANT_A, [
        [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'PAY_ADVANCE_CAP', $3, 'EFFECTIVE', $4, $4)`, [TENANT_A, recordId, `CONSTRUCTION-${randomUUID().slice(0, 6)}`, memberId(MAKER)]],
        [
          `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, status, master_record_id, published_at, legal_basis, created_by, updated_by)
           values ($1, gen_random_uuid(), 'PAY_ADVANCE_CAP', 'CAP', 1, 'Cap', $2::jsonb, '2026-01-01', 'EFFECTIVE', $3, now(), 'Decree 254/2025 (to be confirmed)', $4, $4)`,
          [TENANT_A, JSON.stringify({ tiers: [{ min_value_vnd: '0', cap_pct: '20' }], recovery_threshold_pct: '80', awaiting_confirmation: true, cxn: 'CXN-31' }), recordId, memberId(MAKER)],
        ],
      ]);
      const policy = await as((tx) => advances.policy(tx, TODAY));
      const mine = policy.find((version) => version.legalBasis.startsWith('Decree 254/2025'));
      expect(mine).toMatchObject({ inForce: true, awaitingConfirmation: true, cxn: 'CXN-31', recoveryThresholdPct: '80', tiers: [{ minValueVnd: '0', capPct: '20' }] });
      expect((await as((tx) => advances.policy(tx, '2025-01-01'))).find((version) => version.versionId === mine?.versionId)?.inForce).toBe(false);
    });

    it('a final payment is refused while an advance of the contract is still owed, and goes when it is recovered or the policy does not ask', async () => {
      const contract = await seedContract();
      await advance(contract.contractId, '500000000', '100000000');
      expect(await refusal(as((tx) => advances.assertFinalPaymentClears(tx, contract.contractId, TODAY)))).toMatchObject({ code: 'FINAL_PAYMENT_ADVANCE_OUTSTANDING', status: 422, extensions: { outstanding_after_vnd: '400000000' } });
      const lenient = new PayAdvanceRecoveryReads(new MoneyPolicyReader(async (_tx, type) => (type === 'ADVANCE_RECOVERY' ? { version: 2, params: { finalPaymentRequiresFullRecovery: false, toleranceVnd: '0' } } : undefined)));
      await expect(as((tx) => lenient.assertFinalPaymentClears(tx, contract.contractId, TODAY))).resolves.toBeUndefined();
      await owner("update machvon.contract_advance set recovered_vnd = paid_vnd, status = 'FULLY_RECOVERED' where contract_id = $1::uuid", [contract.contractId]);
      await expect(as((tx) => advances.assertFinalPaymentClears(tx, contract.contractId, TODAY))).resolves.toBeUndefined();
    });
  });
});
