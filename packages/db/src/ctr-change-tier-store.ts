import { randomUUID } from 'node:crypto';
import { DomainError, assertNotProposer, changeFunding, classifyChangeOrder, pctHundredths, signedVnd } from '@machvon/kernel';
import type { ChangeClassification, ChangeFunding, ChangeOrderTierParams, MoneyRuleReading } from '@machvon/kernel';
import { CtrChangeChainStore } from './ctr-change-chain-store.ts';
import { CtrChangeRevisions } from './ctr-change-revision.ts';
import { SCOPE_FROM as CONTRACT_SCOPE_FROM, textOf } from './ctr-contract-store.ts';
import type { ContractScopes } from './ctr-contract-store.ts';
import { decisionDocument } from './ctr-decision-document.ts';
import { MoneyPolicyReader } from './money-policy-reader.ts';
import { PrjReserveStore } from './prj-reserve-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT = `nullif(current_setting('app.tenant_id', true), '')::uuid`;

export interface TierFacts {
  changeId: string;
  contractId: string;
  projectId: string;
  /** The signed change: the assessment while the request is assessed, the approved amount when it is decided. */
  deltaVnd: string;
}

export interface AdjustmentCheckView {
  id: string;
  status: 'REQUIRED' | 'CLEARED';
  cumulativePct: string;
  thresholdPct: string;
  basis: string | null;
  decisionDocumentVersionId: string | null;
  requiredAt: string;
  clearedBy: string | null;
  clearedAt: string | null;
  auditNotifiedAt: string | null;
}

/** What the tier of a change order comes to: the classification, where an increase is paid from, the rule that decided and the check of the project adjustment. */
export interface TierOutcome {
  changeId: string;
  contractId: string;
  projectId: string;
  classification: ChangeClassification;
  funding: ChangeFunding;
  policy: { version: number | null; source: 'DEFAULT' | 'RULE'; projectAdjustmentPct: string; requireReserveCover: boolean };
  check: AdjustmentCheckView | null;
  /** The check of the project adjustment was raised by this very classification: the audit is to be told. */
  checkRaised: boolean;
  /** What a reserve holds for this change order: the drawdowns approved for it, and the contingency left. */
  approvedDrawdownVnd: string;
  contingencyBalanceVnd: string | null;
}

export interface ClearInput {
  basis: string;
  decisionDocumentVersionId: string | undefined;
}

export interface ClearResult {
  checkId: string;
  changeId: string;
  contractId: string;
  projectId: string;
  cumulativePct: string;
  version: number;
}

interface CheckSql {
  id: string;
  status: 'REQUIRED' | 'CLEARED';
  cumulative_pct: string;
  threshold_pct: string;
  basis: string | null;
  decision_document_version_id: string | null;
  required_at: string;
  cleared_by: string | null;
  cleared_at: string | null;
  audit_notified_at: string | null;
}

const CHECK_SELECT = `select id, status, cumulative_pct::text as cumulative_pct, threshold_pct::text as threshold_pct, basis, decision_document_version_id,
       to_char(required_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as required_at, cleared_by, to_char(cleared_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as cleared_at,
       to_char(audit_notified_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as audit_notified_at
  from machvon.change_adjustment_check`;

const toCheck = (row: CheckSql): AdjustmentCheckView => ({
  id: row.id,
  status: row.status,
  cumulativePct: row.cumulative_pct,
  thresholdPct: row.threshold_pct,
  basis: row.basis,
  decisionDocumentVersionId: row.decision_document_version_id,
  requiredAt: row.required_at,
  clearedBy: row.cleared_by,
  clearedAt: row.cleared_at,
  auditNotifiedAt: row.audit_notified_at,
});

