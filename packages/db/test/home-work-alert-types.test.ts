import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { GovernancePolicyPort } from '../src/governance-policy-port';
import { alertTypeCodeOf, applyAlertTypes } from '../src/home-work-alert-types';
import type { AlertTypeReading } from '../src/home-work-alert-types';
import { HomeWorkStore } from '../src/home-work-store';
import type { WorkInput } from '../src/home-work-store';
import { CONSEQUENCES } from '../src/home-work-rules';
import type { ScopeBuilder } from '../src/scope-version';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const store = new HomeWorkStore();

const ROOT = 1;
const NORTH = 2;
const READER = 1;
const OTHER = 2;
const NOW = new Date('2027-10-15T03:00:00Z');
const TODAY = '2027-10-15';
const EVERYTHING: ScopeBuilder = () => ({ sql: 'true', params: [] });

const as = <T>(work: (tx: Parameters<Parameters<typeof harness.tenants.withTenant>[1]>[0]) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(READER)), work);
const input = (over: Partial<WorkInput> = {}): WorkInput => ({ membershipId: memberId(READER), now: NOW, today: TODAY, unitScope: EVERYTHING, projectScope: EVERYTHING, view: 'scope', includeHidden: true, ...over });

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

describe('applyAlertTypes when the registry cannot be read', () => {
  it('rolls back to its savepoint and leaves the items as their sources made them', async () => {
    const statements: string[] = [];
    const tx = { query: (sql: string): Promise<never[]> => { statements.push(sql); return Promise.resolve([]); } };
    const port = { getAll: (): Promise<never> => Promise.reject(new Error('the registry is not readable')) } as unknown as GovernancePolicyPort;
    const row: { kind: string; source: string; consequence: string | null; alertType?: AlertTypeReading | null } = { kind: 'EARLY_WARNING', source: 'EARLY_WARNING', consequence: CONSEQUENCES.EARLY_WARNING ?? null };
    await applyAlertTypes(tx as never, [row], TODAY, port);
    expect(row.consequence).toBe(CONSEQUENCES.EARLY_WARNING);
    expect(row.alertType).toBeUndefined();
    expect(statements).toEqual(['savepoint home_alert_types', 'rollback to savepoint home_alert_types', 'release savepoint home_alert_types']);
  });

  it('does nothing, and asks nothing, when there are no items', async () => {
    const statements: string[] = [];
    const tx = { query: (sql: string): Promise<never[]> => { statements.push(sql); return Promise.resolve([]); } };
    await applyAlertTypes(tx as never, [], TODAY);
    expect(statements).toEqual([]);
  });
});

describe('alertTypeCodeOf', () => {
  it('names the type by the sentence that says what happens when the item is not done, by its own kind, or by its source', () => {
    expect(alertTypeCodeOf({ kind: 'PERMIT_EXPIRY', source: 'PERMIT', consequence: CONSEQUENCES.PERMIT_EXPIRED ?? null })).toBe('PERMIT_EXPIRED');
    expect(alertTypeCodeOf({ kind: 'PERMIT_EXPIRY', source: 'PERMIT', consequence: CONSEQUENCES.PERMIT_EXPIRING ?? null })).toBe('PERMIT_EXPIRING');
    expect(alertTypeCodeOf({ kind: 'ISSUE_SLA_BREACH', source: 'ISSUE', consequence: CONSEQUENCES.ISSUE_SLA_BREACH_L3 ?? null })).toBe('ISSUE_SLA_BREACH_L3');
    expect(alertTypeCodeOf({ kind: 'EAC_EXCEEDS_TMDT', source: 'MONEY_CONTROL', consequence: null })).toBe('EAC_EXCEEDS_TMDT');
    expect(alertTypeCodeOf({ kind: 'APPROVAL', source: 'APPROVAL', consequence: null })).toBe('APPROVAL');
    expect(alertTypeCodeOf({ kind: 'SOMETHING_NEW', source: 'NEW_SOURCE', consequence: 'Một câu lạ.' })).toBe('NEW_SOURCE');
  });
});

