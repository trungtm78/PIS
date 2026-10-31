import { randomUUID } from 'node:crypto';
import {
  ACTION_VERIFICATIONS,
  DomainError,
  FAILED_TEST_SEVERITY,
  NCR_SEVERITIES,
  NCR_SOURCE_KINDS,
  NCR_STATUSES,
  assertActionsVerified,
  assertIndependentCloser,
  assertIndependentVerifier,
  assertNcrTransition,
  blocksAcceptance,
  canAssignAction,
  canSubmitEvidence,
  canVerify,
  failedTestDueAt,
  failedTestWords,
  statusFromActions,
  versionConflict,
  vietnamDateOf,
} from '@machvon/kernel';
import type { ActionStatus, ActionVerification, NcrSeverity, NcrSourceKind, NcrStatus } from '@machvon/kernel';
import { assertTimestampCursor, timestampKey } from './keyset.ts';
import { CtrContractStore, SCOPE_FROM as CONTRACT_SCOPE_FROM, TIMESTAMP } from './ctr-contract-store.ts';
import type { ContractPlace, ContractScopes } from './ctr-contract-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const MAX_TEXT = 2000;
const MAX_PAGE = 200;

const invalid = (field: string, reason?: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field, reason === undefined ? undefined : { extensions: { reason } });
const idOf = (value: string, field: string): string => {
  if (!UUID.test(value)) throw invalid(field);
  return value.toLowerCase();
};
const textOf = (value: string | undefined, field: string): string => {
  const trimmed = (value ?? '').trim();
  if (trimmed === '' || trimmed.length > MAX_TEXT) throw invalid(field);
  return trimmed;
};

export interface RaiseInput {
  contractId: string;
  measurementId?: string | undefined;
  severity: string;
  title: string;
  description: string;
  sourceKind: string;
  inspectionId?: string | undefined;
  materialTestId?: string | undefined;
  siteDiaryId?: string | undefined;
  actionOwnerId: string;
  dueAt: string;
}

export interface AssignInput {
  description: string;
  ownerMembershipId: string;
  dueAt: string;
}

export interface EvidenceInput {
  evidenceDocumentVersionId?: string | undefined;
  evidencePhotoId?: string | undefined;
  note: string;
}

export interface VerifyInput {
  outcome: string;
  verificationNote: string;
}

export interface NcrFilter {
  contractId?: string | undefined;
  status?: string | undefined;
  severity?: string | undefined;
  limit: number;
  after?: { code: string; id: string } | undefined;
}

/** The result of a command about one action: the action is always there. */
export type ActionResult = NcrResult & { action: NonNullable<NcrResult['action']> };

/** What a command did to a non-conformance (and to the action it concerned): the facts the audit row and the event of the command carry. */
export interface NcrResult {
  id: string;
  ncrNo: string;
  contractId: string;
  contractCode: string;
  projectId: string;
  severity: NcrSeverity;
  sourceKind: NcrSourceKind;
  blocksAcceptance: boolean;
  fromStatus: NcrStatus | null;
  status: NcrStatus;
  version: number;
  openActions: number;
  /** The action the command was about, when it was about one. */
  action: { id: string; fromStatus: ActionStatus | null; status: ActionStatus; version: number } | null;
}

export interface ActionLine {
  id: string;
  description: string;
  owner: { membershipId: string; displayName: string };
  dueAt: string;
  overdue: boolean;
  status: ActionStatus;
  evidenceDocumentVersionId: string | null;
  evidencePhotoId: string | null;
  evidenceNote: string | null;
  submittedAt: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  verificationNote: string | null;
  version: number;
}

