import { randomUUID } from 'node:crypto';
import { DIARY_SIGNATURE_VALUE, DIARY_STATUSES, DomainError, SIGNATURE_METHODS, assertConflictResolution, assertDiaryContent, assertDiaryTransition, assertSignatureMethod, diaryHashOf, legalEffectOf, requiresPermitGate, rolesSignableBy, versionConflict, vietnamDateOf } from '@machvon/kernel';
import type { ConflictResolution, DiaryContent, DiaryStatus, SignatureMethod, SignerRole } from '@machvon/kernel';
import { CtrContractStore, SCOPE_FROM as CONTRACT_SCOPE_FROM, TIMESTAMP } from './ctr-contract-store.ts';
import type { ContractPlace, ContractScopes } from './ctr-contract-store.ts';
import { assertGateOpen } from './permit-gate-guard.ts';
import { PmtGateStore } from './pmt-gate-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/** The gate of the permits that a construction contract waits for before work is recorded. */
const START_GATE = 'START_CONSTRUCTION';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT = 2000;
const UNIQUE_VIOLATION = '23505';
const DAY_CONSTRAINT = 'site_diary_day_uq';
const SIGNATURE_ONCE = 'qms_signature_once_uq';
const SIGNATURE_PERSON = 'qms_signature_person_diary_uq';
const SIGNATURE_OPERATION = 'qms_signature_op_uq';
const CORRECTION_OPEN = 'site_diary_correction_open_uq';
const CLIENT_OPERATION = 'diary_client_operation';

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** The refusal that a device is answered with when it saved over a draft it had not read at its version: the diary of the day, the copy that was kept for it and the version to read (409 `DIARY_SYNC_CONFLICT`). */
export const conflictRefusal = (kept: QmsDiaryResult): DomainError => new DomainError('DIARY_SYNC_CONFLICT', 409, 'base_server_version', { extensions: { diary_id: kept.conflict?.mainId ?? null, conflict_diary_id: kept.id, server_version: kept.conflict?.mainVersion ?? null } });

const idOf = (value: string, field: string): string => {
  if (!UUID.test(value)) throw invalid(field);
  return value.toLowerCase();
};
const dateOf = (value: string, field: string): string => {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (!DATE.test(value) || Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) throw invalid(field);
  return value;
};
const textOf = (value: string, field: string): string => {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MAX_TEXT) throw invalid(field);
  return trimmed;
};

export interface SaveInput {
  contractId: string;
  recordDate: string;
  clientOperationId: string;
  baseServerVersion?: number | undefined;
  content: unknown;
  deviceId?: string | undefined;
}

export interface ResolveInput {
  conflictDiaryId: string;
  resolution: string;
  mergedContent?: unknown;
  note: string;
}

export interface ReviseInput {
  content: unknown;
  clientOperationId: string;
}

export interface SignInput {
  signatureMethod: string;
  certSerial?: string | undefined;
  clientOperationId: string;
  /** The words of the supervisor (the remark) or of the owner (the note). */
  text?: string | undefined;
}

export interface CorrectInput {
  content: unknown;
  correctionReason: string;
  clientOperationId: string;
}

/** What a command answers: where the diary stood and where it stands, and the signature that was made. */
export interface QmsDiaryResult {
  id: string;
  diaryNo: string;
  contractId: string;
  contractCode: string;
  projectId: string;
  recordDate: string;
  fromStatus: DiaryStatus | null;
  status: DiaryStatus;
  version: number;
  correctionOfId: string | null;
  /** Set when the command kept a copy of a device in conflict with the main diary instead of changing the main diary: the main diary, and the version it stands at. */
  conflict: { mainId: string; mainVersion: number } | null;
  /** False when the command found that it had been done (the client operation was seen before) and changed nothing. */
  replayed: boolean;
  signerRole: SignerRole | null;
  signatureMethod: SignatureMethod | null;
  legalEffect: 'INTERNAL_RECORD' | 'LEGAL_E_SIGNATURE' | null;
}

export interface DiarySignature {
  role: SignerRole;
  membershipId: string;
  signerName: string;
  method: SignatureMethod;
  legalEffect: 'INTERNAL_RECORD' | 'LEGAL_E_SIGNATURE';
  certSerial: string | null;
  signedAt: string;
  /** Whether the signature is over the hash the diary carries now; one that is not is void. */
  valid: boolean;
}

/** A copy that a device left when it saved over a draft it had not read at its version: what it said, from which device, and how a person settled it. */
export interface DiaryConflictCopy {
  id: string;
  diaryNo: string;
  state: 'CONFLICT_PENDING' | 'RESOLVED';
  deviceId: string | null;
  author: { membershipId: string; displayName: string };
  createdAt: string;
  content: DiaryContent;
  resolution: ConflictResolution | null;
  note: string | null;
  /** What the settling set aside, kept as it was: the copy itself for a main diary that was kept, the main diary as it stood for a copy that was taken or merged. */
  discarded: DiaryContent | null;
  resolvedAt: string | null;
}

export interface QmsDiaryLine {
  id: string;
  diaryNo: string;
  contract: { id: string; code: string; status: string };
  projectId: string;
  recordDate: string;
  status: DiaryStatus;
  content: DiaryContent;
  contentHash: string | null;
  weatherCode: string | null;
  workforceCount: number | null;
  supervisorRemark: string | null;
  ownerNote: string | null;
  lockReason: string | null;
  lockedAt: string | null;
  correctionOfId: string | null;
  correctionReason: string | null;
  /** NONE for a diary of the day; CONFLICT_PENDING or RESOLVED for the copy of a device (it points at the diary of the day). */
  conflictState: 'NONE' | 'CONFLICT_PENDING' | 'RESOLVED';
  conflictOfId: string | null;
  /** The copies that devices left for this diary, oldest first. */
  conflicts: DiaryConflictCopy[];
  author: { membershipId: string; displayName: string };
  signatures: DiarySignature[];
  /** What the regime says about the value of an in-app signature: until the business confirms it (CXN-EXE-05) every diary says that it is not settled. */
  signatureValue: { cxn: string; awaitingConfirmation: boolean };
  createdAt: string;
  updatedAt: string;
  /** The roles the viewer could sign the diary as, now: the one whose turn it is, if the viewer is on that side and has not signed. */
  viewerSignableRoles: SignerRole[];
  viewerMembershipId: string;
  version: number;
  reach: ContractPlace;
}

