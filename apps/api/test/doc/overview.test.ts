import { randomUUID } from 'node:crypto';
import { DocumentStore } from '@machvon/db';
import { ACTOR, ADMIN, DocApp, INCOMING_CLERK, NOBODY, OVERVIEW_INCOMING, OVERVIEW_ONLY, OVERVIEW_UNIT_ONE, OVERVIEW_UNIT_TWO, TENANT_A, TENANT_B, memberId, unitId } from './doc-app';
import { contextFor } from '../../../../packages/db/test/support/authz-fixtures';

jest.setTimeout(240_000);

const app = new DocApp();
const owner = <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => app.harness.owner<T>(TENANT_A, [[sql, params]]);
const NOW = new Date('2026-10-28T08:00:00Z');

let registerId = '';
let incomingRegisters: Record<number, string> = {};
let sequence = 0;

const overview = (member: number, tenantId?: string) => app.call('GET', '/document-overview', { member, ...(tenantId === undefined ? {} : { tenantId }) });
const tiles = async (member: number): Promise<Record<string, number | null>> => {
  const reply = await overview(member);
  expect(reply.status).toBe(200);
  return Object.fromEntries((reply.json.tiles as Array<{ key: string; count: number | null }>).map((tile) => [tile.key, tile.count]));
};

/** An outgoing document of a unit in a state of the chain, as the chain leaves it. */
async function outgoing(unit: number, status: string): Promise<string> {
  const id = randomUUID();
  await app.harness.tenants.withTenant(contextFor(TENANT_A, memberId(ADMIN)), async (tx) => {
    const document = await new DocumentStore().insertDocument(tx, { docKind: 'OUTGOING', docTypeCode: 'QD', title: 'Văn bản đi', classification: 'INTERNAL', createdBy: ACTOR, issuerUnitId: unitId(unit) });
    await tx.query(
      `insert into machvon.outgoing_document (tenant_id, id, document_id, layout_profile_id, status, drafting_unit_id, drafter_user_id, signer_user_id, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, 'DRAFT', $4::uuid, $5::uuid, $5::uuid, $5::uuid, $5::uuid)`,
      [id, document.id, app.layoutProfileId, unitId(unit), memberId(ADMIN)],
    );
    if (status === 'DRAFT') return;
    if (['NUMBERED', 'SEALED', 'ISSUED'].includes(status)) {
      sequence += 1;
      const allocation = randomUUID();
      await tx.query(
        `insert into machvon.document_number_allocation (tenant_id, id, register_id, number, symbol, document_id, issued_on, allocated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::int, $4, $5::uuid, date '2026-10-01', $6::uuid)`,
        [allocation, registerId, 7000 + sequence, `TQ-${sequence}`, document.id, memberId(ADMIN)],
      );
      await tx.query(
        "update machvon.outgoing_document set status = $2, allocation_id = $3::uuid, leader_signed_at = now() - interval '2 hours', numbered_at = now() - interval '1 hour', sealed_at = case when $2 = 'NUMBERED' then null else now() end, issued_at = case when $2 = 'ISSUED' then now() else null end where id = $1::uuid",
        [id, status, allocation],
      );
    } else if (status === 'SIGNED') await tx.query("update machvon.outgoing_document set status = 'SIGNED', leader_signed_at = now() where id = $1::uuid", [id]);
    else if (status === 'CANCELLED') await tx.query("update machvon.outgoing_document set status = 'CANCELLED', cancel_reason = 'cancelled for the test' where id = $1::uuid", [id]);
    else await tx.query('update machvon.outgoing_document set status = $2 where id = $1::uuid', [id, status]);
  });
  return id;
}

