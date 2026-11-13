import { randomUUID } from 'node:crypto';
import {
  ADVANCE_KINDS,
  COUNTED_STATUSES,
  DomainError,
  RECOVERY_BASES,
  advanceCap,
  assertAcknowledgeable,
  assertPlanDue,
  assertRecoverable,
  capPercentFor,
  recoveryPlan,
  versionConflict,
  vietnamDateOf,
  wholeVnd,
} from '@machvon/kernel';
import type { AdvanceKind, AdvanceStatus, CapTier, RecoveryBasis, RecoveryPlan } from '@machvon/kernel';
import { CtrContractStore, SCOPE_FROM as CONTRACT_SCOPE_FROM, TIMESTAMP } from './ctr-contract-store.ts';
import type { ContractPlace, ContractScopes } from './ctr-contract-store.ts';
import { MasterRules } from './master-rules.ts';
import type { RuleReading } from './master-rules.ts';
import { PayPaymentStore } from './pay-payment-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/** The rule type of the caps of the advance and the one of the days a land clearance advance may stay unrecovered (BR-PAY-10, BR-PAY-11). */
export const ADVANCE_CAP_RULE = 'PAY_ADVANCE_CAP';
export const ADVANCE_GPMB_RULE = 'PAY_ADVANCE_GPMB';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 2000;
const MAX_TRANCHE = 32767;
const MAX_PAGE = 200;
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const TENANT = `nullif(current_setting('app.tenant_id', true), '')::uuid`;
const COUNTED = COUNTED_STATUSES.map((status) => `'${status}'`).join(', ');

const invalid = (field: string, reason?: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field, reason === undefined ? undefined : { extensions: { reason } });
const idOf = (value: string, field: string): string => {
  if (!UUID.test(value)) throw invalid(field);
  return value.toLowerCase();
};
const dayOf = (value: string, field: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || !new Date(`${value}T00:00:00Z`).toISOString().startsWith(value)) throw invalid(field);
  return value;
};
const textOf = (value: string, field: string): string => {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MAX_TEXT) throw invalid(field);
  return trimmed;
};

export interface RequestAdvanceInput {
  partyId: string;
  kind: string;
  amountVnd: string;
  guaranteeId?: string | undefined;
  allocationLineId: string;
  trancheNo?: number | undefined;
}

export interface RecordRecoveryInput {
  amountVnd: string;
  basis: string;
  sourceRefId?: string | undefined;
  evidenceDocumentVersionId: string;
  /** The identifier of the command, kept on the entry it posts. */
  requestId: string;
}

export interface AcknowledgeInput {
  note: string;
  planDueOn: string;
}

export interface OverdueFilter {
  /** Only the advances at exactly this alert level. */
  level?: number | undefined;
  limit?: number | undefined;
  after?: { createdAt: string; id: string } | undefined;
}

export interface AdvanceFilter {
  contractId?: string | undefined;
  status?: string | undefined;
  limit?: number | undefined;
  after?: { createdAt: string; id: string } | undefined;
}

/** An advance as the screens read it: the figures, the rule that capped it with the confirmation it waits for, and where the contract lies for the permissions that depend on it. */
export interface AdvanceView {
  id: string;
  version: number;
  status: AdvanceStatus;
  contract: { id: string; code: string; status: string; valueVnd: string; advanceCategory: string };
  projectId: string;
  party: { id: string; role: string; name: string | null; workValueVnd: string };
  trancheNo: number;
  kind: AdvanceKind;
  amountVnd: string;
  capVnd: string;
  /** The share the rule gave this contract; null when the rule version cannot be read any more. */
  capPct: string | null;
  capRuleVersionId: string | null;
  capRuleAwaitingConfirmation: boolean;
  capRuleCxn: string | null;
  guaranteeId: string | null;
  allocationLineId: string | null;
  paidVnd: string;
  recoveredVnd: string;
  outstandingVnd: string;
  paidOn: string | null;
  thresholdPct: string;
  recoveryDeadline: string | null;
  overdueSince: string | null;
  lastAlertLevel: number;
  /** The plan the person who answers for the advance gave once it was overdue: a note and the day it is due, nothing that moves the amounts. */
  /** `byName` is the name of the person who answered as the directory of the tenant holds it (null when the directory has no name for the membership). */
  acknowledgement: { note: string; planDueOn: string; by: string; byName: string | null; at: string } | null;
  createdAt: string;
  updatedAt: string;
  reach: ContractPlace;
}

/** What a command on an advance did: the advance as it stands, and the status it left. */
export interface AdvanceResult {
  view: AdvanceView;
  fromStatus: AdvanceStatus | null;
}

