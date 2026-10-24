import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { sql, stackInfo } from './support/stack.ts';

/**
 * DOC-09 in a real browser against the real API and database (apps/api/test/e2e-stack): the records clerk puts a PDF into the shared upload pipeline,
 * reads what its signatures hold, and then attaches the file the leader signed with their own tool to the document that waits for the signature, or
 * registers a document that was signed and numbered in another system. The files are made by the stack with the test authority it trusts (the folder
 * and the manifest are written next to the seed). A file nobody signed is shown for what it is and cannot be attached, and the person who drafted
 * the document is refused when uploading its signed file. What the screen changed is looked up in the database.
 */

const SAMPLES = join(tmpdir(), 'machvon-e2e-doc-signed');
const sample = (name: string): string => join(SAMPLES, name);

interface Manifest {
  number: number;
  symbol: string;
  issuedOn: string;
  uploadDocumentId: string;
  selfDraftedId: string;
  sha256: string;
}

const manifest = (): Manifest => JSON.parse(readFileSync(sample('manifest.json'), 'utf8')) as Manifest;

async function open(page: Page, user: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/doc/doc-09?devUser=${user}`);
  await page.waitForSelector('[data-screen-id]');
}

async function readFile(page: Page, name: string): Promise<void> {
  await page.getByLabel(vi['doc.signed.file.label']).setInputFiles(sample(name));
  await page.getByRole('button', { name: vi['doc.signed.file.read.action'] }).click();
  await expect(page.getByTestId('verdict')).toBeVisible();
}

async function status(documentId: string): Promise<{ status: string; route: string; stage: string | null }> {
  const [row] = await sql<{ status: string; route: string; stage: string | null }>(
    `select o.status, o.route, (select stage from machvon.document_version v where v.document_id = o.document_id order by v.version desc limit 1) as stage
       from machvon.outgoing_document o where o.id = $1`,
    [documentId],
  );
  if (row === undefined) throw new Error('no such document');
  return row;
}

test.describe('DOC-09: documents signed outside the system', () => {
  test('the clerk reads the file the leader signed and attaches it to the document that waits for the signature', async ({ page }) => {
    const target = manifest().uploadDocumentId;
    expect(await status(target)).toMatchObject({ status: 'SUBMITTED', route: 'IN_SYSTEM' });
    await open(page, 'docClerk');
    await readFile(page, 'leader-signed.pdf');
    const verdict = page.getByTestId('verdict');
    await expect(verdict).toHaveAttribute('data-overall', 'VALID');
    await expect(verdict.getByText(vi['doc.signed.role.leader'])).toBeVisible();
    await expect(verdict.getByText(vi['doc.signed.chain.trusted'])).toBeVisible();
    await expect(verdict.getByText(vi['doc.signed.time.proven'])).toBeVisible();
    await expect(page.getByRole('button', { name: vi['doc.signed.leader.attach.action'] })).toBeDisabled();
    await page.getByLabel(vi['doc.signed.leader.document.label']).selectOption(target);
    await page.getByRole('button', { name: vi['doc.signed.leader.attach.action'] }).click();
    await expect(page.locator('[data-done="LEADER"]')).toBeVisible();
    await expect(page.getByRole('link', { name: vi['doc.signed.done.leader.next'] })).toHaveAttribute('href', new RegExp(`/doc/doc-06\\?doc=${target}`));
    expect(await status(target)).toMatchObject({ status: 'SIGNED', route: 'EXTERNAL_UPLOAD', stage: 'LEADER_SIGNED' });
    const [audit] = await sql<{ n: string }>("select count(*)::text as n from machvon.audit_event where action = 'document.file_uploaded'");
    expect(Number(audit?.n)).toBeGreaterThanOrEqual(1);
  });

  test('the clerk registers a document that was signed and numbered in another system as issued, and the same number is refused the second time', async ({ page }) => {
    const { number, symbol, issuedOn } = manifest();
    const unit = (await sql<{ drafting_unit_id: string }>('select drafting_unit_id from machvon.outgoing_document where id = $1', [stackInfo().documents.visualSigned]))[0]?.drafting_unit_id ?? '';
    await open(page, 'docClerk');
    await page.getByLabel(vi['doc.signed.mode.external.label']).check();
    await readFile(page, 'externally-issued.pdf');
    await expect(page.getByTestId('verdict')).toHaveAttribute('data-overall', 'VALID');
    await expect(page.getByTestId('verdict').locator('tbody tr')).toHaveCount(2);
    const fill = async (title: string): Promise<void> => {
      await page.getByLabel(vi['doc.signed.external.type.label']).selectOption('QD');
      await page.locator('#signed-title').fill(title);
      await page.getByLabel(vi['doc.signed.external.unit.label']).selectOption(unit);
      await page.getByLabel(vi['doc.signed.external.issuedOn.label']).fill(issuedOn);
      const register = await page.locator('#signed-register option', { hasText: 'ZEXT' }).first().getAttribute('value');
      await page.getByLabel(vi['doc.signed.external.register.label']).selectOption(register ?? '');
      await page.getByLabel(vi['doc.signed.external.number.label']).fill(String(number));
      await page.getByLabel(vi['doc.signed.external.symbol.label']).fill(symbol);
      await page.getByLabel(vi['doc.signed.external.recipients.label']).fill('Department of Finance');
    };
    await fill('Decision signed in another system');
    await page.getByRole('button', { name: vi['doc.signed.external.register.action'] }).click();
    await expect(page.locator('[data-done="EXTERNAL"]')).toContainText(symbol);
    const [issued] = await sql<{ status: string; route: string; symbol: string; document_number: number }>(
      `select o.status, o.route, d.symbol, d.document_number from machvon.outgoing_document o join machvon.document d on d.id = o.document_id where d.symbol = $1`,
      [symbol],
    );
    expect(issued).toMatchObject({ status: 'ISSUED', route: 'EXTERNAL_UPLOAD', symbol, document_number: number });
    const [allocation] = await sql<{ n: string }>("select count(*)::text as n from machvon.document_number_allocation a join machvon.document_number_register r on r.id = a.register_id where r.register_code = 'ZEXT' and a.number = $1", [number]);
    expect(allocation?.n).toBe('1');
    // The same file again: its number is in the register.
    await page.reload();
    await page.waitForSelector('[data-screen-id]');
    await page.getByLabel(vi['doc.signed.mode.external.label']).check();
    await readFile(page, 'externally-issued.pdf');
    await fill('The same decision again');
    await page.getByRole('button', { name: vi['doc.signed.external.register.action'] }).click();
    await expect(page.getByRole('alert').filter({ hasText: vi['doc.signed.problem.numberTaken'] })).toBeVisible();
    const [again] = await sql<{ n: string }>('select count(*)::text as n from machvon.document where symbol = $1', [symbol]);
    expect(again?.n).toBe('1');
  });

  test('a file nobody signed is shown for what it is and cannot be attached', async ({ page }) => {
    await open(page, 'docClerk');
    await readFile(page, 'unsigned.pdf');
    await expect(page.getByTestId('verdict').locator('[data-unsigned="true"]')).toHaveText(vi['doc.signed.result.none']);
    await expect(page.getByTestId('verdict').locator('[data-blocked="true"]')).toBeVisible();
    await page.getByLabel(vi['doc.signed.leader.document.label']).selectOption(manifest().selfDraftedId);
    await expect(page.getByRole('button', { name: vi['doc.signed.leader.attach.action'] })).toBeDisabled();
  });

  test('the person who drafted the document is refused when uploading its signed file, and the document stays as it was', async ({ page }) => {
    const own = manifest().selfDraftedId;
    await open(page, 'docClerk');
    await readFile(page, 'leader-signed.pdf');
    await page.getByLabel(vi['doc.signed.leader.document.label']).selectOption(own);
    await page.getByRole('button', { name: vi['doc.signed.leader.attach.action'] }).click();
    await expect(page.getByRole('alert').filter({ hasText: vi['doc.signed.problem.selfUpload'] })).toBeVisible();
    expect(await status(own)).toMatchObject({ status: 'SUBMITTED', route: 'IN_SYSTEM' });
  });

  test('a reader without the permission to upload sees the screen and nothing to change', async ({ page }) => {
    await open(page, 'docReader');
    await expect(page.locator('[data-readonly="true"]')).toHaveText(vi['doc.signed.denied.notice']);
    await expect(page.getByLabel(vi['doc.signed.file.label'])).toBeDisabled();
    await expect(page.getByRole('button', { name: vi['doc.signed.file.read.action'] })).toBeDisabled();
  });
});
