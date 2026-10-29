import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DgvIncidentStore, TenantDatabase, loadAccessIn } from '@machvon/db';
import type { ExceptionRecord, IncidentEventRecord, IncidentRecord } from '@machvon/db';
import { DomainError, EXCEPTION_DECISIONS, activeGrants, INCIDENT_DECISIONS, INCIDENT_STATUSES, INCIDENT_WORK_STATUSES, judgeExceptionDecision, nextWorkStep, resolutionText, assertWorkStep } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { assertTenantAuthority, uuidOf, viewerOf } from './inputs';

const INCIDENT_RESOURCE = 'quality_incident';
const EXCEPTION_RESOURCE = 'quality_exception';
const SEVERITIES: readonly string[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

const TRIAGE = PERMISSIONS.assignQualityIncident;
const REMEDIATE = PERMISSIONS.transitionQualityIncident;
const REVIEW = PERMISSIONS.post_quality_exceptions_id_decision;

function oneOf(list: readonly string[], value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !list.includes(value)) throw new DomainError('VALIDATION_FAILED', 422, name);
  return value;
}

/** The incident as the reads show it, with what the caller may do now (the server judges each command again). */
function incidentView(incident: IncidentRecord, access: EffectiveAccess, membershipId: string, now: Date, events?: IncidentEventRecord[]): Record<string, unknown> {
  const isAssignee = incident.assigneeId === membershipId;
  const next = nextWorkStep(incident.status);
  return {
    id: incident.id,
    title: incident.title,
    dataset: { id: incident.datasetId, code: incident.datasetCode },
    rule: { code: incident.ruleCode, dimension: incident.dimension },
    severity: incident.severity,
    status: incident.status,
    owner: { id: incident.ownerId, name: incident.ownerName },
    assignee: incident.assigneeId === null ? null : { id: incident.assigneeId, name: incident.assigneeName },
    due_at: incident.dueAt,
    sla_hours: incident.slaHours,
    // Past its time and not closed: what the dashboards count.
    is_overdue: incident.status !== 'CLOSED' && incident.dueAt < now.toISOString(),
    sla_breached_at: incident.slaBreachedAt,
    root_cause: incident.rootCause,
    remediation: incident.remediation,
    resolved_at: incident.resolvedAt,
    verified_by: incident.verifiedBy,
    verified_at: incident.verifiedAt,
    closed_at: incident.closedAt,
    reopened_count: incident.reopenedCount,
    run_id: incident.runId,
    reconciliation_id: incident.reconciliationId,
    created_at: incident.createdAt,
    version: incident.version,
    actions: {
      assign: holdsOnWholeTenant(access, TRIAGE) && ['OPEN', 'REOPENED', 'ASSIGNED', 'ACKNOWLEDGED', 'IN_PROGRESS'].includes(incident.status),
      advance: next === undefined || !isAssignee || !holdsOnWholeTenant(access, REMEDIATE) ? null : next,
      verify: holdsOnWholeTenant(access, TRIAGE) && incident.status === 'RESOLVED_PENDING_VERIFICATION' && !isAssignee,
    },
    ...(events === undefined
      ? {}
      : { events: events.map((entry) => ({ id: entry.id, kind: entry.kind, actor: entry.actorId === null ? null : { id: entry.actorId, name: entry.actorName }, from_status: entry.fromStatus, to_status: entry.toStatus, note: entry.note, occurred_at: entry.occurredAt })) }),
  };
}

function exceptionView(exception: ExceptionRecord, access: EffectiveAccess, membershipId: string): Record<string, unknown> {
  return {
    id: exception.id,
    dataset: { id: exception.datasetId, code: exception.datasetCode },
    run_id: exception.runId,
    incident_id: exception.incidentId,
    rule_version_id: exception.ruleVersionId,
    // Hidden from whoever may not see the dataset: the keys say what was looked at, the values are the dataset's.
    record_reference: exception.recordReference,
    evidence: exception.evidence,
    masked: exception.masked,
    reason: exception.reason,
    status: exception.status,
    decision: exception.decision,
    decided_by: exception.decidedBy,
    decided_at: exception.decidedAt,
    waiver_reason: exception.waiverReason,
    waiver_expires_at: exception.waiverExpiresAt,
    reopened_from_id: exception.reopenedFromId,
    owner_id: exception.ownerId,
    created_at: exception.createdAt,
    version: exception.version,
    actions: { decide: exception.status === 'OPEN' && exception.ownerId !== membershipId && holdsOnWholeTenant(access, REVIEW) },
  };
}

