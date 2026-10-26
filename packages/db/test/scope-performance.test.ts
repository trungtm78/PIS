import { performance } from 'node:perf_hooks';
import { effectivePermissions, holdsPermission } from '@machvon/kernel';
import { EffectiveAccessStore } from '../src/effective-access-store';
import { InMemoryAuthzCache } from '../src/authz-cache';
import { MyAccessStore } from '../src/my-access-store';
import { scopePredicate } from '../src/scope-version';
import { seedSystemRoles } from '../src/system-roles';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, unitId } from './support/authz-fixtures';
import { LOAD_GRANTS_PER_MEMBER, LOAD_UNITS, loadMemberId, seedScopeLoad } from './support/scope-load';

const CALLS = 200;
const P95_BUDGET_MS = 100;
// A decision of the PDP from the cached access of a member (UAT-NFR-PERFORMANCE-01).
const DECISION_BUDGET_MS = 20;
const ACTOR = '00000000-0000-4000-8000-0000000000f0';
const PATH_INDEX = 'organization_unit_path_idx';
// The department whose subtree the scoped readers hold: 259 units below and including it, of 5,000.
const DEPARTMENT = 8;
const OTHER_UNIT = 100;
// A reader added to the load: the subtree of the department and one more unit, nothing else, so the predicate has two alternatives.
const READER = LOAD_UNITS + 1;

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}

function nodesOf(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodesOf)];
}

