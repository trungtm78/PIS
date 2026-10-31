import { randomUUID } from 'node:crypto';
import {
  CLAIM_SEVERITIES,
  CLAIM_VERIFICATIONS,
  COST_BEARERS,
  DomainError,
  assertClaimVerifier,
  assertWithinWarranty,
  isResponseOverdue,
  nextClaimStatus,
  responseDueOn,
  versionConflict,
} from '@machvon/kernel';
import type { ClaimSeverity, ClaimStatus, CostBearer } from '@machvon/kernel';
import { assertCleanDocument, assertCleanPhoto, assertContractParty, assertContractorOwn } from './ast-evidence.ts';
import { HANDOVER_FROM } from './ast-warranty-store.ts';
import type { HandoverPlace, HandoverScopes } from './ast-handover-store.ts';
import { calendarDate, textOf } from './ctr-contract-store.ts';
import { assertTimestampCursor, timestampKey } from './keyset.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 2000;
const MAX_PAGE = 200;
const UNIQUE_VIOLATION = '23505';

export const WARRANTY_CLAIM_RESOURCE = 'warranty_claim';

const invalid = (field: string, reason?: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field, reason === undefined ? undefined : { extensions: { reason } });
const idOf = (value: string, field: string): string => {
  if (!UUID.test(value)) throw invalid(field);
  return value.toLowerCase();
};
const optionalId = (value: string | undefined, field: string): string | null => (value === undefined ? null : idOf(value, field));
const choice = <T extends string>(values: readonly T[], value: string, field: string): T => {
  const found = values.find((candidate) => candidate === value);
  if (found === undefined) throw invalid(field);
  return found;
};

export interface FileInput {
  obligationId: string;
  claimNo: string;
  reportedOn: string;
  defectDescription: string;
  severity: string;
  locationText?: string | undefined;
  evidencePhotoId?: string | undefined;
  evidenceDocumentVersionId?: string | undefined;
  responderContractorId: string;
}

export interface AcknowledgeInput {
  committedFixOn: string;
  note?: string | undefined;
}

export interface FixInput {
  fixedOn: string;
  evidencePhotoId?: string | undefined;
  evidenceDocumentVersionId?: string | undefined;
  note: string;
}

export interface VerifyInput {
  outcome: string;
  costBorneBy: string;
  note: string;
}

export interface ClaimFilter {
  obligationId?: string | undefined;
  status?: string | undefined;
  /** The day the lateness of an answer is judged on. */
  today: string;
  limit: number;
  after?: { code: string; id: string } | undefined;
}

/** What a command did to a claim: the facts the audit row and the event carry. */
export interface ClaimResult {
  id: string;
  obligationId: string;
  claimNo: string;
  contractId: string;
  contractCode: string;
  handoverId: string;
  projectId: string;
  severity: ClaimSeverity;
  responderContractorId: string | null;
  reportedOn: string;
  responseDueOn: string;
  committedFixOn: string | null;
  fixedOn: string | null;
  costBorneBy: CostBearer;
  fromStatus: ClaimStatus | null;
  status: ClaimStatus;
  version: number;
}

export interface ClaimLine {
  id: string;
  claimNo: string;
  obligation: { id: string; endsOn: string; status: string };
  contract: { id: string; code: string };
  handover: { id: string; handoverNo: string | null };
  projectId: string;
  severity: ClaimSeverity;
  defectDescription: string;
  locationText: string | null;
  responder: { id: string; name: string } | null;
  reportedOn: string;
  responseDueOn: string;
  committedFixOn: string | null;
  fixedOn: string | null;
  evidencePhotoId: string | null;
  evidenceDocumentVersionId: string | null;
  fixEvidencePhotoId: string | null;
  fixEvidenceDocumentVersionId: string | null;
  fixNote: string | null;
  verificationNote: string | null;
  costBorneBy: CostBearer;
  status: ClaimStatus;
  overdue: boolean;
  issue: { id: string; code: string } | null;
  reportedBy: string;
  fixedBy: string | null;
  createdAt: string;
  version: number;
  reach: HandoverPlace;
}

