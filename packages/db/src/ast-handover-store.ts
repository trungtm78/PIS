import { randomUUID } from 'node:crypto';
import {
  DomainError,
  HANDOVER_DECISIONS,
  HANDOVER_KINDS,
  PUNCH_SEVERITIES,
  PUNCH_VERIFICATIONS,
  assertCanAddPunchItem,
  assertCanWaive,
  assertHandoverApprover,
  assertHandoverDecision,
  assertNoOpenCritical,
  assertPunchMove,
  assertPunchVerifier,
  assertPunchWaiver,
  versionConflict,
  vietnamDateOf,
} from '@machvon/kernel';
import type { EffectiveAccess, HandoverDecision, HandoverKind, HandoverStatus, PunchSeverity, PunchStatus } from '@machvon/kernel';
import { CtrContractStore, SCOPE_FROM as CONTRACT_SCOPE_FROM, TIMESTAMP, calendarDate, contractScope } from './ctr-contract-store.ts';
import type { ContractScopes } from './ctr-contract-store.ts';
import { assertTimestampCursor, timestampKey } from './keyset.ts';
import { PmtGateStore } from './pmt-gate-store.ts';
import { scopePredicate } from './scope-version.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 2000;
const MAX_PAGE = 200;
const MAX_EVIDENCE = 50;
const UNIQUE_VIOLATION = '23505';
const HANDOVER_GATE = 'HANDOVER';

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
const optionalText = (value: string | undefined, field: string): string | null => (value === undefined ? null : textOf(value, field));
const optionalId = (value: string | undefined, field: string): string | null => (value === undefined ? null : idOf(value, field));
const choice = <T extends string>(values: readonly T[], value: string, field: string): T => {
  const found = values.find((candidate) => candidate === value);
  if (found === undefined) throw invalid(field);
  return found;
};

/**
 * The scope of a command or a read of a handover: the contract it is about (the owner and the investor of its project, the project, the contract itself for a guest contractor) and the unit
 * that receives the work. Compiled over the aliases of the contract queries plus `ru`, the receiving unit.
 */
export function handoverScope(access: EffectiveAccess, permission: string, now: Date): ScopeBuilder {
  const ofContract = contractScope(access, permission, now);
  return (first) => {
    const base = ofContract(first);
    if (base.sql === 'true') return base;
    const unit = scopePredicate(access, permission, now, { unitPath: 'ru.path', unitId: 'ru.id' }, first + base.params.length);
    if (unit.sql === 'false') return base;
    if (base.sql === 'false') return unit;
    return { sql: `(${base.sql} or ${unit.sql})`, params: [...base.params, ...unit.params] };
  };
}

/** The scopes a command on a handover is judged by: the one of its permission decides, the one of `handover.read` tells a refusal from a miss. */
export interface HandoverScopes {
  update: ScopeBuilder;
  read: ScopeBuilder;
}

export interface CreateInput {
  projectId: string;
  contractId: string;
  recipientUnitId: string;
  handoverKind: string;
  handoverNo: string;
  qualityAcceptanceId?: string | undefined;
  plannedOn?: string | undefined;
  documentVersionId: string;
}

export interface AddItemInput {
  description: string;
  severity: string;
  locationText?: string | undefined;
  responsibleContractorId?: string | undefined;
  dueOn: string;
  evidencePhotoId?: string | undefined;
}

export interface FixInput {
  evidencePhotoId?: string | undefined;
  evidenceDocumentVersionId?: string | undefined;
  note: string;
}

export interface VerifyInput {
  outcome: string;
  note: string;
}

export interface WaiveInput {
  waiverReason: string;
}

export interface DecisionInput {
  decision: string;
  reason: string;
  evidenceIds: readonly string[];
  asBuiltDocumentVersionId?: string | undefined;
  omManualDocumentVersionId?: string | undefined;
  warrantyCertificateDocumentVersionId?: string | undefined;
}

export interface HandoverFilter {
  contractId?: string | undefined;
  status?: string | undefined;
  limit: number;
  after?: { code: string; id: string } | undefined;
}

/** What a command did to a handover (and to the punch item it concerned): the facts the audit row and the event carry. */
export interface HandoverResult {
  id: string;
  handoverNo: string;
  handoverKind: HandoverKind;
  contractId: string;
  contractCode: string;
  projectId: string;
  recipientUnitId: string;
  fromStatus: HandoverStatus | null;
  status: HandoverStatus;
  version: number;
  openCriticalPunchCount: number;
  decision: HandoverDecision | null;
  item: { id: string; itemNo: number; severity: PunchSeverity; fromStatus: PunchStatus | null; status: PunchStatus } | null;
}

