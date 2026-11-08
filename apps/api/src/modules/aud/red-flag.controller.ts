import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { RedFlagStore, TenantDatabase } from '@machvon/db';
import type { FindingRow, ReviewRow } from '@machvon/db';
import { DomainError, RED_FLAG_STATUSES, asUuid, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, RedFlagMove, RedFlagStatus, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';

const RESOURCE_TYPE = 'red_flag_finding';
const READ = PERMISSIONS.listRedFlags;
const REVIEW = PERMISSIONS.takeRedFlag;
const CLEAR = PERMISSIONS.confirmClearRedFlag;
const SCAN = PERMISSIONS.scanRedFlags;
/** A red flag belongs to no unit: only a grant on the whole tenant reaches it (and the people who took part in the procurement never do, whatever they hold). */
const assertHolds = (access: EffectiveAccess, permission: string): void => {
  if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
};

const BANDS: readonly string[] = ['LOW', 'MEDIUM', 'HIGH'];

const view = (row: FindingRow): Record<string, unknown> => ({
  id: row.id,
  subject_type: row.subjectType,
  subject_id: row.subjectId,
  subject_code: row.subjectCode,
  project_id: row.projectId,
  score: row.score,
  band: row.band,
  status: row.status,
  fired: row.fired.map((entry) => ({ code: entry.code, ocp_id: entry.ocp_id, value: entry.value, threshold: entry.threshold, weight: entry.weight })),
  not_computable: row.notComputable,
  ranking_version: row.rankingVersion,
  first_flagged_at: row.firstFlaggedAt,
  last_evaluated_at: row.lastEvaluatedAt,
  evaluation_count: row.evaluationCount,
  reviewer_id: row.reviewerId,
  clear_proposed_by: row.clearProposedBy,
  cleared_by: row.clearedBy,
  referred_by: row.referredBy,
  reopened_count: row.reopenedCount,
  version: row.version,
  // The wording of the screen: a signal for review, never a conclusion.
  is_conclusion: false,
});

const detailView = (row: FindingRow, history: ReviewRow[]): Record<string, unknown> => ({
  ...view(row),
  readings: row.readings.map((reading) => ({ code: reading.code, ocp_id: reading.ocpId, status: reading.status, value: reading.value, threshold: reading.threshold, weight: reading.weight, missing: reading.missing })),
  rule_versions: row.ruleVersions,
  clear_reason: row.clearReason,
  cleared_at: row.clearedAt,
  referral_reason: row.referralReason,
  referred_at: row.referredAt,
  review_started_at: row.reviewStartedAt,
  history: history.map((entry) => ({ id: entry.id, move: entry.move, from_status: entry.fromStatus, to_status: entry.toStatus, actor_id: entry.actorId, reason: entry.reason, score: entry.score, at: entry.at })),
});

/**
 * Red flags of procurement (G4-3), commands. Twelve indicators of the OCP catalogue are computed from the data of BID and CTR and ranked so that the auditors know where to look first; a red flag is a signal, never a
 * conclusion. An auditor takes a finding up, and clearing it takes two: one proposes with a reason, a different one confirms (or sends it back with a reason); or it is referred to an investigation with a reason. A person who took
 * part in the procurement or the contract cannot act on, see, or learn of the finding: they get 404 as if it did not exist. Every move is audited as CONFIDENTIAL and carried by an event that names the finding, never the words.
 */
@Controller()
export class RedFlagController {
  private readonly store = new RedFlagStore();

  @Post('red-flags/scan')
  @HttpCode(200)
  @OperationId('scanRedFlags')
  @Command({ operation: 'scanRedFlags' })
  async scan(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['RedFlagScanRequest']): Promise<CommandResult> {
    assertHolds(access, SCAN);
    const now = new Date();
    const result = await this.store.scan(scope.tx, now, `manual:${scope.requestId}`, vietnamDateOf(now));
    await scope.audit({ action: 'aud.red_flag_scanned', resourceType: 'red_flag_scan', resourceId: result.scanId, classification: 'CONFIDENTIAL', diff: { subjects: result.subjects, flagged: result.flagged, rescored: result.rescored, reopened: result.reopened }, ...(body.note === undefined ? {} : { reason: body.note }) });
    await scope.emit({
      aggregateType: 'red_flag_scan',
      aggregateId: result.scanId,
      aggregateVersion: 1,
      type: 'aud.red_flag.scanned.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, scan_id: result.scanId, subjects: result.subjects, flagged: result.flagged, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `red_flag_scan:${result.scanId}`,
    });
    return commandResult(scope, 'FINISHED', 1, result.scanId);
  }

  @Post('red-flags/:id/take')
  @HttpCode(200)
  @OperationId('takeRedFlag')
  @Command({ operation: 'takeRedFlag', versioned: true })
  take(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    assertHolds(access, REVIEW);
    return this.move(scope, id, 'TAKE', 'taken', undefined);
  }

  @Post('red-flags/:id/propose-clear')
  @HttpCode(200)
  @OperationId('proposeClearRedFlag')
  @Command({ operation: 'proposeClearRedFlag', versioned: true })
  propose(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['RedFlagReason']): Promise<CommandResult> {
    assertHolds(access, REVIEW);
    return this.move(scope, id, 'PROPOSE_CLEAR', 'clear_proposed', body.reason);
  }

  @Post('red-flags/:id/confirm-clear')
  @HttpCode(200)
  @OperationId('confirmClearRedFlag')
  @Command({ operation: 'confirmClearRedFlag', versioned: true })
  confirm(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    assertHolds(access, CLEAR);
    return this.move(scope, id, 'CONFIRM_CLEAR', 'cleared', undefined);
  }

  @Post('red-flags/:id/reject-clear')
  @HttpCode(200)
  @OperationId('rejectClearRedFlag')
  @Command({ operation: 'rejectClearRedFlag', versioned: true })
  rejectClear(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['RedFlagReason']): Promise<CommandResult> {
    assertHolds(access, CLEAR);
    return this.move(scope, id, 'REJECT_CLEAR', 'clear_rejected', body.reason);
  }

  @Post('red-flags/:id/refer')
  @HttpCode(200)
  @OperationId('referRedFlag')
  @Command({ operation: 'referRedFlag', versioned: true })
  refer(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['RedFlagReason']): Promise<CommandResult> {
    assertHolds(access, REVIEW);
    return this.move(scope, id, 'REFER', 'referred', body.reason);
  }

  private async move(scope: CommandScope, id: string, move: RedFlagMove, what: string, reason: string | undefined): Promise<CommandResult> {
    const now = new Date();
    const done = await this.store.move(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, move, scope.tenant.membershipId, reason, now);
    await scope.audit({ action: `aud.red_flag_${what}`, resourceType: RESOURCE_TYPE, resourceId: done.id, classification: 'CONFIDENTIAL', diff: { status: done.status, score: done.score, subject_type: done.subjectType }, ...(reason === undefined ? {} : { reason: reason.trim() }) });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type: `aud.red_flag.${what}.v1`,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, finding_id: done.id, status: done.status, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${RESOURCE_TYPE}:${done.id}:${done.version}`,
    });
    return commandResult(scope, done.status, done.version, done.id);
  }
}

/** Red flags of procurement, reads: the ranked list, the counts, one finding with every indicator and its history, and the registry of indicators. Nothing that the reader took part in is in any of them. */
@Controller()
export class RedFlagReadsController {
  private readonly store = new RedFlagStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('red-flags')
  @OperationId('listRedFlags')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('status') status?: unknown,
    @Query('band') band?: unknown,
    @Query('project_id') projectId?: unknown,
    @Query('limit') limit?: unknown,
    @Query('offset') offset?: unknown,
  ): Promise<Record<string, unknown>> {
    if (status !== undefined && !(RED_FLAG_STATUSES as readonly string[]).includes(status as string)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    if (band !== undefined && !BANDS.includes(band as string)) throw new DomainError('VALIDATION_FAILED', 422, 'band');
    const project = projectId === undefined ? undefined : asUuid(projectId)?.toLowerCase();
    if (projectId !== undefined && project === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'project_id');
    const take = limit === undefined ? 50 : Number(limit);
    const skip = offset === undefined ? 0 : Number(offset);
    if (!Number.isInteger(take) || take < 1 || take > 200) throw new DomainError('VALIDATION_FAILED', 422, 'limit');
    if (!Number.isInteger(skip) || skip < 0 || skip > 100_000) throw new DomainError('VALIDATION_FAILED', 422, 'offset');
    const today = vietnamDateOf(new Date());
    if (!holdsOnWholeTenant(access, READ)) return { as_of: today, items: [], has_more: false };
    const rows = await this.database.withTenant(tenant, (tx) => this.store.list(tx, tenant.membershipId, { status: status as RedFlagStatus | undefined, band: band as 'LOW' | 'MEDIUM' | 'HIGH' | undefined, projectId: project, limit: take + 1, offset: skip }));
    return { as_of: today, items: rows.slice(0, take).map(view), has_more: rows.length > take };
  }

  @Get('red-flags/summary')
  @OperationId('getRedFlagSummary')
  async summary(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    const today = vietnamDateOf(new Date());
    if (!holdsOnWholeTenant(access, READ)) return { as_of: today, total: 0, by_band: {}, by_status: {}, last_scan: null, denied: true };
    const summary = await this.database.withTenant(tenant, (tx) => this.store.summary(tx, tenant.membershipId));
    const scan = summary.lastScan;
    return {
      as_of: today,
      total: summary.total,
      by_band: summary.byBand,
      by_status: summary.byStatus,
      last_scan: scan === null ? null : { started_at: scan.startedAt, finished_at: scan.finishedAt, status: scan.status, subjects: scan.subjects, flagged: scan.flagged },
    };
  }

  @Get('red-flags/indicators')
  @OperationId('listRedFlagIndicators')
  async indicators(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    const today = vietnamDateOf(new Date());
    if (!holdsOnWholeTenant(access, READ)) return { as_of: today, items: [] };
    const rows = await this.database.withTenant(tenant, (tx) => this.store.registry(tx, today));
    return {
      as_of: today,
      items: rows.map((row) => ({
        code: row.code,
        ocp_id: row.ocpId,
        vendor_side: row.vendorSide,
        data_sources: row.dataSources,
        formula: row.formula,
        source: row.source,
        indicator_as_of: row.asOf,
        legal_status: row.legalStatus,
        unverified: row.unverified,
        enabled: row.enabled,
        params: row.params,
        rule_version: row.version,
      })),
    };
  }

  @Get('red-flags/:id')
  @OperationId('getRedFlag')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, READ)) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    const found = await this.database.withTenant(tenant, async (tx) => {
      const row = await this.store.get(tx, tenant.membershipId, id.toLowerCase());
      return row === undefined ? undefined : { row, history: await this.store.reviews(tx, row.id) };
    });
    // Whoever took part in the procurement, and whoever asks for what does not exist, hears the same thing.
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    return { as_of: vietnamDateOf(new Date()), ...detailView(found.row, found.history) };
  }
}
