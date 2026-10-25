import { randomUUID } from 'node:crypto';
import { DomainError, ROUNDING_MODES, assertNotProposer, assertWithinContractValue, assertWorkAcceptanceTransition, lineAmount, notApproved, sumAmounts, versionConflict } from '@machvon/kernel';
import type { RoundingMode, WorkAcceptanceStatus } from '@machvon/kernel';
import { CtrContractStore, SCOPE_FROM as CONTRACT_SCOPE_FROM, TIMESTAMP } from './ctr-contract-store.ts';
import type { ContractPlace, ContractScopes } from './ctr-contract-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 2000;
const MAX_MEASUREMENTS = 200;
const MAX_EVIDENCE = 50;
const MAX_SIGNERS = 20;
const MAX_SIGNER_REFS_TEXT = 4000;
const TENANT = `nullif(current_setting('app.tenant_id', true), '')::uuid`;
const UNIQUE_VIOLATION = '23505';
const MEASUREMENT_CONSTRAINT = 'acceptance_line_measurement_uq';
const KEY_CONSTRAINT = 'acceptance_line_key_uq';
const NUMBER_CONSTRAINT = 'acceptance_no_uq';

const invalid = (field: string, reason?: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field, reason === undefined ? undefined : { extensions: { reason } });
const idOf = (value: string, field: string): string => {
  if (!UUID.test(value)) throw invalid(field);
  return value.toLowerCase();
};
const textOf = (value: string, field: string): string => {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MAX_TEXT) throw invalid(field);
  return trimmed;
};

export interface CreateInput {
  measurementIds: readonly string[];
  periodId: string;
  documentVersionId: string;
  qualityAcceptanceId?: string | undefined;
}

export interface SubmitInput {
  signerRefs: unknown;
}

export interface DecideInput {
  decision: string;
  reason: string;
  evidenceIds: readonly string[];
}

export interface RevokeInput {
  reason: string;
  approvalDocumentVersionId: string;
}

/** One line of an acceptance as a command answers it and as the event carries it to PAY. */
export interface AcceptanceLineResult {
  id: string;
  measurementId: string;
  boqItemId: string;
  partyId: string | null;
  contractRevisionId: string;
  quantity: string;
  unitPriceSnapshot: string;
  amountVnd: string;
  retentionPctSnapshot: string;
}

/** What a command did to an acceptance: the facts the audit row and the event of the command carry. */
export interface AcceptanceResult {
  id: string;
  acceptanceNo: string;
  contractId: string;
  contractCode: string;
  projectId: string;
  status: WorkAcceptanceStatus;
  fromStatus: WorkAcceptanceStatus | null;
  version: number;
  acceptedOn: string;
  acceptedAmountVnd: string;
  qualityAcceptanceId: string | null;
  lines: AcceptanceLineResult[];
  /** What the contract has accepted after the command: moved by an approval and by a revocation. */
  acceptedTotalVnd: string;
}

/** One line of an acceptance as the register shows it. */
export interface AcceptanceLineView extends AcceptanceLineResult {
  businessKey: string;
  description: string;
  unitCode: string;
  referenceNo: string | null;
  active: boolean;
}

/** One acceptance as the register and the commands show it. */
export interface AcceptanceLine {
  id: string;
  acceptanceNo: string;
  contract: { id: string; code: string; status: string; requiresQualityAcceptance: boolean; contractValueVnd: string; acceptedTotalVnd: string };
  projectId: string;
  period: { id: string; code: string };
  documentVersionId: string;
  acceptedOn: string;
  status: WorkAcceptanceStatus;
  acceptedAmountVnd: string;
  lines: AcceptanceLineView[];
  quality: { id: string; recordNo: string; status: string } | null;
  /** Serious non-conformances that stand in the way of this acceptance and are still open. */
  openCriticalNcr: number;
  signerRefs: unknown[];
  submittedBy: string | null;
  submittedAt: string | null;
  decidedBy: string | null;
  approvedAt: string | null;
  decisionReason: string | null;
  rejectedBy: string | null;
  revokeReason: string | null;
  revokedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  version: number;
  reach: ContractPlace;
}

interface LockSql {
  id: string;
  acceptance_no: string;
  contract_id: string;
  contract_code: string;
  contract_status: string;
  requires_quality_acceptance: boolean;
  contract_value_vnd: string;
  accepted_total_vnd: string;
  project_id: string;
  status: WorkAcceptanceStatus;
  accepted_on: string;
  accepted_amount_vnd: string;
  quality_acceptance_id: string | null;
  submitted_by: string | null;
  decided_by: string | null;
  created_by: string | null;
  measurement_ids: string[];
  version: string;
}

