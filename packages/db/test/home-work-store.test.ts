import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { HomeWorkActionStore } from '../src/home-work-action-store';
import { HomeWorkStore } from '../src/home-work-store';
import type { WorkInput } from '../src/home-work-store';
import type { ScopeBuilder } from '../src/scope-version';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

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
      as((tx) => actions.record(tx, { source: 'EARLY_WARNING', sourceId: warningId, action, actor: memberId(member), ...over }));

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
});
