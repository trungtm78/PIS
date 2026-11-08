import { randomUUID } from 'node:crypto';
import { DomainError, assertChecker, assertDecisionAllowed, nextOutcomeStatus, versionConflict } from '@machvon/kernel';
import type { PetitionDecision, PetitionOutcomeStatus } from '@machvon/kernel';
import { BidConflictStore } from './bid-conflict-store.ts';
import { timestampKey } from './keyset.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UNIQUE_VIOLATION = '23505';
const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export interface OutcomeInput {
  outcome: string;
  decisionRef: string;
  decisionOn: string;
  decisionDocumentId?: string | undefined;
  note?: string | undefined;
}

/** One recorded outcome as BID-34 shows it. */
export interface PetitionOutcomeLine {
  id: string;
  petitionId: string;
  package: { id: string; code: string };
  contractor: { id: string; legalName: string };
  projectId: string;
  petitionStatus: string;
  outcome: PetitionDecision;
  decisionRef: string;
  decisionOn: string;
  decisionDocumentId: string | null;
  note: string | null;
  status: PetitionOutcomeStatus;
  recordedBy: string;
  recordedByName: string | null;
  recordedAt: string;
  checkedBy: string | null;
  checkedByName: string | null;
  checkedAt: string | null;
  returnReason: string | null;
  version: number;
  reach: { ownerUnit: { id: string; path: string }; investorUnit: { id: string; path: string } | null };
}

interface Sql {
  id: string;
  petition_id: string;
  package_id: string;
  package_code: string;
  project_id: string;
  contractor_id: string;
  contractor_name: string | null;
  petition_status: string;
  outcome: PetitionDecision;
  decision_ref: string;
  decision_on: string;
  decision_document_id: string | null;
  note: string | null;
  status: PetitionOutcomeStatus;
  recorded_by: string;
  recorded_by_name: string | null;
  recorded_at: string;
  checked_by: string | null;
  checked_by_name: string | null;
  checked_at: string | null;
  return_reason: string | null;
  version: string;
  owner_unit_id: string;
  owner_unit_path: string;
  investor_unit_id: string | null;
  investor_unit_path: string | null;
}

const SELECT = `select o.id, o.petition_id, t.package_id, k.code as package_code, p.id as project_id, t.contractor_id, c.legal_name as contractor_name, t.status as petition_status, o.outcome, o.decision_ref,
       o.decision_on::text as decision_on, o.decision_document_id, o.note, o.status, o.recorded_by, ru.display_name as recorded_by_name, ${timestampKey('o.recorded_at')} as recorded_at, o.checked_by,
       cu.display_name as checked_by_name, ${timestampKey('o.checked_at')} as checked_at, o.return_reason, o.version::text as version,
       ou.id as owner_unit_id, ou.path as owner_unit_path, iu.id as investor_unit_id, iu.path as investor_unit_path
  from ${SCOPE_FROM}
  join machvon.procurement_package k on k.tenant_id = p.tenant_id and k.project_id = p.id
  join machvon.procurement_petition t on t.tenant_id = k.tenant_id and t.package_id = k.id
  join machvon.procurement_petition_outcome o on o.tenant_id = t.tenant_id and o.petition_id = t.id
  left join machvon.contractor c on c.tenant_id = t.tenant_id and c.id = t.contractor_id
  left join machvon.tenant_user_directory ru on ru.tenant_id = o.tenant_id and ru.membership_id = o.recorded_by
  left join machvon.tenant_user_directory cu on cu.tenant_id = o.tenant_id and cu.membership_id = o.checked_by`;

const toLine = (row: Sql): PetitionOutcomeLine => ({
  id: row.id,
  petitionId: row.petition_id,
  package: { id: row.package_id, code: row.package_code },
  contractor: { id: row.contractor_id, legalName: row.contractor_name ?? '' },
  projectId: row.project_id,
  petitionStatus: row.petition_status,
  outcome: row.outcome,
  decisionRef: row.decision_ref,
  decisionOn: row.decision_on,
  decisionDocumentId: row.decision_document_id,
  note: row.note,
  status: row.status,
  recordedBy: row.recorded_by,
  recordedByName: row.recorded_by_name,
  recordedAt: row.recorded_at,
  checkedBy: row.checked_by,
  checkedByName: row.checked_by_name,
  checkedAt: row.checked_at,
  returnReason: row.return_reason,
  version: Number(row.version),
  reach: {
    ownerUnit: { id: row.owner_unit_id, path: row.owner_unit_path },
    investorUnit: row.investor_unit_id === null || row.investor_unit_path === null ? null : { id: row.investor_unit_id, path: row.investor_unit_path },
  },
});

