import { X509Certificate, createHash, randomUUID } from 'node:crypto';
import { DoaMatrixStore, OutgoingDraftStore } from '@machvon/db';
import { fingerprintOf } from '../../src/modules/doc/cms-verification';
import { MockSigningPort } from '../../src/modules/doc/signing-port';
import { ACTOR, ADMIN, BOARD, CLERK, DRAFTER, DocApp, LEADER, MAKER, NOBODY, NOW, REVIEWER, TENANT_A, TENANT_B, UNIT_TWO_CLERK, memberId, unitId } from './doc-app';
import { roleId } from '../../../../packages/db/test/support/authz-fixtures';
import { createWorld } from './support/pki-world';
import type { World } from './support/pki-world';

jest.setTimeout(180_000);

const app = new DocApp();
const drafts = new OutgoingDraftStore();
let world: World;
const ctx = (member: number = ADMIN) => ({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 });
const owner = <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => app.harness.owner<T>(TENANT_A, [[sql, params]]);
const count = (sql: string, params: unknown[] = []): Promise<number> => app.count(sql, params);
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const ROLE_SIGNER = roleId(4);
const ROLE_BOARD = roleId(8);
const CHECKLIST = { national_title: true, motto: true, agency_name: true, number_symbol: true, summary: true, body: true, signer_title: true, recipients: true };
const RECIPIENTS = [{ name: 'People Committee of Cao Bang', kind: 'EXTERNAL_AGENCY' }, { name: 'Department archive', kind: 'INTERNAL_UNIT', unit_id: unitId(2) }];
const BAND_LIMIT = '5000000000';

let delegationValid = '';
let delegationExpired = '';
let delegationWrongHolder = '';

const payloadOf = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  agency: 'People Committee of Cao Bang',
  place: 'Cao Bang',
  title: 'Decision on the assignment of the capital plan',
  body: 'The capital plan of 2026 is assigned to the units listed in the annex.',
  signer_title: 'CHAIRMAN',
  ...extra,
});

function createBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    doc_type_code: 'QD',
    template_code: 'QD-DEFAULT',
    title: 'Decision on the assignment of the capital plan',
    drafting_unit_id: unitId(2),
    payload: payloadOf({ amount_vnd: '1000000000' }),
    recipients: RECIPIENTS,
    signer_user_id: memberId(LEADER),
    ...overrides,
  };
}

const create = (body: Record<string, unknown>, member: number = MAKER, key?: string) => app.call('POST', '/outgoing-documents', { member, body, ...(key === undefined ? {} : { key }) });
const update = (id: string, version: number, body: Record<string, unknown>, member: number = MAKER) =>
  app.call('POST', `/outgoing-documents/${id}/draft`, { member, ifMatch: `"${version}"`, body });
const submit = (id: string, version: number, member: number = MAKER) => app.call('POST', `/outgoing-documents/${id}/review-submission`, { member, ifMatch: `"${version}"` });
const decide = (id: string, version: number, body: Record<string, unknown>, member: number = REVIEWER) =>
  app.call('POST', `/outgoing-documents/${id}/review-decision`, { member, ifMatch: `"${version}"`, body });
const sendBack = (id: string, version: number, reason: string, member: number = REVIEWER) =>
  app.call('POST', `/outgoing-documents/${id}/return`, { member, ifMatch: `"${version}"`, body: { reason } });
const cancel = (id: string, version: number, body: Record<string, unknown>, member: number = MAKER) =>
  app.call('POST', `/outgoing-documents/${id}/cancellation`, { member, ifMatch: `"${version}"`, body });
const startLeader = (id: string, member: number, version: number) => app.call('POST', `/outgoing-documents/${id}/leader-signing-sessions`, { member, ifMatch: `"${version}"`, body: {} });
const read = (id: string, member: number = ADMIN) => app.call('GET', `/outgoing-documents/${id}`, { member });

async function row(id: string): Promise<{ status: string; version: string; signer_user_id: string | null; current_version_id: string | null; effect_status: string }> {
  const [found] = await owner<{ status: string; version: string; signer_user_id: string | null; current_version_id: string | null; effect_status: string }>(
    `select o.status, o.version::text as version, o.signer_user_id, d.current_version_id, d.effect_status
       from machvon.outgoing_document o join machvon.document d on d.id = o.document_id where o.id = $1`,
    [id],
  );
  if (found === undefined) throw new Error('no document');
  return found;
}

/** A draft that went through create, submit and approve: SUBMITTED with its final PDF, ready for the signer. */
async function submitted(overrides: Record<string, unknown> = {}): Promise<{ id: string; documentId: string; version: number }> {
  const made = await create(createBody(overrides));
  expect([made.status, made.json.code]).toEqual([200, undefined]);
  const id = made.json.resource_id as string;
  expect((await submit(id, 1)).status).toBe(200);
  const approved = await decide(id, 2, { decision: 'APPROVE', format_checklist: CHECKLIST });
  expect(approved.status).toBe(200);
  return { id, documentId: made.json.document_id as string, version: approved.json.resource_version as number };
}

/** An IN_REVIEW document written straight into the database: how a document looks when the matrix changed after it was submitted. */
async function seedInReview(options: { signer: number; amount: string; drafter?: number; mode?: string; delegation?: string }): Promise<string> {
  return app.harness.tenants.withTenant(ctx(MAKER), async (tx) => {
    const draft = await drafts.createDraft(tx, {
      docTypeCode: 'QD',
      title: 'Seeded decision',
      draftingUnitId: unitId(2),
      templateId: app.templateId,
      layoutProfileId: app.layoutProfileId,
      urgency: 'NORMAL',
      circulation: 'INTERNAL_CIRCULATION',
      classification: 'INTERNAL',
      payload: payloadOf({ amount_vnd: options.amount }),
      payloadSha256: 'a'.repeat(64),
      recipients: [{ kind: 'EXTERNAL_AGENCY', name: 'Somebody' }],
      signerUserId: memberId(options.signer),
      signerTitle: 'CHAIRMAN',
      signingMode: (options.mode ?? 'DIRECT') as 'DIRECT',
      delegationId: options.delegation ?? null,
      subjectModule: null,
      subjectId: null,
      replyToIncomingId: null,
      reviewDueOn: null,
      actor: memberId(options.drafter ?? MAKER),
    });
    await drafts.submit(tx, draft.id, { expectedVersion: draft.version, actor: memberId(options.drafter ?? MAKER) });
    return draft.id;
  });
}

