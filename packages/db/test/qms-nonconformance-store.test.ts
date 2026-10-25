import { randomUUID } from 'node:crypto';
import { QmsNonconformanceStore } from '../src/qms-nonconformance-store';
import type { RaiseInput } from '../src/qms-nonconformance-store';
import type { ContractScopes } from '../src/ctr-contract-store';
import type { TenantTx } from '../src/tenant-database';
import { TENANT_A, contextFor, id, memberId } from './support/authz-fixtures';
import { seedAs } from './support/bid-proposal-fixtures';
import { CapWorld } from './support/cap-fixtures';
import { asSuperuser } from './support/ncr-fixtures';

const world = new CapWorld();
const harness = world.harness;
const ncrs = new QmsNonconformanceStore();
const FAMILY = 0xae;
const SUPERVISOR = 1;
const RESPONSIBLE = 2;
const FIXER = 3;
const SECOND_FIXER = 4;
const VERIFIER = 5;
const CLOSER = 6;
const GONE = 7;
const CONTRACTOR = id(FAMILY, 10);
const DOCUMENT = id(FAMILY, 30);
const CLEAN_VERSION = id(FAMILY, 31);
const DIRTY_VERSION = id(FAMILY, 32);
const NOW = new Date('2026-12-20T03:00:00Z');
const DUE = '2026-12-27T03:00:00Z';
const contractScopes: ContractScopes = { update: () => ({ sql: 'true', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const readOnly: ContractScopes = { update: () => ({ sql: 'false', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const invisible: ContractScopes = { update: () => ({ sql: 'false', params: [] }), read: () => ({ sql: 'false', params: [] }) };
const everything = () => ({ sql: 'true', params: [] as unknown[] });
const nothing = () => ({ sql: 'false', params: [] as unknown[] });

let PROJECT = '';
let counter = 0;

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = SUPERVISOR): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
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

interface Seeded {
  contractId: string;
  diary: string;
  photo: string;
  pendingPhoto: string;
}

/** A contract being performed, with a site diary and two photos (one scanned clean, one not yet). */
async function seedContract(options: { status?: string } = {}): Promise<Seeded> {
  counter += 1;
  const contractId = randomUUID();
  const diary = randomUUID();
  const photo = randomUUID();
  const pendingPhoto = randomUUID();
  const line = await world.publishedLine();
  const code = `HD-N-${String(counter).padStart(4, '0')}`;
  await seedAs(harness, [
    [
      `insert into machvon.contract
         (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd,
          created_by, updated_by, signed_on, effective_from, status_reason, status_decision_document_version_id)
       values ($1, $2, $3, $4, $5, $6, 'UNIT_PRICE', 'VND', $7, 1, 'Contract', 'CONSTRUCTION', false, true, 1000000, $8, $8, date '2026-01-01', date '2026-01-02', $9, $10)`,
      [
        TENANT_A,
        contractId,
        line.projectId,
        randomUUID(),
        CONTRACTOR,
        code,
        options.status ?? 'ACTIVE',
        memberId(SUPERVISOR),
        options.status === 'SUSPENDED' ? 'Stopped.' : null,
        options.status === 'SUSPENDED' ? CLEAN_VERSION : null,
      ],
    ],
    [
      `insert into machvon.site_diary (tenant_id, id, project_id, contract_id, record_date, client_operation_id, content, author_id, version, created_by, updated_by)
       values ($1, $2, $3, $4, date '2026-12-20', gen_random_uuid(), '{}'::jsonb, $5, 1, $5, $5)`,
      [TENANT_A, diary, line.projectId, contractId, memberId(SUPERVISOR)],
    ],
    ...[
      [photo, 'CLEAN'],
      [pendingPhoto, 'PENDING'],
    ].map(([photoId, scan]): [string, unknown[]] => [
      `insert into machvon.site_photo (tenant_id, id, project_id, contract_id, client_operation_id, object_key, file_sha256, scan_status, uploaded_by, created_by)
         values ($1, $2, $3, $4, gen_random_uuid(), 'tenants/qms/photo.jpg', repeat('a', 64), $5, $6, $6)`,
      [TENANT_A, photoId, line.projectId, contractId, scan, memberId(FIXER)],
    ]),
  ]);
  PROJECT = line.projectId;
  return { contractId, diary, photo, pendingPhoto };
}

const input = (seeded: Seeded, overrides: Partial<RaiseInput> = {}): RaiseInput => ({
  contractId: seeded.contractId,
  severity: 'MAJOR',
  title: 'Concrete cover below the drawing',
  description: 'The cover of footing F1 measures 30 mm where the drawing says 50 mm.',
  sourceKind: 'SUPERVISOR_REMARK',
  actionOwnerId: memberId(RESPONSIBLE),
  dueAt: DUE,
  ...overrides,
});
const raise = (seeded: Seeded, overrides: Partial<RaiseInput> = {}, scopes: ContractScopes = contractScopes) => as((tx) => ncrs.raise(tx, input(seeded, overrides), memberId(SUPERVISOR), scopes, NOW));
const assign = (ncrId: string, version: number, overrides: Partial<{ description: string; ownerMembershipId: string; dueAt: string }> = {}, scopes: ContractScopes = contractScopes) =>
  as(
    (tx) => ncrs.assign(tx, ncrId, version, { description: 'Break out and recast the cover', ownerMembershipId: memberId(FIXER), dueAt: DUE, ...overrides }, memberId(RESPONSIBLE), scopes, NOW),
    RESPONSIBLE,
  );
const respond = (actionId: string, member: number, overrides: Partial<{ evidenceDocumentVersionId: string; evidencePhotoId: string; note: string }> = {}, scopes: ContractScopes = contractScopes) =>
  as((tx) => ncrs.submitEvidence(tx, actionId, { evidenceDocumentVersionId: CLEAN_VERSION, note: 'Recast, cover measured at 52 mm.', ...overrides }, memberId(member), scopes, NOW), member);
const verify = (actionId: string, member = VERIFIER, overrides: Partial<{ outcome: string; verificationNote: string }> = {}, scopes: ContractScopes = contractScopes) =>
  as((tx) => ncrs.verify(tx, actionId, { outcome: 'VERIFIED', verificationNote: 'Measured on site, cover is right.', ...overrides }, memberId(member), scopes, NOW), member);
const close = (ncrId: string, version: number, member = CLOSER, note = 'Both actions verified, nothing left to do.', scopes: ContractScopes = contractScopes) =>
  as((tx) => ncrs.close(tx, ncrId, version, note, memberId(member), scopes, NOW), member);
const reopen = (ncrId: string, version: number, reason = 'The cover cracked again after the next pour.', scopes: ContractScopes = contractScopes) =>
  as((tx) => ncrs.reopen(tx, ncrId, version, reason, memberId(CLOSER), scopes, NOW), CLOSER);

const list = (scope: typeof everything, filter: Partial<{ contractId: string; status: string; severity: string; limit: number }> = {}) => as((tx) => ncrs.list(tx, scope, { limit: 50, ...filter }));
const rowOf = async (ncrId: string) =>
  (
    await owner<{
      status: string;
      version: string;
      verified_by: string | null;
      closed_by: string | null;
      closure_note: string | null;
      reopen_count: number;
      reopen_reason: string | null;
      blocks_acceptance: boolean;
      ncr_no: string;
      detected_on: string;
    }>(
      'select status, version::text, verified_by, closed_by, closure_note, reopen_count, reopen_reason, blocks_acceptance, ncr_no, detected_on::text from machvon.quality_nonconformance where id = $1::uuid',
      [ncrId],
    )
  )[0];
const actionRow = async (actionId: string) =>
  (
    await owner<{ status: string; version: string; evidence_note: string | null; submitted_by: string | null; verified_by: string | null; verification_note: string | null }>(
      'select status, version::text, evidence_note, submitted_by, verified_by, verification_note from machvon.corrective_action where id = $1::uuid',
      [actionId],
    )
  )[0];

/** A non-conformance with one action assigned to the fixer, ready for the evidence. */
async function withAction(seeded: Seeded, overrides: Partial<RaiseInput> = {}) {
  const raised = await raise(seeded, overrides);
  const assigned = await assign(raised.id, raised.version);
  return { raised, assigned, ncrId: raised.id, actionId: assigned.action.id };
}

/** A non-conformance whose one action was answered and verified, ready to close. */
async function verified(seeded: Seeded, overrides: Partial<RaiseInput> = {}) {
  const made = await withAction(seeded, overrides);
  await respond(made.actionId, FIXER);
  const done = await verify(made.actionId);
  return { ...made, version: done.version };
}

describe('the non-conformances of work under a contract (ST-QMS-006)', () => {
  beforeAll(async () => {
    await world.start();
    for (const n of [SECOND_FIXER, VERIFIER, CLOSER, GONE]) await harness.seedMembership(TENANT_A, n, 1);
    await owner("update machvon.membership set status = 'Suspended' where id = $1::uuid", [memberId(GONE)]);
    await seedAs(harness, [
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Record', 'INTERNAL', $3, $3)`,
        [TENANT_A, DOCUMENT, memberId(SUPERVISOR)],
      ],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/qms/record.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL'),
                ($1, $4, $3, 2, 'tenants/qms/unscanned.pdf', repeat('b', 64), 'application/pdf', 1, 'INTERNAL', 'PENDING', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, CLEAN_VERSION, DOCUMENT, DIRTY_VERSION],
      ],
    ]);
  }, 240_000);

  afterAll(async () => {
    await world.stop();
  }, 60_000);

  describe('raising', () => {
    it('AC-ST-QMS-006-1, UAT-AC361: raises a non-conformance with the next number of the contract, and holds back the acceptance only when it is critical', async () => {
      const seeded = await seedContract();
      const first = await raise(seeded, { severity: 'CRITICAL', sourceKind: 'SELF_REPORT' });
      expect(first).toMatchObject({
        ncrNo: 'NCR-001',
        status: 'OPEN',
        fromStatus: null,
        version: 1,
        severity: 'CRITICAL',
        blocksAcceptance: true,
        sourceKind: 'SELF_REPORT',
        openActions: 0,
        action: null,
        projectId: PROJECT,
      });
      expect(await rowOf(first.id)).toMatchObject({ status: 'OPEN', ncr_no: 'NCR-001', blocks_acceptance: true, detected_on: '2026-12-20' });

      const second = await raise(seeded, { severity: 'MINOR', sourceKind: 'AUDIT', siteDiaryId: seeded.diary });
      expect(second).toMatchObject({ ncrNo: 'NCR-002', blocksAcceptance: false });
      const other = await seedContract();
      expect(await raise(other)).toMatchObject({ ncrNo: 'NCR-001' });
    });

    it('refuses a non-conformance that is badly formed, from a source that does not match, or that names what is not of the contract', async () => {
      const seeded = await seedContract();
      expect(await refusal(raise(seeded, { severity: 'SEVERE' }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'severity' });
      expect(await refusal(raise(seeded, { sourceKind: 'GOSSIP' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'source_kind' });
      expect(await refusal(raise(seeded, { title: '  ' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'title' });
      expect(await refusal(raise(seeded, { description: 'x'.repeat(2001) }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'description' });
      expect(await refusal(raise(seeded, { contractId: 'not-an-id' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'contract_id' });
      expect(await refusal(raise(seeded, { dueAt: 'next week' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'due_at' });
      expect(await refusal(raise(seeded, { dueAt: '2026-12-19T03:00:00Z' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'due_at', extensions: { reason: 'NOT_IN_THE_FUTURE' } });
      // An inspection is named for an inspection source and for no other.
      expect(await refusal(raise(seeded, { sourceKind: 'INSPECTION' }))).toMatchObject({ detail: 'inspection_id', extensions: { reason: 'REQUIRED_FOR_SOURCE' } });
      expect(await refusal(raise(seeded, { inspectionId: randomUUID() }))).toMatchObject({ detail: 'inspection_id', extensions: { reason: 'NOT_FOR_SOURCE' } });
      expect(await refusal(raise(seeded, { sourceKind: 'MATERIAL_TEST' }))).toMatchObject({ detail: 'material_test_id', extensions: { reason: 'REQUIRED_FOR_SOURCE' } });
      expect(await refusal(raise(seeded, { materialTestId: randomUUID() }))).toMatchObject({ detail: 'material_test_id', extensions: { reason: 'NOT_FOR_SOURCE' } });
      expect(await refusal(raise(seeded, { sourceKind: 'INSPECTION', inspectionId: randomUUID() }))).toMatchObject({ detail: 'inspection_id', extensions: { reason: 'NOT_IN_CONTRACT' } });
      expect(await refusal(raise(seeded, { sourceKind: 'MATERIAL_TEST', materialTestId: randomUUID() }))).toMatchObject({ detail: 'material_test_id', extensions: { reason: 'NOT_IN_CONTRACT' } });
      expect(await refusal(raise(seeded, { measurementId: randomUUID() }))).toMatchObject({ detail: 'measurement_id', extensions: { reason: 'NOT_IN_CONTRACT' } });
      expect(await refusal(raise(seeded, { siteDiaryId: randomUUID() }))).toMatchObject({ detail: 'site_diary_id', extensions: { reason: 'NOT_IN_CONTRACT' } });
      // The person responsible is a member who is active.
      expect(await refusal(raise(seeded, { actionOwnerId: memberId(GONE) }))).toMatchObject({ detail: 'action_owner_id', extensions: { reason: 'NOT_AN_ACTIVE_MEMBER' } });
      expect(await refusal(raise(seeded, { actionOwnerId: randomUUID() }))).toMatchObject({ detail: 'action_owner_id' });
      expect(await owner('select id from machvon.quality_nonconformance where contract_id = $1::uuid', [seeded.contractId])).toEqual([]);
    });

    it('raises only against a contract that is being performed and that the caller can change', async () => {
      const suspended = await seedContract({ status: 'SUSPENDED' });
      expect(await refusal(raise(suspended))).toMatchObject({ code: 'CONTRACT_STATE_INVALID', status: 409, extensions: { contract_status: 'SUSPENDED' } });
      const seeded = await seedContract();
      expect((await refusal(raise(seeded, {}, readOnly))).status).toBeGreaterThanOrEqual(403);
      expect(await refusal(raise(seeded, {}, invisible))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(raise({ ...seeded, contractId: randomUUID() }))).toMatchObject({ status: 404 });
    });
  });

  describe('the actions that put it right', () => {
    it('AC-ST-QMS-006-1, UAT-AC361: assigns actions, and the non-conformance waits for them until each is answered and verified', async () => {
      const seeded = await seedContract();
      const raised = await raise(seeded);
      const first = await assign(raised.id, raised.version);
      expect(first).toMatchObject({ fromStatus: 'OPEN', status: 'ACTION_ASSIGNED', version: 2, openActions: 1, action: { fromStatus: null, status: 'ASSIGNED', version: 1 } });
      const second = await assign(raised.id, first.version, { description: 'Inspect the footings next to F1', ownerMembershipId: memberId(SECOND_FIXER) });
      expect(second).toMatchObject({ fromStatus: 'ACTION_ASSIGNED', status: 'ACTION_ASSIGNED', version: 3, openActions: 2 });

      const answered = await respond(first.action.id, FIXER, { evidencePhotoId: seeded.photo, evidenceDocumentVersionId: undefined });
      expect(answered).toMatchObject({ status: 'ACTION_ASSIGNED', openActions: 2, version: 4, action: { fromStatus: 'ASSIGNED', status: 'SUBMITTED', version: 2 } });
      expect(await actionRow(first.action.id)).toMatchObject({ status: 'SUBMITTED', evidence_note: 'Recast, cover measured at 52 mm.', submitted_by: memberId(FIXER) });
      // Once every action is answered the non-conformance waits for the verification.
      const both = await respond(second.action.id, SECOND_FIXER);
      expect(both).toMatchObject({ status: 'ACTION_SUBMITTED', version: 5 });

      const one = await verify(first.action.id);
      expect(one).toMatchObject({ status: 'ACTION_SUBMITTED', openActions: 1, action: { fromStatus: 'SUBMITTED', status: 'VERIFIED', version: 3 } });
      const all = await verify(second.action.id);
      expect(all).toMatchObject({ fromStatus: 'ACTION_SUBMITTED', status: 'VERIFIED', openActions: 0, version: 7 });
      expect(await rowOf(raised.id)).toMatchObject({ status: 'VERIFIED', verified_by: memberId(VERIFIER), version: '7' });
      expect(await actionRow(first.action.id)).toMatchObject({ status: 'VERIFIED', verified_by: memberId(VERIFIER), verification_note: 'Measured on site, cover is right.' });
    });

    it('refuses an action that is badly formed, for a stranger or for a status that does not take one', async () => {
      const seeded = await seedContract();
      const raised = await raise(seeded);
      expect(await refusal(assign(raised.id, 1, { description: '' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'description' });
      expect(await refusal(assign(raised.id, 1, { ownerMembershipId: 'nobody' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'owner_membership_id' });
      expect(await refusal(assign(raised.id, 1, { ownerMembershipId: memberId(GONE) }))).toMatchObject({ detail: 'owner_membership_id', extensions: { reason: 'NOT_AN_ACTIVE_MEMBER' } });
      expect(await refusal(assign(raised.id, 1, { dueAt: '2026-12-01T00:00:00Z' }))).toMatchObject({ detail: 'due_at', extensions: { reason: 'NOT_IN_THE_FUTURE' } });
      expect(await refusal(assign(raised.id, 9))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(assign(randomUUID(), 1))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect((await refusal(assign(raised.id, 1, {}, readOnly))).status).toBeGreaterThanOrEqual(403);
      expect(await refusal(assign(raised.id, 1, {}, invisible))).toMatchObject({ status: 404 });

      const done = await verified(seeded);
      // A non-conformance verified as a whole takes no more actions.
      expect(await refusal(assign(done.ncrId, done.version))).toMatchObject({ code: 'NCR_STATE_INVALID', status: 409, extensions: { status: 'VERIFIED' } });
      expect(await owner('select id from machvon.corrective_action where nonconformance_id = $1::uuid', [raised.id])).toEqual([]);
    });
  });

  describe('the evidence', () => {
    it('is answered only by the person given the action, with a document that is clean or a photo of the contract that is clean, and a note', async () => {
      const seeded = await seedContract();
      const { actionId, ncrId } = await withAction(seeded);
      expect(await refusal(respond(actionId, SECOND_FIXER))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(respond(actionId, FIXER, { evidenceDocumentVersionId: undefined }))).toMatchObject({ code: 'EVIDENCE_REQUIRED', status: 422 });
      expect(await refusal(respond(actionId, FIXER, { note: ' ' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'note' });
      expect(await refusal(respond(actionId, FIXER, { evidenceDocumentVersionId: DIRTY_VERSION }))).toMatchObject({ code: 'DOCUMENT_NOT_CLEAN', status: 422 });
      expect(await refusal(respond(actionId, FIXER, { evidenceDocumentVersionId: randomUUID() }))).toMatchObject({ detail: 'evidence_document_version_id', extensions: { reason: 'NOT_FOUND' } });
      expect(await refusal(respond(actionId, FIXER, { evidenceDocumentVersionId: undefined, evidencePhotoId: seeded.pendingPhoto }))).toMatchObject({ code: 'FILE_NOT_CLEAN', status: 422 });
      expect(await refusal(respond(actionId, FIXER, { evidenceDocumentVersionId: undefined, evidencePhotoId: (await seedContract()).photo }))).toMatchObject({
        detail: 'evidence_photo_id',
        extensions: { reason: 'NOT_IN_CONTRACT' },
      });
      expect(await refusal(respond(randomUUID(), FIXER))).toMatchObject({ status: 404 });
      expect(await refusal(respond('x', FIXER))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'id' });
      expect(await refusal(respond(actionId, FIXER, {}, invisible))).toMatchObject({ status: 404 });
      expect(await actionRow(actionId)).toMatchObject({ status: 'ASSIGNED' });

      const answered = await respond(actionId, FIXER, { evidencePhotoId: seeded.photo });
      expect(answered.action.status).toBe('SUBMITTED');
      // An action that was answered waits for its verification and takes no second answer.
      expect(await refusal(respond(actionId, FIXER))).toMatchObject({ code: 'CORRECTIVE_ACTION_STATE_INVALID', status: 409, extensions: { status: 'SUBMITTED' } });
      expect((await rowOf(ncrId))?.status).toBe('ACTION_SUBMITTED');
    });
  });

  describe('the verification', () => {
    it('AC-ST-QMS-006-1, UAT-AC361: is by someone other than who carried the action out and who is responsible for the non-conformance, and an action given back is answered again', async () => {
      const seeded = await seedContract();
      const { actionId, ncrId } = await withAction(seeded);
      // An action that was not answered is not verified.
      expect(await refusal(verify(actionId))).toMatchObject({ code: 'CORRECTIVE_ACTION_STATE_INVALID', status: 409, extensions: { status: 'ASSIGNED' } });
      await respond(actionId, FIXER);
      expect(await refusal(verify(actionId, FIXER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(verify(actionId, RESPONSIBLE))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(verify(actionId, VERIFIER, { outcome: 'MAYBE' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'outcome' });
      expect(await refusal(verify(actionId, VERIFIER, { verificationNote: '' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'verification_note' });
      expect((await refusal(verify(actionId, VERIFIER, {}, readOnly))).status).toBeGreaterThanOrEqual(403);

      const rejected = await verify(actionId, VERIFIER, { outcome: 'REJECTED', verificationNote: 'The cover is still 40 mm.' });
      expect(rejected).toMatchObject({ status: 'ACTION_ASSIGNED', openActions: 1, action: { status: 'REJECTED' } });
      expect(await actionRow(actionId)).toMatchObject({ status: 'REJECTED', verified_by: memberId(VERIFIER), verification_note: 'The cover is still 40 mm.' });
      expect(await refusal(verify(actionId))).toMatchObject({ code: 'CORRECTIVE_ACTION_STATE_INVALID', extensions: { status: 'REJECTED' } });

      // The person who carried it out answers again, and the verification is wiped to make room for the next.
      const again = await respond(actionId, FIXER, { note: 'Recast again, cover at 51 mm.' });
      expect(again).toMatchObject({ status: 'ACTION_SUBMITTED', action: { fromStatus: 'REJECTED', status: 'SUBMITTED' } });
      expect(await actionRow(actionId)).toMatchObject({ status: 'SUBMITTED', verified_by: null, verification_note: null, evidence_note: 'Recast again, cover at 51 mm.' });
      expect(await verify(actionId)).toMatchObject({ status: 'VERIFIED' });
      expect((await rowOf(ncrId))?.status).toBe('VERIFIED');
    });
  });

  describe('closing and reopening', () => {
    it('AC-ST-QMS-006-1, UAT-AC361: closes a verified non-conformance by someone who is none of the people who put it right, and reopens it when it comes back', async () => {
      const seeded = await seedContract();
      const { ncrId, version, actionId } = await verified(seeded, { severity: 'CRITICAL' });
      expect(await refusal(close(ncrId, version, RESPONSIBLE))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(close(ncrId, version, FIXER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
      expect(await refusal(close(ncrId, version, CLOSER, ''))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'closure_note' });
      expect(await refusal(close(ncrId, version + 1))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect((await refusal(close(ncrId, version, CLOSER, 'Done.', readOnly))).status).toBeGreaterThanOrEqual(403);

      const closed = await close(ncrId, version);
      expect(closed).toMatchObject({ fromStatus: 'VERIFIED', status: 'CLOSED', version: version + 1, openActions: 0, blocksAcceptance: true });
      expect(await rowOf(ncrId)).toMatchObject({ status: 'CLOSED', closed_by: memberId(CLOSER), closure_note: 'Both actions verified, nothing left to do.' });
      // A closed one is not closed again, nor given an action; it waits to be reopened.
      expect(await refusal(close(ncrId, closed.version))).toMatchObject({ code: 'NCR_STATE_INVALID', status: 409, extensions: { status: 'CLOSED' } });
      expect(await refusal(assign(ncrId, closed.version))).toMatchObject({ code: 'NCR_STATE_INVALID' });
      expect(await refusal(respond(actionId, FIXER))).toMatchObject({ code: 'NCR_STATE_INVALID' });
      expect(await refusal(verify(actionId))).toMatchObject({ code: 'NCR_STATE_INVALID' });

      expect(await refusal(reopen(ncrId, closed.version, ' '))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
      const reopened = await reopen(ncrId, closed.version);
      expect(reopened).toMatchObject({ fromStatus: 'CLOSED', status: 'REOPENED', version: closed.version + 1, openActions: 0 });
      expect(await rowOf(ncrId)).toMatchObject({
        status: 'REOPENED',
        closed_by: null,
        verified_by: null,
        closure_note: null,
        reopen_count: 1,
        reopen_reason: 'The cover cracked again after the next pour.',
      });
      expect(await refusal(reopen(ncrId, reopened.version))).toMatchObject({ code: 'NCR_STATE_INVALID', extensions: { status: 'REOPENED' } });

      // A reopened non-conformance takes a new action, and is closed again once that is verified (the old action stays verified).
      const next = await assign(ncrId, reopened.version, { description: 'Inject the crack', ownerMembershipId: memberId(SECOND_FIXER) });
      expect(next).toMatchObject({ fromStatus: 'REOPENED', status: 'ACTION_ASSIGNED', openActions: 1 });
      await respond(next.action.id, SECOND_FIXER);
      const done = await verify(next.action.id);
      expect(done.status).toBe('VERIFIED');
      expect(await close(ncrId, done.version, CLOSER, 'Closed again.')).toMatchObject({ status: 'CLOSED' });
      expect(await rowOf(ncrId)).toMatchObject({ reopen_count: 1, closure_note: 'Closed again.' });
    });

    it('does not close a non-conformance whose actions are not all verified, nor one that has none', async () => {
      const seeded = await seedContract();
      const bare = await raise(seeded);
      expect(await refusal(close(bare.id, bare.version))).toMatchObject({ code: 'CORRECTIVE_ACTION_OPEN', status: 422, extensions: { open_actions: 0, actions: 0 } });
      const { ncrId, assigned, actionId } = await withAction(seeded);
      expect(await refusal(close(ncrId, assigned.version))).toMatchObject({ code: 'CORRECTIVE_ACTION_OPEN', extensions: { open_actions: 1, actions: 1 } });
      await respond(actionId, FIXER);
      expect(await refusal(close(ncrId, assigned.version + 1))).toMatchObject({ code: 'CORRECTIVE_ACTION_OPEN' });
      expect(await refusal(reopen(ncrId, assigned.version + 1))).toMatchObject({ code: 'NCR_STATE_INVALID', status: 409 });
      expect((await rowOf(ncrId))?.status).toBe('ACTION_SUBMITTED');
    });
  });

  describe('what the database keeps', () => {
    it('lets the status move along the edges only, never deletes, and never changes what a non-conformance is about', async () => {
      const seeded = await seedContract();
      const raised = await raise(seeded);
      const move = (sql: string) => databaseRefusal(owner(sql.replace('$id', `'${raised.id}'`)));
      expect(await move("update machvon.quality_nonconformance set status = 'CLOSED' where id = $id::uuid")).toMatchObject({
        sqlstate: '23514',
        message: expect.stringContaining('NCR_STATE_INVALID'),
      });
      expect(await move("update machvon.quality_nonconformance set status = 'VERIFIED' where id = $id::uuid")).toMatchObject({ sqlstate: '23514' });
      expect(await move("update machvon.quality_nonconformance set severity = 'MINOR' where id = $id::uuid")).toMatchObject({ sqlstate: '23514', message: expect.stringContaining('never changes') });
      expect(await move('update machvon.quality_nonconformance set action_owner_id = gen_random_uuid() where id = $id::uuid')).toMatchObject({ sqlstate: expect.stringMatching(/^23/) });
      expect((await databaseRefusal(as((tx) => tx.query('delete from machvon.quality_nonconformance where id = $1::uuid', [raised.id])))).sqlstate).toBe('42501');

      const { ncrId, actionId } = await verified(seeded);
      const action = (sql: string) => databaseRefusal(owner(sql.replace('$id', `'${actionId}'`)));
      expect(await action("update machvon.corrective_action set status = 'ASSIGNED' where id = $id::uuid")).toMatchObject({
        sqlstate: '23514',
        message: expect.stringContaining('CORRECTIVE_ACTION_STATE_INVALID'),
      });
      expect(await action("update machvon.corrective_action set description = 'Another' where id = $id::uuid")).toMatchObject({ sqlstate: '23514', message: expect.stringContaining('never changes') });
      expect((await databaseRefusal(as((tx) => tx.query('delete from machvon.corrective_action where id = $1::uuid', [actionId])))).sqlstate).toBe('42501');
      expect(
        await databaseRefusal(
          owner(
            `insert into machvon.corrective_action (tenant_id, id, nonconformance_id, description, owner_membership_id, due_at, status) values ($1, gen_random_uuid(), $2::uuid, 'x', $3::uuid, now(), 'VERIFIED')`,
            [TENANT_A, ncrId, memberId(FIXER)],
          ),
        ),
      ).toMatchObject({ sqlstate: '23514', message: expect.stringContaining('an action is assigned first') });
      // A closed non-conformance is closed with its note, and changes only by being reopened.
      expect(
        await databaseRefusal(owner("update machvon.quality_nonconformance set status = 'CLOSED', closed_by = $2::uuid, closed_at = now() where id = $1::uuid", [ncrId, memberId(CLOSER)])),
      ).toMatchObject({ message: expect.stringContaining('with its note') });
      await asSuperuser(harness.database.adminUrl, "update machvon.quality_nonconformance set status = 'CLOSED', closed_by = $2::uuid, closed_at = now(), closure_note = 'x' where id = $1::uuid", [
        ncrId,
        memberId(CLOSER),
      ]);
      expect(await databaseRefusal(owner("update machvon.quality_nonconformance set title = 'again' where id = $1::uuid", [ncrId]))).toMatchObject({
        message: expect.stringContaining('a closed non-conformance is not changed'),
      });
    });
  });

  describe('reading', () => {
    it('lists the non-conformances of the scope with their actions, the newest first, and finds one by its id', async () => {
      const seeded = await seedContract();
      const late = await raise(seeded, { dueAt: '2027-02-01T00:00:00Z', severity: 'MINOR' });
      const early = await withAction(seeded, { dueAt: '2026-12-22T00:00:00Z', severity: 'CRITICAL' });
      await respond(early.actionId, FIXER);

      const lines = await list(everything, { contractId: seeded.contractId });
      expect(lines.map((line) => line.ncrNo)).toEqual(['NCR-002', 'NCR-001']);
      expect(lines[0]).toMatchObject({
        id: early.ncrId,
        status: 'ACTION_SUBMITTED',
        severity: 'CRITICAL',
        blocksAcceptance: true,
        sourceKind: 'SUPERVISOR_REMARK',
        contract: { id: seeded.contractId, status: 'ACTIVE' },
        actionOwner: { membershipId: memberId(RESPONSIBLE) },
        overdue: false,
        reopenCount: 0,
        detectedOn: '2026-12-20',
        reach: { contractId: seeded.contractId, projectId: PROJECT },
      });
      expect(lines[0]?.actions).toEqual([
        expect.objectContaining({
          id: early.actionId,
          status: 'SUBMITTED',
          overdue: false,
          owner: expect.objectContaining({ membershipId: memberId(FIXER) }),
          evidenceNote: 'Recast, cover measured at 52 mm.',
        }),
      ]);
      expect(lines[1]).toMatchObject({ id: late.id, actions: [] });

      expect((await list(everything, { contractId: seeded.contractId, status: 'OPEN' })).map((line) => line.id)).toEqual([late.id]);
      expect((await list(everything, { contractId: seeded.contractId, severity: 'CRITICAL' })).map((line) => line.id)).toEqual([early.ncrId]);
      expect((await list(everything, { contractId: seeded.contractId, limit: 1 })).length).toBe(1);
      // A page ends where the next begins: by the creation time and the id of its last line.
      const [newest] = await list(everything, { contractId: seeded.contractId, limit: 1 });
      const next = await as((tx) => ncrs.list(tx, everything, { contractId: seeded.contractId, limit: 5, after: { code: newest?.createdAt ?? '', id: newest?.id ?? '' } }));
      expect(next.map((line) => line.id)).toEqual([late.id]);
      expect(await refusal(list(everything, { limit: 0 }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'limit' });
      expect(await refusal(as((tx) => ncrs.list(tx, everything, { limit: 5, after: { code: 'not a time', id: late.id } })))).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(await list(nothing, {})).toEqual([]);
      expect(await refusal(list(everything, { status: 'BROKEN' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'status' });
      expect(await refusal(list(everything, { severity: 'BROKEN' }))).toMatchObject({ detail: 'severity' });
      expect(await refusal(list(everything, { contractId: 'nope' }))).toMatchObject({ detail: 'contract_id' });

      expect((await as((tx) => ncrs.find(tx, early.ncrId, everything)))?.ncrNo).toBe('NCR-002');
      expect(await as((tx) => ncrs.find(tx, early.ncrId, nothing))).toBeUndefined();
      expect(await as((tx) => ncrs.find(tx, randomUUID(), everything))).toBeUndefined();
    });

    it('says when a non-conformance and its action are overdue, until they are answered or verified', async () => {
      const seeded = await seedContract();
      const { ncrId, actionId } = await withAction(seeded);
      await asSuperuser(harness.database.adminUrl, "update machvon.quality_nonconformance set due_at = now() - interval '1 day' where id = $1::uuid", [ncrId]);
      await asSuperuser(harness.database.adminUrl, "update machvon.corrective_action set due_at = now() - interval '1 day' where id = $1::uuid", [actionId]);
      const late = await as((tx) => ncrs.find(tx, ncrId, everything));
      expect(late).toMatchObject({ overdue: true, actions: [expect.objectContaining({ overdue: true })] });
      await respond(actionId, FIXER);
      const answered = await as((tx) => ncrs.find(tx, ncrId, everything));
      expect(answered).toMatchObject({ overdue: true, actions: [expect.objectContaining({ overdue: false })] });
      await verify(actionId);
      expect(await as((tx) => ncrs.find(tx, ncrId, everything))).toMatchObject({ overdue: false });
    });
  });
});