/** The hook of G0-3 in the alert centre: the consequence and the response time of an item are those of its `ALERT_TYPE` rule in force. */
describe('HomeWorkStore with the registry of alert types', () => {
  const projectId = randomUUID();
  const warningId = randomUUID();

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

  async function approvedType(tenant: string, from: string, params: Record<string, unknown>): Promise<void> {
    await harness.owner(tenant, [
      [
        `insert into machvon.governance_rule (tenant_id, id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at)
         values ($1, gen_random_uuid(), 'ALERT_TYPE', 'EARLY_WARNING', coalesce((select max(version) from machvon.governance_rule where rule_type = 'ALERT_TYPE' and code = 'EARLY_WARNING'), 0) + 1,
                 'APPROVED', $2::jsonb, $3::date, 'Đổi hậu quả của cảnh báo sớm', $4, $5, now(), $6, now())`,
        [tenant, JSON.stringify(params), from, memberId(READER), memberId(OTHER), memberId(3)],
      ],
    ]);
  }

  const override = {
    source: 'EARLY_WARNING',
    owner: 'PROJECT_OWNER',
    expected_action: 'Đọc cảnh báo và ghi kế hoạch khắc phục.',
    consequence: 'Cảnh báo không xử lý trong 6 giờ sẽ được báo thẳng lên lãnh đạo.',
    response_hours: 6,
    default_severity: 'URGENT',
    reason_to_exist: 'Phát hiện sớm dự án chậm giải ngân.',
    review_on: '2020-01-01',
    enabled: true,
  };

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: NORTH, path: `/${unitId(ROOT)}/${unitId(NORTH)}/`, parent: ROOT },
      ]);
      for (const member of [READER, OTHER, 3]) await harness.seedMembership(tenant, member, ROOT);
    }
    await warning(TENANT_A, projectId, warningId);
  }, 300_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  it('gives an item the consequence and the response time of the built-in type when the tenant approved no rule', async () => {
    const { rows } = await as((tx) => store.collect(tx, input()));
    const row = rows.find((candidate) => candidate.id === warningId);
    expect(row?.consequence).toBe(CONSEQUENCES.EARLY_WARNING);
    expect(row?.alertType).toMatchObject({ code: 'EARLY_WARNING', owner: 'PROJECT_OWNER', responseHours: 24, version: 0, source: 'DEFAULT', reviewOverdue: true });
    // The built-in types are to be reviewed on 2027-05-08 and today is 2027-10-15: the registry says so.
    expect(row?.alertType?.expectedAction).toMatch(/kế hoạch khắc phục/);
  });

  it('reads the approved rule of the tenant from its first day, with its version, and says that its review day has passed', async () => {
    await approvedType(TENANT_A, '2027-10-16', override);
    const before = await as((tx) => store.collect(tx, input()));
    expect(before.rows[0]?.alertType).toMatchObject({ version: 0, source: 'DEFAULT' });
    // The day comes: the rule that began tomorrow now begins today.
    await admin([[`update machvon.governance_rule set effective_from = date '2027-10-15' where effective_from = date '2027-10-16' and tenant_id = $1`, [TENANT_A]]]);
    const { rows } = await as((tx) => store.collect(tx, input()));
    const row = rows.find((candidate) => candidate.id === warningId);
    expect(row?.consequence).toBe(override.consequence);
    expect(row?.alertType).toMatchObject({ code: 'EARLY_WARNING', responseHours: 6, version: 1, source: 'RULE', reviewOverdue: true });
    // Another tenant is still on the built-in type.
    await warning(TENANT_B, randomUUID(), randomUUID());
    const other = await as((tx) => store.collect(tx, input()), TENANT_B);
    expect(other.rows[0]?.alertType).toMatchObject({ version: 0, source: 'DEFAULT' });
  });

  it('does not read the registry when only counting', async () => {
    const counted = await as((tx) => store.collect(tx, input({ mode: 'count' })));
    expect(counted.rows.every((row) => row.alertType === undefined)).toBe(true);
  });
});
