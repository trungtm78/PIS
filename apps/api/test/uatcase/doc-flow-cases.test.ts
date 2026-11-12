import { Pool } from 'pg';
import { DocumentStore, NumberRegisterStore } from '@machvon/db';
import { appendRevision } from '../../src/modules/doc/pdf-incremental';
import { rolloverRegisters } from '../../src/modules/doc/register-jobs';
import { ACTOR, ADMIN, CLERK, LEADER, LEGAL_ISSUER, NOW, REVIEWER, TENANT_A, TENANT_B, memberId, unitId } from '../doc/doc-app';
import { FlowWorld, payloadOf } from '../doc/support/flow-world';
import { revisionZero, signField, withNumbering } from '../doc/support/pdf-fixture';
import { EXTERNAL_RECIPIENT, INTERNAL_RECIPIENT, replaceSealedFile, sealedDocument } from '../doc/support/sealed-documents';
import { assertStatus, expectCheckFails } from '../uat/uat-kit';
import type { Reply } from '../uat/uat-kit';

jest.setTimeout(480_000);

const flow = new FlowWorld();
const { app } = flow;
const registers = new NumberRegisterStore();
const documents = new DocumentStore();
const owner = <T extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<T[]> => app.harness.owner<T>(tenant, [[sql, params]]);
const ctx = (member: number, tenantId = TENANT_A) => ({ tenantId, membershipId: memberId(member), scopeVersion: 1 });
const AUDITOR = 60; // holds doc.register.read and doc.outgoing.read over the whole tenant, and nothing that numbers a document
const HOUR = 60 * 60 * 1000;
const SIGNED_AT = new Date(NOW.getTime() - HOUR);
const REASON = 'The legal office confirmed the template by letter 12/PC';
const NUMBERING = { doc_number: '7', doc_symbol: '7/QD-UBND', doc_date: '23/10/2026' };

/** The reply of the HTTP route the screens use, as the kit reads it. */
const asReply = (reply: { status: number; json: Record<string, unknown> }): Reply => ({ status: reply.status, json: reply.json });
const call = async (method: 'GET' | 'POST', url: string, options: { member: number; body?: unknown; version?: number; tenantId?: string }): Promise<Reply> =>
  asReply(await app.call(method, url, { member: options.member, ...(options.body === undefined ? {} : { body: options.body }), ...(options.version === undefined ? {} : { ifMatch: `"${options.version}"` }), ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }) }));

/** A document of the legal fixture taken over the HTTP routes to SIGNED by the leader (the drafter, the reviewer and the leader are three people). Returns its id and the version after the signature. */
async function signedByLeader(title: string): Promise<{ id: string; version: number }> {
  const made = await flow.create({
    doc_type_code: 'QD',
    template_code: 'QD-DEFAULT',
    title,
    drafting_unit_id: unitId(2),
    payload: payloadOf(),
    recipients: [INTERNAL_RECIPIENT, EXTERNAL_RECIPIENT],
    signer_user_id: memberId(LEADER),
  });
  assertStatus(asReply(made), 200);
  const id = made.json.resource_id as string;
  assertStatus(asReply(await flow.submit(id, 1)), 200);
  const approved = await flow.approve(id, 2);
  assertStatus(asReply(approved), 200);
  const started = await call('POST', `/outgoing-documents/${id}/leader-signing-sessions`, { member: LEADER, version: approved.json.resource_version as number, body: {} });
  assertStatus(started, 202);
  const session = started.json.resource_id as string;
  await flow.approveSession(session);
  const signed = await call('POST', `/signing-sessions/${session}/completion`, { member: LEADER, version: 1, body: {} });
  assertStatus(signed, 200);
  return { id, version: signed.json.document_version as number };
}

const numbering = (id: string, version: number, registerId: string, member: number = CLERK): Promise<Reply> => call('POST', `/outgoing-documents/${id}/numbering`, { member, version, body: { register_id: registerId } });

