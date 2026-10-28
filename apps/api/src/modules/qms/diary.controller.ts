import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { QmsDiaryStore, TenantDatabase, conflictRefusal, contractScope } from '@machvon/db';
import type { ContractScopes, QmsDiaryResult } from '@machvon/db';
import { DomainError, asUuid } from '@machvon/kernel';
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
import { diaryActionsOf, diaryView } from './diary-view';
import type { DiaryPermissions } from './diary-view';

const READ_PERMISSION = PERMISSIONS.get_resources_site_diary;
const RESOURCE_TYPE = 'site_diary';
const CLASSIFICATION = 'INTERNAL';

const ACTION_PERMISSIONS: DiaryPermissions = {
  write: PERMISSIONS.saveSiteDiaryDraft,
  contractorSign: PERMISSIONS.signSiteDiaryByContractor,
  supervise: PERMISSIONS.addSupervisorRemark,
  ownerConfirm: PERMISSIONS.confirmSiteDiaryByOwner,
  lock: PERMISSIONS.lockSiteDiary,
  correct: PERMISSIONS.correctSiteDiary,
  resolveConflict: PERMISSIONS.resolveDiaryConflict,
};

const scopesFor = (access: EffectiveAccess, permission: string, now: Date): ContractScopes => ({ update: contractScope(access, permission, now), read: contractScope(access, READ_PERMISSION, now) });

/**
 * The electronic site diary (ST-QMS-001, QMS 3.1). The contractor drafts the diary of a day and signs it over a hash of what it says; the supervisor remarks on it and signs; the owner confirms; and it is locked. A signed
 * diary is not edited (409 `DIARY_STATE_INVALID`) and nobody signs for the other side (403 `SCOPE_DENIED`); after the lock only a correction, a new revision with a reason that is signed again, replaces it. Two people who
 * write at the same time with the same `If-Match` do not overwrite each other: the second is refused with the version it must reload (409 `VERSION_CONFLICT`). The audit rows and the events carry the ids, the day, the
 * status and the roles, never the words of the diary.
 */
@Controller()
export class DiaryController {
  private readonly diaries = new QmsDiaryStore();

