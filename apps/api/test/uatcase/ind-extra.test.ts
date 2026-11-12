import { randomUUID } from 'node:crypto';
import { validateRuleParams } from '@machvon/kernel';
import { TENANT_A, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { assertStatus, expectCheckFails } from '../uat/uat-kit';
import type { Reply } from '../uat/uat-kit';
import { ROOT_UNIT, UatWorld } from '../uat/uat-world';
import { assertWithinBudget, measureP95, scopedCaller, seedScopedMembers } from './support';

/**
 * Cases of docs/uat/ind/uat.json that the suite `../uat/ind.uat.test.ts` does not script: the entry of figures by somebody whose right is on one unit, the boundaries of the values of a figure, and the read of the
 * figures of a period on a tenant with 22 projects of 200 indicators each with three revisions. Each case is named by its id in the title of its test.
 */
jest.setTimeout(240_000);

const FAMILY = 0x9b;
const DEPARTMENT_A = 2;
const DEPARTMENT_B = 3;
const UNIT_ENTRY = 40; // enters figures on the unit tree of department A only
const PROJECTS = 22;
const INDICATORS = 200;
const REVISIONS = 3;
const PERSONAS = {
  'ind-admin': ['ind.read', 'ind.entry'],
  'ind-reader': ['ind.read'],
};
const list = (reply: Reply, key = 'items'): Array<Record<string, unknown>> => reply.json[key] as Array<Record<string, unknown>>;

describe('UAT cases of the indicators and their entry that the suite of the area does not script (IND)', () => {
  const world = new UatWorld();
  const unitCaller = scopedCaller(world);
  let counter = 0;

  beforeAll(async () => {
    await world.start(PERSONAS, {}, async (w) => {
      await w.harness.seedUnits(TENANT_A, [
        { n: DEPARTMENT_A, path: `/${unitId(ROOT_UNIT)}/${unitId(DEPARTMENT_A)}/`, parent: ROOT_UNIT },
        { n: DEPARTMENT_B, path: `/${unitId(ROOT_UNIT)}/${unitId(DEPARTMENT_B)}/`, parent: ROOT_UNIT },
      ]);
      await seedScopedMembers(w, [{ n: UNIT_ENTRY, permissions: ['ind.read', 'ind.entry'], kind: 'UNIT_SUBTREE', units: [DEPARTMENT_A] }]);
    });
  }, 300_000);

  afterAll(() => world.stop(), 60_000);

  async function project(unit: number): Promise<{ projectId: string; code: string }> {
    counter += 1;
    const projectId = randomUUID();
    const code = `UAT-INX-P${counter}-${projectId.slice(0, 4)}`;
    await world.seedAsAdmin([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, 'Indicator project', $4, $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, code, unitId(unit), id(FAMILY, 90)],
      ],
    ]);
    return { projectId, code };
  }

  async function period(code: string): Promise<string> {
    const periodId = randomUUID();
    await world.seedAsAdmin([
      [
        `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
         values ($1, $2, $3, 1, date '2026-10-01', date '2026-10-31', date '2026-11-05' + interval '3 hours', $4, 'MONTH', 2026, 'OPEN', gen_random_uuid(), $5, $5)`,
        [TENANT_A, periodId, code, `CAL-${code}`, memberId(1)],
      ],
    ]);
    return periodId;
  }

  const enter = (persona: string, projectId: string, periodId: string, figures: Array<Record<string, unknown>>): Promise<Reply> =>
    world.as(persona, 'POST', '/indicator-figures', { body: { project_id: projectId, period_id: periodId, figures } });
  const figuresOf = async (projectId: string, periodId: string): Promise<Array<Record<string, unknown>>> => list(await world.as('ind-reader', 'GET', `/indicator-figures?project_id=${projectId}&period_id=${periodId}`));

  it('UAT-IND-SCP-01 an entry clerk whose right is on department A is refused the project of department B (404, as for a project that does not exist) and enters for the project of department A (200), and the history of the project of department B is out of reach (404)', async () => {
    const a = await project(DEPARTMENT_A);
    const b = await project(DEPARTMENT_B);
    const periodId = await period('2026-10-SCP');
    const asClerk = (projectId: string, value: string): Promise<Reply> =>
      unitCaller(UNIT_ENTRY, 'POST', '/indicator-figures', { body: { project_id: projectId, period_id: periodId, figures: [{ indicator_code: 'PLAN_YEAR', value }] } });
    // The control: the figure of department B exists, so a 404 for the clerk is the scope and not the lack of data.
    assertStatus(await enter('ind-admin', b.projectId, periodId, [{ indicator_code: 'PLAN_YEAR', value: '1000' }]), 200);

    // Step 1: the clerk enters for department B.
    const refused = await asClerk(b.projectId, '7777');
    assertStatus(refused, 404);
    const nothing = await asClerk(randomUUID(), '7777');
    expect([refused.status, refused.json.code]).toEqual([nothing.status, nothing.json.code]);
    expect((await figuresOf(b.projectId, periodId)).map((figure) => [figure.indicator_code, figure.value, figure.revision])).toEqual([['PLAN_YEAR', '1000', 1]]);

    // Step 2: the clerk enters for department A.
    const entered = await asClerk(a.projectId, '2500');
    assertStatus(entered, 200);
    expect(entered.json).toMatchObject({ status: 'ENTERED', created: 1 });
    expect((await figuresOf(a.projectId, periodId)).map((figure) => [figure.indicator_code, figure.value, figure.entered_by])).toEqual([['PLAN_YEAR', '2500', memberId(UNIT_ENTRY)]]);

    // Step 3: the history of the project of department B, and the list of its figures, are out of reach; the history of department A is not.
    assertStatus(await unitCaller(UNIT_ENTRY, 'GET', `/indicator-figures/history?project_id=${b.projectId}&period_id=${periodId}&indicator_code=PLAN_YEAR`), 404);
    expect(list(await unitCaller(UNIT_ENTRY, 'GET', `/indicator-figures?project_id=${b.projectId}&period_id=${periodId}`))).toEqual([]);
    const history = await unitCaller(UNIT_ENTRY, 'GET', `/indicator-figures/history?project_id=${a.projectId}&period_id=${periodId}&indicator_code=PLAN_YEAR`);
    assertStatus(history, 200);
    expect(list(history)).toHaveLength(1);
  });

  // Not named by the case id: the case expects 100.01 and -0.01 to be refused with no rule approved, and the product holds an entry only to the rules the tenant approved (finding in the report of the lane).
  it('the boundaries of a figure under the approved range rule of the progress: 0 and 100 are taken, 100.01 and -0.01 are refused (422 IND_ENTRY_RULE_VIOLATED), money of 0 and of twenty digits is kept to the dong, and a decimal comma is refused', async () => {
    const params = validateRuleParams('DATA_ENTRY_RULE', { check: 'VALUE_IN_RANGE', severity: 'BLOCK', fields: ['PHYSICAL_PROGRESS'], min: '0', max: '100', message: 'Progress is between 0 and 100 percent', surfaces: ['INDICATOR_ENTRY'] });
    await world.seedAsAdmin([
      [
        `insert into machvon.governance_rule (tenant_id, id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at)
         values ($1, $2, 'DATA_ENTRY_RULE', 'PROGRESS_PERCENT_IN_RANGE', 1, 'APPROVED', $3::jsonb, date '2026-01-01', 'Approval of the rule for the UAT', $4, $4, now(), $5, now())`,
        [TENANT_A, randomUUID(), JSON.stringify(params), world.idOf('ind-admin'), world.idOf('ind-reader')],
      ],
    ]);
    const attempt = async (code: string, value: string): Promise<{ reply: Reply; projectId: string; periodId: string }> => {
      const { projectId } = await project(DEPARTMENT_A);
      const periodId = await period(`2026-10-B${(counter += 1)}`);
      return { reply: await enter('ind-admin', projectId, periodId, [{ indicator_code: code, value }]), projectId, periodId };
    };
    for (const value of ['0', '100', '99.99']) {
      const taken = await attempt('PHYSICAL_PROGRESS_REPORTED', value);
      assertStatus(taken.reply, 200);
      expect((await figuresOf(taken.projectId, taken.periodId)).map((figure) => [figure.indicator_code, figure.value])).toEqual([['PHYSICAL_PROGRESS_REPORTED', value]]);
    }
    for (const value of ['100.01', '-0.01']) {
      const refused = await attempt('PHYSICAL_PROGRESS_REPORTED', value);
      assertStatus(refused.reply, 422, 'IND_ENTRY_RULE_VIOLATED');
      expect(refused.reply.json).toMatchObject({ detail: 'PROGRESS_PERCENT_IN_RANGE' });
      expect(await figuresOf(refused.projectId, refused.periodId)).toEqual([]);
    }
    const money = ['0', '1', '12345678901234567890'];
    for (const value of money) {
      const taken = await attempt('PLAN_YEAR', value);
      assertStatus(taken.reply, 200);
      expect((await figuresOf(taken.projectId, taken.periodId)).map((figure) => figure.value)).toEqual([value]);
    }
    // The decimal separator of the contract is the point: a comma, as the Vietnamese write it, and a fraction of whole dong are refused, and nothing is written.
    for (const [code, value] of [['PLAN_YEAR', '1,5'], ['PLAN_YEAR', '12,5'], ['PLAN_YEAR', '1.5'], ['PHYSICAL_PROGRESS_REPORTED', '12,5']] as const) {
      const refused = await attempt(code, value);
      assertStatus(refused.reply, 422, 'VALIDATION_FAILED');
      expect(String(refused.reply.json.detail)).toMatch(/^figures(\[0\])?\.value$/);
      expect(await figuresOf(refused.projectId, refused.periodId)).toEqual([]);
    }
  });

  it('UAT-IND-PRF-01 the figures of a project and a period are read within 5 seconds at the p95 on a tenant with 22 projects of 200 indicators, each figure with three revisions', async () => {
    const periodId = await period('2026-10-PRF');
    const first = await project(DEPARTMENT_A);
    const projectIds = [first.projectId];
    for (let index = 1; index < PROJECTS; index += 1) projectIds.push((await project(index % 2 === 0 ? DEPARTMENT_A : DEPARTMENT_B)).projectId);
    // 22 projects x 200 indicators x 3 revisions, written in one statement: the figures are what the entry command would have left, the later revisions with their reasons.
    await world.seedAsAdmin([
      [
        `insert into machvon.ind_figure (tenant_id, id, project_id, period_id, indicator_code, revision, value, unit, definition_version, source, reason, entered_by)
         select $1, gen_random_uuid(), p.id, $2, 'KPI_UAT_' || lpad(k::text, 3, '0'), r, (k * 1000 + r)::numeric, 'VND', 1, 'ENTRY', case when r = 1 then null else 'Correction ' || r || ' of the figure for the UAT' end, $3
           from unnest($4::uuid[]) as p(id), generate_series(1, $5::int) as k, generate_series(1, $6::int) as r`,
        [TENANT_A, periodId, memberId(1), projectIds, INDICATORS, REVISIONS],
      ],
    ]);
    expect((await world.rows<{ n: string }>('select count(*)::text as n from machvon.ind_figure where period_id = $1', [periodId]))[0]?.n).toBe(String(PROJECTS * INDICATORS * REVISIONS));
    const url = `/indicator-figures?project_id=${first.projectId}&period_id=${periodId}`;
    const answer = await world.as('ind-reader', 'GET', url);
    assertStatus(answer, 200);
    expect(list(answer)).toHaveLength(INDICATORS);
    expect(list(answer).every((figure) => figure.revision === REVISIONS)).toBe(true);
    const measured = await measureP95(world, () => world.as('ind-reader', 'GET', url), 5000);
    assertWithinBudget(measured);
    expect(measured.failures).toBe(0);
  });

  it('negative control: the checks of this suite go red on an answer that is wrong on purpose', () => {
    expectCheckFails(() => assertStatus({ status: 200, json: {} }, 404));
    expectCheckFails(() => assertWithinBudget({ p95Ms: 6000, budgetMs: 5000, failures: 0 }));
    expectCheckFails(() => assertWithinBudget({ p95Ms: 10, budgetMs: 5000, failures: 1 }));
  });
});