interface LockSql {
  id: string;
  diary_no: string;
  contract_id: string;
  contract_code: string;
  contract_status: string;
  project_id: string;
  record_date: string;
  status: DiaryStatus;
  content: DiaryContent;
  content_hash: string | null;
  correction_of_id: string | null;
  conflict_of_id: string | null;
  /** Only where the row was read to be answered again: the version the main diary stands at now. */
  main_version?: string | null;
  author_id: string;
  version: string;
}

interface LineSql {
  id: string;
  diary_no: string;
  contract_id: string;
  contract_code: string;
  contract_status: string;
  project_id: string;
  record_date: string;
  status: DiaryStatus;
  content: DiaryContent;
  content_hash: string | null;
  weather_code: string | null;
  workforce_count: number | null;
  supervisor_remark: string | null;
  owner_note: string | null;
  lock_reason: string | null;
  locked_at: string | null;
  correction_of_id: string | null;
  correction_reason: string | null;
  conflict_state: 'NONE' | 'CONFLICT_PENDING' | 'RESOLVED';
  conflict_of_id: string | null;
  author_id: string;
  author_name: string | null;
  created_at: string;
  updated_at: string;
  version: string;
  owner_unit_id: string;
  owner_unit_path: string;
  investor_unit_id: string | null;
  investor_unit_path: string | null;
}

interface SignatureSql {
  subject_id: string;
  signer_role: SignerRole;
  membership_id: string;
  signer_name_snapshot: string;
  method: SignatureMethod;
  legal_effect: 'INTERNAL_RECORD' | 'LEGAL_E_SIGNATURE';
  cert_serial: string | null;
  signed_content_hash: string;
  signed_at: string;
}

const SELECT = `select d.id, d.diary_no, c.id as contract_id, c.code as contract_code, c.status as contract_status, c.project_id, d.record_date::text as record_date, d.status, d.content, d.content_hash, d.weather_code,
       d.workforce_count, d.supervisor_remark, d.owner_note, d.lock_reason, ${TIMESTAMP('d.locked_at')} as locked_at, d.correction_of_id, d.correction_reason, d.conflict_state, d.conflict_of_id, d.author_id, au.display_name as author_name,
       ${TIMESTAMP('d.created_at')} as created_at, ${TIMESTAMP('d.updated_at')} as updated_at, d.version::text as version,
       ou.id as owner_unit_id, ou.path as owner_unit_path, iu.id as investor_unit_id, iu.path as investor_unit_path
  from ${CONTRACT_SCOPE_FROM}
  join machvon.site_diary d on d.tenant_id = c.tenant_id and d.contract_id = c.id
  left join machvon.tenant_user_directory au on au.tenant_id = d.tenant_id and au.membership_id = d.author_id`;

/**
 * The electronic site diary (ST-QMS-001, QMS 3.1). One main diary for a contract and a day: the contractor drafts it, signs it over a hash of what it says, the supervisor remarks on it and signs, the owner confirms, and it is
 * locked; a signed diary is not edited, and after the lock only a correction, a new revision with a reason that is signed again, replaces it. Each signature keeps the hash, the method and what the method is worth (BR-QMS-02,
 * BR-QMS-03), and the diary says that the legal value of an in-app signature is not settled yet (CXN-EXE-05).
 */
export class QmsDiaryStore {
  private readonly contracts: CtrContractStore;
  private readonly gates: PmtGateStore;

  constructor(contracts: CtrContractStore = new CtrContractStore(), gates: PmtGateStore = new PmtGateStore()) {
    this.contracts = contracts;
    this.gates = gates;
  }

