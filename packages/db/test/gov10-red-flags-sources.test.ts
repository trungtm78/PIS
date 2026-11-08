import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { HomeWorkStore } from '../src/home-work-store';
import { RedFlagStore } from '../src/red-flag-store';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const flags = new RedFlagStore();
const work = new HomeWorkStore();

const ROOT = 1;
const AUDITOR = 1;
const DRAFTER = 2;
const SECOND = 3;
const NOW = new Date('2027-10-15T03:00:00Z');
const TODAY = '2027-10-15';
const PROJECT = randomUUID();
const FIRST = randomUUID();
const CLEAN = randomUUID();
const everything = () => ({ sql: 'true', params: [] as unknown[] });

const as = <T>(work_: (tx: Parameters<Parameters<typeof harness.tenants.withTenant>[1]>[0]) => Promise<T>, tenant = TENANT_A, member = AUDITOR): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work_);

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

const packageRow = (id: string, code: string, created: number): [string, unknown[]] => [
  `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, title, created_by)
   values ($1, $2, $3, $4, 900000000, 'OPEN_BIDDING', 1, 'APPROVED', 'Package', $5)`,
  [TENANT_A, id, PROJECT, code, memberId(created)],
];
const milestone = (packageId: string, kind: string, at: string): [string, unknown[]] => [
  `insert into machvon.procurement_milestone (tenant_id, id, package_id, milestone_kind, actual_at, source, created_by, updated_by, version) values ($1, $2, $3, $4, $5::timestamptz, 'MANUAL', $6, $6, 1)`,
  [TENANT_A, randomUUID(), packageId, kind, at, memberId(AUDITOR)],
];
const proposal = (packageId: string, price: string): [string, unknown[]] => [
  `insert into machvon.proposal (tenant_id, id, project_id, package_id, contractor_id, document_version_ids, revision, status, submitted_at, access_released_at, bid_price_vnd, created_by)
   values ($1, $2, $3, $4, $5, '[]'::jsonb, 1, 'RECEIVED', '2027-09-05T01:00:00Z', '2027-09-07T01:00:00Z', $6, $7)`,
  [TENANT_A, randomUUID(), PROJECT, packageId, randomUUID(), price, memberId(AUDITOR)],
];

