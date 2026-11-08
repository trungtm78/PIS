import { randomUUID } from 'node:crypto';
import { DomainError, assertFourEyes, claimTextOf, validateClaimTerm, versionConflict, vietnamDateOf } from '@machvon/kernel';
import type { ClaimSide, ClaimTerm, ClaimTermInput, ClaimTermStatus } from '@machvon/kernel';
import { SCOPE_FROM, TIMESTAMP } from './ctr-contract-store.ts';
import type { ContractPlace, ContractScopes } from './ctr-contract-store.ts';
import { CtrContractSource } from './ctr-contract-source.ts';
import { lockRegisterContract, lockScopedRow, readRegisterContract } from './ctr-register-scope.ts';
import type { TenantTx } from './tenant-database.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TEMPLATE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
/** A contract that never began, or was cancelled, has no claims and so takes no term. */
const NO_TERM_STATES: readonly string[] = ['DRAFT', 'IN_REVIEW', 'CANCELLED'];

export interface ClaimTermRow {
  id: string;
  contractId: string;
  term: ClaimTerm;
  basisDocumentVersionId: string | null;
  templateCode: string | null;
  status: ClaimTermStatus;
  decisionNote: string | null;
  proposedBy: string;
  proposedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  supersededById: string | null;
  version: number;
}

interface TermSql {
  id: string;
  contract_id: string;
  claimant_side: ClaimSide;
  notice_days: number | null;
  particulars_days: number | null;
  response_days: number | null;
  settlement_days: number | null;
  basis: ClaimTerm['basis'];
  particulars_from: ClaimTerm['particularsFrom'];
  bar_effect: ClaimTerm['barEffect'];
  clause_reference: string;
  basis_document_version_id: string | null;
  template_code: string | null;
  status: ClaimTermStatus;
  decision_note: string | null;
  proposed_by: string;
  proposed_at: string;
  decided_by: string | null;
  decided_at: string | null;
  superseded_by_id: string | null;
  version: string;
}

const COLUMNS = `t.id, t.contract_id, t.claimant_side, t.notice_days, t.particulars_days, t.response_days, t.settlement_days, t.basis, t.particulars_from, t.bar_effect, t.clause_reference,
  t.basis_document_version_id, t.template_code, t.status, t.decision_note, t.proposed_by, ${TIMESTAMP('t.proposed_at')} as proposed_at, t.decided_by, ${TIMESTAMP('t.decided_at')} as decided_at,
  t.superseded_by_id, t.version::text as version`;

const FROM = `machvon.contract_claim_term t join ${SCOPE_FROM} on c.tenant_id = t.tenant_id and c.id = t.contract_id`;

const termOf = (row: TermSql): ClaimTerm => ({
  claimantSide: row.claimant_side,
  noticeDays: row.notice_days,
  particularsDays: row.particulars_days,
  responseDays: row.response_days,
  settlementDays: row.settlement_days,
  basis: row.basis,
  particularsFrom: row.particulars_from,
  barEffect: row.bar_effect,
  clauseReference: row.clause_reference,
});

const toRow = (row: TermSql): ClaimTermRow => ({
  id: row.id,
  contractId: row.contract_id,
  term: termOf(row),
  basisDocumentVersionId: row.basis_document_version_id,
  templateCode: row.template_code,
  status: row.status,
  decisionNote: row.decision_note,
  proposedBy: row.proposed_by,
  proposedAt: row.proposed_at,
  decidedBy: row.decided_by,
  decidedAt: row.decided_at,
  supersededById: row.superseded_by_id,
  version: Number(row.version),
});

export interface ClaimTermProposal extends ClaimTermInput {
  basisDocumentVersionId?: string | undefined;
  templateCode?: string | undefined;
}

/** What a command on a term changed: the term, the contract it belongs to, and (for an approval) the claims that were bound to it. */
export interface ClaimTermMove {
  id: string;
  contractId: string;
  contractCode: string;
  claimantSide: ClaimSide;
  status: ClaimTermStatus;
  fromStatus: ClaimTermStatus | null;
  version: number;
  supersededId: string | null;
  /** The ids of the claims of the contract that had no term and were bound to this one by the approval. */
  boundClaimIds: string[];
  reach: ContractPlace;
}