  /**
   * Drafts the diary of a day, or updates the draft that is there. Refusals in order: the shape (422), a client operation that was seen (it answers what it did before), the contract (404 outside the scope, 403 where it may
   * be read and not changed, 409 `CONTRACT_STATE_INVALID` unless it is ACTIVE), a day that has not come (422), the permits of the start of construction for a construction contract (409 `PERMIT_GATE_BLOCKED`), a diary of
   * the day that is not a draft (409 `DIARY_STATE_INVALID`), one that is a draft and was not read (409 `DIARY_DAY_EXISTS`) or was read at another version (409 `DIARY_SYNC_CONFLICT`: nothing is overwritten).
   */
  async save(tx: TenantTx, input: SaveInput, actor: string, scopes: ContractScopes, now: Date): Promise<QmsDiaryResult> {
    const contractId = idOf(input.contractId, 'contract_id');
    const recordDate = dateOf(input.recordDate, 'record_date');
    const operationId = idOf(input.clientOperationId, 'client_operation_id');
    const deviceId = input.deviceId === undefined ? null : idOf(input.deviceId, 'device_id');
    const { weatherCode, workforceCount } = assertDiaryContent(input.content);
    if (input.baseServerVersion !== undefined && (!Number.isInteger(input.baseServerVersion) || input.baseServerVersion < 1)) throw invalid('base_server_version');
    const contract = await this.contracts.lock(tx, contractId, scopes);
    const seen = await this.seenOperation(tx, operationId, contractId);
    if (seen !== undefined) {
      if (seen.conflict !== null) throw conflictRefusal(seen);
      return seen;
    }
    if (contract.status !== 'ACTIVE') throw new DomainError('CONTRACT_STATE_INVALID', 409, 'contract_id', { extensions: { contract_status: contract.status } });
    const today = vietnamDateOf(now);
    if (recordDate > today) throw invalid('record_date');
    const facts = (await tx.query<{ code: string; advance_category: string }>('select code, advance_category from machvon.contract where id = $1::uuid', [contractId]))[0];
    if (requiresPermitGate(facts?.advance_category ?? '')) await assertGateOpen(this.gates, tx, contract.projectId, START_GATE, today);
    const contractCode = facts?.code ?? '';

    const main = (
      await tx.query<{ id: string; status: DiaryStatus; version: string; diary_no: string; correction_of_id: string | null }>(
        "select id, status, version::text as version, diary_no, correction_of_id from machvon.site_diary where contract_id = $1::uuid and record_date = $2::date and conflict_of_id is null and status <> 'SUPERSEDED' order by correction_of_id nulls first for update",
        [contractId, recordDate],
      )
    )[0];
    if (main !== undefined) {
      // A correction is revised and signed through its own commands, never saved over by the device of the day.
      if (main.status !== 'DRAFT' || main.correction_of_id !== null) throw new DomainError('DIARY_STATE_INVALID', 409, 'status', { extensions: { diary_status: main.status, diary_id: main.id } });
      if (input.baseServerVersion === undefined) throw new DomainError('DIARY_DAY_EXISTS', 409, 'record_date', { extensions: { diary_id: main.id, server_version: Number(main.version) } });
      // Read at another version: nothing is overwritten, and what the device wrote is kept as a copy of its own for a person to settle.
      if (input.baseServerVersion !== Number(main.version)) return this.keepConflict(tx, main, { contractId, contractCode, projectId: contract.projectId, recordDate, operationId, content: input.content as DiaryContent, weatherCode, workforceCount, deviceId }, actor);
      await tx.query('update machvon.site_diary set content = $2::jsonb, weather_code = $3, workforce_count = $4, device_id = coalesce($5::uuid, device_id), updated_at = now(), updated_by = $6::uuid, version = version + 1 where id = $1::uuid', [
        main.id,
        JSON.stringify(input.content),
        weatherCode,
        workforceCount,
        deviceId,
        actor,
      ]);
      await tx.query("insert into machvon.site_diary_operation (tenant_id, client_operation_id, diary_id, resulting_version) values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::bigint)", [operationId, main.id, Number(main.version) + 1]);
      return {
        id: main.id,
        diaryNo: main.diary_no,
        contractId,
        contractCode,
        projectId: contract.projectId,
        recordDate,
        fromStatus: 'DRAFT',
        status: 'DRAFT',
        version: Number(main.version) + 1,
        correctionOfId: null,
        conflict: null,
        replayed: false,
        signerRole: null,
        signatureMethod: null,
        legalEffect: null,
      };
    }
    const id = randomUUID();
    const diaryNo = `NK-${contractCode}-${recordDate.replace(/-/g, '')}`;
    try {
      await tx.query(
        `insert into machvon.site_diary
           (tenant_id, id, project_id, contract_id, record_date, client_operation_id, content, author_id, version, diary_no, status, weather_code, workforce_count, device_id, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::date, $5::uuid, $6::jsonb, $7::uuid, 1, $8, 'DRAFT', $9, $10, $11::uuid, $7::uuid, $7::uuid)`,
        [id, contract.projectId, contractId, recordDate, operationId, JSON.stringify(input.content), actor, diaryNo, weatherCode, workforceCount, deviceId],
      );
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (failure.code === UNIQUE_VIOLATION && failure.constraint === DAY_CONSTRAINT) throw new DomainError('DIARY_DAY_EXISTS', 409, 'record_date');
      if (failure.code === UNIQUE_VIOLATION && failure.constraint === CLIENT_OPERATION) throw invalid('client_operation_id');
      throw error;
    }
    return { id, diaryNo, contractId, contractCode, projectId: contract.projectId, recordDate, fromStatus: null, status: 'DRAFT', version: 1, correctionOfId: null, conflict: null, replayed: false, signerRole: null, signatureMethod: null, legalEffect: null };
  }

