import { createHash, randomUUID } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { markOverdueIncoming } from '../../src/modules/doc/incoming-jobs';
import { eicarBytes } from '../../src/modules/files/mock-scan';
import { DocumentStore, loadAccessIn } from '@machvon/db';
import { PermissionResourceAccess } from '../../src/notifications/resource-access-port';
import { ACTOR, ADMIN, DocApp, INCOMING_CHIEF, INCOMING_CLERK, INCOMING_OUTSIDE, INCOMING_STAFF, INCOMING_STAFF_TWO, NOBODY, REFERENCER, TENANT_A, TENANT_B, memberId, unitId } from './doc-app';
import { contextFor } from '../../../../packages/db/test/support/authz-fixtures';

jest.setTimeout(240_000);

const app = new DocApp();
const tenantOf = (member: number, tenantId: string = TENANT_A) => ({ tenantId, membershipId: memberId(member), scopeVersion: 1 });
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const owner = <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => app.harness.owner<T>(TENANT_A, [[sql, params]]);
const count = (sql: string, params: unknown[] = []): Promise<number> => app.count(sql, params);

let registerId = '';
let staffUser = '';
let staffTwoUser = '';
let counter = 0;

/** A PDF of one page whose bytes are its own (the title is in the metadata), so that two letters never share a hash. */
async function pdf(label: string = `letter-${(counter += 1)}-${randomUUID()}`): Promise<Buffer> {
  const document = await PDFDocument.create();
  document.setTitle(label);
  document.addPage([595, 842]);
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

/** Puts a file through the shared upload pipeline, as the screen does before it receives a letter. */
async function upload(bytes: Uint8Array, options: { member?: number; tenantId?: string; type?: string } = {}): Promise<{ key: string; sha: string; scan: string }> {
  const stored = await app.uploads.upload(tenantOf(options.member ?? INCOMING_CLERK, options.tenantId), { purpose: 'document', declaredType: options.type ?? 'application/pdf', bytes });
  return { key: stored.key, sha: sha256(bytes), scan: stored.scanStatus };
}

const receiveBody = (file: { key: string; sha: string }, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  title: 'Công văn về kế hoạch vốn năm 2026',
  doc_type_code: 'CV',
  channel: 'UPLOAD',
  file_object_key: file.key,
  file_sha256: file.sha,
  original_symbol: `${(counter += 1)}/BTC-ĐTPT`,
  original_issued_on: '2026-10-20',
  sender_name: 'Bộ Tài chính',
  ...overrides,
});

/** A letter received: the file is uploaded and the letter taken in. */
async function received(overrides: Record<string, unknown> = {}, member: number = INCOMING_CLERK) {
  const file = await upload(await pdf());
  const reply = await app.call('POST', '/incoming-documents', { member, body: receiveBody(file, overrides) });
  return { reply, id: reply.json.resource_id as string, file };
}