export interface PunchLine {
  id: string;
  itemNo: number;
  description: string;
  severity: PunchSeverity;
  locationText: string | null;
  responsibleContractorId: string | null;
  responsibleContractorName: string | null;
  dueOn: string;
  overdue: boolean;
  status: PunchStatus;
  createdBy: string;
  defectPhotoId: string | null;
  evidencePhotoId: string | null;
  evidenceDocumentVersionId: string | null;
  fixedBy: string | null;
  fixedAt: string | null;
  fixedNote: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  verificationNote: string | null;
  waiverReason: string | null;
  waiverApprovedBy: string | null;
  reopenCount: number;
  version: number;
}

export interface HandoverLine {
  id: string;
  handoverNo: string | null;
  handoverKind: HandoverKind;
  status: HandoverStatus;
  contract: { id: string; code: string; status: string };
  projectId: string;
  recipientUnit: { id: string; code: string; name: string };
  qualityAcceptanceId: string | null;
  plannedOn: string | null;
  handedOn: string | null;
  acceptedAt: string | null;
  acceptedBy: string | null;
  rejectionReason: string | null;
  decisionNote: string | null;
  openCriticalPunchCount: number;
  punchItemCount: number;
  documentVersionId: string;
  asBuiltDocumentVersionId: string | null;
  omManualDocumentVersionId: string | null;
  warrantyCertificateDocumentVersionId: string | null;
  createdBy: string | null;
  createdAt: string;
  version: number;
  /** The places the caller's right is judged at: the contract and the receiving unit. */
  reach: HandoverPlace;
}

export interface HandoverPlace {
  contractId: string;
  projectId: string;
  ownerUnit: { id: string; path: string };
  investorUnit: { id: string; path: string } | null;
  recipientUnit: { id: string; path: string };
}

/** The trace of a handover: the handover, its punch list, the assets it produced, its minutes and the unit that receives it. */
export interface HandoverTrace {
  handover: HandoverLine;
  items: PunchLine[];
  assets: Array<{ id: string; assetCode: string; name: string | null; valueVnd: string; status: string; recipientUnitId: string; externalAssetId: string | null }>;
  documents: Array<{ role: 'MINUTES' | 'AS_BUILT' | 'OM_MANUAL' | 'WARRANTY_CERTIFICATE'; documentVersionId: string }>;
  qualityAcceptance: { id: string; recordNo: string; scope: string; status: string } | null;
}

interface LineSql {
  id: string;
  handover_no: string | null;
  handover_kind: HandoverKind;
  status: HandoverStatus;
  contract_id: string;
  contract_code: string;
  contract_status: string;
  project_id: string;
  recipient_unit_id: string;
  recipient_unit_code: string;
  recipient_unit_name: string;
  recipient_unit_path: string;
  quality_acceptance_id: string | null;
  planned_on: string | null;
  handed_on: string | null;
  accepted_at: string | null;
  accepted_by: string | null;
  rejection_reason: string | null;
  decision_note: string | null;
  open_critical_punch_count: number;
  punch_item_count: string;
  document_version_id: string;
  as_built_document_version_id: string | null;
  om_manual_document_version_id: string | null;
  warranty_certificate_document_version_id: string | null;
  created_by: string | null;
  created_at: string;
  version: string;
  owner_unit_id: string;
  owner_unit_path: string;
  investor_unit_id: string | null;
  investor_unit_path: string | null;
}

interface ItemSql {
  id: string;
  item_no: number;
  description: string;
  severity: PunchSeverity;
  location_text: string | null;
  responsible_contractor_id: string | null;
  responsible_contractor_name: string | null;
  due_on: string;
  overdue: boolean;
  status: PunchStatus;
  created_by: string;
  defect_photo_id: string | null;
  evidence_photo_id: string | null;
  evidence_document_version_id: string | null;
  fixed_by: string | null;
  fixed_at: string | null;
  fixed_note: string | null;
  verified_by: string | null;
  verified_at: string | null;
  verification_note: string | null;
  waiver_reason: string | null;
  waiver_approved_by: string | null;
  reopen_count: number;
  version: string;
}

const SELECT = `select h.id, h.handover_no, h.handover_kind, h.status, c.id as contract_id, c.code as contract_code, c.status as contract_status, c.project_id, h.recipient_unit_id,
       ru.code as recipient_unit_code, ru.name as recipient_unit_name, ru.path as recipient_unit_path, h.quality_acceptance_id, h.planned_on::text as planned_on, h.handed_on::text as handed_on,
       ${TIMESTAMP('h.accepted_at')} as accepted_at, h.accepted_by, h.rejection_reason, h.decision_note, h.open_critical_punch_count,
       (select count(*) from machvon.handover_punch_item i where i.tenant_id = h.tenant_id and i.handover_id = h.id)::text as punch_item_count, h.document_version_id,
       h.as_built_document_version_id, h.om_manual_document_version_id, h.warranty_certificate_document_version_id, h.created_by, ${timestampKey('h.created_at')} as created_at, h.version::text as version,
       ou.id as owner_unit_id, ou.path as owner_unit_path, iu.id as investor_unit_id, iu.path as investor_unit_path
  from ${CONTRACT_SCOPE_FROM}
  join machvon.handover h on h.tenant_id = c.tenant_id and h.contract_id = c.id
  join machvon.organization_unit ru on ru.tenant_id = h.tenant_id and ru.id = h.recipient_unit_id`;

