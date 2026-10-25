import {
  DomainError,
  RETENTION_STATUSES,
  assertNotTheMaker,
  assertReleasable,
  assertReleaseAmount,
  assertSomethingHeld,
  releaseBlocker,
  retentionLeft,
  statusAfterRelease,
  versionConflict,
  vietnamDateOf,
} from '@machvon/kernel';
import type { ReleaseBlocker, ReleaseCondition, RetentionStatus } from '@machvon/kernel';
import { CtrContractStore, SCOPE_FROM as CONTRACT_SCOPE_FROM, TIMESTAMP, textOf, wholeAmount } from './ctr-contract-store.ts';
import type { ContractPlace, ContractScopes } from './ctr-contract-store.ts';
import { assertTimestampCursor, timestampKey } from './keyset.ts';
import { PayLedgerStore } from './pay-ledger-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 2000;
const MAX_PAGE = 200;

const invalid = (field: string, reason?: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field, reason === undefined ? undefined : { extensions: { reason } });
const idOf = (value: string, field: string): string => {
  if (!UUID.test(value)) throw invalid(field);
  return value.toLowerCase();
};

export interface ReleaseInput {
  amountVnd: string;
  reason: string;
  decisionDocumentVersionId?: string | undefined;
}

export interface HoldFilter {
  status?: string | undefined;
  limit: number;
  after?: { code: string; id: string } | undefined;
}

/** What a release did to a hold and to the contract: the facts the audit row and the event carry. */
export interface ReleaseResult {
  id: string;
  contractId: string;
  contractCode: string;
  projectId: string;
  boqItemId: string;
  paymentRequestId: string;
  releaseCondition: ReleaseCondition;
  heldVnd: string;
  /** What was released by this command, and what is released of the hold now. */
  amountVnd: string;
  releasedVnd: string;
  fromStatus: RetentionStatus;
  status: RetentionStatus;
  version: number;
  decisionDocumentVersionId: string | null;
  /** The totals of the contract after the release. */
  contractRetentionHeldVnd: string;
  contractRetentionReleasedVnd: string;
}

/** The header of the register of a contract: what it holds back in all, and what of it was released. */
export interface HoldHeader {
  contractId: string;
  contractCode: string;
  contractStatus: string;
  retentionHeldVnd: string;
  retentionReleasedVnd: string;
  place: ContractPlace;
}

export interface HoldLine {
  id: string;
  boqItem: { id: string; key: string; description: string };
  partyId: string | null;
  paymentRequestId: string;
  acceptanceId: string;
  heldVnd: string;
  releasedVnd: string;
  leftVnd: string;
  releaseCondition: ReleaseCondition;
  releaseNotBefore: string | null;
  status: RetentionStatus;
  /** Why the money may not be released yet, or null when it may (the condition and the earliest day, judged on the day of the read). */
  blocker: ReleaseBlocker | null;
  releasedAt: string | null;
  releaseReason: string | null;
  decisionDocumentVersionId: string | null;
  createdAt: string;
  version: number;
}

interface HeaderSql {
  contract_id: string;
  contract_code: string;
  contract_status: string;
  project_id: string;
  retention_held_vnd: string;
  retention_released_vnd: string;
  owner_unit_id: string;
  owner_unit_path: string;
  investor_unit_id: string | null;
  investor_unit_path: string | null;
}

interface LineSql {
  id: string;
  boq_item_id: string;
  boq_item_key: string;
  description: string;
  party_id: string | null;
  payment_request_id: string;
  acceptance_id: string;
  held_vnd: string;
  released_vnd: string;
  release_condition: ReleaseCondition;
  release_not_before: string | null;
  status: RetentionStatus;
  released_at: string | null;
  release_reason: string | null;
  release_decision_document_version_id: string | null;
  created_at: string;
  version: string;
  contract_status: string;
  obligations: string;
  not_closed: string;
}

