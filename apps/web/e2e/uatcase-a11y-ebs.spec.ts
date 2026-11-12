import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import vi from '../src/i18n/vi.json' with { type: 'json' };
import { DESKTOP, PHONE, seriousViolations } from './support/axe-page.ts';
import { chooseFileWithKeyboard, pressButton, startAtTitle } from './support/keyboard.ts';

/**
 * UAT-EBS-A11-01: the two screens of the Oracle EBS connection against the real stack of the enterprise edition: axe at 1280 px and 360 px before and after a file is
 * taken, and the whole upload (choose the file, read it as a dry run, apply it once) done with the keyboard alone. The populated differences table, the statuses
 * in words and the dialog of an explanation are judged by the component tests of the screen (src/editions/enterprise/screens/ebs/uatcase-a11y.test.tsx).
 */

const HEADER = 'project_code,period,extract_date,disbursed_vnd,committed_vnd';
const FILE = { name: 'ebs-extract.csv', mimeType: 'text/csv', buffer: Buffer.from(`${[HEADER, 'EBS-A11Y-1,2026-10,2026-11-02,700000000,900000000', 'EBS-A11Y-2,2026-10,2026-11-02,100000000,200000000'].join('\n')}\n`, 'utf8') };

// The two screens belong to the enterprise edition only: the block is registered only when the stack serves it (a public run has no such test instead of a skipped one).
const ENTERPRISE = (process.env.MACHVON_EDITION ?? process.env.VITE_EDITION) === 'enterprise';
type DescribeBlock = (title: string, body: () => void) => void;
const noBlock: DescribeBlock = () => undefined;
const describeEnterprise: DescribeBlock = ENTERPRISE ? test.describe : noBlock;

async function open(page: Page, path: string, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await page.goto(`${path}?devUser=owner`);
  await page.waitForSelector('[data-screen-id]');
  await page.waitForLoadState('networkidle');
}

describeEnterprise('EBS screens in the enterprise edition, accessibility', () => {
  for (const [name, size] of [['1280 px', DESKTOP], ['360 px', PHONE]] as const) {
    test(`UAT-EBS-A11-01 EBS-01 and EBS-02 at ${name} have 0 serious or critical axe violations before any file`, async ({ page }) => {
      for (const [screen, path] of [['EBS-01', '/ebs/ebs-01'], ['EBS-02', '/ebs/ebs-02']] as const) {
        await open(page, path, size);
        expect(await seriousViolations(page), `${screen} at ${name}`).toEqual([]);
      }
    });
  }

  test('UAT-EBS-A11-01 a file is chosen, read as a dry run and applied with the keyboard alone, each step is announced in words, and the screen stays free of serious axe violations at both widths', async ({ page }) => {
    await open(page, '/ebs/ebs-01', DESKTOP);
    await startAtTitle(page);
    await chooseFileWithKeyboard(page, page.getByTestId('import-file'), FILE);
    await expect(page.getByTestId('upload-result')).toBeVisible();
    await expect(page.getByTestId('upload-result').getByRole('status')).toHaveText(vi['ebs.import.layout.fits.text']);
    await pressButton(page, page.getByTestId('dry-run-button'));
    await expect(page.getByTestId('preview-result')).toBeVisible();
    // The dry run table has a caption, column headers and a state in words for each row.
    const table = page.getByRole('table', { name: vi['ebs.import.preview.caption'] });
    await expect(table.getByRole('columnheader')).toHaveCount(4);
    await expect(table.getByRole('row').nth(1)).toContainText(vi['ebs.preview.status.valid']);
    for (const size of [DESKTOP, PHONE]) {
      await page.setViewportSize(size);
      expect(await seriousViolations(page), `dry run at ${size.width} px`).toEqual([]);
    }
    await pressButton(page, page.getByTestId('apply-button'));
    await expect(page.getByTestId('apply-result')).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: /\d/ }).first()).toBeVisible();
    for (const size of [DESKTOP, PHONE]) {
      await page.setViewportSize(size);
      expect(await seriousViolations(page), `after the import at ${size.width} px`).toEqual([]);
    }
  });

  test('negative control: the axe check reports a form field without a label', async ({ page }) => {
    await page.setContent('<main><h1>t</h1><input type="text"></main>');
    expect((await seriousViolations(page)).join(' ')).toContain('label');
  });
});