const ITEM_SELECT = `select i.id, i.item_no, i.description, i.severity, i.location_text, i.responsible_contractor_id, k.legal_name as responsible_contractor_name, i.due_on::text as due_on,
       (i.due_on < (now() at time zone 'Asia/Ho_Chi_Minh')::date and i.status in ('OPEN', 'FIXED')) as overdue, i.status, i.created_by, i.defect_photo_id, i.evidence_photo_id, i.evidence_document_version_id, i.fixed_by,
       ${TIMESTAMP('i.fixed_at')} as fixed_at, i.fixed_note, i.verified_by, ${TIMESTAMP('i.verified_at')} as verified_at, i.verification_note, i.waiver_reason, i.waiver_approved_by, i.reopen_count,
       i.version::text as version
  from machvon.handover_punch_item i left join machvon.contractor k on k.tenant_id = i.tenant_id and k.id = i.responsible_contractor_id`;

const toPlace = (row: LineSql): HandoverPlace => ({
  contractId: row.contract_id,
  projectId: row.project_id,
  ownerUnit: { id: row.owner_unit_id, path: row.owner_unit_path },
  investorUnit: row.investor_unit_id === null || row.investor_unit_path === null ? null : { id: row.investor_unit_id, path: row.investor_unit_path },
  recipientUnit: { id: row.recipient_unit_id, path: row.recipient_unit_path },
});

const toLine = (row: LineSql): HandoverLine => ({
  id: row.id,
  handoverNo: row.handover_no,
  handoverKind: row.handover_kind,
  status: row.status,
  contract: { id: row.contract_id, code: row.contract_code, status: row.contract_status },
  projectId: row.project_id,
  recipientUnit: { id: row.recipient_unit_id, code: row.recipient_unit_code, name: row.recipient_unit_name },
  qualityAcceptanceId: row.quality_acceptance_id,
  plannedOn: row.planned_on,
  handedOn: row.handed_on,
  acceptedAt: row.accepted_at,
  acceptedBy: row.accepted_by,
  rejectionReason: row.rejection_reason,
  decisionNote: row.decision_note,
  openCriticalPunchCount: row.open_critical_punch_count,
  punchItemCount: Number(row.punch_item_count),
  documentVersionId: row.document_version_id,
  asBuiltDocumentVersionId: row.as_built_document_version_id,
  omManualDocumentVersionId: row.om_manual_document_version_id,
  warrantyCertificateDocumentVersionId: row.warranty_certificate_document_version_id,
  createdBy: row.created_by,
  createdAt: row.created_at,
  version: Number(row.version),
  reach: toPlace(row),
});

const toItem = (row: ItemSql): PunchLine => ({
  id: row.id,
  itemNo: row.item_no,
  description: row.description,
  severity: row.severity,
  locationText: row.location_text,
  responsibleContractorId: row.responsible_contractor_id,
  responsibleContractorName: row.responsible_contractor_name,
  dueOn: row.due_on,
  overdue: row.overdue,
  status: row.status,
  createdBy: row.created_by,
  defectPhotoId: row.defect_photo_id,
  evidencePhotoId: row.evidence_photo_id,
  evidenceDocumentVersionId: row.evidence_document_version_id,
  fixedBy: row.fixed_by,
  fixedAt: row.fixed_at,
  fixedNote: row.fixed_note,
  verifiedBy: row.verified_by,
  verifiedAt: row.verified_at,
  verificationNote: row.verification_note,
  waiverReason: row.waiver_reason,
  waiverApprovedBy: row.waiver_approved_by,
  reopenCount: row.reopen_count,
  version: Number(row.version),
});

interface Held {
  id: string;
  handover_no: string | null;
  handover_kind: HandoverKind;
  status: HandoverStatus;
  contract_id: string;
  contract_code: string;
  project_id: string;
  recipient_unit_id: string;
  created_by: string | null;
  quality_acceptance_id: string | null;
  as_built_document_version_id: string | null;
  version: string;
}

interface HeldItem {
  id: string;
  item_no: number;
  severity: PunchSeverity;
  status: PunchStatus;
  responsible_contractor_id: string | null;
  created_by: string;
  fixed_by: string | null;
  version: string;
}

