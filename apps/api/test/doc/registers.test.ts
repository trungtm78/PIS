import { DocumentStore, NumberRegisterStore } from '@machvon/db';
import { ACTOR, ADMIN, DocApp, NOBODY, RENDERER_ONLY, TENANT_A, TENANT_B, UNIT_TWO_CLERK, memberId, unitId } from './doc-app';
import { REGISTER_GAP_ALERT, auditRegisterGaps, rolloverRegisters } from '../../src/modules/doc/register-jobs';

jest.setTimeout(60_000);

const harnessApp = new DocApp();
const registers = new NumberRegisterStore();
const documents = new DocumentStore();
const ctx = (tenantId: string, member = ADMIN) => ({ tenantId, membershipId: memberId(member), scopeVersion: 1 });

let counter = 0;
const openBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
  counter += 1;
  return { register_code: `API-REG-${counter}`, name: `Register ${counter}`, direction: 'OUTGOING', organization_unit_id: unitId(2), year: 2026, scope_doc_types: ['QD'], ...overrides };
};

describe('number registers API (ST-DOC-002)', () => {
  beforeAll(() => harnessApp.start(), 240_000);
  afterAll(() => harnessApp.stop(), 60_000);

  describe('openDocumentNumberRegister', () => {
    it('opens a register, audits it and announces it', async () => {
      const reply = await harnessApp.call('POST', '/document-number-registers', { member: ADMIN, body: openBody() });
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ status: 'OPEN', resource_version: 1 });
      const id = reply.json.resource_id as string;
      expect(await harnessApp.count("select count(*) as n from machvon.audit_event where action = 'document_number_register.open' and resource_id = $1", [id])).toBe(1);
      expect(await harnessApp.count("select count(*) as n from machvon.outbox_event where type = 'doc.register_opened.v1' and aggregate_id = $1", [id])).toBe(1);
    });

    it('refuses a second register for the same code, unit and year', async () => {
      const body = openBody();
      expect((await harnessApp.call('POST', '/document-number-registers', { member: ADMIN, body })).status).toBe(200);
      const again = await harnessApp.call('POST', '/document-number-registers', { member: ADMIN, body });
      expect([again.status, again.json.code]).toEqual([409, 'REGISTER_ALREADY_EXISTS']);
    });

    it('refuses an unknown unit, a year out of range and a unit outside the scope of the caller', async () => {
      const unknown = await harnessApp.call('POST', '/document-number-registers', { member: ADMIN, body: openBody({ organization_unit_id: unitId(9) }) });
      expect([unknown.status, unknown.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const year = await harnessApp.call('POST', '/document-number-registers', { member: ADMIN, body: openBody({ year: 1999 }) });
      expect([year.status, year.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const outside = await harnessApp.call('POST', '/document-number-registers', { member: UNIT_TWO_CLERK, body: openBody({ organization_unit_id: unitId(1) }) });
      expect([outside.status, outside.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const inside = await harnessApp.call('POST', '/document-number-registers', { member: UNIT_TWO_CLERK, body: openBody({ organization_unit_id: unitId(2) }) });
      expect(inside.status).toBe(200);
    });

    it('does not let a member without the permission open a register, and keeps the units of another tenant out of reach', async () => {
      const denied = await harnessApp.call('POST', '/document-number-registers', { member: RENDERER_ONLY, body: openBody() });
      expect([denied.status, denied.json.code]).toEqual([403, 'SCOPE_DENIED']);
      // Tenant B has a unit 1 too, but unit 2 only exists in tenant A.
      const foreign = await harnessApp.call('POST', '/document-number-registers', { member: ADMIN, tenantId: TENANT_B, body: openBody({ organization_unit_id: unitId(2) }) });
      expect([foreign.status, foreign.json.code]).toEqual([422, 'VALIDATION_FAILED']);
    });
  });

  describe('listing and entries', () => {
    it('lists the registers in the scope of the caller with the filters, and pages', async () => {
      await harnessApp.call('POST', '/document-number-registers', { member: ADMIN, body: openBody({ register_code: 'LIST-A', organization_unit_id: unitId(1), year: 2033 }) });
      await harnessApp.call('POST', '/document-number-registers', { member: ADMIN, body: openBody({ register_code: 'LIST-B', organization_unit_id: unitId(2), year: 2033 }) });
      await harnessApp.call('POST', '/document-number-registers', { member: ADMIN, body: openBody({ register_code: 'LIST-C', organization_unit_id: unitId(2), year: 2033, direction: 'INCOMING' }) });
      const all = await harnessApp.call('GET', '/document-number-registers?year=2033', { member: ADMIN });
      expect((all.json.items as Array<{ register_code: string }>).map((row) => row.register_code)).toEqual(['LIST-A', 'LIST-B', 'LIST-C']);
      const clerk = await harnessApp.call('GET', '/document-number-registers?year=2033', { member: UNIT_TWO_CLERK });
      expect((clerk.json.items as Array<{ register_code: string }>).map((row) => row.register_code)).toEqual(['LIST-B', 'LIST-C']);
      const outgoing = await harnessApp.call('GET', '/document-number-registers?year=2033&direction=OUTGOING', { member: ADMIN });
      expect((outgoing.json.items as Array<{ register_code: string }>).map((row) => row.register_code)).toEqual(['LIST-A', 'LIST-B']);
      expect((all.json.items as Array<Record<string, unknown>>)[0]).toMatchObject({ last_number: 0, next_number: 1, status: 'OPEN', mode: 'MANAGED', scope_doc_types: ['QD'] });
      const first = await harnessApp.call('GET', '/document-number-registers?year=2033&limit=2', { member: ADMIN });
      expect((first.json.items as unknown[]).length).toBe(2);
      const second = await harnessApp.call('GET', `/document-number-registers?year=2033&limit=2&cursor=${String(first.json.next_cursor)}`, { member: ADMIN });
      expect((second.json.items as Array<{ register_code: string }>).map((row) => row.register_code)).toEqual(['LIST-C']);
      expect(second.json.next_cursor).toBeNull();
      expect((await harnessApp.call('GET', '/document-number-registers?year=2033', { member: ADMIN, tenantId: TENANT_B })).json.items).toEqual([]);
    });

    it('refuses a malformed year, direction or cursor', async () => {
      for (const query of ['year=26', 'year=abcd', 'direction=SIDEWAYS', 'cursor=%21%21', 'limit=0']) {
        const reply = await harnessApp.call('GET', `/document-number-registers?${query}`, { member: ADMIN });
        expect([reply.status, reply.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      }
      expect((await harnessApp.call('GET', '/document-number-registers', { member: NOBODY })).status).toBe(403);
    });

    it('lists the entries of a register in number order and hides a register out of scope or of another tenant', async () => {
      const opened = await harnessApp.call('POST', '/document-number-registers', { member: ADMIN, body: openBody({ organization_unit_id: unitId(1), register_code: 'ENTRY-1' }) });
      const registerId = opened.json.resource_id as string;
      await harnessApp.harness.tenants.withTenant(ctx(TENANT_A), async (tx) => {
        for (let index = 0; index < 3; index += 1) {
          const document = await documents.insertDocument(tx, { docKind: 'OUTGOING', docTypeCode: 'QD', title: 'Numbered', classification: 'INTERNAL', createdBy: ACTOR });
          await registers.allocateNumber(tx, {
            registerId,
            documentId: document.id,
            issuedAt: new Date('2026-06-15T03:00:00Z'),
            symbolPattern: '{number}/{type}-{agency}',
            parts: { type: 'QD', agency: 'ENTRY1' },
            allocatedBy: ACTOR,
          });
        }
      });
      const page1 = await harnessApp.call('GET', `/document-number-registers/${registerId}/entries?limit=2`, { member: ADMIN });
      expect(page1.status).toBe(200);
      expect((page1.json.items as Array<Record<string, unknown>>).map((row) => [row.number, row.display_number, row.symbol, row.issued_on, row.title, row.status])).toEqual([
        [1, '01', '01/QD-ENTRY1', '2026-06-15', 'Numbered', 'ALLOCATED'],
        [2, '02', '02/QD-ENTRY1', '2026-06-15', 'Numbered', 'ALLOCATED'],
      ]);
      expect(page1.json.register).toMatchObject({ id: registerId, last_number: 3, next_number: 4 });
      const page2 = await harnessApp.call('GET', `/document-number-registers/${registerId}/entries?limit=2&cursor=${String(page1.json.next_cursor)}`, { member: ADMIN });
      expect((page2.json.items as Array<{ number: number }>).map((row) => row.number)).toEqual([3]);
      expect(page2.json.next_cursor).toBeNull();
      expect((await harnessApp.call('GET', `/document-number-registers/${registerId}/entries`, { member: UNIT_TWO_CLERK })).status).toBe(404);
      expect((await harnessApp.call('GET', `/document-number-registers/${registerId}/entries`, { member: ADMIN, tenantId: TENANT_B })).status).toBe(404);
      expect((await harnessApp.call('GET', `/document-number-registers/${registerId}/entries?cursor=${Buffer.from(JSON.stringify(['abc', registerId])).toString('base64url')}`, { member: ADMIN })).status).toBe(422);
    });
  });

  describe('closeDocumentNumberRegister', () => {
    it('closes a register with the current version, then refuses allocation, a stale version and a second closing', async () => {
      const opened = await harnessApp.call('POST', '/document-number-registers', { member: ADMIN, body: openBody() });
      const id = opened.json.resource_id as string;
      const stale = await harnessApp.call('POST', `/document-number-registers/${id}/closure`, { member: ADMIN, ifMatch: '"7"', body: { reason: 'closing at the end of the year' } });
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const closed = await harnessApp.call('POST', `/document-number-registers/${id}/closure`, { member: ADMIN, ifMatch: '"1"', body: { reason: 'closing at the end of the year' } });
      expect(closed.status).toBe(200);
      expect(closed.json).toMatchObject({ status: 'CLOSED', resource_version: 2 });
      expect(await harnessApp.count("select count(*) as n from machvon.outbox_event where type = 'doc.register_closed.v1' and aggregate_id = $1", [id])).toBe(1);
      const again = await harnessApp.call('POST', `/document-number-registers/${id}/closure`, { member: ADMIN, ifMatch: '"2"', body: { reason: 'closing again by mistake' } });
      expect([again.status, again.json.code]).toEqual([409, 'REGISTER_NOT_OPEN']);
      const document = await harnessApp.harness.tenants.withTenant(ctx(TENANT_A), (tx) =>
        documents.insertDocument(tx, { docKind: 'OUTGOING', docTypeCode: 'QD', title: 'Late', classification: 'INTERNAL', createdBy: ACTOR }),
      );
      await expect(
        harnessApp.harness.tenants.withTenant(ctx(TENANT_A), (tx) =>
          registers.allocateNumber(tx, { registerId: id, documentId: document.id, issuedAt: new Date('2026-06-15T03:00:00Z'), symbolPattern: '{number}', parts: {}, allocatedBy: ACTOR }),
        ),
      ).rejects.toMatchObject({ code: 'REGISTER_NOT_OPEN' });
    });

    it('needs the If-Match header, the scope of the register and the right tenant', async () => {
      const opened = await harnessApp.call('POST', '/document-number-registers', { member: ADMIN, body: openBody({ organization_unit_id: unitId(1) }) });
      const id = opened.json.resource_id as string;
      expect((await harnessApp.call('POST', `/document-number-registers/${id}/closure`, { member: ADMIN, body: { reason: 'a reason that is long enough' } })).status).toBe(428);
      expect((await harnessApp.call('POST', `/document-number-registers/${id}/closure`, { member: UNIT_TWO_CLERK, ifMatch: '"1"', body: { reason: 'a reason that is long enough' } })).status).toBe(404);
      expect((await harnessApp.call('POST', `/document-number-registers/${id}/closure`, { member: ADMIN, tenantId: TENANT_B, ifMatch: '"1"', body: { reason: 'a reason that is long enough' } })).status).toBe(404);
      expect((await harnessApp.call('POST', `/document-number-registers/${id}/closure`, { member: NOBODY, ifMatch: '"1"', body: { reason: 'a reason that is long enough' } })).status).toBe(403);
    });
  });

  describe('jobs', () => {
    it('rolls the registers over at the turn of the year, once (AC-ST-DOC-002-1)', async () => {
      await harnessApp.call('POST', '/document-number-registers', { member: ADMIN, body: openBody({ register_code: 'ROLL-API', year: 2060 }) });
      const midnight = new Date('2060-12-31T17:00:00Z');
      const opened = await harnessApp.harness.tenants.withTenant(ctx(TENANT_A), (tx) => rolloverRegisters(tx, midnight, ACTOR));
      expect(opened.map((row) => [row.registerCode, row.year, row.lastNumber])).toEqual([['ROLL-API', 2061, 0]]);
      expect(await harnessApp.harness.tenants.withTenant(ctx(TENANT_A), (tx) => rolloverRegisters(tx, midnight, ACTOR))).toEqual([]);
      // One second earlier it is still 2060 in Vietnam: nothing to open for 2060.
      const early = await harnessApp.harness.tenants.withTenant(ctx(TENANT_A), (tx) => rolloverRegisters(tx, new Date('2060-12-31T16:59:59Z'), ACTOR));
      expect(early).toEqual([]);
    });

    it('raises an alert for every register that has a gap and stays quiet otherwise', async () => {
      const opened = await harnessApp.call('POST', '/document-number-registers', { member: ADMIN, body: openBody({ register_code: 'GAP-API', year: 2070, organization_unit_id: unitId(1) }) });
      const registerId = opened.json.resource_id as string;
      await harnessApp.harness.tenants.withTenant(ctx(TENANT_A), async (tx) => {
        for (let index = 0; index < 3; index += 1) {
          const document = await documents.insertDocument(tx, { docKind: 'OUTGOING', docTypeCode: 'QD', title: 'Gap', classification: 'INTERNAL', createdBy: ACTOR });
          await registers.allocateNumber(tx, {
            registerId,
            documentId: document.id,
            issuedAt: new Date('2070-06-15T03:00:00Z'),
            symbolPattern: '{number}/{agency}',
            parts: { agency: 'GAPAPI' },
            allocatedBy: ACTOR,
          });
        }
      });
      const raised: Array<{ code: string; context: Record<string, unknown> }> = [];
      const counted: string[] = [];
      const deps = {
        alerts: { raise: (code: string, context: Record<string, unknown>) => void raised.push({ code, context }) },
        metrics: { increment: (name: string) => void counted.push(name), gauge: () => undefined },
      };
      expect(await harnessApp.harness.tenants.withTenant(ctx(TENANT_A), (tx) => auditRegisterGaps(tx, deps))).toEqual([]);
      expect(raised).toEqual([]);
      await harnessApp.harness.owner(TENANT_A, [['delete from machvon.document_number_allocation where register_id = $1 and number = 2', [registerId]]]);
      const found = await harnessApp.harness.tenants.withTenant(ctx(TENANT_A), (tx) => auditRegisterGaps(tx, deps));
      expect(found).toEqual([{ registerId, registerCode: 'GAP-API', year: 2070, numbers: [2] }]);
      expect(raised).toEqual([{ code: REGISTER_GAP_ALERT, context: { register_id: registerId, register_code: 'GAP-API', year: 2070, missing: [2] } }]);
      expect(counted).toContain('doc_register_gap_total');
    });
  });
});
