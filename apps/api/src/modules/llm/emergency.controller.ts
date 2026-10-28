import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AiDecisionStore, LlmEmergencyStore, LlmFinopsStore, TenantDatabase } from '@machvon/db';
import type { AiDecisionRow, KillSwitchRow } from '@machvon/db';
import { DomainError, NOOP_METRICS, asUuid, scrubSecrets } from '@machvon/kernel';
import type { AiGatewayPort, EffectiveAccess, MetricsSink, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { LLM_GATEWAY, LLM_METRICS } from './tokens';

const SWITCH = 'ai_kill_switch';
const DECISION = 'ai_decision_record';
const DECISIONS = ['ACCEPTED', 'ACCEPTED_WITH_CHANGE', 'REJECTED'];

export function switchView(row: KillSwitchRow): Record<string, unknown> {
  return {
    id: row.id,
    scope_kind: row.scopeKind,
    scope_ref: row.scopeRef,
    reason: row.reason,
    state: row.state,
    engaged_by: row.engagedBy,
    engaged_at: row.engagedAt,
    release_approved_by: row.releaseApprovedBy,
    released_at: row.releasedAt,
    release_reason: row.releaseReason,
    affected_requests: row.affectedRequests,
    version: row.version,
  };
}

export function decisionView(row: AiDecisionRow): Record<string, unknown> {
  return {
    id: row.id,
    ai_request_id: row.aiRequestId,
    subject_module: row.subjectModule,
    subject_kind: row.subjectKind,
    subject_id: row.subjectId,
    ai_output_sha256: row.aiOutputSha256,
    action_kind: row.actionKind,
    decision: row.decision,
    rationale: row.rationale,
    decided_by: row.decidedBy,
    decided_at: row.decidedAt,
    applied_operation_id: row.appliedOperationId,
    applied_resource_version: row.appliedResourceVersion,
  };
}

const cursorOf = (key: string, id: string): string => Buffer.from(`${key}|${id}`).toString('base64url');
function parseCursor(raw: unknown): { key: string; id: string } | undefined {
  if (raw === undefined) return undefined;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6})\|([0-9a-f-]{36})$/.exec(Buffer.from(String(raw), 'base64url').toString('utf8'));
  if (match === null) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
  const key = match[1] as string;
  const moment = new Date(`${key.slice(0, 23)}Z`);
  const id = asUuid(match[2] as string);
  if (Number.isNaN(moment.getTime()) || moment.toISOString().slice(0, 23) !== key.slice(0, 23) || id === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
  return { key, id };
}
function limitOf(raw: unknown): number {
  if (raw === undefined) return 50;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 200) throw new DomainError('VALIDATION_FAILED', 422, 'limit');
  return value;
}

/**
 * The emergency stop of the AI gateway and the records of the decisions of people (ST-LLM-006, LLM F7, F8, LLM-18, LLM-20): a switch stops AI by scope at once (what waits is cancelled, what was sent is cancelled when the provider can and
 * otherwise has its answer thrown away) and is released only by another person; and a person decides, with a reason, what is done with an answer of the AI before any command acts on it.
 */