/** The red flags of procurement and the four new sources of the alert centre (lane GOV-10). */
describe('red flags and the new alert sources', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
      for (const member of [AUDITOR, DRAFTER, SECOND]) await harness.seedMembership(tenant, member, ROOT);
    }
    await admin([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, 'PRJ-RF-1', 'Bridge', $3, $4, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, PROJECT, unitId(ROOT), randomUUID()],
      ],
      packageRow(FIRST, 'GT-RF-1', DRAFTER),
      milestone(FIRST, 'INVITATION_PUBLISHED', '2027-09-01T01:00:00Z'),
      milestone(FIRST, 'BID_CLOSING', '2027-09-06T01:00:00Z'),
      proposal(FIRST, '800000000'),
      packageRow(CLEAN, 'GT-RF-2', DRAFTER),
      milestone(CLEAN, 'INVITATION_PUBLISHED', '2027-09-01T01:00:00Z'),
      milestone(CLEAN, 'BID_CLOSING', '2027-09-21T01:00:00Z'),
      proposal(CLEAN, '800000000'),
      proposal(CLEAN, '810000000'),
      proposal(CLEAN, '820000000'),
    ]);
  }, 300_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('red flags (G4-3)', () => {
    it('scans every approved package, writes a finding for the one with signals, and records the scan once', async () => {
      const scan = await as((tx) => flags.scan(tx, NOW, 'slot:test-1', TODAY));
      expect(scan).toMatchObject({ created: true, subjects: 2, flagged: 1 });
      expect((await as((tx) => flags.scan(tx, NOW, 'slot:test-1', TODAY))).created).toBe(false);
      const [finding] = await as((tx) => flags.list(tx, memberId(AUDITOR), { limit: 10, offset: 0 }));
      const found = finding as NonNullable<typeof finding>;
      expect(found).toMatchObject({ subjectCode: 'GT-RF-1', score: 5, band: 'MEDIUM', status: 'NEW', version: 1 });
      expect(found.fired.map((entry) => entry.code).sort()).toEqual(['SHORT_TENDER_PERIOD', 'SINGLE_BIDDER']);
      // The indicators that need the contract or the award say so: they are not "clear".
      expect(found.notComputable).toEqual(expect.arrayContaining(['AWARD_VS_FINAL_PRICE_GAP', 'CONTRACT_AMENDED']));
      expect(found.ruleVersions).toMatchObject({ SINGLE_BIDDER: 0 });
      expect(found.rankingVersion).toBe('builtin');
      // A scan of another slot changes nothing but the count of evaluations.
      expect((await as((tx) => flags.scan(tx, NOW, 'slot:test-2', TODAY))).rescored).toBe(0);
      expect((await as((tx) => flags.findOne(tx, memberId(AUDITOR), found.id)))?.evaluationCount).toBe(2);
      expect((await as((tx) => flags.summary(tx, memberId(AUDITOR)))).lastScan).toMatchObject({ status: 'FINISHED', subjects: 2 });
    });

    it('is hidden from the person who drafted the package: no list, no count, no detail', async () => {
      expect(await as((tx) => flags.list(tx, memberId(DRAFTER), { limit: 10, offset: 0 }), TENANT_A, DRAFTER)).toEqual([]);
      expect((await as((tx) => flags.summary(tx, memberId(DRAFTER)), TENANT_A, DRAFTER)).total).toBe(0);
      const [finding] = await as((tx) => flags.list(tx, memberId(AUDITOR), { limit: 10, offset: 0 }));
      expect(await as((tx) => flags.findOne(tx, memberId(DRAFTER), (finding as NonNullable<typeof finding>).id), TENANT_A, DRAFTER)).toBeUndefined();
      await expect(as((tx) => flags.move(tx, (finding as NonNullable<typeof finding>).id, 1, 'TAKE', memberId(DRAFTER), undefined, NOW), TENANT_A, DRAFTER)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      expect(await as((tx) => flags.list(tx, memberId(AUDITOR), { limit: 10, offset: 0 }), TENANT_B)).toEqual([]);
    });

    it('is reviewed in two steps: clearing needs a second auditor, and a new signal reopens a cleared finding', async () => {
      const [finding] = await as((tx) => flags.list(tx, memberId(AUDITOR), { limit: 10, offset: 0 }));
      const id = (finding as NonNullable<typeof finding>).id;
      const taken = await as((tx) => flags.move(tx, id, 1, 'TAKE', memberId(AUDITOR), undefined, NOW));
      expect(taken).toMatchObject({ status: 'IN_REVIEW', reviewerId: memberId(AUDITOR), version: 2 });
      await expect(as((tx) => flags.move(tx, id, 1, 'PROPOSE_CLEAR', memberId(AUDITOR), 'The single bid is justified', NOW))).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      await expect(as((tx) => flags.move(tx, id, 2, 'PROPOSE_CLEAR', memberId(AUDITOR), 'ok', NOW))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await as((tx) => flags.move(tx, id, 2, 'PROPOSE_CLEAR', memberId(AUDITOR), 'The single bid is justified by the market', NOW));
      await expect(as((tx) => flags.move(tx, id, 3, 'CONFIRM_CLEAR', memberId(AUDITOR), undefined, NOW))).rejects.toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
      const cleared = await as((tx) => flags.move(tx, id, 3, 'CONFIRM_CLEAR', memberId(SECOND), undefined, NOW), TENANT_A, SECOND);
      expect(cleared).toMatchObject({ status: 'CLEARED', clearedBy: memberId(SECOND), clearProposedBy: memberId(AUDITOR) });
      await expect(as((tx) => flags.move(tx, id, cleared.version, 'TAKE', memberId(AUDITOR), undefined, NOW))).rejects.toMatchObject({ code: 'RED_FLAG_STATE_INVALID' });
      // The same signals again do not reopen it; a second bid with the same price fires another indicator and does.
      expect((await as((tx) => flags.scan(tx, NOW, 'slot:test-3', TODAY))).reopened).toBe(0);
      await admin([proposal(FIRST, '800000000')]);
      const reopened = await as((tx) => flags.scan(tx, NOW, 'slot:test-4', TODAY));
      expect(reopened.reopened).toBe(1);
      const after = await as((tx) => flags.findOne(tx, memberId(AUDITOR), id));
      expect(after).toMatchObject({ status: 'NEW', reopenedCount: 1, clearedBy: null });
      expect(after?.fired.map((entry) => entry.code)).toEqual(expect.arrayContaining(['IDENTICAL_BID_PRICES']));
      const history = await as((tx) => flags.reviews(tx, id));
      expect(history.map((entry) => entry.move)).toEqual(['FLAGGED', 'TAKE', 'PROPOSE_CLEAR', 'CONFIRM_CLEAR', 'RESCORED', 'REOPENED']);
    });

    it('shows the registry of indicators with formula, source, day and an unconfirmed status', async () => {
      const registry = await as((tx) => flags.registry(tx, TODAY));
      expect(registry.filter((entry) => !entry.vendorSide)).toHaveLength(12);
      expect(registry.find((entry) => entry.code === 'SINGLE_BIDDER')).toMatchObject({ ocpId: 'R018', unverified: true, legalStatus: 'UNVERIFIED', enabled: true });
    });

    it('gives the alert centre a red flag to the auditors only, never to the person who took part', async () => {
      const ofReader = async (member: number, holds: boolean) => {
        const collected = await as(
          (tx) => work.collect(tx, { membershipId: memberId(member), now: NOW, today: TODAY, view: 'mine', unitScope: everything, projectScope: everything, mode: 'count', holds: () => holds }),
          TENANT_A,
          member,
        );
        return collected.rows.filter((row) => row.source === 'RED_FLAG');
      };
      expect((await ofReader(AUDITOR, true)).map((row) => [row.kind, row.severity])).toEqual([['RED_FLAG_NEW', 'ACTION']]);
      expect(await ofReader(DRAFTER, true)).toEqual([]);
      expect(await ofReader(AUDITOR, false)).toEqual([]);
    });
  });

  describe('the new alert sources (G2-12)', () => {
    const collect = async (member = AUDITOR, holds = true, view: 'mine' | 'scope' = 'mine') =>
      (await as((tx) => work.collect(tx, { membershipId: memberId(member), now: NOW, today: TODAY, view, unitScope: everything, projectScope: everything, mode: 'count', holds: () => holds }), TENANT_A, member)).rows;

    it('reads a dataset that is not fresh as an alert for its owner, never as "no work"', async () => {
      const dataset = randomUUID();
      const contract = randomUUID();
      await admin([
        [
          `insert into machvon.dataset (tenant_id, id, dataset_code, title, domain, grain, producer_module, owner_user_id, steward_user_id, classification, is_critical, freshness_slo_seconds, status, created_by, updated_by)
           values ($1, $2, 'DS-STALE', 'Stale', 'finance', 'row', 'PAY', $3, $4, 'INTERNAL', false, 3600, 'ACTIVE', $3, $3)`,
          [TENANT_A, dataset, memberId(DRAFTER), memberId(SECOND)],
        ],
        [
          `insert into machvon.quality_run (tenant_id, id, dataset_contract_id, snapshot_id, rule_version_ids, passed_count, failed_count, quarantined_count, started_at, finished_at, dataset_id, trigger, status, overall_result, score)
           values ($1, $2, $3, $4, '[]'::jsonb, 1, 0, 0, now() - interval '48 hours', now() - interval '48 hours', $5, 'MANUAL', 'COMPLETED', 'PASSED', 90)`,
          [TENANT_A, randomUUID(), contract, randomUUID(), dataset],
        ],
      ]);
      const mine = (await collect(DRAFTER, false)).filter((row) => row.source === 'DATA_FRESHNESS');
      expect(mine.map((row) => [row.kind, row.severity, row.id])).toEqual([['DATA_STALE', 'ACTION', dataset]]);
      // Somebody who owns nothing and is not the data steward does not get it.
      expect((await collect(AUDITOR, false)).filter((row) => row.source === 'DATA_FRESHNESS')).toEqual([]);
      expect((await collect(AUDITOR, true)).filter((row) => row.source === 'DATA_FRESHNESS')).toHaveLength(1);
    });

    it('reads a document that waits for review past its day, for the signer', async () => {
      const document = randomUUID();
      const outgoing = randomUUID();
      await admin([
        [`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'OUTGOING', 'QD', 'Decision on the bridge', 'INTERNAL', $3, $3)`, [TENANT_A, document, memberId(DRAFTER)]],
        [
          `insert into machvon.outgoing_document (tenant_id, id, document_id, layout_profile_id, status, drafting_unit_id, drafter_user_id, signer_user_id, review_due_on, created_by, updated_by)
           values ($1, $2, $3, $4, 'IN_REVIEW', $5, $6, $7, '2027-10-13', $6, $6)`,
          [TENANT_A, outgoing, document, randomUUID(), unitId(ROOT), memberId(DRAFTER), memberId(SECOND)],
        ],
      ]);
      const signer = (await collect(SECOND, false)).filter((row) => row.source === 'DOC_REVIEW');
      expect(signer.map((row) => [row.kind, row.severity, row.dueOn, row.status])).toEqual([['DOC_REVIEW_OVERDUE', 'ACTION', '2027-10-13', 'IN_REVIEW']]);
      expect(signer[0]?.target).toEqual({ screen: 'DOC-02', id: outgoing });
    });

    it('reads an advance paid while an earlier one is open as an anomaly for the auditors, with the rule able to switch it off', async () => {
      const contract = randomUUID();
      await admin([
        [`insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version) values ($1, $2, $3, $4, $5, 'HD-AN-1', 'LUMP_SUM', 'VND', 'ACTIVE', 1)`, [TENANT_A, contract, PROJECT, FIRST, randomUUID()]],
        [
          `insert into machvon.contract_advance (tenant_id, id, contract_id, party_id, tranche_no, kind, amount_vnd, cap_vnd, status, paid_vnd, recovered_vnd, paid_on, recovery_deadline, recovery_threshold_pct, created_by, updated_by)
           values ($1, $2, $3, $4, 1, 'GPMB', 100, 1000, 'PAID', 100, 10, '2027-08-01', '2027-12-01', 80, $5, $5), ($1, $6, $3, $4, 2, 'GPMB', 100, 1000, 'PAID', 100, 0, '2027-10-01', '2028-01-01', 80, $5, $5)`,
          [TENANT_A, randomUUID(), contract, randomUUID(), memberId(AUDITOR), randomUUID()],
        ],
      ]);
      const anomalies = (await collect(AUDITOR, true)).filter((row) => row.source === 'ANOMALY');
      expect(anomalies.map((row) => [row.kind, row.severity, row.title.includes('HD-AN-1')])).toEqual([['ANOMALY_SIGNAL', 'ACTION', true]]);
      // A reader who is not an auditor sees none of it.
      expect((await collect(DRAFTER, false)).filter((row) => row.source === 'ANOMALY')).toEqual([]);
      // The tenant turns the rule off with an approved version: the anomaly goes.
      await admin([
        [
          `insert into machvon.governance_rule (tenant_id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at)
           values ($1, 'ANOMALY_RULE', 'ADVANCE_WHILE_OPEN', 2, 'APPROVED', $2::jsonb, '2027-10-01', 'Off for the test', $3, $3, now(), $4, now())`,
          [TENANT_A, JSON.stringify({ indicator: 'Advance while open', min_amount_vnd: '1', severity: 'ACTION', enabled: false }), memberId(AUDITOR), memberId(SECOND)],
        ],
      ]);
      expect((await collect(AUDITOR, true)).filter((row) => row.source === 'ANOMALY')).toEqual([]);
    });

    it('reads the end of a running contract and an accepted quantity nobody asked payment for', async () => {
      const contract = randomUUID();
      await admin([
        [
          `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, completion_due)
           values ($1, $2, $3, $4, $5, 'HD-CK-1', 'LUMP_SUM', 'VND', 'ACTIVE', 1, '2027-10-20')`,
          [TENANT_A, contract, PROJECT, CLEAN, randomUUID()],
        ],
      ]);
      const rows = (await collect(AUDITOR, true, 'scope')).filter((row) => row.source === 'CONTRACT_CLOCK' && row.title.includes('HD-CK-1'));
      expect(rows.map((row) => [row.kind, row.severity, row.dueOn])).toEqual([['CONTRACT_END_NEAR', 'URGENT', '2027-10-20']]);
    });
  });
});
