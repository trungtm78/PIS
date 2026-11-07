import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { HomeWorkActionStore } from '../src/home-work-action-store';
import { GovernancePolicyPort } from '../src/governance-policy-port';
import { CONSEQUENCES, SOURCE_OF_KIND } from '../src/home-work-rules';
import { HomeWorkStore } from '../src/home-work-store';
import type { WorkInput, WorkRow } from '../src/home-work-store';
import type { ScopeBuilder } from '../src/scope-version';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';
import { seedRow } from './support/seed-rows';

const harness = new AuthzHarness();
const store = new HomeWorkStore();
const actions = new HomeWorkActionStore();

const ROOT = 1;
const NORTH = 2;
const READER = 1;
const OTHER = 2;
const NOW = new Date('2027-10-15T03:00:00Z');
const TODAY = '2027-10-15';
const EVERYTHING: ScopeBuilder = () => ({ sql: 'true', params: [] });
const NOTHING: ScopeBuilder = () => ({ sql: 'false', params: [] });

const as = <T>(work: (tx: Parameters<Parameters<typeof harness.tenants.withTenant>[1]>[0]) => Promise<T>, tenant = TENANT_A, member = READER): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const input = (over: Partial<WorkInput> = {}): WorkInput => ({ membershipId: memberId(READER), now: NOW, today: TODAY, unitScope: EVERYTHING, projectScope: EVERYTHING, ...over });

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

