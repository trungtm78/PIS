import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * LND-08 (the complaints of the households) in a real browser against the real API and database (apps/api/test/e2e-stack): the officer files a complaint of a household, which gets its number, the days of the rule from
 * the day it was filed and a timer, and holds the parcels of the household as disputed; it is answered with a reply document, which ends the timer and gives the parcels back, or escalated with a note; what the
 * complainant said is in neither the trail nor the event that asks ISS for an issue; a reader sees the complaints and no button.
 */

const UNIT_CODE = 'CB-SKHDT-QLDA';
const WORDS = 'Giá nhà quá thấp so với thị trường lân cận';
const DAY = 24 * 60 * 60 * 1000;

const vietnamToday = (): string => new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
const shift = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

interface Seeded {
  projectId: string;
  households: Array<{ id: string; code: string; parcelId: string }>;
  documentId: string;
}

/** A project with two households of the unit, each holding a right on a parcel, and a reply document that was scanned clean. */
async function seed(): Promise<Seeded> {
  const tenant = stackInfo().tenants.A;
  const unit = stackInfo().units.A[UNIT_CODE];
  const officer = membershipOf('landComplaintOfficer');
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and code = 'E2E_AREA_1'", [tenant]);
  const projectId = randomUUID();
  const code = `E2E-CMP-${Date.now().toString(36).toUpperCase()}-${projectId.slice(0, 4).toUpperCase()}`;
  await sql(
    `insert into machvon.project
       (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, project_group, version, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 150000000000, 'IMPLEMENTATION', 'B', 1, $7, $7)`,
    [tenant, projectId, code, `Dự án GPMB ${code}`, unit, area?.id, officer],
  );
  const households: Seeded['households'] = [];
  for (const index of [0, 1]) {
    const id = randomUUID();
    const parcelId = randomUUID();
    const householdCode = `HH-${String.fromCharCode(65 + index)}${projectId.slice(0, 4).toUpperCase()}`;
    await sql(
      `insert into machvon.land_parcel (tenant_id, id, project_id, owner_unit_id, parcel_code, land_use_group, area_total_m2, area_affected_m2, status, version, created_by, updated_by)
       values ($1, $2, $3, $4, $5, 'AGRICULTURAL', 1000, 500, 'SURVEYED', 1, $6, $6)`,
      [tenant, parcelId, projectId, unit, `CP-${householdCode}`, officer],
    );
    await sql(
      `insert into machvon.affected_household
         (tenant_id, id, project_id, owner_unit_id, household_code, head_name, head_name_enc, legal_basis, legal_basis_ref, retention_until, status, version, created_by, updated_by)
       values ($1, $2, $3, $4, $5, 'N***** V** A', decode('00', 'hex'), 'PUBLIC_TASK_LAND_LAW', 'Luật Đất đai 2024, Điều 87', date '2036-12-31', 'REGISTERED', 1, $6, $6)`,
      [tenant, id, projectId, unit, householdCode, officer],
    );
    await sql(
      `insert into machvon.household_parcel (tenant_id, id, household_id, parcel_id, owner_unit_id, right_kind, share_pct, created_by, updated_by)
       values ($1, $2, $3, $4, $5, 'OWNER', 100, $6, $6)`,
      [tenant, randomUUID(), id, parcelId, unit, officer],
    );
    households.push({ id, code: householdCode, parcelId });
  }
  const [clean] = await sql<{ id: string }>("select id from machvon.document_version where tenant_id = $1 and scan_status = 'CLEAN' limit 1", [tenant]);
  return { projectId, households, documentId: clean?.id ?? '' };
}

