import { randomUUID } from 'node:crypto';
import {
  DomainError,
  LIVE_MEASUREMENT_STATUSES,
  addDecimal,
  assertMeasurementTransition,
  assertNotDecrease,
  assertNotProposer,
  assertWithinBoq,
  compareDecimal,
  cumulativeQuantity,
  quantityOf,
  requiresPermitGate,
  versionConflict,
} from '@machvon/kernel';
import type { MeasurementStatus } from '@machvon/kernel';
import { CtrContractStore, SCOPE_FROM as CONTRACT_SCOPE_FROM, TIMESTAMP, textOf } from './ctr-contract-store.ts';
import type { ContractPlace, ContractScopes } from './ctr-contract-store.ts';
import { PmtGateStore } from './pmt-gate-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export const START_GATE = 'START_CONSTRUCTION';
const MAX_TEXT = 2000;
const MAX_EVIDENCE = 50;
const MAX_REFERENCES = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT = `nullif(current_setting('app.tenant_id', true), '')::uuid`;
const LIVE = LIVE_MEASUREMENT_STATUSES.map((status) => `'${status}'`).join(', ');
/** The contract states in which a measurement is corrected: it is being performed, or the work is stopped for the moment. */
const CORRECTABLE_CONTRACT_STATUSES: readonly string[] = ['ACTIVE', 'SUSPENDED'];

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export interface RecordInput {
  contractRevisionId: string;
  boqItemId: string;
  partyId?: string | undefined;
  periodId: string;
  quantityPeriod: string;
  referenceNo: string;
  duplicateOverrideReason?: string | undefined;
  evidenceRefs: unknown;
  inspectionId?: string | undefined;
}

export interface CorrectInput {
  quantityPeriod: string;
  correctionReason: string;
  evidenceRefs: unknown;
}

export interface DecideInput {
  decision: string;
  reason: string;
  evidenceIds: readonly string[];
}

/** One measurement as the register and the commands show it, with the contract, the item and the period it belongs to. */
export interface MeasurementLine {
  id: string;
  contract: { id: string; code: string; status: string };
  projectId: string;
  contractRevisionId: string;
  /** The number of the revision of the contract the quantity was recorded under. */
  contractRevisionNo: number;
  boqLineId: string;
  boqItem: { id: string; businessKey: string; description: string; unitCode: string };
  /** The quantity of the item in the revision it was recorded under; exact decimal text with six digits. */
  boqQuantity: string;
  /** What is left of the quantity of the item in the revision in force, after all that is recorded (approved or waiting) for it in the contract: six digits, never below zero. */
  remainingQuantity: string;
  partyId: string | null;
  period: { id: string; code: string };
  quantityPeriod: string;
  quantityCumulative: string;
  /** The number of this record in the chain of corrections of the measurement of the item in the period: 1 for the first. */
  revision: number;
  status: MeasurementStatus;
  evidenceRefs: unknown[];
  referenceNo: string | null;
  duplicateOverrideReason: string | null;
  correctionOfId: string | null;
  correctionReason: string | null;
  inspectionId: string | null;
  createdBy: string;
  createdAt: string;
  submittedBy: string | null;
  submittedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  version: number;
  reach: ContractPlace;
}

/** What a command answers, for the audit row, the event and the answer. */
export interface MeasurementResult {
  id: string;
  contractId: string;
  contractCode: string;
  projectId: string;
  boqItemId: string;
  businessKey: string;
  periodId: string;
  quantityPeriod: string;
  quantityCumulative: string;
  revision: number;
  status: MeasurementStatus;
  fromStatus: MeasurementStatus | null;
  version: number;
  referenceNo: string | null;
  correctionOfId: string | null;
  /** What is left of the quantity of the item after this measurement and what was recorded before it. */
  remainingQuantity: string;
  evidenceIds: string[];
}