@Controller()
export class LlmEmergencyController {
  private readonly switches = new LlmEmergencyStore();
  private readonly decisions = new AiDecisionStore();
  private readonly finops = new LlmFinopsStore();
  private readonly metrics: MetricsSink;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Inject(LLM_GATEWAY) private readonly gateway: AiGatewayPort,
    @Optional() @Inject(LLM_METRICS) metrics?: MetricsSink,
  ) {
    this.metrics = metrics ?? NOOP_METRICS;
  }

  private whole(access: EffectiveAccess, permission: string): void {
    if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
  }

  @Post('ai-kill-switches')
  @HttpCode(200)
  @OperationId('engageAiKillSwitch')
  @Command({ operation: 'engageAiKillSwitch' })
  async engage(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Body() body: Schemas['LlmKillSwitch'],
  ): Promise<CommandResult & { affected_requests: number; cancelled: number; dispatched: number }> {
    this.whole(access, PERMISSIONS.engageAiKillSwitch);
    const started = Date.now();
    const actor = scope.tenant.membershipId;
    // What is kept is the reason without anything that looks like a secret, and it is that which must be long enough.
    const reason = scrubSecrets(body.reason.trim()).trim();
    if (reason.length < 10) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
    const created = await this.switches.engage(scope.tx, { scopeKind: body.scope_kind, scopeRef: body.scope_ref, reason, actor });
    // Only rows are changed here, so that the switch is committed, and in force, at once; the providers are asked to cancel after that.
    const stopped = await this.switches.stopInFlight(scope.tx, { kind: created.scopeKind, ref: created.scopeRef }, actor);
    // What waited is given back its hold; what was sent keeps it until its usage is known.
    for (const entry of stopped) {
      if (entry.outcome !== 'CANCELLED' || entry.reservationId === null) continue;
      const hold = await this.finops.findReservation(scope.tx, entry.reservationId, true);
      if (hold !== undefined && (hold.status === 'RESERVED' || hold.status === 'PENDING_RECONCILE')) await this.finops.release(scope.tx, entry.reservationId, 'KILL_SWITCH');
    }
    await this.switches.countAffected(scope.tx, created.id, stopped.length);
    const entry = (await this.switches.find(scope.tx, created.id)) as KillSwitchRow;
    const cancelled = stopped.filter((request) => request.outcome === 'CANCELLED').length;
    const sent = stopped.length - cancelled;
    await scope.audit({ action: 'llm.kill_switch_engaged', resourceType: SWITCH, resourceId: entry.id, diff: { scope_kind: entry.scopeKind, scope_ref: entry.scopeRef, reason: entry.reason, affected_requests: stopped.length, cancelled, sent } });
    await scope.emit({
      aggregateType: SWITCH,
      aggregateId: entry.id,
      aggregateVersion: entry.version,
      type: 'llm.kill_switch.engaged.v1',
      schemaVersion: 1,
      payload: { kill_switch_id: entry.id, scope_kind: entry.scopeKind, scope_ref: entry.scopeRef, affected_requests: stopped.length },
      eventKey: `${SWITCH}:${entry.id}:${entry.version}`,
    });
    // The switch is in force from the commit. After it the providers are asked to cancel the requests that were sent: one that does has its request cancelled; one that cannot leaves it marked, and the answer is thrown away when it comes.
    // How long the stop took to work, from the call to the last request that was stopped, is what the alert on BR-LLM-12 watches.
    scope.afterCommit(async () => {
      for (const request of stopped) {
        if (request.outcome !== 'KILLED_PENDING' || request.providerRequestId === null || this.gateway.cancel === undefined) continue;
        const providerRequestId = request.providerRequestId;
        const accepted = await this.gateway.cancel(providerRequestId).catch(() => false);
        if (!accepted) continue;
        await this.database.withTenant(scope.tenant, async (tx) => {
          if (!(await this.switches.markCancelled(tx, request.id, actor))) return;
          if (request.reservationId === null) return;
          const hold = await this.finops.findReservation(tx, request.reservationId, true);
          if (hold !== undefined && (hold.status === 'RESERVED' || hold.status === 'PENDING_RECONCILE')) await this.finops.release(tx, request.reservationId, 'KILL_SWITCH');
        });
      }
      this.metrics.gauge('llm_kill_switch_latency_ms', Date.now() - started, { tenant_id: scope.tenant.tenantId });
    });
    return { ...commandResult(scope, 'ENGAGED', entry.version, entry.id), affected_requests: stopped.length, cancelled, dispatched: sent };
  }

  @Post('ai-kill-switches/:id/release')
  @HttpCode(200)
  @OperationId('releaseAiKillSwitch')
  @Command({ operation: 'releaseAiKillSwitch', versioned: true })
  async release(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['LlmKillRelease']): Promise<CommandResult> {
    this.whole(access, PERMISSIONS.releaseAiKillSwitch);
    const reason = scrubSecrets(body.release_reason.trim()).trim();
    if (reason.length < 10) throw new DomainError('VALIDATION_FAILED', 422, 'release_reason');
    const released = await this.switches.release(scope.tx, id, { reason, actor: scope.tenant.membershipId, expectedVersion: scope.expectedVersion ?? 0 });
    await scope.audit({ action: 'llm.kill_switch_released', resourceType: SWITCH, resourceId: id, diff: { scope_kind: released.scopeKind, scope_ref: released.scopeRef, engaged_by: released.engagedBy, release_reason: released.releaseReason } });
    await scope.emit({
      aggregateType: SWITCH,
      aggregateId: id,
      aggregateVersion: released.version,
      type: 'llm.kill_switch.released.v1',
      schemaVersion: 1,
      payload: { kill_switch_id: id, scope_kind: released.scopeKind, scope_ref: released.scopeRef },
      eventKey: `${SWITCH}:${id}:${released.version}`,
    });
    return commandResult(scope, 'RELEASED', released.version, id);
  }

  @Get('ai-kill-switches')
  @OperationId('listAiKillSwitches')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('state') state?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('limit') limit?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    this.whole(access, PERMISSIONS.listAiKillSwitches);
    if (state !== undefined && state !== 'ENGAGED' && state !== 'RELEASED') throw new DomainError('VALIDATION_FAILED', 422, 'state');
    const filter = { state: state as string | undefined, limit: limitOf(limit), after: parseCursor(cursor) };
    const page = await this.database.withTenant(tenant, (tx) => this.switches.switches(tx, filter));
    return { items: page.rows.map(switchView), next_cursor: page.next === undefined ? null : cursorOf(page.next.key, page.next.id), as_of: new Date().toISOString() };
  }

  @Post('ai-decisions')
  @HttpCode(200)
  @OperationId('recordAiDecision')
  @Command({ operation: 'recordAiDecision' })
  async record(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['LlmDecisionRecord']): Promise<CommandResult> {
    this.whole(access, PERMISSIONS.recordAiDecision);
    const requestId = asUuid(body.ai_request_id);
    const subjectId = asUuid(body.subject_id);
    if (requestId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'ai_request_id');
    if (subjectId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'subject_id');
    const rationale = scrubSecrets(body.rationale.trim()).trim();
    if (rationale.length < 20) throw new DomainError('VALIDATION_FAILED', 422, 'rationale');
    const created = await this.decisions.record(scope.tx, {
      aiRequestId: requestId,
      subjectModule: body.subject_module.trim().toUpperCase(),
      subjectKind: body.subject_kind.trim(),
      subjectId,
      aiOutputSha256: body.ai_output_sha256,
      actionKind: body.action_kind,
      decision: body.decision,
      rationale,
      actor: scope.tenant.membershipId,
    });
    // The audit says what was decided and about what, not the words of the person: the record holds them.
    await scope.audit({ action: 'llm.decision_recorded', resourceType: DECISION, resourceId: created.id, diff: { ai_request_id: requestId, subject_module: created.subjectModule, subject_kind: created.subjectKind, subject_id: subjectId, action_kind: created.actionKind, decision: created.decision } });
    await scope.emit({
      aggregateType: DECISION,
      aggregateId: created.id,
      aggregateVersion: 1,
      type: 'llm.decision.recorded.v1',
      schemaVersion: 1,
      payload: { decision_id: created.id, ai_request_id: requestId, subject_module: created.subjectModule, subject_kind: created.subjectKind, subject_id: subjectId, decision: created.decision },
      eventKey: `${DECISION}:${created.id}:1`,
    });
    return commandResult(scope, created.decision, 1, created.id);
  }

  @Get('ai-decisions')
  @OperationId('listAiDecisionRecords')
  async decisionsList(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('ai_request_id') requestId?: unknown,
    @Query('subject_module') subjectModule?: unknown,
    @Query('decision') decision?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('limit') limit?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    this.whole(access, PERMISSIONS.listAiDecisionRecords);
    const request = requestId === undefined ? undefined : asUuid(String(requestId));
    if (requestId !== undefined && request === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'ai_request_id');
    if (decision !== undefined && !DECISIONS.includes(String(decision))) throw new DomainError('VALIDATION_FAILED', 422, 'decision');
    const filter = { aiRequestId: request, subjectModule: subjectModule === undefined ? undefined : String(subjectModule).slice(0, 10).toUpperCase(), decision: decision === undefined ? undefined : String(decision), limit: limitOf(limit), after: parseCursor(cursor) };
    const page = await this.database.withTenant(tenant, (tx) => this.decisions.records(tx, filter));
    return { items: page.rows.map(decisionView), next_cursor: page.next === undefined ? null : cursorOf(page.next.key, page.next.id), as_of: new Date().toISOString() };
  }
}
