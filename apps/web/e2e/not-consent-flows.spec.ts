import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { apiCall } from './support/api.ts';
import { membershipOf, sql } from './support/stack.ts';

/**
 * NOT-17 (the consent history) in a real browser against the real API and database (apps/api/test/e2e-stack): the fixture users are picked with
 * `?devUser=`, every request is authorised by the policy guard, and what the screen changed is looked up in the database. A consent is given against
 * the current text, withdrawn only after a confirmation with a reason, and never rewritten: the history keeps both rows.
 */

const OWNER = membershipOf('owner');
const OTHER_PERSON = membershipOf('nobody');

async function openScreen(page: Page, user: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/not/not-17?devUser=${user}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

interface ConsentRow {
  id: string;
  channel: string;
  purpose: string;
  status: string;
  consent_text_version: string;
  capture_method: string;
  legal_basis: string;
  withdrawn_reason: string | null;
  revoked_at: string | null;
  version: string;
}

const consentsOf = (membershipId: string): Promise<ConsentRow[]> =>
  sql(
    `select id, channel, purpose, status, consent_text_version, capture_method, legal_basis, withdrawn_reason, revoked_at::text as revoked_at, version::text as version
       from machvon.contact_consent where membership_id = $1 order by effective_at, id`,
    [membershipId],
  );

const auditOf = (action: string, resourceId: string): Promise<Array<{ reason: string | null; outcome: string; safe_diff: Record<string, unknown>; classification: string }>> =>
  sql('select reason, outcome, safe_diff, classification from machvon.audit_event where action = $1 and resource_id = $2 order by seq', [action, resourceId]);

test.describe.configure({ mode: 'serial' });

test.describe('NOT-17 consent history', () => {
  test('a member gives a consent against the text, sees it in the history, and withdraws it after a confirmation with a reason; both rows stay', async ({ page }) => {
    await openScreen(page, 'owner');
    await expect(page.getByRole('heading', { level: 1, name: vi['not.consent.page.title'] })).toBeVisible();
    // The inbox is locked: listed as mandatory with no switch.
    await expect(page.getByTestId('locked-channels')).toContainText(vi['not.consent.locked.inApp.name']);
    await expect(page.getByTestId('locked-channels').getByRole('checkbox')).toHaveCount(0);
    await expect(page.getByText(vi['states.empty.title'])).toBeVisible();

    const form = page.getByTestId('grant-form');
    await form.getByLabel(vi['not.consent.grant.channel.label'], { exact: true }).selectOption('EMAIL');
    await form.getByLabel(vi['not.consent.grant.purpose.label'], { exact: true }).selectOption('ANNOUNCEMENT');
    // Without the agreement nothing is sent.
    await form.getByRole('button', { name: vi['not.consent.grant.confirm.action'] }).click();
    await expect(form.getByText(vi['not.consent.grant.agree.error'])).toBeVisible();
    expect(await consentsOf(OWNER)).toHaveLength(0);
    await form.getByRole('checkbox').check();
    await form.getByRole('button', { name: vi['not.consent.grant.confirm.action'] }).click();
    await expect(page.getByTestId('grant-done')).toBeVisible();
    await expect(page.locator('tr[data-consent-id]')).toHaveCount(1);

    const [granted] = await consentsOf(OWNER);
    expect(granted).toMatchObject({ channel: 'EMAIL', purpose: 'ANNOUNCEMENT', status: 'Granted', consent_text_version: 'consent-2026-1', capture_method: 'IN_APP', legal_basis: 'CONSENT', version: '1' });
    const consentId = granted?.id ?? '';
    const row = page.locator(`tr[data-consent-id="${consentId}"]`);
    await expect(row).toContainText(vi['not.consent.status.granted']);
    const audit = await auditOf('consent.granted', consentId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ outcome: 'SUCCESS', classification: 'PERSONAL', safe_diff: { channel: 'EMAIL', purpose: 'ANNOUNCEMENT' } });

    // A second consent for the same channel and purpose is not offered.
    await expect(form.getByTestId('grant-live')).toBeVisible();
    await expect(form.getByRole('button', { name: vi['not.consent.grant.confirm.action'] })).toBeDisabled();

    // Withdrawing needs the confirmation and a reason; dismissing keeps the consent.
    await row.getByRole('button', { name: vi['not.consent.withdraw.action'] }).click();
    const panel = page.getByTestId('withdraw-panel');
    await panel.getByRole('button', { name: vi['not.consent.withdraw.dismiss.action'] }).click();
    await expect(page.getByTestId('withdraw-panel')).toHaveCount(0);
    expect((await consentsOf(OWNER))[0]?.status).toBe('Granted');
    await row.getByRole('button', { name: vi['not.consent.withdraw.action'] }).click();
    await panel.getByRole('button', { name: vi['not.consent.withdraw.confirm.action'] }).click();
    await expect(panel.getByText(vi['not.consent.withdraw.reason.error'])).toBeVisible();
    expect((await consentsOf(OWNER))[0]?.status).toBe('Granted');
    await panel.getByLabel(vi['not.consent.withdraw.reason.label']).fill('Tôi không muốn nhận thông báo chung nữa');
    await panel.getByRole('button', { name: vi['not.consent.withdraw.confirm.action'] }).click();
    await expect(page.getByTestId('withdraw-panel')).toHaveCount(0);
    await expect(row).toContainText(vi['not.consent.status.withdrawn']);
    await expect(row.getByRole('button', { name: vi['not.consent.withdraw.action'] })).toHaveCount(0);

    const [ended] = await consentsOf(OWNER);
    expect(ended).toMatchObject({ id: consentId, status: 'Withdrawn', withdrawn_reason: 'Tôi không muốn nhận thông báo chung nữa', version: '2' });
    expect(ended?.revoked_at).not.toBeNull();
    const withdrawal = await auditOf('consent.withdrawn', consentId);
    expect(withdrawal).toHaveLength(1);
    expect(withdrawal[0]).toMatchObject({ outcome: 'SUCCESS', reason: 'Tôi không muốn nhận thông báo chung nữa' });
    const events = await sql<{ status: string }>("select payload ->> 'status' as status from machvon.outbox_event where type = 'not.consent.changed.v1' and aggregate_id = $1 order by aggregate_version", [consentId]);
    expect(events.map((event) => event.status)).toEqual(['Granted', 'Withdrawn']);

    // The member can give the same consent again: a new row, and the history keeps the old one.
    await form.getByRole('checkbox').check();
    await form.getByRole('button', { name: vi['not.consent.grant.confirm.action'] }).click();
    await expect(page.locator('tr[data-consent-id]')).toHaveCount(2);
    expect((await consentsOf(OWNER)).map((consent) => consent.status)).toEqual(['Withdrawn', 'Granted']);
  });

  test('a channel without a contact on the account is refused with its reason and records nothing', async ({ page }) => {
    await openScreen(page, 'owner');
    const form = page.getByTestId('grant-form');
    const before = (await consentsOf(OWNER)).length;
    await form.getByLabel(vi['not.consent.grant.channel.label'], { exact: true }).selectOption('SMS');
    await form.getByRole('checkbox').check();
    await form.getByRole('button', { name: vi['not.consent.grant.confirm.action'] }).click();
    await expect(page.getByTestId('grant-problem')).toHaveText(vi['not.consent.problem.identity']);
    expect(await consentsOf(OWNER)).toHaveLength(before);
  });

  test('someone without the permission is refused the screen and the server; no member can withdraw the consent of another person', async ({ page }) => {
    const planted = '00000000-0000-4000-8000-0000000000c1';
    await sql(
      `insert into machvon.contact_consent (tenant_id, id, membership_id, channel, purpose, status, evidence_reference, effective_at, consent_text_version, capture_method)
       select tenant_id, $1, $2, 'EMAIL', 'OPERATIONAL', 'Granted', 'e2e-fixture', now(), 'consent-2026-1', 'IN_APP' from machvon.membership where id = $2
       on conflict do nothing`,
      [planted, OTHER_PERSON],
    );
    // The notification reader holds a delivery permission only, not notification.self.
    await openScreen(page, 'notificationReader');
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
    await expect(page.locator('tr[data-consent-id]')).toHaveCount(0);
    const refused = await apiCall('notificationReader', 'POST', '/me/consents', { body: { channel: 'EMAIL', purpose: 'REMINDER', consent_text_version: 'consent-2026-1', capture_method: 'IN_APP' } });
    expect(refused.status).toBe(403);
    expect(await consentsOf(OTHER_PERSON)).toHaveLength(1);

    // The owner holds the permission but the consent is not theirs: a missing one, and nothing changes.
    const foreign = await apiCall('owner', 'POST', `/me/consents/${planted}/withdraw`, { body: { reason: 'Withdrawing the consent of someone else' }, version: 1 });
    expect(foreign.status).toBe(404);
    expect((await consentsOf(OTHER_PERSON))[0]).toMatchObject({ status: 'Granted', version: '1' });
  });
});