interface Row {
  id: string;
  contract_id: string;
  contract_code: string;
  contract_status: string;
  project_id: string;
  contract_revision_id: string;
  contract_revision_no: number;
  boq_line_id: string;
  boq_item_id: string;
  business_key: string;
  description: string;
  unit_code: string;
  boq_quantity: string;
  remaining_quantity: string;
  party_id: string | null;
  period_id: string;
  period_code: string;
  quantity_period: string;
  quantity_cumulative: string;
  revision: number;
  status: MeasurementStatus;
  evidence_refs: unknown;
  reference_no: string | null;
  duplicate_override_reason: string | null;
  correction_of_id: string | null;
  correction_reason: string | null;
  inspection_id: string | null;
  created_by: string;
  created_at: string;
  submitted_by: string | null;
  submitted_at: string | null;
  decided_by: string | null;
  decided_at: string | null;
  version: string;
  owner_unit_id: string;
  owner_unit_path: string;
  investor_unit_id: string | null;
  investor_unit_path: string | null;
}

/** The quantity of the item in the revision in force less what is recorded for it in the contract (a draft, a submitted and an approved measurement count). */
const REMAINING = `greatest(
    coalesce((select e.quantity from machvon.boq_line e join machvon.contract_revision er on er.tenant_id = e.tenant_id and er.id = e.contract_revision_id
               where e.tenant_id = m.tenant_id and e.contract_id = m.contract_id and e.boq_item_id = m.boq_item_id and er.status = 'EFFECTIVE'), 0)
    - (select coalesce(sum(x.quantity_period), 0) from machvon.measurement x where x.tenant_id = m.tenant_id and x.contract_id = m.contract_id and x.boq_item_id = m.boq_item_id and x.status in (${LIVE})), 0)::numeric(30,6)::text`;

const COLUMNS = `m.id, m.contract_id, c.code as contract_code, c.status as contract_status, c.project_id, m.contract_revision_id, cr.revision as contract_revision_no, m.boq_line_id, m.boq_item_id,
  i.business_key, i.description, i.unit_code, l.quantity::text as boq_quantity, ${REMAINING} as remaining_quantity, m.party_id, m.period_id, rp.code as period_code, m.quantity_period::text as quantity_period,
  m.quantity_cumulative::text as quantity_cumulative, m.revision, m.status, m.evidence_refs, m.reference_no, m.duplicate_override_reason, m.correction_of_id, m.correction_reason, m.inspection_id,
  m.created_by, ${TIMESTAMP('m.created_at')} as created_at, m.submitted_by, ${TIMESTAMP('m.submitted_at')} as submitted_at, m.decided_by, ${TIMESTAMP('m.decided_at')} as decided_at, m.version::text as version,
  ou.id as owner_unit_id, ou.path as owner_unit_path, iu.id as investor_unit_id, iu.path as investor_unit_path`;

/** The contract with its project and units (the aliases of the scope builders: `c`, `p`, `ou`, `iu`) and its measurements with the item, the line, the period and the revision. */
const FROM = `${CONTRACT_SCOPE_FROM}
  join machvon.measurement m on m.tenant_id = c.tenant_id and m.contract_id = c.id
  join machvon.boq_item i on i.tenant_id = m.tenant_id and i.id = m.boq_item_id
  join machvon.boq_line l on l.tenant_id = m.tenant_id and l.id = m.boq_line_id
  join machvon.reporting_period rp on rp.tenant_id = m.tenant_id and rp.id = m.period_id
  join machvon.contract_revision cr on cr.tenant_id = m.tenant_id and cr.id = m.contract_revision_id`;

/** A draft is seen by whoever recorded it; the parameter at `position` is the caller. */
const visible = (position: number): string => `(m.status <> 'DRAFT' or m.created_by = $${position}::uuid)`;