async function open(page: Page, user: string, aim: Seeded): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`/lnd/lnd-08?project=${aim.projectId}&devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

const parcelStatus = async (id: string): Promise<string> => ((await sql<{ status: string }>('select status from machvon.land_parcel where id = $1', [id]))[0] as { status: string }).status;

test.describe('LND-08: the complaints of the households', () => {
  test('the officer files a complaint, which gets its number, its days and its timer and holds the parcels; answers one with a reply document and escalates another (AC-ST-LND-008-1, UAT-AC384, UI-LND-08)', async ({ page }) => {
    const aim = await seed();
    const today = vietnamToday();
    const [a, b] = aim.households as [Seeded['households'][number], Seeded['households'][number]];
    await open(page, 'landComplaintOfficer', aim);
    await expect(page.getByRole('heading', { level: 1, name: vi['lnd.complaints.page.title'] })).toBeVisible();
    await expect(page.getByTestId('no-match')).toHaveText(vi['lnd.complaints.empty.notice']);

    const file = async (household: Seeded['households'][number], subject: string, channel: string) => {
      await page.getByRole('button', { name: vi['lnd.complaints.file.action'] }).click();
      await page.getByLabel(vi['lnd.complaints.fileDialog.household.label'], { exact: true }).selectOption({ label: household.code });
      await page.getByLabel(vi['lnd.complaints.fileDialog.channel.label'], { exact: true }).selectOption(channel);
      await page.getByLabel(vi['lnd.complaints.fileDialog.subject.label'], { exact: true }).selectOption(subject);
      await page.getByLabel(vi['lnd.complaints.fileDialog.description.label'], { exact: true }).fill(WORDS);
      await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    };
    await page.getByRole('button', { name: vi['lnd.complaints.file.action'] }).click();
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(page.getByText(vi['lnd.field.required.error']).first()).toBeVisible();
    await page.getByRole('button', { name: vi['lnd.dialog.cancel.action'] }).click();
    await file(a, 'PRICE', 'MEETING');
    const rows = page.locator('[data-complaint-id]');
    await expect(rows).toHaveCount(1);
    const first = rows.first();
    await expect(first.getByTestId('number')).toContainText('LC-000001');
    await expect(first.getByTestId('household')).toHaveText(a.code);
    await expect(first.getByTestId('subject')).toHaveText(vi['lnd.complaintSubject.price.label']);
    await expect(first.getByTestId('description')).toContainText(WORDS);
    await expect(first.getByTestId('due')).toContainText(shift(today, 30));
    await expect(first.getByTestId('left')).toHaveText('Còn 30 ngày');
    await expect(first.getByTestId('status')).toHaveText(vi['lnd.complaintStatus.received.label']);
    expect(await parcelStatus(a.parcelId)).toBe('DISPUTED');
    const [row] = await sql<{ id: string }>('select id from machvon.land_complaint where household_id = $1', [a.id]);
    const [deadline] = await sql<{ timer_code: string; status: string; due_on: string; days_applied: number }>("select timer_code, status, due_on::text as due_on, days_applied from machvon.land_deadline where subject_id = $1", [row?.id]);
    expect(deadline).toEqual({ timer_code: 'COMPLAINT_RESOLUTION', status: 'RUNNING', due_on: shift(today, 30), days_applied: 30 });
    const [event] = await sql<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where aggregate_id = $1 and type = 'lnd.complaint.filed.v1'", [row?.id]);
    expect(event?.payload).toMatchObject({ source_ref_id: row?.id, reference_code: 'LC-000001', source_module: 'LND', subject: 'PRICE' });
    expect(JSON.stringify(event?.payload)).not.toContain(WORDS);
    expect(JSON.stringify(event?.payload)).not.toContain(a.id);

    // A second complaint of another household, answered by escalating it; the first is accepted with the reply document.
    await file(b, 'AREA', 'LETTER');
    await expect(rows).toHaveCount(2);
    const second = page.locator(`[data-complaint-id]`).filter({ hasText: b.code });
    await second.getByRole('button', { name: vi['lnd.complaints.resolve.aria'].replace('{number}', 'LC-000002') }).click();
    await page.getByLabel(vi['lnd.complaints.resolveDialog.outcome.label'], { exact: true }).selectOption('ESCALATED');
    await page.getByLabel(vi['lnd.complaints.resolveDialog.note.label'], { exact: true }).fill('Chuyển lên Hội đồng bồi thường cấp huyện');
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(second.getByTestId('status')).toHaveText(vi['lnd.complaintStatus.escalated.label']);
    expect(await parcelStatus(b.parcelId)).toBe('DISPUTED');

    await first.getByRole('button', { name: vi['lnd.complaints.resolve.aria'].replace('{number}', 'LC-000001') }).click();
    await page.getByLabel(vi['lnd.complaints.resolveDialog.outcome.label'], { exact: true }).selectOption('RESOLVED_ACCEPTED');
    await page.getByLabel(vi['lnd.complaints.resolveDialog.note.label'], { exact: true }).fill('Đã đo lại, chấp nhận kiến nghị');
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(page.getByText(vi['lnd.field.required.error'])).toBeVisible();
    await page.getByLabel(vi['lnd.complaints.resolveDialog.document.label'], { exact: true }).fill(aim.documentId);
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(first.getByTestId('status')).toHaveText(vi['lnd.complaintStatus.resolvedAccepted.label']);
    await expect(first.getByTestId('resolution')).toContainText('Đã đo lại, chấp nhận kiến nghị');
    await expect(first.getByRole('button')).toHaveCount(0);
    expect(await parcelStatus(a.parcelId)).toBe('SURVEYED');
    const [ended] = await sql<{ status: string; satisfied_on: string | null }>('select status, satisfied_on::text as satisfied_on from machvon.land_deadline where subject_id = $1', [row?.id]);
    expect(ended).toEqual({ status: 'SATISFIED', satisfied_on: today });

    const trail = await sql<{ action: string; diff: string }>(
      "select action, safe_diff::text as diff from machvon.audit_event where action like 'lnd.complaint_%' and resource_id in (select id from machvon.land_complaint where project_id = $1) order by occurred_at",
      [aim.projectId],
    );
    expect(trail.map((entry) => entry.action)).toEqual(['lnd.complaint_filed', 'lnd.complaint_filed', 'lnd.complaint_resolved', 'lnd.complaint_resolved']);
    for (const entry of trail) {
      expect(entry.diff).not.toContain(WORDS);
      expect(entry.diff).not.toContain('Chuyển lên');
      expect(entry.diff).not.toContain('Đã đo lại');
      for (const household of aim.households) expect(entry.diff).not.toContain(household.id);
    }
  });

  test('a reader sees the complaints with what they say and no button that files or answers (UI-LND-08)', async ({ page }) => {
    const aim = await seed();
    const [a] = aim.households as [Seeded['households'][number]];
    await open(page, 'landComplaintOfficer', aim);
    await page.getByRole('button', { name: vi['lnd.complaints.file.action'] }).click();
    await page.getByLabel(vi['lnd.complaints.fileDialog.household.label'], { exact: true }).selectOption({ label: a.code });
    await page.getByLabel(vi['lnd.complaints.fileDialog.channel.label'], { exact: true }).selectOption('PORTAL');
    await page.getByLabel(vi['lnd.complaints.fileDialog.subject.label'], { exact: true }).selectOption('PROCEDURE');
    await page.getByLabel(vi['lnd.complaints.fileDialog.description.label'], { exact: true }).fill(WORDS);
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(page.locator('[data-complaint-id]')).toHaveCount(1);

    await open(page, 'landPlanReader', aim);
    const row = page.locator('[data-complaint-id]').first();
    await expect(row).toBeVisible();
    await expect(row.getByTestId('description')).toContainText(WORDS);
    await expect(row.getByTestId('status')).toHaveText(vi['lnd.complaintStatus.received.label']);
    await expect(page.getByRole('button', { name: vi['lnd.complaints.file.action'] })).toHaveCount(0);
    await expect(row.getByRole('button')).toHaveCount(0);
  });
});
