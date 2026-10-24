import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { apiCall } from './support/api.ts';
import { sql } from './support/stack.ts';

/**
 * NOT-11 (send queue), NOT-12 (journey of a send) and NOT-13 (failed queue and replay) in a real browser against the real API and database
 * (apps/api/test/e2e-stack): the fixture users are picked with `?devUser=`, every request is authorised by the policy guard, and what the screens changed is
 * looked up in the database. The notifications the screens show first are seeded by `deliveryFixtures` of the stack; the stack does not run the delivery job,
 * so a send the owner queues stays queued for the check.
 */

const id = (family: number, n: number): string => `00000000-0000-4000-${family.toString(16).padStart(4, '0')}-${n.toString(16).padStart(12, '0')}`;
const NOTIFICATION = (n: number): string => id(0xe6, n);
// The attempts are numbered in the order the stack plants them: five failed e-mails of notification 1, the SMS of 2 and 3, the queued e-mail of 4, three of 5.
const ATTEMPT = { failedFifth: id(0xe7, 5), lostRecent: id(0xe7, 6), lostOld: id(0xe7, 7), queued: id(0xe7, 8), journeyDelivered: id(0xe7, 11) };

type Screen = 'not-11' | 'not-12' | 'not-13';

async function openScreen(page: Page, screen: Screen, user: string, query = ''): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/not/${screen}?devUser=${user}${query}`);
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]');
}

const row = (page: Page, attemptId: string) => page.locator(`tr[data-attempt-id="${attemptId}"]`);

interface AttemptRow {
  attempt_no: number;
  channel: string;
  status: string;
}
const attemptsOf = (notificationId: string): Promise<AttemptRow[]> =>
  sql('select attempt_no, channel, status from machvon.delivery_attempt where notification_id = $1 order by created_at, attempt_no', [notificationId]);

const versionOf = async (notificationId: string): Promise<number> =>
  Number((await sql<{ version: string }>('select version::text as version from machvon.notification_instance where id = $1', [notificationId]))[0]?.version);

const auditOf = (action: string, resourceId: string): Promise<Array<{ reason: string | null; outcome: string; safe_diff: Record<string, unknown> }>> =>
  sql('select reason, outcome, safe_diff from machvon.audit_event where action = $1 and resource_id = $2 order by seq', [action, resourceId]);

test.describe('NOT-13 failed queue and replay', () => {
  test('the operator reads the failed queue, sees what must be reconciled first, and replays a notification that used its five sends (a new notification) and one whose result was never learnt (with a warning)', async ({ page }) => {
    await openScreen(page, 'not-13', 'owner');
    await expect(page.getByRole('heading', { level: 1, name: vi['not.failed.page.title'] })).toBeVisible();
    await expect(row(page, ATTEMPT.failedFifth)).toBeVisible();
    await expect(row(page, ATTEMPT.failedFifth)).toContainText('HTTP_503');
    await expect(row(page, ATTEMPT.failedFifth)).toContainText('5/5');
    // The send whose result was lost an hour ago must be reconciled first: it is marked and offers no replay.
    await expect(row(page, ATTEMPT.lostRecent).getByTestId('needs-reconcile')).toBeVisible();
    await expect(row(page, ATTEMPT.lostRecent).getByRole('button', { name: vi['not.failed.replay.action'] })).toHaveCount(0);
    // A notification delivered in the application never appears in the failed queue.
    await expect(page.locator(`tr[data-attempt-id="${id(0xe7, 9)}"]`)).toHaveCount(0);

    // Five sends were used: the replay starts a new notification that points back at the original.
    await row(page, ATTEMPT.failedFifth).getByRole('button', { name: vi['not.failed.replay.action'] }).click();
    const panel = page.getByTestId('replay-panel');
    await expect(panel.getByTestId('replay-panel-risk')).toHaveCount(0);
    await panel.getByRole('button', { name: vi['not.failed.replay.confirm.action'] }).click();
    await expect(panel.getByText(vi['not.failed.replay.reason.error'])).toBeVisible();
    expect(await auditOf('notification.replayed', NOTIFICATION(1))).toHaveLength(0);
    await panel.getByLabel(vi['not.failed.replay.reason.label']).fill('The mail relay is back, replay the five failed sends');
    await panel.getByRole('button', { name: vi['not.failed.replay.confirm.action'] }).click();
    await expect(page.getByTestId('replay-panel')).toHaveCount(0);
    await expect(row(page, ATTEMPT.failedFifth)).toHaveCount(0);

    const copies = await sql<{ id: string; status: string; replay_seq: number }>('select id, status, replay_seq from machvon.notification_instance where replay_of = $1', [NOTIFICATION(1)]);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ status: 'Queued', replay_seq: 1 });
    expect(await attemptsOf(copies[0]?.id ?? '')).toEqual([{ attempt_no: 1, channel: 'EMAIL', status: 'Queued' }]);
    expect(await attemptsOf(NOTIFICATION(1))).toHaveLength(5);
    const audit = await auditOf('notification.replayed', NOTIFICATION(1));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ outcome: 'SUCCESS', reason: 'The mail relay is back, replay the five failed sends', safe_diff: { started_new_chain: true, channel: 'EMAIL' } });

    // The SMS whose result was lost two days ago may be replayed: the screen warns that the message can go out twice, and the numbering of the channel continues.
    await row(page, ATTEMPT.lostOld).getByRole('button', { name: vi['not.failed.replay.action'] }).click();
    await expect(page.getByTestId('replay-panel-risk')).toHaveText(vi['not.failed.replay.risk']);
    await page.getByTestId('replay-panel').getByLabel(vi['not.failed.replay.reason.label']).fill('The provider confirmed it never sent the message');
    await page.getByTestId('replay-panel').getByRole('button', { name: vi['not.failed.replay.confirm.action'] }).click();
    await expect(page.getByTestId('replay-panel')).toHaveCount(0);
    expect(await attemptsOf(NOTIFICATION(3))).toEqual([
      { attempt_no: 1, channel: 'SMS', status: 'Unknown' },
      { attempt_no: 2, channel: 'SMS', status: 'Queued' },
    ]);
    expect(await sql('select status from machvon.notification_instance where id = $1', [NOTIFICATION(3)])).toEqual([{ status: 'Queued' }]);
  });

  test('a reader sees the queue without the replay, and the server refuses the replay to them as well; the one reconciling is refused by the server too', async ({ page }) => {
    await openScreen(page, 'not-13', 'notificationReader');
    await expect(row(page, ATTEMPT.lostRecent)).toBeVisible();
    await expect(page.getByRole('button', { name: vi['not.failed.replay.action'] })).toHaveCount(0);
    const version = await versionOf(NOTIFICATION(2));
    const body = { decision: 'approve', reason: 'A reader must not replay anything', evidence_ids: [] };
    const refused = await apiCall('notificationReader', 'POST', `/notifications/${NOTIFICATION(2)}/replay`, { body, version });
    expect(refused.status).toBe(403);
    // The owner holds the permission, but the result of that send is still being reconciled: 409, and nothing was sent.
    const early = await apiCall('owner', 'POST', `/notifications/${NOTIFICATION(2)}/replay`, { body: { ...body, reason: 'Replay before the reconciliation is over' }, version });
    expect(early.status).toBe(409);
    expect(early.json.code).toBe('RECONCILE_REQUIRED');
    expect(await attemptsOf(NOTIFICATION(2))).toEqual([{ attempt_no: 1, channel: 'SMS', status: 'Unknown' }]);
  });

  test('someone without delivery_attempt.read is refused the screen', async ({ page }) => {
    await openScreen(page, 'not-13', 'nobody');
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
    await expect(page.locator('tr[data-attempt-id]')).toHaveCount(0);
  });
});

test.describe('NOT-11 send queue', () => {
  test('the operator filters the queue by status and cancels a send that has not gone out, with a reason that is audited', async ({ page }) => {
    await openScreen(page, 'not-11', 'owner');
    await expect(page.getByRole('heading', { level: 1, name: vi['not.queue.page.title'] })).toBeVisible();
    await expect(row(page, ATTEMPT.queued)).toBeVisible();
    await expect(row(page, ATTEMPT.queued)).toHaveAttribute('data-status', 'Queued');
    await expect(row(page, ATTEMPT.queued)).toContainText('1/5');

    await page.getByLabel(vi['not.queue.filter.status.label']).selectOption('Queued');
    await expect(row(page, ATTEMPT.queued)).toBeVisible();
    await expect(page.locator('tr[data-attempt-id]:not([data-status="Queued"])')).toHaveCount(0);
    // Only a send that is waiting can be cancelled.
    await page.getByLabel(vi['not.queue.filter.status.label']).selectOption('Failed');
    await expect(row(page, ATTEMPT.failedFifth)).toBeVisible();
    await expect(page.getByRole('button', { name: vi['not.queue.cancel.action'] })).toHaveCount(0);
    await page.getByLabel(vi['not.queue.filter.status.label']).selectOption('Queued');

    await row(page, ATTEMPT.queued).getByRole('button', { name: vi['not.queue.cancel.action'] }).click();
    const panel = page.getByTestId('cancel-panel');
    await panel.getByRole('button', { name: vi['not.queue.cancel.confirm.action'] }).click();
    await expect(panel.getByText(vi['not.queue.cancel.reason.error'])).toBeVisible();
    expect(await attemptsOf(NOTIFICATION(4))).toEqual([{ attempt_no: 1, channel: 'EMAIL', status: 'Queued' }]);
    await panel.getByLabel(vi['not.queue.cancel.reason.label']).fill('The report was withdrawn before it was sent');
    await panel.getByRole('button', { name: vi['not.queue.cancel.confirm.action'] }).click();
    await expect(page.getByTestId('cancel-panel')).toHaveCount(0);

    expect(await attemptsOf(NOTIFICATION(4))).toEqual([{ attempt_no: 1, channel: 'EMAIL', status: 'Cancelled' }]);
    expect(await sql('select status from machvon.notification_instance where id = $1', [NOTIFICATION(4)])).toEqual([{ status: 'Cancelled' }]);
    const audit = await auditOf('notification.cancelled', NOTIFICATION(4));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ outcome: 'SUCCESS', reason: 'The report was withdrawn before it was sent' });
  });

  test('a reader sees the queue and the server refuses the cancel to them; someone without the permission is refused the screen', async ({ page }) => {
    await openScreen(page, 'not-11', 'notificationReader');
    await expect(row(page, ATTEMPT.failedFifth)).toBeVisible();
    await expect(page.getByRole('button', { name: vi['not.queue.cancel.action'] })).toHaveCount(0);
    const refused = await apiCall('notificationReader', 'POST', `/notifications/${NOTIFICATION(1)}/cancel`, { body: { reason: 'A reader must not cancel anything' }, version: await versionOf(NOTIFICATION(1)) });
    expect(refused.status).toBe(403);
    await openScreen(page, 'not-11', 'nobody');
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
  });
});

test.describe('NOT-12 journey of a send', () => {
  test('opened from the queue it shows the five retry milestones of the channel, the moments of the message and every attempt of the notification', async ({ page }) => {
    await openScreen(page, 'not-11', 'owner');
    await row(page, ATTEMPT.journeyDelivered).getByRole('link').click();
    await page.waitForSelector('[data-screen-id="NOT-12"]');
    await expect(page).toHaveURL(new RegExp(`id=${ATTEMPT.journeyDelivered}`));
    await expect(page.getByRole('heading', { level: 1, name: vi['not.journey.page.title'] })).toBeVisible();
    const milestones = page.getByTestId('journey-milestones').getByRole('listitem');
    await expect(milestones).toHaveCount(5);
    await expect(milestones.nth(0)).toHaveAttribute('data-state', 'failed');
    await expect(milestones.nth(1)).toHaveAttribute('data-state', 'failed');
    await expect(milestones.nth(2)).toHaveAttribute('data-state', 'delivered');
    await expect(milestones.nth(3)).toHaveAttribute('data-state', 'unreached');
    await expect(milestones.nth(4)).toHaveAttribute('data-state', 'unreached');
    await expect(milestones.nth(1)).toContainText('30');
    await expect(page.getByTestId('journey-summary')).toContainText('e2e-message-1');
    await expect(page.getByTestId('journey-attempts').locator('tr[data-attempt-id]')).toHaveCount(3);
    const timeline = page.getByTestId('journey-timeline');
    await expect(timeline).toContainText(vi['not.journey.timeline.notRequired']);
  });

  test('the journey of an unknown send, a send nobody named and a reader: the page says so', async ({ page }) => {
    await openScreen(page, 'not-12', 'owner');
    await expect(page.getByTestId('journey-select')).toBeVisible();
    await openScreen(page, 'not-12', 'notificationReader', `&id=${ATTEMPT.journeyDelivered}`);
    await expect(page.getByTestId('journey-milestones').getByRole('listitem')).toHaveCount(5);
    await openScreen(page, 'not-12', 'nobody', `&id=${ATTEMPT.journeyDelivered}`);
    await expect(page.getByText(vi['states.denied.title'])).toBeVisible();
  });
});