/** A claim whose answer is overdue and that the job has just flagged: the facts of the event that asks ISS for an issue. */
export interface OverdueClaim {
  id: string;
  claimNo: string;
  contractId: string;
  projectId: string;
  ownerUnitId: string;
  severity: ClaimSeverity;
  responseDueOn: string;
  version: number;
}

interface LineSql {
  id: string;
  claim_no: string;
  obligation_id: string;
  obligation_ends_on: string;
  obligation_status: string;
  contract_id: string;
  contract_code: string;
  handover_id: string;
  handover_no: string | null;
  project_id: string;
  severity: ClaimSeverity;
  defect_description: string;
  location_text: string | null;
  responder_id: string | null;
  responder_name: string | null;
  reported_on: string;
  response_due_on: string;
  committed_fix_on: string | null;
  fixed_on: string | null;
  evidence_photo_id: string | null;
  evidence_document_version_id: string | null;
  fix_evidence_photo_id: string | null;
  fix_evidence_document_version_id: string | null;
  fix_note: string | null;
  verification_note: string | null;
  cost_borne_by: CostBearer;
  status: ClaimStatus;
  issue_id: string | null;
  issue_code: string | null;
  reported_by: string;
  fixed_by: string | null;
  created_at: string;
  version: string;
  owner_unit_id: string;
  owner_unit_path: string;
  investor_unit_id: string | null;
  investor_unit_path: string | null;
  recipient_unit_id: string;
  recipient_unit_path: string;
}

const CLAIM_FROM = `${HANDOVER_FROM}
  join machvon.warranty_obligation w on w.tenant_id = h.tenant_id and w.handover_id = h.id
  join machvon.warranty_claim k on k.tenant_id = w.tenant_id and k.obligation_id = w.id`;

const SELECT = `select k.id, k.claim_no, w.id as obligation_id, w.ends_on::text as obligation_ends_on, w.status as obligation_status, c.id as contract_id, c.code as contract_code, h.id as handover_id, h.handover_no,
       c.project_id, k.severity, k.defect_description, k.location_text, k.responder_contractor_id as responder_id, rc.legal_name as responder_name, k.reported_on::text as reported_on,
       k.response_due_on::text as response_due_on, k.committed_fix_on::text as committed_fix_on, k.fixed_on::text as fixed_on, k.evidence_photo_id, k.evidence_document_version_id,
       k.fix_evidence_photo_id, k.fix_evidence_document_version_id, k.fix_note, k.verification_note, k.cost_borne_by, k.status, i.id as issue_id, i.code as issue_code, k.reported_by, k.fixed_by,
       ${timestampKey('k.created_at')} as created_at, k.version::text as version, ou.id as owner_unit_id, ou.path as owner_unit_path, iu.id as investor_unit_id, iu.path as investor_unit_path,
       h.recipient_unit_id, ru.path as recipient_unit_path
  from ${CLAIM_FROM}
  left join machvon.contractor rc on rc.tenant_id = k.tenant_id and rc.id = k.responder_contractor_id
  left join machvon.issue i on i.tenant_id = k.tenant_id and i.id = k.issue_id`;

const toLine = (row: LineSql, today: string): ClaimLine => ({
  id: row.id,
  claimNo: row.claim_no,
  obligation: { id: row.obligation_id, endsOn: row.obligation_ends_on, status: row.obligation_status },
  contract: { id: row.contract_id, code: row.contract_code },
  handover: { id: row.handover_id, handoverNo: row.handover_no },
  projectId: row.project_id,
  severity: row.severity,
  defectDescription: row.defect_description,
  locationText: row.location_text,
  responder: row.responder_id === null ? null : { id: row.responder_id, name: row.responder_name ?? '' },
  reportedOn: row.reported_on,
  responseDueOn: row.response_due_on,
  committedFixOn: row.committed_fix_on,
  fixedOn: row.fixed_on,
  evidencePhotoId: row.evidence_photo_id,
  evidenceDocumentVersionId: row.evidence_document_version_id,
  fixEvidencePhotoId: row.fix_evidence_photo_id,
  fixEvidenceDocumentVersionId: row.fix_evidence_document_version_id,
  fixNote: row.fix_note,
  verificationNote: row.verification_note,
  costBorneBy: row.cost_borne_by,
  status: row.status,
  overdue: isResponseOverdue(row.status, row.response_due_on, today),
  issue: row.issue_id === null ? null : { id: row.issue_id, code: row.issue_code ?? '' },
  reportedBy: row.reported_by,
  fixedBy: row.fixed_by,
  createdAt: row.created_at,
  version: Number(row.version),
  reach: {
    contractId: row.contract_id,
    projectId: row.project_id,
    ownerUnit: { id: row.owner_unit_id, path: row.owner_unit_path },
    investorUnit: row.investor_unit_id === null || row.investor_unit_path === null ? null : { id: row.investor_unit_id, path: row.investor_unit_path },
    recipientUnit: { id: row.recipient_unit_id, path: row.recipient_unit_path },
  },
});

