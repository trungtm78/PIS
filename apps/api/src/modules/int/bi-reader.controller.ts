import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BiReaderStore, BidWorkflowReads, ExportDatasetStore, TenantDatabase } from '@machvon/db';
import { BI_READER_STATUSES, DomainError, OPEN_DATASET_DEFINITIONS, OPEN_DATASETS, biReaderRequestOf, egpReasonOf, generateBiPassword, isBiReaderMove, scramVerifierOf } from '@machvon/kernel';
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
import { biReaderDto, biReaderEventDto, nameLookup } from './int-view';
import { queryText } from './machine-account.controller';

const READER_RESOURCE = 'int_bi_reader';
const CLASSIFICATION = 'CONFIDENTIAL';
/** The schema the views live in: a BI tool is pointed at it (the search path of every login is already set to it). */
export const BI_SCHEMA = 'machvon_bi';

const people = new BidWorkflowReads();

const wholeTenant = (access: EffectiveAccess, permission: string): void => {
  if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
};

/**
 * The database logins of BI tools (INT-04, eng-review R6 and R13). The login and its binding to the tenant are made by privileged functions of the database; this controller asks for them, keeps the register and the
 * history, and shows the password once: the interceptor withholds `password` from the answer it keeps for the replay, the database stores a SCRAM verifier made here, and neither the audit nor the event carries it.
 */
@Controller()
export class BiReaderController {
  private readonly readers = new BiReaderStore();

  private async announce(scope: CommandScope, change: string, id: string, version: number, now: Date): Promise<void> {
    await scope.emit({
      aggregateType: READER_RESOURCE,
      aggregateId: id,
      aggregateVersion: version,
      type: 'int.bi_reader.changed.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, reader_id: id, change, version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${READER_RESOURCE}:${id}:${version}`,
    });
  }

  @Post('int/bi-readers')
  @HttpCode(201)
  @OperationId('createBiReader')
  @Command({ operation: 'createBiReader', withheld: ['password'] })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['BiReaderCreate']): Promise<Schemas['BiReaderIssued']> {
    wholeTenant(access, PERMISSIONS.createBiReader);
    const now = new Date();
    const request = biReaderRequestOf(body as unknown as Record<string, unknown>);
    const password = generateBiPassword();
    const row = await this.readers.provision(scope.tx, scope.tenant.tenantId, request, scramVerifierOf(password), scope.tenant.membershipId);
    await scope.audit({
      action: 'int.bi_reader_provisioned',
      resourceType: READER_RESOURCE,
      resourceId: row.id,
      classification: CLASSIFICATION,
      diff: { name: row.name, tool: row.tool, login_name: row.loginName, connection_limit: row.connectionLimit },
    });
    await this.announce(scope, 'PROVISIONED', row.id, row.version, now);
    return { operation_id: scope.requestId, status: row.status, resource_version: row.version, resource_id: row.id, reader_id: row.id, login_name: row.loginName, password, shown_once: true, schema_name: BI_SCHEMA };
  }

  @Post('int/bi-readers/:id/password')
  @HttpCode(200)
  @OperationId('rotateBiReaderPassword')
  @Command({ operation: 'rotateBiReaderPassword', versioned: true, withheld: ['password'] })
  async rotate(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['BiReaderRotate']): Promise<Schemas['BiReaderIssued']> {
    wholeTenant(access, PERMISSIONS.rotateBiReaderPassword);
    const now = new Date();
    const reason = egpReasonOf(body.reason);
    const password = generateBiPassword();
    const row = await this.readers.rotatePassword(scope.tx, scope.tenant.tenantId, id, scope.expectedVersion ?? 0, scramVerifierOf(password), reason, scope.tenant.membershipId);
    await scope.audit({ action: 'int.bi_reader_password_rotated', resourceType: READER_RESOURCE, resourceId: id, classification: CLASSIFICATION, reason, diff: { login_name: row.loginName } });
    await this.announce(scope, 'PASSWORD_ROTATED', id, row.version, now);
    return { operation_id: scope.requestId, status: row.status, resource_version: row.version, resource_id: id, reader_id: id, login_name: row.loginName, password, shown_once: true, schema_name: BI_SCHEMA };
  }

  @Post('int/bi-readers/:id/decision')
  @HttpCode(200)
  @OperationId('decideBiReader')
  @Command({ operation: 'decideBiReader', versioned: true })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['BiReaderDecision']): Promise<CommandResult> {
    wholeTenant(access, PERMISSIONS.decideBiReader);
    if (!isBiReaderMove(body.decision)) throw new DomainError('VALIDATION_FAILED', 422, 'decision');
    const now = new Date();
    const done = await this.readers.decide(scope.tx, scope.tenant.tenantId, id, scope.expectedVersion ?? 0, { move: body.decision, reason: body.reason }, scope.tenant.membershipId, now);
    await scope.audit({
      action: 'int.bi_reader_decided',
      resourceType: READER_RESOURCE,
      resourceId: id,
      classification: CLASSIFICATION,
      reason: done.row.statusReason ?? body.reason,
      diff: { decision: body.decision, from: done.before.status, to: done.row.status, login_name: done.row.loginName },
    });
    await this.announce(scope, body.decision, id, done.row.version, now);
    return commandResult(scope, done.row.status, done.row.version, id);
  }
}