/** One non-conformance as QMS-07 shows it, with its actions. */
export interface NcrLine {
  id: string;
  ncrNo: string | null;
  title: string | null;
  description: string | null;
  severity: NcrSeverity;
  sourceKind: NcrSourceKind | null;
  status: NcrStatus;
  blocksAcceptance: boolean;
  contract: { id: string; code: string; status: string };
  projectId: string;
  inspectionId: string | null;
  materialTestId: string | null;
  siteDiaryId: string | null;
  measurementId: string | null;
  detectedOn: string | null;
  dueAt: string;
  overdue: boolean;
  actionOwner: { membershipId: string; displayName: string };
  rootCause: string | null;
  closureNote: string | null;
  reopenReason: string | null;
  reopenCount: number;
  verifiedBy: string | null;
  verifiedAt: string | null;
  closedBy: string | null;
  closedAt: string | null;
  actions: ActionLine[];
  createdAt: string;
  version: number;
  reach: ContractPlace;
}

interface LineSql {
  id: string;
  ncr_no: string | null;
  title: string | null;
  description: string | null;
  severity: NcrSeverity;
  source_kind: NcrSourceKind | null;
  status: NcrStatus;
  blocks_acceptance: boolean;
  contract_id: string;
  contract_code: string;
  contract_status: string;
  project_id: string;
  inspection_id: string | null;
  material_test_id: string | null;
  site_diary_id: string | null;
  measurement_id: string | null;
  detected_on: string | null;
  due_at: string;
  overdue: boolean;
  action_owner_id: string;
  owner_name: string | null;
  root_cause: string | null;
  closure_note: string | null;
  reopen_reason: string | null;
  reopen_count: number;
  verified_by: string | null;
  verified_at: string | null;
  closed_by: string | null;
  closed_at: string | null;
  created_at: string;
  version: string;
  owner_unit_id: string;
  owner_unit_path: string;
  investor_unit_id: string | null;
  investor_unit_path: string | null;
}

interface ActionSql {
  id: string;
  nonconformance_id: string;
  description: string;
  owner_membership_id: string;
  owner_name: string | null;
  due_at: string;
  overdue: boolean;
  status: ActionStatus;
  evidence_document_version_id: string | null;
  evidence_photo_id: string | null;
  evidence_note: string | null;
  submitted_at: string | null;
  verified_by: string | null;
  verified_at: string | null;
  verification_note: string | null;
  version: string;
}

const SELECT = `select n.id, n.ncr_no, n.title, n.description, n.severity, n.source_kind, n.status, n.blocks_acceptance, c.id as contract_id, c.code as contract_code, c.status as contract_status, c.project_id,
       n.inspection_id, n.material_test_id, n.site_diary_id, n.measurement_id, n.detected_on::text as detected_on, ${TIMESTAMP('n.due_at')} as due_at,
       (n.due_at < now() and n.status not in ('VERIFIED', 'CLOSED')) as overdue, n.action_owner_id, ou2.display_name as owner_name, n.root_cause, n.closure_note, n.reopen_reason, n.reopen_count,
       n.verified_by, ${TIMESTAMP('n.verified_at')} as verified_at, n.closed_by, ${TIMESTAMP('n.closed_at')} as closed_at, ${timestampKey('n.created_at')} as created_at, n.version::text as version,
       ou.id as owner_unit_id, ou.path as owner_unit_path, iu.id as investor_unit_id, iu.path as investor_unit_path
  from ${CONTRACT_SCOPE_FROM}
  join machvon.quality_nonconformance n on n.tenant_id = c.tenant_id and n.contract_id = c.id
  left join machvon.tenant_user_directory ou2 on ou2.tenant_id = n.tenant_id and ou2.membership_id = n.action_owner_id`;

const ACTION_SELECT = `select a.id, a.nonconformance_id, a.description, a.owner_membership_id, d.display_name as owner_name, ${TIMESTAMP('a.due_at')} as due_at, (a.due_at < now() and a.status in ('ASSIGNED', 'REJECTED')) as overdue,
       a.status, a.evidence_document_version_id, a.evidence_photo_id, a.evidence_note, ${TIMESTAMP('a.submitted_at')} as submitted_at, a.verified_by, ${TIMESTAMP('a.verified_at')} as verified_at,
       a.verification_note, a.version::text as version
  from machvon.corrective_action a left join machvon.tenant_user_directory d on d.tenant_id = a.tenant_id and d.membership_id = a.owner_membership_id`;

