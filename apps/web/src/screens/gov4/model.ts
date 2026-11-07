type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const strOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const bool = (value: unknown): boolean => value === true;
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const list = (value: unknown): Raw[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const rec = (value: unknown): Raw => (isRecord(value) ? value : {});

/** A whole amount of dong as the reader of the locale writes it; text that is not a whole amount is shown as it came (never turned into zero). */
export function vnd(value: string | null | undefined, locale: string): string {
  if (value === null || value === undefined || value === '') return '';
  if (!/^-?\d{1,24}$/.test(value)) return value;
  return new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'vi-VN').format(BigInt(value));
}

export interface AvcVerdict {
  state: string;
  reason: string | null;
  consumptionPct: string;
  usedVnd: string;
  availableVnd: string;
}

function toVerdict(raw: unknown): AvcVerdict | null {
  if (!isRecord(raw)) return null;
  return { state: str(raw.state), reason: strOrNull(raw.reason), consumptionPct: str(raw.consumption_pct), usedVnd: str(raw.used_vnd), availableVnd: str(raw.available_vnd) };
}

export interface ContractAvailability {
  contract: { id: string; code: string; status: string; projectId: string };
  money: {
    currentPriceVnd: string;
    originalPriceVnd: string;
    approvedVariationVnd: string;
    pendingIncreaseVnd: string;
    requestedTotalVnd: string;
    paidTotalVnd: string;
    advanceOutstandingVnd: string;
    cashOutVnd: string;
    remainingPayableVnd: string;
    cashHeadroomVnd: string;
    requestedPct: string | null;
    withinPrice: boolean;
  };
  line: { allocationLineId: string; allocatedVnd: string; reservedVnd: string; committedVnd: string; disbursedVnd: string; contractCommittedVnd: string; contractCommitsWithinLine: boolean; verdict: AvcVerdict | null } | null;
  changeOrders: Array<{ id: string; code: string | null; status: string; deltaVnd: string; verdict: AvcVerdict | null }>;
  asOf: string;
}

export function toContractAvailability(raw: unknown): ContractAvailability | undefined {
  if (!isRecord(raw) || !isRecord(raw.contract) || !isRecord(raw.money) || str(raw.contract.id) === '') return undefined;
  const money = raw.money;
  const line = isRecord(raw.line) ? raw.line : undefined;
  return {
    contract: { id: str(raw.contract.id), code: str(raw.contract.code), status: str(raw.contract.status), projectId: str(raw.contract.project_id) },
    money: {
      currentPriceVnd: str(money.current_price_vnd),
      originalPriceVnd: str(money.original_price_vnd),
      approvedVariationVnd: str(money.approved_variation_vnd),
      pendingIncreaseVnd: str(money.pending_increase_vnd),
      requestedTotalVnd: str(money.requested_total_vnd),
      paidTotalVnd: str(money.paid_total_vnd),
      advanceOutstandingVnd: str(money.advance_outstanding_vnd),
      cashOutVnd: str(money.cash_out_vnd),
      remainingPayableVnd: str(money.remaining_payable_vnd),
      cashHeadroomVnd: str(money.cash_headroom_vnd),
      requestedPct: strOrNull(money.requested_pct),
      withinPrice: bool(money.within_price),
    },
    line:
      line === undefined
        ? null
        : {
            allocationLineId: str(line.allocation_line_id),
            allocatedVnd: str(line.allocated_vnd),
            reservedVnd: str(line.reserved_vnd),
            committedVnd: str(line.committed_vnd),
            disbursedVnd: str(line.disbursed_vnd),
            contractCommittedVnd: str(line.contract_committed_vnd),
            contractCommitsWithinLine: bool(line.contract_commits_within_line),
            verdict: toVerdict(line.verdict),
          },
    changeOrders: list(raw.change_orders).map((change) => ({ id: str(change.id), code: strOrNull(change.code), status: str(change.status), deltaVnd: str(change.delta_vnd), verdict: toVerdict(change.verdict) })),
    asOf: str(raw.as_of),
  };
}

export interface EacControl {
  projectId: string;
  projectCode: string;
  eacVnd: string;
  approvedTotalVnd: string;
  verdict: 'WITHIN' | 'OVER';
  overByVnd: string;
  overPct: string | null;
  raisesAlert: boolean;
  allocatedVnd: string;
  fundingGapVnd: string;
  method: string;
  policy: { version: number | null; source: string; eacAlertAbovePct: string };
  asOf: string;
}

