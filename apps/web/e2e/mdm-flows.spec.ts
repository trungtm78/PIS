import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * MDM-37, MDM-03, MDM-34, MDM-16, MDM-24, MDM-01, MDM-25, MDM-26, MDM-27, MDM-28 and MDM-32 in a real browser against the real API and database (apps/api/test/e2e-stack):
 * a catalogue steward proposes an entry, a second person reviews it, a publisher puts it in force, and the history keeps what was
 * valid before. The four-eyes rule is the real one: the proposer sees their own request as theirs and is offered no decision.
 */

const unique = (): string => Date.now().toString(36).toUpperCase();
const NEWLINE = String.fromCharCode(10);

async function open(page: Page, path: string, user: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

interface ChangeRow {
  id: string;
  status: string;
  change_kind: string;
  version: string;
}

const changesOf = (key: string): Promise<ChangeRow[]> =>
  sql(
    `select c.id, c.status, c.change_kind, c.version::text as version
       from machvon.master_change_request c join machvon.master_record r on r.id = c.master_record_id
      where r.business_key = $1 order by c.created_at`,
    [key],
  );

const recordOf = async (key: string): Promise<{ id: string; status: string; current_version_id: string | null }> => {
  const [row] = await sql<{ id: string; status: string; current_version_id: string | null }>('select id, status, current_version_id from machvon.master_record where business_key = $1', [key]);
  if (row === undefined) throw new Error(`no record ${key}`);
  return row;
};

async function documentFor(): Promise<string> {
  const id = randomUUID();
  await sql(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by)
     values ($1, $2, 'INCOMING', 'CV', 'Decision of the e2e flow', 'INTERNAL', $3, $3)`,
    [stackInfo().tenants.A, id, membershipOf('dataChecker')],
  );
  return id;
}

interface EntrySeed {
  type?: string;
  name?: string;
  attributes?: string;
}

async function propose(page: Page, key: string, entry: EntrySeed = {}): Promise<void> {
  await open(page, '/mdm/mdm-25', 'steward');
  await page.getByLabel(vi['mdm.create.type.label']).fill(entry.type ?? 'E2E_SECTOR');
  await page.getByLabel(vi['mdm.create.key.label']).fill(key);
  await page.getByLabel(vi['mdm.create.name.label']).fill(entry.name ?? 'Giao thông e2e');
  if (entry.attributes !== undefined) await page.getByLabel(vi['mdm.create.attributes.label'], { exact: true }).fill(entry.attributes);
  await page.getByLabel(vi['mdm.create.validFrom.label']).fill('2024-01-01');
  await page.getByLabel(vi['mdm.create.reason.label']).fill('Entry made by the end-to-end flow');
  await page.getByRole('button', { name: vi['mdm.create.save.action'] }).click();
  await expect(page.getByTestId('impact')).toBeVisible();
  await page.getByRole('checkbox', { name: vi['mdm.impact.read.label'] }).check();
  await page.getByRole('button', { name: vi['mdm.impact.submit.action'] }).click();
  await expect(page.getByText(vi['mdm.create.submitted.notice'], { exact: false })).toBeVisible();
}

async function approve(page: Page, changeId: string, reason: string): Promise<void> {
  await open(page, '/mdm/mdm-32', 'dataChecker');
  const row = page.locator(`[data-stage="review"][data-change-id="${changeId}"]`);
  await row.getByRole('button', { name: vi['mdm.approval.review.action'] }).click();
  const panel = page.locator(`[data-panel-for="${changeId}"]`);
  await panel.getByLabel(vi['mdm.approval.reason.label']).fill(reason);
  await panel.getByRole('button', { name: vi['mdm.approval.decision.approve.action'] }).click();
  await expect(page.getByText(vi['mdm.approval.decided.notice'])).toBeVisible();
}

async function publish(page: Page, changeId: string): Promise<void> {
  const document = await documentFor();
  await open(page, '/mdm/mdm-32', 'dataChecker');
  const row = page.locator(`[data-stage="publish"][data-change-id="${changeId}"]`);
  await row.getByRole('button', { name: vi['mdm.approval.publish.action'] }).click();
  const panel = page.locator(`[data-panel-for="${changeId}"]`);
  await panel.getByLabel(vi['mdm.approval.document.label']).fill(document);
  await panel.getByRole('button', { name: vi['mdm.approval.publish.confirm.action'] }).click();
  await expect(page.getByText(vi['mdm.approval.published.notice'])).toBeVisible();
}

/** An entry put in force (by default of the e2e type, as the successor of the first one). */
async function putInForce(page: Page, key: string, entry: EntrySeed = {}): Promise<void> {
  await propose(page, key, entry);
  const [created] = await changesOf(key);
  await approve(page, created?.id ?? '', 'Checked against the decision of the committee');
  await publish(page, created?.id ?? '');
}

test.describe.configure({ mode: 'serial' });

test.describe('master data: propose, review, publish, change and history', () => {
  const key = `E2E-${unique()}`;

  test('a steward proposes an entry, the proposer is offered no decision on it, and a checker approves and publishes it', async ({ page }) => {
    await propose(page, key);
    const [created] = await changesOf(key);
    expect(created).toMatchObject({ status: 'IN_REVIEW', change_kind: 'CREATE' });

    // The steward reads the queue (master.read) and is offered no decision: a steward holds neither the review nor the publish permission.
    await open(page, '/mdm/mdm-32', 'steward');
    await expect(page.locator(`[data-change-id="${created?.id}"]`)).toBeVisible();
    await expect(page.locator(`[data-change-id="${created?.id}"]`).getByRole('button')).toHaveCount(0);

    await approve(page, created?.id ?? '', 'Checked against the decision of the committee');
    expect((await changesOf(key))[0]?.status).toBe('APPROVED');
    expect((await recordOf(key)).status).toBe('APPROVED');

    await publish(page, created?.id ?? '');
    expect((await changesOf(key))[0]?.status).toBe('APPLIED');
    const record = await recordOf(key);
    expect(record.status).toBe('EFFECTIVE');
    expect(record.current_version_id).not.toBeNull();
    const events = await sql<{ n: string }>("select count(*)::text as n from machvon.outbox_event where type = 'master.published.v1' and aggregate_id = $1", [record.id]);
    expect(Number(events[0]?.n)).toBe(1);

    await open(page, '/mdm/mdm-01', 'steward');
    const row = page.locator(`[data-record-id="${record.id}"]`);
    await expect(row).toContainText(key);
    await expect(row).toContainText(vi['mdm.status.record.effective']);
    await row.getByRole('link', { name: vi['mdm.hub.open.action'] }).click();
    await expect(page.getByRole('heading', { level: 1, name: vi['mdm.detail.page.title'] })).toBeVisible();
    await expect(page.getByTestId('entry')).toContainText('Giao thông e2e');
    await expect(page.getByTestId('impact')).toHaveAttribute('data-impact-total', '0');
  });

  test('a change from a later date keeps the old name for the earlier dates, and the history shows both versions', async ({ page }) => {
    await open(page, `/mdm/mdm-26?type=E2E_SECTOR&key=${key}`, 'steward');
    await page.getByLabel(vi['mdm.edit.name.label']).fill('Giao thông vận tải e2e');
    await page.getByLabel(vi['mdm.edit.effectiveFrom.label']).fill('2025-06-01');
    await page.getByLabel(vi['mdm.edit.reason.label']).fill('Renamed by the end-to-end flow');
    await page.getByRole('button', { name: vi['mdm.edit.save.action'] }).click();
    await expect(page.getByTestId('impact')).toBeVisible();
    await page.getByRole('checkbox', { name: vi['mdm.impact.read.label'] }).check();
    await page.getByRole('button', { name: vi['mdm.impact.submit.action'] }).click();
    await expect(page.getByText(vi['mdm.create.submitted.notice'], { exact: false })).toBeVisible();

    const changes = await changesOf(key);
    const update = changes.find((change) => change.change_kind === 'UPDATE');
    expect(update?.status).toBe('IN_REVIEW');
    await approve(page, update?.id ?? '', 'Checked against the decision of the committee');
    await publish(page, update?.id ?? '');

    await open(page, `/mdm/mdm-28?type=E2E_SECTOR&key=${key}`, 'steward');
    await expect(page.locator('[data-revision]')).toHaveCount(2);
    const second = page.locator('[data-revision="2"]');
    await expect(second.locator('[data-field="label"] [data-side="before"]')).toHaveText('Giao thông e2e');
    await expect(second.locator('[data-field="label"] [data-side="after"]')).toHaveText('Giao thông vận tải e2e');
    await expect(page.locator('[data-revision="1"]')).toContainText('2024-01-01 → 2025-06-01');
    expect((await recordOf(key)).status).toBe('EFFECTIVE');
  });

  test('an entry that a project uses is retired only with a successor, and the scope screen shows the type', async ({ page }) => {
    const heir = `E2E-HEIR-${unique()}`;
    await putInForce(page, heir);
    const used = await recordOf(key);
    await sql(
      `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, sector_master_version_id, classification, total_investment_vnd, status, version)
       select $1, $2, $3, 'Project of the e2e flow', u.id, $4, $4, 'INTERNAL', 1000, 'CONCEPT', 1 from machvon.organization_unit u where u.tenant_id = $1 limit 1`,
      [stackInfo().tenants.A, randomUUID(), `E2E-P-${unique()}`, used.current_version_id],
    );

    await open(page, `/mdm/mdm-31?type=E2E_SECTOR&key=${key}`, 'steward');
    await expect(page.getByTestId('in-use')).toBeVisible();
    await page.getByLabel(vi['mdm.retire.date.label']).fill('2026-01-01');
    await page.getByLabel(vi['mdm.retire.reason.label']).fill('Replaced by the successor of the e2e flow');
    await page.getByRole('button', { name: vi['mdm.retire.save.action'] }).click();
    await expect(page.getByText(vi['mdm.field.required.error'])).toBeVisible();
    await page.getByLabel(vi['mdm.retire.successor.label']).selectOption({ label: heir + ' · Giao thông e2e' });
    await page.getByRole('button', { name: vi['mdm.retire.save.action'] }).click();
    await expect(page.getByTestId('impact')).toBeVisible();
    // The project refers to the version twice (as its area and as its sector): two references, counted per column.
    await expect(page.getByTestId('impact')).toHaveAttribute('data-impact-total', '2');
    await page.getByRole('checkbox', { name: vi['mdm.impact.read.label'] }).check();
    await page.getByRole('button', { name: vi['mdm.impact.submit.action'] }).click();
    await expect(page.getByText(vi['mdm.create.submitted.notice'], { exact: false })).toBeVisible();

    const retire = (await changesOf(key)).find((change) => change.change_kind === 'RETIRE');
    expect(retire?.status).toBe('IN_REVIEW');
    await approve(page, retire?.id ?? '', 'Checked against the decision of the committee');
    await publish(page, retire?.id ?? '');
    expect((await recordOf(key)).status).toBe('RETIRED');
    const [closed] = await sql<{ valid_until: string }>("select to_char(valid_until, 'YYYY-MM-DD') as valid_until from machvon.master_record_version where id = $1", [used.current_version_id]);
    expect(closed?.valid_until).toBe('2026-01-01');
    // The project still refers to the version it always did.
    const [still] = await sql<{ n: string }>('select count(*)::text as n from machvon.project where sector_master_version_id = $1', [used.current_version_id]);
    expect(Number(still?.n)).toBe(1);

    await open(page, '/mdm/mdm-33', 'steward');
    const row = page.locator('[data-master-type="E2E_SECTOR"]');
    await expect(row).toBeVisible();
    await expect(row).toContainText(vi['mdm.scope.tenantOnly.label']);
  });

  test('a duplicate key is refused with the message of the screen and nothing is written', async ({ page }) => {
    await open(page, '/mdm/mdm-25', 'steward');
    await page.getByLabel(vi['mdm.create.type.label']).fill('E2E_SECTOR');
    await page.getByLabel(vi['mdm.create.key.label']).fill(key);
    await page.getByLabel(vi['mdm.create.name.label']).fill('Trùng mã');
    await page.getByLabel(vi['mdm.create.validFrom.label']).fill('2024-01-01');
    await page.getByLabel(vi['mdm.create.reason.label']).fill('A second entry with the same key');
    await page.getByRole('button', { name: vi['mdm.create.save.action'] }).click();
    await expect(page.getByRole('alert').filter({ hasText: vi['mdm.problem.duplicateKey.error'] })).toBeVisible();
    const rows = await sql<{ n: string }>("select count(*)::text as n from machvon.master_record where business_key = $1 and master_type = 'E2E_SECTOR'", [key]);
    expect(Number(rows[0]?.n)).toBe(1);
  });

  test('the catalogues of the capital chain start from the baseline of the platform: the tree, the rules with what they wait for, and a typed form', async ({ page }) => {
    // MDM-04: the national target programmes sit inside their budget source, and the steward is offered no new funding source (the platform's alone).
    await open(page, '/mdm/mdm-04', 'steward');
    await expect(page.getByRole('heading', { level: 1, name: vi['mdm.fundSource.page.title'] })).toBeVisible();
    const programme = page.locator('tr[data-key="CTMTQG-NTM"]');
    await expect(programme).toContainText('NSTW-DTPT');
    await expect(programme).toContainText(vi['mdm.value.relation.subsetOf']);
    await expect(programme).toContainText(vi['mdm.catalogue.platform.pill']);
    await expect(page.getByRole('link', { name: vi['mdm.catalogue.add.action'] })).toHaveCount(0);

    // MDM-07: the group thresholds say where they come from and that they wait for a confirmation; the bands are exact amounts.
    await open(page, '/mdm/mdm-07', 'steward');
    const rules = page.getByTestId('rules');
    await expect(rules.locator('[data-rule-type="PROJECT_GROUP_THRESHOLDS"]')).toContainText(vi['mdm.rule.awaiting.pill'].replace('{cxn}', 'CXN-32'));
    await expect(page.getByTestId('bands').getByRole('row')).toHaveCount(5);
    await expect(rules.locator('[data-rule-type="APPRAISAL_CRITERIA"]')).toContainText(vi['mdm.rule.threshold.text'].replace('{score}', '60'));
    await page.getByLabel(vi['mdm.catalogue.type.label'], { exact: true }).selectOption('PROJECT_TYPE');
    await expect(page.locator('tr[data-key="NEW_BUILD"]')).toBeVisible();
    await expect(page.locator('tr[data-key="A"]')).toHaveCount(0);

    // MDM-08: the stage graph and the national code rule.
    await open(page, '/mdm/mdm-08', 'steward');
    await expect(page.locator('tr[data-key="APPRAISAL"]')).toContainText('PIPELINE, REJECTED, CONCEPT, CANCELLED');
    await expect(page.getByTestId('national-code-mode')).toContainText('PIPELINE');
    await expect(page.getByTestId('national-code-format')).toContainText('7654321');

    // MDM-10: a tenant adds a decision type under a decision type of the platform, from the typed form, and the server judges it.
    await open(page, '/mdm/mdm-10', 'steward');
    await page.getByRole('link', { name: vi['mdm.catalogue.add.action'] }).click();
    await expect(page.getByLabel(vi['mdm.create.type.label'])).toHaveValue('DECISION_TYPE');
    const decisionKey = `E2E-DT-${unique()}`;
    await page.getByLabel(vi['mdm.create.key.label']).fill(decisionKey);
    await page.getByLabel(vi['mdm.create.name.label']).fill('Quyết định e2e');
    await page.getByLabel(vi['mdm.create.validFrom.label']).fill('2026-01-01');
    await page.getByLabel(vi['mdm.create.reason.label']).fill('Decision type of the end-to-end flow');
    await page.getByLabel(vi['mdm.create.parent.label']).selectOption({ label: 'INVESTMENT_DECISION · Quyết định đầu tư' });
    // Without the required fields the server refuses and the screen names the field.
    await page.getByRole('button', { name: vi['mdm.create.save.action'] }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'attributes.required_fields' })).toBeVisible();
    await page.getByLabel(vi['mdm.attr.decisionType.requiredFields.label']).fill('number, issued_on');
    await page.getByRole('button', { name: vi['mdm.create.save.action'] }).click();
    await expect(page.getByTestId('impact')).toBeVisible();
    const [created] = await sql<{ attributes: { required_fields: string[] } }>(
      "select v.attributes from machvon.master_record_version v join machvon.master_record r on r.id = v.master_record_id where r.business_key = $1",
      [decisionKey],
    );
    expect(created?.attributes.required_fields).toEqual(['number', 'issued_on']);
  });

  test('the reporting calendar lists the periods of a year with their deadlines, and the units and currencies come from the baseline', async ({ page }) => {
    await open(page, '/mdm/mdm-11?year=2027', 'steward');
    await expect(page.getByRole('heading', { level: 1, name: vi['mdm.calendar.page.title'] })).toBeVisible();
    await expect(page.getByTestId('calendar-rule')).toContainText(vi['mdm.rule.awaiting.pill'].replace('{cxn}', 'ASSUMPTION-D03'));
    await expect(page.getByTestId('calendar-locked')).toBeVisible();
    await expect(page.locator('[data-period]')).toHaveCount(8);
    await expect(page.locator('[data-period="W2027-01"]')).toContainText(vi['mdm.calendar.deadline.text'].replace('{when}', '2027-01-01 03:00'));
    await page.getByRole('button', { name: vi['mdm.calendar.all.action'].replace('{count}', '53') }).click();
    await expect(page.locator('[data-period]')).toHaveCount(53);
    await expect(page.locator('[data-period="W2027-53"]')).toContainText('2027-12-31');

    await open(page, '/mdm/mdm-12', 'steward');
    await expect(page.getByRole('heading', { level: 1, name: vi['mdm.unit.page.title'] })).toBeVisible();
    await expect(page.locator('tr[data-key="HA"]')).toContainText('10000');
    await expect(page.locator('tr[data-key="VND"]')).toContainText(vi['mdm.value.rounding.halfUp']);
    await expect(page.getByRole('link', { name: vi['mdm.catalogue.add.action'] })).toBeVisible();
  });

  test('the operational catalogues come from the baseline, and a steward adds an issue group tied to a priority', async ({ page }) => {
    await open(page, '/mdm/mdm-18', 'steward');
    await expect(page.getByRole('heading', { level: 1, name: vi['mdm.priority.page.title'] })).toBeVisible();
    await expect(page.locator('tr[data-key="URGENT"]')).toContainText('4 / 24');
    await open(page, '/mdm/mdm-23', 'steward');
    await expect(page.locator('tr[data-key="MASTER_DATA"]')).toContainText(vi['mdm.value.retention.permanent']);
    await expect(page.locator('tr[data-key="FINANCIAL_RECORD"]')).toContainText(vi['mdm.rule.awaiting.pill'].replace('{cxn}', 'CXN-05'));
    await expect(page.getByRole('link', { name: vi['mdm.catalogue.add.action'] })).toHaveCount(0);
    await open(page, '/mdm/mdm-13', 'steward');
    await expect(page.locator('tr[data-key="DECISION"]')).toContainText('application/pdf');

    // MDM-17: the issue groups are the tenant's own; the form offers the priorities and names the field that the server refuses.
    await open(page, '/mdm/mdm-17', 'steward');
    await page.getByRole('link', { name: vi['mdm.catalogue.add.action'] }).click();
    await expect(page.getByLabel(vi['mdm.create.type.label'])).toHaveValue('ISSUE_CATEGORY');
    const groupKey = `E2E-IG-${unique()}`;
    await page.getByLabel(vi['mdm.create.key.label'], { exact: true }).fill(groupKey);
    await page.getByLabel(vi['mdm.create.name.label']).fill('Nhóm vướng mắc e2e');
    await page.getByLabel(vi['mdm.create.validFrom.label']).fill('2026-01-01');
    await page.getByLabel(vi['mdm.create.reason.label']).fill('Issue group of the end-to-end flow');
    await page.getByLabel(vi['mdm.attr.issueCategory.slaPriorityKey.label']).selectOption('URGENT');
    await page.getByLabel(vi['mdm.attr.issueCategory.handlerUnitKey.label']).fill('not a key!');
    await page.getByRole('button', { name: vi['mdm.create.save.action'] }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'attributes.handler_unit_key' })).toBeVisible();
    await page.getByLabel(vi['mdm.attr.issueCategory.handlerUnitKey.label']).fill('LAND-UNIT');
    await page.getByRole('button', { name: vi['mdm.create.save.action'] }).click();
    await expect(page.getByTestId('impact')).toBeVisible();
    const [created] = await sql<{ attributes: Record<string, string> }>(
      'select v.attributes from machvon.master_record_version v join machvon.master_record r on r.id = v.master_record_id where r.business_key = $1',
      [groupKey],
    );
    expect(created?.attributes).toEqual({ sla_priority_key: 'URGENT', handler_unit_key: 'LAND-UNIT' });
  });

  test('a steward imports a catalogue file: the dry run names the row in error, the fixed file is applied, and a checker approves and publishes the whole batch', async ({ page }) => {
    const prefix = `IMP${unique()}`;
    const header = 'Mã,Tên,Từ ngày,Mã cha';
    const rows = (broken: boolean): string =>
      [header, `${prefix}-1,Giao thông,2024-01-01,`, `${prefix}-2,${broken ? '' : 'Đường bộ'},2024-01-01,${prefix}-1`, `${prefix}-3,Đường sắt,2024-01-01,${prefix}-1`].join(NEWLINE) + NEWLINE;
    const chooseFile = async (content: string): Promise<void> => {
      await page.locator('#import-file').setInputFiles({ name: 'catalogue.csv', mimeType: 'text/csv', buffer: Buffer.from(content, 'utf8') });
      await page.getByRole('button', { name: vi['mdm.import.upload.action'] }).click();
      await expect(page.getByTestId('mapping')).toBeVisible();
    };
    await open(page, '/mdm/mdm-29', 'steward');
    await page.getByLabel(vi['mdm.import.type.label']).fill('E2E_SECTOR');
    await chooseFile(rows(true));
    // The columns are found by their names; the dry run says which row is wrong.
    await expect(page.getByLabel(vi['mdm.import.map.key.label'], { exact: true })).toHaveValue('Mã');
    await page.getByRole('button', { name: vi['mdm.import.check.action'] }).click();
    await expect(page.getByTestId('errors')).toBeVisible();
    await expect(page.locator('[data-row="3"]')).toContainText(vi['mdm.import.error.required.text']);
    await expect(page.getByTestId('blocked')).toBeVisible();
    await expect(page.getByRole('button', { name: vi['mdm.import.apply.action'] })).toBeDisabled();
    expect(Number((await sql<{ n: string }>('select count(*)::text as n from machvon.master_record where business_key like $1', [`${prefix}-%`]))[0]?.n)).toBe(0);

    // The fixed file is a new upload: no error, and applying it creates every record together for review.
    await open(page, '/mdm/mdm-29', 'steward');
    await page.getByLabel(vi['mdm.import.type.label']).fill('E2E_SECTOR');
    await chooseFile(rows(false));
    await page.getByRole('button', { name: vi['mdm.import.check.action'] }).click();
    await expect(page.getByTestId('no-errors')).toBeVisible();
    await page.getByRole('button', { name: vi['mdm.import.apply.action'] }).click();
    await expect(page.getByTestId('own-batch')).toBeVisible();
    const [applied] = await sql<{ id: string; status: string }>("select id, status from machvon.master_import_batch where total_rows = 3 and error_rows = 0 and status = 'IN_REVIEW' order by created_at desc limit 1");
    expect(applied?.status).toBe('IN_REVIEW');
    expect(Number((await sql<{ n: string }>("select count(*)::text as n from machvon.master_change_request where import_batch_id = $1 and status = 'IN_REVIEW'", [applied?.id]))[0]?.n)).toBe(3);

    // The checker decides the whole batch, then publishes it on a decision document: all three records are in force.
    await open(page, `/mdm/mdm-29?batch=${applied?.id}`, 'dataChecker');
    await page.getByLabel(vi['mdm.approval.reason.label']).fill('Checked against the decision of the committee');
    await page.getByRole('button', { name: vi['mdm.import.review.approve.action'] }).click();
    const document = await documentFor();
    await page.getByLabel(vi['mdm.approval.document.label']).fill(document);
    await page.getByRole('button', { name: vi['mdm.import.publish.action'] }).click();
    await expect(page.getByText(vi['mdm.import.applied.notice'])).toBeVisible();
    const records = await sql<{ business_key: string; status: string }>('select business_key, status from machvon.master_record where business_key like $1 order by business_key', [`${prefix}-%`]);
    expect(records.map((record) => record.status)).toEqual(['EFFECTIVE', 'EFFECTIVE', 'EFFECTIVE']);

    // The same file is never applied again.
    await open(page, '/mdm/mdm-29', 'steward');
    await page.getByLabel(vi['mdm.import.type.label']).fill('E2E_SECTOR');
    await chooseFile(rows(false));
    await page.getByRole('button', { name: vi['mdm.import.check.action'] }).click();
    await expect(page.getByRole('alert').filter({ hasText: vi['mdm.problem.alreadyApplied.error'] })).toBeVisible();
  });

  test('a steward maps a Treasury code to an entry, a second mapping of the same code is refused, and the Treasury offices screen shows the code until the mapping is retired', async ({ page }) => {
    const office = `E2E-TO-${unique()}`;
    const external = `KB-${unique()}`;
    await putInForce(page, office, { type: 'TREASURY_OFFICE', name: 'Kho bạc e2e', attributes: JSON.stringify({ level: 'PROVINCE', province: 'Cao Bằng' }) });
    expect((await recordOf(office)).status).toBe('EFFECTIVE');

    const fillMapping = async (): Promise<void> => {
      const form = page.getByRole('form', { name: vi['mdm.crosswalk.form.aria'] });
      await form.getByLabel(vi['mdm.crosswalk.form.masterType.label'], { exact: true }).fill('TREASURY_OFFICE');
      await form.getByLabel(vi['mdm.crosswalk.form.businessKey.label'], { exact: true }).fill(office);
      await form.getByLabel(vi['mdm.crosswalk.form.system.label'], { exact: true }).fill('TREASURY');
      await form.getByLabel(vi['mdm.crosswalk.form.type.label'], { exact: true }).fill('AGENCY_CODE');
      await form.getByLabel(vi['mdm.crosswalk.form.code.label'], { exact: true }).fill(external);
      await form.getByLabel(vi['mdm.crosswalk.form.validFrom.label'], { exact: true }).fill('2024-01-01');
      await form.getByRole('button', { name: vi['mdm.crosswalk.save.action'] }).click();
    };
    const mappings = async (): Promise<number> =>
      Number((await sql<{ n: string }>("select count(*)::text as n from machvon.master_crosswalk where external_code = $1 and source_system = 'TREASURY'", [external]))[0]?.n);
    const rowOf = () => page.locator(`tr[data-external-code="${external}"]`);

    await open(page, '/mdm/mdm-24', 'steward');
    await fillMapping();
    await expect(page.getByTestId('crosswalk-saved')).toBeVisible();
    await expect(rowOf()).toHaveCount(1);
    await expect(rowOf()).toHaveAttribute('data-status', 'ACTIVE');
    await expect(rowOf()).toContainText('TREASURY');
    await expect(rowOf()).toContainText('AGENCY_CODE');
    await expect(rowOf()).toContainText(office);
    await expect(rowOf()).toContainText(vi['mdm.crosswalk.status.active.text']);

    // A code stands for one entry at a time: the second mapping is refused with the message of the screen and nothing is written.
    await fillMapping();
    await expect(page.getByRole('alert').filter({ hasText: vi['mdm.problem.duplicateCrosswalk.error'] })).toBeVisible();
    await expect(rowOf()).toHaveCount(1);
    expect(await mappings()).toBe(1);

    // MDM-16: the code is read from the active mapping of the system TREASURY and the code type AGENCY_CODE.
    await open(page, '/mdm/mdm-16', 'steward');
    await expect(page.getByRole('heading', { level: 1, name: vi['mdm.treasuryOffice.page.title'] })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: vi['mdm.catalogue.treasuryCode.column'] })).toBeVisible();
    await expect(page.locator(`tr[data-key="${office}"]`)).toContainText(external);

    // Retiring the mapping needs a reason, keeps the row in the table as retired, and the office has no Treasury code any more.
    await open(page, '/mdm/mdm-24', 'steward');
    await rowOf().getByRole('button', { name: vi['mdm.crosswalk.retire.action'] }).click();
    const retireForm = page.getByRole('form', { name: vi['mdm.crosswalk.retire.title'].replace('{code}', external) });
    await retireForm.getByRole('button', { name: vi['mdm.crosswalk.retire.confirm.action'] }).click();
    await expect(retireForm.getByText(vi['mdm.field.required.error'])).toBeVisible();
    await retireForm.getByLabel(vi['mdm.crosswalk.retire.reason.label'], { exact: true }).fill('The office was merged into another one');
    await retireForm.getByRole('button', { name: vi['mdm.crosswalk.retire.confirm.action'] }).click();
    await expect(rowOf()).toHaveAttribute('data-status', 'RETIRED');
    await expect(rowOf().getByRole('button', { name: vi['mdm.crosswalk.retire.action'] })).toHaveCount(0);
    const [stored] = await sql<{ status: string; valid_until: string | null }>("select status, valid_until::text as valid_until from machvon.master_crosswalk where external_code = $1 and source_system = 'TREASURY'", [external]);
    expect(stored?.status).toBe('RETIRED');
    expect(stored?.valid_until).not.toBeNull();

    await open(page, '/mdm/mdm-16', 'steward');
    await expect(page.locator(`tr[data-key="${office}"]`)).toBeVisible();
    await expect(page.locator(`tr[data-key="${office}"]`)).not.toContainText(external);

    // The retired code can be given to an entry again: only an ACTIVE mapping holds a code.
    await open(page, '/mdm/mdm-24', 'steward');
    await fillMapping();
    await expect(page.getByTestId('crosswalk-saved')).toBeVisible();
    expect(await mappings()).toBe(2);
  });

  test('the connectors show that their adapter is only proposed, and a position reset by hand needs a reason and is what the connector reads next', async ({ page }) => {
    await open(page, '/mdm/mdm-24', 'steward');
    const connectors = page.getByTestId('connectors');
    for (const name of ['NATIONAL_PIM_FILE', 'TREASURY_STATEMENT_FILE', 'PROCUREMENT_FILE', 'BUDGET_CODE_FILE']) {
      await expect(connectors.locator(`tr[data-connector="${name}"]`)).toHaveAttribute('data-adapter', 'PROPOSED');
    }
    const row = connectors.locator('tr[data-connector="NATIONAL_PIM_FILE"]');
    await expect(row).toContainText(vi['mdm.cursor.adapter.proposed.pill']);
    await expect(row).toContainText(vi['mdm.cursor.never.text']);

    await row.getByRole('button', { name: vi['mdm.cursor.reset.action'] }).click();
    const form = page.getByTestId('reset-form');
    await expect(form).toBeVisible();
    await expect(form.getByRole('heading', { name: vi['mdm.cursor.reset.title'].replace('{connector}', 'NATIONAL_PIM_FILE') })).toBeVisible();
    // The reason is required and the position is a JSON object; the server is not asked until both are right.
    await form.getByRole('button', { name: vi['mdm.cursor.reset.submit.action'] }).click();
    await expect(form.getByText(vi['mdm.field.required.error'])).toBeVisible();
    await form.getByLabel(vi['mdm.cursor.reset.reason.label'], { exact: true }).fill('Read again from the file of the e2e flow');
    await form.getByLabel(vi['mdm.cursor.reset.position.label'], { exact: true }).fill('not json');
    await form.getByRole('button', { name: vi['mdm.cursor.reset.submit.action'] }).click();
    await expect(form).toBeVisible();
    await form.getByLabel(vi['mdm.cursor.reset.position.label'], { exact: true }).fill(JSON.stringify({ file: 'e2e-batch.csv', offset: 42 }));
    await form.getByRole('button', { name: vi['mdm.cursor.reset.submit.action'] }).click();
    await expect(page.getByTestId('reset-form')).toHaveCount(0);

    const [stored] = await sql<{ cursor_json: { file: string; offset: number }; reset_reason: string; status: string; version: string }>(
      "select cursor_json, reset_reason, status, version::text as version from machvon.integration_cursor where connector_code = 'NATIONAL_PIM_FILE'",
    );
    expect(stored?.cursor_json).toEqual({ file: 'e2e-batch.csv', offset: 42 });
    expect(stored?.reset_reason).toBe('Read again from the file of the e2e flow');
    expect(stored?.status).toBe('ACTIVE');
    expect(Number(stored?.version)).toBeGreaterThan(1);
    // The other connectors were not touched.
    const [others] = await sql<{ n: string }>("select count(*)::text as n from machvon.integration_cursor where connector_code <> 'NATIONAL_PIM_FILE' and reset_reason is not null");
    expect(Number(others?.n)).toBe(0);

    // Reopened (a new load of the screen), the connector offers the position it now stands at; the badge is still the proposed one.
    await open(page, '/mdm/mdm-24', 'steward');
    const again = page.getByTestId('connectors').locator('tr[data-connector="NATIONAL_PIM_FILE"]');
    await expect(again).toHaveAttribute('data-adapter', 'PROPOSED');
    await again.getByRole('button', { name: vi['mdm.cursor.reset.action'] }).click();
    await expect(page.getByLabel(vi['mdm.cursor.reset.position.label'], { exact: true })).toHaveValue(/"offset": 42/);
  });

  test('the mappings are listed but not editable, and the connectors are not shown, to someone who may only read the catalogues', async ({ page }) => {
    await open(page, '/mdm/mdm-24', 'dataChecker');
    await expect(page.getByRole('heading', { level: 1, name: vi['mdm.crosswalk.page.title'] })).toBeVisible();
    await expect(page.getByRole('form', { name: vi['mdm.crosswalk.form.aria'] })).toHaveCount(0);
    await expect(page.getByTestId('connectors')).toHaveCount(0);
    await expect(page.getByRole('button', { name: vi['mdm.crosswalk.retire.action'] })).toHaveCount(0);
  });

  test('a steward proposes a term, the proposer and a holder who does not own it are refused, and the owner approves and publishes it and then its next revision', async ({ page }) => {
    const code = `E2E_TERM_${unique()}`;
    const owner = membershipOf('dataChecker');
    const rowOf = (status: string) => page.locator(`tr[data-term-code="${code}"][data-status="${status}"]`);
    const termsOf = (): Promise<Array<{ id: string; revision: number; status: string; supersedes_id: string | null; effective_from: string | null }>> =>
      sql("select id, revision, status, supersedes_id, effective_from::text as effective_from from machvon.glossary_term where term_code = $1 order by revision", [code]);
    const decideAs = async (user: string, status: string, reason: string): Promise<void> => {
      await open(page, '/mdm/mdm-34', user);
      await rowOf(status).getByRole('button', { name: vi['mdm.glossary.decide.action'] }).click();
      const panel = page.getByRole('form', { name: vi['mdm.glossary.decide.title'].replace('{code}', code) });
      await panel.getByLabel(vi['mdm.approval.reason.label']).fill(reason);
      await panel.getByRole('button', { name: vi['mdm.approval.decision.approve.action'] }).click();
    };
    const form = page.getByRole('form', { name: vi['mdm.glossary.form.aria'] });
    const fillTerm = async (definition: string): Promise<void> => {
      await form.getByLabel(vi['mdm.glossary.form.definition.label'], { exact: true }).fill(definition);
      await form.getByRole('button', { name: vi['mdm.glossary.save.action'] }).click();
      await expect(page.getByTestId('glossary-saved')).toBeVisible();
    };

    await open(page, '/mdm/mdm-34', 'steward');
    await expect(page.getByRole('heading', { level: 1, name: vi['mdm.glossary.page.title'] })).toBeVisible();
    // No disbursement term of the tenant is published, so the D03 definitions await sign-off.
    await expect(page.getByTestId('definition-badge')).toHaveAttribute('data-state', 'PENDING');
    await expect(page.getByTestId('definition-badge')).toContainText(vi['mdm.glossary.badge.pending.pill']);

    // The form names what is missing before the server is asked.
    await form.getByRole('button', { name: vi['mdm.glossary.save.action'] }).click();
    await expect(form.getByText(vi['mdm.field.required.error']).first()).toBeVisible();
    await form.getByLabel(vi['mdm.glossary.form.code.label'], { exact: true }).fill(code);
    await form.getByLabel(vi['mdm.glossary.form.term.label'], { exact: true }).fill('Giải ngân e2e');
    await form.getByLabel(vi['mdm.glossary.form.domain.label'], { exact: true }).fill('E2E_GLOSSARY');
    await form.getByLabel(vi['mdm.glossary.form.owner.label'], { exact: true }).fill(owner);
    await form.getByLabel(vi['mdm.glossary.form.formula.label'], { exact: true }).fill('e2e = SUM(paid)');
    await fillTerm('Giải ngân tính theo ngày Kho bạc thanh toán, bản của luồng e2e.');
    await expect(rowOf('DRAFT')).toHaveCount(1);
    await expect(rowOf('DRAFT')).toContainText('e2e = SUM(paid)');

    await rowOf('DRAFT').getByRole('button', { name: vi['mdm.glossary.submit.action'] }).click();
    await expect(rowOf('IN_REVIEW')).toHaveCount(1);

    // The steward holds the permission to decide and is the proposer: the server refuses and the term stays in review.
    await decideAs('steward', 'IN_REVIEW', 'Approved by its own proposer');
    await expect(page.getByRole('alert').filter({ hasText: vi['mdm.problem.selfApproval.error'] })).toBeVisible();
    expect((await termsOf())[0]?.status).toBe('IN_REVIEW');

    // The tenant owner holds the permission too, but the owner named on the term is someone else.
    await decideAs('owner', 'IN_REVIEW', 'Approved by someone who does not own the term');
    await expect(page.getByRole('alert').filter({ hasText: vi['mdm.problem.notOwner.error'] })).toBeVisible();
    expect((await termsOf())[0]?.status).toBe('IN_REVIEW');

    await decideAs('dataChecker', 'IN_REVIEW', 'Checked against the decision of the committee');
    await expect(rowOf('APPROVED')).toHaveCount(1);
    await rowOf('APPROVED').getByRole('button', { name: vi['mdm.glossary.publish.action'] }).click();
    await expect(rowOf('PUBLISHED')).toHaveCount(1);
    const [first] = await termsOf();
    expect(first).toMatchObject({ revision: 1, status: 'PUBLISHED', supersedes_id: null });
    expect(first?.effective_from).not.toBeNull();
    const events = await sql<{ n: string }>("select count(*)::text as n from machvon.outbox_event where type = 'glossary.published.v1' and aggregate_id = $1", [first?.id]);
    expect(Number(events[0]?.n)).toBe(1);

    // A published term is not edited: the steward proposes the next revision from its words, and publishing it replaces the first.
    await open(page, '/mdm/mdm-34', 'steward');
    await rowOf('PUBLISHED').getByRole('button', { name: vi['mdm.glossary.revise.action'] }).click();
    await expect(page.getByRole('heading', { level: 2, name: vi['mdm.glossary.revise.title'].replace('{code}', code).replace('{revision}', '1') })).toBeVisible();
    await expect(form.getByLabel(vi['mdm.glossary.form.code.label'], { exact: true })).toHaveValue(code);
    await fillTerm('Giải ngân tính theo ngày Kho bạc thanh toán, bản hai của luồng e2e.');
    await expect(rowOf('DRAFT')).toHaveAttribute('data-revision', '2');
    await rowOf('DRAFT').getByRole('button', { name: vi['mdm.glossary.submit.action'] }).click();
    await expect(rowOf('IN_REVIEW')).toHaveCount(1);
    await decideAs('dataChecker', 'IN_REVIEW', 'Checked against the decision of the committee');
    await expect(rowOf('APPROVED')).toHaveCount(1);
    await rowOf('APPROVED').getByRole('button', { name: vi['mdm.glossary.publish.action'] }).click();
    await expect(rowOf('PUBLISHED')).toHaveAttribute('data-revision', '2');
    await expect(rowOf('DEPRECATED')).toHaveAttribute('data-revision', '1');
    const stored = await termsOf();
    expect(stored.map((row) => [row.revision, row.status])).toEqual([[1, 'DEPRECATED'], [2, 'PUBLISHED']]);
    expect(stored[1]?.supersedes_id).toBe(first?.id);
  });

  test('someone who may not propose is offered no form for a term, and someone without the glossary permissions is told so', async ({ page }) => {
    await open(page, '/mdm/mdm-34', 'dataChecker');
    await expect(page.getByRole('heading', { level: 1, name: vi['mdm.glossary.page.title'] })).toBeVisible();
    await expect(page.getByRole('form', { name: vi['mdm.glossary.form.aria'] })).toHaveCount(0);
    await open(page, '/mdm/mdm-34', 'auditor');
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
    await expect(page.getByRole('form', { name: vi['mdm.glossary.form.aria'] })).toHaveCount(0);
  });

  test('a steward records the merger of two agencies, a second person approves and publishes it, and the inheritance tree and the agency screen show it (MDM-37, MDM-03)', async ({ page }) => {
    const suffix = unique();
    const [left, right, merged, other] = ['A', 'B', 'Y', 'Z'].map((part) => `E2E-AG-${part}-${suffix}`) as [string, string, string, string];
    for (const entry of [left, right, merged, other]) await putInForce(page, entry, { type: 'AGENCY', name: `Agency ${entry}` });

    const successionOf = async (key: string): Promise<string> => {
      const [row] = await sql<{ id: string }>(
        `select c.id from machvon.master_change_request c join machvon.master_record r on r.id = c.master_record_id
          where r.business_key = $1 and c.change_kind = 'SUCCESSION' order by c.created_at desc limit 1`,
        [key],
      );
      return row?.id ?? '';
    };
    /** Opens MDM-37 on the agencies, fills the form for one edge and saves the draft; with `submit` it also reads the impact and sends it to review. */
    const record = async (from: string, to: string, options: { kind?: string; share?: string; date?: string; submit?: boolean } = {}): Promise<void> => {
      await open(page, '/mdm/mdm-37', 'steward');
      await page.getByLabel(vi['mdm.succession.type.label'], { exact: true }).selectOption('AGENCY');
      const form = page.getByRole('form', { name: vi['mdm.succession.form.aria'] });
      if (options.kind !== undefined) await form.getByLabel(vi['mdm.succession.kind.label'], { exact: true }).selectOption(options.kind);
      await form.getByLabel(vi['mdm.succession.predecessor.label'], { exact: true }).selectOption((await recordOf(from)).id);
      await form.getByLabel(vi['mdm.succession.successor.label'], { exact: true }).selectOption((await recordOf(to)).id);
      if (options.date !== undefined) await form.getByLabel(vi['mdm.succession.effective.label'], { exact: true }).fill(options.date);
      if (options.share !== undefined) await form.getByLabel(vi['mdm.succession.shareField.label'], { exact: true }).fill(options.share);
      await form.getByLabel(vi['mdm.succession.basis.label'], { exact: true }).fill('Decision of the 2025 reform (working assumption awaiting CXN-34)');
      await form.getByLabel(vi['mdm.succession.reason.label'], { exact: true }).fill('Recorded by the end-to-end flow');
      await form.getByRole('button', { name: vi['mdm.succession.save.action'] }).click();
      if (options.submit !== true) return;
      await expect(page.getByTestId('succession-saved')).toBeVisible();
      await expect(page.getByTestId('impact')).toBeVisible();
      await page.getByRole('checkbox', { name: vi['mdm.impact.read.label'] }).check();
      await page.getByRole('button', { name: vi['mdm.impact.submit.action'] }).click();
      await expect(page.getByTestId('succession-submitted')).toBeVisible();
    };

    await record(left, merged, { submit: true });
    await record(right, merged, { submit: true });
    const leftRequest = await successionOf(left);
    const rightRequest = await successionOf(right);
    expect((await changesOf(left)).map((row) => [row.change_kind, row.status])).toEqual([['CREATE', 'APPLIED'], ['SUCCESSION', 'IN_REVIEW']]);

    // The reviewer reads the kind, the date, the legal basis and the receiving entry of the proposal before deciding.
    await open(page, '/mdm/mdm-32', 'dataChecker');
    const reviewRow = page.locator(`[data-stage="review"][data-change-id="${leftRequest}"]`);
    await expect(reviewRow).toContainText(vi['mdm.kind.change.succession']);
    await reviewRow.getByRole('button', { name: vi['mdm.approval.review.action'] }).click();
    const proposal = page.locator(`[data-panel-for="${leftRequest}"]`).getByTestId('proposal');
    await expect(proposal).toContainText(`MERGE · ${vi['mdm.value.successionKind.merge']}`);
    await expect(proposal).toContainText('2025-07-01');
    await expect(proposal).toContainText(merged);
    // Nothing is a fact before it is published.
    expect(Number((await sql<{ n: string }>('select count(*)::text as n from machvon.master_succession where predecessor_record_id = $1', [(await recordOf(left)).id]))[0]?.n)).toBe(0);

    for (const request of [leftRequest, rightRequest]) {
      await approve(page, request, 'Checked against the decision of the committee');
      await publish(page, request);
    }
    const edges = await sql<{ predecessor: string; successor: string; succession_kind: string; effective_date: string }>(
      `select r.business_key as predecessor, q.business_key as successor, s.succession_kind, s.effective_date::text as effective_date
         from machvon.master_succession s join machvon.master_record r on r.id = s.predecessor_record_id join machvon.master_record q on q.id = s.successor_record_id
        where q.business_key = $1 order by r.business_key`,
      [merged],
    );
    expect(edges).toEqual([left, right].sort().map((predecessor) => ({ predecessor, successor: merged, succession_kind: 'MERGE', effective_date: '2025-07-01' })));
    expect((await recordOf(left)).status).toBe('RETIRED');
    expect((await recordOf(merged)).status).toBe('EFFECTIVE');
    // History is not rewritten: the retired agency keeps its one revision, closed on the date of the succession.
    const versions = await sql<{ revision: number; valid_until: string }>('select revision, valid_until::text as valid_until from machvon.master_record_version where master_record_id = $1', [(await recordOf(left)).id]);
    expect(versions).toEqual([{ revision: 1, valid_until: '2025-07-01' }]);

    // MDM-37: the tree joins the two agencies before the date to the merged one after it, with the kind on the connector.
    await open(page, '/mdm/mdm-37', 'steward');
    await page.getByLabel(vi['mdm.succession.type.label'], { exact: true }).selectOption('AGENCY');
    const connector = page.locator('[data-testid="connector-row"]', { has: page.locator(`[data-side="before"] [data-key="${left}"]`) });
    await expect(connector).toHaveCount(1);
    await expect(connector.locator('[data-side="before"] li')).toHaveCount(2);
    await expect(connector.locator('[data-side="after"] li')).toHaveCount(1);
    await expect(connector.locator('[data-side="after"] [data-key]').first()).toHaveAttribute('data-key', merged);
    await expect(connector.locator('.pill[data-kind="MERGE"]')).toHaveText('MERGE');
    await expect(page.getByRole('heading', { level: 2, name: vi['mdm.succession.before.title'].replace('{date}', '2025-07-01') })).toBeVisible();
    // Another date: nothing takes effect on it. The first date again: the connector is back.
    await page.getByLabel(vi['mdm.succession.date.label'], { exact: true }).fill('2025-08-01');
    await expect(page.getByTestId('no-succession')).toContainText('2025-08-01');
    await page.getByLabel(vi['mdm.succession.date.label'], { exact: true }).fill('2025-07-01');
    await expect(connector).toHaveCount(1);

    // MDM-03: on a date after it, the agency shows who succeeded it; the structure of the entry is read on the date.
    await open(page, '/mdm/mdm-03', 'steward');
    await expect(page.getByRole('heading', { level: 1, name: vi['mdm.agency.page.title'] })).toBeVisible();
    const agency = page.locator(`tr[data-key="${left}"]`);
    await expect(agency).toHaveAttribute('data-state', 'SUCCEEDED');
    await expect(agency.locator('td[data-column="successor"]')).toHaveText(merged);
    await expect(agency.locator('td[data-column="legalName"]')).toHaveText(`Agency ${left}`);
    await agency.getByRole('button', { name: vi['mdm.structure.inspect.action'] }).click();
    await expect(page.getByTestId('inspect-state')).toHaveText(vi['mdm.structure.state.succeeded']);
    await expect(page.getByTestId('inspect-structure-date')).toHaveText('2025-07-01');
    await expect(page.getByTestId('inspect-targets')).toContainText(merged);
    // Before the date the same agency is in force and has no successor yet.
    await page.getByLabel(vi['mdm.structure.date.label'], { exact: true }).fill('2025-06-30');
    await expect(agency).toHaveAttribute('data-state', 'IN_FORCE');
    await expect(agency.locator('td[data-column="successor"]')).toHaveText('');

    // A ring is refused even when the first request is still waiting; a share outside 0..100 never leaves the form.
    await record(other, merged, { submit: false });
    await expect(page.getByTestId('succession-saved')).toBeVisible();
    await record(merged, other, { date: '2025-08-01' });
    await expect(page.getByTestId('record-problem')).toHaveText(vi['mdm.problem.successionCycle.error']);
    await expect(page.getByTestId('succession-saved')).toHaveCount(0);
    await open(page, '/mdm/mdm-37', 'steward');
    await page.getByLabel(vi['mdm.succession.type.label'], { exact: true }).selectOption('AGENCY');
    const splitForm = page.getByRole('form', { name: vi['mdm.succession.form.aria'] });
    await splitForm.getByLabel(vi['mdm.succession.kind.label'], { exact: true }).selectOption('SPLIT');
    await splitForm.getByLabel(vi['mdm.succession.shareField.label'], { exact: true }).fill('100');
    await splitForm.getByRole('button', { name: vi['mdm.succession.save.action'] }).click();
    await expect(splitForm.getByText(vi['mdm.succession.invalidShare.error'])).toBeVisible();
    expect(Number((await sql<{ n: string }>('select count(*)::text as n from machvon.master_succession where predecessor_record_id = $1', [(await recordOf(merged)).id]))[0]?.n)).toBe(0);

    // Someone who may not propose reads the tree and is offered no way to record a succession.
    await open(page, '/mdm/mdm-37', 'dataChecker');
    await expect(page.getByRole('form', { name: vi['mdm.succession.form.aria'] }).getByRole('button', { name: vi['mdm.succession.save.action'] })).toHaveCount(0);
  });

  test('someone without the master data permissions sees no entry and is offered no way to add one', async ({ page }) => {
    await open(page, '/mdm/mdm-01', 'auditor');
    await expect(page.getByRole('heading', { level: 1, name: vi['mdm.hub.page.title'] })).toBeVisible();
    await expect(page.getByRole('link', { name: vi['mdm.hub.add.action'] })).toHaveCount(0);
    await expect(page.locator('[data-record-id]')).toHaveCount(0);
  });
});