interface Held {
  id: string;
  claim_no: string;
  obligation_id: string;
  contract_id: string;
  contract_code: string;
  handover_id: string;
  project_id: string;
  severity: ClaimSeverity;
  responder_contractor_id: string | null;
  reported_on: string;
  response_due_on: string;
  committed_fix_on: string | null;
  fixed_on: string | null;
  reported_by: string;
  fixed_by: string | null;
  cost_borne_by: CostBearer;
  status: ClaimStatus;
  version: string;
}

/**
 * The claims against a warranty and the answer to them (ST-AST-004, AST 3.3, BR-AST-03, UAT-AC390, UAT-AC391). A claim is filed on an obligation that has not run out and is not closed (422 `WARRANTY_EXPIRED`) against a
 * contractor of the contract, with a number that is new in the obligation (409 `CLAIM_NO_DUPLICATE`); the contractor has seven days to answer. The contractor acknowledges the claim with the day it commits to and says it is
 * put right with evidence (422 `EVIDENCE_REQUIRED`); somebody who neither reported the defect nor said it was put right verifies the repair or disputes it (403 `SELF_APPROVAL_DENIED`). A disputed claim is put right again.
 * An unanswered claim past its day is flagged once for the job that asks ISS for an issue.
 */
export class AstClaimStore {
  async file(tx: TenantTx, input: FileInput, actor: string, scopes: HandoverScopes): Promise<ClaimResult> {
    const obligationId = idOf(input.obligationId, 'id');
    const claimNo = textOf(input.claimNo, 'claim_no', MAX_TEXT);
    const reportedOn = calendarDate(input.reportedOn, 'reported_on');
    const description = textOf(input.defectDescription, 'defect_description', MAX_TEXT);
    const severity = choice(CLAIM_SEVERITIES, input.severity, 'severity');
    const location = input.locationText === undefined ? null : textOf(input.locationText, 'location_text', MAX_TEXT);
    const photoId = optionalId(input.evidencePhotoId, 'evidence_photo_id');
    const documentId = optionalId(input.evidenceDocumentVersionId, 'evidence_document_version_id');
    const contractorId = idOf(input.responderContractorId, 'responder_contractor_id');

    const obligation = await this.obligation(tx, obligationId, scopes);
    if (obligation.status === 'CLOSED') throw new DomainError('WARRANTY_STATE_INVALID', 409, 'id', { extensions: { status: obligation.status } });
    if (reportedOn < obligation.starts_on) throw invalid('reported_on', 'BEFORE_START');
    assertWithinWarranty(reportedOn, obligation.ends_on);
    await assertContractParty(tx, obligation.contract_id, contractorId, 'responder_contractor_id');
    if (photoId !== null) await assertCleanPhoto(tx, photoId, obligation.contract_id, 'evidence_photo_id');
    if (documentId !== null) await assertCleanDocument(tx, documentId, 'evidence_document_version_id');

    const id = randomUUID();
    const dueOn = responseDueOn(reportedOn);
    try {
      await tx.query(
        `insert into machvon.warranty_claim
           (tenant_id, id, obligation_id, claim_no, reported_on, reported_by, defect_description, severity, location_text, evidence_photo_id, evidence_document_version_id, responder_contractor_id,
            response_due_on, status, created_by, updated_by, version)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4::date, $5::uuid, $6, $7, $8, $9::uuid, $10::uuid, $11::uuid, $12::date, 'OPEN', $5::uuid, $5::uuid, 1)`,
        [id, obligationId, claimNo, reportedOn, actor, description, severity, location, photoId, documentId, contractorId, dueOn],
      );
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new DomainError('CLAIM_NO_DUPLICATE', 409, 'claim_no');
      throw error;
    }
    return {
      id,
      obligationId,
      claimNo,
      contractId: obligation.contract_id,
      contractCode: obligation.contract_code,
      handoverId: obligation.handover_id,
      projectId: obligation.project_id,
      severity,
      responderContractorId: contractorId,
      reportedOn,
      responseDueOn: dueOn,
      committedFixOn: null,
      fixedOn: null,
      costBorneBy: 'UNDETERMINED',
      fromStatus: null,
      status: 'OPEN',
      version: 1,
    };
  }