interface Held {
  id: string;
  boq_item_id: string;
  acceptance_id: string;
  payment_request_id: string;
  party_id: string | null;
  held_vnd: string;
  released_vnd: string;
  release_condition: ReleaseCondition;
  release_not_before: string | null;
  status: RetentionStatus;
  release_decision_document_version_id: string | null;
  created_by: string;
  version: string;
}

/**
 * The retention held back from the payments of a contract, line by line of the BOQ (ST-CTR-010, CTR 3.5, BR-CTR-09, UAT-AC309, UAT-AC397). A release is made by the chief accountant, never by the
 * person who put the money on hold (403 `SELF_APPROVAL_DENIED`), when the condition of the hold is met (422 `RELEASE_CONDITION_NOT_MET`: the warranty has ended, the contract is completed or the
 * authority decided, and not before the earliest day) and never above what is still held (422 `RELEASE_EXCEEDS_HELD`). The release goes on the cumulative ledger as an entry of its own and on the totals
 * of the contract, in the transaction of the command.
 */
export class CtrRetentionStore {
  private readonly contracts: CtrContractStore;
  private readonly ledger: PayLedgerStore;

  constructor(contracts: CtrContractStore = new CtrContractStore(), ledger: PayLedgerStore = new PayLedgerStore()) {
    this.contracts = contracts;
    this.ledger = ledger;
  }