/** An incoming letter of a unit, in a state, overdue or not. */
async function letter(status: string, overdue: boolean, unit = 2): Promise<string> {
  const documentId = randomUUID();
  const id = randomUUID();
  sequence += 1;
  await owner(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by)
     values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, 'INCOMING', 'QD', 'Công văn đến', 'INTERNAL', $2::uuid, $2::uuid)`,
    [documentId, memberId(ADMIN)],
  );
  await owner(
    `insert into machvon.incoming_document (tenant_id, id, document_id, status, channel, register_id, received_at, received_by, sender_name, original_symbol, original_issued_on, assigned_unit_id, assigned_by, due_on, is_overdue, overdue_since, resolution_summary, resolved_at, created_by, updated_by)
     values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, 'UPLOAD', $4::uuid, now(), $5::uuid, 'Bộ Tài chính', $6, date '2026-10-01', $7::uuid, $5::uuid, date '2026-10-20', $8, case when $8 then date '2026-10-22' end,
             case when $3 = 'RESOLVED' then 'Đã trả lời.' end, case when $3 = 'RESOLVED' then now() end, $5::uuid, $5::uuid)`,
    [id, documentId, status, incomingRegisters[unit], memberId(ADMIN), `OV-${sequence}/BTC`, unitId(unit), overdue],
  );
  return id;
}

describe('the overview of the documents over HTTP (ST-DOC-014)', () => {
  beforeAll(async () => {
    await app.start();
    const made = await app.call('POST', '/document-number-registers', { member: ADMIN, body: { register_code: 'REG-OV', name: 'Sổ đi tổng quan', direction: 'OUTGOING', organization_unit_id: unitId(2), year: 2026, scope_doc_types: ['QD'] } });
    if (made.status !== 200) throw new Error(JSON.stringify(made.json));
    registerId = made.json.resource_id as string;
    for (const unit of [1, 2]) {
      const taken = await app.call('POST', '/document-number-registers', { member: ADMIN, body: { register_code: `REG-OV-D${unit}`, name: `Sổ đến ${unit}`, direction: 'INCOMING', organization_unit_id: unitId(unit), year: 2026, scope_doc_types: ['QD'] } });
      if (taken.status !== 200) throw new Error(JSON.stringify(taken.json));
      incomingRegisters = { ...incomingRegisters, [unit]: taken.json.resource_id as string };
    }
    app.now = NOW;
  }, 480_000);
  afterAll(() => app.stop(), 60_000);

  it('AC-ST-DOC-014-1: UAT-AC400 counts each queue over what the viewer may read, with the moment it was counted, and nothing of another unit or tenant', async () => {
    const base = await tiles(OVERVIEW_UNIT_TWO);
    for (const status of ['IN_REVIEW', 'IN_REVIEW', 'SUBMITTED', 'SIGNED', 'SIGNED', 'SIGNED', 'NUMBERED']) await outgoing(2, status);
    // Not in any queue: a draft, a document sealed or issued, one cancelled.
    for (const status of ['DRAFT', 'SEALED', 'ISSUED', 'CANCELLED']) await outgoing(2, status);
    // The unit above holds its own documents, which the viewer of unit 2 does not see.
    for (const status of ['IN_REVIEW', 'SUBMITTED', 'NUMBERED']) await outgoing(1, status);
    const after = await tiles(OVERVIEW_UNIT_TWO);
    expect(after).toMatchObject({
      drafts_in_review: (base.drafts_in_review ?? 0) + 2,
      awaiting_leader_signature: (base.awaiting_leader_signature ?? 0) + 1,
      awaiting_number: (base.awaiting_number ?? 0) + 3,
      awaiting_seal: (base.awaiting_seal ?? 0) + 1,
      // The messages of the LGSP belong to the tenant: a reader of a unit cannot count them, and is told so, not given 0.
      interop_errors: null,
    });
    // The viewer of unit 1 sees only the documents of unit 1.
    const unitOne = await tiles(OVERVIEW_UNIT_ONE);
    expect(unitOne).toMatchObject({ drafts_in_review: 1, awaiting_leader_signature: 1, awaiting_number: 0, awaiting_seal: 1 });
    const reply = await overview(OVERVIEW_UNIT_TWO);
    expect(reply.json.as_of).toBe(NOW.toISOString());
    expect((reply.json.tiles as Array<{ key: string }>).map((tile) => tile.key)).toEqual(['drafts_in_review', 'awaiting_leader_signature', 'awaiting_number', 'awaiting_seal', 'overdue_incoming', 'interop_errors', 'templates_pending_confirmation']);
    // Another tenant sees nothing of it; someone with no right to the overview is refused.
    expect((await overview(OVERVIEW_UNIT_TWO, TENANT_B)).status).toBe(403);
    expect((await overview(NOBODY)).status).toBe(403);
    expect((await overview(INCOMING_CLERK)).status).toBe(403);
  });

  it('AC-ST-DOC-014-2: UAT-AC419 counts the letters that are overdue now as the filter of the ledger does, and the templates that wait for their legal confirmation', async () => {
    const before = await tiles(OVERVIEW_UNIT_TWO);
    await letter('ASSIGNED', true);
    await letter('PROCESSING', true);
    await letter('PROCESSING', false);
    // Resolved late, it is no longer overdue (it keeps its late days); another unit's letter is not in the scope.
    await letter('RESOLVED', true);
    await letter('ASSIGNED', true, 1);
    // Templates: one published and waiting for its legal basis counts; a confirmed one and a draft do not.
    const template = async (status: string, confirmation: string): Promise<void> => {
      await owner(
        `insert into machvon.document_template (tenant_id, id, template_code, revision, group_code, doc_type_code, title, layout_profile_id, body_blocks, placeholder_schema, legal_basis, legal_confirmation_ref, confirmation_status, watermark_text, origin, content_sha256, effective_from, status, created_by, updated_by, legal_confirmed_by, legal_confirmed_at)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, 1, 'OTHER', 'QD', 'Mẫu thử tổng quan', $2::uuid, '[]'::jsonb, '{}'::jsonb, 'NĐ 30/2020/NĐ-CP', case when $3 = 'CONFIRMED' then 'CXN-DOC-01' end, $3, case when $3 = 'CONFIRMED' then null else 'CHƯA XÁC NHẬN' end, 'PLATFORM_PACK', repeat('c', 64), date '2026-01-01', $4, $5::uuid, $5::uuid,
                 case when $3 = 'CONFIRMED' then $5::uuid end, case when $3 = 'CONFIRMED' then now() end)`,
        [`TPL-OV-${randomUUID().slice(0, 8)}`, app.layoutProfileId, confirmation, status, memberId(ADMIN)],
      );
    };
    await template('PUBLISHED', 'PENDING_CONFIRMATION');
    await template('PUBLISHED', 'CONFIRMED');
    await template('DRAFT', 'PENDING_CONFIRMATION');
    const after = await tiles(OVERVIEW_UNIT_TWO);
    expect(after.overdue_incoming).toBe((before.overdue_incoming ?? 0) + 2);
    expect(after.templates_pending_confirmation).toBe((before.templates_pending_confirmation ?? 0) + 1);
    expect(after.templates_pending_confirmation).toBe(await app.count("select count(*) as n from machvon.document_template where status = 'PUBLISHED' and confirmation_status = 'PENDING_CONFIRMATION'"));
    // The ledger, filtered on overdue, says the same number for the same viewer.
    const ledger = await app.call('GET', '/incoming-documents?overdue=true&limit=200', { member: OVERVIEW_INCOMING });
    expect((ledger.json.items as unknown[]).length).toBe(after.overdue_incoming);
    expect((await tiles(OVERVIEW_INCOMING)).overdue_incoming).toBe(after.overdue_incoming);
    // The viewer of unit 1 counts the letter of unit 1 only.
    expect((await tiles(OVERVIEW_UNIT_ONE)).overdue_incoming).toBeGreaterThanOrEqual(1);
  });

  it('shows a figure only for the kinds of document the viewer may read, and never 0 for what cannot be counted', async () => {
    expect(await tiles(OVERVIEW_ONLY)).toEqual({ drafts_in_review: null, awaiting_leader_signature: null, awaiting_number: null, awaiting_seal: null, overdue_incoming: null, interop_errors: null, templates_pending_confirmation: null });
    const incomingOnly = await tiles(OVERVIEW_INCOMING);
    expect(incomingOnly.drafts_in_review).toBeNull();
    expect(incomingOnly.templates_pending_confirmation).toBeNull();
    expect(incomingOnly.overdue_incoming).toEqual(expect.any(Number));
    const all = await tiles(OVERVIEW_UNIT_TWO);
    // Every kind this viewer may read has a figure; the messages of the LGSP belong to the tenant, so a viewer of a unit has none (null, not 0).
    expect(Object.entries(all).every(([key, count]) => (key === 'interop_errors' ? count === null : typeof count === 'number'))).toBe(true);
  });
});