interface LineSql {
  id: string;
  acceptance_no: string;
  contract_id: string;
  contract_code: string;
  contract_status: string;
  requires_quality_acceptance: boolean;
  contract_value_vnd: string;
  accepted_total_vnd: string;
  project_id: string;
  period_id: string | null;
  period_code: string | null;
  document_version_id: string;
  accepted_on: string;
  status: WorkAcceptanceStatus;
  accepted_amount_vnd: string;
  lines: Array<{
    id: string;
    measurement_id: string;
    boq_item_id: string;
    party_id: string | null;
    contract_revision_id: string;
    quantity: string;
    unit_price_snapshot: string;
    amount_vnd: string;
    retention_pct_snapshot: string;
    active: boolean;
    business_key: string;
    description: string;
    unit_code: string;
    reference_no: string | null;
  }> | null;
  quality_acceptance_id: string | null;
  quality_record_no: string | null;
  quality_status: string | null;
  open_critical_ncr: string;
  signer_refs: unknown;
  submitted_by: string | null;
  submitted_at: string | null;
  decided_by: string | null;
  approved_at: string | null;
  decision_reason: string | null;
  rejected_by: string | null;
  revoke_reason: string | null;
  revoked_at: string | null;
  created_by: string | null;
  created_at: string;
  version: string;
  owner_unit_id: string;
  owner_unit_path: string;
  investor_unit_id: string | null;
  investor_unit_path: string | null;
}

/**
 * A serious non-conformance of the contract that stands in the way of an acceptance (`a` is the acceptance): one that is not closed and blocks acceptance, and is about the work accepted — a
 * measurement of the acceptance, an inspection of an item of the acceptance — or about no work in particular (it is about the contract).
 */
const BLOCKING_NCR = `n.blocks_acceptance and n.status <> 'CLOSED'
  and ((n.measurement_id is null and n.inspection_id is null)
       or n.measurement_id in (select l.measurement_id from machvon.acceptance_line l where l.tenant_id = a.tenant_id and l.acceptance_id = a.id)
       or ni.boq_item_id in (select l.boq_item_id from machvon.acceptance_line l where l.tenant_id = a.tenant_id and l.acceptance_id = a.id))`;

const NCR_FROM = `machvon.quality_nonconformance n left join machvon.inspection ni on ni.tenant_id = n.tenant_id and ni.id = n.inspection_id`;

const SELECT = `select a.id, a.acceptance_no, c.id as contract_id, c.code as contract_code, c.status as contract_status, c.requires_quality_acceptance, c.contract_value_vnd::text as contract_value_vnd,
       c.accepted_total_vnd::text as accepted_total_vnd, c.project_id, rp.id as period_id, rp.code as period_code, a.document_version_id, a.accepted_on::text as accepted_on, a.status,
       a.accepted_amount_vnd::text as accepted_amount_vnd,
       (select jsonb_agg(jsonb_build_object('id', l.id, 'measurement_id', l.measurement_id, 'boq_item_id', l.boq_item_id, 'party_id', l.party_id, 'contract_revision_id', l.contract_revision_id,
                                            'quantity', l.quantity::text, 'unit_price_snapshot', l.unit_price_snapshot::text, 'amount_vnd', l.amount_vnd::text, 'retention_pct_snapshot', l.retention_pct_snapshot::text,
                                            'active', l.active, 'business_key', i.business_key, 'description', i.description, 'unit_code', i.unit_code, 'reference_no', m.reference_no) order by i.business_key, l.id)
          from machvon.acceptance_line l
          join machvon.boq_item i on i.tenant_id = l.tenant_id and i.id = l.boq_item_id
          join machvon.measurement m on m.tenant_id = l.tenant_id and m.id = l.measurement_id
         where l.tenant_id = a.tenant_id and l.acceptance_id = a.id) as lines,
       a.quality_acceptance_id, q.record_no as quality_record_no, q.status as quality_status,
       (select count(*)::text from ${NCR_FROM} where n.tenant_id = a.tenant_id and n.contract_id = a.contract_id and ${BLOCKING_NCR}) as open_critical_ncr,
       a.signer_refs, a.submitted_by, ${TIMESTAMP('a.submitted_at')} as submitted_at, a.decided_by, ${TIMESTAMP('a.approved_at')} as approved_at, a.decision_reason, a.rejected_by, a.revoke_reason,
       ${TIMESTAMP('a.revoked_at')} as revoked_at, a.created_by, ${TIMESTAMP('a.created_at')} as created_at, a.version::text as version,
       ou.id as owner_unit_id, ou.path as owner_unit_path, iu.id as investor_unit_id, iu.path as investor_unit_path
  from ${CONTRACT_SCOPE_FROM}
  join machvon.acceptance a on a.tenant_id = c.tenant_id and a.contract_id = c.id
  left join machvon.reporting_period rp on rp.tenant_id = a.tenant_id and rp.id = a.period_id
  left join machvon.quality_acceptance q on q.tenant_id = a.tenant_id and q.id = a.quality_acceptance_id`;