const evidenceList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const toLine = (row: Row): MeasurementLine => ({
  id: row.id,
  contract: { id: row.contract_id, code: row.contract_code, status: row.contract_status },
  projectId: row.project_id,
  contractRevisionId: row.contract_revision_id,
  contractRevisionNo: row.contract_revision_no,
  boqLineId: row.boq_line_id,
  boqItem: { id: row.boq_item_id, businessKey: row.business_key, description: row.description, unitCode: row.unit_code },
  boqQuantity: row.boq_quantity,
  remainingQuantity: row.remaining_quantity,
  partyId: row.party_id,
  period: { id: row.period_id, code: row.period_code },
  quantityPeriod: row.quantity_period,
  quantityCumulative: row.quantity_cumulative,
  revision: row.revision,
  status: row.status,
  evidenceRefs: evidenceList(row.evidence_refs),
  referenceNo: row.reference_no,
  duplicateOverrideReason: row.duplicate_override_reason,
  correctionOfId: row.correction_of_id,
  correctionReason: row.correction_reason,
  inspectionId: row.inspection_id,
  createdBy: row.created_by,
  createdAt: row.created_at,
  submittedBy: row.submitted_by,
  submittedAt: row.submitted_at,
  decidedBy: row.decided_by,
  decidedAt: row.decided_at,
  version: Number(row.version),
  reach: {
    contractId: row.contract_id,
    projectId: row.project_id,
    ownerUnit: { id: row.owner_unit_id, path: row.owner_unit_path },
    investorUnit: row.investor_unit_id === null || row.investor_unit_path === null ? null : { id: row.investor_unit_id, path: row.investor_unit_path },
  },
});

/** The references to evidence: a list of objects that each name a version of a file of the tenant (`document_version_id`); at least one to submit, at most fifty. */
function referencesOf(value: unknown, field: string): Array<{ document_version_id: string }> {
  if (!Array.isArray(value) || value.length > MAX_REFERENCES) throw invalid(field);
  return value.map((reference): { document_version_id: string } => {
    const id = typeof reference === 'object' && reference !== null ? (reference as Record<string, unknown>).document_version_id : undefined;
    if (typeof id !== 'string' || !UUID.test(id)) throw invalid(field);
    return { document_version_id: id.toLowerCase() };
  });
}

/**
 * The measurements of work done under a contract (ST-CTR-008, CTR 3.4). The contractor or the supervisor records the quantity of one BOQ item in one period (DRAFT), submits it with its
 * evidence, and someone else approves it; what is approved never decreases without a correction, and what is recorded (approved or waiting) never goes above the quantity of the item in
 * the revision in force. The row of the item is locked while a quantity is judged, so two measurements recorded at the same moment cannot both fit the last of the quantity.
 */
export class CtrMeasurementStore {
  private readonly contracts = new CtrContractStore();
  private readonly gates = new PmtGateStore();

  // ---- the commands ---------------------------------------------------------------------------------------------------------

