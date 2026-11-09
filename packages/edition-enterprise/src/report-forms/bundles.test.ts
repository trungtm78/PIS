import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPORT_FORM_CATALOGUE } from '@machvon/kernel/src/report-layout.ts';
import type { FormPeriod } from '@machvon/kernel/src/report-layout.ts';
import { enterpriseReportBundles, templatesFolder } from './bundles.ts';
import { DEMO_FORMS } from './forms.ts';
import { templateFileName } from './template-builder.ts';

const ZIP_MAGIC = [0x50, 0x4b];
const PACKAGE_FOLDER = join(__dirname, '..', '..');

describe('enterpriseReportBundles', () => {
  const bundles = enterpriseReportBundles();

  it('has one bundle per demo form, each with the receiver and the period kind of the catalogue', () => {
    expect(bundles.map((bundle) => bundle.layout.code)).toEqual(DEMO_FORMS.map((form) => form.layout.code));
    for (const bundle of bundles) {
      const entry = REPORT_FORM_CATALOGUE.find((one) => one.code === bundle.layout.code);
      expect(entry).toBeDefined();
      expect(bundle).toMatchObject({ edition: 'enterprise', receiver: entry?.receiver, periodKind: entry?.period });
    }
  });

  it('reads the committed template files: a workbook for every form and a Word skeleton only for the forms with a narrative', async () => {
    for (const bundle of bundles) {
      const files = await bundle.templates();
      expect([...files.xlsx.slice(0, 2)]).toEqual(ZIP_MAGIC);
      expect(Buffer.from(files.xlsx).equals(readFileSync(join(PACKAGE_FOLDER, 'templates', 'demo', templateFileName(bundle.layout.code, 'xlsx'))))).toBe(true);
      if (bundle.narrative === null) expect(files.docx).toBeNull();
      else expect([...(files.docx ?? new Uint8Array()).slice(0, 2)]).toEqual(ZIP_MAGIC);
    }
    expect(bundles.filter((bundle) => bundle.narrative !== null).length).toBeGreaterThan(0);
  });

  it('gives the invented data of a period, filled for the form it belongs to', () => {
    for (const bundle of bundles) {
      const period: FormPeriod = bundle.periodKind === 'QUARTER' ? { kind: 'QUARTER', year: 2026, index: 3 } : bundle.periodKind === 'YEAR' ? { kind: 'YEAR', year: 2026 } : { kind: 'MONTH', year: 2026, index: 10 };
      expect(bundle.illustrative?.(period)).toBeDefined();
    }
  });
});

describe('templatesFolder', () => {
  const scratch: string[] = [];
  afterAll(() => {
    for (const folder of scratch) rmSync(folder, { recursive: true, force: true });
  });
  const fresh = (): string => {
    const folder = mkdtempSync(join(tmpdir(), 'bundles-test-'));
    scratch.push(folder);
    return folder;
  };

  it('finds the folder from the working directory of the package and from a folder far below the repository root', () => {
    const expected = join(PACKAGE_FOLDER, 'templates', 'demo');
    expect(templatesFolder([PACKAGE_FOLDER])).toBe(expected);
    expect(templatesFolder([join(PACKAGE_FOLDER, 'src', 'report-forms')])).toBe(expected);
  });

  it('finds a templates/demo folder beside a started script, walking up, and tries the next start when the first has none', () => {
    const root = fresh();
    const demo = join(root, 'templates', 'demo');
    mkdirSync(demo, { recursive: true });
    mkdirSync(join(root, 'dist', 'server'), { recursive: true });
    const probe = templateFileName(DEMO_FORMS[0]?.layout.code ?? 'PVN-MONTHLY', 'xlsx');
    copyFileSync(join(PACKAGE_FOLDER, 'templates', 'demo', probe), join(demo, probe));
    expect(templatesFolder([join(root, 'dist', 'server')])).toBe(demo);
    expect(templatesFolder([fresh(), join(root, 'dist')])).toBe(demo);
  });

  it('says where it looked when there is no template folder, instead of returning a path that does not exist', () => {
    const empty = fresh();
    expect(() => templatesFolder([empty])).toThrow(`demo forms: the template folder was not found from ${empty}`);
  });

  it('does not take a folder for the templates when the probe file is not in it', () => {
    const root = fresh();
    mkdirSync(join(root, 'templates', 'demo'), { recursive: true });
    expect(() => templatesFolder([root])).toThrow('template folder was not found');
  });
});
