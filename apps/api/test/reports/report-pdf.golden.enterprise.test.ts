import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEMO_MARK, REPORT_FORM_CATALOGUE } from '@machvon/kernel';
import { DEMO_FORMS, illustrativeFillData, templateFileName } from '@machvon/edition-enterprise/src/server.ts';
import type { DemoFormSpec } from '@machvon/edition-enterprise/src/server.ts';
import { sha256Hex } from '../../src/modules/reports/digest';
import { disagreements, writeAll } from './three-writers';

/**
 * The golden test of the three writers for the six demo forms of the enterprise edition (ENT-4b, R26): the workbook in the committed template, the Word narrative and the PDF are made from the same document of the same
 * illustrative data and read back; they must agree on every cell, every word of the narrative and the number of pages. The pages of each form are also fixed in `golden/pdf-pages.json` (regenerate with
 * `UPDATE_GOLDEN=1` and review the diff): a change of the layout that moves a page break shows up there. The name of this file ends in `.enterprise.test.ts`: it is one of the few sources that may name the enterprise package.
 */

const TEMPLATE_DIR = join(__dirname, '..', '..', '..', '..', 'packages', 'edition-enterprise', 'templates', 'demo');
const GOLDEN = join(__dirname, 'golden', 'pdf-pages.json');
const ISSUED_AT = new Date(Date.UTC(2026, 9, 31, 0, 0, 0));
const MONTH = { kind: 'MONTH', year: 2026, index: 10 } as const;
const QUARTER = { kind: 'QUARTER', year: 2026, index: 3 } as const;
const periodOf = (form: DemoFormSpec) => (REPORT_FORM_CATALOGUE.find((entry) => entry.code === form.layout.code)?.period === 'QUARTER' ? QUARTER : MONTH);
const templateOf = (code: string): Uint8Array => new Uint8Array(readFileSync(join(TEMPLATE_DIR, templateFileName(code, 'xlsx'))));

const golden: Record<string, { pages: number; sheetPages: number; cells: number; narrative: number }> = existsSync(GOLDEN) ? (JSON.parse(readFileSync(GOLDEN, 'utf8')) as typeof golden) : {};
const measured: typeof golden = {};

afterAll(() => {
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(GOLDEN, `${JSON.stringify(Object.fromEntries(Object.entries(measured).sort(([a], [b]) => (a < b ? -1 : 1))), null, 2)}\n`);
});

describe.each(DEMO_FORMS.map((form) => [form.layout.code, form] as const))('the three writers on the demo form %s', (code, form) => {
  let made: Awaited<ReturnType<typeof writeAll>>;

  beforeAll(async () => {
    made = await writeAll({ layout: form.layout, narrative: form.narrative, data: illustrativeFillData(form, periodOf(form)), template: templateOf(code), issuedAt: ISSUED_AT });
    // PDF_DUMP_DIR=<folder> keeps the files for a look with the eyes; nothing else reads it.
    if (process.env.PDF_DUMP_DIR !== undefined) writeFileSync(join(process.env.PDF_DUMP_DIR, `${code}.pdf`), made.pdf.bytes);
    measured[code] = { pages: made.pdf.plan.pages, sheetPages: made.pdf.plan.sheetPages, cells: made.pdf.plan.cells.filter((cell) => !cell.repeat).length, narrative: made.pdf.plan.narrative.length };
  }, 120_000);

  it('agree on every cell, every line of the narrative and the pages', async () => {
    expect(await disagreements(made)).toEqual([]);
  });

  it('print the demo mark on every page and say which layout version made the file', () => {
    expect(made.document.stamp).toBe(DEMO_MARK);
    const marks = made.drawn.filter((text) => text === DEMO_MARK);
    // The mark is in the head and the foot of every page.
    expect(marks.length).toBeGreaterThanOrEqual(2 * made.pdf.plan.pages);
    expect(made.drawn.some((text) => text.includes(form.layout.version) && text.includes(code))).toBe(true);
    expect(made.drawn.some((text) => text.includes(made.document.layoutSha256.slice(0, 12)))).toBe(true);
  });

  it('give the same file for the same document and the pages the golden file fixed', async () => {
    const again = await writeAll({ layout: form.layout, narrative: form.narrative, data: illustrativeFillData(form, periodOf(form)), template: templateOf(code), issuedAt: ISSUED_AT });
    expect(sha256Hex(again.pdf.bytes)).toBe(sha256Hex(made.pdf.bytes));
    if (process.env.UPDATE_GOLDEN !== '1') expect(golden[code]).toEqual(measured[code]);
  }, 120_000);

  it('hold the narrative on pages after the sheet, only for the forms that have one', () => {
    expect(made.pdf.plan.narrative.length > 0).toBe(form.narrative !== null);
    if (form.narrative === null) expect(made.pdf.plan.pages).toBe(made.pdf.plan.sheetPages);
    else expect(made.pdf.plan.pages).toBeGreaterThan(made.pdf.plan.sheetPages);
  });
});
