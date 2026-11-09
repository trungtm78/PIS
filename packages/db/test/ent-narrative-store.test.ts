import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { draftHash, enterpriseNarrativeOf, fieldHash, fundingCells, inheritNarrative, inheritanceHashes, narrativeOf, parseNarrativeImport } from '@machvon/kernel';
import type { EffectiveAccess, NarrativeInput, RawFundingLine, Scope } from '@machvon/kernel';
import { DisImportStore } from '../src/dis-import-store';
import { DisReportStore } from '../src/dis-report-store';
import type { NewDraft } from '../src/dis-report-store';
import { EntNarrativeStore } from '../src/ent-narrative-store';
import { projectScope } from '../src/prj-project-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, contextFor, id, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const reports = new DisReportStore();
const store = new EntNarrativeStore();
const imports = new DisImportStore();

const MAKER = 1;
const FAMILY = 0x9d;
const ROOT = 1;
const DEPARTMENT = 2;
const NOW = new Date('2041-04-10T03:00:00Z');
const AREA = id(FAMILY, 30);
const DECISION = id(FAMILY, 32);

const as = <T>(work: (tx: TenantTx) => Promise<T>): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(MAKER)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

const accessOf = (permissions: readonly string[], scope: Scope): EffectiveAccess => ({
  membershipId: memberId(MAKER),
  scopeVersion: 1,
  membershipActive: true,
  grants: [{ roleCode: 'DIS', rank: 30, permissions, scope, status: 'Active', effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveUntil: null }],
});
const whole = accessOf(['report.read', 'report.create'], { kind: 'TENANT' });
const seeAll = projectScope(whole, 'report.read', NOW);

const FUNDING: RawFundingLine[] = [
  { bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: '100000000', ctmtqg_subset_vnd: '40000000' },
  { bucket: 'CURRENT_YEAR', budget_level: 'LOCAL', cumulative_vnd: '200000000' },
  { bucket: 'CARRYOVER', budget_level: 'CENTRAL', cumulative_vnd: '30000000' },
  { bucket: 'CARRYOVER', budget_level: 'LOCAL', cumulative_vnd: '70000000' },
  { bucket: 'OTHER', budget_level: 'CENTRAL', cumulative_vnd: '0' },
  { bucket: 'OTHER', budget_level: 'LOCAL', cumulative_vnd: '20000000' },
];

