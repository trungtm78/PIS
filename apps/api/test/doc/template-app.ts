import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { DocumentStore, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { DocumentVersionReadsController, DocumentsController } from '../../src/modules/doc/documents.controller';
import { DOCUMENT_FILE_PORT, MockDocumentFilePort } from '../../src/modules/doc/file-port';
import { PdfLibRenderer, loadRendererResources } from '../../src/modules/doc/pdf-renderer';
import { LayoutProfilesController } from '../../src/modules/doc/layout-profiles.controller';
import { DocumentTemplatesController } from '../../src/modules/doc/templates.controller';
import { loadPlatformTemplates } from '../../src/modules/doc/template-pack';
import { DOC_STATE_TEXT, PDF_RENDERER } from '../../src/modules/doc/tokens';
import { ACTOR, AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

export const SIGNING_KEY = randomBytes(32);

/** Members of tenant A: the three steps of a template are held by three different people (and a few who hold none). */
export const ADMIN = 1; // drafts, retires and publishes templates, but cannot record the legal confirmation
export const AUTHOR = 2; // publishes templates (doc.template.approve) and reads them
export const LEGAL = 3; // records the legal confirmation and reads templates
export const READER = 4; // reads templates only
export const RENDERER = 5; // renders documents
export const NOBODY = 6; // no grant
export const SECOND_LEGAL = 7; // holds every template permission: used to prove that nobody takes two steps on one revision
export const BRANCH = 8; // holds every template permission, but only over a branch of the organisation tree (the library belongs to the whole tenant)

export interface Reply {
  status: number;
  headers: Headers;
  json: Record<string, unknown>;
}

export const BLOCKS = {
  blocks: [
    { kind: 'heading', text: '{{title}}' },
    { kind: 'paragraph', text: '{{body}}' },
  ],
};

export class TemplateApp {
  readonly harness = new AuthzHarness();
  readonly files = new MockDocumentFilePort();
  app!: RunningApp;
  layoutProfileId = '';
  evidenceDocumentId = '';

  async start(): Promise<void> {
    const { harness } = this;
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: 1, path: `/${unitId(1)}/` }]);
    await harness.seedUnits(TENANT_B, [{ n: 1, path: `/${unitId(1)}/` }]);
    for (const n of [ADMIN, AUTHOR, LEGAL, READER, RENDERER, NOBODY, SECOND_LEGAL, BRANCH]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, ADMIN, 1);
    await harness.seedRole(TENANT_A, 1, 'TEMPLATE_ADMIN', ['doc.template.manage', 'doc.template.approve', 'doc.template.read', 'doc.layout.manage'], 60);
    await harness.seedRole(TENANT_A, 2, 'TEMPLATE_PUBLISHER', ['doc.template.approve', 'doc.template.read', 'doc.layout.approve'], 50);
    await harness.seedRole(TENANT_A, 3, 'LEGAL_OFFICER', ['doc.template.confirm_legal', 'doc.template.read'], 50);
    await harness.seedRole(TENANT_A, 4, 'TEMPLATE_READER', ['doc.template.read'], 20);
    await harness.seedRole(TENANT_A, 5, 'DOC_RENDERER', ['doc.render'], 20);
    await harness.seedRole(TENANT_A, 6, 'TEMPLATE_ALL', ['doc.template.manage', 'doc.template.approve', 'doc.template.confirm_legal', 'doc.template.read', 'doc.layout.manage', 'doc.layout.approve'], 60);
    await harness.seedRole(TENANT_B, 1, 'TEMPLATE_ALL', ['doc.template.manage', 'doc.template.approve', 'doc.template.confirm_legal', 'doc.template.read', 'doc.render', 'doc.layout.manage', 'doc.layout.approve'], 60);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ADMIN, role: 1, kind: 'TENANT' },
      { n: 2, member: AUTHOR, role: 2, kind: 'TENANT' },
      { n: 3, member: LEGAL, role: 3, kind: 'TENANT' },
      { n: 4, member: READER, role: 4, kind: 'TENANT' },
      { n: 5, member: RENDERER, role: 5, kind: 'TENANT' },
      { n: 6, member: SECOND_LEGAL, role: 6, kind: 'TENANT' },
      { n: 7, member: BRANCH, role: 6, kind: 'UNIT_SUBTREE', refs: [unitId(1)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: ADMIN, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    const documents = new DocumentStore();
    // Each tenant starts with the layout profile of Decree 30/2020, waiting for its confirmation like the pack templates.
    const seeded = await tenants.withTenant(contextFor(TENANT_A, memberId(ADMIN)), (tx) => documents.seedDefaults(tx, ACTOR));
    this.layoutProfileId = seeded.layoutProfileId;
    await tenants.withTenant(contextFor(TENANT_B, memberId(ADMIN)), (tx) => documents.seedDefaults(tx, ACTOR));
    this.evidenceDocumentId = (
      await tenants.withTenant(contextFor(TENANT_A, memberId(LEGAL)), (tx) =>
        documents.insertDocument(tx, { docKind: 'REFERENCE', docTypeCode: 'QD', title: 'Legal opinion', classification: 'INTERNAL', createdBy: memberId(LEGAL) }),
      )
    ).id;
    const resources = loadRendererResources();
    this.app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [DocumentsController, DocumentVersionReadsController, DocumentTemplatesController, LayoutProfilesController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: DOCUMENT_FILE_PORT, useValue: this.files },
        { provide: PDF_RENDERER, useValue: new PdfLibRenderer(resources) },
        { provide: DOC_STATE_TEXT, useValue: resources.text },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }

  async stop(): Promise<void> {
    if (this.app) await this.app.close();
    await this.harness.stop();
  }

  /** Loads the platform pack into tenant A the way provisioning would. */
  loadPack(): ReturnType<typeof loadPlatformTemplates> {
    return this.harness.tenants.withTenant(contextFor(TENANT_A, memberId(ADMIN)), (tx) => loadPlatformTemplates(tx, memberId(ADMIN)));
  }

  /** Confirms or un-confirms the layout profile of a tenant as its owner: a render is watermarked while the profile or the template waits. */
  setLayoutConfirmed(confirmed: boolean, tenantId: string = TENANT_A): Promise<unknown> {
    return this.harness.owner(tenantId, [
      [
        'update machvon.document_layout_profile set confirmation_status = $2, legal_confirmation_ref = $3 where profile_code = $1',
        ['ND30_A4_STANDARD', confirmed ? 'CONFIRMED' : 'PENDING_CONFIRMATION', confirmed ? 'CXN-DOC-01' : null],
      ],
    ]);
  }

  async call(
    method: 'GET' | 'POST',
    url: string,
    options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string; headers?: Record<string, string> },
  ): Promise<Reply> {
    const token = signTenantContext({ tenantId: options.tenantId ?? TENANT_A, membershipId: memberId(options.member), scopeVersion: 1 }, SIGNING_KEY);
    const headers: Record<string, string> = { [TENANT_HEADER]: token, 'content-type': 'application/json', ...options.headers };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${this.app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> };
  }

  async count(sql: string, params: unknown[] = [], tenantId: string = TENANT_A): Promise<number> {
    return Number((await this.harness.owner<{ n: string }>(tenantId, [[sql, params]]))[0]?.n);
  }
}

export { ACTOR, TENANT_A, TENANT_B, memberId, unitId };