async function registerCertificate(kind: string, holder: string | null, unit: string | null, subject: string, bytes: Buffer): Promise<void> {
  await app.harness.owner(TENANT_A, [
    [
      `insert into machvon.signing_certificate (tenant_id, id, kind, holder_membership_id, organization_unit_id, certificate_serial, issuer_dn, subject_dn, provider_code, valid_from, valid_until, fingerprint_sha256, status, registered_by)
       values ($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, '01', 'CN=Test Root CA', $6, 'MOCK', '2026-01-01', '2030-01-01', $7, 'Active', $8::uuid)`,
      [TENANT_A, randomUUID(), kind, holder, unit, subject, fingerprintOf(new X509Certificate(bytes)), ACTOR],
    ],
  ]);
}

async function delegation(options: { from: string; until: string; delegator: number; delegate: number; permissions?: string[]; unit?: string; status?: string }): Promise<string> {
  const id = randomUUID();
  await app.harness.owner(TENANT_A, [
    [
      `insert into machvon.delegation_grant (tenant_id, id, delegator_membership_id, delegate_membership_id, permissions, scope_json, valid_from, valid_until, reason, status)
       values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text[], $6::jsonb, $7::timestamptz, $8::timestamptz, 'test', $9)`,
      [TENANT_A, id, memberId(options.delegator), memberId(options.delegate), options.permissions ?? ['doc.outgoing.sign'], JSON.stringify({ kind: 'UNIT_SUBTREE', ref_ids: [options.unit ?? unitId(2)] }), options.from, options.until, options.status ?? 'Active'],
    ],
  ]);
  return id;
}

