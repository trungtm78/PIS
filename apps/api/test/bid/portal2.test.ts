import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_FILTER } from '@nestjs/core';
import { PDFDocument } from 'pdf-lib';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { INVITATION_MAILER, MockInvitationMailer } from '../../src/modules/adm/invitation-mailer';
import { PortalInvitationController, PortalInvitationReadsController } from '../../src/modules/adm/portal-invitation.controller';
import { admModule } from '../../src/modules/adm';
import { bidModule } from '../../src/modules/bid';
import { PetitionOutcomeController } from '../../src/modules/bid/petition-outcome.controller';
import { PortalAttachmentController } from '../../src/modules/bid/portal-attachment.controller';
import { PortalController } from '../../src/modules/bid/portal.controller';
import { PortalReadsController } from '../../src/modules/bid/portal-reads.controller';
import { FailClosedPortalScan, PipelinePortalScan, portalScanFromEnvironment } from '../../src/modules/bid/portal-upload-scan';
import type { PortalUploadScanPort } from '../../src/modules/bid/portal-upload-scan';
import { PORTAL_UPLOAD_SCAN } from '../../src/modules/bid/tokens';
import { VendorPortalStaffController } from '../../src/modules/bid/vendor-portal-staff.controller';
import { VendorPortalStaffReadsController } from '../../src/modules/bid/vendor-portal-staff-reads.controller';
import { FileService } from '../../src/modules/files/file.service';
import { FsObjectStorage } from '../../src/modules/files/fs-object-storage';
import { MockScanPort } from '../../src/modules/files/mock-scan';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const ADMIN = 1; // proposes invitations, records outcomes, sends requests
const CHECKER = 2; // approves and revokes invitations, confirms outcomes
const GUEST_A = 3;
const GUEST_B = 4;
const NOBODY = 5;
const BOTH = 6; // holds the right to propose AND to approve, and to record AND to confirm: the two-person rule must still stop it
const ROOT = 1;
const STAFF_RIGHTS = ['vnd.read', 'vnd.portal.manage', 'bid.read'];
const PORTAL_RIGHTS = ['vnd.portal.read', 'vnd.portal.respond', 'vnd.portal.certificate', 'vnd.portal.reconfirm', 'vnd.portal.remediation', 'vnd.portal.upload'];

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