/** The state of the decisions about the items of the alert centre, and the rules of the store that reads the work (HOME, "Cần xử lý ngay"). */
describe('HomeWorkStore and HomeWorkActionStore', () => {
  const projectId = randomUUID();
  const warningId = randomUUID();
  const otherTenantWarning = randomUUID();

  async function warning(tenant: string, project: string, id: string): Promise<void> {
    const rule = randomUUID();
    await admin([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, $3, $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B') on conflict do nothing`,
        [tenant, project, `P-${project.slice(0, 6)}`, unitId(NORTH), randomUUID()],
      ],
      [
        `insert into machvon.early_warning_rule (tenant_id, id, rule_code, name, metric_code, comparator, threshold_json, severity, scope_kind, legal_basis, effective_from, revision, status, approved_by, created_by, updated_by)
         values ($1, $2, $3, 'Rule', 'YTD_RATE_GAP', 'GTE', '{}'::jsonb, 'CRITICAL', 'PROJECT', 'Legal basis', '2027-01-01', 1, 'PUBLISHED', $4, $5, $5)`,
        [tenant, rule, `EW-${rule.slice(0, 6).toUpperCase()}`, memberId(READER), memberId(OTHER)],
      ],
      [
        `insert into machvon.early_warning (tenant_id, id, rule_id, project_id, period_id, snapshot_id, severity, observed_json, dedupe_key, status, created_by, updated_by)
         values ($1, $2, $3, $4, $5, $6, 'CRITICAL', '{}'::jsonb, $7, 'OPEN', $8, $8)`,
        [tenant, id, rule, project, randomUUID(), randomUUID(), `k-${id}`, memberId(READER)],
      ],
    ]);
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: NORTH, path: `/${unitId(ROOT)}/${unitId(NORTH)}/`, parent: ROOT },
      ]);
      await harness.seedMembership(tenant, READER, ROOT);
      await harness.seedMembership(tenant, OTHER, NORTH);
    }
    await warning(TENANT_A, projectId, warningId);
    await warning(TENANT_B, randomUUID(), otherTenantWarning);
  }, 300_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('work_action', () => {
    const record = (action: 'CLAIM' | 'ASSIGN' | 'SNOOZE', over: Record<string, unknown> = {}, member = READER) =>
      as((tx) => actions.record(tx, { source: 'EARLY_WARNING', sourceId: warningId, action, actor: memberId(member), ...(action === 'SNOOZE' ? { reasonCode: 'WAITING_INFORMATION', snoozeOrdinal: 1, snoozeFinal: false, policyVersion: 'builtin' } : {}), ...over }));

    it('keeps each decision as a row of its own and tells the latest of each kind, and who made it, by name', async () => {
      await record('CLAIM');
      await record('CLAIM', {}, OTHER);
      await record('ASSIGN', { assignee: memberId(OTHER), dueOn: '2027-10-20' });
      const states = await as((tx) => actions.stateOf(tx, [{ source: 'EARLY_WARNING', sourceId: warningId }, { source: 'EARLY_WARNING', sourceId: randomUUID() }], memberId(READER), NOW));
      expect(states.size).toBe(1);
      expect(states.get(`EARLY_WARNING:${warningId}`)).toMatchObject({ claimedBy: { id: memberId(OTHER), name: 'User 2' }, assignee: { id: memberId(OTHER), name: 'User 2', dueOn: '2027-10-20' }, lifecycle: 'IN_PROGRESS', hiddenForReader: false, snoozedUntil: null });
      expect(await as((tx) => tx.query('select 1 from machvon.work_action where source_id = $1', [warningId]))).toHaveLength(3);
    });

    it('hides an item from the one who put it off until it comes back, and only shows to the others when it comes back', async () => {
      await record('SNOOZE', { snoozeUntil: '2027-10-16T05:00:00.000Z' });
      const mine = await as((tx) => actions.stateOf(tx, [{ source: 'EARLY_WARNING', sourceId: warningId }], memberId(READER), NOW));
      expect(mine.get(`EARLY_WARNING:${warningId}`)).toMatchObject({ hiddenForReader: true, snoozedUntil: '2027-10-16T05:00:00.000Z' });
      const theirs = await as((tx) => actions.stateOf(tx, [{ source: 'EARLY_WARNING', sourceId: warningId }], memberId(OTHER), NOW));
      expect(theirs.get(`EARLY_WARNING:${warningId}`)).toMatchObject({ hiddenForReader: false, snoozedUntil: '2027-10-16T05:00:00.000Z' });
      const later = await as((tx) => actions.stateOf(tx, [{ source: 'EARLY_WARNING', sourceId: warningId }], memberId(READER), new Date('2027-10-17T00:00:00Z')));
      expect(later.get(`EARLY_WARNING:${warningId}`)).toMatchObject({ hiddenForReader: false, snoozedUntil: null });
    });

    it('is appended and never changed or removed by the application role, and each kind of decision holds only what it needs', async () => {
      await expect(as((tx) => tx.query('update machvon.work_action set reason = $1 where source_id = $2', ['edited', warningId]))).rejects.toThrow(/permission denied/);
      await expect(as((tx) => tx.query('delete from machvon.work_action where source_id = $1', [warningId]))).rejects.toThrow(/permission denied/);
      await expect(record('CLAIM', { assignee: memberId(OTHER) })).rejects.toThrow(/work_action_shape_chk/);
      await expect(record('ASSIGN')).rejects.toThrow(/work_action_shape_chk/);
      await expect(record('SNOOZE')).rejects.toThrow(/work_action_shape_chk/);
      await expect(record('CLAIM', { sourceId: ' padded ' })).rejects.toThrow(/source_id/);
    });

    it('is the business of one tenant: another tenant reads none of it and cannot write for it', async () => {
      expect(await as((tx) => tx.query('select 1 from machvon.work_action'), TENANT_B)).toHaveLength(0);
      await expect(as((tx) => actions.record(tx, { source: 'EARLY_WARNING', sourceId: warningId, action: 'CLAIM', actor: memberId(READER) }), TENANT_B, READER)).resolves.toBeDefined();
      // The decision of tenant B about the same id is its own row, and tenant A still has the three it had.
      expect(await as((tx) => tx.query('select 1 from machvon.work_action'), TENANT_B)).toHaveLength(1);
      expect((await as((tx) => tx.query('select 1 from machvon.work_action'), TENANT_A)).length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('collect', () => {
    it('reads the work in the scope of the reader and names a source that fails without losing the others', async () => {
      const full = await as((tx) => store.collect(tx, input({ view: 'scope', includeHidden: true })));
      // No calendar is published in this database: the diaries are the one source that cannot be counted (and there are no contracts, so it is not asked).
      expect(full.unavailableSources).toEqual([]);
      expect(full.rows.map((row) => [row.source, row.id, row.severity])).toEqual([['EARLY_WARNING', warningId, 'URGENT']]);
      // A table that cannot be read takes its source out, and the transaction goes on for the rest.
      await admin([['alter table machvon.permit rename column valid_until to valid_until_moved', []]]);
      try {
        const partial = await as((tx) => store.collect(tx, input({ view: 'scope', includeHidden: true })));
        expect(partial.unavailableSources).toEqual(['PERMIT']);
        expect(partial.rows.map((row) => row.id)).toEqual([warningId]);
      } finally {
        await admin([['alter table machvon.permit rename column valid_until_moved to valid_until', []]]);
      }
    });

    it('gives nothing outside the scope, and nothing of another tenant, and counting gives the same rows as listing', async () => {
      expect((await as((tx) => store.collect(tx, input({ view: 'scope', projectScope: NOTHING, unitScope: NOTHING, includeHidden: true })))).rows).toEqual([]);
      const listed = await as((tx) => store.collect(tx, input({ view: 'scope', mode: 'rows', includeHidden: true })));
      const counted = await as((tx) => store.collect(tx, input({ view: 'scope', mode: 'count', includeHidden: true })));
      expect(counted.rows.map((row) => row.id)).toEqual(listed.rows.map((row) => row.id));
      expect(listed.rows.map((row) => row.id)).not.toContain(otherTenantWarning);
      const theirs = await as((tx) => store.collect(tx, input({ view: 'scope', membershipId: memberId(READER) })), TENANT_B);
      expect(theirs.rows.map((row) => row.id)).toEqual([otherTenantWarning]);
    });

    it('takes the item the reader put off out of their list and keeps it when a command asks for it', async () => {
      // The reader's snooze of the previous tests is still in force at NOW.
      const list = await as((tx) => store.collect(tx, input({ view: 'scope' })));
      expect(list.rows).toEqual([]);
      const kept = await as((tx) => store.collect(tx, input({ view: 'scope', includeHidden: true })));
      expect(kept.rows.map((row) => row.id)).toEqual([warningId]);
      expect(kept.rows[0]).toMatchObject({ lifecycle: 'IN_PROGRESS', snoozedUntil: '2027-10-16T05:00:00.000Z', assignee: { name: 'User 2' } });
    });
  });

  /**
   * The sources of the integrity of the money and of the duties and the alert of the baseline (lane D, lane B1, integration GOV-INT): each is read from the table of its module in the scope of the reader, for the audience its alert type has,
   * with the severity and the consequence its `ALERT_TYPE` says, and a source that fails is named. The rows are seeded as they stand (the guards of the modules are off); each test clears what it made.
   */
  describe('the sources of integrity', () => {
    const STRANGER = 3;
    const day = (offset: number): string => new Date(Date.parse(`${TODAY}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
    const seed = (table: string, values: Record<string, unknown>): Promise<string> => seedRow(harness.database.adminUrl, table, TENANT_A, values, { day: TODAY, instant: NOW.toISOString() });
    const holding =
      (...held: Array<[permission: string, wholeTenant: boolean]>) =>
      (permission: string, wholeTenant = false): boolean =>
        held.some(([name, whole]) => name === permission && (!wholeTenant || whole));
    const asMember = (member: number, view: 'mine' | 'scope', over: Partial<WorkInput> = {}): Promise<WorkRow[]> =>
      as((tx) => store.collect(tx, input({ includeHidden: true, membershipId: memberId(member), view, ...over }))).then((collected) => collected.rows.filter((row) => row.kind !== 'EARLY_WARNING'));
    const ids = (rows: Array<{ id: string }>): string[] => rows.map((row) => row.id).sort();
    const person = { created_by: memberId(READER), updated_by: memberId(READER) };

    const wipe = async (): Promise<void> => {
      await admin(
        [
          'work_action',
          'treasury_daily_recon_item',
          'cross_total_check',
          'period_snapshot',
          'sod_exception_use',
          'sod_exception',
          'payment_integrity_run',
          'disbursement_exception',
          'payment_request',
          'contract',
          'project_governance_alert',
          'project_accountability',
        ].map((table): [string, unknown[]] => [`delete from machvon.${table} where tenant_id = $1`, [TENANT_A]]),
      );
    };

    const accountableFor = (project: string, member: number): Promise<string> =>
      seed('project_accountability', { project_id: project, leader_membership_id: memberId(member), accountability_role: 'LEADER_IN_CHARGE', valid_from: '2027-01-01', status: 'ACTIVE', ...person });
    const contractId = (): Promise<string> => seed('contract', { code: `C-${randomUUID().slice(0, 6)}`, project_id: projectId, status: 'ACTIVE', signed_on: day(-100), effective_from: day(-100), type: 'LUMP_SUM', contract_value_vnd: 1000 });
    const request = (contract: string, status: string, over: Record<string, unknown> = {}): Promise<string> =>
      seed('payment_request', { project_id: projectId, contract_id: contract, status, request_no: `PR-${randomUUID().slice(0, 6)}`, created_by: memberId(OTHER), acceptance_id: randomUUID(), gross_vnd: 100, advance_recovery_vnd: 0, retention_vnd: 0, tax_adjustment_vnd: 0, net_vnd: 100, claims_acceptance: status !== 'DRAFT', version: 1, ...over });
    const run = (requestId: string, contract: string, over: Record<string, unknown>): Promise<string> =>
      seed('payment_integrity_run', {
        payment_request_id: requestId,
        contract_id: contract,
        project_id: projectId,
        trigger_kind: 'PREVIEW',
        rule_version: 0,
        rule_source: 'DEFAULT',
        rule_unverified: true,
        as_of: TODAY,
        created_by: memberId(READER),
        created_at: NOW.toISOString(),
        ...over,
      });

    beforeAll(async () => {
      await harness.seedMembership(TENANT_A, STRANGER, NORTH);
    }, 60_000);
    afterEach(wipe);

    it('has, in the built-in alert type of each new kind, the sentence the rules file keeps for it, the source of its kind, an owner and a response time', async () => {
      const kinds = ['TREASURY_RECON_ITEM_OVERDUE', 'CROSS_TOTAL_MISMATCH', 'SOD_EXCEPTION_EXPIRING', 'SOD_EXCEPTION_USED', 'PAYMENT_INTEGRITY_BLOCKED', 'PAYMENT_INTEGRITY_SIGNAL', 'DISBURSEMENT_EXCEPTION_EXPIRING', 'RESCHEDULE_COUNT'] as const;
      const types = await as((tx) => new GovernancePolicyPort().getAll(tx, 'ALERT_TYPE', TODAY));
      for (const kind of kinds) {
        const type = types.find((resolved) => resolved.code === kind);
        expect(type?.params.source).toBe(SOURCE_OF_KIND[kind]);
        expect(type?.params.consequence).toBe(CONSEQUENCES[kind]);
        expect(typeof type?.params.owner).toBe('string');
        expect(typeof type?.params.response_hours).toBe('number');
      }
    });

    it('keeps the decisions of people about an item of each new source (the check on work_action.source takes them and still takes the others)', async () => {
      const refused: string[] = [];
      for (const source of ['TREASURY_RECON', 'CROSS_TOTAL', 'SOD_EXCEPTION', 'PAYMENT_INTEGRITY', 'DISBURSEMENT_EXCEPTION', 'PROJECT_GOVERNANCE', 'PROCUREMENT_WORKFLOW', 'MONEY_CONTROL', 'DIRECTIVE', 'CLOCK', 'ADVANCE']) {
        await as((tx) => actions.record(tx, { source, sourceId: randomUUID(), action: 'CLAIM', actor: memberId(READER) } as never)).catch(() => refused.push(source));
      }
      expect(refused).toEqual([]);
      await expect(as((tx) => actions.record(tx, { source: 'NOT_A_SOURCE', sourceId: randomUUID(), action: 'CLAIM', actor: memberId(READER) } as never))).rejects.toThrow(/source/);
    });

    it('TREASURY_RECON: gives an item of difference past its day to its owner and, in the view scope, to whoever reads the project; an item not yet due, or in a place the reader may not read, is not given', async () => {
      const common = { project_id: projectId, kind: 'AMOUNT', books_vnd: 100, treasury_vnd: 150, latest_difference_vnd: 50, recon_date: day(-3), owner_membership_id: memberId(OTHER), ...person };
      const late = await seed('treasury_daily_recon_item', { ...common, fund_key: 'NSTW', fund_label: 'Vốn NSTW', due_on: day(-1), status: 'OPEN' });
      const explained = await seed('treasury_daily_recon_item', { ...common, fund_key: 'NSDP', due_on: day(-2), status: 'EXPLAINED', explained_by: memberId(OTHER), explained_at: NOW.toISOString(), resolution_note: 'Chờ chứng từ' });
      await seed('treasury_daily_recon_item', { ...common, fund_key: 'ODA', due_on: day(1), status: 'OPEN' });
      const mine = await asMember(OTHER, 'mine');
      expect(ids(mine)).toEqual([late, explained].sort());
      const item = mine.find((row) => row.id === late);
      expect(item).toMatchObject({ kind: 'TREASURY_RECON_ITEM_OVERDUE', source: 'TREASURY_RECON', severity: 'ACTION', dueOn: day(-1), target: { screen: 'PAY-20', id: late }, lifecycle: 'NEW' });
      expect(item?.consequence).toBe(CONSEQUENCES.TREASURY_RECON_ITEM_OVERDUE);
      expect(item?.alertType).toMatchObject({ code: 'TREASURY_RECON_ITEM_OVERDUE', owner: 'RECON_ITEM_OWNER', responseHours: 72 });
      expect(mine.find((row) => row.id === explained)?.lifecycle).toBe('IN_PROGRESS');
      // Who is not the owner and answers for no project has none of it in the view mine; in the view scope the reader has it.
      expect(await asMember(READER, 'mine')).toEqual([]);
      expect(ids(await asMember(READER, 'scope'))).toEqual(ids(mine));
      expect(await asMember(READER, 'scope', { projectScope: NOTHING, unitScope: NOTHING })).toEqual([]);
      // Somebody who is handed the item has it wherever it lies.
      await as((tx) => actions.record(tx, { source: 'TREASURY_RECON', sourceId: late, action: 'ASSIGN', actor: memberId(READER), assignee: memberId(STRANGER), dueOn: day(2) }));
      expect(ids(await asMember(STRANGER, 'mine'))).toEqual([late]);
    });

    it('CROSS_TOTAL: gives a snapshot still being built whose latest check disagrees, only to a reader who holds the right to read the control on the whole tenant (or was handed it); one item for a snapshot', async () => {
      const snapshot = (status: string, over: Record<string, unknown> = {}): Promise<string> =>
        seed('period_snapshot', { snapshot_kind: 'ADHOC', status, definition_status: 'SIGNED', metric_set_version: 'v1', period_id: randomUUID(), as_of_date: TODAY, treasury_cutoff_date: TODAY, ...person, ...over });
      const check = (snapshotId: string, over: Record<string, unknown> = {}): Promise<string> =>
        seed('cross_total_check', {
          snapshot_id: snapshotId,
          fiscal_year: 2027,
          treasury_cutoff_date: TODAY,
          published: false,
          total_unit_vnd: 100,
          total_fund_vnd: 100,
          total_project_vnd: 90,
          disagreeing: ['PROJECT'],
          agreeing: ['UNIT', 'FUND'],
          origin: 'MANUAL',
          created_by: memberId(READER),
          ...over,
        });
      const building = await snapshot('BUILDING');
      await check(building, { created_at: '2027-10-14T03:00:00.000Z' });
      await check(building, { created_at: '2027-10-15T01:00:00.000Z', total_project_vnd: 80 });
      // A later check that agrees closes the alert; a snapshot that was frozen is no longer to be fixed.
      const repaired = await snapshot('BUILDING');
      await check(repaired, { created_at: '2027-10-14T03:00:00.000Z' });
      await check(repaired, { created_at: '2027-10-15T01:00:00.000Z', published: true, total_project_vnd: 100, disagreeing: [], agreeing: ['UNIT', 'FUND', 'PROJECT'] });
      const frozen = await snapshot('FROZEN', { frozen_by: memberId(READER), frozen_at: NOW.toISOString(), payload_sha256: 'a'.repeat(64) });
      await check(frozen);
      const steward = holding(['disbursement.control.read', true]);
      for (const view of ['mine', 'scope'] as const) {
        const rows = await asMember(READER, view, { holds: steward });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: building, kind: 'CROSS_TOTAL_MISMATCH', source: 'CROSS_TOTAL', severity: 'ACTION', dueOn: null, target: { screen: 'DIS-26', id: building } });
        expect(rows[0]?.consequence).toBe(CONSEQUENCES.CROSS_TOTAL_MISMATCH);
        expect(rows[0]?.alertType).toMatchObject({ code: 'CROSS_TOTAL_MISMATCH', owner: 'DIS_DATA_STEWARD', responseHours: 48 });
        // Somebody who holds nothing, or the right on one unit only, has none of it.
        expect(await asMember(OTHER, view)).toEqual([]);
        expect(await asMember(OTHER, view, { holds: holding(['disbursement.control.read', false]) })).toEqual([]);
      }
      await as((tx) => actions.record(tx, { source: 'CROSS_TOTAL', sourceId: building, action: 'ASSIGN', actor: memberId(READER), assignee: memberId(STRANGER), dueOn: day(2) }));
      expect(ids(await asMember(STRANGER, 'mine'))).toEqual([building]);
    });

    it('SOD_EXCEPTION: gives the exceptions that end within five days to the administrator and one item for each exception that something went through to the auditors, each only to the one whose role reads them', async () => {
      const exception = (over: Record<string, unknown>): Promise<string> =>
        seed('sod_exception', {
          action_a: 'contract.draft',
          action_b: 'contract.approve',
          scope: 'SAME_CONTRACT',
          subject_id: randomUUID(),
          member_id: memberId(OTHER),
          requested_by: memberId(READER),
          reason: 'Thiếu người thay thế trong tuần này',
          valid_from: day(-2),
          rule_version: 0,
          approvers_needed: 2,
          approvals: 2,
          status: 'APPROVED',
          decided_at: NOW.toISOString(),
          ...over,
        });
      const ending = await exception({ valid_to: day(3) });
      await exception({ valid_to: day(10) });
      await exception({ valid_to: day(2), status: 'REQUESTED', approvals: 0, decided_at: null });
      const used = (exceptionId: string | null, outcome: string, usedAt: string): Promise<string> =>
        seed('sod_exception_use', {
          outcome,
          exception_id: exceptionId,
          action_a: 'contract.draft',
          action_b: 'contract.approve',
          scope: 'SAME_CONTRACT',
          subject_id: randomUUID(),
          member_id: memberId(OTHER),
          taking: 'contract.approve',
          command: 'activateContract',
          record_id: randomUUID(),
          rule_version: 0,
          used_at: usedAt,
        });
      await used(ending, 'EXCEPTION_USED', NOW.toISOString());
      await used(ending, 'EXCEPTION_USED', '2027-10-14T03:00:00.000Z');
      await used(null, 'WARNED', NOW.toISOString());
      const old = await exception({ valid_to: day(20) });
      await used(old, 'EXCEPTION_USED', '2027-09-20T03:00:00.000Z');
      const administrator = holding(['adm.sod.read', true]);
      const auditor = holding(['aud.sod.read', true]);
      for (const view of ['mine', 'scope'] as const) {
        const forAdministrator = await asMember(READER, view, { holds: administrator });
        expect(forAdministrator).toHaveLength(1);
        expect(forAdministrator[0]).toMatchObject({ id: ending, kind: 'SOD_EXCEPTION_EXPIRING', source: 'SOD_EXCEPTION', severity: 'ACTION', dueOn: day(3), target: { screen: 'ADM-24', id: ending } });
        expect(forAdministrator[0]?.consequence).toBe(CONSEQUENCES.SOD_EXCEPTION_EXPIRING);
        expect(forAdministrator[0]?.alertType).toMatchObject({ code: 'SOD_EXCEPTION_EXPIRING', owner: 'ADM_ADMINISTRATOR' });
        const forAuditor = await asMember(READER, view, { holds: auditor });
        expect(forAuditor).toHaveLength(1);
        expect(forAuditor[0]).toMatchObject({ id: `used:${ending}`, kind: 'SOD_EXCEPTION_USED', source: 'SOD_EXCEPTION', severity: 'WATCH', target: { screen: 'AUD-13', id: ending } });
        expect(forAuditor[0]?.subtitle).toMatch(/2 lần dùng/);
        expect(forAuditor[0]?.alertType).toMatchObject({ code: 'SOD_EXCEPTION_USED', owner: 'AUDITOR' });
        expect(ids(await asMember(READER, view, { holds: holding(['adm.sod.read', true], ['aud.sod.read', true]) }))).toEqual([`used:${ending}`, ending].sort());
        // Neither role: nothing; and the right on one unit only does not reach what belongs to the whole tenant.
        expect(await asMember(READER, view)).toEqual([]);
        expect(await asMember(READER, view, { holds: holding(['adm.sod.read', false], ['aud.sod.read', false]) })).toEqual([]);
      }
    });

    it('PAYMENT_INTEGRITY and DISBURSEMENT_EXCEPTION: give a blocked draft, a request that waits with signals and an exception that lapses to the one who drew the request up and the leader accountable for the project, and not a draft that a later check passed', async () => {
      const contract = await contractId();
      const blocked = await request(contract, 'DRAFT');
      await run(blocked, contract, { outcome: 'BLOCKED', invariant_count: 1, signal_count: 0, excused_count: 0, created_at: '2027-10-14T03:00:00.000Z' });
      const passedLater = await request(contract, 'DRAFT');
      await run(passedLater, contract, { outcome: 'BLOCKED', invariant_count: 1, signal_count: 0, excused_count: 0, created_at: '2027-10-13T03:00:00.000Z' });
      await run(passedLater, contract, { outcome: 'PASSED', invariant_count: 0, signal_count: 0, excused_count: 0, created_at: '2027-10-14T04:00:00.000Z' });
      const signalled = await request(contract, 'SUBMITTED', { submitted_by: memberId(OTHER) });
      await run(signalled, contract, { trigger_kind: 'SUBMIT', outcome: 'SIGNALS', invariant_count: 0, signal_count: 2, excused_count: 0 });
      const exception = (requestId: string, validTo: string): Promise<string> =>
        seed('disbursement_exception', {
          payment_request_id: requestId,
          contract_id: contract,
          project_id: projectId,
          ceiling: 'EXCEEDS_PLAN',
          allowed_amount_vnd: 10,
          valid_to: validTo,
          reason: 'Chờ điều chỉnh kế hoạch vốn',
          status: 'APPROVED',
          requested_by: memberId(READER),
          decided_by: memberId(STRANGER),
          decided_at: NOW.toISOString(),
          requested_at: '2027-09-01T03:00:00.000Z',
        });
      const soon = await exception(await request(contract, 'SUBMITTED'), day(2));
      const lapsed = await exception(await request(contract, 'SUBMITTED'), day(-3));
      await exception(await request(contract, 'SUBMITTED'), day(-20));
      await exception(await request(contract, 'SUBMITTED'), day(30));
      await accountableFor(projectId, STRANGER);
      const expected = [`blocked:${blocked}`, `signal:${signalled}`].sort();
      // The one who drew the request up (OTHER) has the two of them; the leader accountable for the project (STRANGER) has them with the exceptions; a reader who is neither has none in the view mine.
      const drawnUp = await asMember(OTHER, 'mine');
      expect(ids(drawnUp.filter((row) => row.source === 'PAYMENT_INTEGRITY'))).toEqual(expected);
      expect(drawnUp.find((row) => row.id === `blocked:${blocked}`)).toMatchObject({ kind: 'PAYMENT_INTEGRITY_BLOCKED', severity: 'ACTION', dueOn: null, target: { screen: 'PAY-03', id: blocked } });
      expect(drawnUp.find((row) => row.id === `signal:${signalled}`)).toMatchObject({ kind: 'PAYMENT_INTEGRITY_SIGNAL', severity: 'WATCH', target: { screen: 'PAY-03', id: signalled } });
      expect(drawnUp.find((row) => row.id === `blocked:${blocked}`)?.consequence).toBe(CONSEQUENCES.PAYMENT_INTEGRITY_BLOCKED);
      expect(drawnUp.find((row) => row.id === `signal:${signalled}`)?.alertType).toMatchObject({ code: 'PAYMENT_INTEGRITY_SIGNAL', owner: 'PAYMENT_APPROVER', responseHours: 168 });
      const leader = await asMember(STRANGER, 'mine');
      expect(ids(leader)).toEqual([...expected, lapsed, soon].sort());
      expect(leader.find((row) => row.id === soon)).toMatchObject({ kind: 'DISBURSEMENT_EXCEPTION_EXPIRING', source: 'DISBURSEMENT_EXCEPTION', severity: 'WATCH', dueOn: day(2), target: { screen: 'PAY-21', id: soon } });
      expect(leader.find((row) => row.id === lapsed)).toMatchObject({ dueOn: day(-3) });
      expect(leader.find((row) => row.id === soon)?.consequence).toBe(CONSEQUENCES.DISBURSEMENT_EXCEPTION_EXPIRING);
      expect(leader.find((row) => row.id === soon)?.alertType).toMatchObject({ code: 'DISBURSEMENT_EXCEPTION_EXPIRING', owner: 'CONTRACT_MANAGER' });
      expect(await asMember(READER, 'mine')).toEqual([]);
      expect(ids(await asMember(READER, 'scope'))).toEqual(ids(leader));
      expect(await asMember(READER, 'scope', { projectScope: NOTHING, unitScope: NOTHING })).toEqual([]);
    });

    it('PROJECT_GOVERNANCE: gives the alert of a milestone moved as often as the rule says to the reader who holds the right to read the alerts of the auditors, not to the leader of the project who does not, and not once it is acknowledged', async () => {
      const alert = (over: Record<string, unknown>): Promise<string> =>
        seed('project_governance_alert', { project_id: projectId, alert_type: 'RESCHEDULE_COUNT', audience: 'AUD', subject_kind: 'PROJECT', move_count: 3, threshold: 3, rule_version: 'built-in:1', status: 'OPEN', raised_by: memberId(OTHER), raised_at: '2027-10-14T03:00:00.000Z', ...over });
      const open = await alert({});
      await alert({ status: 'ACKNOWLEDGED', acknowledged_by: memberId(READER), acknowledged_at: NOW.toISOString(), acknowledge_note: 'Đã hỏi ban quản lý dự án' });
      await accountableFor(projectId, OTHER);
      const auditor = holding(['project.governance.alert.read', false]);
      for (const view of ['mine', 'scope'] as const) {
        const rows = await asMember(READER, view, { holds: auditor });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: open, kind: 'RESCHEDULE_COUNT', source: 'PROJECT_GOVERNANCE', severity: 'ACTION', target: { screen: 'PRJ-26', id: projectId } });
        expect(rows[0]?.consequence).toBe(CONSEQUENCES.RESCHEDULE_COUNT);
        expect(rows[0]?.alertType).toMatchObject({ code: 'RESCHEDULE_COUNT', owner: 'AUDITOR', responseHours: 168 });
        // The leader accountable for the project, who is not an auditor, does not have an alert that is for the auditors.
        expect(await asMember(OTHER, view)).toEqual([]);
      }
      // The place the auditor may not read hides it, and what an auditor gave to somebody is theirs.
      expect(await asMember(READER, 'scope', { holds: auditor, projectScope: NOTHING, unitScope: NOTHING })).toEqual([]);
      await as((tx) => actions.record(tx, { source: 'PROJECT_GOVERNANCE', sourceId: open, action: 'ASSIGN', actor: memberId(READER), assignee: memberId(STRANGER), dueOn: day(2) }));
      expect(ids(await asMember(STRANGER, 'mine'))).toEqual([open]);
    });

    it('names the source that fails and goes on with the others, for each of the new sources', async () => {
      const broken: Array<[table: string, column: string, source: string]> = [
        ['treasury_daily_recon_item', 'due_on', 'TREASURY_RECON'],
        ['cross_total_check', 'published', 'CROSS_TOTAL'],
        ['sod_exception', 'valid_to', 'SOD_EXCEPTION'],
        ['payment_integrity_run', 'outcome', 'PAYMENT_INTEGRITY'],
        ['disbursement_exception', 'valid_to', 'DISBURSEMENT_EXCEPTION'],
        ['project_governance_alert', 'status', 'PROJECT_GOVERNANCE'],
      ];
      for (const [table, column, source] of broken) {
        await admin([[`alter table machvon.${table} rename column ${column} to ${column}_moved`, []]]);
        try {
          const partial = await as((tx) => store.collect(tx, input({ view: 'scope', includeHidden: true })));
          expect(partial.unavailableSources).toEqual([source]);
          expect(partial.rows.map((row) => row.source)).toContain('EARLY_WARNING');
        } finally {
          await admin([[`alter table machvon.${table} rename column ${column}_moved to ${column}`, []]]);
        }
      }
      expect((await as((tx) => store.collect(tx, input({ view: 'scope', includeHidden: true })))).unavailableSources).toEqual([]);
    });
  });
});
