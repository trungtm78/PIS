import { randomUUID } from 'node:crypto';
import { AstHandoverStore } from '../src/ast-handover-store';
import type { AddItemInput, CreateInput, DecisionInput, HandoverScopes } from '../src/ast-handover-store';
import type { ContractScopes } from '../src/ctr-contract-store';
import type { TenantTx } from '../src/tenant-database';
import { TENANT_A, contextFor, id, memberId, unitId } from './support/authz-fixtures';
import { seedAs, seedContractor } from './support/bid-proposal-fixtures';
import { CapWorld } from './support/cap-fixtures';
import { asSuperuser } from './support/ncr-fixtures';

const world = new CapWorld();
const harness = world.harness;
const handovers = new AstHandoverStore();
const FAMILY = 0xb2;
const DRAFTER = 1; // drafts the handover and puts the defects on the list
const CHECKER = 2; // verifies, waives and accepts: none of the above is the drafter
const GUEST = 4; // the contractor
const OTHER_GUEST = 5; // another contractor
const RECEIVER = 7; // the unit that receives the work
const DOCUMENT = id(FAMILY, 30);
const CLEAN = id(FAMILY, 31);
const PENDING = id(FAMILY, 32);
const AS_BUILT = id(FAMILY, 33);
const MANUAL = id(FAMILY, 34);
const CERTIFICATE = id(FAMILY, 35);
const NOW = new Date('2026-12-20T03:00:00Z');
const DUE = '2026-12-31';
const everything: ContractScopes = { update: () => ({ sql: 'true', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const readOnly: HandoverScopes = { update: () => ({ sql: 'false', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const invisible: HandoverScopes = { update: () => ({ sql: 'false', params: [] }), read: () => ({ sql: 'false', params: [] }) };
const all: HandoverScopes = everything;
const allRows = () => ({ sql: 'true', params: [] as unknown[] });
const noRows = () => ({ sql: 'false', params: [] as unknown[] });

let counter = 0;
let contractor = '';
let otherContractor = '';

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = DRAFTER): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);
const stage = (sql: string, params: unknown[] = []): Promise<void> => asSuperuser(harness.database.adminUrl, sql, params);

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
  projectId: string;
  completion: string;
  photo: string;
  pendingPhoto: string;
}

/** A contract of a project with capital in force, its approved completion minutes and two photos (one scanned clean, one not yet). */
async function seedContract(status = 'ACTIVE'): Promise<Seeded> {
  counter += 1;
  const contractId = randomUUID();
  const photo = randomUUID();
  const pendingPhoto = randomUUID();
  const completion = randomUUID();
  const line = await world.publishedLine();
  await seedAs(harness, [
    [
      `insert into machvon.contract
         (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd,
          created_by, updated_by, signed_on, effective_from, status_reason, status_decision_document_version_id)
       values ($1, $2, $3, $4, $5, $6, 'UNIT_PRICE', 'VND', $7, 1, 'Contract', 'CONSTRUCTION', false, true, 1000000, $8, $8, date '2026-01-02', date '2026-01-03', $9, $10)`,
      [
        TENANT_A,
        contractId,
        line.projectId,
        randomUUID(),
        contractor,
        `HD-B-${String(counter).padStart(4, '0')}`,
        status === 'COMPLETED' ? 'ACTIVE' : status,
        memberId(DRAFTER),
        status === 'SUSPENDED' ? 'Stopped.' : null,
        status === 'SUSPENDED' ? CLEAN : null,
      ],
    ],
    ...[
      [photo, 'CLEAN'],
      [pendingPhoto, 'PENDING'],
    ].map(([photoId, scan]): [string, unknown[]] => [
      `insert into machvon.site_photo (tenant_id, id, project_id, contract_id, client_operation_id, object_key, file_sha256, scan_status, uploaded_by, created_by)
         values ($1, $2, $3, $4, gen_random_uuid(), 'tenants/ast/photo-' || $2::uuid::text || '.jpg', repeat('a', 64), $5, $6, $6)`,
      [TENANT_A, photoId, line.projectId, contractId, scan, memberId(GUEST)],
    ]),
  ]);
  await stage(
    `insert into machvon.quality_acceptance
       (tenant_id, id, project_id, contract_id, inspection_id, record_no, acceptance_scope, document_version_id, status, required_roles, content_hash, created_by, updated_by, version, approved_at, approved_by, decision_note)
     values ($1, $2, $3, $4, $5, $6, 'COMPLETION', $7, 'APPROVED', '["CONTRACTOR","SUPERVISOR","OWNER"]'::jsonb, repeat('a', 64), $8, $8, 1, timestamptz '2026-12-10T03:00:00Z', $9, 'Approved for the test.')`,
    [TENANT_A, completion, line.projectId, contractId, randomUUID(), `QA-H-${completion.slice(0, 8)}`, CLEAN, memberId(DRAFTER), memberId(CHECKER)],
  );
  if (status === 'COMPLETED') {
    await stage("update machvon.contract set status = 'COMPLETED', completed_on = date '2026-12-15', completion_quality_acceptance_id = $2::uuid, completed_by = $3::uuid where id = $1::uuid", [
      contractId,
      completion,
      memberId(CHECKER),
    ]);
  }
  return { contractId, projectId: line.projectId, completion, photo, pendingPhoto };
}

const input = (target: Seeded, overrides: Partial<CreateInput> = {}): CreateInput => ({
  projectId: target.projectId,
  contractId: target.contractId,
  recipientUnitId: unitId(RECEIVER),
  handoverKind: 'COMPLETION',
  handoverNo: `BG-${++counter}`,
  qualityAcceptanceId: target.completion,
  plannedOn: '2026-12-28',
  documentVersionId: CLEAN,
  ...overrides,
});
const create = (target: Seeded, overrides: Partial<CreateInput> = {}, scopes: ContractScopes = everything) =>
  as((tx) => handovers.create(tx, input(target, overrides), memberId(DRAFTER), scopes, NOW));
const item = (overrides: Partial<AddItemInput> = {}): AddItemInput => ({ description: 'The paint of the east wall peels.', severity: 'MAJOR', dueOn: DUE, ...overrides });
const add = (handoverId: string, version: number, overrides: Partial<AddItemInput> = {}, scopes: HandoverScopes = all) =>
  as((tx) => handovers.addItem(tx, handoverId, version, item(overrides), memberId(DRAFTER), scopes, NOW));
const fix = (itemId: string, overrides: Partial<{ evidencePhotoId: string; evidenceDocumentVersionId: string; note: string }> = {}, member = GUEST, scopes: HandoverScopes = all) =>
  as((tx) => handovers.markFixed(tx, itemId, { note: 'Repainted and checked.', ...overrides }, memberId(member), scopes), member);
const verify = (itemId: string, outcome = 'VERIFIED', member = CHECKER, scopes: HandoverScopes = all) =>
  as((tx) => handovers.verify(tx, itemId, { outcome, note: 'Checked on site.' }, memberId(member), scopes, NOW), member);
const waive = (itemId: string, member = CHECKER, scopes: HandoverScopes = all) =>
  as((tx) => handovers.waive(tx, itemId, { waiverReason: 'Cosmetic, accepted by the receiving unit.' }, memberId(member), scopes), member);
const decide = (handoverId: string, version: number, overrides: Partial<DecisionInput> = {}, member = CHECKER, scopes: HandoverScopes = all) =>
  as(
    (tx) => handovers.decide(tx, handoverId, version, { decision: 'approve', reason: 'Accepted.', evidenceIds: [], asBuiltDocumentVersionId: AS_BUILT, ...overrides }, memberId(member), scopes, NOW),
    member,
  );

const rowOf = async (handoverId: string) =>
  (
    await owner<{
      status: string;
      version: string;
      open_critical_punch_count: number;
      punch_list: Array<{ item_no: number; severity: string; status: string }>;
      accepted_by: string | null;
      as_built_document_version_id: string | null;
      handed_on: string | null;
      decision_note: string | null;
      rejection_reason: string | null;
    }>(
      'select status, version::text, open_critical_punch_count, punch_list, accepted_by, as_built_document_version_id, handed_on::text, decision_note, rejection_reason from machvon.handover where id = $1::uuid',
      [handoverId],
    )
  )[0];
const itemRow = async (itemId: string) =>
  (
    await owner<{
      status: string;
      severity: string;
      fixed_by: string | null;
      verified_by: string | null;
      reopen_count: number;
      evidence_photo_id: string | null;
      defect_photo_id: string | null;
      waiver_approved_by: string | null;
      version: string;
    }>('select status, severity, fixed_by, verified_by, reopen_count, evidence_photo_id, defect_photo_id, waiver_approved_by, version::text from machvon.handover_punch_item where id = $1::uuid', [
      itemId,
    ])
  )[0];

/** A handover with one critical item that was put right and verified, ready to be accepted. */
async function ready(target: Seeded) {
  const drafted = await create(target);
  const first = await add(drafted.id, 1, { severity: 'CRITICAL', description: 'The railing of the stair is loose.' });
  await fix(first.item?.id ?? '', { evidencePhotoId: target.photo });
  const verified = await verify(first.item?.id ?? '');
  return { id: drafted.id, itemId: first.item?.id ?? '', version: verified.version };
}

describe('the handover of a work and its punch list (ST-AST-001)', () => {
  beforeAll(async () => {
    await world.start();
    await harness.seedUnits(TENANT_A, [{ n: RECEIVER, path: `/${unitId(RECEIVER)}/` }]);
    for (const n of [GUEST, OTHER_GUEST]) await harness.seedMembership(TENANT_A, n, 1);
    contractor = await seedContractor(harness);
    otherContractor = await seedContractor(harness);
    await owner("update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2::uuid, valid_until = now() + interval '1 year' where id = $1::uuid", [
      memberId(GUEST),
      contractor,
    ]);
    await owner("update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2::uuid, valid_until = now() + interval '1 year' where id = $1::uuid", [
      memberId(OTHER_GUEST),
      otherContractor,
    ]);
    await seedAs(harness, [
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Record', 'INTERNAL', $3, $3)`,
        [TENANT_A, DOCUMENT, memberId(DRAFTER)],
      ],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/ast/minutes.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL'),
                ($1, $4, $3, 2, 'tenants/ast/unscanned.pdf', repeat('b', 64), 'application/pdf', 1, 'INTERNAL', 'PENDING', '{}'::jsonb, 'RENDERED_FINAL'),
                ($1, $5, $3, 3, 'tenants/ast/as-built.pdf', repeat('c', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL'),
                ($1, $6, $3, 4, 'tenants/ast/manual.pdf', repeat('d', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL'),
                ($1, $7, $3, 5, 'tenants/ast/certificate.pdf', repeat('e', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, CLEAN, DOCUMENT, PENDING, AS_BUILT, MANUAL, CERTIFICATE],
      ],
    ]);
  }, 240_000);

  afterAll(async () => {
    await world.stop();
  }, 60_000);

  describe('drafting', () => {
    it('AC-ST-AST-001-2, UAT-AC65: drafts a handover of a completed contract on the approved completion minutes, to a unit of the tenant', async () => {
      const target = await seedContract('COMPLETED');
      const drafted = await create(target, { handoverNo: 'BG-001' });
      expect(drafted).toMatchObject({
        handoverNo: 'BG-001',
        handoverKind: 'COMPLETION',
        status: 'DRAFT',
        fromStatus: null,
        version: 1,
        openCriticalPunchCount: 0,
        recipientUnitId: unitId(RECEIVER),
        projectId: target.projectId,
        item: null,
      });
      expect(await rowOf(drafted.id)).toMatchObject({ status: 'DRAFT', version: '1', open_critical_punch_count: 0, punch_list: [] });
      const active = await seedContract();
      expect((await create(active, { handoverKind: 'PARTIAL', qualityAcceptanceId: undefined })).status).toBe('DRAFT');
      expect((await create(active, { handoverKind: 'ASSET_TRANSFER', qualityAcceptanceId: active.completion })).status).toBe('DRAFT');
    });

    it('refuses what is badly formed, a contract in another state, minutes that do not serve, a unit or a file that is not there, and a number used twice', async () => {
      const target = await seedContract();
      const other = await seedContract();
      expect(await refusal(create(target, { handoverKind: 'WHOLE' }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'handover_kind' });
      expect(await refusal(create(target, { handoverNo: ' ' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'handover_no' });
      expect(await refusal(create(target, { plannedOn: '2026-02-30' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'planned_on' });
      expect(await refusal(create(target, { contractId: 'nope' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'contract_id' });
      expect(await refusal(create(target, { projectId: (await seedContract()).projectId }))).toMatchObject({
        code: 'VALIDATION_FAILED',
        detail: 'project_id',
        extensions: { reason: 'NOT_THE_PROJECT_OF_THE_CONTRACT' },
      });
      expect(await refusal(create(await seedContract('SUSPENDED')))).toMatchObject({ code: 'CONTRACT_STATE_INVALID', status: 409, extensions: { contract_status: 'SUSPENDED' } });
      expect(await refusal(create(target, { qualityAcceptanceId: undefined }))).toMatchObject({ code: 'QUALITY_ACCEPTANCE_REQUIRED', status: 422, extensions: { reason: 'MISSING' } });
      expect(await refusal(create(target, { qualityAcceptanceId: other.completion }))).toMatchObject({ code: 'QUALITY_ACCEPTANCE_REQUIRED', extensions: { reason: 'MISSING' } });
      const work = randomUUID();
      await stage(
        `insert into machvon.quality_acceptance
           (tenant_id, id, project_id, contract_id, inspection_id, record_no, acceptance_scope, document_version_id, status, required_roles, content_hash, created_by, updated_by, version)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'SIGNING', '["CONTRACTOR","SUPERVISOR","OWNER"]'::jsonb, repeat('a', 64), $9, $9, 1)`,
        [TENANT_A, work, target.projectId, target.contractId, randomUUID(), 'QA-W-1', 'WORK_ITEM', CLEAN, memberId(DRAFTER)],
      );
      expect(await refusal(create(target, { qualityAcceptanceId: work }))).toMatchObject({ extensions: { reason: 'NOT_APPROVED' } });
      await stage("update machvon.quality_acceptance set status = 'APPROVED', approved_at = now(), approved_by = $2::uuid, decision_note = 'ok' where id = $1::uuid", [work, memberId(CHECKER)]);
      expect(await refusal(create(target, { qualityAcceptanceId: work }))).toMatchObject({ extensions: { reason: 'NOT_COMPLETION' } });
      expect((await create(target, { handoverKind: 'PARTIAL', qualityAcceptanceId: work })).status).toBe('DRAFT');
      expect(await refusal(create(target, { recipientUnitId: unitId(99) }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'recipient_unit_id', extensions: { reason: 'NOT_FOUND' } });
      expect(await refusal(create(target, { documentVersionId: PENDING }))).toMatchObject({ code: 'DOCUMENT_NOT_CLEAN', status: 422 });
      expect(await refusal(create(target, { documentVersionId: randomUUID() }))).toMatchObject({ code: 'VALIDATION_FAILED', extensions: { reason: 'NOT_FOUND' } });
      expect((await refusal(create(target, {}, { update: () => ({ sql: 'false', params: [] }), read: () => ({ sql: 'true', params: [] }) }))).status).toBe(403);
      expect(await refusal(create(target, {}, { update: () => ({ sql: 'false', params: [] }), read: () => ({ sql: 'false', params: [] }) }))).toMatchObject({
        code: 'RESOURCE_NOT_FOUND',
        status: 404,
      });
      const first = await create(target, { handoverNo: 'BG-DUP' });
      expect(first.status).toBe('DRAFT');
      expect(await refusal(create(target, { handoverNo: 'BG-DUP' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'handover_no', extensions: { reason: 'DUPLICATE' } });
    });
  });

  describe('the punch list', () => {
    it('AC-ST-AST-001-1, UAT-AC388: puts items on the list, keeps the count of critical items open in the same transaction, and holds the handover at PUNCH_PENDING', async () => {
      const target = await seedContract();
      const drafted = await create(target);
      const first = await add(drafted.id, 1, {
        severity: 'CRITICAL',
        description: 'The railing of the stair is loose.',
        evidencePhotoId: target.photo,
        locationText: 'Stair B',
        responsibleContractorId: contractor,
      });
      expect(first).toMatchObject({ fromStatus: 'DRAFT', status: 'PUNCH_PENDING', version: 2, openCriticalPunchCount: 1, item: { itemNo: 1, severity: 'CRITICAL', fromStatus: null, status: 'OPEN' } });
      const second = await add(drafted.id, 2, { severity: 'MINOR' });
      expect(second).toMatchObject({ fromStatus: 'PUNCH_PENDING', status: 'PUNCH_PENDING', version: 3, openCriticalPunchCount: 1, item: { itemNo: 2, severity: 'MINOR' } });
      expect(await rowOf(drafted.id)).toMatchObject({
        status: 'PUNCH_PENDING',
        version: '3',
        open_critical_punch_count: 1,
        punch_list: [
          { item_no: 1, severity: 'CRITICAL', status: 'OPEN' },
          { item_no: 2, severity: 'MINOR', status: 'OPEN' },
        ],
      });
      expect(await itemRow(first.item?.id ?? '')).toMatchObject({ status: 'OPEN', defect_photo_id: target.photo, evidence_photo_id: null, version: '1' });
    });

    it('refuses an item that is badly formed, a contractor that is no party of the contract, a photo that is not of it, a stale version and a handover that was decided', async () => {
      const target = await seedContract();
      const drafted = await create(target);
      expect(await refusal(add(drafted.id, 1, { severity: 'SEVERE' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'severity' });
      expect(await refusal(add(drafted.id, 1, { description: '' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'description' });
      expect(await refusal(add(drafted.id, 1, { locationText: 'x'.repeat(2001) }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'location_text' });
      expect(await refusal(add(drafted.id, 1, { dueOn: '2026-12-19' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'due_on', extensions: { reason: 'NOT_IN_THE_FUTURE' } });
      expect(await refusal(add(drafted.id, 1, { dueOn: 'soon' }))).toMatchObject({ detail: 'due_on' });
      expect(await refusal(add(drafted.id, 1, { responsibleContractorId: otherContractor }))).toMatchObject({ detail: 'responsible_contractor_id', extensions: { reason: 'NOT_A_PARTY' } });
      expect(await refusal(add(drafted.id, 1, { evidencePhotoId: (await seedContract()).photo }))).toMatchObject({ detail: 'evidence_photo_id', extensions: { reason: 'NOT_IN_CONTRACT' } });
      expect(await refusal(add(drafted.id, 1, { evidencePhotoId: target.pendingPhoto }))).toMatchObject({ code: 'FILE_NOT_CLEAN', status: 422 });
      expect(await refusal(add(drafted.id, 9))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(add(randomUUID(), 1))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect((await refusal(add(drafted.id, 1, {}, readOnly))).status).toBe(403);
      expect(await refusal(add(drafted.id, 1, {}, invisible))).toMatchObject({ status: 404 });
      expect(await owner('select id from machvon.handover_punch_item where handover_id = $1::uuid', [drafted.id])).toEqual([]);
      const rejected = await as((tx) => handovers.decide(tx, drafted.id, 1, { decision: 'reject', reason: 'Not ready.', evidenceIds: [] }, memberId(CHECKER), all, NOW), CHECKER);
      expect(await refusal(add(drafted.id, rejected.version))).toMatchObject({ code: 'HANDOVER_STATE_INVALID', status: 409, extensions: { status: 'REJECTED' } });
    });

    it('AC-ST-AST-001-1, UAT-AC388: lets the contractor say an item is put right with evidence, and somebody else verify it or reopen it', async () => {
      const target = await seedContract();
      const drafted = await create(target);
      const added = await add(drafted.id, 1, { severity: 'CRITICAL', responsibleContractorId: contractor });
      const itemId = added.item?.id ?? '';
      // An item that was not answered is not verified; an answer needs evidence and a note.
      expect(await refusal(verify(itemId))).toMatchObject({ code: 'PUNCH_STATE_INVALID', status: 409, extensions: { status: 'OPEN' } });
      expect(await refusal(fix(itemId))).toMatchObject({ code: 'EVIDENCE_REQUIRED', status: 422 });
      expect(await refusal(fix(itemId, { evidencePhotoId: target.photo, note: ' ' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'note' });
      expect(await refusal(fix(itemId, { evidencePhotoId: target.pendingPhoto }))).toMatchObject({ code: 'FILE_NOT_CLEAN' });
      expect(await refusal(fix(itemId, { evidenceDocumentVersionId: PENDING }))).toMatchObject({ code: 'DOCUMENT_NOT_CLEAN' });
      expect(await refusal(fix(itemId, { evidenceDocumentVersionId: randomUUID() }))).toMatchObject({ extensions: { reason: 'NOT_FOUND' } });
      expect(await refusal(fix(itemId, { evidencePhotoId: randomUUID() }))).toMatchObject({ extensions: { reason: 'NOT_IN_CONTRACT' } });
      // The contractor of another contract does not answer for it.
      expect(await refusal(fix(itemId, { evidencePhotoId: target.photo }, OTHER_GUEST))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(fix('not-an-id', { evidencePhotoId: target.photo }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'id' });
      expect(await refusal(fix(randomUUID(), { evidencePhotoId: target.photo }))).toMatchObject({ status: 404 });
      expect(await refusal(fix(itemId, { evidencePhotoId: target.photo }, GUEST, invisible))).toMatchObject({ status: 404 });
      const fixed = await fix(itemId, { evidencePhotoId: target.photo, evidenceDocumentVersionId: AS_BUILT });
      expect(fixed).toMatchObject({ version: 3, openCriticalPunchCount: 1, item: { fromStatus: 'OPEN', status: 'FIXED' } });
      expect(await itemRow(itemId)).toMatchObject({ status: 'FIXED', fixed_by: memberId(GUEST), evidence_photo_id: target.photo, defect_photo_id: null });
      expect(await refusal(fix(itemId, { evidencePhotoId: target.photo }))).toMatchObject({ code: 'PUNCH_STATE_INVALID', extensions: { status: 'FIXED' } });

      // Not the person who said it was put right; not a verdict that is not one.
      expect(await refusal(verify(itemId, 'VERIFIED', GUEST))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(verify(itemId, 'MAYBE'))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'outcome' });
      expect((await refusal(verify(itemId, 'VERIFIED', CHECKER, readOnly))).status).toBe(403);
      const reopened = await verify(itemId, 'REOPEN');
      expect(reopened).toMatchObject({ version: 4, openCriticalPunchCount: 1, item: { fromStatus: 'FIXED', status: 'OPEN' } });
      expect(await itemRow(itemId)).toMatchObject({ status: 'OPEN', fixed_by: null, evidence_photo_id: null, reopen_count: 1 });
      await fix(itemId, { evidencePhotoId: target.photo });
      const verified = await verify(itemId);
      expect(verified).toMatchObject({ version: 6, openCriticalPunchCount: 0, item: { fromStatus: 'FIXED', status: 'VERIFIED' } });
      expect(await itemRow(itemId)).toMatchObject({ status: 'VERIFIED', verified_by: memberId(CHECKER), reopen_count: 1 });
      expect(await rowOf(drafted.id)).toMatchObject({ open_critical_punch_count: 0, punch_list: [{ item_no: 1, severity: 'CRITICAL', status: 'VERIFIED' }] });
      expect(await refusal(verify(itemId))).toMatchObject({ code: 'PUNCH_STATE_INVALID', extensions: { status: 'VERIFIED' } });
    });

    it('AC-ST-AST-001-1, UAT-AC388: never waives a critical item, and waives another with a reason by somebody who did not put it on the list', async () => {
      const target = await seedContract();
      const drafted = await create(target);
      const critical = await add(drafted.id, 1, { severity: 'CRITICAL' });
      const major = await add(drafted.id, 2, { severity: 'MAJOR' });
      expect(await refusal(waive(critical.item?.id ?? ''))).toMatchObject({ code: 'CRITICAL_CANNOT_BE_WAIVED', status: 422 });
      expect(await refusal(waive(major.item?.id ?? '', DRAFTER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(as((tx) => handovers.waive(tx, major.item?.id ?? '', { waiverReason: ' ' }, memberId(CHECKER), all), CHECKER))).toMatchObject({
        code: 'VALIDATION_FAILED',
        detail: 'waiver_reason',
      });
      expect((await refusal(waive(major.item?.id ?? '', CHECKER, readOnly))).status).toBe(403);
      const waived = await waive(major.item?.id ?? '');
      expect(waived).toMatchObject({ version: 4, openCriticalPunchCount: 1, item: { fromStatus: 'OPEN', status: 'WAIVED' } });
      expect(await itemRow(major.item?.id ?? '')).toMatchObject({ status: 'WAIVED', waiver_approved_by: memberId(CHECKER) });
      expect(await refusal(waive(major.item?.id ?? ''))).toMatchObject({ code: 'PUNCH_STATE_INVALID', extensions: { status: 'WAIVED' } });
      expect(await refusal(fix(major.item?.id ?? '', { evidencePhotoId: target.photo }))).toMatchObject({ code: 'PUNCH_STATE_INVALID' });
      // A critical item is not waived whatever its status.
      await fix(critical.item?.id ?? '', { evidencePhotoId: target.photo });
      expect(await refusal(waive(critical.item?.id ?? ''))).toMatchObject({ code: 'CRITICAL_CANNOT_BE_WAIVED' });
    });
  });

  describe('the decision of the receiving unit', () => {
    it('AC-ST-AST-001-1, UAT-AC388: does not accept while a critical item is open, nor without the as-built dossier, nor the drafter, and then accepts', async () => {
      const target = await seedContract();
      const drafted = await create(target);
      const critical = await add(drafted.id, 1, { severity: 'CRITICAL', responsibleContractorId: contractor });
      const minor = await add(drafted.id, 2, { severity: 'MINOR' });
      expect(await refusal(decide(drafted.id, 3))).toMatchObject({ code: 'OPEN_CRITICAL_PUNCH', status: 422, extensions: { open_critical_punch_count: 1, item_nos: [1] } });
      // An update straight to ACCEPTED is refused by the database while the count is not zero.
      expect(
        (
          await databaseRefusal(
            owner("update machvon.handover set status = 'ACCEPTED', accepted_at = now(), accepted_by = $2::uuid, as_built_document_version_id = $3::uuid where id = $1::uuid", [
              drafted.id,
              memberId(CHECKER),
              AS_BUILT,
            ]),
          )
        ).message,
      ).toContain('handover_accepted_chk');
      await fix(critical.item?.id ?? '', { evidencePhotoId: target.photo });
      expect(await refusal(decide(drafted.id, 4))).toMatchObject({ code: 'OPEN_CRITICAL_PUNCH', extensions: { item_nos: [1] } });
      await verify(critical.item?.id ?? '');
      const version = (await rowOf(drafted.id))?.version ?? '0';
      expect(await refusal(decide(drafted.id, Number(version), {}, DRAFTER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(decide(drafted.id, Number(version), { asBuiltDocumentVersionId: undefined }))).toMatchObject({ code: 'AS_BUILT_REQUIRED', status: 422 });
      expect(await refusal(decide(drafted.id, Number(version), { asBuiltDocumentVersionId: PENDING }))).toMatchObject({ code: 'DOCUMENT_NOT_CLEAN' });
      expect(await refusal(decide(drafted.id, Number(version), { evidenceIds: [randomUUID()] }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'evidence_ids' });
      expect(await refusal(decide(drafted.id, Number(version) - 1))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(decide(drafted.id, Number(version), { decision: 'maybe' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'decision' });
      expect(await refusal(decide(drafted.id, Number(version), { reason: '' }))).toMatchObject({ detail: 'reason' });
      expect(await refusal(decide(drafted.id, Number(version), { evidenceIds: Array.from({ length: 51 }, () => randomUUID()) }))).toMatchObject({ detail: 'evidence_ids' });
      expect((await refusal(decide(drafted.id, Number(version), {}, CHECKER, readOnly))).status).toBe(403);
      expect(await refusal(decide(drafted.id, Number(version), {}, CHECKER, invisible))).toMatchObject({ status: 404 });
      expect((await rowOf(drafted.id))?.status).toBe('PUNCH_PENDING');

      // A minor item left open does not stop the acceptance.
      expect(minor.item?.status).toBe('OPEN');
      const accepted = await decide(drafted.id, Number(version), { evidenceIds: [CLEAN], omManualDocumentVersionId: MANUAL, warrantyCertificateDocumentVersionId: CERTIFICATE });
      expect(accepted).toMatchObject({ fromStatus: 'PUNCH_PENDING', status: 'ACCEPTED', decision: 'approve', version: Number(version) + 1, openCriticalPunchCount: 0 });
      expect(await rowOf(drafted.id)).toMatchObject({
        status: 'ACCEPTED',
        accepted_by: memberId(CHECKER),
        as_built_document_version_id: AS_BUILT,
        handed_on: '2026-12-20',
        decision_note: 'Accepted.',
      });
      // A decided handover takes no more decision, no more item and no more answer.
      expect(await refusal(decide(drafted.id, accepted.version))).toMatchObject({ code: 'HANDOVER_STATE_INVALID', status: 409 });
      expect(await refusal(add(drafted.id, accepted.version))).toMatchObject({ code: 'HANDOVER_STATE_INVALID' });
      expect(await refusal(verify(minor.item?.id ?? ''))).toMatchObject({ code: 'HANDOVER_STATE_INVALID' });
      expect(await refusal(waive(minor.item?.id ?? ''))).toMatchObject({ code: 'HANDOVER_STATE_INVALID' });
      expect(await refusal(fix(minor.item?.id ?? '', { evidencePhotoId: target.photo }))).toMatchObject({ code: 'HANDOVER_STATE_INVALID' });
    });

    it('accepts a handover with no punch list, gives one back for more work, and rejects one with the reason', async () => {
      const target = await seedContract();
      const clean = await create(target);
      expect(await refusal(decide(clean.id, 1, { decision: 'return' }))).toMatchObject({ code: 'HANDOVER_STATE_INVALID', extensions: { status: 'DRAFT', decision: 'return' } });
      expect(await decide(clean.id, 1)).toMatchObject({ status: 'ACCEPTED' });

      const worked = await create(target);
      const listed = await add(worked.id, 1, { severity: 'MAJOR' });
      const returned = await decide(worked.id, listed.version, { decision: 'return', reason: 'Add the remaining defects.' });
      expect(returned).toMatchObject({ fromStatus: 'PUNCH_PENDING', status: 'PUNCH_PENDING', decision: 'return', version: listed.version + 1 });
      expect(await rowOf(worked.id)).toMatchObject({ status: 'PUNCH_PENDING', decision_note: 'Add the remaining defects.', rejection_reason: null });
      const rejected = await decide(worked.id, returned.version, { decision: 'reject', reason: 'The work is not ready to be handed over.' });
      expect(rejected).toMatchObject({ status: 'REJECTED', decision: 'reject' });
      expect(await rowOf(worked.id)).toMatchObject({ status: 'REJECTED', rejection_reason: 'The work is not ready to be handed over.', accepted_by: null });
      expect(await refusal(decide(worked.id, rejected.version, { decision: 'reject' }))).toMatchObject({ code: 'HANDOVER_STATE_INVALID' });
    });
  });

  describe('what the database keeps', () => {
    it('lets the status move along the edges only, never deletes, and never changes what a handover or an item is about', async () => {
      const target = await seedContract();
      const { id: handoverId, itemId, version: readyVersion } = await ready(target);
      const app = (sql: string) => as((tx) => tx.query(sql.replace('$h', `'${handoverId}'`).replace('$i', `'${itemId}'`)));
      expect((await databaseRefusal(app('delete from machvon.handover where id = $h::uuid'))).sqlstate).toBe('42501');
      expect((await databaseRefusal(app('delete from machvon.handover_punch_item where id = $i::uuid'))).sqlstate).toBe('42501');
      expect(await databaseRefusal(app("update machvon.handover set handover_kind = 'PARTIAL' where id = $h::uuid"))).toMatchObject({
        sqlstate: '23514',
        message: expect.stringContaining('never changes'),
      });
      expect(await databaseRefusal(app("update machvon.handover_punch_item set severity = 'MINOR' where id = $i::uuid"))).toMatchObject({ sqlstate: '23514' });
      expect(await databaseRefusal(app("update machvon.handover_punch_item set status = 'OPEN' where id = $i::uuid"))).toMatchObject({
        sqlstate: '23514',
        message: expect.stringContaining('PUNCH_STATE_INVALID'),
      });
      expect(await databaseRefusal(app("update machvon.handover set status = 'DRAFT' where id = $h::uuid"))).toMatchObject({
        sqlstate: '23514',
        message: expect.stringContaining('HANDOVER_STATE_INVALID'),
      });
      // An item is open first, on a handover that was not decided.
      expect(
        await databaseRefusal(
          owner(
            `insert into machvon.handover_punch_item (tenant_id, id, handover_id, item_no, description, severity, due_on, status, created_by, updated_by) values ($1, gen_random_uuid(), $2::uuid, 9, 'x', 'MINOR', date '2026-12-31', 'FIXED', $3::uuid, $3::uuid)`,
            [TENANT_A, handoverId, memberId(DRAFTER)],
          ),
        ),
      ).toMatchObject({ sqlstate: '23514', message: expect.stringContaining('an item is open first') });
      const accepted = await decide(handoverId, readyVersion);
      expect(accepted.status).toBe('ACCEPTED');
      expect(await databaseRefusal(app("update machvon.handover set decision_note = 'again' where id = $h::uuid"))).toMatchObject({
        message: expect.stringContaining('a decided handover does not change'),
      });
      expect(
        await databaseRefusal(
          owner(
            `insert into machvon.handover_punch_item (tenant_id, id, handover_id, item_no, description, severity, due_on, created_by, updated_by) values ($1, gen_random_uuid(), $2::uuid, 9, 'x', 'MINOR', date '2026-12-31', $3::uuid, $3::uuid)`,
            [TENANT_A, handoverId, memberId(DRAFTER)],
          ),
        ),
      ).toMatchObject({ message: expect.stringContaining('does not change') });
      // The checks of the table: a critical item waived, the verifier who is the answerer, a waiver by the one who raised it.
      const open = await seedContract();
      const drafted = await create(open);
      const first = await add(drafted.id, 1, { severity: 'MAJOR' });
      const criticalItem = await add(drafted.id, 2, { severity: 'CRITICAL' });
      expect(
        (
          await databaseRefusal(
            stage("update machvon.handover_punch_item set status = 'WAIVED', waiver_reason = 'x', waiver_approved_by = $2::uuid where id = $1::uuid", [criticalItem.item?.id, memberId(CHECKER)]),
          )
        ).message,
      ).toContain('punch_item_waiver_critical_chk');
      expect(
        (await databaseRefusal(stage("update machvon.handover_punch_item set status = 'WAIVED', waiver_reason = 'x', waiver_approved_by = created_by where id = $1::uuid", [first.item?.id]))).message,
      ).toContain('punch_item_waiver_actor_chk');
      expect((await databaseRefusal(stage("update machvon.handover_punch_item set status = 'FIXED' where id = $1::uuid", [first.item?.id]))).message).toContain('punch_item_fixed_chk');
      expect(
        (await databaseRefusal(stage('update machvon.handover_punch_item set verified_by = $2::uuid, fixed_by = $2::uuid where id = $1::uuid', [first.item?.id, memberId(CHECKER)]))).message,
      ).toContain('punch_item_verifier_chk');
    });
  });

  describe('reading', () => {
    it('AC-ST-AST-001-2, UAT-AC65: lists the handovers of the scope and traces one: its punch list, its assets, its minutes and the unit that receives it', async () => {
      const target = await seedContract();
      const drafted = await create(target, { handoverNo: 'BG-TRACE' });
      const first = await add(drafted.id, 1, { severity: 'CRITICAL', responsibleContractorId: contractor });
      await add(drafted.id, 2, { severity: 'MINOR', dueOn: '2026-12-25' });
      await fix(first.item?.id ?? '', { evidencePhotoId: target.photo });
      await stage("update machvon.handover_punch_item set due_on = date '2020-01-01' where id = $1::uuid", [first.item?.id]);
      await stage(
        `insert into machvon.asset_record (tenant_id, id, project_id, handover_id, asset_code, value_vnd, recipient_unit_id, name, source_contract_id, created_by, updated_by)
         values ($1, gen_random_uuid(), $2::uuid, $3::uuid, 'AS-001', 3200000000, $4::uuid, 'Pump house', $5::uuid, $6::uuid, $6::uuid)`,
        [TENANT_A, target.projectId, drafted.id, unitId(RECEIVER), target.contractId, memberId(CHECKER)],
      );
      const trace = await as((tx) => handovers.trace(tx, drafted.id, allRows));
      expect(trace?.handover).toMatchObject({
        id: drafted.id,
        handoverNo: 'BG-TRACE',
        status: 'PUNCH_PENDING',
        openCriticalPunchCount: 1,
        punchItemCount: 2,
        recipientUnit: { id: unitId(RECEIVER), name: `Unit ${RECEIVER}` },
        contract: { id: target.contractId, status: 'ACTIVE' },
        qualityAcceptanceId: target.completion,
        reach: { contractId: target.contractId, recipientUnit: { id: unitId(RECEIVER), path: `/${unitId(RECEIVER)}/` } },
      });
      expect(trace?.items.map((entry) => [entry.itemNo, entry.severity, entry.status, entry.overdue, entry.responsibleContractorName !== null])).toEqual([
        [1, 'CRITICAL', 'FIXED', true, true],
        [2, 'MINOR', 'OPEN', false, false],
      ]);
      expect(trace?.assets).toEqual([expect.objectContaining({ assetCode: 'AS-001', valueVnd: '3200000000', status: 'DRAFT', recipientUnitId: unitId(RECEIVER) })]);
      expect(trace?.documents).toEqual([{ role: 'MINUTES', documentVersionId: CLEAN }]);
      expect(trace?.qualityAcceptance).toMatchObject({ id: target.completion, scope: 'COMPLETION', status: 'APPROVED' });
      expect(await as((tx) => handovers.trace(tx, drafted.id, noRows))).toBeUndefined();

      const lines = await as((tx) => handovers.list(tx, allRows, { contractId: target.contractId, limit: 50 }));
      expect(lines.map((line) => line.id)).toEqual([drafted.id]);
      const fresh = await create(target);
      const newest = await as((tx) => handovers.list(tx, allRows, { contractId: target.contractId, limit: 1 }));
      expect(newest.map((line) => line.id)).toEqual([fresh.id]);
      const older = await as((tx) => handovers.list(tx, allRows, { contractId: target.contractId, limit: 5, after: { code: newest[0]?.createdAt ?? '', id: newest[0]?.id ?? '' } }));
      expect(older.map((line) => line.id)).toEqual([drafted.id]);
      expect((await as((tx) => handovers.list(tx, allRows, { contractId: target.contractId, status: 'DRAFT', limit: 50 }))).map((line) => line.id)).toEqual([fresh.id]);
      expect(await as((tx) => handovers.list(tx, noRows, { limit: 50 }))).toEqual([]);
      expect(await refusal(as((tx) => handovers.list(tx, allRows, { status: 'BROKEN', limit: 5 })))).toMatchObject({ detail: 'status' });
      expect(await refusal(as((tx) => handovers.list(tx, allRows, { limit: 0 })))).toMatchObject({ detail: 'limit' });
      expect(await refusal(as((tx) => handovers.list(tx, allRows, { limit: 5, after: { code: 'not a time', id: fresh.id } })))).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(await refusal(as((tx) => handovers.list(tx, allRows, { contractId: 'nope', limit: 5 })))).toMatchObject({ detail: 'contract_id' });
      expect((await as((tx) => handovers.find(tx, fresh.id, allRows)))?.handoverNo).toBe(fresh.handoverNo);
      expect(await as((tx) => handovers.find(tx, fresh.id, noRows))).toBeUndefined();
      expect(await as((tx) => handovers.find(tx, randomUUID(), allRows))).toBeUndefined();
      expect(await as((tx) => handovers.trace(tx, randomUUID(), allRows))).toBeUndefined();
    });
  });
});
