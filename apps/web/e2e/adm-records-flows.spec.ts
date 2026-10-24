import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { apiCall } from './support/api.ts';
import { membershipOf, sql } from './support/stack.ts';

/**
 * ADM-11 (audit log), ADM-12 (retention rules), ADM-09 (connectors) and ADM-10 (sync monitor) in a real browser against the real API and
 * database (apps/api/test/e2e-stack): the fixture users are picked with `?devUser=`, every request is authorised by the policy guard, and
 * what the screens changed is looked up in the database. The rows the screens show first are seeded by `governanceFixtures` of the stack.
 */

const id = (family: number, n: number): string => `00000000-0000-4000-${family.toString(16).padStart(4, '0')}-${n.toString(16).padStart(12, '0')}`;
const AUDIT = (n: number): string => id(0x7a, n);
const RETENTION = (n: number): string => id(0x7b, n);
const CONNECTOR = (n: number): string => id(0x7c, n);
const INBOX = (n: number): string => id(0x7d, n);
const unique = (): string => Date.now().toString(36);

type Screen = 'adm-09' | 'adm-10' | 'adm-11' | 'adm-12';

async function openScreen(page: Page, screen: Screen, user: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/adm/${screen}?devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

const auditRows = (action: string): Promise<Array<{ actor_id: string; resource_id: string; outcome: string }>> =>
  sql('select actor_id, resource_id, outcome from machvon.audit_event where action = $1 order by seq', [action]);

test.describe('ADM-11 audit log', () => {
  test('the owner reads every outcome, narrows the trail by outcome, actor and action, and asks for a sealed export whose period is checked first', async ({ page }) => {
    await openScreen(page, 'adm-11', 'owner');
    await expect(page.getByRole('heading', { level: 1, name: vi['adm.audit.page.title'] })).toBeVisible();
    for (const n of [1, 2, 3]) await expect(page.locator(`tr[data-event-id="${AUDIT(n)}"]`)).toBeVisible();
    await expect(page.locator(`tr[data-event-id="${AUDIT(2)}"]`)).toHaveAttribute('data-outcome', 'DENIED');
    // The redacted diff of a row is shown on request only.
    await page.locator(`tr[data-event-id="${AUDIT(1)}"]`).getByText(vi['adm.audit.diff.show.action']).click();
    await expect(page.locator(`tr[data-event-id="${AUDIT(1)}"] pre.diff`)).toContainText('"field": "value"');

    const filters = page.getByRole('form', { name: vi['adm.audit.filter.title'] });
    await filters.getByLabel(vi['adm.audit.filter.outcome.label']).selectOption('DENIED');
    await filters.getByRole('button', { name: vi['adm.audit.filter.apply.action'], exact: true }).click();
    await expect(page.locator(`tr[data-event-id="${AUDIT(2)}"]`)).toBeVisible();
    await expect(page.locator(`tr[data-event-id="${AUDIT(1)}"]`)).toHaveCount(0);
    await expect(page.locator('tr[data-event-id]:not([data-outcome="DENIED"])')).toHaveCount(0);

    await filters.getByRole('button', { name: vi['adm.audit.filter.clear.action'] }).click();
    await filters.getByLabel(vi['adm.audit.filter.actor.label']).fill(membershipOf('nobody'));
    await filters.getByRole('button', { name: vi['adm.audit.filter.apply.action'], exact: true }).click();
    await expect(page.locator(`tr[data-event-id="${AUDIT(1)}"]`)).toBeVisible();
    await expect(page.locator(`tr[data-event-id="${AUDIT(2)}"]`)).toBeVisible();
    await expect(page.locator(`tr[data-event-id="${AUDIT(3)}"]`)).toHaveCount(0);

    await filters.getByRole('button', { name: vi['adm.audit.filter.clear.action'] }).click();
    await filters.getByLabel(vi['adm.audit.filter.action.label']).fill('e2e.seed.crashed');
    await filters.getByRole('button', { name: vi['adm.audit.filter.apply.action'], exact: true }).click();
    await expect(page.locator('tr[data-event-id]')).toHaveCount(1);
    await expect(page.locator(`tr[data-event-id="${AUDIT(3)}"]`)).toHaveAttribute('data-outcome', 'FAILED');
    await filters.getByLabel(vi['adm.audit.filter.action.label']).fill('e2e.seed.nothing-like-this');
    await filters.getByRole('button', { name: vi['adm.audit.filter.apply.action'], exact: true }).click();
    await expect(page.getByText(vi['adm.audit.filtered.empty'])).toBeVisible();
    await filters.getByRole('button', { name: vi['adm.audit.filter.clear.action'] }).click();

    await page.getByRole('button', { name: vi['adm.audit.export.open.action'] }).click();
    const panel = page.getByTestId('export-panel');
    await panel.getByLabel(vi['adm.audit.export.from.label']).fill('2025-01-01T00:00');
    await panel.getByLabel(vi['adm.audit.export.to.label']).fill('2026-06-01T00:00');
    await panel.getByRole('button', { name: vi['adm.audit.export.submit.action'] }).click();
    await expect(panel.getByText(vi['adm.audit.export.range.error'])).toBeVisible();
    expect(await auditRows('audit.exported')).toHaveLength(0);
    await panel.getByLabel(vi['adm.audit.export.from.label']).fill('2026-03-01T00:00');
    await panel.getByLabel(vi['adm.audit.export.to.label']).fill('2026-03-03T00:00');
    await panel.getByRole('button', { name: vi['adm.audit.export.submit.action'] }).click();
    await expect(page.getByTestId('export-done')).toBeVisible();
    const exported = await auditRows('audit.exported');
    expect(exported).toHaveLength(1);
    expect(exported[0]?.actor_id).toBe(membershipOf('owner'));
  });

  test('a reader sees the trail without the export, and the server refuses the export to them as well', async ({ page }) => {
    await openScreen(page, 'adm-11', 'admReader');
    await expect(page.locator(`tr[data-event-id="${AUDIT(1)}"]`)).toBeVisible();
    await expect(page.getByRole('button', { name: vi['adm.audit.export.open.action'] })).toHaveCount(0);
    const refused = await apiCall('admReader', 'POST', '/audit-exports', { body: { from: '2026-03-01T00:00:00Z', to: '2026-03-03T00:00:00Z', format: 'JSONL' } });
    expect(refused.status).toBe(403);
  });

  test('someone without audit_event.read is refused the screen', async ({ page }) => {
    await openScreen(page, 'adm-11', 'auditor');
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
    await expect(page.locator('tr[data-event-id]')).toHaveCount(0);
  });
});

interface PolicyRow {
  id: string;
  status: string;
  record_class: string;
  created_by: string;
  approved_by: string | null;
  published_at: string | null;
}
const policyRows = (recordClass: string): Promise<PolicyRow[]> =>
  sql('select id, status, record_class, created_by, approved_by, published_at from machvon.data_retention_policy where record_class = $1 order by revision', [recordClass]);

test.describe('ADM-12 retention rules', () => {
  test('the owner sees the rules, the review list and the active hold, drafts a rule that another person must publish, and publishes the seeded draft of someone else', async ({ page }) => {
    await openScreen(page, 'adm-12', 'owner');
    await expect(page.getByRole('heading', { level: 1, name: vi['adm.retention.page.title'] })).toBeVisible();
    await expect(page.getByTestId('placeholder-note')).toBeVisible();
    await expect(page.locator(`tr[data-policy-id="${RETENTION(1)}"]`)).toHaveAttribute('data-status', 'Published');
    await expect(page.locator(`tr[data-policy-id="${RETENTION(2)}"]`)).toHaveAttribute('data-status', 'Draft');
    await expect(page.locator(`tr[data-review-id="${RETENTION(3)}"]`)).toContainText('payment_dossier');
    await expect(page.getByTestId('holds')).toContainText('Thanh tra chuyên đề e2e');

    // A rule of a business class is reviewed or transferred, never purged; the form follows the class.
    await page.locator('#draft-class').selectOption('project_dossier');
    await page.locator('#draft-years').fill('10');
    await page.locator('#draft-legal').fill(`TT 10/2022/TT-BNV CXN-RET-03 ${unique()}`);
    await page.locator('#draft-effective').fill('2030-01-01');
    await page.getByRole('button', { name: vi['adm.retention.draft.submit.action'] }).click();
    await expect(page.getByTestId('draft-saved')).toBeVisible();
    const [draft] = await policyRows('project_dossier');
    expect(draft).toMatchObject({ status: 'Draft', created_by: membershipOf('owner'), approved_by: null, published_at: null });
    const own = page.locator(`tr[data-policy-id="${draft?.id}"]`);
    await expect(own.getByTestId('own-draft')).toBeVisible();
    await expect(own.getByRole('button', { name: vi['adm.retention.publish.action'] })).toHaveCount(0);
    // The screen hides the button, and the server refuses the author as well.
    const self = await apiCall('owner', 'POST', `/retention-policies/${draft?.id}/publish`, { body: { reason: 'The author publishes their own draft' }, version: 1 });
    expect(self.status).toBe(403);
    expect((await policyRows('project_dossier'))[0]?.status).toBe('Draft');

    const seeded = page.locator(`tr[data-policy-id="${RETENTION(2)}"]`);
    await seeded.getByRole('button', { name: vi['adm.retention.publish.action'] }).click();
    await page.getByRole('button', { name: vi['adm.retention.publish.confirm.action'] }).click();
    await expect(page.getByText(vi['adm.retention.publish.reason.error'])).toBeVisible();
    await page.locator('#publish-reason').fill('The rule is confirmed by the archives council');
    await page.getByRole('button', { name: vi['adm.retention.publish.confirm.action'] }).click();
    await expect(seeded).toHaveAttribute('data-status', 'Published');
    const [published] = await policyRows('contract_dossier');
    expect(published).toMatchObject({ status: 'Published', approved_by: membershipOf('owner') });
    expect(published?.published_at).not.toBeNull();
    const events = await auditRows('retention.published');
    expect(events.map((event) => event.resource_id)).toContain(RETENTION(2));
  });

  test('a reader sees the rules without the form or any publication', async ({ page }) => {
    await openScreen(page, 'adm-12', 'admReader');
    await expect(page.locator(`tr[data-policy-id="${RETENTION(1)}"]`)).toBeVisible();
    await expect(page.getByRole('heading', { name: vi['adm.retention.draft.title'] })).toHaveCount(0);
    await expect(page.getByRole('button', { name: vi['adm.retention.publish.action'] })).toHaveCount(0);
    await expect(page.getByTestId('holds')).toContainText('Thanh tra chuyên đề e2e');
  });

  test('someone without adm.retention.read is refused the screen', async ({ page }) => {
    await openScreen(page, 'adm-12', 'auditor');
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
    await expect(page.locator('tr[data-policy-id]')).toHaveCount(0);
  });
});

const connectorRows = (code: string): Promise<Array<{ id: string; status: string; adapter_status: string; config_json: Record<string, unknown>; credential_secret_ref: string | null }>> =>
  sql('select id, status, adapter_status, config_json, credential_secret_ref from machvon.integration_connector where connector_code = $1', [code]);

test.describe('ADM-09 integration connectors', () => {
  test('the owner declares a connector as a draft, cannot put a mock or an unverified adapter to work, and activates a verified one', async ({ page }) => {
    const code = `e2e-form-${unique()}`;
    await openScreen(page, 'adm-09', 'owner');
    await expect(page.getByRole('heading', { level: 1, name: vi['adm.connectors.page.title'] })).toBeVisible();
    await expect(page.getByTestId('honesty-note')).toBeVisible();
    await expect(page.locator(`tr[data-connector-id="${CONNECTOR(1)}"]`)).toHaveAttribute('data-adapter', 'VERIFIED');
    await expect(page.locator(`tr[data-connector-id="${CONNECTOR(2)}"]`)).toHaveAttribute('data-adapter', 'MOCK');
    await expect(page.locator(`tr[data-connector-id="${CONNECTOR(3)}"]`)).toHaveAttribute('data-adapter', 'PROPOSED');
    // A proposed adapter is not offered for activation at all.
    await expect(page.locator(`tr[data-connector-id="${CONNECTOR(3)}"]`).getByTestId('not-activatable')).toBeVisible();
    await expect(page.locator(`tr[data-connector-id="${CONNECTOR(3)}"]`).getByRole('button', { name: vi['adm.connectors.activate.action'] })).toHaveCount(0);

    // The configuration holds no secret: a key that looks like one is refused before anything is sent.
    await page.locator('#connector-code').fill(code);
    await page.locator('#connector-config').fill('{"password":"hunter2"}');
    await page.getByRole('button', { name: vi['adm.connectors.form.submit.action'] }).click();
    await expect(page.locator('#connector-config')).toHaveAttribute('aria-invalid', 'true');
    expect(await connectorRows(code)).toHaveLength(0);
    await page.locator('#connector-config').fill('{"directory":"/e2e/form"}');
    await page.locator('#connector-credential').fill('secret://e2e/connectors/form');
    await page.locator('#connector-mapping').fill('v1');
    await page.getByRole('button', { name: vi['adm.connectors.form.submit.action'] }).click();
    await expect(page.getByTestId('form-saved')).toBeVisible();
    const [made] = await connectorRows(code);
    expect(made).toMatchObject({ status: 'Draft', adapter_status: 'PROPOSED', config_json: { directory: '/e2e/form' }, credential_secret_ref: 'secret://e2e/connectors/form' });
    await expect(page.locator(`tr[data-connector-id="${made?.id}"]`)).toHaveAttribute('data-status', 'Draft');

    // A mock adapter is never Active in production: the server says so and the connector stays a draft.
    const mock = page.locator(`tr[data-connector-id="${CONNECTOR(2)}"]`);
    await mock.getByRole('button', { name: vi['adm.connectors.activate.action'] }).click();
    await page.locator('#move-reason').fill('The gateway is needed for the pilot');
    await page.getByRole('button', { name: vi['adm.connectors.move.confirm.action'] }).click();
    await expect(page.getByTestId('move-problem')).toContainText(vi['adm.connectors.problem.mockInProduction']);
    expect((await connectorRows('e2e-mock-gateway'))[0]?.status).toBe('Draft');
    await page.getByRole('button', { name: vi['adm.connectors.move.cancel.action'] }).click();

    const verified = page.locator(`tr[data-connector-id="${CONNECTOR(1)}"]`);
    await verified.getByRole('button', { name: vi['adm.connectors.activate.action'] }).click();
    await page.getByRole('button', { name: vi['adm.connectors.move.confirm.action'] }).click();
    await expect(page.getByText(vi['adm.connectors.move.reason.error'])).toBeVisible();
    await page.locator('#move-reason').fill('The treasury file is verified against the provider');
    await page.getByRole('button', { name: vi['adm.connectors.move.confirm.action'] }).click();
    await expect(verified).toHaveAttribute('data-status', 'Active');
    expect((await connectorRows('e2e-verified-file'))[0]?.status).toBe('Active');
    const updated = await auditRows('integration.connector_updated');
    expect(updated.map((event) => event.resource_id)).toContain(CONNECTOR(1));
  });

  test('a reader sees the connectors without the form or any change of state', async ({ page }) => {
    await openScreen(page, 'adm-09', 'admReader');
    await expect(page.locator(`tr[data-connector-id="${CONNECTOR(3)}"]`)).toBeVisible();
    await expect(page.getByRole('complementary', { name: vi['adm.connectors.form.title'] })).toHaveCount(0);
    await expect(page.getByRole('button', { name: vi['adm.connectors.activate.action'] })).toHaveCount(0);
    await expect(page.getByRole('button', { name: vi['adm.connectors.disable.action'] })).toHaveCount(0);
  });

  test('someone without adm.integration.read is refused the screen', async ({ page }) => {
    await openScreen(page, 'adm-09', 'auditor');
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
    await expect(page.locator('tr[data-connector-id]')).toHaveCount(0);
  });
});

test.describe('ADM-10 sync monitor', () => {
  test('the owner sees where the connector has read to and the inbound events without their payload, and takes a failed event up again with a reason', async ({ page }) => {
    await openScreen(page, 'adm-10', 'owner');
    await expect(page.getByRole('heading', { level: 1, name: vi['adm.sync.page.title'] })).toBeVisible();
    await expect(page.getByTestId('cursors').locator(`tr[data-cursor-id="${id(0x7e, 1)}"]`)).toHaveAttribute('data-adapter', 'PROPOSED');
    await expect(page.locator(`tr[data-event-id="${INBOX(1)}"]`)).toHaveAttribute('data-status', 'FAILED');
    await expect(page.locator(`tr[data-event-id="${INBOX(2)}"]`)).toHaveAttribute('data-status', 'DEAD');
    await expect(page.getByTestId('dead-note')).toBeVisible();
    // The payload and the place it is kept never reach the browser.
    expect(await page.locator('body').innerText()).not.toContain('E2E-SECRET-PAYLOAD');
    expect(await page.content()).not.toContain('E2E-SECRET-PAYLOAD');
    // An event whose payload has been purged cannot be replayed: the screen says so instead of offering the button.
    await expect(page.locator(`tr[data-event-id="${INBOX(2)}"]`).getByTestId('payload-gone')).toBeVisible();
    await expect(page.locator(`tr[data-event-id="${INBOX(2)}"]`).getByRole('button', { name: vi['adm.sync.replay.action'] })).toHaveCount(0);

    await page.getByLabel(vi['adm.sync.filter.status.label']).selectOption('DEAD');
    await expect(page.locator(`tr[data-event-id="${INBOX(2)}"]`)).toBeVisible();
    await expect(page.locator(`tr[data-event-id="${INBOX(1)}"]`)).toHaveCount(0);
    await page.getByLabel(vi['adm.sync.filter.status.label']).selectOption('');

    const failed = page.locator(`tr[data-event-id="${INBOX(1)}"]`);
    await failed.getByRole('button', { name: vi['adm.sync.replay.action'] }).click();
    await page.getByRole('button', { name: vi['adm.sync.replay.confirm.action'] }).click();
    await expect(page.getByText(vi['adm.sync.replay.reason.error'])).toBeVisible();
    await page.locator('#replay-reason').fill('The provider has fixed its endpoint');
    await page.getByRole('button', { name: vi['adm.sync.replay.confirm.action'] }).click();
    await expect(failed).toContainText(vi['adm.sync.events.replayed.text'].replace('{count}', '1'));
    const [row] = await sql<{ replay_count: number; last_replayed_by: string }>('select replay_count, last_replayed_by from machvon.integration_event_inbox where id = $1', [INBOX(1)]);
    expect(row).toMatchObject({ replay_count: 1, last_replayed_by: membershipOf('owner') });
    const replayed = await auditRows('integration.inbox_replayed');
    expect(replayed.map((event) => event.resource_id)).toContain(INBOX(1));
    expect(await page.locator('body').innerText()).not.toContain('E2E-SECRET-PAYLOAD');
  });

  test('a reader sees the events without any replay', async ({ page }) => {
    await openScreen(page, 'adm-10', 'admReader');
    await expect(page.locator(`tr[data-event-id="${INBOX(3)}"]`)).toHaveAttribute('data-status', 'PROCESSED');
    await expect(page.getByRole('button', { name: vi['adm.sync.replay.action'] })).toHaveCount(0);
  });

  test('someone without adm.integration.read is refused the screen', async ({ page }) => {
    await openScreen(page, 'adm-10', 'auditor');
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
    await expect(page.locator('tr[data-event-id]')).toHaveCount(0);
  });
});
