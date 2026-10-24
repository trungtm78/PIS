import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { PmtPermitTypeStore, TenantDatabase } from '@machvon/db';
import type { PermitTypeRow } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
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
import { holdsOnWholeTenant } from '../adm/tenant-authority';

const MANAGE_PERMISSION = PERMISSIONS.publishPermitType;
const TYPE_RESOURCE = 'permit_type';

/**
 * The permit type catalogue is the legal data of the whole tenant (PMT 2: the legal counsel or the business owner of the tenant), not
 * the data of one organisation unit, so only a grant on the whole tenant reaches it; a grant on a subtree does not.
 */
function assertManages(access: EffectiveAccess): void {
  if (!holdsOnWholeTenant(access, MANAGE_PERMISSION)) throw new DomainError('SCOPE_DENIED', 403);
}

/**
 * The permit type catalogue as dated legal data (ST-PMT-001, PMT 3.1, BR-PMT-03). A change of the regulation is a new revision that takes
 * over from a date; a version that a permit was written under never changes, it is only ended. Retiring needs no second person: the
 * catalogue is changed by the business owner and every change is audited with the legal basis it rests on.
 */
@Controller()
export class PermitTypeController {
  private readonly types = new PmtPermitTypeStore();

  @Post('permit-types')
  @HttpCode(200)
  @OperationId('publishPermitType')
  @Command({ operation: 'publishPermitType' })
  async publish(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['PmtPublishPermitType']): Promise<CommandResult> {
    assertManages(access);
    const published = await this.types.publish(
      scope.tx,
      {
        code: body.code,
        name: body.name,
        category: body.category,
        authorityText: body.authority_text,
        legalBasis: body.legal_basis,
        cxnRef: body.cxn_ref,
        effectiveFrom: body.effective_from,
        effectiveUntil: body.effective_until,
        appliesToRule: body.applies_to_rule,
        defaultValidityMonths: body.default_validity_months,
        defaultProcessingDays: body.default_processing_days,
        exemptionAllowed: body.exemption_allowed,
      },
      scope.tenant.membershipId,
    );
    const row = await this.types.find(scope.tx, published.id);
    await scope.audit({
      action: 'pmt.permit_type_published',
      resourceType: TYPE_RESOURCE,
      resourceId: published.id,
      diff: {
        code: row?.code,
        revision: published.revision,
        category: row?.category,
        legal_basis: row?.legalBasis,
        cxn_ref: row?.cxnRef ?? null,
        effective_from: row?.effectiveFrom,
        effective_until: row?.effectiveUntil ?? null,
        superseded_permit_type_id: published.supersededId,
      },
    });
    await scope.emit({
      aggregateType: TYPE_RESOURCE,
      aggregateId: published.id,
      aggregateVersion: published.version,
      type: 'pmt.permit_type.published.v1',
      schemaVersion: 1,
      payload: {
        permit_type_id: published.id,
        code: row?.code,
        revision: published.revision,
        effective_from: row?.effectiveFrom,
        effective_until: row?.effectiveUntil ?? null,
        awaiting_confirmation: row?.cxnRef !== null,
        superseded_permit_type_id: published.supersededId,
      },
      eventKey: `${TYPE_RESOURCE}:${published.id}:${published.version}`,
    });
    return commandResult(scope, 'PUBLISHED', published.version, published.id);
  }

  @Post('permit-types/:id/retire')
  @HttpCode(200)
  @OperationId('retirePermitType')
  @Command({ operation: 'retirePermitType' })
  async retire(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['PmtRetirePermitType'],
  ): Promise<CommandResult> {
    assertManages(access);
    const retired = await this.types.retire(scope.tx, id, body.effective_until, scope.tenant.membershipId);
    // Every command is audited, also the one that found the end already in place: who asked for it, and that nothing changed.
    await scope.audit({
      action: 'pmt.permit_type_retired',
      resourceType: TYPE_RESOURCE,
      resourceId: id,
      diff: {
        code: retired.row.code,
        revision: retired.row.revision,
        effective_until_before: retired.row.effectiveUntil,
        effective_until: body.effective_until,
        changed: retired.changed,
      },
    });
    if (retired.changed) {
      await scope.emit({
        aggregateType: TYPE_RESOURCE,
        aggregateId: id,
        aggregateVersion: retired.version,
        type: 'pmt.permit_type.retired.v1',
        schemaVersion: 1,
        payload: { permit_type_id: id, code: retired.row.code, revision: retired.row.revision, effective_until: body.effective_until },
        eventKey: `${TYPE_RESOURCE}:${id}:${retired.version}`,
      });
    }
    return commandResult(scope, 'RETIRED', retired.version, id);
  }
}

function typeViewOf(row: PermitTypeRow): Record<string, unknown> {
  return {
    id: row.id,
    code: row.code,
    revision: row.revision,
    name: row.name,
    category: row.category,
    authority_text: row.authorityText,
    legal_basis: row.legalBasis,
    cxn_ref: row.cxnRef,
    effective_from: row.effectiveFrom,
    effective_until: row.effectiveUntil,
    applies_to_rule: row.appliesToRule,
    default_validity_months: row.defaultValidityMonths,
    default_processing_days: row.defaultProcessingDays,
    exemption_allowed: row.exemptionAllowed,
    status: row.status,
    supersedes_id: row.supersedesId,
    version: row.version,
  };
}

/**
 * Reads of the catalogue (PMT-03). The catalogue is legal data of the whole tenant, not of one unit or project, so the permission
 * of the contract (`permit.read`, checked by the policy guard on the operation) is enough whatever the scope of the grant is: an auditor
 * or a project officer reads the same versions. Writing stays with `permit.catalogue.manage` on the whole tenant, so the legal
 * counsel holds both.
 */
@Controller()
export class PermitTypeReadsController {
  private readonly types = new PmtPermitTypeStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('resources/permit_type')
  @OperationId('get_resources_permit_type')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    const request = parsePageRequest(limit, cursor);
    const rows = await this.database.withTenant(tenant, (tx) => this.types.list(tx, {}, { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(typeViewOf),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAtKey, id: last.id }) : null,
    };
  }

  @Get('resources/permit_type/:id')
  @OperationId('get_resources_permit_type_id')
  async get(@CurrentTenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const row = await this.database.withTenant(tenant, (tx) => this.types.find(tx, id));
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return typeViewOf(row);
  }
}
