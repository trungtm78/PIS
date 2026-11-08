import { Controller, Get, Inject, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { PayClockStore, TenantDatabase, contractScope } from '@machvon/db';
import type { ClockBoard, ClockRuleReading, PaymentClockRow, ReasonReading } from '@machvon/db';
import { DomainError, PAYMENT_CLOCK_KINDS, PAYMENT_CLOCK_STATES, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, PaymentClockKind, PaymentClockState, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

const rowView = (row: PaymentClockRow): Record<string, unknown> => ({
  id: row.id,
  payment_request_id: row.paymentRequestId,
  request_no: row.requestNo,
  request_status: row.requestStatus,
  net_vnd: row.netVnd,
  project: row.project,
  contract: row.contract,
  investor: row.investor,
  clock_kind: row.clockKind,
  attempt: row.attempt,
  started_at: row.startedAt,
  working_days: row.workingDays,
  policy_version: row.policyVersion,
  state: row.state,
  basis: row.basis,
  due_at: row.dueAt,
  working_minutes_left: row.workingMinutesLeft,
  working_minutes_late: row.workingMinutesLate,
  ended_at: row.endedAt,
  end_kind: row.endKind,
  return_reason_code: row.returnReasonCode,
  returned_by_treasury: row.returnedByTreasury,
});

const ruleView = (rule: ClockRuleReading): Record<string, unknown> => ({
  kind: rule.kind,
  working_days: rule.params.working_days,
  near_working_hours: rule.params.near_working_hours,
  reason_code_required: rule.params.reason_code_required,
  version: rule.version,
  source: rule.source,
  unverified: rule.unverified,
  provenance: rule.provenance === null ? null : { formula: rule.provenance.formula, source: rule.provenance.source, as_of: rule.provenance.asOf, legal_status: rule.provenance.legalStatus },
});

export function clockBoardView(board: ClockBoard, rules: readonly ClockRuleReading[], limit: number, now: Date): Record<string, unknown> {
  return {
    items: board.rows.slice(0, limit).map(rowView),
    summary: {
      total: board.summary.total,
      open: board.summary.open,
      breached: board.summary.breached,
      near: board.summary.near,
      in_time_rate_pct: board.summary.inTimeRatePct,
      returned: board.summary.returned,
      returns_by_reason: board.summary.returnsByReason.map((entry) => ({ reason_code: entry.reasonCode, count: entry.count })),
    },
    rules: rules.map(ruleView),
    truncated: board.truncated || board.rows.length > limit,
    calendar_found: board.calendarFound,
    calendar_unavailable: board.calendarUnavailable,
    as_of: now.toISOString(),
  };
}

const reasonView = (reason: ReasonReading): Record<string, unknown> => ({
  code: reason.code,
  category: reason.params.category,
  requires_note: reason.params.requires_note,
  owner_side: reason.params.owner_side,
  active: reason.params.active,
  version: reason.version,
  source: reason.source,
  unverified: reason.unverified,
});

/**
 * The clocks of the Treasury control (G1-17, PAY): a payment request has 2 working days from the complete dossier at the Treasury, an advance 1, counted on the published calendar; a request that was returned
 * names one of the standard reasons. The board is judged when it is read and never stored; a caller sees only the clocks of the contracts in their scope. The days and the reasons are rules of the tenant
 * (`PAYMENT_CLOCK`, `PAYMENT_RETURN_REASON`), labelled not confirmed until the tenant approves its own.
 */
@Controller()
export class PaymentClockReadsController {
  private readonly clocks = new PayClockStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('payment-clocks')
  @OperationId('listPaymentClocks')
  async board(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('state') state?: unknown,
    @Query('kind') kind?: unknown,
    @Query('unit_id') unitId?: unknown,
    @Query('from') from?: unknown,
    @Query('limit') limit?: unknown,
  ): Promise<Record<string, unknown>> {
    const now = new Date();
    if (state !== undefined && (typeof state !== 'string' || !(PAYMENT_CLOCK_STATES as readonly string[]).includes(state))) throw invalid('state');
    if (kind !== undefined && (typeof kind !== 'string' || !(PAYMENT_CLOCK_KINDS as readonly string[]).includes(kind))) throw invalid('kind');
    if (unitId !== undefined && (typeof unitId !== 'string' || !UUID.test(unitId))) throw invalid('unit_id');
    if (from !== undefined && (typeof from !== 'string' || !DAY.test(from) || Number.isNaN(Date.parse(`${from}T00:00:00Z`)))) throw invalid('from');
    let size = DEFAULT_LIMIT;
    if (limit !== undefined) {
      size = typeof limit === 'string' && /^\d{1,4}$/.test(limit) ? Number(limit) : 0;
      if (size < 1 || size > MAX_LIMIT) throw invalid('limit');
    }
    const scope = contractScope(access, PERMISSIONS.listPaymentClocks, now);
    return this.database.withTenant(tenant, async (tx) => {
      const board = await this.clocks.board(
        tx,
        scope,
        { state: state as PaymentClockState | undefined, kind: kind as PaymentClockKind | undefined, unitId: unitId === undefined ? undefined : (unitId as string).toLowerCase(), from: from as string | undefined },
        now,
      );
      const today = vietnamDateOf(now);
      const rules = await Promise.all(PAYMENT_CLOCK_KINDS.map((one) => this.clocks.rule(tx, one, today)));
      return clockBoardView(board, rules, size, now);
    });
  }

  @Get('payment-return-reasons')
  @OperationId('listPaymentReturnReasons')
  async reasons(@CurrentTenant() tenant: TenantContext): Promise<Record<string, unknown>> {
    const now = new Date();
    const today = vietnamDateOf(now);
    return this.database.withTenant(tenant, async (tx) => {
      const [reasons, rules] = await Promise.all([this.clocks.reasons(tx, today), this.clocks.returnRules(tx, today)]);
      return { items: reasons.map(reasonView), reason_code_required: rules.required.PAYMENT || rules.required.ADVANCE, as_of: today };
    });
  }
}