export function toEacControl(raw: unknown): EacControl | undefined {
  if (!isRecord(raw) || str(raw.project_id) === '') return undefined;
  const policy = rec(raw.policy);
  return {
    projectId: str(raw.project_id),
    projectCode: str(raw.project_code),
    eacVnd: str(raw.eac_vnd),
    approvedTotalVnd: str(raw.approved_total_vnd),
    verdict: raw.verdict === 'OVER' ? 'OVER' : 'WITHIN',
    overByVnd: str(raw.over_by_vnd),
    overPct: strOrNull(raw.over_pct),
    raisesAlert: bool(raw.raises_alert),
    allocatedVnd: str(raw.allocated_vnd),
    fundingGapVnd: str(raw.funding_gap_vnd),
    method: str(raw.method),
    policy: { version: typeof policy.version === 'number' ? policy.version : null, source: str(policy.source), eacAlertAbovePct: str(policy.eac_alert_above_pct) },
    asOf: str(raw.as_of),
  };
}

export interface ReserveEntry {
  id: string;
  entryKind: string;
  amountVnd: string;
  balanceAfterVnd: string;
  riskId: string | null;
  changeRequestId: string | null;
  reason: string;
  requestedBy: string;
  approvedBy: string | null;
  postedAt: string;
}

export interface OpenDrawdown {
  id: string;
  amountVnd: string;
  riskId: string | null;
  changeRequestId: string | null;
  reason: string;
  requestedBy: string;
  requestedAt: string;
  version: number;
}

export interface ReserveFund {
  id: string;
  kind: string;
  balanceVnd: string;
  entries: ReserveEntry[];
  openDrawdowns: OpenDrawdown[];
}

export interface ReserveRisk {
  id: string;
  code: string;
  title: string;
  status: string;
  probabilityPct: string | null;
  costImpactVnd: string | null;
  expectedValueVnd: string | null;
}

export interface ProjectReserve {
  projectId: string;
  projectCode: string;
  funds: ReserveFund[];
  risks: ReserveRisk[];
  expectedValueVnd: string;
  unassessedRiskCount: number;
  cover: { balanceVnd: string; expectedValueVnd: string; shortfallVnd: string; covered: boolean; coverPct: string | null } | null;
  policy: { version: number | null; source: string; coverAlertBelowPct: string };
  actions: { fund: boolean; requestDrawdown: boolean; decideDrawdown: boolean; setExposure: boolean };
  asOf: string;
}

export function toProjectReserve(raw: unknown): ProjectReserve | undefined {
  if (!isRecord(raw) || str(raw.project_id) === '') return undefined;
  const cover = isRecord(raw.contingency_cover) ? raw.contingency_cover : undefined;
  const policy = rec(raw.policy);
  const actions = rec(raw.actions);
  return {
    projectId: str(raw.project_id),
    projectCode: str(raw.project_code),
    funds: list(raw.funds).map((fund) => ({
      id: str(fund.id),
      kind: str(fund.kind),
      balanceVnd: str(fund.balance_vnd),
      entries: list(fund.entries).map((entry) => ({
        id: str(entry.id),
        entryKind: str(entry.entry_kind),
        amountVnd: str(entry.amount_vnd),
        balanceAfterVnd: str(entry.balance_after_vnd),
        riskId: strOrNull(entry.risk_id),
        changeRequestId: strOrNull(entry.change_request_id),
        reason: str(entry.reason),
        requestedBy: str(entry.requested_by),
        approvedBy: strOrNull(entry.approved_by),
        postedAt: str(entry.posted_at),
      })),
      openDrawdowns: list(fund.open_drawdowns).map((drawdown) => ({
        id: str(drawdown.id),
        amountVnd: str(drawdown.amount_vnd),
        riskId: strOrNull(drawdown.risk_id),
        changeRequestId: strOrNull(drawdown.change_request_id),
        reason: str(drawdown.reason),
        requestedBy: str(drawdown.requested_by),
        requestedAt: str(drawdown.requested_at),
        version: num(drawdown.version),
      })),
    })),
    risks: list(raw.risks).map((risk) => ({
      id: str(risk.id),
      code: str(risk.code),
      title: str(risk.title),
      status: str(risk.status),
      probabilityPct: strOrNull(risk.probability_pct),
      costImpactVnd: strOrNull(risk.cost_impact_vnd),
      expectedValueVnd: strOrNull(risk.expected_value_vnd),
    })),
    expectedValueVnd: str(raw.expected_value_vnd),
    unassessedRiskCount: num(raw.unassessed_risk_count),
    cover: cover === undefined ? null : { balanceVnd: str(cover.balance_vnd), expectedValueVnd: str(cover.expected_value_vnd), shortfallVnd: str(cover.shortfall_vnd), covered: bool(cover.covered), coverPct: strOrNull(cover.cover_pct) },
    policy: { version: typeof policy.version === 'number' ? policy.version : null, source: str(policy.source), coverAlertBelowPct: str(policy.cover_alert_below_pct) },
    actions: { fund: bool(actions.fund), requestDrawdown: bool(actions.request_drawdown), decideDrawdown: bool(actions.decide_drawdown), setExposure: bool(actions.set_exposure) },
    asOf: str(raw.as_of),
  };
}

