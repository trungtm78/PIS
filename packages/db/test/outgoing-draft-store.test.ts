import { randomUUID } from 'node:crypto';
import { DomainError } from '@machvon/kernel';
import { DocIssueRequestStore } from '../src/doc-issue-request-store';
import type { NewIssueRequest } from '../src/doc-issue-request-store';
import { DocumentStore } from '../src/document-store';
import { NumberRegisterStore } from '../src/number-register-store';
import { OutgoingDocumentStore } from '../src/outgoing-document-store';
import { OutgoingDraftStore } from '../src/outgoing-draft-store';
import type { NewOutgoingDraft } from '../src/outgoing-draft-store';
import { SignerAuthorityStore } from '../src/signer-authority-store';
import { ACTOR, AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, roleId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const documents = new DocumentStore();
const outgoing = new OutgoingDocumentStore();
const drafts = new OutgoingDraftStore();
const authority = new SignerAuthorityStore();
const requests = new DocIssueRequestStore();
const registers = new NumberRegisterStore();
const DRAFTER = memberId(1);
const SIGNER = memberId(2);
const OTHER = memberId(3);
const CERTIFICATE = '00000000-0000-4000-8000-0000000000ce';
const NOW = new Date('2026-10-23T03:00:00Z');
const ctxA = contextFor(TENANT_A, DRAFTER);
const ctxB = contextFor(TENANT_B, DRAFTER);
const inA = <T>(work: Parameters<typeof harness.tenants.withTenant<T>>[1]) => harness.tenants.withTenant(ctxA, work);
let layoutProfileId = '';
let templateId = '';

async function failure(promise: Promise<unknown>): Promise<{ code: string; sqlState?: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return { code: error.code };
    return { code: 'DB', sqlState: (error as { code?: string }).code };
  }
  throw new Error('expected a rejection');
}

const draftInput = (overrides: Partial<NewOutgoingDraft> = {}): NewOutgoingDraft => ({
  docTypeCode: 'QD',
  title: 'Decision on a plan',
  draftingUnitId: unitId(2),
  templateId,
  layoutProfileId,
  urgency: 'NORMAL',
  circulation: 'INTERNAL_CIRCULATION',
  classification: 'INTERNAL',
  payload: { agency: 'A', place: 'B' },
  payloadSha256: 'a'.repeat(64),
  recipients: [{ kind: 'EXTERNAL_AGENCY', name: 'Finance' }],
  signerUserId: SIGNER,
  signerTitle: 'CHAIRMAN',
  signingMode: 'DIRECT',
  delegationId: null,
  subjectModule: null,
  subjectId: null,
  replyToIncomingId: null,
  reviewDueOn: null,
  actor: DRAFTER,
  ...overrides,
});

const owner = <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => harness.owner<T>(TENANT_A, [[sql, params]]);