const actionLine = (row: ActionSql): ActionLine => ({
  id: row.id,
  description: row.description,
  owner: { membershipId: row.owner_membership_id, displayName: row.owner_name ?? '' },
  dueAt: row.due_at,
  overdue: row.overdue,
  status: row.status,
  evidenceDocumentVersionId: row.evidence_document_version_id,
  evidencePhotoId: row.evidence_photo_id,
  evidenceNote: row.evidence_note,
  submittedAt: row.submitted_at,
  verifiedBy: row.verified_by,
  verifiedAt: row.verified_at,
  verificationNote: row.verification_note,
  version: Number(row.version),
});

function toLine(row: LineSql, actions: ActionLine[]): NcrLine {
  return {
    id: row.id,
    ncrNo: row.ncr_no,
    title: row.title,
    description: row.description,
    severity: row.severity,
    sourceKind: row.source_kind,
    status: row.status,
    blocksAcceptance: row.blocks_acceptance,
    contract: { id: row.contract_id, code: row.contract_code, status: row.contract_status },
    projectId: row.project_id,
    inspectionId: row.inspection_id,
    materialTestId: row.material_test_id,
    siteDiaryId: row.site_diary_id,
    measurementId: row.measurement_id,
    detectedOn: row.detected_on,
    dueAt: row.due_at,
    overdue: row.overdue,
    actionOwner: { membershipId: row.action_owner_id, displayName: row.owner_name ?? '' },
    rootCause: row.root_cause,
    closureNote: row.closure_note,
    reopenReason: row.reopen_reason,
    reopenCount: row.reopen_count,
    verifiedBy: row.verified_by,
    verifiedAt: row.verified_at,
    closedBy: row.closed_by,
    closedAt: row.closed_at,
    actions,
    createdAt: row.created_at,
    version: Number(row.version),
    reach: {
      contractId: row.contract_id,
      projectId: row.project_id,
      ownerUnit: { id: row.owner_unit_id, path: row.owner_unit_path },
      investorUnit: row.investor_unit_id === null || row.investor_unit_path === null ? null : { id: row.investor_unit_id, path: row.investor_unit_path },
    },
  };
}

interface Held {
  id: string;
  ncr_no: string | null;
  contract_id: string;
  contract_code: string;
  project_id: string;
  severity: NcrSeverity;
  source_kind: NcrSourceKind;
  blocks_acceptance: boolean;
  status: NcrStatus;
  action_owner_id: string;
  version: string;
}

/**
 * The non-conformances of the work under a contract and the actions that put them right (ST-QMS-006, QMS 3.3, BR-QMS-07, UAT-AC361). A supervisor raises one against a contract being performed, with its
 * seriousness, where it came from and the person responsible; a critical one holds back the quality acceptance until it is closed. Actions are assigned to people with a day; whoever carries one out sends
 * the evidence (a clean document or a photo), someone other than the person responsible verifies it, or gives it back; when every action is verified the non-conformance is verified and can be closed
 * by someone who is none of the people who put it right; a closed one can be reopened. The status of the non-conformance follows its actions and is never typed.
 */
export class QmsNonconformanceStore {
  private readonly contracts: CtrContractStore;

  constructor(contracts: CtrContractStore = new CtrContractStore()) {
    this.contracts = contracts;
  }