async function seedReplica(statements: Array<[string, unknown[]]>): Promise<void> {
  const client = new Client({ connectionString: harness.database.adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    for (const [sql, params] of statements) await client.query(sql, params);
  } finally {
    await client.end();
  }
}

const project = { a: id(FAMILY, 1), b: id(FAMILY, 2) };
const month = { jan: id(FAMILY, 10), feb: id(FAMILY, 11), mar: id(FAMILY, 12) };
const plan = { a: id(FAMILY, 20), b: id(FAMILY, 21) };
const CAUSE_RECORD = id(FAMILY, 40);
const CAUSE_VERSION = id(FAMILY, 41);
const RETIRED_RECORD = id(FAMILY, 42);
const RETIRED_VERSION = id(FAMILY, 43);

const periodRow = (n: string, code: string, start: string, end: string): [string, unknown[]] => [
  `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
   values ($1, $2, $3, 1, $4::date, $5::date, $5::date + interval '3 hours', 'DEFAULT', 'MONTH', 2041, 'OPEN', $6, $7, $7)`,
  [TENANT_A, n, code, start, end, id(FAMILY, 50), memberId(MAKER)],
];

const draft = async (projectId: string, periodId: string, planId: string, narrative: NarrativeInput | null): Promise<{ id: string; version: number }> => {
  const input: NewDraft = {
    projectId,
    periodId,
    planVersionId: planId,
    reportType: 'MONTHLY',
    measurementBasis: 'YTD',
    cells: fundingCells(FUNDING),
    negativeDeltaExplanation: null,
    progress: null,
    narrative,
    attachments: [],
    asOfDate: '2041-03-31',
    clientOperationId: undefined,
    allocations: new Map(),
  };
  return as((tx) => reports.createDraft(tx, input, memberId(MAKER)));
};

const block = (raw: Parameters<typeof enterpriseNarrativeOf>[0]) => {
  const made = enterpriseNarrativeOf(raw);
  if (made === null) throw new Error('empty block');
  return made;
};
const narrative = (raw: Parameters<typeof enterpriseNarrativeOf>[0]): NarrativeInput => {
  const made = narrativeOf({ enterprise: raw });
  if (made === null) throw new Error('empty narrative');
  return made;
};

describe('EntNarrativeStore (the structured narrative of a period, ENT-3b)', () => {
  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: ROOT, path: '/u1/' },
      { n: DEPARTMENT, path: '/u1/u2/', parent: ROOT },
    ]);
    await harness.seedMembership(TENANT_A, MAKER, ROOT);
    await seedReplica([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, 'NA-A', 'Project A', $3, $4, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B'), ($1, $5, 'NA-B', 'Project B', $3, $4, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, project.a, unitId(DEPARTMENT), AREA, project.b],
      ],
      [
        `insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, decision_id, status, effective_at)
         values ($1, $2, $3, 2041, 1, $5, 'PUBLISHED', '2041-01-01T00:00:00Z'), ($1, $4, $6, 2041, 1, $5, 'PUBLISHED', '2041-01-01T00:00:00Z')`,
        [TENANT_A, plan.a, project.a, plan.b, DECISION, project.b],
      ],
      periodRow(month.jan, '2041-M01', '2041-01-01', '2041-01-31'),
      periodRow(month.feb, '2041-M02', '2041-02-01', '2041-02-28'),
      periodRow(month.mar, '2041-M03', '2041-03-01', '2041-03-31'),
      [
        `insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, current_version_id, created_by, updated_by)
         values ($1, $2, 'TENANT', 'ISSUE_CATEGORY', 'SITE_HANDOVER', 'EFFECTIVE', $3, $6, $6), ($1, $4, 'TENANT', 'ISSUE_CATEGORY', 'OLD_CAUSE', 'RETIRED', $5, $6, $6)`,
        [TENANT_A, CAUSE_RECORD, CAUSE_VERSION, RETIRED_RECORD, RETIRED_VERSION, memberId(MAKER)],
      ],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, published_at, created_by, updated_by)
         values ($1, $2, $3, 'ISSUE_CATEGORY', 'SITE_HANDOVER', 1, 'Site handover', '{}', date '2024-01-01', 'EFFECTIVE', 'TENANT', now(), $6, $6),
                ($1, $4, $5, 'ISSUE_CATEGORY', 'OLD_CAUSE', 1, 'Old cause', '{}', date '2024-01-01', 'EFFECTIVE', 'TENANT', now(), $6, $6)`,
        [TENANT_A, CAUSE_VERSION, CAUSE_RECORD, RETIRED_VERSION, RETIRED_RECORD, memberId(MAKER)],
      ],
    ]);
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  it('keeps the enterprise block with the narrative of a report and reads it back whole', async () => {
    const written = block({ status: 'Works on schedule', schedule: 'Milestone 3 late', next_plan: 'Finish the foundation', cause_codes: ['SITE_HANDOVER'], directive_refs: [{ id: randomUUID(), code: 'CD-1', status_at_end: 'IN_PROGRESS' }] });
    const made = await draft(project.a, month.jan, plan.a, { resultsText: 'public words', causesText: null, solutionsText: null, proposalsText: null, linkedIssueIds: [], enterprise: written });
    const read = await as((tx) => reports.narrativeOf(tx, made.id));
    expect(read?.resultsText).toBe('public words');
    expect(read?.enterprise).toEqual({ ...written });
    const row = (await owner<{ pack_code: string; pack_fields: Record<string, string> }>('select pack_code, pack_fields from machvon.report_narrative where report_revision_id = $1', [made.id]))[0];
    expect(row?.pack_code).toBe('ENTERPRISE');
    expect(Object.keys(row?.pack_fields ?? {}).sort()).toEqual(['next_plan', 'schedule', 'status']);
  });

  it('saves a narrative on its own and moves the version and the hash of the report with it, to the hash a full save would give', async () => {
    const made = await draft(project.b, month.jan, plan.b, null);
    const head = await as((tx) => reports.lockHead(tx, made.id));
    const next = narrative({ status: 'First words' });
    const saved = await as((tx) => reports.saveNarrative(tx, head as NonNullable<typeof head>, next, memberId(MAKER)));
    expect(saved.version).toBe(2);
    const expected = draftHash({
      projectId: project.b,
      periodId: month.jan,
      planVersionId: plan.b,
      reportType: 'MONTHLY',
      measurementBasis: 'YTD',
      cells: fundingCells(FUNDING),
      negativeDeltaExplanation: null,
      progress: null,
      narrative: next,
      attachments: [],
    });
    expect(saved.payloadHash).toBe(expected);
    const stored = (await owner<{ payload_hash: string; version: string }>('select payload_hash, version::text as version from machvon.report_revision where id = $1', [made.id]))[0];
    expect(stored).toEqual({ payload_hash: expected, version: '2' });
    // The hash of a report without a block does not know the block: a narrative of the public edition hashes as it always did.
    const plain = narrativeOf({ results: 'only public' }) as NarrativeInput;
    expect(JSON.stringify(plain)).not.toContain('enterprise');
  });

  it('keeps the trace of an inheritance when the block is saved again without it, and drops it with the block', async () => {
    const made = await draft(project.a, month.feb, plan.a, null);
    const head = await as((tx) => reports.lockHead(tx, made.id));
    const previous = block({ status: 'Old status', causes: 'Old reason' });
    const merged = inheritNarrative(previous, null);
    const trace = { fromReportId: (await owner<{ id: string }>('select id from machvon.report_revision where project_id = $1 and period_id = $2', [project.a, month.jan]))[0]?.id as string, fromPeriodId: null, at: '2041-02-02T00:00:00.000Z', by: memberId(MAKER), hashes: inheritanceHashes(merged.block, merged.copied) };
    await as((tx) => reports.saveNarrative(tx, head as NonNullable<typeof head>, { resultsText: null, causesText: null, solutionsText: null, proposalsText: null, linkedIssueIds: [], enterprise: { ...merged.block, inheritance: trace } }, memberId(MAKER)));
    const first = await as((tx) => store.blockOf(tx, made.id));
    expect(first?.inheritance).toMatchObject({ fromReportId: trace.fromReportId, by: memberId(MAKER) });
    expect(first?.inheritance?.hashes.status).toBe(fieldHash('Old status'));
    expect(first?.inheritance?.fromPeriodId).toBe(month.jan);

    const head2 = await as((tx) => reports.lockHead(tx, made.id));
    await as((tx) => reports.saveNarrative(tx, head2 as NonNullable<typeof head2>, narrative({ status: 'Rewritten status', causes: 'Old reason' }), memberId(MAKER)));
    const second = await as((tx) => store.blockOf(tx, made.id));
    expect(second?.fields.status).toBe('Rewritten status');
    expect(second?.inheritance?.hashes.status).toBe(fieldHash('Old status'));

    const head3 = await as((tx) => reports.lockHead(tx, made.id));
    await as((tx) => reports.saveNarrative(tx, head3 as NonNullable<typeof head3>, null, memberId(MAKER)));
    expect(await as((tx) => store.blockOf(tx, made.id))).toBeUndefined();
  });

  it('finds the previous report of the project that was handed in, never a draft', async () => {
    const janReport = (await owner<{ id: string }>('select id from machvon.report_revision where project_id = $1 and period_id = $2', [project.a, month.jan]))[0]?.id as string;
    const mar = await draft(project.a, month.mar, plan.a, null);
    expect(await as((tx) => store.previousOf(tx, mar.id))).toBeUndefined();
    await owner("update machvon.report_revision set status = 'SUBMITTED', submitted_at = now(), submitted_by = created_by where id = $1", [janReport]);
    const found = await as((tx) => store.previousOf(tx, mar.id));
    expect(found).toMatchObject({ reportId: janReport, periodCode: '2041-M01', status: 'SUBMITTED' });
    expect(found?.block.fields.status).toBe('Works on schedule');
    expect(found?.block.directiveRefs).toHaveLength(1);
    const other = (await owner<{ id: string }>('select id from machvon.report_revision where project_id = $1 and period_id = $2', [project.b, month.jan]))[0]?.id as string;
    expect(await as((tx) => store.previousOf(tx, other))).toBeUndefined();
  });

  it('lists the standard causes in use and names the codes that are not on the list', async () => {
    expect(await as((tx) => store.causes(tx))).toEqual([{ code: 'SITE_HANDOVER', label: 'Site handover' }]);
    expect(await as((tx) => store.unknownCodes(tx, ['SITE_HANDOVER', 'OLD_CAUSE', 'NOPE']))).toEqual(['OLD_CAUSE', 'NOPE']);
    expect(await as((tx) => store.labelsOf(tx, ['SITE_HANDOVER', 'LEFT']))).toEqual(['Site handover', 'LEFT']);
  });

  it('refuses in the table what the code would never write: an unknown field of the pack, a trace with no pack, a block with nothing in it', async () => {
    const made = await draft(project.b, month.feb, plan.b, narrative({ status: 'x' }));
    const attempt = async (sql: string): Promise<string> => {
      try {
        await owner(sql, [made.id]);
        return 'accepted';
      } catch (error) {
        return (error as { constraint?: string }).constraint ?? 'other';
      }
    };
    expect(await attempt(`update machvon.report_narrative set pack_fields = '{"bogus":"x"}'::jsonb where report_revision_id = $1`)).toBe('report_narrative_enterprise_fields_chk');
    expect(await attempt(`update machvon.report_narrative set pack_version = null where report_revision_id = $1`)).toBe('report_narrative_pack_chk');
    expect(await attempt(`update machvon.report_narrative set pack_fields = '{}'::jsonb where report_revision_id = $1`)).toBe('report_narrative_not_empty_chk');
    expect(await attempt(`update machvon.report_narrative set inherited_from_report_id = report_revision_id, inherited_at = now(), inherited_by = updated_by, inherited_hashes = '{}'::jsonb where report_revision_id = $1`)).toBe('report_narrative_inherited_chk');
  });

  describe('the file of narratives', () => {
    const table = (rows: string[][]) => ({
      format: 'XLSX' as const,
      headers: ['project_code', 'status', 'schedule', 'disbursement', 'causes', 'difficulties', 'solutions', 'next_plan', 'proposals', 'cause_codes'],
      rows,
      lines: rows.map((_row, index) => index + 2),
    });
    const context = { scope: seeAll, actor: memberId(MAKER), now: NOW };

    it('judges every row on its own: a project outside the register, a project with no live draft, a cause that is not on the list', async () => {
      const parsed = parseNarrativeImport(
        table([
          ['NA-A', 'File words', '', '', '', '', '', 'Plan', '', 'SITE_HANDOVER'],
          ['NO-SUCH', 'x', '', '', '', '', '', '', '', ''],
          ['NA-B', 'y', '', '', '', '', '', '', '', 'NOPE'],
        ]),
      );
      const judgement = await as((tx) => store.judge(tx, parsed, month.feb, context));
      expect(judgement.faults.map((fault) => `${fault.line}:${fault.code}`)).toEqual(['3:PROJECT_NOT_FOUND', '4:CAUSE_CODE_UNKNOWN']);
      expect(judgement.targets.map((target) => target.projectCode)).toEqual(['NA-A']);
    });

    it('sends a project that has no draft of the period back as a fault, and applies a file once, keeping the public words and the trace', async () => {
      const parsed = parseNarrativeImport(table([['NA-A', 'File words', '', '', '', '', '', 'Plan', '', 'SITE_HANDOVER']]));
      const noDraft = await as((tx) => store.judge(tx, parseNarrativeImport(table([['NA-B', 'z', '', '', '', '', '', '', '', '']])), month.mar, context));
      expect(noDraft.faults.map((fault) => fault.code)).toEqual(['REPORT_DRAFT_MISSING']);
      expect(noDraft.targets).toEqual([]);

      const judgement = await as((tx) => store.judge(tx, parsed, month.feb, context));
      expect(judgement.faults).toEqual([]);
      const applied = await as(async (tx) => {
        const batch = await imports.record(tx, { periodId: month.feb, fileObjectKey: 'k/narrative.xlsx', fileSha256: 'a'.repeat(64), mappingVersion: 'ENT-NARRATIVE-1', totalRows: 1, faults: [], actor: memberId(MAKER) });
        const locked = await imports.lockForApply(tx, batch.id, batch.version, memberId(MAKER));
        return store.apply(tx, locked, judgement, context);
      });
      expect(applied.batch).toMatchObject({ status: 'APPLIED', draftsUpdated: 1, draftsCreated: 0 });
      const feb = applied.drafts[0]?.id as string;
      const read = await as((tx) => store.blockOf(tx, feb));
      expect(read?.fields.status).toBe('File words');
      expect(read?.causeCodes).toEqual(['SITE_HANDOVER']);
      const hash = (await owner<{ payload_hash: string }>('select payload_hash from machvon.report_revision where id = $1', [feb]))[0]?.payload_hash;
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
