import { randomBytes, randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { BidContractorStore, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { ContractorController, ContractorReadsController } from '../../src/modules/bid/contractor.controller';
import { MockIdentityPort } from '../../src/modules/bid/identity-port';
import { CONTRACTOR_IDENTITY_PORT } from '../../src/modules/bid/tokens';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const MANAGER = 1; // bid.contractor.manage, contractor.read
const VERIFIER = 2; // bid.contractor.verify, bid.contractor.read, contractor.read
const READER = 3; // contractor.read
const NOBODY = 4;
const UNIT_VERIFIER = 5; // bid.contractor.verify over one unit only
const GUEST = 6; // contractor.read, a guest of one contractor
const OTHER_TENANT_MANAGER = 1; // of tenant B
const OTHER_TENANT_VERIFIER = 2; // of tenant B
const TODAY = '2026-10-24';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('contractor registry commands and reads (ST-BID-002)', () => {
  const harness = new AuthzHarness();
  const identity = new MockIdentityPort();
  const guestContractor = randomUUID();
  let app: RunningApp;
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);
  const idOf = (reply: Reply): string => reply.json.resource_id as string;
  const taxId = (): string => {
    counter += 1;
    return `03${String(counter).padStart(8, '0')}`;
  };

  /** A document of the tenant; `effective` makes it a decision in force. */
  async function document(effective = true, tenant = TENANT_A): Promise<string> {
    const documentId = randomUUID();
    await harness.owner(tenant, [
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, symbol, issued_on, effect_status, created_by, updated_by)
         values ($1, $2, 'REFERENCE', 'QD', 'Document', 'INTERNAL', '12/QD', date '2026-01-01', $3, $4, $4)`,
        [tenant, documentId, effective ? 'EFFECTIVE' : 'PENDING', memberId(MANAGER)],
      ],
    ]);
    return documentId;
  }

  const registerBody = async (extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> => ({
    tax_identifier: taxId(),
    legal_name: 'Cty Nha Thau',
    legal_form: 'TNHH',
    profile_document_id: await document(false),
    ...extra,
  });
  const register = async (member = MANAGER, extra: Record<string, unknown> = {}): Promise<Reply> => call('POST', '/contractors', { member, body: await registerBody(extra) });
  const verify = async (member: number, contractorId: string, version: number, decision: 'VERIFIED' | 'REJECTED' = 'VERIFIED'): Promise<Reply> =>
    call('POST', `/contractors/${contractorId}/verification`, { member, ifMatch: `"${version}"`, body: { decision, verification_evidence_document_id: await document(false) } });
  const restrict = async (member: number, contractorId: string, extra: Record<string, unknown> = {}): Promise<Reply> =>
    call('POST', `/contractors/${contractorId}/restrictions`, { member, body: { kind: 'DEBARMENT', effective_from: '2026-01-01', decision_document_id: await document(true), ...extra } });
  const verifiedContractor = async (extra: Record<string, unknown> = {}): Promise<string> => {
    const made = await register(MANAGER, extra);
    await verify(VERIFIER, idOf(made), 1);
    return idOf(made);
  };

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: 1, path: `/${unitId(1)}/` },
        { n: 2, path: `/${unitId(2)}/` },
      ]);
    }
    for (const n of [MANAGER, VERIFIER, READER, NOBODY, UNIT_VERIFIER, GUEST]) await harness.seedMembership(TENANT_A, n, 1);
    for (const n of [OTHER_TENANT_MANAGER, OTHER_TENANT_VERIFIER]) await harness.seedMembership(TENANT_B, n, 1);
    await harness.seedRole(TENANT_A, 1, 'CONTRACTOR_MANAGER', ['bid.contractor.manage', 'contractor.read'], 40);
    await harness.seedRole(TENANT_A, 2, 'CONTRACTOR_VERIFIER', ['bid.contractor.verify', 'bid.contractor.read', 'contractor.read'], 50);
    await harness.seedRole(TENANT_A, 3, 'CONTRACTOR_READER', ['contractor.read'], 20);
    await harness.seedRole(TENANT_A, 4, 'UNIT_VERIFIER', ['bid.contractor.verify', 'contractor.read'], 30);
    await harness.seedRole(TENANT_A, 5, 'GUEST_READER', ['contractor.read'], 10);
    await harness.seedRole(TENANT_B, 1, 'CONTRACTOR_MANAGER', ['bid.contractor.manage', 'contractor.read'], 40);
    await harness.seedRole(TENANT_B, 2, 'CONTRACTOR_VERIFIER', ['bid.contractor.verify', 'contractor.read'], 50);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MANAGER, role: 1, kind: 'TENANT' },
      { n: 2, member: VERIFIER, role: 2, kind: 'TENANT' },
      { n: 3, member: READER, role: 3, kind: 'TENANT' },
      { n: 4, member: UNIT_VERIFIER, role: 4, kind: 'UNIT_ONLY', refs: [unitId(1)] },
      { n: 5, member: GUEST, role: 5, kind: 'CONTRACT', refs: [id(0x99, 1)] },
    ]);
    await harness.seedGrants(TENANT_B, [
      { n: 1, member: OTHER_TENANT_MANAGER, role: 1, kind: 'TENANT' },
      { n: 2, member: OTHER_TENANT_VERIFIER, role: 2, kind: 'TENANT' },
    ]);
    await harness.owner(TENANT_A, [
      [
        "insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id) values ($1, $2, '0100000555', 'Guest Builders', 'VERIFIED', $3)",
        [TENANT_A, guestContractor, await document(false)],
      ],
      ["update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2, valid_until = now() + interval '1 year' where id = $1", [memberId(GUEST), guestContractor]],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [ContractorController, ContractorReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: CONTRACTOR_IDENTITY_PORT, useValue: identity },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  beforeEach(() => {
    identity.adapterStatus = 'MOCK';
    identity.setReachable(true);
  });

  describe('registerContractor', () => {
    it('registers a contractor UNVERIFIED, audits it with the tax id covered, and emits the event without personal data', async () => {
      const body = await registerBody({ tax_identifier: ' 0200000123 ' });
      const made = await call('POST', '/contractors', { member: MANAGER, body });
      expect(made.status).toBe(200);
      expect(made.json).toMatchObject({ status: 'UNVERIFIED', resource_version: 1 });
      const stored = await rows<{ tax_identifier: string; verification_status: string; created_by: string }>('select tax_identifier, verification_status, created_by from machvon.contractor where id = $1', [idOf(made)]);
      expect(stored).toEqual([{ tax_identifier: '0200000123', verification_status: 'UNVERIFIED', created_by: memberId(MANAGER) }]);
      const audit = await rows<{ action: string; diff: Record<string, unknown> }>('select action, safe_diff as diff from machvon.audit_event where resource_id = $1', [idOf(made)]);
      expect(audit).toHaveLength(1);
      expect(audit[0]?.action).toBe('contractor.registered');
      expect(JSON.stringify(audit[0]?.diff)).not.toContain('0200000123');
      expect(audit[0]?.diff).toMatchObject({ tax_identifier: '020****123', legal_form: 'TNHH' });
      const events = await rows<{ type: string; payload: Record<string, unknown> }>('select type, payload from machvon.outbox_event where aggregate_id = $1', [idOf(made)]);
      expect(events.map((event) => event.type)).toEqual(['bid.contractor.registered.v1']);
      expect(JSON.stringify(events[0]?.payload)).not.toContain('0200000123');
      expect(JSON.stringify(events[0]?.payload)).not.toContain('Cty Nha Thau');
    });

    it('takes only the fields of the contract: a representative, a status or a verifier is refused', async () => {
      expect((await register(MANAGER, { representative_name: 'Nguyen Van A' })).json.code).toBe('FIELD_NOT_ALLOWED');
      expect((await register(MANAGER, { verification_status: 'VERIFIED' })).json.code).toBe('FIELD_NOT_ALLOWED');
      expect((await register(MANAGER, { verified_by: memberId(MANAGER) })).json.code).toBe('FIELD_NOT_ALLOWED');
      expect((await register(MANAGER, { profile_document_id: 'nope' })).status).toBe(422);
      expect((await register(MANAGER, { legal_name: 'x' })).status).toBe(422);
    });

    it('refuses a tax id that is not one with 409 TAX_ID_INVALID, and a contractor whose tax id is verified already', async () => {
      const invalid = await register(MANAGER, { tax_identifier: '12345ABCDE' });
      expect([invalid.status, invalid.json.code]).toEqual([409, 'TAX_ID_INVALID']);
      const existing = await verifiedContractor();
      const taxIdentifier = (await rows<{ tax_identifier: string }>('select tax_identifier from machvon.contractor where id = $1', [existing]))[0]?.tax_identifier;
      const again = await register(MANAGER, { tax_identifier: taxIdentifier });
      expect([again.status, again.json.code, again.json.existing_contractor_id]).toEqual([422, 'CONTRACTOR_ALREADY_VERIFIED', existing]);
    });

    it('links the master entry by the tax id, never by the name, and refuses an entry of another key', async () => {
      const taxIdentifier = taxId();
      const entry = randomUUID();
      await rows("insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'CONTRACTOR', $3, 'EFFECTIVE', $4, $4)", [TENANT_A, entry, taxIdentifier, memberId(MANAGER)]);
      const made = await register(MANAGER, { tax_identifier: taxIdentifier, legal_name: 'A name that matches nothing' });
      expect((await rows<{ master_record_id: string }>('select master_record_id from machvon.contractor where id = $1', [idOf(made)]))[0]?.master_record_id).toBe(entry);
      expect((await register(MANAGER, { master_record_id: entry })).json).toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('needs bid.contractor.manage over the whole tenant', async () => {
      expect((await register(READER)).status).toBe(403);
      expect((await register(NOBODY)).status).toBe(403);
      expect((await register(VERIFIER)).status).toBe(403);
      const foreign = await call('POST', '/contractors', { member: OTHER_TENANT_MANAGER, tenantId: TENANT_B, body: await registerBody({ profile_document_id: await document(false, TENANT_B) }) });
      expect(foreign.status).toBe(200);
      expect(await rows('select 1 from machvon.contractor where id = $1', [idOf(foreign)])).toEqual([]);
    });
  });

  describe('verifyContractor', () => {
    it('verifies a contractor on the evidence by someone other than the registrant, and says the basis was a document (the adapter is not bound)', async () => {
      const made = await register();
      const self = await verify(MANAGER, idOf(made), 1);
      expect(self.status).toBe(403);
      const done = await verify(VERIFIER, idOf(made), 1);
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ status: 'VERIFIED', resource_version: 2 });
      const stored = await rows<Record<string, unknown>>(
        'select verification_status, verification_basis, lookup_adapter_status, lookup_outcome, verified_by from machvon.contractor where id = $1',
        [idOf(made)],
      );
      // The mock answered NOT_FOUND and, being a mock, is kept as what it was and does not count.
      expect(stored).toEqual([{ verification_status: 'VERIFIED', verification_basis: 'EVIDENCE_DOCUMENT', lookup_adapter_status: 'MOCK', lookup_outcome: 'NOT_FOUND', verified_by: memberId(VERIFIER) }]);
      const audit = await rows<{ action: string; diff: Record<string, unknown> }>('select action, safe_diff as diff from machvon.audit_event where resource_id = $1 order by occurred_at', [idOf(made)]);
      expect(audit.map((entry) => entry.action)).toEqual(['contractor.registered', 'contractor.verified']);
      expect(audit[1]?.diff).toMatchObject({ decision: 'VERIFIED', verification_basis: 'EVIDENCE_DOCUMENT', identity_lookup: { adapter_status: 'MOCK', outcome: 'NOT_FOUND' } });
      const events = await rows<{ type: string }>('select type from machvon.outbox_event where aggregate_id = $1 order by created_at', [idOf(made)]);
      expect(events.map((event) => event.type)).toEqual(['bid.contractor.registered.v1', 'bid.contractor.verified.v1']);
    });

    it('calls a verification a lookup only when the adapter says VERIFIED and the register says MATCH', async () => {
      const taxIdentifier = taxId();
      identity.register(taxIdentifier, 'Cty Co Trong So').adapterStatus = 'VERIFIED';
      const made = await register(MANAGER, { tax_identifier: taxIdentifier, legal_name: 'cty co trong so' });
      expect((await verify(VERIFIER, idOf(made), 1)).status).toBe(200);
      const stored = await rows<Record<string, unknown>>('select verification_basis, lookup_adapter_status, lookup_outcome from machvon.contractor where id = $1', [idOf(made)]);
      expect(stored).toEqual([{ verification_basis: 'EVIDENCE_DOCUMENT_AND_LOOKUP', lookup_adapter_status: 'VERIFIED', lookup_outcome: 'MATCH' }]);

      // The same answer from an adapter that is PROPOSED is kept as it was and never becomes a lookup verification.
      const other = taxId();
      identity.register(other, 'Cty Hai').adapterStatus = 'PROPOSED';
      const second = await register(MANAGER, { tax_identifier: other, legal_name: 'Cty Hai' });
      expect((await verify(VERIFIER, idOf(second), 1)).status).toBe(200);
      expect(await rows('select verification_basis, lookup_adapter_status, lookup_outcome from machvon.contractor where id = $1', [idOf(second)])).toEqual([
        { verification_basis: 'EVIDENCE_DOCUMENT', lookup_adapter_status: 'PROPOSED', lookup_outcome: 'MATCH' },
      ]);
    });

    it('stops when an adapter that is VERIFIED says the tax id is unknown or is registered under another name, and changes nothing', async () => {
      identity.adapterStatus = 'VERIFIED';
      const unknown = await register();
      const refusedUnknown = await verify(VERIFIER, idOf(unknown), 1);
      expect([refusedUnknown.status, refusedUnknown.json.code]).toEqual([409, 'TAX_ID_INVALID']);
      const taxIdentifier = taxId();
      identity.register(taxIdentifier, 'The Real Name');
      const wrongName = await register(MANAGER, { tax_identifier: taxIdentifier, legal_name: 'Another Name' });
      expect((await verify(VERIFIER, idOf(wrongName), 1)).json.code).toBe('TAX_ID_INVALID');
      expect(await rows("select verification_status, version::int as version from machvon.contractor where id = any($1::uuid[]) order by id", [[idOf(unknown), idOf(wrongName)].sort()])).toEqual([
        { verification_status: 'UNVERIFIED', version: 1 },
        { verification_status: 'UNVERIFIED', version: 1 },
      ]);
    });

    it('verifies on the evidence when the register cannot be reached, and records that it could not be asked', async () => {
      identity.setReachable(false);
      identity.adapterStatus = 'VERIFIED';
      const made = await register();
      expect((await verify(VERIFIER, idOf(made), 1)).status).toBe(200);
      expect(await rows('select verification_basis, lookup_adapter_status, lookup_outcome from machvon.contractor where id = $1', [idOf(made)])).toEqual([
        { verification_basis: 'EVIDENCE_DOCUMENT', lookup_adapter_status: 'VERIFIED', lookup_outcome: 'UNAVAILABLE' },
      ]);
    });

    it('does not write the tax id to the log when the register fails with an error that quotes it', async () => {
      const made = await register();
      const [stored] = await rows<{ tax_identifier: string }>('select tax_identifier from machvon.contractor where id = $1', [idOf(made)]);
      const taxIdentifier = stored?.tax_identifier ?? '';
      expect(taxIdentifier).toMatch(/^\d{10}$/);
      // A real adapter fails with the request it made: its message names the number it asked about.
      const lookup = jest.spyOn(identity, 'lookup').mockRejectedValueOnce(new Error(`GET https://register.example/tax/${taxIdentifier} failed with 502`));
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        expect((await verify(VERIFIER, idOf(made), 1)).status).toBe(200);
        expect(logged).toHaveBeenCalled();
        const written = JSON.stringify(logged.mock.calls.map((call) => call.map((argument) => (argument instanceof Error ? { name: argument.name, message: argument.message, stack: argument.stack } : argument))));
        expect(written).not.toContain(taxIdentifier);
      } finally {
        logged.mockRestore();
        lookup.mockRestore();
      }
    });

    it('rejects a contractor without asking the register, and leaves it rejected for good', async () => {
      identity.adapterStatus = 'VERIFIED';
      const made = await register();
      const rejected = await verify(VERIFIER, idOf(made), 1, 'REJECTED');
      expect(rejected.json).toMatchObject({ status: 'REJECTED', resource_version: 2 });
      expect(await rows('select verification_basis, lookup_outcome from machvon.contractor where id = $1', [idOf(made)])).toEqual([{ verification_basis: null, lookup_outcome: null }]);
      expect((await verify(VERIFIER, idOf(made), 2)).json.code).toBe('STAGE_TRANSITION_DENIED');
      const events = await rows<{ type: string }>('select type from machvon.outbox_event where aggregate_id = $1', [idOf(made)]);
      expect(events.map((event) => event.type)).toEqual(['bid.contractor.registered.v1']);
    });

    it('refuses to verify a second contractor with a tax id that is verified, with an MDM merge suggestion, then blocks a debarred contractor from a proposal and a result (AC-ST-BID-002-1)', async () => {
      const taxIdentifier = taxId();
      const nt2 = await register(MANAGER, { tax_identifier: taxIdentifier, legal_name: 'Cty NT Mot' });
      const nt1 = await register(MANAGER, { tax_identifier: taxIdentifier, legal_name: 'Cty NT Hai' });
      expect((await verify(VERIFIER, idOf(nt1), 1)).status).toBe(200);
      const duplicate = await verify(VERIFIER, idOf(nt2), 1);
      expect([duplicate.status, duplicate.json.code]).toEqual([409, 'TAX_ID_DUPLICATE_VERIFIED']);
      expect(duplicate.json.merge_suggestion).toMatchObject({ target: 'MDM', action: 'MERGE', verified_contractor_id: idOf(nt1), contractor_id: idOf(nt2) });
      expect(JSON.stringify(duplicate.json)).not.toContain(taxIdentifier);
      expect(await rows("select count(*)::int as n from machvon.contractor where tax_identifier = $1 and verification_status = 'VERIFIED'", [taxIdentifier])).toEqual([{ n: 1 }]);

      const nt3 = await verifiedContractor();
      const restricted = await restrict(VERIFIER, nt3, { kind: 'DEBARMENT', effective_from: '2026-01-01', effective_until: '2027-12-31' });
      expect(restricted.status).toBe(200);
      // The registration of a proposal and the submission of a result both ask the registry before they take the contractor in.
      const store = new BidContractorStore();
      const tenants = harness.tenants as TenantDatabase;
      for (const what of ['proposal', 'result']) {
        const refusal = await tenants.withTenant(contextFor(TENANT_A, memberId(MANAGER)), (tx) => store.assertMayTakePart(tx, nt3, TODAY)).catch((error: { code: string; status: number }) => error);
        expect([what, (refusal as { code: string }).code, (refusal as { status: number }).status]).toEqual([what, 'CONTRACTOR_RESTRICTED', 422]);
      }
    });

    it('needs the permission over the whole tenant, the current version, an evidence document and an existing contractor', async () => {
      const made = await register();
      expect((await verify(READER, idOf(made), 1)).status).toBe(403);
      expect((await verify(NOBODY, idOf(made), 1)).status).toBe(403);
      const narrow = await verify(UNIT_VERIFIER, idOf(made), 1);
      expect([narrow.status, narrow.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect((await verify(VERIFIER, idOf(made), 9)).json.code).toBe('VERSION_CONFLICT');
      expect((await verify(VERIFIER, randomUUID(), 1)).json.code).toBe('RESOURCE_NOT_FOUND');
      const noEvidence = await call('POST', `/contractors/${idOf(made)}/verification`, { member: VERIFIER, ifMatch: '"1"', body: { decision: 'VERIFIED', verification_evidence_document_id: randomUUID() } });
      expect([noEvidence.status, noEvidence.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      expect((await call('POST', `/contractors/${idOf(made)}/verification`, { member: VERIFIER, ifMatch: '"1"', body: { decision: 'MAYBE', verification_evidence_document_id: randomUUID() } })).status).toBe(422);
      // A verifier of another tenant does not find the contractor.
      const foreign = await call('POST', `/contractors/${idOf(made)}/verification`, {
        member: OTHER_TENANT_VERIFIER,
        tenantId: TENANT_B,
        ifMatch: '"1"',
        body: { decision: 'VERIFIED', verification_evidence_document_id: await document(false, TENANT_B) },
      });
      expect([foreign.status, foreign.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
    });
  });

  describe('recordContractorRestriction', () => {
    it('records a restriction on a decision in force, and shows it as the restriction in force', async () => {
      const contractor = await verifiedContractor();
      const decision = await document(true);
      const made = await call('POST', `/contractors/${contractor}/restrictions`, {
        member: VERIFIER,
        body: { kind: 'SUSPENSION', effective_from: '2026-01-01', effective_until: '2099-12-31', decision_document_id: decision, note: 'Decision 12/QD' },
      });
      expect(made.json).toMatchObject({ status: 'RECORDED', resource_version: 1 });
      const audit = await rows<{ action: string; diff: Record<string, unknown> }>("select action, safe_diff as diff from machvon.audit_event where action = 'contractor.restriction_recorded' and resource_id = $1", [contractor]);
      expect(audit[0]?.diff).toMatchObject({ restriction_id: idOf(made), kind: 'SUSPENSION', decision_document_id: decision });
      expect(JSON.stringify(audit[0]?.diff)).not.toContain('Decision 12/QD');
      const events = await rows<{ type: string; event_key: string }>("select type, event_key from machvon.outbox_event where aggregate_id = $1 and type = 'bid.contractor.restricted.v1'", [contractor]);
      expect(events).toEqual([{ type: 'bid.contractor.restricted.v1', event_key: `contractor-restriction:${idOf(made)}` }]);
      const line = (await call('GET', `/resources/contractor/${contractor}`, { member: VERIFIER })).json;
      expect(line.restriction_in_force).toMatchObject({ id: idOf(made), kind: 'SUSPENSION', effective_until: '2099-12-31' });
      expect((line.restrictions as Array<Record<string, unknown>>)[0]).toMatchObject({ decision_document_id: decision, note: 'Decision 12/QD' });
    });

    it('refuses a decision that is not in force, and dates, kinds and fields the contract does not allow', async () => {
      const contractor = await verifiedContractor();
      const notInForce = await restrict(VERIFIER, contractor, { decision_document_id: await document(false) });
      expect([notInForce.status, notInForce.json.code]).toEqual([422, 'DECISION_DOCUMENT_NOT_EFFECTIVE']);
      expect((await restrict(VERIFIER, contractor, { decision_document_id: randomUUID() })).json.code).toBe('VALIDATION_FAILED');
      expect((await restrict(VERIFIER, contractor, { kind: 'BAN' })).status).toBe(422);
      expect((await restrict(VERIFIER, contractor, { effective_from: '2026-02-30' })).json.code).toBe('VALIDATION_FAILED');
      expect((await restrict(VERIFIER, contractor, { effective_until: '2025-12-31' })).json.code).toBe('VALIDATION_FAILED');
      expect((await restrict(VERIFIER, contractor, { source: 'NATIONAL_E_PROCUREMENT_IMPORT' })).json.code).toBe('FIELD_NOT_ALLOWED');
      expect((await restrict(VERIFIER, randomUUID())).json.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('needs bid.contractor.verify over the whole tenant and a contractor of the tenant', async () => {
      const contractor = await verifiedContractor();
      expect((await restrict(MANAGER, contractor)).status).toBe(403);
      expect((await restrict(READER, contractor)).status).toBe(403);
      expect((await restrict(UNIT_VERIFIER, contractor)).json.code).toBe('SCOPE_DENIED');
      const foreign = await call('POST', `/contractors/${contractor}/restrictions`, {
        member: OTHER_TENANT_VERIFIER,
        tenantId: TENANT_B,
        body: { kind: 'WARNING', effective_from: '2026-01-01', decision_document_id: await document(true, TENANT_B) },
      });
      expect([foreign.status, foreign.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
    });
  });

  describe('reading the registry', () => {
    it('covers the tax id and leaves out the people and the documents for a reader, and shows them to the holder of bid.contractor.read', async () => {
      const made = await register(MANAGER, { tax_identifier: '0300000999' });
      await verify(VERIFIER, idOf(made), 1);
      const masked = (await call('GET', `/resources/contractor/${idOf(made)}`, { member: READER })).json;
      expect(masked).toMatchObject({ id: idOf(made), tax_identifier: '030****999', tax_identifier_masked: true, verification_status: 'VERIFIED', verification_basis: 'EVIDENCE_DOCUMENT', contract_count: 0, version: 2 });
      expect(masked).not.toHaveProperty('verified_by');
      expect(masked).not.toHaveProperty('profile_document_id');
      expect(masked).not.toHaveProperty('verification_evidence_document_id');
      expect(JSON.stringify(masked)).not.toContain('0300000999');
      const full = (await call('GET', `/resources/contractor/${idOf(made)}`, { member: VERIFIER })).json;
      expect(full).toMatchObject({ tax_identifier: '0300000999', tax_identifier_masked: false, verified_by: memberId(VERIFIER) });
      expect(full).toHaveProperty('profile_document_id');
      expect(full).toHaveProperty('verification_evidence_document_id');
      // A right over one unit is not a right over the registry.
      expect((await call('GET', `/resources/contractor/${idOf(made)}`, { member: UNIT_VERIFIER })).json).toMatchObject({ tax_identifier: '030****999' });
    });

    it('keeps the decision and the note of a restriction from a reader without the full right', async () => {
      const contractor = await verifiedContractor();
      await restrict(VERIFIER, contractor, { note: 'Names a person', effective_until: '2099-01-01' });
      const detail = (await call('GET', `/resources/contractor/${contractor}`, { member: READER })).json;
      const restriction = (detail.restrictions as Array<Record<string, unknown>>)[0];
      expect(restriction).toMatchObject({ kind: 'DEBARMENT', source: 'DECISION', effective_from: '2026-01-01', effective_until: '2099-01-01' });
      expect(restriction).not.toHaveProperty('note');
      expect(restriction).not.toHaveProperty('decision_document_id');
      expect(detail.restriction_in_force).toMatchObject({ kind: 'DEBARMENT' });
    });

    it('lists the newest first in pages with the restriction in force, and lists nothing of another tenant', async () => {
      const first = await verifiedContractor();
      const second = await verifiedContractor();
      await restrict(VERIFIER, first, { kind: 'WARNING', effective_until: '2099-01-01' });
      const page = await call('GET', '/resources/contractor?limit=2', { member: READER });
      const items = page.json.items as Array<Record<string, unknown>>;
      expect(items.map((item) => item.id)).toEqual([second, first]);
      expect(items[1]?.restriction_in_force).toMatchObject({ kind: 'WARNING' });
      expect(items[0]?.restriction_in_force).toBeNull();
      expect(typeof page.json.as_of).toBe('string');
      const next = await call('GET', `/resources/contractor?limit=2&cursor=${page.json.next_cursor as string}`, { member: READER });
      expect((next.json.items as Array<Record<string, unknown>>).map((item) => item.id)).not.toContain(first);
      const foreign = await call('GET', '/resources/contractor', { member: OTHER_TENANT_MANAGER, tenantId: TENANT_B });
      expect((foreign.json.items as Array<Record<string, unknown>>).map((item) => item.id)).not.toContain(first);
      expect((await call('GET', `/resources/contractor/${first}`, { member: OTHER_TENANT_MANAGER, tenantId: TENANT_B })).status).toBe(404);
    });

    it('shows a guest contractor the contractor of the invitation and nobody else', async () => {
      const other = await verifiedContractor();
      const list = await call('GET', '/resources/contractor', { member: GUEST });
      expect((list.json.items as Array<Record<string, unknown>>).map((item) => item.id)).toEqual([guestContractor]);
      expect((list.json.items as Array<Record<string, unknown>>)[0]).toMatchObject({ tax_identifier: '010****555', tax_identifier_masked: true });
      expect((await call('GET', `/resources/contractor/${guestContractor}`, { member: GUEST })).status).toBe(200);
      expect((await call('GET', `/resources/contractor/${other}`, { member: GUEST })).status).toBe(404);
      expect((await call('GET', `/resources/contractor/${randomUUID()}`, { member: GUEST })).status).toBe(404);
    });

    it('refuses a caller without contractor.read and a page request that is not well formed', async () => {
      expect((await call('GET', '/resources/contractor', { member: NOBODY })).status).toBe(403);
      expect((await call('GET', `/resources/contractor/${guestContractor}`, { member: NOBODY })).status).toBe(403);
      expect((await call('GET', '/resources/contractor?limit=0', { member: READER })).status).toBe(422);
      expect((await call('GET', '/resources/contractor?cursor=nope', { member: READER })).status).toBe(422);
      expect((await call('GET', '/resources/contractor/not-a-uuid', { member: READER })).status).toBe(422);
    });
  });
});
