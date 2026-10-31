import { Client } from 'pg';
import { OutgoingDocumentStore, assertBidDecisionDocument as assertDecisionDocument } from '@machvon/db';
import { CORRECTOR, DISTRIBUTOR, LEGAL_ISSUER, MAKER, NOBODY, RECALLER, REFERENCER, SUPERSEDER, TENANT_A, memberId, unitId } from './doc-app';
import type { Reply } from './doc-app';
import { FlowWorld } from './support/flow-world';
import { INTERNAL_RECIPIENT, sealedDocument } from './support/sealed-documents';

jest.setTimeout(300_000);

const flow = new FlowWorld();
const { app } = flow;
const owner = <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => app.harness.owner<T>(TENANT_A, [[sql, params]]);
const REASON = 'Adjust the total investment after the revised estimate';
const CORRECTION = 'Replace “Article 3” with “Article 4” in the second paragraph';

const replace = (id: string, member: number, version: number, body: Record<string, unknown> = { reason: REASON }): Promise<Reply> =>
  app.call('POST', `/outgoing-documents/${id}/replacements`, { member, ifMatch: `"${version}"`, body });
const correct = (id: string, member: number, version: number, body: Record<string, unknown> = { correction_text: CORRECTION, reason: REASON }): Promise<Reply> =>
  app.call('POST', `/outgoing-documents/${id}/corrections`, { member, ifMatch: `"${version}"`, body });

interface Issued {
  id: string;
  documentId: string;
  version: number;
}

/** A document issued through the command (the default template is unconfirmed, so a legal user gives the reason). */
async function issuedFrom(sealed: { id: string; version: number; documentId: string }): Promise<Issued> {
  const reply = await app.call('POST', `/outgoing-documents/${sealed.id}/issuance`, {
    member: LEGAL_ISSUER,
    ifMatch: `"${sealed.version}"`,
    body: { unconfirmed_override_reason: 'The legal office confirmed the template by letter 12/PC' },
  });
  if (reply.status !== 200) throw new Error(`the issue was refused: ${JSON.stringify(reply.json)}`);
  return { id: sealed.id, documentId: sealed.documentId, version: reply.json.resource_version as number };
}

const issued = async (): Promise<Issued> => issuedFrom(await sealedDocument(flow));

/** The draft a replacement or a correction made, taken over the same routes as any draft up to the issue. */
async function issueDraft(draftId: string, documentId: string): Promise<Issued> {
  const submitted = await flow.submit(draftId, 1);
  if (submitted.status !== 200) throw new Error(`the review request was refused: ${JSON.stringify(submitted.json)}`);
  const approved = await flow.approve(draftId, submitted.json.resource_version as number);
  if (approved.status !== 200) throw new Error(`the review was refused: ${JSON.stringify(approved.json)}`);
  const version = await flow.sealFrom(draftId, approved.json.resource_version as number, await flow.openRegister());
  return issuedFrom({ id: draftId, documentId, version });
}

async function row(id: string): Promise<{ status: string; effect_status: string; version: string; number: number | null }> {
  const [found] = await owner<{ status: string; effect_status: string; version: string; number: number | null }>(
    `select o.status, d.effect_status, o.version::text as version, d.document_number as number
       from machvon.outgoing_document o join machvon.document d on d.tenant_id = o.tenant_id and d.id = o.document_id where o.id = $1`,
    [id],
  );
  if (found === undefined) throw new Error('no document');
  return found;
}

const events = (id: string, type: string): Promise<Array<{ payload: Record<string, unknown> }>> =>
  owner('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at', [id, type]);
const relations = (documentId: string): Promise<Array<{ from_document_id: string; to_document_id: string; relation_kind: string; note: string | null }>> =>
  owner('select from_document_id, to_document_id, relation_kind, note from machvon.document_relation where from_document_id = $1 or to_document_id = $1 order by created_at', [documentId]);