async function leaderSigned(): Promise<Buffer> {
  flow.world.setTime(SIGNED_AT);
  try {
    return await signField(revisionZero(), { field: 'sig_leader', identity: flow.world.leader, signingTime: SIGNED_AT, docMdpLevel: 2, timestamps: flow.world.tsa });
  } finally {
    flow.world.setTime(NOW);
  }
}

/** The file the leader signed, then the organisation seal over one more revision that carries `change` (the three number fields by default). */
async function sealedWith(pdf: Buffer, change: (pdf: Buffer) => Buffer = (bytes) => withNumbering(bytes, NUMBERING)): Promise<Buffer> {
  flow.world.setTime(new Date(SIGNED_AT.getTime() + 60_000));
  try {
    return await signField(change(pdf), { field: 'sig_org', identity: flow.world.organization, signingTime: new Date(SIGNED_AT.getTime() + 60_000), timestamps: flow.world.tsa });
  } finally {
    flow.world.setTime(NOW);
  }
}

describe('the numbering, the isolation of the tenants, the ledger and the signature report of the outgoing documents (UAT cases of DOC)', () => {
  beforeAll(async () => {
    await flow.start();
    await app.harness.seedMembership(TENANT_A, AUDITOR, 1);
    await app.harness.seedRole(TENANT_A, 60, 'DOC_AUDITOR', ['doc.register.read', 'doc.outgoing.read', 'document_version.read'], 20);
    await app.harness.seedGrants(TENANT_A, [{ n: 60, member: AUDITOR, role: 60, kind: 'TENANT' }]);
  }, 480_000);
  afterAll(() => flow.stop(), 60_000);
  afterEach(() => flow.reset());

  it('UAT-AC402: a decision signed at 23:59:30 on 31 December is numbered 01 of the register of the new year opened at midnight, and the register of the old year cannot be forced', async () => {
    const register2026 = await flow.openRegister({ register_code: 'REG-QD-ROLL', year: 2026 });
    await owner('update machvon.document_number_register set last_number = 87 where id = $1', [register2026]);
    // QD-Z and a second decision are signed by the leader half a minute before the end of the year (Vietnam time).
    app.now = new Date('2026-12-31T16:59:30Z');
    flow.world.setTime(app.now);
    const z = await signedByLeader('Decision Z');
    const other = await signedByLeader('Decision of the same night');

    // 1. The job of 00:00:00 on 1 January 2027 opens the register of the year with the counter at zero.
    const midnight = new Date('2026-12-31T17:00:00Z');
    const opened = await app.harness.tenants.withTenant(ctx(ADMIN), (tx) => rolloverRegisters(tx, midnight, ACTOR));
    const rolled = opened.filter((row) => row.registerCode === 'REG-QD-ROLL');
    expect(rolled.map((row) => [row.year, row.lastNumber])).toEqual([[2027, 0]]);
    const register2027 = rolled[0]?.id as string;

    // 2. The clerk numbers it at 00:00:10: the first number of 2027, in the register of 2027, issued on 1 January 2027.
    app.now = new Date('2026-12-31T17:00:10Z');
    flow.world.setTime(app.now);
    const numbered = await numbering(z.id, z.version, register2027);
    assertStatus(numbered, 200);
    expect(numbered.json).toMatchObject({ status: 'NUMBERED', number: 1, display_number: '01', issued_on: '2027-01-01' });
    expect(String(numbered.json.symbol)).toMatch(/^01\/QD-/);
    const [header] = await owner<{ number_year: number; issued_on: string; document_number: number }>(
      'select d.number_year, d.issued_on::text as issued_on, d.document_number from machvon.document d join machvon.outgoing_document o on o.document_id = d.id where o.id = $1',
      [z.id],
    );
    expect(header).toEqual({ number_year: 2027, issued_on: '2027-01-01', document_number: 1 });

    // 3. A command that names the register of 2026 is refused, the counter of 2026 stays at 87 and no number of 2027 is in it.
    const forced = await numbering(other.id, other.version, register2026);
    assertStatus(forced, 409, 'REGISTER_YEAR_MISMATCH');
    expect((await owner<{ last_number: number }>('select last_number from machvon.document_number_register where id = $1', [register2026]))[0]?.last_number).toBe(87);
    expect(await owner('select number from machvon.document_number_allocation where register_id = $1', [register2026])).toEqual([]);
    expect((await owner<{ last_number: number }>('select last_number from machvon.document_number_register where id = $1', [register2027]))[0]?.last_number).toBe(1);
  });

  it('UAT-AC405: the file with the three number fields filled and the seal is VALID for the leader with incremental changes allowed, the file with a changed page and a FreeText annotation is INVALID for it and cannot be issued', async () => {
    const leader = await leaderSigned();
    const p1 = await sealedWith(leader);
    const annotated = (bytes: Buffer): Buffer =>
      appendRevision(bytes, [
        { num: 4, body: '<< /Length 36 >>\nstream\nBT /F1 12 Tf 72 780 Td (Fraud) Tj ET\nendstream' },
        { num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Annots [6 0 R 7 0 R 8 0 R 9 0 R 10 0 R 14 0 R] /Resources << /Font << /F1 11 0 R >> >> >>' },
        { num: 14, body: '<< /Type /Annot /Subtype /FreeText /Rect [72 600 272 640] /P 3 0 R /Contents (Written over the content) /DA (/F1 10 Tf 0 g) >>' },
      ]).pdf;
    const p2 = await sealedWith(leader, annotated);

    const first = await sealedDocument(flow);
    await replaceSealedFile(flow, first, p1);
    const second = await sealedDocument(flow);
    await replaceSealedFile(flow, second, p2);

    // 1. P1: the leader signature is VALID and the revisions after it are the ones the rules allow.
    const verifiedP1 = await call('POST', `/document-versions/${first.versionId}/signature-verifications`, { member: ADMIN, body: {} });
    assertStatus(verifiedP1, 200);
    expect(verifiedP1.json).toMatchObject({ overall: 'VALID' });
    const reportP1 = await call('GET', `/document-versions/${first.versionId}/signature-report`, { member: ADMIN });
    const leaderP1 = (reportP1.json.signatures as Array<Record<string, unknown>>).find((signature) => signature.role === 'LEADER');
    expect(leaderP1).toMatchObject({ status: 'VALID', incremental_changes_allowed: true, findings: [] });

    // 2. P2: the signature is valid as cryptography (the digest matches) but the revision changed the content, so the verdict is INVALID with INCREMENTAL_CHANGES_NOT_ALLOWED and nothing else.
    const verifiedP2 = await call('POST', `/document-versions/${second.versionId}/signature-verifications`, { member: ADMIN, body: {} });
    assertStatus(verifiedP2, 200);
    expect(verifiedP2.json).toMatchObject({ overall: 'INVALID' });
    const reportP2 = await call('GET', `/document-versions/${second.versionId}/signature-report`, { member: ADMIN });
    expect(reportP2.json.overall).toBe('INVALID');
    const leaderP2 = (reportP2.json.signatures as Array<Record<string, unknown>>).find((signature) => signature.role === 'LEADER');
    expect(leaderP2).toMatchObject({ status: 'INVALID', incremental_changes_allowed: false, findings: ['INCREMENTAL_CHANGES_NOT_ALLOWED'] });
    const stored = await owner<{ role: string; failure_codes: string[] }>('select role, failure_codes from machvon.document_signature where document_version_id = $1 and verification_no = (select max(verification_no) from machvon.document_signature where document_version_id = $1)', [second.versionId]);
    expect(stored.find((row) => row.role === 'LEADER')?.failure_codes).toContain('INCREMENTAL_CHANGES_NOT_ALLOWED');
    expect(stored.find((row) => row.role === 'LEADER')?.failure_codes).not.toContain('DIGEST_MISMATCH');

    // 3. Issuing P2 is refused with the same code, and the document stays sealed.
    const refused = await call('POST', `/outgoing-documents/${second.id}/issuance`, { member: LEGAL_ISSUER, version: second.version, body: { unconfirmed_override_reason: REASON } });
    assertStatus(refused, 422, 'INCREMENTAL_CHANGES_NOT_ALLOWED');
    expect((await owner<{ status: string }>('select status from machvon.outgoing_document where id = $1', [second.id]))[0]?.status).toBe('SEALED');
  });

  it('UAT-AC413: a clerk of tenant B knows the ids of a document of tenant A and gets 404 everywhere, numbers in its own register, and the application role without a tenant reads no row', async () => {
    const sealed = await sealedDocument(flow);
    await flow.issueSealed(sealed.id);
    const registerA = await flow.openRegister({ register_code: 'QD_CA_BIET', year: 2026 });
    await owner('update machvon.document_number_register set last_number = 42 where id = $1', [registerA]);
    const openedB = await app.call('POST', '/document-number-registers', {
      member: ADMIN,
      tenantId: TENANT_B,
      body: { register_code: 'QD_CA_BIET', name: 'Outgoing register of tenant B', direction: 'OUTGOING', organization_unit_id: unitId(1), year: 2026, mode: 'MANAGED', scope_doc_types: ['QD'] },
    });
    assertStatus(asReply(openedB), 200);
    const registerB = openedB.json.resource_id as string;

    // 1 and 2. The reads of the clerk of tenant B: 404 RESOURCE_NOT_FOUND, with no URL to download.
    for (const url of [`/outgoing-documents/${sealed.id}`, `/document-versions/${sealed.versionId}/download`, `/document-versions/${sealed.versionId}/signature-report`]) {
      const reply = await call('GET', url, { member: ADMIN, tenantId: TENANT_B });
      assertStatus(reply, 404, 'RESOURCE_NOT_FOUND');
      expect(JSON.stringify(reply.json)).not.toMatch(/mock:\/\/|https?:\/\//);
    }
    // The same reads by tenant A show the document, so it is the tenant that hid it.
    assertStatus(await call('GET', `/outgoing-documents/${sealed.id}`, { member: ADMIN }), 200);

    // 3. The number of a document of tenant B is the first of its register, and the register of tenant A is where it was.
    const documentB = await app.harness.tenants.withTenant(ctx(ADMIN, TENANT_B), (tx) => documents.insertDocument(tx, { docKind: 'OUTGOING', docTypeCode: 'QD', title: 'QD-B', classification: 'INTERNAL', createdBy: ACTOR }));
    const allocated = await app.harness.tenants.withTenant(ctx(ADMIN, TENANT_B), (tx) =>
      registers.allocateNumber(tx, { registerId: registerB, documentId: documentB.id, issuedAt: new Date('2026-06-15T03:00:00Z'), symbolPattern: '{number}/{type}-{agency}', parts: { type: 'QD', agency: 'UBND' }, allocatedBy: ACTOR }),
    );
    expect(allocated.number).toBe(1);
    expect((await owner<{ last_number: number }>('select last_number from machvon.document_number_register where id = $1', [registerA]))[0]?.last_number).toBe(42);
    expect((await owner<{ last_number: number }>('select last_number from machvon.document_number_register where id = $1', [registerB], TENANT_B))[0]?.last_number).toBe(1);

    // The application role that sets no tenant sees no row of either table.
    const pool = new Pool({ connectionString: app.harness.database.urlFor('machvon_app'), max: 1 });
    pool.on('error', () => undefined);
    try {
      for (const table of ['document', 'outgoing_document']) expect((await pool.query(`select count(*)::int as n from machvon.${table}`)).rows[0]).toEqual({ n: 0 });
    } finally {
      await pool.end();
    }
  });

  it('UAT-AC431: the register of 43 numbers lists 43 rows and no 44, with the voided and the recalled number in words and two digits under ten, and an auditor cannot number', async () => {
    const register = await flow.openRegister({ register_code: 'QD_CA_BIET_LEDGER', year: 2026 });
    const allocations: string[] = [];
    await app.harness.tenants.withTenant(ctx(ADMIN), async (tx) => {
      for (let n = 1; n <= 43; n += 1) {
        const document = await documents.insertDocument(tx, { docKind: 'OUTGOING', docTypeCode: 'QD', title: `Decision ${n}`, classification: 'INTERNAL', createdBy: ACTOR });
        const result = await registers.allocateNumber(tx, { registerId: register, documentId: document.id, issuedAt: new Date('2026-06-15T03:00:00Z'), symbolPattern: '{number}/{type}-{agency}', parts: { type: 'QD', agency: 'UBND' }, allocatedBy: ACTOR });
        allocations.push(`${result.number}:${document.id}`);
      }
    });
    await owner("update machvon.document_number_allocation set status = 'VOIDED', voided_at = now(), voided_by = $2::uuid, void_reason = 'Printed twice', void_approved_by = $3::uuid where register_id = $1 and number = 10", [register, memberId(ADMIN), memberId(REVIEWER)]);
    const recalled = allocations.find((entry) => entry.startsWith('20:'))?.split(':')[1];
    await owner("update machvon.document set effect_status = 'RECALLED' where id = $1", [recalled]);

    const entries: Array<{ number: number; display_number: string; symbol: string; status: string }> = [];
    let cursor = '';
    for (let page = 0; page < 10; page += 1) {
      const reply = await call('GET', `/document-number-registers/${register}/entries?limit=20${cursor === '' ? '' : `&cursor=${encodeURIComponent(cursor)}`}`, { member: ADMIN });
      assertStatus(reply, 200);
      entries.push(...(reply.json.items as typeof entries));
      if (reply.json.next_cursor === null) break;
      cursor = reply.json.next_cursor as string;
    }
    expect(entries).toHaveLength(43);
    expect(entries.map((entry) => entry.number)).toEqual(Array.from({ length: 43 }, (_unused, index) => index + 1));
    expect(entries.some((entry) => entry.number === 44)).toBe(false);
    expect(entries.find((entry) => entry.number === 10)?.status).toBe('VOIDED');
    expect(entries.find((entry) => entry.number === 20)?.status).toBe('RECALLED');
    expect(entries.filter((entry) => entry.status === 'ALLOCATED')).toHaveLength(41);
    expect(entries.find((entry) => entry.number === 5)).toMatchObject({ display_number: '05', symbol: '05/QD-UBND' });
    expect(entries.find((entry) => entry.number === 43)).toMatchObject({ display_number: '43' });

    // The auditor reads the register and cannot number a document: 403 SCOPE_DENIED, nothing is spent.
    assertStatus(await call('GET', `/document-number-registers/${register}/entries?limit=5`, { member: AUDITOR }), 200);
    const signed = await signedByLeader('Decision for the auditor');
    assertStatus(await numbering(signed.id, signed.version, register, AUDITOR), 403, 'SCOPE_DENIED');
    expect((await owner<{ last_number: number }>('select last_number from machvon.document_number_register where id = $1', [register]))[0]?.last_number).toBe(43);
  });

  it('negative control of the document cases: an answer that is not the refusal, or a verdict that is not INVALID, makes the check throw', () => {
    expectCheckFails(() => assertStatus({ status: 200, json: {} }, 409, 'REGISTER_YEAR_MISMATCH'));
    expectCheckFails(() => assertStatus({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } }, 403, 'SCOPE_DENIED'));
    expectCheckFails(() => expect({ status: 'VALID', findings: [] }).toMatchObject({ status: 'INVALID', findings: ['INCREMENTAL_CHANGES_NOT_ALLOWED'] }));
  });
});
