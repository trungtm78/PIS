import { DomainError, advancePosition, assertFinalPaymentClearsAdvance, contractAvailability, recoveryTable } from '@machvon/kernel';
import type { AdvancePosition, ContractAvailability, RecoveryEvent, RecoveryRow } from '@machvon/kernel';
import { SCOPE_FROM as CONTRACT_SCOPE_FROM } from './ctr-contract-store.ts';
import { MoneyPolicyReader } from './money-policy-reader.ts';
import { PayAdvanceStore } from './pay-advance-store.ts';
import type { AdvanceView } from './pay-advance-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The recovery of one advance, planned against actual, and the advance of the contract against what is left to pay (PAY-07, G1-11). */
export interface AdvanceRecoveryTable {
  advance: AdvanceView;
  rows: RecoveryRow[];
  position: ContractAdvancePosition;
  asOf: string;
}

/** What a contract owes in advances against what it can still recover from payments. */
export interface ContractAdvancePosition extends AdvancePosition {
  contractId: string;
  contractCode: string;
  money: ContractAvailability;
  /** The final payment of the contract is refused while the advance is still owed (the policy of the day). */
  finalPaymentRequiresFullRecovery: boolean;
  policy: { version: number | null; source: 'DEFAULT' | 'RULE'; toleranceVnd: string };
}

/** One tier of the cap table of the advance, as the policy in force on a day says it. */
export interface AdvancePolicyTier {
  minValueVnd: string;
  capPct: string;
}

export interface AdvancePolicyVersion {
  versionId: string;
  advanceCategory: string;
  revision: number;
  validFrom: string;
  validUntil: string | null;
  inForce: boolean;
  legalBasis: string;
  /** The cap is a working assumption until the confirmation named by `cxn` arrives: a screen that applies it says so (a configuration, never a rule of the system). */
  awaitingConfirmation: boolean;
  cxn: string | null;
  recoveryThresholdPct: string | null;
  tiers: AdvancePolicyTier[];
}

/**
 * The reads of the advance against what is left to pay (governance deepening G1-11, PAY-07/11/12 extended): the planned recovery next to the actual one for each payment request that recovered, the
 * position of the contract (what is owed against the payments left to recover it), and the policy of the cap as data with the days it is in force. The cap itself stays a master rule (`PAY_ADVANCE_CAP`),
 * which already carries its period, its legal basis and its `awaiting_confirmation` flag: the number of Decree 254/2025 is configuration, never a rule of the system.
 */
export class PayAdvanceRecoveryReads {
  private readonly advances = new PayAdvanceStore();
  private readonly money: MoneyPolicyReader;

  constructor(money: MoneyPolicyReader = new MoneyPolicyReader()) {
    this.money = money;
  }

  async table(tx: TenantTx, advanceId: string, scope: ScopeBuilder, today: string): Promise<AdvanceRecoveryTable | undefined> {
    const advance = await this.advances.find(tx, advanceId, scope);
    if (advance === undefined) return undefined;
    const parties = await tx.query<{ id: string }>("select id from machvon.contract_party where contract_id = $1::uuid and status = 'ACTIVE'", [advance.contract.id]);
    const sole = parties.length === 1 ? (parties[0]?.id ?? null) : null;
    const entries = await tx.query<{ posted_at: string; paid: string; after: string; request_no: string | null; posted_on: string; gross_cum: string }>(
      `select e.posted_at::text as posted_at, a.paid_vnd::text as paid, e.outstanding_after_vnd::text as after, pr.request_no, (e.posted_at at time zone 'Asia/Ho_Chi_Minh')::date::text as posted_on,
              (select coalesce(sum(le.requested_delta_vnd), 0)::text
                 from machvon.cumulative_ledger_entry le join machvon.cumulative_ledger l on l.tenant_id = le.tenant_id and l.id = le.ledger_id
                where le.contract_id = e.contract_id and (l.party_id = e.party_id or (l.party_id is null and $2::uuid = e.party_id)) and le.posted_at <= e.posted_at) as gross_cum
         from machvon.advance_ledger_entry e
         join machvon.contract_advance a on a.tenant_id = e.tenant_id and a.id = e.advance_id
         left join machvon.payment_request pr on pr.tenant_id = e.tenant_id and pr.id = e.payment_request_id
        where e.advance_id = $1::uuid and e.entry_kind = 'RECOVER' and not exists (select 1 from machvon.advance_ledger_entry r where r.tenant_id = e.tenant_id and r.reversal_of_id = e.id)
        order by e.posted_at, e.id`,
      [advance.id, sole],
    );
    const events: RecoveryEvent[] = entries.map((entry) => ({
      requestNo: entry.request_no,
      on: entry.posted_on,
      grossCumVnd: entry.gross_cum,
      recoveredCumVnd: (BigInt(entry.paid) - BigInt(entry.after)).toString(),
    }));
    const gross = await this.advances.grossToDate(tx, advance.contract.id, advance.party.id);
    const rows = recoveryTable({ paidVnd: advance.paidVnd, workValueVnd: advance.party.workValueVnd, thresholdPct: advance.thresholdPct, grossToDateVnd: gross, recoveredVnd: advance.recoveredVnd, events });
    const position = await this.positionOfContract(tx, advance.contract.id, scope, today);
    if (position === undefined) return undefined;
    return { advance, rows, position, asOf: new Date().toISOString() };
  }

