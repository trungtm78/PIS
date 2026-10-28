import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_FILTER } from '@nestjs/core';
import { DocumentStore, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import type { MetricsSink } from '@machvon/kernel';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import type { TrustAnchor } from '../../src/modules/doc/cms-verification';
import type { RevocationAnswer } from '../../src/modules/doc/pades-verifier';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { DocumentVersionReadsController, DocumentsController } from '../../src/modules/doc/documents.controller';
import { DOCUMENT_FILE_PORT, MockDocumentFilePort } from '../../src/modules/doc/file-port';
import { PdfLibRenderer, loadRendererResources } from '../../src/modules/doc/pdf-renderer';
import { IncomingController, IncomingReadsController } from '../../src/modules/doc/incoming.controller';
import { OutgoingController } from '../../src/modules/doc/outgoing.controller';
import { OutgoingDraftsController } from '../../src/modules/doc/outgoing-drafts.controller';
import { IssueRequestsController } from '../../src/modules/doc/issue-requests.controller';
import { DocumentFilesController } from '../../src/modules/doc/document-files.controller';
import { SignedDocumentsController } from '../../src/modules/doc/signed-documents.controller';
import { DocumentDistributionsController } from '../../src/modules/doc/distributions.controller';
import { OutgoingIssuanceController } from '../../src/modules/doc/issuance.controller';
import { OutgoingRecallController } from '../../src/modules/doc/recall.controller';
import type { EmailChannelPort, EmailDelivery, EmailReceipt } from '../../src/modules/doc/distribution-channel';
import { FileService } from '../../src/modules/files/file.service';
import { FsObjectStorage } from '../../src/modules/files/fs-object-storage';
import { MockScanPort } from '../../src/modules/files/mock-scan';
import { DocumentIssueService } from '../../src/modules/doc/issue-request.service';
import { RegistersController } from '../../src/modules/doc/registers.controller';
import { MockSigningDirectory } from '../../src/modules/doc/signing-adapters';
import { SignaturesController } from '../../src/modules/doc/signatures.controller';
import { DOC_CLOCK, DOC_EMAIL_CHANNEL, DOC_METRICS, DOC_REVOCATION, DOC_SIGNING_PORT, DOC_STATE_TEXT, DOC_TRUST_STORE, PDF_RENDERER } from '../../src/modules/doc/tokens';
import { ACTOR, AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

export const SIGNING_KEY = randomBytes(32);
export const NOW = new Date('2026-10-23T03:00:00Z');

/** Members of tenant A. */
export const ADMIN = 1; // every document permission on the whole tenant
export const UNIT_TWO_CLERK = 2; // register and document reads/manage on the subtree of unit 2 only
export const NOBODY = 3; // no grant
export const RENDERER_ONLY = 4; // doc.render only
export const DRAFTER = 5; // reads outgoing documents and holds the signing permission, but drafts documents
export const LEADER = 6; // signs outgoing documents of unit 2
export const CLERK = 7; // numbers and seals the outgoing documents of unit 2
export const MAKER = 8; // drafts, edits, submits and cancels outgoing documents of unit 2, and may review (a head of department who drafts too)
export const REVIEWER = 9; // reviews, returns and cancels the outgoing documents of unit 2
export const BOARD = 10; // signs the documents of the high DoA band in unit 2
export const SOURCE = 11; // a source module: asks for documents and checks references over the whole tenant
export const SOURCE_UNIT = 12; // the same permissions, on the subtree of unit 2 only
export const REFERENCER = 13; // only checks whether a document may be relied on, on the whole tenant
export const EXT_CLERK = 14; // takes in documents signed outside the system, for unit 2 and below
export const EXT_OUTSIDE = 15; // the same permissions, but only on unit 1 itself: nothing drafted in unit 2 is in their reach
export const ISSUER = 16; // issues sealed documents of unit 2 (a records clerk), without the right to distribute or to confirm templates
export const DISTRIBUTOR = 17; // distributes issued documents of unit 2 and records the receipts
export const LEGAL_ISSUER = 18; // issues over unit 2 and holds the right to confirm templates on the whole tenant
export const LEGAL_UNIT = 19; // the same two rights, but the right to confirm templates only over unit 2: not a tenant-wide authority
export const ISSUER_DISTRIBUTOR = 20; // issues and distributes in unit 2
export const RECALLER = 21; // recalls the issued documents of unit 2 (a leader)
export const RECORDS_MANAGER = 22; // voids the numbers of the documents of unit 2 and may approve a void
export const SECOND_MANAGER = 23; // the same right: the second person of a void
export const OUTSIDE_MANAGER = 24;
export const INCOMING_CLERK = 25; // receives, registers and rejects the incoming documents of unit 2 and reads them
export const INCOMING_CHIEF = 26; // assigns the incoming documents of unit 2 (the chief of the office)
export const INCOMING_STAFF = 27; // works the incoming documents given to them in unit 2
export const INCOMING_STAFF_TWO = 28; // the same right, for letters that are not given to them
export const INCOMING_OUTSIDE = 29; // the same rights as the clerk, but only on unit 1 itself // the same right, but only on unit 1 itself: nothing of unit 2 is in their reach and they cannot approve a void there

export interface Reply {
  status: number;
  headers: Headers;
  json: Record<string, unknown>;
}

export interface MetricEvent {
  name: string;
  labels: Record<string, string> | undefined;
}

export class DocApp {
  readonly harness = new AuthzHarness();
  readonly files = new MockDocumentFilePort();
  readonly metrics: MetricEvent[] = [];
  readonly gauges: Array<MetricEvent & { value: number }> = [];
  /** The trust anchors every tenant verifies against; tests set them before they verify. */
  anchors: TrustAnchor[] = [];
  /** The signing adapter: one MOCK identity per certificate, registered by the tests that sign. */
  readonly signing = new MockSigningDirectory();
  /** The instant of the document module's clock; tests move it to let a session run out. */
  now = NOW;
  /** What the revocation port answers when a verification asks for it. */
  revocationAnswer: RevocationAnswer = { status: 'GOOD' };
  /** The messages the email channel was asked to send, and what it answers: a receipt, or the failure to throw. */
  readonly emailSent: EmailDelivery[] = [];
  emailBehaviour: EmailReceipt | Error = { outcome: 'SENT', externalRef: 'MAIL-1' };
  app!: RunningApp;
  layoutProfileId = '';
  templateId = '';
  /** The shared upload pipeline (stored on a temporary folder, scanned by the MOCK scanner): files come in through it, as they do in production. */
  uploads!: FileService;
  /** The storage under the pipeline: a test can put an object that was never scanned (PENDING). */
  objects!: FsObjectStorage;
  private objectRoot = '';

  async start(): Promise<void> {
    const { harness } = this;
    await harness.start();
    this.objectRoot = await mkdtemp(join(tmpdir(), 'machvon-doc-objects-'));
    this.objects = new FsObjectStorage(this.objectRoot);
    this.uploads = new FileService({ storage: this.objects, scanner: new MockScanPort(), urlSecret: randomBytes(32), now: () => this.now });
    await harness.seedUnits(TENANT_A, [
      { n: 1, path: `/${unitId(1)}/` },
      { n: 2, path: `/${unitId(1)}/${unitId(2)}/`, parent: 1 },
    ]);
    await harness.seedUnits(TENANT_B, [{ n: 1, path: `/${unitId(1)}/` }]);
    for (const n of [
      ADMIN,
      UNIT_TWO_CLERK,
      NOBODY,
      RENDERER_ONLY,
      DRAFTER,
      LEADER,
      CLERK,
      MAKER,
      REVIEWER,
      BOARD,
      SOURCE,
      SOURCE_UNIT,
      REFERENCER,
      EXT_CLERK,
      EXT_OUTSIDE,
      ISSUER,
      DISTRIBUTOR,
      LEGAL_ISSUER,
      LEGAL_UNIT,
      ISSUER_DISTRIBUTOR,
      RECALLER,
      RECORDS_MANAGER,
      SECOND_MANAGER,
      OUTSIDE_MANAGER,
      INCOMING_CLERK,
      INCOMING_CHIEF,
      INCOMING_STAFF,
      INCOMING_STAFF_TWO,
      INCOMING_OUTSIDE,
    ])
      await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, ADMIN, 1);
    const all = ['doc.render', 'doc.type.manage', 'doc.outgoing.read', 'document_version.read', 'doc.register.manage', 'doc.register.read', 'doc.signature.verify', 'doc.signature.read', 'doc.file.upload'];
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedRole(tenant, 1, 'DOC_ADMIN', all, 60);
      await harness.seedGrants(tenant, [{ n: 1, member: ADMIN, role: 1, kind: 'TENANT' }]);
    }
    await harness.seedRole(TENANT_A, 2, 'DOC_CLERK', ['doc.outgoing.read', 'document_version.read', 'doc.register.manage', 'doc.register.read', 'doc.signature.read'], 30);
    await harness.seedRole(TENANT_A, 3, 'DOC_RENDERER', ['doc.render'], 20);
    await harness.seedRole(TENANT_A, 4, 'DOC_SIGNER', ['doc.outgoing.read', 'doc.outgoing.sign', 'document_version.read', 'doc.signature.read'], 40);
    await harness.seedRole(TENANT_A, 5, 'DOC_SEALER', ['doc.outgoing.read', 'doc.outgoing.sign', 'doc.outgoing.number', 'doc.outgoing.seal', 'doc.outgoing.void_number', 'doc.register.read', 'document_version.read'], 30);
    await harness.seedRole(TENANT_A, 6, 'DOC_MAKER', ['doc.outgoing.read', 'doc.outgoing.create', 'doc.outgoing.edit', 'doc.outgoing.submit', 'doc.outgoing.cancel', 'doc.outgoing.review', 'doc.render'], 30);
    await harness.seedRole(TENANT_A, 7, 'DOC_REVIEWER', ['doc.outgoing.read', 'doc.outgoing.review', 'doc.outgoing.cancel', 'document_version.read'], 40);
    await harness.seedRole(TENANT_A, 8, 'DOC_BOARD', ['doc.outgoing.read', 'doc.outgoing.sign'], 50);
    await harness.seedRole(TENANT_A, 9, 'DOC_SOURCE', ['doc.issue.request', 'doc.reference.check'], 30);
    await harness.seedRole(TENANT_A, 10, 'DOC_REFERENCER', ['doc.reference.check'], 20);
    await harness.seedRole(TENANT_A, 11, 'DOC_EXTERNAL_CLERK', ['doc.outgoing.read', 'doc.outgoing.upload_signed', 'doc.outgoing.register_external', 'doc.file.upload', 'doc.register.read'], 30);
    await harness.seedRole(TENANT_A, 12, 'DOC_ISSUER', ['doc.outgoing.read', 'doc.outgoing.issue', 'document_version.read'], 30);
    await harness.seedRole(TENANT_A, 13, 'DOC_DISTRIBUTOR', ['doc.outgoing.read', 'doc.distribution.manage'], 30);
    await harness.seedRole(TENANT_A, 14, 'DOC_LEGAL_ISSUER', ['doc.outgoing.read', 'doc.outgoing.issue', 'doc.template.confirm_legal'], 40);
    await harness.seedRole(TENANT_A, 15, 'DOC_ISSUER_DISTRIBUTOR', ['doc.outgoing.read', 'doc.outgoing.issue', 'doc.distribution.manage'], 30);
    await harness.seedRole(TENANT_A, 16, 'DOC_RECALLER', ['doc.outgoing.read', 'doc.outgoing.recall'], 40);
    await harness.seedRole(TENANT_A, 17, 'DOC_RECORDS_MANAGER', ['doc.outgoing.read', 'doc.outgoing.void_number', 'doc.register.read'], 40);
    await harness.seedRole(TENANT_A, 18, 'DOC_INCOMING_CLERK', ['doc.incoming.receive', 'doc.incoming.register', 'doc.incoming.read', 'doc.file.upload', 'document_version.read', 'doc.outgoing.read'], 30);
    await harness.seedRole(TENANT_A, 19, 'DOC_INCOMING_CHIEF', ['doc.incoming.assign', 'doc.incoming.read'], 40);
    await harness.seedRole(TENANT_A, 20, 'DOC_INCOMING_STAFF', ['doc.incoming.process', 'doc.incoming.read', 'document_version.read', 'doc.outgoing.read'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 30, member: INCOMING_CLERK, role: 18, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 31, member: INCOMING_CHIEF, role: 19, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 32, member: INCOMING_STAFF, role: 20, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 33, member: INCOMING_STAFF_TWO, role: 20, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 34, member: INCOMING_OUTSIDE, role: 18, kind: 'UNIT_ONLY', refs: [unitId(1)] },
      { n: 35, member: INCOMING_OUTSIDE, role: 19, kind: 'UNIT_ONLY', refs: [unitId(1)] },
      { n: 20, member: RECALLER, role: 16, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 21, member: RECORDS_MANAGER, role: 17, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 22, member: SECOND_MANAGER, role: 17, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 23, member: OUTSIDE_MANAGER, role: 17, kind: 'UNIT_ONLY', refs: [unitId(1)] },
      { n: 15, member: ISSUER, role: 12, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 16, member: DISTRIBUTOR, role: 13, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 17, member: LEGAL_ISSUER, role: 14, kind: 'TENANT' },
      { n: 18, member: LEGAL_UNIT, role: 14, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 19, member: ISSUER_DISTRIBUTOR, role: 15, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 2, member: UNIT_TWO_CLERK, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 7, member: MAKER, role: 6, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 8, member: REVIEWER, role: 7, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 9, member: BOARD, role: 8, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 10, member: SOURCE, role: 9, kind: 'TENANT' },
      { n: 11, member: SOURCE_UNIT, role: 9, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 12, member: REFERENCER, role: 10, kind: 'TENANT' },
      { n: 13, member: EXT_CLERK, role: 11, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 14, member: EXT_OUTSIDE, role: 11, kind: 'UNIT_ONLY', refs: [unitId(1)] },
      { n: 3, member: RENDERER_ONLY, role: 3, kind: 'TENANT' },
      { n: 4, member: DRAFTER, role: 4, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 5, member: LEADER, role: 4, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 6, member: CLERK, role: 5, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
    ]);
    const seeded = await harness.tenants.withTenant(contextFor(TENANT_A, memberId(ADMIN)), (tx) => new DocumentStore().seedDefaults(tx, ACTOR));
    this.layoutProfileId = seeded.layoutProfileId;
    this.templateId = seeded.templateId;
    const tenants = harness.tenants as TenantDatabase;
    const resources = loadRendererResources();
    const sink: MetricsSink = {
      increment: (name, labels) => {
        this.metrics.push({ name, labels });
      },
      gauge: (name, value, labels) => {
        this.gauges.push({ name, value, labels });
      },
    };
    this.app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [
        DocumentsController,
        DocumentVersionReadsController,
        OutgoingController,
        OutgoingDraftsController,
        IssueRequestsController,
        SignedDocumentsController,
        DocumentFilesController,
        RegistersController,
        SignaturesController,
        OutgoingIssuanceController,
        DocumentDistributionsController,
        OutgoingRecallController,
        IncomingController,
        IncomingReadsController,
      ],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: DOCUMENT_FILE_PORT, useValue: this.files },
        { provide: PDF_RENDERER, useValue: new PdfLibRenderer(resources) },
        { provide: DOC_STATE_TEXT, useValue: resources.text },
        { provide: DOC_METRICS, useValue: sink },
        { provide: DocumentIssueService, useValue: new DocumentIssueService(this.files, sink, () => this.now) },
        { provide: FileService, useValue: this.uploads },
        { provide: DOC_CLOCK, useValue: () => this.now },
        { provide: DOC_SIGNING_PORT, useValue: this.signing },
        { provide: DOC_TRUST_STORE, useValue: { forTenant: async () => ({ anchors: () => this.anchors }) } },
        {
          provide: DOC_EMAIL_CHANNEL,
          useValue: {
            send: async (request: EmailDelivery): Promise<EmailReceipt> => {
              this.emailSent.push(request);
              if (this.emailBehaviour instanceof Error) throw this.emailBehaviour;
              return this.emailBehaviour;
            },
          } satisfies EmailChannelPort,
        },
        { provide: DOC_REVOCATION, useValue: { check: async (): Promise<RevocationAnswer> => this.revocationAnswer } },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }

  async stop(): Promise<void> {
    if (this.app) await this.app.close();
    await this.harness.stop();
    if (this.objectRoot !== '') await rm(this.objectRoot, { recursive: true, force: true });
  }

  async call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const token = signTenantContext({ tenantId: options.tenantId ?? TENANT_A, membershipId: memberId(options.member), scopeVersion: 1 }, SIGNING_KEY);
    const headers: Record<string, string> = { [TENANT_HEADER]: token, 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${this.app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> };
  }

  /** A multipart upload the way the screen sends it: one file field, the tenant token and an idempotency key. */
  async upload(url: string, options: { member: number; bytes: Uint8Array; tenantId?: string; type?: string; key?: string; name?: string }): Promise<Reply> {
    const token = signTenantContext({ tenantId: options.tenantId ?? TENANT_A, membershipId: memberId(options.member), scopeVersion: 1 }, SIGNING_KEY);
    const form = new FormData();
    form.append('file', new Blob([options.bytes], { type: options.type ?? 'application/pdf' }), options.name ?? 'document.pdf');
    const response = await fetch(`${this.app.baseUrl}${url}`, { method: 'POST', headers: { [TENANT_HEADER]: token, 'idempotency-key': options.key ?? `key-${randomUUID()}` }, body: form });
    return { status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> };
  }

  async count(sql: string, params: unknown[] = [], tenantId: string = TENANT_A): Promise<number> {
    return Number((await this.harness.owner<{ n: string }>(tenantId, [[sql, params]]))[0]?.n);
  }
}

export { ACTOR, TENANT_A, TENANT_B, memberId, unitId };