  /** Raises a non-conformance against a contract that is being performed. */
  async raise(tx: TenantTx, input: RaiseInput, actor: string, scopes: ContractScopes, now: Date): Promise<NcrResult> {
    const contractId = idOf(input.contractId, 'contract_id');
    const severity = NCR_SEVERITIES.find((candidate) => candidate === input.severity) ?? invalidField('severity');
    const sourceKind = NCR_SOURCE_KINDS.find((candidate) => candidate === input.sourceKind) ?? invalidField('source_kind');
    const title = textOf(input.title, 'title');
    const description = textOf(input.description, 'description');
    const owner = idOf(input.actionOwnerId, 'action_owner_id');
    const dueAt = this.future(input.dueAt, 'due_at', now);
    const measurementId = input.measurementId === undefined ? null : idOf(input.measurementId, 'measurement_id');
    const inspectionId = input.inspectionId === undefined ? null : idOf(input.inspectionId, 'inspection_id');
    const materialTestId = input.materialTestId === undefined ? null : idOf(input.materialTestId, 'material_test_id');
    const diaryId = input.siteDiaryId === undefined ? null : idOf(input.siteDiaryId, 'site_diary_id');
    // A source names what it came from, and only that: an inspection for an inspection, a test for a test.
    if ((sourceKind === 'INSPECTION') !== (inspectionId !== null)) throw invalid('inspection_id', sourceKind === 'INSPECTION' ? 'REQUIRED_FOR_SOURCE' : 'NOT_FOR_SOURCE');
    if ((sourceKind === 'MATERIAL_TEST') !== (materialTestId !== null)) throw invalid('material_test_id', sourceKind === 'MATERIAL_TEST' ? 'REQUIRED_FOR_SOURCE' : 'NOT_FOR_SOURCE');

    const contract = await this.contracts.lock(tx, contractId, scopes);
    if (contract.status !== 'ACTIVE') throw new DomainError('CONTRACT_STATE_INVALID', 409, 'contract_id', { extensions: { contract_status: contract.status } });
    await this.assertBelongs(tx, 'measurement', measurementId, contractId, 'measurement_id');
    await this.assertBelongs(tx, 'inspection', inspectionId, contractId, 'inspection_id');
    await this.assertBelongs(tx, 'material_test', materialTestId, contractId, 'material_test_id');
    await this.assertBelongs(tx, 'site_diary', diaryId, contractId, 'site_diary_id');
    await this.assertActiveMember(tx, owner, 'action_owner_id');

    return this.insert(
      tx,
      { contractId, projectId: contract.projectId, measurementId, severity, owner, dueAt, title, description, sourceKind, inspectionId, materialTestId, diaryId },
      actor,
      now,
    );
  }

  /**
   * Raises the non-conformance of a material test that failed, in the transaction that records the result: the test was found inside the scope of the command and its contract is locked and being performed, so
   * the non-conformance is raised for the system and not judged again by the scope of raising one. The person who took the sample answers for it.
   */
  async raiseFromMaterialTest(
    tx: TenantTx,
    test: { id: string; contractId: string; projectId: string; sampleCode: string; materialKind: string; standardRef: string },
    owner: string,
    actor: string,
    now: Date,
  ): Promise<NcrResult> {
    const words = failedTestWords(test);
    return this.insert(
      tx,
      {
        contractId: test.contractId,
        projectId: test.projectId,
        measurementId: null,
        severity: FAILED_TEST_SEVERITY,
        owner,
        dueAt: failedTestDueAt(now),
        title: words.title,
        description: words.description,
        sourceKind: 'MATERIAL_TEST',
        inspectionId: null,
        materialTestId: test.id,
        diaryId: null,
      },
      actor,
      now,
    );
  }

  /** Writes the non-conformance, numbered after the ones of its contract, open and with no action yet. */
  private async insert(
    tx: TenantTx,
    a: {
      contractId: string;
      projectId: string;
      measurementId: string | null;
      severity: NcrSeverity;
      owner: string;
      dueAt: string;
      title: string;
      description: string;
      sourceKind: NcrSourceKind;
      inspectionId: string | null;
      materialTestId: string | null;
      diaryId: string | null;
    },
    actor: string,
    now: Date,
  ): Promise<NcrResult> {
    const facts = (
      await tx.query<{ code: string; n: string }>(
        'select c.code, (select count(*) + 1 from machvon.quality_nonconformance where contract_id = c.id)::text as n from machvon.contract c where c.id = $1::uuid',
        [a.contractId],
      )
    )[0];
    const ncrNo = `NCR-${String(Number(facts?.n ?? '1')).padStart(3, '0')}`;
    const id = randomUUID();
    await tx.query(
      `insert into machvon.quality_nonconformance
         (tenant_id, id, project_id, contract_id, measurement_id, severity, action_owner_id, due_at, status, closure_evidence, ncr_no, title, description, source_kind, inspection_id, material_test_id, site_diary_id,
          detected_on, blocks_acceptance, created_by, updated_by, version)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::uuid, $7::timestamptz, 'OPEN', '{}'::jsonb, $8, $9, $10, $11, $12::uuid, $13::uuid, $14::uuid,
               $15::date, $16, $17::uuid, $17::uuid, 1)`,
      [
        id,
        a.projectId,
        a.contractId,
        a.measurementId,
        a.severity,
        a.owner,
        a.dueAt,
        ncrNo,
        a.title,
        a.description,
        a.sourceKind,
        a.inspectionId,
        a.materialTestId,
        a.diaryId,
        vietnamDateOf(now),
        blocksAcceptance(a.severity),
        actor,
      ],
    );
    return {
      id,
      ncrNo,
      contractId: a.contractId,
      contractCode: facts?.code ?? '',
      projectId: a.projectId,
      severity: a.severity,
      sourceKind: a.sourceKind,
      blocksAcceptance: blocksAcceptance(a.severity),
      fromStatus: null,
      status: 'OPEN',
      version: 1,
      openActions: 0,
      action: null,
    };
  }

