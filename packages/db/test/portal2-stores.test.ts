import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { enterPortalPath } from '../src/portal-boundary';
import { BidPetitionOutcomeStore } from '../src/bid-petition-outcome-store';
import { VendorDisputeStore } from '../src/vnd-dispute-store';
import { VendorPortalAttachmentStore } from '../src/vnd-portal-attachment-store';
import { VendorPortalInvitationStore } from '../src/vnd-portal-invitation-store';
import type { PortalInvitationRow } from '../src/vnd-portal-invitation-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, contextFor, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const invitations = new VendorPortalInvitationStore();
const attachments = new VendorPortalAttachmentStore();
const outcomes = new BidPetitionOutcomeStore();
const disputes = new VendorDisputeStore();

const [STAFF, STAFF2, GUEST_A, GUEST_B, GUEST_NEW, GUEST_NEW2] = [1, 2, 3, 4, 5, 6];
const as = <T>(work: (tx: TenantTx) => Promise<T>, member = STAFF): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);
const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

const databaseRefusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the database to refuse');
};

/** Seeds a row of a table this story only reads (a project) with the foreign keys it has to other modules switched off. */
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

async function document(): Promise<string> {
  const id = randomUUID();
  await owner(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, symbol, issued_on, effect_status, created_by, updated_by)
     values ($1, $2, 'REFERENCE', 'QD', 'Decision', 'INTERNAL', '12/QD', date '2026-01-01', 'EFFECTIVE', $3, $3)`,
    [TENANT_A, id, memberId(STAFF)],
  );
  return id;
}

let counter = 0;
async function contractor(name: string, options: { verified?: boolean; email?: string } = {}): Promise<string> {
  counter += 1;
  const id = randomUUID();
  const tax = `07${String(counter).padStart(8, '0')}`;
  if (options.verified === false) {
    await owner(
      `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id, created_by, updated_by, email, email_key)
       values ($1, $2, $3, $4, 'UNVERIFIED', $5, $6, $6, $7::text, case when $7::text is null then null else repeat('c', 64) end)`,
      [TENANT_A, id, tax, name, await document(), memberId(STAFF), options.email ?? null],
    );
    return id;
  }
  await owner(
    `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id, created_by, updated_by, verified_by, verified_at, verification_evidence_document_id, verification_basis, email, email_key)
     values ($1, $2, $3, $4, 'VERIFIED', $5, $6, $6, $7, now(), $8, 'EVIDENCE_DOCUMENT', $9::text, case when $9::text is null then null else repeat('c', 64) end)`,
    [TENANT_A, id, tax, name, await document(), memberId(STAFF), memberId(STAFF2), await document(), options.email ?? null],
  );
  return id;
}

const bind = (member: number, contractorId: string): Promise<unknown[]> =>
  owner("update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2::uuid, valid_until = now() + interval '1 year' where id = $1::uuid", [memberId(member), contractorId]);

const NOW = new Date('2026-11-09T03:00:00Z');
const later = (days: number): Date => new Date(NOW.getTime() + days * 86_400_000);

const proposal = (contractorId: string, email: string, extra: Record<string, unknown> = {}) => ({ contractorId, contactEmail: email, contactName: 'Nguyen Van Lien He', contactBasis: 'REGISTRY_EMAIL', ...extra });

describe('portal access through the registry, petition outcomes and portal attachments (PORTAL-2)', () => {
  let a = '';
  let b = '';
  let unverified = '';
  let d = '';

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: 1, path: '/u1/' }]);
    for (const member of [STAFF, STAFF2, GUEST_A, GUEST_B, GUEST_NEW, GUEST_NEW2]) await harness.seedMembership(TENANT_A, member, 1);
    a = await contractor('Cty Moi Vao Cong A', { email: 'lienhe@congty-a.vn' });
    b = await contractor('Cty Moi Vao Cong B', { email: 'lienhe@congty-b.vn' });
    unverified = await contractor('Cty Chua Xac Minh', { verified: false, email: 'lienhe@chua.vn' });
    d = await contractor('Cty Moi Vao Cong D', { email: 'lienhe@congty-d.vn' });
    await bind(GUEST_A, a);
    await bind(GUEST_B, b);
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the invitation of a contact of a contractor with no contract', () => {
    let first: PortalInvitationRow;

    it('proposes a contact whose address is on the registry entry and shows it as proposed with the expiry of the rule', async () => {
      first = await as((tx) => invitations.propose(tx, proposal(a, ' LienHe@Congty-A.vn '), memberId(STAFF), NOW));
      expect(first).toMatchObject({ status: 'PROPOSED', effectiveStatus: 'PROPOSED', contactEmail: 'lienhe@congty-a.vn', contactBasis: 'REGISTRY_EMAIL', basisReference: null, version: 1, taxIdentifier: expect.stringMatching(/^07/) });
      expect(new Date(first.proposalExpiresAt).getTime() - NOW.getTime()).toBe(7 * 86_400_000);
    });

    it('refuses an address that is not on the entry, a paper basis without a reference, an unverified contractor and a second proposal for the same contact', async () => {
      expect(await refusal(as((tx) => invitations.propose(tx, proposal(a, 'someone.else@congty-a.vn'), memberId(STAFF), NOW)))).toMatchObject({ code: 'PORTAL_CONTACT_UNPROVEN', status: 422 });
      expect(await refusal(as((tx) => invitations.propose(tx, proposal(a, 'someone.else@congty-a.vn', { contactBasis: 'REPRESENTATIVE_LETTER' }), memberId(STAFF), NOW)))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'basis_reference' });
      expect(await refusal(as((tx) => invitations.propose(tx, proposal(unverified, 'lienhe@chua.vn'), memberId(STAFF), NOW)))).toMatchObject({ code: 'CONTRACTOR_NOT_INVITABLE', status: 422 });
      expect(await refusal(as((tx) => invitations.propose(tx, proposal(a, 'lienhe@congty-a.vn'), memberId(STAFF2), NOW)))).toMatchObject({ code: 'PORTAL_INVITATION_EXISTS', status: 409 });
      expect(await refusal(as((tx) => invitations.propose(tx, proposal(randomUUID(), 'x@y.vn'), memberId(STAFF), NOW)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('accepts a contact proved by a paper and refuses a restricted contractor', async () => {
      const paper = await as((tx) => invitations.propose(tx, proposal(a, 'giam.doc@congty-a.vn', { contactBasis: 'REPRESENTATIVE_LETTER', basisReference: 'CV-2026/118' }), memberId(STAFF), NOW));
      expect(paper).toMatchObject({ contactBasis: 'REPRESENTATIVE_LETTER', basisReference: 'CV-2026/118' });
      await owner(`insert into machvon.contractor_restriction (tenant_id, id, contractor_id, kind, source, effective_from, decision_document_id, created_by, updated_by) values ($1, $2, $3, 'DEBARMENT', 'DECISION', '2026-01-01', $4, $5, $5)`, [TENANT_A, randomUUID(), b, await document(), memberId(STAFF)]);
      expect(await refusal(as((tx) => invitations.propose(tx, proposal(b, 'lienhe@congty-b.vn'), memberId(STAFF), NOW)))).toMatchObject({ code: 'CONTRACTOR_NOT_INVITABLE', status: 422 });
    });

    it('stops at the number of accounts the rule allows for one contractor', async () => {
      await as((tx) => invitations.propose(tx, proposal(a, 'ke.toan@congty-a.vn', { contactBasis: 'OTHER_EVIDENCE', basisReference: 'Certificate 55/2026' }), memberId(STAFF), NOW));
      expect(await refusal(as((tx) => invitations.propose(tx, proposal(a, 'thu.ky@congty-a.vn', { contactBasis: 'OTHER_EVIDENCE', basisReference: 'Certificate 56/2026' }), memberId(STAFF), NOW)))).toMatchObject({ code: 'PORTAL_ACCESS_LIMIT', status: 422 });
    });

    it('is approved only by a different person, once, and ends up with the guest membership of the creator and an end day', async () => {
      expect(await refusal(as((tx) => invitations.approve(tx, first.id, 1, memberId(STAFF), undefined, NOW, () => Promise.resolve(memberId(GUEST_NEW))), STAFF))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(as((tx) => invitations.approve(tx, first.id, 9, memberId(STAFF2), undefined, NOW, () => Promise.resolve(memberId(GUEST_NEW))), STAFF2))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      let seen: PortalInvitationRow | undefined;
      const done = await as(
        (tx) =>
          invitations.approve(tx, first.id, 1, memberId(STAFF2), 'Letter checked against the registry', NOW, (invitation) => {
            seen = invitation;
            return Promise.resolve(memberId(GUEST_NEW));
          }),
        STAFF2,
      );
      expect(seen?.contractorId).toBe(a);
      expect(done).toMatchObject({ status: 'APPROVED', membershipId: memberId(GUEST_NEW), decidedBy: memberId(STAFF2), version: 2 });
      expect(new Date(done.accessValidUntil as string).getTime() - NOW.getTime()).toBe(365 * 86_400_000);
      expect(await refusal(as((tx) => invitations.approve(tx, first.id, 2, memberId(STAFF2), undefined, NOW, () => Promise.resolve(memberId(GUEST_NEW))), STAFF2))).toMatchObject({ code: 'PORTAL_INVITATION_STATE_INVALID', status: 409 });
    });

    it('does not approve a proposal that expired, and the database refuses the same person on both sides', async () => {
      const stale = await as((tx) => invitations.propose(tx, proposal(d, 'het.han@congty-d.vn', { contactBasis: 'TAX_AUTHORITY_RECORD', basisReference: 'Record 7788' }), memberId(STAFF), later(-30)));
      expect(stale.effectiveStatus).toBe('PROPOSED');
      expect(await refusal(as((tx) => invitations.approve(tx, stale.id, 1, memberId(STAFF2), undefined, NOW, () => Promise.resolve(memberId(GUEST_NEW2))), STAFF2))).toMatchObject({ code: 'PORTAL_INVITATION_STATE_INVALID', status: 409 });
      expect(await databaseRefusal(as((tx) => tx.query('update machvon.contractor_portal_invitation set decided_by = proposed_by, decided_at = now() where id = $1::uuid', [stale.id])))).toContain('portal_invitation_sod_chk');
    });

    it('rejects with a reason, revokes an approved access at once and ends the guest membership and its grants', async () => {
      const second = await as((tx) => invitations.propose(tx, proposal(d, 'rejected@congty-d.vn', { contactBasis: 'OTHER_EVIDENCE', basisReference: 'Certificate 99/2026' }), memberId(STAFF), later(-60)));
      expect(await refusal(as((tx) => invitations.reject(tx, second.id, 1, memberId(STAFF2), 'no', NOW), STAFF2))).toMatchObject({ code: 'VALIDATION_FAILED' });
      const approved = (await as((tx) => invitations.list(tx, { status: 'APPROVED', contractorId: a }, NOW)))[0] as PortalInvitationRow;
      const role = randomUUID();
      await owner("insert into machvon.role_definition (tenant_id, id, code, name, permissions, rank, is_system, guest_allowed, status, created_by) values ($1, $2, 'T_PORTAL', 'Test portal role', ARRAY['vnd.portal.read']::text[], 10, false, true, 'Active', $3)", [TENANT_A, role, memberId(STAFF)]);
      await owner("insert into machvon.role_grant (tenant_id, id, membership_id, role_id, scope_json, effective_from, scope_kind, scope_ref_ids, status, granted_by, grant_reason) values ($1, gen_random_uuid(), $2, $3, '{}'::jsonb, now(), 'UNIT_ONLY', ARRAY[$4::uuid], 'Active', $5, 'test')", [TENANT_A, memberId(GUEST_NEW), role, unitId(1), memberId(STAFF)]);
      const revoked = await as((tx) => invitations.revoke(tx, approved.id, approved.version, memberId(STAFF), 'The contact left the company', NOW));
      expect(revoked).toMatchObject({ status: 'REVOKED', revokeReason: 'The contact left the company', revokedBy: memberId(STAFF) });
      expect((await owner<{ status: string }>('select status from machvon.membership where id = $1::uuid', [memberId(GUEST_NEW)]))[0]?.status).toBe('Ended');
      expect((await owner<{ n: number }>("select count(*)::int as n from machvon.role_grant where membership_id = $1::uuid and status = 'Active'", [memberId(GUEST_NEW)]))[0]?.n).toBe(0);
      expect((await owner<{ n: number }>("select count(*)::int as n from machvon.role_grant where membership_id = $1::uuid and status = 'Revoked'", [memberId(GUEST_NEW)]))[0]?.n).toBe(1);
      expect(await refusal(as((tx) => invitations.revoke(tx, approved.id, revoked.version, memberId(STAFF), 'Revoked twice by mistake', NOW)))).toMatchObject({ code: 'PORTAL_INVITATION_STATE_INVALID', status: 409 });
      const rejected = await as((tx) => invitations.reject(tx, second.id, 1, memberId(STAFF2), 'The proof is not enough', NOW), STAFF2);
      expect(rejected).toMatchObject({ status: 'REJECTED', decisionNote: 'The proof is not enough' });
    });

    it('lets the nightly job expire proposals and accesses and end the guest of an expired access', async () => {
      const c = await contractor('Cty Het Han Dem', { email: 'dem@congty-c.vn' });
      await bind(GUEST_NEW2, c);
      const p = await as((tx) => invitations.propose(tx, proposal(c, 'dem@congty-c.vn'), memberId(STAFF), NOW));
      const open = await as((tx) => invitations.propose(tx, proposal(c, 'khac@congty-c.vn', { contactBasis: 'OTHER_EVIDENCE', basisReference: 'Certificate 12/2026' }), memberId(STAFF), NOW));
      await as((tx) => invitations.approve(tx, p.id, 1, memberId(STAFF2), undefined, NOW, () => Promise.resolve(memberId(GUEST_NEW2))), STAFF2);
      await as((tx) => invitations.expireDue(tx, later(1)));
      expect(await as((tx) => invitations.expireDue(tx, later(1)))).toEqual({ proposals: 0, accesses: 0 });
      const swept = await as((tx) => invitations.expireDue(tx, later(400)));
      expect(swept.accesses).toBe(1);
      expect(swept.proposals).toBeGreaterThanOrEqual(1);
      expect((await as((tx) => invitations.find(tx, open.id, later(400))))?.status).toBe('EXPIRED');
      expect((await as((tx) => invitations.find(tx, p.id, later(400))))?.status).toBe('EXPIRED');
      expect((await owner<{ status: string }>('select status from machvon.membership where id = $1::uuid', [memberId(GUEST_NEW2)]))[0]?.status).toBe('Ended');
    });
  });

  describe('the files of a contractor and the boundary of the portal path', () => {
    let fileA = '';

    const fileOf = (name: string) => ({ purpose: 'CERTIFICATE' as const, title: name, mime: 'application/pdf', sizeBytes: 1200, sha256: randomUUID().replace(/-/g, '').padEnd(64, 'a'), objectKey: `t/${randomUUID()}`, pageCount: 2 });

    it('registers a file as a document of the DOC framework that belongs to the contractor of the caller', async () => {
      const row = await as((tx) => attachments.register(tx, memberId(GUEST_A), fileOf('Certificate of A')), GUEST_A);
      fileA = row.documentId;
      expect(row).toMatchObject({ contractorId: a, purpose: 'CERTIFICATE', mime: 'application/pdf', linkedKind: null });
      const documentRow = (await owner<{ doc_kind: string; subject_module: string; subject_id: string }>('select doc_kind, subject_module, subject_id from machvon.document where id = $1::uuid', [fileA]))[0];
      expect(documentRow).toMatchObject({ doc_kind: 'ATTACHMENT', subject_module: 'VND_PORTAL', subject_id: a });
      expect(await refusal(as((tx) => attachments.register(tx, memberId(STAFF), fileOf('Not a guest')), STAFF))).toMatchObject({ code: 'PORTAL_CONTRACTOR_REQUIRED', status: 403 });
    });

    it('shows a contractor its own files only and refuses the document id of another contractor, with no sign that it exists', async () => {
      const own = await as(async (tx) => {
        await enterPortalPath(tx, a);
        return attachments.listOwn(tx);
      }, GUEST_A);
      expect(own.map((row) => row.documentId)).toEqual([fileA]);
      const other = await as(async (tx) => {
        await enterPortalPath(tx, b);
        return attachments.listOwn(tx);
      }, GUEST_B);
      expect(other).toEqual([]);
      const foreign = await refusal(
        as(async (tx) => {
          await enterPortalPath(tx, b);
          await attachments.take(tx, fileA, 'REQUEST', randomUUID());
        }, GUEST_B),
      );
      expect(foreign).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'document_id' });
      const unknown = await refusal(
        as(async (tx) => {
          await enterPortalPath(tx, b);
          await attachments.take(tx, randomUUID(), 'REQUEST', randomUUID());
        }, GUEST_B),
      );
      expect(unknown).toEqual(foreign);
    });

    it('links a file to one record only', async () => {
      const target = randomUUID();
      await as(async (tx) => {
        await enterPortalPath(tx, a);
        await attachments.take(tx, fileA, 'REQUEST', target);
        await attachments.take(tx, fileA, 'REQUEST', target);
      }, GUEST_A);
      const again = await refusal(
        as(async (tx) => {
          await enterPortalPath(tx, a);
          await attachments.take(tx, fileA, 'REMEDIATION_ACTION', randomUUID());
        }, GUEST_A),
      );
      expect(again).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'document_id' });
    });

    it('closes the register of documents and the invitations to the portal path', async () => {
      const seen = await as(async (tx) => {
        await enterPortalPath(tx, a);
        return {
          documents: (await tx.query('select 1 from machvon.document')).length,
          versions: (await tx.query('select 1 from machvon.document_version')).length,
          invitations: (await tx.query('select 1 from machvon.contractor_portal_invitation')).length,
          attachments: (await tx.query<{ contractor_id: string }>('select contractor_id from machvon.portal_attachment')).map((row) => row.contractor_id),
        };
      }, GUEST_A);
      expect(seen).toEqual({ documents: 0, versions: 0, invitations: 0, attachments: [a] });
      const write = await databaseRefusal(
        as(async (tx) => {
          await enterPortalPath(tx, a);
          await tx.query("insert into machvon.contractor_portal_invitation (tenant_id, id, contractor_id, tax_identifier, contact_email, contact_name, contact_basis, status, unit_id, proposed_by, proposal_expires_at) values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, '0700000000', 'x@y.vn', 'Xx', 'REGISTRY_EMAIL', 'PROPOSED', $2::uuid, $3::uuid, now() + interval '1 day')", [a, unitId(1), memberId(GUEST_A)]);
        }, GUEST_A),
      );
      expect(write).toContain('row-level security');
    });
  });

  describe('the recorded outcome of a petition', () => {
    let packageId = '';
    let c = '';

    async function petition(status: 'RECEIVED' | 'RESOLVED' | 'ESCALATED', contractorId = c): Promise<string> {
      const id = randomUUID();
      const answered = status !== 'RECEIVED';
      await owner(
        `insert into machvon.procurement_petition (tenant_id, id, package_id, contractor_id, petition_kind, received_on, due_on, petition_document_id, status, resolution_document_id, handled_by, resolved_at, days_applied, rule_version_id, created_by, updated_by)
         values ($1, $2, $3, $4, 'PROCESS', date '2026-10-01', date '2026-10-15', $5, $6, $7, $8, $9, 14, $10, $11, $11)`,
        [TENANT_A, id, packageId, contractorId, await document(), status, answered ? await document() : null, answered ? memberId(STAFF) : null, answered ? '2026-10-10T03:00:00Z' : null, randomUUID(), memberId(STAFF)],
      );
      return id;
    }

    beforeAll(async () => {
      c = await contractor('Cty Kien Nghi', { email: 'kn@congty-k.vn' });
      const projectId = randomUUID();
      packageId = randomUUID();
      await seedReplica(
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, 'P-OUTCOME', 'Outcome project', $3, $3, $4, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, unitId(1), randomUUID()],
      );
      await owner(
        `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, title, created_by)
         values ($1, $2, $3, 'PK-OUTCOME', 5000000000, 'OPEN_BIDDING', 1, 'AWARDED', 'Package', $4)`,
        [TENANT_A, packageId, projectId, memberId(STAFF)],
      );
    });

    it('is recorded by one person for an answered petition and confirmed by another, and a confirmed outcome is final', async () => {
      const p = await petition('RESOLVED');
      expect(await refusal(as((tx) => outcomes.record(tx, p, { outcome: 'MAYBE', decisionRef: 'QD 12', decisionOn: '2026-10-12' }, memberId(STAFF), everything)))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'outcome' });
      const line = await as((tx) => outcomes.record(tx, p, { outcome: 'UPHELD', decisionRef: 'QD 12/QD-UBND', decisionOn: '2026-10-12', note: 'The contractor was right' }, memberId(STAFF), everything));
      expect(line).toMatchObject({ status: 'PROPOSED', outcome: 'UPHELD', petitionStatus: 'RESOLVED', contractor: { id: c }, package: { code: 'PK-OUTCOME' } });
      expect(await refusal(as((tx) => outcomes.record(tx, p, { outcome: 'REJECTED', decisionRef: 'QD 13', decisionOn: '2026-10-12' }, memberId(STAFF2), everything), STAFF2))).toMatchObject({ code: 'PETITION_OUTCOME_STATE_INVALID', status: 409 });
      expect(await refusal(as((tx) => outcomes.confirm(tx, line.id, 1, memberId(STAFF), everything, NOW)))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      const confirmed = await as((tx) => outcomes.confirm(tx, line.id, 1, memberId(STAFF2), everything, NOW), STAFF2);
      expect(confirmed).toMatchObject({ status: 'CONFIRMED', checkedBy: memberId(STAFF2), version: 2 });
      expect(await refusal(as((tx) => outcomes.returnOutcome(tx, line.id, 2, memberId(STAFF2), 'Changed my mind later', everything, NOW), STAFF2))).toMatchObject({ code: 'PETITION_OUTCOME_STATE_INVALID', status: 409 });
      expect(await databaseRefusal(as((tx) => tx.query("update machvon.procurement_petition_outcome set outcome = 'REJECTED' where id = $1::uuid", [line.id])))).toContain('never changes');
    });

    it('refuses a decision the petition cannot have yet, and returns an outcome with a reason so that it can be recorded again', async () => {
      const waiting = await petition('RECEIVED');
      expect(await refusal(as((tx) => outcomes.record(tx, waiting, { outcome: 'UPHELD', decisionRef: 'QD 14', decisionOn: '2026-10-12' }, memberId(STAFF), everything)))).toMatchObject({ code: 'PETITION_OUTCOME_NOT_ALLOWED', status: 422 });
      const answered = await petition('ESCALATED');
      const first = await as((tx) => outcomes.record(tx, answered, { outcome: 'REJECTED', decisionRef: 'QD 15', decisionOn: '2026-10-12' }, memberId(STAFF), everything));
      expect(await refusal(as((tx) => outcomes.returnOutcome(tx, first.id, 1, memberId(STAFF2), 'no', everything, NOW), STAFF2))).toMatchObject({ code: 'VALIDATION_FAILED' });
      const returned = await as((tx) => outcomes.returnOutcome(tx, first.id, 1, memberId(STAFF2), 'The decision number is wrong', everything, NOW), STAFF2);
      expect(returned).toMatchObject({ status: 'RETURNED', returnReason: 'The decision number is wrong' });
      const again = await as((tx) => outcomes.record(tx, answered, { outcome: 'REJECTED', decisionRef: 'QD 15/QD-UBND', decisionOn: '2026-10-12' }, memberId(STAFF), everything));
      expect(again.status).toBe('PROPOSED');
      expect((await as((tx) => outcomes.list(tx, everything, { petitionId: answered }))).map((line) => line.status).sort()).toEqual(['PROPOSED', 'RETURNED']);
    });

    it('moves a waiting petition to WITHDRAWN when the withdrawal is confirmed', async () => {
      const waiting = await petition('RECEIVED');
      const line = await as((tx) => outcomes.record(tx, waiting, { outcome: 'WITHDRAWN', decisionRef: 'Letter of withdrawal 03', decisionOn: '2026-10-11' }, memberId(STAFF), everything));
      await as((tx) => outcomes.confirm(tx, line.id, 1, memberId(STAFF2), everything, NOW), STAFF2);
      expect((await owner<{ status: string }>('select status from machvon.procurement_petition where id = $1::uuid', [waiting]))[0]?.status).toBe('WITHDRAWN');
    });

    it('feeds the dispute figures only with confirmed decisions and counts the answered ones apart', async () => {
      const fresh = await contractor('Cty Chi So Kien Nghi', { email: 'cs@congty-s.vn' });
      const upheld = await petition('RESOLVED', fresh);
      const rejected = await petition('RESOLVED', fresh);
      const pending = await petition('RESOLVED', fresh);
      const proposedOnly = await petition('RESOLVED', fresh);
      const waiting = await petition('RECEIVED', fresh);
      for (const [id, outcome, ref] of [[upheld, 'UPHELD', 'QD 21'], [rejected, 'REJECTED', 'QD 22']] as const) {
        const line = await as((tx) => outcomes.record(tx, id, { outcome, decisionRef: ref, decisionOn: '2026-10-20' }, memberId(STAFF), everything));
        await as((tx) => outcomes.confirm(tx, line.id, 1, memberId(STAFF2), everything, NOW), STAFF2);
      }
      await as((tx) => outcomes.record(tx, proposedOnly, { outcome: 'UPHELD', decisionRef: 'QD 23', decisionOn: '2026-10-20' }, memberId(STAFF), everything));
      const report = await as((tx) => disputes.report(tx, fresh));
      expect(report.petitions).toMatchObject({ total: 5, open: 3, upheld: 1, rejected: 1, withdrawn: 0, awaitingOutcome: 2, upheldPct: 50 });
      const byId = new Map(report.items.map((item) => [item.id, item]));
      expect(byId.get(upheld)).toMatchObject({ outcome: 'UPHELD', decisionRef: 'QD 21', closedOn: '2026-10-20', awaitingOutcome: false });
      expect(byId.get(pending)).toMatchObject({ outcome: 'OPEN', awaitingOutcome: true, decisionRef: null });
      expect(byId.get(waiting)).toMatchObject({ outcome: 'OPEN', awaitingOutcome: false });
    });
  });
});
