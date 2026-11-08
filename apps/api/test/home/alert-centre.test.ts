import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { homeModule } from '../../src/modules/home';
import { MyWorkController } from '../../src/modules/home/my-work.controller';
import { HOME_CLOCK } from '../../src/modules/home/tokens';
import { WorkActionController } from '../../src/modules/home/work-action.controller';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(180_000);

const SIGNING_KEY = randomBytes(32);
const LEADER = 1; // reads the whole tenant and may acknowledge warnings and advances
const MAKER = 2; // a member of the north who answers for the project P1
const OTHER = 3; // a member of the south
const NOBODY = 4; // holds no right to read HOME
const AUDITOR = 5; // reads the whole tenant and holds the rights the auditors read their alerts with
const ADMIN = 6; // reads the whole tenant and administers the exceptions to the separation of duties
const B_LEADER = 1;
const ROOT = 1;
const NORTH = 2;
const SOUTH = 3;
const NOW = new Date('2027-10-15T03:00:00Z');
const TODAY = '2027-10-15';

interface Reply {
  status: number;
  json: Record<string, unknown>;
  headers: Headers;
}
interface Item {
  id: string;
  kind: string;
  source: string;
  severity: string;
  title: string;
  subtitle: string | null;
  lifecycle: string;
  due_on: string | null;
  claimed_by: { id: string; name: string; at: string } | null;
  assignee: { id: string; name: string; due_on: string | null } | null;
  escalation: { level: number; of: number; next_at: string | null; chain: string[] } | null;
  consequence: string | null;
  snoozed_until: string | null;
  target: { screen: string; id: string };
  snooze: { by: { id: string; name: string }; until: string; reason_code: string | null; ordinal: number | null; of: number | null; final: boolean; policy_version: string | null } | null;
  snooze_count: number;
}
interface Counts {
  urgent: number;
  action: number;
  watch: number;
  total: number;
}