const register = (member: number, id: string, version: number, body: Record<string, unknown> = {}, key?: string) => app.call('POST', `/incoming-documents/${id}/registration`, { member, ifMatch: `"${version}"`, ...(key === undefined ? {} : { key }), body });
const assign = (member: number, id: string, version: number, body: Record<string, unknown>) => app.call('POST', `/incoming-documents/${id}/assignment`, { member, ifMatch: `"${version}"`, body });
const start = (member: number, id: string, version: number) => app.call('POST', `/incoming-documents/${id}/processing`, { member, ifMatch: `"${version}"`, body: {} });
const resolve = (member: number, id: string, version: number, body: Record<string, unknown> = { resolution_summary: 'Đã trả lời bằng văn bản.' }) => app.call('POST', `/incoming-documents/${id}/resolution`, { member, ifMatch: `"${version}"`, body });
const reject = (member: number, id: string, version: number, body: Record<string, unknown> = { rejection_reason: 'Gửi nhầm đơn vị, không thuộc thẩm quyền.' }) => app.call('POST', `/incoming-documents/${id}/rejection`, { member, ifMatch: `"${version}"`, body });
const show = (member: number, id: string, tenantId?: string) => app.call('GET', `/incoming-documents/${id}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });
const list = (member: number, query = '') => app.call('GET', `/incoming-documents${query}`, { member });
const events = (id: string, type: string) => owner<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at', [id, type]);
const stored = async (id: string) =>
  (await owner<{ status: string; version: string; register_id: string | null; is_overdue: boolean; late_days: number | null; due_on: string | null }>('select status, version::text, register_id, is_overdue, late_days, due_on::text from machvon.incoming_document where id = $1', [id]))[0];
const lastNumber = async (): Promise<number> => Number((await owner<{ last_number: number }>('select last_number from machvon.document_number_register where id = $1', [registerId]))[0]?.last_number);

/** A letter that is registered, assigned to the staff of unit 2 and not yet worked. */
async function assigned(due: string = '2026-10-27', overrides: Record<string, unknown> = {}) {
  const made = await received();
  expect((await register(INCOMING_CLERK, made.id, 1)).status).toBe(200);
  const given = await assign(INCOMING_CHIEF, made.id, 2, { assigned_unit_id: unitId(2), assignee_user_id: staffUser, due_on: due, leader_directive: 'Trả lời trước hạn.', ...overrides });
  expect(given.status).toBe(200);
  return { ...made, version: 3 };
}

describe('incoming documents over HTTP (ST-DOC-011)', () => {
  beforeAll(async () => {
    await app.start();
    expect((await app.call('POST', '/document-types', { member: ADMIN, body: { code: 'CV', name: 'Công văn', symbol_kind: 'OFFICIAL_LETTER', symbol_pattern: '{number}/{type}-{agency}', register_code: 'REG-CV', legal_basis: 'ND 30/2020', effective_from: '2026-01-01' } })).status).toBe(200);
    const opened = await app.call('POST', '/document-number-registers', { member: ADMIN, body: { register_code: 'REG-DEN-2026', name: 'Sổ đến 2026', direction: 'INCOMING', organization_unit_id: unitId(2), year: 2026, scope_doc_types: ['CV'] } });
    expect(opened.status).toBe(200);
    registerId = opened.json.resource_id as string;
    await owner('update machvon.document_number_register set last_number = 9 where id = $1', [registerId]);
    const users = await owner<{ membership_id: string; user_account_id: string }>('select membership_id, user_account_id from machvon.tenant_user_directory where membership_id = any($1::uuid[])', [[memberId(INCOMING_STAFF), memberId(INCOMING_STAFF_TWO)]]);
    staffUser = users.find((row) => row.membership_id === memberId(INCOMING_STAFF))?.user_account_id ?? '';
    staffTwoUser = users.find((row) => row.membership_id === memberId(INCOMING_STAFF_TWO))?.user_account_id ?? '';
    expect(staffUser).not.toBe('');
  }, 480_000);
  afterAll(() => app.stop(), 60_000);

  it('AC-ST-DOC-011-1: UAT-AC419 receives a letter, refuses the same letter again unless a reason is given, numbers it 10 in the register, and takes it by assignment, processing and resolution, with one event per step', async () => {
    const first = await received({ original_symbol: '1234/BTC-ĐTPT' });
    expect(first.reply).toMatchObject({ status: 200, json: { status: 'RECEIVED', resource_version: 1 } });
    // The same sender, symbol and day again, without a reason.
    const file = await upload(await pdf());
    const again = await app.call('POST', '/incoming-documents', { member: INCOMING_CLERK, body: receiveBody(file, { original_symbol: '1234/btc-đtpt', sender_name: 'BỘ TÀI CHÍNH' }) });
    expect(again).toMatchObject({ status: 409, json: { code: 'INCOMING_DUPLICATE_SUSPECTED', duplicate_of_id: first.id } });
    expect(await count('select count(*) as n from machvon.incoming_document where sender_name ilike $1', ['%tài chính%'])).toBeGreaterThanOrEqual(1);
    // With a reason it is taken in again, pointing at the first.
    const taken = await app.call('POST', '/incoming-documents', { member: INCOMING_CLERK, body: receiveBody(file, { original_symbol: '1234/BTC-ĐTPT', duplicate_override_reason: 'Bản gốc gửi lại kèm phụ lục mới.' }) });
    expect(taken.status).toBe(200);
    expect((await owner<{ duplicate_of_id: string }>('select duplicate_of_id from machvon.incoming_document where id = $1', [taken.json.resource_id as string]))[0]?.duplicate_of_id).toBe(first.id);
    // A reason for a letter that is not a duplicate is a mistake.
    expect((await received({ duplicate_override_reason: 'Không có thư nào trùng cả.' })).reply.status).toBe(422);

    // Registered: number 10 in the register of unit 2, and a second registration is refused.
    expect(await lastNumber()).toBe(9);
    const registered = await register(INCOMING_CLERK, first.id, 1);
    expect(registered).toMatchObject({ status: 200, json: { status: 'REGISTERED', number: 10, symbol: '10/REG-DEN-2026', register_id: registerId, resource_version: 2 } });
    expect(await lastNumber()).toBe(10);
    expect(await register(INCOMING_CLERK, first.id, 2)).toMatchObject({ status: 409, json: { code: 'DOCUMENT_STATE_INVALID' } });
    expect(await lastNumber()).toBe(10);

    // Assigned by the chief to the staff of unit 2 with a deadline.
    const given = await assign(INCOMING_CHIEF, first.id, 2, { assigned_unit_id: unitId(2), assignee_user_id: staffUser, due_on: '2026-10-27', leader_directive: 'Chuẩn bị ý kiến.' });
    expect(given).toMatchObject({ status: 200, json: { status: 'ASSIGNED', resource_version: 3 } });
    // Somebody it is not assigned to cannot work it; the handler can.
    expect(await start(INCOMING_STAFF_TWO, first.id, 3)).toMatchObject({ status: 403, json: { code: 'NOT_ASSIGNEE' } });
    expect(await start(INCOMING_STAFF, first.id, 3)).toMatchObject({ status: 200, json: { status: 'PROCESSING', resource_version: 4 } });
    expect(await resolve(INCOMING_STAFF_TWO, first.id, 4)).toMatchObject({ status: 403, json: { code: 'NOT_ASSIGNEE' } });
    expect(await resolve(INCOMING_STAFF, first.id, 4)).toMatchObject({ status: 200, json: { status: 'RESOLVED', resource_version: 5 } });
    expect(await stored(first.id)).toMatchObject({ status: 'RESOLVED', register_id: registerId });
    // No step can be taken again or out of order.
    expect(await start(INCOMING_STAFF, first.id, 5)).toMatchObject({ status: 409, json: { code: 'DOCUMENT_STATE_INVALID' } });
    expect(await assign(INCOMING_CHIEF, first.id, 5, { assigned_unit_id: unitId(2) })).toMatchObject({ status: 409, json: { code: 'DOCUMENT_STATE_INVALID' } });
    expect(await reject(INCOMING_CLERK, first.id, 5)).toMatchObject({ status: 409, json: { code: 'DOCUMENT_STATE_INVALID' } });
    // One event and one audit row for each step, with the facts and none of the words of the letter.
    for (const [type, action] of [
      ['doc.incoming_received.v1', 'incoming_document.received'],
      ['doc.incoming_registered.v1', 'incoming_document.registered'],
      ['doc.incoming_assigned.v1', 'incoming_document.assigned'],
      ['doc.incoming_processing.v1', 'incoming_document.processing'],
      ['doc.incoming_resolved.v1', 'incoming_document.resolved'],
    ] as const) {
      expect([type, (await events(first.id, type)).length]).toEqual([type, 1]);
      expect([action, await count('select count(*) as n from machvon.audit_event where resource_id = $1 and action = $2', [first.id, action])]).toEqual([action, 1]);
    }
    expect((await events(first.id, 'doc.incoming_registered.v1'))[0]?.payload).toMatchObject({ number: 10, symbol: '10/REG-DEN-2026', incoming_document_id: first.id, tenant_id: TENANT_A });
    expect(JSON.stringify((await events(first.id, 'doc.incoming_resolved.v1'))[0]?.payload)).not.toContain('Đã trả lời');
  });

  it('AC-ST-DOC-011-2: UAT-AC420 marks a letter overdue once after its deadline, tells NOT how late it is, and lets the handler resolve it late with the lateness recorded', async () => {
    const letter = await assigned('2026-10-27');
    expect((await start(INCOMING_STAFF, letter.id, 3)).status).toBe(200);
    const run = async (at: Date) => app.harness.tenants.withTenant(contextFor(TENANT_A, memberId(ADMIN)), (tx) => markOverdueIncoming(tx, TENANT_A, at));
    // On the deadline itself it is not late; the morning after (08:00 in Vietnam) it is one working day late.
    expect(await run(new Date('2026-10-27T10:00:00Z'))).toEqual([]);
    expect((await stored(letter.id))?.is_overdue).toBe(false);
    const marked = await run(new Date('2026-10-28T01:00:00Z'));
    expect(marked.map((entry) => entry.id)).toEqual([letter.id]);
    expect(await stored(letter.id)).toMatchObject({ is_overdue: true, status: 'PROCESSING' });
    const [event] = await events(letter.id, 'doc.incoming_overdue.v1');
    expect(event?.payload).toMatchObject({ incoming_document_id: letter.id, due_on: '2026-10-27', late_days: 1, assignee_user_id: staffUser, tenant_id: TENANT_A });
    // The job runs every hour and announces it once.
    expect(await run(new Date('2026-10-28T02:00:00Z'))).toEqual([]);
    expect((await events(letter.id, 'doc.incoming_overdue.v1')).length).toBe(1);
    // The ledger shows how late, on the screen's own clock.
    app.now = new Date('2026-10-28T08:00:00Z');
    const shown = await show(INCOMING_STAFF, letter.id);
    expect(shown.json).toMatchObject({ is_overdue: true, overdue_days: 1, due_on: '2026-10-27', status: 'PROCESSING' });
    expect((await list(INCOMING_STAFF, '?overdue=true')).json.items).toEqual([expect.objectContaining({ id: letter.id, overdue_days: 1 })]);
    // Resolved at 15:00: it succeeds and says how late.
    const done = await resolve(INCOMING_STAFF, letter.id, Number((await stored(letter.id))?.version));
    expect(done).toMatchObject({ status: 200, json: { status: 'RESOLVED', late_days: 1 } });
    expect(await stored(letter.id)).toMatchObject({ status: 'RESOLVED', late_days: 1, is_overdue: true });
    expect((await show(INCOMING_STAFF, letter.id)).json).toMatchObject({ late_days: 1, overdue_days: null });
    app.now = new Date('2026-10-23T03:00:00Z');
  });

  it('counts the lateness in working days of the calendar of the tenant, and not on a weekend or a holiday', async () => {
    // 2026-10-30 is a Friday: on the Saturday and Sunday the letter is not yet late, on the Monday it is one day late.
    const letter = await assigned('2026-10-30');
    const run = async (at: Date) => app.harness.tenants.withTenant(contextFor(TENANT_A, memberId(ADMIN)), (tx) => markOverdueIncoming(tx, TENANT_A, at));
    expect(await run(new Date('2026-10-31T03:00:00Z'))).toEqual([]);
    expect(await run(new Date('2026-11-01T03:00:00Z'))).toEqual([]);
    expect((await run(new Date('2026-11-02T03:00:00Z'))).map((entry) => entry.id)).toEqual([letter.id]);
    expect((await events(letter.id, 'doc.incoming_overdue.v1'))[0]?.payload).toMatchObject({ late_days: 1 });
    // A letter with no deadline is never overdue, and a reassignment starts the clock again.
    const fresh = await assigned('2026-12-31');
    expect((await assign(INCOMING_CHIEF, letter.id, Number((await stored(letter.id))?.version), { assigned_unit_id: unitId(2), assignee_user_id: staffUser, due_on: '2026-11-20' })).status).toBe(200);
    expect(await stored(letter.id)).toMatchObject({ is_overdue: false });
    expect(await stored(fresh.id)).toMatchObject({ is_overdue: false });
  });

  it('AC-ST-DOC-011-3: UAT-AC429 takes in no letter that declares a level of state secret, creates nothing, and audits the refusal as DENIED', async () => {
    const before = await count('select count(*) as n from machvon.incoming_document');
    const documents = await count("select count(*) as n from machvon.document where doc_kind = 'INCOMING'");
    for (const overrides of [{ title: 'CÔNG VĂN TỐI MẬT số 5' }, { original_symbol: '12/TUYỆT MẬT' }, { sender_name: 'Văn phòng (MẬT)' }]) {
      const file = await upload(await pdf());
      const reply = await app.call('POST', '/incoming-documents', { member: INCOMING_CLERK, body: receiveBody(file, overrides) });
      expect([reply.status, reply.json.code]).toEqual([422, 'STATE_SECRET_NOT_SUPPORTED']);
    }
    expect(await count('select count(*) as n from machvon.incoming_document')).toBe(before);
    expect(await count("select count(*) as n from machvon.document where doc_kind = 'INCOMING'")).toBe(documents);
    expect(await count("select count(*) as n from machvon.audit_event where action = 'incoming_document.receive' and outcome = 'DENIED'")).toBeGreaterThanOrEqual(3);
    // A word that is not a marking is a letter like any other.
    expect((await received({ title: 'Quy chế bảo mật thông tin và mật độ xây dựng' })).reply.status).toBe(200);
  });

  it('judges the file: a clean PDF of this tenant whose hash is the one said, and the shape of the request', async () => {
    const good = await upload(await pdf());
    const body = (overrides: Record<string, unknown> = {}) => receiveBody(good, overrides);
    expect(await app.call('POST', '/incoming-documents', { member: INCOMING_CLERK, body: body({ file_sha256: 'b'.repeat(64) }) })).toMatchObject({ status: 422, json: { detail: 'file_sha256' } });
    // A file that is not a PDF, one that is infected, one that was not scanned, one of another tenant and one that is not there.
    const png = await upload(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`png-${randomUUID()}`)]), { type: 'image/png' });
    expect(await app.call('POST', '/incoming-documents', { member: INCOMING_CLERK, body: receiveBody(png) })).toMatchObject({ status: 422, json: { code: 'UPLOAD_NOT_PDF' } });
    const infected = await upload(Buffer.concat([await pdf(), Buffer.from(eicarBytes())]));
    expect(infected.scan).toBe('INFECTED');
    expect(await app.call('POST', '/incoming-documents', { member: INCOMING_CLERK, body: receiveBody(infected) })).toMatchObject({ status: 422, json: { code: 'FILE_NOT_CLEAN' } });
    const pendingBytes = await pdf();
    const pendingKey = `tenants/${TENANT_A}/document/${randomUUID()}`;
    await app.objects.put(tenantOf(INCOMING_CLERK), pendingKey, pendingBytes, { contentType: 'application/pdf' });
    expect(await app.call('POST', '/incoming-documents', { member: INCOMING_CLERK, body: receiveBody({ key: pendingKey, sha: sha256(pendingBytes) }) })).toMatchObject({ status: 409, json: { code: 'SCAN_PENDING' } });
    const foreign = await upload(await pdf(), { tenantId: TENANT_B });
    expect((await app.call('POST', '/incoming-documents', { member: INCOMING_CLERK, body: receiveBody(foreign) })).status).toBe(404);
    expect((await app.call('POST', '/incoming-documents', { member: INCOMING_CLERK, body: receiveBody({ key: `tenants/${TENANT_A}/document/${randomUUID()}`, sha: good.sha }) })).status).toBe(404);
    // The type of document must exist; the shape is the allowlist of the contract.
    expect(await app.call('POST', '/incoming-documents', { member: INCOMING_CLERK, body: body({ doc_type_code: 'NOPE' }) })).toMatchObject({ status: 422, json: { detail: 'doc_type_code' } });
    for (const bad of [{ channel: 'FAX' }, { title: 'ab' }, { urgency: 'NOW' }, { original_issued_on: '2026-13-40' }, { sender_name: 'x' }, { file_sha256: 'xyz' }])
      expect([JSON.stringify(bad), (await app.call('POST', '/incoming-documents', { member: INCOMING_CLERK, body: body(bad) })).status >= 400]).toEqual([JSON.stringify(bad), true]);
    expect((await app.call('POST', '/incoming-documents', { member: INCOMING_CLERK, body: { ...body(), surprise: 1 } })).status).toBe(400);
    expect((await app.call('POST', '/incoming-documents', { member: NOBODY, body: body() })).status).toBe(403);
    expect(await count('select count(*) as n from machvon.incoming_document i join machvon.document d on d.id = i.document_id where d.title = $1 and i.original_symbol is null', ['x'])).toBe(0);
    // The letter is stored as an INCOMING document with a received scan that is clean.
    const ok = await app.call('POST', '/incoming-documents', { member: INCOMING_CLERK, body: body({ original_symbol: undefined, original_issued_on: undefined }) });
    expect(ok.status).toBe(200);
    const row = (
      await owner<{ doc_kind: string; stage: string; scan_status: string; page_count: number; checksum: string }>(
        'select d.doc_kind, v.stage, v.scan_status, v.page_count, trim(v.checksum) as checksum from machvon.incoming_document i join machvon.document d on d.id = i.document_id join machvon.document_version v on v.id = d.current_version_id where i.id = $1',
        [ok.json.resource_id as string],
      )
    )[0];
    expect(row).toMatchObject({ doc_kind: 'INCOMING', stage: 'RECEIVED_SCAN', scan_status: 'CLEAN', page_count: 1, checksum: good.sha });
  });

  it('puts the letter in force as a record when it is registered with its original symbol and date, and only then', async () => {
    const usability = (documentId: string) => app.call('GET', `/documents/${documentId}/usability`, { member: REFERENCER });
    const letter = await received();
    const documentId = letter.reply.json.document_id as string;
    // Received, not yet registered: the document is pending and cannot be relied on.
    expect(await usability(documentId)).toMatchObject({ status: 422, json: { code: 'DOCUMENT_NOT_EFFECTIVE', reason: 'NOT_EFFECTIVE', effect_status: 'PENDING' } });
    const registered = await register(INCOMING_CLERK, letter.id, 1);
    expect(registered.status).toBe(200);
    const [row] = await owner<{ effect_status: string; document_number: number; number_year: number; symbol: string; issued_on: string }>('select effect_status, document_number, number_year, symbol, issued_on::text from machvon.document where id = $1', [documentId]);
    expect(row).toMatchObject({ effect_status: 'EFFECTIVE', document_number: registered.json.number, number_year: 2026, symbol: registered.json.symbol });
    expect(await usability(documentId)).toMatchObject({ status: 200, json: { effect_status: 'EFFECTIVE', symbol: registered.json.symbol } });
    // A letter without its original date or symbol is registered as before and its document stays pending.
    for (const missing of ['original_symbol', 'original_issued_on']) {
      const bare = await received({ [missing]: undefined });
      expect((await register(INCOMING_CLERK, bare.id, 1)).status).toBe(200);
      expect(await usability(bare.reply.json.document_id as string)).toMatchObject({ status: 422, json: { code: 'DOCUMENT_NOT_EFFECTIVE', reason: 'NOT_EFFECTIVE', effect_status: 'PENDING' } });
    }
  });

  it('refuses a registration with no register, a register that is closed, one of another direction or outside the scope, and gives the number back when it fails', async () => {
    const letter = await received();
    // The unit-1 clerk may register letters, but there is no register of unit 1 to register into, and the register of unit 2 is not in their scope.
    expect(await register(INCOMING_OUTSIDE, letter.id, 1)).toMatchObject({ status: 409, json: { code: 'REGISTER_NOT_OPEN' } });
    expect((await register(INCOMING_OUTSIDE, letter.id, 1, { register_id: registerId })).status).toBe(404);
    expect(await register(INCOMING_CLERK, letter.id, 1, { register_id: randomUUID() })).toMatchObject({ status: 404 });
    const outgoing = await app.call('POST', '/document-number-registers', { member: ADMIN, body: { register_code: 'REG-DI-X', name: 'Sổ đi', direction: 'OUTGOING', organization_unit_id: unitId(2), year: 2026, scope_doc_types: ['CV'] } });
    expect(await register(INCOMING_CLERK, letter.id, 1, { register_id: outgoing.json.resource_id })).toMatchObject({ status: 422, json: { detail: 'register_id' } });
    const before = await lastNumber();
    expect(await register(INCOMING_CLERK, letter.id, 7)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    expect(await lastNumber()).toBe(before);
    expect((await stored(letter.id))?.status).toBe('RECEIVED');
    expect((await register(INCOMING_CLERK, letter.id, 1)).status).toBe(200);
    expect(await lastNumber()).toBe(before + 1);
    // The same registration again with its key is answered with what it did.
    const key = randomUUID();
    const other = await received();
    const once = await register(INCOMING_CLERK, other.id, 1, {}, key);
    expect(await register(INCOMING_CLERK, other.id, 1, {}, key)).toMatchObject({ status: 200, json: { number: once.json.number } });
    expect(await lastNumber()).toBe(before + 2);
  });

  it('assigns within the scope of whoever assigns, with a deadline that has not passed, and keeps the history of a reassignment', async () => {
    const letter = await received();
    expect((await register(INCOMING_CLERK, letter.id, 1)).status).toBe(200);
    // The unit must exist and be in the scope of the chief; the handler must be able to work letters there; the deadline cannot be past.
    expect(await assign(INCOMING_CHIEF, letter.id, 2, { assigned_unit_id: randomUUID() })).toMatchObject({ status: 422, json: { detail: 'assigned_unit_id' } });
    expect(await assign(INCOMING_CHIEF, letter.id, 2, { assigned_unit_id: unitId(1) })).toMatchObject({ status: 422, json: { code: 'ASSIGNEE_OUT_OF_SCOPE' } });
    expect(await assign(INCOMING_CHIEF, letter.id, 2, { assigned_unit_id: unitId(2), assignee_user_id: randomUUID() })).toMatchObject({ status: 422, json: { code: 'ASSIGNEE_OUT_OF_SCOPE' } });
    expect(await assign(INCOMING_CHIEF, letter.id, 2, { assigned_unit_id: unitId(2), assignee_user_id: staffUser, due_on: '2026-10-22' })).toMatchObject({ status: 422, json: { code: 'DUE_DATE_IN_PAST' } });
    expect(await assign(INCOMING_STAFF, letter.id, 2, { assigned_unit_id: unitId(2) })).toMatchObject({ status: 403 });
    expect(await assign(INCOMING_CHIEF, letter.id, 1, { assigned_unit_id: unitId(2) })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    expect((await stored(letter.id))?.status).toBe('REGISTERED');
    expect(await assign(INCOMING_CHIEF, letter.id, 2, { assigned_unit_id: unitId(2), assignee_user_id: staffUser, due_on: '2026-10-23', leader_directive: 'Lần một' })).toMatchObject({ status: 200 });
    // Reassigned from ASSIGNED, and again from PROCESSING (it goes back to ASSIGNED).
    expect(await assign(INCOMING_CHIEF, letter.id, 3, { assigned_unit_id: unitId(2), assignee_user_id: staffTwoUser, due_on: '2026-10-30', leader_directive: 'Lần hai' })).toMatchObject({ status: 200, json: { status: 'ASSIGNED', resource_version: 4 } });
    expect(await start(INCOMING_STAFF, letter.id, 4)).toMatchObject({ status: 403, json: { code: 'NOT_ASSIGNEE' } });
    expect(await start(INCOMING_STAFF_TWO, letter.id, 4)).toMatchObject({ status: 200 });
    expect(await assign(INCOMING_CHIEF, letter.id, 5, { assigned_unit_id: unitId(2), assignee_user_id: staffUser })).toMatchObject({ status: 200, json: { status: 'ASSIGNED' } });
    const shown = (await show(INCOMING_CHIEF, letter.id)).json;
    expect(shown).toMatchObject({ status: 'ASSIGNED', assignee: { user_id: staffUser }, due_on: null });
    expect((shown.assignments as Array<{ leader_directive: string | null; assignee: { user_id: string } }>).map((entry) => [entry.leader_directive, entry.assignee.user_id])).toEqual([
      ['Lần một', staffUser],
      ['Lần hai', staffTwoUser],
      [null, staffUser],
    ]);
    expect((await events(letter.id, 'doc.incoming_assigned.v1')).length).toBe(3);
    // The history is never changed or erased by the runtime role.
    expect(await count('select count(*) as n from machvon.incoming_assignment where incoming_document_id = $1', [letter.id])).toBe(3);
    expect((await owner<{ can: boolean }>("select has_table_privilege('machvon_app', 'machvon.incoming_assignment', 'DELETE') as can"))[0]?.can).toBe(false);
  });

  it('rejects a letter that was only received, with a reason, optionally as a copy of another; and a rejected letter changes no more', async () => {
    const keep = await received();
    const copy = await received();
    expect(await reject(INCOMING_CLERK, copy.id, 1, { rejection_reason: 'ngắn' })).toMatchObject({ status: 422 });
    expect(await reject(INCOMING_CLERK, copy.id, 1, { rejection_reason: 'Bản sao của thư đã nhận trước đó.', duplicate_of_id: copy.id })).toMatchObject({ status: 422, json: { detail: 'duplicate_of_id' } });
    expect(await reject(INCOMING_CLERK, copy.id, 1, { rejection_reason: 'Bản sao của thư đã nhận trước đó.', duplicate_of_id: randomUUID() })).toMatchObject({ status: 422 });
    expect(await reject(INCOMING_CLERK, copy.id, 1, { rejection_reason: 'Bản sao của thư đã nhận trước đó.', duplicate_of_id: keep.id })).toMatchObject({ status: 200, json: { status: 'REJECTED' } });
    expect((await owner<{ duplicate_of_id: string; rejection_reason: string }>('select duplicate_of_id, rejection_reason from machvon.incoming_document where id = $1', [copy.id]))[0]).toMatchObject({ duplicate_of_id: keep.id });
    for (const attempt of [() => register(INCOMING_CLERK, copy.id, 2), () => reject(INCOMING_CLERK, copy.id, 2), () => assign(INCOMING_CHIEF, copy.id, 2, { assigned_unit_id: unitId(2) })]) expect(await attempt()).toMatchObject({ status: 409, json: { code: 'DOCUMENT_STATE_INVALID' } });
    await expect(owner("update machvon.incoming_document set status = 'RECEIVED' where id = $1", [copy.id])).rejects.toThrow(/DOCUMENT_STATE_INVALID/);
    // A rejected letter does not count as a duplicate: the letter may be taken in again.
    const same = (await owner<{ original_symbol: string; sender_name: string }>('select original_symbol, sender_name from machvon.incoming_document where id = $1', [copy.id]))[0];
    expect((await received({ original_symbol: same?.original_symbol, sender_name: same?.sender_name })).reply.status).toBe(200);
    // And a letter that has a register is no longer refused (it is registered).
    expect((await register(INCOMING_CLERK, keep.id, 1)).status).toBe(200);
    expect(await reject(INCOMING_CLERK, keep.id, 2)).toMatchObject({ status: 409, json: { code: 'DOCUMENT_STATE_INVALID' } });
  });

  it('answers a resolution with an issued answer, and refuses one that is not an issued letter of ours', async () => {
    const letter = await assigned('2026-12-31');
    expect((await start(INCOMING_STAFF, letter.id, 3)).status).toBe(200);
    expect(await resolve(INCOMING_STAFF, letter.id, 4, { resolution_summary: 'ok' })).toMatchObject({ status: 422 });
    expect(await resolve(INCOMING_STAFF, letter.id, 4, { resolution_summary: 'Đã trả lời.', response_outgoing_id: randomUUID() })).toMatchObject({ status: 422, json: { detail: 'response_outgoing_id' } });
    expect(await resolve(INCOMING_STAFF, letter.id, 3)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    expect((await stored(letter.id))?.status).toBe('PROCESSING');
    const done = await resolve(INCOMING_STAFF, letter.id, 4, { resolution_summary: 'Đã trả lời bằng công văn.' });
    expect(done).toMatchObject({ status: 200, json: { status: 'RESOLVED', late_days: 0 } });
    await expect(owner("update machvon.incoming_document set resolution_summary = 'đổi' where id = $1", [letter.id])).rejects.toThrow(/DOCUMENT_STATE_INVALID|kept as it is/);
  });

  it('links as the answer only an issued letter of ours that the caller may read', async () => {
    const seed = async (unit: number, status: string): Promise<string> => {
      const id = randomUUID();
      await app.harness.tenants.withTenant(contextFor(TENANT_A, memberId(ADMIN)), async (tx) => {
        const document = await new DocumentStore().insertDocument(tx, { docKind: 'OUTGOING', docTypeCode: 'CV', title: 'Trả lời', classification: 'INTERNAL', createdBy: ACTOR, issuerUnitId: unitId(unit) });
        await tx.query(
          `insert into machvon.outgoing_document (tenant_id, id, document_id, layout_profile_id, status, drafting_unit_id, drafter_user_id, signer_user_id, created_by, updated_by)
           values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::uuid, $6::uuid, $6::uuid, $6::uuid)`,
          [id, document.id, app.layoutProfileId, 'SUBMITTED', unitId(unit), memberId(ADMIN)],
        );
        if (status !== 'SUBMITTED') {
          // Issued means numbered and sealed: the number is taken from the register of the incoming letters only as a row to point at.
          const allocation = randomUUID();
          await tx.query(
            `insert into machvon.document_number_allocation (tenant_id, id, register_id, number, symbol, document_id, issued_on, allocated_by)
             values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::int, $4, $5::uuid, date '2026-10-23', $6::uuid)`,
            [allocation, registerId, 9000 + (counter += 1), 'KQ-' + counter, document.id, memberId(ADMIN)],
          );
          await tx.query("update machvon.outgoing_document set status = $3, allocation_id = $2::uuid, issued_at = now(), sealed_at = now() where id = $1::uuid", [id, allocation, status]);
        }
      });
      return id;
    };
    const mine = await seed(2, 'ISSUED');
    const foreign = await seed(1, 'ISSUED');
    const draft = await seed(2, 'SUBMITTED');
    const letter = await assigned('2026-12-31');
    expect((await start(INCOMING_STAFF, letter.id, 3)).status).toBe(200);
    // A letter of another unit is as good as none, whatever its state; a draft of ours is not an answer.
    expect(await resolve(INCOMING_STAFF, letter.id, 4, { resolution_summary: 'Đã trả lời.', response_outgoing_id: foreign })).toMatchObject({ status: 422, json: { detail: 'response_outgoing_id' } });
    expect(await resolve(INCOMING_STAFF, letter.id, 4, { resolution_summary: 'Đã trả lời.', response_outgoing_id: draft })).toMatchObject({ status: 422, json: { code: 'RESPONSE_DOCUMENT_NOT_ISSUED' } });
    expect(await resolve(INCOMING_STAFF, letter.id, 4, { resolution_summary: 'Đã trả lời.', response_outgoing_id: mine })).toMatchObject({ status: 200, json: { status: 'RESOLVED' } });
    expect((await show(INCOMING_STAFF, letter.id)).json.response_outgoing_id).toBe(mine);
    // An answer that the archivist filed meanwhile is still an issued answer.
    const filedAnswer = await seed(2, 'FILED');
    const second = await assigned('2026-12-31');
    expect((await start(INCOMING_STAFF, second.id, 3)).status).toBe(200);
    expect(await resolve(INCOMING_STAFF, second.id, 4, { resolution_summary: 'Đã trả lời.', response_outgoing_id: filedAnswer })).toMatchObject({ status: 200, json: { status: 'RESOLVED' } });
    // So is an answer that was corrected afterwards (ST-DOC-015): it is still in force.
    const correctedAnswer = await seed(2, 'CORRECTED');
    const third = await assigned('2026-12-31');
    expect((await start(INCOMING_STAFF, third.id, 3)).status).toBe(200);
    expect(await resolve(INCOMING_STAFF, third.id, 4, { resolution_summary: 'Đã trả lời.', response_outgoing_id: correctedAnswer })).toMatchObject({ status: 200, json: { status: 'RESOLVED' } });
  });

  it('advertises the work on a letter only to a handler whose membership may work it, and sends the reminder to the memberships of the handler', async () => {
    const letter = await assigned('2026-10-27');
    expect(((await show(INCOMING_STAFF, letter.id)).json.actions as Record<string, boolean>).startProcessing).toBe(true);
    // The same user through a membership that may read but not work letters sees no button.
    const readerMembership = randomUUID();
    await owner('insert into machvon.membership (tenant_id, id, user_id, organization_id, status, valid_from) select tenant_id, $2::uuid, user_id, organization_id, \'Ended\', valid_from from machvon.membership where id = $1', [memberId(INCOMING_STAFF), readerMembership]);
    expect(((await show(INCOMING_CHIEF, letter.id)).json.actions as Record<string, boolean>).startProcessing).toBe(false);
    // The reminder carries who is to be told and where to go.
    const run = async (at: Date) => app.harness.tenants.withTenant(contextFor(TENANT_A, memberId(ADMIN)), (tx) => markOverdueIncoming(tx, TENANT_A, at));
    expect((await run(new Date('2026-10-28T01:00:00Z'))).map((entry) => entry.id)).toContain(letter.id);
    const [event] = await events(letter.id, 'doc.incoming_overdue.v1');
    const notification = event?.payload.notification as { recipients: string[]; deepLink: string; resource: { type: string; ownerUnitId: string } };
    expect(notification.recipients).toEqual(expect.arrayContaining([memberId(INCOMING_STAFF)]));
    expect(notification.deepLink).toBe('/doc/doc-13?id=' + letter.id);
    expect(notification.resource).toMatchObject({ type: 'doc.incoming', ownerUnitId: unitId(2) });
    // The consumer of the notifications lets the handler read the letter it is told about.
    const access = await app.harness.tenants.withTenant(contextFor(TENANT_A, memberId(INCOMING_STAFF)), (tx) => loadAccessIn(tx, memberId(INCOMING_STAFF)));
    expect(new PermissionResourceAccess().canRead(access, notification.resource as never, new Date('2026-10-28T01:00:00Z'))).toBe(true);
    expect((await owner<{ n: string }>("select count(*)::text as n from machvon.notification_event_type where event_type = 'doc.incoming_overdue.v1'"))[0]?.n).toBe('1');
  });

  it('sends the reminder of a letter given to a unit with no one named to the memberships that may work letters there', async () => {
    const made = await received();
    expect((await register(INCOMING_CLERK, made.id, 1)).status).toBe(200);
    expect(await assign(INCOMING_CHIEF, made.id, 2, { assigned_unit_id: unitId(2), due_on: '2026-10-27' })).toMatchObject({ status: 200 });
    const run = async (at: Date) => app.harness.tenants.withTenant(contextFor(TENANT_A, memberId(ADMIN)), (tx) => markOverdueIncoming(tx, TENANT_A, at));
    expect((await run(new Date('2026-10-28T01:00:00Z'))).map((entry) => entry.id)).toContain(made.id);
    const [event] = await events(made.id, 'doc.incoming_overdue.v1');
    const recipients = (event?.payload.notification as { recipients?: string[] }).recipients ?? [];
    // The staff of unit 2 hold the right there; the clerk and the chief do not, and nobody of unit 1 does.
    expect(recipients).toEqual(expect.arrayContaining([memberId(INCOMING_STAFF), memberId(INCOMING_STAFF_TWO)]));
    expect(recipients).not.toContain(memberId(INCOMING_CLERK));
    expect(recipients).not.toContain(memberId(INCOMING_CHIEF));
    expect(recipients).not.toContain(memberId(INCOMING_OUTSIDE));
  });

  it('records a late resolution as overdue even when the hourly sweep did not come first, and judges the reasons after they are trimmed', async () => {
    const letter = await assigned('2026-10-27');
    expect((await start(INCOMING_STAFF, letter.id, 3)).status).toBe(200);
    app.now = new Date('2026-10-28T08:00:00Z');
    try {
      expect(await resolve(INCOMING_STAFF, letter.id, 4, { resolution_summary: '     ' })).toMatchObject({ status: 422 });
      expect(await resolve(INCOMING_STAFF, letter.id, 4)).toMatchObject({ status: 200, json: { late_days: 1 } });
    } finally {
      app.now = new Date('2026-10-23T03:00:00Z');
    }
    expect(await stored(letter.id)).toMatchObject({ status: 'RESOLVED', late_days: 1, is_overdue: true });
    // Late when it was resolved, and no longer overdue: the filter and the overview count the letters that are late now.
    expect(((await list(INCOMING_CHIEF, '?overdue=true&limit=200')).json.items as Array<{ id: string }>).map((item) => item.id)).not.toContain(letter.id);
    expect((await show(INCOMING_CHIEF, letter.id)).json).toMatchObject({ status: 'RESOLVED', late_days: 1, is_overdue: false, overdue_days: null });
    // Ten spaces are not a reason, for a copy or for a refusal.
    const original = await received({ original_symbol: 'TRIM-1/BTC', original_issued_on: '2026-09-25', sender_name: 'Bộ Nội vụ' });
    expect(original.reply.status).toBe(200);
    const blank = await app.call('POST', '/incoming-documents', { member: INCOMING_CLERK, body: receiveBody(await upload(await pdf()), { original_symbol: 'TRIM-1/BTC', original_issued_on: '2026-09-25', sender_name: 'Bộ Nội vụ', duplicate_override_reason: '          ' }) });
    expect(blank).toMatchObject({ status: 422, json: { detail: 'duplicate_override_reason' } });
    const fresh = await received();
    expect(await reject(INCOMING_CLERK, fresh.id, 1, { rejection_reason: '          ' })).toMatchObject({ status: 422 });
    // A letter is not a copy of itself, however its id is spelled.
    expect(await reject(INCOMING_CLERK, fresh.id.toUpperCase(), 1, { rejection_reason: 'Không phải bản sao của chính nó.', duplicate_of_id: fresh.id.toUpperCase() })).toMatchObject({ status: 422, json: { detail: 'duplicate_of_id' } });
  });

  it('shows the letters in the scope of the caller newest first, narrowed by state, unit, overdue and year, with what each caller may do, and nothing of another tenant', async () => {
    const mine = await assigned('2026-12-31');
    const ledger = await list(INCOMING_CLERK, '?limit=200');
    expect(ledger.status).toBe(200);
    const ids = (ledger.json.items as Array<{ id: string }>).map((item) => item.id);
    expect(ids).toContain(mine.id);
    // Newest first.
    const times = (ledger.json.items as Array<{ received_at: string }>).map((item) => item.received_at);
    expect([...times].sort().reverse()).toEqual(times);
    const one = (await show(INCOMING_CLERK, mine.id)).json;
    expect(Object.keys(one).sort()).toEqual(
      [
        'actions',
        'assigned_unit',
        'assignee',
        'assignments',
        'channel',
        'classification',
        'document_id',
        'doc_type_code',
        'due_on',
        'duplicate_of_id',
        'duplicate_override_reason',
        'file_sha256',
        'id',
        'is_overdue',
        'late_days',
        'leader_directive',
        'number',
        'original_issued_on',
        'original_symbol',
        'overdue_days',
        'overdue_since',
        'received_at',
        'register',
        'rejection_reason',
        'resolution_summary',
        'resolved_at',
        'response_outgoing_id',
        'sender_name',
        'status',
        'symbol',
        'title',
        'updated_at',
        'urgency',
        'version',
      ].sort(),
    );
    // What each caller may do now, as buttons.
    expect((await show(INCOMING_CHIEF, mine.id)).json).toMatchObject({ actions: { register: false, assign: true, startProcessing: false, resolve: false, reject: false } });
    expect((await show(INCOMING_STAFF, mine.id)).json).toMatchObject({ actions: { assign: false, startProcessing: true, resolve: false } });
    expect((await show(INCOMING_STAFF_TWO, mine.id)).json).toMatchObject({ actions: { startProcessing: false } });
    const fresh = await received();
    expect((await show(INCOMING_CLERK, fresh.id)).json).toMatchObject({ status: 'RECEIVED', actions: { register: true, reject: true, assign: false } });
    // Filters and pages.
    expect(((await list(INCOMING_CLERK, '?status=ASSIGNED&limit=200')).json.items as Array<{ status: string }>).every((item) => item.status === 'ASSIGNED')).toBe(true);
    expect(((await list(INCOMING_CLERK, `?assigned_unit_id=${unitId(2)}&limit=200`)).json.items as Array<{ id: string }>).map((item) => item.id)).toContain(mine.id);
    expect(((await list(INCOMING_CLERK, '?year=2026&limit=200')).json.items as unknown[]).length).toBeGreaterThan(0);
    expect(((await list(INCOMING_CLERK, '?year=2025')).json.items as unknown[]).length).toBe(0);
    const firstPage = await list(INCOMING_CLERK, '?limit=2');
    expect((firstPage.json.items as unknown[]).length).toBe(2);
    const secondPage = await list(INCOMING_CLERK, `?limit=2&cursor=${encodeURIComponent(firstPage.json.next_cursor as string)}`);
    expect((secondPage.json.items as Array<{ id: string }>).map((item) => item.id)).not.toContain((firstPage.json.items as Array<{ id: string }>)[0]?.id);
    for (const bad of ['status=NOPE', 'assigned_unit_id=x', 'overdue=maybe', 'year=26', 'limit=0', 'cursor=bad']) expect([bad, (await list(INCOMING_CLERK, `?${bad}`)).status]).toEqual([bad, 422]);
    // Outside the scope the letter does not exist; nor does a letter of another tenant; the staff see their own letters; nobody with no right sees anything.
    expect((await show(INCOMING_OUTSIDE, mine.id)).status).toBe(404);
    expect([403, 404]).toContain((await show(ADMIN, mine.id, TENANT_B)).status);
    expect(((await list(INCOMING_STAFF, '?limit=200')).json.items as Array<{ id: string }>).map((item) => item.id)).toContain(mine.id);
    expect((await list(NOBODY)).status).toBe(403);
    expect(((await list(INCOMING_OUTSIDE, '?limit=200')).json.items as Array<{ id: string }>).map((item) => item.id)).not.toContain(mine.id);
    expect((await show(INCOMING_CLERK, randomUUID())).status).toBe(404);
  });

  it('lets a letter given to a unit with no one named be worked only by whoever holds the right in that unit, and not by someone who merely reaches it through the register', async () => {
    const letter = await received();
    expect((await register(INCOMING_CLERK, letter.id, 1)).status).toBe(200);
    // Given to unit 1 (above the register's unit 2): the staff of unit 2 see the letter through the register, and hold no right in unit 1.
    // (Nobody in this fixture may assign above unit 2, so the row is set as the data owner would.)
    await owner("update machvon.incoming_document set status = 'ASSIGNED', assigned_unit_id = $2, assigned_by = updated_by, due_on = '2026-10-30', version = version + 1 where id = $1", [letter.id, unitId(1)]);
    expect(((await show(INCOMING_STAFF, letter.id)).json.actions as Record<string, boolean>).startProcessing).toBe(false);
    expect(await start(INCOMING_STAFF, letter.id, 3)).toMatchObject({ status: 403, json: { code: 'NOT_ASSIGNEE' } });
    expect((await stored(letter.id))?.status).toBe('ASSIGNED');
    // Given to unit 2, the staff who hold the right there may take it.
    expect(await assign(INCOMING_CHIEF, letter.id, 3, { assigned_unit_id: unitId(2), due_on: '2026-10-30' })).toMatchObject({ status: 200 });
    expect(((await show(INCOMING_STAFF, letter.id)).json.actions as Record<string, boolean>).startProcessing).toBe(true);
    expect(await start(INCOMING_STAFF, letter.id, 4)).toMatchObject({ status: 200, json: { status: 'PROCESSING' } });
    expect(await resolve(INCOMING_STAFF_TWO, letter.id, 5)).toMatchObject({ status: 200, json: { status: 'RESOLVED' } });
  });

  it('lets the manager of the unit a letter was given to reassign it, though the register is in another unit', async () => {
    const letter = await received();
    expect((await register(INCOMING_CLERK, letter.id, 1)).status).toBe(200);
    await owner("update machvon.incoming_document set status = 'ASSIGNED', assigned_unit_id = $2, assigned_by = updated_by, due_on = '2026-10-30', version = version + 1 where id = $1", [letter.id, unitId(1)]);
    // The chief of unit 2 (the register's unit) and the manager of unit 1 (where it was given) may both assign; the staff of unit 2 may not.
    expect(((await show(INCOMING_CHIEF, letter.id)).json.actions as Record<string, boolean>).assign).toBe(true);
    expect(((await show(INCOMING_OUTSIDE, letter.id)).json.actions as Record<string, boolean>).assign).toBe(true);
    expect(((await show(INCOMING_STAFF, letter.id)).json.actions as Record<string, boolean>).assign).toBe(false);
    expect(await assign(INCOMING_OUTSIDE, letter.id, 3, { assigned_unit_id: unitId(1), due_on: '2026-10-31' })).toMatchObject({ status: 200, json: { status: 'ASSIGNED' } });
  });

  it('refuses a suspected copy wherever the other letter is, and names it only to someone who may read it', async () => {
    const original = await received({ original_symbol: 'HIDDEN-9/BXD', original_issued_on: '2026-09-20', sender_name: 'Bộ Xây dựng' });
    expect((await register(INCOMING_CLERK, original.id, 1)).status).toBe(200);
    // The clerk of unit 1 cannot read a letter registered in unit 2: the refusal does not say which letter it is.
    expect((await show(INCOMING_OUTSIDE, original.id)).status).toBe(404);
    const file = await upload(await pdf(), { member: INCOMING_OUTSIDE });
    const refused = await app.call('POST', '/incoming-documents', { member: INCOMING_OUTSIDE, body: receiveBody(file, { original_symbol: 'HIDDEN-9/BXD', original_issued_on: '2026-09-20', sender_name: 'Bộ Xây dựng' }) });
    expect(refused).toMatchObject({ status: 409, json: { code: 'INCOMING_DUPLICATE_SUSPECTED' } });
    expect(JSON.stringify(refused.json)).not.toContain(original.id);
    // Someone who may read it is told, as before.
    const named = await app.call('POST', '/incoming-documents', { member: INCOMING_CLERK, body: receiveBody(await upload(await pdf()), { original_symbol: 'HIDDEN-9/BXD', original_issued_on: '2026-09-20', sender_name: 'Bộ Xây dựng' }) });
    expect(named).toMatchObject({ status: 409, json: { duplicate_of_id: original.id } });
    // Taken in again with a reason, the clerk of unit 1 cannot read the link to a letter of unit 2; the clerk of unit 2 can.
    const again = await app.call('POST', '/incoming-documents', { member: INCOMING_OUTSIDE, body: receiveBody(await upload(await pdf(), { member: INCOMING_OUTSIDE }), { original_symbol: 'HIDDEN-9/BXD', original_issued_on: '2026-09-20', sender_name: 'Bộ Xây dựng', duplicate_override_reason: 'Bản gửi lại từ đơn vị khác.' }) });
    expect(again.status).toBe(200);
    const shown = (await show(INCOMING_OUTSIDE, again.json.resource_id as string)).json;
    expect(shown.duplicate_of_id).toBeNull();
    expect(JSON.stringify((await list(INCOMING_OUTSIDE)).json)).not.toContain(original.id);
    expect((await owner<{ duplicate_of_id: string }>('select duplicate_of_id from machvon.incoming_document where id = $1', [again.json.resource_id]))[0]?.duplicate_of_id).toBe(original.id);
    expect((await show(INCOMING_CLERK, again.json.resource_id as string)).json.duplicate_of_id).toBe(original.id);
  });

  it('refuses a malformed unit in the filter of the ledger', async () => {
    for (const bad of ['-'.repeat(36), 'x'.repeat(36), 'not-a-uuid']) expect([bad, (await list(INCOMING_CLERK, '?assigned_unit_id=' + bad)).status]).toEqual([bad, 422]);
  });

  it('keeps a register that takes only some types of document to those, and does not give such a letter a number', async () => {
    const restricted = await app.call('POST', '/document-number-registers', { member: ADMIN, body: { register_code: 'REG-DEN-R', name: 'Sổ riêng', direction: 'INCOMING', organization_unit_id: unitId(2), year: 2026, scope_doc_types: ['QD'] } });
    expect(restricted.status).toBe(200);
    const letter = await received();
    const before = await count('select count(*) as n from machvon.document_number_allocation');
    // Named on purpose, it is refused; left to the server, it is not among the candidates (the register that takes CV is the only one).
    expect(await register(INCOMING_CLERK, letter.id, 1, { register_id: restricted.json.resource_id })).toMatchObject({ status: 422, json: { detail: 'register_id' } });
    expect(await count('select count(*) as n from machvon.document_number_allocation')).toBe(before);
    expect(await register(INCOMING_CLERK, letter.id, 1)).toMatchObject({ status: 200, json: { register_id: registerId } });
    const current = (await owner<{ version: string }>('select version::text from machvon.document_number_register where id = $1', [restricted.json.resource_id]))[0]?.version;
    expect((await app.call('POST', '/document-number-registers/' + String(restricted.json.resource_id) + '/closure', { member: ADMIN, ifMatch: `"${current}"`, body: { reason: 'closed after the test' } })).status).toBe(200);
  });

  it('finds the only register that takes the type among more than a page of registers that do not', async () => {
    // 105 open registers of unit 2 for another type, whose codes sort before the one that takes CV.
    await app.harness.owner(TENANT_A, [
      ['create temp table tmp_registers as select r.*, g as n from machvon.document_number_register r, generate_series(1, 105) g where r.id = $1', [registerId]],
      ["update tmp_registers set id = gen_random_uuid(), register_code = 'AAA-' || lpad(n::text, 3, '0'), scope_policy = '{\"doc_types\": [\"QD\"]}'::jsonb", []],
      ['alter table tmp_registers drop column n', []],
      ['insert into machvon.document_number_register select * from tmp_registers', []],
    ]);
    try {
      const letter = await received();
      expect(await register(INCOMING_CLERK, letter.id, 1)).toMatchObject({ status: 200, json: { register_id: registerId } });
    } finally {
      await owner("delete from machvon.document_number_register where register_code like 'AAA-%'");
    }
  });

  it('serves the file of a letter to whoever took it in, to the units that work it, and to no one else', async () => {
    const letter = await received();
    const versionId = (await owner<{ id: string }>('select v.id from machvon.document_version v join machvon.incoming_document i on i.document_id = v.document_id where i.id = $1', [letter.id]))[0]?.id as string;
    const download = (member: number) => app.call('GET', '/document-versions/' + versionId + '/download', { member });
    // Not yet registered: the clerk who took it in reads it; the staff and the clerk of another unit do not.
    expect((await download(INCOMING_CLERK)).status).toBe(200);
    expect((await download(INCOMING_STAFF)).status).toBe(404);
    expect((await download(INCOMING_OUTSIDE)).status).toBe(404);
    // Registered in unit 2: the staff of unit 2 read it.
    expect((await register(INCOMING_CLERK, letter.id, 1)).status).toBe(200);
    expect((await download(INCOMING_STAFF)).status).toBe(200);
    expect((await download(INCOMING_OUTSIDE)).status).toBe(404);
    // Given to unit 1: its clerk reads it too, and the file comes from the store the downloads are served from.
    await owner("update machvon.incoming_document set status = 'ASSIGNED', assigned_unit_id = $2, assigned_by = updated_by, due_on = '2026-10-30', version = version + 1 where id = $1", [letter.id, unitId(1)]);
    const served = await download(INCOMING_OUTSIDE);
    expect(served).toMatchObject({ status: 200, json: { version_id: versionId, mime: 'application/pdf' } });
    expect(String(served.json.url)).toContain('/documents/');
  });

  it('refuses a malformed cursor of the ledger', async () => {
    const cursor = Buffer.from(JSON.stringify(['invalid', randomUUID()])).toString('base64url');
    expect((await list(INCOMING_CLERK, '?cursor=' + cursor)).status).toBe(422);
  });

  it('does not offer a mirrored register, which gives no numbers here', async () => {
    const mirrored = await app.call('POST', '/document-number-registers', { member: ADMIN, body: { register_code: 'REG-DEN-M', name: 'Sổ gương', direction: 'INCOMING', organization_unit_id: unitId(2), year: 2026, scope_doc_types: ['CV'] } });
    expect(mirrored.status).toBe(200);
    await owner("update machvon.document_number_register set mode = 'MIRRORED' where id = $1", [mirrored.json.resource_id]);
    try {
      const letter = await received();
      expect(await register(INCOMING_CLERK, letter.id, 1)).toMatchObject({ status: 200, json: { register_id: registerId } });
      const other = await received();
      expect(await register(INCOMING_CLERK, other.id, 1, { register_id: mirrored.json.resource_id })).toMatchObject({ status: 422, json: { detail: 'register_id' } });
    } finally {
      await owner("update machvon.document_number_register set status = 'CLOSED', closed_at = now() where id = $1", [mirrored.json.resource_id]);
    }
  });

  it('counts the lateness of an old deadline with the calendars published for the years since, not only the last two', async () => {
    const letter = await assigned('2026-10-27');
    // A deadline long past (set as the data owner would, the command refuses a past deadline).
    await owner("update machvon.incoming_document set due_on = '2024-12-20' where id = $1", [letter.id]);
    app.now = new Date('2026-10-28T03:00:00Z');
    try {
      const before = Number((await show(INCOMING_CHIEF, letter.id)).json.overdue_days);
      expect(before).toBeGreaterThan(300);
      // 2024-12-24 is a Tuesday that the calendar of 2024 gives as a holiday: one working day less.
      await owner("insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at) select tenant_id, gen_random_uuid(), 'VN-STD', 2024, 1, '[1,2,3,4,5]'::jsonb, '[{\"date\": \"2024-12-24\", \"name\": \"Test\"}]'::jsonb, '[]'::jsonb, 'Test notice', 'Published', created_by, created_by, now() from machvon.incoming_document where id = $1", [letter.id]);
      expect(Number((await show(INCOMING_CHIEF, letter.id)).json.overdue_days)).toBe(before - 1);
    } finally {
      app.now = new Date('2026-10-23T03:00:00Z');
      await owner("delete from machvon.work_calendar_version where calendar_code = 'VN-STD' and year = 2024");
      // Not left open with a deadline long past for the tests that look at the job.
      await owner('update machvon.incoming_document set due_on = null where id = $1', [letter.id]);
    }
  });

  it('names the open registers when several are open and none is chosen, and registers into the one chosen', async () => {
    const second = await app.call('POST', '/document-number-registers', { member: ADMIN, body: { register_code: 'REG-DEN-B', name: 'Sổ đến B', direction: 'INCOMING', organization_unit_id: unitId(2), year: 2026, scope_doc_types: ['CV'] } });
    expect(second.status).toBe(200);
    const letter = await received();
    const ambiguous = await register(INCOMING_CLERK, letter.id, 1);
    expect(ambiguous).toMatchObject({ status: 422, json: { detail: 'register_id' } });
    const named = (ambiguous.json.open_registers ?? (ambiguous.json.extensions as { open_registers?: unknown } | undefined)?.open_registers) as Array<{ id: string; register_code: string }>;
    expect(named.map((entry) => entry.register_code).sort()).toEqual(['REG-DEN-2026', 'REG-DEN-B']);
    expect(await register(INCOMING_CLERK, letter.id, 1, { register_id: second.json.resource_id })).toMatchObject({ status: 200, json: { register_id: second.json.resource_id } });
    // Closed again, so that the other tests find one open register.
    const current = (await owner<{ version: string }>('select version::text from machvon.document_number_register where id = $1', [second.json.resource_id]))[0]?.version;
    expect((await app.call('POST', '/document-number-registers/' + String(second.json.resource_id) + '/closure', { member: ADMIN, ifMatch: `"${current}"`, body: { reason: 'closed after the test' } })).status).toBe(200);
  });

  it('takes in one of two simultaneous letters that differ only in case, marks and spaces, and refuses the other as a suspected copy', async () => {
    const attempts = await Promise.all(
      ['Cong van 5/BTC', 'CÔNG VĂN  5/btc'].map(async (symbol) => {
        const file = await upload(await pdf());
        return app.call('POST', '/incoming-documents', { member: INCOMING_CLERK, body: receiveBody(file, { original_symbol: symbol, original_issued_on: '2026-09-15', sender_name: 'Bộ Công Thương' }) });
      }),
    );
    expect(attempts.map((reply) => reply.status).sort()).toEqual([200, 409]);
    expect(attempts.find((reply) => reply.status === 409)?.json).toMatchObject({ code: 'INCOMING_DUPLICATE_SUSPECTED' });
  });

  it('registers into the only open register even when closed registers come first in the order of the codes', async () => {
    for (const code of ['REG-A1', 'REG-A2', 'REG-A3']) {
      const made = await app.call('POST', '/document-number-registers', { member: ADMIN, body: { register_code: code, name: code, direction: 'INCOMING', organization_unit_id: unitId(2), year: 2026, scope_doc_types: ['CV'] } });
      expect(made.status).toBe(200);
      expect((await app.call('POST', "/document-number-registers/" + String(made.json.resource_id) + "/closure", { member: ADMIN, ifMatch: '"1"', body: { reason: 'closed before the year began' } })).status).toBe(200);
    }
    const letter = await received();
    expect(await register(INCOMING_CLERK, letter.id, 1)).toMatchObject({ status: 200, json: { register_id: registerId } });
  });

  it('keeps the link of a letter taken in as a suspected copy when it is rejected without naming the other letter, and refuses another one', async () => {
    const original = await received({ original_symbol: 'COPY-1/BTC', sender_name: 'Bộ Kế hoạch' });
    const again = await received({ original_symbol: 'COPY-1/BTC', sender_name: 'Bộ Kế hoạch', duplicate_override_reason: 'Gửi lại kèm phụ lục mới.' });
    expect(again.reply.status).toBe(200);
    expect(await reject(INCOMING_CLERK, again.id, 1, { rejection_reason: 'Không có phụ lục như đã nói.', duplicate_of_id: randomUUID() })).toMatchObject({ status: 422 });
    expect(await reject(INCOMING_CLERK, again.id, 1, { rejection_reason: 'Không có phụ lục như đã nói.', duplicate_of_id: (await received()).id })).toMatchObject({ status: 422, json: { detail: 'duplicate_of_id' } });
    expect(await reject(INCOMING_CLERK, again.id, 1, { rejection_reason: 'Không có phụ lục như đã nói.' })).toMatchObject({ status: 200, json: { status: 'REJECTED' } });
    expect((await owner<{ duplicate_of_id: string | null }>('select duplicate_of_id from machvon.incoming_document where id = $1', [again.id]))[0]?.duplicate_of_id).toBe(original.id);
  });

  it('announces a letter that becomes overdue again under a new deadline, once for each episode', async () => {
    const letter = await assigned('2026-10-27');
    const run = async (at: Date) => app.harness.tenants.withTenant(contextFor(TENANT_A, memberId(ADMIN)), (tx) => markOverdueIncoming(tx, TENANT_A, at));
    expect((await run(new Date('2026-10-28T01:00:00Z'))).map((entry) => entry.id)).toEqual([letter.id]);
    // Reassigned with a new deadline (Thursday 29th), it is late again on Friday 30th.
    expect((await assign(INCOMING_CHIEF, letter.id, Number((await stored(letter.id))?.version), { assigned_unit_id: unitId(2), assignee_user_id: staffUser, due_on: '2026-10-29' })).status).toBe(200);
    expect(await run(new Date('2026-10-29T03:00:00Z'))).toEqual([]);
    expect((await run(new Date('2026-10-30T03:00:00Z'))).map((entry) => entry.id)).toEqual([letter.id]);
    expect(await run(new Date('2026-10-30T04:00:00Z'))).toEqual([]);
    const sent = await owner<{ event_key: string; payload: Record<string, unknown> }>("select event_key, payload from machvon.outbox_event where aggregate_id = $1 and type = 'doc.incoming_overdue.v1' order by created_at", [letter.id]);
    expect(sent.map((event) => event.payload.due_on)).toEqual(['2026-10-27', '2026-10-29']);
    expect(new Set(sent.map((event) => event.event_key)).size).toBe(2);
  });

  it('compares a new letter with the earlier ones that carry no symbol without failing', async () => {
    const day = '2026-09-01';
    expect((await received({ original_symbol: undefined, original_issued_on: day, sender_name: 'Sở Xây dựng' })).reply.status).toBe(200);
    expect((await received({ original_symbol: 'XD-77/SXD', original_issued_on: day, sender_name: 'Sở Xây dựng' })).reply.status).toBe(200);
    // And the same letter again is still found among them.
    expect((await received({ original_symbol: 'XD-77/SXD', original_issued_on: day, sender_name: 'Sở Xây dựng' })).reply).toMatchObject({ status: 409, json: { code: 'INCOMING_DUPLICATE_SUSPECTED' } });
  });

  it('shows a letter once, and marks it overdue once, when its handler has two memberships in the tenant', async () => {
    await owner('insert into machvon.membership (tenant_id, id, user_id, organization_id, status, valid_from) select tenant_id, $2::uuid, user_id, organization_id, \'Ended\', valid_from from machvon.membership where id = $1', [memberId(INCOMING_STAFF), randomUUID()]);
    const letter = await assigned('2026-10-27');
    expect(((await list(INCOMING_CHIEF)).json.items as Array<{ id: string }>).filter((item) => item.id === letter.id)).toHaveLength(1);
    expect((await show(INCOMING_CHIEF, letter.id)).json).toMatchObject({ id: letter.id, assignee: { user_id: staffUser, display_name: expect.any(String) } });
    expect(((await show(INCOMING_CHIEF, letter.id)).json.assignments as unknown[]).length).toBe(1);
    const before = Number((await stored(letter.id))?.version);
    const marked = await app.harness.tenants.withTenant(contextFor(TENANT_A, memberId(ADMIN)), (tx) => markOverdueIncoming(tx, TENANT_A, new Date('2026-10-28T01:00:00Z')));
    expect(marked.filter((entry) => entry.id === letter.id)).toHaveLength(1);
    expect(Number((await stored(letter.id))?.version)).toBe(before + 1);
  });

  it('keeps what arrived as it arrived: the database refuses to change the identity of a letter, its register, and a state out of the chain', async () => {
    const letter = await assigned('2026-12-31');
    await expect(owner("update machvon.incoming_document set sender_name = 'Khác' where id = $1", [letter.id])).rejects.toThrow(/does not change/);
    await expect(owner("update machvon.incoming_document set status = 'FILED' where id = $1", [letter.id])).rejects.toThrow(/DOCUMENT_STATE_INVALID/);
    await expect(owner("update machvon.incoming_document set status = 'RECEIVED' where id = $1", [letter.id])).rejects.toThrow(/DOCUMENT_STATE_INVALID/);
    await expect(owner('update machvon.incoming_document set register_id = gen_random_uuid() where id = $1', [letter.id])).rejects.toThrow();
    expect((await stored(letter.id))?.status).toBe('ASSIGNED');
    expect((await owner<{ can: boolean }>("select has_table_privilege('machvon_app', 'machvon.incoming_assignment', 'UPDATE') as can"))[0]?.can).toBe(false);
  });
});