function toLine(row: LineSql): AcceptanceLine {
  return {
    id: row.id,
    acceptanceNo: row.acceptance_no,
    contract: { id: row.contract_id, code: row.contract_code, status: row.contract_status, requiresQualityAcceptance: row.requires_quality_acceptance, contractValueVnd: row.contract_value_vnd, acceptedTotalVnd: row.accepted_total_vnd },
    projectId: row.project_id,
    period: { id: row.period_id ?? '', code: row.period_code ?? '' },
    documentVersionId: row.document_version_id,
    acceptedOn: row.accepted_on,
    status: row.status,
    acceptedAmountVnd: row.accepted_amount_vnd,
    lines: (row.lines ?? []).map((line) => ({
      id: line.id,
      measurementId: line.measurement_id,
      boqItemId: line.boq_item_id,
      partyId: line.party_id,
      contractRevisionId: line.contract_revision_id,
      quantity: line.quantity,
      unitPriceSnapshot: line.unit_price_snapshot,
      amountVnd: line.amount_vnd,
      retentionPctSnapshot: line.retention_pct_snapshot,
      active: line.active,
      businessKey: line.business_key,
      description: line.description,
      unitCode: line.unit_code,
      referenceNo: line.reference_no,
    })),
    quality: row.quality_acceptance_id === null ? null : { id: row.quality_acceptance_id, recordNo: row.quality_record_no ?? '', status: row.quality_status ?? '' },
    openCriticalNcr: Number(row.open_critical_ncr),
    signerRefs: Array.isArray(row.signer_refs) ? row.signer_refs : [],
    submittedBy: row.submitted_by,
    submittedAt: row.submitted_at,
    decidedBy: row.decided_by,
    approvedAt: row.approved_at,
    decisionReason: row.decision_reason,
    rejectedBy: row.rejected_by,
    revokeReason: row.revoke_reason,
    revokedAt: row.revoked_at,
    createdBy: row.created_by,
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

interface MeasurementSql {
  id: string;
  status: string;
  period_id: string;
  boq_item_id: string;
  party_id: string | null;
  quantity_period: string;
  inspection_id: string | null;
}

interface PricedSql {
  line_id: string;
  unit_price: string;
  rounding_rule: string;
  retention_pct: string;
}

/**
 * The acceptance of work done under a contract (ST-CTR-009, CTR 3.4, BR-CTR-05). An approver other than whoever drafted or sent it accepts approved measurements: each line is priced at the
 * price of the revision in force on the day of the acceptance, which the line keeps; the accepted value of the contract never goes above its value; a contract that asks for quality acceptance
 * minutes needs approved ones and no open serious non-conformance on the work; and a measurement is accepted by one approved acceptance only — the unique index on the active line decides between
 * two acceptances approved at the same moment. Revoking is refused while a payment request holds the acceptance.
 */
export class CtrAcceptanceStore {
  private readonly contracts = new CtrContractStore();

  // ---- the commands ---------------------------------------------------------------------------------------------------------

  /**
   * Drafts an acceptance. Refusals in order: the shape (422), the contract (404 outside the scope, 403 where it may be read and not changed, 409 `CONTRACT_STATE_INVALID` unless ACTIVE), the
   * period and the paper (422), the measurements (422 `MEASUREMENT_NOT_APPROVED` naming those that are not approved, 409 `MEASUREMENT_ALREADY_ACCEPTED` naming those an approved acceptance holds,
   * 422 for one of another period), the revision in force on the day (422 `REVISION_NOT_EFFECTIVE`) and its price for each item (422), and the minutes of quality named (422
   * `QUALITY_ACCEPTANCE_REQUIRED` for ones that can never serve).
   */
  async create(tx: TenantTx, contractId: string, input: CreateInput, actor: string, scopes: ContractScopes, today: string): Promise<AcceptanceResult> {
    const asked = this.measurementIds(input.measurementIds);
    const periodId = idOf(input.periodId, 'period_id');
    const documentId = idOf(input.documentVersionId, 'document_version_id');
    const qualityId = input.qualityAcceptanceId === undefined ? null : idOf(input.qualityAcceptanceId, 'quality_acceptance_id');
    const contract = await this.contracts.lock(tx, contractId, scopes);
    if (contract.status !== 'ACTIVE') throw new DomainError('CONTRACT_STATE_INVALID', 409, 'contract_id', { extensions: { contract_status: contract.status } });
    if ((await tx.query('select 1 from machvon.reporting_period where id = $1::uuid', [periodId])).length === 0) throw invalid('period_id');
    if ((await tx.query("select 1 from machvon.document_version where id = $1::uuid and scan_status = 'CLEAN'", [documentId])).length === 0) throw invalid('document_version_id');

    const found = await tx.query<MeasurementSql>(
      'select id, status, period_id, boq_item_id, party_id, quantity_period::text as quantity_period, inspection_id from machvon.measurement where id = any($1::uuid[]) and contract_id = $2::uuid',
      [asked, contractId],
    );
    if (found.length !== asked.length) throw invalid('measurement_ids', 'UNKNOWN');
    const byId = new Map(found.map((row) => [row.id, row]));
    const unapproved = notApproved(asked, new Set(found.filter((row) => row.status === 'APPROVED').map((row) => row.id)));
    if (unapproved.length > 0) throw new DomainError('MEASUREMENT_NOT_APPROVED', 422, 'measurement_ids', { extensions: { measurement_ids: unapproved } });
    await this.assertNotAccepted(tx, asked);
    if (found.some((row) => row.period_id !== periodId)) throw invalid('period_id', 'MEASUREMENT_PERIOD');
    if (qualityId !== null) await this.assertQualityUsable(tx, contractId, qualityId);

    const revision = await this.revisionInForce(tx, contractId, today);
    const priced: Array<{ measurement: MeasurementSql; line: PricedSql; amount: string }> = [];
    for (const id of asked) {
      const measurement = byId.get(id) as MeasurementSql;
      const line = await this.priceOf(tx, revision.id, measurement);
      const rule = ROUNDING_MODES.find((mode) => mode === line.rounding_rule) as RoundingMode | undefined;
      if (rule === undefined) throw invalid('measurement_ids', 'NO_PRICE');
      const amount = lineAmount(measurement.quantity_period, line.unit_price, rule);
      if (BigInt(amount) <= 0n) throw invalid('measurement_ids', 'AMOUNT_NOT_POSITIVE');
      priced.push({ measurement, line, amount });
    }
    const total = sumAmounts(priced.map((entry) => entry.amount));
    const id = randomUUID();
    const sequence = Number((await tx.query<{ n: string }>('select (count(*) + 1)::text as n from machvon.acceptance where contract_id = $1::uuid', [contractId]))[0]?.n ?? '1');
    const acceptanceNo = `NT-${String(sequence).padStart(3, '0')}`;
    try {
      await tx.query(
        `insert into machvon.acceptance
           (tenant_id, id, contract_id, measurement_ids, document_version_id, approved_at, signer_refs, status, version, acceptance_no, period_id, accepted_amount_vnd, quality_acceptance_id, accepted_on,
            created_by, updated_by)
         values (${TENANT}, $1::uuid, $2::uuid, $3::jsonb, $4::uuid, null, '[]'::jsonb, 'DRAFT', 1, $5, $6::uuid, $7::numeric, $8::uuid, $9::date, $10::uuid, $10::uuid)`,
        [id, contractId, JSON.stringify(asked), documentId, acceptanceNo, periodId, total, qualityId, today, actor],
      );
      for (const { measurement, line, amount } of priced) {
        await tx.query(
          `insert into machvon.acceptance_line
             (tenant_id, id, acceptance_id, measurement_id, boq_item_id, party_id, contract_revision_id, quantity, unit_price_snapshot, amount_vnd, retention_pct_snapshot, active, created_by, updated_by)
           values (${TENANT}, gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::numeric, $7::numeric, $8::numeric, $9::numeric, false, $10::uuid, $10::uuid)`,
          [id, measurement.id, measurement.boq_item_id, measurement.party_id, revision.id, measurement.quantity_period, line.unit_price, amount, line.retention_pct, actor],
        );
      }
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (failure.code === UNIQUE_VIOLATION && failure.constraint === KEY_CONSTRAINT) throw invalid('measurement_ids', 'ITEM_TWICE');
      if (failure.code === UNIQUE_VIOLATION && failure.constraint === NUMBER_CONSTRAINT) throw new DomainError('ACCEPTANCE_STATE_INVALID', 409, 'acceptance_no', { extensions: { reason: 'NUMBER_USED' } });
      throw error;
    }
    return this.resultOf(tx, id, null);
  }

  /**
   * Sends a draft for decision, with the people who sign the paper. The measurements must still be approved and not accepted elsewhere (422 `MEASUREMENT_NOT_APPROVED`, 409
   * `MEASUREMENT_ALREADY_ACCEPTED`); minutes of quality that were named and can no longer serve (revoked or rejected) are 422 `QUALITY_ACCEPTANCE_REQUIRED`: they would have to be named again.
   */
  async submit(tx: TenantTx, id: string, expectedVersion: number, input: SubmitInput, actor: string, scopes: ContractScopes): Promise<AcceptanceResult> {
    const signers = this.signerRefs(input.signerRefs);
    const held = await this.lock(tx, id, expectedVersion, scopes);
    assertWorkAcceptanceTransition('submit', held.status);
    if (held.contract_status !== 'ACTIVE') throw new DomainError('CONTRACT_STATE_INVALID', 409, 'contract_id', { extensions: { contract_status: held.contract_status } });
    await this.assertMeasurementsStillApproved(tx, held);
    if (held.quality_acceptance_id !== null) await this.assertQualityUsable(tx, held.contract_id, held.quality_acceptance_id);
    await tx.query("update machvon.acceptance set status = 'SUBMITTED', signer_refs = $2::jsonb, submitted_by = $3::uuid, submitted_at = now(), updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid", [
      id,
      JSON.stringify(signers),
      actor,
    ]);
    return this.resultOf(tx, id, held.status);
  }

  /**
   * Decides a sent acceptance: approve it, reject it, or give it back to the draft. Not by whoever drafted or sent it (403 `SELF_APPROVAL_DENIED`). Approving is refused, in this order: the
   * contract is no longer being performed (409), a measurement is no longer approved (422) or is accepted already (409 `MEASUREMENT_ALREADY_ACCEPTED`), the contract asks for approved quality
   * acceptance minutes and has none for this work (422 `QUALITY_ACCEPTANCE_REQUIRED`), a serious non-conformance on the work is open (422 `OPEN_CRITICAL_NCR`), and the accepted value would go
   * above the value of the contract (422 `ACCEPTANCE_VALUE_EXCEEDS_CONTRACT`). The lines then count as accepted and the contract's accepted total rises, in the same transaction.
   */
  async decide(tx: TenantTx, id: string, expectedVersion: number, input: DecideInput, actor: string, scopes: ContractScopes): Promise<AcceptanceResult & { decision: 'approve' | 'return' | 'reject'; reason: string; evidenceIds: string[] }> {
    const decision = input.decision === 'approve' || input.decision === 'return' || input.decision === 'reject' ? input.decision : undefined;
    if (decision === undefined) throw invalid('decision');
    const reason = textOf(input.reason, 'reason');
    const evidenceIds = this.documentIds(input.evidenceIds, 'evidence_ids');
    const held = await this.lock(tx, id, expectedVersion, scopes);
    assertWorkAcceptanceTransition(decision, held.status);
    assertNotProposer(actor, [held.submitted_by, held.created_by]);
    if (evidenceIds.length > 0 && (await tx.query<{ id: string }>('select id from machvon.document where id = any($1::uuid[])', [evidenceIds])).length !== evidenceIds.length) throw invalid('evidence_ids');
    if (decision === 'reject') {
      await tx.query(
        `update machvon.acceptance
            set status = 'REJECTED', decision_reason = $2, decision_evidence_ids = $3::jsonb, rejected_at = now(), rejected_by = $4::uuid, updated_at = now(), updated_by = $4::uuid, version = version + 1
          where id = $1::uuid`,
        [id, reason, JSON.stringify(evidenceIds), actor],
      );
    } else if (decision === 'return') {
      await tx.query("update machvon.acceptance set status = 'DRAFT', submitted_by = null, submitted_at = null, updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid", [id, actor]);
    } else {
      if (held.contract_status !== 'ACTIVE') throw new DomainError('CONTRACT_STATE_INVALID', 409, 'contract_id', { extensions: { contract_status: held.contract_status } });
      await this.assertMeasurementsStillApproved(tx, held);
      const qualityId = await this.qualityFor(tx, held);
      await this.assertNoBlockingNcr(tx, held.id);
      assertWithinContractValue(held.accepted_total_vnd, held.accepted_amount_vnd, held.contract_value_vnd);
      await tx.query(
        `update machvon.acceptance
            set status = 'APPROVED', quality_acceptance_id = $2::uuid, decision_reason = $3, decision_evidence_ids = $4::jsonb, approved_at = now(), decided_by = $5::uuid, updated_at = now(), updated_by = $5::uuid,
                version = version + 1
          where id = $1::uuid`,
        [id, qualityId, reason, JSON.stringify(evidenceIds), actor],
      );
      try {
        await tx.query('update machvon.acceptance_line set active = true, updated_at = now(), updated_by = $2::uuid, version = version + 1 where acceptance_id = $1::uuid', [id, actor]);
      } catch (error) {
        const failure = error as { code?: string; constraint?: string };
        if (failure.code === UNIQUE_VIOLATION && failure.constraint === MEASUREMENT_CONSTRAINT) throw new DomainError('MEASUREMENT_ALREADY_ACCEPTED', 409, 'measurement_ids');
        throw error;
      }
      await tx.query('update machvon.contract set accepted_total_vnd = accepted_total_vnd + $2::numeric, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid', [held.contract_id, held.accepted_amount_vnd, actor]);
    }
    const result = await this.resultOf(tx, id, held.status);
    return { ...result, decision, reason, evidenceIds };
  }

  /**
   * Withdraws an approved acceptance with the reason and the paper that approves the withdrawal. Not by whoever sent or approved it (403 `SELF_APPROVAL_DENIED`), and not while a payment request
   * holds the acceptance (409 `ACCEPTANCE_ALREADY_CLAIMED`). The lines stop counting and the contract's accepted total falls by the amount of the acceptance.
   */
  async revoke(tx: TenantTx, id: string, expectedVersion: number, input: RevokeInput, actor: string, scopes: ContractScopes): Promise<AcceptanceResult> {
    const reason = textOf(input.reason, 'reason');
    const documentId = idOf(input.approvalDocumentVersionId, 'approval_document_version_id');
    const held = await this.lock(tx, id, expectedVersion, scopes);
    assertWorkAcceptanceTransition('revoke', held.status);
    assertNotProposer(actor, [held.submitted_by, held.decided_by]);
    if ((await tx.query("select 1 from machvon.document_version where id = $1::uuid and scan_status = 'CLEAN'", [documentId])).length === 0) throw invalid('approval_document_version_id');
    const claim = await tx.query<{ id: string }>('select id from machvon.payment_request where acceptance_id = $1::uuid and claims_acceptance limit 1', [id]);
    if (claim[0] !== undefined) throw new DomainError('ACCEPTANCE_ALREADY_CLAIMED', 409, 'id', { extensions: { payment_request_id: claim[0].id } });
    await tx.query(
      `update machvon.acceptance
          set status = 'REVOKED', revoke_reason = $2, revoke_approval_document_version_id = $3::uuid, revoked_at = now(), revoked_by = $4::uuid, updated_at = now(), updated_by = $4::uuid, version = version + 1
        where id = $1::uuid`,
      [id, reason, documentId, actor],
    );
    await tx.query('update machvon.acceptance_line set active = false, updated_at = now(), updated_by = $2::uuid, version = version + 1 where acceptance_id = $1::uuid', [id, actor]);
    await tx.query('update machvon.contract set accepted_total_vnd = accepted_total_vnd - $2::numeric, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid', [held.contract_id, held.accepted_amount_vnd, actor]);
    return this.resultOf(tx, id, held.status);
  }

  // ---- the reads -----------------------------------------------------------------------------------------------------------

  /** The acceptances of the contracts in the scope of the caller, the latest first; one contract when named. `after` is the creation time and the id of the last one read. */
  async list(tx: TenantTx, scope: ScopeBuilder, filter: { contractId?: string | undefined; limit?: number | undefined; after?: { createdAt: string; id: string } | undefined }): Promise<AcceptanceLine[]> {
    const predicate = scope(4);
    const rows = await tx.query<LineSql>(
      `${SELECT}
        where ${predicate.sql} and ($1::uuid is null or a.contract_id = $1::uuid) and ($2::text is null or (${TIMESTAMP('a.created_at')}, a.id) < ($2::text, $3::uuid))
        order by ${TIMESTAMP('a.created_at')} desc, a.id desc limit ${Math.min(Math.max(filter.limit ?? 200, 1), 1000)}`,
      [filter.contractId ?? null, filter.after?.createdAt ?? null, filter.after?.id ?? null, ...predicate.params],
    );
    return rows.map(toLine);
  }

  async find(tx: TenantTx, id: string, scope: ScopeBuilder): Promise<AcceptanceLine | undefined> {
    const predicate = scope(2);
    const rows = await tx.query<LineSql>(`${SELECT} where a.id = $1::uuid and ${predicate.sql}`, [id, ...predicate.params]);
    return rows[0] === undefined ? undefined : toLine(rows[0]);
  }

  // ---- internals ------------------------------------------------------------------------------------------------------------

  private measurementIds(ids: readonly string[]): string[] {
    if (ids.length === 0 || ids.length > MAX_MEASUREMENTS) throw invalid('measurement_ids');
    const unique = [...new Set(ids.map((id) => idOf(id, 'measurement_ids')))];
    if (unique.length !== ids.length) throw invalid('measurement_ids', 'DUPLICATED');
    return unique;
  }

  private documentIds(ids: readonly string[], field: string): string[] {
    if (ids.length > MAX_EVIDENCE || ids.some((id) => !UUID.test(id))) throw invalid(field);
    return [...new Set(ids.map((id) => id.toLowerCase()))].sort();
  }

  /** The people who sign the paper: a short list of objects, kept as they were given. */
  private signerRefs(value: unknown): Array<Record<string, unknown>> {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SIGNERS) throw invalid('signer_refs');
    if (!value.every((entry) => typeof entry === 'object' && entry !== null && !Array.isArray(entry))) throw invalid('signer_refs');
    if (JSON.stringify(value).length > MAX_SIGNER_REFS_TEXT) throw invalid('signer_refs');
    return value as Array<Record<string, unknown>>;
  }

  /** 409 `MEASUREMENT_ALREADY_ACCEPTED` naming the measurements an approved acceptance already holds. */
  private async assertNotAccepted(tx: TenantTx, ids: readonly string[]): Promise<void> {
    const held = await tx.query<{ measurement_id: string }>('select measurement_id from machvon.acceptance_line where measurement_id = any($1::uuid[]) and active order by measurement_id', [ids]);
    if (held.length > 0) throw new DomainError('MEASUREMENT_ALREADY_ACCEPTED', 409, 'measurement_ids', { extensions: { measurement_ids: held.map((row) => row.measurement_id) } });
  }

  /** The measurements of the acceptance are approved still (a correction supersedes one) and not held by another acceptance. */
  private async assertMeasurementsStillApproved(tx: TenantTx, held: LockSql): Promise<void> {
    const current = await tx.query<{ id: string; status: string }>('select id, status from machvon.measurement where id = any($1::uuid[])', [held.measurement_ids]);
    const unapproved = notApproved(held.measurement_ids, new Set(current.filter((row) => row.status === 'APPROVED').map((row) => row.id)));
    if (unapproved.length > 0) throw new DomainError('MEASUREMENT_NOT_APPROVED', 422, 'measurement_ids', { extensions: { measurement_ids: unapproved } });
    const taken = await tx.query<{ measurement_id: string }>('select measurement_id from machvon.acceptance_line where measurement_id = any($1::uuid[]) and active and acceptance_id <> $2::uuid order by measurement_id', [held.measurement_ids, held.id]);
    if (taken.length > 0) throw new DomainError('MEASUREMENT_ALREADY_ACCEPTED', 409, 'measurement_ids', { extensions: { measurement_ids: taken.map((row) => row.measurement_id) } });
  }

  /** The revision whose dates contain the day of the acceptance: the price of every line is the price in it (422 `REVISION_NOT_EFFECTIVE` when none is). */
  private async revisionInForce(tx: TenantTx, contractId: string, day: string): Promise<{ id: string; revision: number }> {
    const rows = await tx.query<{ id: string; revision: number }>(
      `select id, revision from machvon.contract_revision
        where contract_id = $1::uuid and status in ('EFFECTIVE', 'SUPERSEDED') and valid_from <= $2::date and (valid_until is null or valid_until > $2::date)
        order by revision desc limit 1`,
      [contractId, day],
    );
    if (rows[0] === undefined) throw new DomainError('REVISION_NOT_EFFECTIVE', 422, 'contract_id', { extensions: { on: day } });
    return rows[0];
  }

  /** The line of the revision that prices the item (there is one for an item in a revision): its price, its rounding and its retention. */
  private async priceOf(tx: TenantTx, revisionId: string, measurement: MeasurementSql): Promise<PricedSql> {
    const rows = await tx.query<PricedSql>('select l.id as line_id, l.unit_price::text as unit_price, l.rounding_rule, l.retention_pct::text as retention_pct from machvon.boq_line l where l.contract_revision_id = $1::uuid and l.boq_item_id = $2::uuid', [
      revisionId,
      measurement.boq_item_id,
    ]);
    if (rows[0] === undefined) throw invalid('measurement_ids', 'NO_PRICE');
    return rows[0];
  }

  /** Minutes of quality that can serve this contract: its own, and not rejected or revoked (422 `QUALITY_ACCEPTANCE_REQUIRED`). */
  private async assertQualityUsable(tx: TenantTx, contractId: string, qualityId: string): Promise<void> {
    const rows = await tx.query<{ status: string }>('select status from machvon.quality_acceptance where id = $1::uuid and contract_id = $2::uuid', [qualityId, contractId]);
    if (rows[0] === undefined || rows[0].status === 'REJECTED' || rows[0].status === 'REVOKED') {
      throw new DomainError('QUALITY_ACCEPTANCE_REQUIRED', 422, 'quality_acceptance_id', { extensions: { reason: rows[0] === undefined ? 'UNKNOWN' : rows[0].status } });
    }
  }

  /**
   * The approved minutes of quality that cover the acceptance, when its contract asks for them (null when it does not). The minutes named on the acceptance serve when they are approved;
   * otherwise the latest approved minutes of the contract whose inspection one of the measurements was made against. None is 422 `QUALITY_ACCEPTANCE_REQUIRED`: the acceptance waits for them.
   */
  private async qualityFor(tx: TenantTx, held: LockSql): Promise<string | null> {
    if (!held.requires_quality_acceptance) return held.quality_acceptance_id;
    if (held.quality_acceptance_id !== null) {
      const named = await tx.query<{ status: string }>('select status from machvon.quality_acceptance where id = $1::uuid and contract_id = $2::uuid', [held.quality_acceptance_id, held.contract_id]);
      if (named[0]?.status === 'APPROVED') return held.quality_acceptance_id;
    }
    const found = await tx.query<{ id: string }>(
      `select q.id from machvon.quality_acceptance q
        where q.contract_id = $1::uuid and q.status = 'APPROVED'
          and q.inspection_id in (select m.inspection_id from machvon.measurement m where m.id = any($2::uuid[]) and m.inspection_id is not null)
        order by q.approved_at desc, q.id limit 1`,
      [held.contract_id, held.measurement_ids],
    );
    if (found[0] === undefined) throw new DomainError('QUALITY_ACCEPTANCE_REQUIRED', 422, 'quality_acceptance_id', { extensions: { reason: held.quality_acceptance_id === null ? 'MISSING' : 'NOT_APPROVED' } });
    return found[0].id;
  }

  private async assertNoBlockingNcr(tx: TenantTx, acceptanceId: string): Promise<void> {
    const open = await tx.query<{ id: string }>(
      `select n.id from ${NCR_FROM} join machvon.acceptance a on a.tenant_id = n.tenant_id and a.contract_id = n.contract_id where a.id = $1::uuid and ${BLOCKING_NCR} order by n.id limit 20`,
      [acceptanceId],
    );
    if (open.length > 0) throw new DomainError('OPEN_CRITICAL_NCR', 422, 'id', { extensions: { nonconformance_ids: open.map((row) => row.id) } });
  }

  /** The acceptance locked for update inside the scope of the command, its contract locked first and judged by the scope; one the caller cannot see does not exist. */
  private async lock(tx: TenantTx, id: string, expectedVersion: number, scopes: ContractScopes): Promise<LockSql> {
    const peek = await tx.query<{ contract_id: string }>('select contract_id from machvon.acceptance where id = $1::uuid', [id]);
    if (peek[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await this.contracts.lock(tx, peek[0].contract_id, scopes);
    const rows = await tx.query<LockSql>(
      `select a.id, a.acceptance_no, c.id as contract_id, c.code as contract_code, c.status as contract_status, c.requires_quality_acceptance, c.contract_value_vnd::text as contract_value_vnd,
              c.accepted_total_vnd::text as accepted_total_vnd, c.project_id, a.status, a.accepted_on::text as accepted_on, a.accepted_amount_vnd::text as accepted_amount_vnd, a.quality_acceptance_id,
              a.submitted_by, a.decided_by, a.created_by, a.measurement_ids, a.version::text as version
         from machvon.acceptance a join machvon.contract c on c.tenant_id = a.tenant_id and c.id = a.contract_id
        where a.id = $1::uuid for update of a`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    return row;
  }

  private async resultOf(tx: TenantTx, id: string, fromStatus: WorkAcceptanceStatus | null): Promise<AcceptanceResult> {
    const rows = await tx.query<{
      id: string;
      acceptance_no: string;
      contract_id: string;
      contract_code: string;
      project_id: string;
      status: WorkAcceptanceStatus;
      version: string;
      accepted_on: string;
      accepted_amount_vnd: string;
      quality_acceptance_id: string | null;
      accepted_total_vnd: string;
    }>(
      `select a.id, a.acceptance_no, c.id as contract_id, c.code as contract_code, c.project_id, a.status, a.version::text as version, a.accepted_on::text as accepted_on, a.accepted_amount_vnd::text as accepted_amount_vnd,
              a.quality_acceptance_id, c.accepted_total_vnd::text as accepted_total_vnd
         from machvon.acceptance a join machvon.contract c on c.tenant_id = a.tenant_id and c.id = a.contract_id where a.id = $1::uuid`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const lines = await tx.query<{
      id: string;
      measurement_id: string;
      boq_item_id: string;
      party_id: string | null;
      contract_revision_id: string;
      quantity: string;
      unit_price_snapshot: string;
      amount_vnd: string;
      retention_pct_snapshot: string;
    }>(
      `select l.id, l.measurement_id, l.boq_item_id, l.party_id, l.contract_revision_id, l.quantity::text as quantity, l.unit_price_snapshot::text as unit_price_snapshot, l.amount_vnd::text as amount_vnd,
              l.retention_pct_snapshot::text as retention_pct_snapshot
         from machvon.acceptance_line l where l.acceptance_id = $1::uuid order by l.boq_item_id, l.id`,
      [id],
    );
    return {
      id: row.id,
      acceptanceNo: row.acceptance_no,
      contractId: row.contract_id,
      contractCode: row.contract_code,
      projectId: row.project_id,
      status: row.status,
      fromStatus,
      version: Number(row.version),
      acceptedOn: row.accepted_on,
      acceptedAmountVnd: row.accepted_amount_vnd,
      qualityAcceptanceId: row.quality_acceptance_id,
      lines: lines.map((line) => ({
        id: line.id,
        measurementId: line.measurement_id,
        boqItemId: line.boq_item_id,
        partyId: line.party_id,
        contractRevisionId: line.contract_revision_id,
        quantity: line.quantity,
        unitPriceSnapshot: line.unit_price_snapshot,
        amountVnd: line.amount_vnd,
        retentionPctSnapshot: line.retention_pct_snapshot,
      })),
      acceptedTotalVnd: row.accepted_total_vnd,
    };
  }
}
