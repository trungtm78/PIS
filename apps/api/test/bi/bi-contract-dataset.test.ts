import { randomUUID } from 'node:crypto';
import { BiDatasetStore, CtrFactStore, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import type { TenantTx } from '@machvon/db';
import { concentrationOf } from '@machvon/kernel';
import { ANALYST_ALL, BUILDER, BiApp, PIPELINE, TENANT_A, UNIT_A, UNIT_B, memberId, roleId, unitId } from './bi-app';
import type { Reply } from './bi-app';

jest.setTimeout(240_000);

/**
 * CA-1, part 2 on the BI side: the contract fact is frozen with a period, the dataset DS-CTR is made from it and the engine reads it like any other: one line per contract per ACTIVE party, the money of a joint venture
 * attributed to its parties by the largest remainder, so that every sum is whole dong and the groups of any dimension add up to the total. Concentration is recomputed from the raw contracts (R16): the second stage reads the
 * groups of the first, it is not the sum of the rows.
 */

const app = new BiApp();
const field = (name: string) => ({ op: 'field', name });
const sum = (name: string) => ({ op: 'sum', args: [field(name)] });
const num = (value: number) => ({ op: 'const', value });
const METRICS = [
  { code: 'ctr_value', grain: 'contract', aggregation_type: 'additive', expression: sum('CONTRACT_VALUE'), unit: 'VND', effective_from: '2026-01-01' },
  { code: 'ctr_paid_rate', grain: 'contract', aggregation_type: 'ratio', numerator: sum('PAID'), denominator: sum('ACCEPTED'), unit: 'percent', effective_from: '2026-01-01' },
  {
    code: 'ctr_hhi_active',
    grain: 'contract',
    aggregation_type: 'ratio',
    numerator: { op: 'mul', args: [num(100), { op: 'sum_of_squares', args: [sum('ACTIVE_VALUE')] }] },
    denominator: { op: 'mul', args: [sum('ACTIVE_VALUE'), sum('ACTIVE_VALUE')] },
    unit: 'index',
    effective_from: '2026-01-01',
  },
  { code: 'ctr_top1_share', grain: 'contract', aggregation_type: 'ratio', numerator: { op: 'top_n_sum', args: [sum('ACTIVE_VALUE'), num(1)] }, denominator: sum('ACTIVE_VALUE'), unit: 'percent', effective_from: '2026-01-01' },
  { code: 'ctr_single_bidder', grain: 'contract', aggregation_type: 'ratio', numerator: sum('SINGLE_BIDDER'), denominator: sum('BIDDER_KNOWN'), unit: 'percent', effective_from: '2026-01-01' },
];
const metricIds: Record<string, string> = {};
const BILLION = 1_000_000_000;
let datasetId = '';
let versionId = '';
let periodSnapshotId = '';
const contractors: string[] = [randomUUID(), randomUUID(), randomUUID()];

const query = (body: Record<string, unknown>, member = ANALYST_ALL): Promise<Reply> => app.call('POST', '/dashboard-queries', { member, body: { filters: [], dimensions: [], ...body } });
const rows = (reply: Reply): Array<Record<string, unknown>> => reply.json.children as Array<Record<string, unknown>>;
const total = (reply: Reply): Record<string, unknown> => reply.json.total as Record<string, unknown>;

describe('CA-1 part 2: the dataset DS-CTR over the contract fact frozen with a period', () => {
  beforeAll(async () => {
    await app.start();
    const { key, sha256 } = await app.bundle(METRICS);
    expect((await app.call('POST', '/bi/metric-registry-syncs', { member: PIPELINE, body: { source_commit: 'ctr-ds1', bundle_object_key: key, bundle_sha256: sha256 } })).status).toBe(200);
    const listed = await app.call('GET', '/resources/metric_definition', { member: PIPELINE });
    for (const item of listed.json.items as Array<{ id: string; code: string }>) metricIds[item.code] = item.id;

    // A period with a frozen close snapshot of DIS, and the contracts the fact is made of.
    const periodId = randomUUID();
    periodSnapshotId = randomUUID();
    const statements: Array<[string, unknown[]]> = [
      [
        `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
         values ($1, $2, '2032-01', 1, date '2032-01-01', date '2032-01-31', now(), 'DEFAULT', 'MONTH', 2032, 'OPEN', $3, $4, $4)`,
        [TENANT_A, periodId, randomUUID(), WORKER_MEMBERSHIP_ID],
      ],
      [
        `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, payload_sha256, frozen_by, frozen_at, created_by, updated_by)
         values ($1, $2, $3, 'PERIOD_CLOSE', now(), date '2032-01-31', date '2032-01-31', 'FROZEN', 'DIS-METRICS-R1', 'SIGNED', 0, $4, $5::uuid, now(), $5::uuid, $5::uuid)`,
        [TENANT_A, periodSnapshotId, periodId, 'e'.repeat(64), WORKER_MEMBERSHIP_ID],
      ],
    ];
    contractors.forEach((contractor, index) =>
      statements.push([
        `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id) values ($1, $2, $3, $4, 'VERIFIED', $5)`,
        [TENANT_A, contractor, `20000000${index}1`, `Contractor ${index + 1}`, randomUUID()],
      ]),
    );
    const projectA = randomUUID();
    const projectB = randomUUID();
    for (const [project, unit] of [[projectA, UNIT_A], [projectB, UNIT_B]] as const) {
      statements.push([
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, $3, $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, project, `CTRP-${unit}`, unitId(unit), randomUUID()],
      ]);
    }
    const contract = (code: string, project: string, contractor: string, status: string, value: number, accepted: number, paid: number, bidders: number | null, parties?: Array<[string, string, string]>): void => {
      const contractId = randomUUID();
      const packageId = randomUUID();
      statements.push([
        `insert into machvon.contract
           (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd, created_by, updated_by,
            signed_on, effective_from, completion_due, requested_total_vnd, accepted_total_vnd, paid_total_vnd)
         values ($1, $2, $3, $4, $5, $6, 'LUMP_SUM', 'VND', $7, 1, $6, 'CONSTRUCTION', $8, true, $9, $10, $10, date '2031-01-01', date '2031-01-02', date '2033-01-01', $11, $11, $12)`,
        [TENANT_A, contractId, project, packageId, contractor, code, status, parties !== undefined, value, WORKER_MEMBERSHIP_ID, accepted, paid],
      ]);
      for (let bidder = 0; bidder < (bidders ?? 0); bidder += 1) {
        statements.push([
          `insert into machvon.proposal (tenant_id, id, project_id, package_id, contractor_id, document_version_ids, revision, status, bid_price_vnd, submitted_at, access_released_at, created_by)
           values ($1, $2, $3, $4, $5, '[]'::jsonb, 1, 'RECEIVED', $6, now(), now(), $7)`,
          [TENANT_A, randomUUID(), project, packageId, contractors[(contractors.indexOf(contractor) + bidder) % contractors.length], value, WORKER_MEMBERSHIP_ID],
        ]);
      }
      for (const [partyContractor, share, role] of parties ?? []) {
        statements.push([
          `insert into machvon.contract_party (tenant_id, id, contract_id, contractor_id, role, share_pct, work_value_vnd, status, valid_from, created_by, updated_by)
           values ($1, $2, $3, $4, $5, $6::numeric, 0, 'ACTIVE', date '2031-01-02', $7, $7)`,
          [TENANT_A, randomUUID(), contractId, partyContractor, role, share, WORKER_MEMBERSHIP_ID],
        ]);
      }
    };
    const [a, b, c] = contractors as [string, string, string];
    contract('HD-1', projectA, a, 'ACTIVE', 600 * BILLION, 300 * BILLION, 270 * BILLION, 1);
    contract('HD-2', projectA, b, 'ACTIVE', 300 * BILLION, 200 * BILLION, 100 * BILLION, 3);
    // a joint venture of A and C, a third each... no: half and half, and one that is not active
    contract('HD-3', projectB, a, 'ACTIVE', 100 * BILLION + 1, 50 * BILLION, 10 * BILLION, 2, [[a, '50.0000', 'LEAD'], [c, '50.0000', 'MEMBER']]);
    contract('HD-4', projectB, c, 'DRAFT', 999 * BILLION, 0, 0, null);
    await app.seedReplica(statements);

    // The fact is frozen with the period and the dataset is made from it, as the consumer of the event does.
    await app.harness.tenants.withTenant(app.contextOf(BUILDER), async (tx: TenantTx) => {
      const built = await new CtrFactStore().buildFor(tx, periodSnapshotId, WORKER_MEMBERSHIP_ID);
      expect(built.snapshot).toMatchObject({ revision: 1, contractCount: 4, rowCount: 5 });
      const datasets = new BiDatasetStore();
      datasetId = await datasets.ensureContractDataset(tx, memberId(BUILDER));
      const made = await datasets.build(tx, { datasetId, sourceSnapshotId: periodSnapshotId, asOfPeriod: undefined, actor: memberId(BUILDER) });
      expect(made).toMatchObject({ outcome: 'BUILT', version: { asOfPeriod: '2032-01', rowCount: 5, qualityBadge: 'NOT_ASSESSED', sourceSnapshotId: periodSnapshotId } });
      versionId = made.version.id;
      // the same period again is the same content
      expect((await datasets.build(tx, { datasetId, sourceSnapshotId: periodSnapshotId, asOfPeriod: undefined, actor: memberId(BUILDER) })).outcome).toBe('UNCHANGED');
    });
    await app.seedReplica([
      [
        `insert into machvon.bi_access_policy (tenant_id, id, dataset_id, revision, grantee_kind, grantee_ref_id, row_predicate_ast, column_masks, status, approved_by, created_by, updated_by)
         values ($1, $2, $3, 1, 'ROLE', $4, '{"op":"unit_in_scope"}'::jsonb, '{}'::jsonb, 'ACTIVE', $5, $6, $5)`,
        [TENANT_A, randomUUID(), datasetId, roleId(9), memberId(BUILDER), memberId(PIPELINE)],
      ],
    ]);
  }, 300_000);
  afterAll(() => app.stop(), 60_000);

  const ACTIVE = [
    { contractId: 'a', status: 'ACTIVE', valueVnd: String(600 * BILLION), investorKey: null, unitKey: null, fundKey: null, contractorId: contractors[0] as string },
    { contractId: 'b', status: 'ACTIVE', valueVnd: String(300 * BILLION), investorKey: null, unitKey: null, fundKey: null, contractorId: contractors[1] as string },
    {
      contractId: 'c',
      status: 'ACTIVE',
      valueVnd: String(100 * BILLION + 1),
      investorKey: null,
      unitKey: null,
      fundKey: null,
      contractorId: contractors[0] as string,
      parties: [
        { contractorId: contractors[0] as string, sharePct: '50.0000', status: 'ACTIVE' },
        { contractorId: contractors[2] as string, sharePct: '50.0000', status: 'ACTIVE' },
      ],
    },
  ];

  it('makes one line per contract per active party, a joint venture counted once, the dong that does not divide going to one party (largest remainder)', async () => {
    const lines = await app.harness.owner(TENANT_A, [
      ['select contract_id::text, contractor_id::text, contract_value_vnd::text as value, active_value_vnd::text as active, is_lead, single_bidder_flag, days_late from machvon.contract_fact_snapshot_line where period_snapshot_id = $1::uuid order by contract_id, contractor_id', [periodSnapshotId]],
    ]);
    expect(lines).toHaveLength(5);
    const venture = (lines as Array<{ value: string; active: string; is_lead: boolean; single_bidder_flag: number | null }>).filter((line) => ['50000000001', '50000000000'].includes(line.value));
    // 100,000,000,001 split in halves: 50,000,000,001 and 50,000,000,000, equal remainders to the earlier key; together they are the contract.
    expect(venture).toHaveLength(2);
    expect(venture.reduce((acc, line) => acc + BigInt(line.value), 0n)).toBe(BigInt(100 * BILLION + 1));
    expect(venture.filter((line) => line.is_lead)).toHaveLength(1);
    expect(venture.filter((line) => !line.is_lead).every((line) => line.single_bidder_flag === null)).toBe(true);
  });

  it('adds up: the total of an additive metric is the sum of its groups under every dimension, and is the sum of the contracts', async () => {
    for (const dimension of ['unit', 'contractor', 'project', 'contract_status']) {
      const reply = await query({ metric_version_id: metricIds.ctr_value, snapshot_id: versionId, dimensions: [dimension] });
      expect([dimension, reply.status]).toEqual([dimension, 200]);
      const expected = BigInt(600 * BILLION) + BigInt(300 * BILLION) + BigInt(100 * BILLION + 1) + BigInt(999 * BILLION);
      expect(total(reply).value).toBe(expected.toString());
      expect(rows(reply).reduce((acc, row) => acc + BigInt(row.value as string), 0n)).toBe(expected);
    }
    const byContractor = await query({ metric_version_id: metricIds.ctr_value, snapshot_id: versionId, dimensions: ['contractor'] });
    // A: 600 + half of the venture; C: its draft of 999 + the other half of the venture
    const named = Object.fromEntries(rows(byContractor).map((row) => [row.key, BigInt(row.value as string)]));
    expect(named[contractors[1] as string]).toBe(BigInt(300 * BILLION));
    expect((named[contractors[0] as string] as bigint) + (named[contractors[2] as string] as bigint)).toBe(BigInt(600 * BILLION) + BigInt(100 * BILLION + 1) + BigInt(999 * BILLION));
  });

  it('recomputes the concentration from the raw contracts: the HHI and the top share of the active value by contractor (R16)', async () => {
    const expected = concentrationOf(ACTIVE, 'contractor', 1);
    const hhi = await query({ metric_version_id: metricIds.ctr_hhi_active, snapshot_id: versionId, dimensions: ['contractor'] });
    expect(hhi.status).toBe(200);
    expect(total(hhi).value).toBe(expected.hhi.value);
    const top = await query({ metric_version_id: metricIds.ctr_top1_share, snapshot_id: versionId, dimensions: ['contractor'] });
    expect(total(top).value).toBe(expected.top.value);
    // the groups of the first stage are the shares of the contractors, a draft is not exposure (its active value is zero)
    expect(rows(hhi).map((row) => BigInt(row.numerator as string)).filter((value) => value > 0n).sort()).toEqual(expected.groups.map((group) => BigInt(group.valueVnd)).sort());
  });

  it('gives the single-bidder rate over the contracts whose bidder count is known, from the lead line only', async () => {
    const reply = await query({ metric_version_id: metricIds.ctr_single_bidder, snapshot_id: versionId, dimensions: [] });
    // HD-1 had one bidder, HD-2 three, HD-3 two; the draft has none on record
    expect(total(reply)).toMatchObject({ value: '33.33', numerator: '1', denominator: '3' });
  });

  it('refuses a snapshot that is not there as it always did: the metric of contract fields cannot be planned over the default dataset', async () => {
    const unknown = await query({ metric_version_id: metricIds.ctr_paid_rate, snapshot_id: randomUUID() });
    expect([unknown.status, unknown.json.code]).toEqual([422, 'VALIDATION_FAILED']);
  });
});