  /**
   * Edits the draft at the version it was read at. A diary that was signed is not edited (409 `DIARY_STATE_INVALID`), and a draft is no more edited than it is saved once the contract is not ACTIVE any more (409
   * `CONTRACT_STATE_INVALID`) or the permits of the start of construction are blocked (409 `PERMIT_GATE_BLOCKED`).
   */
  async revise(tx: TenantTx, id: string, expectedVersion: number, input: ReviseInput, actor: string, scopes: ContractScopes, now: Date): Promise<QmsDiaryResult> {
    const operationId = idOf(input.clientOperationId, 'client_operation_id');
    const { weatherCode, workforceCount } = assertDiaryContent(input.content);
    // A revision that was made before answers what it did, whatever version the retry names: it is not applied twice, and it is not refused for the version that it moved.
    const peek = await tx.query<{ contract_id: string }>('select contract_id from machvon.site_diary where id = $1::uuid', [idOf(id, 'id')]);
    if (peek[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await this.contracts.lock(tx, peek[0].contract_id, scopes);
    const seen = await this.seenOperation(tx, operationId, peek[0].contract_id);
    if (seen !== undefined) {
      if (seen.id !== id) throw invalid('client_operation_id');
      return seen;
    }
    const held = await this.lock(tx, id, expectedVersion, scopes);
    assertDiaryTransition('revise', held.status);
    await this.assertWritable(tx, held, now);
    await tx.query('update machvon.site_diary set content = $2::jsonb, weather_code = $3, workforce_count = $4, updated_at = now(), updated_by = $5::uuid, version = version + 1 where id = $1::uuid', [id, JSON.stringify(input.content), weatherCode, workforceCount, actor]);
    await tx.query("insert into machvon.site_diary_operation (tenant_id, client_operation_id, diary_id, resulting_version) values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::bigint)", [operationId, id, Number(held.version) + 1]);
    return this.resultOf(held, held.status, 'DRAFT', null);
  }

  /** A draft is written only while the contract is being performed (409 `CONTRACT_STATE_INVALID`) and the permits of the start of construction are open (409 `PERMIT_GATE_BLOCKED`). */
  private async assertWritable(tx: TenantTx, held: LockSql, now: Date): Promise<void> {
    if (held.contract_status !== 'ACTIVE') throw new DomainError('CONTRACT_STATE_INVALID', 409, 'contract_id', { extensions: { contract_status: held.contract_status } });
    const facts = (await tx.query<{ advance_category: string }>('select advance_category from machvon.contract where id = $1::uuid', [held.contract_id]))[0];
    if (requiresPermitGate(facts?.advance_category ?? '')) await assertGateOpen(this.gates, tx, held.project_id, START_GATE, vietnamDateOf(now));
  }

  /**
   * Keeps what a stale device wrote as a copy of its own: a draft that points at the diary of the day (CONFLICT_PENDING), under the operation of the device, so that the same operation again is told the same. The diary of
   * the day is not touched.
   */
  private async keepConflict(
    tx: TenantTx,
    main: { id: string; diary_no: string; version: string },
    input: { contractId: string; contractCode: string; projectId: string; recordDate: string; operationId: string; content: DiaryContent; weatherCode: string | null; workforceCount: number | null; deviceId: string | null },
    actor: string,
  ): Promise<QmsDiaryResult> {
    const copies = Number((await tx.query<{ n: string }>('select count(*)::text as n from machvon.site_diary where conflict_of_id = $1::uuid', [main.id]))[0]?.n ?? '0');
    const id = randomUUID();
    const diaryNo = `${main.diary_no}-C${copies + 1}`;
    try {
      await tx.query(
        `insert into machvon.site_diary
           (tenant_id, id, project_id, contract_id, record_date, client_operation_id, content, author_id, version, diary_no, status, weather_code, workforce_count, device_id, conflict_of_id, conflict_state, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::date, $5::uuid, $6::jsonb, $7::uuid, 1, $8, 'DRAFT', $9, $10, $11::uuid, $12::uuid, 'CONFLICT_PENDING', $7::uuid, $7::uuid)`,
        [id, input.projectId, input.contractId, input.recordDate, input.operationId, JSON.stringify(input.content), actor, diaryNo, input.weatherCode, input.workforceCount, input.deviceId, main.id],
      );
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (failure.code === UNIQUE_VIOLATION && failure.constraint === CLIENT_OPERATION) throw invalid('client_operation_id');
      throw error;
    }
    return {
      id,
      diaryNo,
      contractId: input.contractId,
      contractCode: input.contractCode,
      projectId: input.projectId,
      recordDate: input.recordDate,
      fromStatus: null,
      status: 'DRAFT',
      version: 1,
      correctionOfId: null,
      conflict: { mainId: main.id, mainVersion: Number(main.version) },
      replayed: false,
      signerRole: null,
      signatureMethod: null,
      legalEffect: null,
    };
  }

  /**
   * A person settles the conflict of a device with the diary of the day: keep the diary (the copy is set aside), take the copy (the diary becomes what the device wrote) or merge them (the diary becomes the content
   * that the person wrote). Nothing is lost: the copy stays with how it was settled, and what was set aside is kept with it (`conflict_discarded`). The diary is changed only while it is a draft (409
   * `DIARY_STATE_INVALID`; keeping it changes nothing of it and is open in every state) and under the rules of a draft (the contract in force, the permits open); a copy that is not of this diary, or was settled, is not settled again.
   */
  async resolveConflict(tx: TenantTx, id: string, expectedVersion: number, input: ResolveInput, actor: string, scopes: ContractScopes, now: Date): Promise<QmsDiaryResult> {
    const note = textOf(input.note, 'note');
    const conflictId = idOf(input.conflictDiaryId, 'conflict_diary_id');
    const { resolution, merged } = assertConflictResolution({ resolution: input.resolution, mergedContent: input.mergedContent });
    const held = await this.lock(tx, id, expectedVersion, scopes);
    const copy = (
      await tx.query<{ id: string; content: DiaryContent; weather_code: string | null; workforce_count: number | null; conflict_state: string; conflict_of_id: string | null }>(
        'select id, content, weather_code, workforce_count, conflict_state, conflict_of_id from machvon.site_diary where id = $1::uuid for update',
        [conflictId],
      )
    )[0];
    if (copy === undefined || copy.conflict_of_id !== held.id) throw invalid('conflict_diary_id');
    if (copy.conflict_state !== 'CONFLICT_PENDING') throw new DomainError('DIARY_STATE_INVALID', 409, 'conflict_diary_id', { extensions: { conflict_state: copy.conflict_state } });
    let discarded: DiaryContent = copy.content;
    if (resolution !== 'KEEP_PRIMARY') {
      // The diary takes what the copy said, or what the person wrote: only a draft is written over, and under the rules of a draft.
      assertDiaryTransition('revise', held.status);
      await this.assertWritable(tx, held, now);
      const next = resolution === 'ADOPT_CONFLICT' ? copy.content : (merged as DiaryContent);
      const { weatherCode, workforceCount } = assertDiaryContent(next);
      discarded = held.content;
      await tx.query('update machvon.site_diary set content = $2::jsonb, weather_code = $3, workforce_count = $4, updated_at = now(), updated_by = $5::uuid, version = version + 1 where id = $1::uuid', [held.id, JSON.stringify(next), weatherCode, workforceCount, actor]);
    }
    await tx.query(
      `update machvon.site_diary set conflict_state = 'RESOLVED', conflict_resolution = $2, conflict_note = $3, conflict_discarded = $4::jsonb, conflict_resolved_by = $5::uuid, conflict_resolved_at = now(),
         updated_at = now(), updated_by = $5::uuid, version = version + 1 where id = $1::uuid`,
      [copy.id, resolution, note, JSON.stringify(discarded), actor],
    );
    // Keeping the diary changes nothing of it, in whatever state it is (a replaced diary included): it stands at the version it had. The other two ways moved it.
    const result = this.resultOf(held, held.status, held.status, null);
    return resolution === 'KEEP_PRIMARY' ? { ...result, version: Number(held.version) } : result;
  }

  /** The contractor signs the draft over the hash of what it says (BR-QMS-02). The diary is then kept as it is. */
  async contractorSign(tx: TenantTx, id: string, expectedVersion: number, input: SignInput, actor: string, scopes: ContractScopes, now: Date): Promise<QmsDiaryResult> {
    return this.sign('contractorSign', 'CONTRACTOR', tx, id, expectedVersion, input, actor, scopes, now);
  }

  /** The supervisor remarks on the diary the contractor signed and signs it (the remark is kept as it is). */
  async supervise(tx: TenantTx, id: string, expectedVersion: number, input: SignInput, actor: string, scopes: ContractScopes, now: Date): Promise<QmsDiaryResult> {
    return this.sign('supervise', 'SUPERVISOR', tx, id, expectedVersion, { ...input, text: textOf(input.text ?? '', 'remark') }, actor, scopes, now);
  }

  /** The owner confirms the diary that was remarked on, with a note if they wish. */
  async ownerConfirm(tx: TenantTx, id: string, expectedVersion: number, input: SignInput, actor: string, scopes: ContractScopes, now: Date): Promise<QmsDiaryResult> {
    return this.sign('ownerConfirm', 'OWNER', tx, id, expectedVersion, { ...input, text: input.text === undefined ? undefined : textOf(input.text, 'note') }, actor, scopes, now);
  }

  /**
   * One role signs the diary in its turn. Refusals in order: the state (409 `DIARY_STATE_INVALID`: a role does not sign out of its turn, and a diary that was signed is not signed again by the contractor), the method (422
   * `SIGNATURE_METHOD_NOT_ACCEPTED`: a certificate needs its serial, and only a certificate carries one), a role that is not the signer's to sign (403 `SCOPE_DENIED`: nobody signs for the other side), a role or a person
   * that has signed (409 `ALREADY_SIGNED`), and a diary whose content no longer gives the hash it carries (409 `DIARY_STATE_INVALID`).
   */
  private async sign(command: 'contractorSign' | 'supervise' | 'ownerConfirm', role: SignerRole, tx: TenantTx, id: string, expectedVersion: number, input: SignInput, actor: string, scopes: ContractScopes, now: Date): Promise<QmsDiaryResult> {
    const operationId = idOf(input.clientOperationId, 'client_operation_id');
    const method = SIGNATURE_METHODS.find((candidate) => candidate === input.signatureMethod);
    if (method === undefined) throw invalid('signature_method');
    const serial = input.certSerial === undefined ? null : textOf(input.certSerial, 'cert_serial');
    const held = await this.lock(tx, id, expectedVersion, scopes);
    const target = assertDiaryTransition(command, held.status);
    assertSignatureMethod(method, serial);
    const standing = await this.standingOf(tx, actor, held.contract_id);
    if (!standing.roles.includes(role)) throw new DomainError('SCOPE_DENIED', 403, 'signer_role');
    const hash = diaryHashOf({ contractId: held.contract_id, recordDate: held.record_date, correctionOfId: held.correction_of_id, content: held.content });
    // The hash is set when the contractor signs; after that it is the one every signature is over, and a diary whose content gives another is not signed any more.
    if (command === 'contractorSign') await tx.query('update machvon.site_diary set content_hash = $2 where id = $1::uuid', [id, hash]);
    else if (held.content_hash !== hash) throw new DomainError('DIARY_STATE_INVALID', 409, 'content_hash', { extensions: { reason: 'CONTENT_CHANGED' } });
    const signatures = await this.signaturesOf(tx, [id]);
    if (signatures.some((signature) => signature.signer_role === role && signature.signed_content_hash === hash) || signatures.some((signature) => signature.membership_id === actor)) {
      throw new DomainError('ALREADY_SIGNED', 409, 'signer_role', { extensions: { signer_role: role } });
    }
    const effect = legalEffectOf(method);
    try {
      await tx.query(
        `insert into machvon.qms_signature
           (tenant_id, id, subject_kind, subject_id, signer_role, membership_id, signer_name_snapshot, method, legal_effect, cert_serial, signed_content_hash, signed_at, client_operation_id, created_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), 'SITE_DIARY', $1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9::timestamptz, $10::uuid, $3::uuid)`,
        [id, role, actor, standing.displayName, method, effect, serial, hash, now.toISOString(), operationId],
      );
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (failure.code === UNIQUE_VIOLATION && (failure.constraint === SIGNATURE_ONCE || failure.constraint === SIGNATURE_PERSON)) throw new DomainError('ALREADY_SIGNED', 409, 'signer_role', { extensions: { signer_role: role } });
      if (failure.code === UNIQUE_VIOLATION && failure.constraint === SIGNATURE_OPERATION) throw invalid('client_operation_id');
      throw error;
    }
    await tx.query(
      `update machvon.site_diary
          set status = $2, supervisor_remark = case when $3 = 'supervise' then $4 else supervisor_remark end, owner_note = case when $3 = 'ownerConfirm' then $4 else owner_note end,
              updated_at = now(), updated_by = $5::uuid, version = version + 1
        where id = $1::uuid`,
      [id, target, command, input.text ?? null, actor],
    );
    return this.resultOf(held, held.status, target, { role, method, effect });
  }

  /**
   * Locks a diary that was remarked on (and confirmed, when the owner confirms). A locked diary is part of the record: the one that a correction replaces is then superseded by it. The reason is optional.
   */
  async lockDiary(tx: TenantTx, id: string, expectedVersion: number, reason: string | undefined, actor: string, scopes: ContractScopes, now: Date): Promise<QmsDiaryResult> {
    const why = reason === undefined ? null : textOf(reason, 'reason');
    const held = await this.lock(tx, id, expectedVersion, scopes);
    const target = assertDiaryTransition('lock', held.status);
    await tx.query('update machvon.site_diary set status = $2, locked_at = $3::timestamptz, locked_by = $4::uuid, lock_reason = $5, updated_at = now(), updated_by = $4::uuid, version = version + 1 where id = $1::uuid', [id, target, now.toISOString(), actor, why]);
    // The diary that this one corrects is replaced by it.
    if (held.correction_of_id !== null) {
      await tx.query("update machvon.site_diary set status = 'SUPERSEDED', updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid and status = 'LOCKED'", [held.correction_of_id, actor]);
    }
    return this.resultOf(held, held.status, target, null);
  }

  /**
   * A correction of a locked diary: a new revision, with the reason, that is signed again (the diary that it corrects is kept as it is until the correction is locked). Only a locked diary is corrected (409
   * `DIARY_STATE_INVALID`), one correction is open at a time (409 `DIARY_STATE_INVALID`), and a client operation that was seen answers what it did.
   */
  async correct(tx: TenantTx, id: string, input: CorrectInput, actor: string, scopes: ContractScopes): Promise<QmsDiaryResult> {
    const operationId = idOf(input.clientOperationId, 'client_operation_id');
    const reason = textOf(input.correctionReason, 'correction_reason');
    const { weatherCode, workforceCount } = assertDiaryContent(input.content);
    const peek = await tx.query<{ contract_id: string }>('select contract_id from machvon.site_diary where id = $1::uuid', [idOf(id, 'id')]);
    if (peek[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const contract = await this.contracts.lock(tx, peek[0].contract_id, scopes);
    const seen = await this.seenOperation(tx, operationId, peek[0].contract_id);
    if (seen !== undefined) {
      // Only the operation that made a correction of this diary is answered with it; the operation of another diary, of a draft or of a revision is a mistake.
      if (seen.correctionOfId !== id) throw invalid('client_operation_id');
      return seen;
    }
    const rows = await tx.query<LockSql>(
      `select d.id, d.diary_no, c.id as contract_id, c.code as contract_code, c.status as contract_status, c.project_id, d.record_date::text as record_date, d.status, d.content, d.content_hash, d.correction_of_id, d.conflict_of_id, d.author_id, d.version::text as version
         from machvon.site_diary d join machvon.contract c on c.tenant_id = d.tenant_id and c.id = d.contract_id where d.id = $1::uuid for update of d`,
      [id],
    );
    const original = rows[0];
    if (original === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (contract.status !== 'ACTIVE') throw new DomainError('CONTRACT_STATE_INVALID', 409, 'contract_id', { extensions: { contract_status: contract.status } });
    if (original.conflict_of_id !== null) throw new DomainError('DIARY_STATE_INVALID', 409, 'status', { extensions: { conflict_of_id: original.conflict_of_id } });
    if (original.status !== 'LOCKED') throw new DomainError('DIARY_STATE_INVALID', 409, 'status', { extensions: { diary_status: original.status } });
    const base = original.diary_no.replace(/-R\d+$/, '');
    // The revisions of the day are counted by what they are (the contract, the day and that they correct), not by a pattern made of the number, whose characters (a backslash, % or _ in a contract code) are not all literal.
    const next = Number((await tx.query<{ n: string }>('select count(*)::text as n from machvon.site_diary where contract_id = $1::uuid and record_date = $2::date and correction_of_id is not null and conflict_of_id is null', [original.contract_id, original.record_date]))[0]?.n ?? '0') + 1;
    const created = randomUUID();
    const diaryNo = `${base}-R${next}`;
    try {
      await tx.query(
        `insert into machvon.site_diary
           (tenant_id, id, project_id, contract_id, record_date, client_operation_id, content, author_id, version, diary_no, status, weather_code, workforce_count, correction_of_id, correction_reason, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::date, $5::uuid, $6::jsonb, $7::uuid, 1, $8, 'DRAFT', $9, $10, $11::uuid, $12, $7::uuid, $7::uuid)`,
        [created, original.project_id, original.contract_id, original.record_date, operationId, JSON.stringify(input.content), actor, diaryNo, weatherCode, workforceCount, id, reason],
      );
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (failure.code === UNIQUE_VIOLATION && failure.constraint === CORRECTION_OPEN) throw new DomainError('DIARY_STATE_INVALID', 409, 'status', { extensions: { reason: 'CORRECTION_OPEN' } });
      if (failure.code === UNIQUE_VIOLATION && failure.constraint === CLIENT_OPERATION) throw invalid('client_operation_id');
      throw error;
    }
    return {
      id: created,
      diaryNo,
      contractId: original.contract_id,
      contractCode: original.contract_code,
      projectId: original.project_id,
      recordDate: original.record_date,
      fromStatus: null,
      status: 'DRAFT',
      version: 1,
      correctionOfId: id,
      conflict: null,
      replayed: false,
      signerRole: null,
      signatureMethod: null,
      legalEffect: null,
    };
  }

  /** The diaries of the contracts in the scope of the caller, newest day first, a page at a time. */
  async list(
    tx: TenantTx,
    scope: ScopeBuilder,
    viewer: string,
    filter: { contractId?: string | undefined; status?: string | undefined; from?: string | undefined; to?: string | undefined; hasConflict?: boolean | undefined; limit: number; after?: { code: string; id: string } | undefined },
  ): Promise<{ lines: QmsDiaryLine[]; next: { code: string; id: string } | undefined }> {
    if (filter.status !== undefined && !(DIARY_STATUSES as readonly string[]).includes(filter.status)) throw invalid('status');
    const from = filter.from === undefined ? null : dateOf(filter.from, 'from');
    const to = filter.to === undefined ? null : dateOf(filter.to, 'to');
    if (filter.after !== undefined) dateOf(filter.after.code, 'cursor');
    const predicate = scope(8);
    const rows = await tx.query<LineSql>(
      `${SELECT} where ${predicate.sql} and d.conflict_of_id is null and (not $7::boolean or exists (select 1 from machvon.site_diary k where k.tenant_id = d.tenant_id and k.conflict_of_id = d.id and k.conflict_state = 'CONFLICT_PENDING')) and ($1::uuid is null or d.contract_id = $1::uuid) and ($2::text is null or d.status = $2) and ($3::date is null or d.record_date >= $3::date) and ($4::date is null or d.record_date <= $4::date)
         and ($5::date is null or (d.record_date, d.id) < ($5::date, $6::uuid))
        order by d.record_date desc, d.id desc limit ${filter.limit + 1}`,
      [filter.contractId ?? null, filter.status ?? null, from, to, filter.after?.code ?? null, filter.after?.id ?? null, filter.hasConflict === true, ...predicate.params],
    );
    const page = rows.slice(0, filter.limit);
    const last = page.at(-1);
    return { lines: await this.lines(tx, page, viewer), next: rows.length > filter.limit && last !== undefined ? { code: last.record_date, id: last.id } : undefined };
  }

  async find(tx: TenantTx, id: string, scope: ScopeBuilder, viewer: string): Promise<QmsDiaryLine | undefined> {
    const predicate = scope(2);
    const rows = await tx.query<LineSql>(`${SELECT} where d.id = $1::uuid and ${predicate.sql}`, [id, ...predicate.params]);
    return (await this.lines(tx, rows, viewer))[0];
  }

  // ---- internals --------------------------------------------------------------------------------------------------------

  /** A client operation that was seen before: the diary it made is what it answers (a device that did not hear the answer asks again). Another contract's is a mistake. */
  private async seenOperation(tx: TenantTx, operationId: string, contractId: string): Promise<QmsDiaryResult | undefined> {
    const kept = (await tx.query<{ resulting_version: string }>('select resulting_version::text as resulting_version from machvon.site_diary_operation where client_operation_id = $1::uuid', [operationId]))[0];
    const rows = await tx.query<LockSql & { contract_code: string }>(
      `select (select m.version::text from machvon.site_diary m where m.id = d.conflict_of_id) as main_version, d.id, d.diary_no, c.id as contract_id, c.code as contract_code, c.status as contract_status, c.project_id, d.record_date::text as record_date, d.status, d.content, d.content_hash, d.correction_of_id, d.conflict_of_id, d.author_id, d.version::text as version
         from machvon.site_diary d join machvon.contract c on c.tenant_id = d.tenant_id and c.id = d.contract_id
        where d.client_operation_id = $1::uuid or d.id = (select o.diary_id from machvon.site_diary_operation o where o.client_operation_id = $1::uuid)`,
      [operationId],
    );
    const seen = rows[0];
    if (seen === undefined) return undefined;
    if (seen.contract_id !== contractId) throw invalid('client_operation_id');
    // The diary as it is now, at the version the operation made of it: the retry of an update is told what the update did.
    // A creation made version 1 of the diary, an update the version it recorded: the retry is told that, not the version it has reached since (a client that takes it as the base of its next save would overwrite what others wrote), and a draft was a draft.
    const version = kept === undefined ? 1 : Number(kept.resulting_version);
    return { ...this.resultOf({ ...seen, version: String(version - 1) }, null, 'DRAFT', null), replayed: true };
  }

  private async lines(tx: TenantTx, rows: LineSql[], viewer: string): Promise<QmsDiaryLine[]> {
    if (rows.length === 0) return [];
    const signatures = await this.signaturesOf(
      tx,
      rows.map((row) => row.id),
    );
    const copies = await this.copiesOf(
      tx,
      rows.map((row) => row.id),
    );
    const standings = new Map<string, { roles: SignerRole[]; displayName: string }>();
    const lines: QmsDiaryLine[] = [];
    for (const row of rows) {
      if (!standings.has(row.contract_id)) standings.set(row.contract_id, await this.standingOf(tx, viewer, row.contract_id));
      const own = signatures.filter((signature) => signature.subject_id === row.id);
      const standing = standings.get(row.contract_id);
      const turn: SignerRole | null = row.status === 'DRAFT' ? 'CONTRACTOR' : row.status === 'CONTRACTOR_SIGNED' ? 'SUPERVISOR' : row.status === 'SUPERVISED' ? 'OWNER' : null;
      const signed = own.some((signature) => signature.membership_id === viewer);
      lines.push({
        id: row.id,
        diaryNo: row.diary_no,
        contract: { id: row.contract_id, code: row.contract_code, status: row.contract_status },
        projectId: row.project_id,
        recordDate: row.record_date,
        status: row.status,
        content: row.content,
        contentHash: row.content_hash,
        weatherCode: row.weather_code,
        workforceCount: row.workforce_count,
        supervisorRemark: row.supervisor_remark,
        ownerNote: row.owner_note,
        lockReason: row.lock_reason,
        lockedAt: row.locked_at,
        correctionOfId: row.correction_of_id,
        correctionReason: row.correction_reason,
        conflictState: row.conflict_state,
        conflictOfId: row.conflict_of_id,
        conflicts: copies.filter((copy) => copy.mainId === row.id).map((copy) => copy.copy),
        author: { membershipId: row.author_id, displayName: row.author_name ?? '' },
        signatures: own.map((signature) => ({
          role: signature.signer_role,
          membershipId: signature.membership_id,
          signerName: signature.signer_name_snapshot,
          method: signature.method,
          legalEffect: signature.legal_effect,
          certSerial: signature.cert_serial,
          signedAt: signature.signed_at,
          valid: signature.signed_content_hash === row.content_hash,
        })),
        signatureValue: { ...DIARY_SIGNATURE_VALUE },
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        viewerSignableRoles: turn === null || signed || !(standing?.roles ?? []).includes(turn) ? [] : [turn],
        viewerMembershipId: viewer,
        version: Number(row.version),
        reach: {
          contractId: row.contract_id,
          projectId: row.project_id,
          ownerUnit: { id: row.owner_unit_id, path: row.owner_unit_path },
          investorUnit: row.investor_unit_id === null || row.investor_unit_path === null ? null : { id: row.investor_unit_id, path: row.investor_unit_path },
        },
      });
    }
    return lines;
  }

  /** The copies that devices left for these diaries, oldest first, with how each was settled. */
  private async copiesOf(tx: TenantTx, ids: readonly string[]): Promise<Array<{ mainId: string; copy: DiaryConflictCopy }>> {
    const rows = await tx.query<{
      id: string;
      diary_no: string;
      conflict_of_id: string;
      conflict_state: 'CONFLICT_PENDING' | 'RESOLVED';
      device_id: string | null;
      author_id: string;
      author_name: string | null;
      created_at: string;
      content: DiaryContent;
      conflict_resolution: ConflictResolution | null;
      conflict_note: string | null;
      conflict_discarded: DiaryContent | null;
      conflict_resolved_at: string | null;
    }>(
      `select d.id, d.diary_no, d.conflict_of_id, d.conflict_state, d.device_id, d.author_id, au.display_name as author_name, ${TIMESTAMP('d.created_at')} as created_at, d.content, d.conflict_resolution, d.conflict_note,
              d.conflict_discarded, ${TIMESTAMP('d.conflict_resolved_at')} as conflict_resolved_at
         from machvon.site_diary d left join machvon.tenant_user_directory au on au.tenant_id = d.tenant_id and au.membership_id = d.author_id
        where d.conflict_of_id = any($1::uuid[]) order by d.created_at, d.id`,
      [ids],
    );
    return rows.map((row) => ({
      mainId: row.conflict_of_id,
      copy: {
        id: row.id,
        diaryNo: row.diary_no,
        state: row.conflict_state,
        deviceId: row.device_id,
        author: { membershipId: row.author_id, displayName: row.author_name ?? '' },
        createdAt: row.created_at,
        content: row.content,
        resolution: row.conflict_resolution,
        note: row.conflict_note,
        discarded: row.conflict_discarded,
        resolvedAt: row.conflict_resolved_at,
      },
    }));
  }

  private async signaturesOf(tx: TenantTx, ids: readonly string[]): Promise<SignatureSql[]> {
    return tx.query<SignatureSql>(
      `select subject_id, signer_role, membership_id, signer_name_snapshot, method, legal_effect, cert_serial, signed_content_hash, ${TIMESTAMP('signed_at')} as signed_at
         from machvon.qms_signature where subject_kind = 'SITE_DIARY' and subject_id = any($1::uuid[]) order by signed_at, created_at, id`,
      [ids],
    );
  }

  /** Who the person is to the contract and the roles they may sign as (BR-QMS-05): a guest of the contractor signs for the contractor, the staff for the other side. */
  private async standingOf(tx: TenantTx, membershipId: string, contractId: string): Promise<{ roles: SignerRole[]; displayName: string }> {
    const people = await tx.query<{ membership_type: string; contractor_id: string | null; display_name: string | null }>(
      `select m.membership_type, m.contractor_id, d.display_name
         from machvon.membership m left join machvon.tenant_user_directory d on d.tenant_id = m.tenant_id and d.membership_id = m.id
        where m.id = $1::uuid`,
      [membershipId],
    );
    const person = people[0];
    if (person === undefined) return { roles: [], displayName: '' };
    const parties = await tx.query<{ contractor_id: string }>(
      `select contractor_id from machvon.contract where id = $1::uuid
        union select contractor_id from machvon.contract_party where contract_id = $1::uuid and status = 'ACTIVE'`,
      [contractId],
    );
    const standing = person.membership_type === 'GUEST_CONTRACTOR' && person.contractor_id !== null ? ({ kind: 'GUEST_CONTRACTOR', contractorId: person.contractor_id } as const) : person.membership_type === 'STAFF' ? ({ kind: 'STAFF' } as const) : undefined;
    return {
      roles:
        standing === undefined
          ? []
          : rolesSignableBy(
              standing,
              parties.map((party) => party.contractor_id),
            ),
      displayName: person.display_name ?? '',
    };
  }

  /** The diary locked for update inside the scope of the command, its contract locked first and judged by the scope; a diary the caller cannot see does not exist. */
  private async lock(tx: TenantTx, id: string, expectedVersion: number, scopes: ContractScopes): Promise<LockSql> {
    const peek = await tx.query<{ contract_id: string }>('select contract_id from machvon.site_diary where id = $1::uuid', [idOf(id, 'id')]);
    if (peek[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await this.contracts.lock(tx, peek[0].contract_id, scopes);
    const rows = await tx.query<LockSql>(
      `select d.id, d.diary_no, c.id as contract_id, c.code as contract_code, c.status as contract_status, c.project_id, d.record_date::text as record_date, d.status, d.content, d.content_hash, d.correction_of_id, d.conflict_of_id, d.author_id, d.version::text as version
         from machvon.site_diary d join machvon.contract c on c.tenant_id = d.tenant_id and c.id = d.contract_id
        where d.id = $1::uuid for update of d`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    // The copy of a device is settled through the diary it points at; it is never edited, signed or locked by itself.
    if (row.conflict_of_id !== null) throw new DomainError('DIARY_STATE_INVALID', 409, 'status', { extensions: { conflict_of_id: row.conflict_of_id } });
    if (Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    return row;
  }

  private resultOf(held: LockSql, from: DiaryStatus | null, status: DiaryStatus, signer: { role: SignerRole; method: SignatureMethod; effect: 'INTERNAL_RECORD' | 'LEGAL_E_SIGNATURE' } | null): QmsDiaryResult {
    return {
      id: held.id,
      diaryNo: held.diary_no,
      contractId: held.contract_id,
      contractCode: held.contract_code,
      projectId: held.project_id,
      recordDate: held.record_date,
      fromStatus: from,
      status,
      version: Number(held.version) + 1,
      correctionOfId: held.correction_of_id,
      conflict: held.conflict_of_id === null ? null : { mainId: held.conflict_of_id, mainVersion: Number(held.main_version ?? 0) },
      replayed: false,
      signerRole: signer?.role ?? null,
      signatureMethod: signer?.method ?? null,
      legalEffect: signer?.effect ?? null,
    };
  }
}
