import { Controller, Get, Inject, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { CapLedgerReads, TenantDatabase, projectScope } from '@machvon/db';
import type { CapitalLedgerEntry, CapitalLedgerFilter } from '@machvon/db';
import { DomainError, asUuid, isCalendarDate } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';

const PERMISSION = PERMISSIONS.listCapitalLedger;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
/** The end of a day in Vietnam (UTC+7): a day typed without a time means everything posted up to its last moment. */
const END_OF_DAY = 'T23:59:59.999999+07:00';

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

function queryId(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  const id = typeof value === 'string' ? asUuid(value) : undefined;
  if (id === undefined) throw invalid(name);
  return id;
}

/** The moment `at` names: a day (up to the end of it in Vietnam) or an instant with its zone; anything else is a fault of the request. */
export function momentOf(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalid('at');
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    if (!isCalendarDate(value)) throw invalid('at');
    return `${value}${END_OF_DAY}`;
  }
  if (!isInstant(value)) throw invalid('at');
  return value;
}

/** An instant with its zone whose day exists: the engine reads 30 February as March, the database refuses it. */
const isInstant = (value: string, pattern: RegExp = INSTANT): boolean => pattern.test(value) && isCalendarDate(value.slice(0, 10)) && !Number.isNaN(Date.parse(value));

/** The entry as the contract exposes it: an allowlist. */
export function ledgerEntryView(line: CapitalLedgerEntry): Record<string, unknown> {
  return {
    id: line.id,
    entry_type: line.entryType,
    amount_vnd: line.amountVnd,
    plan_year: line.planYear,
    appropriation_id: line.appropriationId,
    allocation_line_id: line.allocationLineId,
    project: line.project,
    source_ref_kind: line.sourceRefKind,
    source_ref_id: line.sourceRefId,
    reversal_of_id: line.reversalOfId,
    reason: line.reason,
    posted_at: line.postedAt,
    posted_by: { membership_id: line.postedBy.membershipId, display_name: line.postedBy.displayName },
  };
}

/**
 * The capital ledger (ST-CAP-014, CAP 3.4, CAP-21), read from one snapshot so that the entries, the balance and the page that follows describe the same state: the entries of the append-only ledger, newest first, and the balance they add up to at a chosen moment, so that every balance can be traced to entries. An
 * entry of a project is read in the scope of the caller over the project; an entry that belongs to no project only by someone who holds the right on the whole tenant. There is no command here.
 */
@Controller()
export class CapitalLedgerController {
  private readonly ledger = new CapLedgerReads();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('capital-ledger')
  @OperationId('listCapitalLedger')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('appropriation_id') appropriationId?: unknown,
    @Query('allocation_line_id') allocationLineId?: unknown,
    @Query('project_id') projectId?: unknown,
    @Query('at') at?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<Record<string, unknown>> {
    const request = parsePageRequest(limit, cursor);
    if (request.after !== undefined && !isInstant(request.after.code, TIMESTAMP)) throw invalid('cursor');
    const filter: CapitalLedgerFilter = {
      appropriationId: queryId(appropriationId, 'appropriation_id'),
      allocationLineId: queryId(allocationLineId, 'allocation_line_id'),
      projectId: queryId(projectId, 'project_id'),
      at: momentOf(at),
    };
    const now = new Date();
    const page = await this.database.withSnapshot(tenant, (tx) =>
      this.ledger.list(tx, filter, { projects: projectScope(access, PERMISSION, now), wholeTenant: holdsOnWholeTenant(access, PERMISSION) }, {
        limit: request.limit + 1,
        after: request.after === undefined ? undefined : { postedAt: request.after.code, id: request.after.id },
      }),
    );
    const shown = page.lines.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(ledgerEntryView),
      next_cursor: page.lines.length > request.limit && last !== undefined ? encodeCursor({ code: last.postedAt, id: last.id }) : null,
      balance: {
        appropriated_vnd: page.balance.appropriated,
        allocated_vnd: page.balance.allocated,
        reserved_vnd: page.balance.reserved,
        committed_vnd: page.balance.committed,
        disbursed_vnd: page.balance.disbursed,
      },
      entry_count: page.entryCount,
      as_of: page.asOf,
    };
  }
}