/**
 * The handover of a work to the unit that receives it and the punch list of what is still wrong with it (ST-AST-001, AST 3.1, BR-AST-01, UAT-AC388, UAT-AC65). The project office drafts the
 * handover once the completion acceptance is approved and puts the defects on a list with a severity, a day and the contractor that answers for each; the contractor says an item is put
 * right with evidence; somebody else verifies it or reopens it; an item that is not critical may be waived with a reason, a critical one never. The receiving unit accepts the handover only
 * when no critical item is open, the as-built dossier is there and it is not the unit's drafter who accepts; it can also give it back or reject it. The number of critical items open and
 * the snapshot of the list are kept by the database in the same transaction as the item.
 */
export class AstHandoverStore {
  private readonly contracts: CtrContractStore;
  private readonly gates: PmtGateStore;

  constructor(contracts: CtrContractStore = new CtrContractStore(), gates: PmtGateStore = new PmtGateStore()) {
    this.contracts = contracts;
    this.gates = gates;
  }

  /** Drafts a handover of a contract that is being performed or completed to a unit of the tenant. */
  async create(tx: TenantTx, input: CreateInput, actor: string, scopes: ContractScopes, now: Date): Promise<HandoverResult> {
    const projectId = idOf(input.projectId, 'project_id');
    const contractId = idOf(input.contractId, 'contract_id');
    const recipientId = idOf(input.recipientUnitId, 'recipient_unit_id');
    const kind = choice(HANDOVER_KINDS, input.handoverKind, 'handover_kind');
    const handoverNo = textOf(input.handoverNo, 'handover_no');
    const quality = optionalId(input.qualityAcceptanceId, 'quality_acceptance_id');
    const plannedOn = input.plannedOn === undefined ? null : calendarDate(input.plannedOn, 'planned_on');
    const documentId = idOf(input.documentVersionId, 'document_version_id');
    const contract = await this.contracts.lock(tx, contractId, scopes);
    if (contract.status !== 'ACTIVE' && contract.status !== 'COMPLETED') throw new DomainError('CONTRACT_STATE_INVALID', 409, 'contract_id', { extensions: { contract_status: contract.status } });
    if (contract.projectId !== projectId) throw invalid('project_id', 'NOT_THE_PROJECT_OF_THE_CONTRACT');
    await this.assertMinutes(tx, contractId, quality, kind);
    await this.gates.assertPasses(tx, projectId, HANDOVER_GATE, vietnamDateOf(now));
    const unit = await tx.query('select 1 from machvon.organization_unit where id = $1::uuid', [recipientId]);
    if (unit.length === 0) throw invalid('recipient_unit_id', 'NOT_FOUND');
    await this.assertClean(tx, documentId, 'document_version_id');
    const code = (await tx.query<{ code: string }>('select code from machvon.contract where id = $1::uuid', [contractId]))[0]?.code ?? '';
    const id = randomUUID();
    try {
      await tx.query(
        `insert into machvon.handover
           (tenant_id, id, project_id, contract_id, recipient_unit_id, document_version_id, punch_list, status, handover_no, handover_kind, quality_acceptance_id, planned_on, created_by, updated_by, version)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, '[]'::jsonb, 'DRAFT', $6, $7, $8::uuid, $9::date, $10::uuid, $10::uuid, 1)`,
        [id, projectId, contractId, recipientId, documentId, handoverNo, kind, quality, plannedOn, actor],
      );
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw invalid('handover_no', 'DUPLICATE');
      throw error;
    }
    return {
      id,
      handoverNo,
      handoverKind: kind,
      contractId,
      contractCode: code,
      projectId,
      recipientUnitId: recipientId,
      fromStatus: null,
      status: 'DRAFT',
      version: 1,
      openCriticalPunchCount: 0,
      decision: null,
      item: null,
    };
  }

  /** Puts a defect on the list: the handover waits for it to be put right (PUNCH_PENDING). */
  async addItem(tx: TenantTx, id: string, expectedVersion: number, input: AddItemInput, actor: string, scopes: HandoverScopes, now: Date): Promise<HandoverResult> {
    const description = textOf(input.description, 'description');
    const severity = choice(PUNCH_SEVERITIES, input.severity, 'severity');
    const location = optionalText(input.locationText, 'location_text');
    const dueOn = calendarDate(input.dueOn, 'due_on');
    const contractorId = optionalId(input.responsibleContractorId, 'responsible_contractor_id');
    const photoId = optionalId(input.evidencePhotoId, 'evidence_photo_id');
    const held = await this.lock(tx, id, scopes);
    if (Number(held.version) !== expectedVersion) throw versionConflict(Number(held.version));
    assertCanAddPunchItem(held.status);
    if (dueOn < vietnamDateOf(now)) throw invalid('due_on', 'NOT_IN_THE_FUTURE');
    if (contractorId !== null) await this.assertParty(tx, held.contract_id, contractorId);
    if (photoId !== null) await this.assertPhoto(tx, photoId, held.contract_id, 'evidence_photo_id');
    const next = (await tx.query<{ n: string }>('select (coalesce(max(item_no), 0) + 1)::text as n from machvon.handover_punch_item where handover_id = $1::uuid', [held.id]))[0]?.n ?? '1';
    const itemId = randomUUID();
    await tx.query(
      `insert into machvon.handover_punch_item
         (tenant_id, id, handover_id, item_no, description, severity, location_text, responsible_contractor_id, due_on, status, defect_photo_id, created_by, updated_by, version)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::integer, $4, $5, $6, $7::uuid, $8::date, 'OPEN', $9::uuid, $10::uuid, $10::uuid, 1)`,
      [itemId, held.id, Number(next), description, severity, location, contractorId, dueOn, photoId, actor],
    );
    const after = await this.touch(tx, held, actor, 'PUNCH_PENDING');
    return { ...this.resultOf(held, after), item: { id: itemId, itemNo: Number(next), severity, fromStatus: null, status: 'OPEN' } };
  }