/**
 * The tiers of the change orders (governance deepening G1-8, CTR F05). The thresholds are the policy of the day (`CHANGE_ORDER_TIER`): a change order is tier 1, 2 or 3 by its size and by the cumulative
 * variation of the contract against its original price; the authority that decides it is the delegation of authority of ADM, asked for the larger of the change and the cumulative variation; a cumulative
 * variation at the threshold forces a check of the project adjustment, cleared by someone who had no part in the chain, before the change order is approved; and an increase needs a source, an approved drawdown
 * of the reserve for this change order or a project adjustment that was cleared (the capital line is judged by CAP as before).
 */
export class CtrChangeTierStore {
  private readonly money: MoneyPolicyReader;
  private readonly reserves: PrjReserveStore;
  private readonly chain = new CtrChangeChainStore();
  private readonly revisions = new CtrChangeRevisions();

  constructor(money: MoneyPolicyReader = new MoneyPolicyReader(), reserves: PrjReserveStore = new PrjReserveStore(money)) {
    this.money = money;
    this.reserves = reserves;
  }

  /**
   * Works out the tier of a change order for a signed change and writes it on the request with the version of the rule that gave it. When the cumulative variation reaches the threshold of the policy
   * a check of the project adjustment is raised (once) and `checkRaised` says so, for the audit to be told. Writes only the classification of the request and that check.
   */
  async classify(tx: TenantTx, facts: TierFacts, actor: string, today: string): Promise<TierOutcome> {
    const delta = signedVnd(facts.deltaVnd, 'delta_vnd');
    const reading = await this.money.get(tx, 'CHANGE_ORDER_TIER', today);
    const classification = await this.classification(tx, facts, delta.toString(), reading.params);
    await tx.query(
      `update machvon.change_request set tier = $2, cumulative_variation_pct = $3::numeric, tier_rule_version = $4, tier_rule_source = $5, classified_at = now() where id = $1::uuid`,
      [facts.changeId, classification.tier, classification.cumulativePct ?? '0', reading.version, reading.source],
    );
    let checkRaised = false;
    if (classification.forcesAdjustment) {
      const [existing] = await tx.query<{ id: string }>('select id from machvon.change_adjustment_check where change_request_id = $1::uuid', [facts.changeId]);
      if (existing === undefined) {
        await tx.query(
          `insert into machvon.change_adjustment_check (tenant_id, id, change_request_id, project_id, contract_id, cumulative_pct, threshold_pct, required_by, audit_notified_at)
           values (${TENANT}, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::numeric, $6::numeric, $7::uuid, now())`,
          [randomUUID(), facts.changeId, facts.projectId, facts.contractId, classification.cumulativePct ?? '0', reading.params.projectAdjustmentPct, actor],
        );
        checkRaised = true;
      }
    }
    return this.outcome(tx, facts, classification, reading, checkRaised);
  }

  /**
   * The gate an approval goes through: classifies the change at the amount that is being approved, then refuses while the check of the project adjustment is required and not cleared at least up to the
   * cumulative variation now (422 `PROJECT_ADJUSTMENT_CHECK_REQUIRED`), and while an increase has no source (422 `CHANGE_FUNDING_REQUIRED`). Gives what the delegation of authority is asked for.
   */
  async gate(tx: TenantTx, facts: TierFacts, actor: string, today: string): Promise<TierOutcome> {
    const outcome = await this.classify(tx, facts, actor, today);
    if (outcome.classification.forcesAdjustment) {
      const cleared = outcome.check?.status === 'CLEARED' && pctHundredths(outcome.check.cumulativePct) >= pctHundredths(outcome.classification.cumulativePct ?? '0');
      if (!cleared) {
        // The refusal rolls back the classification with it; the request for the check is raised by the evaluation, and cleared by its own command.
        throw new DomainError('PROJECT_ADJUSTMENT_CHECK_REQUIRED', 422, 'change_request_id', {
          extensions: { cumulative_pct: outcome.classification.cumulativePct, threshold_pct: outcome.policy.projectAdjustmentPct, check_status: outcome.check?.status ?? 'NOT_RAISED', tier: outcome.classification.tier },
        });
      }
    }
    if (outcome.funding.needsCover && !outcome.funding.covered) {
      throw new DomainError('CHANGE_FUNDING_REQUIRED', 422, 'change_request_id', {
        extensions: { shortfall_vnd: outcome.funding.shortfallVnd, approved_drawdown_vnd: outcome.approvedDrawdownVnd, contingency_balance_vnd: outcome.contingencyBalanceVnd, tier: outcome.classification.tier },
      });
    }
    return outcome;
  }

