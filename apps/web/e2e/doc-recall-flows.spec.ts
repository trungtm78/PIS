import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { membershipOf, sql } from './support/stack.ts';

/**
 * DOC-19 in a real browser against the real API and database (apps/api/test/e2e-stack): the leader recalls an issued document and its recipients are told, a records
 * manager voids the number of a document that cannot be sealed with a second person who is not the one who allocated it, and someone without the rights sees the document
 * but no way to act. The stack seeds the documents (titles below) the way the commands leave them; what a screen changed is looked up in the database.
 */

const TITLES = {
  recall: 'Quyet dinh can thu hoi',
  basis: 'Quyet dinh lam can cu thu hoi',
  validation: 'Quyet dinh kiem tra ly do thu hoi',
  void: 'Quyet dinh khong dong dau duoc',
  visualRecalled: 'Quyet dinh hien thi da thu hoi',
} as const;
const REASON = 'Phat hanh nham ky bao cao, so lieu bang 2 sai';

interface Ids {
  id: string;
  documentId: string;
}

async function idsOf(title: string): Promise<Ids> {
  const [row] = await sql<{ id: string; document_id: string }>('select o.id, o.document_id from machvon.outgoing_document o join machvon.document d on d.id = o.document_id where d.title = $1', [title]);
  if (row === undefined) throw new Error(`no document titled ${title}`);
  return { id: row.id, documentId: row.document_id };
}

async function open(page: Page, user: string, title: string): Promise<Ids> {
  const ids = await idsOf(title);
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto(`/doc/doc-19?devUser=${user}&doc=${ids.id}`);
  await page.waitForSelector('[data-screen-id]');
  await page.waitForSelector(`[data-document-id="${ids.id}"]`);
  return ids;
}

const recallForm = (page: Page) => page.getByRole('form', { name: vi['doc.recall.recall.form'] });
const voidForm = (page: Page) => page.getByRole('form', { name: vi['doc.recall.void.form'] });

async function stateOf(id: string): Promise<{ status: string; effect_status: string; recall_reason: string | null; cancel_reason: string | null }> {
  const [row] = await sql<{ status: string; effect_status: string; recall_reason: string | null; cancel_reason: string | null }>(
    `select o.status, d.effect_status, o.recall_reason, o.cancel_reason from machvon.outgoing_document o join machvon.document d on d.id = o.document_id where o.id = $1`,
    [id],
  );
  if (row === undefined) throw new Error('no such document');
  return row;
}

const eventsOf = async (id: string, type: string): Promise<number> => Number((await sql<{ n: string }>('select count(*)::text as n from machvon.outbox_event where aggregate_id = $1 and type = $2', [id, type]))[0]?.n);