  /** The contractor says an item is put right, with evidence (a clean photo of the contract or a clean document) and a note. */
  async markFixed(tx: TenantTx, itemId: string, input: FixInput, actor: string, scopes: HandoverScopes): Promise<HandoverResult> {
    const note = textOf(input.note, 'note');
    const photoId = optionalId(input.evidencePhotoId, 'evidence_photo_id');
    const documentId = optionalId(input.evidenceDocumentVersionId, 'evidence_document_version_id');
    const { held, item } = await this.lockItem(tx, itemId, scopes);
    this.assertOpen(held);
    assertPunchMove('fix', item.status);
    // A contractor answers for the items it is responsible for, and for no other.
    const caller = (await tx.query<{ membership_type: string; contractor_id: string | null }>('select membership_type, contractor_id from machvon.membership where id = $1::uuid', [actor]))[0];
    if (caller?.membership_type === 'GUEST_CONTRACTOR' && item.responsible_contractor_id !== null && caller.contractor_id !== item.responsible_contractor_id)
      throw new DomainError('SCOPE_DENIED', 403);
    if (photoId === null && documentId === null) throw new DomainError('EVIDENCE_REQUIRED', 422, 'evidence_photo_id');
    if (photoId !== null) await this.assertPhoto(tx, photoId, held.contract_id, 'evidence_photo_id');
    if (documentId !== null) await this.assertClean(tx, documentId, 'evidence_document_version_id');
    await tx.query(
      `update machvon.handover_punch_item
          set status = 'FIXED', evidence_photo_id = $2::uuid, evidence_document_version_id = $3::uuid, fixed_by = $4::uuid, fixed_at = now(), fixed_note = $5,
              updated_at = now(), updated_by = $4::uuid, version = version + 1
        where id = $1::uuid`,
      [item.id, photoId, documentId, actor, note],
    );
    const after = await this.touch(tx, held, actor);
    return { ...this.resultOf(held, after), item: { id: item.id, itemNo: item.item_no, severity: item.severity, fromStatus: item.status, status: 'FIXED' } };
  }

  /** Verifies an item that was put right, or reopens it; not by the person who said it was put right. */
  async verify(tx: TenantTx, itemId: string, input: VerifyInput, actor: string, scopes: HandoverScopes, now: Date): Promise<HandoverResult> {
    const outcome = choice(PUNCH_VERIFICATIONS, input.outcome, 'outcome');
    const note = textOf(input.note, 'note');
    const { held, item } = await this.lockItem(tx, itemId, scopes);
    this.assertOpen(held);
    assertPunchMove('verify', item.status);
    assertPunchVerifier(actor, item.fixed_by);
    if (outcome === 'VERIFIED') {
      await tx.query(
        `update machvon.handover_punch_item set status = 'VERIFIED', verified_by = $2::uuid, verified_at = $3::timestamptz, verification_note = $4, updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid`,
        [item.id, actor, now.toISOString(), note],
      );
    } else {
      await tx.query(
        `update machvon.handover_punch_item
            set status = 'OPEN', evidence_photo_id = null, evidence_document_version_id = null, fixed_by = null, fixed_at = null, fixed_note = null, verification_note = $2,
                reopen_count = reopen_count + 1, updated_at = now(), updated_by = $3::uuid, version = version + 1
          where id = $1::uuid`,
        [item.id, note, actor],
      );
    }
    const after = await this.touch(tx, held, actor);
    return { ...this.resultOf(held, after), item: { id: item.id, itemNo: item.item_no, severity: item.severity, fromStatus: item.status, status: outcome === 'VERIFIED' ? 'VERIFIED' : 'OPEN' } };
  }