  /** Assigns a corrective action to a person with a day; the non-conformance is then waiting for it. */
  async assign(tx: TenantTx, id: string, expectedVersion: number, input: AssignInput, actor: string, scopes: ContractScopes, now: Date): Promise<ActionResult> {
    const description = textOf(input.description, 'description');
    const owner = idOf(input.ownerMembershipId, 'owner_membership_id');
    const dueAt = this.future(input.dueAt, 'due_at', now);
    const held = await this.lock(tx, id, expectedVersion, scopes);
    if (!canAssignAction(held.status)) throw new DomainError('NCR_STATE_INVALID', 409, 'id', { extensions: { status: held.status } });
    await this.assertActiveMember(tx, owner, 'owner_membership_id');
    const actionId = randomUUID();
    await tx.query(
      `insert into machvon.corrective_action (tenant_id, id, nonconformance_id, description, owner_membership_id, due_at, status, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4::uuid, $5::timestamptz, 'ASSIGNED', $6::uuid, $6::uuid)`,
      [actionId, held.id, description, owner, dueAt, actor],
    );
    const after = await this.recompute(tx, held, actor, now);
    return { ...this.resultOf(held, after.status, after.open), action: { id: actionId, fromStatus: null, status: 'ASSIGNED', version: 1 } };
  }

  /** The person who carries an action out answers it with evidence: a clean document of the tenant or a photo of the contract, and a note. */
  async submitEvidence(tx: TenantTx, actionId: string, input: EvidenceInput, actor: string, scopes: ContractScopes, now: Date): Promise<ActionResult> {
    const note = textOf(input.note, 'note');
    const documentId = input.evidenceDocumentVersionId === undefined ? null : idOf(input.evidenceDocumentVersionId, 'evidence_document_version_id');
    const photoId = input.evidencePhotoId === undefined ? null : idOf(input.evidencePhotoId, 'evidence_photo_id');
    const { held, action } = await this.lockAction(tx, actionId, scopes);
    // The answer is the answer of the person given the action.
    if (action.owner_membership_id.toLowerCase() !== actor.toLowerCase()) throw new DomainError('SCOPE_DENIED', 403);
    if (held.status === 'CLOSED') throw new DomainError('NCR_STATE_INVALID', 409, 'id', { extensions: { status: held.status } });
    if (!canSubmitEvidence(action.status)) throw new DomainError('CORRECTIVE_ACTION_STATE_INVALID', 409, 'id', { extensions: { status: action.status } });
    if (documentId === null && photoId === null) throw new DomainError('EVIDENCE_REQUIRED', 422, 'evidence_document_version_id');
    if (documentId !== null) {
      const [document] = await tx.query<{ scan_status: string }>('select scan_status from machvon.document_version where id = $1::uuid', [documentId]);
      if (document === undefined) throw invalid('evidence_document_version_id', 'NOT_FOUND');
      if (document.scan_status !== 'CLEAN') throw new DomainError('DOCUMENT_NOT_CLEAN', 422, 'evidence_document_version_id');
    }
    await this.assertBelongs(tx, 'site_photo', photoId, held.contract_id, 'evidence_photo_id');
    if (photoId !== null) {
      const [photo] = await tx.query<{ scan_status: string }>('select scan_status from machvon.site_photo where id = $1::uuid', [photoId]);
      if (photo?.scan_status !== 'CLEAN') throw new DomainError('FILE_NOT_CLEAN', 422, 'evidence_photo_id');
    }
    await tx.query(
      `update machvon.corrective_action
          set status = 'SUBMITTED', evidence_document_version_id = $2::uuid, evidence_photo_id = $3::uuid, evidence_note = $4, submitted_at = $5::timestamptz, submitted_by = $6::uuid,
              verified_by = null, verified_at = null, verification_note = null, updated_at = now(), updated_by = $6::uuid, version = version + 1
        where id = $1::uuid`,
      [action.id, documentId, photoId, note, now.toISOString(), actor],
    );
    const after = await this.recompute(tx, held, actor, now);
    return { ...this.resultOf(held, after.status, after.open), action: { id: action.id, fromStatus: action.status, status: 'SUBMITTED', version: Number(action.version) + 1 } };
  }

