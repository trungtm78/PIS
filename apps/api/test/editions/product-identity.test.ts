import 'reflect-metadata';
import ExcelJS from 'exceljs';
import { PDFDocument } from 'pdf-lib';
import { unzipSync } from 'fflate';
import type { TenantDatabase } from '@machvon/db';
import { ALLOW_ALL, PUBLIC_EDITION_MANIFEST, defineEditionManifest } from '@machvon/kernel';
import type { EditionManifest, ExportDocument } from '@machvon/kernel';
import { AppModule } from '../../src/app.module';
import type { AppModuleOptions } from '../../src/app.module';
import { documentProducer, openApiTitle, serveEdition } from '../../src/editions/product-identity';
import { pdfOf } from '../../src/modules/dis/export-pdf';
import { buildNarrativeTemplate } from '../../src/modules/dis/narrative-template';
import { OpenApiController } from '../../src/modules/int/open-api.controller';
import { docxOf } from '../../src/modules/reports/export-docx';

const OTHER: EditionManifest = defineEditionManifest({
  edition: 'enterprise',
  productName: { vi: 'Sản phẩm khác', en: 'Another product' },
  brand: {
    mark: { vi: 'SK', en: 'AP' },
    shortName: { vi: 'Khác', en: 'Other' },
    launcherName: { vi: 'Khác', en: 'Other' },
    logoAlt: { vi: 'Biểu tượng Khác', en: 'Other logo' },
    tagline: { vi: 'Khẩu hiệu', en: 'Tagline' },
    themeColor: '#0F3B57',
  },
  modules: ALLOW_ALL,
  screens: ALLOW_ALL,
  menu: ALLOW_ALL,
  terminology: { web: [], mobile: [] },
  rulePacks: ['enterprise-investment'],
});

const DOCUMENT: ExportDocument = {
  title: 'Export',
  header: [{ key: 'period', label: 'Period', value: '2026-W41' }],
  columns: [{ key: 'c0', label: 'Column', numeric: false }] as ExportDocument['columns'],
  rows: [['a']],
  notice: null,
};

afterEach(() => serveEdition(undefined));

describe('the product name the process writes into what it produces', () => {
  it('is the public product until an edition is served, and never a code name', () => {
    expect(documentProducer()).toBe(PUBLIC_EDITION_MANIFEST.productName.vi);
    expect(documentProducer()).toBe('Hệ thống quản lý đầu tư công');
    expect(openApiTitle()).toBe('Public Investment Management System open API');
    expect(`${documentProducer()} ${openApiTitle()}`).not.toMatch(/MACHVON|Mạch Vốn/i);
  });

  it('follows the edition the application is registered with, and the public one when none is named', () => {
    const options = { database: {} as TenantDatabase, registry: new Map(), edition: OTHER } as AppModuleOptions;
    AppModule.register(options);
    expect(documentProducer()).toBe('Sản phẩm khác');
    expect(openApiTitle()).toBe('Another product open API');
    AppModule.register({ ...options, edition: undefined });
    expect(documentProducer()).toBe(PUBLIC_EDITION_MANIFEST.productName.vi);
  });

  it('is the author of a Word file, the producer of a PDF and the creator of a workbook', async () => {
    const docx = unzipSync(await docxOf(DOCUMENT));
    const core = new TextDecoder().decode(docx['docProps/core.xml']);
    expect(core).toContain('Hệ thống quản lý đầu tư công');
    expect(core).not.toContain('MACHVON');
    const pdf = await PDFDocument.load(await pdfOf(DOCUMENT), { updateMetadata: false });
    expect(pdf.getProducer()).toBe('Hệ thống quản lý đầu tư công');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(await buildNarrativeTemplate({ projects: [], causes: [] })) as unknown as ArrayBuffer);
    expect(workbook.creator).toBe('Hệ thống quản lý đầu tư công');
    serveEdition(OTHER);
    expect((await PDFDocument.load(await pdfOf(DOCUMENT), { updateMetadata: false })).getProducer()).toBe('Sản phẩm khác');
  });

  it('titles the open API document it serves for the edition it runs as and keeps the rest of the published document', () => {
    const controller = new OpenApiController({} as never);
    const served = controller.document();
    expect((served.info as { title: string }).title).toBe('Public Investment Management System open API');
    serveEdition(OTHER);
    const other = controller.document();
    expect((other.info as { title: string; version: string }).title).toBe('Another product open API');
    expect(other.paths).toBe(served.paths);
  });
});