  async release(tx: TenantTx, id: string, expectedVersion: number, input: ReleaseInput, actor: string, requestId: string, scopes: ContractScopes, now: Date): Promise<ReleaseResult> {
    const amount = wholeAmount(input.amountVnd, 'amount_vnd');
    const reason = textOf(input.reason, 'reason', MAX_TEXT);
    const documentId = input.decisionDocumentVersionId === undefined ? null : idOf(input.decisionDocumentVersionId, 'decision_document_version_id');
    const holdId = idOf(id, 'id');
    // The contract is locked first, as every command that moves the money of a contract does, so that a release and a payment of the same contract take their turns.
    const owner = (await tx.query<{ contract_id: string }>('select contract_id from machvon.retention_hold where id = $1::uuid', [holdId]))[0];
    if (owner === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const contract = await this.contracts.lock(tx, owner.contract_id, scopes);
    const hold = (
      await tx.query<Held>(
        `select id, boq_item_id, acceptance_id, payment_request_id, party_id, held_vnd::text as held_vnd, released_vnd::text as released_vnd, release_condition, release_not_before::text as release_not_before,
                status, release_decision_document_version_id, created_by, version::text as version
           from machvon.retention_hold where id = $1::uuid for update`,
        [holdId],
      )
    )[0];
    if (hold === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    // A hold with nothing left is over whatever the caller saw of it: that is the answer, before the version it was read at.
    assertSomethingHeld(hold.held_vnd, hold.status === 'FORFEITED' ? hold.held_vnd : hold.released_vnd);
    if (Number(hold.version) !== expectedVersion) throw versionConflict(Number(hold.version));
    assertNotTheMaker(actor, hold.created_by);
    if (documentId !== null) {
      const documents = await tx.query<{ scan_status: string }>('select scan_status from machvon.document_version where id = $1::uuid', [documentId]);
      if (documents[0] === undefined) throw invalid('decision_document_version_id', 'NOT_FOUND');
      if (documents[0].scan_status !== 'CLEAN') throw new DomainError('DOCUMENT_NOT_CLEAN', 422, 'decision_document_version_id');
    }
    const warranty = (
      await tx.query<{ obligations: string; not_closed: string }>(
        "select count(*)::text as obligations, (count(*) filter (where status <> 'CLOSED'))::text as not_closed from machvon.warranty_obligation where contract_id = $1::uuid",
        [owner.contract_id],
      )
    )[0];
    assertReleasable({
      condition: hold.release_condition,
      notBefore: hold.release_not_before,
      today: vietnamDateOf(now),
      contractStatus: contract.status,
      warranty: { obligations: Number(warranty?.obligations ?? 0), notClosed: Number(warranty?.not_closed ?? 0) },
      hasDecision: documentId !== null || hold.release_decision_document_version_id !== null,
    });
    assertReleaseAmount(hold.held_vnd, hold.released_vnd, amount);

    const releasedAfter = (BigInt(hold.released_vnd) + BigInt(amount)).toString();
    const status = statusAfterRelease(hold.held_vnd, releasedAfter);
    await tx.query(
      `update machvon.retention_hold
          set released_vnd = $2::numeric, status = $3, released_by = $4::uuid, released_at = $5::timestamptz, release_reason = $6,
              release_decision_document_version_id = coalesce($7::uuid, release_decision_document_version_id), updated_at = now(), updated_by = $4::uuid, version = version + 1
        where id = $1::uuid`,
      [hold.id, releasedAfter, status, actor, now.toISOString(), reason, documentId],
    );
    const totals = (
      await tx.query<{ outstanding: string; held: string; released: string; code: string; project_id: string }>(
        `update machvon.contract set retention_released_vnd = retention_released_vnd + $2::numeric, updated_at = now(), updated_by = $3::uuid, version = version + 1
          where id = $1::uuid
          returning (advance_paid_vnd - advance_recovered_vnd)::text as outstanding, retention_held_vnd::text as held, retention_released_vnd::text as released, code, project_id`,
        [owner.contract_id, amount, actor],
      )
    )[0];
    if (totals === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const ledgerRow = (
      await tx.query<{ id: string }>(
        'select id from machvon.cumulative_ledger where contract_id = $1::uuid and acceptance_id = $2::uuid and boq_item_id = $3::uuid and party_id is not distinct from $4::uuid',
        [owner.contract_id, hold.acceptance_id, hold.boq_item_id, hold.party_id],
      )
    )[0];
    if (ledgerRow === undefined) throw new DomainError('PAYMENT_STATE_INVALID', 409, 'id', { extensions: { reason: 'NOT_ON_THE_LEDGER', boq_item_id: hold.boq_item_id } });
    await this.ledger.post(tx, {
      ledgerId: ledgerRow.id,
      kind: 'RETENTION_RELEASE',
      delta: { accepted: '0', requested: '0', paid: '0', advanceRecovery: '0', retention: `-${amount}` },
      paymentRequestId: hold.payment_request_id,
      reason,
      requestId,
      actor,
      advanceOutstandingVnd: BigInt(totals.outstanding) < 0n ? '0' : totals.outstanding,
    });
    return {
      id: hold.id,
      contractId: owner.contract_id,
      contractCode: totals.code,
      projectId: totals.project_id,
      boqItemId: hold.boq_item_id,
      paymentRequestId: hold.payment_request_id,
      releaseCondition: hold.release_condition,
      heldVnd: hold.held_vnd,
      amountVnd: amount,
      releasedVnd: releasedAfter,
      fromStatus: hold.status,
      status,
      version: Number(hold.version) + 1,
      decisionDocumentVersionId: documentId ?? hold.release_decision_document_version_id,
      contractRetentionHeldVnd: totals.held,
      contractRetentionReleasedVnd: totals.released,
    };
  }

  // ---- reads --------------------------------------------------------------------------------------------------------------

  /** The totals a contract holds back and has released, inside the scope of the caller; undefined when the contract is outside it. */
  async header(tx: TenantTx, contractId: string, scope: ScopeBuilder): Promise<HoldHeader | undefined> {
    const predicate = scope(2);
    const [row] = await tx.query<HeaderSql>(
      `select c.id as contract_id, c.code as contract_code, c.status as contract_status, c.project_id, c.retention_held_vnd::text as retention_held_vnd, c.retention_released_vnd::text as retention_released_vnd,
              ou.id as owner_unit_id, ou.path as owner_unit_path, iu.id as investor_unit_id, iu.path as investor_unit_path
         from ${CONTRACT_SCOPE_FROM} where c.id = $1::uuid and ${predicate.sql}`,
      [idOf(contractId, 'contract_id'), ...predicate.params],
    );
    if (row === undefined) return undefined;
    return {
      contractId: row.contract_id,
      contractCode: row.contract_code,
      contractStatus: row.contract_status,
      retentionHeldVnd: row.retention_held_vnd,
      retentionReleasedVnd: row.retention_released_vnd,
      place: {
        contractId: row.contract_id,
        projectId: row.project_id,
        ownerUnit: { id: row.owner_unit_id, path: row.owner_unit_path },
        investorUnit: row.investor_unit_id === null || row.investor_unit_path === null ? null : { id: row.investor_unit_id, path: row.investor_unit_path },
      },
    };
  }

  /** The holds of a contract inside the scope of the caller, the newest first; the cursor is the creation time and the id. Each says whether the money may be released today, and if not, why. */
  async list(tx: TenantTx, contractId: string, scope: ScopeBuilder, filter: HoldFilter, now: Date): Promise<HoldLine[]> {
    const status = filter.status === undefined ? null : (RETENTION_STATUSES.find((candidate) => candidate === filter.status) ?? this.badField('status'));
    if (!Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > MAX_PAGE + 1) throw invalid('limit');
    assertTimestampCursor(filter.after?.code);
    const predicate = scope(5);
    const rows = await tx.query<LineSql>(
      `select h.id, h.boq_item_id, i.business_key as boq_item_key, i.description, h.party_id, h.payment_request_id, h.acceptance_id, h.held_vnd::text as held_vnd, h.released_vnd::text as released_vnd,
              h.release_condition, h.release_not_before::text as release_not_before, h.status, ${TIMESTAMP('h.released_at')} as released_at, h.release_reason,
              h.release_decision_document_version_id, ${timestampKey('h.created_at')} as created_at, h.version::text as version, c.status as contract_status,
              (select count(*) from machvon.warranty_obligation w where w.tenant_id = c.tenant_id and w.contract_id = c.id)::text as obligations,
              (select count(*) from machvon.warranty_obligation w where w.tenant_id = c.tenant_id and w.contract_id = c.id and w.status <> 'CLOSED')::text as not_closed
         from ${CONTRACT_SCOPE_FROM}
         join machvon.retention_hold h on h.tenant_id = c.tenant_id and h.contract_id = c.id
         join machvon.boq_item i on i.tenant_id = h.tenant_id and i.id = h.boq_item_id
        where c.id = $1::uuid and ${predicate.sql} and ($2::text is null or h.status = $2)
          and ($3::text is null or (${timestampKey('h.created_at')}, h.id) < ($3::text, $4::uuid))
        order by h.created_at desc, h.id desc limit ${filter.limit}`,
      [idOf(contractId, 'contract_id'), status, filter.after?.code ?? null, filter.after?.id ?? null, ...predicate.params],
    );
    const today = vietnamDateOf(now);
    return rows.map((row) => ({
      id: row.id,
      boqItem: { id: row.boq_item_id, key: row.boq_item_key, description: row.description },
      partyId: row.party_id,
      paymentRequestId: row.payment_request_id,
      acceptanceId: row.acceptance_id,
      heldVnd: row.held_vnd,
      releasedVnd: row.released_vnd,
      leftVnd: row.status === 'FORFEITED' ? '0' : retentionLeft(row.held_vnd, row.released_vnd),
      releaseCondition: row.release_condition,
      releaseNotBefore: row.release_not_before,
      status: row.status,
      blocker:
        releaseBlocker({
          condition: row.release_condition,
          notBefore: row.release_not_before,
          today,
          contractStatus: row.contract_status,
          warranty: { obligations: Number(row.obligations), notClosed: Number(row.not_closed) },
          hasDecision: row.release_decision_document_version_id !== null,
        }) ?? null,
      releasedAt: row.released_at,
      releaseReason: row.release_reason,
      decisionDocumentVersionId: row.release_decision_document_version_id,
      createdAt: row.created_at,
      version: Number(row.version),
    }));
  }

  private badField(field: string): never {
    throw invalid(field);
  }
}