let pdfCounter = 0;
async function pdfBytes(): Promise<Uint8Array> {
  pdfCounter += 1;
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Portal file ${pdfCounter} ${randomUUID()}`);
  pdf.addPage();
  return pdf.save();
}

describe('portal access through the registry, petition outcomes and portal uploads (PORTAL-2: VND-23, VND-24, BID-34)', () => {
  const harness = new AuthzHarness();
  const mailer = new MockInvitationMailer();
  let app: RunningApp;
  let root = '';
  let a = '';
  let b = '';
  let counter = 0;
  let verdict: 'CLEAN' | 'INFECTED' | 'UNAVAILABLE' = 'CLEAN';
  const scanner: PortalUploadScanPort = { scan: () => Promise.resolve(verdict) };

  const tokenOf = (member: number | string, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: typeof member === 'number' ? memberId(member) : member, scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number | string; body?: unknown; ifMatch?: string | number; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = `"${options.ifMatch}"`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  async function upload(member: number | string, bytes: Uint8Array, type: string, query = 'purpose=CERTIFICATE&title=Certificate'): Promise<Reply> {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type }), 'file.bin');
    const response = await fetch(`${app.baseUrl}/portal/attachments?${query}`, { method: 'POST', headers: { [TENANT_HEADER]: tokenOf(member), 'idempotency-key': `key-${randomUUID()}` }, body: form });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const audits = (resourceId: string, action: string) => rows<{ safe_diff: Record<string, unknown>; reason: string | null; actor_id: string; classification: string }>('select safe_diff, reason, actor_id, classification from machvon.audit_event where resource_id = $1 and action = $2 order by occurred_at', [resourceId, action]);
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at', [aggregateId, type]);

  async function document(): Promise<string> {
    const documentId = randomUUID();
    await rows("insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, symbol, issued_on, effect_status, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Decision', 'INTERNAL', '12/QD', date '2026-01-01', 'EFFECTIVE', $3, $3)", [TENANT_A, documentId, memberId(ADMIN)]);
    return documentId;
  }

  async function contractor(name: string, email: string | null): Promise<string> {
    counter += 1;
    const contractorId = randomUUID();
    await rows(
      `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id, created_by, updated_by, verified_by, verified_at, verification_evidence_document_id, verification_basis, email, email_key)
       values ($1, $2, $3, $4, 'VERIFIED', $5, $6, $6, $7, now(), $8, 'EVIDENCE_DOCUMENT', $9::text, case when $9::text is null then null else repeat('c', 64) end)`,
      [TENANT_A, contractorId, `08${String(counter).padStart(8, '0')}`, name, await document(), memberId(ADMIN), memberId(CHECKER), await document(), email],
    );
    return contractorId;
  }

  const bind = (member: number, contractorId: string) =>
    rows("update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2::uuid, valid_until = now() + interval '1 year' where id = $1::uuid", [memberId(member), contractorId]);

  const dayFromNow = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

  async function seedReplica(sql: string, params: unknown[]): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'portal2-'));
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
    for (const n of [ADMIN, CHECKER, GUEST_A, GUEST_B, NOBODY, BOTH]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedRole(TENANT_A, 1, 'PORTAL_ADMIN', [...STAFF_RIGHTS, 'vnd.portal.invite', 'bid.petition.outcome.record'], 50);
    await harness.seedRole(TENANT_A, 2, 'PORTAL_CHECKER', [...STAFF_RIGHTS, 'vnd.portal.invite.approve', 'vnd.portal.invite.revoke', 'bid.petition.outcome.confirm'], 50);
    await harness.seedRole(TENANT_A, 3, 'PORTAL_CONTRACTOR', PORTAL_RIGHTS, 10);
    await harness.seedRole(TENANT_A, 4, 'MEMBER', ['session.self'], 5);
    await harness.seedRole(TENANT_A, 5, 'PORTAL_BOTH', [...STAFF_RIGHTS, 'vnd.portal.invite', 'vnd.portal.invite.approve', 'bid.petition.outcome.record', 'bid.petition.outcome.confirm', 'vnd.portal.upload'], 50);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ADMIN, role: 1, kind: 'TENANT' },
      { n: 2, member: CHECKER, role: 2, kind: 'TENANT' },
      // The portal rights of a guest sit on a unit, not on a contract: that is the whole point of the registry-bound invitation.
      { n: 3, member: GUEST_A, role: 3, kind: 'UNIT_ONLY', refs: [unitId(ROOT)] },
      { n: 4, member: GUEST_B, role: 3, kind: 'UNIT_ONLY', refs: [unitId(ROOT)] },
      { n: 5, member: BOTH, role: 5, kind: 'TENANT' },
    ]);
    for (const year of [2026, 2027, 2028]) {
      await rows(
        `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
         values ($1, gen_random_uuid(), 'WORKDAY_VN', $2, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019', 'Published', $3, $3, now())`,
        [TENANT_A, year, memberId(ADMIN)],
      );
    }
    a = await contractor('Cty Cong Moi A', 'lienhe@congty-a.vn');
    b = await contractor('Cty Cong Moi B', 'lienhe@congty-b.vn');
    await bind(GUEST_A, a);
    await bind(GUEST_B, b);
    const tenants = harness.tenants as TenantDatabase;
    const files = new FileService({ storage: new FsObjectStorage(root), scanner: new MockScanPort(), urlSecret: randomBytes(32) });
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [PortalInvitationController, PortalInvitationReadsController, PetitionOutcomeController, PortalAttachmentController, PortalController, PortalReadsController, VendorPortalStaffController, VendorPortalStaffReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: FileService, useValue: files },
        { provide: PORTAL_UPLOAD_SCAN, useValue: scanner },
        { provide: INVITATION_MAILER, useValue: mailer },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
    await rm(root, { recursive: true, force: true });
  }, 60_000);

  it('is registered in the modules of ADM and BID', () => {
    for (const controller of [PortalInvitationController, PortalInvitationReadsController]) expect(admModule.controllers).toContain(controller);
    for (const controller of [PetitionOutcomeController, PortalAttachmentController]) expect(bidModule.controllers).toContain(controller);
  });

  describe('UAT-PORTAL2-01: the invitation of a contractor that has no contract, and the proof of the contact', () => {
    let invitationId = '';
    let memberOfInvitation = '';

    it('proposes a contact whose address is on the registry entry, audited without the address', async () => {
      expect((await call('POST', '/vendor/portal/invitations', { member: ADMIN, body: { contractor_id: a, contact_email: 'someone.else@congty-a.vn', contact_name: 'Tran Thi Lien He', contact_basis: 'REGISTRY_EMAIL' } })).json).toMatchObject({ code: 'PORTAL_CONTACT_UNPROVEN' });
      expect((await call('POST', '/vendor/portal/invitations', { member: NOBODY, body: { contractor_id: a, contact_email: 'lienhe@congty-a.vn', contact_name: 'Tran Thi Lien He', contact_basis: 'REGISTRY_EMAIL' } })).status).toBe(403);
      const made = await call('POST', '/vendor/portal/invitations', { member: ADMIN, body: { contractor_id: a, contact_email: 'LienHe@Congty-A.vn', contact_name: 'Tran Thi Lien He', contact_basis: 'REGISTRY_EMAIL' } });
      expect(made).toMatchObject({ status: 200, json: { status: 'PROPOSED', resource_version: 1 } });
      invitationId = made.json.resource_id as string;
      const [audit] = await audits(invitationId, 'vnd.portal_invitation_proposed');
      expect(audit).toMatchObject({ classification: 'CONFIDENTIAL', actor_id: memberId(ADMIN), safe_diff: { contractor_id: a, contact_basis: 'REGISTRY_EMAIL' } });
      expect(JSON.stringify(audit)).not.toContain('congty-a.vn');
      expect(JSON.stringify((await events(invitationId, 'vnd.portal.invitation.changed.v1')).map((entry) => entry.payload))).not.toContain('congty-a.vn');
      expect((await call('POST', '/vendor/portal/invitations', { member: ADMIN, body: { contractor_id: a, contact_email: 'lienhe@congty-a.vn', contact_name: 'Tran Thi Lien He', contact_basis: 'REGISTRY_EMAIL' } })).json).toMatchObject({ code: 'PORTAL_INVITATION_EXISTS' });
    });

    it('shows it to staff with the actions each person may take, and refuses the same person on both sides', async () => {
      const asChecker = await call('GET', '/vendor/portal/invitations?status=PROPOSED', { member: CHECKER });
      expect(asChecker.status).toBe(200);
      const line = (asChecker.json.items as Array<Record<string, unknown>>).find((item) => item.id === invitationId);
      expect(line).toMatchObject({ contractor_id: a, effective_status: 'PROPOSED', actions: { approve: true, reject: true, revoke: true }, proposed_by_name: expect.anything() });
      expect(asChecker.json).toMatchObject({ policy: { proposal_days: 7, access_days: 365, max_live_accounts: 3, unverified: true } });
      const asAdmin = await call('GET', '/vendor/portal/invitations', { member: ADMIN });
      expect((asAdmin.json.items as Array<{ id: string; actions: Record<string, boolean> }>).find((item) => item.id === invitationId)?.actions).toMatchObject({ approve: false, reject: false });
      expect((await call('GET', '/vendor/portal/invitations', { member: GUEST_A })).status).toBe(403);
      const own = await call('POST', '/vendor/portal/invitations', { member: BOTH, body: { contractor_id: b, contact_email: 'lienhe@congty-b.vn', contact_name: 'Le Van Lien He', contact_basis: 'REGISTRY_EMAIL' } });
      expect(await call('POST', `/vendor/portal/invitations/${own.json.resource_id}/approval`, { member: BOTH, ifMatch: 1 })).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect(await call('POST', `/vendor/portal/invitations/${own.json.resource_id}/rejection`, { member: BOTH, ifMatch: 1, body: { reason: 'I proposed it myself' } })).toMatchObject({ status: 403 });
    });

    it('approves it by another person: an invited guest bound to the contractor, with the portal role on a unit and no contract, and the invitation goes to the person', async () => {
      expect((await call('POST', `/vendor/portal/invitations/${invitationId}/approval`, { member: CHECKER, ifMatch: 9 })).json).toMatchObject({ code: 'VERSION_CONFLICT' });
      const done = await call('POST', `/vendor/portal/invitations/${invitationId}/approval`, { member: CHECKER, ifMatch: 1, body: { note: 'Checked against the registry' } });
      expect(done).toMatchObject({ status: 200, json: { status: 'APPROVED', resource_version: 2 } });
      const [member] = await rows<{ id: string; status: string; membership_type: string; contractor_id: string; valid_until: string }>("select id, status, membership_type, contractor_id, valid_until from machvon.membership where contractor_id = $1::uuid and status = 'Invited'", [a]);
      expect(member).toMatchObject({ status: 'Invited', membership_type: 'GUEST_CONTRACTOR', contractor_id: a });
      memberOfInvitation = member?.id ?? '';
      const grants = await rows<{ scope_kind: string; code: string }>('select g.scope_kind, r.code from machvon.role_grant g join machvon.role_definition r on r.id = g.role_id where g.membership_id = $1::uuid order by r.code', [memberOfInvitation]);
      expect(grants).toEqual([{ scope_kind: 'UNIT_ONLY', code: 'MEMBER' }, { scope_kind: 'UNIT_ONLY', code: 'PORTAL_CONTRACTOR' }]);
      expect(mailer.lastTo('lienhe@congty-a.vn')).toMatchObject({ tenantId: TENANT_A });
      const [audit] = await audits(invitationId, 'vnd.portal_invitation_approved');
      expect(audit).toMatchObject({ classification: 'CONFIDENTIAL', actor_id: memberId(CHECKER) });
      expect(JSON.stringify(audit)).not.toContain('congty-a.vn');
      expect((await call('POST', `/vendor/portal/invitations/${invitationId}/approval`, { member: CHECKER, ifMatch: 2 })).json).toMatchObject({ code: 'PORTAL_INVITATION_STATE_INVALID' });
    });

    it('lets the new account read its own profile and requests and never those of another contractor', async () => {
      await rows("update machvon.membership set status = 'Active' where id = $1::uuid", [memberOfInvitation]);
      const sent = await call('POST', `/vendor/contractors/${a}/portal-requests`, { member: ADMIN, body: { kind: 'INFORMATION', title: 'Send the list of the key staff', due_on: dayFromNow(10) } });
      const foreign = await call('POST', `/vendor/contractors/${b}/portal-requests`, { member: ADMIN, body: { kind: 'INFORMATION', title: 'Request to the other contractor', due_on: dayFromNow(10) } });
      expect(sent.status).toBe(200);
      const home = await call('GET', '/portal/me', { member: memberOfInvitation });
      expect(home.status).toBe(200);
      expect(JSON.stringify(home.json)).toContain(a);
      expect(JSON.stringify(home.json)).not.toContain(b);
      const mine = await call('GET', '/portal/requests', { member: memberOfInvitation });
      expect((mine.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([sent.json.resource_id]);
      expect(await call('POST', `/portal/requests/${foreign.json.resource_id}/response`, { member: memberOfInvitation, ifMatch: 1, body: { text: 'This is not mine' } })).toMatchObject({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
      expect((await call('GET', '/portal/requests', { member: GUEST_B })).json.items).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: sent.json.resource_id })]));
      expect((await call('GET', `/vendor/portal/invitations`, { member: memberOfInvitation })).status).toBe(403);
    });
  });

  describe('UAT-PORTAL2-02: the number of accounts, the revocation and the expiry', () => {
    it('stops at the number of live accounts the rule allows, asks a reason to revoke, and ends the account at once', async () => {
      const c = await contractor('Cty Han Muc Tai Khoan', 'a@congty-c.vn');
      for (const [email, reference] of [['b@congty-c.vn', 'Letter 1/2026'], ['c@congty-c.vn', 'Letter 2/2026']] as const) {
        expect((await call('POST', '/vendor/portal/invitations', { member: ADMIN, body: { contractor_id: c, contact_email: email, contact_name: 'Pham Lien He', contact_basis: 'REPRESENTATIVE_LETTER', basis_reference: reference } })).status).toBe(200);
      }
      const third = await call('POST', '/vendor/portal/invitations', { member: ADMIN, body: { contractor_id: c, contact_email: 'a@congty-c.vn', contact_name: 'Pham Lien He', contact_basis: 'REGISTRY_EMAIL' } });
      expect(third.status).toBe(200);
      expect((await call('POST', '/vendor/portal/invitations', { member: ADMIN, body: { contractor_id: c, contact_email: 'd@congty-c.vn', contact_name: 'Pham Lien He', contact_basis: 'OTHER_EVIDENCE', basis_reference: 'Record 4/2026' } })).json).toMatchObject({ code: 'PORTAL_ACCESS_LIMIT' });
      const id = third.json.resource_id as string;
      expect((await call('POST', `/vendor/portal/invitations/${id}/revocation`, { member: CHECKER, ifMatch: 1, body: { reason: 'no' } })).json).toMatchObject({ code: 'VALIDATION_FAILED' });
      const revoked = await call('POST', `/vendor/portal/invitations/${id}/revocation`, { member: CHECKER, ifMatch: 1, body: { reason: 'Proposed by mistake' } });
      expect(revoked).toMatchObject({ status: 200, json: { status: 'REVOKED' } });
      const [audit] = await audits(id, 'vnd.portal_invitation_revoked');
      expect(audit).toMatchObject({ reason: 'Proposed by mistake', actor_id: memberId(CHECKER) });
      expect((await call('POST', `/vendor/portal/invitations/${id}/revocation`, { member: CHECKER, ifMatch: 2, body: { reason: 'Revoked twice' } })).json).toMatchObject({ code: 'PORTAL_INVITATION_STATE_INVALID' });
    });

    it('revokes an approved access: the guest membership ends and its grants are revoked', async () => {
      const d = await contractor('Cty Thu Hoi', 'x@congty-d.vn');
      const made = await call('POST', '/vendor/portal/invitations', { member: ADMIN, body: { contractor_id: d, contact_email: 'x@congty-d.vn', contact_name: 'Do Lien He', contact_basis: 'REGISTRY_EMAIL' } });
      const id = made.json.resource_id as string;
      expect((await call('POST', `/vendor/portal/invitations/${id}/approval`, { member: CHECKER, ifMatch: 1 })).status).toBe(200);
      const [member] = await rows<{ id: string }>("select id from machvon.membership where contractor_id = $1::uuid and status = 'Invited'", [d]);
      const revoked = await call('POST', `/vendor/portal/invitations/${id}/revocation`, { member: CHECKER, ifMatch: 2, body: { reason: 'The contact left the company' } });
      expect(revoked).toMatchObject({ status: 200, json: { status: 'REVOKED', resource_version: 3 } });
      expect((await rows<{ status: string }>('select status from machvon.membership where id = $1::uuid', [member?.id]))[0]?.status).toBe('Ended');
      expect(await rows<{ status: string }>("select status from machvon.role_grant where membership_id = $1::uuid and status = 'Active'", [member?.id])).toEqual([]);
    });
  });

  describe('UAT-PORTAL2-03: the upload of a file on the portal', () => {
    it('refuses every upload while no scanner is wired (the default hook fails closed) and stores nothing', async () => {
      expect(portalScanFromEnvironment({})).toBeInstanceOf(FailClosedPortalScan);
      expect(portalScanFromEnvironment({ MACHVON_PORTAL_SCAN: 'PIPELINE' })).toBeInstanceOf(PipelinePortalScan);
      expect(await new FailClosedPortalScan().scan()).toBe('UNAVAILABLE');
      verdict = 'UNAVAILABLE';
      const before = await rows<{ n: string }>("select count(*)::text as n from machvon.document where subject_module = 'VND_PORTAL'");
      expect(await upload(GUEST_A, await pdfBytes(), 'application/pdf')).toMatchObject({ status: 409, json: { code: 'SCAN_PENDING' } });
      verdict = 'INFECTED';
      expect(await upload(GUEST_A, await pdfBytes(), 'application/pdf')).toMatchObject({ status: 422, json: { code: 'FILE_NOT_CLEAN' } });
      expect(await rows<{ n: string }>("select count(*)::text as n from machvon.document where subject_module = 'VND_PORTAL'")).toEqual(before);
      verdict = 'CLEAN';
    });

    it('judges the bytes, the size, the purpose and the caller, then registers the file as a document of the contractor of the caller', async () => {
      expect(await upload(GUEST_A, new TextEncoder().encode('just words'), 'text/plain')).toMatchObject({ status: 422, json: { code: 'FILE_TYPE_NOT_ALLOWED' } });
      expect((await upload(GUEST_A, await pdfBytes(), 'application/pdf', 'purpose=PHOTO&title=Certificate')).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'purpose' });
      expect((await upload(GUEST_A, await pdfBytes(), 'application/pdf', 'purpose=CERTIFICATE')).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'title' });
      expect((await upload(NOBODY, await pdfBytes(), 'application/pdf')).status).toBe(403);
      expect(await upload(BOTH, await pdfBytes(), 'application/pdf')).toMatchObject({ status: 403, json: { code: 'PORTAL_CONTRACTOR_REQUIRED' } });
      expect((await upload(GUEST_A, new Uint8Array(10 * 1024 * 1024 + 64 * 1024), 'application/pdf')).status).toBe(413);
      const bytes = await pdfBytes();
      const done = await upload(GUEST_A, bytes, 'application/pdf', 'purpose=REQUEST_RESPONSE&title=Signed%20page');
      expect(done).toMatchObject({ status: 200, json: { purpose: 'REQUEST_RESPONSE', title: 'Signed page', mime: 'application/pdf', size_bytes: bytes.length, linked_kind: null } });
      const documentId = done.json.document_id as string;
      const [stored] = await rows<{ doc_kind: string; subject_module: string; subject_id: string; scan_status: string }>('select d.doc_kind, d.subject_module, d.subject_id, v.scan_status from machvon.document d join machvon.document_version v on v.document_id = d.id where d.id = $1::uuid', [documentId]);
      expect(stored).toMatchObject({ doc_kind: 'ATTACHMENT', subject_module: 'VND_PORTAL', subject_id: a, scan_status: 'CLEAN' });
      const [audit] = await audits(done.json.id as string, 'vnd.portal_attachment_uploaded');
      expect(audit).toMatchObject({ classification: 'CONFIDENTIAL', actor_id: memberId(GUEST_A), safe_diff: { contractor_id: a, document_id: documentId } });
      expect(JSON.stringify(audit)).not.toContain('Signed page');
      const listed = await call('GET', '/portal/attachments', { member: GUEST_A });
      expect(listed).toMatchObject({ status: 200, json: { limits: { max_bytes: 10 * 1024 * 1024, mimes: ['application/pdf', 'image/png', 'image/jpeg'] } } });
      expect((listed.json.items as Array<{ id: string }>).map((item) => item.id)).toContain(done.json.id);
    });
  });

  describe('UAT-PORTAL2-05: the files of one contractor never reach another', () => {
    it('lets a contractor answer with its own file only, and treats the file of another as if it did not exist', async () => {
      const done = await upload(GUEST_A, await pdfBytes(), 'application/pdf', 'purpose=REQUEST_RESPONSE&title=Answer%20paper');
      const documentId = done.json.document_id as string;
      expect((await call('GET', '/portal/attachments', { member: GUEST_B })).json.items).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: done.json.id })]));
      const mineA = await call('POST', `/vendor/contractors/${a}/portal-requests`, { member: ADMIN, body: { kind: 'INFORMATION', title: 'Answer with a paper', due_on: dayFromNow(10) } });
      const mineB = await call('POST', `/vendor/contractors/${b}/portal-requests`, { member: ADMIN, body: { kind: 'INFORMATION', title: 'Answer with a paper, B', due_on: dayFromNow(10) } });
      const stolen = await call('POST', `/portal/requests/${mineB.json.resource_id}/response`, { member: GUEST_B, ifMatch: 1, body: { document_id: documentId } });
      const unknown = await call('POST', `/portal/requests/${mineB.json.resource_id}/response`, { member: GUEST_B, ifMatch: 1, body: { document_id: randomUUID() } });
      expect(stolen).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'document_id' } });
      expect(unknown.json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'document_id' });
      const answered = await call('POST', `/portal/requests/${mineA.json.resource_id}/response`, { member: GUEST_A, ifMatch: 1, body: { document_id: documentId } });
      expect(answered).toMatchObject({ status: 200, json: { status: 'RESPONDED' } });
      expect((await rows<{ linked_kind: string; linked_id: string }>('select linked_kind, linked_id from machvon.portal_attachment where document_id = $1::uuid', [documentId]))[0]).toMatchObject({ linked_kind: 'REQUEST', linked_id: mineA.json.resource_id });
      const second = await call('POST', `/vendor/contractors/${a}/portal-requests`, { member: ADMIN, body: { kind: 'INFORMATION', title: 'A second request', due_on: dayFromNow(10) } });
      expect((await call('POST', `/portal/requests/${second.json.resource_id}/response`, { member: GUEST_A, ifMatch: 1, body: { document_id: documentId } })).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'document_id' });
    });
  });

  describe('UAT-PORTAL2-04: the outcome of a petition feeds the dispute figures', () => {
    let petitionId = '';
    let outcomeId = '';

    it('records the decision by one person and confirms it by another; a confirmed decision is the only one counted', async () => {
      const projectId = randomUUID();
      const packageId = randomUUID();
      await seedReplica(
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, 'P-PORTAL2', 'Petition project', $3, $3, $4, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, unitId(ROOT), randomUUID()],
      );
      await rows("insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, title, created_by) values ($1, $2, $3, 'PK-PORTAL2', 5000000000, 'OPEN_BIDDING', 1, 'AWARDED', 'Package', $4)", [TENANT_A, packageId, projectId, memberId(ADMIN)]);
      petitionId = randomUUID();
      await rows(
        `insert into machvon.procurement_petition (tenant_id, id, package_id, contractor_id, petition_kind, received_on, due_on, petition_document_id, status, resolution_document_id, handled_by, resolved_at, days_applied, rule_version_id, created_by, updated_by)
         values ($1, $2, $3, $4, 'RESULT', date '2026-10-01', date '2026-10-15', $5, 'RESOLVED', $6, $7, '2026-10-10T03:00:00Z', 14, $8, $7, $7)`,
        [TENANT_A, petitionId, packageId, b, await document(), await document(), memberId(ADMIN), randomUUID()],
      );
      const before = await call('GET', `/vendor/disputes?contractor_id=${b}`, { member: CHECKER });
      expect(before.json).toMatchObject({ petitions: { total: 1, open: 1, upheld: 0, rejected: 0, awaiting_outcome: 1, upheld_pct: null } });

      expect((await call('POST', `/procurement-petitions/${petitionId}/outcome`, { member: NOBODY, body: { outcome: 'UPHELD', decision_ref: 'QD 12/QD-UBND', decision_on: '2026-10-12' } })).status).toBe(403);
      expect((await call('POST', `/procurement-petitions/${petitionId}/outcome`, { member: ADMIN, body: { outcome: 'MAYBE', decision_ref: 'QD 12/QD-UBND', decision_on: '2026-10-12' } })).status).toBe(422);
      const recorded = await call('POST', `/procurement-petitions/${petitionId}/outcome`, { member: ADMIN, body: { outcome: 'UPHELD', decision_ref: 'QD 12/QD-UBND', decision_on: '2026-10-12', note: 'The contractor was right about the criteria' } });
      expect(recorded).toMatchObject({ status: 200, json: { status: 'PROPOSED', resource_version: 1 } });
      outcomeId = recorded.json.resource_id as string;
      const [audit] = await audits(outcomeId, 'petition.outcome_recorded');
      expect(audit).toMatchObject({ actor_id: memberId(ADMIN), safe_diff: { petition_id: petitionId, contractor_id: b, outcome: 'UPHELD' } });
      expect(JSON.stringify(audit)).not.toContain('criteria');
      // Still proposed: it counts for nothing yet.
      expect((await call('GET', `/vendor/disputes?contractor_id=${b}`, { member: CHECKER })).json).toMatchObject({ petitions: { upheld: 0, awaiting_outcome: 1, upheld_pct: null } });

      const listed = await call('GET', `/procurement-petition-outcomes?petition_id=${petitionId}`, { member: CHECKER });
      expect((listed.json.items as Array<Record<string, unknown>>)[0]).toMatchObject({ id: outcomeId, status: 'PROPOSED', actions: { confirm: true, return: true } });
      const recorderView = await call('GET', `/procurement-petition-outcomes?petition_id=${petitionId}`, { member: ADMIN });
      expect((recorderView.json.items as Array<{ actions: Record<string, boolean> }>)[0]?.actions).toEqual({ confirm: false, return: false });

      expect(await call('POST', `/procurement-petition-outcomes/${outcomeId}/confirmation`, { member: ADMIN, ifMatch: 1 })).toMatchObject({ status: 403 });
      expect((await call('POST', `/procurement-petitions/${petitionId}/outcome`, { member: BOTH, body: { outcome: 'REJECTED', decision_ref: 'QD 13/QD-UBND', decision_on: '2026-10-12' } })).json).toMatchObject({ code: 'PETITION_OUTCOME_STATE_INVALID' });
      const confirmed = await call('POST', `/procurement-petition-outcomes/${outcomeId}/confirmation`, { member: CHECKER, ifMatch: 1 });
      expect(confirmed).toMatchObject({ status: 200, json: { status: 'CONFIRMED', resource_version: 2 } });
      expect((await call('POST', `/procurement-petition-outcomes/${outcomeId}/return`, { member: CHECKER, ifMatch: 2, body: { reason: 'Changed my mind later' } })).json).toMatchObject({ code: 'PETITION_OUTCOME_STATE_INVALID' });

      const after = await call('GET', `/vendor/disputes?contractor_id=${b}`, { member: CHECKER });
      expect(after.json).toMatchObject({ petitions: { total: 1, open: 0, upheld: 1, rejected: 0, awaiting_outcome: 0, upheld_pct: 100 } });
      expect((after.json.items as Array<Record<string, unknown>>)[0]).toMatchObject({ outcome: 'UPHELD', decision_ref: 'QD 12/QD-UBND', awaiting_outcome: false });
    });

    it('returns an outcome with a reason so that it can be recorded again, and keeps the person who recorded it apart from the one who returns it', async () => {
      const [petition] = await rows<{ package_id: string }>('select package_id from machvon.procurement_petition where id = $1::uuid', [petitionId]);
      const other = randomUUID();
      await rows(
        `insert into machvon.procurement_petition (tenant_id, id, package_id, contractor_id, petition_kind, received_on, due_on, petition_document_id, status, resolution_document_id, handled_by, resolved_at, days_applied, rule_version_id, created_by, updated_by)
         values ($1, $2, $3, $4, 'PROCESS', date '2026-10-02', date '2026-10-16', $5, 'RESOLVED', $6, $7, '2026-10-11T03:00:00Z', 14, $8, $7, $7)`,
        [TENANT_A, other, petition?.package_id, a, await document(), await document(), memberId(ADMIN), randomUUID()],
      );
      const recorded = await call('POST', `/procurement-petitions/${other}/outcome`, { member: ADMIN, body: { outcome: 'REJECTED', decision_ref: 'QD 20/QD-UBND', decision_on: '2026-10-13' } });
      const id = recorded.json.resource_id as string;
      expect((await call('POST', `/procurement-petition-outcomes/${id}/return`, { member: CHECKER, ifMatch: 1, body: { reason: 'no' } })).json).toMatchObject({ code: 'VALIDATION_FAILED' });
      const returned = await call('POST', `/procurement-petition-outcomes/${id}/return`, { member: CHECKER, ifMatch: 1, body: { reason: 'The number of the decision is wrong' } });
      expect(returned).toMatchObject({ status: 200, json: { status: 'RETURNED' } });
      const [audit] = await audits(id, 'petition.outcome_returned');
      expect(audit).toMatchObject({ reason: 'The number of the decision is wrong' });
      expect((await call('POST', `/procurement-petitions/${other}/outcome`, { member: ADMIN, body: { outcome: 'REJECTED', decision_ref: 'QD 20/QD-UBND', decision_on: '2026-10-13' } })).status).toBe(200);
      expect((await call('POST', `/procurement-petitions/${randomUUID()}/outcome`, { member: ADMIN, body: { outcome: 'REJECTED', decision_ref: 'QD 20/QD-UBND', decision_on: '2026-10-13' } })).status).toBe(404);
    });
  });
});
