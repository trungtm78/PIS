import { randomUUID } from 'node:crypto';
import { builtInDefault } from '@machvon/kernel';
import { Client } from 'pg';
import { HomeWorkActionStore } from '../src/home-work-action-store';
import { CONSEQUENCES, DEFAULT_SEVERITY_RULES, SOURCE_OF_KIND, WORK_SOURCES } from '../src/home-work-rules';
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
const STRANGER = 3;
const NOW = new Date('2027-10-15T03:00:00Z');
const TODAY = '2027-10-15';
const EVERYTHING: ScopeBuilder = () => ({ sql: 'true', params: [] });
const NOTHING: ScopeBuilder = () => ({ sql: 'false', params: [] });
const onlyProject =
  (id: string): ScopeBuilder =>
  (first) => ({ sql: `p.id = $${first}::uuid`, params: [id] });

const as = <T>(work: (tx: Parameters<Parameters<typeof harness.tenants.withTenant>[1]>[0]) => Promise<T>, tenant = TENANT_A, member = READER): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const input = (over: Partial<WorkInput> = {}): WorkInput => ({ membershipId: memberId(READER), now: NOW, today: TODAY, unitScope: EVERYTHING, projectScope: EVERYTHING, view: 'scope', includeHidden: true, ...over });
const holding =
  (...held: Array<[permission: string, wholeTenant: boolean]>) =>
  (permission: string, wholeTenant = false): boolean =>
    held.some(([name, whole]) => name === permission && (!wholeTenant || whole));

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

const SOURCES = ['PROJECT_RISK', 'COMMITTEE'];
const ids = (rows: Array<{ id: string }>): string[] => rows.map((row) => row.id).sort();