/**
 * The commands of the quality incidents and exceptions (ST-DGV-003, DGV.md F4). An incident is given to a handler with a due time, worked by that handler through acknowledged and in progress to resolved (with the cause and
 * the measure), and closed by someone else after a run that passes; an exception is resolved or waived for at most 180 days by someone who does not own it. Datasets belong to no unit: the rights are held on the whole tenant.
 */
@Controller()
export class DgvIncidentCommandsController {
  private readonly incidents = new DgvIncidentStore();

  @Post('dgv/quality-incidents/:id/assignment')
  @HttpCode(200)
  @OperationId('assignQualityIncident')
  @Command({ operation: 'assignQualityIncident', versioned: true })
  async assign(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DgvIncidentAssign']): Promise<CommandResult> {
    assertTenantAuthority(access, TRIAGE);
    const now = new Date();
    const incident = await this.incidents.lock(scope.tx, id.toLowerCase(), viewerOf(scope.tenant, access));
    this.incidents.assertVersion(incident, scope.expectedVersion ?? 0);
    const assigneeId = uuidOf(body.assignee_user_id, 'assignee_user_id');
    const dueAt = new Date(body.due_at);
    if (Number.isNaN(dueAt.getTime()) || dueAt.getTime() <= now.getTime()) throw new DomainError('VALIDATION_FAILED', 422, 'due_at');
    // The handler is a member of the tenant who may work incidents (any of the datasets: the right is held on the whole tenant).
    const assignee = await loadAccessIn(scope.tx, assigneeId).catch(() => undefined);
    if (assignee === undefined || !assignee.membershipActive || !holdsOnWholeTenant(assignee, REMEDIATE)) throw new DomainError('ASSIGNEE_OUT_OF_SCOPE', 422, 'assignee_user_id');
    // ...and may see the dataset the incident is about: a handler who would get a 404 on it cannot work it.
    const handlerViewer = { membershipId: assigneeId, roleCodes: [...new Set(activeGrants(assignee, now).map((grant) => grant.roleCode))] };
    if ((await this.incidents.find(scope.tx, incident.id, handlerViewer)) === undefined) throw new DomainError('ASSIGNEE_OUT_OF_SCOPE', 422, 'assignee_user_id');
    const note = body.note?.normalize('NFC').trim();
    await this.incidents.assign(scope.tx, incident, { expectedVersion: scope.expectedVersion ?? 0, assigneeId, dueAt, note: note === '' ? undefined : note, actor: scope.tenant.membershipId });
    const version = incident.version + 1;
    await this.written(scope, incident, version, 'ASSIGNED', 'dgv.incident.assigned.v1', 'dgv.quality_incident_assigned', { from_status: incident.status, assignee_id: assigneeId, due_at: dueAt.toISOString() });
    return commandResult(scope, 'ASSIGNED', version, incident.id);
  }

  @Post('dgv/quality-incidents/:id/transition')
  @HttpCode(200)
  @OperationId('transitionQualityIncident')
  @Command({ operation: 'transitionQualityIncident', versioned: true })
  async transition(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DgvIncidentTransition']): Promise<CommandResult> {
    assertTenantAuthority(access, REMEDIATE);
    const to = INCIDENT_WORK_STATUSES.find((status) => status === body.to_status);
    if (to === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'to_status');
    const incident = await this.incidents.lock(scope.tx, id.toLowerCase(), viewerOf(scope.tenant, access));
    this.incidents.assertVersion(incident, scope.expectedVersion ?? 0);
    assertWorkStep(incident.status, to);
    // Only the handler works the incident.
    if (incident.assigneeId !== scope.tenant.membershipId) throw new DomainError('NOT_ASSIGNEE', 403);
    const resolving = to === 'RESOLVED_PENDING_VERIFICATION' ? resolutionText({ rootCause: body.root_cause, remediation: body.remediation }) : undefined;
    const note = body.note?.normalize('NFC').trim();
    await this.incidents.advance(scope.tx, incident, { expectedVersion: scope.expectedVersion ?? 0, to, rootCause: resolving?.rootCause, remediation: resolving?.remediation, note: note === '' ? undefined : note, actor: scope.tenant.membershipId, at: new Date() });
    const version = incident.version + 1;
    await this.written(scope, incident, version, to, 'dgv.incident.status_changed.v1', 'dgv.quality_incident_status_changed', { from_status: incident.status, to_status: to });
    return commandResult(scope, to, version, incident.id);
  }