  /** The contractor takes the claim on and commits to a day to put it right. */
  async acknowledge(tx: TenantTx, id: string, expectedVersion: number, input: AcknowledgeInput, actor: string, scopes: HandoverScopes, now: Date): Promise<ClaimResult> {
    const note = input.note === undefined ? null : textOf(input.note, 'note', MAX_TEXT);
    const committedOn = calendarDate(input.committedFixOn, 'committed_fix_on');
    const held = await this.lock(tx, idOf(id, 'id'), expectedVersion, scopes);
    await assertContractorOwn(tx, actor, held.responder_contractor_id);
    const status = nextClaimStatus(held.status, 'ACKNOWLEDGE');
    if (committedOn < held.reported_on) throw invalid('committed_fix_on', 'BEFORE_REPORT');
    await tx.query(
      `update machvon.warranty_claim
          set status = $2, committed_fix_on = $3::date, acknowledged_by = $4::uuid, acknowledged_at = $5::timestamptz, acknowledge_note = $6, updated_at = now(), updated_by = $4::uuid, version = version + 1
        where id = $1::uuid`,
      [held.id, status, committedOn, actor, now.toISOString(), note],
    );
    return this.resultOf(held, status, { committedFixOn: committedOn });
  }

  /** The contractor says the defect is put right, with evidence (a clean photo of the contract or a clean file) and a note. */
  async fix(tx: TenantTx, id: string, expectedVersion: number, input: FixInput, actor: string, scopes: HandoverScopes): Promise<ClaimResult> {
    const note = textOf(input.note, 'note', MAX_TEXT);
    const fixedOn = calendarDate(input.fixedOn, 'fixed_on');
    const photoId = optionalId(input.evidencePhotoId, 'evidence_photo_id');
    const documentId = optionalId(input.evidenceDocumentVersionId, 'evidence_document_version_id');
    const held = await this.lock(tx, idOf(id, 'id'), expectedVersion, scopes);
    await assertContractorOwn(tx, actor, held.responder_contractor_id);
    const status = nextClaimStatus(held.status, 'FIX');
    if (fixedOn < held.reported_on) throw invalid('fixed_on', 'BEFORE_REPORT');
    if (photoId === null && documentId === null) throw new DomainError('EVIDENCE_REQUIRED', 422, 'evidence_photo_id');
    if (photoId !== null) await assertCleanPhoto(tx, photoId, held.contract_id, 'evidence_photo_id');
    if (documentId !== null) await assertCleanDocument(tx, documentId, 'evidence_document_version_id');
    await tx.query(
      `update machvon.warranty_claim
          set status = $2, fixed_on = $3::date, fixed_by = $4::uuid, fix_note = $5, fix_evidence_photo_id = $6::uuid, fix_evidence_document_version_id = $7::uuid,
              updated_at = now(), updated_by = $4::uuid, version = version + 1
        where id = $1::uuid`,
      [held.id, status, fixedOn, actor, note, photoId, documentId],
    );
    return this.resultOf(held, status, { fixedOn });
  }

