import { Controller, Get, Inject, Query } from '@nestjs/common';
import { IssSlaPolicyStore, SLA_SEVERITIES, TenantDatabase } from '@machvon/db';
import type { SlaPolicyRow, SlaPolicyStatus, SlaSeverity } from '@machvon/db';
import { DomainError, asUuid } from '@machvon/kernel';
import type { TenantContext } from '@machvon/kernel';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';

const STATUSES: ReadonlySet<string> = new Set(['DRAFT', 'ACTIVE', 'RETIRED']);
const SEVERITIES: ReadonlySet<string> = new Set(SLA_SEVERITIES);
const MAX_TEXT = 100;

/** A short text of a query parameter: absent stays absent, empty or long or holding a NUL is 422 naming the parameter. */
function textOf(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '' || value.length > MAX_TEXT || value.includes('\0')) throw new DomainError('VALIDATION_FAILED', 422, name);
  return value;
}

function uuidOf(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  const found = asUuid(value);
  if (found === undefined) throw new DomainError('VALIDATION_FAILED', 422, name);
  return found;
}

function choiceOf<Value extends string>(value: unknown, name: string, allowed: ReadonlySet<string>): Value | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.has(value)) throw new DomainError('VALIDATION_FAILED', 422, name);
  return value as Value;
}

export function policyViewOf(row: SlaPolicyRow): Record<string, unknown> {
  return {
    id: row.id,
    code: row.code,
    revision: row.revision,
    category_version_id: row.categoryVersionId,
    category_record_id: row.categoryRecordId,
    category_key: row.categoryKey,
    category_label: row.categoryLabel,
    severity: row.severity,
    owner_unit_id: row.ownerUnitId,
    calendar_code: row.calendarCode,
    response_hours: row.responseHours,
    resolve_hours: row.resolveHours,
    escalate_l2_pct: row.escalateL2Pct,
    escalate_l3_pct: row.escalateL3Pct,
    require_independent_verifier: row.requireIndependentVerifier,
    require_evidence: row.requireEvidence,
    valid_from: row.validFrom,
    valid_until: row.validUntil,
    status: row.status,
    version: row.version,
  };
}

/** The read of the SLA policies for ISS-09: every version of the tenant, the newest first, with the category it is written for. */
@Controller()
export class IssSlaPolicyReadsController {
  private readonly policies = new IssSlaPolicyStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('issue-sla-policies')
  @OperationId('listIssueSlaPolicies')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query('category_record_id') categoryRecordId?: unknown,
    @Query('code') code?: unknown,
    @Query('severity') severity?: unknown,
    @Query('owner_unit_id') ownerUnitId?: unknown,
    @Query('status') status?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    const request = parsePageRequest(limit, cursor);
    const filter = {
      categoryRecordId: uuidOf(categoryRecordId, 'category_record_id'),
      code: textOf(code, 'code'),
      severity: choiceOf<SlaSeverity>(severity, 'severity', SEVERITIES),
      ownerUnitId: uuidOf(ownerUnitId, 'owner_unit_id'),
      status: choiceOf<SlaPolicyStatus>(status, 'status', STATUSES),
    };
    const rows = await this.database.withTenant(tenant, (tx) => this.policies.list(tx, filter, { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(policyViewOf),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAtKey, id: last.id }) : null,
    };
  }
}
