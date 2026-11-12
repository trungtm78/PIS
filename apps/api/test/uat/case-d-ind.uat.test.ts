import { randomUUID } from 'node:crypto';
import { BASELINE_PACK, applyBaseline } from '@machvon/db';
import { vietnamDateOf } from '@machvon/kernel';
import type { TenantDatabase } from '@machvon/db';
import { TENANT_A, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import type { Doc } from './case-d-support';
import { assertStatus, expectCheckFails } from './uat-kit';
import type { Reply } from './uat-kit';
import { ROOT_UNIT, UatWorld } from './uat-world';

/**
 * The design cases of the indicators, their entry and the import of a form that no suite named (docs/uat/ind/uat.json): PLAN-IND-1 (the dictionary and the entry rules, with and without the starting templates),
 * PLAN-IND-2 (the entry of figures under an approved blocking and warning rule, revisions and a locked period), PLAN-IND-3 (the form F-1 through the sample and the approved mapping) and IND-PX-01 (the labels of
 * what the platform started with while the dictionary and the rules are not agreed by the customer, PENDING-EXTERNAL PX-02).
 * The rules and mappings are approved by the real commands of the governance module (drafted by one person, submitted by another, approved by a third), and the periods are generated, closed and locked by the real
 * commands of DIS; only the projects are written as a superuser, as no command of this area makes one. The world is the whole enterprise edition over a real database.
 */
jest.setTimeout(600_000);

const FAMILY = 0x9b;
const UNIT_B = 2; // the unit of the importer whose scope is one unit
const UNIT_C = 3; // another unit: a project of it is outside that scope
const SYSTEM_ACTOR = '00000000-0000-4000-8000-000000000000';
const PERSONAS = {
  'ind-admin': ['ind.read', 'ind.entry', 'ind.import.preview', 'ind.import'],
  'ind-reader': ['ind.read'],
  'ind-scoped': ['ind.read', 'ind.import.preview', 'ind.import'],
  'gov-drafter': ['adm.governance.manage', 'adm.governance.read'],
  'gov-submitter': ['adm.governance.manage', 'adm.governance.read'],
  'gov-approver': ['adm.governance.approve', 'adm.governance.read'],
  'dis-manager': ['period.manage', 'period.lock', 'reporting_period.read'],
};
const HEADER = 'Project,Period,Total investment,Equity,Loan,Cumulative';
const MAPPING = {
  name: 'Form with a row for each project',
  layout: 'COLUMNS',
  number_format: 'VN',
  project_column: 'Project',
  period_column: 'Period',
  lines: [
    { indicator: 'TOTAL_INVESTMENT', source: 'Total investment', scale: 'ONE' },
    { indicator: 'EQUITY_CAPITAL', source: 'Equity', scale: 'ONE' },
    { indicator: 'LOAN_CAPITAL', source: 'Loan', scale: 'ONE' },
    { indicator: 'CUMULATIVE_YTD', source: 'Cumulative', scale: 'ONE' },
  ],
};
const csv = (...lines: string[]): Uint8Array => new TextEncoder().encode(lines.join('\n'));
const list = (reply: Reply, key = 'items'): Array<Doc> => reply.json[key] as Array<Doc>;

describe('UAT cases of the indicators, their entry and the import of a form (PLAN-IND-1..3, IND-PX-01)', () => {
  const world = new UatWorld();
  let counter = 0;

  beforeAll(async () => {
    await world.start(PERSONAS, {}, async (w) => {
      await w.harness.seedUnits(TENANT_A, [
        { n: UNIT_B, path: `/${unitId(ROOT_UNIT)}/${unitId(UNIT_B)}/`, parent: ROOT_UNIT },
        { n: UNIT_C, path: `/${unitId(ROOT_UNIT)}/${unitId(UNIT_C)}/`, parent: ROOT_UNIT },
      ]);
      // The importer of the case reads and imports for the projects of one unit only.
      await w.harness.owner(TENANT_A, [
        [
          "update machvon.role_grant set scope_kind = 'UNIT_SUBTREE', scope_ref_ids = array[$2]::uuid[], scope_json = $3::jsonb where membership_id = $1::uuid",
          [memberId(w.member('ind-scoped')), unitId(UNIT_B), JSON.stringify({ kind: 'UNIT_SUBTREE', ref_ids: [unitId(UNIT_B)] })],
        ],
      ]);
      // The reporting calendar of the platform: the periods are generated from it by DIS.
      await (w.harness.tenants as TenantDatabase).withTenant({ tenantId: TENANT_A, membershipId: SYSTEM_ACTOR, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, SYSTEM_ACTOR));
    });
    assertStatus(await world.as('dis-manager', 'POST', '/reporting-periods/generate', { body: { calendar_code: 'DEFAULT', fiscal_year: 2026, period_type: 'MONTH' } }), 200);
  }, 600_000);

  afterAll(() => world.stop(), 60_000);

  async function project(unit = ROOT_UNIT): Promise<{ projectId: string; code: string }> {
    counter += 1;
    const projectId = randomUUID();
    const code = `UAT-INDC-P${counter}-${projectId.slice(0, 4)}`;
    await world.seedAsAdmin([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, 'Indicator project', $4, $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, code, unitId(unit), id(FAMILY, 90)],
      ],
    ]);
    return { projectId, code };
  }

  /** The period of a month of 2026 as DIS generated it. */
  async function periodOf(month: string): Promise<{ id: string; code: string; status: string }> {
    const [row] = await world.rows<{ id: string; code: string; status: string }>('select id::text, code, status from machvon.reporting_period where period_type = $1 and calendar_code = $2 and start_date = $3::date', ['MONTH', 'DEFAULT', `${month}-01`]);
    if (row === undefined) throw new Error(`no period of ${month}`);
    return row;
  }

  /** Closes and locks a period by the commands of DIS, after its deadline. */
  async function lock(periodId: string): Promise<void> {
    assertStatus(await world.as('dis-manager', 'POST', `/reporting-periods/${periodId}/soft-close`, { ifMatch: 1, body: { reason: 'The deadline has passed' } }), 200);
    assertStatus(await world.as('dis-manager', 'POST', `/reporting-periods/${periodId}/lock`, { ifMatch: 2, body: { reason: 'Locked after the review' } }), 200);
  }

  /** The rule a tenant approves by the two-person rule of the governance module: drafted by one person, submitted by a second, approved by a third. */
  async function approveRule(type: string, code: string, params: Record<string, unknown>): Promise<string> {
    const drafted = await world.as('gov-drafter', 'POST', '/governance-rules', { body: { rule_type: type, code, params, effective_from: vietnamDateOf(new Date()), reason: 'The rule is agreed with the owner of the figures' } });
    assertStatus(drafted, 201);
    const ruleId = drafted.json.resource_id as string;
    const submitted = await world.as('gov-submitter', 'POST', `/governance-rules/${ruleId}/submit`, { ifMatch: drafted.json.resource_version as number, body: { reason: 'Submitted for approval' } });
    assertStatus(submitted, 200);
    assertStatus(await world.as('gov-approver', 'POST', `/governance-rules/${ruleId}/approve`, { ifMatch: submitted.json.resource_version as number, body: { reason: 'Approved by the head of the data team' } }), 200);
    return ruleId;
  }

  const enter = (projectId: string, periodId: string, figures: Array<Record<string, unknown>>, persona = 'ind-admin'): Promise<Reply> => world.as(persona, 'POST', '/indicator-figures', { body: { project_id: projectId, period_id: periodId, figures } });
  const evaluate = (values: Record<string, string>, includeTemplates: boolean): Promise<Reply> => world.as('ind-admin', 'POST', '/indicator-entry-rules/evaluate', { body: { surface: 'INDICATOR_ENTRY', values, include_templates: includeTemplates } });
  const figuresOf = (projectId: string, periodId: string): Promise<Reply> => world.as('ind-admin', 'GET', `/indicator-figures?project_id=${projectId}&period_id=${periodId}`);

  // The first case of the file reads what the platform started with, before any rule of the tenant is approved.
  it('UAT-IND-PX-01 the starting indicators and the starting rules are written origin DEFAULT and unverified, the templates of the rules are not active, and what the customer has not agreed is told so (the data of the unconfirmed band)', async () => {
    const dictionary = await world.as('ind-reader', 'GET', '/indicators');
    assertStatus(dictionary, 200);
    const indicators = list(dictionary);
    expect(indicators.length).toBeGreaterThan(10);
    // Every indicator is the platform's own (origin DEFAULT); the ones the entry is made on carry no confirmation by the customer (unverified true). A few built-in indicators have a legal text behind them and say so.
    for (const indicator of indicators) expect([indicator.code, indicator.origin]).toEqual([indicator.code, 'DEFAULT']);
    for (const code of ['PLAN_YEAR', 'TOTAL_INVESTMENT', 'CUMULATIVE_YTD', 'EQUITY_CAPITAL', 'LOAN_CAPITAL']) expect([code, indicators.find((indicator) => indicator.code === code)?.unverified]).toEqual([code, true]);
    const rules = await world.as('ind-reader', 'GET', '/indicator-entry-rules');
    assertStatus(rules, 200);
    const templates = list(rules);
    expect(templates.length).toBeGreaterThanOrEqual(4);
    for (const rule of templates) expect([rule.code, rule.origin, rule.unverified, rule.active]).toEqual([rule.code, 'DEFAULT', true, false]);
    expect(templates.map((rule) => rule.code)).toContain('CUMULATIVE_NOT_ABOVE_TOTAL');
    // The mapping of the platform is a sample too: unverified and not active.
    const mappings = list(await world.as('ind-reader', 'GET', '/indicator-import-mappings'));
    expect(mappings.length).toBeGreaterThanOrEqual(1);
    for (const mapping of mappings) expect([mapping.code, mapping.origin, mapping.unverified, mapping.active]).toEqual([mapping.code, 'DEFAULT', true, false]);
    // Nothing of the tenant is approved: no rule of the tenant is in force until it approves one.
    expect(await world.rows("select 1 from machvon.governance_rule where status = 'APPROVED'")).toHaveLength(0);
  });

  it('UAT-PLAN-IND-1 the dictionary does not let a derived indicator be entered and the starting rules are templates; a cumulative above the total is allowed without the templates and blocked with them; once the tenant approves the rule it is blocked by that rule only', async () => {
    // Step 1: the dictionary and the rules.
    const dictionary = list(await world.as('ind-reader', 'GET', '/indicators'));
    const derived = dictionary.filter((indicator) => indicator.enterable === false);
    expect(derived.length).toBeGreaterThanOrEqual(1);
    expect(derived.map((indicator) => indicator.code)).toContain('RATE_YEAR_IN_FORCE');
    expect(dictionary.filter((indicator) => indicator.enterable === true).map((indicator) => indicator.code)).toEqual(expect.arrayContaining(['PLAN_YEAR', 'TOTAL_INVESTMENT', 'CUMULATIVE_YTD']));
    const { projectId } = await project();
    const open = await periodOf('2026-12');
    assertStatus(await enter(projectId, open.id, [{ indicator_code: 'RATE_YEAR_IN_FORCE', value: '5' }]), 422, 'VALIDATION_FAILED');
    const startingRules = list(await world.as('ind-reader', 'GET', '/indicator-entry-rules'));
    expect(startingRules.every((rule) => rule.active === false && rule.origin === 'DEFAULT')).toBe(true);
    // Step 2: a cumulative of 9 against a total investment of 1.
    const facts = { CUMULATIVE: '9', TOTAL_INVESTMENT: '1' };
    const without = await evaluate(facts, false);
    assertStatus(without, 200);
    expect(without.json).toMatchObject({ allowed: true, violations: [] });
    const withTemplates = await evaluate(facts, true);
    assertStatus(withTemplates, 200);
    expect(withTemplates.json).toMatchObject({ allowed: false });
    expect(list(withTemplates, 'violations').map((one) => [one.rule_code, one.severity])).toEqual([['CUMULATIVE_NOT_ABOVE_TOTAL', 'BLOCK']]);
    // The same figures typed in a real entry pass while no rule is approved.
    assertStatus(await enter(projectId, open.id, [{ indicator_code: 'CUMULATIVE_YTD', value: '9' }]), 200);
    // Step 3: the tenant approves the rule; now it blocks without the templates, and by that rule only (one violation, the version of the approved rule).
    const ruleId = await approveRule('DATA_ENTRY_RULE', 'CUMULATIVE_NOT_ABOVE_TOTAL', { check: 'CUMULATIVE_NOT_ABOVE_TOTAL', severity: 'BLOCK', fields: ['CUMULATIVE'], total_field: 'TOTAL_INVESTMENT', tolerance: 0, message: 'The cumulative must not exceed the total investment', surfaces: ['INDICATOR_ENTRY'] });
    const approved = await evaluate(facts, false);
    expect(approved.json).toMatchObject({ allowed: false });
    for (const includeTemplates of [false, true]) {
      const reply = await evaluate(facts, includeTemplates);
      expect(list(reply, 'violations')).toHaveLength(1);
      expect(list(reply, 'violations')[0]).toMatchObject({ rule_code: 'CUMULATIVE_NOT_ABOVE_TOTAL', rule_version: 1, severity: 'BLOCK', message: 'The cumulative must not exceed the total investment' });
    }
    const adopted = list(await world.as('ind-reader', 'GET', '/indicator-entry-rules')).find((rule) => rule.code === 'CUMULATIVE_NOT_ABOVE_TOTAL');
    expect(adopted).toMatchObject({ active: true, version: 1 });
    expect(adopted?.origin).not.toBe('DEFAULT');
    // A real entry above the total is now refused by the approved rule, and the rule that is in force is the one the tenant approved (id).
    const refused = await enter(projectId, open.id, [{ indicator_code: 'CUMULATIVE_YTD', value: '5000' }]);
    assertStatus(refused, 422, 'IND_ENTRY_RULE_VIOLATED');
    expect(refused.json).toMatchObject({ detail: 'CUMULATIVE_NOT_ABOVE_TOTAL' });
    expect((await world.rows<{ id: string }>("select id::text from machvon.governance_rule where code = 'CUMULATIVE_NOT_ABOVE_TOTAL' and status = 'APPROVED'"))[0]?.id).toBe(ruleId);
  });

  it('UAT-PLAN-IND-2 equity plus loan not equal to the total is refused (422 IND_ENTRY_RULE_VIOLATED) and writes nothing, a warning passes with revision 1 and the warning in the audit trail, the same figure again changes nothing, a different one needs a reason and makes revision 2, and a locked period refuses (409 PERIOD_LOCKED)', async () => {
    await approveRule('DATA_ENTRY_RULE', 'EQUITY_PLUS_DEBT_EQUALS_TOTAL', { check: 'PARTS_EQUAL_TOTAL', severity: 'BLOCK', fields: ['EQUITY', 'DEBT'], total_field: 'TOTAL', tolerance: 0, message: 'Equity plus loan must equal the total', surfaces: ['INDICATOR_ENTRY'] });
    await approveRule('DATA_ENTRY_RULE', 'PROGRESS_WARNING', { check: 'VALUE_IN_RANGE', severity: 'WARN', fields: ['PHYSICAL_PROGRESS'], min: '0', max: '90', message: 'Progress above 90 percent: check it', surfaces: ['INDICATOR_ENTRY'] });
    const { projectId, code } = await project();
    const open = await periodOf('2026-12');
    const closed = await periodOf('2026-08');
    await lock(closed.id);
    // Step 1: equity 400 and loan 500 against a total of 1000: refused, nothing written.
    const blocked = await enter(projectId, open.id, [{ indicator_code: 'EQUITY_CAPITAL', value: '400' }, { indicator_code: 'LOAN_CAPITAL', value: '500' }, { indicator_code: 'TOTAL_FUNDING', value: '1000' }]);
    assertStatus(blocked, 422, 'IND_ENTRY_RULE_VIOLATED');
    expect(blocked.json).toMatchObject({ detail: 'EQUITY_PLUS_DEBT_EQUALS_TOTAL' });
    expect(list(await figuresOf(projectId, open.id))).toEqual([]);
    // Step 2: equity 400, loan 600, total 1000 and a progress of 95 (a warning): revision 1 for each figure, with the warning in the audit trail.
    const ok = await enter(projectId, open.id, [
      { indicator_code: 'EQUITY_CAPITAL', value: '400' },
      { indicator_code: 'LOAN_CAPITAL', value: '600' },
      { indicator_code: 'TOTAL_FUNDING', value: '1000' },
      { indicator_code: 'PHYSICAL_PROGRESS_REPORTED', value: '95' },
      { indicator_code: 'PLAN_YEAR', value: '1000' },
    ]);
    assertStatus(ok, 200);
    expect(ok.json).toMatchObject({ status: 'ENTERED', created: 5, revised: 0, unchanged: 0 });
    expect(list(ok, 'warnings').map((one) => one.rule_code)).toEqual(['PROGRESS_WARNING']);
    expect(list(await figuresOf(projectId, open.id)).every((figure) => figure.revision === 1)).toBe(true);
    const warned = (await world.rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where action = 'ind.entry_warned' and safe_diff->>'project_code' = $1", [code]))[0];
    expect(warned?.safe_diff).toMatchObject({ surface: 'INDICATOR_ENTRY', warned: [{ rule_code: 'PROGRESS_WARNING' }] });
    // Step 3: the same plan figure again changes nothing: no revision, no event.
    const same = await enter(projectId, open.id, [{ indicator_code: 'PLAN_YEAR', value: '1000' }]);
    expect(same.json).toMatchObject({ created: 0, revised: 0, unchanged: 1 });
    expect(await world.rows("select 1 from machvon.outbox_event where type = 'ind.figure.entered.v1' and payload->>'project_id' = $1 and aggregate_version = 2", [projectId])).toHaveLength(0);
    // Step 4: a different plan figure without a reason is refused on the reason; with one it is revision 2.
    const bare = await enter(projectId, open.id, [{ indicator_code: 'PLAN_YEAR', value: '1200' }]);
    assertStatus(bare, 422, 'VALIDATION_FAILED');
    expect(bare.json).toMatchObject({ detail: 'reason' });
    const revised = await enter(projectId, open.id, [{ indicator_code: 'PLAN_YEAR', value: '1200', reason: 'The adjusted plan was published' }]);
    assertStatus(revised, 200);
    expect(revised.json).toMatchObject({ created: 0, revised: 1, unchanged: 0 });
    const history = await world.as('ind-reader', 'GET', `/indicator-figures/history?project_id=${projectId}&period_id=${open.id}&indicator_code=PLAN_YEAR`);
    expect(list(history).map((figure) => [figure.revision, figure.value])).toEqual([[2, '1200'], [1, '1000']]);
    // Step 5: a locked period takes no figure, and nothing is written for it.
    assertStatus(await enter(projectId, closed.id, [{ indicator_code: 'PLAN_YEAR', value: '1' }]), 409, 'PERIOD_LOCKED');
    expect(list(await figuresOf(projectId, closed.id))).toEqual([]);
  });

  it('UAT-PLAN-IND-3 the form F-1 of five rows is refused through the sample mapping (409 IND_MAPPING_NOT_APPROVED); through the approved mapping the dry run writes nothing and the apply writes the valid figures with the file, the line and the mapping version, the refused rows are reported with line, field and code, the differing number is a difference, and the file cannot be applied again', async () => {
    const importRule = await approveRule('DATA_ENTRY_RULE', 'IMPORT_CUMULATIVE_NOT_ABOVE_TOTAL', { check: 'CUMULATIVE_NOT_ABOVE_TOTAL', severity: 'BLOCK', fields: ['CUMULATIVE'], total_field: 'TOTAL_INVESTMENT', tolerance: 0, message: 'The cumulative must not exceed the total investment', surfaces: ['INDICATOR_IMPORT'] });
    expect(importRule).toMatch(/^[0-9a-f-]{36}$/);
    const open = await periodOf('2026-11');
    const good = await project(UNIT_B);
    const outside = await project(UNIT_C);
    const unknownPeriod = await project(UNIT_B);
    const blocked = await project(UNIT_B);
    const differing = await project(UNIT_B);
    // The register already holds a number of the project of line 6: the file says another.
    assertStatus(await enter(differing.projectId, open.id, [{ indicator_code: 'TOTAL_INVESTMENT', value: '1500' }]), 200);
    const file = csv(
      HEADER,
      `${good.code},${open.code},"1.000","400","600","250"`,
      `${outside.code},${open.code},"1.000","400","600","250"`,
      `${unknownPeriod.code},NO-SUCH-PERIOD,"1.000","400","600","250"`,
      `${blocked.code},${open.code},"1.000","400","600","5.000"`,
      `${differing.code},${open.code},"1.000","400","600","250"`,
    );
    const stored = await world.store(file, 'import', 'text/csv', 'ind-scoped');
    const request = (mapping: string): Record<string, unknown> => ({ mapping_code: mapping, file_object_key: stored.key, file_sha256: stored.sha });
    // Step 1: the sample of the platform is a template: it reads no file.
    const sample = await world.as('ind-scoped', 'POST', '/indicator-imports/preview', { body: request('SAMPLE_COLUMNS_FORM') });
    assertStatus(sample, 409, 'IND_MAPPING_NOT_APPROVED');
    const sampleRow = list(await world.as('ind-reader', 'GET', '/indicator-import-mappings')).find((mapping) => mapping.code === 'SAMPLE_COLUMNS_FORM');
    expect(sampleRow).toMatchObject({ origin: 'DEFAULT', unverified: true, active: false });
    // Step 2: the mapping the tenant approved reads it. The dry run writes nothing.
    await approveRule('INDICATOR_IMPORT_MAPPING', 'MONTHLY_FORM', MAPPING);
    const dry = await world.as('ind-scoped', 'POST', '/indicator-imports/preview', { body: request('MONTHLY_FORM') });
    assertStatus(dry, 200);
    expect(dry.json).toMatchObject({ mode: 'DRY_RUN', mapping_code: 'MONTHLY_FORM', mapping_version: 1, already_applied: false, counts: { total: 5, valid: 2, errors: 3 } });
    expect(await world.rows('select 1 from machvon.ind_figure where project_id = any($1::uuid[]) and import_id is not null', [[good.projectId, outside.projectId, unknownPeriod.projectId, blocked.projectId, differing.projectId]])).toHaveLength(0);
    const applied = await world.as('ind-scoped', 'POST', '/indicator-imports', { body: request('MONTHLY_FORM') });
    assertStatus(applied, 200);
    expect(applied.json).toMatchObject({ status: 'APPLIED', mapping_version: 1, counts: { total: 5, applied: 2, quarantined: 3, differences_opened: 1 }, figures_written: 7 });
    const importId = applied.json.resource_id as string;
    // The valid figures carry the file (the import), the line of the file and the version of the mapping.
    const written = list(await figuresOf(good.projectId, open.id));
    expect(written.map((figure) => [figure.indicator_code, figure.value, figure.source, figure.mapping_code, figure.mapping_version, figure.import_id, figure.import_line])).toEqual([
      ['CUMULATIVE_YTD', '250', 'IMPORT', 'MONTHLY_FORM', 1, importId, 2],
      ['EQUITY_CAPITAL', '400', 'IMPORT', 'MONTHLY_FORM', 1, importId, 2],
      ['LOAN_CAPITAL', '600', 'IMPORT', 'MONTHLY_FORM', 1, importId, 2],
      ['TOTAL_INVESTMENT', '1000', 'IMPORT', 'MONTHLY_FORM', 1, importId, 2],
    ]);
    // The refused rows are in the error report with line, field and code; the held number is kept and the other one is a difference.
    const report = await world.as('ind-admin', 'GET', `/indicator-imports/rows?import_id=${importId}`);
    assertStatus(report, 200);
    expect(list(report, 'errors').map((error) => [error.line, error.field, error.code])).toEqual([
      [3, 'project', 'PROJECT_UNKNOWN'],
      [4, 'period', 'PERIOD_UNKNOWN'],
      [5, 'IMPORT_CUMULATIVE_NOT_ABOVE_TOTAL', 'ENTRY_RULE_BLOCKED'],
    ]);
    const differences = list(report, 'differences');
    expect(differences).toHaveLength(1);
    expect(differences[0]).toMatchObject({ line: 6, status: expect.any(String) });
    expect(JSON.stringify(differences[0])).toContain('1500');
    expect(JSON.stringify(differences[0])).toContain('1000');
    const held = list(await figuresOf(differing.projectId, open.id)).find((figure) => figure.indicator_code === 'TOTAL_INVESTMENT');
    expect(held).toMatchObject({ value: '1500', revision: 1, source: 'ENTRY' });
    expect((await world.audits(importId, 'ind.import_applied'))[0]).toMatchObject({ actor_id: world.idOf('ind-scoped'), safe_diff: { mapping_code: 'MONTHLY_FORM', mapping_version: 1, figures_written: 7, figures_differing: 1 } });
    // Step 3: the same file again is already loaded.
    assertStatus(await world.as('ind-scoped', 'POST', '/indicator-imports', { body: request('MONTHLY_FORM') }), 409, 'IMPORT_FILE_ALREADY_APPLIED');
    expect(await world.rows('select 1 from machvon.ind_figure where import_id = $1::uuid', [importId])).toHaveLength(7);
  });

  it('negative control: the checks of this suite go red on an answer that is wrong on purpose', () => {
    expectCheckFails(() => assertStatus({ status: 200, json: {} }, 422, 'IND_ENTRY_RULE_VIOLATED'));
    expectCheckFails(() => assertStatus({ status: 409, json: { code: 'PERIOD_LOCKED' } }, 409, 'IND_MAPPING_NOT_APPROVED'));
  });
});