  /**
   * Records a quantity in DRAFT. Refusals in order: the shape (422), the contract (404 outside the scope, 403 where it may be read and not changed, 409 `CONTRACT_STATE_INVALID` unless it is
   * ACTIVE: a suspended contract takes no new quantity), the revision (422 `REVISION_NOT_EFFECTIVE`), the item and the period, the quantity (422 `CUMULATIVE_DECREASE_WITHOUT_CORRECTION` for a
   * negative one, 422 `QUANTITY_EXCEEDS_BOQ` above what is left), the permit gate of the start of construction (422 `PERMIT_GATE_BLOCKED`), and the number of the record (409
   * `MEASUREMENT_REFERENCE_DUPLICATE`).
   */
  async record(tx: TenantTx, contractId: string, input: RecordInput, actor: string, scopes: ContractScopes, today: string): Promise<MeasurementResult> {
    const revisionId = this.idOf(input.contractRevisionId, 'contract_revision_id');
    const itemId = this.idOf(input.boqItemId, 'boq_item_id');
    const periodId = this.idOf(input.periodId, 'period_id');
    const partyId = input.partyId === undefined ? null : this.idOf(input.partyId, 'party_id');
    const inspectionId = input.inspectionId === undefined ? null : this.idOf(input.inspectionId, 'inspection_id');
    const quantity = quantityOf(input.quantityPeriod, 'quantity_period');
    const reference = textOf(input.referenceNo, 'reference_no', MAX_TEXT);
    const override = input.duplicateOverrideReason === undefined ? null : textOf(input.duplicateOverrideReason, 'duplicate_override_reason', MAX_TEXT);
    const evidence = referencesOf(input.evidenceRefs, 'evidence_refs');
    assertNotDecrease(quantity);
    if (compareDecimal(quantity, '0') === 0) throw invalid('quantity_period');

    const contract = await this.contracts.lock(tx, contractId, scopes);
    if (contract.status !== 'ACTIVE') throw new DomainError('CONTRACT_STATE_INVALID', 409, 'contract_id', { extensions: { contract_status: contract.status } });
    const revision = (await tx.query<{ status: string; contract_id: string }>('select status, contract_id from machvon.contract_revision where id = $1::uuid', [revisionId]))[0];
    if (revision === undefined || revision.contract_id !== contractId) throw invalid('contract_revision_id');
    if (revision.status !== 'EFFECTIVE') throw new DomainError('REVISION_NOT_EFFECTIVE', 422, 'contract_revision_id', { extensions: { revision_status: revision.status } });
    const line = await this.lockItemLine(tx, contractId, itemId, revisionId);
    if (partyId !== null) await this.assertParty(tx, contractId, partyId);
    await this.assertPeriod(tx, periodId);
    await this.assertEvidence(tx, evidence);
    if (inspectionId !== null) await this.assertInspection(tx, contractId, inspectionId);
    const category = (await tx.query<{ advance_category: string }>('select advance_category from machvon.contract where id = $1::uuid', [contractId]))[0]?.advance_category ?? '';
    if (requiresPermitGate(category)) await this.assertStartGate(tx, contract.projectId, today);

    const taken = await tx.query<{ id: string }>(`select id from machvon.measurement where contract_id = $1::uuid and boq_item_id = $2::uuid and period_id = $3::uuid and status in (${LIVE}) limit 1`, [contractId, itemId, periodId]);
    if (taken[0] !== undefined) throw new DomainError('MEASUREMENT_STATE_INVALID', 409, 'period_id', { extensions: { reason: 'PERIOD_ALREADY_MEASURED', measurement_id: taken[0].id } });
    if (override === null) await this.assertReferenceFree(tx, contractId, reference);

    const totals = await this.totalsOf(tx, contractId, itemId);
    assertWithinBoq(line.quantity, totals.live, quantity);
    const cumulative = cumulativeQuantity(totals.approved, quantity);
    const revisionNo = Number((await tx.query<{ next: string }>('select (coalesce(max(revision), 0) + 1)::text as next from machvon.measurement where contract_revision_id = $1::uuid and boq_line_id = $2::uuid and period_id = $3::uuid', [revisionId, line.id, periodId]))[0]?.next ?? '1');
    const id = randomUUID();
    await tx.query(
      `insert into machvon.measurement
         (tenant_id, id, contract_id, contract_revision_id, boq_line_id, boq_item_id, party_id, period_id, quantity_period, quantity_cumulative, revision, status, evidence_refs, reference_no,
          duplicate_override_reason, inspection_id, created_by, updated_by, version)
       values (${TENANT}, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::numeric, $9::numeric, $10, 'DRAFT', $11::jsonb, $12, $13, $14::uuid, $15::uuid, $15::uuid, 1)`,
      [id, contractId, revisionId, line.id, itemId, partyId, periodId, quantity, cumulative, revisionNo, JSON.stringify(evidence), reference, override, inspectionId, actor],
    );
    return this.resultOf(tx, id, null, line.quantity, totals.live, quantity);
  }

