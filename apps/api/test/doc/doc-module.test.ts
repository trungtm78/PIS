import { Test } from '@nestjs/testing';
import { TenantDatabase } from '@machvon/db';
import type { PdfRenderer } from '@machvon/kernel';
import { docModule } from '../../src/modules/doc';
import { DOCUMENT_FILE_PORT } from '../../src/modules/doc/file-port';
import { DocInteropSender } from '../../src/modules/doc/interop-sender';
import { DocInteropService } from '../../src/modules/doc/interop.service';
import { UnconfiguredInteropTransport } from '../../src/modules/doc/interop-port';
import type { DocumentFilePort } from '../../src/modules/doc/file-port';
import { DOC_INTEROP_TRANSPORT, DOC_STATE_TEXT, PDF_RENDERER } from '../../src/modules/doc/tokens';
import { APPROVAL_FINAL_COMMANDS, FinalCommandRegistry } from '../../src/modules/adm/approval.service';
import { FileService } from '../../src/modules/files';
import { WEBHOOK_SECRETS } from '../../src/notifications/delivery/webhook-support';
import { MODULES } from '../../src/modules/registry';
import { sampleRequest } from './render-fixture';

// What the module takes from the platform: the tenant database, the object store of the platform and the vault of the signing keys.
const OUTSIDE = [
  { provide: TenantDatabase, useValue: {} },
  { provide: FileService, useValue: {} },
  { provide: APPROVAL_FINAL_COMMANDS, useFactory: () => new FinalCommandRegistry() },
  { provide: WEBHOOK_SECRETS, useValue: { resolve: () => Promise.resolve([]) } },
];

describe('docModule', () => {
  it('is registered under the code DOC with its twenty-five controllers', () => {
    expect(MODULES).toContain(docModule);
    expect(docModule.code).toBe('DOC');
    expect(docModule.controllers.map((controller) => controller.name)).toEqual(['IncomingController', 'IncomingReadsController', 'DossiersController', 'DossierReadsController', 'RetentionRulesController', 'DocumentOverviewController', 'DocumentsController', 'DocumentVersionReadsController', 'OutgoingController', 'OutgoingDraftsController', 'IssueRequestsController', 'SignedDocumentsController', 'DocumentFilesController', 'RegistersController', 'SignaturesController', 'DocumentTemplatesController', 'LayoutProfilesController', 'OutgoingIssuanceController', 'DocumentDistributionsController', 'DocInteropController', 'OutgoingRecallController', 'OutgoingSupersessionController', 'ProjectDocumentFilesController', 'ProjectDocumentsController', 'ProjectDocumentReadsController', 'DocumentCommentsController', 'DocumentReviewsController', 'DocumentReviewReadsController']);
  });

  it('wires a renderer that draws with the vendored fonts, the fixed texts and an in-memory file port', async () => {
    const module = await Test.createTestingModule({ providers: [...(docModule.providers ?? []), ...OUTSIDE] }).compile();
    const renderer = module.get<PdfRenderer>(PDF_RENDERER);
    const rendered = await renderer.render(sampleRequest());
    expect(rendered.pageCount).toBe(1);
    expect(module.get<{ nationalTitle: string }>(DOC_STATE_TEXT).nationalTitle).toContain('VIỆT NAM');
    const files = module.get<DocumentFilePort>(DOCUMENT_FILE_PORT);
    await files.put('tenants/t/documents/x.pdf', rendered.bytes, 'application/pdf');
    expect((await files.get('tenants/t/documents/x.pdf'))?.mime).toBe('application/pdf');
  });

  it('binds the interoperability: the service and the sender exist, and the gateway is the adapter that says the provider cannot be reached until the LGSP of the pilot tenant is specified (CXN-06)', async () => {
    const module = await Test.createTestingModule({ providers: [...(docModule.providers ?? []), ...OUTSIDE] }).compile();
    expect(module.get(DocInteropService)).toBeInstanceOf(DocInteropService);
    expect(module.get(DocInteropSender)).toBeInstanceOf(DocInteropSender);
    expect(module.get(DOC_INTEROP_TRANSPORT)).toBeInstanceOf(UnconfiguredInteropTransport);
  });
});
