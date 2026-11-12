import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BiDashboardStore, BiPolicyStore, BiMetricStore, BiPublicationStore, TenantDatabase } from '@machvon/db';
import type { PublicationRow } from '@machvon/db';
import { DomainError, PUBLICATION_KINDS, assertApproverIsNotChecker, assertCheckerIsIndependent, assertDecisionReason, asUuid, versionConflict } from '@machvon/kernel';
import type { EffectiveAccess, PublicationDecision, PublicationKind, TenantContext } from '@machvon/kernel';
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
import { PublicationChecks } from './publication-checks';
import type { Judged } from './publication-checks';

const RESOURCE_TYPE = 'bi_publication_request';
const STATUSES: readonly string[] = ['PENDING', 'DECIDED', 'WITHDRAWN'];

export const publicationView = (row: PublicationRow): Record<string, unknown> => ({
  id: row.id,
  object_kind: row.objectKind,
  object_id: row.objectId,
  object_code: row.objectCode,
  object_revision: row.objectRevision,
  requested_by: { id: row.requestedBy, name: row.requestedByName },
  checks: row.checks,
  status: row.status,
  decision: row.decision,
  decided_by: row.decidedBy === null ? null : { id: row.decidedBy, name: row.decidedByName },
  decided_at: row.decidedAt,
  comment: row.comment,
  checked_by: row.checkedBy === null ? null : { id: row.checkedBy, name: row.checkedByName },
  checked_at: row.checkedAt,
  check_comment: row.checkComment,
  created_at: row.createdAt,
  version: row.version,
});

/**
 * What a decision does to the object a request is about: a metric is certified, a version of a dashboard is published, a policy is made active. The store of the object refuses the one who wrote it (SELF_APPROVAL_DENIED),
 * and what moved is told on the audit trail and, for the dashboard and the policy, as an event.
 */
async function approve(scope: CommandScope, judged: Judged, actor: string): Promise<void> {
  const { subject } = judged;
  if (subject.kind === 'METRIC') {
    const certified = await new BiMetricStore().certify(scope.tx, subject.metric.id, actor);
    await scope.audit({ action: 'bi.metric.certify', resourceType: 'metric_definition', resourceId: certified.id, diff: { code: certified.code, revision: certified.revision, checks: judged.checks } });
    return;
  }
  if (subject.kind === 'DASHBOARD') {
    const published = await new BiDashboardStore().publishVersion(scope.tx, subject.version.id, actor);
    await scope.audit({ action: 'bi.dashboard.publish', resourceType: 'dashboard', resourceId: published.dashboard.id, diff: { code: published.dashboard.code, revision: published.version.revision, version_id: published.version.id } });
    await scope.emit({
      aggregateType: 'dashboard',
      aggregateId: published.dashboard.id,
      aggregateVersion: published.dashboard.version,
      type: 'bi.dashboard.published.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, dashboard_id: published.dashboard.id, dashboard_version_id: published.version.id, revision: published.version.revision, actor_id: actor, occurred_at: new Date().toISOString() },
      eventKey: `dashboard:${published.dashboard.id}:${published.dashboard.version}`,
    });
    return;
  }
  const policy = await new BiPolicyStore().activate(scope.tx, subject.policy.id, actor);
  await scope.audit({ action: 'bi.policy.activate', resourceType: 'bi_access_policy', resourceId: policy.id, diff: { dataset_id: policy.datasetId, grantee_kind: policy.granteeKind, revision: policy.revision } });
  await scope.emit({
    aggregateType: 'bi_access_policy',
    aggregateId: policy.id,
    aggregateVersion: policy.version,
    type: 'bi.policy.activated.v1',
    schemaVersion: 1,
    payload: { tenant_id: scope.tenant.tenantId, policy_id: policy.id, dataset_id: policy.datasetId, grantee_kind: policy.granteeKind, revision: policy.revision, actor_id: actor, occurred_at: new Date().toISOString() },
    eventKey: `bi_access_policy:${policy.id}:${policy.version}`,
  });
}

/**
 * The decision on a request that is pending, by someone who is not who asked: approving runs the checks again and then does what was asked; the decision is written whichever it is. The caller holds the lock of the
 * object (a dashboard and its version before the request, the one order of both ways to approve a dashboard); the request is locked and read again here, so a decision made in between is seen.
 */