  /** The advances of a contract against what is left to pay on it; undefined when the caller does not reach the contract. */
  async positionOfContract(tx: TenantTx, contractId: string, scope: ScopeBuilder, today: string): Promise<ContractAdvancePosition | undefined> {
    if (!UUID.test(contractId)) throw new DomainError('VALIDATION_FAILED', 422, 'id');
    const predicate = scope(2);
    const [row] = await tx.query<{
      id: string;
      code: string;
      contract_value_vnd: string;
      requested_total_vnd: string;
      paid_total_vnd: string;
      advance_paid_vnd: string;
      advance_recovered_vnd: string;
      original: string | null;
    }>(
      `select c.id, c.code, c.contract_value_vnd::text as contract_value_vnd, c.requested_total_vnd::text as requested_total_vnd, c.paid_total_vnd::text as paid_total_vnd,
              c.advance_paid_vnd::text as advance_paid_vnd, c.advance_recovered_vnd::text as advance_recovered_vnd,
              (select b.amount_vnd::text from machvon.contract_revision b where b.tenant_id = c.tenant_id and b.contract_id = c.id order by b.revision limit 1) as original
         from ${CONTRACT_SCOPE_FROM} where c.id = $1::uuid and ${predicate.sql}`,
      [contractId.toLowerCase(), ...predicate.params],
    );
    if (row === undefined) return undefined;
    const reading = await this.money.get(tx, 'ADVANCE_RECOVERY', today);
    const money = contractAvailability({
      currentPriceVnd: row.contract_value_vnd,
      originalPriceVnd: row.original ?? row.contract_value_vnd,
      requestedTotalVnd: row.requested_total_vnd,
      paidTotalVnd: row.paid_total_vnd,
      advancePaidVnd: row.advance_paid_vnd,
      advanceRecoveredVnd: row.advance_recovered_vnd,
      pendingIncreaseVnd: '0',
    });
    return {
      ...advancePosition(money.advanceOutstandingVnd, money.remainingPayableVnd),
      contractId: row.id,
      contractCode: row.code,
      money,
      finalPaymentRequiresFullRecovery: reading.params.finalPaymentRequiresFullRecovery,
      policy: { version: reading.version, source: reading.source, toleranceVnd: reading.params.toleranceVnd },
    };
  }

  /**
   * The check a final payment goes through when it is sent: after the recovery this very request makes, the advances of the contract may not be owed beyond the tolerance of the policy (422
   * `FINAL_PAYMENT_ADVANCE_OUTSTANDING`). Called from the sending of a request of the FINAL kind, inside its transaction and under the lock of the contract.
   */
  async assertFinalPaymentClears(tx: TenantTx, contractId: string, today: string): Promise<void> {
    const reading = await this.money.get(tx, 'ADVANCE_RECOVERY', today);
    if (!reading.params.finalPaymentRequiresFullRecovery) return;
    const [owed] = await tx.query<{ outstanding: string }>("select coalesce(sum(paid_vnd - recovered_vnd), 0)::text as outstanding from machvon.contract_advance where contract_id = $1::uuid and status in ('PAID', 'RECOVERING')", [contractId]);
    // The request has already taken its recovery from the advances when this is asked (it is asked after the books are written), so what is owed now is what is owed after it.
    assertFinalPaymentClearsAdvance(owed?.outstanding ?? '0', reading.params.toleranceVnd);
  }

  /** The advance policy as data: every version of the cap table with the days it is in force and whether it still waits for confirmation, newest first; `asOf` marks the one in force. */
  async policy(tx: TenantTx, asOf: string): Promise<AdvancePolicyVersion[]> {
    const rows = await tx.query<{ id: string; business_key: string; revision: number; valid_from: string; valid_until: string | null; legal_basis: string | null; attributes: Record<string, unknown> }>(
      `select v.id, r.business_key, v.revision, v.valid_from::text as valid_from, v.valid_until::text as valid_until, v.legal_basis, v.attributes
         from machvon.master_record r join machvon.master_record_version v on v.master_record_id = r.id
        where r.master_type = 'PAY_ADVANCE_CAP' and v.status in ('APPROVED', 'EFFECTIVE', 'RETIRED') and v.published_at is not null
        order by r.business_key, v.valid_from desc, v.revision desc limit 200`,
    );
    return rows.map((row) => {
      const tiers = Array.isArray(row.attributes.tiers)
        ? (row.attributes.tiers as Array<{ min_value_vnd?: unknown; cap_pct?: unknown }>).flatMap((tier): AdvancePolicyTier[] => (typeof tier.min_value_vnd === 'string' && typeof tier.cap_pct === 'string' ? [{ minValueVnd: tier.min_value_vnd, capPct: tier.cap_pct }] : []))
        : [];
      return {
        versionId: row.id,
        advanceCategory: row.business_key,
        revision: row.revision,
        validFrom: row.valid_from,
        validUntil: row.valid_until,
        inForce: row.valid_from <= asOf && (row.valid_until === null || asOf < row.valid_until),
        legalBasis: row.legal_basis ?? '',
        awaitingConfirmation: row.attributes.awaiting_confirmation === true,
        cxn: typeof row.attributes.cxn === 'string' ? row.attributes.cxn : null,
        recoveryThresholdPct: typeof row.attributes.recovery_threshold_pct === 'string' || typeof row.attributes.recovery_threshold_pct === 'number' ? String(row.attributes.recovery_threshold_pct) : null,
        tiers,
      };
    });
  }
}