const day = (offset: number): string => new Date(Date.parse(`${TODAY}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
const at = (offset: number, time = '05:00:00'): string => `${day(offset)}T${time}.000Z`;

/** The alert centre over HTTP: one list of what the modules ask for, by severity, in two views, with the three decisions a person takes about an item (HOME, "Cần xử lý ngay"). */
describe('the alert centre over HTTP', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method === 'POST') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown>, headers: response.headers };
  }
  const list = (query = '', member = LEADER, tenantId?: string): Promise<Reply> => call('GET', `/home/my-work${query}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });
  const counted = (query = '', member = LEADER, tenantId?: string): Promise<Reply> => call('GET', `/home/my-work/counts${query}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });
  const items = (reply: Reply): Item[] => reply.json.items as Item[];
  const bySource = (reply: Reply, source: string): Item[] => items(reply).filter((item) => item.source === source);
  const act = (action: 'claim' | 'assign' | 'snooze', body: Record<string, unknown>, member = LEADER, key?: string): Promise<Reply> => call('POST', `/home/work-actions/${action}`, { member, body, ...(key === undefined ? {} : { key }) });
  const rows = <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

  /** Runs statements as the administrator with the checks of the foreign keys and the guards of the modules off: a record is seeded as it stands, not as a command would have made it. */
  async function admin(work: (client: Client) => Promise<void>): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      await work(client);
    } finally {
      await client.end();
    }
  }
  /** Inserts a row, giving the columns that the table needs and the test does not care about a value of their type (a column that has a default or is computed is left to it). */
  async function insert(table: string, values: Record<string, unknown>, tenant = TENANT_A): Promise<string> {
    const rowId = (values.id as string | undefined) ?? randomUUID();
    await admin(async (client) => {
      const columns = (
        await client.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null; is_generated: string }>(
          `select column_name, data_type, is_nullable, column_default, is_generated from information_schema.columns where table_schema = 'machvon' and table_name = $1`,
          [table],
        )
      ).rows;
      const all: Record<string, unknown> = { tenant_id: tenant, id: rowId, ...values };
      const json = new Set(columns.filter((column) => column.data_type === 'jsonb').map((column) => column.column_name));
      for (const column of columns) {
        if (column.column_name in all || column.is_generated === 'ALWAYS' || column.is_nullable === 'YES' || column.column_default !== null) continue;
        all[column.column_name] =
          column.data_type === 'uuid' ? randomUUID() : ['integer', 'smallint', 'bigint', 'numeric'].includes(column.data_type) ? 1 : column.data_type === 'boolean' ? false : column.data_type === 'date' ? TODAY : column.data_type.startsWith('timestamp') ? NOW.toISOString() : column.data_type === 'jsonb' ? {} : column.data_type === 'ARRAY' ? [] : column.data_type === 'character' ? 'VND' : 'text-value';
      }
      const names = Object.keys(all);
      const params = names.map((name) => {
        const value = all[name];
        return json.has(name) || (typeof value === 'object' && value !== null && !Array.isArray(value)) ? JSON.stringify(value) : value;
      });
      await client.query(`insert into machvon.${table} (${names.map((name) => `"${name}"`).join(', ')}) values (${names.map((_, index) => `$${index + 1}`).join(', ')})`, params);
    });
    return rowId;
  }
  const wipe = (): Promise<void> =>
    admin(async (client) => {
      for (const table of ['work_reminder', 'work_clock', 'work_action', 'early_warning', 'early_warning_rule', 'contract_advance', 'contract_party', 'guarantee', 'permit', 'permit_dossier', 'permit_type', 'audit_recommendation', 'issue_escalation', 'issue', 'site_diary', 'treasury_daily_recon_item', 'cross_total_check', 'period_snapshot', 'sod_exception_use', 'sod_exception', 'payment_integrity_run', 'disbursement_exception', 'payment_request', 'project_governance_alert', 'project_accountability', 'contract', 'work_calendar_version', 'project']) {
        await client.query(`delete from machvon.${table}`);
      }
    });

  async function project(unit: number, code: string, tenant = TENANT_A): Promise<string> {
    return insert('project', { code, name: code, owner_unit_id: unitId(unit), classification: 'INTERNAL', total_investment_vnd: 1000, status: 'IMPLEMENTATION', version: 1, project_group: 'B' }, tenant);
  }
  // A contract that started long ago and has no early warning yet is late for the register of CTR (EW_REGISTER_OVERDUE); the tests that are not about the register start theirs yesterday.
  const contract = (projectId: string, code: string, status = 'ACTIVE', startedOn = day(-200)): Promise<string> => insert('contract', { code, project_id: projectId, status, signed_on: day(-200), effective_from: startedOn, type: 'LUMP_SUM', contract_value_vnd: 1000 });
  async function rule(severity: string, code: string, tenant = TENANT_A): Promise<string> {
    return insert('early_warning_rule', { rule_code: code, name: `Rule ${code}`, metric_code: 'YTD_RATE_GAP', comparator: 'GTE', threshold_json: { points: 10 }, severity, scope_kind: 'PROJECT', status: 'PUBLISHED', revision: 1, effective_from: '2027-01-01', approved_by: memberId(MAKER), created_by: memberId(LEADER), version: 1 }, tenant);
  }
  async function warning(projectId: string, severity: string, status = 'OPEN', tenant = TENANT_A): Promise<string> {
    const ruleId = await rule(severity, `EW-${randomUUID().slice(0, 6).toUpperCase()}`, tenant);
    return insert('early_warning', { rule_id: ruleId, project_id: projectId, severity, observed_json: {}, dedupe_key: `k-${randomUUID()}`, status, opened_at: NOW.toISOString(), ...(status === 'EXPLANATION_REQUESTED' ? { explanation_request_id: randomUUID() } : {}), ...(status === 'RESOLVED' || status === 'DISMISSED' ? { resolution_reason: 'Done', closed_at: NOW.toISOString() } : {}), version: 1 }, tenant);
  }
  async function advance(contractId: string, options: { paid: number; recovered: number; status: string; overdueSince: string | null; level: number }): Promise<string> {
    const party = await insert('contract_party', { contract_id: contractId, role: 'MEMBER', share_pct: 10, work_value_vnd: 1000, status: 'ACTIVE', valid_from: day(-200), created_by: memberId(LEADER), updated_by: memberId(LEADER) });
    return insert('contract_advance', { contract_id: contractId, party_id: party, kind: 'CONTRACT', guarantee_id: randomUUID(), amount_vnd: options.paid > 0 ? options.paid : 100, cap_vnd: 1000, status: options.status, paid_on: day(-60), paid_vnd: options.paid, recovered_vnd: options.recovered, overdue_since: options.overdueSince, last_alert_level: options.level, version: 1 });
  }
  async function permit(projectId: string, options: { status: string; validUntil: string | null }): Promise<string> {
    const type = await insert('permit_type', { code: `PT_${randomUUID().slice(0, 6).toUpperCase()}`, name: 'Giấy phép môi trường', category: 'OTHER', revision: 1 });
    const dossier = await insert('permit_dossier', { project_id: projectId, project_component_id: randomUUID(), owner_unit_id: unitId(NORTH), status: 'OPEN' });
    return insert('permit', { dossier_id: dossier, permit_type_id: type, permit_no: `GP-${randomUUID().slice(0, 6)}`, status: options.status, issued_on: day(-300), valid_from: day(-300), valid_until: options.validUntil, no_expiry: false, document_version_id: randomUUID(), version: 1 });
  }
  async function recommendation(projectId: string | null, options: { due: string; status?: string; unit?: number; owner?: number }): Promise<string> {
    return insert('audit_recommendation', {
      rec_code: `KN-${randomUUID().slice(0, 5)}`,
      rec_type: 'PROCESS_CORRECTION',
      description: 'Complete the correction',
      project_id: projectId,
      owner_unit_id: unitId(options.unit ?? NORTH),
      owner_user_id: options.owner === undefined ? null : memberId(options.owner),
      due_on: options.due,
      status: options.status ?? 'OPEN',
      ...(options.status === 'CLOSED' ? { verified_by: memberId(LEADER), verified_at: NOW.toISOString() } : {}),
      version: 1,
    });
  }
  async function issue(projectId: string, options: { level: number; overdue: boolean; assignee?: number; sourceRef?: string; sourceModule?: string }): Promise<string> {
    return insert('issue', {
      code: `VM-2027-${String(Math.floor(Math.random() * 900000) + 100000)}`,
      title: 'Cracked slab',
      description: 'The slab of the second floor has a crack.',
      opened_at: at(-10),
      response_due_at: at(-9),
      severity: 'HIGH',
      status: 'IN_PROGRESS',
      project_id: projectId,
      owner_unit_id: unitId(NORTH),
      assignee_id: memberId(options.assignee ?? LEADER),
      reported_by: memberId(LEADER),
      due_at: at(-3),
      overdue_since: options.overdue ? at(-3) : null,
      escalation_level: options.level,
      sla_policy_id: randomUUID(),
      source_module: options.sourceModule ?? 'MANUAL',
      source_ref_id: options.sourceRef ?? null,
      version: 1,
    });
  }
  async function guarantee(contractId: string, daysLeft: number): Promise<string> {
    return insert('guarantee', { contract_id: contractId, kind: 'PERFORMANCE', issuer: 'Bank', amount_vnd: 100, expires_at: at(daysLeft, '12:00:00'), valid_from: day(-100), verification_status: 'VERIFIED', verified_by: memberId(MAKER), verified_at: NOW.toISOString(), verification_method: 'ORIGINAL', verification_evidence_id: randomUUID(), created_by: memberId(LEADER), status: 'ACTIVE', version: 1 });
  }
  async function calendars(): Promise<void> {
    for (const year of [2026, 2027, 2028]) {
      await insert('work_calendar_version', { calendar_code: 'WORKDAY_VN', year, revision: 1, working_days: [1, 2, 3, 4, 5], holidays: [], compensated_workdays: [], legal_basis_ref: 'Labour Code 2019, Article 112', status: 'Published', created_by: memberId(LEADER), published_by: memberId(LEADER), published_at: NOW.toISOString() });
    }
  }
  const accountable = (projectId: string, member: number): Promise<string> => insert('project_accountability', { project_id: projectId, leader_membership_id: memberId(member), accountability_role: 'LEADER_IN_CHARGE', valid_from: '2027-01-01', status: 'ACTIVE', created_by: memberId(LEADER), updated_by: memberId(LEADER) });

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: NORTH, path: `/${unitId(ROOT)}/${unitId(NORTH)}/`, parent: ROOT },
        { n: SOUTH, path: `/${unitId(ROOT)}/${unitId(SOUTH)}/`, parent: ROOT },
      ]);
    }
    await harness.seedMembership(TENANT_A, LEADER, ROOT);
    await harness.seedMembership(TENANT_A, MAKER, NORTH);
    await harness.seedMembership(TENANT_A, OTHER, SOUTH);
    await harness.seedMembership(TENANT_A, NOBODY, NORTH);
    await harness.seedMembership(TENANT_A, AUDITOR, ROOT);
    await harness.seedMembership(TENANT_A, ADMIN, ROOT);
    await harness.seedMembership(TENANT_B, B_LEADER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'HOME_LEADER', ['home.read', 'warning.handle', 'advance.alert.ack', 'advance.read'], 20);
    await harness.seedRole(TENANT_A, 2, 'HOME_READER', ['home.read'], 20);
    await harness.seedRole(TENANT_A, 3, 'INTEGRITY_AUDITOR', ['home.read', 'aud.sod.read', 'project.governance.alert.read', 'disbursement.control.read'], 20);
    await harness.seedRole(TENANT_A, 4, 'INTEGRITY_ADMIN', ['home.read', 'adm.sod.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'HOME_LEADER', ['home.read', 'warning.handle'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: LEADER, role: 1, kind: 'TENANT' },
      { n: 2, member: MAKER, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(NORTH)] },
      { n: 3, member: OTHER, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(SOUTH)] },
      { n: 4, member: AUDITOR, role: 3, kind: 'TENANT' },
      { n: 5, member: ADMIN, role: 4, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_LEADER, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [MyWorkController, WorkActionController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: HOME_CLOCK, useValue: () => NOW },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  beforeEach(wipe);

  it('serves the commands of the alert centre in the module of HOME', () => {
    expect(homeModule.controllers).toContain(WorkActionController);
  });

  describe('what each module raises, and how urgent it is', () => {
    it('gives the early warnings by their colour: red is urgent, amber is to be acted on, information is to be watched, and closed ones are not given', async () => {
      const p = await project(NORTH, 'P-EW');
      const red = await warning(p, 'CRITICAL');
      const amber = await warning(p, 'WARNING', 'ACKNOWLEDGED');
      const info = await warning(p, 'INFO', 'EXPLANATION_REQUESTED');
      await warning(p, 'CRITICAL', 'RESOLVED');
      await warning(p, 'CRITICAL', 'DISMISSED');
      const reply = await list('?view=scope');
      expect(reply.status).toBe(200);
      const found = bySource(reply, 'EARLY_WARNING');
      expect(found.map((item) => [item.id, item.severity, item.lifecycle]).sort()).toEqual(
        [
          [red, 'URGENT', 'NEW'],
          [amber, 'ACTION', 'CLAIMED'],
          [info, 'WATCH', 'IN_PROGRESS'],
        ].sort(),
      );
      expect(found[0]).toMatchObject({ kind: 'EARLY_WARNING', subtitle: 'P-EW', target: { screen: 'HOME-06' }, consequence: expect.stringContaining('Cảnh báo') });
    });

    it('gives an advance that is overdue and still owed (to be acted on, with where it stands on its way up), and not one that was recovered', async () => {
      const p = await project(NORTH, 'P-ADV');
      const c = await contract(p, 'C-ADV');
      const owed = await advance(c, { paid: 100, recovered: 0, status: 'PAID', overdueSince: day(-3), level: 3 });
      await advance(c, { paid: 100, recovered: 100, status: 'FULLY_RECOVERED', overdueSince: day(-30), level: 4 });
      await advance(c, { paid: 100, recovered: 0, status: 'PAID', overdueSince: null, level: 0 });
      const found = bySource(await list('?view=scope'), 'ADVANCE');
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ id: owed, severity: 'ACTION', kind: 'ADVANCE_OVERDUE', due_on: day(-3), target: { screen: 'PAY-12', id: owed }, escalation: { level: 2, of: 3, next_at: null } });
      // An item that is overdue shows the chain of the rule of the escalation (GOV-9): the owner and the levels of its severity, the first one reached at once.
      expect(found[0]?.escalation?.chain).toHaveLength(3);
    });

    it('gives a permit that has expired as urgent and one that ends within 30 days as to be watched, and not one that ends later', async () => {
      const p = await project(NORTH, 'P-PMT');
      const expired = await permit(p, { status: 'EXPIRED', validUntil: day(-2) });
      const ending = await permit(p, { status: 'ISSUED', validUntil: day(10) });
      await permit(p, { status: 'ISSUED', validUntil: day(90) });
      const found = bySource(await list('?view=scope'), 'PERMIT');
      expect(found.map((item) => [item.id, item.severity]).sort()).toEqual([[expired, 'URGENT'], [ending, 'WATCH']].sort());
      expect(found.find((item) => item.id === expired)).toMatchObject({ escalation: { level: 2, of: 4, next_at: null }, consequence: expect.stringContaining('hết hạn') });
      expect(found.find((item) => item.id === ending)?.escalation).toMatchObject({ level: 3, of: 4, next_at: day(10) });
    });

    it('gives a recommendation of an audit that is late: to be acted on, and urgent once it was raised to the leader a month after its day', async () => {
      const p = await project(NORTH, 'P-AUD');
      const late = await recommendation(p, { due: day(-10) });
      const escalated = await recommendation(p, { due: day(-40), status: 'IN_PROGRESS' });
      await recommendation(p, { due: day(5) });
      await recommendation(p, { due: day(-40), status: 'CLOSED' });
      const found = bySource(await list('?view=scope'), 'AUDIT_RECOMMENDATION');
      expect(found.map((item) => [item.id, item.severity]).sort()).toEqual([[late, 'ACTION'], [escalated, 'URGENT']].sort());
      expect(found.find((item) => item.id === escalated)?.escalation).toMatchObject({ level: 2, of: 4, next_at: null });
      expect(found.find((item) => item.id === late)?.escalation).toMatchObject({ level: 2, of: 3, next_at: null });
    });

    it('gives an issue that missed the SLA by the level it was raised to: level 3 is urgent, levels 1 and 2 are to be acted on, and one that is on time is not given', async () => {
      const p = await project(NORTH, 'P-ISS');
      const first = await issue(p, { level: 0, overdue: true });
      const second = await issue(p, { level: 2, overdue: true });
      const third = await issue(p, { level: 3, overdue: true });
      await issue(p, { level: 0, overdue: false });
      const found = bySource(await list('?view=scope'), 'ISSUE');
      expect(found.map((item) => [item.id, item.severity, item.escalation?.level]).sort()).toEqual([[first, 'ACTION', 2], [second, 'ACTION', 2], [third, 'URGENT', 2]].sort());
      expect(found.find((item) => item.id === third)).toMatchObject({ due_on: day(-3), escalation: { of: 4 }, target: { screen: 'ISS-03' } });
      expect(found.find((item) => item.id === third)?.escalation?.chain).toHaveLength(4);
    });

    it('gives a guarantee that ends within 30 days (to be watched, and to be acted on in the last week) and not one that ends later', async () => {
      const p = await project(NORTH, 'P-GUA');
      const c = await contract(p, 'C-GUA');
      const soon = await guarantee(c, 5);
      const month = await guarantee(c, 20);
      await guarantee(c, 90);
      const found = bySource(await list('?view=scope'), 'GUARANTEE');
      expect(found.map((item) => [item.id, item.severity]).sort()).toEqual([[soon, 'ACTION'], [month, 'WATCH']].sort());
      expect(found.find((item) => item.id === soon)?.escalation).toMatchObject({ level: 3, of: 4, next_at: day(5) });
    });

    it('folds the contracts that miss their diaries into one item that says how many projects, and gives none when the diaries are there', async () => {
      await calendars();
      const p1 = await project(NORTH, 'P-D1');
      const p2 = await project(SOUTH, 'P-D2');
      await contract(p1, 'C-D1');
      await contract(p2, 'C-D2');
      await contract(p2, 'C-D3', 'DRAFT');
      const reply = await list('?view=scope');
      const found = bySource(reply, 'SITE_DIARY');
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ id: 'site-diary:2027-10', severity: 'WATCH', kind: 'SITE_DIARY_MISSING', title: '2 dự án thiếu nhật ký công trường', target: { screen: 'QMS-11' } });
      expect(reply.json.unavailable_sources).toEqual([]);
      // The north alone: one project, said by name.
      const north = bySource(await list('?view=scope', MAKER), 'SITE_DIARY');
      expect(north).toHaveLength(1);
      expect(north[0]?.title).toContain('P-D1');
    });

    it('counts the same items as it lists, by severity, in both views', async () => {
      await calendars();
      const p = await project(NORTH, 'P-ALL');
      const c = await contract(p, 'C-ALL');
      await accountable(p, MAKER);
      await warning(p, 'CRITICAL');
      await warning(p, 'WARNING');
      await advance(c, { paid: 100, recovered: 0, status: 'PAID', overdueSince: day(-3), level: 3 });
      await permit(p, { status: 'EXPIRED', validUntil: day(-2) });
      await guarantee(c, 20);
      await issue(p, { level: 3, overdue: true });
      for (const [view, member] of [['scope', LEADER], ['mine', MAKER], ['scope', MAKER]] as const) {
        const full = await list(`?view=${view}`, member);
        const head = await counted(`?view=${view}`, member);
        const expected: Counts = { urgent: 0, action: 0, watch: 0, total: 0 };
        for (const item of items(full)) {
          expected[item.severity === 'URGENT' ? 'urgent' : item.severity === 'ACTION' ? 'action' : 'watch'] += 1;
          expected.total += 1;
        }
        expect(head.status).toBe(200);
        expect(head.json).toMatchObject({ view, counts: expected, unavailable_sources: [], as_of: NOW.toISOString() });
        expect(full.json.counts).toMatchObject({ urgent: expected.urgent, action: expected.action, watch: expected.watch, total: expected.total });
        expect(expected.total).toBeGreaterThan(0);
      }
    });

    it('lists the urgent items first, then the others, and pages in that order', async () => {
      const p = await project(NORTH, 'P-ORD');
      const watch = await warning(p, 'INFO');
      const action = await warning(p, 'WARNING');
      const urgent = await warning(p, 'CRITICAL');
      const first = await list('?view=scope&limit=2');
      expect(items(first).map((item) => item.id)).toEqual([urgent, action]);
      const second = await list(`?view=scope&limit=2&cursor=${first.json.next_cursor as string}`);
      expect(items(second).map((item) => item.id)).toEqual([watch]);
      expect(second.json.next_cursor).toBeNull();
    });
  });

  describe('whose work it is', () => {
    it('gives a person in the view mine what they answer for or were given, and in the view scope everything they may read, and never a place outside it', async () => {
      const north = await project(NORTH, 'P-N');
      const south = await project(SOUTH, 'P-S');
      await accountable(north, MAKER);
      const mineWarning = await warning(north, 'CRITICAL');
      const otherWarning = await warning(south, 'CRITICAL');
      const northPermit = await permit(north, { status: 'EXPIRED', validUntil: day(-1) });
      const makerMine = items(await list('?view=mine', MAKER)).map((item) => item.id);
      expect(makerMine.sort()).toEqual([mineWarning, northPermit].sort());
      // Not accountable for anything: the view mine is empty, the view scope is the place they may read.
      expect(items(await list('?view=mine', OTHER))).toEqual([]);
      expect(items(await list('?view=scope', OTHER)).map((item) => item.id)).toEqual([otherWarning]);
      expect(items(await list('?view=scope', MAKER)).map((item) => item.id).sort()).toEqual([mineWarning, northPermit].sort());
      expect(items(await list('?view=scope', LEADER))).toHaveLength(3);
      // The default view is mine.
      expect((await list('', OTHER)).json.view).toBe('mine');
    });

    it('gives a recommendation to the person it was given to, and an issue to its assignee, in the view mine', async () => {
      const north = await project(NORTH, 'P-OWN');
      const rec = await recommendation(north, { due: day(-5), owner: MAKER });
      const iss = await issue(north, { level: 1, overdue: true, assignee: MAKER });
      await recommendation(north, { due: day(-5), owner: LEADER });
      const mine = items(await list('?view=mine', MAKER)).map((item) => item.id);
      expect(mine.sort()).toEqual([rec, iss].sort());
    });

    it('never gives the work of another tenant, in either view or in the counts', async () => {
      const a = await project(NORTH, 'P-A');
      await warning(a, 'CRITICAL');
      const b = await project(NORTH, 'P-B', TENANT_B);
      const other = await warning(b, 'CRITICAL', 'OPEN', TENANT_B);
      for (const view of ['mine', 'scope']) {
        const theirs = await list(`?view=${view}`, B_LEADER, TENANT_B);
        expect(items(theirs).map((item) => item.id)).toEqual(view === 'scope' ? [other] : []);
        expect(JSON.stringify(theirs.json)).not.toContain('P-A');
      }
      expect((await counted('?view=scope', B_LEADER, TENANT_B)).json).toMatchObject({ counts: { urgent: 1, total: 1 } });
      expect(items(await list('?view=scope')).map((item) => item.id)).not.toContain(other);
    });

    it('refuses a member who may not read HOME in both views (403), and a view that is not one (422)', async () => {
      for (const path of ['/home/my-work', '/home/my-work?view=scope', '/home/my-work/counts', '/home/my-work/counts?view=scope']) {
        expect([path, (await call('GET', path, { member: NOBODY })).status]).toEqual([path, 403]);
      }
      const bad = await list('?view=everyone');
      expect([bad.status, bad.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      expect((await counted('?view=everyone')).status).toBe(422);
    });
  });

  describe('a source that fails', () => {
    it('is named and the others go on: a calendar that is not published makes the diaries unavailable and nothing else', async () => {
      const p = await project(NORTH, 'P-PART');
      await contract(p, 'C-PART', 'ACTIVE', day(-1));
      const w = await warning(p, 'CRITICAL');
      const reply = await list('?view=scope');
      expect(reply.status).toBe(200);
      expect(reply.json.unavailable_sources).toEqual(['SITE_DIARY']);
      expect(items(reply).map((item) => item.id)).toEqual([w]);
      const head = await counted('?view=scope');
      expect(head.json).toMatchObject({ counts: { urgent: 1, total: 1 }, unavailable_sources: ['SITE_DIARY'] });
    });

    it('is named when its own statement fails, and the transaction goes on for the others', async () => {
      const p = await project(NORTH, 'P-SQL');
      const c = await contract(p, 'C-SQL', 'ACTIVE', day(-1));
      await guarantee(c, 5);
      const w = await warning(p, 'CRITICAL');
      await admin(async (client) => void (await client.query('alter table machvon.guarantee rename column kind to kind_moved')));
      try {
        const reply = await list('?view=scope');
        expect(reply.status).toBe(200);
        expect((reply.json.unavailable_sources as string[]).includes('GUARANTEE')).toBe(true);
        expect(items(reply).map((item) => item.id)).toEqual([w]);
        expect((await counted('?view=scope')).json).toMatchObject({ counts: { urgent: 1, total: 1 } });
      } finally {
        await admin(async (client) => void (await client.query('alter table machvon.guarantee rename column kind_moved to kind')));
      }
      expect(bySource(await list('?view=scope'), 'GUARANTEE')).toHaveLength(1);
    });
  });

  describe('the integrity of the money and of the duties, and the alert of the baseline', () => {
    const person = { created_by: memberId(LEADER), updated_by: memberId(LEADER) };

    /** One of every new source, in the project of the north: the item of the Treasury is owned by OTHER, the exception of the duties is of OTHER, the request that a check blocked was drawn up by MAKER. */
    async function seedIntegrity(): Promise<{ project: string; recon: string; snapshot: string; sodExpiring: string; sodUsed: string; blocked: string; signalled: string; lapsing: string; alert: string }> {
      // The contract is in execution: the diaries are counted on a published calendar.
      await calendars();
      const p = await project(NORTH, 'P-INT');
      const c = await contract(p, 'C-INT', 'ACTIVE', day(-1));
      await accountable(p, MAKER);
      const recon = await insert('treasury_daily_recon_item', { project_id: p, fund_key: 'NSTW', recon_date: day(-3), kind: 'AMOUNT', books_vnd: 100, treasury_vnd: 150, latest_difference_vnd: 50, owner_membership_id: memberId(OTHER), due_on: day(-1), status: 'OPEN', ...person });
      const snapshot = await insert('period_snapshot', { snapshot_kind: 'ADHOC', status: 'BUILDING', definition_status: 'SIGNED', metric_set_version: 'v1', period_id: randomUUID(), as_of_date: TODAY, treasury_cutoff_date: TODAY, ...person });
      await insert('cross_total_check', { snapshot_id: snapshot, fiscal_year: 2027, treasury_cutoff_date: TODAY, published: false, total_unit_vnd: 100, total_fund_vnd: 100, total_project_vnd: 90, disagreeing: ['PROJECT'], agreeing: ['UNIT', 'FUND'], origin: 'MANUAL', created_by: memberId(LEADER) });
      const exception = await insert('sod_exception', {
        action_a: 'contract.draft',
        action_b: 'contract.approve',
        scope: 'SAME_CONTRACT',
        subject_id: randomUUID(),
        member_id: memberId(OTHER),
        requested_by: memberId(LEADER),
        reason: 'Thiếu người thay thế trong tuần này',
        valid_from: day(-2),
        valid_to: day(3),
        rule_version: 0,
        approvers_needed: 2,
        approvals: 2,
        status: 'APPROVED',
        decided_at: NOW.toISOString(),
      });
      await insert('sod_exception_use', { outcome: 'EXCEPTION_USED', exception_id: exception, action_a: 'contract.draft', action_b: 'contract.approve', scope: 'SAME_CONTRACT', subject_id: randomUUID(), member_id: memberId(OTHER), taking: 'contract.approve', command: 'activateContract', record_id: randomUUID(), rule_version: 0, used_at: NOW.toISOString() });
      const request = (status: string, by: number): Promise<string> =>
        insert('payment_request', { project_id: p, contract_id: c, status, request_no: `PR-${randomUUID().slice(0, 6)}`, created_by: memberId(by), acceptance_id: randomUUID(), gross_vnd: 100, advance_recovery_vnd: 0, retention_vnd: 0, tax_adjustment_vnd: 0, net_vnd: 100, claims_acceptance: status !== 'DRAFT', version: 1 });
      const run = (requestId: string, over: Record<string, unknown>): Promise<string> =>
        insert('payment_integrity_run', { payment_request_id: requestId, contract_id: c, project_id: p, trigger_kind: 'PREVIEW', rule_version: 0, rule_source: 'DEFAULT', rule_unverified: true, as_of: TODAY, created_by: memberId(LEADER), created_at: at(-1), excused_count: 0, ...over });
      const blocked = await request('DRAFT', MAKER);
      await run(blocked, { outcome: 'BLOCKED', invariant_count: 1, signal_count: 0 });
      const signalled = await request('SUBMITTED', MAKER);
      await run(signalled, { trigger_kind: 'SUBMIT', outcome: 'SIGNALS', invariant_count: 0, signal_count: 2 });
      const lapsing = await insert('disbursement_exception', { payment_request_id: await request('SUBMITTED', MAKER), contract_id: c, project_id: p, ceiling: 'EXCEEDS_PLAN', allowed_amount_vnd: 10, valid_to: day(2), reason: 'Chờ điều chỉnh kế hoạch vốn', status: 'APPROVED', requested_by: memberId(LEADER), decided_by: memberId(OTHER), decided_at: NOW.toISOString(), requested_at: at(-30) });
      const alert = await insert('project_governance_alert', { project_id: p, alert_type: 'RESCHEDULE_COUNT', audience: 'AUD', subject_kind: 'PROJECT', move_count: 3, threshold: 3, rule_version: 'built-in:1', status: 'OPEN', raised_by: memberId(MAKER), raised_at: at(-1) });
      return { project: p, recon, snapshot, sodExpiring: exception, sodUsed: `used:${exception}`, blocked: `blocked:${blocked}`, signalled: `signal:${signalled}`, lapsing, alert };
    }

    it('gives each item to the role it is for: the auditors have the exceptions that were used, the baseline alert and the cross-total; the administrator has the exceptions that end; the leader of the project and the reader of the whole tenant have the ones of the money', async () => {
      const seeded = await seedIntegrity();
      // The contract of the project is in execution and has no diaries, which is another source's business.
      const kinds = (reply: Reply): string[] => items(reply).map((item) => item.kind).filter((kind) => kind !== 'SITE_DIARY_MISSING').sort();
      const moneyOfTheProject = ['PAYMENT_INTEGRITY_BLOCKED', 'PAYMENT_INTEGRITY_SIGNAL', 'DISBURSEMENT_EXCEPTION_EXPIRING', 'TREASURY_RECON_ITEM_OVERDUE'];
      // The auditor: the three that are for the auditors, and what the whole tenant is read for in the view scope.
      const auditorScope = await list('?view=scope', AUDITOR);
      expect(auditorScope.status).toBe(200);
      expect(kinds(auditorScope)).toEqual(['CROSS_TOTAL_MISMATCH', 'RESCHEDULE_COUNT', 'SOD_EXCEPTION_USED', ...moneyOfTheProject].sort());
      const auditorMine = await list('?view=mine', AUDITOR);
      expect(kinds(auditorMine)).toEqual(['CROSS_TOTAL_MISMATCH', 'RESCHEDULE_COUNT', 'SOD_EXCEPTION_USED']);
      // The administrator of the duties: only the exception that ends (and, in the view scope, what the scope shows).
      expect(kinds(await list('?view=mine', ADMIN))).toEqual(['SOD_EXCEPTION_EXPIRING']);
      expect(kinds(await list('?view=scope', ADMIN))).toEqual(['SOD_EXCEPTION_EXPIRING', ...moneyOfTheProject].sort());
      // Who is not the auditor or the administrator never has the three that are for them, in any view, whatever they read.
      for (const [view, member] of [['scope', LEADER], ['mine', MAKER], ['scope', MAKER], ['scope', OTHER]] as const) {
        const reply = await list(`?view=${view}`, member);
        expect(kinds(reply).filter((kind) => ['CROSS_TOTAL_MISMATCH', 'RESCHEDULE_COUNT', 'SOD_EXCEPTION_USED', 'SOD_EXCEPTION_EXPIRING'].includes(kind))).toEqual([]);
      }
      // The leader of the project has the money of the project in the view mine; the owner of the item of the Treasury, a member of the south who may not read the place of the project, has none of it in either view.
      expect(kinds(await list('?view=mine', MAKER))).toEqual([...moneyOfTheProject].sort());
      expect(items(await list('?view=mine', OTHER))).toEqual([]);
      expect(kinds(await list('?view=scope', OTHER))).toEqual([]);
      // The item says where it is opened and what it is: severity, consequence from the alert type, the dedupe key of the cause.
      const byId = new Map(items(auditorScope).map((item) => [item.id, item]));
      expect(byId.get(seeded.recon)).toMatchObject({ kind: 'TREASURY_RECON_ITEM_OVERDUE', source: 'TREASURY_RECON', severity: 'ACTION', due_on: day(-1), target: { screen: 'PAY-20', id: seeded.recon } });
      expect(byId.get(seeded.snapshot)).toMatchObject({ kind: 'CROSS_TOTAL_MISMATCH', source: 'CROSS_TOTAL', severity: 'ACTION', target: { screen: 'DIS-26', id: seeded.snapshot } });
      expect(byId.get(seeded.sodUsed)).toMatchObject({ kind: 'SOD_EXCEPTION_USED', source: 'SOD_EXCEPTION', severity: 'WATCH', target: { screen: 'AUD-13', id: seeded.sodExpiring } });
      expect(byId.get(seeded.blocked)).toMatchObject({ kind: 'PAYMENT_INTEGRITY_BLOCKED', source: 'PAYMENT_INTEGRITY', severity: 'ACTION', target: { screen: 'PAY-03' } });
      expect(byId.get(seeded.signalled)).toMatchObject({ kind: 'PAYMENT_INTEGRITY_SIGNAL', severity: 'WATCH' });
      expect(byId.get(seeded.lapsing)).toMatchObject({ kind: 'DISBURSEMENT_EXCEPTION_EXPIRING', source: 'DISBURSEMENT_EXCEPTION', severity: 'WATCH', due_on: day(2), target: { screen: 'PAY-21', id: seeded.lapsing } });
      expect(byId.get(seeded.alert)).toMatchObject({ kind: 'RESCHEDULE_COUNT', source: 'PROJECT_GOVERNANCE', severity: 'ACTION', target: { screen: 'PRJ-26', id: seeded.project } });
      expect(byId.get(seeded.alert)?.consequence).toBe('Đường cơ sở bị sửa nhiều lần mà không ai xem lại: kiểm toán theo dõi muộn.');
      expect(byId.get(seeded.recon)?.consequence).toBe('Chỉ tiêu liên quan vẫn bị đánh dấu và một vướng mắc được mở ở phân hệ ISS.');
      // The counts are those of the list, by kind and by severity, for each reader.
      for (const [view, member] of [['scope', AUDITOR], ['mine', AUDITOR], ['scope', ADMIN], ['mine', MAKER]] as const) {
        const full = await list(`?view=${view}`, member);
        const head = await counted(`?view=${view}`, member);
        expect(head.json.counts).toEqual({ urgent: (full.json.counts as Counts).urgent, action: (full.json.counts as Counts).action, watch: (full.json.counts as Counts).watch, total: (full.json.counts as Counts).total });
        expect(head.json.unavailable_sources).toEqual([]);
      }
      expect((auditorScope.json.counts as Record<string, number>).RESCHEDULE_COUNT).toBe(1);
      expect((auditorScope.json.counts as Record<string, number>).SOD_EXCEPTION_USED).toBe(1);
    });

    it('folds the issue that ISS opened for an item of the Treasury into that item: one cause, one item', async () => {
      const p = await project(NORTH, 'P-ONE');
      const recon = await insert('treasury_daily_recon_item', { project_id: p, fund_key: 'NSTW', recon_date: day(-3), kind: 'AMOUNT', books_vnd: 100, treasury_vnd: 150, latest_difference_vnd: 50, owner_membership_id: memberId(OTHER), due_on: day(-1), status: 'OPEN', ...person });
      await issue(p, { level: 3, overdue: true, sourceRef: recon, sourceModule: 'PAY', assignee: OTHER });
      const reply = await list('?view=scope', LEADER);
      expect(items(reply).map((item) => item.id)).toEqual([recon]);
      // The item shows the more urgent of the two severities and the escalation of the issue.
      expect(items(reply)[0]).toMatchObject({ kind: 'TREASURY_RECON_ITEM_OVERDUE', severity: 'URGENT', escalation: { level: 2, of: 4 } });
    });

    it('names the source that fails, over HTTP, and still gives the others', async () => {
      const seeded = await seedIntegrity();
      await admin(async (client) => void (await client.query('alter table machvon.project_governance_alert rename column status to status_moved')));
      try {
        const reply = await list('?view=scope', AUDITOR);
        expect(reply.status).toBe(200);
        expect(reply.json.unavailable_sources).toEqual(['PROJECT_GOVERNANCE']);
        expect(items(reply).map((item) => item.id)).toContain(seeded.recon);
        expect((await counted('?view=scope', AUDITOR)).json.unavailable_sources).toEqual(['PROJECT_GOVERNANCE']);
      } finally {
        await admin(async (client) => void (await client.query('alter table machvon.project_governance_alert rename column status_moved to status')));
      }
    });

    it('takes up an item of a new source for the person who may read it, and hides it from the one who may not', async () => {
      const seeded = await seedIntegrity();
      const claimed = await act('claim', { source: 'PROJECT_GOVERNANCE', source_id: seeded.alert }, AUDITOR);
      expect(claimed.status).toBe(200);
      expect(bySource(await list('?view=mine', AUDITOR), 'PROJECT_GOVERNANCE')[0]).toMatchObject({ id: seeded.alert, lifecycle: 'CLAIMED', claimed_by: { id: memberId(AUDITOR) } });
      // The leader of the project holds no right to read the alerts of the auditors: for them the item is not there.
      const refused = await act('claim', { source: 'PROJECT_GOVERNANCE', source_id: seeded.alert }, MAKER);
      expect([refused.status, refused.json.code]).toEqual([404, 'WORK_ITEM_GONE']);
      expect((await act('claim', { source: 'PAYMENT_INTEGRITY', source_id: seeded.blocked }, MAKER)).status).toBe(200);
      expect((await act('claim', { source: 'PROCUREMENT_WORKFLOW', source_id: `${randomUUID()}:step` }, MAKER)).json.code).toBe('WORK_ITEM_GONE');
    });
  });

  describe('one cause is one item', () => {
    it('folds the issue that ISS opened for a permit into the permit: one item, the more urgent severity, the escalation of the issue', async () => {
      const p = await project(NORTH, 'P-DUP');
      const expired = await permit(p, { status: 'EXPIRED', validUntil: day(-2) });
      await issue(p, { level: 2, overdue: true, sourceModule: 'PMT', sourceRef: expired });
      const reply = await list('?view=scope');
      expect(items(reply)).toHaveLength(1);
      expect(items(reply)[0]).toMatchObject({ id: expired, source: 'PERMIT', severity: 'URGENT', escalation: { level: 2, of: 4 } });
      expect((await counted('?view=scope')).json).toMatchObject({ counts: { total: 1, urgent: 1 } });
    });
  });

  describe('taking an item up', () => {
    it('claims an early warning: the decision is kept, DIS acknowledges the warning in the same step, the trail says both, and the list shows who took it up', async () => {
      const p = await project(NORTH, 'P-CL');
      const w = await warning(p, 'CRITICAL');
      const reply = await act('claim', { source: 'EARLY_WARNING', source_id: w, reason: 'On it, with the unit head.' });
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ status: 'CLAIMED', resource_version: 1 });
      const [state] = await rows<{ status: string; acknowledged_by: string; version: string }>('select status, acknowledged_by, version::text as version from machvon.early_warning where id = $1', [w]);
      expect(state).toMatchObject({ status: 'ACKNOWLEDGED', acknowledged_by: memberId(LEADER), version: '2' });
      expect(await rows('select action, actor_membership_id from machvon.work_action where source_id = $1', [w])).toEqual([{ action: 'CLAIM', actor_membership_id: memberId(LEADER) }]);
      const trail = await rows<{ action: string }>('select action from machvon.audit_event where resource_id = $1 order by occurred_at, id', [w]);
      expect(trail.map((entry) => entry.action).sort()).toEqual(['dis.warning_acknowledged', 'home.work_claimed']);
      const events = await rows<{ type: string }>('select type from machvon.outbox_event where aggregate_id = $1', [w]);
      expect(events.map((event) => event.type)).toEqual(['home.work_claimed.v1']);
      const shown = bySource(await list('?view=scope'), 'EARLY_WARNING')[0];
      expect(shown).toMatchObject({ lifecycle: 'CLAIMED', claimed_by: { id: memberId(LEADER), name: 'User 1' }, severity: 'URGENT' });
    });

    it('answers the same Idempotency-Key with the same answer and records the decision once; the same key with another body is a conflict', async () => {
      const p = await project(NORTH, 'P-ID');
      const w = await warning(p, 'WARNING');
      const first = await act('claim', { source: 'EARLY_WARNING', source_id: w }, LEADER, 'key-claim-0000000000001');
      const again = await act('claim', { source: 'EARLY_WARNING', source_id: w }, LEADER, 'key-claim-0000000000001');
      expect([first.status, again.status]).toEqual([200, 200]);
      expect(again.json).toEqual(first.json);
      expect(again.headers.get('idempotency-replayed')).toBe('true');
      expect(await rows('select 1 from machvon.work_action where source_id = $1', [w])).toHaveLength(1);
      const other = await project(NORTH, 'P-ID2');
      const w2 = await warning(other, 'WARNING');
      const conflict = await act('claim', { source: 'EARLY_WARNING', source_id: w2 }, LEADER, 'key-claim-0000000000001');
      expect([conflict.status, conflict.json.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    });

    it('claims an advance with the plan to recover it: PAY acknowledges the alert in the same step; without the words and the day it only takes the item up', async () => {
      const p = await project(NORTH, 'P-AD');
      const c = await contract(p, 'C-AD');
      const first = await advance(c, { paid: 100, recovered: 0, status: 'PAID', overdueSince: day(-3), level: 3 });
      const second = await advance(c, { paid: 100, recovered: 0, status: 'PAID', overdueSince: day(-2), level: 3 });
      expect((await act('claim', { source: 'ADVANCE', source_id: first, reason: 'Recovery plan agreed with the contractor.', due_on: day(10) })).status).toBe(200);
      const [done] = await rows<{ alert_acknowledged_by: string | null; alert_plan_due_on: string | null }>('select alert_acknowledged_by, alert_plan_due_on::text as alert_plan_due_on from machvon.contract_advance where id = $1', [first]);
      expect(done).toEqual({ alert_acknowledged_by: memberId(LEADER), alert_plan_due_on: day(10) });
      expect((await act('claim', { source: 'ADVANCE', source_id: second })).status).toBe(200);
      const [only] = await rows<{ alert_acknowledged_by: string | null }>('select alert_acknowledged_by from machvon.contract_advance where id = $1', [second]);
      expect(only?.alert_acknowledged_by).toBeNull();
      const found = bySource(await list('?view=scope'), 'ADVANCE');
      expect(found.find((item) => item.id === first)).toMatchObject({ lifecycle: 'IN_PROGRESS', claimed_by: { id: memberId(LEADER) } });
      expect(found.find((item) => item.id === second)).toMatchObject({ lifecycle: 'CLAIMED' });
    });

    it('rolls the decision back when the module refuses it, so that the two never disagree', async () => {
      const p = await project(NORTH, 'P-RB');
      const c = await contract(p, 'C-RB');
      const a = await advance(c, { paid: 100, recovered: 0, status: 'PAID', overdueSince: day(-3), level: 3 });
      const refused = await act('claim', { source: 'ADVANCE', source_id: a, reason: 'A plan for the past.', due_on: day(-1) });
      expect(refused.status).toBe(422);
      expect(await rows('select 1 from machvon.work_action where source_id = $1', [a])).toHaveLength(0);
    });

    it('takes up an item that is not acknowledged in its module (a permit) as a decision only, and says 404 WORK_ITEM_GONE for an item that is not there or not in the scope of the person', async () => {
      const south = await project(SOUTH, 'P-GO');
      const northProject = await project(NORTH, 'P-GO2');
      const northPermit = await permit(northProject, { status: 'EXPIRED', validUntil: day(-1) });
      const southPermit = await permit(south, { status: 'EXPIRED', validUntil: day(-1) });
      expect((await act('claim', { source: 'PERMIT', source_id: northPermit }, MAKER)).status).toBe(200);
      for (const [member, body] of [
        [LEADER, { source: 'PERMIT', source_id: randomUUID() }],
        [MAKER, { source: 'PERMIT', source_id: southPermit }],
        [LEADER, { source: 'ISSUE', source_id: northPermit }],
      ] as const) {
        const reply = await act('claim', body, member);
        expect([reply.status, reply.json.code]).toEqual([404, 'WORK_ITEM_GONE']);
      }
      expect(await rows('select 1 from machvon.work_action')).toHaveLength(1);
    });

    it('refuses what is not well formed: a body with a field of another command, one without the item, one that names a source that does not exist', async () => {
      const p = await project(NORTH, 'P-BAD');
      const w = await warning(p, 'WARNING');
      expect((await act('claim', { source: 'EARLY_WARNING', source_id: w, assignee_id: memberId(MAKER) })).status).toBe(422);
      expect((await act('claim', { source: 'EARLY_WARNING' })).status).toBe(400);
      expect((await act('claim', { source: 'SOMETHING', source_id: w })).status).toBeGreaterThanOrEqual(400);
      expect((await call('POST', '/home/work-actions/claim', { member: NOBODY, body: { source: 'EARLY_WARNING', source_id: w } })).status).toBe(403);
    });
  });

  describe('giving an item to someone', () => {
    it('assigns an item with a day: the assignee has it in the view mine wherever it lies, the list says who and by when, and the trail and the event are written', async () => {
      const south = await project(SOUTH, 'P-AS2');
      const w = await warning(south, 'WARNING');
      expect(items(await list('?view=mine', MAKER))).toEqual([]);
      const reply = await act('assign', { source: 'EARLY_WARNING', source_id: w, assignee_id: memberId(MAKER), due_on: day(5), reason: 'Please take over.' });
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ status: 'ASSIGNED' });
      const mine = await list('?view=mine', MAKER);
      expect(items(mine)).toHaveLength(1);
      expect(items(mine)[0]).toMatchObject({ id: w, lifecycle: 'IN_PROGRESS', assignee: { id: memberId(MAKER), name: 'User 2', due_on: day(5) } });
      const trail = await rows<{ action: string }>('select action from machvon.audit_event where resource_id = $1', [w]);
      expect(trail.map((entry) => entry.action)).toEqual(['home.work_assigned']);
      expect((await rows<{ type: string }>('select type from machvon.outbox_event where aggregate_id = $1', [w])).map((event) => event.type)).toEqual(['home.work_assigned.v1']);
      // Counts follow the same rule.
      expect((await counted('?view=mine', MAKER)).json).toMatchObject({ counts: { urgent: 0, action: 1, total: 1 } });
    });

    it('requires an assignee that is an active member of a unit the person may read (404), a day that is not past (422) and an assignee at all (422)', async () => {
      const north = await project(NORTH, 'P-AS3');
      const w = await warning(north, 'WARNING');
      // MAKER reads the north only: the south is not theirs to give work to, and another tenant's member is nobody.
      const outside = await act('assign', { source: 'EARLY_WARNING', source_id: w, assignee_id: memberId(OTHER) }, MAKER);
      expect([outside.status, outside.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect((await act('assign', { source: 'EARLY_WARNING', source_id: w, assignee_id: randomUUID() })).status).toBe(404);
      expect((await act('assign', { source: 'EARLY_WARNING', source_id: w, assignee_id: memberId(MAKER), due_on: day(-1) })).status).toBe(422);
      expect((await act('assign', { source: 'EARLY_WARNING', source_id: w })).status).toBe(422);
      expect((await act('assign', { source: 'EARLY_WARNING', source_id: w, assignee_id: memberId(MAKER), snooze_until: at(1) })).status).toBe(422);
      expect(await rows('select 1 from machvon.work_action')).toHaveLength(0);
    });
  });

  describe('putting an item off', () => {
    const WHY = { reason_code: 'WAITING_INFORMATION' };

    it('refuses an urgent item, and anything past the day the item is due on, and a time that is already past', async () => {
      const p = await project(NORTH, 'P-SN');
      const urgent = await warning(p, 'CRITICAL');
      const c = await contract(p, 'C-SN');
      const soon = await guarantee(c, 5);
      const refusedUrgent = await act('snooze', { source: 'EARLY_WARNING', source_id: urgent, snooze_until: at(1), ...WHY });
      expect([refusedUrgent.status, refusedUrgent.json.code]).toEqual([422, 'WORK_SNOOZE_NOT_ALLOWED']);
      const late = await act('snooze', { source: 'GUARANTEE', source_id: soon, snooze_until: at(6), ...WHY });
      expect([late.status, late.json.code]).toEqual([422, 'WORK_SNOOZE_NOT_ALLOWED']);
      const past = await act('snooze', { source: 'GUARANTEE', source_id: soon, snooze_until: '2027-10-14T05:00:00.000Z', ...WHY });
      expect([past.status, past.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      expect((await act('snooze', { source: 'GUARANTEE', source_id: soon, ...WHY })).status).toBe(422);
      expect(await rows('select 1 from machvon.work_action')).toHaveLength(0);
    });

    it('puts an item off until a time that is not past its day: it leaves the list and the counts of the one who put it off, stays for another reader with the time it comes back, and returns when the time comes', async () => {
      const p = await project(NORTH, 'P-SN2');
      const c = await contract(p, 'C-SN2', 'ACTIVE', day(-1));
      const soon = await guarantee(c, 5);
      const reply = await act('snooze', { source: 'GUARANTEE', source_id: soon, snooze_until: at(2), reason: 'Waiting for the bank.', ...WHY });
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ status: 'SNOOZED' });
      expect(bySource(await list('?view=scope'), 'GUARANTEE')).toEqual([]);
      expect((await counted('?view=scope')).json).toMatchObject({ counts: { total: 0 } });
      const seen = bySource(await list('?view=scope', MAKER), 'GUARANTEE');
      expect(seen).toHaveLength(1);
      expect(seen[0]?.snoozed_until).toBe(at(2));
      // Put off again, as far as the policy goes for an item to be acted on (three days), which is also before the day it ends.
      expect((await act('snooze', { source: 'GUARANTEE', source_id: soon, snooze_until: at(3, '02:00:00'), ...WHY })).status).toBe(200);
      // The time comes: the item is back on the list of the one who put it off.
      await admin(async (client) => void (await client.query("update machvon.work_action set snooze_until = now() - interval '1 hour' where action = 'SNOOZE'")));
      expect(bySource(await list('?view=scope'), 'GUARANTEE')).toHaveLength(1);
    });

    it('puts off an item that has no day for as long as its severity allows: three days when it is to be acted on, two weeks when it is to be watched', async () => {
      const p = await project(NORTH, 'P-SN3');
      const action = await warning(p, 'WARNING');
      const watch = await warning(p, 'INFO');
      expect((await act('snooze', { source: 'EARLY_WARNING', source_id: action, snooze_until: at(31), ...WHY })).json.code).toBe('WORK_SNOOZE_TOO_LONG');
      expect((await act('snooze', { source: 'EARLY_WARNING', source_id: action, snooze_until: at(4), ...WHY })).json.code).toBe('WORK_SNOOZE_TOO_LONG');
      expect((await act('snooze', { source: 'EARLY_WARNING', source_id: action, snooze_until: at(2), ...WHY })).status).toBe(200);
      expect((await act('snooze', { source: 'EARLY_WARNING', source_id: watch, snooze_until: at(15), ...WHY })).json.code).toBe('WORK_SNOOZE_TOO_LONG');
      expect((await act('snooze', { source: 'EARLY_WARNING', source_id: watch, snooze_until: at(13), ...WHY })).status).toBe(200);
    });

    it('puts off an item that is already past its day for no time at all', async () => {
      const p = await project(NORTH, 'P-SN4');
      const c = await contract(p, 'C-SN4');
      const a = await advance(c, { paid: 100, recovered: 0, status: 'PAID', overdueSince: day(-3), level: 3 });
      expect((await act('snooze', { source: 'ADVANCE', source_id: a, snooze_until: at(1), ...WHY })).json.code).toBe('WORK_SNOOZE_NOT_ALLOWED');
    });
  });
});
