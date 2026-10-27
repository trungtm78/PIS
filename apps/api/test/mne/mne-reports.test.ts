import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { ADMIN, APPROVER, BRANCH, INVESTORS, MneApp, OUTSIDE, PREPARER, READER, SCOPED_PREPARER, TENANT_A, TENANT_B, memberId, unitId } from './mne-app';
import type { Reply } from './mne-app';

jest.setTimeout(120_000);

const app = new MneApp();
const etag = (version: number): string => `"${version}"`;
const UNIT = INVESTORS[0];
let counter = 0;

const FIELDS = [
  { key: 'plan_total', label: 'Plan, whole', kind: 'MONEY', required: true, source: { kind: 'SNAPSHOT_METRIC', metric: 'plan_total_vnd' } },
  { key: 'disbursed', label: 'Disbursed', kind: 'MONEY', required: true, source: { kind: 'SNAPSHOT_METRIC', metric: 'disbursed_treasury_vnd' } },
  { key: 'rate_pm', label: 'Rate over the plan of the Prime Minister', kind: 'PERCENT', required: true, source: { kind: 'SNAPSHOT_METRIC', metric: 'rate_pm_pct' } },
  { key: 'rate_total', label: 'Rate over the whole plan', kind: 'PERCENT', required: false, source: { kind: 'SNAPSHOT_METRIC', metric: 'rate_total_pct' } },
  { key: 'projects', label: 'Projects', kind: 'INTEGER', required: false, source: { kind: 'PROJECT_COUNT' } },
  { key: 'assessment', label: 'Assessment', kind: 'TEXT', required: true },
  { key: 'difficulties', label: 'Difficulties', kind: 'TEXT', required: false },
];

const formBody = (formCode: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  form_code: formCode,
  title: 'Overall report',
  report_kind: 'OVERALL_SEMIANNUAL',
  legal_basis: 'Circular 44/2026/TT-BTC [CXN-10]',
  effective_from: '2026-01-01',
  schema_json: { fields: FIELDS },
  doc_template_code: 'MNE-TT44-M02',
  export_formats: ['XLSX'],
  ...overrides,
});

async function publishedForm(formCode: string, overrides: Record<string, unknown> = {}, tenantId?: string): Promise<string> {
  const options = tenantId === undefined ? {} : { tenantId };
  const created = await app.call('POST', '/mne-forms', { member: ADMIN, body: formBody(formCode, overrides), ...options });
  expect(created.status).toBe(200);
  const published = await app.call('POST', `/mne-forms/${created.json.resource_id as string}/publish`, { member: APPROVER, ifMatch: etag(1), ...options });
  expect(published.status).toBe(200);
  return created.json.resource_id as string;
}

