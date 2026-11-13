import { randomUUID } from 'node:crypto';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess, Scope } from '@machvon/kernel';
import { Client } from 'pg';
import { DocumentStore } from '../src/document-store';
import { NumberRegisterStore, REGISTER_SCOPE_COLUMNS } from '../src/number-register-store';
import { scopePredicate } from '../src/scope-version';
import type { AllocateInput, NewRegister, RegisterRecord } from '../src/number-register-store';
import { ACTOR, AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const documents = new DocumentStore();
const registers = new NumberRegisterStore();
const CLERK = '00000000-0000-4000-8000-0000000000c1';
const APPROVER = '00000000-0000-4000-8000-0000000000c2';

const ctxA = contextFor(TENANT_A, memberId(1));
const ctxB = contextFor(TENANT_B, memberId(1));
function accessWith(scope: Scope): EffectiveAccess {
  return {
    membershipId: memberId(1),
    scopeVersion: 1,
    membershipActive: true,
    grants: [{ roleCode: 'CLERK', rank: 10, permissions: ['doc.register.read'], scope, status: 'Active', effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveUntil: null }],
  };
}

const inA = <T>(work: Parameters<typeof harness.tenants.withTenant<T>>[1]) => harness.tenants.withTenant(ctxA, work);

async function failure(promise: Promise<unknown>): Promise<{ code: string; sqlState?: string; detail?: string | undefined }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return { code: error.code, detail: error.detail };
    return { code: 'DB', sqlState: (error as { code?: string }).code };
  }
  throw new Error('expected a rejection');
}

let counter = 0;
function newRegister(overrides: Partial<NewRegister> = {}): NewRegister {
  counter += 1;
  return {
    registerCode: `REG-${counter}`,
    name: `Register ${counter}`,
    direction: 'OUTGOING',
    organizationUnitId: unitId(1),
    year: 2026,
    mode: 'MANAGED',
    scopeDocTypes: ['QD'],
    actor: ACTOR,
    ...overrides,
  };
}

async function newDocument(): Promise<string> {
  return (await inA((tx) => documents.insertDocument(tx, { docKind: 'OUTGOING', docTypeCode: 'QD', title: 'Decision', classification: 'INTERNAL', createdBy: ACTOR }))).id;
}

// The agency part carries the register code: the symbol of an outgoing document is unique within its year.
function allocation(register: Pick<RegisterRecord, 'id' | 'registerCode'>, documentId: string, overrides: Partial<AllocateInput> = {}): AllocateInput {
  return {
    registerId: register.id,
    documentId,
    issuedAt: new Date('2026-06-15T03:00:00Z'),
    symbolPattern: '{number}/{type}-{agency}',
    parts: { type: 'QD', agency: register.registerCode },
    allocatedBy: CLERK,
    ...overrides,
  };
}

async function openRegister(overrides: Partial<NewRegister> = {}): Promise<RegisterRecord> {
  return inA((tx) => registers.openRegister(tx, newRegister(overrides)));
}

