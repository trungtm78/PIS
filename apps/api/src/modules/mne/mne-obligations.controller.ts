import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { MNE_UNIT_COLUMNS, MneObligationStore, TenantDatabase, scopePredicate } from '@machvon/db';
import type { ScopeBuilder } from '@machvon/db';
import { DomainError, asUuid, isIsoDate, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { obligationViewOf } from './mne-views';

const RESOURCE_TYPE = 'mne_obligation_run';
const STATUSES: ReadonlySet<string> = new Set(['DRAFT', 'IN_REVIEW', 'APPROVED', 'ISSUING', 'ISSUED', 'EXPORTED', 'SUBMITTED_EXTERNAL', 'RETURNED', 'SUPERSEDED']);
const YEAR = /^[1-9][0-9]{3}$/;

/** The units a permission reaches, compiled over the unit columns of the obligation queries. */
const unitScope =
  (access: EffectiveAccess, permission: string, now: Date): ScopeBuilder =>
  (first) =>
    scopePredicate(access, permission, now, MNE_UNIT_COLUMNS, first);

function uuidFilter(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  const found = asUuid(value);
  if (found === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return found;
}

function yearFilter(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !YEAR.test(value)) throw new DomainError('VALIDATION_FAILED', 422, 'report_year');
  return Number(value);
}

function statusFilter(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !STATUSES.has(value)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
  return value;
}

/** The cursor of a page carries the due date of the last obligation on it (the ordering key, with its id). */
function anchorOf(cursor: ReturnType<typeof parsePageRequest>['after']): { dueDate: string; id: string } | undefined {
  if (cursor === undefined) return undefined;
  if (!isIsoDate(cursor.code)) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
  return { dueDate: cursor.code, id: cursor.id };
}

/**
 * The filing calendar (ST-MNE-001, MNE F2): `generateMneObligations` writes the report shells of a year from the rules in force and
 * runs again without adding anything; `listMneObligations` reads them in the scope of the caller, which is what MNE-01 and the
 * progress screen show. A unit the caller does not reach neither gets obligations from the caller nor shows in their calendar.
 */
@Controller()
export class MneObligationsController {
  private readonly obligations = new MneObligationStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Post('mne-obligations/generate')
  @HttpCode(200)
  @OperationId('generateMneObligations')
  @Command({ operation: 'generateMneObligations' })
  async generate(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Body() body: Schemas['MneObligationGenerate'],
  ): Promise<CommandResult & { created: number; existing: number; periods: number; unresolved_roles: string[] }> {
    const now = new Date();
    const result = await this.obligations.generate(scope.tx, {
      year: body.report_year,
      scopeUnitId: body.scope_unit_id,
      today: vietnamDateOf(now),
      actor: scope.tenant.membershipId,
      scope: unitScope(access, PERMISSIONS.generateMneObligations, now),
    });
    const runId = randomUUID();
    const summary = { report_year: body.report_year, scope_unit_id: body.scope_unit_id ?? null, created: result.created, existing: result.existing, periods: result.periods, unresolved_roles: result.unresolvedRoles };
    await scope.audit({ action: 'mne.obligations_generated', resourceType: RESOURCE_TYPE, resourceId: runId, diff: summary });
    // A run that wrote nothing changes nothing for anyone who listens: only the audit trail keeps it.
    if (result.created > 0) {
      await scope.emit({
        aggregateType: RESOURCE_TYPE,
        aggregateId: runId,
        aggregateVersion: 1,
        type: 'mne.obligations.generated.v1',
        schemaVersion: 1,
        payload: { run_id: runId, ...summary },
        eventKey: `${RESOURCE_TYPE}:${runId}`,
      });
    }
    return { ...commandResult(scope, 'GENERATED', 1, runId), created: result.created, existing: result.existing, periods: result.periods, unresolved_roles: result.unresolvedRoles };
  }

  @Get('mne-obligations')
  @OperationId('listMneObligations')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('report_year') reportYear?: unknown,
    @Query('scope_unit_id') scopeUnitId?: unknown,
    @Query('status') status?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    const filter = { reportYear: yearFilter(reportYear), scopeUnitId: uuidFilter(scopeUnitId, 'scope_unit_id'), status: statusFilter(status) };
    const after = anchorOf(request.after);
    const now = new Date();
    const today = vietnamDateOf(now);
    const rows = await this.database.withTenant(tenant, (tx) =>
      this.obligations.list(tx, filter, { limit: request.limit + 1, after }, unitScope(access, PERMISSIONS.listMneObligations, now), today),
    );
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(obligationViewOf),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.dueDate, id: last.id }) : null,
      as_of: today,
    };
  }
}
