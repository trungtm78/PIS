import { randomUUID } from 'node:crypto';
import {
  DomainError,
  assertFollowsRevision,
  assertNotProposer,
  assertNotRetroactive,
  assertValueAboveFloor,
  changeDecisionOf,
  compareDecimal,
  signedVnd,
  valueAfterChange,
} from '@machvon/kernel';
import type { ChangeDecision, ChangeStatus } from '@machvon/kernel';
import { CtrBoqStore } from './ctr-boq-store.ts';
import type { BoqImportResult } from './ctr-boq-store.ts';
import { reconciliationOf, totalMismatch } from './ctr-boq-lines.ts';
import { CtrChangeChainStore } from './ctr-change-chain-store.ts';
import type { ChangeRow } from './ctr-change-chain-store.ts';
import { CtrContractSource } from './ctr-contract-source.ts';
import type { ProjectRef } from './ctr-contract-source.ts';
import { calendarDate, textOf } from './ctr-contract-store.ts';
import type { ContractScopes } from './ctr-contract-store.ts';
import { decisionDocument } from './ctr-decision-document.ts';
import type { TenantTx } from './tenant-database.ts';

const MAX_TEXT = 2000;
const MAX_EVIDENCE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT = `nullif(current_setting('app.tenant_id', true), '')::uuid`;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export interface DecideInput {
  /** `approve`, `return` or `reject`. */
  decision: string;
  reason: string;
  evidenceIds: readonly string[];
  /** The signed amount the contract changes by; the assessment of the request when it is left out. */
  approvedDeltaVnd?: string | undefined;
  /** The first day of the new revision, `YYYY-MM-DD`; today when it is left out. */
  effectiveOn?: string | undefined;
  decisionDocumentVersionId?: string | undefined;
  /** The BOQ of the new revision (the lines of an import, replacing the copy of the BOQ in force); absent, the revision starts from a copy of the BOQ in force. */
  boqLines?: unknown;
}

/** What the store asks of the caller before a change is approved: the delegation limit of the matrix, and the availability of the capital for an increase. */
export interface DecisionHooks {
  /** Throws 403 `SCOPE_DENIED` above the delegation limit of the caller; `amountVnd` is the size of the change, whichever way it goes. */
  authorise(facts: { amountVnd: string; contractId: string; projectId: string; ownerUnit: { id: string; path: string } }): Promise<void>;
  /** Throws 422 `ALLOCATION_UNAVAILABLE` when the line of capital cannot take the increase. */
  available(allocationLineId: string, amountVnd: string): Promise<void>;
}

export interface NewRevisionResult {
  id: string;
  revision: number;
  amountVnd: string;
  validFrom: string;
  status: 'PENDING_EFFECTIVE';
  supersedesId: string;
  version: number;
  boqLineCount: number;
  boqTotalVnd: string;
  /** The import that put the lines of the change order in, when the decision carried them. */
  boqImport: BoqImportResult | undefined;
}

/** The decision as the command answers it, for the audit rows, the events and the answer. */
export interface DecisionResult {
  id: string;
  code: string;
  decision: ChangeDecision;
  /** SUBMITTED after a return, APPROVED or REJECTED. */
  status: ChangeStatus;
  fromStatus: ChangeStatus;
  version: number;
  contractId: string;
  contractCode: string;
  projectId: string;
  reason: string;
  evidenceIds: string[];
  approvedDeltaVnd: string | null;
  effectiveOn: string | null;
  decisionDocumentVersionId: string | null;
  allocationLineId: string | null;
  /** The value of the contract the change stands on and the value it gives (approval only). */
  fromValueVnd: string | null;
  toValueVnd: string | null;
  revision: NewRevisionResult | undefined;
}

/** What every decision tells: which change order, which decision, and on whose contract and reason. */
type Common = Pick<DecisionResult, 'id' | 'code' | 'decision' | 'fromStatus' | 'contractId' | 'contractCode' | 'projectId' | 'reason' | 'evidenceIds'>;

interface RevisionHead {
  id: string;
  revision: number;
  amount_vnd: string;
  valid_from: string;
  status: string;
}