function p95(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

describe('scope queries on a tenant of 5,000 units and 50,000 grants (ST-IAM-005, IAM section 3.4)', () => {
  const harness = new AuthzHarness();
  const ctxOf = (member: number) => contextFor(TENANT_A, loadMemberId(member));
  let access: EffectiveAccessStore;
  const load = { units: 0, grants: 0 };

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_B, [{ n: 1, path: '/b/' }]);
    await harness.tenants.withTenant(contextFor(TENANT_A, loadMemberId(1)), (tx) => seedSystemRoles(tx, ACTOR));
    const seeded = await seedScopeLoad(harness.database.urlFor('machvon_owner'), TENANT_A, ACTOR);
    load.units = seeded.units;
    load.grants = seeded.grants;
    // What autovacuum does on a live database: the planner judges the tables by their statistics, not by guesses.
    await seedReader();
    await harness.owner(TENANT_A, [['analyze machvon.organization_unit'], ['analyze machvon.role_grant'], ['analyze machvon.membership']]);
    access = new EffectiveAccessStore(harness.tenants, new InMemoryAuthzCache());
  }, 600_000);

  afterAll(() => harness.stop(), 60_000);

  async function seedReader(): Promise<void> {
    const [role] = await harness.owner<{ id: string }>(TENANT_A, [["select id from machvon.role_definition where tenant_id = $1 and code = 'UNIT_ADMIN'", [TENANT_A]]]);
    const grant = (n: number, kind: string, unit: number): [string, unknown[]] => [
      `insert into machvon.role_grant (tenant_id, id, membership_id, role_id, scope_json, effective_from, scope_kind, scope_ref_ids, status, granted_by, grant_reason)
       values ($1, $2, $3, $4, jsonb_build_object('kind', $5::text), '2026-01-01T00:00:00Z', $5, array[$6]::uuid[], 'Active', $7, 'load')`,
      [TENANT_A, id(0x43, n), loadMemberId(READER), role?.id, kind, unitId(unit), ACTOR],
    ];
    await harness.owner(TENANT_A, [
      ["insert into machvon.user_account (id, idp_subject, email_normalized, display_name, status) values ($1, 'load-reader', 'load-reader@example.test', 'Reader', 'Active')", [id(0x62, READER)]],
      ["insert into machvon.membership (tenant_id, id, user_id, organization_id, status, valid_from) values ($1, $2, $3, $4, 'Active', now() - interval '1 day')", [TENANT_A, loadMemberId(READER), id(0x62, READER), unitId(1)]],
      grant(1, 'UNIT_SUBTREE', DEPARTMENT),
      grant(2, 'UNIT_ONLY', OTHER_UNIT),
    ]);
  }

  const inTenant = <T>(work: (tx: TenantTx) => Promise<T>, member = 1): Promise<T> => harness.tenants.withTenant(ctxOf(member), work);

  async function planOf(sql: string, params: unknown[]): Promise<PlanNode[]> {
    return inTenant(async (tx) => {
      // The index is what is measured: a tiny table that the planner would scan anyway is the only thing this switch hides.
      const rows = await tx.query<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(`explain (format json) ${sql}`, params);
      const root = rows[0]?.['QUERY PLAN'][0]?.Plan;
      return root === undefined ? [] : nodesOf(root);
    });
  }

  // SCOPE_PERF_REPORT=1 prints the p95 of every measurement, for the record of what a run measured.
  const report = (name: string, samples: readonly number[]): void => {
    if (process.env.SCOPE_PERF_REPORT === '1') process.stderr.write(`scope-performance ${name}: p95 ${p95(samples).toFixed(1)} ms, max ${Math.max(...samples).toFixed(1)} ms
`);
  };

  async function timed(call: () => Promise<unknown>): Promise<number[]> {
    await call();
    const samples: number[] = [];
    for (let i = 0; i < CALLS; i += 1) {
      const started = performance.now();
      await call();
      samples.push(performance.now() - started);
    }
    return samples;
  }

  // A reader of one department: the subtree grant of member 8 (unit 8) plus the owner of unit 8, to have more than one alternative.
  const departmentReader = async (): Promise<{ sql: string; params: unknown[] }> => {
    const held = await access.load(ctxOf(READER));
    return scopePredicate(held, 'iam.unit.manage', new Date(), { unitPath: 'path', unitId: 'id' }, 1);
  };

  it('has the volume the budget is measured on', () => {
    expect(load.units).toBe(LOAD_UNITS);
    expect(load.grants).toBe(LOAD_UNITS * LOAD_GRANTS_PER_MEMBER);
  });

  describe('the plans use the path index and never scan organization_unit', () => {
    it('the unit list of a subtree reader', async () => {
      const scope = await departmentReader();
      expect(scope.sql).toContain('path');
      const nodes = await planOf(
        `select id, code, name, path from machvon.organization_unit where ${scope.sql} order by code, id limit 51`,
        scope.params,
      );
      expect(nodes.some((node) => node['Index Name'] === PATH_INDEX)).toBe(true);
      expect(nodes.filter((node) => node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'organization_unit')).toEqual([]);
    });

    it('the member list of a subtree reader (the unit path of the member joined in)', async () => {
      const held = await access.load(ctxOf(READER));
      const scope = scopePredicate(held, 'iam.unit.manage', new Date(), { unitPath: 'ou.path', unitId: 'ou.id' }, 1);
      const nodes = await planOf(
        `select m.id from machvon.membership m join machvon.organization_unit ou on ou.tenant_id = m.tenant_id and ou.id = m.organization_id
          where ${scope.sql} order by m.id limit 51`,
        scope.params,
      );
      expect(nodes.some((node) => node['Index Name'] === PATH_INDEX)).toBe(true);
      expect(nodes.filter((node) => node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'organization_unit')).toEqual([]);
    });
  });

  describe(`p95 under ${P95_BUDGET_MS} ms over ${CALLS} calls`, () => {
    it('lists the units of a subtree reader', async () => {
      const scope = await departmentReader();
      const samples = await timed(() =>
        inTenant((tx) => tx.query(`select id, code, name, path from machvon.organization_unit where ${scope.sql} order by code, id limit 51`, scope.params), READER),
      );
      report('unit list', samples);
      expect(p95(samples)).toBeLessThan(P95_BUDGET_MS);
    });

    it('loads the effective access of a member (ten grants of 50,000)', async () => {
      let member = 0;
      const samples = await timed(() => access.load(contextFor(TENANT_A, loadMemberId((member += 1) % LOAD_UNITS || 1))));
      report('effective access load', samples);
      expect(p95(samples)).toBeLessThan(P95_BUDGET_MS);
    });

    it(`AC-ST-IAM-005-4 / UAT-NFR-PERFORMANCE-01: decides from the cached access of a member (ten grants of 50,000) in under ${DECISION_BUDGET_MS} ms p95`, async () => {
      const ctx = contextFor(TENANT_A, loadMemberId(READER));
      const [row] = await inTenant((tx) => tx.query<{ path: string }>('select path from machvon.organization_unit where id = $1::uuid', [unitId(DEPARTMENT)]));
      const unit = { ownerUnitPath: row?.path ?? '', ownerUnitId: unitId(DEPARTMENT) };
      const decide = async (): Promise<boolean> => holdsPermission(effectivePermissions(await access.load(ctx), new Date(), unit), 'iam.unit.manage');
      expect(await decide()).toBe(true);
      const samples = await timed(decide);
      report('pdp decision (cached access)', samples);
      expect(p95(samples)).toBeLessThan(DECISION_BUDGET_MS);
      // A unit the grants do not reach is refused just as fast.
      const refused = await timed(async () => holdsPermission(effectivePermissions(await access.load(ctx), new Date(), { ownerUnitPath: '/none/', ownerUnitId: unitId(4000) }), 'iam.unit.manage'));
      expect(p95(refused)).toBeLessThan(DECISION_BUDGET_MS);
    });

    it('shows my effective access: the ten grants of a member with their units and breadcrumbs', async () => {
      const mine = new MyAccessStore();
      let member = 0;
      const samples = await timed(() =>
        inTenant(async (tx) => {
          const who = loadMemberId(((member += 1) % LOAD_UNITS) || 1);
          return [await mine.grants(tx, who), await mine.delegationsTo(tx, who), await mine.scopeVersionOf(tx, who)];
        }),
      );
      report('my effective access', samples);
      expect(p95(samples)).toBeLessThan(P95_BUDGET_MS);
    });

    it('lists the members of a subtree reader (the unit path of the member joined in)', async () => {
      const held = await access.load(ctxOf(READER));
      const scope = scopePredicate(held, 'iam.unit.manage', new Date(), { unitPath: 'ou.path', unitId: 'ou.id' }, 1);
      const samples = await timed(() =>
        inTenant(
          (tx) =>
            tx.query(
              `select m.id from machvon.membership m join machvon.organization_unit ou on ou.tenant_id = m.tenant_id and ou.id = m.organization_id
                where ${scope.sql} order by m.id limit 51`,
              scope.params,
            ),
          READER,
        ),
      );
      report('member list', samples);
      expect(p95(samples)).toBeLessThan(P95_BUDGET_MS);
    });
  });
});