  @Post('dgv/quality-incidents/:id/verification')
  @HttpCode(200)
  @OperationId('verifyQualityIncident')
  @Command({ operation: 'verifyQualityIncident', versioned: true })
  async verify(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DgvIncidentVerify']): Promise<CommandResult> {
    assertTenantAuthority(access, TRIAGE);
    const decision = INCIDENT_DECISIONS.find((candidate) => candidate === body.decision);
    if (decision === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'decision');
    const note = body.note.normalize('NFC').trim();
    if (note.length < 10) throw new DomainError('VALIDATION_FAILED', 422, 'note');
    const incident = await this.incidents.lock(scope.tx, id.toLowerCase(), viewerOf(scope.tenant, access));
    this.incidents.assertVersion(incident, scope.expectedVersion ?? 0);
    await this.incidents.verify(scope.tx, incident, { expectedVersion: scope.expectedVersion ?? 0, decision, note, verifier: scope.tenant.membershipId, at: new Date() });
    const version = incident.version + 1;
    const status = decision === 'CLOSE' ? 'CLOSED' : 'REOPENED';
    await this.written(scope, incident, version, status, decision === 'CLOSE' ? 'dgv.incident.closed.v1' : 'dgv.incident.reopened.v1', decision === 'CLOSE' ? 'dgv.quality_incident_closed' : 'dgv.quality_incident_reopened', {
      from_status: incident.status,
      verified_by: decision === 'CLOSE' ? scope.tenant.membershipId : null,
    });
    return commandResult(scope, status, version, incident.id);
  }

  @Post('quality-exceptions/:id/decision')
  @HttpCode(200)
  @OperationId('post_quality_exceptions_id_decision')
  @Command({ operation: 'post_quality_exceptions_id_decision', versioned: true })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DgvExceptionDecision']): Promise<CommandResult> {
    assertTenantAuthority(access, REVIEW);
    const decision = EXCEPTION_DECISIONS.find((candidate) => candidate === body.decision);
    if (decision === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'decision');
    const now = new Date();
    const exception = await this.incidents.lockException(scope.tx, id.toLowerCase(), viewerOf(scope.tenant, access));
    this.incidents.assertVersion(exception, scope.expectedVersion ?? 0);
    const judged = judgeExceptionDecision({
      decision,
      reason: body.reason,
      waiverExpiresAt: body.waiver_expires_at === undefined ? undefined : new Date(body.waiver_expires_at),
      now,
      ownerUserId: exception.ownerId,
      deciderUserId: scope.tenant.membershipId,
    });
    await this.incidents.decide(scope.tx, exception, { expectedVersion: scope.expectedVersion ?? 0, decision, reason: judged.reason, waiverExpiresAt: judged.waiverExpiresAt, decider: scope.tenant.membershipId, at: now });
    const version = exception.version + 1;
    // The record, the reason and the evidence stay in the exception; the audit and the event name ids and the decision.
    const facts = { decision, run_id: exception.runId, incident_id: exception.incidentId, waiver_expires_at: judged.waiverExpiresAt?.toISOString() ?? null };
    await scope.audit({ action: 'dgv.quality_exception_decided', resourceType: EXCEPTION_RESOURCE, resourceId: exception.id, reason: judged.reason, diff: facts });
    await scope.emit({
      aggregateType: EXCEPTION_RESOURCE,
      aggregateId: exception.id,
      aggregateVersion: version,
      type: 'dgv.exception.decided.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, exception_id: exception.id, version, ...facts, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${EXCEPTION_RESOURCE}:${exception.id}:${version}`,
    });
    return commandResult(scope, decision, version, exception.id);
  }

  /** The audit row and the event of a step of an incident: ids and facts, never the cause or the measure in the audit diff beyond the step. */
  private async written(scope: CommandScope, incident: IncidentRecord, version: number, status: string, type: string, action: string, facts: Record<string, unknown>): Promise<void> {
    await scope.audit({ action, resourceType: INCIDENT_RESOURCE, resourceId: incident.id, diff: { to_status: status, dataset_id: incident.datasetId, severity: incident.severity, ...facts } });
    await scope.emit({
      aggregateType: INCIDENT_RESOURCE,
      aggregateId: incident.id,
      aggregateVersion: version,
      type,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, incident_id: incident.id, dataset_id: incident.datasetId, version, status, ...facts, actor_id: scope.tenant.membershipId, occurred_at: new Date().toISOString() },
      eventKey: `${INCIDENT_RESOURCE}:${incident.id}:${version}`,
    });
  }
}