async function settle(scope: CommandScope, seen: PublicationRow, decision: PublicationDecision, comment: string | null, expectedVersion?: number): Promise<PublicationRow> {
  const actor = scope.tenant.membershipId;
  const request = await new BiPublicationStore().lock(scope.tx, seen.id);
  if (request === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
  if (expectedVersion !== undefined && request.version !== expectedVersion) throw versionConflict(request.version);
  if (request.status !== 'PENDING') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
  if (request.requestedBy === actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
  // Three people, not two: who checked the request does not decide it (the database holds the same rule).
  assertApproverIsNotChecker(actor, request.checkedBy);
  const store = new BiPublicationStore();
  if (decision === 'APPROVED') await approve(scope, await new PublicationChecks().judge(scope.tx, request.objectKind, request.objectId), actor);
  const decided = await store.decide(scope.tx, request.id, { decision, decidedBy: actor, comment });
  await scope.audit({
    action: 'bi.publication.decide',
    resourceType: RESOURCE_TYPE,
    resourceId: decided.id,
    diff: { object_kind: decided.objectKind, object_id: decided.objectId, decision, requested_by: decided.requestedBy, checks: decided.checks.map((check) => check.code), reason: comment },
  });
  await scope.emit({
    aggregateType: RESOURCE_TYPE,
    aggregateId: decided.id,
    aggregateVersion: decided.version,
    type: 'bi.publication.decided.v1',
    schemaVersion: 1,
    payload: { tenant_id: scope.tenant.tenantId, request_id: decided.id, object_kind: decided.objectKind, object_id: decided.objectId, decision, requested_by: decided.requestedBy, actor_id: actor, occurred_at: new Date().toISOString() },
    eventKey: `${RESOURCE_TYPE}:${decided.id}:${decided.version}`,
  });
  return decided;
}

/**
 * The requests to publish (ST-BI-006, BI 3 F5): to certify a metric, to publish a version of a dashboard, to activate an access policy. Asking runs the checks (a metric is rerun over the latest frozen snapshot, a version
 * names certified metrics and frozen versions only); deciding, by someone other than who asked, runs them again and does what was asked. One request is pending for an object at a time.
 */
@Controller()
export class PublicationController {
  private readonly publications = new BiPublicationStore();
  private readonly dashboards = new BiDashboardStore();
  private readonly checks = new PublicationChecks();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Post('bi/publication-requests')
  @HttpCode(200)
  @OperationId('submitBiPublication')
  @Command({ operation: 'submitBiPublication' })
  async submit(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['BiPublicationRequest']): Promise<CommandResult & { checks: Array<{ code: string; passed: boolean }> }> {
    const actor = scope.tenant.membershipId;
    const kind = body.object_kind as PublicationKind;
    const objectId = asUuid(body.object_id);
    if (objectId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'object_id');
    // A metric and a policy are the tenant's; a version of a dashboard is asked for by the one who owns the dashboard.
    if (kind !== 'DASHBOARD' && !holdsOnWholeTenant(access, PERMISSIONS.submitBiPublication)) throw new DomainError('SCOPE_DENIED', 403);
    if (kind === 'DASHBOARD') {
      const held = await this.dashboards.lockVersion(scope.tx, objectId);
      const seen = held === undefined ? undefined : await this.dashboards.find(scope.tx, held.dashboard.id, actor);
      if (held === undefined || seen === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      if (held.dashboard.ownerUserId !== actor) throw new DomainError('SCOPE_DENIED', 403);
    }
    if ((await this.publications.pendingFor(scope.tx, kind, objectId)) !== undefined) throw new DomainError('PUBLICATION_ALREADY_PENDING', 409, 'object_id');
    const judged = await this.checks.judge(scope.tx, kind, objectId);
    const created = await this.publications.create(scope.tx, { kind, objectId, requestedBy: actor, checks: judged.checks });
    await scope.audit({ action: 'bi.publication.request', resourceType: RESOURCE_TYPE, resourceId: created.id, diff: { object_kind: kind, object_id: objectId, checks: judged.checks.map((check) => check.code) } });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: 'bi.publication.requested.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, request_id: created.id, object_kind: kind, object_id: objectId, requested_by: actor, occurred_at: new Date().toISOString() },
      eventKey: `${RESOURCE_TYPE}:${created.id}:${created.version}`,
    });
    return { ...commandResult(scope, created.status, created.version, created.id), checks: created.checks };
  }

  @Post('bi/publication-requests/:id/decision')
  @HttpCode(200)
  @OperationId('decideBiPublication')
  @Command({ operation: 'decideBiPublication', versioned: true })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['BiPublicationDecision']): Promise<CommandResult> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.decideBiPublication)) throw new DomainError('SCOPE_DENIED', 403);
    const seen = await this.publications.find(scope.tx, id.toLowerCase());
    if (seen === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (seen.version !== scope.expectedVersion) throw versionConflict(seen.version);
    const decision = body.decision as PublicationDecision;
    const comment = assertDecisionReason(decision, body.comment);
    // The dashboard and its version are locked before the request, as the approval of the layout locks them.
    if (seen.objectKind === 'DASHBOARD') await this.dashboards.lockVersion(scope.tx, seen.objectId);
    const decided = await settle(scope, seen, decision, comment, scope.expectedVersion ?? undefined);
    return commandResult(scope, decided.status, decided.version, decided.id);
  }

  /**
   * The check step (BC.02): somebody who is not who asked and not who wrote the version looks at the request and says so, once, while it is pending. The request stays pending: the decision is another person's. The step is
   * optional, a request that is decided without it is the two-person flow of before and its block of signatures says the check was not taken.
   */
  @Post('bi/publication-requests/:id/check')
  @HttpCode(200)
  @OperationId('checkBiPublication')
  @Command({ operation: 'checkBiPublication', versioned: true })
  async check(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['BiPublicationCheck']): Promise<CommandResult> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.checkBiPublication)) throw new DomainError('SCOPE_DENIED', 403);
    const seen = await this.publications.find(scope.tx, id.toLowerCase());
    if (seen === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (seen.version !== scope.expectedVersion) throw versionConflict(seen.version);
    // The dashboard and its version are locked before the request, as a decision locks them.
    const held = seen.objectKind === 'DASHBOARD' ? await this.dashboards.lockVersion(scope.tx, seen.objectId) : undefined;
    const request = await this.publications.lock(scope.tx, seen.id);
    if (request === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (request.version !== scope.expectedVersion) throw versionConflict(request.version);
    if (request.status !== 'PENDING' || request.checkedBy !== null) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    const actor = scope.tenant.membershipId;
    assertCheckerIsIndependent(actor, { requestedBy: request.requestedBy, preparedBy: held?.version.createdBy ?? null });
    const comment = body.comment === undefined || body.comment.trim() === '' ? null : body.comment.trim().normalize('NFC');
    const checked = await this.publications.check(scope.tx, request.id, { checkedBy: actor, comment });
    await scope.audit({ action: 'bi.publication.check', resourceType: RESOURCE_TYPE, resourceId: checked.id, diff: { object_kind: checked.objectKind, object_id: checked.objectId, requested_by: checked.requestedBy, comment } });
    return commandResult(scope, checked.status, checked.version, checked.id);
  }

  @Get('bi/publication-requests')
  @OperationId('listBiPublicationRequests')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('status') status?: unknown,
    @Query('object_kind') objectKind?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    // The inbox is the approver's, over the whole tenant: a request about a metric or a policy is not something a unit sees.
    if (!holdsOnWholeTenant(access, PERMISSIONS.listBiPublicationRequests)) throw new DomainError('SCOPE_DENIED', 403);
    const request = parsePageRequest(limit, cursor);
    if (status !== undefined && (typeof status !== 'string' || !STATUSES.includes(status))) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    if (objectKind !== undefined && (typeof objectKind !== 'string' || !PUBLICATION_KINDS.includes(objectKind as PublicationKind))) throw new DomainError('VALIDATION_FAILED', 422, 'object_kind');
    const page = await this.database.withTenant(tenant, (tx) => this.publications.list(tx, { status: status as string | undefined, objectKind: objectKind as string | undefined }, { limit: request.limit, after: request.after === undefined ? undefined : { at: request.after.code, id: request.after.id } }));
    return { items: page.records.map(publicationView), next_cursor: page.next === undefined ? null : encodeCursor({ code: page.next.at, id: page.next.id }) };
  }
}