  /** Waives an item that is not critical, with the reason; not by the person who put it on the list. */
  async waive(tx: TenantTx, itemId: string, input: WaiveInput, actor: string, scopes: HandoverScopes): Promise<HandoverResult> {
    const reason = textOf(input.waiverReason, 'waiver_reason');
    const { held, item } = await this.lockItem(tx, itemId, scopes);
    this.assertOpen(held);
    assertCanWaive(item.severity);
    assertPunchMove('waive', item.status);
    assertPunchWaiver(actor, item.created_by);
    await tx.query(
      `update machvon.handover_punch_item set status = 'WAIVED', waiver_reason = $2, waiver_approved_by = $3::uuid, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid`,
      [item.id, reason, actor],
    );
    const after = await this.touch(tx, held, actor);
    return { ...this.resultOf(held, after), item: { id: item.id, itemNo: item.item_no, severity: item.severity, fromStatus: item.status, status: 'WAIVED' } };
  }

  /** The decision of the receiving unit: accept (no critical item open, the as-built dossier given, not by the drafter), give back for more work on the list, or reject. */
  async decide(tx: TenantTx, id: string, expectedVersion: number, input: DecisionInput, actor: string, scopes: HandoverScopes, now: Date): Promise<HandoverResult> {
    const decision = choice(HANDOVER_DECISIONS, input.decision, 'decision');
    const reason = textOf(input.reason, 'reason');
    if (input.evidenceIds.length > MAX_EVIDENCE) throw invalid('evidence_ids');
    const evidence = [...new Set(input.evidenceIds.map((evidenceId) => idOf(evidenceId, 'evidence_ids')))];
    const asBuilt = optionalId(input.asBuiltDocumentVersionId, 'as_built_document_version_id');
    const manual = optionalId(input.omManualDocumentVersionId, 'om_manual_document_version_id');
    const certificate = optionalId(input.warrantyCertificateDocumentVersionId, 'warranty_certificate_document_version_id');
    const held = await this.lock(tx, id, scopes);
    if (Number(held.version) !== expectedVersion) throw versionConflict(Number(held.version));
    const to = assertHandoverDecision(decision, held.status);
    for (const evidenceId of evidence) await this.assertClean(tx, evidenceId, 'evidence_ids');
    if (decision === 'approve') {
      assertHandoverApprover(actor, held.created_by);
      const items = await tx.query<{ item_no: number; severity: PunchSeverity; status: PunchStatus }>(
        'select item_no, severity, status from machvon.handover_punch_item where handover_id = $1::uuid order by item_no',
        [held.id],
      );
      assertNoOpenCritical(items.map((item) => ({ itemNo: item.item_no, severity: item.severity, status: item.status })));
      const dossier = asBuilt ?? held.as_built_document_version_id;
      if (dossier === null) throw new DomainError('AS_BUILT_REQUIRED', 422, 'as_built_document_version_id');
      for (const [field, document] of [
        ['as_built_document_version_id', asBuilt],
        ['om_manual_document_version_id', manual],
        ['warranty_certificate_document_version_id', certificate],
      ] as const) {
        if (document !== null) await this.assertClean(tx, document, field);
      }
      await tx.query(
        `update machvon.handover
            set status = $2, accepted_at = $3::timestamptz, accepted_by = $4::uuid, handed_on = coalesce(handed_on, $5::date), as_built_document_version_id = $6::uuid,
                om_manual_document_version_id = coalesce($7::uuid, om_manual_document_version_id), warranty_certificate_document_version_id = coalesce($8::uuid, warranty_certificate_document_version_id),
                decision_note = $9, decision_evidence = $10::jsonb, updated_at = now(), updated_by = $4::uuid, version = version + 1
          where id = $1::uuid`,
        [held.id, to, now.toISOString(), actor, vietnamDateOf(now), dossier, manual, certificate, reason, JSON.stringify(evidence)],
      );
    } else {
      await tx.query(
        `update machvon.handover
            set status = $2, rejection_reason = case when $3 = 'reject' then $4 else rejection_reason end, decision_note = $4, decision_evidence = $5::jsonb, updated_at = now(), updated_by = $6::uuid, version = version + 1
          where id = $1::uuid`,
        [held.id, to, decision, reason, JSON.stringify(evidence), actor],
      );
    }
    const open = (await tx.query<{ open_critical_punch_count: number }>('select open_critical_punch_count from machvon.handover where id = $1::uuid', [held.id]))[0]?.open_critical_punch_count ?? 0;
    return { ...this.resultOf(held, { status: to, open }), decision };
  }

  // ---- reads --------------------------------------------------------------------------------------------------------------

  /** The handovers in the scope of the caller, the newest first; the cursor is the creation time and the id. */
  async list(tx: TenantTx, scope: ScopeBuilder, filter: HandoverFilter): Promise<HandoverLine[]> {
    const contract = filter.contractId === undefined ? null : idOf(filter.contractId, 'contract_id');
    const status = filter.status === undefined ? null : choice(['DRAFT', 'INSPECTING', 'PUNCH_PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED'] as const, filter.status, 'status');
    if (!Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > MAX_PAGE + 1) throw invalid('limit');
    assertTimestampCursor(filter.after?.code);
    const predicate = scope(5);
    const rows = await tx.query<LineSql>(
      `${SELECT} where ${predicate.sql} and ($1::uuid is null or h.contract_id = $1::uuid) and ($2::text is null or h.status = $2)
          and ($3::text is null or (${timestampKey('h.created_at')}, h.id) < ($3::text, $4::uuid))
        order by h.created_at desc, h.id desc limit ${filter.limit}`,
      [contract, status, filter.after?.code ?? null, filter.after?.id ?? null, ...predicate.params],
    );
    return rows.map(toLine);
  }