  /** Sends a measurement for decision: DRAFT to SUBMITTED, with evidence (422 `EVIDENCE_REQUIRED`), while the contract is being performed (409 `CONTRACT_STATE_INVALID`). */
  async submit(tx: TenantTx, id: string, expectedVersion: number, actor: string, scopes: ContractScopes): Promise<MeasurementResult> {
    const held = await this.lock(tx, id, expectedVersion, scopes);
    assertMeasurementTransition('submit', held.row.status);
    if (held.contract.status !== 'ACTIVE') throw new DomainError('CONTRACT_STATE_INVALID', 409, 'contract_id', { extensions: { contract_status: held.contract.status } });
    if (evidenceList(held.row.evidence_refs).length === 0) throw new DomainError('EVIDENCE_REQUIRED', 422, 'evidence_refs');
    await tx.query("update machvon.measurement set status = 'SUBMITTED', submitted_by = $2::uuid, submitted_at = now(), updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid", [id, actor]);
    return this.resultOf(tx, id, held.row.status, held.row.boq_quantity, null, null);
  }

  /**
   * Decides a submitted measurement: approve it (its cumulative is counted from what was approved, and it is judged against the quantity of the item in the revision in force once more),
   * reject it, or give it back to its maker. Not by whoever recorded or submitted it (403 `SELF_APPROVAL_DENIED`).
   */
  async decide(tx: TenantTx, id: string, expectedVersion: number, input: DecideInput, actor: string, scopes: ContractScopes): Promise<MeasurementResult & { decision: 'approve' | 'return' | 'reject'; reason: string }> {
    const decision = input.decision === 'approve' || input.decision === 'return' || input.decision === 'reject' ? input.decision : undefined;
    if (decision === undefined) throw invalid('decision');
    const reason = textOf(input.reason, 'reason', MAX_TEXT);
    const evidenceIds = this.documentIds(input.evidenceIds, 'evidence_ids');
    const held = await this.lock(tx, id, expectedVersion, scopes);
    const row = held.row;
    assertMeasurementTransition(decision, row.status);
    assertNotProposer(actor, [row.submitted_by, row.created_by]);
    await this.assertDocuments(tx, evidenceIds, 'evidence_ids');
    if (decision === 'approve') {
      await this.lockItem(tx, row.contract_id, row.boq_item_id);
      const totals = await this.totalsOf(tx, row.contract_id, row.boq_item_id);
      const boqNow = await this.quantityInForce(tx, row.contract_id, row.boq_item_id);
      // What is recorded without this measurement, and this measurement, must still fit the quantity of the item as it stands now.
      assertWithinBoq(boqNow, addDecimal(totals.live, `-${row.quantity_period}`), row.quantity_period);
      const cumulative = cumulativeQuantity(totals.approved, row.quantity_period);
      await tx.query(
        "update machvon.measurement set status = 'APPROVED', quantity_cumulative = $2::numeric, decided_by = $3::uuid, decided_at = now(), updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid",
        [id, cumulative, actor],
      );
    } else if (decision === 'reject') {
      await tx.query("update machvon.measurement set status = 'REJECTED', decided_by = $2::uuid, decided_at = now(), updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid", [id, actor]);
    } else {
      await tx.query("update machvon.measurement set status = 'DRAFT', updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid", [id, actor]);
    }
    const result = await this.resultOf(tx, id, row.status, row.boq_quantity, null, null);
    return { ...result, decision, reason, evidenceIds };
  }