/** The recovery of one advance and the facts it stands on (CTR-06, PAY-07). */
export interface AdvancePlan {
  view: AdvanceView;
  plan: RecoveryPlan;
}

interface AdvanceSql {
  id: string;
  version: string;
  status: AdvanceStatus;
  contract_id: string;
  contract_code: string;
  contract_status: string;
  contract_value_vnd: string;
  advance_category: string;
  project_id: string;
  party_id: string;
  party_role: string;
  party_name: string | null;
  work_value_vnd: string;
  tranche_no: number;
  kind: AdvanceKind;
  amount_vnd: string;
  cap_vnd: string;
  cap_rule_version_id: string | null;
  rule_attributes: Record<string, unknown> | null;
  guarantee_id: string | null;
  allocation_line_id: string | null;
  paid_vnd: string;
  recovered_vnd: string;
  outstanding_vnd: string;
  paid_on: string | null;
  recovery_threshold_pct: string;
  recovery_deadline: string | null;
  overdue_since: string | null;
  last_alert_level: number;
  alert_note: string | null;
  alert_plan_due_on: string | null;
  alert_acknowledged_by: string | null;
  alert_acknowledged_by_name: string | null;
  alert_acknowledged_at: string | null;
  created_at: string;
  updated_at: string;
  owner_unit_id: string;
  owner_unit_path: string;
  investor_unit_id: string | null;
  investor_unit_path: string | null;
}

const SELECT = `select a.id, a.version::text as version, a.status, c.id as contract_id, c.code as contract_code, c.status as contract_status, c.contract_value_vnd::text as contract_value_vnd,
       c.advance_category, c.project_id, a.party_id, cp.role as party_role, k.legal_name as party_name, cp.work_value_vnd::text as work_value_vnd, a.tranche_no, a.kind,
       a.amount_vnd::text as amount_vnd, a.cap_vnd::text as cap_vnd, a.cap_rule_version_id, rv.attributes as rule_attributes, a.guarantee_id, a.allocation_line_id, a.paid_vnd::text as paid_vnd,
       a.recovered_vnd::text as recovered_vnd, a.outstanding_vnd::text as outstanding_vnd, a.paid_on::text as paid_on, a.recovery_threshold_pct::text as recovery_threshold_pct,
       a.recovery_deadline::text as recovery_deadline, a.overdue_since::text as overdue_since, a.last_alert_level, a.alert_note, a.alert_plan_due_on::text as alert_plan_due_on, a.alert_acknowledged_by,
       (select u.display_name from machvon.tenant_user_directory u where u.tenant_id = a.tenant_id and u.membership_id = a.alert_acknowledged_by) as alert_acknowledged_by_name, ${TIMESTAMP('a.alert_acknowledged_at')} as alert_acknowledged_at,
       ${TIMESTAMP('a.created_at')} as created_at, ${TIMESTAMP('a.updated_at')} as updated_at,
       ou.id as owner_unit_id, ou.path as owner_unit_path, iu.id as investor_unit_id, iu.path as investor_unit_path
  from ${CONTRACT_SCOPE_FROM}
  join machvon.contract_advance a on a.tenant_id = c.tenant_id and a.contract_id = c.id
  join machvon.contract_party cp on cp.tenant_id = a.tenant_id and cp.id = a.party_id
  left join machvon.contractor k on k.tenant_id = cp.tenant_id and k.id = cp.contractor_id
  left join machvon.master_record_version rv on rv.id = a.cap_rule_version_id`;

/** Percent with trailing zeros dropped: the share as a person reads it. */
const trimmedPercent = (value: string): string => {
  const [whole = '0', fraction = ''] = value.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed === '' ? whole : `${whole}.${trimmed}`;
};

function tiersOf(attributes: Record<string, unknown> | null): CapTier[] {
  const tiers = attributes?.tiers;
  if (!Array.isArray(tiers)) return [];
  return tiers.flatMap((tier): CapTier[] => {
    const row = tier as { min_value_vnd?: unknown; cap_pct?: unknown };
    return typeof row.min_value_vnd === 'string' && typeof row.cap_pct === 'string' ? [{ minValueVnd: row.min_value_vnd, capPct: row.cap_pct }] : [];
  });
}