  /** Somebody who neither reported the defect nor said it was put right verifies the repair, saying who bears the cost, or disputes it. */
  async verify(tx: TenantTx, id: string, expectedVersion: number, input: VerifyInput, actor: string, scopes: HandoverScopes, now: Date): Promise<ClaimResult> {
    const outcome = choice(CLAIM_VERIFICATIONS, input.outcome, 'outcome');
    const bearer = choice(COST_BEARERS, input.costBorneBy, 'cost_borne_by');
    const note = textOf(input.note, 'note', MAX_TEXT);
    const held = await this.lock(tx, idOf(id, 'id'), expectedVersion, scopes);
    const status = nextClaimStatus(held.status, outcome === 'VERIFIED' ? 'VERIFY' : 'DISPUTE');
    assertClaimVerifier(actor, held.reported_by, held.fixed_by);
    if (outcome === 'VERIFIED') {
      await tx.query(
        `update machvon.warranty_claim
            set status = $2, verified_by = $3::uuid, verified_at = $4::timestamptz, cost_borne_by = $5, verification_note = $6, updated_at = now(), updated_by = $3::uuid, version = version + 1
          where id = $1::uuid`,
        [held.id, status, actor, now.toISOString(), bearer, note],
      );
    } else {
      await tx.query(`update machvon.warranty_claim set status = $2, cost_borne_by = $3, verification_note = $4, updated_at = now(), updated_by = $5::uuid, version = version + 1 where id = $1::uuid`, [
        held.id,
        status,
        bearer,
        note,
        actor,
      ]);
    }
    return this.resultOf(held, status, { costBorneBy: bearer });
  }

  // ---- reads --------------------------------------------------------------------------------------------------------------

  /** The claims in the scope of the caller, the newest first; the cursor is the creation time and the id. */
  async list(tx: TenantTx, scope: ScopeBuilder, filter: ClaimFilter): Promise<ClaimLine[]> {
    const obligation = filter.obligationId === undefined ? null : idOf(filter.obligationId, 'obligation_id');
    const status = filter.status === undefined ? null : choice(['OPEN', 'ACKNOWLEDGED', 'REPAIRING', 'FIXED', 'VERIFIED', 'CLOSED', 'DISPUTED'] as const, filter.status, 'status');
    if (!Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > MAX_PAGE + 1) throw invalid('limit');
    assertTimestampCursor(filter.after?.code);
    const today = calendarDate(filter.today, 'today');
    const predicate = scope(6);
    const rows = await tx.query<LineSql>(
      `${SELECT} where ${predicate.sql} and ($1::uuid is null or w.id = $1::uuid) and ($2::text is null or k.status = $2)
          and ($3::text is null or (${timestampKey('k.created_at')}, k.id) < ($3::text, $4::uuid))
        order by k.created_at desc, k.id desc limit $5`,
      [obligation, status, filter.after?.code ?? null, filter.after?.id ?? null, filter.limit, ...predicate.params],
    );
    return rows.map((row) => toLine(row, today));
  }

  // ---- the job ------------------------------------------------------------------------------------------------------------

  /**
   * The claims nobody answered by their day (the day in Vietnam is after it), flagged once: each is locked and marked with the time, and handed to the caller for its event. A claim being flagged by another pass is
   * skipped, and one already flagged is not selected, so a second pass over the same day finds nothing.
   */
  async flagOverdue(tx: TenantTx, today: string, now: Date, actor: string): Promise<OverdueClaim[]> {
    const day = calendarDate(today, 'today');
    const due = await tx.query<{ id: string; claim_no: string; contract_id: string; project_id: string; owner_unit_id: string; severity: ClaimSeverity; response_due_on: string; version: string }>(
      `select k.id, k.claim_no, c.id as contract_id, c.project_id, p.owner_unit_id, k.severity, k.response_due_on::text as response_due_on, k.version::text as version
         from machvon.warranty_claim k
         join machvon.warranty_obligation w on w.tenant_id = k.tenant_id and w.id = k.obligation_id
         join machvon.contract c on c.tenant_id = w.tenant_id and c.id = w.contract_id
         join machvon.project p on p.tenant_id = c.tenant_id and p.id = c.project_id
        where k.status = 'OPEN' and k.escalated_at is null and k.response_due_on < $1::date
        order by k.response_due_on, k.id
        for update of k skip locked`,
      [day],
    );
    for (const row of due) {
      await tx.query('update machvon.warranty_claim set escalated_at = $2::timestamptz, updated_by = $3::uuid, updated_at = now() where id = $1::uuid', [row.id, now.toISOString(), actor]);
    }
    return due.map((row) => ({
      id: row.id,
      claimNo: row.claim_no,
      contractId: row.contract_id,
      projectId: row.project_id,
      ownerUnitId: row.owner_unit_id,
      severity: row.severity,
      responseDueOn: row.response_due_on,
      version: Number(row.version),
    }));
  }

