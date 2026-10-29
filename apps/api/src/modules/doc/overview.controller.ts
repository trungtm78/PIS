import { Controller, Get, Inject, Optional } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DocIncomingStore, DocumentTemplateStore, OUTGOING_SCOPE_COLUMNS, OutgoingDocumentStore, TenantDatabase, scopePredicate } from '@machvon/db';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsAnywhere, incomingScope } from './incoming.controller';
import { DOC_CLOCK } from './tokens';

/** The queues of the outgoing documents the overview counts, and the state each one stands for (DOC.md state table). */
const OUTGOING_QUEUES = [
  { key: 'drafts_in_review', status: 'IN_REVIEW' },
  { key: 'awaiting_leader_signature', status: 'SUBMITTED' },
  { key: 'awaiting_number', status: 'SIGNED' },
  { key: 'awaiting_seal', status: 'NUMBERED' },
] as const;

interface Tile {
  key: string;
  /** The number of documents in the queue in the scope of the caller, or none when the caller may not read that kind of document: a figure that cannot be given is never shown as 0. */
  count: number | null;
}

/**
 * The overview of the documents (ST-DOC-014, DOC-01): how many documents wait in each queue, counted over what the caller may read. Each tile is judged by the right to read its own kind of document, so a person who may read
 * the incoming register and not the outgoing documents sees the one and not the other; the figure is counted in the database in the same scope as the list it leads to, at the moment named in `as_of`.
 */
@Controller()
export class DocumentOverviewController {
  private readonly outgoing = new OutgoingDocumentStore();
  private readonly incoming = new DocIncomingStore();
  private readonly templates = new DocumentTemplateStore();
  private readonly clock: () => Date;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(DOC_CLOCK) clock?: () => Date,
  ) {
    this.clock = clock ?? ((): Date => new Date());
  }

  @Get('document-overview')
  @OperationId('getDocumentOverview')
  async overview(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<{ as_of: string; tiles: Tile[] }> {
    const now = this.clock();
    const outgoingScope = (first: number) => scopePredicate(access, PERMISSIONS.getOutgoingDocument, now, OUTGOING_SCOPE_COLUMNS, first);
    const mayReadOutgoing = outgoingScope(1).sql !== 'false';
    const mayReadIncoming = holdsAnywhere(access, PERMISSIONS.getIncomingDocument, now);
    const mayReadTemplates = holdsAnywhere(access, PERMISSIONS.getDocumentTemplate, now);
    return this.database.withTenant(tenant, async (tx) => {
      const queued = mayReadOutgoing ? await this.outgoing.countByStatus(tx, OUTGOING_QUEUES.map((queue) => queue.status), outgoingScope) : undefined;
      const overdue = mayReadIncoming ? await this.incoming.countOverdue(tx, incomingScope(access, PERMISSIONS.getIncomingDocument, now, tenant.membershipId)) : null;
      const unconfirmed = mayReadTemplates ? await this.templates.countPendingConfirmation(tx) : null;
      return {
        as_of: now.toISOString(),
        tiles: [
          ...OUTGOING_QUEUES.map((queue): Tile => ({ key: queue.key, count: queued === undefined ? null : (queued[queue.status] ?? 0) })),
          { key: 'overdue_incoming', count: overdue },
          // The interoperability with other systems is not built yet (ST-DOC-021): there is nothing that can have failed.
          { key: 'interop_errors', count: 0 },
          { key: 'templates_pending_confirmation', count: unconfirmed },
        ],
      };
    });
  }
}