describe('the drafting stores of DOC (ST-DOC-007, 008, 009)', () => {
  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: 1, path: `/${unitId(1)}/` },
      { n: 2, path: `/${unitId(1)}/${unitId(2)}/`, parent: 1 },
      { n: 3, path: `/${unitId(3)}/` },
    ]);
    await harness.seedUnits(TENANT_B, [{ n: 1, path: `/${unitId(1)}/` }]);
    for (const n of [1, 2, 3]) await harness.seedMembership(TENANT_A, n, 1);
    const seeded = await inA((tx) => documents.seedDefaults(tx, ACTOR));
    layoutProfileId = seeded.layoutProfileId;
    templateId = seeded.templateId;
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.signing_certificate (tenant_id, id, kind, holder_membership_id, certificate_serial, issuer_dn, subject_dn, provider_code, valid_from, valid_until, fingerprint_sha256, status, registered_by)
         values ($1::uuid, $2::uuid, 'PERSONAL', $3::uuid, '01', 'CN=Test CA', 'CN=Signer', 'MOCK', '2026-01-01', '2030-01-01', $4, 'Active', $3::uuid)`,
        [TENANT_A, CERTIFICATE, SIGNER, 'd'.repeat(64)],
      ],
    ]);
  }, 180_000);

  afterAll(() => harness.stop(), 60_000);

  describe('OutgoingDraftStore', () => {
    it('writes the anchor and the draft together, and reads the content back', async () => {
      const draft = await inA((tx) => drafts.createDraft(tx, draftInput({ subjectModule: 'PRJ', subjectId: randomUUID(), reviewDueOn: '2026-11-01' })));
      expect(draft).toMatchObject({ status: 'DRAFT', route: 'IN_SYSTEM', version: 1, templateId, effectStatus: 'PENDING', classification: 'INTERNAL', sourceModule: null, reviewDueOn: '2026-11-01', cancelReason: null });
      const content = await inA((tx) => drafts.contentOf(tx, draft.id));
      expect(content).toMatchObject({ payload: { agency: 'A', place: 'B' }, payloadSha256: 'a'.repeat(64), subjectModule: 'PRJ' });
      expect(await inA((tx) => drafts.contentOf(tx, randomUUID()))).toBeUndefined();
      expect(await harness.tenants.withTenant(ctxB, (tx) => drafts.contentOf(tx, draft.id))).toBeUndefined();
      expect((await inA((tx) => outgoing.findByDocument(tx, draft.documentId)))?.id).toBe(draft.id);
      expect(await inA((tx) => outgoing.findByDocument(tx, randomUUID()))).toBeUndefined();
    });

    it('edits only a draft, under the version it read, field by field', async () => {
      const draft = await inA((tx) => drafts.createDraft(tx, draftInput()));
      const changed = await inA((tx) =>
        drafts.updateDraft(tx, draft.id, {
          expectedVersion: 1,
          actor: OTHER,
          patch: {
            title: 'A new title',
            payload: { agency: 'C' },
            payloadSha256: 'b'.repeat(64),
            recipients: [],
            urgency: 'HOA_TOC',
            signerUserId: OTHER,
            signerTitle: null,
            signingMode: 'DIRECT',
            delegationId: null,
            reviewDueOn: '2026-12-01',
          },
        }),
      );
      expect(changed).toMatchObject({ title: 'A new title', urgency: 'HOA_TOC', signerUserId: OTHER, signerTitle: null, recipients: [], payloadSha256: 'b'.repeat(64), version: 2, reviewDueOn: '2026-12-01' });
      expect((await failure(inA((tx) => drafts.updateDraft(tx, draft.id, { expectedVersion: 1, actor: OTHER, patch: { title: 'late' } })))).code).toBe('VERSION_CONFLICT');
      expect((await failure(inA((tx) => drafts.updateDraft(tx, randomUUID(), { expectedVersion: 1, actor: OTHER, patch: {} })))).code).toBe('RESOURCE_NOT_FOUND');
      // Nothing to change is only a new version.
      expect((await inA((tx) => drafts.updateDraft(tx, draft.id, { expectedVersion: 2, actor: OTHER, patch: {} }))).version).toBe(3);
      await inA((tx) => drafts.submit(tx, draft.id, { expectedVersion: 3, actor: DRAFTER }));
      expect((await failure(inA((tx) => drafts.updateDraft(tx, draft.id, { expectedVersion: 4, actor: OTHER, patch: { title: 'locked' } })))).code).toBe('DOCUMENT_STATE_INVALID');
    });

    it('moves a draft to review, to approved and back, and lets nothing else through', async () => {
      const draft = await inA((tx) => drafts.createDraft(tx, draftInput()));
      expect((await failure(inA((tx) => drafts.approve(tx, draft.id, { expectedVersion: 1, actor: OTHER })))).code).toBe('DOCUMENT_STATE_INVALID');
      expect((await inA((tx) => drafts.submit(tx, draft.id, { expectedVersion: 1, actor: DRAFTER }))).status).toBe('IN_REVIEW');
      expect((await failure(inA((tx) => drafts.submit(tx, draft.id, { expectedVersion: 2, actor: DRAFTER })))).code).toBe('DOCUMENT_STATE_INVALID');
      const back = await inA((tx) => drafts.returnToDraft(tx, draft.id, { expectedVersion: 2, actor: OTHER }));
      expect(back).toMatchObject({ from: 'IN_REVIEW', cancelled: [], document: { status: 'DRAFT', version: 3 } });
      await inA((tx) => drafts.submit(tx, draft.id, { expectedVersion: 3, actor: DRAFTER }));
      expect((await inA((tx) => drafts.approve(tx, draft.id, { expectedVersion: 4, actor: OTHER }))).status).toBe('SUBMITTED');
      expect((await failure(inA((tx) => drafts.returnToDraft(tx, randomUUID(), { expectedVersion: 1, actor: OTHER })))).code).toBe('RESOURCE_NOT_FOUND');
    });

    it('takes the final file away when a submitted draft goes back and ends the sessions that were open', async () => {
      const draft = await inA((tx) => drafts.createDraft(tx, draftInput()));
      await inA((tx) => drafts.submit(tx, draft.id, { expectedVersion: 1, actor: DRAFTER }));
      await inA((tx) => drafts.approve(tx, draft.id, { expectedVersion: 2, actor: OTHER }));
      const version = await inA((tx) =>
        documents.appendVersion(tx, { documentId: draft.documentId, objectKey: `tenants/${TENANT_A}/documents/${randomUUID()}.pdf`, checksum: 'c'.repeat(64), mime: 'application/pdf', pageCount: 1, classification: 'INTERNAL', stage: 'RENDERED_FINAL', byteLength: 1, createdBy: ACTOR }),
      );
      const session = await inA((tx) =>
        outgoing.createSession(tx, {
          id: randomUUID(),
          outgoingDocumentId: draft.id,
          role: 'LEADER',
          signerUserId: SIGNER,
          signingCertificateId: CERTIFICATE,
          adapterCode: 'MOCK',
          adapterStatus: 'MOCK',
          baseVersionId: version.id,
          digestHex: 'd'.repeat(64),
          byteRange: [0, 1, 2, 3],
          providerTxnRef: 'txn-1',
          expiresAt: new Date(NOW.getTime() + 900_000),
          actor: SIGNER,
        }),
      );
      const result = await inA((tx) => drafts.returnToDraft(tx, draft.id, { expectedVersion: 3, actor: OTHER }));
      expect(result.from).toBe('SUBMITTED');
      expect(result.cancelled).toEqual([{ id: session.id, adapterCode: 'MOCK', providerTxnRef: 'txn-1', expiresAt: expect.any(Date) as Date }]);
      expect((await owner<{ current_version_id: string | null }>('select current_version_id from machvon.document where id = $1', [draft.documentId]))[0]?.current_version_id).toBeNull();
      expect((await owner<{ status: string }>('select status from machvon.doc_signing_session where id = $1', [session.id]))[0]?.status).toBe('CANCELLED');
      // The same file can be made current again.
      expect((await inA((tx) => documents.versionByKey(tx, draft.documentId, version.objectKey)))?.id).toBe(version.id);
      expect(await inA((tx) => documents.versionByKey(tx, draft.documentId, 'tenants/none'))).toBeUndefined();
      await inA((tx) => documents.pointAt(tx, draft.documentId, version.id, OTHER));
      expect((await owner<{ current_version_id: string }>('select current_version_id from machvon.document where id = $1', [draft.documentId]))[0]?.current_version_id).toBe(version.id);
    });

    it('cancels up to SIGNED with a reason, makes the anchor EXPIRED and refuses a numbered document', async () => {
      const draft = await inA((tx) => drafts.createDraft(tx, draftInput()));
      const cancelled = await inA((tx) => drafts.cancel(tx, draft.id, { expectedVersion: 1, reason: 'No longer needed', actor: OTHER }));
      expect(cancelled).toMatchObject({ from: 'DRAFT', document: { status: 'CANCELLED', effectStatus: 'EXPIRED', cancelReason: 'No longer needed' } });
      expect((await failure(inA((tx) => drafts.cancel(tx, draft.id, { expectedVersion: 2, reason: 'again', actor: OTHER })))).code).toBe('DOCUMENT_STATE_INVALID');
      const numbered = await inA((tx) => drafts.createDraft(tx, draftInput({ title: 'Numbered one' })));
      await owner("update machvon.outgoing_document set status = 'NUMBERED', leader_signed_at = now(), numbered_at = now(), allocation_id = gen_random_uuid() where id = $1", [numbered.id]);
      expect((await failure(inA((tx) => drafts.cancel(tx, numbered.id, { expectedVersion: 1, reason: 'too late', actor: OTHER })))).code).toBe('NUMBER_ALREADY_ALLOCATED');
    });

    it('keeps the history in order, finds the latest of some kinds and refuses to change a row', async () => {
      const draft = await inA((tx) => drafts.createDraft(tx, draftInput()));
      await inA(async (tx) => {
        await drafts.appendEvent(tx, { outgoingDocumentId: draft.id, kind: 'CREATED', fromStatus: null, toStatus: 'DRAFT', actor: DRAFTER, documentVersion: 1, occurredAt: NOW });
        await drafts.appendEvent(tx, { outgoingDocumentId: draft.id, kind: 'RETURNED', fromStatus: 'IN_REVIEW', toStatus: 'DRAFT', actor: OTHER, comment: 'why', details: { via: 'return' }, documentVersion: 2, occurredAt: NOW });
      });
      const events = await inA((tx) => drafts.eventsOf(tx, draft.id));
      expect(events.map((event) => [event.kind, event.fromStatus, event.toStatus, event.comment])).toEqual([
        ['CREATED', null, 'DRAFT', null],
        ['RETURNED', 'IN_REVIEW', 'DRAFT', 'why'],
      ]);
      expect(events[1]?.seq).toBeGreaterThan(events[0]?.seq ?? 0);
      expect((await inA((tx) => drafts.latestEvent(tx, draft.id, ['REVIEW_APPROVED', 'RETURNED'])))?.details).toEqual({ via: 'return' });
      expect(await inA((tx) => drafts.latestEvent(tx, draft.id, ['ISSUED']))).toBeUndefined();
      expect((await failure(inA((tx) => tx.query('update machvon.outgoing_document_event set comment = $2 where id = $1::uuid', [events[0]?.id, 'x'])))).sqlState).toBe('42501');
      expect((await failure(inA((tx) => tx.query("insert into machvon.outgoing_document_event (tenant_id, id, outgoing_document_id, kind, to_status, actor_id, document_version) values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, 'bad kind', 'DRAFT', $2::uuid, 1)", [draft.id, DRAFTER])))).sqlState).toBe('23514');
    });
  });

  describe('SignerAuthorityStore', () => {
    it('knows who is an active member at a moment', async () => {
      await harness.seedMembership(TENANT_A, 4, 1, { status: 'Suspended' });
      await harness.seedMembership(TENANT_A, 5, 1, { validFrom: '2027-01-01T00:00:00Z' });
      expect(await inA((tx) => authority.isActiveMember(tx, SIGNER, new Date(Date.now() + 1000)))).toBe(true);
      expect(await inA((tx) => authority.isActiveMember(tx, memberId(4), NOW))).toBe(false);
      expect(await inA((tx) => authority.isActiveMember(tx, memberId(5), NOW))).toBe(false);
      expect(await inA((tx) => authority.isActiveMember(tx, randomUUID(), NOW))).toBe(false);
    });

    it('finds the role over a unit by every kind of scope, inside the window of the grant', async () => {
      await harness.seedRole(TENANT_A, 1, 'SIGNING_ROLE', ['doc.outgoing.sign'], 40);
      await harness.seedGrants(TENANT_A, [
        { n: 1, member: 2, role: 1, kind: 'TENANT' },
        { n: 2, member: 3, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(1)] },
        { n: 3, member: 1, role: 1, kind: 'UNIT_ONLY', refs: [unitId(2)] },
      ]);
      const holds = (member: string, unit: string, at: Date = new Date(Date.now() + 1000)) => inA((tx) => authority.holdsRoleOnUnit(tx, { membershipId: member, roleId: roleId(1), unitId: unit, at }));
      expect(await holds(SIGNER, unitId(3))).toBe(true);
      expect(await holds(OTHER, unitId(2))).toBe(true);
      expect(await holds(OTHER, unitId(3))).toBe(false);
      expect(await holds(DRAFTER, unitId(2))).toBe(true);
      expect(await holds(DRAFTER, unitId(1))).toBe(false);
      expect(await holds(SIGNER, unitId(2), new Date('2025-01-01T00:00:00Z'))).toBe(false);
    });

    it('reads a delegation with whether it covers the unit, and the band of a rule', async () => {
      const id = randomUUID();
      await harness.owner(TENANT_A, [
        [
          `insert into machvon.delegation_grant (tenant_id, id, delegator_membership_id, delegate_membership_id, permissions, scope_json, valid_from, valid_until, reason, status)
           values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, array['doc.outgoing.sign'], $5::jsonb, '2026-10-01', '2026-11-01', 'test', 'Active')`,
          [TENANT_A, id, SIGNER, OTHER, JSON.stringify({ kind: 'UNIT_SUBTREE', ref_ids: [unitId(1)] })],
        ],
      ]);
      const inside = await inA((tx) => authority.delegation(tx, id, unitId(2)));
      expect(inside).toMatchObject({ id, delegatorMembershipId: SIGNER, delegateMembershipId: OTHER, permissions: ['doc.outgoing.sign'], status: 'Active', coversUnit: true });
      expect((await inA((tx) => authority.delegation(tx, id, unitId(3))))?.coversUnit).toBe(false);
      expect(await inA((tx) => authority.delegation(tx, randomUUID(), unitId(2)))).toBeUndefined();
      expect(await inA((tx) => authority.band(tx, randomUUID()))).toBeUndefined();
    });
  });

  describe('DocIssueRequestStore', () => {
    const request = (overrides: Partial<NewIssueRequest> = {}): NewIssueRequest => ({
      sourceModule: 'MNE',
      sourceRef: `MNE:report:${randomUUID()}:r1`,
      templateCode: 'QD-DEFAULT',
      payloadSha256: 'e'.repeat(64),
      payloadRef: `tenants/${TENANT_A}/payloads/x.json`,
      eventId: randomUUID(),
      signerHint: { drafting_unit_id: unitId(2) },
      recipientsHint: [{ name: 'A' }],
      requestedBy: DRAFTER,
      ...overrides,
    });

    it('records a request, answers the same event and the same open content with the first, and ends along the state machine', async () => {
      const input = request();
      const first = await inA((tx) => requests.insertReceived(tx, input));
      expect(first.outcome).toBe('INSERTED');
      const id = first.request.id;
      expect(first.request).toMatchObject({ status: 'RECEIVED', version: 1, rejectCode: null, outgoingDocumentId: null, completedAt: null, signerHint: { drafting_unit_id: unitId(2) } });
      const sameEvent = await inA((tx) => requests.insertReceived(tx, { ...input, sourceRef: 'MNE:other', payloadSha256: '1'.repeat(64) }));
      expect(sameEvent).toMatchObject({ outcome: 'DUPLICATE_EVENT', request: { id } });
      const sameContent = await inA((tx) => requests.insertReceived(tx, { ...input, eventId: randomUUID() }));
      expect(sameContent).toMatchObject({ outcome: 'ALREADY_OPEN', request: { id } });
      expect((await inA((tx) => requests.findByEvent(tx, 'MNE', input.eventId)))?.id).toBe(id);
      expect((await inA((tx) => requests.findOpen(tx, 'MNE', input.sourceRef, input.payloadSha256)))?.id).toBe(id);
      expect((await inA((tx) => requests.find(tx, id)))?.id).toBe(id);
      expect(await harness.tenants.withTenant(ctxB, (tx) => requests.find(tx, id))).toBeUndefined();
      const draft = await inA((tx) => drafts.createDraft(tx, draftInput({ source: { module: 'MNE', ref: input.sourceRef, issueRequestId: id } })));
      const accepted = await inA((tx) => requests.markAccepted(tx, id, { templateId, outgoingDocumentId: draft.id, actor: DRAFTER }));
      expect(accepted).toMatchObject({ status: 'ACCEPTED', version: 2, outgoingDocumentId: draft.id, templateId });
      expect(accepted.completedAt).not.toBeNull();
      await expect(inA((tx) => requests.markAccepted(tx, id, { templateId, outgoingDocumentId: draft.id, actor: DRAFTER }))).rejects.toThrow('received');
      expect((await inA((tx) => requests.markIssued(tx, draft.id, DRAFTER)))?.status).toBe('ISSUED');
      expect(await inA((tx) => requests.markIssued(tx, draft.id, DRAFTER))).toBeUndefined();
    });

    it('takes a request without hints, answers undefined for what is not there and lets any other violation through', async () => {
      const bare = await inA((tx) => requests.insertReceived(tx, request({ signerHint: null, recipientsHint: null })));
      expect(bare.request).toMatchObject({ signerHint: null, recipientsHint: null });
      expect(await inA((tx) => requests.findByEvent(tx, 'MNE', randomUUID()))).toBeUndefined();
      expect(await inA((tx) => requests.findOpen(tx, 'MNE', 'MNE:none', 'f'.repeat(64)))).toBeUndefined();
      expect(await inA((tx) => requests.find(tx, randomUUID()))).toBeUndefined();
      expect((await failure(inA((tx) => requests.insertReceived(tx, request({ sourceModule: 'not a module' }))))).sqlState).toBe('23514');
    });

    it('keeps a refusal and frees nothing but the content of a request that ended', async () => {
      const input = request();
      const inserted = await inA((tx) => requests.insertReceived(tx, input));
      const rejected = await inA((tx) => requests.markRejected(tx, inserted.request.id, { code: 'PAYLOAD_HASH_MISMATCH', templateId: null, actor: DRAFTER }));
      expect(rejected).toMatchObject({ status: 'REJECTED', rejectCode: 'PAYLOAD_HASH_MISMATCH' });
      await expect(inA((tx) => requests.markRejected(tx, inserted.request.id, { code: 'PAYLOAD_HASH_MISMATCH', templateId: null, actor: DRAFTER }))).rejects.toThrow('received');
      // A refused request is not open: the same content may ask again with a new event.
      expect((await inA((tx) => requests.insertReceived(tx, { ...input, eventId: randomUUID() }))).outcome).toBe('INSERTED');
      expect((await failure(inA((tx) => tx.query("update machvon.doc_issue_request set reject_code = 'OTHER' where id = $1::uuid", [inserted.request.id])))).sqlState).toBe('23514');
    });
  });

  describe('the external paths of the outgoing document store and the registers', () => {
    async function anchor(): Promise<string> {
      return (await inA((tx) => documents.insertDocument(tx, { docKind: 'OUTGOING', docTypeCode: 'QD', title: 'External', classification: 'INTERNAL', createdBy: ACTOR, issuerUnitId: unitId(2) }))).id;
    }
    let sequence = 0;
    const openRegister = (mode: 'MANAGED' | 'MIRRORED', year = 2026) => {
      sequence += 1;
      return inA((tx) => registers.openRegister(tx, { registerCode: `EXT-${sequence}`, name: 'External', direction: 'OUTGOING', organizationUnitId: unitId(2), year, mode, scopeDocTypes: ['QD'], actor: ACTOR }));
    };
    const external = (registerId: string, documentId: string, number: number, issuedOn = '2026-10-22') =>
      inA((tx) => registers.registerExternal(tx, { registerId, documentId, number, symbol: `${number}/QD-EXT${sequence}`, issuedOn, allocatedBy: DRAFTER }));

    it('takes the numbers of another system into a mirrored register and the next number into a managed one', async () => {
      const mirrored = await openRegister('MIRRORED');
      const first = await external(mirrored.id, await anchor(), 128);
      expect(first).toMatchObject({ number: 128, issuedOn: '2026-10-22' });
      expect((await inA((tx) => registers.findRegister(tx, mirrored.id)))?.lastNumber).toBe(128);
      await external(mirrored.id, await anchor(), 5);
      expect((await inA((tx) => registers.findRegister(tx, mirrored.id)))?.lastNumber).toBe(128);
      expect((await failure(external(mirrored.id, await anchor(), 128))).code).toBe('NUMBER_ALREADY_REGISTERED');
      const managed = await openRegister('MANAGED');
      expect((await failure(external(managed.id, await anchor(), 3))).code).toBe('REGISTER_MODE_MISMATCH');
      expect((await external(managed.id, await anchor(), 1)).number).toBe(1);
      expect((await external(managed.id, await anchor(), 2)).number).toBe(2);
    });

    it('refuses a closed register, another year, a document of another kind and a symbol that another document of the year carries', async () => {
      const register = await openRegister('MIRRORED');
      expect((await failure(external(register.id, await anchor(), 1, '2025-12-31'))).code).toBe('REGISTER_YEAR_MISMATCH');
      const incoming = (await inA((tx) => documents.insertDocument(tx, { docKind: 'INCOMING', docTypeCode: 'QD', title: 'In', classification: 'INTERNAL', createdBy: ACTOR }))).id;
      expect((await failure(external(register.id, incoming, 2))).code).toBe('DOCUMENT_STATE_INVALID');
      expect((await failure(external(randomUUID(), await anchor(), 2))).code).toBe('RESOURCE_NOT_FOUND');
      expect((await failure(inA((tx) => registers.registerExternal(tx, { registerId: register.id, documentId: randomUUID(), number: 2, symbol: '2/QD', issuedOn: '2026-10-22', allocatedBy: DRAFTER })))).code).toBe('RESOURCE_NOT_FOUND');
      await external(register.id, await anchor(), 7);
      const symbolOwner = await anchor();
      await inA((tx) => registers.registerExternal(tx, { registerId: register.id, documentId: symbolOwner, number: 8, symbol: 'SAME/QD-X', issuedOn: '2026-10-22', allocatedBy: DRAFTER }));
      const another = await anchor();
      expect((await failure(inA((tx) => registers.registerExternal(tx, { registerId: register.id, documentId: another, number: 9, symbol: 'SAME/QD-X', issuedOn: '2026-10-22', allocatedBy: DRAFTER })))).code).toBe('NUMBER_ALREADY_REGISTERED');
      const current = await inA((tx) => registers.findRegister(tx, register.id));
      await inA((tx) => registers.closeRegister(tx, register.id, { expectedVersion: current?.version ?? 0, reason: 'closed for the year', actor: ACTOR }));
      expect((await failure(external(register.id, another, 20))).code).toBe('REGISTER_NOT_OPEN');
    });

    it('writes an issued document that came from outside, and moves a submitted one to SIGNED by an external signature', async () => {
      const register = await openRegister('MIRRORED');
      const documentId = await anchor();
      const allocation = await external(register.id, documentId, 40);
      const issued = await inA((tx) =>
        outgoing.insertIssuedExternally(tx, {
          documentId,
          layoutProfileId,
          draftingUnitId: unitId(2),
          registerId: register.id,
          allocationId: allocation.allocationId,
          recipients: [{ name: 'A' }],
          leaderSignedAt: new Date('2026-10-22T03:00:00Z'),
          sealedAt: new Date('2026-10-22T05:00:00Z'),
          issuedAt: NOW,
          actor: DRAFTER,
        }),
      );
      expect(issued).toMatchObject({ status: 'ISSUED', route: 'EXTERNAL_UPLOAD', effectStatus: 'EFFECTIVE', symbol: `40/QD-EXT${sequence}`, documentNumber: 40, signerUserId: null, clerkUserId: DRAFTER });
      const draft = await inA((tx) => drafts.createDraft(tx, draftInput()));
      await inA((tx) => drafts.submit(tx, draft.id, { expectedVersion: 1, actor: DRAFTER }));
      await inA((tx) => drafts.approve(tx, draft.id, { expectedVersion: 2, actor: OTHER }));
      const signed = await inA((tx) => outgoing.markSignedExternally(tx, draft.id, { expectedVersion: 3, signedAt: new Date('2026-10-22T03:00:00Z'), actor: OTHER }));
      expect(signed).toMatchObject({ status: 'SIGNED', route: 'EXTERNAL_UPLOAD', leaderSignedAt: new Date('2026-10-22T03:00:00Z') });
      expect((await failure(inA((tx) => outgoing.markSignedExternally(tx, draft.id, { expectedVersion: 4, signedAt: NOW, actor: OTHER })))).code).toBe('DOCUMENT_STATE_INVALID');
    });

    it('issues a sealed document: SEALED to ISSUED and in force', async () => {
      const draft = await inA((tx) => drafts.createDraft(tx, draftInput()));
      await owner(
        "update machvon.outgoing_document set status = 'SEALED', leader_signed_at = now() - interval '2 hour', numbered_at = now() - interval '1 hour', sealed_at = now(), allocation_id = gen_random_uuid() where id = $1",
        [draft.id],
      );
      await owner("update machvon.document set document_number = 9, number_year = 2026, symbol = '9/QD-ISS', issued_on = date '2026-10-23' where id = $1", [draft.documentId]);
      const issued = await inA((tx) => outgoing.markIssued(tx, draft.id, { expectedVersion: 1, issuedAt: NOW, actor: DRAFTER }));
      expect(issued).toMatchObject({ status: 'ISSUED', effectStatus: 'EFFECTIVE', issuedAt: NOW });
      expect((await failure(inA((tx) => outgoing.markIssued(tx, draft.id, { expectedVersion: 2, issuedAt: NOW, actor: DRAFTER })))).code).toBe('DOCUMENT_STATE_INVALID');
    });
  });

  describe('the guards of V1221 and V1222', () => {
    it('fixes the content of a document that left the draft, the template and the source for good, and the title of its anchor', async () => {
      const draft = await inA((tx) => drafts.createDraft(tx, draftInput()));
      const update = (assignments: string) => inA((tx) => tx.query(`update machvon.outgoing_document set ${assignments} where id = $1::uuid`, [draft.id]));
      await update("urgency = 'KHAN'");
      expect((await failure(update("template_id = gen_random_uuid()"))).sqlState).toBeDefined();
      expect((await failure(update("source_module = 'MNE', source_ref = 'MNE:x'"))).sqlState).toBe('23514');
      expect((await failure(update("status = 'IN_REVIEW', recipients = '[]'::jsonb"))).sqlState).toBe('23514');
    });

    it('lets the document anchor of a cancelled draft carry no symbol, and no other effect than the ones the checks list', async () => {
      const draft = await inA((tx) => drafts.createDraft(tx, draftInput()));
      await inA((tx) => drafts.cancel(tx, draft.id, { expectedVersion: 1, reason: 'cancelled draft', actor: DRAFTER }));
      expect((await owner<{ effect_status: string; symbol: string | null }>('select effect_status, symbol from machvon.document where id = $1', [draft.documentId]))[0]).toEqual({ effect_status: 'EXPIRED', symbol: null });
      expect((await failure(inA((tx) => tx.query("update machvon.document set effect_status = 'EFFECTIVE' where id = $1::uuid", [draft.documentId])))).sqlState).toBe('23514');
    });
  });
});
