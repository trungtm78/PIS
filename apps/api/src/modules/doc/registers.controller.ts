import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DocumentStore, NumberRegisterStore, REGISTER_SCOPE_COLUMNS, TenantDatabase, scopePredicate } from '@machvon/db';
import type { RegisterDirection, RegisterEntry, RegisterRecord } from '@machvon/db';
import { DomainError, formatRegisterNumber } from '@machvon/kernel';
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
import { docTypeViews } from './documents.controller';
import { mayActOnUnit } from './unit-scope';

const MANAGE_PERMISSION = PERMISSIONS.openDocumentNumberRegister;
const READ_PERMISSION = PERMISSIONS.listDocumentNumberRegisters;
const RESOURCE_TYPE = 'document_number_register';
const FIRST_YEAR = 2000;
const LAST_YEAR = 2200;
const YEAR_TEXT = /^[0-9]{4}$/;
const DIRECTIONS: readonly string[] = ['OUTGOING', 'INCOMING'];
const NUMBER_CURSOR = /^[0-9]{1,9}$/;

function registerView(row: RegisterRecord): Record<string, unknown> {
  return {
    id: row.id,
    register_code: row.registerCode,
    name: row.name,
    direction: row.direction,
    organization_unit_id: row.organizationUnitId,
    year: row.year,
    mode: row.mode,
    last_number: row.lastNumber,
    next_number: row.lastNumber + 1,
    status: row.status,
    closed_at: row.closedAt === null ? null : row.closedAt.toISOString(),
    scope_doc_types: row.scopeDocTypes,
    version: row.version,
  };
}

/** openapi.json DocRegisterEntry (+ the display form of the number, BR-DOC-06: two digits below ten). */
function entryView(row: RegisterEntry): Record<string, unknown> {
  return {
    allocation_id: row.allocationId,
    number: row.number,
    display_number: formatRegisterNumber(row.number),
    symbol: row.symbol,
    document_id: row.documentId,
    issued_on: row.issuedOn,
    title: row.title,
    status: row.status,
  };
}

function yearFilter(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !YEAR_TEXT.test(value)) throw new DomainError('VALIDATION_FAILED', 422, 'year');
  return Number(value);
}

function directionFilter(value: unknown): RegisterDirection | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !DIRECTIONS.includes(value)) throw new DomainError('VALIDATION_FAILED', 422, 'direction');
  return value as RegisterDirection;
}

/**
 * Number registers (ST-DOC-002, BR-DOC-02 to BR-DOC-06): one register per code, organisation unit and year. Reads and
 * commands are scoped to the organisation unit of the register; a register out of scope does not exist for the caller.
 */
@Controller()
export class RegistersController {
  private readonly registers = new NumberRegisterStore();
  private readonly documents = new DocumentStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Post('document-number-registers')
  @HttpCode(200)
  @OperationId('openDocumentNumberRegister')
  @Command({ operation: 'openDocumentNumberRegister' })
  async open(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['DocRegisterOpen']): Promise<CommandResult> {
    if (body.year < FIRST_YEAR || body.year > LAST_YEAR) throw new DomainError('VALIDATION_FAILED', 422, 'year');
    const unit = await this.registers.unitRef(scope.tx, body.organization_unit_id);
    if (unit === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'organization_unit_id');
    if (!mayActOnUnit(access, MANAGE_PERMISSION, unit, new Date())) throw new DomainError('SCOPE_DENIED', 403);
    const register = await this.registers.openRegister(scope.tx, {
      registerCode: body.register_code,
      name: body.name,
      direction: body.direction,
      organizationUnitId: body.organization_unit_id,
      year: body.year,
      mode: body.mode ?? 'MANAGED',
      scopeDocTypes: [...new Set(body.scope_doc_types)],
      actor: scope.tenant.membershipId,
    });
    await scope.audit({
      action: 'document_number_register.open',
      resourceType: RESOURCE_TYPE,
      resourceId: register.id,
      diff: { register_code: register.registerCode, direction: register.direction, organization_unit_id: register.organizationUnitId, year: register.year, mode: register.mode },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: register.id,
      aggregateVersion: register.version,
      type: 'doc.register_opened.v1',
      schemaVersion: 1,
      payload: { register_id: register.id, register_code: register.registerCode, direction: register.direction, year: register.year },
      eventKey: `${RESOURCE_TYPE}:${register.id}:${register.version}`,
    });
    return commandResult(scope, 'OPEN', register.version, register.id);
  }