function toView(row: AdvanceSql): AdvanceView {
  const pct = capPercentFor(tiersOf(row.rule_attributes), row.contract_value_vnd);
  return {
    id: row.id,
    version: Number(row.version),
    status: row.status,
    contract: { id: row.contract_id, code: row.contract_code, status: row.contract_status, valueVnd: row.contract_value_vnd, advanceCategory: row.advance_category },
    projectId: row.project_id,
    party: { id: row.party_id, role: row.party_role, name: row.party_name, workValueVnd: row.work_value_vnd },
    trancheNo: row.tranche_no,
    kind: row.kind,
    amountVnd: row.amount_vnd,
    capVnd: row.cap_vnd,
    capPct: pct === undefined ? null : trimmedPercent(pct),
    capRuleVersionId: row.cap_rule_version_id,
    capRuleAwaitingConfirmation: row.rule_attributes?.awaiting_confirmation === true,
    capRuleCxn: typeof row.rule_attributes?.cxn === 'string' ? row.rule_attributes.cxn : null,
    guaranteeId: row.guarantee_id,
    allocationLineId: row.allocation_line_id,
    paidVnd: row.paid_vnd,
    recoveredVnd: row.recovered_vnd,
    outstandingVnd: row.outstanding_vnd,
    paidOn: row.paid_on,
    thresholdPct: trimmedPercent(row.recovery_threshold_pct),
    recoveryDeadline: row.recovery_deadline,
    overdueSince: row.overdue_since,
    lastAlertLevel: row.last_alert_level,
    acknowledgement:
      row.alert_note === null || row.alert_plan_due_on === null || row.alert_acknowledged_by === null || row.alert_acknowledged_at === null
        ? null
        : { note: row.alert_note, planDueOn: row.alert_plan_due_on, by: row.alert_acknowledged_by, byName: row.alert_acknowledged_by_name, at: row.alert_acknowledged_at },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reach: {
      contractId: row.contract_id,
      projectId: row.project_id,
      ownerUnit: { id: row.owner_unit_id, path: row.owner_unit_path },
      investorUnit: row.investor_unit_id === null || row.investor_unit_path === null ? null : { id: row.investor_unit_id, path: row.investor_unit_path },
    },
  };
}

interface ContractSql {
  status: string;
  effective_from: string | null;
  advance_category: string;
  contract_value_vnd: string;
  project_id: string;
  advance_paid_vnd: string;
  advance_recovered_vnd: string;
  paid_total_vnd: string;
}

interface GuaranteeSql {
  id: string;
  party_id: string | null;
  status: string;
  verification_status: string;
  amount_vnd: string;
  expired: boolean;
}

/**
 * The advance of a contract (ST-PAY-004, PAY 3.2, BR-PAY-04, BR-PAY-10, BR-PAY-11): asked for on a contract that is in force, under a guarantee that covers it, within the cap the rule of the day
 * gives the work of the member; cancelled while it is only planned or asked for; recovered outside the payments with a basis and evidence. Every command takes the lock of the contract first (the
 * order of the locks of the product), so two requests for one member are decided one after the other and the second sees the first under the cap. The payments recover the advance in the sending of
 * a request (`PayClaimStore`); here are the advance itself and the recoveries that no payment makes.
 */
export class PayAdvanceStore {
  private readonly contracts = new CtrContractStore();
  private readonly payments = new PayPaymentStore();
  private readonly rules: MasterRules;

  constructor(rules: MasterRules = new MasterRules()) {
    this.rules = rules;
  }