/**
 * The limitation terms of the claims of a contract (G1-9, `docs/ctr-claims.md`). A term is entered from the clauses of the signed contract and proposed by one person, and approved by another (403
 * `SELF_APPROVAL_DENIED`): only an APPROVED term gives the claims of a side a limitation clock, and the register never assumes one. Approving a term supersedes the one before it (its history stays) and binds
 * the open claims of that side that had no term, each with a step on its timeline.
 */
export class CtrClaimTermStore {
  private readonly source = new CtrContractSource();

  /** Proposes a term for one side of a contract. Only one proposal per side waits at a time (409 `CLAIM_TERM_PENDING`). */
  async propose(tx: TenantTx, contractId: string, input: ClaimTermProposal, actor: string, scopes: ContractScopes): Promise<ClaimTermMove> {
    const contract = await lockRegisterContract(tx, contractId, scopes);
    if (NO_TERM_STATES.includes(contract.status)) throw new DomainError('CONTRACT_STATE_INVALID', 409);
    const term = validateClaimTerm(input);
    const documentId = input.basisDocumentVersionId?.toLowerCase();
    if (documentId !== undefined && !(UUID.test(documentId) && (await this.source.cleanDocumentVersionExists(tx, documentId)))) throw new DomainError('VALIDATION_FAILED', 422, 'basis_document_version_id');
    if (input.templateCode !== undefined && !TEMPLATE_CODE.test(input.templateCode)) throw new DomainError('VALIDATION_FAILED', 422, 'template_code');
    const pending = await tx.query<{ id: string }>("select id from machvon.contract_claim_term where contract_id = $1::uuid and claimant_side = $2 and status = 'PROPOSED' for update", [contractId, term.claimantSide]);
    if (pending[0] !== undefined) throw new DomainError('CLAIM_TERM_PENDING', 409, 'claimant_side');
    const id = randomUUID();
    await tx.query(
      `insert into machvon.contract_claim_term (tenant_id, id, contract_id, claimant_side, notice_days, particulars_days, response_days, settlement_days, basis, particulars_from, bar_effect, clause_reference,
         basis_document_version_id, template_code, status, proposed_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::uuid, $13, 'PROPOSED', $14::uuid)`,
      [id, contractId, term.claimantSide, term.noticeDays, term.particularsDays, term.responseDays, term.settlementDays, term.basis, term.particularsFrom, term.barEffect, term.clauseReference, documentId ?? null, input.templateCode ?? null, actor],
    );
    return { id, contractId, contractCode: contract.code, claimantSide: term.claimantSide, status: 'PROPOSED', fromStatus: null, version: 1, supersededId: null, boundClaimIds: [], reach: contract.reach };
  }