  @Post('document-number-registers/:id/closure')
  @HttpCode(200)
  @OperationId('closeDocumentNumberRegister')
  @Command({ operation: 'closeDocumentNumberRegister', versioned: true })
  async close(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['DocRegisterClose'],
  ): Promise<CommandResult> {
    const now = new Date();
    const visible = await this.registers.findRegister(scope.tx, id, (first) => scopePredicate(access, MANAGE_PERMISSION, now, REGISTER_SCOPE_COLUMNS, first));
    if (visible === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const closed = await this.registers.closeRegister(scope.tx, id, { expectedVersion: scope.expectedVersion ?? 0, reason: body.reason, actor: scope.tenant.membershipId });
    await scope.audit({
      action: 'document_number_register.close',
      resourceType: RESOURCE_TYPE,
      resourceId: id,
      reason: body.reason,
      diff: { register_code: closed.registerCode, year: closed.year, last_number: closed.lastNumber },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: id,
      aggregateVersion: closed.version,
      type: 'doc.register_closed.v1',
      schemaVersion: 1,
      payload: { register_id: id, register_code: closed.registerCode, year: closed.year, last_number: closed.lastNumber },
      eventKey: `${RESOURCE_TYPE}:${id}:${closed.version}`,
    });
    return commandResult(scope, 'CLOSED', closed.version, id);
  }

  /**
   * The registers the caller may read and, next to them, the document types of the tenant: the configuration screen
   * (DOC-21) needs both and the design has no list operation for types (recorded as a design gap).
   */
  @Get('document-number-registers')
  @OperationId('listDocumentNumberRegisters')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('year') year?: unknown,
    @Query('direction') direction?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; doc_types: Array<Record<string, unknown>> }> {
    const request = parsePageRequest(limit, cursor);
    const filters = { year: yearFilter(year), direction: directionFilter(direction) };
    const now = new Date();
    return this.database.withTenant(tenant, async (tx) => {
      const rows = await this.registers.listRegisters(
        tx,
        { ...filters, limit: request.limit + 1, after: request.after === undefined ? undefined : { code: request.after.code, id: request.after.id } },
        (first) => scopePredicate(access, READ_PERMISSION, now, REGISTER_SCOPE_COLUMNS, first),
      );
      const shown = rows.slice(0, request.limit);
      const last = shown[shown.length - 1];
      return {
        items: shown.map(registerView),
        next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.registerCode, id: last.id }) : null,
        doc_types: docTypeViews(await this.documents.listDocTypes(tx)),
      };
    });
  }

  @Get('document-number-registers/:id/entries')
  @OperationId('listDocumentRegisterEntries')
  async entries(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ register: Record<string, unknown>; items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    const request = parsePageRequest(limit, cursor);
    if (request.after !== undefined && !NUMBER_CURSOR.test(request.after.code)) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
    const afterNumber = request.after === undefined ? undefined : Number(request.after.code);
    const now = new Date();
    return this.database.withTenant(tenant, async (tx) => {
      const register = await this.registers.findRegister(tx, id, (first) => scopePredicate(access, READ_PERMISSION, now, REGISTER_SCOPE_COLUMNS, first));
      if (register === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const rows = await this.registers.listEntries(tx, id, { limit: request.limit + 1, afterNumber });
      const shown = rows.slice(0, request.limit);
      const last = shown[shown.length - 1];
      return {
        register: registerView(register),
        items: shown.map(entryView),
        next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: String(last.number), id: last.allocationId }) : null,
      };
    });
  }
}