  /** The tier, the funding and the check of a change order in the scope of the caller, as the screen shows them; undefined when the caller does not reach it. */
  async view(tx: TenantTx, changeId: string, scope: ScopeBuilder, today: string): Promise<(TierOutcome & { code: string | null; stage: string; status: string; version: number }) | undefined> {
    if (!UUID.test(changeId)) throw new DomainError('VALIDATION_FAILED', 422, 'id');
    const predicate = scope(2);
    const [row] = await tx.query<{ id: string; code: string | null; stage: string; status: string; contract_id: string; project_id: string; delta: string; version: string }>(
      `select r.id, r.code, r.stage, r.status, r.contract_id, c.project_id, coalesce(case when r.status = 'APPROVED' then r.approved_delta_vnd else coalesce(r.evaluated_delta_vnd, r.estimated_delta_vnd) end, 0)::text as delta, r.version::text as version
         from ${CONTRACT_SCOPE_FROM} join machvon.change_request r on r.tenant_id = c.tenant_id and r.contract_id = c.id
        where r.id = $1::uuid and ${predicate.sql}`,
      [changeId.toLowerCase(), ...predicate.params],
    );
    if (row === undefined) return undefined;
    const facts: TierFacts = { changeId: row.id, contractId: row.contract_id, projectId: row.project_id, deltaVnd: row.delta };
    const reading = await this.money.get(tx, 'CHANGE_ORDER_TIER', today);
    const classification = await this.classification(tx, facts, row.delta, reading.params);
    const outcome = await this.outcome(tx, facts, classification, reading, false);
    return { ...outcome, code: row.code, stage: row.stage, status: row.status, version: Number(row.version) };
  }

  /**
   * Clears the check of the project adjustment of a change order on a document: by someone who had no part in the chain and did not make the document (403 `SELF_APPROVAL_DENIED`), while the cumulative variation
   * still calls for it (409 `ADJUSTMENT_CHECK_NOT_REQUIRED` otherwise). The check is created here if the evaluation did not raise it, so the check is never a dead end.
   */
  async clear(tx: TenantTx, changeId: string, expectedVersion: number, input: ClearInput, actor: string, scopes: ContractScopes, today: string): Promise<ClearResult> {
    const basis = textOf(input.basis, 'basis', 2000);
    const held = await this.chain.lock(tx, changeId, expectedVersion, scopes);
    if (held.row.stage !== 'CO' || held.row.status !== 'EVALUATED') throw new DomainError('CHANGE_STATE_INVALID', 409, 'status', { extensions: { change_status: held.row.status, stage: held.row.stage } });
    const document = await decisionDocument(tx, input.decisionDocumentVersionId, 'decision_document_version_id');
    assertNotProposer(actor, [...(await this.revisions.makersOf(tx, held.row)), document.maker]);
    const delta = held.row.evaluated_delta_vnd ?? held.row.estimated_delta_vnd ?? '0';
    const facts: TierFacts = { changeId: held.row.id, contractId: held.contract.id, projectId: held.contract.projectId, deltaVnd: delta };
    const reading = await this.money.get(tx, 'CHANGE_ORDER_TIER', today);
    const classification = await this.classification(tx, facts, delta, reading.params);
    if (!classification.forcesAdjustment) throw new DomainError('ADJUSTMENT_CHECK_NOT_REQUIRED', 409, 'change_request_id', { extensions: { cumulative_pct: classification.cumulativePct, threshold_pct: reading.params.projectAdjustmentPct } });
    const pct = classification.cumulativePct ?? '0';
    const [existing] = await tx.query<{ id: string; status: string; version: string }>('select id, status, version::text as version from machvon.change_adjustment_check where change_request_id = $1::uuid for update', [held.row.id]);
    if (existing === undefined) {
      const checkId = randomUUID();
      await tx.query(
        `insert into machvon.change_adjustment_check (tenant_id, id, change_request_id, project_id, contract_id, status, cumulative_pct, threshold_pct, basis, decision_document_version_id, required_by, cleared_by, cleared_at, audit_notified_at)
         values (${TENANT}, $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'CLEARED', $5::numeric, $6::numeric, $7, $8::uuid, $9::uuid, $9::uuid, now(), now())`,
        [checkId, held.row.id, held.contract.projectId, held.contract.id, pct, reading.params.projectAdjustmentPct, basis, document.versionId, actor],
      );
      return { checkId, changeId: held.row.id, contractId: held.contract.id, projectId: held.contract.projectId, cumulativePct: pct, version: 1 };
    }
    await tx.query(
      `update machvon.change_adjustment_check
          set status = 'CLEARED', cumulative_pct = $2::numeric, basis = $3, decision_document_version_id = $4::uuid, cleared_by = $5::uuid, cleared_at = now(), version = version + 1
        where id = $1::uuid`,
      [existing.id, pct, basis, document.versionId, actor],
    );
    return { checkId: existing.id, changeId: held.row.id, contractId: held.contract.id, projectId: held.contract.projectId, cumulativePct: pct, version: Number(existing.version) + 1 };
  }