  @Post('site-diaries')
  @HttpCode(200)
  @OperationId('saveSiteDiaryDraft')
  @Command({ operation: 'saveSiteDiaryDraft' })
  async save(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['QmsSaveSiteDiaryDraft']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.diaries.save(
      scope.tx,
      { contractId: body.contract_id, recordDate: body.record_date, clientOperationId: body.client_operation_id, baseServerVersion: body.base_server_version, content: body.content, deviceId: body.device_id },
      scope.tenant.membershipId,
      scopesFor(access, ACTION_PERMISSIONS.write, now),
      now,
    );
    if (done.conflict !== null) {
      // The device wrote over a draft it had not read at its version: its copy is kept (the answer is the refusal, after the commit) and the diary of the day is not touched.
      await scope.audit({
        action: 'site_diary.conflict_stored',
        resourceType: RESOURCE_TYPE,
        resourceId: done.id,
        classification: CLASSIFICATION,
        diff: { diary_no: done.diaryNo, conflict_of_id: done.conflict.mainId, contract_id: done.contractId, record_date: done.recordDate, server_version: done.conflict.mainVersion },
      });
      scope.refuseAfterCommit(conflictRefusal(done));
      return commandResult(scope, 'CONFLICT_PENDING', done.version, done.id);
    }
    await this.written(scope, done, done.fromStatus === null ? 'site_diary.drafted' : 'site_diary.revised', done.fromStatus === null ? 'qms.site_diary.drafted.v1' : 'qms.site_diary.revised.v1', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('site-diaries/:id/draft')
  @HttpCode(200)
  @OperationId('reviseSiteDiaryDraft')
  @Command({ operation: 'reviseSiteDiaryDraft', versioned: true })
  async revise(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['QmsReviseSiteDiaryDraft']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.diaries.revise(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, { content: body.content, clientOperationId: body.client_operation_id }, scope.tenant.membershipId, scopesFor(access, ACTION_PERMISSIONS.write, now), now);
    await this.written(scope, done, 'site_diary.revised', 'qms.site_diary.revised.v1', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('site-diaries/:id/contractor-sign')
  @HttpCode(200)
  @OperationId('signSiteDiaryByContractor')
  @Command({ operation: 'signSiteDiaryByContractor', versioned: true })
  async contractorSign(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['QmsSignSiteDiaryByContractor']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.diaries.contractorSign(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { signatureMethod: body.signature_method, certSerial: body.cert_serial, clientOperationId: body.client_operation_id },
      scope.tenant.membershipId,
      scopesFor(access, ACTION_PERMISSIONS.contractorSign, now),
      now,
    );
    await this.written(scope, done, 'site_diary.contractor_signed', 'qms.site_diary.contractor_signed.v1', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('site-diaries/:id/supervisor-remark')
  @HttpCode(200)
  @OperationId('addSupervisorRemark')
  @Command({ operation: 'addSupervisorRemark', versioned: true })
  async supervise(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['QmsAddSupervisorRemark']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.diaries.supervise(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { signatureMethod: body.signature_method, certSerial: body.cert_serial, clientOperationId: body.client_operation_id, text: body.remark },
      scope.tenant.membershipId,
      scopesFor(access, ACTION_PERMISSIONS.supervise, now),
      now,
    );
    await this.written(scope, done, 'site_diary.supervised', 'qms.site_diary.supervised.v1', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('site-diaries/:id/owner-confirm')
  @HttpCode(200)
  @OperationId('confirmSiteDiaryByOwner')
  @Command({ operation: 'confirmSiteDiaryByOwner', versioned: true })
  async ownerConfirm(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['QmsConfirmSiteDiaryByOwner']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.diaries.ownerConfirm(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { signatureMethod: body.signature_method, certSerial: body.cert_serial, clientOperationId: body.client_operation_id, text: body.note },
      scope.tenant.membershipId,
      scopesFor(access, ACTION_PERMISSIONS.ownerConfirm, now),
      now,
    );
    await this.written(scope, done, 'site_diary.owner_confirmed', 'qms.site_diary.owner_confirmed.v1', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('site-diaries/:id/lock')
  @HttpCode(200)
  @OperationId('lockSiteDiary')
  @Command({ operation: 'lockSiteDiary', versioned: true })
  async lock(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['QmsLockSiteDiary']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.diaries.lockDiary(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, body.reason, scope.tenant.membershipId, scopesFor(access, ACTION_PERMISSIONS.lock, now), now);
    await this.written(scope, done, 'site_diary.locked', 'qms.site_diary.locked.v1', now, body.reason);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('site-diaries/:id/corrections')
  @HttpCode(200)
  @OperationId('correctSiteDiary')
  @Command({ operation: 'correctSiteDiary' })
  async correct(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['QmsCorrectSiteDiary']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.diaries.correct(scope.tx, id.toLowerCase(), { content: body.content, correctionReason: body.correction_reason, clientOperationId: body.client_operation_id }, scope.tenant.membershipId, scopesFor(access, ACTION_PERMISSIONS.correct, now));
    await this.written(scope, done, 'site_diary.corrected', 'qms.site_diary.corrected.v1', now, body.correction_reason);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('site-diaries/:id/resolve-conflict')
  @HttpCode(200)
  @OperationId('resolveDiaryConflict')
  @Command({ operation: 'resolveDiaryConflict', versioned: true })
  async resolveConflict(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['QmsResolveDiaryConflict']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.diaries.resolveConflict(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { conflictDiaryId: body.conflict_diary_id, resolution: body.resolution, mergedContent: body.merged_content, note: body.note },
      scope.tenant.membershipId,
      scopesFor(access, ACTION_PERMISSIONS.resolveConflict, now),
      now,
    );
    // The audit row names the copy and how it was settled; what each side said stays in the rows of the diary, not in the audit or the event.
    await this.written(scope, done, 'site_diary.conflict_resolved', 'qms.site_diary.conflict_resolved.v1', now, undefined, { conflict_diary_id: body.conflict_diary_id, resolution: body.resolution });
    return commandResult(scope, done.status, done.version, done.id);
  }

  /** The audit row and the event of a command: ids, the day, statuses and roles, never the words of the diary beyond the reason that the audit row keeps. */
  private async written(scope: CommandScope, done: QmsDiaryResult, action: string, type: string, now: Date, reason?: string, more: Record<string, unknown> = {}): Promise<void> {
    if (done.replayed) {
      // A client operation that was seen before changed nothing: it is audited as the read that it is, and says nothing new.
      await scope.audit({ action: 'site_diary.replayed', resourceType: RESOURCE_TYPE, resourceId: done.id, classification: CLASSIFICATION, diff: { diary_no: done.diaryNo, status: done.status } });
      return;
    }
    const facts = {
      diary_no: done.diaryNo,
      contract_id: done.contractId,
      contract_code: done.contractCode,
      project_id: done.projectId,
      record_date: done.recordDate,
      correction_of_id: done.correctionOfId,
      signer_role: done.signerRole,
      signature_method: done.signatureMethod,
      legal_effect: done.legalEffect,
      ...more,
    };
    await scope.audit({
      action,
      resourceType: RESOURCE_TYPE,
      resourceId: done.id,
      classification: CLASSIFICATION,
      ...(reason === undefined ? {} : { reason }),
      diff: { from_status: done.fromStatus, to_status: done.status, ...facts },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, site_diary_id: done.id, ...facts, status: done.status, from_status: done.fromStatus, version: done.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      // Keeping a diary does not move its version, so the event of settling a copy is told apart by the copy.
      eventKey: `${RESOURCE_TYPE}:${done.id}:${done.version}${typeof more.conflict_diary_id === 'string' ? `:${more.conflict_diary_id}` : ''}`,
    });
  }
}

/** The diaries of the contracts in the scope of the caller (the right to read them is `site_diary.read`; a guest contractor holds it over its own contract). */
@Controller('resources/site_diary')
export class DiaryReadsController {
  private readonly diaries = new QmsDiaryStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_site_diary')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('contract_id') contractId?: unknown,
    @Query('status') status?: unknown,
    @Query('from') from?: unknown,
    @Query('to') to?: unknown,
    @Query('has_conflict') hasConflict?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('limit') limit?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const contract = contractId === undefined ? undefined : typeof contractId === 'string' ? asUuid(contractId) : undefined;
    if (contractId !== undefined && contract === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'contract_id');
    const text = (name: string, value: unknown): string | undefined => {
      if (value === undefined) return undefined;
      if (typeof value !== 'string') throw new DomainError('VALIDATION_FAILED', 422, name);
      return value;
    };
    // The diaries that have a copy of a device that nobody has settled, whatever state they are in: `has_conflict=true`.
    const flag = (name: string, value: unknown): boolean | undefined => {
      if (value === undefined) return undefined;
      if (value !== 'true' && value !== 'false') throw new DomainError('VALIDATION_FAILED', 422, name);
      return value === 'true';
    };
    const page = parsePageRequest(limit, cursor);
    const now = new Date();
    const found = await this.database.withTenant(tenant, (tx) =>
      this.diaries.list(tx, contractScope(access, READ_PERMISSION, now), tenant.membershipId, { contractId: contract?.toLowerCase(), status: text('status', status), from: text('from', from), to: text('to', to), hasConflict: flag('has_conflict', hasConflict), limit: page.limit, after: page.after }),
    );
    return {
      items: found.lines.map((line) => diaryView(line, diaryActionsOf(line, access, now, ACTION_PERMISSIONS))),
      next_cursor: found.next === undefined ? null : encodeCursor(found.next),
      as_of: now.toISOString(),
    };
  }

  @Get(':id')
  @OperationId('get_resources_site_diary_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const line = await this.database.withTenant(tenant, (tx) => this.diaries.find(tx, id.toLowerCase(), contractScope(access, READ_PERMISSION, now), tenant.membershipId));
    // A diary in another tenant or outside the scope of the caller is indistinguishable from one that does not exist.
    if (line === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return diaryView(line, diaryActionsOf(line, access, now, ACTION_PERMISSIONS));
  }
}
