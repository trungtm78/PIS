import { randomUUID } from 'node:crypto';
import { AuditWriter, DocDossierStore, DocumentStore, OutgoingDocumentStore } from '@machvon/db';
import { ACTOR, ADMIN, ARCHIVE_CHIEF, ARCHIVIST, ARCHIVIST_OUTSIDE, COUNCIL, DOSSIER_READER, DocApp, INCOMING_CLERK, NOBODY, RULE_ALL, RULE_APPROVER, RULE_DRAFTER, RULE_LEGAL, RULE_UNIT, TENANT_A, TENANT_B, memberId, unitId } from './doc-app';
import { remindHandoverDue } from '../../src/modules/doc/handover-jobs';
import { contextFor } from '../../../../packages/db/test/support/authz-fixtures';

jest.setTimeout(240_000);

const app = new DocApp();
const owner = <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => app.harness.owner<T>(TENANT_A, [[sql, params]]);
const count = (sql: string, params: unknown[] = []): Promise<number> => app.count(sql, params);

let outgoingRegisterId = '';
let incomingRegisterId = '';
let sequence = 0;
const NOW = new Date('2026-10-29T03:00:00Z');

const create = (member: number, overrides: Record<string, unknown> = {}, tenantId?: string) =>
  app.call('POST', '/dossiers', {
    member,
    ...(tenantId === undefined ? {} : { tenantId }),
    body: { dossier_code: `DS-${(sequence += 1)}`, year: 2026, title: 'Hồ sơ đầu tư dự án', organization_unit_id: unitId(2), category_code: 'PROJECT_INVESTMENT', ...overrides },
  });
const add = (member: number, id: string, version: number, body: Record<string, unknown>) => app.call('POST', `/dossiers/${id}/items`, { member, ifMatch: `"${version}"`, body });
const close = (member: number, id: string, version: number, body: Record<string, unknown> = {}) => app.call('POST', `/dossiers/${id}/closure`, { member, ifMatch: `"${version}"`, body });
const file = (member: number, letterId: string, version: number, body: Record<string, unknown>) => app.call('POST', `/incoming-documents/${letterId}/filing`, { member, ifMatch: `"${version}"`, body });
const show = (member: number, id: string, tenantId?: string) => app.call('GET', `/dossiers/${id}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });
const list = (member: number, query = '') => app.call('GET', `/dossiers${query}`, { member });
const stored = async (id: string) =>
  (await owner<{ status: string; version: string; closed_at: string | null; provisional_retention: boolean; retention_rule_id: string | null; retention_class_code: string | null; retention_ends_on: string | null; handover_due_on: string | null; settlement_closed_on: string | null }>(
    'select status, version::text, closed_at::text, provisional_retention, retention_rule_id, retention_class_code, retention_ends_on::text, handover_due_on::text, settlement_closed_on::text from machvon.dossier where id = $1',
    [id],
  ))[0];
const events = (id: string, type: string) => owner<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at', [id, type]);

/** A retention rule, published (the lawyers confirm or not), as the data owner writes it. */
async function rule(overrides: Record<string, string | number | null> = {}): Promise<string> {
  const id = randomUUID();
  const values = { rule_set: 'TT74_2025_BTC', category_code: 'PROJECT_INVESTMENT', class_code: 'Y70', retention_years: 70, start_basis: 'FROM_CLOSED', handover_months: 12, confirmation_status: 'CONFIRMED', precedence: 100, effective_from: '2025-01-01', effective_until: null, status: 'PUBLISHED', ...overrides };
  await owner(
    `insert into machvon.doc_retention_rule (tenant_id, id, rule_set, category_code, class_code, retention_years, start_basis, handover_months, legal_basis, confirmation_status, legal_confirmation_ref, precedence, effective_from, effective_until, status, created_by, updated_by)
     values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4, $5::int, $6, $7::int, 'TT 74/2025/TT-BTC (test)', $8, case when $8 = 'CONFIRMED' then 'CXN-05' end, $9::int, $10::date, $11::date, $12, $13::uuid, $13::uuid)`,
    [id, values.rule_set, values.category_code, values.class_code, values.retention_years, values.start_basis, values.handover_months, values.confirmation_status, values.precedence, values.effective_from, values.effective_until, values.status, memberId(ADMIN)],
  );
  return id;
}

async function clearRules(): Promise<void> {
  await owner('update machvon.dossier set retention_rule_id = null where retention_rule_id is not null and status = $1', ['NEVER']);
  await owner("delete from machvon.doc_retention_rule where not exists (select 1 from machvon.dossier d where d.retention_rule_id = doc_retention_rule.id)");
}

/** An issued outgoing document of a unit (numbered and sealed: the data the chain of issuing leaves). */
async function issued(options: { unit?: number; status?: string; issuedOn?: string } = {}): Promise<string> {
  const unit = unitId(options.unit ?? 2);
  const outgoing = randomUUID();
  const status = options.status ?? 'ISSUED';
  const documentId = await app.harness.tenants.withTenant(contextFor(TENANT_A, memberId(ADMIN)), async (tx) => {
    const document = await new DocumentStore().insertDocument(tx, { docKind: 'OUTGOING', docTypeCode: 'QD', title: 'Quyết định đã ban hành', classification: 'INTERNAL', createdBy: ACTOR, issuerUnitId: unit });
    await tx.query(
      `insert into machvon.outgoing_document (tenant_id, id, document_id, layout_profile_id, status, drafting_unit_id, drafter_user_id, signer_user_id, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, 'SUBMITTED', $4::uuid, $5::uuid, $5::uuid, $5::uuid, $5::uuid)`,
      [outgoing, document.id, app.layoutProfileId, unit, memberId(ADMIN)],
    );
    if (status !== 'SUBMITTED') {
      const allocation = randomUUID();
      sequence += 1;
      await tx.query(
        `insert into machvon.document_number_allocation (tenant_id, id, register_id, number, symbol, document_id, issued_on, allocated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::int, $4, $5::uuid, date '2026-09-01', $6::uuid)`,
        [allocation, outgoingRegisterId, 5000 + sequence, `KQ-${sequence}`, document.id, memberId(ADMIN)],
      );
      await tx.query('update machvon.outgoing_document set status = $2, allocation_id = $3::uuid, issued_at = now(), sealed_at = now() where id = $1::uuid', [outgoing, status, allocation]);
      await tx.query('update machvon.document set issued_on = $2::date where id = $1::uuid', [document.id, options.issuedOn ?? '2026-09-01']);
    }
    return document.id;
  });
  return documentId;
}

/** A resolved incoming letter, as the chain of ST-DOC-011 leaves it. */
async function resolvedLetter(status = 'RESOLVED'): Promise<{ id: string; documentId: string }> {
  const documentId = randomUUID();
  const id = randomUUID();
  await owner(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by)
     values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, 'INCOMING', 'QD', 'Công văn đến đã giải quyết', 'INTERNAL', $2::uuid, $2::uuid)`,
    [documentId, memberId(ADMIN)],
  );
  sequence += 1;
  await owner(
    `insert into machvon.incoming_document (tenant_id, id, document_id, status, channel, register_id, received_at, received_by, sender_name, original_symbol, original_issued_on, assigned_unit_id, assigned_by, resolution_summary, resolved_at, created_by, updated_by)
     values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, 'UPLOAD', $7::uuid, now(), $4::uuid, 'Bộ Tài chính', $5, date '2026-10-01', $6::uuid, $4::uuid, 'Đã trả lời bằng văn bản.', now(), $4::uuid, $4::uuid)`,
    [id, documentId, status, memberId(ADMIN), `FILE-${sequence}/BTC`, unitId(2), incomingRegisterId],
  );
  return { id, documentId };
}

const HANDOVER = { archive_ref: 'KLT-2026/0001', handed_over_at: '2026-10-29T03:00:00Z' };
const handover = (member: number, id: string, version: number, body: Record<string, unknown> = HANDOVER, tenantId?: string) =>
  app.call('POST', `/dossiers/${id}/handover`, { member, ...(tenantId === undefined ? {} : { tenantId }), ifMatch: `"${version}"`, body });
const propose = (member: number, id: string, version: number, reason = 'Hết thời hạn bảo quản, đề nghị xét hủy') => app.call('POST', `/dossiers/${id}/disposal-proposals`, { member, ifMatch: `"${version}"`, body: { reason } });
const decide = (member: number, id: string, version: number, body: Record<string, unknown>) => app.call('POST', `/dossiers/${id}/disposal-decision`, { member, ifMatch: `"${version}"`, body });
const draftRule = (member: number, body: Record<string, unknown> = {}, tenantId?: string) =>
  app.call('POST', '/document-retention-rules', {
    member,
    ...(tenantId === undefined ? {} : { tenantId }),
    body: { rule_set: 'TENANT_CUSTOM', category_code: 'RULE_CAT', class_code: 'Y10', retention_years: 10, start_basis: 'FROM_CLOSED', legal_basis: 'Điều 5 Thông tư 10/2022/TT-BNV', effective_from: '2040-01-01', ...body },
  });
const publishRule = (member: number, id: string, version: number) => app.call('POST', `/document-retention-rules/${id}/publish`, { member, ifMatch: `"${version}"`, body: {} });
const confirmRule = (member: number, id: string, version: number, body: Record<string, unknown>) => app.call('POST', `/document-retention-rules/${id}/legal-confirmation`, { member, ifMatch: `"${version}"`, body });
const storedRule = async (id: string) =>
  (await owner<{ status: string; version: string; confirmation_status: string; approved_by: string | null; legal_confirmed_by: string | null; legal_confirmation_ref: string | null; legal_evidence_document_id: string | null }>(
    'select status, version::text, confirmation_status, approved_by, legal_confirmed_by, legal_confirmation_ref, legal_evidence_document_id from machvon.doc_retention_rule where id = $1',
    [id],
  ))[0];
const storedDossier = async (id: string) =>
  (await owner<{ status: string; version: string; archive_ref: string | null; handed_over_by: string | null; disposal_proposed_by: string | null; disposal_reason: string | null; disposal_from_status: string | null; disposal_decided_by: string | null; disposal_decision_document_id: string | null; disposal_comment: string | null }>(
    'select status, version::text, archive_ref, handed_over_by, disposal_proposed_by, disposal_reason, disposal_from_status, disposal_decided_by, disposal_decision_document_id, disposal_comment from machvon.dossier where id = $1',
    [id],
  ))[0];
let holdId = '';
const placeHold = (): Promise<unknown> => {
  holdId = randomUUID();
  return owner(
    `insert into machvon.legal_hold (tenant_id, id, resource_scope, authority_reference, reason, effective_at, hold_kind, status, placed_by, version)
     values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, '{"kind":"TENANT","ids":[]}'::jsonb, 'QĐ-417/TTCP', 'Thanh tra hồ sơ', now() - interval '1 day', 'INSPECTION', 'Active', $2::uuid, 1)`,
    [holdId, memberId(ADMIN)],
  );
};
const releaseHold = (): Promise<unknown> =>
  owner("update machvon.legal_hold set status = 'Released', released_at = now(), released_by = $1::uuid, release_reason = 'released for the test' where id = $2::uuid", [memberId(INCOMING_CLERK), holdId]);