test.describe('DOC-19: recall and void', () => {
  test('the leader recalls a delivered document: the reason is asked for, the effect ends, the recipients are told and the sending that failed is called off', async ({ page }) => {
    const target = await open(page, 'docLeader', TITLES.recall);
    const basis = await idsOf(TITLES.basis);
    await expect(page.getByTestId('document-status')).toHaveText(vi['doc.recall.status.delivered']);
    await expect(voidForm(page)).toHaveCount(0);

    // Nothing is sent without a reason of ten characters.
    const submit = recallForm(page).getByRole('button', { name: vi['doc.recall.recall.submit.action'] });
    await submit.click();
    await expect(page.getByRole('alert')).toHaveText(vi['doc.recall.reason.problem.required']);
    await recallForm(page).getByLabel(vi['doc.recall.recall.reason.label']).fill('qua ngan');
    await submit.click();
    await expect(page.getByRole('alert')).toHaveText(vi['doc.recall.reason.problem.tooShort']);
    expect(await stateOf(target.id)).toMatchObject({ status: 'DELIVERED', effect_status: 'EFFECTIVE', recall_reason: null });

    await recallForm(page).getByLabel(vi['doc.recall.recall.reason.label']).fill(REASON);
    await recallForm(page).getByLabel(vi['doc.recall.recall.basis.label']).selectOption(basis.documentId);
    await submit.click();
    const banner = page.getByTestId('recall-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(REASON);
    await expect(page.getByTestId('document-status')).toHaveText(vi['doc.recall.status.recalled']);
    await expect(recallForm(page)).toHaveCount(0);

    expect(await stateOf(target.id)).toMatchObject({ status: 'RECALLED', effect_status: 'RECALLED', recall_reason: REASON });
    const rows = await sql<{ recipient_name: string; status: string; noticed: boolean }>(
      'select recipient_name, status, recall_notice_at is not null as noticed from machvon.document_distribution where outgoing_document_id = $1 order by recipient_name',
      [target.id],
    );
    expect(rows).toEqual([
      { recipient_name: 'Kho bac Nha nuoc', status: 'CANCELLED', noticed: false },
      { recipient_name: 'Phong Ke hoach', status: 'DELIVERED', noticed: true },
      { recipient_name: 'So Tai chinh', status: 'SENT', noticed: true },
    ]);
    const relations = await sql<{ from_document_id: string; relation_kind: string }>('select from_document_id, relation_kind from machvon.document_relation where to_document_id = $1', [target.documentId]);
    expect(relations).toEqual([{ from_document_id: basis.documentId, relation_kind: 'RECALLS' }]);
    expect(await eventsOf(target.id, 'doc.recalled.v1')).toBe(1);
    const [audit] = await sql<{ n: string }>("select count(*)::text as n from machvon.audit_event where resource_id = $1 and action = 'outgoing_document.recall'", [target.id]);
    expect(audit?.n).toBe('1');

    // The page tells who was noticed and keeps the history, the recall among it.
    await expect(page.getByTestId('notice-progress')).toHaveText(vi['doc.recall.notices.progress'].replace('{noticed}', '2').replace('{total}', '3').replace('{calledOff}', '1'));
    await expect(page.locator(`tr[data-distribution-id] >> text=Phong Ke hoach`)).toBeVisible();
    await expect(page.getByRole('list', { name: vi['doc.recall.history.title'] }).locator('[data-kind="RECALLED"]')).toContainText(REASON);
    // The number stays with the document in the ledger.
    const [ledger] = await sql<{ allocation_status: string; effect_status: string }>(
      `select a.status as allocation_status, d.effect_status from machvon.document_number_allocation a join machvon.document d on d.id = a.document_id where a.document_id = $1`,
      [target.documentId],
    );
    expect(ledger).toEqual({ allocation_status: 'ALLOCATED', effect_status: 'RECALLED' });
  });

  test('a recall made in another window first is refused with the reason and leaves the first recall as it was', async ({ page }) => {
    const target = await open(page, 'docLeader', TITLES.validation);
    await recallForm(page).getByLabel(vi['doc.recall.recall.reason.label']).fill(REASON);
    const other = await page.context().newPage();
    try {
      await open(other, 'docLeader', TITLES.validation);
      await recallForm(other).getByLabel(vi['doc.recall.recall.reason.label']).fill('Thu hoi vi phat hanh nham doi tuong nhan');
      await recallForm(other).getByLabel(vi['doc.recall.recall.notify.label']).uncheck();
      await recallForm(other).getByRole('button', { name: vi['doc.recall.recall.submit.action'] }).click();
      await expect(other.getByTestId('recall-banner')).toBeVisible();
    } finally {
      await other.close();
    }
    await recallForm(page).getByRole('button', { name: vi['doc.recall.recall.submit.action'] }).click();
    await expect(page.getByRole('alert')).toContainText(vi['doc.recall.problem.conflict']);
    expect(await stateOf(target.id)).toMatchObject({ status: 'RECALLED', recall_reason: 'Thu hoi vi phat hanh nham doi tuong nhan' });
    expect(await eventsOf(target.id, 'doc.recalled.v1')).toBe(1);
  });

  test('a records manager voids the number of a document that cannot be sealed: the allocator is refused as approver, a second person approves, and the number stays voided in the ledger', async ({ page }) => {
    const target = await open(page, 'docRecordsManager', TITLES.void);
    await expect(page.getByTestId('document-status')).toHaveText(vi['doc.recall.status.numbered']);
    await expect(recallForm(page)).toHaveCount(0);
    const [allocation] = await sql<{ id: string; register_id: string; number: number; allocated_by: string }>(
      `select a.id, a.register_id, a.number, a.allocated_by from machvon.document_number_allocation a where a.document_id = $1`,
      [target.documentId],
    );
    if (allocation === undefined) throw new Error('no allocation');

    const submit = voidForm(page).getByRole('button', { name: vi['doc.recall.void.submit.action'] });
    await submit.click();
    await expect(page.getByRole('alert')).toHaveCount(2);
    await voidForm(page).getByLabel(vi['doc.recall.void.reason.label']).fill('Chung thu so cua co quan bi thu hoi, khong the dong dau');
    await voidForm(page).getByLabel(vi['doc.recall.void.approver.label']).fill(allocation.allocated_by);
    await submit.click();
    await expect(page.getByRole('alert')).toContainText(vi['doc.recall.problem.selfApproval']);
    expect((await stateOf(target.id)).status).toBe('NUMBERED');

    await voidForm(page).getByLabel(vi['doc.recall.void.approver.label']).fill(membershipOf('docSecondManager'));
    await submit.click();
    await expect(page.getByText(vi['doc.recall.done.voided'].replace('{number}', String(allocation.number)))).toBeVisible();
    await expect(page.getByTestId('document-status')).not.toHaveText(vi['doc.recall.status.numbered']);

    expect(await stateOf(target.id)).toMatchObject({ status: 'CANCELLED', effect_status: 'EXPIRED', cancel_reason: 'Chung thu so cua co quan bi thu hoi, khong the dong dau' });
    const [voided] = await sql<{ status: string; voided_by: string; void_approved_by: string }>('select status, voided_by, void_approved_by from machvon.document_number_allocation where id = $1', [allocation.id]);
    expect(voided).toEqual({ status: 'VOIDED', voided_by: membershipOf('docRecordsManager'), void_approved_by: membershipOf('docSecondManager') });
    expect(await eventsOf(target.id, 'doc.number_voided.v1')).toBe(1);
    // A voided number is not a gap: the register still has every number from 1 to its last.
    const gaps = await sql<{ number: number }>('select machvon.register_gaps($1::uuid) as number', [allocation.register_id]);
    expect(gaps).toEqual([]);
  });

  test('someone who may only read sees the documents and no way to recall or void them', async ({ page }) => {
    await open(page, 'docReader', TITLES.basis);
    await expect(page.getByText(vi['doc.recall.recall.denied'])).toBeVisible();
    await expect(recallForm(page)).toHaveCount(0);
    await open(page, 'docReader', TITLES.visualRecalled);
    await expect(page.getByTestId('recall-banner')).toBeVisible();
    await expect(page.getByTestId('notice-progress')).toBeVisible();
    await expect(page.getByRole('list', { name: vi['doc.recall.history.title'] }).locator('[data-kind="ISSUED"]')).toBeVisible();
  });
});