  /**
   * Decides a proposal: APPROVE (the proposal becomes the term in force, the one before it is superseded, and the open claims of the side that had no term are bound to it) or REJECT (with words). Never by the
   * person who proposed it. A stale version is 409 `VERSION_CONFLICT`; a term that is not waiting for a decision is 409 `CLAIM_STATE_INVALID`.
   */
  async decide(tx: TenantTx, id: string, expectedVersion: number, decision: unknown, note: unknown, actor: string, scopes: ContractScopes, now: Date): Promise<ClaimTermMove> {
    const held = await lockScopedRow<TermSql & { contract_code: string }>(tx, { columns: `${COLUMNS}, c.code as contract_code`, from: FROM, alias: 't', id }, scopes);
    if (Number(held.version) !== expectedVersion) throw versionConflict(Number(held.version));
    if (held.status !== 'PROPOSED') throw new DomainError('CLAIM_STATE_INVALID', 409, 'status');
    if (decision !== 'APPROVE' && decision !== 'REJECT') throw new DomainError('VALIDATION_FAILED', 422, 'decision');
    assertFourEyes(held.proposed_by, actor);
    const text = note === undefined || note === null ? null : claimTextOf(note, 'note');
    if (decision === 'REJECT' && text === null) throw new DomainError('VALIDATION_FAILED', 422, 'note');
    let supersededId: string | null = null;
    const bound: string[] = [];
    if (decision === 'APPROVE') {
      const previous = await tx.query<{ id: string; version: string }>("select id, version::text as version from machvon.contract_claim_term where contract_id = $1::uuid and claimant_side = $2 and status = 'APPROVED' for update", [held.contract_id, held.claimant_side]);
      if (previous[0] !== undefined) {
        supersededId = previous[0].id;
        await tx.query("update machvon.contract_claim_term set status = 'SUPERSEDED', superseded_by_id = $2::uuid, version = version + 1, updated_at = now() where id = $1::uuid", [supersededId, id]);
      }
    }
    await tx.query(
      `update machvon.contract_claim_term set status = $2, decision_note = $3, decided_by = $4::uuid, decided_at = $5::timestamptz, version = version + 1, updated_at = now() where id = $1::uuid`,
      [id, decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', text, actor, now.toISOString()],
    );
    if (decision === 'APPROVE') bound.push(...(await this.bindOpenClaims(tx, held.contract_id, held.claimant_side, id, actor, vietnamDateOf(now))));
    return { id, contractId: held.contract_id, contractCode: held.contract_code, claimantSide: held.claimant_side, status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', fromStatus: 'PROPOSED', version: Number(held.version) + 1, supersededId, boundClaimIds: bound, reach: held.reach };
  }

  /** Binds the open claims of the side that have no term to the term just approved, one step on the timeline of each (the claim is locked in the order of its id, so two approvals never deadlock). */
  private async bindOpenClaims(tx: TenantTx, contractId: string, side: ClaimSide, termId: string, actor: string, today: string): Promise<string[]> {
    const claims = await tx.query<{ id: string; step_count: number; version: string; last_step_on: string }>(
      `select id, step_count, version::text as version, last_step_on::text as last_step_on from machvon.contract_claim
        where contract_id = $1::uuid and claimant_side = $2 and term_id is null and status not in ('SETTLED', 'WITHDRAWN', 'REFERRED', 'TIME_BARRED') order by id for update`,
      [contractId, side],
    );
    for (const claim of claims) {
      const version = Number(claim.version) + 1;
      await tx.query('update machvon.contract_claim set term_id = $2::uuid, step_count = step_count + 1, version = $3, updated_at = now() where id = $1::uuid', [claim.id, termId, version]);
      await tx.query(
        `insert into machvon.contract_claim_step (tenant_id, id, claim_id, ordinal, kind, occurred_on, note, term_id, actor_id, claim_version_after)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, 'TERM_BOUND', $3::date, $4, $5::uuid, $6::uuid, $7)`,
        [claim.id, claim.step_count + 1, today, 'The approved term of the contract was bound to the claim.', termId, actor, version],
      );
    }
    return claims.map((claim) => claim.id);
  }

  /** The terms of a contract, newest first (404 for a contract the caller cannot see). */
  async list(tx: TenantTx, contractId: string, scopes: Pick<ContractScopes, 'read'>): Promise<ClaimTermRow[]> {
    await readRegisterContract(tx, contractId, scopes.read);
    const rows = await tx.query<TermSql>(`select ${COLUMNS} from machvon.contract_claim_term t where t.contract_id = $1::uuid order by t.proposed_at desc, t.id desc`, [contractId]);
    return rows.map(toRow);
  }

  /** The terms with these ids (the terms the claims of a page are bound to). */
  async byIds(tx: TenantTx, ids: readonly string[]): Promise<Map<string, ClaimTermRow>> {
    if (ids.length === 0) return new Map();
    const rows = await tx.query<TermSql>(`select ${COLUMNS} from machvon.contract_claim_term t where t.id = any($1::uuid[])`, [[...ids]]);
    return new Map(rows.map((row) => [row.id, toRow(row)]));
  }

  /** The term in force for a side of a contract, or undefined when it has none (then its claims have no limitation clock). */
  async approved(tx: TenantTx, contractId: string, side: ClaimSide): Promise<ClaimTermRow | undefined> {
    const rows = await tx.query<TermSql>(`select ${COLUMNS} from machvon.contract_claim_term t where t.contract_id = $1::uuid and t.claimant_side = $2 and t.status = 'APPROVED'`, [contractId, side]);
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }
}