/** The register of BI logins and what they can read (INT-04). */
@Controller()
export class BiReaderReadsController {
  private readonly readers = new BiReaderStore();
  private readonly datasets = new ExportDatasetStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('int/bi-readers')
  @OperationId('listBiReaders')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    wholeTenant(access, PERMISSIONS.listBiReaders);
    const now = new Date();
    const status = queryText(query.status, 'status', 20);
    if (status !== undefined && !(BI_READER_STATUSES as readonly string[]).includes(status)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const request = parsePageRequest(query.limit, query.cursor);
    const caller = { mayManage: holdsOnWholeTenant(access, PERMISSIONS.decideBiReader) && holdsOnWholeTenant(access, PERMISSIONS.rotateBiReaderPassword) };
    return this.database.withTenant(tenant, async (tx) => {
      const rows = await this.readers.list(tx, { status: status as 'ACTIVE' | 'SUSPENDED' | 'RETIRED' | undefined }, { limit: request.limit + 1, after: request.after === undefined ? undefined : { key: request.after.code, id: request.after.id } });
      const shown = rows.slice(0, request.limit);
      const last = shown[shown.length - 1];
      const states = await this.datasets.state(tx, now);
      return {
        items: shown.map((row) => biReaderDto(row, caller)),
        next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAtKey, id: last.id }) : null,
        counts: await this.readers.counts(tx),
        views: OPEN_DATASETS.map((code) => ({
          dataset_code: code,
          view: OPEN_DATASET_DEFINITIONS[code].view,
          grain: OPEN_DATASET_DEFINITIONS[code].grain,
          columns: [...OPEN_DATASET_DEFINITIONS[code].columns],
          open: states.find((state) => state.datasetCode === code)?.gate.open === true,
        })),
        schema_name: BI_SCHEMA,
        can_create: holdsOnWholeTenant(access, PERMISSIONS.createBiReader),
        as_of: now.toISOString(),
      };
    });
  }

  @Get('int/bi-readers/:id')
  @OperationId('getBiReader')
  async detail(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    wholeTenant(access, PERMISSIONS.getBiReader);
    const caller = { mayManage: holdsOnWholeTenant(access, PERMISSIONS.decideBiReader) && holdsOnWholeTenant(access, PERMISSIONS.rotateBiReaderPassword) };
    return this.database.withTenant(tenant, async (tx) => {
      const row = await this.readers.find(tx, id);
      if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const events = await this.readers.events(tx, id, 50);
      const nameOf = nameLookup(await people.names(tx, events.map((event) => event.actorId)));
      return { reader: biReaderDto(row, caller), events: events.map((event) => biReaderEventDto(event, nameOf)), as_of: new Date().toISOString() };
    });
  }
}