  /** Plans an advance: the conditions of PAY 3.2 step 1, in the order they are met. */
  async request(tx: TenantTx, contractId: string, input: RequestAdvanceInput, actor: string, scopes: ContractScopes, now: Date): Promise<AdvanceResult> {
    const id = idOf(contractId, 'id');
    const today = vietnamDateOf(now);
    const partyId = idOf(input.partyId, 'party_id');
    const allocationLineId = idOf(input.allocationLineId, 'allocation_line_id');
    const kind = ADVANCE_KINDS.find((candidate) => candidate === input.kind) ?? this.fail('kind');
    const amount = wholeVnd(input.amountVnd, 'amount_vnd');
    if (amount === 0n) throw invalid('amount_vnd', 'MUST_BE_POSITIVE');
    if (input.trancheNo !== undefined && (!Number.isInteger(input.trancheNo) || input.trancheNo < 1 || input.trancheNo > MAX_TRANCHE)) throw invalid('tranche_no');
    const requestedGuarantee = input.guaranteeId === undefined ? undefined : idOf(input.guaranteeId, 'guarantee_id');

    await this.contracts.lock(tx, id, scopes);
    const [contract] = await tx.query<ContractSql>(
      `select status, effective_from::text as effective_from, advance_category, contract_value_vnd::text as contract_value_vnd, project_id, advance_paid_vnd::text as advance_paid_vnd,
              advance_recovered_vnd::text as advance_recovered_vnd, paid_total_vnd::text as paid_total_vnd
         from machvon.contract where id = $1::uuid`,
      [id],
    );
    if (contract === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (contract.status !== 'ACTIVE' || contract.effective_from === null || contract.effective_from > today) {
      throw new DomainError('ADVANCE_CONTRACT_NOT_EFFECTIVE', 422, 'id', { extensions: { contract_status: contract.status, effective_from: contract.effective_from } });
    }
    const [party] = await tx.query<{ work_value_vnd: string }>("select work_value_vnd::text as work_value_vnd from machvon.contract_party where id = $1::uuid and contract_id = $2::uuid and status = 'ACTIVE'", [partyId, id]);
    if (party === undefined) throw invalid('party_id', 'NOT_A_MEMBER');

    const guaranteeId = kind === 'CONTRACT' ? await this.coveringGuarantee(tx, id, partyId, amount, requestedGuarantee, now) : null;

    // The cap: the rule of the day for the category of the contract, the tier its value reaches, the work of the member and what is already advanced to it.
    const rule = await this.rules.read(tx, 'PAY_ADVANCE_CAP', contract.advance_category, today);
    if (rule === undefined) throw new DomainError('ADVANCE_RULE_UNCONFIRMED', 422, 'advance_category', { extensions: { reason: 'NO_RULE', advance_category: contract.advance_category } });
    const capPct = capPercentFor(tiersOf(rule.attributes), contract.contract_value_vnd);
    if (capPct === undefined) throw new DomainError('ADVANCE_RULE_UNCONFIRMED', 422, 'advance_category', { extensions: { reason: 'NO_TIER', advance_category: contract.advance_category, cap_rule_version_id: rule.versionId } });
    const [advanced] = await tx.query<{ committed: string }>(
      `select coalesce(sum(case when paid_vnd > 0 then paid_vnd else amount_vnd end), 0)::text as committed from machvon.contract_advance
        where contract_id = $1::uuid and party_id = $2::uuid and status in (${COUNTED})`,
      [id, partyId],
    );
    const room = advanceCap(capPct, party.work_value_vnd, advanced?.committed ?? '0');
    if (amount > BigInt(room)) {
      throw new DomainError('ADVANCE_CAP_EXCEEDED', 422, 'amount_vnd', {
        extensions: { cap_vnd: room, cap_pct: trimmedPercent(capPct), cap_rule_version_id: rule.versionId, rule_awaiting_confirmation: rule.awaitingConfirmation, cxn: rule.cxn },
      });
    }
    await this.assertNoOverdue(tx, id, partyId, party.work_value_vnd, rule, today);
    await this.assertCashOut(tx, id, contract, amount);
    await this.payments.assertAllocation(tx, allocationLineId, contract.project_id, null, today);

    const [next] = await tx.query<{ next: number }>('select coalesce(max(tranche_no), 0) + 1 as next from machvon.contract_advance where contract_id = $1::uuid and party_id = $2::uuid', [id, partyId]);
    const trancheNo = input.trancheNo ?? Number(next?.next ?? 1);
    const advanceId = randomUUID();
    try {
      await tx.query(
        `insert into machvon.contract_advance
           (tenant_id, id, contract_id, party_id, tranche_no, kind, amount_vnd, cap_vnd, cap_rule_version_id, guarantee_id, allocation_line_id, status, recovery_threshold_pct, created_by, updated_by)
         values (${TENANT}, $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::numeric, $7::numeric, $8::uuid, $9::uuid, $10::uuid, 'PLANNED', $11::numeric, $12::uuid, $12::uuid)`,
        [advanceId, id, partyId, trancheNo, kind, amount.toString(), room, rule.versionId, guaranteeId, allocationLineId, String(rule.attributes.recovery_threshold_pct), actor],
      );
    } catch (error) {
      throw this.mapRefusal(error);
    }
    return { view: await this.view(tx, advanceId), fromStatus: null };
  }

  /** Cancels an advance that is only planned or asked for, with the reason (kept in the audit row); one a payment request still stands on is returned or cancelled first. */
  async cancel(tx: TenantTx, advanceId: string, expectedVersion: number, reasonText: string, actor: string, scopes: ContractScopes): Promise<AdvanceResult> {
    textOf(reasonText, 'reason');
    const held = await this.lock(tx, advanceId, expectedVersion, scopes);
    if (held.status !== 'PLANNED' && held.status !== 'REQUESTED') throw new DomainError('ADVANCE_STATE_INVALID', 409, 'id', { extensions: { status: held.status } });
    const open = await tx.query<{ id: string }>("select id from machvon.payment_request where advance_id = $1::uuid and status not in ('CANCELLED', 'REVERSED', 'RETURNED') limit 1", [held.id]);
    if (open[0] !== undefined) throw new DomainError('ADVANCE_STATE_INVALID', 409, 'id', { extensions: { status: held.status, reason: 'PAYMENT_REQUEST_OPEN', payment_request_id: open[0].id } });
    try {
      await tx.query("update machvon.contract_advance set status = 'CANCELLED', updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid", [held.id, actor]);
    } catch (error) {
      throw this.mapRefusal(error);
    }
    return { view: await this.view(tx, held.id), fromStatus: held.status };
  }

  /**
   * Records a recovery that no payment makes (a compensation paid to the one who owes the advance, a refund of money): up to what is still owed, with its basis and the evidence. The advance, the
   * totals of the contract and the journal of the advance move together, and the journal keeps the entry as it was posted.
   */
  async recordRecovery(tx: TenantTx, advanceId: string, expectedVersion: number, input: RecordRecoveryInput, actor: string, scopes: ContractScopes): Promise<AdvanceResult> {
    const basis: RecoveryBasis = RECOVERY_BASES.find((candidate) => candidate === input.basis) ?? this.fail('basis');
    const evidence = idOf(input.evidenceDocumentVersionId, 'evidence_document_version_id');
    const source = input.sourceRefId === undefined ? null : idOf(input.sourceRefId, 'source_ref_id');
    const amount = wholeVnd(input.amountVnd, 'amount_vnd');
    const held = await this.lock(tx, advanceId, expectedVersion, scopes);
    if (held.status !== 'PAID' && held.status !== 'RECOVERING') throw new DomainError('ADVANCE_STATE_INVALID', 409, 'id', { extensions: { status: held.status } });
    const [document] = await tx.query<{ scan_status: string }>('select scan_status from machvon.document_version where id = $1::uuid', [evidence]);
    if (document === undefined) throw invalid('evidence_document_version_id', 'NOT_FOUND');
    if (document.scan_status !== 'CLEAN') throw new DomainError('DOCUMENT_NOT_CLEAN', 422, 'evidence_document_version_id');
    const recovered = assertRecoverable(held.paid_vnd, held.recovered_vnd, amount.toString());
    const full = recovered === held.paid_vnd;
    try {
      await tx.query(
        `update machvon.contract_advance set recovered_vnd = $2::numeric, status = $3, updated_at = now(), updated_by = $4::uuid, version = version + 1 where id = $1::uuid`,
        [held.id, recovered, full ? 'FULLY_RECOVERED' : 'RECOVERING', actor],
      );
      await tx.query('update machvon.contract set advance_recovered_vnd = advance_recovered_vnd + $2::numeric, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid', [held.contract_id, amount.toString(), actor]);
      await tx.query(
        `insert into machvon.advance_ledger_entry
           (tenant_id, id, contract_id, payment_request_id, entry_kind, amount_vnd, posted_at, advance_id, party_id, outstanding_after_vnd, posted_by, request_id, basis, source_ref_id, evidence_document_version_id)
         values (${TENANT}, gen_random_uuid(), $1::uuid, null, 'RECOVER', $2::numeric, now(), $3::uuid, $4::uuid, ($5::numeric - $6::numeric), $7::uuid, $8::uuid, $9, $10::uuid, $11::uuid)`,
        [held.contract_id, amount.toString(), held.id, held.party_id, held.paid_vnd, recovered, actor, input.requestId, basis, source, evidence],
      );
    } catch (error) {
      throw this.mapRefusal(error);
    }
    return { view: await this.view(tx, held.id), fromStatus: held.status };
  }

  /**
   * The person who answers for an advance that is overdue gives the plan to recover it and the day it is due (PAY 3.2 step 5, UAT-AC329). Only that is stored: the amounts and the status do not move, and the advance stays
   * overdue and owed until it is recovered. A stale version is 409 `VERSION_CONFLICT`, an advance that is not overdue or not owed 422 `ADVANCE_NOT_OVERDUE`, a plan due before today 422 `VALIDATION_FAILED`.
   */
  async acknowledge(tx: TenantTx, advanceId: string, expectedVersion: number, input: AcknowledgeInput, actor: string, scopes: ContractScopes, today: string): Promise<AdvanceResult> {
    const note = textOf(input.note, 'note');
    const planDueOn = dayOf(input.planDueOn, 'action_plan_due_on');
    const held = await this.lock(tx, advanceId, expectedVersion, scopes);
    assertAcknowledgeable({ outstandingVnd: held.outstanding_vnd, overdueSince: held.overdue_since });
    assertPlanDue(planDueOn, today);
    try {
      await tx.query(
        'update machvon.contract_advance set alert_note = $2, alert_plan_due_on = $3::date, alert_acknowledged_by = $4::uuid, alert_acknowledged_at = now(), updated_at = now(), updated_by = $4::uuid, version = version + 1 where id = $1::uuid',
        [held.id, note, planDueOn, actor],
      );
    } catch (error) {
      throw this.mapRefusal(error);
    }
    return { view: await this.view(tx, held.id), fromStatus: held.status };
  }

  /** The advances in the scope of the caller that were alerted and are still owed, the newest first; narrowed to one alert level (PAY-12). */
  async overdue(tx: TenantTx, scope: ScopeBuilder, filter: OverdueFilter): Promise<AdvanceView[]> {
    if (filter.level !== undefined && (!Number.isInteger(filter.level) || filter.level < 1 || filter.level > 4)) throw invalid('level');
    const predicate = scope(4);
    const rows = await tx.query<AdvanceSql>(
      `${SELECT}
        where ${predicate.sql} and a.last_alert_level > 0 and a.paid_vnd > a.recovered_vnd and ($1::int is null or a.last_alert_level = $1::int)
          and ($2::text is null or (${TIMESTAMP('a.created_at')}, a.id) < ($2::text, $3::uuid))
        order by ${TIMESTAMP('a.created_at')} desc, a.id desc limit ${Math.min(Math.max(filter.limit ?? 50, 1), MAX_PAGE + 1)}`,
      [filter.level ?? null, filter.after?.createdAt ?? null, filter.after?.id ?? null, ...predicate.params],
    );
    return rows.map(toView);
  }

  /** The advance with where its recovery stands and where it goes (CTR-06, PAY-07): what the member asked to be paid before decides, whatever the other members did. */
  async plan(tx: TenantTx, advanceId: string, scope: ScopeBuilder): Promise<AdvancePlan | undefined> {
    const view = await this.find(tx, advanceId, scope);
    if (view === undefined) return undefined;
    return { view, plan: await this.planOf(tx, view) };
  }

  async find(tx: TenantTx, advanceId: string, scope: ScopeBuilder): Promise<AdvanceView | undefined> {
    const predicate = scope(2);
    const [row] = await tx.query<AdvanceSql>(`${SELECT} where a.id = $1::uuid and ${predicate.sql}`, [idOf(advanceId, 'id'), ...predicate.params]);
    return row === undefined ? undefined : toView(row);
  }

  /** The advances in the scope of the caller, the newest first; narrowed by contract and status. */
  async list(tx: TenantTx, scope: ScopeBuilder, filter: AdvanceFilter): Promise<AdvanceView[]> {
    const contractId = filter.contractId === undefined ? null : idOf(filter.contractId, 'contract_id');
    const status = filter.status === undefined ? null : (['PLANNED', 'REQUESTED', 'PAID', 'RECOVERING', 'FULLY_RECOVERED', 'CANCELLED'] as const).find((candidate) => candidate === filter.status) ?? this.fail('status');
    const predicate = scope(5);
    const rows = await tx.query<AdvanceSql>(
      `${SELECT}
        where ${predicate.sql} and ($1::uuid is null or a.contract_id = $1::uuid) and ($2::text is null or a.status = $2)
          and ($3::text is null or (${TIMESTAMP('a.created_at')}, a.id) < ($3::text, $4::uuid))
        order by ${TIMESTAMP('a.created_at')} desc, a.id desc limit ${Math.min(Math.max(filter.limit ?? 50, 1), MAX_PAGE + 1)}`,
      [contractId, status, filter.after?.createdAt ?? null, filter.after?.id ?? null, ...predicate.params],
    );
    return rows.map(toView);
  }

  /** What the member has asked to be paid in the requests so far (the `G` of BR-PAY-04); lines that name no party count under the one active party of a sole contract. */
  async grossToDate(tx: TenantTx, contractId: string, partyId: string): Promise<string> {
    const parties = await tx.query<{ id: string }>("select id from machvon.contract_party where contract_id = $1::uuid and status = 'ACTIVE'", [contractId]);
    const sole = parties.length === 1 ? parties[0]?.id : undefined;
    const [row] = await tx.query<{ gross: string }>(
      'select coalesce(sum(requested_vnd), 0)::text as gross from machvon.cumulative_ledger where contract_id = $1::uuid and (party_id = $2::uuid or (party_id is null and $3::uuid = $2::uuid))',
      [contractId, partyId, sole ?? null],
    );
    return row?.gross ?? '0';
  }

  // ---- internals ------------------------------------------------------------------------------------------------------------

  private fail(field: string): never {
    throw invalid(field);
  }

  private async planOf(tx: TenantTx, view: AdvanceView): Promise<RecoveryPlan> {
    return recoveryPlan({
      paidVnd: view.paidVnd,
      recoveredVnd: view.recoveredVnd,
      workValueVnd: view.party.workValueVnd,
      thresholdPct: view.thresholdPct,
      grossToDateVnd: await this.grossToDate(tx, view.contract.id, view.party.id),
    });
  }

  private async view(tx: TenantTx, advanceId: string): Promise<AdvanceView> {
    const [row] = await tx.query<AdvanceSql>(`${SELECT} where a.id = $1::uuid`, [advanceId]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return toView(row);
  }

  /** The advance locked for update inside the scope of the command, its contract locked first; one the caller cannot see does not exist, and a stale version is 409 `VERSION_CONFLICT`. */
  private async lock(
    tx: TenantTx,
    advanceId: string,
    expectedVersion: number,
    scopes: ContractScopes,
  ): Promise<{ id: string; contract_id: string; party_id: string; status: AdvanceStatus; paid_vnd: string; recovered_vnd: string; outstanding_vnd: string; overdue_since: string | null }> {
    const id = idOf(advanceId, 'id');
    const peek = await tx.query<{ contract_id: string }>('select contract_id from machvon.contract_advance where id = $1::uuid', [id]);
    if (peek[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await this.contracts.lock(tx, peek[0].contract_id, scopes);
    const [row] = await tx.query<{ id: string; version: string; contract_id: string; party_id: string; status: AdvanceStatus; paid_vnd: string; recovered_vnd: string; outstanding_vnd: string; overdue_since: string | null }>(
      'select id, version::text as version, contract_id, party_id, status, paid_vnd::text as paid_vnd, recovered_vnd::text as recovered_vnd, outstanding_vnd::text as outstanding_vnd, overdue_since::text as overdue_since from machvon.contract_advance where id = $1::uuid for update',
      [id],
    );
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    return row;
  }

  /**
   * The guarantee that covers an advance of a contract: active, verified, not expired and at least as large as the advance, of the member or of the whole contract. The one named is judged as it is; when none is
   * named the smallest that covers is taken. 422 `ADVANCE_GUARANTEE_REQUIRED` says what is wrong with the best candidate.
   */
  private async coveringGuarantee(tx: TenantTx, contractId: string, partyId: string, amount: bigint, named: string | undefined, now: Date): Promise<string> {
    const rows = await tx.query<GuaranteeSql>(
      `select id, party_id, status, verification_status, amount_vnd::text as amount_vnd, (expires_at <= $2::timestamptz) as expired
         from machvon.guarantee where contract_id = $1::uuid and kind = 'ADVANCE' order by amount_vnd, id`,
      [contractId, now.toISOString()],
    );
    const refusal = (guarantee: GuaranteeSql): string | undefined => {
      if (guarantee.verification_status !== 'VERIFIED') return 'NOT_VERIFIED';
      if (guarantee.status !== 'ACTIVE') return 'NOT_ACTIVE';
      if (guarantee.expired) return 'EXPIRED';
      if (BigInt(guarantee.amount_vnd) < amount) return 'TOO_SMALL';
      if (guarantee.party_id !== null && guarantee.party_id !== partyId) return 'OTHER_MEMBER';
      return undefined;
    };
    const required = (reason: string): DomainError => new DomainError('ADVANCE_GUARANTEE_REQUIRED', 422, 'guarantee_id', { extensions: { reason } });
    if (named !== undefined) {
      const guarantee = rows.find((candidate) => candidate.id === named);
      if (guarantee === undefined) throw required('NOT_FOUND');
      const problem = refusal(guarantee);
      if (problem !== undefined) throw required(problem);
      return guarantee.id;
    }
    const usable = rows.find((candidate) => refusal(candidate) === undefined);
    if (usable !== undefined) return usable.id;
    // Say what is wrong with the one that came nearest: a verified one before the others, then the largest.
    const nearest = [...rows].sort((a, b) => Number(b.verification_status === 'VERIFIED') - Number(a.verification_status === 'VERIFIED') || Number(BigInt(b.amount_vnd) - BigInt(a.amount_vnd)))[0];
    throw required(nearest === undefined ? 'NO_GUARANTEE' : (refusal(nearest) ?? 'NO_GUARANTEE'));
  }

  /**
   * A member whose earlier advance is overdue is not advanced again: a land clearance advance past its deadline, or a contract advance whose member has already asked to be paid up to the threshold
   * and still owes it. 422 `ADVANCE_OUTSTANDING_PRIOR` names the advance.
   */
  private async assertNoOverdue(tx: TenantTx, contractId: string, partyId: string, workValueVnd: string, rule: RuleReading, today: string): Promise<void> {
    const owing = await tx.query<{ id: string; kind: AdvanceKind; paid_vnd: string; recovered_vnd: string; recovery_deadline: string | null; recovery_threshold_pct: string }>(
      `select id, kind, paid_vnd::text as paid_vnd, recovered_vnd::text as recovered_vnd, recovery_deadline::text as recovery_deadline, recovery_threshold_pct::text as recovery_threshold_pct
         from machvon.contract_advance where contract_id = $1::uuid and party_id = $2::uuid and status in ('PAID', 'RECOVERING') and paid_vnd > recovered_vnd order by tranche_no`,
      [contractId, partyId],
    );
    if (owing.length === 0) return;
    const gross = owing.some((advance) => advance.kind === 'CONTRACT') ? await this.grossToDate(tx, contractId, partyId) : '0';
    for (const advance of owing) {
      const late =
        advance.kind === 'GPMB'
          ? advance.recovery_deadline !== null && advance.recovery_deadline < today
          : recoveryPlan({ paidVnd: advance.paid_vnd, recoveredVnd: advance.recovered_vnd, workValueVnd, thresholdPct: advance.recovery_threshold_pct, grossToDateVnd: gross }).remainingToThresholdVnd === '0';
      if (late) throw new DomainError('ADVANCE_OUTSTANDING_PRIOR', 422, 'party_id', { extensions: { advance_id: advance.id, outstanding_vnd: (BigInt(advance.paid_vnd) - BigInt(advance.recovered_vnd)).toString(), cap_rule_version_id: rule.versionId } });
    }
  }

  /** The cash that leaves a contract (the advances unrecovered and the payments) may not go above its value (`contract_cash_out_chk`): 409 `VALUE_EXCEEDED` before the advance is planned. */
  private async assertCashOut(tx: TenantTx, contractId: string, contract: ContractSql, amount: bigint): Promise<void> {
    const [planned] = await tx.query<{ amount: string }>("select coalesce(sum(amount_vnd), 0)::text as amount from machvon.contract_advance where contract_id = $1::uuid and status in ('PLANNED', 'REQUESTED')", [contractId]);
    const out = BigInt(contract.advance_paid_vnd) + BigInt(contract.paid_total_vnd) - BigInt(contract.advance_recovered_vnd) + BigInt(planned?.amount ?? '0') + amount;
    if (out > BigInt(contract.contract_value_vnd)) {
      throw new DomainError('VALUE_EXCEEDED', 409, 'amount_vnd', { extensions: { rule: 'contract_cash_out_chk', contract_value_vnd: contract.contract_value_vnd, cash_out_vnd: out.toString() } });
    }
  }

  /** What the database refused, in the words of the contract; anything else is not ours to explain. */
  private mapRefusal(error: unknown): unknown {
    const failure = error as { code?: string; constraint?: string; message?: string };
    if (failure.code === UNIQUE_VIOLATION && failure.constraint === 'contract_advance_tranche_uq') return invalid('tranche_no', 'TRANCHE_EXISTS');
    if (failure.code === CHECK_VIOLATION) {
      const message = failure.message ?? '';
      if (message.startsWith('ADVANCE_CONTRACT_NOT_EFFECTIVE')) return new DomainError('ADVANCE_CONTRACT_NOT_EFFECTIVE', 422, 'id');
      if (message.startsWith('ADVANCE_GUARANTEE_REQUIRED')) return new DomainError('ADVANCE_GUARANTEE_REQUIRED', 422, 'guarantee_id');
      if (message.startsWith('ADVANCE_STATE_INVALID')) return new DomainError('ADVANCE_STATE_INVALID', 409, 'id');
      if (failure.constraint === 'contract_advance_amounts_chk' || failure.constraint === 'contract_advance_order_chk') return new DomainError('ADVANCE_RECOVERY_EXCEEDED', 422, 'amount_vnd');
      if (failure.constraint === 'contract_advance_alert_ack_chk') return invalid('note');
      if (failure.constraint === 'contract_cash_out_chk') return new DomainError('VALUE_EXCEEDED', 409, 'amount_vnd', { extensions: { rule: 'contract_cash_out_chk' } });
    }
    return error;
  }
}