/**
 * The recorded outcome of a petition of a contractor (PORTAL-2; docs/plans/portal2.md, BID-34). One person records the decision of the authority (upheld, rejected or withdrawn, with its reference), a different person
 * confirms it or returns it with a reason; a confirmed outcome is final and is the only thing that feeds the dispute figures. Refusals in order: the shape (422), the petition (404 outside the scope), the status of the petition
 * (422 `PETITION_OUTCOME_NOT_ALLOWED`), a live outcome already there (409 `PETITION_OUTCOME_STATE_INVALID`), a conflict of interest of the caller with the contractor or the package (409 `CONFLICT_OF_INTEREST_BLOCKED`).
 */
export class BidPetitionOutcomeStore {
  private readonly conflicts: BidConflictStore;

  constructor(conflicts: BidConflictStore = new BidConflictStore()) {
    this.conflicts = conflicts;
  }

  async record(tx: TenantTx, petitionId: string, input: OutcomeInput, actor: string, scope: ScopeBuilder): Promise<PetitionOutcomeLine> {
    if (!UUID.test(petitionId)) throw invalid('petition_id');
    const decisionRef = input.decisionRef.trim();
    if (decisionRef.length < 3 || decisionRef.length > 120) throw invalid('decision_ref');
    if (!DATE.test(input.decisionOn) || Number.isNaN(Date.parse(`${input.decisionOn}T00:00:00Z`))) throw invalid('decision_on');
    const note = input.note === undefined || input.note.trim() === '' ? null : input.note.trim();
    if (note !== null && note.length > 1000) throw invalid('note');
    const predicate = scope(2);
    const petition = (
      await tx.query<{ id: string; status: string; contractor_id: string; package_id: string; received_on: string }>(
        `select t.id, t.status, t.contractor_id, t.package_id, t.received_on::text as received_on
           from ${SCOPE_FROM} join machvon.procurement_package k on k.tenant_id = p.tenant_id and k.project_id = p.id join machvon.procurement_petition t on t.tenant_id = k.tenant_id and t.package_id = k.id
          where t.id = $1::uuid and ${predicate.sql} for update of p, k, t`,
        [petitionId, ...predicate.params],
      )
    )[0];
    if (petition === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const decision = assertDecisionAllowed(input.outcome, petition.status);
    if (input.decisionOn < petition.received_on) throw invalid('decision_on');
    await this.assertNotConflicted(tx, actor, petition.contractor_id, petition.package_id);
    if (input.decisionDocumentId !== undefined) {
      if (!UUID.test(input.decisionDocumentId)) throw invalid('decision_document_id');
      if ((await tx.query('select 1 from machvon.document where id = $1::uuid', [input.decisionDocumentId])).length === 0) throw invalid('decision_document_id');
    }
    const id = randomUUID();
    try {
      await tx.query(
        `insert into machvon.procurement_petition_outcome (tenant_id, id, petition_id, outcome, decision_ref, decision_on, decision_document_id, note, status, recorded_by)
         values (${TENANT}, $1::uuid, $2::uuid, $3, $4, $5::date, $6::uuid, $7, 'PROPOSED', $8::uuid)`,
        [id, petition.id, decision, decisionRef, input.decisionOn, input.decisionDocumentId ?? null, note, actor],
      );
    } catch (error) {
      if (typeof error === 'object' && error !== null && (error as { code?: string }).code === UNIQUE_VIOLATION) throw new DomainError('PETITION_OUTCOME_STATE_INVALID', 409, 'petition_id');
      throw error;
    }
    return (await this.find(tx, id, scope)) as PetitionOutcomeLine;
  }

  private async assertNotConflicted(tx: TenantTx, actor: string, contractorId: string, packageId: string): Promise<void> {
    const declaration = await this.conflicts.blockingDeclaration(tx, actor, contractorId, packageId);
    if (declaration !== undefined) throw new DomainError('CONFLICT_OF_INTEREST_BLOCKED', 409, 'actor', { extensions: { contractor_id: contractorId, declaration_id: declaration.id, conflict_of: 'HANDLER' } });
  }

  async find(tx: TenantTx, id: string, scope: ScopeBuilder, lock = false): Promise<PetitionOutcomeLine | undefined> {
    const predicate = scope(2);
    const rows = await tx.query<Sql>(`${SELECT} where o.id = $1::uuid and ${predicate.sql}${lock ? ' for update of o' : ''}`, [id, ...predicate.params]);
    return rows[0] === undefined ? undefined : toLine(rows[0]);
  }

  async list(tx: TenantTx, scope: ScopeBuilder, filter: { petitionId?: string | undefined; status?: string | undefined }): Promise<PetitionOutcomeLine[]> {
    const predicate = scope(3);
    const rows = await tx.query<Sql>(
      `${SELECT} where ${predicate.sql} and ($1::uuid is null or o.petition_id = $1::uuid) and ($2::text is null or o.status = $2)
        order by (o.status = 'PROPOSED') desc, o.recorded_at desc, o.id limit 500`,
      [filter.petitionId ?? null, filter.status ?? null, ...predicate.params],
    );
    return rows.map(toLine);
  }

  private async held(tx: TenantTx, id: string, expectedVersion: number, scope: ScopeBuilder): Promise<PetitionOutcomeLine> {
    const line = await this.find(tx, id, scope, true);
    if (line === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (line.version !== expectedVersion) throw versionConflict(line.version);
    return line;
  }

  /** Confirms an outcome: a different person than the recorder, free of a conflict with the contractor or package. A confirmed withdrawal also moves a petition that still waits to WITHDRAWN. */
  async confirm(tx: TenantTx, id: string, expectedVersion: number, actor: string, scope: ScopeBuilder, now: Date): Promise<PetitionOutcomeLine> {
    const line = await this.held(tx, id, expectedVersion, scope);
    nextOutcomeStatus(line.status, 'CONFIRM');
    assertChecker(line.recordedBy, actor);
    await this.assertNotConflicted(tx, actor, line.contractor.id, line.package.id);
    // The petition may have moved since the outcome was recorded (answered, passed up): the decision is judged again against the status it has NOW, with the row locked.
    const current = (await tx.query<{ status: string }>('select status from machvon.procurement_petition where id = $1::uuid for update', [line.petitionId]))[0];
    if (current === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    assertDecisionAllowed(line.outcome, current.status);
    await tx.query(`update machvon.procurement_petition_outcome set status = 'CONFIRMED', checked_by = $2::uuid, checked_at = $3::timestamptz, version = version + 1 where id = $1::uuid`, [id, actor, now.toISOString()]);
    if (line.outcome === 'WITHDRAWN' && (current.status === 'RECEIVED' || current.status === 'PROCESSING')) {
      await tx.query(`update machvon.procurement_petition set status = 'WITHDRAWN', updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid`, [line.petitionId, actor]);
    }
    return (await this.find(tx, id, scope)) as PetitionOutcomeLine;
  }

  async returnOutcome(tx: TenantTx, id: string, expectedVersion: number, actor: string, reason: string, scope: ScopeBuilder, now: Date): Promise<PetitionOutcomeLine> {
    const line = await this.held(tx, id, expectedVersion, scope);
    nextOutcomeStatus(line.status, 'RETURN', reason);
    assertChecker(line.recordedBy, actor);
    await tx.query(`update machvon.procurement_petition_outcome set status = 'RETURNED', checked_by = $2::uuid, checked_at = $3::timestamptz, return_reason = $4, version = version + 1 where id = $1::uuid`, [id, actor, now.toISOString(), reason.trim()]);
    return (await this.find(tx, id, scope)) as PetitionOutcomeLine;
  }
}
