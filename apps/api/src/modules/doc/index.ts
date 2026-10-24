import { defineModule } from '../module-descriptor';
import { DocumentVersionReadsController, DocumentsController } from './documents.controller';
import { DOCUMENT_FILE_PORT, MockDocumentFilePort } from './file-port';
import { OutgoingController } from './outgoing.controller';
import { PdfLibRenderer, loadRendererResources } from './pdf-renderer';
import type { RendererResources } from './pdf-renderer';
import { RegistersController } from './registers.controller';
import { SignaturesController } from './signatures.controller';
import { UnconfiguredSigningPort } from './signing-adapters';
import { DocumentTemplatesController } from './templates.controller';
import { DOC_RESOURCES, DOC_REVOCATION, DOC_SIGNING_PORT, DOC_STATE_TEXT, DOC_TRUST_STORE, PDF_RENDERER } from './tokens';
import { StaticTrustStoreProvider, UnavailableRevocationPort, loadTrustAnchors } from './trust-anchors';

/**
 * DOC, documents: the anchor and file versions, deterministic PDF rendering, document types and number registers
 * (ST-DOC-001, ST-DOC-002), the verification of PDF signatures (ST-DOC-003) and the outgoing documents with leader signing,
 * numbering and the organisation seal (ST-DOC-005) and the template library with its separated legal confirmation
 * (ST-DOC-006). The issue, delivery and incoming flows join it in later slices.
 */
export const docModule = defineModule({
  code: 'DOC',
  controllers: [DocumentsController, DocumentVersionReadsController, OutgoingController, RegistersController, SignaturesController, DocumentTemplatesController],
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
    { provide: DOC_STATE_TEXT, useFactory: (resources: RendererResources) => resources.text, inject: [DOC_RESOURCES] },
  ],
});