  async find(tx: TenantTx, id: string, scope: ScopeBuilder): Promise<HandoverLine | undefined> {
    const predicate = scope(2);
    const rows = await tx.query<LineSql>(`${SELECT} where h.id = $1::uuid and ${predicate.sql}`, [id, ...predicate.params]);
    return rows[0] === undefined ? undefined : toLine(rows[0]);
  }

  /** The trace of a handover: its punch list, the assets, the minutes and the unit that receives it (UAT-AC65). */
  async trace(tx: TenantTx, id: string, scope: ScopeBuilder): Promise<HandoverTrace | undefined> {
    const handover = await this.find(tx, id, scope);
    if (handover === undefined) return undefined;
    const items = await tx.query<ItemSql>(`${ITEM_SELECT} where i.handover_id = $1::uuid order by i.item_no`, [id]);
    const assets = await tx.query<{ id: string; asset_code: string; name: string | null; value_vnd: string; status: string; recipient_unit_id: string; external_asset_id: string | null }>(
      'select id, asset_code, name, value_vnd::text as value_vnd, status, recipient_unit_id, external_asset_id from machvon.asset_record where handover_id = $1::uuid order by asset_code, id',
      [id],
    );
    const minutes =
      handover.qualityAcceptanceId === null
        ? undefined
        : (
            await tx.query<{ id: string; record_no: string; acceptance_scope: string; status: string }>(
              'select id, record_no, acceptance_scope, status from machvon.quality_acceptance where id = $1::uuid',
              [handover.qualityAcceptanceId],
            )
          )[0];
    const documents: HandoverTrace['documents'] = [{ role: 'MINUTES', documentVersionId: handover.documentVersionId }];
    if (handover.asBuiltDocumentVersionId !== null) documents.push({ role: 'AS_BUILT', documentVersionId: handover.asBuiltDocumentVersionId });
    if (handover.omManualDocumentVersionId !== null) documents.push({ role: 'OM_MANUAL', documentVersionId: handover.omManualDocumentVersionId });
    if (handover.warrantyCertificateDocumentVersionId !== null) documents.push({ role: 'WARRANTY_CERTIFICATE', documentVersionId: handover.warrantyCertificateDocumentVersionId });
    return {
      handover,
      items: items.map(toItem),
      assets: assets.map((asset) => ({
        id: asset.id,
        assetCode: asset.asset_code,
        name: asset.name,
        valueVnd: asset.value_vnd,
        status: asset.status,
        recipientUnitId: asset.recipient_unit_id,
        externalAssetId: asset.external_asset_id,
      })),
      documents,
      qualityAcceptance: minutes === undefined ? null : { id: minutes.id, recordNo: minutes.record_no, scope: minutes.acceptance_scope, status: minutes.status },
    };
  }

  // ---- internals ----------------------------------------------------------------------------------------------------------

  /** The handover locked for update inside the scope of the command; one the caller can read and not change is a refusal, one it cannot see does not exist. */
  private async lock(tx: TenantTx, id: string, scopes: HandoverScopes): Promise<Held> {
    const predicate = scopes.update(2);
    const rows = await tx.query<Held>(
      `select h.id, h.handover_no, h.handover_kind, h.status, c.id as contract_id, c.code as contract_code, c.project_id, h.recipient_unit_id, h.created_by, h.quality_acceptance_id,
              h.as_built_document_version_id, h.version::text as version
         from ${CONTRACT_SCOPE_FROM}
         join machvon.handover h on h.tenant_id = c.tenant_id and h.contract_id = c.id
         join machvon.organization_unit ru on ru.tenant_id = h.tenant_id and ru.id = h.recipient_unit_id
        where h.id = $1::uuid and ${predicate.sql}
        for update of h`,
      [id, ...predicate.params],
    );
    const row = rows[0];
    if (row !== undefined) return row;
    const readable = scopes.read(2);
    const seen = await tx.query(
      `select h.id from ${CONTRACT_SCOPE_FROM} join machvon.handover h on h.tenant_id = c.tenant_id and h.contract_id = c.id join machvon.organization_unit ru on ru.tenant_id = h.tenant_id and ru.id = h.recipient_unit_id where h.id = $1::uuid and ${readable.sql}`,
      [id, ...readable.params],
    );
    throw seen[0] === undefined ? new DomainError('RESOURCE_NOT_FOUND', 404) : new DomainError('SCOPE_DENIED', 403);
  }

