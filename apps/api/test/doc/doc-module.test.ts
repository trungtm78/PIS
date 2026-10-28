import { Test } from '@nestjs/testing';
import type { PdfRenderer } from '@machvon/kernel';
import { docModule } from '../../src/modules/doc';
import { DOCUMENT_FILE_PORT } from '../../src/modules/doc/file-port';
import type { DocumentFilePort } from '../../src/modules/doc/file-port';
import { DOC_STATE_TEXT, PDF_RENDERER } from '../../src/modules/doc/tokens';
import { MODULES } from '../../src/modules/registry';
import { sampleRequest } from './render-fixture';

describe('docModule', () => {
  it('is registered under the code DOC with its seventeen controllers', () => {
    expect(MODULES).toContain(docModule);
    expect(docModule.code).toBe('DOC');
    expect(docModule.controllers.map((controller) => controller.name)).toEqual(['IncomingController', 'IncomingReadsController', 'DossiersController', 'DossierReadsController', 'DocumentsController', 'DocumentVersionReadsController', 'OutgoingController', 'OutgoingDraftsController', 'IssueRequestsController', 'SignedDocumentsController', 'DocumentFilesController', 'RegistersController', 'SignaturesController', 'DocumentTemplatesController', 'OutgoingIssuanceController', 'DocumentDistributionsController', 'OutgoingRecallController']);
  });

  it('wires a renderer that draws with the vendored fonts, the fixed texts and an in-memory file port', async () => {
    const module = await Test.createTestingModule({ providers: [...(docModule.providers ?? [])] }).compile();
    const renderer = module.get<PdfRenderer>(PDF_RENDERER);
    const rendered = await renderer.render(sampleRequest());
    expect(rendered.pageCount).toBe(1);
    expect(module.get<{ nationalTitle: string }>(DOC_STATE_TEXT).nationalTitle).toContain('VIỆT NAM');
    const files = module.get<DocumentFilePort>(DOCUMENT_FILE_PORT);
    await files.put('tenants/t/documents/x.pdf', rendered.bytes, 'application/pdf');
    expect((await files.get('tenants/t/documents/x.pdf'))?.mime).toBe('application/pdf');
  });
});