  // ---- internals ---------------------------------------------------------------------------------------------------------------

  private async classification(tx: TenantTx, facts: TierFacts, deltaVnd: string, params: ChangeOrderTierParams): Promise<ChangeClassification> {
    const [figures] = await tx.query<{ original: string | null; approved: string }>(
      `select (select b.amount_vnd::text from machvon.contract_revision b where b.tenant_id = c.tenant_id and b.contract_id = c.id order by b.revision limit 1) as original,
              (select coalesce(sum(r.approved_delta_vnd), 0)::text from machvon.change_request r where r.tenant_id = c.tenant_id and r.contract_id = c.id and r.status = 'APPROVED' and r.id <> $2::uuid) as approved
         from machvon.contract c where c.id = $1::uuid`,
      [facts.contractId, facts.changeId],
    );
    if (figures === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return classifyChangeOrder(params, { deltaVnd, approvedCumulativeVnd: figures.approved, originalPriceVnd: figures.original ?? '0' });
  }

  private async outcome(tx: TenantTx, facts: TierFacts, classification: ChangeClassification, reading: MoneyRuleReading<'CHANGE_ORDER_TIER'>, checkRaised: boolean): Promise<TierOutcome> {
    const [check] = await tx.query<CheckSql>(`${CHECK_SELECT} where change_request_id = $1::uuid`, [facts.changeId]);
    const drawn = await this.reserves.approvedDrawdownFor(tx, facts.changeId);
    const [fund] = await tx.query<{ balance: string }>("select balance_vnd::text as balance from machvon.reserve_fund where project_id = $1::uuid and kind = 'CONTINGENCY'", [facts.projectId]);
    const cleared = check?.status === 'CLEARED' && pctHundredths(check.cumulative_pct) >= pctHundredths(classification.cumulativePct ?? '0');
    return {
      changeId: facts.changeId,
      contractId: facts.contractId,
      projectId: facts.projectId,
      classification,
      funding: changeFunding(reading.params, { deltaVnd: facts.deltaVnd, approvedDrawdownVnd: drawn, adjustmentCleared: cleared && classification.forcesAdjustment }),
      policy: { version: reading.version, source: reading.source, projectAdjustmentPct: reading.params.projectAdjustmentPct, requireReserveCover: reading.params.requireReserveCover },
      check: check === undefined ? null : toCheck(check),
      checkRaised,
      approvedDrawdownVnd: drawn,
      contingencyBalanceVnd: fund?.balance ?? null,
    };
  }
}