/**
 * The decision of a change order (ST-CTR-007, CTR 3.3 step 4, BR-CTR-06): a CO that was assessed is approved, given back to be assessed again, or rejected, by someone who had no part in it
 * (403 `SELF_APPROVAL_DENIED`: not whoever raised or promoted a request of its chain, nor whoever assessed it, nor whoever made the decision document). An approval rests on a decision
 * document (422 `DECISION_DOCUMENT_REQUIRED`), begins today or later (422 `RETROACTIVE_NOT_ALLOWED`: what was accepted and paid under the old terms is not rewritten), after the revision it
 * follows, keeps the value of the contract at or above what was accepted and paid (422 `ACCEPTANCE_VALUE_EXCEEDS_CONTRACT`), is within the delegation limit of the matrix, and for an increase
 * the line of capital must still take it (422 `ALLOCATION_UNAVAILABLE`). It makes the next revision of the contract, PENDING_EFFECTIVE until its day: the job `revision-effective` puts
 * it in force. A revision that is pending prices nothing.
 */
export class CtrChangeDecisionStore {
  private readonly chain: CtrChangeChainStore;
  private readonly boq = new CtrBoqStore();
  private readonly source: CtrContractSource;

  constructor(source: CtrContractSource = new CtrContractSource()) {
    this.source = source;
    this.chain = new CtrChangeChainStore(source);
  }

  async decide(tx: TenantTx, id: string, expectedVersion: number, input: DecideInput, actor: string, scopes: ContractScopes, today: string, hooks: DecisionHooks): Promise<DecisionResult> {
    const decision = changeDecisionOf(input.decision);
    if (decision === undefined) throw invalid('decision');
    const reason = textOf(input.reason, 'reason', MAX_TEXT);
    const evidenceIds = this.evidenceOf(input.evidenceIds);

    const held = await this.chain.lock(tx, id, expectedVersion, scopes);
    const { row, contract } = held;
    if (row.stage !== 'CO') throw new DomainError('CHANGE_STAGE_NOT_ALLOWED', 422, 'stage', { extensions: { stage: row.stage, reason: 'ONLY_CO_DECIDED' } });
    if (row.status !== 'EVALUATED') throw new DomainError('CHANGE_STATE_INVALID', 409, 'status', { extensions: { change_status: row.status } });
    if (contract.status !== 'ACTIVE' && contract.status !== 'SUSPENDED') throw new DomainError('CONTRACT_STATE_INVALID', 409, 'contract_id', { extensions: { contract_status: contract.status } });
    await this.assertDocuments(tx, evidenceIds);
    const makers = await this.makersOf(tx, row);

    const base = {
      id: row.id,
      code: row.code ?? row.id,
      decision,
      fromStatus: row.status,
      contractId: row.contract_id,
      contractCode: row.contract_code,
      projectId: row.project_id,
      reason,
      evidenceIds,
    };

    // Whoever had a part in the chain does not decide it, whichever way; they can withdraw it.
    assertNotProposer(actor, makers);
    if (decision === 'return' || decision === 'reject') {
      return decision === 'return' ? this.giveBack(tx, row, reason, actor, base) : this.reject(tx, row, reason, actor, base);
    }

    const document = await decisionDocument(tx, input.decisionDocumentVersionId, 'decision_document_version_id');
    assertNotProposer(actor, [document.maker]);
    const delta = signedVnd(input.approvedDeltaVnd ?? row.evaluated_delta_vnd ?? '', 'approved_delta_vnd');
    const effectiveOn = input.effectiveOn === undefined ? today : calendarDate(input.effectiveOn, 'effective_on');
    assertNotRetroactive(effectiveOn, today);

    const project = await this.projectOf(tx, contract.projectId);
    await hooks.authorise({ amountVnd: absolute(delta), contractId: contract.id, projectId: contract.projectId, ownerUnit: project.ownerUnit });
    const head = await this.head(tx, contract.id);
    assertFollowsRevision(effectiveOn, head.valid_from);
    const newValue = valueAfterChange(head.amount_vnd, delta);
    if (compareDecimal(newValue, '0') <= 0) throw invalid('approved_delta_vnd');
    assertValueAboveFloor(newValue, await this.ledgerOf(tx, contract.id));
    const increase = compareDecimal(delta, '0') > 0;
    if (increase) {
      if (row.evaluation_allocation_line_id === null) throw new DomainError('ALLOCATION_UNAVAILABLE', 422, 'allocation_line_id', { extensions: { reason: 'ALLOCATION_LINE_REQUIRED' } });
      await hooks.available(row.evaluation_allocation_line_id, delta);
    }

    const revision = await this.makeRevision(tx, { head, contractId: contract.id, row, value: newValue, validFrom: effectiveOn, documentVersionId: document.versionId, actor, boqLines: input.boqLines, scopes });
    await tx.query(
      `update machvon.change_request
          set status = 'APPROVED', status_reason = $2, approved_delta_vnd = $3::numeric, effective_on = $4::date, decision_document_version_id = $5::uuid, resulting_revision_id = $6::uuid,
              decided_by = $7::uuid, decided_at = now(), updated_at = now(), updated_by = $7::uuid, version = version + 1
        where id = $1::uuid`,
      [id, reason, delta, effectiveOn, document.versionId, revision.id, actor],
    );
    return {
      ...base,
      status: 'APPROVED',
      version: Number(row.version) + 1,
      approvedDeltaVnd: delta,
      effectiveOn,
      decisionDocumentVersionId: document.versionId,
      allocationLineId: row.evaluation_allocation_line_id,
      fromValueVnd: head.amount_vnd,
      toValueVnd: newValue,
      revision,
    };
  }

