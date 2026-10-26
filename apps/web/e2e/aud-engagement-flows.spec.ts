import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql, stackInfo } from './support/stack.ts';

/**
 * AUD-02 and AUD-03 (the inspections and audits) in a real browser against the real API and database (apps/api/test/e2e-stack): the coordinator registers an engagement against a decision of DOC that is in force
 * with a project in its scope, starts it with a legal hold that covers the scope (the project cannot be disposed of while it holds), ends the fieldwork, and cancels another one with a reason, which releases the hold;
 * the trail and the events carry codes and ids and not the title; a reader sees the list and the file and has no button.
 */

const UNIT_CODE = 'CB-SKHDT-QLDA';
const TITLE = 'Thanh tra việc đầu tư xây dựng cầu qua sông';

const vietnamToday = (): string => new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);

interface Seeded {
  projectId: string;
  projectCode: string;
  decisionId: string;
}

/** A project of the unit and a decision of DOC that is in force (a reference document with its symbol and day). */
async function seed(): Promise<Seeded> {
  const tenant = stackInfo().tenants.A;
  const unit = stackInfo().units.A[UNIT_CODE];
  const officer = membershipOf('audOfficer');
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and code = 'E2E_AREA_1'", [tenant]);
  const projectId = randomUUID();
  const projectCode = `E2E-AUD-${Date.now().toString(36).toUpperCase()}-${projectId.slice(0, 4).toUpperCase()}`;
  await sql(
    `insert into machvon.project
       (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, project_group, version, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 150000000000, 'IMPLEMENTATION', 'B', 1, $7, $7)`,
    [tenant, projectId, projectCode, `Dự án cầu ${projectCode}`, unit, area?.id, officer],
  );
  const decisionId = randomUUID();
  await sql(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
     values ($1, $2, 'REFERENCE', 'QD', $3, $4, date '2026-01-15', 'EFFECTIVE', 'INTERNAL', $5, $5)`,
    [tenant, decisionId, `Quyết định thanh tra ${projectCode}`, `${projectCode}/QD-TTCP`, officer],
  );
  return { projectId, projectCode, decisionId };
}

async function open(page: Page, user: string, path = '/aud/aud-02'): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

/** Registers an engagement about the project through the dialog and returns its code once the file has opened. */
async function register(page: Page, aim: Seeded, code: string): Promise<void> {
  await page.getByRole('button', { name: vi['aud.engagements.register.action'] }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(vi['aud.engagementDialog.code.label'], { exact: true }).fill(code);
  await dialog.getByLabel(vi['aud.engagementDialog.type.label'], { exact: true }).selectOption('ADMINISTRATIVE_INSPECTION');
  await dialog.getByLabel(vi['aud.engagementDialog.authorityKind.label'], { exact: true }).selectOption('PROVINCIAL_INSPECTORATE');
  await dialog.getByLabel(vi['aud.engagementDialog.authorityName.label'], { exact: true }).fill('Thanh tra tỉnh Cao Bằng');
  await dialog.getByLabel(vi['aud.engagementDialog.decision.label'], { exact: true }).fill(aim.decisionId);
  await dialog.getByLabel(vi['aud.engagementDialog.title.label'], { exact: true }).fill(TITLE);
  await dialog.getByLabel(vi['aud.engagementDialog.periodFrom.label'], { exact: true }).fill('2025-01-01');
  await dialog.getByLabel(vi['aud.engagementDialog.periodTo.label'], { exact: true }).fill('2025-12-31');
  await dialog.getByLabel(vi['aud.engagementDialog.scope.label'], { exact: true }).selectOption({ label: `${aim.projectCode} · Dự án cầu ${aim.projectCode}` });
  await dialog.getByRole('button', { name: vi['aud.engagementDialog.scope.add'] }).click();
  await dialog.getByRole('button', { name: vi['aud.dialog.submit.action'] }).click();
  await expect(page.getByRole('heading', { level: 1, name: vi['aud.engagement.file.title'].replace('{code}', code) })).toBeVisible();
}

/** Whether an active hold names the project itself (a hold over the whole tenant, which the stack may hold, would block it whatever an engagement does) and the purge guard agrees. */
const held = async (projectId: string): Promise<boolean> => {
  const [row] = await sql<{ named: boolean; blocks: boolean }>(
    "select exists (select 1 from machvon.legal_hold h where h.status = 'Active' and h.resource_scope -> 'ids' ? ($1::uuid)::text) as named, machvon.legal_hold_blocks('project', $1::uuid) as blocks",
    [projectId],
  );
  return row?.named === true && row.blocks;
};

test.describe('AUD-02 and AUD-03: the inspections and audits', () => {
  test('the coordinator registers an engagement, starts it with a legal hold on its scope and ends the fieldwork (AC-ST-AUD-001-1, UAT-AC433, UI-AUD-02, UI-AUD-03)', async ({ page }) => {
    const aim = await seed();
    const today = vietnamToday();
    const code = `TTCP-${aim.projectCode}`;
    await open(page, 'audOfficer');
    await expect(page.getByRole('heading', { level: 1, name: vi['aud.engagements.page.title'] })).toBeVisible();
    await page.getByRole('button', { name: vi['aud.engagements.register.action'] }).click();
    await page.getByRole('dialog').getByRole('button', { name: vi['aud.dialog.submit.action'] }).click();
    await expect(page.getByRole('dialog').getByText(vi['aud.formProblem.required']).first()).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: vi['aud.dialog.cancel.action'] }).click();

    await register(page, aim, code);
    await expect(page.getByTestId('period-card')).toContainText(vi['aud.engagementStatus.planned']);
    await expect(page.getByTestId('decision-card')).toContainText(`${aim.projectCode}/QD-TTCP`);
    await expect(page.getByTestId('hold-card')).toContainText(vi['aud.engagement.hold.none']);
    await expect(page.getByRole('row').filter({ hasText: aim.projectCode })).toContainText(vi['aud.scopeKind.project']);
    expect(await held(aim.projectId)).toBe(false);

    await page.getByRole('button', { name: vi['aud.engagement.start.action'] }).click();
    await page.getByRole('dialog').getByRole('button', { name: vi['aud.dialog.submit.action'] }).click();
    await expect(page.getByTestId('period-card')).toContainText(vi['aud.engagementStatus.ongoing']);
    await expect(page.getByTestId('period-card')).toContainText(today);
    await expect(page.getByTestId('hold-card')).toContainText(vi['aud.holdStatus.active']);
    expect(await held(aim.projectId)).toBe(true);
    const [hold] = await sql<{ hold_kind: string; status: string }>(
      'select h.hold_kind, h.status from machvon.legal_hold h join machvon.audit_engagement e on e.legal_hold_id = h.id where e.engagement_code = $1',
      [code],
    );
    expect(hold).toEqual({ hold_kind: 'INSPECTION', status: 'Active' });

    await page.getByRole('button', { name: vi['aud.engagement.endFieldwork.action'] }).click();
    await page.getByRole('dialog').getByRole('button', { name: vi['aud.dialog.submit.action'] }).click();
    await expect(page.getByTestId('period-card')).toContainText(vi['aud.engagementStatus.awaitingConclusion']);
    await expect(page.getByRole('button', { name: vi['aud.engagement.start.action'] })).toHaveCount(0);
    await expect(page.getByRole('button', { name: vi['aud.engagement.endFieldwork.action'] })).toHaveCount(0);

    // The list shows it with its hold; a second registration with the same code is refused in the dialog.
    await page.getByRole('link', { name: vi['aud.engagement.back.link'] }).click();
    const row = page.locator('[data-engagement-id]').filter({ hasText: code });
    await expect(row).toContainText(vi['aud.engagementStatus.awaitingConclusion']);
    await expect(row).toContainText(vi['aud.holdStatus.active']);
    await page.getByRole('button', { name: vi['aud.engagements.register.action'] }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(vi['aud.engagementDialog.code.label'], { exact: true }).fill(code);
    await dialog.getByLabel(vi['aud.engagementDialog.type.label'], { exact: true }).selectOption('STATE_AUDIT');
    await dialog.getByLabel(vi['aud.engagementDialog.authorityKind.label'], { exact: true }).selectOption('STATE_AUDIT_OFFICE');
    await dialog.getByLabel(vi['aud.engagementDialog.authorityName.label'], { exact: true }).fill('Kiểm toán nhà nước');
    await dialog.getByLabel(vi['aud.engagementDialog.decision.label'], { exact: true }).fill(aim.decisionId);
    await dialog.getByLabel(vi['aud.engagementDialog.title.label'], { exact: true }).fill(TITLE);
    await dialog.getByLabel(vi['aud.engagementDialog.periodFrom.label'], { exact: true }).fill('2025-01-01');
    await dialog.getByLabel(vi['aud.engagementDialog.periodTo.label'], { exact: true }).fill('2025-12-31');
    await dialog.getByLabel(vi['aud.engagementDialog.scope.label'], { exact: true }).selectOption({ label: `${aim.projectCode} · Dự án cầu ${aim.projectCode}` });
    await dialog.getByRole('button', { name: vi['aud.engagementDialog.scope.add'] }).click();
    await dialog.getByRole('button', { name: vi['aud.dialog.submit.action'] }).click();
    await expect(dialog.getByTestId('refusal')).toHaveText(vi['aud.problem.codeDuplicate']);
    await dialog.getByRole('button', { name: vi['aud.dialog.cancel.action'] }).click();

    const [engagement] = await sql<{ id: string }>('select id from machvon.audit_engagement where engagement_code = $1', [code]);
    const trail = await sql<{ action: string; diff: string }>("select action, safe_diff::text as diff from machvon.audit_event where resource_id = $1 order by occurred_at, id", [engagement?.id]);
    expect(trail.map((entry) => entry.action)).toEqual(['aud.engagement_created', 'aud.engagement_started', 'aud.engagement_fieldwork_ended']);
    const events = await sql<{ type: string; payload: Record<string, unknown> }>('select type, payload from machvon.outbox_event where aggregate_id = $1 order by created_at, id', [engagement?.id]);
    expect(events.map((event) => event.type)).toEqual(['aud.engagement.created.v1', 'aud.engagement.started.v1', 'aud.engagement.fieldwork_ended.v1']);
    for (const text of [JSON.stringify(trail), JSON.stringify(events)]) {
      expect(text).not.toContain(TITLE);
      expect(text).not.toContain('Thanh tra tỉnh Cao Bằng');
    }
  });

  test('the coordinator cancels a started engagement with a reason, which releases its legal hold (AC-ST-AUD-001-3, UAT-AC443)', async ({ page }) => {
    const aim = await seed();
    const code = `TTCP-${aim.projectCode}`;
    await open(page, 'audOfficer');
    await register(page, aim, code);
    await page.getByRole('button', { name: vi['aud.engagement.start.action'] }).click();
    await page.getByRole('dialog').getByRole('button', { name: vi['aud.dialog.submit.action'] }).click();
    await expect(page.getByTestId('hold-card')).toContainText(vi['aud.holdStatus.active']);
    expect(await held(aim.projectId)).toBe(true);

    await page.getByRole('button', { name: vi['aud.engagement.cancel.action'] }).click();
    await page.getByRole('dialog').getByRole('button', { name: vi['aud.dialog.submit.action'] }).click();
    await expect(page.getByRole('dialog').getByText(vi['aud.formProblem.required'])).toBeVisible();
    await page.getByRole('dialog').getByLabel(vi['aud.engagementDialog.cancelReason.label'], { exact: true }).fill('Cơ quan tiến hành đã rút quyết định thanh tra.');
    await page.getByRole('dialog').getByRole('button', { name: vi['aud.dialog.submit.action'] }).click();
    await expect(page.getByTestId('period-card')).toContainText(vi['aud.engagementStatus.cancelled']);
    await expect(page.getByTestId('cancel-reason')).toHaveText('Cơ quan tiến hành đã rút quyết định thanh tra.');
    await expect(page.getByTestId('hold-card')).toContainText(vi['aud.holdStatus.released']);
    await expect(page.locator('.actions')).toHaveCount(0);
    expect(await held(aim.projectId)).toBe(false);
    const [hold] = await sql<{ status: string }>('select h.status from machvon.legal_hold h join machvon.audit_engagement e on e.legal_hold_id = h.id where e.engagement_code = $1', [code]);
    expect(hold?.status).toBe('Released');
  });

  test('a reader sees the list and the file and has no button that registers, starts, ends or cancels (UI-AUD-02, UI-AUD-03)', async ({ page }) => {
    const aim = await seed();
    const code = `TTCP-${aim.projectCode}`;
    await open(page, 'audOfficer');
    await register(page, aim, code);
    const [engagement] = await sql<{ id: string }>('select id from machvon.audit_engagement where engagement_code = $1', [code]);

    await open(page, 'audReader');
    const row = page.locator('[data-engagement-id]').filter({ hasText: code });
    await expect(row).toContainText(vi['aud.engagementStatus.planned']);
    await expect(page.getByRole('button', { name: vi['aud.engagements.register.action'] })).toHaveCount(0);
    await open(page, 'audReader', `/aud/aud-03?engagement=${engagement?.id}`);
    await expect(page.getByRole('heading', { level: 1, name: vi['aud.engagement.file.title'].replace('{code}', code) })).toBeVisible();
    await expect(page.getByTestId('decision-card')).toContainText(`${aim.projectCode}/QD-TTCP`);
    await expect(page.locator('.actions')).toHaveCount(0);

    // An engagement that does not exist is told as an empty file, in the same words as one outside the scope of the reader.
    await open(page, 'audReader', `/aud/aud-03?engagement=${randomUUID()}`);
    await expect(page.getByText(vi['states.empty.title'])).toBeVisible();
  });
});
