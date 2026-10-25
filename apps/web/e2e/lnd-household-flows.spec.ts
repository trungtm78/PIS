import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * LND-03 (the households affected by a land recovery) in a real browser against the real API and database (apps/api/test/e2e-stack): an officer registers a
 * household on a legal basis with its retention, the identity number, the telephone and the address are sealed and shown masked, the household is linked to a
 * parcel of its unit, and the one button that opens the personal data shows it and leaves a trail without it; a reader sees the households with the identity
 * number hidden whole and no button; a household cannot be registered without its legal basis, nor twice with the same identity number.
 */

const UNIT_CODE = 'CB-SKHDT-QLDA';
const UNIT_NAME = 'Ban Quản lý dự án';
const HEAD = 'Nguyễn Văn Anh';
const ADDRESS = '12 Lê Lợi, Phường 3, Quận 1';
const PHONE = '0912345678';
const BASIS_REF = 'Luật Đất đai 2024, Điều 87';
const REASON = 'Đối chiếu hồ sơ trước khi chi trả bồi thường';

async function seedProject(): Promise<{ id: string; code: string; parcel: string; parcelCode: string }> {
  const tenant = stackInfo().tenants.A;
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and code = 'E2E_AREA_1'", [tenant]);
  const id = randomUUID();
  const code = `E2E-HH-${Date.now().toString(36).toUpperCase()}-${id.slice(0, 4).toUpperCase()}`;
  const unit = stackInfo().units.A[UNIT_CODE];
  const officer = membershipOf('householdOfficer');
  await sql(
    `insert into machvon.project
       (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, project_group, version, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 150000000000, 'IMPLEMENTATION', 'B', 1, $7, $7)`,
    [tenant, id, code, `Dự án GPMB ${code}`, unit, area?.id, officer],
  );
  const parcel = randomUUID();
  const parcelCode = `HH-P-${id.slice(0, 6).toUpperCase()}`;
  await sql(
    `insert into machvon.land_parcel (tenant_id, id, project_id, owner_unit_id, parcel_code, land_use_group, area_total_m2, area_affected_m2, status, version, created_by, updated_by)
     values ($1, $2, $3, $4, $5, 'AGRICULTURAL', 1000, 500, 'SURVEYED', 1, $6, $6)`,
    [tenant, parcel, id, unit, parcelCode, officer],
  );
  return { id, code, parcel, parcelCode };
}

async function open(page: Page, user: string, path: string): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

async function fillRegistration(page: Page, fields: { head: string; nationalId: string; phone: string; address: string; basis: string; basisRef: string; until: string }): Promise<void> {
  await page.getByLabel(vi['lnd.households.registerDialog.unit.label'], { exact: true }).selectOption({ label: UNIT_NAME });
  await page.getByLabel(vi['lnd.households.registerDialog.head.label'], { exact: true }).fill(fields.head);
  await page.getByLabel(vi['lnd.households.registerDialog.nationalId.label'], { exact: true }).fill(fields.nationalId);
  await page.getByLabel(vi['lnd.households.registerDialog.phone.label'], { exact: true }).fill(fields.phone);
  await page.getByLabel(vi['lnd.households.registerDialog.address.label'], { exact: true }).fill(fields.address);
  await page.getByLabel(vi['lnd.households.registerDialog.members.label'], { exact: true }).fill('4');
  if (fields.basis !== '') await page.getByLabel(vi['lnd.households.registerDialog.basis.label'], { exact: true }).selectOption(fields.basis);
  await page.getByLabel(vi['lnd.households.registerDialog.basisRef.label'], { exact: true }).fill(fields.basisRef);
  await page.getByLabel(vi['lnd.households.registerDialog.retention.label'], { exact: true }).fill(fields.until);
}