  /**
   * Corrects an approved measurement: it becomes SUPERSEDED and the next revision of the measurement is written in DRAFT with the new quantity, the reason and the evidence, counted from what
   * was approved without it. A measurement that an active acceptance holds is not corrected (409 `MEASUREMENT_IN_ACTIVE_ACCEPTANCE`).
   */
  async correct(tx: TenantTx, id: string, expectedVersion: number, input: CorrectInput, actor: string, scopes: ContractScopes): Promise<MeasurementResult> {
    const quantity = quantityOf(input.quantityPeriod, 'quantity_period');
    const reason = textOf(input.correctionReason, 'correction_reason', MAX_TEXT);
    const evidence = referencesOf(input.evidenceRefs, 'evidence_refs');
    if (compareDecimal(quantity, '0') < 0) throw invalid('quantity_period');
    const held = await this.lock(tx, id, expectedVersion, scopes);
    const row = held.row;
    assertMeasurementTransition('supersede', row.status);
    if (!CORRECTABLE_CONTRACT_STATUSES.includes(held.contract.status)) throw new DomainError('CONTRACT_STATE_INVALID', 409, 'contract_id', { extensions: { contract_status: held.contract.status } });
    const accepted = await tx.query<{ id: string }>('select id from machvon.acceptance_line where measurement_id = $1::uuid and active limit 1', [id]);
    if (accepted[0] !== undefined) throw new DomainError('MEASUREMENT_IN_ACTIVE_ACCEPTANCE', 409, 'measurement_id', { extensions: { acceptance_line_id: accepted[0].id } });
    await this.assertEvidence(tx, evidence);
    await this.lockItem(tx, row.contract_id, row.boq_item_id);
    // The old one stops counting before the new quantity is judged against the quantity of the item.
    await tx.query("update machvon.measurement set status = 'SUPERSEDED', updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid", [id, actor]);
    const totals = await this.totalsOf(tx, row.contract_id, row.boq_item_id);
    const boqNow = await this.quantityInForce(tx, row.contract_id, row.boq_item_id);
    assertWithinBoq(boqNow, totals.live, quantity);
    const cumulative = cumulativeQuantity(totals.approved, quantity);
    const next = Number((await tx.query<{ next: string }>('select (coalesce(max(revision), 0) + 1)::text as next from machvon.measurement where contract_revision_id = $1::uuid and boq_line_id = $2::uuid and period_id = $3::uuid', [row.contract_revision_id, row.boq_line_id, row.period_id]))[0]?.next ?? '2');
    const newId = randomUUID();
    await tx.query(
      `insert into machvon.measurement
         (tenant_id, id, contract_id, contract_revision_id, boq_line_id, boq_item_id, party_id, period_id, quantity_period, quantity_cumulative, revision, status, evidence_refs, reference_no,
          duplicate_override_reason, correction_of_id, correction_reason, inspection_id, created_by, updated_by, version)
       values (${TENANT}, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::numeric, $9::numeric, $10, 'DRAFT', $11::jsonb, $12, $13, $14::uuid, $15, $16::uuid, $17::uuid, $17::uuid, 1)`,
      [newId, row.contract_id, row.contract_revision_id, row.boq_line_id, row.boq_item_id, row.party_id, row.period_id, quantity, cumulative, next, JSON.stringify(evidence), row.reference_no, row.duplicate_override_reason, id, reason, row.inspection_id, actor],
    );
    return this.resultOf(tx, newId, row.status, boqNow, totals.live, quantity);
  }

  // ---- the reads -----------------------------------------------------------------------------------------------------------

  /**
   * The measurements of the contracts in the scope of the caller, the oldest first; one contract when named. `after` is the creation time and the id of the last one read. A draft is the
   * work of whoever recorded it until it is sent, so the others (the owner's staff, the supervisor, another member of the contractor) do not see it: `viewer` is the caller.
   */
  async list(tx: TenantTx, scope: ScopeBuilder, viewer: string, filter: { contractId?: string | undefined; limit?: number | undefined; after?: { createdAt: string; id: string } | undefined }): Promise<MeasurementLine[]> {
    const predicate = scope(5);
    const rows = await tx.query<Row>(
      `select ${COLUMNS} from ${FROM}
        where ${predicate.sql} and ${visible(4)} and ($1::uuid is null or m.contract_id = $1::uuid) and ($2::text is null or (${TIMESTAMP('m.created_at')}, m.id) > ($2::text, $3::uuid))
        order by ${TIMESTAMP('m.created_at')}, m.id limit ${Math.min(Math.max(filter.limit ?? 200, 1), 1000)}`,
      [filter.contractId ?? null, filter.after?.createdAt ?? null, filter.after?.id ?? null, viewer, ...predicate.params],
    );
    return rows.map(toLine);
  }

  async find(tx: TenantTx, id: string, scope: ScopeBuilder, viewer: string): Promise<MeasurementLine | undefined> {
    const predicate = scope(3);
    const rows = await tx.query<Row>(`select ${COLUMNS} from ${FROM} where m.id = $1::uuid and ${visible(2)} and ${predicate.sql}`, [id, viewer, ...predicate.params]);
    return rows[0] === undefined ? undefined : toLine(rows[0]);
  }

