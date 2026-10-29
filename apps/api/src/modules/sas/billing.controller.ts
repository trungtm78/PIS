import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { BillingPaymentStore, BillingStore, ControlDatabase, EINVOICE_PROVIDER, actingAsTenant, tenantOfInvoice } from '@machvon/db';
import type { ApprovalEffects, EInvoiceProviderPort } from '@machvon/db';
import { DomainError, addDays, isBillingPeriod, vietnamDateOf } from '@machvon/kernel';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import { Command, Scope } from '../../command.decorator';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { invoiceView } from './invoice-view';

/**
 * The billing run and the e-invoice on the control plane (ST-SAS-011, SAS-09, SAS.md 3.7): a System Admin or a Billing Operator runs the billing for a period and issues the Draft invoices through
 * the port of the provider. The commands act as the tenant of the invoice while they write, audit and emit, so every row belongs to that tenant. There is no command that cancels an invoice,
 * and the contract has none: a mistake after the issue is an adjustment or a replacement (SAS-24).
 */
@Controller('system')
export class BillingController {
  private readonly payments = new BillingPaymentStore();

  constructor(
    @Inject(BillingStore) private readonly store: BillingStore,
    @Inject(ControlDatabase) private readonly control: ControlDatabase,
    @Inject(EINVOICE_PROVIDER) private readonly provider: EInvoiceProviderPort,
  ) {}

  @Get('tenants/:tenantId/invoices')
  @OperationId('listTenantInvoices')
  async ofTenant(@Param('tenantId', ParseUUIDPipe) tenantId: string, @Query('limit') limit?: unknown, @Query('cursor') cursor?: unknown): Promise<Schemas['TenantInvoices']> {
    const page = parsePageRequest(limit, cursor);
    // The cursor of this list is a period and an id: a text that is not a calendar day never reaches the query.
    if (page.after !== undefined) {
      try {
        addDays(page.after.code, 0);
      } catch {
        throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
      }
    }
    const known = await this.control.withControl((tx) => tx.query<{ id: string }>('select id from machvon.tenant where id = $1::uuid', [tenantId]));
    if (known.length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return this.control.withTenantOf(tenantId, async (tx) => {
      const rows = await this.store.list(tx, { limit: page.limit + 1, after: page.after === undefined ? undefined : { periodStart: page.after.code, id: page.after.id } });
      const shown = rows.slice(0, page.limit);
      const last = shown[shown.length - 1];
      const [lines, state, paid] = [await this.store.linesOf(tx, shown.map((row) => row.id)), await this.store.subscriptionState(tx), await this.payments.ofInvoices(tx, shown.map((row) => row.id))];
      return {
        items: shown.map((row) => invoiceView(row, lines.filter((line) => line.invoiceId === row.id), paid.filter((payment) => payment.invoiceId === row.id))),
        next_cursor: rows.length > page.limit && last !== undefined ? encodeCursor({ code: last.periodStart, id: last.id }) : null,
        ...(state === undefined ? {} : { subscription_status: state.status }),
        ...(state?.pastDueSince == null ? {} : { past_due_since: state.pastDueSince.toISOString() }),
        ...(state?.suspensionProposedAt == null ? {} : { suspension_proposed_at: state.suspensionProposedAt.toISOString() }),
      };
    });
  }

  /**
   * Makes the Draft original invoices of the period for the tenants named (all the Active ones when none is): one for each subscription whose billing period is exactly that one, however many times it is
   * asked (BR-SAS-13). The work is done in the command, tenant by tenant; the invoices wait as Drafts for `issueEInvoice`.
   */
  @Post('billing-runs')
  @HttpCode(202)
  @OperationId('runBillingCycle')
  @Command({ operation: 'runBillingCycle', plane: 'control' })
  async run(@Scope() scope: CommandScope, @Body() body: Schemas['BillingRunRequest']): Promise<CommandResult> {
    const today = vietnamDateOf(new Date());
    const period = { start: body.period_start, end: body.period_end };
    if (!isBillingPeriod(period, today)) throw new DomainError('BILLING_PERIOD_INVALID', 422, 'period_start');
    const tenantIds = body.tenant_ids ?? (await scope.tx.query<{ id: string }>("select id from machvon.tenant where status = 'Active' order by id")).map((row) => row.id);
    let created = 0;
    let existing = 0;
    for (const tenantId of [...new Set(tenantIds)]) {
      const result = await actingAsTenant(scope.tx, tenantId, scope.tenant.tenantId, () => this.store.runPeriod(scope.tx, this.effectsOf(scope), period, today));
      created += result.created.length;
      existing += result.existing.length;
    }
    await scope.audit({ action: 'billing.run_started', resourceType: 'billing_run', resourceId: scope.requestId, diff: { period_start: period.start, period_end: period.end, tenants: tenantIds.length, created, existing } });
    return commandResult(scope, 'BILLED', 1, scope.requestId);
  }

  /**
   * Sends a Draft (or an invoice that could not be issued, again) to the provider. The first attempt is made now; a provider that does not answer leaves the invoice PendingIssue and the worker asks
   * again for a day. An invoice that is anything else is 409 EINVOICE_STATE_INVALID, so a second issue of one that went out is refused.
   */
  @Post('invoices/:invoiceId/issue')
  @HttpCode(202)
  @OperationId('issueEInvoice')
  @Command({ operation: 'issueEInvoice', plane: 'control', versioned: true })
  async issue(@Scope() scope: CommandScope, @Param('invoiceId', ParseUUIDPipe) invoiceId: string, @Body() body: Schemas['ReasonOnly']): Promise<CommandResult> {
    const tenantId = await tenantOfInvoice(scope.tx, invoiceId);
    if (tenantId === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return actingAsTenant(scope.tx, tenantId, scope.tenant.tenantId, async () => {
      const { invoice, outcome } = await this.store.issue(scope.tx, this.effectsOf(scope), this.provider, invoiceId, scope.expectedVersion ?? undefined, new Date());
      await scope.audit({ action: 'einvoice.issue_requested', resourceType: 'invoice', resourceId: invoiceId, reason: body.reason, diff: { outcome, attempts: invoice.issueAttempts } });
      return commandResult(scope, outcome === 'ISSUED' ? 'ISSUED' : outcome === 'PENDING' ? 'PENDING_ISSUE' : 'ISSUE_FAILED', invoice.version, invoiceId);
    });
  }

  private effectsOf(scope: CommandScope): ApprovalEffects {
    return { actor: scope.tenant.membershipId, audit: (entry) => scope.audit(entry), emit: (event) => scope.emit(event) };
  }
}