const prefRowOf = (page: Page, category: string) => page.locator(`tr[data-category="${category}"]`);

interface PreferenceRow {
  event_category: string;
  channel: string;
  enabled: boolean;
  digest_mode: string;
}
const preferencesOf = (membershipId: string): Promise<PreferenceRow[]> =>
  sql('select event_category, channel, enabled, digest_mode from machvon.notification_preference where membership_id = $1 order by event_category, channel', [membershipId]);
const profileOf = (membershipId: string): Promise<Array<{ version: string; quiet_start: string | null; quiet_end: string | null; time_zone: string }>> =>
  sql('select version::text as version, quiet_start::text as quiet_start, quiet_end::text as quiet_end, time_zone from machvon.notification_preference_profile where membership_id = $1', [membershipId]);

test.describe('NOT-03 notification preferences', () => {
  test.beforeAll(async () => {
    // The stack seeds no urgent workflow: plant one so that the inbox of the category "approval" is locked.
    await sql(
      `insert into machvon.workflow_version (tenant_id, id, business_type, revision, definition_json, status, kind, event_type, created_by, definition_hash)
       select tenant_id, '00000000-0000-4000-8000-0000000000c2', 'e2e.approval', 1, '{"priority":"CRITICAL"}'::jsonb, 'Published', 'NOTIFICATION', 'approval.requested', $1, repeat('c', 64)
         from machvon.membership where id = $1
       on conflict do nothing`,
      [OWNER],
    );
  });

  test.afterAll(async () => {
    await sql("delete from machvon.workflow_version where id = '00000000-0000-4000-8000-0000000000c2'");
  });

  test('a member sees the default hours, the locked inbox of an urgent category, saves a channel off with a digest and a time zone, and a stale save is refused', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/not/not-03?devUser=owner');
    await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
    await expect(page.getByRole('heading', { level: 1, name: vi['not.pref.page.title'] })).toBeVisible();
    await expect(page.getByText(vi['not.pref.default.message'])).toBeVisible();
    await expect(page.getByLabel(vi['not.pref.quiet.start.label'])).toHaveValue('21:00');
    await expect(page.getByLabel(vi['not.pref.quiet.end.label'])).toHaveValue('07:00');
    expect(await profileOf(OWNER)).toHaveLength(0);

    // The inbox of the category with an urgent workflow (and of every category) is locked and says why.
    const locked = prefRowOf(page, 'approval').getByRole('checkbox', { name: `approval - ${vi['not.pref.channel.inApp']}` });
    await expect(locked).toBeChecked();
    await expect(locked).toBeDisabled();
    await expect(locked).toHaveAttribute('title', vi['not.pref.locked.hint']);
    await expect(prefRowOf(page, '*').getByRole('checkbox', { name: `${vi['not.pref.category.all']} - ${vi['not.pref.channel.inApp']}` })).toBeDisabled();

    // A new category with SMS off and a daily digest, the quiet hours moved, and another time zone.
    await page.getByLabel(vi['not.pref.category.add.label']).fill('report');
    await page.getByRole('button', { name: vi['not.pref.category.add.action'] }).click();
    await prefRowOf(page, 'report').getByRole('checkbox', { name: `report - ${vi['not.pref.channel.sms']}` }).uncheck();
    await prefRowOf(page, 'report').getByRole('combobox').selectOption('DAILY');
    await page.getByLabel(vi['not.pref.quiet.start.label']).fill('22:00');
    await page.getByLabel(vi['not.pref.quiet.end.label']).fill('06:30');
    await page.getByLabel(vi['not.pref.zone.label']).selectOption('Asia/Tokyo');
    await page.getByRole('button', { name: vi['not.pref.save.action'] }).click();
    await expect(page.getByTestId('save-done')).toBeVisible();

    expect(await profileOf(OWNER)).toEqual([{ version: '1', quiet_start: '22:00:00', quiet_end: '06:30:00', time_zone: 'Asia/Tokyo' }]);
    const rows = await preferencesOf(OWNER);
    expect(rows).toContainEqual({ event_category: 'report', channel: 'SMS', enabled: false, digest_mode: 'DAILY' });
    // Only what differs from the default is stored: the cells of the new category (its digest) and the one switched off.
    expect(rows.every((row) => row.event_category === 'report')).toBe(true);
    const audit = await sql<{ outcome: string }>("select outcome from machvon.audit_event where action = 'notification.preferences_updated' and actor_id = $1", [OWNER]);
    expect(audit.map((row) => row.outcome)).toEqual(['SUCCESS']);

    // The page reloads what the server holds, under the new version.
    await page.reload();
    await expect(page.getByLabel(vi['not.pref.zone.label'])).toHaveValue('Asia/Tokyo');
    await expect(prefRowOf(page, 'report').getByRole('checkbox', { name: `report - ${vi['not.pref.channel.sms']}` })).not.toBeChecked();
    await expect(page.getByText(vi['not.pref.default.message'])).toHaveCount(0);

    // A save made under the old version (another tab) is refused and changes nothing.
    const stale = await apiCall('owner', 'PUT', '/me/notification-preferences', { body: { items: [], time_zone: 'UTC' }, version: 0 });
    expect(stale.status).toBe(409);
    expect((await profileOf(OWNER))[0]).toMatchObject({ version: '1', time_zone: 'Asia/Tokyo' });
  });

  test('the server refuses to switch off a locked inbox, and someone without the permission is refused the screen and the read', async ({ page }) => {
    const before = await profileOf(OWNER);
    const refused = await apiCall('owner', 'PUT', '/me/notification-preferences', {
      body: { items: [{ event_category: 'approval', channel: 'IN_APP', enabled: false, digest_mode: 'IMMEDIATE' }], time_zone: 'Asia/Tokyo' },
      version: Number(before[0]?.version ?? 0),
    });
    expect(refused.status).toBe(422);
    expect(refused.json.code).toBe('MANDATORY_CHANNEL_LOCKED');
    expect(await profileOf(OWNER)).toEqual(before);

    await page.goto('/not/not-03?devUser=notificationReader');
    await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
    await expect(page.getByTestId('preferences-form')).toHaveCount(0);
    expect((await apiCall('notificationReader', 'GET', '/me/notification-preferences')).status).toBe(403);
  });
});