  /** Verifies an action that was submitted, or gives it back; not by the person who carried it out nor by the person responsible for the non-conformance. */
  async verify(tx: TenantTx, actionId: string, input: VerifyInput, actor: string, scopes: ContractScopes, now: Date): Promise<ActionResult> {
    const outcome: ActionVerification = ACTION_VERIFICATIONS.find((candidate) => candidate === input.outcome) ?? invalidField('outcome');
    const note = textOf(input.verificationNote, 'verification_note');
    const { held, action } = await this.lockAction(tx, actionId, scopes);
    if (held.status === 'CLOSED') throw new DomainError('NCR_STATE_INVALID', 409, 'id', { extensions: { status: held.status } });
    if (!canVerify(action.status)) throw new DomainError('CORRECTIVE_ACTION_STATE_INVALID', 409, 'id', { extensions: { status: action.status } });
    assertIndependentVerifier(actor, action.owner_membership_id, held.action_owner_id);
    await tx.query(
      `update machvon.corrective_action set status = $2, verified_by = $3::uuid, verified_at = $4::timestamptz, verification_note = $5, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid`,
      [action.id, outcome, actor, now.toISOString(), note],
    );
    const after = await this.recompute(tx, held, actor, now);
    return { ...this.resultOf(held, after.status, after.open), action: { id: action.id, fromStatus: action.status, status: outcome, version: Number(action.version) + 1 } };
  }

  /** Closes a verified non-conformance, by someone who is none of the people who put it right (422 `CORRECTIVE_ACTION_OPEN` while an action is not verified). */
  async close(tx: TenantTx, id: string, expectedVersion: number, closureNote: string, actor: string, scopes: ContractScopes, now: Date): Promise<NcrResult> {
    const note = textOf(closureNote, 'closure_note');
    const held = await this.lock(tx, id, expectedVersion, scopes);
    if (held.status === 'CLOSED') throw new DomainError('NCR_STATE_INVALID', 409, 'id', { extensions: { status: held.status } });
    const actions = await this.actionsOf(tx, held.id);
    assertActionsVerified(actions.map((row) => row.status));
    const to = assertNcrTransition(held.status, 'close');
    assertIndependentCloser(
      actor,
      held.action_owner_id,
      actions.map((row) => row.owner_membership_id),
    );
    await tx.query(
      `update machvon.quality_nonconformance
          set status = $2, closed_by = $3::uuid, closed_at = $4::timestamptz, closure_note = $5, closure_evidence = $6::jsonb, updated_at = now(), updated_by = $3::uuid, version = version + 1
        where id = $1::uuid`,
      [held.id, to, actor, now.toISOString(), note, JSON.stringify({ action_ids: actions.map((row) => row.id) })],
    );
    return this.resultOf(held, to, 0);
  }