/** The incidents (the scaffold read of `quality_incident`): those of the datasets the viewer may see, with their history on the one that is opened. */
@Controller('resources/quality_incident')
export class QualityIncidentReadsController {
  private readonly incidents = new DgvIncidentStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_quality_incident')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('dataset_id') datasetId?: unknown,
    @Query('status') status?: unknown,
    @Query('severity') severity?: unknown,
    @Query('assignee_id') assigneeId?: unknown,
    @Query('overdue') overdue?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    if (overdue !== undefined && overdue !== 'true' && overdue !== 'false') throw new DomainError('VALIDATION_FAILED', 422, 'overdue');
    const filters = {
      datasetId: datasetId === undefined ? undefined : uuidOf(datasetId, 'dataset_id'),
      status: oneOf(INCIDENT_STATUSES, status, 'status'),
      severity: oneOf(SEVERITIES, severity, 'severity'),
      assigneeId: assigneeId === undefined ? undefined : uuidOf(assigneeId, 'assignee_id'),
      overdue: overdue === undefined ? undefined : overdue === 'true',
    };
    const now = new Date();
    const viewer = viewerOf(tenant, access);
    const rows = await this.database.withTenant(tenant, (tx) => this.incidents.list(tx, viewer, filters, { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map((incident) => incidentView(incident, access, tenant.membershipId, now)),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.sortKey, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }

  @Get(':id')
  @OperationId('get_resources_quality_incident_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const viewer = viewerOf(tenant, access);
    const found = await this.database.withTenant(tenant, async (tx) => {
      const incident = await this.incidents.find(tx, id.toLowerCase(), viewer);
      return incident === undefined ? undefined : { incident, events: await this.incidents.events(tx, incident.id) };
    });
    // An incident of a dataset the viewer may not see does not exist for them.
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const now = new Date();
    return { ...incidentView(found.incident, access, tenant.membershipId, now, found.events), as_of: now.toISOString() };
  }
}

/**
 * The exceptions (the scaffold read of `quality_exception`): listed for every dataset, the values of the record hidden where the viewer may not see the dataset (a national id reads `***2345`). There is no export of the
 * exceptions yet; when there is one, the rows of the datasets the viewer may not see are left out of it.
 */
@Controller('resources/quality_exception')
export class QualityExceptionReadsController {
  private readonly incidents = new DgvIncidentStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_quality_exception')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('dataset_id') datasetId?: unknown,
    @Query('status') status?: unknown,
    @Query('incident_id') incidentId?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    const filters = {
      datasetId: datasetId === undefined ? undefined : uuidOf(datasetId, 'dataset_id'),
      status: oneOf(['OPEN', 'RESOLVED', 'WAIVED'], status, 'status'),
      incidentId: incidentId === undefined ? undefined : uuidOf(incidentId, 'incident_id'),
    };
    const viewer = viewerOf(tenant, access);
    const rows = await this.database.withTenant(tenant, (tx) => this.incidents.listExceptions(tx, viewer, filters, { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map((exception) => exceptionView(exception, access, tenant.membershipId)),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.sortKey, id: last.id }) : null,
      as_of: new Date().toISOString(),
    };
  }

  @Get(':id')
  @OperationId('get_resources_quality_exception_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const viewer = viewerOf(tenant, access);
    const row = await this.database.withTenant(tenant, (tx) => this.incidents.findException(tx, id.toLowerCase(), viewer));
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { ...exceptionView(row, access, tenant.membershipId), as_of: new Date().toISOString() };
  }
}
