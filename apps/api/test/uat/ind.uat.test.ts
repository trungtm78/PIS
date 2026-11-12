import { randomUUID } from 'node:crypto';
import { validateRuleParams } from '@machvon/kernel';
import { TENANT_A, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { assertStatus, expectCheckFails } from './uat-kit';
import type { Reply } from './uat-kit';
import { ROOT_UNIT, UatWorld } from './uat-world';

/**
 * UAT of the indicator dictionary, the entry of figures and the import of a form (docs/uat/ind/uat.json, HSKT row DL.02, screens IND-01 to IND-03): a figure is entered once, entering the same number again
 * changes nothing, a correction needs a reason and keeps every revision, the approved rules block or warn, a locked period is closed, and an Excel form is read through an approved mapping as a dry run first and
 * once per hash. Each case is named by its id in docs/uat/ind/uat.json.
 */
jest.setTimeout(600_000);

const FAMILY = 0x98;
const PERSONAS = {
  'ind-admin': ['ind.read', 'ind.entry', 'ind.import.preview', 'ind.import'],
  'ind-reader': ['ind.read'],
  'ind-checker': ['ind.read'],
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
const list = (reply: Reply, key = 'items'): Array<Record<string, unknown>> => reply.json[key] as Array<Record<string, unknown>>;

describe('UAT of the indicators, their entry and the import of a form (DL.02, IND-01..IND-03)', () => {
  const world = new UatWorld();
  let counter = 0;
  const versions = new Map<string, number>();

  beforeAll(async () => {
    await world.start(PERSONAS, { 'ind-admin': PERSONAS['ind-admin'] });
  }, 600_000);

  afterAll(() => world.stop(), 60_000);

  async function project(): Promise<{ projectId: string; code: string }> {
    counter += 1;
    const projectId = randomUUID();
    const code = `UAT-IND-P${counter}-${projectId.slice(0, 4)}`;
    await world.seedAsAdmin([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, 'Indicator project', $4, $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, code, unitId(ROOT_UNIT), id(FAMILY, 90)],
      ],
    ]);
    return { projectId, code };
  }

  async function period(code: string, status: 'OPEN' | 'LOCKED' = 'OPEN'): Promise<string> {
    const periodId = randomUUID();
    const owner = memberId(world.member('ind-admin'));
    await world.seedAsAdmin([
      [
        status === 'OPEN'
          ? `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
             values ($1, $2, $3, 1, date '2026-10-01', date '2026-10-31', date '2026-11-05' + interval '3 hours', $4, 'MONTH', 2026, 'OPEN', gen_random_uuid(), $5, $5)`
          : `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by, soft_closed_at, locked_at, locked_by)
             values ($1, $2, $3, 1, date '2026-09-01', date '2026-09-30', date '2026-10-05' + interval '3 hours', $4, 'MONTH', 2026, 'LOCKED', gen_random_uuid(), $5, $5, now(), now(), $5)`,
        [TENANT_A, periodId, code, `CAL-${code}`, owner],
      ],
    ]);
    return periodId;
  }

  /** The rule a tenant approves by the two-person rule of the governance module: written as approved, by a maker and a checker. */
  async function approveRule(type: string, code: string, params: Record<string, unknown>): Promise<void> {
    const version = (versions.get(`${type}/${code}`) ?? 0) + 1;
    versions.set(`${type}/${code}`, version);
    await world.seedAsAdmin([
      [
        `insert into machvon.governance_rule (tenant_id, id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at)
         values ($1, $2, $3, $4, $5, 'APPROVED', $6::jsonb, date '2026-01-01', 'Approval of the rule for the UAT', $7, $7, now(), $8, now())`,
        [TENANT_A, randomUUID(), type, code, version, JSON.stringify(validateRuleParams(type, params)), world.idOf('ind-admin'), world.idOf('ind-checker')],
      ],
    ]);
  }

  const enter = (projectId: string, periodId: string, figures: Array<Record<string, unknown>>, persona = 'ind-admin'): Promise<Reply> => world.as(persona, 'POST', '/indicator-figures', { body: { project_id: projectId, period_id: periodId, figures } });

  it('UAT-IND-E2E-01 a figure is entered as revision 1, a correction needs a reason and makes revision 2, and the history, the audit trail and the outbox keep both', async () => {
    const { projectId, code } = await project();
    const periodId = await period('2026-10-A');
    const first = await enter(projectId, periodId, [{ indicator_code: 'PLAN_YEAR', value: '1000' }, { indicator_code: 'PHYSICAL_PROGRESS_REPORTED', value: '12.5' }]);
    assertStatus(first, 200);
    expect(first.json).toMatchObject({ status: 'ENTERED', created: 2, revised: 0, unchanged: 0 });
    const bare = await enter(projectId, periodId, [{ indicator_code: 'PLAN_YEAR', value: '1200' }]);
    assertStatus(bare, 422, 'VALIDATION_FAILED');
    expect(bare.json).toMatchObject({ detail: 'reason' });
    const revised = await enter(projectId, periodId, [{ indicator_code: 'PLAN_YEAR', value: '1200', reason: 'The adjusted plan was published' }]);
    expect(revised.json).toMatchObject({ created: 0, revised: 1 });
    const history = await world.as('ind-reader', 'GET', `/indicator-figures/history?project_id=${projectId}&period_id=${periodId}&indicator_code=PLAN_YEAR`);
    expect(list(history).map((figure) => [figure.revision, figure.value])).toEqual([[2, '1200'], [1, '1000']]);
    const trail = (await world.rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where action = 'ind.figure_revised' and safe_diff->>'project_code' = $1", [code]))[0];
    expect(trail?.safe_diff).toMatchObject({ indicator_code: 'PLAN_YEAR', revision: 2, value: '1200', with_reason: true });
    // The reason is kept as the reason of the revision, never in the safe diff of the audit trail.
    expect(JSON.stringify(trail?.safe_diff)).not.toContain('adjusted plan');
    const announced = await world.rows<{ aggregate_version: string }>("select aggregate_version::text from machvon.outbox_event where type = 'ind.figure.entered.v1' and payload->>'project_id' = $1 order by aggregate_version", [projectId]);
    expect(announced.map((row) => row.aggregate_version)).toEqual(['1', '1', '2']);
  });

  it('UAT-IND-IDM-01 entering the same number again changes nothing: no revision, no event, and the answer says unchanged', async () => {
    const { projectId } = await project();
    const periodId = await period('2026-10-B');
    assertStatus(await enter(projectId, periodId, [{ indicator_code: 'PLAN_YEAR', value: '1000' }]), 200);
    const same = await enter(projectId, periodId, [{ indicator_code: 'PLAN_YEAR', value: '1000' }]);
    expect(same.json).toMatchObject({ created: 0, revised: 0, unchanged: 1 });
    expect(await world.rows("select 1 from machvon.outbox_event where type = 'ind.figure.entered.v1' and payload->>'project_id' = $1", [projectId])).toHaveLength(1);
    const current = await world.as('ind-reader', 'GET', `/indicator-figures?project_id=${projectId}&period_id=${periodId}`);
    expect(list(current).map((figure) => [figure.indicator_code, figure.revision])).toEqual([['PLAN_YEAR', 1]]);
  });

  it('UAT-IND-EDG-01 a derived, unknown or repeated indicator, a number that does not fit its unit and an empty list are refused (422) and write nothing', async () => {
    const { projectId } = await project();
    const periodId = await period('2026-10-C');
    for (const [figures, detail] of [
      [[{ indicator_code: 'RATE_YEAR_IN_FORCE', value: '5' }], 'figures[0].indicator_code'],
      [[{ indicator_code: 'NO_SUCH_CODE', value: '5' }], 'figures[0].indicator_code'],
      [[{ indicator_code: 'PLAN_YEAR', value: '5' }, { indicator_code: 'PLAN_YEAR', value: '6' }], 'figures[1].indicator_code'],
      [[{ indicator_code: 'PLAN_YEAR', value: '5.5' }], 'figures[0].value'],
    ] as const) {
      const reply = await enter(projectId, periodId, figures as unknown as Array<Record<string, unknown>>);
      assertStatus(reply, 422, 'VALIDATION_FAILED');
      expect(reply.json).toMatchObject({ detail });
    }
    assertStatus(await enter(projectId, periodId, [{ indicator_code: 'PLAN_YEAR', value: '1,5' }]), 422);
    assertStatus(await enter(projectId, periodId, []), 422);
    assertStatus(await world.as('ind-reader', 'GET', '/indicators/detail?code=NO_SUCH_CODE'), 404);
    expect(list(await world.as('ind-reader', 'GET', `/indicator-figures?project_id=${projectId}&period_id=${periodId}`))).toEqual([]);
  });

  it('UAT-IND-STA-01 a locked period takes no figure (409 PERIOD_LOCKED) and a reader may not enter one (403); nothing is written for either', async () => {
    const { projectId } = await project();
    const locked = await period('2026-09-C', 'LOCKED');
    const open = await period('2026-10-D');
    const figure = [{ indicator_code: 'PLAN_YEAR', value: '1' }];
    assertStatus(await enter(projectId, locked, figure), 409, 'PERIOD_LOCKED');
    assertStatus(await enter(projectId, open, figure, 'ind-reader'), 403);
    expect(list(await world.as('ind-admin', 'GET', `/indicator-figures?project_id=${projectId}`))).toEqual([]);
  });

  it('UAT-IND-DAT-01 an approved blocking rule refuses the figures with the rule named (422 IND_ENTRY_RULE_VIOLATED) and writes nothing, and a warning passes and is in the audit trail', async () => {
    const { projectId, code } = await project();
    const periodId = await period('2026-10-E');
    await approveRule('DATA_ENTRY_RULE', 'EQUITY_PLUS_DEBT_EQUALS_TOTAL', { check: 'PARTS_EQUAL_TOTAL', severity: 'BLOCK', fields: ['EQUITY', 'DEBT'], total_field: 'TOTAL', tolerance: 0, message: 'Equity plus loan must equal the total', surfaces: ['INDICATOR_ENTRY'] });
    await approveRule('DATA_ENTRY_RULE', 'PROGRESS_WARNING', { check: 'VALUE_IN_RANGE', severity: 'WARN', fields: ['PHYSICAL_PROGRESS'], min: '0', max: '90', message: 'Progress above 90 percent: check it', surfaces: ['INDICATOR_ENTRY'] });
    const blocked = await enter(projectId, periodId, [{ indicator_code: 'EQUITY_CAPITAL', value: '400' }, { indicator_code: 'LOAN_CAPITAL', value: '500' }, { indicator_code: 'TOTAL_FUNDING', value: '1000' }]);
    assertStatus(blocked, 422, 'IND_ENTRY_RULE_VIOLATED');
    expect(blocked.json).toMatchObject({ detail: 'EQUITY_PLUS_DEBT_EQUALS_TOTAL' });
    expect(JSON.stringify(blocked.json)).toContain('Equity plus loan must equal the total');
    expect(list(await world.as('ind-admin', 'GET', `/indicator-figures?project_id=${projectId}&period_id=${periodId}`))).toEqual([]);
    const ok = await enter(projectId, periodId, [{ indicator_code: 'EQUITY_CAPITAL', value: '400' }, { indicator_code: 'LOAN_CAPITAL', value: '600' }, { indicator_code: 'TOTAL_FUNDING', value: '1000' }, { indicator_code: 'PHYSICAL_PROGRESS_REPORTED', value: '95' }]);
    assertStatus(ok, 200);
    expect(list(ok, 'warnings').map((one) => one.rule_code)).toEqual(['PROGRESS_WARNING']);
    const warned = (await world.rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where action = 'ind.entry_warned' and safe_diff->>'project_code' = $1", [code]))[0];
    expect(warned?.safe_diff).toMatchObject({ surface: 'INDICATOR_ENTRY', warned: [{ rule_code: 'PROGRESS_WARNING' }] });
  });

  it('UAT-IND-E2E-02 an Excel form is refused while no mapping is approved, then read through the approved one as a dry run that writes nothing, applied once per file, with the line and the mapping version kept', async () => {
    const { projectId, code } = await project();
    const periodId = await period('2026-10-F');
    const file = csv(HEADER, `${code},2026-10-F,"1.000","400","600","250"`);
    const stored = await world.store(file, 'import', 'text/csv', 'ind-admin');
    const importBody = { mapping_code: 'MONTHLY_FORM', file_object_key: stored.key, file_sha256: stored.sha };
    const sample = await world.as('ind-admin', 'POST', '/indicator-imports/preview', { body: { ...importBody, mapping_code: 'SAMPLE_COLUMNS_FORM' } });
    assertStatus(sample, 409, 'IND_MAPPING_NOT_APPROVED');
    await approveRule('INDICATOR_IMPORT_MAPPING', 'MONTHLY_FORM', MAPPING);
    const door = await world.door('ind-admin', '/indicator-imports/files', file, 'text/csv', 'form.csv');
    assertStatus(door, 200);
    expect(door.json).toMatchObject({ fitting_mappings: ['MONTHLY_FORM'], file_sha256: stored.sha });
    const preview = await world.as('ind-admin', 'POST', '/indicator-imports/preview', { body: importBody });
    assertStatus(preview, 200);
    expect(preview.json).toMatchObject({ mode: 'DRY_RUN', already_applied: false, counts: { total: 1, valid: 1, errors: 0 } });
    expect(list(await world.as('ind-admin', 'GET', `/indicator-figures?project_id=${projectId}&period_id=${periodId}`))).toEqual([]);
    const applied = await world.as('ind-admin', 'POST', '/indicator-imports', { body: importBody });
    assertStatus(applied, 200);
    expect(applied.json).toMatchObject({ status: 'APPLIED', mapping_version: 1, counts: { applied: 1 }, figures_written: 4 });
    const figures = await world.as('ind-admin', 'GET', `/indicator-figures?project_id=${projectId}&period_id=${periodId}`);
    expect(list(figures).map((figure) => [figure.indicator_code, figure.value, figure.source, figure.mapping_code, figure.mapping_version])).toEqual([
      ['CUMULATIVE_YTD', '250', 'IMPORT', 'MONTHLY_FORM', 1],
      ['EQUITY_CAPITAL', '400', 'IMPORT', 'MONTHLY_FORM', 1],
      ['LOAN_CAPITAL', '600', 'IMPORT', 'MONTHLY_FORM', 1],
      ['TOTAL_INVESTMENT', '1000', 'IMPORT', 'MONTHLY_FORM', 1],
    ]);
    expect(list(figures)[0]).toMatchObject({ import_id: applied.json.resource_id, import_line: 2 });
    assertStatus(await world.as('ind-admin', 'POST', '/indicator-imports', { body: importBody }), 409, 'IMPORT_FILE_ALREADY_APPLIED');
    expect((await world.audits(applied.json.resource_id as string, 'ind.import_applied'))[0]?.safe_diff).toMatchObject({ mapping_code: 'MONTHLY_FORM', mapping_version: 1, figures_written: 4 });
    expect(await world.rows('select 1 from machvon.ind_figure where import_id = $1::uuid', [applied.json.resource_id])).toHaveLength(4);
  });

  it('UAT-IND-ISO-01 a member of another tenant cannot enter a figure for a project of this tenant (404) and reads an empty dictionary of figures', async () => {
    const { projectId } = await project();
    const periodId = await period('2026-10-G');
    const foreign = await world.asTenantB(1, 'POST', '/indicator-figures', { body: { project_id: projectId, period_id: periodId, figures: [{ indicator_code: 'PLAN_YEAR', value: '1' }] } });
    assertStatus(foreign, 404);
    expect(list(await world.asTenantB(1, 'GET', `/indicator-figures?project_id=${projectId}`))).toEqual([]);
    assertStatus(await world.asTenantB(1, 'GET', '/indicators'), 200);
  });

  it('negative control: the checks of this suite go red on an answer that is wrong on purpose', () => {
    expectCheckFails(() => assertStatus({ status: 200, json: {} }, 422, 'VALIDATION_FAILED'));
    expectCheckFails(() => assertStatus({ status: 422, json: { code: 'OTHER' } }, 422, 'VALIDATION_FAILED'));
  });
});