  /** Reopens a closed non-conformance (it came back): it waits for a new action, and a critical one holds back the acceptance again. */
  async reopen(tx: TenantTx, id: string, expectedVersion: number, reason: string, actor: string, scopes: ContractScopes, now: Date): Promise<NcrResult> {
    const text = textOf(reason, 'reason');
    const held = await this.lock(tx, id, expectedVersion, scopes);
    const to = assertNcrTransition(held.status, 'reopen');
    await tx.query(
      `update machvon.quality_nonconformance
          set status = $2, reopen_reason = $3, reopened_at = $4::timestamptz, reopened_by = $5::uuid, reopen_count = reopen_count + 1, closed_by = null, closed_at = null, closure_note = null,
              verified_by = null, verified_at = null, updated_at = now(), updated_by = $5::uuid, version = version + 1
        where id = $1::uuid`,
      [held.id, to, text, now.toISOString(), actor],
    );
    const open = (await this.actionsOf(tx, held.id)).filter((row) => row.status !== 'VERIFIED').length;
    return this.resultOf(held, to, open);
  }

  /** The non-conformances of the contracts in the scope of the caller, the newest first; the cursor is the creation time and the id. */
  async list(tx: TenantTx, scope: ScopeBuilder, filter: NcrFilter): Promise<NcrLine[]> {
    const contract = filter.contractId === undefined ? null : idOf(filter.contractId, 'contract_id');
    const status = filter.status === undefined ? null : (NCR_STATUSES.find((candidate) => candidate === filter.status) ?? invalidField('status'));
    const severity = filter.severity === undefined ? null : (NCR_SEVERITIES.find((candidate) => candidate === filter.severity) ?? invalidField('severity'));
    if (!Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > MAX_PAGE + 1) throw invalid('limit');
    assertTimestampCursor(filter.after?.code);
    const predicate = scope(6);
    const rows = await tx.query<LineSql>(
      `${SELECT} where ${predicate.sql} and ($1::uuid is null or n.contract_id = $1::uuid) and ($2::text is null or n.status = $2) and ($3::text is null or n.severity = $3)
          and ($4::text is null or (${timestampKey('n.created_at')}, n.id) < ($4::text, $5::uuid))
        order by n.created_at desc, n.id desc limit ${filter.limit}`,
      [contract, status, severity, filter.after?.code ?? null, filter.after?.id ?? null, ...predicate.params],
    );
    return this.withActions(tx, rows);
  }

  async find(tx: TenantTx, id: string, scope: ScopeBuilder): Promise<NcrLine | undefined> {
    const predicate = scope(2);
    const rows = await tx.query<LineSql>(`${SELECT} where n.id = $1::uuid and ${predicate.sql}`, [id, ...predicate.params]);
    return (await this.withActions(tx, rows))[0];
  }

  // ---- internals --------------------------------------------------------------------------------------------------------

  private async withActions(tx: TenantTx, rows: readonly LineSql[]): Promise<NcrLine[]> {
    if (rows.length === 0) return [];
    const actions = await tx.query<ActionSql>(`${ACTION_SELECT} where a.nonconformance_id = any($1::uuid[]) order by a.created_at, a.id`, [rows.map((row) => row.id)]);
    return rows.map((row) => toLine(row, actions.filter((action) => action.nonconformance_id === row.id).map(actionLine)));
  }

  private actionsOf(tx: TenantTx, ncrId: string): Promise<Array<{ id: string; status: ActionStatus; owner_membership_id: string }>> {
    return tx.query('select id, status, owner_membership_id from machvon.corrective_action where nonconformance_id = $1::uuid order by created_at, id', [ncrId]);
  }

  /** The status the actions leave the non-conformance in, written with a new version of it whatever the command was about, so that every command has its own version for the event it emits. */
  private async recompute(tx: TenantTx, held: Held, actor: string, now: Date): Promise<{ status: NcrStatus; open: number }> {
    const actions = await this.actionsOf(tx, held.id);
    const status = statusFromActions(
      held.status,
      actions.map((row) => row.status),
    );
    const verified = status === 'VERIFIED';
    await tx.query(
      `update machvon.quality_nonconformance
          set status = $2, verified_by = case when $3::boolean then $4::uuid else null end, verified_at = case when $3::boolean then $5::timestamptz else null end, updated_at = now(), updated_by = $4::uuid, version = version + 1
        where id = $1::uuid`,
      [held.id, status, verified, actor, now.toISOString()],
    );
    return { status, open: actions.filter((row) => row.status !== 'VERIFIED').length };
  }