/** Statements run behind the application as the administrator of the database, with the triggers that keep documents and templates left out. */
async function behindTheApplication(statements: Array<[string, unknown[]?]>): Promise<void> {
  const admin = new Client({ connectionString: app.harness.database.adminUrl });
  await admin.connect();
  try {
    await admin.query('set session_replication_role = replica');
    for (const [sql, params] of statements) await admin.query(sql, params).catch((error: Error) => { throw new Error(`${error.message} in: ${sql}`); });
  } finally {
    await admin.end();
  }
}
const usability = (documentId: string, member = REFERENCER): Promise<Reply> => app.call('GET', `/documents/${documentId}/usability`, { member });

describe('replacing and correcting an issued document (ST-DOC-015)', () => {
  beforeAll(() => flow.start(), 300_000);
  afterAll(() => flow.stop(), 60_000);
  afterEach(() => flow.reset());

  describe('AC-ST-DOC-015-1 / UAT-AC412: a replacement and a correction', () => {
    it('makes a draft that carries the relation REPLACES and changes nothing in the issued document until the draft is issued; then the old one is REPLACED and no longer in force, its number stays taken, and one event goes out', async () => {
      const original = await issued();
      const before = await row(original.id);
      expect(before).toMatchObject({ status: 'ISSUED', effect_status: 'EFFECTIVE' });

      const made = await replace(original.id, SUPERSEDER, original.version, { reason: `  ${REASON}  `, title: 'Decision adjusting the total investment' });
      expect(made).toMatchObject({ status: 200, json: { status: 'DRAFT', resource_version: 1, of_outgoing_document_id: original.id } });
      const draftId = made.json.resource_id as string;
      const draftDocumentId = made.json.document_id as string;
      expect(draftId).not.toBe(original.id);
      // Nothing happened to the issued document yet.
      expect(await row(original.id)).toEqual(before);
      expect(await relations(original.documentId)).toEqual([{ from_document_id: draftDocumentId, to_document_id: original.documentId, relation_kind: 'REPLACES', note: REASON }]);
      expect((await usability(original.documentId)).status).toBe(200);
      const [draft] = await owner<{ status: string; title: string; template_id: string; payload_json: Record<string, unknown>; drafter_user_id: string }>(
        'select o.status, d.title, o.template_id, o.payload_json, o.drafter_user_id from machvon.outgoing_document o join machvon.document d on d.tenant_id = o.tenant_id and d.id = o.document_id where o.id = $1',
        [draftId],
      );
      expect(draft).toMatchObject({ status: 'DRAFT', title: 'Decision adjusting the total investment', drafter_user_id: memberId(SUPERSEDER) });
      const [source] = await owner<{ template_id: string; payload_json: Record<string, unknown> }>('select template_id, payload_json from machvon.outgoing_document where id = $1', [original.id]);
      expect(draft?.template_id).toBe(source?.template_id);
      expect(draft?.payload_json).toEqual(source?.payload_json);

      const replacement = await issueDraft(draftId, draftDocumentId);
      expect(await row(replacement.id)).toMatchObject({ status: 'ISSUED', effect_status: 'EFFECTIVE' });
      const after = await row(original.id);
      expect(after).toMatchObject({ status: 'REPLACED', effect_status: 'REPLACED', number: before.number });
      expect(Number(after.version)).toBe(Number(before.version) + 1);
      // The number stays booked: the allocation is still taken by the replaced document.
      const [allocation] = await owner<{ status: string }>('select a.status from machvon.document_number_allocation a join machvon.outgoing_document o on o.allocation_id = a.id where o.id = $1', [original.id]);
      expect(allocation?.status).toBe('ALLOCATED');
      const [event] = await events(original.id, 'doc.replaced.v1');
      expect(event?.payload).toMatchObject({ document_id: original.documentId, effect_status: 'REPLACED', by_document_id: draftDocumentId, by_outgoing_document_id: replacement.id });
      expect(await events(original.id, 'doc.replaced.v1')).toHaveLength(1);
      const history = await owner<{ kind: string; from_status: string; to_status: string }>("select kind, from_status, to_status from machvon.outgoing_document_event where outgoing_document_id = $1 and kind = 'REPLACED'", [original.id]);
      expect(history).toEqual([{ kind: 'REPLACED', from_status: 'ISSUED', to_status: 'REPLACED' }]);
      const audit = await owner<{ action: string }>("select action from machvon.audit_event where resource_id = $1 and action in ('outgoing_document.replace', 'outgoing_document.replaced')", [original.id]);
      expect(audit.map((entry) => entry.action).sort()).toEqual(['outgoing_document.replace', 'outgoing_document.replaced']);
    });

    it('AC-ST-DOC-015-2: a replaced document is not usable as a legal basis: resolveDocumentReference answers DOCUMENT_NOT_EFFECTIVE with the document that took its place', async () => {
      const original = await issued();
      const made = await replace(original.id, SUPERSEDER, original.version);
      const replacement = await issueDraft(made.json.resource_id as string, made.json.document_id as string);
      const refused = await usability(original.documentId);
      expect(refused).toMatchObject({ status: 422, json: { code: 'DOCUMENT_NOT_EFFECTIVE', reason: 'NOT_EFFECTIVE', effect_status: 'REPLACED' } });
      expect(refused.json.relations).toEqual([{ kind: 'REPLACES', document_id: made.json.document_id }]);
      expect((await usability(made.json.document_id as string)).status).toBe(200);
      expect(replacement.id).toBe(made.json.resource_id);
    });

    it('makes a correction that, once issued, leaves the original CORRECTED and in force with its correction: the words are in the content of the draft, the relation is CORRECTS and the reference still resolves', async () => {
      const original = await issued();
      const made = await correct(original.id, SUPERSEDER, original.version);
      expect(made).toMatchObject({ status: 200, json: { status: 'DRAFT', of_outgoing_document_id: original.id } });
      const draftId = made.json.resource_id as string;
      const draftDocumentId = made.json.document_id as string;
      const [draft] = await owner<{ title: string; payload_json: { correction?: { text: string; reason: string; corrects_document_id: string } } }>(
        'select d.title, o.payload_json from machvon.outgoing_document o join machvon.document d on d.tenant_id = o.tenant_id and d.id = o.document_id where o.id = $1',
        [draftId],
      );
      expect(draft?.payload_json.correction).toEqual({ text: CORRECTION, reason: REASON, corrects_document_id: original.documentId });
      expect(draft?.title).toMatch(/^Correction of /);
      expect(await relations(original.documentId)).toEqual([expect.objectContaining({ relation_kind: 'CORRECTS', to_document_id: original.documentId })]);
      expect(await row(original.id)).toMatchObject({ status: 'ISSUED', effect_status: 'EFFECTIVE' });

      await issueDraft(draftId, draftDocumentId);
      expect(await row(original.id)).toMatchObject({ status: 'CORRECTED', effect_status: 'CORRECTED' });
      const [event] = await events(original.id, 'doc.corrected.v1');
      expect(event?.payload).toMatchObject({ document_id: original.documentId, effect_status: 'CORRECTED', by_document_id: draftDocumentId });
      // Still in force with its correction: a module may rely on it, and is told where the correction is.
      const usable = await usability(original.documentId);
      expect(usable.status).toBe(200);
      expect(usable.json.relations).toEqual([{ kind: 'CORRECTS', document_id: draftDocumentId }]);
    });

    it('AC-ST-DOC-015-1: a second correction while the first is still open is 409 CORRECTION_ALREADY_OPEN, and so is a second replacement (REPLACEMENT_ALREADY_OPEN); one of each can be open together', async () => {
      const original = await issued();
      const first = await correct(original.id, SUPERSEDER, original.version);
      expect(first.status).toBe(200);
      expect(await correct(original.id, SUPERSEDER, original.version)).toMatchObject({ status: 409, json: { code: 'CORRECTION_ALREADY_OPEN' } });
      const replacement = await replace(original.id, SUPERSEDER, original.version);
      expect(replacement.status).toBe(200);
      expect(await replace(original.id, SUPERSEDER, original.version)).toMatchObject({ status: 409, json: { code: 'REPLACEMENT_ALREADY_OPEN' } });
      expect(await relations(original.documentId)).toHaveLength(2);
    });

    it('opens the correction again once the first was issued (the original is CORRECTED and can be corrected again) or the open draft was cancelled', async () => {
      const original = await issued();
      const first = await correct(original.id, SUPERSEDER, original.version);
      await issueDraft(first.json.resource_id as string, first.json.document_id as string);
      const refreshed = await row(original.id);
      expect(refreshed.status).toBe('CORRECTED');
      const second = await correct(original.id, SUPERSEDER, Number(refreshed.version), { correction_text: 'Replace “Article 5” with “Article 6”', reason: REASON });
      expect(second.status).toBe(200);
      // The open draft is called off: its relation no longer keeps the correction open.
      const cancelled = await app.call('POST', `/outgoing-documents/${second.json.resource_id as string}/cancellation`, { member: MAKER, ifMatch: '"1"', body: { reason: 'The second correction is not needed any more', reject_code: 'CANCELLED_BY_DRAFTER' } });
      expect(cancelled.status).toBe(200);
      const third = await correct(original.id, SUPERSEDER, Number(refreshed.version), { correction_text: 'Replace “Article 7” with “Article 8”', reason: REASON });
      expect(third.status).toBe(200);
      await issueDraft(third.json.resource_id as string, third.json.document_id as string);
      expect(await events(original.id, 'doc.corrected.v1')).toHaveLength(2);
    });

    it('a replacement of a corrected document ends REPLACED, and a replaced document is final: no replacement, no correction, no recall', async () => {
      const original = await issued();
      const corrected = await correct(original.id, SUPERSEDER, original.version);
      await issueDraft(corrected.json.resource_id as string, corrected.json.document_id as string);
      const afterCorrection = await row(original.id);
      const made = await replace(original.id, SUPERSEDER, Number(afterCorrection.version));
      expect(made.status).toBe(200);
      await issueDraft(made.json.resource_id as string, made.json.document_id as string);
      const replaced = await row(original.id);
      expect(replaced).toMatchObject({ status: 'REPLACED', effect_status: 'REPLACED' });
      expect(await replace(original.id, SUPERSEDER, Number(replaced.version))).toMatchObject({ status: 409, json: { code: 'DOCUMENT_STATE_INVALID' } });
      expect(await correct(original.id, SUPERSEDER, Number(replaced.version))).toMatchObject({ status: 409, json: { code: 'DOCUMENT_STATE_INVALID' } });
      expect(await app.call('POST', `/outgoing-documents/${original.id}/recall`, { member: RECALLER, ifMatch: `"${replaced.version}"`, body: { reason: 'Recalled after it was replaced' } })).toMatchObject({ status: 409, json: { code: 'DOCUMENT_STATE_INVALID' } });
      await expect(owner("update machvon.outgoing_document set status = 'ISSUED' where id = $1", [original.id])).rejects.toMatchObject({ code: '23514' });
      await expect(owner("update machvon.document set effect_status = 'EFFECTIVE' where id = $1", [original.documentId])).rejects.toMatchObject({ code: '23514' });
    });

    it('recalls a corrected document only on a document that is in force as its basis (it is in force itself)', async () => {
      const original = await issued();
      const made = await correct(original.id, SUPERSEDER, original.version);
      await issueDraft(made.json.resource_id as string, made.json.document_id as string);
      const corrected = await row(original.id);
      expect(await app.call('POST', `/outgoing-documents/${original.id}/recall`, { member: RECALLER, ifMatch: `"${corrected.version}"`, body: { reason: 'Recalled after it was corrected' } })).toMatchObject({
        status: 422,
        json: { code: 'RECALL_BASIS_REQUIRED', basis: 'REQUIRED_FOR_CORRECTED' },
      });
      const basis = await issued();
      const recalled = await app.call('POST', `/outgoing-documents/${original.id}/recall`, {
        member: RECALLER,
        ifMatch: `"${corrected.version}"`,
        body: { reason: 'Recalled after it was corrected', recall_basis_document_id: basis.documentId },
      });
      expect(recalled.status).toBe(200);
      expect(await row(original.id)).toMatchObject({ status: 'RECALLED', effect_status: 'RECALLED' });
    });
  });

  describe('what a reference sees and what a replacement does to a document that moved', () => {
    it('lists as the documents that took its place only those that took effect: a draft that is still being drawn up, or was cancelled, is not one', async () => {
      const original = await issued();
      const pending = await correct(original.id, SUPERSEDER, original.version);
      const usable = await usability(original.documentId);
      expect(usable.status).toBe(200);
      expect(usable.json.relations).toEqual([]);
      const cancelled = await app.call('POST', `/outgoing-documents/${pending.json.resource_id as string}/cancellation`, { member: MAKER, ifMatch: '"1"', body: { reason: 'The correction is not needed any more', reject_code: 'CANCELLED_BY_DRAFTER' } });
      expect(cancelled.status).toBe(200);
      const first = await replace(original.id, SUPERSEDER, original.version);
      const abandoned = await app.call('POST', `/outgoing-documents/${first.json.resource_id as string}/cancellation`, { member: MAKER, ifMatch: '"1"', body: { reason: 'The replacement is not needed any more', reject_code: 'CANCELLED_BY_DRAFTER' } });
      expect(abandoned.status).toBe(200);
      const second = await replace(original.id, SUPERSEDER, original.version);
      await issueDraft(second.json.resource_id as string, second.json.document_id as string);
      const refused = await usability(original.documentId);
      expect(refused).toMatchObject({ status: 422, json: { code: 'DOCUMENT_NOT_EFFECTIVE', effect_status: 'REPLACED' } });
      expect(refused.json.relations).toEqual([{ kind: 'REPLACES', document_id: second.json.document_id }]);
    });

    it('leaves a document that was recalled while its replacement was being drawn up as it is, and the replacement is issued all the same', async () => {
      const original = await issued();
      const made = await replace(original.id, SUPERSEDER, original.version);
      const recalled = await app.call('POST', `/outgoing-documents/${original.id}/recall`, { member: RECALLER, ifMatch: `"${original.version}"`, body: { reason: 'Recalled while its replacement was drawn up' } });
      expect(recalled.status).toBe(200);
      const replacement = await issueDraft(made.json.resource_id as string, made.json.document_id as string);
      expect(await row(replacement.id)).toMatchObject({ status: 'ISSUED', effect_status: 'EFFECTIVE' });
      expect(await row(original.id)).toMatchObject({ status: 'RECALLED', effect_status: 'RECALLED' });
      expect(await events(original.id, 'doc.replaced.v1')).toHaveLength(0);
    });
  });

  describe('a document that is corrected stays at work, and a draft always has a template in force', () => {
    it('is still sent to new recipients after it was corrected, and its status stays CORRECTED', async () => {
      const original = await issued();
      const made = await correct(original.id, SUPERSEDER, original.version);
      await issueDraft(made.json.resource_id as string, made.json.document_id as string);
      const corrected = await row(original.id);
      expect(corrected.status).toBe('CORRECTED');
      const sent = await app.call('POST', `/outgoing-documents/${original.id}/distributions`, { member: DISTRIBUTOR, ifMatch: `"${corrected.version}"`, body: { recipients: [{ ...INTERNAL_RECIPIENT, channel: 'INTERNAL' }] } });
      expect(sent.status).toBe(200);
      expect(await row(original.id)).toMatchObject({ status: 'CORRECTED', effect_status: 'CORRECTED' });
    });

    it('keeps a corrected document in the scheduled check of its signatures: it is still in force and a module may rely on it', async () => {
      const original = await issued();
      const made = await correct(original.id, SUPERSEDER, original.version);
      await issueDraft(made.json.resource_id as string, made.json.document_id as string);
      expect((await row(original.id)).status).toBe('CORRECTED');
      const due = await app.harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(SUPERSEDER), scopeVersion: 1 }, (tx) =>
        new OutgoingDocumentStore().issuedFilesDueForRevocationCheck(tx, { checkedBefore: new Date(Date.now() + 86_400_000), limit: 1000 }),
      );
      expect(due.map((entry) => entry.outgoingDocumentId)).toContain(original.id);
    });

    it('is still a legal basis of other modules after it was corrected (a decision, a recall basis) and no longer after it was replaced', async () => {
      const corrected = await issued();
      const made = await correct(corrected.id, SUPERSEDER, corrected.version);
      await issueDraft(made.json.resource_id as string, made.json.document_id as string);
      const replaced = await issued();
      const replacement = await replace(replaced.id, SUPERSEDER, replaced.version);
      await issueDraft(replacement.json.resource_id as string, replacement.json.document_id as string);
      const basisCheck = (documentId: string) =>
        app.harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(SUPERSEDER), scopeVersion: 1 }, (tx) => assertDecisionDocument(tx, documentId));
      await expect(basisCheck(corrected.documentId)).resolves.toBe(corrected.documentId);
      await expect(basisCheck(replaced.documentId)).rejects.toMatchObject({ code: 'DECISION_DOCUMENT_NOT_EFFECTIVE' });
      // A corrected document is a basis for recalling another one.
      const target = await issued();
      const recalled = await app.call('POST', `/outgoing-documents/${target.id}/recall`, { member: RECALLER, ifMatch: `"${target.version}"`, body: { reason: 'Recalled on a corrected decision', recall_basis_document_id: corrected.documentId } });
      expect(recalled.status).toBe(200);
      const other = await issued();
      expect(await app.call('POST', `/outgoing-documents/${other.id}/recall`, { member: RECALLER, ifMatch: `"${other.version}"`, body: { reason: 'Recalled on a replaced decision', recall_basis_document_id: replaced.documentId } })).toMatchObject({
        status: 422,
        json: { code: 'RECALL_BASIS_REQUIRED', basis: 'NOT_IN_FORCE' },
      });
    });

    it('takes the template of its type for a document that has none of its own (one registered after it was signed outside)', async () => {
      const original = await issued();
      await behindTheApplication([['update machvon.outgoing_document set template_id = null where id = $1::uuid', [original.id]]]);
      const made = await replace(original.id, SUPERSEDER, original.version);
      expect(made.status).toBe(200);
      const [draft] = await owner<{ template_code: string }>('select t.template_code from machvon.outgoing_document o join machvon.document_template t on t.id = o.template_id where o.id = $1', [made.json.resource_id]);
      expect(draft?.template_code).toBe('QD-DEFAULT');
      await issueDraft(made.json.resource_id as string, made.json.document_id as string);
    });

    it('takes the revision of the template that is in force when the one the document was drawn from has expired, and 422 TEMPLATE_NOT_EFFECTIVE when none is: no draft and no relation are left', async () => {
      const original = await issued();
      const [pinned] = await owner<{ template_id: string }>('select template_id from machvon.outgoing_document where id = $1', [original.id]);
      await behindTheApplication([
        ['create temp table next_revision as select * from machvon.document_template where id = $1::uuid', [pinned?.template_id]],
        ['update next_revision set id = gen_random_uuid(), revision = revision + 1, effective_from = effective_from + 1, effective_until = null', []],
        ['update machvon.document_template set effective_until = effective_from + 1 where id = $1::uuid', [pinned?.template_id]],
        ['insert into machvon.document_template select * from next_revision', []],
      ]);
      const made = await replace(original.id, SUPERSEDER, original.version);
      expect(made.status).toBe(200);
      const [draft] = await owner<{ revision: number }>('select t.revision from machvon.outgoing_document o join machvon.document_template t on t.id = o.template_id where o.id = $1', [made.json.resource_id]);
      expect(draft?.revision).toBeGreaterThan(1);
      const [saved] = await owner<{ ids: string[]; untils: Array<string | null> }>(
        "select array_agg(id) as ids, array_agg(effective_until::text) as untils from machvon.document_template where doc_type_code = 'QD'",
      );
      try {
        await behindTheApplication([['update machvon.document_template set effective_until = effective_from + 1 where doc_type_code = $1 and (effective_until is null or effective_until > effective_from + 1)', ['QD']]]);
        const before = (await relations(original.documentId)).length;
        expect(await correct(original.id, SUPERSEDER, original.version)).toMatchObject({ status: 422, json: { code: 'TEMPLATE_NOT_EFFECTIVE' } });
        expect((await relations(original.documentId)).length).toBe(before);
      } finally {
        await behindTheApplication(saved?.ids.map((id, index): [string, unknown[]] => ['update machvon.document_template set effective_until = $2::date where id = $1::uuid', [id, saved.untils[index] ?? null]]) ?? []);
      }
    });
  });

  describe('what is refused', () => {
    it('a document that is not issued is 409 DOCUMENT_STATE_INVALID, a recalled one too, and a version that moved is 409 VERSION_CONFLICT', async () => {
      const sealed = await sealedDocument(flow);
      expect(await replace(sealed.id, SUPERSEDER, sealed.version)).toMatchObject({ status: 409, json: { code: 'DOCUMENT_STATE_INVALID' } });
      expect(await correct(sealed.id, SUPERSEDER, sealed.version)).toMatchObject({ status: 409, json: { code: 'DOCUMENT_STATE_INVALID' } });
      const original = await issuedFrom(sealed);
      expect(await replace(original.id, SUPERSEDER, original.version + 5)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      const recalled = await app.call('POST', `/outgoing-documents/${original.id}/recall`, { member: RECALLER, ifMatch: `"${original.version}"`, body: { reason: 'Recalled before it was replaced' } });
      expect(recalled.status).toBe(200);
      expect(await replace(original.id, SUPERSEDER, original.version + 1)).toMatchObject({ status: 409, json: { code: 'DOCUMENT_STATE_INVALID' } });
    });

    it('needs the reason and the words of a correction in earnest (blanks do not count) and a title that is a title', async () => {
      const original = await issued();
      expect(await replace(original.id, SUPERSEDER, original.version, { reason: '           ' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'reason' } });
      expect(await replace(original.id, SUPERSEDER, original.version, { reason: REASON, title: '   ' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'title' } });
      expect(await correct(original.id, SUPERSEDER, original.version, { correction_text: '     ', reason: REASON })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'correction_text' } });
      expect(await relations(original.documentId)).toEqual([]);
    });

    it('is for those who hold the permission over the unit: a corrector cannot replace, a reader or a stranger can do neither, and a document of another unit is not there', async () => {
      const original = await issued();
      expect(await replace(original.id, CORRECTOR, original.version)).toMatchObject({ status: 403 });
      expect(await replace(original.id, NOBODY, original.version)).toMatchObject({ status: 403 });
      expect(await correct(original.id, NOBODY, original.version)).toMatchObject({ status: 403 });
      expect((await correct(original.id, CORRECTOR, original.version)).status).toBe(200);
      expect(await relations(original.documentId)).toHaveLength(1);
    });

    it('keeps the relations as they were written: the documents and the kind never change, a relation to itself is not made, and nothing is deleted', async () => {
      const original = await issued();
      const made = await replace(original.id, SUPERSEDER, original.version);
      const [relation] = await owner<{ id: string }>('select id from machvon.document_relation where to_document_id = $1', [original.documentId]);
      await expect(owner("update machvon.document_relation set relation_kind = 'CORRECTS' where id = $1", [relation?.id])).rejects.toMatchObject({ code: '23514' });
      await expect(owner('update machvon.document_relation set to_document_id = from_document_id where id = $1', [relation?.id])).rejects.toMatchObject({ code: '23514' });
      await expect(
        owner(
          `insert into machvon.document_relation (tenant_id, id, from_document_id, to_document_id, relation_kind, created_by, updated_by)
           select tenant_id, gen_random_uuid(), from_document_id, from_document_id, 'REPLACES', created_by, created_by from machvon.document_relation where id = $1`,
          [relation?.id],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        owner(
          `insert into machvon.document_relation (tenant_id, id, from_document_id, to_document_id, relation_kind, created_by, updated_by)
           select tenant_id, gen_random_uuid(), from_document_id, to_document_id, relation_kind, created_by, created_by from machvon.document_relation where id = $1`,
          [relation?.id],
        ),
      ).rejects.toMatchObject({ code: '23505' });
      const [privileges] = await owner<{ del: boolean }>("select has_table_privilege('machvon_app', 'machvon.document_relation', 'DELETE') as del");
      expect(privileges?.del).toBe(false);
      expect(made.status).toBe(200);
    });
  });

  describe('the timeline of DOC-19', () => {
    it('shows the other document of a relation only to a reader who can read it: a document of a unit outside the scope of the reader is left out, with its title, symbol, state and note', async () => {
      const original = await issued();
      // A document of another unit: drafted in unit 2 like the others, then moved to unit 1 behind the application (the triggers that keep the content are left out).
      const elsewhere = await issuedFrom(await sealedDocument(flow, { title: 'A decision of another unit' }));
      await behindTheApplication([['update machvon.outgoing_document set drafting_unit_id = $2::uuid where id = $1::uuid', [elsewhere.id, unitId(1)]]]);
      await owner(
        `insert into machvon.document_relation (tenant_id, id, from_document_id, to_document_id, relation_kind, note, created_by, updated_by)
         values ($1, gen_random_uuid(), $2, $3, 'RECALLS', 'The note of another unit', $4, $4)`,
        [TENANT_A, elsewhere.documentId, original.documentId, memberId(LEGAL_ISSUER)],
      );
      const narrow = await app.call('GET', `/outgoing-documents/${original.id}`, { member: SUPERSEDER });
      expect(narrow.status).toBe(200);
      expect(narrow.json.relations).toEqual([]);
      expect(JSON.stringify(narrow.json)).not.toContain('A decision of another unit');
      expect(JSON.stringify(narrow.json)).not.toContain('The note of another unit');
      const wide = await app.call('GET', `/outgoing-documents/${original.id}`, { member: LEGAL_ISSUER });
      expect((wide.json.relations as Array<Record<string, unknown>>).map((entry) => [entry.kind, entry.direction, entry.title, entry.note])).toEqual([['RECALLS', 'IN', 'A decision of another unit', 'The note of another unit']]);
    });

    it('shows on the document the relations it has in both directions, newest first, with the other document and its state', async () => {
      const original = await issued();
      const made = await replace(original.id, SUPERSEDER, original.version);
      const corrected = await correct(original.id, SUPERSEDER, original.version);
      const detail = await app.call('GET', `/outgoing-documents/${original.id}`, { member: SUPERSEDER });
      expect(detail.status).toBe(200);
      const timeline = detail.json.relations as Array<Record<string, unknown>>;
      expect(timeline.map((entry) => [entry.kind, entry.direction, entry.outgoing_document_id, entry.status])).toEqual([
        ['CORRECTS', 'IN', corrected.json.resource_id, 'DRAFT'],
        ['REPLACES', 'IN', made.json.resource_id, 'DRAFT'],
      ]);
      expect(timeline[1]?.note).toBe(REASON);
      const draftDetail = await app.call('GET', `/outgoing-documents/${made.json.resource_id as string}`, { member: SUPERSEDER });
      expect((draftDetail.json.relations as Array<Record<string, unknown>>).map((entry) => [entry.kind, entry.direction, entry.document_id])).toEqual([['REPLACES', 'OUT', original.documentId]]);
    });
  });
});