test.describe('LND-03: the households affected by a land recovery', () => {
  test('a household is registered on a legal basis, sealed and shown masked, linked to a parcel, and opened by the one recorded reading (AC-ST-LND-002-1, UI-LND-03)', async ({ page }) => {
    const project = await seedProject();
    const nationalId = `079${String(Date.now()).slice(-9)}`;
    await open(page, 'householdOfficer', `/lnd/lnd-03?project=${project.id}`);
    await expect(page.getByRole('heading', { level: 1, name: vi['lnd.households.page.title'] })).toBeVisible();
    await expect(page.getByTestId('privacy-note')).toHaveText(vi['lnd.households.privacy.note']);

    await page.getByRole('button', { name: vi['lnd.households.register.action'] }).click();
    // The form refuses what is missing before anything is sent: the legal basis and its reference first of all.
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(page.getByText(vi['lnd.field.required.error']).first()).toBeVisible();
    await fillRegistration(page, { head: HEAD, nationalId, phone: PHONE, address: ADDRESS, basis: '', basisRef: '', until: '2036-12-31' });
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(page.getByText(vi['lnd.field.required.error']).first()).toBeVisible();
    expect(await sql('select 1 from machvon.affected_household where project_id = $1', [project.id])).toHaveLength(0);

    await page.getByLabel(vi['lnd.households.registerDialog.basis.label'], { exact: true }).selectOption('PUBLIC_TASK_LAND_LAW');
    await page.getByLabel(vi['lnd.households.registerDialog.basisRef.label'], { exact: true }).fill(BASIS_REF);
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    const row = page.locator('[data-household-id]').first();
    await expect(row).toBeVisible();
    await expect(row.getByTestId('head')).toHaveText('N***** V** A**');
    await expect(row.getByTestId('national-id')).toHaveText(`********${nationalId.slice(-4)}`);
    await expect(row.getByTestId('basis')).toHaveText(vi['lnd.legalBasis.publicTask.label']);
    await expect(row.getByTestId('retention')).toHaveText(vi['lnd.households.retention.line'].replace('{until}', '2036-12-31'));
    await expect(page.locator('body')).not.toContainText(HEAD);
    await expect(page.locator('body')).not.toContainText(nationalId);

    // The database holds the masked forms in the clear columns and the sealed forms in the others; the plaintext is in neither.
    const [stored] = await sql<{ head_name: string; address_text: string; national_id_masked: string; phone_masked: string; sealed: boolean; has_plain: boolean }>(
      `select head_name, address_text, national_id_masked, phone_masked,
              (head_name_enc is not null and national_id_enc is not null and phone_enc is not null and address_enc is not null) as sealed,
              (position(convert_to($2, 'UTF8') in head_name_enc) > 0 or position(convert_to($3, 'UTF8') in national_id_enc) > 0
               or position(convert_to($4, 'UTF8') in address_enc) > 0 or position(convert_to($5, 'UTF8') in phone_enc) > 0) as has_plain
         from machvon.affected_household where project_id = $1`,
      [project.id, HEAD, nationalId, ADDRESS, PHONE],
    );
    expect(stored).toEqual({ head_name: 'N***** V** A**', address_text: '***, Quận 1', national_id_masked: `********${nationalId.slice(-4)}`, phone_masked: '*******678', sealed: true, has_plain: false });

    // The household is linked to a parcel of its unit.
    await row.getByRole('button', { name: vi['lnd.households.link.action'] }).click();
    await page.getByLabel(vi['lnd.households.linkDialog.parcel.label'], { exact: true }).selectOption({ label: project.parcelCode });
    await page.getByLabel(vi['lnd.households.linkDialog.right.label'], { exact: true }).selectOption('OWNER');
    await page.getByLabel(vi['lnd.households.linkDialog.share.label'], { exact: true }).fill('60');
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(row.getByTestId('parcels')).toContainText(project.parcelCode);
    await expect(row.getByTestId('parcels')).toContainText('60');

    // Opening the personal data is a reading that is asked for; the data is in the dialog and nowhere else, and the trail says that it was read, not what.
    await row.getByRole('button', { name: vi['lnd.households.reveal.action'] }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('reveal-note')).toHaveText(vi['lnd.households.revealDialog.note.text']);
    await expect(dialog.getByTestId('identity')).toHaveCount(0);
    // The reading is asked for with its reason; without one nothing is read.
    await dialog.getByRole('button', { name: vi['lnd.households.revealDialog.submit.action'] }).click();
    await expect(dialog.getByText(vi['lnd.field.required.error'])).toBeVisible();
    await dialog.getByLabel(vi['lnd.households.revealDialog.reason.label'], { exact: true }).fill(REASON);
    await dialog.getByRole('button', { name: vi['lnd.households.revealDialog.submit.action'] }).click();
    await expect(dialog.getByTestId('identity-head')).toHaveText(HEAD);
    await expect(dialog.getByTestId('identity-national-id')).toHaveText(nationalId);
    await expect(dialog.getByTestId('identity-phone')).toHaveText(PHONE);
    await expect(dialog.getByTestId('identity-address')).toHaveText(ADDRESS);
    await dialog.getByRole('button', { name: vi['lnd.dialog.cancel.action'] }).click();
    await expect(page.locator('body')).not.toContainText(HEAD);

    const trail = await sql<{ action: string; diff: string }>(
      `select action, safe_diff::text as diff from machvon.audit_event
        where resource_id in (select id from machvon.affected_household where project_id = $1) and action like 'lnd.household%' order by occurred_at`,
      [project.id],
    );
    expect(trail.map((entry) => entry.action)).toEqual(['lnd.household_registered', 'lnd.household_identity_revealed']);
    for (const entry of trail) for (const personal of [HEAD, nationalId, PHONE, ADDRESS]) expect(entry.diff).not.toContain(personal);
    expect(trail[1]?.diff).toContain(REASON);
    expect(await sql("select 1 from machvon.outbox_event where type like 'lnd.household.%' and payload::text like '%' || $1 || '%'", [nationalId])).toHaveLength(0);
  });

  test('the same identity number is not registered twice in a project, and the server says so (AC-ST-LND-002-2, UI-LND-03)', async ({ page }) => {
    const project = await seedProject();
    const nationalId = `079${String(Date.now()).slice(-9)}`;
    await open(page, 'householdOfficer', `/lnd/lnd-03?project=${project.id}`);
    for (const attempt of [1, 2]) {
      await page.getByRole('button', { name: vi['lnd.households.register.action'] }).click();
      await fillRegistration(page, { head: HEAD, nationalId, phone: PHONE, address: ADDRESS, basis: 'LEGAL_OBLIGATION', basisRef: BASIS_REF, until: '2036-12-31' });
      await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
      if (attempt === 1) await expect(page.locator('[data-household-id]')).toHaveCount(1);
    }
    await expect(page.getByTestId('refusal')).toHaveText(vi['lnd.households.problem.duplicate.error']);
    expect(await sql('select 1 from machvon.affected_household where project_id = $1', [project.id])).toHaveLength(1);
  });

  test('the data protection officer holds an erasure back while the household was paid, meets it in part with the reason, and anonymises a household that was not paid (AC-ST-LND-003-1, UAT-AC381, UI-LND-13)', async ({ page }) => {
    const project = await seedProject();
    const tenant = stackInfo().tenants.A;
    const unit = stackInfo().units.A[UNIT_CODE];
    const stamp = Date.now();
    const nationalIds = [`079${String(stamp).slice(-9)}`, `079${String(stamp + 1).slice(-9)}`];
    await open(page, 'householdOfficer', `/lnd/lnd-03?project=${project.id}`);
    for (const nationalId of nationalIds) {
      await page.getByRole('button', { name: vi['lnd.households.register.action'] }).click();
      await fillRegistration(page, { head: HEAD, nationalId, phone: PHONE, address: ADDRESS, basis: 'PUBLIC_TASK_LAND_LAW', basisRef: BASIS_REF, until: '2036-12-31' });
      await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
      await expect(page.locator('[data-household-id]')).toHaveCount(nationalIds.indexOf(nationalId) + 1);
    }
    const [paid, unpaid] = await sql<{ id: string }>('select id from machvon.affected_household where project_id = $1 order by household_code', [project.id]);
    // A payment was made to the first household: the voucher of it has to be kept. The plan it belongs to is another story, so the foreign keys are off for this one row.
    const [voucher] = await sql<{ id: string }>("select id from machvon.document_version where scan_status = 'CLEAN' limit 1");
    await sql(`begin; set local session_replication_role = replica;
      insert into machvon.compensation_payment (tenant_id, id, plan_id, household_id, owner_unit_id, payment_no, amount_vnd, due_on, paid_on, method, voucher_document_version_id, status, created_by, updated_by)
      values ('${tenant}', gen_random_uuid(), gen_random_uuid(), '${paid?.id}', '${unit}', 1, 1000000, date '2026-10-01', date '2026-10-10', 'BANK_TRANSFER', '${voucher?.id}', 'PAID', '${membershipOf('householdOfficer')}', '${membershipOf('householdOfficer')}');
      commit;`);

    await open(page, 'householdDpo', `/lnd/lnd-03?project=${project.id}`);
    await page.locator(`[data-household-id="${paid?.id}"]`).getByRole('link').click();
    await expect(page.getByRole('heading', { level: 1, name: vi['lnd.dataRequest.page.title'] })).toBeVisible();
    await expect(page.getByTestId('household-head')).toHaveText('N***** V** A**');
    const send = async (kind: string, outcome: string, reason: string): Promise<void> => {
      await page.getByLabel(vi['lnd.dataRequest.form.kind.label'], { exact: true }).selectOption(kind);
      await page.getByLabel(vi['lnd.dataRequest.form.verified.label'], { exact: true }).check();
      await page.getByLabel(vi['lnd.dataRequest.form.outcome.label'], { exact: true }).selectOption(outcome);
      await page.getByLabel(vi['lnd.dataRequest.form.reason.label'], { exact: true }).fill(reason);
      await page.getByRole('button', { name: vi['lnd.dataRequest.form.submit.action'] }).click();
    };
    await send('ERASE', 'FULFILLED', 'The person asked for the data to be erased');
    await expect(page.getByTestId('refusal')).toHaveText(vi['lnd.dataRequest.problem.retention.error']);
    await send('ERASE', 'PARTIAL', 'The voucher of the payment names the head of the household');
    await expect(page.getByTestId('handled')).toBeVisible();
    const [kept] = await sql<{ has_phone: boolean; has_name: boolean; erased: string[]; reason: string }>(
      'select h.phone_enc is not null as has_phone, h.head_name_enc is not null as has_name, r.erased_fields as erased, r.reason from machvon.affected_household h join machvon.household_data_request r on r.household_id = h.id where h.id = $1',
      [paid?.id],
    );
    expect(kept).toEqual({ has_phone: false, has_name: true, erased: ['phone', 'address_text'], reason: 'The voucher of the payment names the head of the household' });

    await page.goto(`/lnd/lnd-13?project=${project.id}&household=${unpaid?.id}&devUser=householdDpo`);
    await expect(page.getByTestId('household-code')).toBeVisible();
    await send('ERASE', 'FULFILLED', 'The person asked for the data to be erased and nothing was paid');
    await expect(page.getByTestId('household-anonymised')).toBeVisible();
    const [erased] = await sql<{ head_name: string; has_nid: boolean; anonymised: boolean }>('select head_name, national_id_enc is not null as has_nid, anonymised_at is not null as anonymised from machvon.affected_household where id = $1', [unpaid?.id]);
    expect(erased).toEqual({ head_name: '[erased]', has_nid: false, anonymised: true });
    const trail = await sql<{ diff: string }>("select safe_diff::text as diff from machvon.audit_event where action = 'lnd.household_data_request_handled' and resource_id = any($1::uuid[])", [[paid?.id, unpaid?.id]]);
    expect(trail).toHaveLength(2);
    for (const entry of trail) for (const personal of [HEAD, ADDRESS, PHONE, 'The person asked', 'The voucher']) expect(entry.diff).not.toContain(personal);
  });

  test('a reader sees the households with the identity number hidden whole and no button that changes or opens them (AC-ST-LND-002-1, UI-LND-03)', async ({ page }) => {
    const project = await seedProject();
    const nationalId = `079${String(Date.now()).slice(-9)}`;
    await open(page, 'householdOfficer', `/lnd/lnd-03?project=${project.id}`);
    await page.getByRole('button', { name: vi['lnd.households.register.action'] }).click();
    await fillRegistration(page, { head: HEAD, nationalId, phone: PHONE, address: ADDRESS, basis: 'PUBLIC_TASK_LAND_LAW', basisRef: BASIS_REF, until: '2036-12-31' });
    await page.getByRole('button', { name: vi['lnd.dialog.submit.action'] }).click();
    await expect(page.locator('[data-household-id]')).toHaveCount(1);

    await open(page, 'householdReader', `/lnd/lnd-03?project=${project.id}`);
    const row = page.locator('[data-household-id]').first();
    await expect(row).toBeVisible();
    await expect(row.getByTestId('national-id')).toHaveText('************');
    await expect(row.getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('button', { name: vi['lnd.households.register.action'] })).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(nationalId);
  });
});