async function seed(statements: Array<[string, unknown[]]>): Promise<void> {
  const client = new Client({ connectionString: app.harness.database.adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    for (const [sql, params] of statements) await client.query(sql, params);
  } finally {
    await client.end();
  }
}

/** A project of a unit and a frozen snapshot of 2026-06-30 in which it holds a plan of 1250 billion (1000 billion from the Prime Minister) and 600 billion paid by the Treasury. */
async function world(overrides: { frozen?: boolean; asOf?: string; unit?: number } = {}): Promise<{ snapshotId: string; projectId: string }> {
  counter += 1;
  const projectId = randomUUID();
  const snapshotId = randomUUID();
  const periodId = randomUUID();
  const unit = overrides.unit ?? UNIT;
  await seed([
    [
      `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
       values ($1, $2, $3, 'Bridge', $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
      [TENANT_A, projectId, `MR-${counter}-${projectId.slice(0, 6)}`, unitId(unit), randomUUID()],
    ],
    [
      `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
       values ($1, $2, $3, 1, $4::date, $4::date + 6, now(), 'DEFAULT', 'WEEK', 2026, 'OPEN', $5, $6, $6)`,
      [TENANT_A, periodId, `MRP-${counter}`, new Date(Date.UTC(2043, 0, 2) + counter * 7 * 86_400_000).toISOString().slice(0, 10), randomUUID(), WORKER_MEMBERSHIP_ID],
    ],
    [
      `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, created_by, updated_by)
       values ($1, $2, $3, 'PERIOD_CLOSE', now(), $4::date, $4::date, 'BUILDING', 'DIS-METRICS-R1-PROPOSED', 'PROPOSED_PENDING_SIGNOFF', 1, $5, $5)`,
      [TENANT_A, snapshotId, periodId, overrides.asOf ?? '2026-06-30', WORKER_MEMBERSHIP_ID],
    ],
    [
      `insert into machvon.period_snapshot_line (tenant_id, id, snapshot_id, project_id, unit_id, bucket, budget_level, plan_pm_assigned_vnd, plan_local_added_vnd, plan_total_vnd, disbursed_treasury_vnd, treasury_coverage)
       values ($1, gen_random_uuid(), $2, $3, $4, 'CURRENT_YEAR', 'CENTRAL', 1000000000000, 250000000000, 1250000000000, 600000000000, 'COMPLETE')`,
      [TENANT_A, snapshotId, projectId, unitId(unit)],
    ],
    ...((overrides.frozen ?? true)
      ? ([[`update machvon.period_snapshot set status = 'FROZEN', payload_sha256 = repeat('a', 64), frozen_by = $2, frozen_at = now() where id = $1`, [snapshotId, WORKER_MEMBERSHIP_ID]]] as Array<[string, unknown[]]>)
      : []),
  ]);
  return { snapshotId, projectId };
}

const create = (body: Record<string, unknown>, member = PREPARER, tenantId?: string, key?: string): Promise<Reply> =>
  app.call('POST', '/mne-reports', { member, body, ...(tenantId === undefined ? {} : { tenantId }), ...(key === undefined ? {} : { key }) });
const edit = (id: string, version: number, body: Record<string, unknown>, member = PREPARER): Promise<Reply> => app.call('POST', `/mne-reports/${id}/revisions`, { member, body, ifMatch: etag(version) });
const submit = (id: string, version: number, member = PREPARER): Promise<Reply> => app.call('POST', `/mne-reports/${id}/submit`, { member, ifMatch: etag(version) });
const read = (id: string, member = READER, tenantId?: string): Promise<Reply> => app.call('GET', `/mne-reports/${id}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });
const fieldsOf = (reply: Reply): Record<string, Record<string, unknown>> => Object.fromEntries((reply.json.fields as Array<Record<string, unknown>>).map((field) => [field.key as string, field]));
const reportBody = (formId: string, snapshotId?: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  form_id: formId,
  report_year: 2026,
  period_label: 'H1-2026',
  scope_unit_id: unitId(UNIT),
  ...(snapshotId === undefined ? {} : { snapshot_id: snapshotId }),
  ...overrides,
});

describe('the periodic overall report API (ST-MNE-002, MNE F3, MNE-03)', () => {
  beforeAll(() => app.start(), 240_000);
  afterAll(() => app.stop(), 60_000);
  afterEach(async () => {
    await app.reset();
    await app.reset(TENANT_B);
    await seed([['delete from machvon.period_snapshot_line', []], ['delete from machvon.period_snapshot', []], ['delete from machvon.project', []]]);
  });

  describe('AC-ST-MNE-002-1: the financial cells come from a frozen snapshot and are locked', () => {
    it('UAT-AC287: refuses a report without a snapshot, fills the cells from the snapshot with the two rates of DIS, and locks them', async () => {
      const formId = await publishedForm('TT44-M02');
      const { snapshotId } = await world();
      const without = await create(reportBody(formId));
      expect([without.status, without.json.code]).toEqual([422, 'SNAPSHOT_REQUIRED']);
      expect(await app.count('select count(*)::text as n from machvon.mne_report')).toBe(0);
      const made = await create(reportBody(formId, snapshotId));
      expect(made.status).toBe(200);
      expect(made.json).toMatchObject({ status: 'DRAFT', resource_version: 1 });
      const shown = await read(made.json.resource_id as string);
      expect(shown.status).toBe(200);
      const fields = fieldsOf(shown);
      expect(fields.plan_total).toMatchObject({ value: '1250000000000', locked: true });
      expect(fields.disbursed).toMatchObject({ value: '600000000000', locked: true });
      expect(fields.rate_pm?.value).toBe('60.0000');
      expect(fields.rate_total?.value).toBe('48.0000');
      expect(fields.projects).toMatchObject({ value: 1, locked: true });
      expect(fields.assessment).toMatchObject({ value: null, locked: false, required: true });
      expect(shown.json).toMatchObject({
        status: 'DRAFT',
        period_label: 'H1-2026',
        due_date: '2026-06-30',
        form: { code: 'TT44-M02', revision: 1 },
        snapshot: { id: snapshotId, as_of_date: '2026-06-30' },
        awaiting_confirmation: true,
        cxn_refs: [],
      });
      // The preparer is offered the frozen snapshots of the period (a close of a day not after its end), newest first, and no others.
      expect(shown.json.snapshot_options).toEqual([{ id: snapshotId, as_of_date: '2026-06-30' }]);
      const edited = await edit(made.json.resource_id as string, 1, { narrative: { plan_total: '1' } });
      expect([edited.status, edited.json.code, edited.json.detail]).toEqual([422, 'FIELD_SOURCE_LOCKED', 'narrative.plan_total']);
      expect(edited.json.fields).toEqual(['plan_total']);
      const text = await edit(made.json.resource_id as string, 1, { narrative: { assessment: 'Disbursement is on track.', difficulties: 'Site clearance.' } });
      expect(text.status).toBe(200);
      expect(text.json).toMatchObject({ resource_version: 2 });
      const again = fieldsOf(await read(made.json.resource_id as string));
      expect(again.assessment?.value).toBe('Disbursement is on track.');
      expect(again.plan_total?.value).toBe('1250000000000');
    });

    it('refuses a snapshot that is not frozen (422 SNAPSHOT_NOT_FROZEN) or that is of a day after the period (422 VALIDATION_FAILED)', async () => {
      const formId = await publishedForm('TT44-M02');
      const building = await world({ frozen: false });
      const refused = await create(reportBody(formId, building.snapshotId));
      expect([refused.status, refused.json.code]).toEqual([422, 'SNAPSHOT_NOT_FROZEN']);
      const late = await world({ asOf: '2026-09-30' });
      const after = await create(reportBody(formId, late.snapshotId));
      expect([after.status, after.json.code, after.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'snapshot_id']);
      const unknown = await create(reportBody(formId, randomUUID()));
      expect([unknown.status, unknown.json.code, unknown.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'snapshot_id']);
    });

    it('fills the cells again when another snapshot is attached to the draft, and only the draft', async () => {
      const formId = await publishedForm('TT44-M02');
      const first = await world();
      const made = await create(reportBody(formId, first.snapshotId));
      const id = made.json.resource_id as string;
      const second = await world();
      await seed([[`update machvon.period_snapshot_line set disbursed_treasury_vnd = 900000000000 where snapshot_id = $1`, [second.snapshotId]]]);
      const swapped = await edit(id, 1, { snapshot_id: second.snapshotId });
      expect(swapped.status).toBe(200);
      const fields = fieldsOf(await read(id));
      expect(fields.disbursed?.value).toBe('900000000000');
      expect(fields.rate_pm?.value).toBe('90.0000');
      expect(fields.rate_total?.value).toBe('72.0000');
    });

    it('refuses a cell the form does not have and a value of the wrong kind (422 VALIDATION_FAILED)', async () => {
      const formId = await publishedForm('TT44-M02');
      const { snapshotId } = await world();
      const id = (await create(reportBody(formId, snapshotId))).json.resource_id as string;
      const unknown = await edit(id, 1, { narrative: { nothing: 'x' } });
      expect([unknown.status, unknown.json.code, unknown.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'narrative.nothing']);
      const kind = await edit(id, 1, { narrative: { assessment: 12 } });
      expect([kind.status, kind.json.code, kind.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'narrative.assessment']);
      const cleared = await edit(id, 1, { narrative: { assessment: 'First', difficulties: 'Second' } });
      expect(cleared.status).toBe(200);
      const removed = await edit(id, 2, { narrative: { difficulties: null } });
      expect(removed.status).toBe(200);
      expect(fieldsOf(await read(id)).difficulties?.value).toBeNull();
      const attachment = await edit(id, 3, { attachments: [randomUUID()] });
      expect([attachment.status, attachment.json.code]).toEqual([422, 'DECISION_REQUIRED']);
      const documentId = randomUUID();
      await app.harness.owner(TENANT_A, [
        [
          `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
           values ($1, $2, 'REFERENCE', 'QD', 'Evidence', 'QD-EVIDENCE', '2026-01-15', 'EFFECTIVE', 'INTERNAL', $3, $3)`,
          [TENANT_A, documentId, memberId(PREPARER)],
        ],
      ]);
      const attached = await edit(id, 3, { attachments: [documentId, documentId] });
      expect(attached.status).toBe(200);
      expect((await read(id)).json.attachments).toEqual([documentId]);
    });
  });

  describe('AC-ST-MNE-002-2: the form revision in force on the last day of the period', () => {
    it('UAT-AC286: gives YEAR-2026 revision 1 and H1-2027 revision 2 of the same code, and leaves a report alone when the revision is closed', async () => {
      const first = await publishedForm('TT44-M02', { effective_from: '2026-01-01', title: 'Overall report, first' });
      const secondDraft = await app.call('POST', '/mne-forms', { member: ADMIN, body: formBody('TT44-M02', { effective_from: '2027-01-01', title: 'Overall report, second' }) });
      expect(secondDraft.json.revision).toBe(2);
      const secondId = secondDraft.json.resource_id as string;
      const { snapshotId } = await world();
      const year2026 = await create(reportBody(first, snapshotId, { period_label: 'YEAR-2026' }));
      expect(year2026.status).toBe(200);
      const late = await world({ asOf: '2026-12-31' });
      void late;
      expect((await app.call('POST', `/mne-forms/${secondId}/publish`, { member: APPROVER, ifMatch: etag(1) })).status).toBe(200);
      const shown2026 = await read(year2026.json.resource_id as string);
      expect(shown2026.json).toMatchObject({ period_label: 'YEAR-2026', due_date: '2026-12-31', form: { code: 'TT44-M02', revision: 1, title: 'Overall report, first' } });
      const frozen2027 = await world({ asOf: '2027-06-30' });
      const half2027 = await create(reportBody(first, frozen2027.snapshotId, { report_year: 2027, period_label: 'H1-2027' }));
      expect(half2027.status).toBe(200);
      const shown2027 = await read(half2027.json.resource_id as string);
      expect(shown2027.json).toMatchObject({ period_label: 'H1-2027', due_date: '2027-06-30', form: { code: 'TT44-M02', revision: 2, title: 'Overall report, second' } });
      expect(shown2026.json.form).toMatchObject({ revision: 1 });
      expect(fieldsOf(await read(year2026.json.resource_id as string)).plan_total?.value).toBe('1250000000000');
    });
  });

  describe('AC-ST-MNE-002-3: a form that is not in force', () => {
    it('UAT-AC296: refuses a 2025 report of a form that takes effect in 2026, naming the day (422 FORM_NOT_EFFECTIVE)', async () => {
      const formId = await publishedForm('TT44-M05', { effective_from: '2026-01-01' });
      const { snapshotId } = await world({ asOf: '2025-12-31' });
      const refused = await create(reportBody(formId, snapshotId, { report_year: 2025, period_label: 'H2-2025' }));
      expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'FORM_NOT_EFFECTIVE', 'form_id']);
      expect(refused.json.extensions ?? refused.json).toMatchObject({ effective_from: '2026-01-01', form_code: 'TT44-M05' });
      expect(await app.count('select count(*)::text as n from machvon.mne_report')).toBe(0);
    });
  });

  describe('AC-ST-MNE-002-4: tenants and units', () => {
    it('UAT-AC295: a report of tenant A is not there for a user of tenant B (404 RESOURCE_NOT_FOUND)', async () => {
      const formId = await publishedForm('TT44-M02');
      const { snapshotId } = await world();
      const id = (await create(reportBody(formId, snapshotId))).json.resource_id as string;
      const other = await read(id, ADMIN, TENANT_B);
      expect([other.status, other.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      const edited = await app.call('POST', `/mne-reports/${id}/revisions`, { member: ADMIN, tenantId: TENANT_B, ifMatch: etag(1), body: { narrative: { assessment: 'x' } } });
      expect(edited.status).toBe(403);
      expect((await read(id)).status).toBe(200);
    });

    it('keeps a preparer to the units they reach: 403 SCOPE_DENIED to create, 404 to read, and 404 for a unit that does not exist', async () => {
      const formId = await publishedForm('TT44-M02');
      const outside = await world({ unit: OUTSIDE });
      const inside = await world();
      const denied = await create(reportBody(formId, outside.snapshotId, { scope_unit_id: unitId(OUTSIDE) }), SCOPED_PREPARER);
      expect([denied.status, denied.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const mine = await create(reportBody(formId, inside.snapshotId), SCOPED_PREPARER);
      expect(mine.status).toBe(200);
      const away = await create(reportBody(formId, outside.snapshotId, { scope_unit_id: unitId(OUTSIDE) }), PREPARER);
      expect(away.status).toBe(200);
      const hidden = await read(away.json.resource_id as string, SCOPED_PREPARER);
      expect([hidden.status, hidden.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      const touch = await edit(away.json.resource_id as string, 1, { narrative: { assessment: 'x' } }, SCOPED_PREPARER);
      expect([touch.status, touch.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const nowhere = await create(reportBody(formId, inside.snapshotId, { scope_unit_id: unitId(BRANCH + 20) }), PREPARER);
      expect([nowhere.status, nowhere.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
    });

    it('says a draft past its due date is late by today, as the calendar does, and counts the days', async () => {
      const formId = await publishedForm('TT44-M02');
      const { snapshotId } = await world();
      const id = (await create(reportBody(formId, snapshotId))).json.resource_id as string;
      // Created for H1-2026, due 2026-06-30: long past on the day of the test.
      const shown = await read(id);
      expect(shown.json.is_late).toBe(true);
      expect(shown.json.days_late).toBeGreaterThan(0);
      await app.harness.owner(TENANT_A, [["update machvon.mne_report set due_date = (now() at time zone 'Asia/Ho_Chi_Minh')::date + 5 where id = $1::uuid", [id]]]);
      const open = await read(id);
      expect([open.json.is_late, open.json.days_late]).toEqual([false, 0]);
    });

    it('lets the reader read and nothing else: the reader neither creates, edits nor submits', async () => {
      const formId = await publishedForm('TT44-M02');
      const { snapshotId } = await world();
      expect((await create(reportBody(formId, snapshotId), READER)).status).toBe(403);
      const id = (await create(reportBody(formId, snapshotId))).json.resource_id as string;
      expect((await edit(id, 1, { narrative: { assessment: 'x' } }, READER)).status).toBe(403);
      expect((await submit(id, 1, READER)).status).toBe(403);
      expect((await read(id, READER)).status).toBe(200);
    });
  });

  describe('creating a report that already exists, and the calendar shell', () => {
    it('answers a second report of the same key with 409 REPORT_EXISTS naming the first, and a retry with the same key replays the first answer', async () => {
      const formId = await publishedForm('TT44-M02');
      const { snapshotId } = await world();
      const first = await create(reportBody(formId, snapshotId), PREPARER, undefined, 'report-retry-key-0001');
      const retry = await create(reportBody(formId, snapshotId), PREPARER, undefined, 'report-retry-key-0001');
      expect(retry.json).toEqual(first.json);
      const second = await create(reportBody(formId, snapshotId));
      expect([second.status, second.json.code]).toEqual([409, 'REPORT_EXISTS']);
      expect(JSON.stringify(second.json)).toContain(first.json.resource_id as string);
      expect(await app.count('select count(*)::text as n from machvon.mne_report')).toBe(1);
    });

    it('gives a report made for a rule the deadline of that rule, not the end of the period, and refuses a rule of another form or of a period it does not ask for', async () => {
      const formId = await publishedForm('TT44-M02');
      const other = await publishedForm('TT44-M03', { report_kind: 'OVERALL_ANNUAL', doc_template_code: 'MNE-TT44-M03' });
      const ruleOf = async (form: string, code: string): Promise<string> => {
        const made = await app.call('POST', '/mne-obligation-rules', {
          member: ADMIN,
          body: { rule_code: code, form_id: form, reporting_role: 'INVESTOR', recipient: 'Department of Finance', frequency: 'SEMIANNUAL', due_rule_json: { period: 'H1', month: 7, day: 10 }, legal_basis: 'Circular 44/2026/TT-BTC [CXN-10]', effective_from: '2026-01-01' },
        });
        expect((await app.call('POST', `/mne-obligation-rules/${made.json.resource_id as string}/publish`, { member: APPROVER, ifMatch: etag(1) })).status).toBe(200);
        return made.json.resource_id as string;
      };
      const rule = await ruleOf(formId, 'OVERALL_SEMIANNUAL');
      const foreign = await ruleOf(other, 'OTHER_FORM_RULE');
      const { snapshotId } = await world();
      const wrongForm = await create(reportBody(formId, snapshotId, { obligation_rule_id: foreign }));
      expect([wrongForm.status, wrongForm.json.code, wrongForm.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'obligation_rule_id']);
      const wrongPeriod = await create(reportBody(formId, snapshotId, { obligation_rule_id: rule, period_label: 'H2-2026' }));
      expect([wrongPeriod.status, wrongPeriod.json.code, wrongPeriod.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'obligation_rule_id']);
      expect(await app.count('select count(*)::text as n from machvon.mne_report')).toBe(0);
      const made = await create(reportBody(formId, snapshotId, { obligation_rule_id: rule }));
      expect(made.status).toBe(200);
      expect((await read(made.json.resource_id as string)).json).toMatchObject({ due_date: '2026-07-10', period_label: 'H1-2026' });
      const [row] = await app.harness.owner<{ obligation_rule_id: string }>(TENANT_A, [['select obligation_rule_id from machvon.mne_report where id = $1::uuid', [made.json.resource_id]]]);
      expect(row?.obligation_rule_id).toBe(rule);
    });

    it('opens the shell that the filing calendar made: an edit with the snapshot fills it, and a submit without a snapshot is refused (422 SNAPSHOT_REQUIRED)', async () => {
      const formId = await publishedForm('TT44-M02');
      const rule = await app.call('POST', '/mne-obligation-rules', {
        member: ADMIN,
        body: { rule_code: 'OVERALL_SEMIANNUAL', form_id: formId, reporting_role: 'INVESTOR', recipient: 'Department of Finance', frequency: 'SEMIANNUAL', due_rule_json: { period: 'H1', month: 7, day: 10 }, legal_basis: 'Circular 44/2026/TT-BTC [CXN-10]', effective_from: '2026-01-01' },
      });
      expect((await app.call('POST', `/mne-obligation-rules/${rule.json.resource_id as string}/publish`, { member: APPROVER, ifMatch: etag(1) })).status).toBe(200);
      expect((await app.call('POST', '/mne-obligations/generate', { member: ADMIN, body: { report_year: 2026 } })).status).toBe(200);
      const [shell] = await app.harness.owner<{ id: string; version: string }>(TENANT_A, [['select id, version::text as version from machvon.mne_report where scope_unit_id = $1::uuid and period_label = $2', [unitId(UNIT), 'H1-2026']]]);
      expect(shell).toBeDefined();
      const id = shell?.id as string;
      const bare = await submit(id, Number(shell?.version));
      expect([bare.status, bare.json.code]).toEqual([422, 'SNAPSHOT_REQUIRED']);
      const { snapshotId } = await world();
      const filled = await edit(id, Number(shell?.version), { snapshot_id: snapshotId, narrative: { assessment: 'On track.' } });
      expect(filled.status).toBe(200);
      const fields = fieldsOf(await read(id));
      expect([fields.plan_total?.value, fields.rate_pm?.value, fields.assessment?.value]).toEqual(['1250000000000', '60.0000', 'On track.']);
      const duplicate = await create(reportBody(formId, snapshotId));
      expect([duplicate.status, duplicate.json.code]).toEqual([409, 'REPORT_EXISTS']);
    });
  });

  describe('handing in', () => {
    it('refuses a report that lacks a required cell (422 VALIDATION_FAILED, the cells listed) and hands in the complete one for review', async () => {
      const formId = await publishedForm('TT44-M02');
      const { snapshotId } = await world();
      const made = await create(reportBody(formId, snapshotId));
      const id = made.json.resource_id as string;
      const lacking = await submit(id, 1);
      expect([lacking.status, lacking.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      expect(JSON.stringify(lacking.json)).toContain('assessment');
      await edit(id, 1, { narrative: { assessment: 'On track.' } });
      const handed = await submit(id, 2);
      expect(handed.status).toBe(200);
      expect(handed.json).toMatchObject({ status: 'IN_REVIEW', resource_version: 3 });
      const shown = await read(id);
      expect(shown.json).toMatchObject({ status: 'IN_REVIEW', submitted_by: memberId(PREPARER) });
      expect(await app.count("select count(*)::text as n from machvon.audit_event where action = 'mne.report.submitted' and outcome = 'SUCCESS'")).toBe(1);
      expect(await app.count("select count(*)::text as n from machvon.outbox_event where type = 'mne.report.submitted.v1'")).toBe(1);
    });

    it('leaves a report that was handed in alone: no edit (409 REPORT_STATE_INVALID), no second hand-in, and the database refuses a change to its figures', async () => {
      const formId = await publishedForm('TT44-M02');
      const { snapshotId } = await world();
      const id = (await create(reportBody(formId, snapshotId))).json.resource_id as string;
      await edit(id, 1, { narrative: { assessment: 'On track.' } });
      await submit(id, 2);
      const again = await edit(id, 3, { narrative: { assessment: 'Changed.' } });
      expect([again.status, again.json.code]).toEqual([409, 'REPORT_STATE_INVALID']);
      expect(JSON.stringify(again.json)).toContain('IN_REVIEW');
      const twice = await submit(id, 3);
      expect([twice.status, twice.json.code]).toEqual([409, 'REPORT_STATE_INVALID']);
      await expect(app.harness.owner(TENANT_A, [[`update machvon.mne_report set payload_json = '{}'::jsonb where id = $1::uuid`, [id]]])).rejects.toThrow(/keeps its snapshot and its figures/);
      await expect(app.harness.owner(TENANT_A, [[`update machvon.mne_report set period_label = 'H2-2026' where id = $1::uuid`, [id]]])).rejects.toThrow(/keeps its form, unit, project, period and revision/);
    });

    it('answers a stale version with 409 VERSION_CONFLICT and a write without one with 428', async () => {
      const formId = await publishedForm('TT44-M02');
      const { snapshotId } = await world();
      const id = (await create(reportBody(formId, snapshotId))).json.resource_id as string;
      const stale = await edit(id, 7, { narrative: { assessment: 'x' } });
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const blind = await app.call('POST', `/mne-reports/${id}/revisions`, { member: PREPARER, body: { narrative: { assessment: 'x' } } });
      expect(blind.status).toBe(428);
    });
  });

  describe('the request', () => {
    it('refuses a body that is not the contract and a form, period or unit that cannot be read', async () => {
      const formId = await publishedForm('TT44-M02');
      const { snapshotId } = await world();
      expect((await create({ form_id: formId })).status).toBe(400);
      expect((await create(reportBody(formId, snapshotId, { extra: true }))).json.code).toBe('FIELD_NOT_ALLOWED');
      const unknownForm = await create(reportBody(randomUUID(), snapshotId));
      expect([unknownForm.status, unknownForm.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      const badYear = await create(reportBody(formId, snapshotId, { report_year: 1900, period_label: 'H1-1900' }));
      expect([badYear.status, badYear.json.code, badYear.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'report_year']);
      const badLabel = await create(reportBody(formId, snapshotId, { period_label: 'Q3-2026' }));
      expect([badLabel.status, badLabel.json.code, badLabel.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'period_label']);
      const elsewhere = await create(reportBody(formId, snapshotId, { project_id: randomUUID() }));
      expect([elsewhere.status, elsewhere.json.code, elsewhere.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'project_id']);
    });

    it('refuses a form whose cells cannot be read when it is drafted (422 VALIDATION_FAILED)', async () => {
      const bad = await app.call('POST', '/mne-forms', { member: ADMIN, body: formBody('TT44-M09', { schema_json: { fields: [{ key: 'Bad Key', kind: 'TEXT' }] } }) });
      expect([bad.status, bad.json.code, bad.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'schema_json.fields[0].key']);
      const sourced = await app.call('POST', '/mne-forms', { member: ADMIN, body: formBody('TT44-M09', { schema_json: { fields: [{ key: 'text', kind: 'TEXT', source: { kind: 'PROJECT_COUNT' } }] } }) });
      expect([sourced.status, sourced.json.detail]).toEqual([422, 'schema_json.fields[0].source']);
    });
  });
});
