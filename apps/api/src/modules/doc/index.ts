import { defineModule } from '../module-descriptor';
import { DocumentFilesController } from './document-files.controller';
import { DocumentVersionReadsController, DocumentsController } from './documents.controller';
import { DOCUMENT_FILE_PORT, MockDocumentFilePort } from './file-port';
import type { DocumentFilePort } from './file-port';
import type { MetricsSink } from '@machvon/kernel';
import { DossierReadsController, DossiersController } from './dossier.controller';
import { DocumentOverviewController } from './overview.controller';
import { IncomingController, IncomingReadsController } from './incoming.controller';
import { OutgoingController } from './outgoing.controller';
import { UnconfiguredEmailChannel } from './distribution-channel';
import { DocumentDistributionsController } from './distributions.controller';
import { OutgoingIssuanceController } from './issuance.controller';
import { IssueRequestsController } from './issue-requests.controller';
import { DocumentIssueService } from './issue-request.service';
import { OutgoingDraftsController } from './outgoing-drafts.controller';
import { LayoutProfilesController } from './layout-profiles.controller';
import { OutgoingRecallController } from './recall.controller';
import { OutgoingSupersessionController } from './supersession.controller';
import { SignedDocumentsController } from './signed-documents.controller';
import { PdfLibRenderer, loadRendererResources } from './pdf-renderer';
import type { RendererResources } from './pdf-renderer';
import { RegistersController } from './registers.controller';
import { SignaturesController } from './signatures.controller';
import { UnconfiguredSigningPort } from './signing-adapters';
import { DocumentTemplatesController } from './templates.controller';
import { DOC_CLOCK, DOC_EMAIL_CHANNEL, DOC_METRICS, DOC_RESOURCES, DOC_REVOCATION, DOC_SIGNING_PORT, DOC_STATE_TEXT, DOC_TRUST_STORE, PDF_RENDERER } from './tokens';
import { StaticTrustStoreProvider, UnavailableRevocationPort, loadTrustAnchors } from './trust-anchors';

/**
 * DOC, documents: the anchor and file versions, deterministic PDF rendering, document types and number registers
 * (ST-DOC-001, ST-DOC-002), the verification of PDF signatures (ST-DOC-003) and the outgoing documents with leader signing,
 * numbering and the organisation seal (ST-DOC-005), the template library with its separated legal confirmation
 * (ST-DOC-006), the composing, review and lock of outgoing documents (ST-DOC-007) and the issue-request and document-reference ports for source
 * modules (ST-DOC-008), the documents signed outside the system (ST-DOC-009, the production path while no certification authority sandbox exists) and
 * the verify-and-issue gate with the distribution of an issued document to its recipients (ST-DOC-010) and the recall of an issued document with the voiding
 * of the number of one that cannot be sealed (ST-DOC-012). The incoming documents (ST-DOC-011) are received, registered, assigned, worked and resolved here, and the dossiers they are filed in join it in a later slice.
 */
export const docModule = defineModule({
  code: 'DOC',
  controllers: [
    IncomingController,
    IncomingReadsController,
    DossiersController,
    DossierReadsController,
    DocumentOverviewController,
    DocumentsController,
    DocumentVersionReadsController,
    OutgoingController,
    OutgoingDraftsController,
    IssueRequestsController,
    SignedDocumentsController,
    DocumentFilesController,
    RegistersController,
    SignaturesController,
    DocumentTemplatesController,
    LayoutProfilesController,
    OutgoingIssuanceController,
    DocumentDistributionsController,
    OutgoingRecallController,
    OutgoingSupersessionController,
  ],
  providers: [
    // The object storage of the platform replaces the in-memory adapter when it is bound (KERNEL-024).
    { provide: DOCUMENT_FILE_PORT, useValue: new MockDocumentFilePort() },
    // Fonts and fixed texts are read when the application starts, not when this file is imported.
    { provide: DOC_RESOURCES, useFactory: (): RendererResources => loadRendererResources() },
    { provide: PDF_RENDERER, useFactory: (resources: RendererResources): PdfLibRenderer => new PdfLibRenderer(resources), inject: [DOC_RESOURCES] },
    // The trust anchors per regime come from the directory named by MACHVON_TRUST_ANCHORS_DIR (none: nothing is trusted).
    { provide: DOC_TRUST_STORE, useFactory: () => new StaticTrustStoreProvider(loadTrustAnchors(process.env.MACHVON_TRUST_ANCHORS_DIR)) },
    // No OCSP/CRL adapter exists yet: revocation then reads UNKNOWN, which the report shows as INDETERMINATE.
    { provide: DOC_REVOCATION, useValue: new UnavailableRevocationPort() },
    // No certification authority adapter exists yet (DOC-SPK-01): signing answers PROVIDER_UNAVAILABLE until one is bound.
    { provide: DOC_SIGNING_PORT, useValue: new UnconfiguredSigningPort() },
    // No mail transport exists yet: an email distribution is FAILED with the reason and can be sent again once an adapter is bound.
    { provide: DOC_EMAIL_CHANNEL, useValue: new UnconfiguredEmailChannel() },
    { provide: DOC_STATE_TEXT, useFactory: (resources: RendererResources) => resources.text, inject: [DOC_RESOURCES] },
    // The port that source modules ask for documents through; the event consumer of the workers uses the same instance.
    {
      provide: DocumentIssueService,
      useFactory: (files: DocumentFilePort, metrics?: MetricsSink, clock?: () => Date) => new DocumentIssueService(files, metrics, clock),
      inject: [DOCUMENT_FILE_PORT, { token: DOC_METRICS, optional: true }, { token: DOC_CLOCK, optional: true }],
    },
  ],
});
