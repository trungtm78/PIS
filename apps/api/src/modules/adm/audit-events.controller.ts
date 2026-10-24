import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { TenantDatabase, readSealCheck, scopePredicate } from '@machvon/db';
import type { SealCheck } from '@machvon/db';
import { DomainError, safeDiff } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { auditFilterSql, parseAuditFilter } from './audit-filters';
import { holdsOnWholeTenant } from './tenant-authority';

const READ_PERMISSION = PERMISSIONS.get_resources_audit_event;
const SEQ_PATTERN = /^[0-9]{1,18}$/;

interface AuditRow {
  id: string;
  seq: string;
  actor_id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  safe_diff: Record<string, unknown>;
  reason: string | null;
  correlation_id: string;
  request_id: string;
  outcome: string;
  classification: string;
  impersonator_id: string | null;
  on_behalf_of_id: string | null;
  occurred_at: string;
  seal_hash: string | null;
}

// An event belongs to the organisation unit of the member who acted: the unit path decides which scope reaches it.
// An event with no such member (a worker, the control plane) is visible to a grant on the whole tenant only.
const COLUMNS = `e.id, e.seq::text as seq, e.actor_id, e.action, e.resource_type, e.resource_id, e.safe_diff, e.reason,
  e.correlation_id, e.request_id, e.outcome, e.classification, e.impersonator_id, e.on_behalf_of_id,
  to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as occurred_at,
  (select s.seal_hash from machvon.audit_seal s where s.to_seq >= e.seq and s.from_seq <= e.seq order by s.to_seq limit 1) as seal_hash`;
const FROM = `machvon.audit_event e
  left join machvon.membership m on m.tenant_id = e.tenant_id and m.id = e.actor_id
  left join machvon.organization_unit ou on ou.tenant_id = m.tenant_id and ou.id = m.organization_id`;

/**
 * openapi.json audit_event DTO (ADM section 7): the stored diff is redacted again on the way out, so a sensitive value
 * never leaves even when a writer forgot to list its key; the identity behind an impersonation shows only to a caller
 * who reads the audit trail of the whole tenant; the network address hash is never returned. `seal_hash` is the seal that covers
 * the event, null while it waits for the next run of the sealer.
 */
function viewOf(row: AuditRow, mayReadImpersonation: boolean): Record<string, unknown> {
  return {
    id: row.id,
    seq: Number(row.seq),
    actor_id: row.actor_id,
    action: row.action,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    safe_diff: safeDiff(row.safe_diff),
    reason: row.reason,
    correlation_id: row.correlation_id,
    request_id: row.request_id,
    outcome: row.outcome,
    classification: row.classification,
    impersonator_id: mayReadImpersonation ? row.impersonator_id : null,
    on_behalf_of_id: row.on_behalf_of_id,
    occurred_at: row.occurred_at,
    seal_hash: row.seal_hash,
  };
}

/** The kept verdict of the seal verification, as the viewer's banner reads it (ADM-11). */
function sealViewOf(check: SealCheck): Record<string, unknown> {
  return {
    status: check.status,
    checked_at: check.checkedAt,
    seals: check.seals,
    broken: check.broken === null ? null : { seal_id: check.broken.sealId, from_seq: check.broken.fromSeq, to_seq: check.broken.toSeq, reason: check.broken.reason },
  };
}

/**
 * The audit trail, newest first, within the scope of the caller (ST-ADM-002, ADM-11), narrowed by the filters of ST-ADM-016
 * (actor_id, action, resource_type, resource_id, outcome, from, to) and with the kept verdict of the seal verification (`seal`).
 */
@Controller('resources/audit_event')
export class AuditEventsController {
  private readonly database: TenantDatabase;

  constructor(@Inject(TenantDatabase) database: TenantDatabase) {
    this.database = database;
  }

  @Get()
  @OperationId('get_resources_audit_event')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query() query: Record<string, unknown>,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; seal: Record<string, unknown> }> {
    const request = parsePageRequest(query.limit, query.cursor);
    // The cursor carries the seq of the last row: events come back by seq, newest first, and seq is unique.
    if (request.after !== undefined && !SEQ_PATTERN.test(request.after.code)) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
    // The filters (actor, action, resource, outcome, period) narrow what the scope already allows; they never widen it.
    const filter = auditFilterSql(parseAuditFilter(query), 3);
    const scope = scopePredicate(access, READ_PERMISSION, new Date(), { unitPath: 'ou.path', unitId: 'ou.id' }, 3 + filter.params.length);
    const { rows, check } = await this.database.withTenant(tenant, async (tx) => ({
      rows: await tx.query<AuditRow>(
        `select ${COLUMNS} from ${FROM}
          where ($1::bigint is null or e.seq < $1::bigint) and ${filter.sql} and ${scope.sql}
          order by e.seq desc
          limit $2`,
        [request.after?.code ?? null, request.limit + 1, ...filter.params, ...scope.params],
      ),
      check: await readSealCheck(tx),
    }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    const mayReadImpersonation = holdsOnWholeTenant(access, READ_PERMISSION);
    return {
      items: shown.map((row) => viewOf(row, mayReadImpersonation)),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.seq, id: last.id }) : null,
      seal: sealViewOf(check),
    };
  }

  @Get(':id')
  @OperationId('get_resources_audit_event_id')
  async get(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>> {
    const scope = scopePredicate(access, READ_PERMISSION, new Date(), { unitPath: 'ou.path', unitId: 'ou.id' }, 2);
    const rows = await this.database.withTenant(tenant, (tx) =>
      tx.query<AuditRow>(`select ${COLUMNS} from ${FROM} where e.id = $1::uuid and ${scope.sql}`, [id, ...scope.params]),
    );
    const row = rows[0];
    // An event in another tenant or outside the caller's scope is indistinguishable from one that does not exist.
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return viewOf(row, holdsOnWholeTenant(access, READ_PERMISSION));
  }
}