  private resultOf(held: Held, status: NcrStatus, open: number): NcrResult {
    return {
      id: held.id,
      ncrNo: held.ncr_no ?? '',
      contractId: held.contract_id,
      contractCode: held.contract_code,
      projectId: held.project_id,
      severity: held.severity,
      sourceKind: held.source_kind,
      blocksAcceptance: held.blocks_acceptance,
      fromStatus: held.status,
      status,
      version: Number(held.version) + 1,
      openActions: open,
      action: null,
    };
  }

  /** The non-conformance locked for update inside the scope of the command, its contract locked first and judged by the scope; one the caller cannot see does not exist. */
  private async lock(tx: TenantTx, id: string, expectedVersion: number | undefined, scopes: ContractScopes): Promise<Held> {
    const peek = await tx.query<{ contract_id: string }>('select contract_id from machvon.quality_nonconformance where id = $1::uuid', [id]);
    if (peek[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await this.contracts.lock(tx, peek[0].contract_id, scopes);
    const rows = await tx.query<Held>(
      `select n.id, n.ncr_no, c.id as contract_id, c.code as contract_code, c.project_id, n.severity, n.source_kind, n.blocks_acceptance, n.status, n.action_owner_id, n.version::text as version
         from machvon.quality_nonconformance n join machvon.contract c on c.tenant_id = n.tenant_id and c.id = n.contract_id
        where n.id = $1::uuid for update of n`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (expectedVersion !== undefined && Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    return row;
  }

  /** The action and its non-conformance, both locked, inside the scope of the command. */
  private async lockAction(
    tx: TenantTx,
    actionId: string,
    scopes: ContractScopes,
  ): Promise<{ held: Held; action: { id: string; status: ActionStatus; owner_membership_id: string; version: string } }> {
    const peek = await tx.query<{ nonconformance_id: string }>('select nonconformance_id from machvon.corrective_action where id = $1::uuid', [idOf(actionId, 'id')]);
    if (peek[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const held = await this.lock(tx, peek[0].nonconformance_id, undefined, scopes);
    const rows = await tx.query<{ id: string; status: ActionStatus; owner_membership_id: string; version: string }>(
      'select id, status, owner_membership_id, version::text as version from machvon.corrective_action where id = $1::uuid for update',
      [actionId],
    );
    const action = rows[0];
    if (action === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { held, action };
  }

  private future(value: string, field: string, now: Date): string {
    if (!ISO_INSTANT.test(value) || Number.isNaN(Date.parse(value))) throw invalid(field);
    const moment = new Date(value);
    if (moment.getTime() <= now.getTime()) throw invalid(field, 'NOT_IN_THE_FUTURE');
    return moment.toISOString();
  }

  private async assertActiveMember(tx: TenantTx, membershipId: string, field: string): Promise<void> {
    const rows = await tx.query("select 1 from machvon.membership where id = $1::uuid and status = 'Active'", [membershipId]);
    if (rows.length === 0) throw invalid(field, 'NOT_AN_ACTIVE_MEMBER');
  }

  /** A record the command names belongs to the contract of the non-conformance. */
  private async assertBelongs(tx: TenantTx, table: 'measurement' | 'inspection' | 'material_test' | 'site_diary' | 'site_photo', id: string | null, contractId: string, field: string): Promise<void> {
    if (id === null) return;
    const rows = await tx.query(`select 1 from machvon.${table} where id = $1::uuid and contract_id = $2::uuid`, [id, contractId]);
    if (rows.length === 0) throw invalid(field, 'NOT_IN_CONTRACT');
  }
}

const invalidField = (field: string): never => {
  throw invalid(field);
};