/**
 * The approval of the layout of a dashboard (the baseline operation under the decision of a request, ST-BI-006): the version the dashboard points to, a draft, is judged by the same checks and published by someone
 * other than who saved it. A request pending for that version is decided by the same act, so none is left behind; to return or reject asks for the pending request and decides it.
 */
@Controller()
export class DashboardPublishController {
  private readonly publications = new BiPublicationStore();
  private readonly dashboards = new BiDashboardStore();
  private readonly checks = new PublicationChecks();

  @Post('dashboards/:id/publish')
  @HttpCode(200)
  @OperationId('post_dashboards_id_publish')
  @Command({ operation: 'post_dashboards_id_publish', versioned: true })
  async publish(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['Decision']): Promise<CommandResult> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.post_dashboards_id_publish)) throw new DomainError('SCOPE_DENIED', 403);
    const dashboard = await this.dashboards.lock(scope.tx, id.toLowerCase());
    if (dashboard === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (dashboard.version !== scope.expectedVersion) throw versionConflict(dashboard.version);
    if (dashboard.currentVersionId === null) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    await this.dashboards.lockVersion(scope.tx, dashboard.currentVersionId);
    const pending = await this.publications.pendingFor(scope.tx, 'DASHBOARD', dashboard.currentVersionId);
    const actor = scope.tenant.membershipId;
    if (body.decision !== 'approve') {
      if (pending === undefined) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
      await settle(scope, pending, 'REJECTED', body.reason.trim().normalize('NFC'));
      return commandResult(scope, dashboard.status, dashboard.version, dashboard.id);
    }
    if (pending !== undefined) {
      await settle(scope, pending, 'APPROVED', body.reason.trim().normalize('NFC'));
    } else {
      await approve(scope, await this.checks.judge(scope.tx, 'DASHBOARD', dashboard.currentVersionId), actor);
    }
    const published = await this.dashboards.lock(scope.tx, dashboard.id);
    return commandResult(scope, (published as NonNullable<typeof published>).status, (published as NonNullable<typeof published>).version, dashboard.id);
  }
}
