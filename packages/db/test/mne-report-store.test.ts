import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { reportingPeriods } from '@machvon/kernel';
import { DocumentStore } from '../src/document-store';
import { BASELINE_PACK, applyBaseline, sealPack } from '../src/master-baseline';
import type { BaselineEntry } from '../src/master-baseline';
import { MneFormStore } from '../src/mne-form-store';
import type { MneFormInput, MneFormRow } from '../src/mne-form-store';
import { MneObligationRuleStore } from '../src/mne-obligation-rule-store';
import type { MneRuleInput, MneRuleRow } from '../src/mne-obligation-rule-store';
import { MneExportExpiryJob, MneExportStore } from '../src/mne-export-store';
import { MneObligationStore } from '../src/mne-obligation-store';
import { MneReportStore } from '../src/mne-report-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuditWriter } from '../src/audit-writer';
import { AuthzHarness, TENANT_A, contextFor, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const forms = new MneFormStore();
const rules = new MneObligationRuleStore();
const obligations = new MneObligationStore();
const reports = new MneReportStore();

const MAKER = 1;
const CHECKER = 2;
const WORKER = '00000000-0000-4000-8000-000000000000';
const ROOT = 1;
const INVESTOR = 2;
const COMMITTEE = 3;
const LEGAL_BASIS = 'Circular 44/2026/TT-BTC [CXN-10]';
const TODAY = '2026-12-15';
const EVERYTHING: ScopeBuilder = () => ({ sql: 'true', params: [] });
const calendarEntry = BASELINE_PACK.entries.find((entry) => entry.masterType === 'CALENDAR') as BaselineEntry;

const as = <T>(work: (tx: TenantTx) => Promise<T>): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(MAKER)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

let periods = 0;
const SCHEMA = {
  fields: [
    { key: 'plan_total', label: 'Plan', kind: 'MONEY', required: true, source: { kind: 'SNAPSHOT_METRIC', metric: 'plan_total_vnd' } },
    { key: 'assessment', label: 'Assessment', kind: 'TEXT', required: true },
  ],
};

async function seedTemplate(): Promise<void> {
  const [profile] = await owner<{ id: string }>("select id from machvon.document_layout_profile where profile_code = 'ND30_A4_STANDARD'");
  await owner(
    `insert into machvon.document_template
       (tenant_id, id, template_code, revision, group_code, doc_type_code, title, layout_profile_id, body_blocks, placeholder_schema, legal_basis, watermark_text,
        origin, content_sha256, effective_from, status, published_at, created_by, updated_by)
     values ($1, $2, 'MNE-REPORT-TEMPLATE', 1, 'REPORT_MONITORING', 'BC', 'Template', $3, '[{"kind":"paragraph","text":"{{body}}"}]'::jsonb, '{"required":["body"]}'::jsonb, 'Legal basis', 'Waiting',
        'PLATFORM_PACK', repeat('c', 64), '2026-01-01', 'PUBLISHED', now(), $4, $4)`,
    [TENANT_A, randomUUID(), (profile as { id: string }).id, memberId(MAKER)],
  );
}

const formInput = (formCode: string, overrides: Partial<MneFormInput> = {}): MneFormInput => ({
  formCode,
  title: 'Report',
  reportKind: 'OVERALL_SEMIANNUAL',
  legalBasis: LEGAL_BASIS,
  effectiveFrom: '2026-01-01',
  schemaJson: SCHEMA,
  docTemplateCode: 'MNE-REPORT-TEMPLATE',
  exportFormats: ['XLSX'],
  ...overrides,
});
async function publishedForm(formCode: string, overrides: Partial<MneFormInput> = {}): Promise<MneFormRow> {
  const draft = await as((tx) => forms.create(tx, formInput(formCode, overrides), memberId(MAKER)));
  return (await harness.tenants.withTenant(contextFor(TENANT_A, memberId(CHECKER)), (tx) => forms.publish(tx, draft.id, draft.version, memberId(CHECKER)))).record;
}
async function publishedRule(formId: string, ruleCode: string, overrides: Partial<MneRuleInput> = {}): Promise<MneRuleRow> {
  const input: MneRuleInput = {
    ruleCode,
    formId,
    reportingRole: 'INVESTOR',
    recipient: 'Department of Finance',
    frequency: 'SEMIANNUAL',
    dueRuleJson: { period: 'H1', month: 7, day: 10 },
    legalBasis: LEGAL_BASIS,
    effectiveFrom: '2026-01-01',
    ...overrides,
  };
  const draft = await as((tx) => rules.create(tx, input, memberId(MAKER)));
  return (await harness.tenants.withTenant(contextFor(TENANT_A, memberId(CHECKER)), (tx) => rules.publish(tx, draft.id, draft.version, memberId(CHECKER)))).record;
}

/** A frozen snapshot of a day with no line in it (the figures are zero): enough for the store to accept it as the ground of a report. */
async function frozenSnapshot(asOf: string): Promise<string> {
  const snapshotId = randomUUID();
  const periodId = randomUUID();
  periods += 1;
  const start = new Date(Date.UTC(2043, 0, 2) + periods * 7 * 86_400_000).toISOString().slice(0, 10);
  const client = new Client({ connectionString: harness.database.adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    await client.query(
      `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
       values ($1, $2, $3, 1, $6::date, $6::date + 6, now(), 'DEFAULT', 'WEEK', 2026, 'OPEN', $4, $5, $5)`,
      [TENANT_A, periodId, `RP-${periodId.slice(0, 8)}`, randomUUID(), WORKER, start],
    );
    await client.query(
      `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, payload_sha256, frozen_by, frozen_at, created_by, updated_by)
       values ($1, $2, $3, 'PERIOD_CLOSE', now(), $4::date, $4::date, 'FROZEN', 'DIS-METRICS-R1-PROPOSED', 'PROPOSED_PENDING_SIGNOFF', 0, repeat('a', 64), $5, now(), $5, $5)`,
      [TENANT_A, snapshotId, periodId, asOf, WORKER],
    );
  } finally {
    await client.end();
  }
  return snapshotId;
}

describe('MneReportStore (ST-MNE-002, MNE F3)', () => {
  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: ROOT, path: `/${unitId(ROOT)}/` },
      { n: INVESTOR, path: `/${unitId(ROOT)}/${unitId(INVESTOR)}/`, parent: ROOT },
      { n: COMMITTEE, path: `/${unitId(COMMITTEE)}/` },
    ]);
    for (const member of [MAKER, CHECKER]) await harness.seedMembership(TENANT_A, member, ROOT);
    await owner('update machvon.organization_unit set is_investor = true where id = $1', [unitId(INVESTOR)]);
    await owner("update machvon.organization_unit set unit_type = 'GOVERNING_BODY' where id = $1", [unitId(COMMITTEE)]);
    await as((tx) => new DocumentStore().seedDefaults(tx, memberId(MAKER)));
    await seedTemplate();
    await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: WORKER, scopeVersion: 0 }, (tx) => applyBaseline(tx, sealPack('MNE-R-1', [calendarEntry]), WORKER));
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  afterEach(async () => {
    await harness.owner(TENANT_A, [['delete from machvon.mne_report'], ['delete from machvon.mne_obligation_rule'], ['delete from machvon.mne_report_form']]);
  });

  it('opens the weekly shell of the calendar: its week is read from the reporting calendar, so a snapshot can be attached and the report handed in', async () => {
    const form = await publishedForm('CV3665-WEEKLY', { reportKind: 'WEEKLY_QUICK' });
    await publishedRule(form.id, 'WEEKLY_QUICK', { reportingRole: 'PROVINCIAL_PEOPLE_COMMITTEE', frequency: 'WEEKLY', dueRuleJson: { weekly: 'FRI', time: '16:00' } });
    await as((tx) => obligations.generate(tx, { year: 2027, today: TODAY, actor: memberId(MAKER), scope: EVERYTHING, scopeUnitId: undefined }));
    const weeks = reportingPeriods({ weekStartsOn: 'SATURDAY', deadlineWeekday: 'FRIDAY', deadlineTime: '10:00', timezone: 'Asia/Ho_Chi_Minh' }, 2027);
    const week = weeks[10] as { code: string; endsOn: string };
    const [shell] = await owner<{ id: string; version: string; period_id: string | null }>('select id, version::text as version, period_id from machvon.mne_report where period_label = $1', [week.code]);
    expect(shell?.period_id).toBeNull();
    const snapshotId = await frozenSnapshot(week.endsOn);
    const edited = await as((tx) =>
      reports.edit(tx, { id: shell?.id as string, today: TODAY, expectedVersion: Number(shell?.version), narrative: { assessment: 'On track.' }, snapshotId, actor: memberId(MAKER), unitScope: EVERYTHING }),
    );
    expect(edited.row).toMatchObject({ snapshotId, periodLabel: week.code, status: 'DRAFT' });
    expect(edited.row.payload.meta).toMatchObject({ snapshot_id: snapshotId, as_of_date: week.endsOn });
    // A snapshot of a day after the week ends is not the ground of that week.
    const later = await frozenSnapshot('2027-12-31');
    expect(
      await refusal(as((tx) => reports.edit(tx, { id: shell?.id as string, today: TODAY, expectedVersion: edited.row.version, snapshotId: later, actor: memberId(MAKER), unitScope: EVERYTHING }))),
    ).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'snapshot_id' });
    const submitted = await as((tx) => reports.submit(tx, { id: shell?.id as string, expectedVersion: edited.row.version, actor: memberId(MAKER), now: new Date(), unitScope: EVERYTHING }));
    expect(submitted.row.status).toBe('IN_REVIEW');
  });

  it('refuses a weekly label that the reporting calendar does not know (422 VALIDATION_FAILED)', async () => {
    const form = await publishedForm('CV3665-WEEKLY', { reportKind: 'WEEKLY_QUICK' });
    const snapshotId = await frozenSnapshot('2027-03-05');
    expect(
      await refusal(
        as((tx) =>
          reports.create(tx, { formId: form.id, reportYear: 2027, periodLabel: 'NOT-A-WEEK', scopeUnitId: unitId(COMMITTEE), snapshotId, today: TODAY, actor: memberId(MAKER), unitScope: EVERYTHING }),
        ),
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'period_label' });
  });

  it('gives a report made for one rule its deadline although another rule of the year needs a calendar the tenant has not got', async () => {
    const half = await publishedForm('TT44-M02');
    const weekly = await publishedForm('CV3665-WEEKLY', { reportKind: 'WEEKLY_QUICK' });
    const rule = await publishedRule(half.id, 'OVERALL_SEMIANNUAL');
    // A rule that shifts its deadline to a working calendar that is not published stops the calendar of the whole year, and does not stop this rule.
    await publishedRule(weekly.id, 'SHIFTING', { frequency: 'ANNUAL', dueRuleJson: { period: 'YEAR', month: 2, day: 10, year_offset: 1, shift_on_holiday: true, calendar_code: 'NO_SUCH_CALENDAR' } });
    expect(await refusal(as((tx) => obligations.generate(tx, { year: 2026, today: TODAY, actor: memberId(MAKER), scope: EVERYTHING, scopeUnitId: undefined })))).toMatchObject({ code: 'CALENDAR_NOT_EFFECTIVE' });
    const snapshotId = await frozenSnapshot('2026-06-30');
    const made = await as((tx) =>
      reports.create(tx, { formId: half.id, reportYear: 2026, periodLabel: 'H1-2026', scopeUnitId: unitId(INVESTOR), snapshotId, obligationRuleId: rule.id, today: TODAY, actor: memberId(MAKER), unitScope: EVERYTHING }),
    );
    expect(made.row).toMatchObject({ dueDate: '2026-07-10', periodLabel: 'H1-2026' });
  });

  it('refuses a period that does not belong to the label: none beside a half year or a year, and the one whose code the weekly label is', async () => {
    const form = await publishedForm('TT44-M02');
    const snapshotId = await frozenSnapshot('2026-06-30');
    const [period] = await owner<{ id: string }>('select id from machvon.reporting_period limit 1');
    const base = { formId: form.id, reportYear: 2026, scopeUnitId: unitId(INVESTOR), snapshotId, today: TODAY, actor: memberId(MAKER), unitScope: EVERYTHING };
    // A period named beside H1-2027 would have set the day the report ends on, whatever its label says.
    expect(await refusal(as((tx) => reports.create(tx, { ...base, periodLabel: 'H1-2027', periodId: period?.id })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'period_id' });
    expect(await refusal(as((tx) => reports.create(tx, { ...base, periodLabel: 'H1-2026', periodId: period?.id })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'period_id' });
    expect(await refusal(as((tx) => reports.create(tx, { ...base, periodLabel: 'W99-2026', periodId: period?.id })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'period_id' });
    // The right period and the right label, but another year than the report's: the period of 2026 does not make a report of 2027.
    const [named] = await owner<{ id: string; code: string }>('select id, code from machvon.reporting_period where fiscal_year = 2026 limit 1');
    expect(await refusal(as((tx) => reports.create(tx, { ...base, reportYear: 2027, periodLabel: named?.code ?? '', periodId: named?.id })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'period_id' });
    expect(Number((await owner<{ n: string }>('select count(*)::text as n from machvon.mne_report'))[0]?.n)).toBe(0);
  });

  it('names the report of the project asked for, and not that of another project, when two creations race for the same key', async () => {
    const form = await publishedForm('TT44-M04', { reportKind: 'PROJECT_PERIODIC' });
    const first = randomUUID();
    const second = randomUUID();
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      for (const [id, code] of [[first, 'RACE-1'], [second, 'RACE-2']] as const) {
        await client.query(
          `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
           values ($1, $2, $3, 'Project', $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
          [TENANT_A, id, code, unitId(INVESTOR), randomUUID()],
        );
      }
    } finally {
      await client.end();
    }
    const snapshotId = await frozenSnapshot('2026-06-30');
    const make = (projectId: string) =>
      harness.tenants.withTenant(contextFor(TENANT_A, memberId(MAKER)), (tx) =>
        reports.create(tx, { formId: form.id, reportYear: 2026, periodLabel: 'H1-2026', scopeUnitId: unitId(INVESTOR), projectId, snapshotId, today: TODAY, actor: memberId(MAKER), unitScope: EVERYTHING }),
      );
    const earlier = await make(first);
    const results = await Promise.allSettled([make(second), make(second)]);
    const winners = results.filter((result) => result.status === 'fulfilled');
    const losers = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const winner = (winners[0] as PromiseFulfilledResult<{ row: { id: string } }>).value.row.id;
    const refused = losers[0]?.reason as { code?: string; extensions?: { report_id?: string } };
    expect(refused.code).toBe('REPORT_EXISTS');
    expect(refused.extensions?.report_id).toBe(winner);
    expect(refused.extensions?.report_id).not.toBe(earlier.row.id);
  });

  describe('the packages that nobody filed (ST-MNE-004)', () => {
    const packages = new MneExportStore();
    const insert = async (status: string, ageDays: number): Promise<string> => {
      const id = randomUUID();
      const client = new Client({ connectionString: harness.database.adminUrl });
      await client.connect();
      try {
        await client.query('set session_replication_role = replica');
        await client.query(
          `insert into machvon.mne_export_package (tenant_id, id, mne_report_id, target_system, format, object_key, file_sha256, adapter_status, status, receipt_reference, submitted_at, receipt_recorded_by, receipt_recorded_at, created_at, created_by, updated_by)
           values ($1, $2, $3, 'NATIONAL_PIM_SYSTEM', 'CSV', $4, $5, 'MISSING', $6, $7, $8::timestamptz, $9, $8::timestamptz, now() - make_interval(days => $10::int), $11, $11)`,
          [TENANT_A, id, randomUUID(), `tenants/${TENANT_A}/report_export/${id}`, randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), status, status === 'SUBMISSION_CONFIRMED' ? 'QG-1' : null, status === 'SUBMISSION_CONFIRMED' ? new Date().toISOString() : null, status === 'SUBMISSION_CONFIRMED' ? WORKER : null, ageDays, WORKER],
        );
      } finally {
        await client.end();
      }
      return id;
    };

    it('expires a package that was made more than 90 days ago and not filed, once, and leaves the filed and the recent ones', async () => {
      const old = await insert('GENERATED', 91);
      const downloaded = await insert('DOWNLOADED', 120);
      const recent = await insert('GENERATED', 89);
      const filed = await insert('SUBMISSION_CONFIRMED', 400);
      const job = new MneExportExpiryJob(new AuditWriter(harness.tenants));
      const first = await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: WORKER, scopeVersion: 0 }, (tx) => job.run(tx, WORKER, new Date()));
      expect(first).toEqual({ expired: 2 });
      const status = async (id: string): Promise<string> => (await owner<{ status: string }>('select status from machvon.mne_export_package where id = $1::uuid', [id]))[0]?.status as string;
      expect([await status(old), await status(downloaded), await status(recent), await status(filed)]).toEqual(['EXPIRED', 'EXPIRED', 'GENERATED', 'SUBMISSION_CONFIRMED']);
      const again = await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: WORKER, scopeVersion: 0 }, (tx) => job.run(tx, WORKER, new Date()));
      expect(again).toEqual({ expired: 0 });
      const trail = await owner<{ n: string }>("select count(*)::text as n from machvon.audit_event where action = 'mne.package_expired' and resource_id::text = any($1::text[])", [[old, downloaded]]);
      expect(trail).toEqual([{ n: '2' }]);
      // An expired file is final: it takes no receipt.
      const row = await as((tx) => packages.find(tx, old));
      expect(row).toMatchObject({ status: 'EXPIRED' });
      expect(row?.expiredAt).not.toBeNull();
      await expect(as((tx) => packages.recordReceipt(tx, { id: old, expectedVersion: row?.version as number, reference: 'QG-7', submittedAt: new Date().toISOString(), receiptDocumentId: undefined, actor: memberId(MAKER), now: new Date() }))).rejects.toMatchObject({ code: 'PACKAGE_STATE_INVALID', status: 409 });
    });
  });
});