/** A dossier of a category closed on `closedOn` under the rule of the category (a confirmed Y5 rule unless the category has none): the dossier, its documents and the version after closing. */
async function closedDossier(category: string, options: { closedOn?: string; withRule?: boolean } = {}): Promise<{ id: string; version: number; documentId: string }> {
  if (options.withRule !== false) await rule({ category_code: category, class_code: 'Y5', retention_years: 5, handover_months: 0 });
  const id = (await create(ARCHIVIST, { category_code: category })).json.resource_id as string;
  const documentId = await issued();
  expect((await add(ARCHIVIST, id, 1, { document_id: documentId })).status).toBe(200);
  app.now = new Date(`${options.closedOn ?? '2026-10-29'}T03:00:00Z`);
  expect((await close(ARCHIVIST, id, 2)).status).toBe(200);
  return { id, version: 3, documentId };
}

const AFTER_RETENTION = new Date('2031-10-30T03:00:00Z');

describe('dossiers over HTTP (ST-DOC-013)', () => {
  beforeAll(async () => {
    await app.start();
    const made = await app.call('POST', '/document-number-registers', { member: ADMIN, body: { register_code: 'REG-DI-HS', name: 'Sổ đi', direction: 'OUTGOING', organization_unit_id: unitId(2), year: 2026, scope_doc_types: ['QD'] } });
    expect(made.status).toBe(200);
    outgoingRegisterId = made.json.resource_id as string;
    const taken = await app.call('POST', '/document-number-registers', { member: ADMIN, body: { register_code: 'REG-DEN-HS', name: 'Sổ đến', direction: 'INCOMING', organization_unit_id: unitId(2), year: 2026, scope_doc_types: ['QD'] } });
    expect(taken.status).toBe(200);
    incomingRegisterId = taken.json.resource_id as string;
    app.now = NOW;
  }, 480_000);
  afterAll(() => app.stop(), 60_000);
  afterEach(() => {
    app.now = NOW;
  });

  it('AC-ST-DOC-013-1: UAT-AC421 closes a dossier while no rule is confirmed, keeps it for ever provisionally, and names the blocker of a disposal; a confirmed rule gives the second dossier its class and its handover', async () => {
    // Two rules, neither confirmed; a legal hold on the whole tenant.
    await rule({ rule_set: 'TT74_2025_BTC', class_code: 'PERMANENT', retention_years: null, confirmation_status: 'PENDING_CONFIRMATION', precedence: 10 });
    await rule({ rule_set: 'TT10_2022_BNV', class_code: 'Y20', retention_years: 20, confirmation_status: 'PENDING_CONFIRMATION', precedence: 20 });
    await owner(
      `insert into machvon.legal_hold (tenant_id, id, resource_scope, authority_reference, reason, effective_at, hold_kind, status, placed_by, version)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, '{"kind":"TENANT","ids":[]}'::jsonb, 'QĐ-421/TTCP', 'Thanh tra dự án', now() - interval '1 day', 'INSPECTION', 'Active', $2::uuid, 1)`,
      ['00000000-0000-4000-8000-0000000421a1', memberId(ADMIN)],
    );
    try {
      const first = await create(ARCHIVIST, { dossier_code: 'DS-421' });
      expect(first).toMatchObject({ status: 200, json: { status: 'OPEN', resource_version: 1 } });
      const id = first.json.resource_id as string;
      for (let n = 0; n < 6; n += 1) expect((await add(ARCHIVIST, id, 1 + n, { document_id: await issued() })).status).toBe(200);
      const closed = await close(ARCHIVIST, id, 7);
      expect(closed).toMatchObject({ status: 200, json: { status: 'CLOSED', provisional_retention: true, retention_class_code: 'PERMANENT', retention_rule_id: null, handover_due_on: null, retention_ends_on: null } });
      expect(await stored(id)).toMatchObject({ status: 'CLOSED', provisional_retention: true, retention_class_code: 'PERMANENT', retention_rule_id: null, retention_ends_on: null, handover_due_on: null });
      // The proposal of a disposal would be refused first for being provisional (422 RETENTION_PROVISIONAL), though the hold is Active too.
      expect((await show(ARCHIVIST, id)).json).toMatchObject({ disposal_blocker: 'RETENTION_PROVISIONAL', legal_hold_active: true, retention: { provisional: true, class_code: 'PERMANENT', rule_id: null } });
      expect((await events(id, 'doc.dossier_closed.v1'))[0]?.payload).toMatchObject({ provisional_retention: true, retention_class_code: 'PERMANENT', dossier_code: 'DS-421' });

      // The lawyers confirm TT 74 as 70 years, precedence 10: the second dossier of the category takes it.
      await owner("update machvon.doc_retention_rule set class_code = 'Y70', retention_years = 70, confirmation_status = 'CONFIRMED', legal_confirmation_ref = 'CXN-05' where rule_set = 'TT74_2025_BTC'");
      const second = await create(ARCHIVIST, { dossier_code: 'DS-421b' });
      const secondId = second.json.resource_id as string;
      expect((await add(ARCHIVIST, secondId, 1, { document_id: await issued() })).status).toBe(200);
      const done = await close(ARCHIVIST, secondId, 2);
      expect(done).toMatchObject({ status: 200, json: { provisional_retention: false, retention_class_code: 'Y70', retention_ends_on: '2096-10-29', handover_due_on: '2027-10-29' } });
      const row = await stored(secondId);
      expect(row).toMatchObject({ provisional_retention: false, retention_class_code: 'Y70', retention_ends_on: '2096-10-29', handover_due_on: '2027-10-29' });
      expect(row?.retention_rule_id).not.toBeNull();
      // With the hold Active the disposal is blocked by the hold (409 LEGAL_HOLD_ACTIVE), also when the retention is over.
      expect((await show(ARCHIVIST, secondId)).json).toMatchObject({ disposal_blocker: 'LEGAL_HOLD_ACTIVE', legal_hold_active: true, retention: { class_code: 'Y70', provisional: false } });
      // And what closing wrote down does not change when the rule changes later.
      await owner("update machvon.doc_retention_rule set precedence = 5 where id = $1", [row?.retention_rule_id]);
      expect((await stored(secondId))?.retention_rule_id).toBe(row?.retention_rule_id);
      // Released, only the end of the retention is left.
      await owner("update machvon.legal_hold set status = 'Released', released_at = now(), released_by = $1::uuid, release_reason = 'released for the test' where id = $2::uuid", [memberId(INCOMING_CLERK), '00000000-0000-4000-8000-0000000421a1']);
      expect((await show(ARCHIVIST, secondId)).json).toMatchObject({ disposal_blocker: 'RETENTION_NOT_EXPIRED', legal_hold_active: false });
    } finally {
      await owner("delete from machvon.legal_hold where id = '00000000-0000-4000-8000-0000000421a1'").catch(() => undefined);
    }
  });

  it('AC-ST-DOC-013-2: UAT-AC422 gives each dossier the rule in force on the day it is closed, and does not let two published rules of one set and category overlap', async () => {
    await clearRules().catch(() => undefined);
    const oldRule = await rule({ category_code: 'ACCOUNTING', class_code: 'Y20', retention_years: 20, effective_from: '2025-01-01', effective_until: '2027-01-01' });
    const fill = async (code: string): Promise<{ id: string; version: number }> => {
      const made = await create(ARCHIVIST, { dossier_code: code, category_code: 'ACCOUNTING' });
      const id = made.json.resource_id as string;
      expect((await add(ARCHIVIST, id, 1, { document_id: await issued() })).status).toBe(200);
      return { id, version: 2 };
    };
    const a = await fill('DS-A');
    const b = await fill('DS-B');
    app.now = new Date('2026-12-31T03:00:00Z');
    expect(await close(ARCHIVIST, a.id, a.version)).toMatchObject({ status: 200, json: { retention_class_code: 'Y20', retention_ends_on: '2046-12-31' } });
    // The new rule overlaps the old one: refused by the database; starting the day the old one ends is fine.
    await expect(rule({ category_code: 'ACCOUNTING', class_code: 'Y70', retention_years: 70, effective_from: '2026-06-01' })).rejects.toThrow(/exclusion|overlap|conflicting/i);
    const newRule = await rule({ category_code: 'ACCOUNTING', class_code: 'Y70', retention_years: 70, effective_from: '2027-01-01' });
    app.now = new Date('2027-01-02T03:00:00Z');
    expect(await close(ARCHIVIST, b.id, b.version)).toMatchObject({ status: 200, json: { retention_class_code: 'Y70' } });
    expect((await stored(a.id))?.retention_class_code).toBe('Y20');
    expect((await stored(b.id))?.retention_rule_id).toBe(newRule);
    expect((await stored(a.id))?.retention_rule_id).toBe(oldRule);
    // A draft or a superseded rule over the same days does not collide (only the published ones do).
    await expect(rule({ category_code: 'ACCOUNTING', class_code: 'Y70', retention_years: 70, effective_from: '2027-06-01', status: 'DRAFT' })).resolves.toEqual(expect.any(String));
  });

  it('starts the years from the settlement when the rule says so, and asks for its day', async () => {
    const settlementRule = await rule({ category_code: 'SETTLEMENT_CAT', class_code: 'Y10', retention_years: 10, start_basis: 'FROM_SETTLEMENT', handover_months: 6 });
    const made = await create(ARCHIVIST, { category_code: 'SETTLEMENT_CAT' });
    const id = made.json.resource_id as string;
    expect((await add(ARCHIVIST, id, 1, { document_id: await issued() })).status).toBe(200);
    expect(await close(ARCHIVIST, id, 2)).toMatchObject({ status: 422, json: { detail: 'settlement_closed_on' } });
    expect(await close(ARCHIVIST, id, 2, { settlement_closed_on: '2026-02-30' })).toMatchObject({ status: 422, json: { detail: 'settlement_closed_on' } });
    expect(await close(ARCHIVIST, id, 2, { settlement_closed_on: '2027-01-01' })).toMatchObject({ status: 422, json: { detail: 'settlement_closed_on' } });
    expect((await stored(id))?.status).toBe('OPEN');
    expect(await close(ARCHIVIST, id, 2, { settlement_closed_on: '2026-06-30' })).toMatchObject({ status: 200, json: { retention_ends_on: '2036-06-30', handover_due_on: '2027-04-29' } });
    expect(await stored(id)).toMatchObject({ settlement_closed_on: '2026-06-30', retention_rule_id: settlementRule });
  });

  it('AC-ST-DOC-013-3: UAT-AC419 files a resolved incoming letter into an open dossier, once, and tells the chain', async () => {
    const letter = await resolvedLetter();
    const made = await create(ARCHIVIST, { dossier_code: 'DS-FILE' });
    const dossierId = made.json.resource_id as string;
    const filed = await file(ARCHIVIST, letter.id, 1, { dossier_id: dossierId });
    expect(filed).toMatchObject({ status: 200, json: { status: 'FILED', resource_version: 2, dossier_id: dossierId, ordinal: 1 } });
    expect((await owner<{ status: string; version: string }>('select status, version::text from machvon.incoming_document where id = $1', [letter.id]))[0]).toEqual({ status: 'FILED', version: '2' });
    expect((await events(letter.id, 'doc.incoming_filed.v1'))[0]?.payload).toMatchObject({ dossier_id: dossierId, incoming_document_id: letter.id, status: 'FILED', tenant_id: TENANT_A });
    expect((await events(dossierId, 'doc.dossier_item_added.v1')).length).toBe(1);
    expect(await count("select count(*) as n from machvon.audit_event where resource_id = $1 and action = 'incoming_document.filed'", [letter.id])).toBe(1);
    const shown = (await show(ARCHIVIST, dossierId)).json;
    expect(shown).toMatchObject({ item_count: 1, version: 2, items: [{ document_id: letter.documentId, ordinal: 1, doc_kind: 'INCOMING' }] });
    // Again: filed already, and a document is in one dossier only.
    expect(await file(ARCHIVIST, letter.id, 2, { dossier_id: dossierId })).toMatchObject({ status: 409, json: { code: 'DOCUMENT_STATE_INVALID' } });
    const other = await create(ARCHIVIST, { dossier_code: 'DS-FILE-2' });
    expect(await add(ARCHIVIST, other.json.resource_id as string, 1, { document_id: letter.documentId })).toMatchObject({ status: 422, json: { code: 'DOCUMENT_ALREADY_IN_DOSSIER' } });
  });

  it('counts a rule that starts from the issue from the day written on an incoming letter, and pages the rules by category then id', async () => {
    await rule({ category_code: 'ISSUED_CAT', class_code: 'Y5', retention_years: 5, start_basis: 'FROM_ISSUED', handover_months: 0 });
    const letter = await resolvedLetter();
    const id = (await create(ARCHIVIST, { category_code: 'ISSUED_CAT' })).json.resource_id as string;
    expect((await file(ARCHIVIST, letter.id, 1, { dossier_id: id })).status).toBe(200);
    // The letter says 2026-10-01 (nothing else is in the dossier), so the five years end on 2031-10-01, not five years after the closing.
    expect(await close(ARCHIVIST, id, 2)).toMatchObject({ status: 200, json: { retention_ends_on: '2031-10-01', retention_class_code: 'Y5' } });
    // Two categories where one is the start of the other: a page ending at the shorter does not skip the longer.
    await rule({ category_code: 'PAGE_CAT', rule_set: 'TT10_2022_BNV' });
    await rule({ category_code: 'PAGE_CAT_EXTRA', rule_set: 'TT10_2022_BNV' });
    await rule({ category_code: 'PAGE_CAT', rule_set: 'TENANT_CUSTOM' });
    const seen: string[] = [];
    let cursor = '';
    for (let pages = 0; pages < 40; pages += 1) {
      const page = (await app.call('GET', `/document-retention-rules?limit=1${cursor}`, { member: ARCHIVIST })).json;
      seen.push(...(page.items as Array<{ id: string }>).map((item) => item.id));
      if (page.next_cursor === null) break;
      cursor = `&cursor=${page.next_cursor as string}`;
    }
    const all = ((await app.call('GET', '/document-retention-rules?limit=200', { member: ARCHIVIST })).json.items as Array<{ id: string }>).map((item) => item.id);
    expect(seen).toEqual(all);
  });

  it('refuses to file a letter that is not resolved, with a dossier that is not open, with a stale version or without a dossier', async () => {
    const dossier = (await create(ARCHIVIST)).json.resource_id as string;
    const pending = await resolvedLetter('PROCESSING');
    expect(await file(ARCHIVIST, pending.id, 1, { dossier_id: dossier })).toMatchObject({ status: 409, json: { code: 'DOCUMENT_STATE_INVALID' } });
    const letter = await resolvedLetter();
    expect(await file(ARCHIVIST, letter.id, 4, { dossier_id: dossier })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    expect((await file(ARCHIVIST, letter.id, 1, {})).status).toBe(400);
    expect([400, 422]).toContain((await file(ARCHIVIST, letter.id, 1, { dossier_id: 'not-a-uuid' })).status);
    expect(await file(ARCHIVIST, letter.id, 1, { dossier_id: randomUUID() })).toMatchObject({ status: 404 });
    // A closed dossier takes nothing more.
    const closedOne = (await create(ARCHIVIST)).json.resource_id as string;
    expect((await add(ARCHIVIST, closedOne, 1, { document_id: await issued() })).status).toBe(200);
    expect((await close(ARCHIVIST, closedOne, 2)).status).toBe(200);
    expect(await file(ARCHIVIST, letter.id, 1, { dossier_id: closedOne })).toMatchObject({ status: 409, json: { code: 'DOSSIER_NOT_OPEN' } });
    expect((await owner<{ status: string }>('select status from machvon.incoming_document where id = $1', [letter.id]))[0]?.status).toBe('RESOLVED');
    // The dossier of another unit, and the letter without the right, are as good as none.
    const outsideDossier = (await create(ARCHIVIST_OUTSIDE, { organization_unit_id: unitId(1), dossier_code: 'DS-OUT' })).json.resource_id as string;
    expect(await file(ARCHIVIST, letter.id, 1, { dossier_id: outsideDossier })).toMatchObject({ status: 404 });
    expect((await file(NOBODY, letter.id, 1, { dossier_id: dossier })).status).toBe(403);
    expect((await file(DOSSIER_READER, letter.id, 1, { dossier_id: dossier })).status).toBe(403);
  });

  it('files an issued outgoing document into a dossier, once, and only an issued one', async () => {
    const dossier = (await create(ARCHIVIST)).json.resource_id as string;
    const documentId = await issued({ status: 'DELIVERED' });
    expect(await add(ARCHIVIST, dossier, 1, { document_id: documentId })).toMatchObject({ status: 200, json: { ordinal: 1, document_id: documentId, resource_version: 2 } });
    expect((await owner<{ status: string }>('select status from machvon.outgoing_document where document_id = $1', [documentId]))[0]?.status).toBe('FILED');
    // The same document again, here or in another dossier.
    expect(await add(ARCHIVIST, dossier, 2, { document_id: documentId })).toMatchObject({ status: 422, json: { code: 'DOCUMENT_ALREADY_IN_DOSSIER' } });
    const other = (await create(ARCHIVIST)).json.resource_id as string;
    expect(await add(ARCHIVIST, other, 1, { document_id: documentId })).toMatchObject({ status: 422, json: { code: 'DOCUMENT_ALREADY_IN_DOSSIER' } });
    // A draft, a document that is not there, one that is not a letter, and one of a unit out of reach.
    expect(await add(ARCHIVIST, dossier, 2, { document_id: await issued({ status: 'SUBMITTED' }) })).toMatchObject({ status: 422, json: { code: 'DOCUMENT_NOT_FILEABLE' } });
    expect(await add(ARCHIVIST, dossier, 2, { document_id: randomUUID() })).toMatchObject({ status: 422, json: { detail: 'document_id' } });
    expect(await add(ARCHIVIST, dossier, 2, { document_id: await issued({ unit: 1 }) })).toMatchObject({ status: 422, json: { detail: 'document_id' } });
    // The place in the contents: asked for, taken, and the next free one.
    const free = await issued();
    expect(await add(ARCHIVIST, dossier, 2, { document_id: free, ordinal: 1 })).toMatchObject({ status: 422, json: { detail: 'ordinal' } });
    expect(await add(ARCHIVIST, dossier, 2, { document_id: free, ordinal: 0 })).toMatchObject({ status: 422, json: { detail: 'ordinal' } });
    expect(await add(ARCHIVIST, dossier, 2, { document_id: free, ordinal: 5 })).toMatchObject({ status: 200, json: { ordinal: 5 } });
    expect(await add(ARCHIVIST, dossier, 3, { document_id: await issued() })).toMatchObject({ status: 200, json: { ordinal: 6 } });
    expect(await add(ARCHIVIST, dossier, 3, { document_id: await issued() })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    expect((await show(ARCHIVIST, dossier)).json.items).toHaveLength(3);
  });

  it('files a corrected document too, which is still in force: it stays CORRECTED, with its effect, and the step is in its timeline (ST-DOC-015)', async () => {
    const dossier = (await create(ARCHIVIST)).json.resource_id as string;
    const documentId = await issued({ status: 'CORRECTED' });
    await owner("update machvon.document set effect_status = 'CORRECTED', symbol = 'KQ-C/QD-UBND', document_number = 5999, number_year = 2026 where id = $1", [documentId]);
    expect(await add(ARCHIVIST, dossier, 1, { document_id: documentId })).toMatchObject({ status: 200, json: { ordinal: 1, document_id: documentId } });
    const [kept] = await owner<{ status: string; effect_status: string }>('select o.status, d.effect_status from machvon.outgoing_document o join machvon.document d on d.id = o.document_id where o.document_id = $1', [documentId]);
    expect(kept).toEqual({ status: 'CORRECTED', effect_status: 'CORRECTED' });
    const [step] = await owner<{ from_status: string; to_status: string }>("select e.from_status, e.to_status from machvon.outgoing_document_event e join machvon.outgoing_document o on o.id = e.outgoing_document_id where o.document_id = $1 and e.kind = 'FILED'", [documentId]);
    expect(step).toEqual({ from_status: 'CORRECTED', to_status: 'CORRECTED' });
  });

  it('keeps a filed document in the sweep of the revocation of its certificates', async () => {
    const documentId = await issued();
    await app.harness.tenants.withTenant(contextFor(TENANT_A, memberId(ADMIN)), async (tx) => {
      const store = new DocumentStore();
      const version = await store.appendVersion(tx, { documentId, objectKey: `tenants/${TENANT_A}/documents/${documentId}-sealed.pdf`, checksum: 'b'.repeat(64), mime: 'application/pdf', pageCount: 1, classification: 'INTERNAL', stage: 'ORG_SEALED', byteLength: 10, createdBy: ACTOR });
      await store.setScanResult(tx, version.id, 'CLEAN');
    });
    const due = async (): Promise<string[]> =>
      (await app.harness.tenants.withTenant(contextFor(TENANT_A, memberId(ADMIN)), (tx) => new OutgoingDocumentStore().issuedFilesDueForRevocationCheck(tx, { checkedBefore: new Date(Date.now() + 60_000), limit: 500 }))).map((entry) => entry.documentId);
    expect(await due()).toContain(documentId);
    const dossier = (await create(ARCHIVIST)).json.resource_id as string;
    expect((await add(ARCHIVIST, dossier, 1, { document_id: documentId })).status).toBe(200);
    expect((await owner<{ status: string }>('select status from machvon.outgoing_document where document_id = $1', [documentId]))[0]?.status).toBe('FILED');
    expect(await due()).toContain(documentId);
    // The step is in the timeline of the document: who filed it, from where, into which dossier.
    const [event] = await owner<{ kind: string; from_status: string; to_status: string; actor_id: string; details: { dossier_id: string; ordinal: number }; document_version: string }>(
      "select e.kind, e.from_status, e.to_status, e.actor_id, e.details, e.document_version::text from machvon.outgoing_document_event e join machvon.outgoing_document o on o.id = e.outgoing_document_id where o.document_id = $1 and e.kind = 'FILED'",
      [documentId],
    );
    expect(event).toMatchObject({ kind: 'FILED', from_status: 'ISSUED', to_status: 'FILED', actor_id: memberId(ARCHIVIST), details: { dossier_id: dossier, ordinal: 1 } });
  });

  it('tells nothing of a document out of reach: a filed document of another unit and one that is not there are refused alike', async () => {
    const dossier = (await create(ARCHIVIST)).json.resource_id as string;
    const foreign = await issued({ unit: 1 });
    const theirs = (await create(ARCHIVIST_OUTSIDE, { organization_unit_id: unitId(1), dossier_code: 'DS-THEIRS' })).json.resource_id as string;
    expect((await add(ARCHIVIST_OUTSIDE, theirs, 1, { document_id: foreign })).status).toBe(200);
    const refusal = async (documentId: string) => {
      const reply = await add(ARCHIVIST, dossier, 1, { document_id: documentId });
      return [reply.status, reply.json.code, reply.json.detail];
    };
    expect(await refusal(foreign)).toEqual(await refusal(randomUUID()));
    expect(await refusal(foreign)).toEqual([422, 'VALIDATION_FAILED', 'document_id']);
    // A document recalled meanwhile is not filed: the conditional update of the store finds nothing to change.
    const recalled = await issued();
    await owner("update machvon.outgoing_document set status = 'RECALLED', recalled_at = now(), recalled_by = $2::uuid, recall_reason = 'recalled for the test of filing' where document_id = $1", [recalled, memberId(ADMIN)]);
    expect(await app.harness.tenants.withTenant(contextFor(TENANT_A, memberId(ARCHIVIST)), (tx) => new DocDossierStore().markOutgoingFiled(tx, recalled, { actor: memberId(ARCHIVIST), dossierId: dossier, ordinal: 1, at: NOW }))).toBe(false);
    expect(await add(ARCHIVIST, dossier, 1, { document_id: recalled })).toMatchObject({ status: 422, json: { code: 'DOCUMENT_NOT_FILEABLE' } });
    // A draft of another unit is refused the same way, and a document that is not a letter too.
    expect(await refusal(await issued({ unit: 1, status: 'SUBMITTED' }))).toEqual([422, 'VALIDATION_FAILED', 'document_id']);
  });

  it('opens a dossier in a unit of the caller, with a unique code in its year, and refuses what is not well formed', async () => {
    expect(await create(ARCHIVIST, { dossier_code: 'DS-UNIQUE' })).toMatchObject({ status: 200 });
    expect(await create(ARCHIVIST, { dossier_code: 'DS-UNIQUE' })).toMatchObject({ status: 409, json: { code: 'DOSSIER_CODE_DUPLICATE' } });
    expect(await create(ARCHIVIST, { dossier_code: 'DS-UNIQUE', year: 2025 })).toMatchObject({ status: 200 });
    for (const [overrides, field] of [
      [{ dossier_code: '  ' }, 'dossier_code'],
      [{ dossier_code: 'ab' }, 'dossier_code'],
      [{ title: '   ' }, 'title'],
      [{ year: 1999 }, 'year'],
      [{ year: 2099 }, 'year'],
      [{ category_code: 'lower_case' }, 'category_code'],
      [{ subject_module: 'PRJ' }, 'subject_id'],
      [{ subject_id: randomUUID() }, 'subject_module'],
      [{ subject_module: 'NOPE', subject_id: randomUUID() }, 'subject_module'],
      [{ organization_unit_id: randomUUID() }, 'organization_unit_id'],
    ] as const) {
      const reply = await create(ARCHIVIST, overrides);
      expect([field, reply.status, reply.json.detail]).toEqual([field, 422, field]);
    }
    // A unit out of reach is refused, and so is a caller without the right.
    expect((await create(ARCHIVIST, { organization_unit_id: unitId(1) })).status).toBe(403);
    expect((await create(ARCHIVIST_OUTSIDE, { organization_unit_id: unitId(2) })).status).toBe(403);
    expect((await create(DOSSIER_READER)).status).toBe(403);
    expect((await create(NOBODY)).status).toBe(403);
    expect((await create(ARCHIVIST, { extra: 1 })).status).toBe(400);
    const subject = randomUUID();
    const withSubject = await create(ARCHIVIST, { subject_module: 'prj', subject_id: subject });
    expect(withSubject.status).toBe(200);
    expect((await show(ARCHIVIST, withSubject.json.resource_id as string)).json).toMatchObject({ subject_module: 'PRJ', subject_id: subject, status: 'OPEN', item_count: 0, version: 1 });
    expect(await count("select count(*) as n from machvon.audit_event where resource_id = $1 and action = 'dossier.created'", [withSubject.json.resource_id])).toBe(1);
  });

  it('does not close an empty dossier or one that is not open, and writes what it closed with once', async () => {
    const id = (await create(ARCHIVIST)).json.resource_id as string;
    expect(await close(ARCHIVIST, id, 1)).toMatchObject({ status: 422, json: { code: 'DOSSIER_EMPTY' } });
    expect((await add(ARCHIVIST, id, 1, { document_id: await issued() })).status).toBe(200);
    expect(await close(ARCHIVIST, id, 1)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    expect((await close(ARCHIVIST, id, 2)).status).toBe(200);
    expect(await close(ARCHIVIST, id, 3)).toMatchObject({ status: 409, json: { code: 'DOSSIER_NOT_OPEN' } });
    expect(await add(ARCHIVIST, id, 3, { document_id: await issued() })).toMatchObject({ status: 409, json: { code: 'DOSSIER_NOT_OPEN' } });
    expect((await close(ARCHIVIST_OUTSIDE, id, 3)).status).toBe(404);
    expect(await count("select count(*) as n from machvon.audit_event where resource_id = $1 and action = 'dossier.closed'", [id])).toBe(1);
  });

  it('shows the dossiers in the scope of the caller, narrowed and in pages, with what the caller may do, and nothing of another tenant', async () => {
    const mine = (await create(ARCHIVIST, { dossier_code: 'DS-LIST-1', subject_module: 'PRJ', subject_id: '00000000-0000-4000-8000-00000000f001' })).json.resource_id as string;
    const outside = (await create(ARCHIVIST_OUTSIDE, { organization_unit_id: unitId(1), dossier_code: 'DS-LIST-OUT' })).json.resource_id as string;
    expect(await count('select count(*) as n from machvon.dossier where id = any($1::uuid[])', [[mine, outside]])).toBe(2);
    const seen = (await list(ARCHIVIST, '?limit=200')).json.items as Array<{ id: string; actions: Record<string, boolean>; organization_unit: { id: string } }>;
    expect(seen.map((item) => item.id)).toContain(mine);
    expect(seen.map((item) => item.id)).not.toContain(outside);
    expect(seen.find((item) => item.id === mine)).toMatchObject({ actions: { addDocument: true, close: false }, organization_unit: { id: unitId(2) } });
    expect(((await list(DOSSIER_READER, '?limit=200')).json.items as Array<{ id: string; actions: Record<string, boolean> }>).find((item) => item.id === mine)?.actions).toEqual({ addDocument: false, close: false, handover: false, proposeDisposal: false, decideDisposal: false });
    const outsideSees = ((await list(ARCHIVIST_OUTSIDE, '?limit=200')).json.items as Array<{ id: string }>).map((item) => item.id);
    expect(outsideSees).toContain(outside);
    expect(outsideSees).not.toContain(mine);
    // Filters and pages.
    expect(((await list(ARCHIVIST, '?subject_module=prj&subject_id=00000000-0000-4000-8000-00000000f001')).json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([mine]);
    expect(((await list(ARCHIVIST, '?status=CLOSED&limit=200')).json.items as Array<{ status: string }>).every((item) => item.status === 'CLOSED')).toBe(true);
    const first = (await list(ARCHIVIST, '?limit=2')).json;
    expect(first.items).toHaveLength(2);
    expect(typeof first.next_cursor).toBe('string');
    const second = (await list(ARCHIVIST, `?limit=2&cursor=${first.next_cursor as string}`)).json;
    expect((second.items as Array<{ id: string }>).map((item) => item.id)).not.toEqual(expect.arrayContaining([(first.items as Array<{ id: string }>)[0]?.id]));
    for (const bad of ['status=NOPE', 'subject_module=NOPE', 'subject_id=x', 'year=26', 'limit=0', 'cursor=bad', `cursor=${Buffer.from(JSON.stringify(['invalid', randomUUID()])).toString('base64url')}`]) expect([bad, (await list(ARCHIVIST, `?${bad}`)).status]).toEqual([bad, 422]);
    // A dossier of another unit, of another tenant, or without the right to read is as good as none.
    expect((await show(ARCHIVIST_OUTSIDE, mine)).status).toBe(404);
    expect((await show(NOBODY, mine)).status).toBe(403);
    expect((await show(ARCHIVIST, mine, TENANT_B)).status).toBe(403);
    expect((await show(ARCHIVIST, randomUUID())).status).toBe(404);
    expect((await show(DOSSIER_READER, mine)).json).toMatchObject({ id: mine, actions: { addDocument: false } });
  });

  it('lists the retention rules with their confirmation, narrowed and in pages', async () => {
    const reply = await app.call('GET', '/document-retention-rules?limit=200', { member: ARCHIVIST });
    expect(reply.status).toBe(200);
    const items = reply.json.items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThan(2);
    expect(Object.keys(items[0] as object).sort()).toEqual(['approved_by', 'category_code', 'class_code', 'confirmation_status', 'created_by', 'effective_from', 'effective_until', 'end_action', 'handover_months', 'id', 'legal_basis', 'legal_confirmation_ref', 'legal_confirmed_by', 'precedence', 'retention_years', 'rule_set', 'start_basis', 'status', 'version']);
    const only = (await app.call('GET', '/document-retention-rules?rule_set=TT74_2025_BTC&category_code=ACCOUNTING', { member: ARCHIVIST })).json.items as Array<{ rule_set: string; category_code: string }>;
    expect(only.length).toBeGreaterThan(0);
    expect(only.every((item) => item.rule_set === 'TT74_2025_BTC' && item.category_code === 'ACCOUNTING')).toBe(true);
    const page = (await app.call('GET', '/document-retention-rules?limit=2', { member: ARCHIVIST })).json;
    expect(page.items).toHaveLength(2);
    const next = (await app.call('GET', `/document-retention-rules?limit=2&cursor=${page.next_cursor as string}`, { member: ARCHIVIST })).json.items as Array<{ id: string }>;
    expect(next.map((item) => item.id)).not.toContain((page.items as Array<{ id: string }>)[0]?.id);
    for (const bad of ['rule_set=NOPE', 'category_code=lower', 'limit=0', 'cursor=bad']) expect([bad, (await app.call('GET', `/document-retention-rules?${bad}`, { member: ARCHIVIST })).status]).toEqual([bad, 422]);
    expect((await app.call('GET', '/document-retention-rules', { member: DOSSIER_READER })).status).toBe(403);
    expect((await app.call('GET', '/document-retention-rules', { member: ARCHIVIST, tenantId: TENANT_B })).status).toBe(403);
  });

  it('keeps the dossier as it was written: the database refuses to rewrite what closing wrote, to go back, to take in a document once closed, or to erase', async () => {
    const id = (await create(ARCHIVIST)).json.resource_id as string;
    const documentId = await issued();
    expect((await add(ARCHIVIST, id, 1, { document_id: documentId })).status).toBe(200);
    await expect(owner("update machvon.dossier set status = 'HANDED_OVER' where id = $1", [id])).rejects.toThrow(/does not go from OPEN to HANDED_OVER/);
    await expect(owner("update machvon.dossier set dossier_code = 'CHANGED' where id = $1", [id])).rejects.toThrow(/not changed/);
    expect((await close(ARCHIVIST, id, 2)).status).toBe(200);
    await expect(owner("update machvon.dossier set status = 'OPEN' where id = $1", [id])).rejects.toThrow(/does not go from CLOSED to OPEN/);
    const bare = (await create(ARCHIVIST, { category_code: 'NO_RULE_CAT' })).json.resource_id as string;
    expect((await add(ARCHIVIST, bare, 1, { document_id: await issued() })).status).toBe(200);
    expect((await close(ARCHIVIST, bare, 2)).status).toBe(200);
    // Provisional (no rule for the category): it may be settled once, but the day of closing stays.
    await expect(owner("update machvon.dossier set closed_at = now() - interval '1 year' where id = $1", [bare])).rejects.toThrow(/day a dossier was closed/);
    await rule({ category_code: 'GUARD_CAT' });
    const second = (await create(ARCHIVIST, { category_code: 'GUARD_CAT' })).json.resource_id as string;
    expect((await add(ARCHIVIST, second, 1, { document_id: await issued() })).status).toBe(200);
    expect((await close(ARCHIVIST, second, 2)).status).toBe(200);
    await expect(owner("update machvon.dossier set retention_class_code = 'Y5' where id = $1", [second])).rejects.toThrow(/not rewritten/);
    await expect(owner("update machvon.dossier set provisional_retention = true where id = $1", [second])).rejects.toThrow(/not rewritten|dossier_provisional_chk/);
    await expect(owner('insert into machvon.dossier_item (tenant_id, id, dossier_id, document_id, ordinal, added_by) values (nullif(current_setting(\'app.tenant_id\', true), \'\')::uuid, gen_random_uuid(), $1, $2, 9, $3)', [second, await issued(), memberId(ADMIN)])).rejects.toThrow(/open dossier only/);
    const privileges = await owner<{ del: boolean; upd: boolean; itemDel: boolean; itemUpd: boolean }>(
      "select has_table_privilege('machvon_app', 'machvon.dossier', 'DELETE') as del, has_table_privilege('machvon_app', 'machvon.dossier', 'UPDATE') as upd, has_table_privilege('machvon_app', 'machvon.dossier_item', 'DELETE') as \"itemDel\", has_table_privilege('machvon_app', 'machvon.dossier_item', 'UPDATE') as \"itemUpd\"",
    );
    expect(privileges[0]).toEqual({ del: false, upd: true, itemDel: false, itemUpd: false });
    // A provisional dossier is settled once (a later command): the rule it takes is written, and then it is frozen too.
    const ruleId = await rule({ category_code: 'NEVER_USED', class_code: 'Y5', retention_years: 5 });
    await owner("update machvon.dossier set provisional_retention = false, retention_rule_id = $2, retention_class_code = 'Y5', retention_ends_on = date '2031-10-29', handover_due_on = date '2027-10-29' where id = $1", [bare, ruleId]);
    await expect(owner("update machvon.dossier set retention_class_code = 'PERMANENT' where id = $1", [bare])).rejects.toThrow(/not rewritten/);
  });

  it('AC-ST-DOC-017-2: UAT-AC421 refuses to propose a disposal of a provisional dossier, of one under a legal hold even when its retention is over, and of one not yet due; the proposer does not decide', async () => {
    const provisional = await closedDossier('DISP_NO_RULE', { withRule: false });
    const due = await closedDossier('DISP_DUE');
    const open = (await create(ARCHIVIST, { category_code: 'DISP_OPEN' })).json.resource_id as string;
    expect(await propose(ARCHIVIST, open, 1)).toMatchObject({ status: 422, json: { code: 'DOSSIER_NOT_CLOSED' } });
    app.now = new Date('2026-12-01T03:00:00Z');
    expect(await propose(ARCHIVIST, due.id, due.version)).toMatchObject({ status: 422, json: { code: 'RETENTION_NOT_EXPIRED' } });
    app.now = AFTER_RETENTION;
    // The retention is not provisional for ever: the dossier with no confirmed rule is kept (422 RETENTION_PROVISIONAL), whatever the days that went by.
    expect(await propose(ARCHIVIST, provisional.id, provisional.version)).toMatchObject({ status: 422, json: { code: 'RETENTION_PROVISIONAL' } });
    await placeHold();
    try {
      expect(await propose(ARCHIVIST, due.id, due.version)).toMatchObject({ status: 409, json: { code: 'LEGAL_HOLD_ACTIVE' } });
      expect((await show(ARCHIVIST, due.id)).json).toMatchObject({ disposal_blocker: 'LEGAL_HOLD_ACTIVE', actions: { proposeDisposal: true, decideDisposal: false } });
    } finally {
      await releaseHold();
    }
    expect(await storedDossier(due.id)).toMatchObject({ status: 'CLOSED', disposal_proposed_by: null });
    // Released and past the retention: proposed, with who, why and from which state kept; the version moves once.
    const proposed = await propose(ARCHIVE_CHIEF, due.id, due.version, '  Hết thời hạn bảo quản 5 năm  ');
    expect(proposed).toMatchObject({ status: 200, json: { status: 'DISPOSAL_PROPOSED', resource_version: due.version + 1, resource_id: due.id } });
    expect(await storedDossier(due.id)).toMatchObject({ status: 'DISPOSAL_PROPOSED', disposal_proposed_by: memberId(ARCHIVE_CHIEF), disposal_reason: 'Hết thời hạn bảo quản 5 năm', disposal_from_status: 'CLOSED', disposal_decided_by: null });
    expect((await events(due.id, 'doc.dossier_disposal_proposed.v1'))[0]?.payload).toMatchObject({ from_status: 'CLOSED', reason: 'Hết thời hạn bảo quản 5 năm', dossier_code: expect.any(String), actor_id: memberId(ARCHIVE_CHIEF) });
    expect(await count("select count(*) as n from machvon.audit_event where resource_id = $1 and action = 'dossier.disposal_proposed'", [due.id])).toBe(1);
    expect((await show(ARCHIVE_CHIEF, due.id)).json).toMatchObject({ status: 'DISPOSAL_PROPOSED', disposal: { proposed_by: memberId(ARCHIVE_CHIEF), reason: 'Hết thời hạn bảo quản 5 năm', from_status: 'CLOSED', decided_by: null }, actions: { proposeDisposal: false, decideDisposal: false, handover: false } });
    // A second proposal is a transition that does not exist.
    expect(await propose(ARCHIVIST, due.id, due.version + 1)).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
    // The proposer holds the right to decide as well, and is refused (403 SELF_APPROVAL_DENIED); someone else sees the action offered.
    expect(await decide(ARCHIVE_CHIEF, due.id, due.version + 1, { decision: 'REJECT' })).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
    expect((await show(COUNCIL, due.id)).json).toMatchObject({ actions: { decideDisposal: true } });
    expect(await storedDossier(due.id)).toMatchObject({ status: 'DISPOSAL_PROPOSED', disposal_decided_by: null });
  });

  it('decides the disposal: an approval needs the document of the council and no legal hold, marks the dossier DISPOSED for good and deletes nothing; a rejection sends it back to where it was', async () => {
    const approved = await closedDossier('DECIDE_OK');
    const rejected = await closedDossier('DECIDE_NO');
    app.now = AFTER_RETENTION;
    expect((await propose(ARCHIVIST, approved.id, approved.version)).status).toBe(200);
    expect((await propose(ARCHIVIST, rejected.id, rejected.version)).status).toBe(200);
    const version = approved.version + 1;
    // Without the document of the decision, with one that does not exist or is a draft, or with a body that is no decision: nothing changes.
    expect(await decide(COUNCIL, approved.id, version, { decision: 'APPROVE' })).toMatchObject({ status: 422, json: { code: 'DECISION_DOCUMENT_REQUIRED' } });
    expect(await decide(COUNCIL, approved.id, version, { decision: 'APPROVE', council_decision_document_id: randomUUID() })).toMatchObject({ status: 422, json: { code: 'DECISION_DOCUMENT_REQUIRED' } });
    expect(await decide(COUNCIL, approved.id, version, { decision: 'APPROVE', council_decision_document_id: await issued({ status: 'SUBMITTED' }) })).toMatchObject({ status: 422, json: { code: 'DECISION_DOCUMENT_REQUIRED' } });
    expect((await decide(COUNCIL, approved.id, version, { decision: 'MAYBE' })).status).toBe(422);
    expect(await decide(COUNCIL, approved.id, version, { decision: 'REJECT', comment: 'x'.repeat(1001) })).toMatchObject({ status: 422 });
    expect(await decide(COUNCIL, approved.id, version + 3, { decision: 'REJECT' })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    expect((await decide(DOSSIER_READER, approved.id, version, { decision: 'REJECT' })).status).toBe(403);
    expect(await decide(COUNCIL, randomUUID(), 1, { decision: 'REJECT' })).toMatchObject({ status: 404 });
    expect(await storedDossier(approved.id)).toMatchObject({ status: 'DISPOSAL_PROPOSED' });
    // A hold placed after the proposal stops the approval too.
    const decision = await issued();
    await placeHold();
    try {
      expect(await decide(COUNCIL, approved.id, version, { decision: 'APPROVE', council_decision_document_id: decision })).toMatchObject({ status: 409, json: { code: 'LEGAL_HOLD_ACTIVE' } });
    } finally {
      await releaseHold();
    }
    const items = await count('select count(*) as n from machvon.dossier_item where dossier_id = $1', [approved.id]);
    const done = await decide(COUNCIL, approved.id, version, { decision: 'APPROVE', council_decision_document_id: decision, comment: '  Hội đồng đồng ý hủy theo biên bản số 12  ' });
    expect(done).toMatchObject({ status: 200, json: { status: 'DISPOSED', resource_version: version + 1 } });
    expect(await storedDossier(approved.id)).toMatchObject({
      status: 'DISPOSED',
      disposal_proposed_by: memberId(ARCHIVIST),
      disposal_decided_by: memberId(COUNCIL),
      disposal_decision_document_id: decision,
      disposal_comment: 'Hội đồng đồng ý hủy theo biên bản số 12',
    });
    // Nothing is deleted: the items and the document are all still there; the event tells the archive process.
    expect(await count('select count(*) as n from machvon.dossier_item where dossier_id = $1', [approved.id])).toBe(items);
    expect(await count('select count(*) as n from machvon.document where id = $1', [approved.documentId])).toBe(1);
    expect((await events(approved.id, 'doc.dossier_disposed.v1'))[0]?.payload).toMatchObject({ decision: 'APPROVE', council_decision_document_id: decision, proposed_by: memberId(ARCHIVIST), to_status: 'DISPOSED' });
    expect((await show(COUNCIL, approved.id)).json).toMatchObject({ status: 'DISPOSED', disposal: { decided_by: memberId(COUNCIL), council_decision_document_id: decision }, actions: { proposeDisposal: false, decideDisposal: false } });
    // Final: nothing more is proposed or decided.
    expect(await propose(ARCHIVIST, approved.id, version + 1)).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
    expect(await decide(COUNCIL, approved.id, version + 1, { decision: 'REJECT' })).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
    await expect(owner("update machvon.dossier set title = 'CHANGED' where id = $1", [approved.id])).rejects.toThrow(/final/);

    // The other is rejected: the document of a decision does not go with a rejection, the dossier goes back to CLOSED with no proposal on it, and a new one may be made.
    expect(await decide(COUNCIL, rejected.id, version, { decision: 'REJECT', council_decision_document_id: decision })).toMatchObject({ status: 422, json: { detail: 'council_decision_document_id' } });
    const back = await decide(COUNCIL, rejected.id, version, { decision: 'REJECT', comment: 'Còn cần cho kiểm toán' });
    expect(back).toMatchObject({ status: 200, json: { status: 'CLOSED', resource_version: version + 1 } });
    expect(await storedDossier(rejected.id)).toMatchObject({ status: 'CLOSED', disposal_proposed_by: null, disposal_reason: null, disposal_from_status: null, disposal_decided_by: null });
    expect((await events(rejected.id, 'doc.dossier_disposal_rejected.v1'))[0]?.payload).toMatchObject({ decision: 'REJECT', comment: 'Còn cần cho kiểm toán', to_status: 'CLOSED', proposed_by: memberId(ARCHIVIST), proposed_reason: 'Hết thời hạn bảo quản, đề nghị xét hủy', proposed_at: expect.any(String) });
    expect(await owner<{ diff: Record<string, unknown> }>("select safe_diff as diff from machvon.audit_event where resource_id = $1 and action in ('dossier.disposal_proposed', 'dossier.disposal_rejected') order by occurred_at", [rejected.id])).toEqual([expect.objectContaining({ diff: expect.objectContaining({ reason: 'Hết thời hạn bảo quản, đề nghị xét hủy' }) }), expect.objectContaining({ diff: expect.objectContaining({ proposed_reason: 'Hết thời hạn bảo quản, đề nghị xét hủy' }) })]);
    expect(await count("select count(*) as n from machvon.audit_event where resource_id = $1 and action = 'dossier.disposal_rejected'", [rejected.id])).toBe(1);
    expect((await propose(ARCHIVIST, rejected.id, version + 1)).status).toBe(200);
  });

  it('hands a closed dossier over to the archive in one step, archives its filed outgoing documents with a line in their timeline, and then lets a disposal go back to ARCHIVED', async () => {
    const closedOne = await closedDossier('HANDOVER_CAT');
    const outgoingId = (await owner<{ id: string; version: string }>('select id, version::text from machvon.outgoing_document where document_id = $1', [closedOne.documentId]))[0];
    expect(outgoingId).toBeDefined();
    const before = await owner<{ status: string }>('select status from machvon.outgoing_document where document_id = $1', [closedOne.documentId]);
    expect(before[0]?.status).toBe('FILED');
    // What is wrong: an open dossier, a reference that is too short, a moment in the future or before the closing, a stale version, without the right or the reach, in another tenant.
    const open = (await create(ARCHIVIST, { category_code: 'HANDOVER_OPEN' })).json.resource_id as string;
    expect(await handover(ARCHIVIST, open, 1)).toMatchObject({ status: 422, json: { code: 'DOSSIER_NOT_CLOSED' } });
    expect([400, 422]).toContain((await handover(ARCHIVIST, closedOne.id, closedOne.version, { archive_ref: 'ab', handed_over_at: HANDOVER.handed_over_at })).status);
    expect(await handover(ARCHIVIST, closedOne.id, closedOne.version, { archive_ref: '   ', handed_over_at: HANDOVER.handed_over_at })).toMatchObject({ status: 422, json: { detail: 'archive_ref' } });
    expect(await handover(ARCHIVIST, closedOne.id, closedOne.version, { archive_ref: 'KLT-2026/0002', handed_over_at: '2026-10-29T03:00:01Z' })).toMatchObject({ status: 422, json: { detail: 'handed_over_at' } });
    expect(await handover(ARCHIVIST, closedOne.id, closedOne.version, { archive_ref: 'KLT-2026/0002', handed_over_at: '2026-10-28T03:00:00Z' })).toMatchObject({ status: 422, json: { detail: 'handed_over_at' } });
    expect([400, 422]).toContain((await handover(ARCHIVIST, closedOne.id, closedOne.version, { archive_ref: 'KLT-2026/0002', handed_over_at: 'not a date' })).status);
    expect(await handover(ARCHIVIST, closedOne.id, closedOne.version + 4)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    expect((await handover(DOSSIER_READER, closedOne.id, closedOne.version)).status).toBe(403);
    expect((await handover(ARCHIVIST_OUTSIDE, closedOne.id, closedOne.version)).status).toBe(404);
    expect((await handover(ARCHIVIST, closedOne.id, closedOne.version, HANDOVER, TENANT_B)).status).toBe(403);
    expect(await storedDossier(closedOne.id)).toMatchObject({ status: 'CLOSED', archive_ref: null });

    const done = await handover(ARCHIVIST, closedOne.id, closedOne.version, { archive_ref: '  KLT-2026/0001  ', handed_over_at: '2026-10-29T03:00:00Z' });
    // CLOSED to HANDED_OVER to ARCHIVED: two steps of the chain, so the version moves twice.
    expect(done).toMatchObject({ status: 200, json: { status: 'ARCHIVED', resource_version: closedOne.version + 2, archive_ref: 'KLT-2026/0001', documents_archived: 1, handed_over_at: '2026-10-29T03:00:00.000Z' } });
    expect(await storedDossier(closedOne.id)).toMatchObject({ status: 'ARCHIVED', version: String(closedOne.version + 2), archive_ref: 'KLT-2026/0001', handed_over_by: memberId(ARCHIVIST) });
    expect((await owner<{ status: string; version: string }>('select status, version::text from machvon.outgoing_document where document_id = $1', [closedOne.documentId]))[0]).toEqual({ status: 'ARCHIVED', version: String(Number(outgoingId?.version) + 1) });
    const timeline = await owner<{ kind: string; from_status: string; to_status: string; details: Record<string, unknown> }>("select kind, from_status, to_status, details from machvon.outgoing_document_event where outgoing_document_id = $1 and kind = 'ARCHIVED'", [outgoingId?.id]);
    expect(timeline).toEqual([{ kind: 'ARCHIVED', from_status: 'FILED', to_status: 'ARCHIVED', details: { dossier_id: closedOne.id, archive_ref: 'KLT-2026/0001' } }]);
    expect((await events(closedOne.id, 'doc.dossier_archived.v1'))[0]?.payload).toMatchObject({ archive_ref: 'KLT-2026/0001', documents_archived: 1 });
    expect(await count("select count(*) as n from machvon.audit_event where resource_id = $1 and action = 'dossier.archived'", [closedOne.id])).toBe(1);
    expect((await show(ARCHIVIST, closedOne.id)).json).toMatchObject({ status: 'ARCHIVED', archive_ref: 'KLT-2026/0001', handed_over_at: '2026-10-29T03:00:00.000Z', actions: { handover: false } });
    // Once archived, a handover is no longer possible (the state is not CLOSED); the guard also keeps what the handover wrote.
    expect(await handover(ARCHIVIST, closedOne.id, closedOne.version + 2)).toMatchObject({ status: 422, json: { code: 'DOSSIER_NOT_CLOSED' } });
    await expect(owner("update machvon.dossier set archive_ref = 'OTHER-REF' where id = $1", [closedOne.id])).rejects.toThrow(/handover of a dossier is not rewritten/);

    // An archived dossier is proposed for disposal like a closed one and, rejected, goes back to ARCHIVED.
    app.now = AFTER_RETENTION;
    const version = closedOne.version + 2;
    expect((await propose(ARCHIVIST, closedOne.id, version)).status).toBe(200);
    expect(await storedDossier(closedOne.id)).toMatchObject({ disposal_from_status: 'ARCHIVED' });
    expect(await decide(COUNCIL, closedOne.id, version + 1, { decision: 'REJECT' })).toMatchObject({ status: 200, json: { status: 'ARCHIVED' } });
    expect(await storedDossier(closedOne.id)).toMatchObject({ status: 'ARCHIVED', archive_ref: 'KLT-2026/0001', disposal_proposed_by: null });
  });

  it('hands over a dossier of incoming letters: the letters stay as they are (filed) and no outgoing document is archived', async () => {
    await rule({ category_code: 'HANDOVER_LETTERS', class_code: 'Y5', retention_years: 5, handover_months: 0 });
    const letter = await resolvedLetter();
    const id = (await create(ARCHIVIST, { category_code: 'HANDOVER_LETTERS' })).json.resource_id as string;
    expect((await file(ARCHIVIST, letter.id, 1, { dossier_id: id })).status).toBe(200);
    expect((await close(ARCHIVIST, id, 2)).status).toBe(200);
    const done = await handover(ARCHIVIST, id, 3, { archive_ref: 'KLT-2026/0009', handed_over_at: NOW.toISOString() });
    expect(done).toMatchObject({ status: 200, json: { status: 'ARCHIVED', documents_archived: 0, resource_version: 5 } });
    expect((await owner<{ status: string }>('select status from machvon.incoming_document where id = $1', [letter.id]))[0]?.status).toBe('FILED');
    expect(await storedDossier(id)).toMatchObject({ status: 'ARCHIVED', archive_ref: 'KLT-2026/0009' });
  });

  it('AC-ST-DOC-017-1: UAT-AC422 drafts, publishes and confirms the retention rules with three people, refuses an overlap, and lets each dossier keep the rule of the day it was closed', async () => {
    await clearRules().catch(() => undefined);
    const evidence = await issued();
    const oldRule = await draftRule(RULE_DRAFTER, { category_code: 'AC422_CAT', class_code: 'Y20', retention_years: 20, effective_from: '2025-01-01', effective_until: '2027-01-01', handover_months: 6, precedence: 50 });
    expect(oldRule).toMatchObject({ status: 200, json: { status: 'DRAFT', resource_version: 1 } });
    const oldId = oldRule.json.resource_id as string;
    expect(await storedRule(oldId)).toMatchObject({ status: 'DRAFT', confirmation_status: 'PENDING_CONFIRMATION', approved_by: null });
    // Before it is published it cannot be confirmed (409 RETENTION_STATE_INVALID); the drafter cannot publish it, with or without the right; someone with the right to publish does.
    expect(await confirmRule(RULE_LEGAL, oldId, 1, { legal_confirmation_ref: 'CXN-05', evidence_document_id: evidence })).toMatchObject({ status: 409, json: { code: 'RETENTION_STATE_INVALID' } });
    expect((await publishRule(RULE_DRAFTER, oldId, 1)).status).toBe(403);
    expect(await publishRule(RULE_APPROVER, oldId, 5)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    const publishedOld = await publishRule(RULE_APPROVER, oldId, 1);
    expect(publishedOld).toMatchObject({ status: 200, json: { status: 'PUBLISHED', resource_version: 2 } });
    expect(await publishRule(RULE_APPROVER, oldId, 2)).toMatchObject({ status: 409, json: { code: 'RETENTION_STATE_INVALID' } });
    expect(await storedRule(oldId)).toMatchObject({ status: 'PUBLISHED', approved_by: memberId(RULE_APPROVER), confirmation_status: 'PENDING_CONFIRMATION' });
    expect((await events(oldId, 'doc.retention_rule_published.v1'))[0]?.payload).toMatchObject({ category_code: 'AC422_CAT', class_code: 'Y20', effective_until: '2027-01-01' });
    // Not yet confirmed: a dossier closed under it is provisional.
    // The new rule that starts before the old one ends is an overlap (409 RETENTION_RANGE_OVERLAP); starting on the day the old one ends it is not.
    expect(await draftRule(RULE_DRAFTER, { category_code: 'AC422_CAT', class_code: 'Y70', retention_years: 70, effective_from: '2026-06-01' })).toMatchObject({ status: 409, json: { code: 'RETENTION_RANGE_OVERLAP' } });
    expect(await draftRule(RULE_DRAFTER, { category_code: 'AC422_CAT', class_code: 'Y70', retention_years: 70, effective_from: '2025-01-01' })).toMatchObject({ status: 409, json: { code: 'RETENTION_RANGE_OVERLAP' } });
    const newRule = await draftRule(RULE_ALL, { category_code: 'AC422_CAT', class_code: 'Y70', retention_years: 70, effective_from: '2027-01-01' });
    expect(newRule).toMatchObject({ status: 200, json: { status: 'DRAFT' } });
    const newId = newRule.json.resource_id as string;
    // Four eyes: the drafter holds the right to publish and is refused; to confirm, neither the drafter nor the publisher.
    expect(await publishRule(RULE_ALL, newId, 1)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
    expect((await publishRule(RULE_APPROVER, newId, 1)).status).toBe(200);
    expect(await confirmRule(RULE_ALL, newId, 2, { legal_confirmation_ref: 'CXN-05', evidence_document_id: evidence })).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
    expect((await confirmRule(RULE_APPROVER, newId, 2, { legal_confirmation_ref: 'CXN-05', evidence_document_id: evidence })).status).toBe(403);
    expect(await confirmRule(RULE_LEGAL, newId, 2, { legal_confirmation_ref: '   ', evidence_document_id: evidence })).toMatchObject({ status: 422, json: { code: 'CONFIRMATION_REF_REQUIRED' } });
    expect(await confirmRule(RULE_LEGAL, newId, 2, { legal_confirmation_ref: 'CXN-05', evidence_document_id: randomUUID() })).toMatchObject({ status: 422, json: { detail: 'evidence_document_id' } });
    expect(await confirmRule(RULE_LEGAL, newId, 2, { legal_confirmation_ref: 'CXN-05', evidence_document_id: evidence, note: 'n'.repeat(1001) })).toMatchObject({ status: 422 });
    expect(await confirmRule(RULE_LEGAL, newId, 9, { legal_confirmation_ref: 'CXN-05', evidence_document_id: evidence })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    expect(await storedRule(newId)).toMatchObject({ confirmation_status: 'PENDING_CONFIRMATION', legal_confirmed_by: null });
    for (const id of [oldId, newId]) {
      const confirmed = await confirmRule(RULE_LEGAL, id, 2, { legal_confirmation_ref: '  CXN-05  ', evidence_document_id: evidence, note: 'Đã đối chiếu với Thông tư' });
      expect(confirmed).toMatchObject({ status: 200, json: { status: 'CONFIRMED', resource_version: 3 } });
      expect(await storedRule(id)).toMatchObject({ confirmation_status: 'CONFIRMED', legal_confirmation_ref: 'CXN-05', legal_confirmed_by: memberId(RULE_LEGAL), legal_evidence_document_id: evidence });
      expect(await confirmRule(RULE_LEGAL, id, 3, { legal_confirmation_ref: 'CXN-05', evidence_document_id: evidence })).toMatchObject({ status: 409, json: { code: 'RETENTION_STATE_INVALID' } });
    }
    expect((await events(newId, 'doc.retention_rule_confirmed.v1'))[0]?.payload).toMatchObject({ legal_confirmation_ref: 'CXN-05', category_code: 'AC422_CAT' });
    expect(await count("select count(*) as n from machvon.audit_event where resource_id = any($1::uuid[]) and action like 'document_retention_rule.%'", [[oldId, newId]])).toBe(6);
    // DS-A is closed on the last day of the old rule, DS-B the day after: each takes the rule of its day, and DS-A keeps its rule when the new one is published.
    const fill = async (code: string): Promise<{ id: string; version: number }> => {
      const made = await create(ARCHIVIST, { dossier_code: code, category_code: 'AC422_CAT' });
      const id = made.json.resource_id as string;
      expect((await add(ARCHIVIST, id, 1, { document_id: await issued() })).status).toBe(200);
      return { id, version: 2 };
    };
    const a = await fill('DS-A-017');
    const b = await fill('DS-B-017');
    app.now = new Date('2026-12-31T03:00:00Z');
    expect(await close(ARCHIVIST, a.id, a.version)).toMatchObject({ status: 200, json: { retention_class_code: 'Y20', provisional_retention: false, retention_ends_on: '2046-12-31', retention_rule_id: oldId } });
    app.now = new Date('2027-01-02T03:00:00Z');
    expect(await close(ARCHIVIST, b.id, b.version)).toMatchObject({ status: 200, json: { retention_class_code: 'Y70', retention_rule_id: newId } });
    expect((await stored(a.id))?.retention_rule_id).toBe(oldId);
    // The list shows who drafted, published and confirmed each rule, with names.
    const listed = ((await app.call('GET', '/document-retention-rules?category_code=AC422_CAT', { member: RULE_DRAFTER })).json.items as Array<Record<string, unknown>>).find((item) => item.id === newId);
    expect(listed).toMatchObject({ status: 'PUBLISHED', confirmation_status: 'CONFIRMED', created_by: { id: memberId(RULE_ALL) }, approved_by: { id: memberId(RULE_APPROVER) }, legal_confirmed_by: { id: memberId(RULE_LEGAL) } });
  });

  it('refuses a rule that is not well made, a second one for the same day, and an overlap found at publication; keeps the authority over the rules to the whole tenant', async () => {
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ class_code: 'PERMANENT', retention_years: 10 }, 'retention_years'],
      [{ class_code: 'Y10', retention_years: 20 }, 'retention_years'],
      [{ retention_years: 0 }, 'retention_years'],
      [{ category_code: 'lower_case' }, 'category_code'],
      [{ legal_basis: '    ' }, 'legal_basis'],
      [{ effective_from: '2026-02-30' }, 'effective_from'],
      [{ effective_from: '2040-01-01', effective_until: '2040-01-01' }, 'effective_until'],
      [{ effective_from: '2040-01-01', effective_until: '2039-01-01' }, 'effective_until'],
      [{ effective_until: '2041-13-01' }, 'effective_until'],
      [{ handover_months: -1 }, 'handover_months'],
      [{ handover_months: 241 }, 'handover_months'],
      [{ precedence: 0 }, 'precedence'],
    ];
    for (const [body, field] of bad) {
      const reply = await draftRule(RULE_DRAFTER, body);
      expect([JSON.stringify(body), reply.status, reply.json.code === 'LEGAL_BASIS_REQUIRED' ? 'legal_basis' : reply.json.detail]).toEqual([JSON.stringify(body), 422, field]);
    }
    expect(await draftRule(RULE_DRAFTER, { legal_basis: '    ' })).toMatchObject({ json: { code: 'LEGAL_BASIS_REQUIRED' } });
    expect((await draftRule(RULE_DRAFTER, { rule_set: 'OTHER' })).status).toBe(422);
    // A permanent class takes no years; the years of a class may be left out.
    const permanent = await draftRule(RULE_DRAFTER, { category_code: 'WELL_MADE', class_code: 'PERMANENT', retention_years: undefined, effective_from: '2041-01-01' });
    expect(permanent.status).toBe(200);
    const implied = await draftRule(RULE_DRAFTER, { category_code: 'WELL_MADE', class_code: 'Y5', retention_years: undefined, effective_from: '2042-01-01', handover_months: undefined, precedence: undefined });
    expect(implied.status).toBe(200);
    expect(await owner<{ retention_years: number | null; handover_months: number; precedence: number }>('select retention_years, handover_months, precedence from machvon.doc_retention_rule where id = $1', [implied.json.resource_id])).toEqual([{ retention_years: 5, handover_months: 12, precedence: 100 }]);
    // The same start day for the same set and category is an overlap even between drafts.
    expect(await draftRule(RULE_DRAFTER, { category_code: 'WELL_MADE', class_code: 'Y5', retention_years: undefined, effective_from: '2042-01-01' })).toMatchObject({ status: 409, json: { code: 'RETENTION_RANGE_OVERLAP' } });
    // Two drafts of overlapping periods are both fine; the second cannot be published once the first is.
    const first = (await draftRule(RULE_DRAFTER, { category_code: 'RACE_CAT', effective_from: '2045-01-01', effective_until: '2046-01-01' })).json.resource_id as string;
    const second = (await draftRule(RULE_DRAFTER, { category_code: 'RACE_CAT', effective_from: '2045-06-01', effective_until: '2046-06-01' })).json.resource_id as string;
    expect((await publishRule(RULE_APPROVER, first, 1)).status).toBe(200);
    expect(await publishRule(RULE_APPROVER, second, 1)).toMatchObject({ status: 409, json: { code: 'RETENTION_RANGE_OVERLAP' } });
    expect(await storedRule(second)).toMatchObject({ status: 'DRAFT' });
    // A unit-level authority, no right, another tenant, an unknown rule: no draft, no publication, no confirmation.
    expect(await draftRule(RULE_UNIT, { category_code: 'UNIT_CAT' })).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
    expect((await draftRule(NOBODY, { category_code: 'UNIT_CAT' })).status).toBe(403);
    expect((await draftRule(RULE_DRAFTER, { category_code: 'UNIT_CAT' }, TENANT_B)).status).toBe(403);
    expect(await publishRule(RULE_UNIT, second, 1)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
    expect(await confirmRule(RULE_UNIT, first, 2, { legal_confirmation_ref: 'CXN-05', evidence_document_id: randomUUID() })).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
    expect(await publishRule(RULE_APPROVER, randomUUID(), 1)).toMatchObject({ status: 404 });
    expect(await confirmRule(RULE_LEGAL, randomUUID(), 1, { legal_confirmation_ref: 'CXN-05', evidence_document_id: randomUUID() })).toMatchObject({ status: 404 });
    expect(await count("select count(*) as n from machvon.doc_retention_rule where category_code = 'UNIT_CAT'")).toBe(0);
  });

  it('keeps the retention rules as they were written: the database refuses to rewrite a rule, to confirm it twice or by its drafter, to publish it without an approver, or to delete it; and keeps what a disposal wrote', async () => {
    const evidence = await issued();
    const drafted = (await draftRule(RULE_DRAFTER, { category_code: 'GUARD_RULE', effective_from: '2050-01-01' })).json.resource_id as string;
    // The data owner bypasses the guards of the rules; the application role does not, so the statements run as it.
    const sql = (statement: string, params: unknown[]): Promise<unknown> => app.harness.tenants.withTenant(contextFor(TENANT_A, memberId(ADMIN)), (tx) => tx.query(statement, params));
    await expect(sql('update machvon.doc_retention_rule set class_code = $2 where id = $1', [drafted, 'Y70'])).rejects.toThrow(/content of a retention rule never changes/);
    await expect(sql("update machvon.doc_retention_rule set status = 'PUBLISHED' where id = $1", [drafted])).rejects.toThrow(/names the approver/);
    await expect(sql("update machvon.doc_retention_rule set status = 'SUPERSEDED' where id = $1", [drafted])).rejects.toThrow(/cannot move from DRAFT to SUPERSEDED/);
    await expect(sql('delete from machvon.doc_retention_rule where id = $1', [drafted])).rejects.toThrow(/permission denied|never deleted/);
    expect((await publishRule(RULE_APPROVER, drafted, 1)).status).toBe(200);
    await expect(sql('update machvon.doc_retention_rule set approved_by = created_by where id = $1', [drafted])).rejects.toThrow(/approval of a retention rule is written once|doc_retention_rule_sod_chk/);
    await expect(sql("update machvon.doc_retention_rule set confirmation_status = 'CONFIRMED', legal_confirmation_ref = 'X-1' where id = $1", [drafted])).rejects.toThrow(/needs its reference, its evidence/);
    await expect(sql("update machvon.doc_retention_rule set confirmation_status = 'CONFIRMED', legal_confirmation_ref = 'X-1', legal_evidence_document_id = $2::uuid, legal_confirmed_by = created_by where id = $1", [drafted, evidence])).rejects.toThrow(/neither the drafter nor the publisher/);
    await expect(sql("update machvon.doc_retention_rule set confirmation_status = 'CONFIRMED', legal_confirmation_ref = 'X-1', legal_evidence_document_id = $2::uuid, legal_confirmed_by = approved_by where id = $1", [drafted, evidence])).rejects.toThrow(/neither the drafter nor the publisher/);
    await expect(sql("update machvon.doc_retention_rule set legal_confirmation_note = 'note' where id = $1", [drafted])).rejects.toThrow(/written once/);
    expect((await confirmRule(RULE_LEGAL, drafted, 2, { legal_confirmation_ref: 'CXN-05', evidence_document_id: evidence })).status).toBe(200);
    await expect(sql("update machvon.doc_retention_rule set confirmation_status = 'PENDING_CONFIRMATION' where id = $1", [drafted])).rejects.toThrow(/only be confirmed once|doc_retention_rule_confirmed_chk/);
    await expect(sql("update machvon.doc_retention_rule set legal_confirmation_ref = 'OTHER' where id = $1", [drafted])).rejects.toThrow(/written once/);
    const privileges = await owner<{ del: boolean; trunc: boolean }>("select has_table_privilege('machvon_app', 'machvon.doc_retention_rule', 'DELETE') as del, has_table_privilege('machvon_app', 'machvon.doc_retention_rule', 'TRUNCATE') as trunc");
    expect(privileges[0]).toEqual({ del: false, trunc: false });
    // The same for a dossier: it is not proposed while provisional, the decider is not the proposer, and an approval needs its time.
    const provisional = await closedDossier('GUARD_PROV', { withRule: false });
    await expect(owner("update machvon.dossier set status = 'DISPOSAL_PROPOSED', disposal_proposed_by = $2::uuid, disposal_proposed_at = now(), disposal_reason = 'Một lý do đủ dài', disposal_from_status = 'CLOSED' where id = $1", [provisional.id, memberId(ARCHIVIST)])).rejects.toThrow(/provisional dossier is not proposed/);
    const ruled = await closedDossier('GUARD_DISP');
    await owner("update machvon.dossier set status = 'DISPOSAL_PROPOSED', disposal_proposed_by = $2::uuid, disposal_proposed_at = now(), disposal_reason = 'Một lý do đủ dài', disposal_from_status = 'CLOSED' where id = $1", [ruled.id, memberId(ARCHIVIST)]);
    await expect(owner("update machvon.dossier set status = 'DISPOSED', disposal_decided_by = disposal_proposed_by, disposal_decided_at = now() where id = $1", [ruled.id])).rejects.toThrow(/dossier_disposal_sod_chk/);
    await expect(owner("update machvon.dossier set status = 'DISPOSED' where id = $1", [ruled.id])).rejects.toThrow(/dossier_disposal_decision_chk/);
    await expect(owner("update machvon.dossier set status = 'ARCHIVED' where id = $1", [ruled.id])).rejects.toThrow(/does not go from DISPOSAL_PROPOSED to ARCHIVED|dossier_handover_chk/);
    await expect(owner("update machvon.dossier set disposal_reason = 'short' where id = $1", [ruled.id])).rejects.toThrow(/dossier_disposal_reason_chk/);
    await expect(owner("update machvon.dossier set status = 'HANDED_OVER' where id = $1", [provisional.id])).rejects.toThrow(/dossier_handover_chk/);
  });

  it('reminds the archivists of a handover that falls due 30, 7 and 1 days ahead, once for each stage, to the people who may hand the dossier over, and leaves a handed-over dossier alone (doc.handover-due)', async () => {
    await rule({ category_code: 'REMIND_CAT', class_code: 'Y5', retention_years: 5, handover_months: 2 });
    const reminded = await closedDossier('REMIND_CAT', { withRule: false });
    const handed = await closedDossier('REMIND_HANDED', { withRule: true });
    expect((await handover(ARCHIVIST, handed.id, handed.version, { archive_ref: 'KLT-2026/0010', handed_over_at: NOW.toISOString() })).status).toBe(200);
    expect((await stored(reminded.id))?.handover_due_on).toBe('2026-12-29');
    // The job looks at the whole tenant: the dossiers the other tests closed are reminded too, and are left out of what this one checks.
    const audit = new AuditWriter(app.harness.tenants);
    const mine = new Set([reminded.id, handed.id]);
    const run = async (at: string) => (await app.harness.tenants.withTenant(contextFor(TENANT_A, memberId(ADMIN)), (tx) => remindHandoverDue(tx, TENANT_A, new Date(at), { audit }))).filter((sent) => mine.has(sent.dossierId));
    const tell = async () => (await events(reminded.id, 'doc.handover_due.v1')).map((event) => event.payload.stage);
    // 31 days ahead: nothing yet. 30 days ahead: the first stage, once, however often the job runs.
    expect(await run('2026-11-28T01:00:00Z')).toEqual([]);
    expect(await run('2026-11-29T01:00:00Z')).toEqual([{ dossierId: reminded.id, daysLeft: 30, stage: 30 }]);
    expect(await run('2026-11-29T02:00:00Z')).toEqual([]);
    expect(await run('2026-12-10T02:00:00Z')).toEqual([]);
    expect(await tell()).toEqual([30]);
    const first = (await events(reminded.id, 'doc.handover_due.v1'))[0]?.payload as { notification: { recipients: string[]; resource: { type: string; id: string }; deepLink: string }; days_left: number; handover_due_on: string };
    expect(first).toMatchObject({ days_left: 30, handover_due_on: '2026-12-29', notification: { resource: { type: 'doc.dossier', id: reminded.id }, deepLink: `/doc/doc-17?id=${reminded.id}` } });
    // Those who may hand over in the unit are told: not a reader, not a person whose reach is another unit.
    expect(first.notification.recipients).toEqual(expect.arrayContaining([memberId(ARCHIVIST), memberId(ARCHIVE_CHIEF)]));
    expect(first.notification.recipients).not.toEqual(expect.arrayContaining([memberId(DOSSIER_READER)]));
    expect(first.notification.recipients).not.toEqual(expect.arrayContaining([memberId(ARCHIVIST_OUTSIDE)]));
    expect(await run('2026-12-22T01:00:00Z')).toEqual([{ dossierId: reminded.id, daysLeft: 7, stage: 7 }]);
    expect(await run('2026-12-28T01:00:00Z')).toEqual([{ dossierId: reminded.id, daysLeft: 1, stage: 1 }]);
    expect(await run('2026-12-29T01:00:00Z')).toEqual([]);
    expect(await run('2027-02-01T01:00:00Z')).toEqual([]);
    expect(await tell()).toEqual([30, 7, 1]);
    expect(await count("select count(*) as n from machvon.audit_event where resource_id = $1 and action = 'dossier.handover_due'", [reminded.id])).toBe(3);
    // The reminders did not touch what a person reads or changes: the version stays, so the screen's command still goes through.
    expect(await stored(reminded.id)).toMatchObject({ version: String(reminded.version), status: 'CLOSED' });
    expect((await owner<{ handover_reminded_days: number }>('select handover_reminded_days from machvon.dossier where id = $1', [reminded.id]))[0]?.handover_reminded_days).toBe(1);
    // The handed-over dossier is never reminded, and one first seen the day before the due day gets the last stage only.
    expect(await events(handed.id, 'doc.handover_due.v1')).toHaveLength(0);
    const late = await closedDossier('REMIND_LATE', { withRule: false });
    mine.add(late.id);
    await owner("update machvon.dossier set handover_due_on = date '2026-11-02' where id = $1", [late.id]);
    expect(await run('2026-11-01T01:00:00Z')).toEqual([{ dossierId: late.id, daysLeft: 1, stage: 1 }]);
    expect(await run('2026-11-02T01:00:00Z')).toEqual([]);
    await expect(owner("update machvon.dossier set handover_reminded_days = 14 where id = $1", [late.id])).rejects.toThrow(/dossier_handover_reminder_chk/);
  });

  it('shows the hold indicator and what stops a disposal in the list as in the detail', async () => {
    const closedOne = await closedDossier('LIST_HOLD');
    app.now = AFTER_RETENTION;
    await placeHold();
    try {
      const listed = ((await list(ARCHIVIST, '?limit=200')).json.items as Array<{ id: string; legal_hold_active: boolean; disposal_blocker: string | null }>).find((item) => item.id === closedOne.id);
      expect(listed).toMatchObject({ legal_hold_active: true, disposal_blocker: 'LEGAL_HOLD_ACTIVE' });
    } finally {
      await releaseHold();
    }
    expect(((await list(ARCHIVIST, '?limit=200')).json.items as Array<{ id: string; legal_hold_active: boolean; disposal_blocker: string | null }>).find((item) => item.id === closedOne.id)).toMatchObject({ legal_hold_active: false, disposal_blocker: null });
    expect((await show(ARCHIVIST, closedOne.id)).json).toMatchObject({ legal_hold_active: false, disposal_blocker: null });
  });

  it('does not dispose of a dossier while a legal hold names a document filed in it, at the proposal and at the approval, and shows the hold in the list', async () => {
    const proposedFirst = await closedDossier('DOC_HOLD_A');
    const proposedLater = await closedDossier('DOC_HOLD_B');
    app.now = AFTER_RETENTION;
    const holdOn = async (documentId: string): Promise<string> => {
      const id = randomUUID();
      await owner(
        `insert into machvon.legal_hold (tenant_id, id, resource_scope, authority_reference, reason, effective_at, hold_kind, status, placed_by, version)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::jsonb, 'QĐ-417/TTCP', 'Tạm giữ một văn bản', now() - interval '1 day', 'INSPECTION', 'Active', $3::uuid, 1)`,
        [id, JSON.stringify({ kind: 'RESOURCE', ids: [documentId] }), memberId(ADMIN)],
      );
      return id;
    };
    const release = (id: string): Promise<unknown> =>
      owner("update machvon.legal_hold set status = 'Released', released_at = now(), released_by = $1::uuid, release_reason = 'released for the test' where id = $2::uuid", [memberId(INCOMING_CLERK), id]);
    // A hold on a document of the first dossier stops the proposal, and the list and the detail say so.
    const first = await holdOn(proposedFirst.documentId);
    expect(await propose(ARCHIVIST, proposedFirst.id, proposedFirst.version)).toMatchObject({ status: 409, json: { code: 'LEGAL_HOLD_ACTIVE' } });
    const listed = ((await list(ARCHIVIST, '?limit=200')).json.items as Array<{ id: string; legal_hold_active: boolean; disposal_blocker: string | null }>).filter((item) => [proposedFirst.id, proposedLater.id].includes(item.id));
    expect(listed.find((item) => item.id === proposedFirst.id)).toMatchObject({ legal_hold_active: true, disposal_blocker: 'LEGAL_HOLD_ACTIVE' });
    expect(listed.find((item) => item.id === proposedLater.id)).toMatchObject({ legal_hold_active: false, disposal_blocker: null });
    expect((await show(ARCHIVIST, proposedFirst.id)).json).toMatchObject({ legal_hold_active: true, disposal_blocker: 'LEGAL_HOLD_ACTIVE' });
    await release(first);
    expect(await propose(ARCHIVIST, proposedFirst.id, proposedFirst.version)).toMatchObject({ status: 200 });
    // A hold on a document of the second dossier, placed after the proposal, stops the approval; released, the approval goes through.
    expect((await propose(ARCHIVIST, proposedLater.id, proposedLater.version)).status).toBe(200);
    const later = await holdOn(proposedLater.documentId);
    const decision = await issued();
    expect(await decide(COUNCIL, proposedLater.id, proposedLater.version + 1, { decision: 'APPROVE', council_decision_document_id: decision })).toMatchObject({ status: 409, json: { code: 'LEGAL_HOLD_ACTIVE' } });
    expect((await storedDossier(proposedLater.id))?.status).toBe('DISPOSAL_PROPOSED');
    await release(later);
    expect(await decide(COUNCIL, proposedLater.id, proposedLater.version + 1, { decision: 'APPROVE', council_decision_document_id: decision })).toMatchObject({ status: 200, json: { status: 'DISPOSED' } });
  });

  it('registers the reminder of a handover with the notification service', async () => {
    const rows = await owner<{ status: string; owning_module: string; allowed_purposes: string[] }>("select status, owning_module, allowed_purposes from machvon.notification_event_type where event_type = 'doc.handover_due.v1'");
    expect(rows).toEqual([{ status: 'Active', owning_module: 'DOC', allowed_purposes: ['REMINDER', 'OPERATIONAL'] }]);
  });
});
