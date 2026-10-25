import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_FILTER } from '@nestjs/core';
import { PDFDocument } from 'pdf-lib';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { bidModule } from '../../src/modules/bid';
import { ConflictController } from '../../src/modules/bid/conflict.controller';
import { ProposalController, ProposalReadsController } from '../../src/modules/bid/proposal.controller';
import { FileService } from '../../src/modules/files/file.service';
import { FsObjectStorage } from '../../src/modules/files/fs-object-storage';
import { MockScanPort, eicarBytes } from '../../src/modules/files/mock-scan';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { hoursFromNow, seedAs, seedContractor, seedMilestone } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const CLERK = 1; // bid.proposal.receive, proposal.read, bid.read over the tenant
const DEPARTMENT_CLERK = 2; // the same over the unit tree of the department
const ELSEWHERE_CLERK = 3; // the same over another branch
const E1 = 4; // bid.evaluate, proposal.read, bid.read over the tenant
const E2 = 5;
const E4 = 6; // bid.evaluate and bid.conflict.decide: may decide, but not his own declaration
const APPROVER = 7; // bid.conflict.decide, bid.read
const READER = 8; // proposal.read only
const NOBODY = 9;
const DEPARTMENT_EVALUATOR = 10; // bid.evaluate over the unit tree of the department
const B_CLERK = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const FAMILY = 0x96;
const REASON = 'The relation was examined by the authority and recorded.';
const RELATION = 'The director of NT-1 is a cousin of mine.';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const shaOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
let pdfCounter = 0;
/** A small PDF that is different from every other one made here. */
async function pdfBytes(extra?: string): Promise<Uint8Array> {
  pdfCounter += 1;
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Bid volume ${pdfCounter} ${randomUUID()}`);
  if (extra !== undefined) pdf.setSubject(extra);
  pdf.addPage();
  pdf.addPage();
  return pdf.save();
}

describe('the sealed proposal and the declaration of conflict of interest (ST-BID-004)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let root: string;
  let files: FileService;
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const audits = (resourceId: string, action: string) =>
    rows<{ safe_diff: Record<string, unknown>; outcome: string; actor_id: string; reason: string | null; classification: string }>(
      'select safe_diff, outcome, actor_id, reason, classification from machvon.audit_event where resource_id = $1 and action = $2',
      [resourceId, action],
    );
  const events = (aggregateId: string, type: string) =>
    rows<{ payload: Record<string, unknown>; aggregate_version: string }>('select payload, aggregate_version::text as aggregate_version from machvon.outbox_event where aggregate_id = $1 and type = $2 order by aggregate_version', [aggregateId, type]);

  interface Seeded {
    projectId: string;
    packageId: string;
    code: string;
  }

  /** An approved package of a project of the department whose bids close in 36 hours and open in 48. */
  async function seedPackage(options: { status?: string; unit?: number; opening?: string | null; closing?: string | null } = {}): Promise<Seeded> {
    counter += 1;
    const projectId = randomUUID();
    const packageId = randomUUID();
    const code = `GT-${String(counter).padStart(4, '0')}`;
    await seedAs(harness, [
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, 'Procurement project', $4, $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, `PRJ-${counter}-${projectId.slice(0, 4)}`, unitId(options.unit ?? DEPARTMENT), unitId(ROOT), id(FAMILY, 90)],
      ],
      [
        `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, title, created_by, version)
         values ($1, $2, $3, $4, 1000000000, 'OPEN_BIDDING', 1, $5, 'Construction package', $6, 1)`,
        [TENANT_A, packageId, projectId, code, options.status ?? 'APPROVED', memberId(CLERK)],
      ],
    ]);
    if (options.opening !== null) await seedMilestone(harness, packageId, 'BID_OPENING', { planned: options.opening ?? hoursFromNow(48) });
    if (options.closing !== null) await seedMilestone(harness, packageId, 'BID_CLOSING', { planned: options.closing ?? hoursFromNow(36) });
    return { projectId, packageId, code };
  }

  /** A PDF put through the upload door as a clerk would. */
  async function uploadDoor(member: number, bytes: Uint8Array, type = 'application/pdf'): Promise<Reply> {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type }), 'volume.pdf');
    const response = await fetch(`${app.baseUrl}/proposals/files`, { method: 'POST', headers: { [TENANT_HEADER]: tokenOf(member), 'idempotency-key': `key-${randomUUID()}` }, body: form });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  /** The documents of a proposal: PDFs through the pipeline, named by key and digest as the door answers. */
  async function documentsOf(n = 1, tenantId = TENANT_A): Promise<Array<{ part: string; title: string; file_object_key: string; file_sha256: string }>> {
    const parts = ['TECHNICAL', 'FINANCIAL', 'LEGAL', 'OTHER'];
    const made = [];
    for (let i = 0; i < n; i += 1) {
      const bytes = await pdfBytes();
      const stored = await files.upload({ tenantId, membershipId: memberId(CLERK), scopeVersion: 1 }, { purpose: 'document', declaredType: 'application/pdf', bytes });
      expect(stored.scanStatus).toBe('CLEAN');
      made.push({ part: parts[i % parts.length] as string, title: `Volume ${i + 1}`, file_object_key: stored.key, file_sha256: shaOf(bytes) });
    }
    return made;
  }

  const receive = async (member: number, seeded: Seeded, contractorId: string, overrides: Record<string, unknown> = {}, extra: { key?: string; tenantId?: string } = {}): Promise<Reply> =>
    call('POST', '/proposals', {
      member,
      ...extra,
      body: { package_id: seeded.packageId, contractor_id: contractorId, submitted_at: hoursFromNow(-1), bid_price_vnd: '900000000', documents: await documentsOf(2), ...overrides },
    });
  const declare = (member: number, packageId: string, body: Record<string, unknown>): Promise<Reply> => call('POST', `/procurement-packages/${packageId}/conflict-declarations`, { member, body });
  const decide = (member: number, declarationId: string, version: number | string, body: Record<string, unknown>): Promise<Reply> =>
    call('POST', `/bid-conflict-declarations/${declarationId}/decision`, { member, ifMatch: `"${version}"`, body });
  const open = (packageId: string) =>
    rows(`update machvon.procurement_milestone set planned_at = now() - interval '1 hour' where package_id = $1::uuid and milestone_kind = 'BID_OPENING'`, [packageId]).then(() =>
      rows(`update machvon.procurement_milestone set planned_at = now() - interval '2 hours' where package_id = $1::uuid and milestone_kind = 'BID_CLOSING'`, [packageId]),
    );

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'machvon-bid-proposal-'));
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
    }
    for (const n of [CLERK, DEPARTMENT_CLERK, ELSEWHERE_CLERK, E1, E2, E4, APPROVER, READER, NOBODY, DEPARTMENT_EVALUATOR]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_CLERK, ROOT);
    await harness.seedRole(TENANT_A, 1, 'BID_CLERK', ['bid.proposal.receive', 'proposal.read', 'bid.read'], 30);
    await harness.seedRole(TENANT_A, 2, 'BID_EVALUATOR', ['bid.evaluate', 'proposal.read', 'bid.read'], 30);
    await harness.seedRole(TENANT_A, 3, 'BID_EVALUATOR_AUTHORITY', ['bid.evaluate', 'bid.conflict.decide', 'proposal.read', 'bid.read'], 40);
    await harness.seedRole(TENANT_A, 4, 'BID_AUTHORITY', ['bid.conflict.decide', 'bid.read'], 40);
    await harness.seedRole(TENANT_A, 5, 'PROPOSAL_READER', ['proposal.read'], 10);
    await harness.seedRole(TENANT_B, 1, 'BID_CLERK', ['bid.proposal.receive', 'proposal.read', 'bid.read'], 30);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: CLERK, role: 1, kind: 'TENANT' },
      { n: 2, member: DEPARTMENT_CLERK, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 3, member: ELSEWHERE_CLERK, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
      { n: 4, member: E1, role: 2, kind: 'TENANT' },
      { n: 5, member: E2, role: 2, kind: 'TENANT' },
      { n: 6, member: E4, role: 3, kind: 'TENANT' },
      { n: 7, member: APPROVER, role: 4, kind: 'TENANT' },
      { n: 8, member: READER, role: 5, kind: 'TENANT' },
      { n: 9, member: DEPARTMENT_EVALUATOR, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_CLERK, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    files = new FileService({ storage: new FsObjectStorage(root), scanner: new MockScanPort(), urlSecret: randomBytes(32) });
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [ProposalController, ProposalReadsController, ConflictController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: FileService, useValue: files },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
    await rm(root, { recursive: true, force: true });
  }, 60_000);

  it('is registered in the module of BID', () => {
    for (const controller of [ProposalController, ProposalReadsController, ConflictController]) expect(bidModule.controllers).toContain(controller);
  });

  describe('uploadProposalFile', () => {
    it('stores a clean PDF and answers the key, the digest, the size and the pages, and audits it without the name of the file (AC-ST-BID-004-1)', async () => {
      const bytes = await pdfBytes();
      const done = await uploadDoor(CLERK, bytes);
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ file_sha256: shaOf(bytes), size_bytes: bytes.length, page_count: 2 });
      expect(String(done.json.file_object_key)).toMatch(new RegExp(`^tenants/${TENANT_A}/document/`));
      const [audit] = await rows<{ safe_diff: Record<string, unknown>; classification: string }>(
        `select safe_diff, classification from machvon.audit_event where action = 'bid.proposal_file_uploaded' and safe_diff->>'file_sha256' = $1`,
        [shaOf(bytes)],
      );
      expect(audit).toMatchObject({ safe_diff: { file_sha256: shaOf(bytes), size_bytes: bytes.length, page_count: 2 }, classification: 'CONFIDENTIAL' });
    });

    it('refuses what is not a PDF (422 UPLOAD_NOT_PDF), an infected file (422 FILE_NOT_CLEAN) and a type nobody accepts (422 FILE_TYPE_NOT_ALLOWED)', async () => {
      const text = await uploadDoor(CLERK, new TextEncoder().encode('Not a pdf at all'), 'text/plain');
      expect(text).toMatchObject({ status: 422, json: { code: 'UPLOAD_NOT_PDF' } });
      // The test string after the end of an otherwise sound PDF: the scanner finds it in the bytes, whatever the reader makes of the file.
      const infected = await uploadDoor(CLERK, Buffer.concat([await pdfBytes(), Buffer.from(eicarBytes())]));
      expect(infected).toMatchObject({ status: 422, json: { code: 'FILE_NOT_CLEAN' } });
      const exe = await uploadDoor(CLERK, new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]), 'application/x-msdownload');
      expect(exe).toMatchObject({ status: 422, json: { code: 'FILE_TYPE_NOT_ALLOWED' } });
    });

    it('is for whoever may receive proposals: an evaluator, a reader and a member without a grant are refused', async () => {
      const bytes = await pdfBytes();
      for (const member of [E1, READER, NOBODY]) expect((await uploadDoor(member, bytes)).status).toBe(403);
    });
  });

  describe('receiveProposal', () => {
    it('receives the proposal sealed, audits it and tells the world who sent it and how many files, never the price or a file (UAT-AC448 step 0)', async () => {
      const seeded = await seedPackage();
      const contractor = await seedContractor(harness);
      const received = await receive(CLERK, seeded, contractor);
      expect(received.status).toBe(200);
      expect(received.json).toMatchObject({ status: 'RECEIVED', resource_version: 1 });
      const proposalId = String(received.json.resource_id);
      const [stored] = await rows<{ status: string; classification: string; revision: number; created_by: string; bid_price_vnd: string }>('select status, classification, revision, created_by, bid_price_vnd::text from machvon.proposal where id = $1::uuid', [proposalId]);
      expect(stored).toEqual({ status: 'RECEIVED', classification: 'CONFIDENTIAL', revision: 1, created_by: memberId(CLERK), bid_price_vnd: '900000000' });
      const [audit] = await audits(proposalId, 'bid.proposal_received');
      expect(audit).toMatchObject({ outcome: 'SUCCESS', actor_id: memberId(CLERK), classification: 'CONFIDENTIAL', safe_diff: { package_code: seeded.code, contractor_id: contractor, revision: 1, file_count: 2, has_price: true, superseded_id: null } });
      expect(JSON.stringify(audit)).not.toContain('900000000');
      expect(JSON.stringify(audit)).not.toContain('tenants/');
      const [event] = await events(proposalId, 'bid.proposal.received.v1');
      expect(event?.payload).toMatchObject({ tenant_id: TENANT_A, proposal_id: proposalId, package_id: seeded.packageId, project_id: seeded.projectId, contractor_id: contractor, revision: 1, file_count: 2, actor_id: memberId(CLERK) });
      expect(JSON.stringify(event)).not.toContain('900000000');
      expect(event?.aggregate_version).toBe('1');
    });

    it('answers the same request with the same key once, and takes a new revision of the same contractor as a new proposal', async () => {
      const seeded = await seedPackage();
      const contractor = await seedContractor(harness);
      const body = { package_id: seeded.packageId, contractor_id: contractor, submitted_at: hoursFromNow(-1), documents: await documentsOf(1) };
      const first = await call('POST', '/proposals', { member: CLERK, key: 'same-key-for-one-proposal', body });
      const again = await call('POST', '/proposals', { member: CLERK, key: 'same-key-for-one-proposal', body });
      expect(again).toEqual(first);
      expect(Number((await rows<{ n: string }>('select count(*)::text as n from machvon.proposal where package_id = $1::uuid', [seeded.packageId]))[0]?.n)).toBe(1);
      const second = await receive(CLERK, seeded, contractor);
      expect(second.json).toMatchObject({ status: 'RECEIVED', resource_version: 1 });
      const states = await rows<{ revision: number; status: string }>('select revision, status from machvon.proposal where package_id = $1::uuid order by revision', [seeded.packageId]);
      expect(states).toEqual([
        { revision: 1, status: 'SUPERSEDED' },
        { revision: 2, status: 'RECEIVED' },
      ]);
      expect((await events(String(second.json.resource_id), 'bid.proposal.received.v1'))[0]?.payload).toMatchObject({ revision: 2, superseded_id: first.json.resource_id });
    });

    it('refuses without a date for the opening (BID_OPENING_UNSET), after the opening and after the closing (BID_CLOSED)', async () => {
      const contractor = await seedContractor(harness);
      expect(await receive(CLERK, await seedPackage({ opening: null }), contractor)).toMatchObject({ status: 422, json: { code: 'BID_OPENING_UNSET' } });
      expect(await receive(CLERK, await seedPackage({ opening: hoursFromNow(-1), closing: hoursFromNow(-2) }), contractor, { submitted_at: hoursFromNow(-5) })).toMatchObject({ status: 422, json: { code: 'BID_CLOSED' } });
      expect(await receive(CLERK, await seedPackage({ closing: hoursFromNow(-2) }), contractor)).toMatchObject({ status: 422, json: { code: 'BID_CLOSED' } });
    });

    it('refuses a contractor that is restricted or not verified, and a package that is not open for bids', async () => {
      const seeded = await seedPackage();
      expect(await receive(CLERK, seeded, await seedContractor(harness, { restricted: true }))).toMatchObject({ status: 422, json: { code: 'CONTRACTOR_RESTRICTED' } });
      expect(await receive(CLERK, seeded, await seedContractor(harness, { status: 'UNVERIFIED' }))).toMatchObject({ status: 422, json: { code: 'CONTRACTOR_NOT_VERIFIED' } });
      expect(await receive(CLERK, await seedPackage({ status: 'DRAFT' }), await seedContractor(harness))).toMatchObject({ status: 409, json: { code: 'PACKAGE_STATE_INVALID' } });
      expect(Number((await rows<{ n: string }>('select count(*)::text as n from machvon.proposal where package_id = $1::uuid', [seeded.packageId]))[0]?.n)).toBe(0);
    });

    it('refuses a file that is not the one the clerk named, one that is not a document upload, one of another tenant and one already attached', async () => {
      const seeded = await seedPackage();
      const contractor = await seedContractor(harness);
      const [mine = { part: 'TECHNICAL', title: 'x', file_object_key: '', file_sha256: '' }] = await documentsOf(1);
      expect(await receive(CLERK, seeded, contractor, { documents: [{ ...mine, file_sha256: 'a'.repeat(64) }] })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', reason: 'FILE_DIGEST_MISMATCH' } });
      const csvStored = await files.upload({ tenantId: TENANT_A, membershipId: memberId(CLERK), scopeVersion: 1 }, { purpose: 'import', declaredType: 'text/csv', bytes: new TextEncoder().encode('a,b\n1,2\n') });
      expect(await receive(CLERK, seeded, contractor, { documents: [{ ...mine, file_object_key: csvStored.key }] })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', reason: 'FILE_KEY_INVALID' } });
      expect(await receive(CLERK, seeded, contractor, { documents: [{ ...mine, file_object_key: 'not/a/key' }] })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      const [foreign = mine] = await documentsOf(1, TENANT_B);
      expect(await receive(CLERK, seeded, contractor, { documents: [foreign] })).toMatchObject({ status: 404 });
      const ok = await receive(CLERK, seeded, contractor, { documents: [mine] });
      expect(ok.status).toBe(200);
      const other = await seedContractor(harness);
      expect(await receive(CLERK, seeded, other, { documents: [mine] })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', reason: 'FILE_ALREADY_ATTACHED' } });
    });

    it('is for the clerk of the scope of the project: a clerk of another branch gets 404, an evaluator and a reader get 403 (UAT-AC448)', async () => {
      const seeded = await seedPackage();
      const contractor = await seedContractor(harness);
      expect(await receive(ELSEWHERE_CLERK, seeded, contractor)).toMatchObject({ status: 404 });
      expect((await receive(DEPARTMENT_CLERK, seeded, contractor)).status).toBe(200);
      for (const member of [E1, READER, NOBODY]) expect((await receive(member, seeded, contractor)).status).toBe(403);
    });
  });

  describe('reading a sealed proposal (AC-ST-BID-004-1, UAT-AC448)', () => {
    async function sealed() {
      const seeded = await seedPackage();
      const contractor = await seedContractor(harness, { name: 'NT-1 Builders' });
      const received = await receive(CLERK, seeded, contractor);
      expect(received.status).toBe(200);
      return { seeded, contractor, proposalId: String(received.json.resource_id) };
    }

    it('hides the proposal from an evaluator who declared before the opening (404), and shows the clerk the metadata and nothing else', async () => {
      const { seeded, contractor, proposalId } = await sealed();
      expect((await declare(E1, seeded.packageId, { has_conflict: false })).status).toBe(200);
      expect(await call('GET', `/resources/proposal/${proposalId}`, { member: E1 })).toMatchObject({ status: 404 });
      expect((await call('GET', `/resources/proposal?package_id=${seeded.packageId}`, { member: E1 })).json.items).toEqual([]);
      const clerk = await call('GET', `/resources/proposal/${proposalId}`, { member: CLERK });
      expect(clerk.status).toBe(200);
      expect(clerk.json).toEqual({
        id: proposalId,
        package: { id: seeded.packageId, code: seeded.code, title: 'Construction package' },
        project: { id: seeded.projectId, code: expect.any(String) },
        contractor: { id: contractor, legal_name: 'NT-1 Builders' },
        revision: 1,
        status: 'RECEIVED',
        submitted_at: expect.any(String),
        access_released_at: expect.any(String),
        locked: true,
        file_count: 2,
        classification: 'CONFIDENTIAL',
        access: 'METADATA',
        conflict_standing: 'UNDECLARED',
        version: 1,
      });
      const listed = await call('GET', `/resources/proposal?package_id=${seeded.packageId}`, { member: CLERK });
      expect((listed.json.items as Array<Record<string, unknown>>).map((item) => [item.id, item.access, 'bid_price_vnd' in item])).toEqual([[proposalId, 'METADATA', false]]);
    });

    it('shows the evaluator who declared the whole proposal after the opening, and records that they opened it', async () => {
      const { seeded, proposalId } = await sealed();
      expect((await declare(E1, seeded.packageId, { has_conflict: false })).status).toBe(200);
      await open(seeded.packageId);
      const full = await call('GET', `/resources/proposal/${proposalId}`, { member: E1 });
      expect(full.status).toBe(200);
      expect(full.json).toMatchObject({ id: proposalId, access: 'FULL', locked: false, conflict_standing: 'CLEAR', bid_price_vnd: '900000000', file_count: 2 });
      const documents = full.json.documents as Array<Record<string, unknown>>;
      expect(documents.map((document) => [document.part, document.title, document.mime, document.page_count]).sort()).toEqual([
        ['FINANCIAL', 'Volume 2', 'application/pdf', 2],
        ['TECHNICAL', 'Volume 1', 'application/pdf', 2],
      ]);
      expect(JSON.stringify(full.json)).not.toContain('tenants/');
      expect(JSON.stringify(full.json)).not.toContain('object_key');
      expect(JSON.stringify(full.json)).not.toContain('document_version_ids');
      const [opened] = await audits(proposalId, 'bid.proposal_opened');
      expect(opened).toMatchObject({ actor_id: memberId(E1), outcome: 'SUCCESS', classification: 'CONFIDENTIAL', safe_diff: { package_code: seeded.code, revision: 1, file_count: 2 } });
      // The clerk still sees the metadata and not the price.
      expect(await call('GET', `/resources/proposal/${proposalId}`, { member: CLERK })).toMatchObject({ status: 200, json: { access: 'METADATA', locked: false } });
    });

    it('asks the evaluator who has not declared to declare first (403 CONFLICT_UNDECLARED), and shows them the proposal as one that waits for it', async () => {
      const { seeded, proposalId } = await sealed();
      await open(seeded.packageId);
      expect(await call('GET', `/resources/proposal/${proposalId}`, { member: E2 })).toMatchObject({ status: 403, json: { code: 'CONFLICT_UNDECLARED' } });
      const listed = await call('GET', `/resources/proposal?package_id=${seeded.packageId}`, { member: E2 });
      expect((listed.json.items as Array<Record<string, unknown>>).map((item) => [item.id, item.access, 'bid_price_vnd' in item])).toEqual([[proposalId, 'DECLARATION_REQUIRED', false]]);
      expect(await audits(proposalId, 'bid.proposal_opened')).toEqual([]);
    });

    it('shows nothing to a caller who may only read proposals, to a clerk of another branch, and to another tenant', async () => {
      const { seeded, proposalId } = await sealed();
      await open(seeded.packageId);
      expect(await call('GET', `/resources/proposal/${proposalId}`, { member: READER })).toMatchObject({ status: 404 });
      expect((await call('GET', '/resources/proposal', { member: READER })).json.items).toEqual([]);
      expect(await call('GET', `/resources/proposal/${proposalId}`, { member: ELSEWHERE_CLERK })).toMatchObject({ status: 404 });
      expect(await call('GET', `/resources/proposal/${proposalId}`, { member: B_CLERK, tenantId: TENANT_B })).toMatchObject({ status: 404 });
      expect((await call('GET', `/resources/proposal/${proposalId}`, { member: NOBODY })).status).toBe(403);
    });

    it('pages the proposals and refuses a package id that is not one', async () => {
      const seeded = await seedPackage();
      for (let n = 0; n < 3; n += 1) expect((await receive(CLERK, seeded, await seedContractor(harness))).status).toBe(200);
      const first = await call('GET', `/resources/proposal?package_id=${seeded.packageId}&limit=2`, { member: CLERK });
      expect((first.json.items as unknown[]).length).toBe(2);
      expect(first.json.next_cursor).toEqual(expect.any(String));
      const second = await call('GET', `/resources/proposal?package_id=${seeded.packageId}&limit=2&cursor=${encodeURIComponent(String(first.json.next_cursor))}`, { member: CLERK });
      expect((second.json.items as unknown[]).length).toBe(1);
      expect(second.json.next_cursor).toBeNull();
      expect((await call('GET', '/resources/proposal?package_id=nope', { member: CLERK })).status).toBe(422);
    });
  });

  describe('the declaration of conflict of interest (AC-ST-BID-004-2, UAT-AC450)', () => {
    it('records a declaration, audits it and tells the world that it was made, without the words of the relation', async () => {
      const seeded = await seedPackage();
      const contractor = await seedContractor(harness);
      const made = await declare(E1, seeded.packageId, { has_conflict: true, relation_text: RELATION, contractor_id: contractor });
      expect(made).toMatchObject({ status: 200, json: { status: 'PENDING', resource_version: 1 } });
      const declarationId = String(made.json.resource_id);
      const [audit] = await audits(declarationId, 'bid.conflict_declared');
      expect(audit).toMatchObject({ outcome: 'SUCCESS', actor_id: memberId(E1), safe_diff: { package_code: seeded.code, has_conflict: true, contractor_id: contractor } });
      const [event] = await events(declarationId, 'bid.conflict.declared.v1');
      expect(event?.payload).toMatchObject({ declaration_id: declarationId, package_id: seeded.packageId, project_id: seeded.projectId, member_id: memberId(E1), has_conflict: true, contractor_id: contractor });
      expect(JSON.stringify([audit, event])).not.toContain('cousin');
      expect(await declare(E2, seeded.packageId, { has_conflict: false })).toMatchObject({ status: 200, json: { status: 'CLEAR' } });
    });

    it('refuses a second declaration (422 ALREADY_DECLARED), a conflict without its relation (422), a package outside the scope (404) and a caller without the right (403)', async () => {
      const seeded = await seedPackage();
      expect((await declare(E1, seeded.packageId, { has_conflict: false })).status).toBe(200);
      expect(await declare(E1, seeded.packageId, { has_conflict: true, relation_text: RELATION })).toMatchObject({ status: 422, json: { code: 'ALREADY_DECLARED' } });
      expect(await declare(E2, seeded.packageId, { has_conflict: true })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await declare(CLERK, seeded.packageId, { has_conflict: false })).toMatchObject({ status: 403 });
      const elsewhere = await seedPackage({ unit: ELSEWHERE });
      expect(await declare(DEPARTMENT_EVALUATOR, elsewhere.packageId, { has_conflict: false })).toMatchObject({ status: 404 });
      expect((await declare(DEPARTMENT_EVALUATOR, seeded.packageId, { has_conflict: false })).status).toBe(200);
    });

    it('does not let the member decide their own declaration (403 SELF_APPROVAL_DENIED); someone else recuses them, and the proposal of the bidder stops existing for them (UAT-AC450)', async () => {
      const seeded = await seedPackage();
      const nt1 = await seedContractor(harness, { name: 'NT-1' });
      const nt2 = await seedContractor(harness, { name: 'NT-2' });
      const hs1 = String((await receive(CLERK, seeded, nt1)).json.resource_id);
      const hs2 = String((await receive(CLERK, seeded, nt2)).json.resource_id);
      await open(seeded.packageId);
      const made = await declare(E4, seeded.packageId, { has_conflict: true, relation_text: RELATION, contractor_id: nt1 });
      const declarationId = String(made.json.resource_id);
      // Waiting for the decision: NT-1 is already shut, NT-2 is open.
      expect((await call('GET', `/resources/proposal/${hs1}`, { member: E4 })).status).toBe(404);
      expect((await call('GET', `/resources/proposal/${hs2}`, { member: E4 })).status).toBe(200);
      const own = await decide(E4, declarationId, 1, { decision: 'ALLOWED', decision_reason: REASON });
      expect(own).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect((await call('GET', `/resources/proposal/${hs1}`, { member: E4 })).status).toBe(404);
      const recused = await decide(APPROVER, declarationId, 1, { decision: 'RECUSED', decision_reason: REASON });
      expect(recused).toMatchObject({ status: 200, json: { status: 'RECUSED', resource_version: 2, resource_id: declarationId } });
      expect(await call('GET', `/resources/proposal/${hs1}`, { member: E4 })).toMatchObject({ status: 404 });
      expect((await call('GET', `/resources/proposal?package_id=${seeded.packageId}`, { member: E4 })).json.items).toHaveLength(1);
      expect(await call('GET', `/resources/proposal/${hs2}`, { member: E4 })).toMatchObject({ status: 200, json: { access: 'FULL' } });
      const [audit] = await audits(declarationId, 'bid.conflict_decided');
      expect(audit).toMatchObject({ outcome: 'SUCCESS', actor_id: memberId(APPROVER), reason: REASON, safe_diff: { package_code: seeded.code, member_id: memberId(E4), contractor_id: nt1, decision: 'RECUSED', previous_decision: null, reports_reopened: 0 } });
      const [event] = await events(declarationId, 'bid.conflict.decided.v1');
      expect(event).toMatchObject({ aggregate_version: '2', payload: { declaration_id: declarationId, member_id: memberId(E4), decision: 'RECUSED', previous_decision: null, actor_id: memberId(APPROVER) } });
      // The authority allows it after all: the proposal is back.
      expect(await decide(APPROVER, declarationId, 2, { decision: 'ALLOWED', decision_reason: 'The relation was found to have no effect on the evaluation.' })).toMatchObject({ status: 200, json: { status: 'ALLOWED', resource_version: 3 } });
      expect((await call('GET', `/resources/proposal/${hs1}`, { member: E4 })).status).toBe(200);
    });

    it('takes the recused member out of the sign-off of the reports of the package', async () => {
      const seeded = await seedPackage();
      const made = await declare(E1, seeded.packageId, { has_conflict: true, relation_text: RELATION });
      const reportId = randomUUID();
      await seedAs(harness, [
        [
          `insert into machvon.evaluation_report (tenant_id, id, package_id, criteria_version_id, summary_json, status, signed_off_by, created_by, updated_by)
           values ($1, $2, $3, $4, '{}'::jsonb, 'SIGNED_OFF', $5::jsonb, $6, $6)`,
          [TENANT_A, reportId, seeded.packageId, randomUUID(), JSON.stringify([{ membership_id: memberId(E1) }, { membership_id: memberId(E2) }]), memberId(CLERK)],
        ],
      ]);
      expect((await decide(APPROVER, String(made.json.resource_id), 1, { decision: 'BLOCKED', decision_reason: REASON })).status).toBe(200);
      const [report] = await rows<{ status: string; signed_off_by: unknown[] }>('select status, signed_off_by from machvon.evaluation_report where id = $1::uuid', [reportId]);
      expect(report).toEqual({ status: 'DRAFT', signed_off_by: [{ membership_id: memberId(E2) }] });
      expect((await audits(String(made.json.resource_id), 'bid.conflict_decided'))[0]?.safe_diff).toMatchObject({ decision: 'BLOCKED', reports_reopened: 1 });
    });

    it('refuses a stale version (409 VERSION_CONFLICT), a declaration of no conflict (422 NO_CONFLICT_DECLARED), a short reason (422) and a caller who may not decide (403)', async () => {
      const seeded = await seedPackage();
      const made = await declare(E1, seeded.packageId, { has_conflict: true, relation_text: RELATION });
      const declarationId = String(made.json.resource_id);
      const clear = await declare(E2, seeded.packageId, { has_conflict: false });
      expect(await decide(APPROVER, declarationId, 7, { decision: 'ALLOWED', decision_reason: REASON })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect(await decide(APPROVER, String(clear.json.resource_id), 1, { decision: 'ALLOWED', decision_reason: REASON })).toMatchObject({ status: 422, json: { code: 'NO_CONFLICT_DECLARED' } });
      expect(await decide(APPROVER, declarationId, 1, { decision: 'ALLOWED', decision_reason: 'Too short.' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await decide(E2, declarationId, 1, { decision: 'ALLOWED', decision_reason: REASON })).toMatchObject({ status: 403 });
      expect(await decide(CLERK, declarationId, 1, { decision: 'ALLOWED', decision_reason: REASON })).toMatchObject({ status: 403 });
      expect(await decide(APPROVER, randomUUID(), 1, { decision: 'ALLOWED', decision_reason: REASON })).toMatchObject({ status: 404 });
      expect((await rows<{ decision: string | null }>('select decision from machvon.bid_conflict_declaration where id = $1::uuid', [declarationId]))[0]?.decision).toBeNull();
    });
  });

  describe('listConflictDeclarations', () => {
    it('shows whoever decides every declaration of the package with the words, and a member only their own', async () => {
      const seeded = await seedPackage();
      const contractor = await seedContractor(harness, { name: 'NT-1' });
      const one = await declare(E1, seeded.packageId, { has_conflict: true, relation_text: RELATION, contractor_id: contractor });
      const two = await declare(E2, seeded.packageId, { has_conflict: false });
      const all = await call('GET', `/procurement-packages/${seeded.packageId}/conflict-declarations`, { member: APPROVER });
      expect(all.status).toBe(200);
      expect(all.json.may_decide).toBe(true);
      expect((all.json.items as Array<Record<string, unknown>>).map((item) => [item.id, item.standing, item.is_own, item.relation_text])).toEqual([
        [one.json.resource_id, 'PENDING', false, RELATION],
        [two.json.resource_id, 'CLEAR', false, null],
      ]);
      const mine = await call('GET', `/procurement-packages/${seeded.packageId}/conflict-declarations`, { member: E2 });
      expect(mine.json.may_decide).toBe(false);
      expect((mine.json.items as Array<Record<string, unknown>>).map((item) => [item.id, item.is_own])).toEqual([[two.json.resource_id, true]]);
      const decider = await call('GET', `/procurement-packages/${seeded.packageId}/conflict-declarations`, { member: E4 });
      expect(decider.json.may_decide).toBe(true);
      expect(await call('GET', `/procurement-packages/${seeded.packageId}/conflict-declarations`, { member: READER })).toMatchObject({ status: 403 });
      expect(await call('GET', `/procurement-packages/${seeded.packageId}/conflict-declarations`, { member: ELSEWHERE_CLERK })).toMatchObject({ status: 404 });
      expect(await call('GET', `/procurement-packages/${randomUUID()}/conflict-declarations`, { member: APPROVER })).toMatchObject({ status: 404 });
    });
  });
});