describe('NumberRegisterStore', () => {
  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: 1, path: '/a/1/' },
      { n: 2, path: '/a/2/' },
    ]);
    await harness.seedUnits(TENANT_B, [{ n: 1, path: '/b/1/' }]);
  }, 180_000);

  afterAll(() => harness.stop(), 60_000);

  describe('opening and listing registers (BR-DOC-02)', () => {
    it('opens a register at counter zero and refuses a second one for the same code, unit and year', async () => {
      const input = newRegister();
      const register = await inA((tx) => registers.openRegister(tx, input));
      expect(register).toMatchObject({ registerCode: input.registerCode, year: 2026, lastNumber: 0, status: 'OPEN', mode: 'MANAGED', version: 1 });
      expect(register.scopeDocTypes).toEqual(['QD']);
      expect((await failure(inA((tx) => registers.openRegister(tx, input)))).code).toBe('REGISTER_ALREADY_EXISTS');
      const nextYear = await inA((tx) => registers.openRegister(tx, { ...input, year: 2027 }));
      expect(nextYear.year).toBe(2027);
    });

    it('refuses a unit that is not in the tenant', async () => {
      const outcome = await failure(inA((tx) => registers.openRegister(tx, newRegister({ organizationUnitId: unitId(99) }))));
      expect(outcome.code).toBe('VALIDATION_FAILED');
      expect(outcome.detail).toBe('organization_unit_id');
    });

    it('lists registers by year and direction in keyset pages, inside the tenant', async () => {
      const incoming = await openRegister({ direction: 'INCOMING', year: 2031, registerCode: 'IN-2031' });
      await openRegister({ year: 2031, registerCode: 'OUT-2031-A' });
      await openRegister({ year: 2031, registerCode: 'OUT-2031-B' });
      const all = await inA((tx) => registers.listRegisters(tx, { year: 2031, limit: 10 }));
      expect(all.map((row) => row.registerCode)).toEqual(['IN-2031', 'OUT-2031-A', 'OUT-2031-B']);
      const outgoing = await inA((tx) => registers.listRegisters(tx, { year: 2031, direction: 'OUTGOING', limit: 10 }));
      expect(outgoing.map((row) => row.registerCode)).toEqual(['OUT-2031-A', 'OUT-2031-B']);
      const first = await inA((tx) => registers.listRegisters(tx, { year: 2031, limit: 1 }));
      const anchor = first[0];
      if (anchor === undefined) throw new Error('no register');
      const rest = await inA((tx) => registers.listRegisters(tx, { year: 2031, limit: 5, after: { code: anchor.registerCode, id: anchor.id } }));
      expect(rest.map((row) => row.registerCode)).toEqual(['OUT-2031-A', 'OUT-2031-B']);
      expect(await harness.tenants.withTenant(ctxB, (tx) => registers.listRegisters(tx, { year: 2031, limit: 10 }))).toEqual([]);
      expect(await harness.tenants.withTenant(ctxB, (tx) => registers.findRegister(tx, incoming.id))).toBeUndefined();
    });
  });

  describe('scope of the caller', () => {
    it('narrows one register and a list to the units the caller may see, and names the unit of a register', async () => {
      const mine = await openRegister({ registerCode: 'SCOPE-1' });
      const theirs = await openRegister({ registerCode: 'SCOPE-2', organizationUnitId: unitId(2) });
      const builder = (access: EffectiveAccess) => (first: number) => scopePredicate(access, 'doc.register.read', new Date('2026-10-23T00:00:00Z'), REGISTER_SCOPE_COLUMNS, first);
      const unitOne = accessWith({ kind: 'UNIT_ONLY', refIds: [unitId(1)] });
      const whole = accessWith({ kind: 'TENANT' });
      const seen = (access: EffectiveAccess) =>
        inA(async (tx) => ({
          mine: (await registers.findRegister(tx, mine.id, builder(access))) !== undefined,
          theirs: (await registers.findRegister(tx, theirs.id, builder(access))) !== undefined,
          listed: (await registers.listRegisters(tx, { year: 2026, limit: 100 }, builder(access))).map((row) => row.registerCode).filter((code) => code.startsWith('SCOPE-')),
        }));
      expect(await seen(whole)).toEqual({ mine: true, theirs: true, listed: ['SCOPE-1', 'SCOPE-2'] });
      expect(await seen(unitOne)).toEqual({ mine: true, theirs: false, listed: ['SCOPE-1'] });
      expect(await inA((tx) => registers.unitRef(tx, unitId(2)))).toEqual({ id: unitId(2), path: '/a/2/' });
      expect(await inA((tx) => registers.unitRef(tx, unitId(9)))).toBeUndefined();
    });
  });

  describe('allocateNumber (BR-DOC-03, BR-DOC-04, BR-DOC-05, BR-DOC-06)', () => {
    it('hands out 1, 2, 3 without a gap, builds the symbol and writes the number to the document', async () => {
      const register = await openRegister();
      const docs = [await newDocument(), await newDocument(), await newDocument()];
      const results = [];
      for (const documentId of docs) results.push(await inA((tx) => registers.allocateNumber(tx, allocation(register, documentId))));
      expect(results.map((row) => row.number)).toEqual([1, 2, 3]);
      expect(results.map((row) => row.symbol)).toEqual(['01', '02', '03'].map((text) => `${text}/QD-${register.registerCode}`));
      const [doc] = await harness.owner<{ document_number: number; number_year: number; symbol: string; issued_on: string }>(TENANT_A, [
        ["select document_number, number_year, symbol, issued_on::text as issued_on from machvon.document where id = $1", [docs[2]]],
      ]);
      expect(doc).toEqual({ document_number: 3, number_year: 2026, symbol: `03/QD-${register.registerCode}`, issued_on: '2026-06-15' });
      const stored = await inA((tx) => registers.findRegister(tx, register.id));
      expect(stored?.lastNumber).toBe(3);
      expect(stored?.version).toBe(4);
      expect(await inA((tx) => registers.gaps(tx, register.id))).toEqual([]);
    });

    it('shows two digits below ten and the plain number from ten on', async () => {
      const register = await openRegister();
      let last = '';
      for (let n = 1; n <= 10; n += 1) last = (await inA(async (tx) => registers.allocateNumber(tx, allocation(register, await newDocumentIn(tx))))).symbol;
      expect(last).toBe(`10/QD-${register.registerCode}`);
    });

    it('numbers a document once: a second allocation for it is a state conflict and consumes no number (AC-ST-DOC-005-5)', async () => {
      const register = await openRegister();
      const documentId = await newDocument();
      await inA((tx) => registers.allocateNumber(tx, allocation(register, documentId)));
      const second = await failure(inA((tx) => registers.allocateNumber(tx, allocation(register, documentId))));
      expect(second.code).toBe('DOCUMENT_STATE_INVALID');
      expect((await inA((tx) => registers.findRegister(tx, register.id)))?.lastNumber).toBe(1);
    });

    it('refuses a register of another year (REGISTER_YEAR_MISMATCH) at the Vietnam new-year boundary (AC-ST-DOC-002-1)', async () => {
      const old = await openRegister({ year: 2026 });
      const fresh = await openRegister({ year: 2027 });
      const documentId = await newDocument();
      // 2026-12-31 23:59:59 in Vietnam is still 2026; one second later it is 2027.
      const lastSecond = new Date('2026-12-31T16:59:59Z');
      const firstSecond = new Date('2026-12-31T17:00:00Z');
      expect((await failure(inA((tx) => registers.allocateNumber(tx, allocation(old, documentId, { issuedAt: firstSecond }))))).code).toBe('REGISTER_YEAR_MISMATCH');
      expect((await failure(inA((tx) => registers.allocateNumber(tx, allocation(fresh, documentId, { issuedAt: lastSecond }))))).code).toBe('REGISTER_YEAR_MISMATCH');
      expect((await inA((tx) => registers.findRegister(tx, old.id)))?.lastNumber).toBe(0);
      const issued = await inA((tx) => registers.allocateNumber(tx, allocation(fresh, documentId, { issuedAt: firstSecond })));
      expect(issued.number).toBe(1);
      const [doc] = await harness.owner<{ issued_on: string; number_year: number }>(TENANT_A, [
        ['select issued_on::text as issued_on, number_year from machvon.document where id = $1', [documentId]],
      ]);
      expect(doc).toEqual({ issued_on: '2027-01-01', number_year: 2027 });
    });

    it('refuses a closed register, a mirrored register and an unknown register', async () => {
      const register = await openRegister();
      await inA((tx) => registers.closeRegister(tx, register.id, { expectedVersion: 1, reason: 'year end', actor: ACTOR }));
      const closed = await failure(inA(async (tx) => registers.allocateNumber(tx, allocation(register, await newDocumentIn(tx)))));
      expect(closed.code).toBe('REGISTER_NOT_OPEN');
      const mirrored = await openRegister({ mode: 'MIRRORED' });
      expect((await failure(inA(async (tx) => registers.allocateNumber(tx, allocation(mirrored, await newDocumentIn(tx)))))).code).toBe('REGISTER_MODE_MISMATCH');
      expect((await failure(inA(async (tx) => registers.allocateNumber(tx, allocation({ id: randomUUID(), registerCode: 'X' }, await newDocumentIn(tx)))))).code).toBe('RESOURCE_NOT_FOUND');
    });

    it('refuses a register of another tenant as if it did not exist', async () => {
      const register = await openRegister();
      const outcome = await failure(harness.tenants.withTenant(ctxB, async (tx) => registers.allocateNumber(tx, allocation(register, randomUUID()))));
      expect(outcome.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('refuses a symbol pattern that cannot be filled and rolls the number back', async () => {
      const register = await openRegister();
      const documentId = await newDocument();
      const bad = await failure(inA((tx) => registers.allocateNumber(tx, allocation(register, documentId, { parts: { type: 'QD' } }))));
      expect(bad).toMatchObject({ code: 'SYMBOL_FORMAT_INVALID' });
      expect((await inA((tx) => registers.findRegister(tx, register.id)))?.lastNumber).toBe(0);
    });

    it('allocates 50 numbers from 10 workers as 1..50 without a gap or a duplicate (BR-DOC-04, AC-ST-DOC-002-3, AC-ST-DOC-005-2)', async () => {
      const register = await openRegister();
      const docs = await Promise.all(Array.from({ length: 50 }, () => newDocument()));
      const queue = [...docs];
      const numbers: number[] = [];
      const worker = async (): Promise<void> => {
        for (let documentId = queue.shift(); documentId !== undefined; documentId = queue.shift()) {
          const id = documentId;
          const result = await inA((tx) => registers.allocateNumber(tx, allocation(register, id)));
          numbers.push(result.number);
        }
      };
      await Promise.all(Array.from({ length: 10 }, () => worker()));
      expect([...numbers].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
      expect(await inA((tx) => registers.gaps(tx, register.id))).toEqual([]);
      const entries = await inA((tx) => registers.listEntries(tx, register.id, { limit: 100 }));
      expect(entries).toHaveLength(50);
      expect(new Set(entries.map((entry) => entry.symbol)).size).toBe(50);
      // Each line of the log carries the summary of its document (DOC-10 "Trích yếu").
      expect(new Set(entries.map((entry) => entry.title))).toEqual(new Set(['Decision']));
    }, 60_000);

    it('answers REGISTER_LOCK_TIMEOUT when another transaction holds the register row too long (AC-ST-DOC-002-3)', async () => {
      const register = await openRegister();
      const impatient = new NumberRegisterStore({ lockTimeoutMs: 300 });
      const holder = new Client({ connectionString: harness.database.urlFor('machvon_owner') });
      await holder.connect();
      try {
        await holder.query('begin');
        await holder.query("select set_config('app.tenant_id', $1, true)", [TENANT_A]);
        await holder.query('select id from machvon.document_number_register where id = $1 for update', [register.id]);
        const documentId = await newDocument();
        const outcome = await failure(inA((tx) => impatient.allocateNumber(tx, allocation(register, documentId))));
        expect(outcome.code).toBe('REGISTER_LOCK_TIMEOUT');
      } finally {
        await holder.query('rollback');
        await holder.end();
      }
    });
  });

  describe('closing a register', () => {
    it('stops allocation, needs the current version and cannot be repeated', async () => {
      const register = await openRegister();
      const stale = await failure(inA((tx) => registers.closeRegister(tx, register.id, { expectedVersion: 7, reason: 'x', actor: ACTOR })));
      expect(stale.code).toBe('VERSION_CONFLICT');
      const closed = await inA((tx) => registers.closeRegister(tx, register.id, { expectedVersion: 1, reason: 'year end', actor: ACTOR }));
      expect(closed).toMatchObject({ status: 'CLOSED', version: 2 });
      expect(closed.closedAt).not.toBeNull();
      const again = await failure(inA((tx) => registers.closeRegister(tx, register.id, { expectedVersion: 2, reason: 'again', actor: ACTOR })));
      expect(again.code).toBe('REGISTER_NOT_OPEN');
    });

    it('is refused while a numbered outgoing document of the register is not yet issued', async () => {
      const register = await openRegister();
      const documentId = await newDocument();
      const issued = await inA((tx) => registers.allocateNumber(tx, allocation(register, documentId)));
      const { layoutProfileId } = await inA((tx) => documents.seedDefaults(tx, ACTOR));
      await harness.owner(TENANT_A, [
        [
          `insert into machvon.outgoing_document
             (tenant_id, id, document_id, layout_profile_id, status, drafting_unit_id, drafter_user_id, register_id, allocation_id, leader_signed_at, numbered_at, created_by, updated_by)
           values ($1, gen_random_uuid(), $2, $3, 'NUMBERED', $4, $5, $6, $7, now(), now(), $5, $5)`,
          [TENANT_A, documentId, layoutProfileId, unitId(1), ACTOR, register.id, issued.allocationId],
        ],
      ]);
      const outcome = await failure(inA((tx) => registers.closeRegister(tx, register.id, { expectedVersion: 2, reason: 'year end', actor: ACTOR })));
      expect(outcome.code).toBe('REGISTER_HAS_OPEN_NUMBERED_DOCUMENTS');
      await harness.owner(TENANT_A, [["update machvon.outgoing_document set status = 'ISSUED', sealed_at = now(), issued_at = now() where document_id = $1", [documentId]]]);
      const closed = await inA((tx) => registers.closeRegister(tx, register.id, { expectedVersion: 2, reason: 'year end', actor: ACTOR }));
      expect(closed.status).toBe('CLOSED');
    });
  });

  describe('voiding, entries and gaps (BR-DOC-03)', () => {
    it('voids a number with a reason and a second person, and keeps it in the log (AC-ST-DOC-005-3)', async () => {
      const register = await openRegister();
      const documentId = await newDocument();
      const issued = await inA((tx) => registers.allocateNumber(tx, allocation(register, documentId)));
      const same = await failure(inA((tx) => registers.voidAllocation(tx, issued.allocationId, { reason: 'typo', voidedBy: CLERK, approvedBy: CLERK })));
      expect(same.code).toBe('SELF_APPROVAL_DENIED');
      const voided = await inA((tx) => registers.voidAllocation(tx, issued.allocationId, { reason: 'typo', voidedBy: CLERK, approvedBy: APPROVER }));
      expect(voided.status).toBe('VOIDED');
      const again = await failure(inA((tx) => registers.voidAllocation(tx, issued.allocationId, { reason: 'typo', voidedBy: CLERK, approvedBy: APPROVER })));
      expect(again.code).toBe('DOCUMENT_STATE_INVALID');
      expect(await failure(inA((tx) => registers.voidAllocation(tx, randomUUID(), { reason: 'x', voidedBy: CLERK, approvedBy: APPROVER })))).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      const entries = await inA((tx) => registers.listEntries(tx, register.id, { limit: 10 }));
      expect(entries.map((entry) => [entry.number, entry.status])).toEqual([[1, 'VOIDED']]);
      expect(await inA((tx) => registers.gaps(tx, register.id))).toEqual([]);
      // The next number is 2: a voided number is never reused.
      const next = await inA(async (tx) => registers.allocateNumber(tx, allocation(register, await newDocumentIn(tx))));
      expect(next.number).toBe(2);
      // The document can be numbered again after its number was voided.
      const renumbered = await inA((tx) => registers.allocateNumber(tx, allocation(register, documentId)));
      expect(renumbered.number).toBe(3);
    });

    it('lists entries in number order in keyset pages and keeps them inside the tenant', async () => {
      const register = await openRegister();
      for (let n = 0; n < 5; n += 1) await inA(async (tx) => registers.allocateNumber(tx, allocation(register, await newDocumentIn(tx))));
      const page1 = await inA((tx) => registers.listEntries(tx, register.id, { limit: 2 }));
      expect(page1.map((entry) => entry.number)).toEqual([1, 2]);
      const page2 = await inA((tx) => registers.listEntries(tx, register.id, { limit: 10, afterNumber: 2 }));
      expect(page2.map((entry) => entry.number)).toEqual([3, 4, 5]);
      expect(page2[0]).toMatchObject({ symbol: `03/QD-${register.registerCode}`, issuedOn: '2026-06-15' });
      expect(await harness.tenants.withTenant(ctxB, (tx) => registers.listEntries(tx, register.id, { limit: 10 }))).toEqual([]);
    });

    it('reports a number that is missing from the log (a serious error)', async () => {
      const register = await openRegister();
      for (let n = 0; n < 4; n += 1) await inA(async (tx) => registers.allocateNumber(tx, allocation(register, await newDocumentIn(tx))));
      expect(await inA((tx) => registers.gaps(tx, register.id))).toEqual([]);
      await harness.owner(TENANT_A, [['delete from machvon.document_number_allocation where register_id = $1 and number = 2', [register.id]]]);
      expect(await inA((tx) => registers.gaps(tx, register.id))).toEqual([2]);
    });
  });

  describe('guards of V016 for the application role', () => {
    it('keeps the allocation log append-only', async () => {
      const register = await openRegister();
      await inA(async (tx) => registers.allocateNumber(tx, allocation(register, await newDocumentIn(tx))));
      const statements = [
        "update machvon.document_number_allocation set symbol = 'x' where register_id = $1",
        "update machvon.document_number_allocation set number = 9 where register_id = $1",
        "update machvon.document_number_allocation set status = 'VOIDED', voided_at = now(), voided_by = gen_random_uuid(), void_reason = 'r', void_approved_by = gen_random_uuid(), symbol = 'x' where register_id = $1",
        'delete from machvon.document_number_allocation where register_id = $1',
      ];
      for (const text of statements) expect((await failure(inA((tx) => tx.query(text, [register.id])))).sqlState).toBe('42501');
      expect((await failure(inA((tx) => tx.query('truncate machvon.document_number_allocation')))).sqlState).toBe('42501');
      expect((await failure(inA((tx) => tx.query('truncate machvon.document_number_register')))).sqlState).toBe('42501');
      expect((await failure(inA((tx) => tx.query('delete from machvon.document_number_register where id = $1', [register.id])))).sqlState).toBe('42501');
    });

    it('keeps a register moving forward: no lower counter, no reopening, no new identity', async () => {
      const register = await openRegister();
      await inA(async (tx) => registers.allocateNumber(tx, allocation(register, await newDocumentIn(tx))));
      const attempts: Array<[string, string]> = [
        ['update machvon.document_number_register set last_number = 0 where id = $1', '23514'],
        ['update machvon.document_number_register set year = 2030 where id = $1', '23514'],
        ["update machvon.document_number_register set register_code = 'OTHER' where id = $1", '23514'],
        ["update machvon.document_number_register set direction = 'INCOMING' where id = $1", '23514'],
      ];
      for (const [text, state] of attempts) expect((await failure(inA((tx) => tx.query(text, [register.id])))).sqlState).toBe(state);
      await inA((tx) => registers.closeRegister(tx, register.id, { expectedVersion: 2, reason: 'done', actor: ACTOR }));
      const reopen = await failure(inA((tx) => tx.query("update machvon.document_number_register set status = 'OPEN', closed_at = null where id = $1", [register.id])));
      expect(reopen.sqlState).toBe('23514');
    });
  });

  describe('rollover (BR-DOC-02)', () => {
    it('opens the next year for every open register that has none, once, and leaves closed ones alone (AC-ST-DOC-002-1)', async () => {
      const keep = await openRegister({ year: 2040, registerCode: 'ROLL-KEEP', scopeDocTypes: ['QD', 'CV'] });
      const stop = await openRegister({ year: 2040, registerCode: 'ROLL-STOP' });
      await inA((tx) => registers.closeRegister(tx, stop.id, { expectedVersion: 1, reason: 'retired', actor: ACTOR }));
      const done = await inA((tx) => registers.rollover(tx, { fromYear: 2040, actor: ACTOR }));
      expect(done.map((row) => [row.registerCode, row.year, row.lastNumber, row.status])).toEqual([['ROLL-KEEP', 2041, 0, 'OPEN']]);
      expect(done[0]?.scopeDocTypes).toEqual(['QD', 'CV']);
      expect(done[0]?.organizationUnitId).toBe(keep.organizationUnitId);
      expect(await inA((tx) => registers.rollover(tx, { fromYear: 2040, actor: ACTOR }))).toEqual([]);
    });

    it('is a tenant-wide job under row-level security: it never sees the registers of another tenant', async () => {
      await openRegister({ year: 2050, registerCode: 'ROLL-ONLY-A' });
      expect(await harness.tenants.withTenant(ctxB, (tx) => registers.rollover(tx, { fromYear: 2050, actor: ACTOR }))).toEqual([]);
    });
  });

  describe('document types', () => {
    it('defines a type with a valid symbol pattern, refuses a bad pattern and keeps revisions by start date', async () => {
      const input = {
        code: 'QD',
        name: 'Decision',
        abbreviation: 'QD',
        symbolKind: 'DECISION' as const,
        symbolPattern: '{number}/{type}-{agency}',
        registerCode: 'REG-QD',
        legalBasis: 'ND 30/2020',
        effectiveFrom: '2026-01-01',
        actor: ACTOR,
      };
      const defined = await inA((tx) => documents.defineDocType(tx, input));
      expect(defined).toMatchObject({ code: 'QD', status: 'PUBLISHED', symbolPattern: '{number}/{type}-{agency}', version: 1 });
      expect((await failure(inA((tx) => documents.defineDocType(tx, { ...input, symbolPattern: '{number}a/{type}' })))).code).toBe('SYMBOL_PATTERN_INVALID');
      expect((await failure(inA((tx) => documents.defineDocType(tx, input)))).code).toBe('DOC_TYPE_RANGE_OVERLAP');
      await inA((tx) => documents.defineDocType(tx, { ...input, effectiveFrom: '2027-01-01', symbolPattern: '{number}/{type}' }));
      expect((await failure(inA((tx) => documents.defineDocType(tx, { ...input, effectiveFrom: '2026-06-01' })))).code).toBe('DOC_TYPE_RANGE_OVERLAP');
      const listed = await inA((tx) => documents.listDocTypes(tx));
      expect(listed.filter((row) => row.code === 'QD').map((row) => row.effectiveFrom)).toEqual(['2026-01-01', '2027-01-01']);
      expect(await harness.tenants.withTenant(ctxB, (tx) => documents.listDocTypes(tx))).toEqual([]);
      const at = await inA((tx) => documents.docTypeFor(tx, 'QD', '2026-12-31'));
      expect(at?.symbolPattern).toBe('{number}/{type}-{agency}');
      expect((await inA((tx) => documents.docTypeFor(tx, 'QD', '2027-06-01')))?.symbolPattern).toBe('{number}/{type}');
      expect(await inA((tx) => documents.docTypeFor(tx, 'QD', '2025-12-31'))).toBeUndefined();
    });

    it('serialises two concurrent definitions of a code that does not exist yet, so periods never overlap', async () => {
      const input = {
        code: 'CV-RACE',
        name: 'Official letter',
        abbreviation: 'CV',
        symbolKind: 'OFFICIAL_LETTER' as const,
        symbolPattern: '{number}/{type}-{agency}',
        registerCode: 'REG-CV',
        legalBasis: 'ND 30/2020',
        actor: ACTOR,
      };
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let firstInserted: () => void = () => undefined;
      const inserted = new Promise<void>((resolve) => {
        firstInserted = resolve;
      });
      // The first transaction has inserted its revision and not committed yet when the second one starts.
      const first = inA(async (tx) => {
        const row = await documents.defineDocType(tx, { ...input, effectiveFrom: '2026-01-01', effectiveUntil: '2026-12-31' });
        firstInserted();
        await gate;
        return row;
      });
      await inserted;
      const second = inA((tx) => documents.defineDocType(tx, { ...input, effectiveFrom: '2026-06-01', effectiveUntil: '2027-06-01' }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      release();
      const outcomes = await Promise.allSettled([first, second]);
      expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'rejected']);
      expect(((outcomes[1] as PromiseRejectedResult).reason as { code?: string }).code).toBe('DOC_TYPE_RANGE_OVERLAP');
      const listed = await inA((tx) => documents.listDocTypes(tx));
      expect(listed.filter((row) => row.code === 'CV-RACE').map((row) => row.effectiveFrom)).toEqual(['2026-01-01']);
    });
  });
});

async function newDocumentIn(tx: Parameters<DocumentStore['insertDocument']>[0]): Promise<string> {
  return (await documents.insertDocument(tx, { docKind: 'OUTGOING', docTypeCode: 'QD', title: 'Decision', classification: 'INTERNAL', createdBy: ACTOR })).id;
}