  // ---- the three decisions -----------------------------------------------------------------------------------------------

  private async giveBack(tx: TenantTx, row: ChangeRow, reason: string, actor: string, base: Common): Promise<DecisionResult> {
    await tx.query("update machvon.change_request set status = 'SUBMITTED', status_reason = $2, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid", [row.id, reason, actor]);
    return { ...base, status: 'SUBMITTED', version: Number(row.version) + 1, ...EMPTY_DECIDED, allocationLineId: row.evaluation_allocation_line_id };
  }

  private async reject(tx: TenantTx, row: ChangeRow, reason: string, actor: string, base: Common): Promise<DecisionResult> {
    await tx.query(
      "update machvon.change_request set status = 'REJECTED', status_reason = $2, decided_by = $3::uuid, decided_at = now(), updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid",
      [row.id, reason, actor],
    );
    return { ...base, status: 'REJECTED', version: Number(row.version) + 1, ...EMPTY_DECIDED, allocationLineId: row.evaluation_allocation_line_id };
  }

  // ---- the revision -------------------------------------------------------------------------------------------------------

  /**
   * Writes the next revision of the contract for an approved change order: PENDING_EFFECTIVE, from the first day the change takes effect, with the value the change gives. Its BOQ is the
   * lines sent with the decision, or a copy of the BOQ of the revision it follows (which then has to fit the value); a pending revision can still be put right by an import before its day.
   */
  private async makeRevision(
    tx: TenantTx,
    values: { head: RevisionHead; contractId: string; row: ChangeRow; value: string; validFrom: string; documentVersionId: string; actor: string; boqLines: unknown; scopes: ContractScopes },
  ): Promise<NewRevisionResult> {
    const { head, contractId, row, actor } = values;
    const numbers = await tx.query<{ next: number }>('select coalesce(max(revision), 0) + 1 as next from machvon.contract_revision where contract_id = $1::uuid', [contractId]);
    const revision = numbers[0]?.next ?? head.revision + 1;
    const id = randomUUID();
    await tx.query(
      `insert into machvon.contract_revision
         (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, change_request_id, supersedes_id, retroactive, decided_by, decided_at, version, created_by, updated_by)
       values (${TENANT}, $1::uuid, $2::uuid, $3, $4::numeric, $5::uuid, $6::date, 'PENDING_EFFECTIVE', 'CHANGE_ORDER', $7::uuid, $8::uuid, false, $9::uuid, now(), 1, $9::uuid, $9::uuid)`,
      [id, contractId, revision, values.value, values.documentVersionId, values.validFrom, row.id, head.id, actor],
    );
    let boqImport: BoqImportResult | undefined;
    if (values.boqLines === undefined) await this.copyLines(tx, head.id, id, actor);
    else boqImport = await this.boq.importLines(tx, id, 1, { mode: 'REPLACE', lines: values.boqLines }, actor, values.scopes);
    const totals = await tx.query<{ total: string; n: number }>('select coalesce(sum(amount_vnd), 0)::text as total, count(*)::int as n from machvon.boq_line where contract_revision_id = $1::uuid', [id]);
    // The lines never add up to more than the value of their revision: a change that takes from the contract has to say which lines shrink.
    if (compareDecimal(totals[0]?.total ?? '0', values.value) > 0) throw totalMismatch(reconciliationOf(values.value, totals[0]?.total ?? '0', totals[0]?.n ?? 0));
    return {
      id,
      revision,
      amountVnd: values.value,
      validFrom: values.validFrom,
      status: 'PENDING_EFFECTIVE',
      supersedesId: head.id,
      version: boqImport?.version ?? 1,
      boqLineCount: totals[0]?.n ?? 0,
      boqTotalVnd: totals[0]?.total ?? '0',
      boqImport,
    };
  }

