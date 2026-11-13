import { expect, test } from '@playwright/test';
import vi from '../../src/i18n/vi.json' with { type: 'json' };
import { pdfWithText } from './pdf.ts';
import { Clip, loadFlow } from './recorder.ts';
import TEXTS from './data/02-danh-muc-dia-ban.hdsd.json' with { type: 'json' };
import { textsOf } from '../support/texts.ts';

const tx = textsOf(TEXTS);

/**
 * Clip 02 of the user guide: the base data the projects stand on. A member of the project board receives the decision that backs the change, proposes the areas,
 * and the leader approves and publishes them. Everything goes through the screens and the real API; the areas exist afterwards because the leader published them.
 */
const AREAS = [
  { key: 'CB-THUC-PHAN', name: tx('name.001') },
  { key: 'CB-NUNG-TRI-CAO', name: tx('name.002') },
  { key: 'CB-TAN-GIANG', name: tx('name.003') },
];

test('clip 02: receive the decision, propose the areas, approve and publish them', async ({ browser }) => {
  test.setTimeout(900_000);
  const clip = new Clip(loadFlow('02-danh-muc-dia-ban'), browser, undefined, process.env.HDSD_RECORD?.split(',').includes('02-danh-muc-dia-ban') ?? true);
  const ui = await clip.open();
  const { page } = ui;
  let documentId = '';

  await clip.step('khai-bao-loai-van-ban', async () => {
    await page.goto('/doc/doc-21?devUser=projectManager');
    await expect(page.getByRole('heading', { level: 1, name: vi['doc.types.page.title'] })).toBeVisible();
    const form = page.getByRole('form', { name: vi['doc.types.type.title'] });
    await ui.type(form.getByLabel(vi['doc.types.code.label']), 'QD');
    await ui.type(form.getByLabel(vi['doc.types.name.label']), tx('text.004'));
    await ui.type(form.getByLabel(vi['doc.types.abbreviation.label']), tx('text.005'));
    await form.getByLabel(vi['doc.types.symbolKind.label']).selectOption({ label: vi['doc.types.kind.decision'] });
    await ui.type(form.getByLabel(vi['doc.types.symbolPattern.label']), '{number}/{type}-{agency}');
    await ui.type(form.getByLabel(vi['doc.types.registerCode.label']), 'SO-QD');
    await ui.type(form.getByLabel(vi['doc.types.legalBasis.label']), tx('text.006'));
    await form.getByLabel(vi['doc.types.effectiveFrom.label']).fill('2026-01-01');
    await ui.click(form.getByRole('button', { name: vi['doc.types.type.submit.action'] }));
    await expect(page.getByText(vi['doc.types.type.accepted.notice'])).toBeVisible();
    await ui.spot(page.getByText(vi['doc.types.list.title']), () => ui.wait(1200));
  });

  await clip.step('nhan-van-ban', async () => {
    await page.goto('/doc/doc-11?devUser=projectManager');
    await expect(page.getByRole('heading', { level: 1, name: vi['doc.incoming.intake.title'] })).toBeVisible();
    await ui.point(page.getByLabel(vi['doc.incoming.intake.scan']));
    await page.getByLabel(vi['doc.incoming.intake.scan']).setInputFiles({
      name: 'qd-128-cong-bo-dia-ban.pdf',
      mimeType: 'application/pdf',
      buffer: pdfWithText(['UY BAN NHAN DAN TINH CAO BANG', 'Quyet dinh so 128/QD-UBND', 'Ve viec cong bo danh muc dia ban hanh chinh dung chung']),
    });
    await ui.type(page.getByLabel(vi['doc.incoming.field.title']), tx('text.007'));
    await ui.point(page.getByLabel(vi['doc.incoming.field.docType']));
    await page.getByLabel(vi['doc.incoming.field.docType']).selectOption('QD');
    await page.getByLabel(vi['doc.incoming.field.channel']).selectOption({ index: 0 });
    await ui.type(page.getByLabel(vi['doc.incoming.field.sender']), tx('text.008'));
    await ui.type(page.getByLabel(vi['doc.incoming.field.symbol']), tx('text.009'));
    await page.getByLabel(vi['doc.incoming.field.issuedOn']).fill('2026-10-12');
    await ui.click(page.getByRole('button', { name: vi['doc.incoming.intake.submit'], exact: true }));
    await expect(page.getByTestId('taken-link')).toBeVisible();
    await ui.spot(page.getByText(vi['doc.incoming.intake.taken']), () => ui.wait(1200));
  });

  await clip.step('van-ban-trong-so', async () => {
    await page.goto('/doc/doc-12?devUser=projectManager');
    await expect(page.getByRole('heading', { level: 1, name: vi['doc.incoming.ledger.title'] })).toBeVisible();
    const row = page.locator('tbody tr').first();
    await expect(row).toContainText(tx('text.009'));
    await ui.spot(row, () => ui.wait(1200));
    // The code of the document is on the screen of the letter: it is what the publication of the catalogue asks for.
    await ui.click(row.getByRole('link').first());
    const code = page.getByTestId('fact-document');
    await expect(code).toBeVisible();
    documentId = ((await code.textContent()) ?? '').trim();
    expect(documentId).toMatch(/^[0-9a-f-]{36}$/u);
    await ui.spot(code, () => ui.wait(1500));
  });

  await clip.step('de-xuat-dia-ban', async () => {
    await page.goto('/mdm/mdm-25?devUser=projectManager');
    await expect(page.getByRole('heading', { level: 1, name: vi['mdm.create.page.title'] })).toBeVisible();
    await fillArea(AREAS[0]!, true);
  });

  await clip.step('gui-duyet', async () => {
    await submitImpact(true);
    for (const area of AREAS.slice(1)) {
      await page.goto('/mdm/mdm-25?devUser=projectManager');
      await fillArea(area, false);
      await submitImpact(false);
    }
  });

  await clip.step('duyet-ban-ghi', async () => {
    await page.goto('/mdm/mdm-32?devUser=capApprover');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    for (const area of AREAS) {
      const row = page.locator('tr[data-stage="review"]', { hasText: area.key });
      await expect(row).toBeVisible();
      await ui.click(row.getByRole('button', { name: vi['mdm.approval.review.action'] }));
      const panel = page.locator('tr[data-panel-for]');
      await ui.type(panel.getByLabel(vi['mdm.approval.reason.label']), tx('text.010'));
      await ui.click(panel.getByRole('button', { name: vi['mdm.approval.decision.approve.action'] }));
      await expect(page.getByText(vi['mdm.approval.decided.notice'])).toBeVisible();
    }
  });

  await clip.step('cong-bo', async () => {
    for (const area of AREAS) {
      const row = page.locator('tr[data-stage="publish"]', { hasText: area.key });
      await expect(row).toBeVisible();
      await ui.click(row.getByRole('button', { name: vi['mdm.approval.publish.action'] }));
      const panel = page.locator('tr[data-panel-for]');
      await ui.type(panel.getByLabel(vi['mdm.approval.document.label']), documentId);
      await ui.click(panel.getByRole('button', { name: vi['mdm.approval.publish.confirm.action'] }));
      await expect(page.getByText(vi['mdm.approval.published.notice'])).toBeVisible();
    }
  });

  await clip.finish();

  async function fillArea(area: { key: string; name: string }, slow: boolean): Promise<void> {
    const type = page.getByLabel(vi['mdm.create.type.label']);
    if (slow) await ui.type(type, 'AREA');
    else await type.fill('AREA');
    // The platform publishes the provinces; a tenant adds its wards under the province they belong to.
    const parent = page.getByLabel(vi['mdm.create.parent.label']);
    await expect(parent.locator('option', { hasText: tx('hasText.011') }).first()).toBeAttached();
    const province = await parent.locator('option', { hasText: tx('hasText.011') }).first().getAttribute('value');
    if (slow) await ui.point(parent);
    await parent.selectOption(province);
    if (slow) {
      await ui.type(page.getByLabel(vi['mdm.create.key.label']), area.key);
      await ui.type(page.getByLabel(vi['mdm.create.name.label']), area.name);
    } else {
      await page.getByLabel(vi['mdm.create.key.label']).fill(area.key);
      await page.getByLabel(vi['mdm.create.name.label']).fill(area.name);
    }
    await page.getByLabel(vi['mdm.create.validFrom.label']).fill('2026-01-01');
    if (slow) await ui.type(page.getByLabel(vi['mdm.create.reason.label']), tx('fillArea.012'));
    else await page.getByLabel(vi['mdm.create.reason.label']).fill(tx('fillArea.012'));
    if (slow) await ui.click(page.getByRole('button', { name: vi['mdm.create.save.action'] }));
    else await page.getByRole('button', { name: vi['mdm.create.save.action'] }).click();
  }

  async function submitImpact(slow: boolean): Promise<void> {
    await expect(page.getByTestId('impact')).toBeVisible();
    if (slow) await ui.spot(page.getByTestId('impact'), () => ui.wait(1500));
    const read = page.getByRole('checkbox', { name: vi['mdm.impact.read.label'] });
    if (slow) await ui.click(read);
    else await read.check();
    const send = page.getByRole('button', { name: vi['mdm.impact.submit.action'] });
    if (slow) await ui.click(send);
    else await send.click();
    await expect(page.getByText(vi['mdm.create.submitted.notice'], { exact: false })).toBeVisible();
  }
});