describe('outgoing documents: compose, review and submit for signature (ST-DOC-007)', () => {
  beforeAll(async () => {
    world = await createWorld();
    await app.start();
    app.anchors = [{ regime: 'PUBLIC_CA', certificate: world.root.certificate }];
    const clock = (): Date => app.now;
    app.signing.register(fingerprintOf(new X509Certificate(world.leader.certificate)), new MockSigningPort({ identity: world.leader, clock, timestamps: world.tsa }));
    world.setTime(NOW);
    // The members were seeded with the real clock; the clock of the module runs in October 2026.
    await app.harness.owner(TENANT_A, [["update machvon.membership set valid_from = '2020-01-01'"]]);
    await registerCertificate('PERSONAL', memberId(LEADER), null, 'CN=Nguyen Van A', world.leader.certificate);
    const type = await app.call('POST', '/document-types', {
      member: ADMIN,
      body: { code: 'QD', name: 'Decision', abbreviation: 'QD', symbol_kind: 'DECISION', symbol_pattern: '{number}/{type}-{agency}', register_code: 'REG-QD', legal_basis: 'ND 30/2020', effective_from: '2026-01-01' },
    });
    expect(type.status).toBe(200);
    // The matrix in force: up to 5 billion the role of LEADER signs a decision, above it the board.
    const matrix = new DoaMatrixStore();
    await app.harness.tenants.withTenant(ctx(ADMIN), async (tx) => {
      const draft = await matrix.createDraft(
        tx,
        {
          effective_from: '2026-01-01',
          legal_basis_ref: 'Internal regulation 12/QD-2026',
          rules: [
            { document_type: 'QD', unit_id: unitId(1), amount_min_vnd: '0', amount_max_vnd: BAND_LIMIT, approver_role_id: ROLE_SIGNER },
            { document_type: 'QD', unit_id: unitId(1), amount_min_vnd: BAND_LIMIT, amount_max_vnd: null, approver_role_id: ROLE_BOARD },
          ],
        },
        memberId(ADMIN),
      );
      await matrix.submit(tx, draft.id, draft.version, memberId(ADMIN));
      await matrix.decide(tx, draft.id, draft.version + 1, 'approve', memberId(REVIEWER));
    });
    const notice = await app.call('POST', '/document-types', {
      member: ADMIN,
      body: { code: 'TB', name: 'Notice', abbreviation: 'TB', symbol_kind: 'NAMED_TYPE', symbol_pattern: '{number}/{type}-{agency}', register_code: 'REG-TB', legal_basis: 'ND 30/2020', effective_from: '2026-01-01' },
    });
    expect(notice.status).toBe(200);
    await app.harness.owner(TENANT_A, [
      [
        `insert into machvon.document_template (tenant_id, id, template_code, revision, group_code, doc_type_code, title, layout_profile_id, body_blocks, placeholder_schema, legal_basis,
            confirmation_status, watermark_text, origin, content_sha256, effective_from, status, created_by, updated_by)
         select tenant_id, gen_random_uuid(), 'TB-DEFAULT', 1, group_code, 'TB', title, layout_profile_id, body_blocks, placeholder_schema, legal_basis, confirmation_status, watermark_text, origin,
            content_sha256, effective_from, status, created_by, updated_by from machvon.document_template where id = $1`,
        [app.templateId],
      ],
    ]);
    delegationValid = await delegation({ from: '2026-10-01T00:00:00Z', until: '2026-11-15T00:00:00Z', delegator: BOARD, delegate: LEADER });
    delegationExpired = await delegation({ from: '2026-08-01T00:00:00Z', until: '2026-09-01T00:00:00Z', delegator: BOARD, delegate: LEADER });
    delegationWrongHolder = await delegation({ from: '2026-10-01T00:00:00Z', until: '2026-11-15T00:00:00Z', delegator: CLERK, delegate: LEADER });
  }, 300_000);

  afterAll(() => app.stop(), 60_000);

  afterEach(() => {
    app.now = NOW;
    world.setTime(NOW);
    app.signing.setAvailable(true);
  });

  describe('createOutgoingDocument', () => {
    it('writes the anchor, the draft, the history and the event, with the stored (normalised) payload', async () => {
      const reply = await create(createBody({ payload: payloadOf({ amount_vnd: 2000000000, title: 'Decision Å' }), urgency: 'KHAN' }));
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ status: 'DRAFT', resource_version: 1 });
      const id = reply.json.resource_id as string;
      const detail = await read(id);
      expect(detail.status).toBe(200);
      expect(detail.json).toMatchObject({
        status: 'DRAFT',
        route: 'IN_SYSTEM',
        urgency: 'KHAN',
        effect_status: 'PENDING',
        classification: 'INTERNAL',
        drafter_user_id: memberId(MAKER),
        signer_user_id: memberId(LEADER),
        signing_mode: 'DIRECT',
        doc_type_code: 'QD',
      });
      // A number is stored as decimal text and a name in NFC, so the same content always gives the same hash (BR-DOC-11).
      expect((detail.json.payload as Record<string, unknown>).amount_vnd).toBe('2000000000');
      expect((detail.json.payload as Record<string, unknown>).title).toBe('Decision Å');
      expect(detail.json.payload_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(detail.json.recipients).toEqual([
        { kind: 'EXTERNAL_AGENCY', name: 'People Committee of Cao Bang' },
        { kind: 'INTERNAL_UNIT', name: 'Department archive', unit_id: unitId(2) },
      ]);
      const events = await owner<{ kind: string; to_status: string }>('select kind, to_status from machvon.outgoing_document_event where outgoing_document_id = $1', [id]);
      expect(events).toEqual([{ kind: 'CREATED', to_status: 'DRAFT' }]);
      const outbox = await owner<{ type: string }>('select type from machvon.outbox_event where aggregate_id = $1', [id]);
      expect(outbox.map((event) => event.type)).toEqual(['doc.draft_created.v1']);
      const audit = await owner<{ action: string; outcome: string }>('select action, outcome from machvon.audit_event where resource_id = $1', [id]);
      expect(audit).toEqual([{ action: 'outgoing_document.create', outcome: 'SUCCESS' }]);
    });

    it('takes the template of the document type when none is named, and merges content_blocks into the payload', async () => {
      const reply = await create(createBody({ template_code: undefined, content_blocks: { annex: 'Annex 1' } }));
      expect(reply.status).toBe(200);
      const detail = await read(reply.json.resource_id as string);
      expect((detail.json.payload as Record<string, unknown>).content_blocks).toEqual({ annex: 'Annex 1' });
      expect(detail.json.template_id).toBe(app.templateId);
      const twice = await create(createBody({ payload: payloadOf({ content_blocks: 'x' }), content_blocks: { annex: 'Annex 1' } }));
      expect([twice.status, twice.json.code]).toEqual([422, 'PAYLOAD_SCHEMA_INVALID']);
    });

    it('answers the same call with the same key once, and refuses the same key with another body', async () => {
      const key = `create-${randomUUID()}`;
      const before = await count('select count(*) as n from machvon.outgoing_document');
      const first = await create(createBody(), MAKER, key);
      const again = await create(createBody(), MAKER, key);
      expect(again.json.resource_id).toBe(first.json.resource_id);
      expect(await count('select count(*) as n from machvon.outgoing_document')).toBe(before + 1);
      const other = await create(createBody({ title: 'Another title' }), MAKER, key);
      expect([other.status, other.json.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    });

    it.each([
      ['an unknown template', { template_code: 'NO-SUCH-TEMPLATE' }, 422, 'TEMPLATE_NOT_EFFECTIVE'],
      ['a template of another document type', { doc_type_code: 'CV' }, 422, 'VALIDATION_FAILED'],
      ['a document type that does not exist', { doc_type_code: 'ZZ', template_code: undefined }, 422, 'VALIDATION_FAILED'],
      ['a payload that is not an object', { payload: ['x'] }, 400, 'INVALID_REQUEST'],
      ['a title that is only blanks', { title: '     ' }, 422, 'VALIDATION_FAILED'],
      ['an amount that is not whole VND', { payload: payloadOf({ amount_vnd: '12.5' }) }, 422, 'PAYLOAD_SCHEMA_INVALID'],
      ['a subject module without an id', { subject_module: 'PRJ' }, 422, 'SUBJECT_REF_INVALID'],
      ['a reply to a document that was never received', { reply_to_incoming_id: randomUUID() }, 422, 'SUBJECT_REF_INVALID'],
      ['a recipient without a name', { recipients: [{ name: ' ' }] }, 422, 'VALIDATION_FAILED'],
      ['a recipient with an unknown member', { recipients: [{ name: 'A', phone: '1' }] }, 422, 'VALIDATION_FAILED'],
      ['a recipient unit of another tenant', { recipients: [{ name: 'A', unit_id: randomUUID() }] }, 422, 'VALIDATION_FAILED'],
      ['a drafting unit that does not exist', { drafting_unit_id: randomUUID() }, 422, 'VALIDATION_FAILED'],
      ['a signer who is not a member', { signer_user_id: randomUUID() }, 422, 'VALIDATION_FAILED'],
      ['a delegation on a direct signature', { delegation_id: randomUUID() }, 422, 'VALIDATION_FAILED'],
    ])('refuses %s', async (_name, overrides, status, code) => {
      const before = await count('select count(*) as n from machvon.outgoing_document');
      const reply = await create(createBody(overrides));
      expect([reply.status, reply.json.code]).toEqual([status, code]);
      expect(await count('select count(*) as n from machvon.outgoing_document')).toBe(before);
    });

    it('hides a drafting unit outside the grant of the caller and refuses a caller without the permission', async () => {
      const outside = await create(createBody({ drafting_unit_id: unitId(1) }));
      expect([outside.status, outside.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const nobody = await create(createBody(), NOBODY);
      expect([nobody.status, nobody.json.code]).toEqual([403, 'SCOPE_DENIED']);
    });

    it('declares a state secret as not supported: no row, no file, a DENIED audit entry (AC-ST-DOC-007-4, UAT-AC429)', async () => {
      const documents = await count('select count(*) as n from machvon.document');
      const outgoing = await count('select count(*) as n from machvon.outgoing_document');
      for (const declared of [{ secrecy_level: 'Tuyệt mật' }, { annex: { Độ_mật: 'TỐI MẬT' } }, { security_level: 'mat' }]) {
        const reply = await create(createBody({ payload: payloadOf(declared) }));
        expect([reply.status, reply.json.code]).toEqual([422, 'STATE_SECRET_NOT_SUPPORTED']);
      }
      expect(await count('select count(*) as n from machvon.document')).toBe(documents);
      expect(await count('select count(*) as n from machvon.outgoing_document')).toBe(outgoing);
      const denied = await owner<{ safe_diff: { reason: string; field: string } }>(
        "select safe_diff from machvon.audit_event where action = 'outgoing_document.create' and outcome = 'DENIED' order by occurred_at",
      );
      expect(denied).toHaveLength(3);
      expect(denied[0]?.safe_diff.reason).toBe('STATE_SECRET_NOT_SUPPORTED');
      // The audit row names the member that declared the level and keeps the declared value out.
      expect(JSON.stringify(denied)).not.toMatch(/Tuyệt|TỐI|mat"/);
      // The data classification of the platform (CONFIDENTIAL) is not a state secret.
      const fine = await create(createBody({ payload: payloadOf({ classification: 'CONFIDENTIAL', secrecy_level: 'public' }) }));
      expect(fine.status).toBe(200);
    });
  });

  describe('updateOutgoingDocumentDraft', () => {
    it('changes the draft under If-Match: the second editor of the same version gets 409 VERSION_CONFLICT', async () => {
      const made = await create(createBody());
      const id = made.json.resource_id as string;
      const first = await update(id, 1, { title: 'A better title', urgency: 'HOA_TOC', recipients: [{ name: 'Only one' }] });
      expect(first.status).toBe(200);
      expect(first.json.resource_version).toBe(2);
      const second = await update(id, 1, { title: 'The other title' });
      expect([second.status, second.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const detail = await read(id);
      expect(detail.json).toMatchObject({ title: 'A better title', urgency: 'HOA_TOC', version: 2 });
      expect(detail.json.recipients).toEqual([{ kind: 'EXTERNAL_AGENCY', name: 'Only one' }]);
    });

    it('replaces the payload and keeps its hash and the signer title in step', async () => {
      const made = await create(createBody());
      const id = made.json.resource_id as string;
      const before = (await read(id)).json.payload_sha256;
      const changed = await update(id, 1, { payload: payloadOf({ body: 'A new body', signer_title: 'VICE CHAIRMAN' }) });
      expect(changed.status).toBe(200);
      const detail = await read(id);
      expect(detail.json.payload_sha256).not.toBe(before);
      expect(detail.json.signer_title).toBe('VICE CHAIRMAN');
      const events = await owner<{ type: string }>('select type from machvon.outbox_event where aggregate_id = $1 order by created_at', [id]);
      expect(events.map((event) => event.type)).toEqual(['doc.draft_created.v1', 'doc.draft_updated.v1']);
    });

    it('replaces content_blocks on a later edit that sends no payload, and still refuses a payload that carries content_blocks of its own next to them', async () => {
      const made = await create(createBody({ content_blocks: { annex: 'Annex 1' } }));
      const id = made.json.resource_id as string;
      const again = await update(id, 1, { content_blocks: { annex: 'Annex 2' } });
      expect([again.status, again.json.code]).toEqual([200, undefined]);
      expect(((await read(id)).json.payload as Record<string, unknown>).content_blocks).toEqual({ annex: 'Annex 2' });
      const both = await update(id, 2, { payload: payloadOf({ content_blocks: 'x' }), content_blocks: { annex: 'Annex 3' } });
      expect([both.status, both.json.code]).toEqual([422, 'PAYLOAD_SCHEMA_INVALID']);
    });

    it('refuses an empty change, a state secret, and a field the draft does not have', async () => {
      const made = await create(createBody());
      const id = made.json.resource_id as string;
      expect((await update(id, 1, {})).json.code).toBe('VALIDATION_FAILED');
      const blank = await update(id, 1, { title: '     ' });
      expect([blank.status, blank.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const secret = await update(id, 1, { payload: payloadOf({ secrecy_level: 'mat' }) });
      expect([secret.status, secret.json.code]).toEqual([422, 'STATE_SECRET_NOT_SUPPORTED']);
      const extra = await update(id, 1, { status: 'SUBMITTED' });
      expect(extra.status).toBe(400);
      expect((await row(id)).status).toBe('DRAFT');
    });

    it('is closed once the draft is in review, and a caller outside the unit does not see it', async () => {
      const made = await create(createBody());
      const id = made.json.resource_id as string;
      expect((await submit(id, 1)).status).toBe(200);
      const late = await update(id, 2, { title: 'Too late' });
      expect([late.status, late.json.code]).toEqual([409, 'DOCUMENT_STATE_INVALID']);
      const unseen = await update(randomUUID(), 2, { title: 'Elsewhere' });
      expect(unseen.status).toBe(404);
    });

    it('switches to a delegated signature only with a delegation in force, and back to a direct one by dropping it', async () => {
      const made = await create(createBody());
      const id = made.json.resource_id as string;
      const without = await update(id, 1, { signing_mode: 'TUQ' });
      expect([without.status, without.json.code]).toEqual([422, 'SIGNER_NOT_AUTHORIZED']);
      const delegated = await update(id, 1, { signing_mode: 'KT', delegation_id: delegationValid });
      expect(delegated.status).toBe(200);
      expect((await read(id)).json).toMatchObject({ signing_mode: 'KT', delegation_id: delegationValid });
      const direct = await update(id, 2, { signing_mode: 'DIRECT' });
      expect(direct.status).toBe(200);
      expect((await read(id)).json).toMatchObject({ signing_mode: 'DIRECT', delegation_id: null });
    });
  });

  describe('submitOutgoingDocumentForReview and decideOutgoingDocumentReview', () => {
    it('takes a draft missing recipients and signer through the checks in steps, then locks the final PDF with its SHA-256 (AC-ST-DOC-007-2, UAT-AC428)', async () => {
      const made = await create(createBody({ recipients: undefined, signer_user_id: undefined, payload: payloadOf({ amount_vnd: '6000000000' }) }));
      const id = made.json.resource_id as string;
      const empty = await submit(id, 1);
      expect([empty.status, empty.json.code]).toEqual([422, 'FORMAT_CHECK_FAILED']);
      expect(empty.json.failures).toEqual([
        { field: 'recipients', code: 'RECIPIENTS_REQUIRED' },
        { field: 'signer_user_id', code: 'SIGNER_REQUIRED' },
      ]);
      // A signer without the role of the high band is refused with the threshold that decided.
      const filled = await update(id, 1, { recipients: RECIPIENTS, signer_user_id: memberId(LEADER) });
      expect(filled.status).toBe(200);
      const wrong = await submit(id, 2);
      expect([wrong.status, wrong.json.code]).toEqual([422, 'SIGNER_NOT_AUTHORIZED']);
      expect(wrong.json).toMatchObject({ reason: 'ROLE_NOT_HELD', threshold: { document_type: 'QD', amount_vnd: '6000000000', amount_min_vnd: BAND_LIMIT, amount_max_vnd: null, approver_role_id: ROLE_BOARD } });
      expect((await row(id)).status).toBe('DRAFT');
      const board = await update(id, 2, { signer_user_id: memberId(BOARD) });
      expect(board.status).toBe(200);
      const review = await submit(id, 3);
      expect(review.status).toBe(200);
      expect(review.json.status).toBe('IN_REVIEW');
      // The final PDF is not there before the approval.
      expect((await row(id)).current_version_id).toBeNull();
      const approved = await decide(id, 4, { decision: 'APPROVE', comment: 'Format checked', format_checklist: CHECKLIST });
      expect(approved.status).toBe(200);
      expect(approved.json).toMatchObject({ status: 'SUBMITTED', resource_version: 5 });
      const final = await owner<{ id: string; checksum: string; stage: string; classification: string; scan_status: string; template_id: string; renderer_version: string }>(
        'select id, checksum, stage, classification, scan_status, template_id, renderer_version from machvon.document_version where document_id = $1',
        [made.json.document_id],
      );
      expect(final).toHaveLength(1);
      expect(final[0]).toMatchObject({ stage: 'RENDERED_FINAL', classification: 'INTERNAL', scan_status: 'CLEAN', template_id: app.templateId });
      expect(approved.json.file_sha256).toBe(final[0]?.checksum);
      expect(approved.json.version_id).toBe(final[0]?.id);
      const stored = await owner<{ object_key: string }>('select object_key from machvon.document_version where id = $1', [final[0]?.id]);
      const file = await app.files.get(stored[0]?.object_key ?? '');
      expect(sha256(file?.bytes ?? new Uint8Array())).toBe(final[0]?.checksum);
      // The record of the review keeps the checklist, the comment and the hash; the drafter reads them back.
      const detail = await read(id);
      expect(detail.json.latest_review).toMatchObject({ kind: 'REVIEW_APPROVED', comment: 'Format checked', file_sha256: final[0]?.checksum, actor_id: memberId(REVIEWER) });
      expect((detail.json.latest_review as { checklist: Record<string, boolean> }).checklist).toEqual(CHECKLIST);
      const types = await owner<{ type: string }>('select type from machvon.outbox_event where aggregate_id = $1 order by created_at, id', [id]);
      expect(types.map((event) => event.type)).toEqual(['doc.draft_created.v1', 'doc.draft_updated.v1', 'doc.draft_updated.v1', 'doc.review_requested.v1', 'doc.submitted.v1']);
    });

    it('refuses the unfinished payload by field, and an incomplete or false checklist by item', async () => {
      const made = await create(createBody({ payload: { agency: 'People Committee', amount_vnd: '1000' } }));
      const id = made.json.resource_id as string;
      const incomplete = await submit(id, 1);
      expect([incomplete.status, incomplete.json.code]).toEqual([422, 'FORMAT_CHECK_FAILED']);
      expect(incomplete.json.failures).toEqual(expect.arrayContaining([{ field: 'payload.place', code: 'PAYLOAD_FIELD_REQUIRED' }, { field: 'payload.title', code: 'PAYLOAD_FIELD_REQUIRED' }]));
      expect((await update(id, 1, { payload: payloadOf({ amount_vnd: '1000' }) })).status).toBe(200);
      expect((await submit(id, 2)).status).toBe(200);
      const missing = await decide(id, 3, { decision: 'APPROVE', format_checklist: { ...CHECKLIST, motto: false, recipients: undefined } });
      expect([missing.status, missing.json.code]).toEqual([422, 'FORMAT_CHECK_FAILED']);
      expect(missing.json.failures).toEqual([
        { field: 'format_checklist.motto', code: 'CHECK_NOT_CONFIRMED' },
        { field: 'format_checklist.recipients', code: 'CHECK_NOT_CONFIRMED' },
      ]);
      const none = await decide(id, 3, { decision: 'APPROVE' });
      expect((none.json.failures as unknown[]).length).toBe(8);
      expect((await row(id)).status).toBe('IN_REVIEW');
    });

    it('refuses a template that stopped being in force, at submission and at approval', async () => {
      const made = await create(createBody());
      const id = made.json.resource_id as string;
      expect((await submit(id, 1)).status).toBe(200);
      await app.harness.owner(TENANT_A, [["update machvon.document_template set effective_until = '2026-10-01' where id = $1", [app.templateId]]]);
      try {
        const approval = await decide(id, 2, { decision: 'APPROVE', format_checklist: CHECKLIST });
        expect([approval.status, approval.json.code]).toEqual([422, 'TEMPLATE_NOT_EFFECTIVE']);
        const another = await create(createBody({ template_code: undefined }));
        expect([another.status, another.json.code]).toEqual([422, 'TEMPLATE_NOT_EFFECTIVE']);
      } finally {
        await app.harness.owner(TENANT_A, [['update machvon.document_template set effective_until = null where id = $1', [app.templateId]]]);
      }
      expect((await row(id)).status).toBe('IN_REVIEW');
    });

    it('refuses a self-approval, a signer without the authority, a clerk who starts signing and a leader who numbers: four DENIED rows (AC-ST-DOC-007-1, UAT-AC414)', async () => {
      const id = await seedInReview({ signer: LEADER, amount: '6000000000' });
      const denied = async (): Promise<number> => count("select count(*) as n from machvon.audit_event where outcome = 'DENIED'");
      const before = await denied();
      const self = await decide(id, 2, { decision: 'APPROVE', format_checklist: CHECKLIST }, MAKER);
      expect([self.status, self.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      const unauthorised = await decide(id, 2, { decision: 'APPROVE', format_checklist: CHECKLIST });
      expect([unauthorised.status, unauthorised.json.code]).toEqual([422, 'SIGNER_NOT_AUTHORIZED']);
      expect(unauthorised.json).toMatchObject({ reason: 'ROLE_NOT_HELD', threshold: { amount_min_vnd: BAND_LIMIT, approver_role_id: ROLE_BOARD } });
      const clerk = await startLeader(id, UNIT_TWO_CLERK, 2);
      expect([clerk.status, clerk.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const leader = await app.call('POST', `/outgoing-documents/${id}/numbering`, { member: LEADER, ifMatch: '"2"', body: { register_id: randomUUID() } });
      expect([leader.status, leader.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect(await denied()).toBe(before + 4);
      // Nothing moved: the document is still waiting for a reviewer who may approve.
      expect(await row(id)).toMatchObject({ status: 'IN_REVIEW', version: '2', current_version_id: null });
      expect(await count('select count(*) as n from machvon.document_version v join machvon.outgoing_document o on o.document_id = v.document_id where o.id = $1', [id])).toBe(0);
    });

    it('keeps the drafter from approving but lets them take their own submission back', async () => {
      const made = await create(createBody());
      const id = made.json.resource_id as string;
      expect((await submit(id, 1)).status).toBe(200);
      const self = await decide(id, 2, { decision: 'APPROVE', format_checklist: CHECKLIST }, MAKER);
      expect([self.status, self.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      const back = await decide(id, 2, { decision: 'RETURN', comment: 'I forgot an annex' }, MAKER);
      expect(back.status).toBe(200);
      expect(back.json.status).toBe('DRAFT');
    });

    it('returns a document with the reason: the drafter reads it back and the history keeps it', async () => {
      const made = await create(createBody());
      const id = made.json.resource_id as string;
      expect((await submit(id, 1)).status).toBe(200);
      expect((await decide(id, 2, { decision: 'RETURN', comment: 'short' })).json.code).toBe('VALIDATION_FAILED');
      expect((await decide(id, 2, { decision: 'RETURN' })).json.code).toBe('VALIDATION_FAILED');
      const back = await decide(id, 2, { decision: 'RETURN', comment: 'The recipients are incomplete' });
      expect(back.status).toBe(200);
      expect(back.json).toMatchObject({ status: 'DRAFT', resource_version: 3 });
      const detail = await read(id);
      expect(detail.json.latest_review).toMatchObject({ kind: 'RETURNED', comment: 'The recipients are incomplete', actor_id: memberId(REVIEWER) });
      expect((await update(id, 3, { title: 'Corrected title' })).status).toBe(200);
      const again = await decide(id, 4, { decision: 'APPROVE', format_checklist: CHECKLIST });
      expect([again.status, again.json.code]).toEqual([409, 'DOCUMENT_STATE_INVALID']);
    });

    it('treats a delegated signature like a signature of the delegator for the band, and refuses a delegation that is not good (AC-ST-DOC-007-3, UAT-AC418)', async () => {
      // KT. with a valid delegation from a member who holds the board role: the high band is reached.
      const valid = await create(createBody({ payload: payloadOf({ amount_vnd: '9000000000' }), signing_mode: 'KT', delegation_id: delegationValid }));
      expect(valid.status).toBe(200);
      const validId = valid.json.resource_id as string;
      expect((await submit(validId, 1)).status).toBe(200);
      const approved = await decide(validId, 2, { decision: 'APPROVE', format_checklist: CHECKLIST });
      expect(approved.status).toBe(200);
      const started = await startLeader(validId, LEADER, 3);
      expect(started.status).toBe(202);

      // TUQ. without a delegation cannot even be a draft, and the database says no to a row that gets round the command.
      const tuq = await create(createBody({ signing_mode: 'TUQ' }));
      expect([tuq.status, tuq.json.code]).toEqual([422, 'SIGNER_NOT_AUTHORIZED']);
      expect(tuq.json.reason).toBe('DELEGATION_MISSING');
      await expect(
        app.harness.tenants.withTenant(ctx(MAKER), (tx) =>
          drafts.createDraft(tx, {
            docTypeCode: 'QD',
            title: 'Direct insert',
            draftingUnitId: unitId(2),
            templateId: app.templateId,
            layoutProfileId: app.layoutProfileId,
            urgency: 'NORMAL',
            circulation: 'INTERNAL_CIRCULATION',
            classification: 'INTERNAL',
            payload: {},
            payloadSha256: 'b'.repeat(64),
            recipients: [],
            signerUserId: memberId(LEADER),
            signerTitle: null,
            signingMode: 'TUQ',
            delegationId: null,
            subjectModule: null,
            subjectId: null,
            replyToIncomingId: null,
            reviewDueOn: null,
            actor: memberId(MAKER),
          }),
        ),
      ).rejects.toMatchObject({ code: '23514' });

      // An expired delegation, a delegation of someone who lacks the role, one that names another delegate: all 422 at the write.
      for (const [label, id, reason] of [
        ['expired', delegationExpired, 'DELEGATION_EXPIRED'],
        ['delegator without the role', delegationWrongHolder, 'DELEGATOR_NOT_AUTHORIZED'],
      ] as const) {
        const made = await create(createBody({ payload: payloadOf({ amount_vnd: '9000000000' }), signing_mode: 'TM', delegation_id: id }));
        if (label === 'expired') {
          expect([made.status, made.json.code, made.json.reason]).toEqual([422, 'SIGNER_NOT_AUTHORIZED', reason]);
        } else {
          // The delegation is fine as a delegation; the delegator's role is judged against the band when the draft is submitted.
          expect(made.status).toBe(200);
          const refused = await submit(made.json.resource_id as string, 1);
          expect([refused.status, refused.json.code, refused.json.reason]).toEqual([422, 'SIGNER_NOT_AUTHORIZED', reason]);
        }
      }
      const stranger = await create(createBody({ signer_user_id: memberId(DRAFTER), signing_mode: 'KT', delegation_id: delegationValid }));
      expect([stranger.status, stranger.json.code, stranger.json.reason]).toEqual([422, 'SIGNER_NOT_AUTHORIZED', 'DELEGATION_INVALID']);

      // A delegation that was in force when the document was approved but has ended when signing starts.
      const late = await create(createBody({ payload: payloadOf({ amount_vnd: '9000000000' }), signing_mode: 'KT', delegation_id: delegationValid }));
      const lateId = late.json.resource_id as string;
      expect((await submit(lateId, 1)).status).toBe(200);
      expect((await decide(lateId, 2, { decision: 'APPROVE', format_checklist: CHECKLIST })).status).toBe(200);
      app.now = new Date(Date.parse('2026-11-16T00:00:00Z'));
      const ended = await startLeader(lateId, LEADER, 3);
      expect([ended.status, ended.json.code, ended.json.reason]).toEqual([422, 'SIGNER_NOT_AUTHORIZED', 'DELEGATION_EXPIRED']);
      expect(await count('select count(*) as n from machvon.doc_signing_session where outgoing_document_id = $1', [lateId])).toBe(0);
    });

    it('answers a signer with no matrix rule or an inactive signer with SIGNER_NOT_AUTHORIZED and the reason', async () => {
      const unknownType = await create(createBody());
      const id = unknownType.json.resource_id as string;
      // A kind of document the matrix has no rule for: nobody is named to sign it.
      const unruled = await create(createBody({ doc_type_code: 'TB', template_code: 'TB-DEFAULT' }));
      expect(unruled.status).toBe(200);
      const noRule = await submit(unruled.json.resource_id as string, 1);
      expect([noRule.status, noRule.json.code, noRule.json.reason]).toEqual([422, 'SIGNER_NOT_AUTHORIZED', 'DOA_RULE_NOT_FOUND']);
      await app.harness.owner(TENANT_A, [["update machvon.membership set status = 'Suspended' where id = $1", [memberId(LEADER)]]]);
      try {
        const inactive = await submit(id, 1);
        expect([inactive.status, inactive.json.code, inactive.json.reason]).toEqual([422, 'SIGNER_NOT_AUTHORIZED', 'SIGNER_INACTIVE']);
      } finally {
        await app.harness.owner(TENANT_A, [["update machvon.membership set status = 'Active' where id = $1", [memberId(LEADER)]]]);
      }
    });
  });

  describe('returnOutgoingDocument', () => {
    it('takes a SUBMITTED document back to a draft: the final PDF stops being current, an open signing session ends', async () => {
      const ready = await submitted();
      const started = await startLeader(ready.id, LEADER, ready.version);
      expect(started.status).toBe(202);
      const session = started.json.resource_id as string;
      const short = await sendBack(ready.id, ready.version, 'too short');
      expect(short.json.code).toBe('VALIDATION_FAILED');
      const back = await sendBack(ready.id, ready.version, 'The signer changed, please redraft');
      expect(back.status).toBe(200);
      expect(back.json).toMatchObject({ status: 'DRAFT', resource_version: ready.version + 1 });
      expect(await row(ready.id)).toMatchObject({ status: 'DRAFT', current_version_id: null });
      const [sessionRow] = await owner<{ status: string }>('select status from machvon.doc_signing_session where id = $1', [session]);
      expect(sessionRow?.status).toBe('CANCELLED');
      // The file of the earlier approval stays in the history, and the next approval writes a second one.
      expect(await count('select count(*) as n from machvon.document_version where document_id = $1', [ready.documentId])).toBe(1);
      expect((await submit(ready.id, ready.version + 1)).status).toBe(200);
      const again = await decide(ready.id, ready.version + 2, { decision: 'APPROVE', format_checklist: CHECKLIST });
      expect(again.status).toBe(200);
      expect(await count('select count(*) as n from machvon.document_version where document_id = $1', [ready.documentId])).toBe(1);
      const stale = await sendBack(ready.id, 1, 'A reason that is long enough');
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
    });

    it('refuses to return a draft or a signed document', async () => {
      const made = await create(createBody());
      const draft = await sendBack(made.json.resource_id as string, 1, 'Return a draft for no reason');
      expect([draft.status, draft.json.code]).toEqual([409, 'DOCUMENT_STATE_INVALID']);
    });
  });

  describe('cancelOutgoingDocument', () => {
    it('cancels a draft with the reason: the anchor is EXPIRED and the history and the events say why', async () => {
      const made = await create(createBody());
      const id = made.json.resource_id as string;
      const short = await cancel(id, 1, { reason: 'short', reject_code: 'CANCELLED_BY_DRAFTER' });
      expect(short.json.code).toBe('VALIDATION_FAILED');
      const cancelled = await cancel(id, 1, { reason: 'The decision is no longer needed', reject_code: 'CANCELLED_BY_DRAFTER' });
      expect(cancelled.status).toBe(200);
      expect(cancelled.json.status).toBe('CANCELLED');
      expect(await row(id)).toMatchObject({ status: 'CANCELLED', effect_status: 'EXPIRED' });
      const detail = await read(id);
      expect(detail.json).toMatchObject({ status: 'CANCELLED', cancel_reason: 'The decision is no longer needed' });
      const types = await owner<{ type: string }>('select type from machvon.outbox_event where aggregate_id = $1 order by created_at, id', [id]);
      expect(types.map((event) => event.type)).toEqual(['doc.draft_created.v1', 'doc.cancelled.v1']);
      const again = await cancel(id, 2, { reason: 'Once more for good measure', reject_code: 'CANCELLED_BY_DRAFTER' });
      expect([again.status, again.json.code]).toEqual([409, 'DOCUMENT_STATE_INVALID']);
    });

    it('cancels a signed document before it has a number, and refuses once the number is allocated', async () => {
      const ready = await submitted();
      const started = await startLeader(ready.id, LEADER, ready.version);
      const session = started.json.resource_id as string;
      const [txn] = await owner<{ provider_txn_ref: string; expires_at: Date }>('select provider_txn_ref, expires_at from machvon.doc_signing_session where id = $1', [session]);
      app.signing.approve({ provider: 'MOCK', sessionId: txn?.provider_txn_ref ?? '', expiresAt: txn?.expires_at ?? new Date() });
      const done = await app.call('POST', `/signing-sessions/${session}/completion`, { member: LEADER, ifMatch: '"1"', body: {} });
      expect(done.status).toBe(200);
      const signed = await cancel(ready.id, ready.version + 1, { reason: 'The text must change after all', reject_code: 'REJECTED_BY_LEADER' }, REVIEWER);
      expect(signed.status).toBe(200);
      expect(await row(ready.id)).toMatchObject({ status: 'CANCELLED', effect_status: 'EXPIRED' });
      // A NUMBERED document ends by voiding its number, not by this command.
      const numbered = await submitted();
      await app.harness.owner(TENANT_A, [["update machvon.outgoing_document set status = 'NUMBERED', leader_signed_at = now(), numbered_at = now(), allocation_id = gen_random_uuid() where id = $1", [numbered.id]]]);
      const refused = await cancel(numbered.id, numbered.version, { reason: 'It already has a number', reject_code: 'CANCELLED_BY_DRAFTER' });
      expect([refused.status, refused.json.code]).toEqual([409, 'NUMBER_ALREADY_ALLOCATED']);
    });

    it('tells the source module that the document it asked for will not come (doc.rejected.v1) and closes the issue request', async () => {
      const id = await app.harness.tenants.withTenant(ctx(MAKER), async (tx) => {
        const requestId = randomUUID();
        await tx.query(
          `insert into machvon.doc_issue_request (tenant_id, id, source_module, source_ref, template_code, template_id, payload_sha256, payload_ref, event_id, status, requested_by, created_by, updated_by)
           values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, 'MNE', 'MNE:mne_report:x:r1', 'QD-DEFAULT', $2::uuid, $3, 'tenants/x/payload.json', $4::uuid, 'RECEIVED', $5::uuid, $5::uuid, $5::uuid)`,
          [requestId, app.templateId, 'c'.repeat(64), randomUUID(), memberId(MAKER)],
        );
        const draft = await drafts.createDraft(tx, {
          docTypeCode: 'QD',
          title: 'Report decision',
          draftingUnitId: unitId(2),
          templateId: app.templateId,
          layoutProfileId: app.layoutProfileId,
          urgency: 'NORMAL',
          circulation: 'INTERNAL_CIRCULATION',
          classification: 'INTERNAL',
          payload: payloadOf(),
          payloadSha256: 'c'.repeat(64),
          recipients: [],
          signerUserId: null,
          signerTitle: null,
          signingMode: 'DIRECT',
          delegationId: null,
          subjectModule: null,
          subjectId: null,
          replyToIncomingId: null,
          reviewDueOn: null,
          source: { module: 'MNE', ref: 'MNE:mne_report:x:r1', issueRequestId: requestId },
          actor: memberId(MAKER),
        });
        await tx.query("update machvon.doc_issue_request set status = 'ACCEPTED', outgoing_document_id = $2::uuid, completed_at = now() where id = $1::uuid", [requestId, draft.id]);
        return draft.id;
      });
      const cancelled = await cancel(id, 1, { reason: 'The report was withdrawn', reject_code: 'SOURCE_WITHDRAWN' });
      expect(cancelled.status).toBe(200);
      const events = await owner<{ type: string; payload: Record<string, unknown> }>("select type, payload from machvon.outbox_event where aggregate_id = $1 and type = 'doc.rejected.v1'", [id]);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toEqual({ source_module: 'MNE', source_ref: 'MNE:mne_report:x:r1', payload_sha256: 'c'.repeat(64), reject_code: 'SOURCE_WITHDRAWN' });
      const [request] = await owner<{ status: string }>("select status from machvon.doc_issue_request where source_ref = 'MNE:mne_report:x:r1'");
      expect(request?.status).toBe('CANCELLED');
    });
  });

  describe('the content lock (BR-DOC-16) and the database guards', () => {
    it('fixes the text, the signer and the recipients once the document is in review, whatever statement is used', async () => {
      const made = await create(createBody());
      const id = made.json.resource_id as string;
      expect((await submit(id, 1)).status).toBe(200);
      for (const sql of [
        `update machvon.outgoing_document set payload_json = '{"x":1}'::jsonb where id = $1`,
        `update machvon.outgoing_document set signer_user_id = '${memberId(BOARD)}' where id = $1`,
        `update machvon.outgoing_document set recipients = '[]'::jsonb where id = $1`,
        `update machvon.outgoing_document set urgency = 'HOA_TOC' where id = $1`,
        `update machvon.outgoing_document set status = 'SUBMITTED', payload_sha256 = repeat('d', 64) where id = $1`,
        `update machvon.document set title = 'Changed behind the back' where id = (select document_id from machvon.outgoing_document where id = $1)`,
        `update machvon.outgoing_document set template_id = gen_random_uuid() where id = $1`,
      ]) {
        await expect(app.harness.tenants.withTenant(ctx(MAKER), (tx) => tx.query(sql, [id]))).rejects.toMatchObject({ code: expect.stringMatching(/^(23514|23503|42501)$/) as unknown });
      }
      // The draft state is open: the same statements are fine there.
      const open = await create(createBody());
      await app.harness.tenants.withTenant(ctx(MAKER), (tx) => tx.query(`update machvon.outgoing_document set urgency = 'HOA_TOC' where id = $1`, [open.json.resource_id]));
    });

    it('keeps the status history for good: no update, no delete, no truncate', async () => {
      const made = await create(createBody());
      const id = made.json.resource_id as string;
      for (const sql of ["update machvon.outgoing_document_event set comment = 'x' where outgoing_document_id = $1", 'delete from machvon.outgoing_document_event where outgoing_document_id = $1']) {
        await expect(app.harness.tenants.withTenant(ctx(MAKER), (tx) => tx.query(sql, [id]))).rejects.toMatchObject({ code: '42501' });
      }
      await expect(app.harness.tenants.withTenant(ctx(MAKER), (tx) => tx.query('truncate machvon.outgoing_document_event'))).rejects.toMatchObject({ code: '42501' });
    });

    it('does not let an event of one tenant be written or read through another', async () => {
      await expect(
        app.harness.tenants.withTenant({ tenantId: TENANT_B, membershipId: memberId(ADMIN), scopeVersion: 1 }, (tx) => drafts.eventsOf(tx, randomUUID())),
      ).resolves.toEqual([]);
      const made = await create(createBody());
      const rows = await app.harness.tenants.withTenant({ tenantId: TENANT_B, membershipId: memberId(ADMIN), scopeVersion: 1 }, (tx) => drafts.eventsOf(tx, made.json.resource_id as string));
      expect(rows).toEqual([]);
    });
  });

  describe('getDocumentTimeline and the reads', () => {
    it('shows the history, the file versions and the signatures of a document in the order they happened', async () => {
      const ready = await submitted();
      const started = await startLeader(ready.id, LEADER, ready.version);
      const session = started.json.resource_id as string;
      const [txn] = await owner<{ provider_txn_ref: string; expires_at: Date }>('select provider_txn_ref, expires_at from machvon.doc_signing_session where id = $1', [session]);
      app.signing.approve({ provider: 'MOCK', sessionId: txn?.provider_txn_ref ?? '', expiresAt: txn?.expires_at ?? new Date() });
      expect((await app.call('POST', `/signing-sessions/${session}/completion`, { member: LEADER, ifMatch: '"1"', body: {} })).status).toBe(200);
      const timeline = await app.call('GET', `/documents/${ready.documentId}/timeline`, { member: ADMIN });
      expect(timeline.status).toBe(200);
      expect(timeline.json).toMatchObject({ document_id: ready.documentId, outgoing_document_id: ready.id, status: 'SIGNED' });
      const events = timeline.json.events as Array<{ kind: string; from_status: string | null; to_status: string }>;
      expect(events.map((event) => [event.kind, event.from_status, event.to_status])).toEqual([
        ['CREATED', null, 'DRAFT'],
        ['REVIEW_REQUESTED', 'DRAFT', 'IN_REVIEW'],
        ['REVIEW_APPROVED', 'IN_REVIEW', 'SUBMITTED'],
        ['LEADER_SIGNED', 'SUBMITTED', 'SIGNED'],
      ]);
      expect((timeline.json.versions as Array<{ stage: string }>).map((version) => version.stage)).toEqual(['LEADER_SIGNED', 'RENDERED_FINAL']);
      expect((timeline.json.signatures as Array<{ role: string; status: string }>).map((signature) => [signature.role, signature.status])).toEqual([['LEADER', 'VALID']]);
      expect(JSON.stringify(timeline.json)).not.toContain('object_key');
    });

    it('does not reveal a document outside the scope of the caller, of another tenant, or that does not exist', async () => {
      const made = await create(createBody({ drafting_unit_id: unitId(2) }));
      const documentId = made.json.document_id as string;
      expect((await app.call('GET', `/documents/${documentId}/timeline`, { member: ADMIN, tenantId: TENANT_B })).status).toBe(404);
      expect((await app.call('GET', `/documents/${randomUUID()}/timeline`, { member: ADMIN })).status).toBe(404);
      expect((await app.call('GET', `/documents/${documentId}/timeline`, { member: NOBODY })).status).toBe(403);
      expect((await app.call('GET', `/documents/${documentId}/timeline`, { member: UNIT_TWO_CLERK })).status).toBe(200);
    });

    it('lists the new columns for the queue screens', async () => {
      const made = await create(createBody({ title: 'A listed decision' }));
      const listed = await app.call('GET', '/outgoing-documents?status=DRAFT&limit=200', { member: ADMIN });
      expect(listed.status).toBe(200);
      const item = (listed.json.items as Array<Record<string, unknown>>).find((entry) => entry.id === made.json.resource_id);
      expect(item).toMatchObject({ title: 'A listed decision', effect_status: 'PENDING', source_module: null, template_id: app.templateId, cancel_reason: null });
      expect(item).not.toHaveProperty('payload');
    });
  });

  describe('the final PDF is the file the signing flow works on', () => {
    it('is signed, numbered and sealed by the engine of ST-DOC-005 without a change', async () => {
      const ready = await submitted();
      const stored = await owner<{ stage: string; classification: string }>('select stage, classification from machvon.document_version where document_id = $1', [ready.documentId]);
      expect(stored).toEqual([{ stage: 'RENDERED_FINAL', classification: 'INTERNAL' }]);
      const started = await startLeader(ready.id, LEADER, ready.version);
      expect(started.status).toBe(202);
      expect(started.json).toMatchObject({ adapter_code: 'MOCK', role: 'LEADER' });
    });
  });
});
