import { randomUUID } from 'node:crypto';
import { applyBaseline, sealPack } from '../src/master-baseline';
import type { BaselineEntry } from '../src/master-baseline';
import { QmsAcceptanceStore } from '../src/qms-acceptance-store';
import type { SignInput } from '../src/qms-acceptance-store';
import { QmsInspectionStore } from '../src/qms-inspection-store';
import type { ContractScopes } from '../src/ctr-contract-store';
import type { TenantTx } from '../src/tenant-database';
import { TENANT_A, contextFor, id, memberId } from './support/authz-fixtures';
import { seedAs } from './support/bid-proposal-fixtures';
import { CapWorld } from './support/cap-fixtures';
import { ncrStatement } from './support/ncr-fixtures';

const world = new CapWorld();
const harness = world.harness;
const inspections = new QmsInspectionStore();
const acceptances = new QmsAcceptanceStore();
const FAMILY = 0xae;
const REQUESTER = 1;
/** Drafts the minutes and signs as the supervisor. */
const SUPERVISOR = 2;
const FIRST = 3;
/** Signs as the contractor: a guest of the contractor of the contract. */
const GUEST = 4;
/** Signs as the owner and approves. */
const OWNER = 5;
const DESIGNER = 6;
/** A guest of another firm. */
const STRANGER = 7;
const CONTRACTOR = id(FAMILY, 10);
const OTHER_FIRM = id(FAMILY, 11);
const DOCUMENT = id(FAMILY, 30);
const VERSION = id(FAMILY, 31);
const DIRTY = id(FAMILY, 32);
const NOW = new Date('2026-12-20T03:00:00Z');
const contractScopes: ContractScopes = { update: () => ({ sql: 'true', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const readOnly: ContractScopes = { update: () => ({ sql: 'false', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const invisible: ContractScopes = { update: () => ({ sql: 'false', params: [] }), read: () => ({ sql: 'false', params: [] }) };
const everything = () => ({ sql: 'true', params: [] as unknown[] });
const nothing = () => ({ sql: 'false', params: [] as unknown[] });

let counter = 0;
let ncr = 0;

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = REQUESTER): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string; extensions?: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

const databaseRefusal = async (work: Promise<unknown>): Promise<{ message: string; sqlstate: string }> => {
  try {
    await work;
  } catch (error) {
    const e = error as { message: string; code?: string };
    return { message: e.message, sqlstate: e.code ?? '' };
  }
  throw new Error('expected the database to refuse');
};

const regime = (key: string, validFrom: string, roles: string[]): BaselineEntry => ({
  masterType: 'QMS_REGIME',
  businessKey: key,
  label: `Regime ${key}`,
  attributes: {
    owner_module: 'QMS',
    awaiting_confirmation: true,
    cxn: 'CXN-07',
    required_roles: roles,
    completion_required_roles: [...roles, 'DESIGNER'].filter((role, index, all) => all.indexOf(role) === index),
    checklists: [
      { inspection_type: 'CONCEALED_WORK', items: [{ code: 'A', label: 'Rebar to drawing' }, { code: 'B', label: 'Concrete cover' }] },
      { inspection_type: 'COMPLETION', items: [{ code: 'C', label: 'Works complete' }] },
      { inspection_type: 'CONSTRUCTION_STAGE', items: [{ code: 'S', label: 'Stage complete' }] },
    ],
  },
  validFrom,
  legalBasis: 'Decree fixture',
});

interface Seeded {
  contractId: string;
  projectId: string;
  item: string;
}

async function seedContract(status = 'ACTIVE'): Promise<Seeded> {
  counter += 1;
  const contractId = randomUUID();
  const item = randomUUID();
  const line = await world.publishedLine();
  await seedAs(harness, [
    [
      `insert into machvon.contract
         (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd,
          created_by, updated_by, signed_on, effective_from, status_reason, status_decision_document_version_id)
       values ($1, $2, $3, $4, $5, $6, 'UNIT_PRICE', 'VND', $7, 1, 'Contract', 'OTHER', false, true, 1000000, $8, $8, date '2026-01-01', date '2026-01-02', $9, $10)`,
      [TENANT_A, contractId, line.projectId, randomUUID(), CONTRACTOR, `HD-Q-${String(counter).padStart(4, '0')}`, status, memberId(REQUESTER), status === 'SUSPENDED' ? 'Stopped.' : null, status === 'SUSPENDED' ? VERSION : null],
    ],
    [`insert into machvon.boq_item (tenant_id, id, contract_id, business_key, description, unit_code, created_by, updated_by) values ($1, $2, $3, 'B01', 'Earthwork', 'M3', $4, $4)`, [TENANT_A, item, contractId, memberId(REQUESTER)]],
  ]);
  return { contractId, projectId: line.projectId, item };
}

const PASSED = [
  { code: 'A', outcome: 'PASS' },
  { code: 'B', outcome: 'PASS' },
];

/** An inspection of the contract whose result is recorded: PASS unless said, with a checklist that fits the kind. */
async function inspected(seeded: Seeded, options: { type?: string; result?: string; checklist?: unknown[]; stop?: 'REQUESTED' | 'SCHEDULED' } = {}): Promise<string> {
  const type = options.type ?? 'CONCEALED_WORK';
  const requested = await as((tx) => inspections.request(tx, { contractId: seeded.contractId, boqItemId: seeded.item, inspectionType: type, title: `Inspection ${counter}`, requestedFor: '2026-12-30' }, memberId(REQUESTER), contractScopes, NOW));
  if (options.stop === 'REQUESTED') return requested.id;
  const scheduled = await as((tx) => inspections.schedule(tx, requested.id, 1, { scheduledAt: '2026-12-28T02:00:00Z', participantMembershipIds: [memberId(FIRST)] }, memberId(SUPERVISOR), contractScopes, NOW), SUPERVISOR);
  if (options.stop === 'SCHEDULED') return scheduled.id;
  const checklist = options.checklist ?? (type === 'COMPLETION' ? [{ code: 'C', outcome: 'PASS' }] : type === 'CONSTRUCTION_STAGE' ? [{ code: 'S', outcome: 'PASS' }] : PASSED);
  const result = options.result ?? 'PASS';
  const answers = result === 'PASS' ? checklist : (checklist as Array<{ code: string; outcome: string }>).map((answer, index) => (index === 0 ? { ...answer, outcome: 'FAIL', note: 'Condition: add the missing cover.' } : answer));
  await as((tx) => inspections.record(tx, requested.id, 2, { result, resultNote: 'Result recorded.', checklist: answers }, memberId(SUPERVISOR), contractScopes, NOW), SUPERVISOR);
  return requested.id;
}

const create = (inspectionId: string, overrides: Partial<{ acceptanceScope: string; recordNo: string; documentVersionId: string }> = {}, options: { scopes?: ContractScopes; member?: number } = {}) =>
  as(
    (tx) => acceptances.create(tx, inspectionId, { acceptanceScope: 'WORK_ITEM', recordNo: `QA-W-${String(++ncr).padStart(3, '0')}`, documentVersionId: VERSION, ...overrides }, memberId(options.member ?? SUPERVISOR), options.scopes ?? contractScopes),
    options.member ?? SUPERVISOR,
  );
const sign = (minutesId: string, version: number, role: string, member: number, overrides: Partial<SignInput> = {}, scopes: ContractScopes = contractScopes) =>
  as((tx) => acceptances.sign(tx, minutesId, version, { signerRole: role, signatureMethod: 'IN_APP_OTP', clientOperationId: randomUUID(), ...overrides }, memberId(member), scopes, NOW), member);
const decide = (minutesId: string, version: number, decision: string, member: number, reason = 'All the roles have signed.', scopes: ContractScopes = contractScopes) =>
  as((tx) => acceptances.decide(tx, minutesId, version, { decision, reason }, memberId(member), scopes, NOW), member);
const revoke = (minutesId: string, version: number, reason = 'The work was found to be defective.', member = OWNER, scopes: ContractScopes = contractScopes) =>
  as((tx) => acceptances.revoke(tx, minutesId, version, reason, memberId(member), scopes, NOW), member);
const rowOf = async (minutesId: string) =>
  (
    await owner<{ status: string; version: string; content_hash: string; required_roles: string[]; regime_awaiting_confirmation: boolean; regime_cxn: string | null; decision_note: string | null; approved_by: string | null; revoke_reason: string | null }>(
      'select status, version::text, content_hash, required_roles, regime_awaiting_confirmation, regime_cxn, decision_note, approved_by, revoke_reason from machvon.quality_acceptance where id = $1::uuid',
      [minutesId],
    )
  )[0];
const signaturesOf = (minutesId: string) =>
  owner<{ signer_role: string; membership_id: string; method: string; legal_effect: string; cert_serial: string | null; signed_content_hash: string; signer_name_snapshot: string }>(
    "select signer_role, membership_id, method, legal_effect, cert_serial, signed_content_hash, signer_name_snapshot from machvon.qms_signature where subject_kind = 'QUALITY_ACCEPTANCE' and subject_id = $1::uuid order by signed_at, created_at, id",
    [minutesId],
  );

/** Minutes that every required role signed: drafted by the supervisor, signed by the contractor, the supervisor and the owner. */
async function signedByAll(seeded: Seeded): Promise<{ id: string; version: number; inspectionId: string }> {
  const inspectionId = await inspected(seeded);
  const drafted = await create(inspectionId);
  const first = await sign(drafted.id, 1, 'CONTRACTOR', GUEST);
  const second = await sign(drafted.id, first.version, 'SUPERVISOR', SUPERVISOR);
  const third = await sign(drafted.id, second.version, 'OWNER', OWNER);
  return { id: drafted.id, version: third.version, inspectionId };
}

const openCritical = async (seeded: Seeded, status = 'OPEN') => {
  const nid = randomUUID();
  await seedAs(harness, [
    [
      `insert into machvon.quality_nonconformance (tenant_id, id, project_id, contract_id, severity, action_owner_id, due_at, status, closure_evidence, blocks_acceptance)
       values ($1, $2, $3, $4, 'CRITICAL', $5, now() + interval '7 days', $6, '[]'::jsonb, true)`,
      [TENANT_A, nid, seeded.projectId, seeded.contractId, memberId(REQUESTER), status],
    ],
  ]);
  return nid;
};

/** Moves a non-conformance to a status; a closed one was verified by someone other than the owner of the action. */
const ncrStatus = (nid: string, status: string) =>
  ncrStatement(
    harness.database.adminUrl,
    `update machvon.quality_nonconformance
        set status = $2, verified_by = case when $2 = 'CLOSED' then $3::uuid end, closed_by = case when $2 = 'CLOSED' then $3::uuid end, closed_at = case when $2 = 'CLOSED' then now() end,
            closure_note = case when $2 = 'CLOSED' then 'closed for the test' end
      where id = $1::uuid`,
    [nid, status, memberId(FIRST)],
  );

describe('the quality acceptance minutes of an inspection (ST-QMS-005)', () => {
  beforeAll(async () => {
    await world.start();
    for (const n of [GUEST, OWNER, DESIGNER, STRANGER]) await harness.seedMembership(TENANT_A, n, 1);
    await seedAs(harness, [
      [`update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2, valid_until = now() + interval '1 year' where id = $1`, [memberId(GUEST), CONTRACTOR]],
      [`update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2, valid_until = now() + interval '1 year' where id = $1`, [memberId(STRANGER), OTHER_FIRM]],
      [`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Minutes', 'INTERNAL', $3, $3)`, [TENANT_A, DOCUMENT, memberId(REQUESTER)]],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/qms/minutes.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL'),
                ($1, $4, $3, 2, 'tenants/qms/unscanned.pdf', repeat('b', 64), 'application/pdf', 1, 'INTERNAL', 'PENDING', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, VERSION, DOCUMENT, DIRTY],
      ],
    ]);
    await owner("update machvon.master_record_version set published_at = null where master_type = 'QMS_REGIME' and code in ('ND-06-2021', 'ND-207-2026')");
    await as((tx) => applyBaseline(tx, sealPack('QMS-ACCEPTANCE-FIXTURE', [regime('REG-QA-1', '2026-01-01', ['CONTRACTOR', 'SUPERVISOR', 'OWNER'])]), memberId(REQUESTER), '2026-06-01'));
  }, 240_000);

  afterAll(async () => {
    await world.stop();
  }, 60_000);

  describe('drafting the minutes', () => {
    it('AC-ST-QMS-005-1, UAT-AC360: drafts minutes from an inspection that passed, with the roles of the regime and the hash the signers will sign', async () => {
      const seeded = await seedContract();
      const inspectionId = await inspected(seeded);
      const drafted = await create(inspectionId, { recordNo: ' QA-W-001 ' });
      expect(drafted).toMatchObject({ recordNo: 'QA-W-001', status: 'DRAFT', fromStatus: null, version: 1, acceptanceScope: 'WORK_ITEM', requiredRoles: ['CONTRACTOR', 'SUPERVISOR', 'OWNER'], missingRoles: ['CONTRACTOR', 'SUPERVISOR', 'OWNER'], regimeAwaitingConfirmation: true, inspectionId, boqItemId: seeded.item });
      const row = await rowOf(drafted.id);
      expect(row).toMatchObject({ status: 'DRAFT', required_roles: ['CONTRACTOR', 'SUPERVISOR', 'OWNER'], regime_awaiting_confirmation: true, regime_cxn: 'CXN-07', approved_by: null });
      expect(row?.content_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('takes an inspection that passed with a condition, and the roles of the completion include the designer', async () => {
      const seeded = await seedContract();
      expect((await create(await inspected(seeded, { result: 'CONDITIONAL' }))).status).toBe('DRAFT');
      const completion = await create(await inspected(seeded, { type: 'COMPLETION' }), { acceptanceScope: 'COMPLETION' });
      expect(completion.requiredRoles).toEqual(['CONTRACTOR', 'SUPERVISOR', 'OWNER', 'DESIGNER']);
    });

    it('refuses an inspection that did not pass: a failed result, one that has no result yet', async () => {
      const seeded = await seedContract();
      expect(await refusal(create(await inspected(seeded, { result: 'FAIL' })))).toMatchObject({ code: 'INSPECTION_NOT_PASSED', status: 422, extensions: { inspection_status: 'RESULT_RECORDED', inspection_result: 'FAIL' } });
      expect(await refusal(create(await inspected(seeded, { stop: 'SCHEDULED' })))).toMatchObject({ code: 'INSPECTION_NOT_PASSED', extensions: { inspection_status: 'SCHEDULED', inspection_result: null } });
      expect(await owner('select 1 from machvon.quality_acceptance where contract_id = $1::uuid', [seeded.contractId])).toEqual([]);
    });

    it('drafts minutes of a scope only from the kind of inspection that covers it', async () => {
      const seeded = await seedContract();
      const concealed = await inspected(seeded);
      for (const scope of ['STAGE', 'PART', 'COMPLETION']) expect(await refusal(create(concealed, { acceptanceScope: scope }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'acceptance_scope' });
      const stage = await inspected(seeded, { type: 'CONSTRUCTION_STAGE' });
      expect((await create(stage, { acceptanceScope: 'STAGE' })).acceptanceScope).toBe('STAGE');
    });

    it('refuses a contract that is not being performed, a serious non-conformance that is open, and a paper that is not a clean file', async () => {
      const seeded = await seedContract();
      const inspectionId = await inspected(seeded);
      expect(await refusal(create(inspectionId, { documentVersionId: DIRTY }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'document_version_id' });
      expect(await refusal(create(inspectionId, { documentVersionId: randomUUID() }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'document_version_id' });
      const blocking = await openCritical(seeded);
      expect(await refusal(create(inspectionId))).toMatchObject({ code: 'OPEN_CRITICAL_NCR', status: 422, extensions: { nonconformance_ids: [blocking] } });
      await ncrStatus(blocking, 'CLOSED');
      expect((await create(inspectionId)).status).toBe('DRAFT');
      const other = await seedContract();
      const otherInspection = await inspected(other);
      await owner("update machvon.contract set status = 'SUSPENDED', status_reason = 'Stopped.', status_decision_document_version_id = $2::uuid where id = $1::uuid", [other.contractId, VERSION]);
      expect(await refusal(create(otherInspection))).toMatchObject({ code: 'CONTRACT_STATE_INVALID', status: 409 });
    });

    it('keeps one live set of minutes for an inspection, and a number once for the contract', async () => {
      const seeded = await seedContract();
      const inspectionId = await inspected(seeded);
      const first = await create(inspectionId, { recordNo: 'QA-DUP' });
      expect(await refusal(create(inspectionId))).toMatchObject({ code: 'QUALITY_ACCEPTANCE_STATE_INVALID', status: 409, extensions: { reason: 'ALREADY_DRAFTED' } });
      const second = await inspected(seeded);
      expect(await refusal(create(second, { recordNo: 'QA-DUP' }))).toMatchObject({ code: 'QUALITY_ACCEPTANCE_STATE_INVALID', extensions: { reason: 'RECORD_NO_USED' } });
      expect(first.status).toBe('DRAFT');
    });

    it('refuses a shape that is not one, an inspection that is not there, and a caller outside the scope of the contract', async () => {
      const seeded = await seedContract();
      const inspectionId = await inspected(seeded);
      const refused = async (overrides: Partial<{ acceptanceScope: string; recordNo: string; documentVersionId: string }>) => (await refusal(create(inspectionId, overrides))).detail;
      expect(await refused({ acceptanceScope: 'ROOM' })).toBe('acceptance_scope');
      expect(await refused({ recordNo: '  ' })).toBe('record_no');
      expect(await refused({ recordNo: 'x'.repeat(2001) })).toBe('record_no');
      expect(await refused({ documentVersionId: 'nope' })).toBe('document_version_id');
      expect(await refusal(create(randomUUID()))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(create('nope'))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'id' });
      expect(await refusal(create(inspectionId, {}, { scopes: readOnly }))).toMatchObject({ status: 403 });
      expect(await refusal(create(inspectionId, {}, { scopes: invisible }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await owner('select 1 from machvon.quality_acceptance where contract_id = $1::uuid', [seeded.contractId])).toEqual([]);
    });
  });

  describe('signing', () => {
    it('AC-ST-QMS-005-1, UAT-AC360: a role signs over the hash of the minutes; the first signature starts the signing', async () => {
      const seeded = await seedContract();
      const drafted = await create(await inspected(seeded));
      const first = await sign(drafted.id, 1, 'CONTRACTOR', GUEST);
      expect(first).toMatchObject({ status: 'SIGNING', fromStatus: 'DRAFT', version: 2, signerRole: 'CONTRACTOR', signatureMethod: 'IN_APP_OTP', legalEffect: 'INTERNAL_RECORD', missingRoles: ['SUPERVISOR', 'OWNER'] });
      const second = await sign(drafted.id, first.version, 'SUPERVISOR', SUPERVISOR);
      expect(second).toMatchObject({ status: 'SIGNING', fromStatus: 'SIGNING', version: 3, missingRoles: ['OWNER'] });
      const row = await rowOf(drafted.id);
      const signatures = await signaturesOf(drafted.id);
      expect(signatures.map((signature) => [signature.signer_role, signature.membership_id, signature.signed_content_hash])).toEqual([
        ['CONTRACTOR', memberId(GUEST), row?.content_hash],
        ['SUPERVISOR', memberId(SUPERVISOR), row?.content_hash],
      ]);
      expect(signatures[0]?.signer_name_snapshot).not.toBe('');
    });

    it('BR-QMS-03: only a certificate is a legal electronic signature, and it carries its serial', async () => {
      const seeded = await seedContract();
      const drafted = await create(await inspected(seeded));
      expect(await refusal(sign(drafted.id, 1, 'SUPERVISOR', SUPERVISOR, { signatureMethod: 'DIGITAL_CERT' }))).toMatchObject({ code: 'SIGNATURE_METHOD_NOT_ACCEPTED', status: 422 });
      expect(await refusal(sign(drafted.id, 1, 'SUPERVISOR', SUPERVISOR, { signatureMethod: 'IN_APP_OTP', certSerial: 'SN-0099' }))).toMatchObject({ code: 'SIGNATURE_METHOD_NOT_ACCEPTED' });
      expect(await refusal(sign(drafted.id, 1, 'SUPERVISOR', SUPERVISOR, { signatureMethod: 'FAX' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'signature_method' });
      const signed = await sign(drafted.id, 1, 'SUPERVISOR', SUPERVISOR, { signatureMethod: 'DIGITAL_CERT', certSerial: 'SN-0099' });
      expect(signed).toMatchObject({ signatureMethod: 'DIGITAL_CERT', legalEffect: 'LEGAL_E_SIGNATURE' });
      expect((await signaturesOf(drafted.id))[0]).toMatchObject({ method: 'DIGITAL_CERT', legal_effect: 'LEGAL_E_SIGNATURE', cert_serial: 'SN-0099' });
      const webauthn = await sign(drafted.id, signed.version, 'OWNER', OWNER, { signatureMethod: 'IN_APP_WEBAUTHN' });
      expect(webauthn.legalEffect).toBe('INTERNAL_RECORD');
    });

    it('refuses a role the minutes do not require, and a role that is not the signer to sign', async () => {
      const seeded = await seedContract();
      const drafted = await create(await inspected(seeded));
      expect(await refusal(sign(drafted.id, 1, 'DESIGNER', DESIGNER))).toMatchObject({ code: 'ROLE_NOT_REQUIRED', status: 422, extensions: { required_roles: ['CONTRACTOR', 'SUPERVISOR', 'OWNER'] } });
      expect(await refusal(sign(drafted.id, 1, 'TESTING_LAB', DESIGNER))).toMatchObject({ code: 'ROLE_NOT_REQUIRED' });
      // The staff does not sign for the contractor, the contractor does not sign for the owner, and a guest of another firm signs for no one.
      expect(await refusal(sign(drafted.id, 1, 'CONTRACTOR', SUPERVISOR))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(sign(drafted.id, 1, 'OWNER', GUEST))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(sign(drafted.id, 1, 'CONTRACTOR', STRANGER))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      expect(await signaturesOf(drafted.id)).toEqual([]);
      expect((await rowOf(drafted.id))?.status).toBe('DRAFT');
    });

    it('AC-ST-QMS-005-1, UAT-AC360: a role signs once over the same hash, and a person signs once', async () => {
      const seeded = await seedContract();
      const drafted = await create(await inspected(seeded));
      const first = await sign(drafted.id, 1, 'SUPERVISOR', SUPERVISOR);
      expect(await refusal(sign(drafted.id, first.version, 'SUPERVISOR', FIRST))).toMatchObject({ code: 'ALREADY_SIGNED', status: 409, extensions: { signer_role: 'SUPERVISOR' } });
      expect(await refusal(sign(drafted.id, first.version, 'OWNER', SUPERVISOR))).toMatchObject({ code: 'ALREADY_SIGNED', status: 409 });
      const operation = randomUUID();
      const owned = await sign(drafted.id, first.version, 'OWNER', OWNER, { clientOperationId: operation });
      expect(await refusal(sign(drafted.id, owned.version, 'CONTRACTOR', GUEST, { clientOperationId: operation }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'client_operation_id' });
      expect(await refusal(sign(drafted.id, owned.version, 'CONTRACTOR', GUEST, { clientOperationId: 'x' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'client_operation_id' });
      expect(await signaturesOf(drafted.id)).toHaveLength(2);
    });

    it('judges the version and the state of the minutes, and the scope of the contract', async () => {
      const seeded = await seedContract();
      const drafted = await create(await inspected(seeded));
      expect(await refusal(sign(drafted.id, 7, 'SUPERVISOR', SUPERVISOR))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(sign(randomUUID(), 1, 'SUPERVISOR', SUPERVISOR))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(sign(drafted.id, 1, 'SUPERVISOR', SUPERVISOR, {}, readOnly))).toMatchObject({ status: 403 });
      expect(await refusal(sign(drafted.id, 1, 'SUPERVISOR', SUPERVISOR, {}, invisible))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      const all = await signedByAll(seeded);
      const approved = await decide(all.id, all.version, 'approve', OWNER);
      expect(await refusal(sign(all.id, approved.version, 'OWNER', DESIGNER))).toMatchObject({ code: 'QUALITY_ACCEPTANCE_STATE_INVALID', status: 409, extensions: { acceptance_status: 'APPROVED' } });
    });

    it('BR-QMS-02: a signature over other content is refused by the database, and a signature is kept as it is', async () => {
      const seeded = await seedContract();
      const drafted = await create(await inspected(seeded));
      await sign(drafted.id, 1, 'SUPERVISOR', SUPERVISOR);
      const insert = (hash: string, role: string, kind = 'QUALITY_ACCEPTANCE') =>
        owner(
          `insert into machvon.qms_signature (tenant_id, id, subject_kind, subject_id, signer_role, membership_id, signer_name_snapshot, method, legal_effect, signed_content_hash, signed_at, client_operation_id, created_by)
           values ($1, gen_random_uuid(), $5, $2, $3, $6, 'Someone', 'IN_APP_OTP', 'INTERNAL_RECORD', $4, now(), gen_random_uuid(), $6)`,
          [TENANT_A, drafted.id, role, hash, kind, memberId(OWNER)],
        );
      expect((await databaseRefusal(insert('c'.repeat(64), 'OWNER'))).sqlstate).toBe('23514');
      expect((await databaseRefusal(insert((await rowOf(drafted.id))?.content_hash ?? '', 'DESIGNER'))).sqlstate).toBe('23514');
      const app = (sql: string, params: unknown[] = []) => as((tx) => tx.query(sql, params));
      expect((await databaseRefusal(app("update machvon.qms_signature set signer_role = 'OWNER' where subject_id = $1::uuid", [drafted.id]))).sqlstate).toBe('42501');
      expect((await databaseRefusal(app('delete from machvon.qms_signature where subject_id = $1::uuid', [drafted.id]))).sqlstate).toBe('42501');
      expect(await signaturesOf(drafted.id)).toHaveLength(1);
    });
  });

  describe('deciding', () => {
    it('AC-ST-QMS-005-1, UAT-AC360: is refused with two signatures, and approved once every role has signed and the owner approves', async () => {
      const seeded = await seedContract();
      const inspectionId = await inspected(seeded);
      const drafted = await create(inspectionId);
      const first = await sign(drafted.id, 1, 'CONTRACTOR', GUEST);
      const second = await sign(drafted.id, first.version, 'SUPERVISOR', SUPERVISOR);
      expect(await refusal(decide(drafted.id, second.version, 'approve', OWNER))).toMatchObject({ code: 'SIGNATURES_INCOMPLETE', status: 422, extensions: { missing_roles: ['OWNER'] } });
      expect((await rowOf(drafted.id))?.status).toBe('SIGNING');
      const third = await sign(drafted.id, second.version, 'OWNER', OWNER);
      const approved = await decide(drafted.id, third.version, 'approve', OWNER, ' Reviewed on site. ');
      expect(approved).toMatchObject({ status: 'APPROVED', fromStatus: 'SIGNING', version: third.version + 1, missingRoles: [], inspectionId });
      expect(await rowOf(drafted.id)).toMatchObject({ status: 'APPROVED', approved_by: memberId(OWNER), decision_note: 'Reviewed on site.' });
    });

    it('does not let whoever drafted the minutes approve them', async () => {
      const seeded = await seedContract();
      const all = await signedByAll(seeded);
      expect(await refusal(decide(all.id, all.version, 'approve', SUPERVISOR))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect((await rowOf(all.id))?.status).toBe('SIGNING');
      expect((await decide(all.id, all.version, 'approve', OWNER)).status).toBe('APPROVED');
    });

    it('UAT-AC361: refuses approval while a serious non-conformance of the contract is open, even for minutes that are only drafted', async () => {
      const seeded = await seedContract();
      const all = await signedByAll(seeded);
      const blocking = await openCritical(seeded, 'ACTION_ASSIGNED');
      expect(await refusal(decide(all.id, all.version, 'approve', OWNER))).toMatchObject({ code: 'OPEN_CRITICAL_NCR', status: 422, extensions: { nonconformance_ids: [blocking] } });
      expect((await rowOf(all.id))?.status).toBe('SIGNING');
      // Minutes that are only drafted are refused for it too: the open non-conformance is judged before the state.
      await ncrStatus(blocking, 'CLOSED');
      const drafted = await create(await inspected(seeded));
      await ncrStatus(blocking, 'REOPENED');
      expect(await refusal(decide(drafted.id, 1, 'approve', OWNER))).toMatchObject({ code: 'OPEN_CRITICAL_NCR' });
      await ncrStatus(blocking, 'CLOSED');
      expect((await decide(all.id, all.version, 'approve', OWNER)).status).toBe('APPROVED');
      expect(await refusal(decide(drafted.id, 1, 'approve', OWNER))).toMatchObject({ code: 'QUALITY_ACCEPTANCE_STATE_INVALID', status: 409 });
    });

    it('refuses to approve on a contract that is no longer being performed', async () => {
      const seeded = await seedContract();
      const all = await signedByAll(seeded);
      await owner("update machvon.contract set status = 'SUSPENDED', status_reason = 'Stopped.', status_decision_document_version_id = $2::uuid where id = $1::uuid", [seeded.contractId, VERSION]);
      expect(await refusal(decide(all.id, all.version, 'approve', OWNER))).toMatchObject({ code: 'CONTRACT_STATE_INVALID', status: 409 });
    });

    it('rejects minutes with the reason, keeps them, and lets the inspection be drafted anew', async () => {
      const seeded = await seedContract();
      const inspectionId = await inspected(seeded);
      const drafted = await create(inspectionId);
      const first = await sign(drafted.id, 1, 'CONTRACTOR', GUEST);
      expect(await refusal(decide(drafted.id, first.version, 'reject', OWNER, '  '))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
      expect(await refusal(decide(drafted.id, first.version, 'maybe', OWNER))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'decision' });
      const rejected = await decide(drafted.id, first.version, 'reject', OWNER, 'The paper is the wrong one.');
      expect(rejected).toMatchObject({ status: 'REJECTED', fromStatus: 'SIGNING' });
      expect(await rowOf(drafted.id)).toMatchObject({ status: 'REJECTED', decision_note: 'The paper is the wrong one.' });
      expect(await refusal(decide(drafted.id, rejected.version, 'reject', OWNER))).toMatchObject({ code: 'QUALITY_ACCEPTANCE_STATE_INVALID' });
      expect((await create(inspectionId)).status).toBe('DRAFT');
    });

    it('keeps the database to the same rules: the edges of the status, the approval and who approves', async () => {
      const seeded = await seedContract();
      const all = await signedByAll(seeded);
      const bump = (set: string) => owner(`update machvon.quality_acceptance set ${set} where id = $1::uuid`, [all.id]);
      expect((await databaseRefusal(bump("status = 'DRAFT'"))).sqlstate).toBe('23514');
      expect((await databaseRefusal(bump("status = 'REVOKED'"))).sqlstate).toBe('23514');
      expect((await databaseRefusal(bump("record_no = 'CHANGED'"))).sqlstate).toBe('23514');
      expect((await databaseRefusal(bump(`content_hash = '${'d'.repeat(64)}'`))).sqlstate).toBe('23514');
      expect((await databaseRefusal(bump(`status = 'APPROVED', decision_note = 'ok', approved_at = now(), approved_by = created_by`))).sqlstate).toBe('23514');
      await decide(all.id, all.version, 'approve', OWNER);
      expect((await databaseRefusal(bump("decision_note = 'changed'"))).sqlstate).toBe('23514');
      expect((await databaseRefusal(bump("status = 'SIGNING'"))).sqlstate).toBe('23514');
      expect((await databaseRefusal(as((tx) => tx.query('delete from machvon.quality_acceptance where id = $1::uuid', [all.id])))).sqlstate).toBe('42501');
    });
  });

  describe('revoking', () => {
    const approvedMinutes = async (seeded: Seeded) => {
      const all = await signedByAll(seeded);
      const approved = await decide(all.id, all.version, 'approve', OWNER);
      return { ...all, version: approved.version };
    };

    it('AC-ST-QMS-005-2, UAT-PLAN-27: withdraws approved minutes with the reason, which keeps them, and the inspection can be drafted anew', async () => {
      const seeded = await seedContract();
      const approved = await approvedMinutes(seeded);
      expect(await refusal(revoke(approved.id, approved.version, '  '))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
      const revoked = await revoke(approved.id, approved.version, ' The work was found to be defective. ');
      expect(revoked).toMatchObject({ status: 'REVOKED', fromStatus: 'APPROVED', version: approved.version + 1 });
      expect(await rowOf(approved.id)).toMatchObject({ status: 'REVOKED', revoke_reason: 'The work was found to be defective.', approved_by: memberId(OWNER) });
      expect(await refusal(revoke(approved.id, revoked.version))).toMatchObject({ code: 'QUALITY_ACCEPTANCE_STATE_INVALID', status: 409, extensions: { acceptance_status: 'REVOKED' } });
      expect((await create(approved.inspectionId)).status).toBe('DRAFT');
    });

    it('refuses to withdraw minutes that an approved acceptance of work holds, and withdraws them once it does not', async () => {
      const seeded = await seedContract();
      const approved = await approvedMinutes(seeded);
      const acceptanceId = randomUUID();
      await seedAs(harness, [
        [
          `insert into machvon.acceptance (tenant_id, id, contract_id, measurement_ids, document_version_id, approved_at, signer_refs, status, version, accepted_amount_vnd, quality_acceptance_id, decided_by, submitted_by, submitted_at, decision_reason)
           values ($1, $2, $3, jsonb_build_array(gen_random_uuid()::text), $4, now(), '[]'::jsonb, 'APPROVED', 1, 100, $5, $6, $7, now(), 'ok')`,
          [TENANT_A, acceptanceId, seeded.contractId, VERSION, approved.id, memberId(FIRST), memberId(REQUESTER)],
        ],
      ]);
      expect(await refusal(revoke(approved.id, approved.version))).toMatchObject({ code: 'ACCEPTANCE_ALREADY_USED', status: 409, extensions: { acceptance_id: acceptanceId } });
      expect((await rowOf(approved.id))?.status).toBe('APPROVED');
      await seedAs(harness, [["update machvon.acceptance set status = 'REVOKED', revoked_at = now(), revoked_by = $2::uuid, revoke_reason = 'Withdrawn.', revoke_approval_document_version_id = $3::uuid where id = $1::uuid", [acceptanceId, memberId(OWNER), VERSION]]]);
      expect((await revoke(approved.id, approved.version)).status).toBe('REVOKED');
    });

    it('revokes only approved minutes, under the version and the scope', async () => {
      const seeded = await seedContract();
      const drafted = await create(await inspected(seeded));
      expect(await refusal(revoke(drafted.id, 1))).toMatchObject({ code: 'QUALITY_ACCEPTANCE_STATE_INVALID', status: 409 });
      const approved = await approvedMinutes(await seedContract());
      expect(await refusal(revoke(approved.id, 1))).toMatchObject({ code: 'VERSION_CONFLICT' });
      expect(await refusal(revoke(approved.id, approved.version, 'x', OWNER, readOnly))).toMatchObject({ status: 403 });
      expect(await refusal(revoke(approved.id, approved.version, 'x', OWNER, invisible))).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });
  });

  describe('reading the minutes', () => {
    it('lists the minutes of the scope with the signatures, the missing roles, the warning of the regime and what the viewer may sign', async () => {
      const seeded = await seedContract();
      const inspectionId = await inspected(seeded);
      const drafted = await create(inspectionId, { recordNo: 'QA-READ' });
      const signed = await sign(drafted.id, 1, 'CONTRACTOR', GUEST);
      const blocking = await openCritical(seeded);
      const asViewer = (member: number, scope = everything) => as((tx) => acceptances.list(tx, scope, memberId(member), { contractId: seeded.contractId }), member);
      const [line] = await asViewer(SUPERVISOR);
      expect(line).toMatchObject({
        id: drafted.id,
        recordNo: 'QA-READ',
        contract: { id: seeded.contractId, status: 'ACTIVE' },
        inspection: { id: inspectionId, inspectionType: 'CONCEALED_WORK', result: 'PASS' },
        boqItem: { id: seeded.item, businessKey: 'B01' },
        acceptanceScope: 'WORK_ITEM',
        status: 'SIGNING',
        requiredRoles: ['CONTRACTOR', 'SUPERVISOR', 'OWNER'],
        missingRoles: ['SUPERVISOR', 'OWNER'],
        openCriticalNcr: 1,
        regime: { awaitingConfirmation: true, cxn: 'CXN-07', legalBasis: 'Decree fixture' },
        viewerSignableRoles: ['SUPERVISOR', 'OWNER'],
        version: signed.version,
        documentVersionId: VERSION,
      });
      expect(line?.signatures).toEqual([expect.objectContaining({ role: 'CONTRACTOR', membershipId: memberId(GUEST), method: 'IN_APP_OTP', legalEffect: 'INTERNAL_RECORD', valid: true })]);
      // The contractor who has signed, a guest of another firm and the contractor's view of a role already signed.
      expect((await asViewer(GUEST))[0]?.viewerSignableRoles).toEqual([]);
      expect((await asViewer(STRANGER))[0]?.viewerSignableRoles).toEqual([]);
      expect(await asViewer(SUPERVISOR, nothing)).toEqual([]);
      await ncrStatus(blocking, 'CLOSED');
      expect((await asViewer(OWNER))[0]?.openCriticalNcr).toBe(0);
    });

    it('finds one set of minutes by its id inside the scope only, and filters by inspection', async () => {
      const seeded = await seedContract();
      const inspectionId = await inspected(seeded);
      const drafted = await create(inspectionId);
      const found = await as((tx) => acceptances.find(tx, drafted.id, everything, memberId(OWNER)), OWNER);
      expect(found).toMatchObject({ id: drafted.id, status: 'DRAFT', viewerSignableRoles: ['SUPERVISOR', 'OWNER'] });
      expect(await as((tx) => acceptances.find(tx, drafted.id, nothing, memberId(OWNER)), OWNER)).toBeUndefined();
      expect(await as((tx) => acceptances.find(tx, randomUUID(), everything, memberId(OWNER)), OWNER)).toBeUndefined();
      expect((await as((tx) => acceptances.list(tx, everything, memberId(OWNER), { inspectionId }), OWNER)).map((line) => line.id)).toEqual([drafted.id]);
      expect(await as((tx) => acceptances.list(tx, everything, memberId(OWNER), { inspectionId: randomUUID() }), OWNER)).toEqual([]);
    });

    it('shows a signature over other content as void', async () => {
      const seeded = await seedContract();
      const drafted = await create(await inspected(seeded));
      await sign(drafted.id, 1, 'SUPERVISOR', SUPERVISOR);
      // The database refuses a later change of the hash, so the only way to void a signature is to read it against another hash: the owner role bypasses the guard in this test only.
      await owner('alter table machvon.quality_acceptance disable trigger quality_acceptance_guard');
      try {
        await owner(`update machvon.quality_acceptance set content_hash = '${'e'.repeat(64)}' where id = $1::uuid`, [drafted.id]);
        const [line] = await as((tx) => acceptances.list(tx, everything, memberId(OWNER), { contractId: seeded.contractId }), OWNER);
        expect(line?.signatures[0]?.valid).toBe(false);
        expect(line?.missingRoles).toEqual(['CONTRACTOR', 'SUPERVISOR', 'OWNER']);
        // Nothing is signed or approved on minutes whose hash is no longer the hash of what they say.
        expect(await refusal(sign(drafted.id, 2, 'OWNER', OWNER))).toMatchObject({ code: 'QUALITY_ACCEPTANCE_STATE_INVALID', extensions: { reason: 'CONTENT_CHANGED' } });
      } finally {
        await owner('alter table machvon.quality_acceptance enable trigger quality_acceptance_guard');
      }
    });
  });
});