/** HUBADAPT step 4: the alerts of the risk register (MR-1) and of the committee workspace (BAN-1) in the alert centre. */
describe('the sources PROJECT_RISK and COMMITTEE of the alert centre', () => {
  const projectA = randomUUID();
  const projectB = randomUUID();
  const projectOfB = randomUUID();
  const person = { created_by: memberId(READER), updated_by: memberId(READER) };

  const project = (tenant: string, id: string): Promise<void> =>
    admin([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, $3, $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B') on conflict do nothing`,
        [tenant, id, `P-${id.slice(0, 6)}`, unitId(NORTH), randomUUID()],
      ],
    ]);

  const riskAlert = (tenant: string, projectId: string, over: Record<string, unknown> = {}): Promise<string> =>
    seedRow(harness.database.adminUrl, 'project_risk_alert', tenant, {
      project_id: projectId,
      alert_type: 'RISK_SCORE_CRITICAL',
      subject_kind: 'SIGNAL',
      signal_id: randomUUID(),
      signal_kind: 'SCHEDULE_DELAY',
      score: 20,
      prior_score: 10,
      threshold: 16,
      rule_version: 'built-in:1',
      status: 'OPEN',
      raised_on: '2027-10-12',
      raised_by: memberId(READER),
      ...over,
    });

  const acknowledged = { status: 'ACKNOWLEDGED', acknowledged_by: memberId(OTHER), acknowledged_at: '2027-10-13T03:00:00.000Z', acknowledge_note: 'Seen' };

  const committeeAlert = (tenant: string, over: Record<string, unknown> = {}): Promise<string> =>
    seedRow(harness.database.adminUrl, 'committee_alert', tenant, {
      alert_type: 'COMMITTEE_PROVINCE_BEHIND',
      dedupe_key: `COMMITTEE_PROVINCE_BEHIND:PROVINCE:2027:${randomUUID().slice(0, 6)}`,
      subject_kind: 'PROVINCE',
      subject_key: 'PROVINCE',
      severity: 'ACTION',
      value: '37.20',
      threshold: '52.00',
      fiscal_year: 2027,
      status: 'OPEN',
      opened_on: '2027-10-10',
      last_seen_on: '2027-10-14',
      ...over,
    });

  const committeeAck = { status: 'ACKNOWLEDGED', acknowledged_by: memberId(OTHER), acknowledged_at: '2027-10-13T03:00:00.000Z', acknowledged_note: 'Seen' };

  const read = (over: Partial<WorkInput> = {}, tenant = TENANT_A, member = READER): Promise<WorkRow[]> =>
    as((tx) => store.collect(tx, input({ membershipId: memberId(member), ...over })), tenant, member).then((collected) => {
      expect(collected.unavailableSources).toEqual([]);
      return collected.rows.filter((row) => SOURCES.includes(row.source));
    });

  const wipe = (): Promise<void> => admin(['work_action', 'project_risk_alert', 'committee_alert', 'project_accountability'].map((table): [string, unknown[]] => [`delete from machvon.${table}`, []]));

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: NORTH, path: `/${unitId(ROOT)}/${unitId(NORTH)}/`, parent: ROOT },
      ]);
      for (const member of [READER, OTHER, STRANGER]) await harness.seedMembership(tenant, member, ROOT);
    }
    await project(TENANT_A, projectA);
    await project(TENANT_A, projectB);
    await project(TENANT_B, projectOfB);
  }, 300_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  beforeEach(wipe);

  describe('the declarations', () => {
    it('maps each kind to its source and gives it a consequence of its own and the severity facets of its source', () => {
      for (const kind of ['RISK_SCORE_CRITICAL', 'RISK_SCORE_JUMP'] as const) {
        expect(SOURCE_OF_KIND[kind]).toBe('PROJECT_RISK');
        expect(CONSEQUENCES[kind]).toBeTruthy();
      }
      for (const kind of ['COMMITTEE_PROVINCE_BEHIND', 'COMMITTEE_SECTOR_BEHIND', 'COMMITTEE_UNIT_NOT_REPORTING', 'COMMITTEE_DIRECTIVE_OVERDUE'] as const) {
        expect(SOURCE_OF_KIND[kind]).toBe('COMMITTEE');
        expect(CONSEQUENCES[kind]).toBeTruthy();
      }
      expect(DEFAULT_SEVERITY_RULES.PROJECT_RISK).toEqual({ CRITICAL: 'ACTION', JUMP: 'WATCH' });
      expect(DEFAULT_SEVERITY_RULES.COMMITTEE).toEqual({ URGENT: 'URGENT', ACTION: 'ACTION', WATCH: 'WATCH' });
    });

    it('is taken by the check on work_action.source: every source the alert centre reads can be decided about, and a made-up one cannot', async () => {
      const definition = await as((tx) =>
        tx.query<{ definition: string }>(`select pg_get_constraintdef(c.oid) as definition from pg_constraint c where c.conrelid = 'machvon.work_action'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%ADVANCE%' and pg_get_constraintdef(c.oid) like '%source%'`),
      );
      const text = definition[0]?.definition ?? '';
      expect(WORK_SOURCES.filter((source) => !text.includes(`'${source}'`))).toEqual([]);
      const refused: string[] = [];
      for (const source of ['PROJECT_RISK', 'COMMITTEE', 'CONTRACT_CLAIM', 'CONTRACT_EARLY_WARNING']) {
        await as((tx) => actions.record(tx, { source, sourceId: randomUUID(), action: 'CLAIM', actor: memberId(READER) } as never)).catch(() => refused.push(source));
      }
      expect(refused).toEqual([]);
      await expect(as((tx) => actions.record(tx, { source: 'NOT_A_SOURCE', sourceId: randomUUID(), action: 'CLAIM', actor: memberId(READER) } as never))).rejects.toThrow(/source/);
    });
  });

  describe('PROJECT_RISK', () => {
    it('lists an open alert and an acknowledged one, never a resolved one, with the severity, the target, the consequence and the type of the registry', async () => {
      const critical = await riskAlert(TENANT_A, projectA);
      const jump = await riskAlert(TENANT_A, projectA, { alert_type: 'RISK_SCORE_JUMP', subject_kind: 'REGISTER', signal_id: null, signal_kind: null, risk_id: randomUUID(), score: 12, prior_score: 4, threshold: 6 });
      const taken = await riskAlert(TENANT_A, projectB, acknowledged);
      const done = await riskAlert(TENANT_A, projectA, { status: 'RESOLVED', resolved_on: '2027-10-14' });
      const rows = await read();
      expect(ids(rows)).toEqual([critical, jump, taken].sort());
      expect(ids(rows)).not.toContain(done);
      const one = rows.find((row) => row.id === critical);
      expect(one).toMatchObject({ kind: 'RISK_SCORE_CRITICAL', source: 'PROJECT_RISK', severity: 'ACTION', lifecycle: 'NEW', dueOn: TODAY, originalDueOn: '2027-10-12', target: { screen: 'PRJ-28', id: projectA }, status: 'OPEN' });
      // The consequence is the one of the alert type in force (the registry), which is what the person reads.
      expect(one?.consequence).toBe(builtInDefault('ALERT_TYPE', 'RISK_SCORE_CRITICAL')?.params.consequence);
      expect(one?.title).toContain('20');
      expect(one?.alertType).toMatchObject({ code: 'RISK_SCORE_CRITICAL', owner: 'PROJECT_OWNER', responseHours: 72 });
      const rise = rows.find((row) => row.id === jump);
      expect(rise).toMatchObject({ kind: 'RISK_SCORE_JUMP', severity: 'WATCH', target: { screen: 'PRJ-28', id: projectA } });
      expect(rise?.title).toContain('8');
      expect(rise?.alertType).toMatchObject({ code: 'RISK_SCORE_JUMP', owner: 'PROJECT_OWNER', responseHours: 168 });
      // An alert somebody took in is taken up and has no day to meet.
      expect(rows.find((row) => row.id === taken)).toMatchObject({ lifecycle: 'CLAIMED', dueOn: null, status: 'ACKNOWLEDGED' });
    });

    it('gives only what the reader may read: nothing outside the scope of the projects, nothing of another tenant', async () => {
      const inA = await riskAlert(TENANT_A, projectA);
      const inB = await riskAlert(TENANT_A, projectB);
      const foreign = await riskAlert(TENANT_B, projectOfB);
      expect(await read({ projectScope: NOTHING })).toEqual([]);
      expect(ids(await read({ projectScope: onlyProject(projectB) }))).toEqual([inB]);
      expect(ids(await read())).toEqual([inA, inB].sort());
      expect(ids(await read({}, TENANT_B))).toEqual([foreign]);
    });

    it('gives, in the view mine, the alerts of the projects the reader answers for and the ones somebody handed to the reader', async () => {
      const own = await riskAlert(TENANT_A, projectA);
      const other = await riskAlert(TENANT_A, projectB);
      expect(await read({ view: 'mine' })).toEqual([]);
      await seedRow(harness.database.adminUrl, 'project_accountability', TENANT_A, { project_id: projectA, leader_membership_id: memberId(READER), accountability_role: 'LEADER_IN_CHARGE', valid_from: '2027-01-01', status: 'ACTIVE', ...person });
      expect(ids(await read({ view: 'mine' }))).toEqual([own]);
      await as((tx) => actions.record(tx, { source: 'PROJECT_RISK', sourceId: other, action: 'ASSIGN', actor: memberId(OTHER), assignee: memberId(READER), dueOn: '2027-10-20' }), TENANT_A, OTHER);
      expect(ids(await read({ view: 'mine' }))).toEqual([own, other].sort());
      expect(ids(await read({ view: 'mine' }, TENANT_A, STRANGER))).toEqual([]);
    });
  });

  describe('COMMITTEE', () => {
    const KINDS = [
      { alert_type: 'COMMITTEE_PROVINCE_BEHIND', subject_kind: 'PROVINCE', subject_key: 'PROVINCE', severity: 'URGENT', value: '30.00', threshold: '55.00' },
      { alert_type: 'COMMITTEE_SECTOR_BEHIND', subject_kind: 'SECTOR', subject_key: 'TRANSPORT', subject_label: 'Transport', severity: 'ACTION', value: '20.00', threshold: '40.00' },
      { alert_type: 'COMMITTEE_UNIT_NOT_REPORTING', subject_kind: 'UNIT', subject_key: randomUUID(), subject_label: 'Unit Alpha', severity: 'WATCH', value: '12', threshold: '7' },
      { alert_type: 'COMMITTEE_DIRECTIVE_OVERDUE', subject_kind: 'UNIT', subject_key: randomUUID(), subject_label: 'Unit Beta', severity: 'ACTION', value: '4', threshold: '3' },
    ];

    it('lists the open and acknowledged alerts of the four types to the committee, with the severity of the row, and not a resolved one', async () => {
      const made: Record<string, string> = {};
      for (const kind of KINDS) made[kind.alert_type] = await committeeAlert(TENANT_A, { ...kind, dedupe_key: `${kind.alert_type}:${kind.subject_key}:2027` });
      const taken = await committeeAlert(TENANT_A, { ...KINDS[1], subject_key: 'EDUCATION', subject_label: 'Education', dedupe_key: 'COMMITTEE_SECTOR_BEHIND:EDUCATION:2027', ...committeeAck });
      const done = await committeeAlert(TENANT_A, { ...KINDS[0], dedupe_key: 'COMMITTEE_PROVINCE_BEHIND:PROVINCE:2026', fiscal_year: 2026, status: 'RESOLVED', opened_on: '2027-09-01', last_seen_on: '2027-09-30', resolved_on: '2027-10-01' });
      const rows = await read({ holds: holding(['committee.read', true]) });
      expect(ids(rows)).toEqual([...Object.values(made), taken].sort());
      expect(ids(rows)).not.toContain(done);
      expect(rows.map((row) => [row.kind, row.source, row.severity]).sort()).toEqual(
        [
          ['COMMITTEE_PROVINCE_BEHIND', 'COMMITTEE', 'URGENT'],
          ['COMMITTEE_SECTOR_BEHIND', 'COMMITTEE', 'ACTION'],
          ['COMMITTEE_SECTOR_BEHIND', 'COMMITTEE', 'ACTION'],
          ['COMMITTEE_UNIT_NOT_REPORTING', 'COMMITTEE', 'WATCH'],
          ['COMMITTEE_DIRECTIVE_OVERDUE', 'COMMITTEE', 'ACTION'],
        ].sort(),
      );
      const province = rows.find((row) => row.id === made.COMMITTEE_PROVINCE_BEHIND);
      expect(province).toMatchObject({ lifecycle: 'NEW', dueOn: TODAY, originalDueOn: '2027-10-10', target: { screen: 'BAN-05', id: province?.id }, status: 'OPEN' });
      expect(province?.consequence).toBe(builtInDefault('ALERT_TYPE', 'COMMITTEE_PROVINCE_BEHIND')?.params.consequence);
      expect(province?.alertType).toMatchObject({ code: 'COMMITTEE_PROVINCE_BEHIND', owner: 'COMMITTEE_HEAD', responseHours: 72 });
      expect(rows.find((row) => row.id === made.COMMITTEE_UNIT_NOT_REPORTING)).toMatchObject({ title: expect.stringContaining('Unit Alpha'), alertType: expect.objectContaining({ owner: 'COMMITTEE_SECRETARIAT' }) });
      expect(rows.find((row) => row.id === made.COMMITTEE_DIRECTIVE_OVERDUE)?.title).toContain('Unit Beta');
      expect(rows.find((row) => row.id === taken)).toMatchObject({ lifecycle: 'CLAIMED', dueOn: null, status: 'ACKNOWLEDGED' });
    });

    it('says that a unit never reported in words of its own', async () => {
      const never = await committeeAlert(TENANT_A, { ...KINDS[2], value: null, severity: 'URGENT', dedupe_key: 'COMMITTEE_UNIT_NOT_REPORTING:never:2027' });
      const rows = await read({ holds: holding(['committee.read', true]) });
      const row = rows.find((candidate) => candidate.id === never);
      expect(row?.severity).toBe('URGENT');
      expect(row?.subtitle).not.toMatch(/undefined|null|NaN/);
      expect(row?.subtitle).toContain('7');
    });

    it('is for the committee: a reader without the permission on the whole tenant sees none, unless somebody handed one over', async () => {
      const first = await committeeAlert(TENANT_A, { ...KINDS[0], dedupe_key: 'COMMITTEE_PROVINCE_BEHIND:PROVINCE:2027' });
      await committeeAlert(TENANT_A, { ...KINDS[1], dedupe_key: 'COMMITTEE_SECTOR_BEHIND:TRANSPORT:2027' });
      expect(await read()).toEqual([]);
      expect(await read({ holds: holding(['committee.read', false]) })).toEqual([]);
      expect(await read({ holds: holding(['bid.egp.admin', true]) })).toEqual([]);
      expect(ids(await read({ holds: holding(['committee.read', true]), view: 'mine' }))).toHaveLength(2);
      await as((tx) => actions.record(tx, { source: 'COMMITTEE', sourceId: first, action: 'ASSIGN', actor: memberId(OTHER), assignee: memberId(STRANGER), dueOn: '2027-10-20' }), TENANT_A, OTHER);
      expect(ids(await read({}, TENANT_A, STRANGER))).toEqual([first]);
    });

    it('keeps one tenant from the alerts of another', async () => {
      const mine = await committeeAlert(TENANT_A, { ...KINDS[0], dedupe_key: 'COMMITTEE_PROVINCE_BEHIND:PROVINCE:2027' });
      const theirs = await committeeAlert(TENANT_B, { ...KINDS[0], dedupe_key: 'COMMITTEE_PROVINCE_BEHIND:PROVINCE:2027' });
      expect(ids(await read({ holds: holding(['committee.read', true]) }))).toEqual([mine]);
      expect(ids(await read({ holds: holding(['committee.read', true]) }, TENANT_B))).toEqual([theirs]);
    });
  });

  it('names a source that fails without losing the other one', async () => {
    await riskAlert(TENANT_A, projectA);
    const committee = await committeeAlert(TENANT_A);
    await admin([['alter table machvon.project_risk_alert rename column score to score_moved', []]]);
    try {
      const partial = await as((tx) => store.collect(tx, input({ holds: holding(['committee.read', true]) })));
      expect(partial.unavailableSources).toEqual(['PROJECT_RISK']);
      expect(partial.rows.filter((row) => row.source === 'COMMITTEE').map((row) => row.id)).toEqual([committee]);
    } finally {
      await admin([['alter table machvon.project_risk_alert rename column score_moved to score', []]]);
    }
  });
});