  // ---- internals ----------------------------------------------------------------------------------------------------------

  private resultOf(held: Held, status: ClaimStatus, changed: { committedFixOn?: string; fixedOn?: string; costBorneBy?: CostBearer }): ClaimResult {
    return {
      id: held.id,
      obligationId: held.obligation_id,
      claimNo: held.claim_no,
      contractId: held.contract_id,
      contractCode: held.contract_code,
      handoverId: held.handover_id,
      projectId: held.project_id,
      severity: held.severity,
      responderContractorId: held.responder_contractor_id,
      reportedOn: held.reported_on,
      responseDueOn: held.response_due_on,
      committedFixOn: changed.committedFixOn ?? held.committed_fix_on,
      fixedOn: changed.fixedOn ?? held.fixed_on,
      costBorneBy: changed.costBorneBy ?? held.cost_borne_by,
      fromStatus: held.status,
      status,
      version: Number(held.version) + 1,
    };
  }

  /** The obligation a claim is filed on, inside the scope of the command; one the caller can read and not change is a refusal, one it cannot see does not exist. */
  private async obligation(
    tx: TenantTx,
    id: string,
    scopes: HandoverScopes,
  ): Promise<{ status: string; starts_on: string; ends_on: string; contract_id: string; contract_code: string; handover_id: string; project_id: string }> {
    const predicate = scopes.update(2);
    const columns = 'w.status, w.starts_on::text as starts_on, w.ends_on::text as ends_on, c.id as contract_id, c.code as contract_code, h.id as handover_id, c.project_id';
    const from = `${HANDOVER_FROM} join machvon.warranty_obligation w on w.tenant_id = h.tenant_id and w.handover_id = h.id`;
    const rows = await tx.query<{ status: string; starts_on: string; ends_on: string; contract_id: string; contract_code: string; handover_id: string; project_id: string }>(
      `select ${columns} from ${from} where w.id = $1::uuid and ${predicate.sql}`,
      [id, ...predicate.params],
    );
    if (rows[0] !== undefined) return rows[0];
    const readable = scopes.read(2);
    const seen = await tx.query(`select w.id from ${from} where w.id = $1::uuid and ${readable.sql}`, [id, ...readable.params]);
    throw seen[0] === undefined ? new DomainError('RESOURCE_NOT_FOUND', 404) : new DomainError('SCOPE_DENIED', 403);
  }

  /** The claim locked for update inside the scope of the command, at the version the caller saw. */
  private async lock(tx: TenantTx, id: string, expectedVersion: number, scopes: HandoverScopes): Promise<Held> {
    const predicate = scopes.update(2);
    const columns = `k.id, k.claim_no, k.obligation_id, c.id as contract_id, c.code as contract_code, h.id as handover_id, c.project_id, k.severity, k.responder_contractor_id, k.reported_on::text as reported_on,
              k.response_due_on::text as response_due_on, k.committed_fix_on::text as committed_fix_on, k.fixed_on::text as fixed_on, k.reported_by, k.fixed_by, k.cost_borne_by, k.status, k.version::text as version`;
    const rows = await tx.query<Held>(`select ${columns} from ${CLAIM_FROM} where k.id = $1::uuid and ${predicate.sql} for update of k`, [id, ...predicate.params]);
    const row = rows[0];
    if (row === undefined) {
      const readable = scopes.read(2);
      const seen = await tx.query(`select k.id from ${CLAIM_FROM} where k.id = $1::uuid and ${readable.sql}`, [id, ...readable.params]);
      throw seen[0] === undefined ? new DomainError('RESOURCE_NOT_FOUND', 404) : new DomainError('SCOPE_DENIED', 403);
    }
    if (Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    return row;
  }
}

/** The issue that a late answer opened is remembered on the claim (the intake calls this in the transaction that opens it); the claim keeps the first. */
export async function linkWarrantyIssue(tx: TenantTx, claimId: string, issueId: string): Promise<void> {
  await tx.query('update machvon.warranty_claim set issue_id = $2::uuid where id = $1::uuid and issue_id is null', [claimId, issueId]);
}
