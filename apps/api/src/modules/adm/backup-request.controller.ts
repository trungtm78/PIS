import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BackupRequestStore, TenantDatabase } from '@machvon/db';
import type { ApprovalEffects, BackupRequestRow } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { BackupState, EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { BACKUP_STATE_PORT, NoBackupState } from './backup-state.port';
import type { BackupStatePort } from './backup-state.port';
import { holdsOnWholeTenant } from './tenant-authority';
import { ADM_CLOCK } from './tokens';

/** The backups are tenant administration of the installation (ADM 3.12): a grant on the whole tenant reaches them, a grant on a subtree does not. */
function assertHolds(access: EffectiveAccess, permission: string): void {
  if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
}

function effectsOf(scope: CommandScope): ApprovalEffects {
  return { actor: scope.tenant.membershipId, audit: (entry) => scope.audit(entry), emit: (event) => scope.emit(event) };
}

export function backupRequestView(row: BackupRequestRow): Schemas['BackupRequest'] {
  return {
    id: row.id,
    kind: row.kind,
    repository: row.repository,
    reason: row.reason,
    status: row.status,
    requested_by: row.requestedBy,
    requested_at: row.requestedAt.toISOString(),
    decided_by: row.decidedBy,
    decided_at: row.decidedAt?.toISOString() ?? null,
    decision_reason: row.decisionReason,
    recorded_by: row.recordedBy,
    finished_at: row.finishedAt?.toISOString() ?? null,
    backup_label: row.backupLabel,
    outcome_note: row.outcomeNote,
    version: row.version,
  };
}

export function backupStateView(state: BackupState): Schemas['BackupState'] {
  return {
    source: state.source,
    read_at: state.readAt,
    backups: state.backups.map((entry) => ({ label: entry.label, kind: entry.kind, finished_at: entry.finishedAt, repository: entry.repository, failed: entry.failed })),
    last_verify_at: state.lastVerifyAt,
    health: state.health,
    detail: state.detail,
  };
}

/**
 * Manual backup requests (INFRA-2, HSKT YCK.06). A person asks for a full, differential or incremental backup, a different person allows it (maker-checker, audited), the host runner of the installation
 * runs it with pgBackRest and somebody records the outcome. The API never runs a backup: it records the request and shows the state it reads from the state port.
 */
@Controller('backup-requests')
export class BackupRequestCommandsController {
  private readonly store = new BackupRequestStore();
  private readonly clock: () => Date;

  constructor(@Optional() @Inject(ADM_CLOCK) clock?: () => Date) {
    this.clock = clock ?? (() => new Date());
  }

  @Post()
  @HttpCode(201)
  @OperationId('requestBackup')
  @Command({ operation: 'requestBackup' })
  async request(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['BackupRequestCreate']): Promise<CommandResult> {
    assertHolds(access, PERMISSIONS.requestBackup);
    const row = await this.store.request(scope.tx, effectsOf(scope), { kind: body.kind, repository: body.repository ?? 1, reason: body.reason, requestedBy: scope.tenant.membershipId, now: this.clock() });
    return commandResult(scope, 'REQUESTED', row.version, row.id);
  }

  @Post(':id/decision')
  @HttpCode(200)
  @OperationId('decideBackupRequest')
  @Command({ operation: 'decideBackupRequest', versioned: true })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['BackupRequestDecision']): Promise<CommandResult> {
    assertHolds(access, PERMISSIONS.decideBackupRequest);
    const row = await this.store.decide(scope.tx, effectsOf(scope), { id, decision: body.decision, decidedBy: scope.tenant.membershipId, reason: body.reason ?? '', expectedVersion: scope.expectedVersion ?? 0, now: this.clock() });
    return commandResult(scope, row.status === 'Approved' ? 'APPROVED' : 'REJECTED', row.version, row.id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @OperationId('cancelBackupRequest')
  @Command({ operation: 'cancelBackupRequest', versioned: true })
  async cancel(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['ReasonOnly']): Promise<CommandResult> {
    assertHolds(access, PERMISSIONS.cancelBackupRequest);
    const row = await this.store.cancel(scope.tx, effectsOf(scope), { id, by: scope.tenant.membershipId, reason: body.reason, expectedVersion: scope.expectedVersion ?? 0, now: this.clock() });
    return commandResult(scope, 'CANCELLED', row.version, row.id);
  }

  @Post(':id/outcome')
  @HttpCode(200)
  @OperationId('recordBackupOutcome')
  @Command({ operation: 'recordBackupOutcome', versioned: true })
  async outcome(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['BackupRequestOutcome']): Promise<CommandResult> {
    assertHolds(access, PERMISSIONS.recordBackupOutcome);
    const row = await this.store.record(scope.tx, effectsOf(scope), { id, outcome: body.outcome, backupLabel: body.backup_label, note: body.note, recordedBy: scope.tenant.membershipId, expectedVersion: scope.expectedVersion ?? 0, now: this.clock() });
    return commandResult(scope, row.status === 'Completed' ? 'COMPLETED' : 'FAILED', row.version, row.id);
  }
}

@Controller('backup-requests')
export class BackupRequestReadsController {
  private readonly store = new BackupRequestStore();
  private readonly clock: () => Date;
  private readonly state: BackupStatePort;

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase, @Optional() @Inject(BACKUP_STATE_PORT) state?: BackupStatePort, @Optional() @Inject(ADM_CLOCK) clock?: () => Date) {
    this.state = state ?? new NoBackupState();
    this.clock = clock ?? (() => new Date());
  }

  @Get()
  @OperationId('listBackupRequests')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('limit') limit?: unknown, @Query('cursor') cursor?: unknown): Promise<Schemas['BackupRequestPage']> {
    const request = parsePageRequest(limit, cursor);
    if (request.after !== undefined && Number.isNaN(Date.parse(request.after.code))) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
    assertHolds(access, PERMISSIONS.listBackupRequests);
    const rows = await this.database.withTenant(tenant, (tx) => this.store.list(tx, { limit: request.limit + 1, after: request.after === undefined ? undefined : { requestedAt: request.after.code, id: request.after.id } }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      state: backupStateView(await this.state.read(this.clock())),
      items: shown.map(backupRequestView),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.requestedAt.toISOString(), id: last.id }) : null,
    };
  }
}