  /** The item and its handover, both locked, inside the scope of the command. */
  private async lockItem(tx: TenantTx, itemId: string, scopes: HandoverScopes): Promise<{ held: Held; item: HeldItem }> {
    const peek = await tx.query<{ handover_id: string }>('select handover_id from machvon.handover_punch_item where id = $1::uuid', [idOf(itemId, 'id')]);
    if (peek[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const held = await this.lock(tx, peek[0].handover_id, scopes);
    const rows = await tx.query<HeldItem>(
      'select id, item_no, severity, status, responsible_contractor_id, created_by, fixed_by, version::text as version from machvon.handover_punch_item where id = $1::uuid for update',
      [itemId.toLowerCase()],
    );
    const item = rows[0];
    if (item === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { held, item };
  }

  private assertOpen(held: Held): void {
    if (held.status === 'ACCEPTED' || held.status === 'REJECTED' || held.status === 'CANCELLED') throw new DomainError('HANDOVER_STATE_INVALID', 409, 'id', { extensions: { status: held.status } });
  }

  /** Gives the handover a new version (and the status the command leads to, when it leads to one); the database has already counted the items. */
  private async touch(tx: TenantTx, held: Held, actor: string, status?: HandoverStatus): Promise<{ status: HandoverStatus; open: number }> {
    const rows = await tx.query<{ status: HandoverStatus; open_critical_punch_count: number }>(
      `update machvon.handover set status = coalesce($2, status), updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid returning status, open_critical_punch_count`,
      [held.id, status ?? null, actor],
    );
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { status: row.status, open: row.open_critical_punch_count };
  }

  private resultOf(held: Held, after: { status: HandoverStatus; open: number }): HandoverResult {
    return {
      id: held.id,
      handoverNo: held.handover_no ?? '',
      handoverKind: held.handover_kind,
      contractId: held.contract_id,
      contractCode: held.contract_code,
      projectId: held.project_id,
      recipientUnitId: held.recipient_unit_id,
      fromStatus: held.status,
      status: after.status,
      version: Number(held.version) + 1,
      openCriticalPunchCount: after.open,
      decision: null,
      item: null,
    };
  }

  /** The completion acceptance the handover rests on: approved minutes of this contract (for the completion of the work when the handover is of the completion). */
  private async assertMinutes(tx: TenantTx, contractId: string, minutesId: string | null, kind: HandoverKind): Promise<void> {
    const refuse = (reason: string): DomainError => new DomainError('QUALITY_ACCEPTANCE_REQUIRED', 422, 'quality_acceptance_id', { extensions: { reason } });
    if (minutesId === null) {
      if (kind === 'COMPLETION') throw refuse('MISSING');
      return;
    }
    const rows = await tx.query<{ acceptance_scope: string; status: string }>('select acceptance_scope, status from machvon.quality_acceptance where id = $1::uuid and contract_id = $2::uuid', [
      minutesId,
      contractId,
    ]);
    const row = rows[0];
    if (row === undefined) throw refuse('MISSING');
    if (row.status !== 'APPROVED') throw refuse('NOT_APPROVED');
    if (kind === 'COMPLETION' && row.acceptance_scope !== 'COMPLETION') throw refuse('NOT_COMPLETION');
  }

  /** A version of a file of the tenant that has passed the scan. */
  private async assertClean(tx: TenantTx, versionId: string, field: string): Promise<void> {
    const rows = await tx.query<{ scan_status: string }>('select scan_status from machvon.document_version where id = $1::uuid', [versionId]);
    if (rows[0] === undefined) throw invalid(field, 'NOT_FOUND');
    if (rows[0].scan_status !== 'CLEAN') throw new DomainError('DOCUMENT_NOT_CLEAN', 422, field);
  }

  /** A photo of the contract that has passed the scan. */
  private async assertPhoto(tx: TenantTx, photoId: string, contractId: string, field: string): Promise<void> {
    const rows = await tx.query<{ scan_status: string }>('select scan_status from machvon.site_photo where id = $1::uuid and contract_id = $2::uuid', [photoId, contractId]);
    if (rows[0] === undefined) throw invalid(field, 'NOT_IN_CONTRACT');
    if (rows[0].scan_status !== 'CLEAN') throw new DomainError('FILE_NOT_CLEAN', 422, field);
  }

  /** The contractor answering for an item is the contractor of the contract or one of its parties. */
  private async assertParty(tx: TenantTx, contractId: string, contractorId: string): Promise<void> {
    const rows = await tx.query(
      `select 1 from machvon.contract where id = $1::uuid and contractor_id = $2::uuid
        union select 1 from machvon.contract_party where contract_id = $1::uuid and contractor_id = $2::uuid and status = 'ACTIVE'`,
      [contractId, contractorId],
    );
    if (rows.length === 0) throw invalid('responsible_contractor_id', 'NOT_A_PARTY');
  }
}