  // ---- internals ------------------------------------------------------------------------------------------------------------

  /** The measurement locked for update inside the scope of the command, with its contract locked first and judged by the scope; one the caller cannot see does not exist. */
  private async lock(tx: TenantTx, id: string, expectedVersion: number, scopes: ContractScopes): Promise<{ row: Row; contract: { status: string } }> {
    const peek = await tx.query<{ contract_id: string }>('select contract_id from machvon.measurement where id = $1::uuid', [id]);
    if (peek[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const contract = await this.contracts.lock(tx, peek[0].contract_id, scopes);
    const rows = await tx.query<Row>(`select ${COLUMNS} from ${FROM} where m.id = $1::uuid for update of m`, [id]);
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    return { row, contract };
  }

  private async resultOf(tx: TenantTx, id: string, fromStatus: MeasurementStatus | null, boqQuantity: string, recordedBefore: string | null, quantity: string | null): Promise<MeasurementResult> {
    const rows = await tx.query<Row>(`select ${COLUMNS} from ${FROM} where m.id = $1::uuid`, [id]);
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const live = recordedBefore !== null && quantity !== null ? addDecimal(recordedBefore, quantity) : (await this.totalsOf(tx, row.contract_id, row.boq_item_id)).live;
    const left = compareDecimal(boqQuantity, live) < 0 ? '0.000000' : cumulativeQuantity(boqQuantity, `-${live}`);
    return {
      id: row.id,
      contractId: row.contract_id,
      contractCode: row.contract_code,
      projectId: row.project_id,
      boqItemId: row.boq_item_id,
      businessKey: row.business_key,
      periodId: row.period_id,
      quantityPeriod: row.quantity_period,
      quantityCumulative: row.quantity_cumulative,
      revision: row.revision,
      status: row.status,
      fromStatus,
      version: Number(row.version),
      referenceNo: row.reference_no,
      correctionOfId: row.correction_of_id,
      remainingQuantity: left,
      evidenceIds: evidenceList(row.evidence_refs).flatMap((reference) => {
        const documentId = (reference as Record<string, unknown>).document_version_id;
        return typeof documentId === 'string' ? [documentId] : [];
      }),
    };
  }

  /** What has been recorded for the item in the contract: all that still counts (draft, submitted, approved) and what was approved, as exact decimals with six digits. */
  private async totalsOf(tx: TenantTx, contractId: string, itemId: string): Promise<{ live: string; approved: string }> {
    const rows = await tx.query<{ live: string; approved: string }>(
      `select coalesce(sum(quantity_period) filter (where status in (${LIVE})), 0)::numeric(30,6)::text as live,
              coalesce(sum(quantity_period) filter (where status = 'APPROVED'), 0)::numeric(30,6)::text as approved
         from machvon.measurement where contract_id = $1::uuid and boq_item_id = $2::uuid`,
      [contractId, itemId],
    );
    return { live: rows[0]?.live ?? '0.000000', approved: rows[0]?.approved ?? '0.000000' };
  }

  /** The quantity of the item in the revision that is in force now; nothing when the revision in force does not price it. */
  private async quantityInForce(tx: TenantTx, contractId: string, itemId: string): Promise<string> {
    const rows = await tx.query<{ quantity: string }>(
      `select l.quantity::text as quantity from machvon.boq_line l join machvon.contract_revision r on r.tenant_id = l.tenant_id and r.id = l.contract_revision_id
        where l.contract_id = $1::uuid and l.boq_item_id = $2::uuid and r.status = 'EFFECTIVE'`,
      [contractId, itemId],
    );
    return rows[0]?.quantity ?? '0';
  }

  /** Locks the row of the item (the quantities of an item are judged one at a time) and returns the line that prices it in the revision. */
  private async lockItemLine(tx: TenantTx, contractId: string, itemId: string, revisionId: string): Promise<{ id: string; quantity: string }> {
    await this.lockItem(tx, contractId, itemId);
    const lines = await tx.query<{ id: string; quantity: string }>('select id, quantity::text as quantity from machvon.boq_line where contract_revision_id = $1::uuid and boq_item_id = $2::uuid', [revisionId, itemId]);
    if (lines[0] === undefined) throw invalid('boq_item_id');
    return lines[0];
  }

  private async lockItem(tx: TenantTx, contractId: string, itemId: string): Promise<void> {
    const item = await tx.query<{ status: string }>('select status from machvon.boq_item where id = $1::uuid and contract_id = $2::uuid for update', [itemId, contractId]);
    if (item[0] === undefined || item[0].status !== 'ACTIVE') throw invalid('boq_item_id');
  }

  private async assertParty(tx: TenantTx, contractId: string, partyId: string): Promise<void> {
    const rows = await tx.query<{ id: string }>("select id from machvon.contract_party where id = $1::uuid and contract_id = $2::uuid and status = 'ACTIVE'", [partyId, contractId]);
    if (rows[0] === undefined) throw invalid('party_id');
  }

  private async assertPeriod(tx: TenantTx, periodId: string): Promise<void> {
    const rows = await tx.query<{ id: string }>('select id from machvon.reporting_period where id = $1::uuid', [periodId]);
    if (rows[0] === undefined) throw invalid('period_id');
  }

  private async assertInspection(tx: TenantTx, contractId: string, inspectionId: string): Promise<void> {
    const rows = await tx.query<{ id: string }>('select id from machvon.inspection where id = $1::uuid and contract_id = $2::uuid', [inspectionId, contractId]);
    if (rows[0] === undefined) throw invalid('inspection_id');
  }

  private async assertEvidence(tx: TenantTx, references: ReadonlyArray<{ document_version_id: string }>): Promise<void> {
    if (references.length === 0) return;
    const ids = [...new Set(references.map((reference) => reference.document_version_id))];
    const rows = await tx.query<{ id: string }>("select id from machvon.document_version where id = any($1::uuid[]) and scan_status = 'CLEAN'", [ids]);
    if (rows.length !== ids.length) throw invalid('evidence_refs');
  }

  private async assertReferenceFree(tx: TenantTx, contractId: string, reference: string): Promise<void> {
    const rows = await tx.query<{ id: string }>(
      "select id from machvon.measurement where contract_id = $1::uuid and reference_no = $2 and duplicate_override_reason is null and status not in ('SUPERSEDED', 'REJECTED') limit 1",
      [contractId, reference],
    );
    if (rows[0] !== undefined) throw new DomainError('MEASUREMENT_REFERENCE_DUPLICATE', 409, 'reference_no', { extensions: { measurement_id: rows[0].id } });
  }

  /** The gate of the start of construction is refused with 422 here (the table of the gates answers 409 to the commands that cannot go on at all). */
  private async assertStartGate(tx: TenantTx, projectId: string, today: string): Promise<void> {
    try {
      await this.gates.assertPasses(tx, projectId, START_GATE, today);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'PERMIT_GATE_BLOCKED') throw new DomainError('PERMIT_GATE_BLOCKED', 422, error.detail, { extensions: error.extensions });
      throw error;
    }
  }

  private idOf(value: string, field: string): string {
    if (!UUID.test(value)) throw invalid(field);
    return value.toLowerCase();
  }

  private documentIds(ids: readonly string[], field: string): string[] {
    if (ids.length > MAX_EVIDENCE || ids.some((id) => !UUID.test(id))) throw invalid(field);
    return [...new Set(ids.map((id) => id.toLowerCase()))].sort();
  }

  private async assertDocuments(tx: TenantTx, ids: readonly string[], field: string): Promise<void> {
    if (ids.length === 0) return;
    const rows = await tx.query<{ id: string }>('select id from machvon.document where id = any($1::uuid[])', [ids]);
    if (rows.length !== ids.length) throw invalid(field);
  }
}