export interface ChangeTier {
  changeId: string;
  code: string | null;
  stage: string;
  status: string;
  version: number;
  contractId: string;
  projectId: string;
  tier: 1 | 2 | 3;
  cumulativeAfterVnd: string;
  cumulativePct: string | null;
  forcesAdjustment: boolean;
  authorityAmountVnd: string;
  funding: { needsCover: boolean; covered: boolean; coveredBy: string | null; shortfallVnd: string; approvedDrawdownVnd: string; contingencyBalanceVnd: string | null };
  check: { id: string; status: string; cumulativePct: string; thresholdPct: string; basis: string | null; requiredAt: string; clearedAt: string | null; auditNotifiedAt: string | null } | null;
  policy: { version: number | null; source: string; projectAdjustmentPct: string; requireReserveCover: boolean };
  actions: { clearAdjustment: boolean };
  asOf: string;
}

export function toChangeTier(raw: unknown): ChangeTier | undefined {
  if (!isRecord(raw) || str(raw.change_id) === '') return undefined;
  const funding = rec(raw.funding);
  const check = isRecord(raw.check) ? raw.check : undefined;
  const policy = rec(raw.policy);
  const tier = raw.tier === 1 || raw.tier === 2 || raw.tier === 3 ? raw.tier : 3;
  return {
    changeId: str(raw.change_id),
    code: strOrNull(raw.code),
    stage: str(raw.stage),
    status: str(raw.status),
    version: num(raw.version),
    contractId: str(raw.contract_id),
    projectId: str(raw.project_id),
    tier,
    cumulativeAfterVnd: str(raw.cumulative_after_vnd),
    cumulativePct: strOrNull(raw.cumulative_pct),
    forcesAdjustment: bool(raw.forces_adjustment),
    authorityAmountVnd: str(raw.authority_amount_vnd),
    funding: {
      needsCover: bool(funding.needs_cover),
      covered: bool(funding.covered),
      coveredBy: strOrNull(funding.covered_by),
      shortfallVnd: str(funding.shortfall_vnd),
      approvedDrawdownVnd: str(funding.approved_drawdown_vnd),
      contingencyBalanceVnd: strOrNull(funding.contingency_balance_vnd),
    },
    check:
      check === undefined
        ? null
        : { id: str(check.id), status: str(check.status), cumulativePct: str(check.cumulative_pct), thresholdPct: str(check.threshold_pct), basis: strOrNull(check.basis), requiredAt: str(check.required_at), clearedAt: strOrNull(check.cleared_at), auditNotifiedAt: strOrNull(check.audit_notified_at) },
    policy: { version: typeof policy.version === 'number' ? policy.version : null, source: str(policy.source), projectAdjustmentPct: str(policy.project_adjustment_pct), requireReserveCover: bool(policy.require_reserve_cover) },
    actions: { clearAdjustment: bool(rec(raw.actions).clear_adjustment) },
    asOf: str(raw.as_of),
  };
}

export interface RecoveryRow {
  kind: 'ACTUAL' | 'PLANNED';
  requestNo: string | null;
  on: string | null;
  atPct: number | null;
  grossCumVnd: string;
  plannedRecoveredVnd: string;
  actualRecoveredVnd: string | null;
  behindVnd: string | null;
}

export interface AdvancePosition {
  contractId: string;
  contractCode: string;
  outstandingVnd: string;
  remainingPayableVnd: string;
  exceedsRemaining: boolean;
  unrecoverableVnd: string;
  finalPaymentRequiresFullRecovery: boolean;
  policy: { version: number | null; source: string; toleranceVnd: string };
}