  private async copyLines(tx: TenantTx, fromRevisionId: string, toRevisionId: string, actor: string): Promise<void> {
    await tx.query(
      `insert into machvon.boq_line
         (tenant_id, id, contract_revision_id, contract_id, boq_item_id, line_no, business_key, description, unit_code, quantity, unit_price, rounding_rule, amount_vnd,
          retention_pct, milestone_code, milestone_due_on, party_id, created_by)
       select tenant_id, gen_random_uuid(), $2::uuid, contract_id, boq_item_id, line_no, business_key, description, unit_code, quantity, unit_price, rounding_rule, amount_vnd,
              retention_pct, milestone_code, milestone_due_on, party_id, $3::uuid
         from machvon.boq_line where contract_revision_id = $1::uuid`,
      [fromRevisionId, toRevisionId, actor],
    );
  }

  /** The revision the change follows: the latest one in force or waiting for its day. A contract that is being performed always has one. */
  private async head(tx: TenantTx, contractId: string): Promise<RevisionHead> {
    const rows = await tx.query<RevisionHead>(
      `select id, revision, amount_vnd::text as amount_vnd, valid_from::text as valid_from, status
         from machvon.contract_revision where contract_id = $1::uuid and status in ('PENDING_EFFECTIVE', 'EFFECTIVE') order by revision desc limit 1`,
      [contractId],
    );
    const head = rows[0];
    if (head === undefined) throw new DomainError('CONTRACT_STATE_INVALID', 409, 'contract_id', { extensions: { reason: 'NO_REVISION_IN_FORCE' } });
    return head;
  }

  // ---- what the decision is judged on --------------------------------------------------------------------------------------

  /** Whoever raised or promoted a request of the chain and whoever assessed the request: the people whose work the decision approves. */
  private async makersOf(tx: TenantTx, row: ChangeRow): Promise<string[]> {
    const rows = await tx.query<{ submitted_by: string | null; evaluated_by: string | null }>(
      `with recursive chain as (
         select id, parent_id, submitted_by, evaluated_by from machvon.change_request where id = $1::uuid
         union all
         select r.id, r.parent_id, r.submitted_by, r.evaluated_by from machvon.change_request r join chain c on r.id = c.parent_id
       ) select submitted_by, evaluated_by from chain`,
      [row.id],
    );
    return rows.flatMap((each) => [each.submitted_by, each.evaluated_by].filter((who): who is string => who !== null));
  }

  private async ledgerOf(tx: TenantTx, contractId: string) {
    const rows = await tx.query<{ accepted_total_vnd: string; advance_paid_vnd: string; paid_total_vnd: string; advance_recovered_vnd: string }>(
      'select accepted_total_vnd::text, advance_paid_vnd::text, paid_total_vnd::text, advance_recovered_vnd::text from machvon.contract where id = $1::uuid',
      [contractId],
    );
    const ledger = rows[0];
    if (ledger === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { acceptedTotalVnd: ledger.accepted_total_vnd, advancePaidVnd: ledger.advance_paid_vnd, paidTotalVnd: ledger.paid_total_vnd, advanceRecoveredVnd: ledger.advance_recovered_vnd };
  }

  private async projectOf(tx: TenantTx, projectId: string): Promise<ProjectRef> {
    const project = await this.source.projectRef(tx, projectId);
    if (project === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return project;
  }

  private evidenceOf(ids: readonly string[]): string[] {
    if (ids.length > MAX_EVIDENCE || ids.some((id) => !UUID.test(id))) throw invalid('evidence_ids');
    return [...new Set(ids.map((id) => id.toLowerCase()))].sort();
  }

  private async assertDocuments(tx: TenantTx, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const rows = await tx.query<{ id: string }>('select id from machvon.document where id = any($1::uuid[])', [ids]);
    if (rows.length !== ids.length) throw invalid('evidence_ids');
  }
}

const EMPTY_DECIDED = {
  approvedDeltaVnd: null,
  effectiveOn: null,
  decisionDocumentVersionId: null,
  fromValueVnd: null,
  toValueVnd: null,
  revision: undefined,
} as const;

/** The size of a signed amount without its sign: the delegation limit judges how much is changed, not which way. */
function absolute(amount: string): string {
  return amount.startsWith('-') ? amount.slice(1) : amount;
}
