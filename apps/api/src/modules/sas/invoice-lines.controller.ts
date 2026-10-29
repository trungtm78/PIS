import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { BillingStore, TenantDatabase } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { TenantContext } from '@machvon/kernel';
import type { Schemas } from '../../contract-types';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { invoiceLineView } from './invoice-view';

/**
 * The lines of the invoices of the caller's own tenant (ST-SAS-011): whoever holds `invoice_line.read` (the owner and the billing viewer) lists them and reads one. A line of another tenant is
 * indistinguishable from one that does not exist.
 */
@Controller('resources/invoice_line')
export class InvoiceLinesController {
  constructor(
    @Inject(BillingStore) private readonly store: BillingStore,
    @Inject(TenantDatabase) private readonly tenants: TenantDatabase,
  ) {}

  @Get()
  @OperationId('get_resources_invoice_line')
  async list(@CurrentTenant() tenant: TenantContext, @Query('limit') limit?: unknown, @Query('cursor') cursor?: unknown): Promise<{ items: Array<Schemas['InvoiceLine']>; next_cursor: string | null }> {
    const page = parsePageRequest(limit, cursor);
    const rows = await this.tenants.withTenant(tenant, (tx) => this.store.listLines(tx, { limit: page.limit + 1, after: page.after?.id }));
    const items = rows.slice(0, page.limit);
    const last = items[items.length - 1];
    return { items: items.map(invoiceLineView), next_cursor: rows.length > page.limit && last !== undefined ? encodeCursor({ code: last.id, id: last.id }) : null };
  }

  @Get(':id')
  @OperationId('get_resources_invoice_line_id')
  async get(@CurrentTenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<Schemas['InvoiceLine']> {
    const row = await this.tenants.withTenant(tenant, (tx) => this.store.findLine(tx, id));
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return invoiceLineView(row);
  }
}