export interface RecoveryTable {
  advance: { id: string; status: string; kind: string; trancheNo: number; contractCode: string; partyName: string | null; paidVnd: string; recoveredVnd: string; outstandingVnd: string; thresholdPct: string; awaitingConfirmation: boolean; cxn: string | null };
  rows: RecoveryRow[];
  position: AdvancePosition;
  asOf: string;
}

function toPosition(raw: Raw): AdvancePosition {
  const policy = rec(raw.policy);
  return {
    contractId: str(raw.contract_id),
    contractCode: str(raw.contract_code),
    outstandingVnd: str(raw.outstanding_vnd),
    remainingPayableVnd: str(raw.remaining_payable_vnd),
    exceedsRemaining: bool(raw.exceeds_remaining),
    unrecoverableVnd: str(raw.unrecoverable_vnd),
    finalPaymentRequiresFullRecovery: bool(raw.final_payment_requires_full_recovery),
    policy: { version: typeof policy.version === 'number' ? policy.version : null, source: str(policy.source), toleranceVnd: str(policy.tolerance_vnd) },
  };
}

export const toAdvancePosition = (raw: unknown): AdvancePosition | undefined => (isRecord(raw) && str(raw.contract_id) !== '' ? toPosition(raw) : undefined);

export function toRecoveryTable(raw: unknown): RecoveryTable | undefined {
  if (!isRecord(raw) || !isRecord(raw.advance) || !isRecord(raw.position)) return undefined;
  const advance = raw.advance;
  const contract = rec(advance.contract);
  const party = rec(advance.party);
  return {
    advance: {
      id: str(advance.id),
      status: str(advance.status),
      kind: str(advance.kind),
      trancheNo: num(advance.tranche_no),
      contractCode: str(contract.code),
      partyName: strOrNull(party.name),
      paidVnd: str(advance.paid_vnd),
      recoveredVnd: str(advance.recovered_vnd),
      outstandingVnd: str(advance.outstanding_vnd),
      thresholdPct: str(advance.recovery_threshold_pct),
      awaitingConfirmation: bool(advance.cap_rule_awaiting_confirmation),
      cxn: strOrNull(advance.cap_rule_cxn),
    },
    rows: list(raw.rows).map((row) => ({
      kind: row.kind === 'PLANNED' ? 'PLANNED' : 'ACTUAL',
      requestNo: strOrNull(row.request_no),
      on: strOrNull(row.on),
      atPct: typeof row.at_pct === 'number' ? row.at_pct : null,
      grossCumVnd: str(row.gross_cum_vnd),
      plannedRecoveredVnd: str(row.planned_recovered_vnd),
      actualRecoveredVnd: strOrNull(row.actual_recovered_vnd),
      behindVnd: strOrNull(row.behind_vnd),
    })),
    position: toPosition(raw.position),
    asOf: str(raw.as_of),
  };
}

export interface AdvancePolicyVersion {
  versionId: string;
  advanceCategory: string;
  revision: number;
  validFrom: string;
  validUntil: string | null;
  inForce: boolean;
  legalBasis: string;
  awaitingConfirmation: boolean;
  cxn: string | null;
  recoveryThresholdPct: string | null;
  tiers: Array<{ minValueVnd: string; capPct: string }>;
}

export function toAdvancePolicy(raw: unknown): AdvancePolicyVersion[] {
  if (!isRecord(raw)) return [];
  return list(raw.items).map((item) => ({
    versionId: str(item.version_id),
    advanceCategory: str(item.advance_category),
    revision: num(item.revision),
    validFrom: str(item.valid_from),
    validUntil: strOrNull(item.valid_until),
    inForce: bool(item.in_force),
    legalBasis: str(item.legal_basis),
    awaitingConfirmation: bool(item.awaiting_confirmation),
    cxn: strOrNull(item.cxn),
    recoveryThresholdPct: strOrNull(item.recovery_threshold_pct),
    tiers: list(item.tiers).map((tier) => ({ minValueVnd: str(tier.min_value_vnd), capPct: str(tier.cap_pct) })),
  }));
}

/** The day and the hour of a time the server gave, as the reader writes it; text that is not a time is shown as it came. */
export function asOfText(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  return match === null ? value : `${match[4]}:${match[5]} ${match[3]}/${match[2]}/${match[1]}`;
}

/** The id the address names, when it is the shape of one. */
export function idFrom(value: string | null): string | undefined {
  return value !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : undefined;
}
