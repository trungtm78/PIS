import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { NotificationCampaignStore, TenantDatabase } from '@machvon/db';
import type { CampaignRecord, DeliveryEngine, TenantTx } from '@machvon/db';
import { DomainError, assertCampaignDraft, assertCampaignReason, assertCampaignSubmission, assertCampaignVerdict, campaignAfter } from '@machvon/kernel';
import type { CampaignSegment, EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { holdsOnWholeTenant } from '../../modules/adm/tenant-authority';
import { mayActOnUnit } from '../../modules/doc/unit-scope';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { dedupeKeyOf } from '../dedupe';
import { DELIVERY_ENGINE } from '../delivery/tokens';

const CAMPAIGN_RESOURCE = 'notification_campaign';
const APPROVED_EVENT = 'not.campaign.approved.v1';
const MANAGE = PERMISSIONS.createCampaign;
const APPROVE = PERMISSIONS.decideCampaign;
const READ = PERMISSIONS.getCampaign;

const STATUSES = ['Draft', 'Previewed', 'PendingApproval', 'Approved', 'Scheduled', 'Sending', 'Completed', 'Rejected', 'Cancelled'];

type Page = { items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string };

function viewOf(campaign: CampaignRecord): Schemas['CampaignView'] {
  return {
    id: campaign.id,
    name: campaign.name,
    purpose: campaign.purpose,
    template_version_id: campaign.templateVersionId,
    template_code: campaign.templateCode,
    template_channel: campaign.templateChannel,
    segment: { unit_ids: campaign.segment.unitIds, role_codes: campaign.segment.roleCodes, include_guests: campaign.segment.includeGuests, units: campaign.units },
    scheduled_at: campaign.scheduledAt,
    status: campaign.status,
    recipient_count: campaign.recipientCount,
    ...(campaign.excluded === null ? {} : { excluded: campaign.excluded }),
    preview_hash: campaign.previewHash,
    previewed_at: campaign.previewedAt,
    created_by: campaign.createdBy,
    created_at: campaign.createdAt,
    submitted_at: campaign.submittedAt,
    approved_by: campaign.approvedBy,
    approved_at: campaign.approvedAt,
    decided_by: campaign.decidedBy,
    decided_at: campaign.decidedAt,
    decision_reason: campaign.decisionReason,
    cancelled_at: campaign.cancelledAt,
    completed_at: campaign.completedAt,
    notification_count: campaign.notificationCount,
    waiting_count: campaign.waitingCount,
    version: campaign.version,
  } as Schemas['CampaignView'];
}

/**
 * The broadcast campaigns (ST-NOT-009, NOT-09, NOT-10, NOT-16, NOT 3.5, BR-NOT-12). A campaign is made as a draft, previewed (who gets it and who is left out, and why, with a hash of the set), sent to approval with that hash,
 * and approved by another person; the set is read again at the submit and at the decision, and a set that changed is 409 `PREVIEW_STALE`. Whoever makes a campaign names units within their own scope (or, for a segment of roles only, holds
 * the permission on the whole tenant). The approval makes the notifications, at the time of the campaign; the cancel stops what is not yet sent.
 */
@Controller()
export class CampaignsController {
  private readonly campaigns = new NotificationCampaignStore();

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Inject(DELIVERY_ENGINE) private readonly engine: DeliveryEngine,
  ) {}

  /** The units a segment names are within the scope of the person acting; a segment of roles alone has no unit to test and wants the whole tenant. */
  private async assertSegmentInScope(tx: TenantTx, access: EffectiveAccess, segment: CampaignSegment, now: Date): Promise<void> {
    if (segment.unitIds.length === 0) {
      if (!holdsOnWholeTenant(access, MANAGE)) throw new DomainError('SCOPE_DENIED', 403);
      return;
    }
    const units = await tx.query<{ id: string; path: string }>('select id, path from machvon.organization_unit where id = any($1::uuid[])', [segment.unitIds]);
    // A unit that is not there (or is another tenant's) is not found.
    if (units.length !== segment.unitIds.length) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'segment.unit_ids');
    // A unit of a segment stands for its whole subtree: the actor must hold the permission over every unit below it, not only over the one named (a grant on one unit alone does not reach its children).
    const subtree = await tx.query<{ id: string; path: string }>(
      'select o.id, o.path from machvon.organization_unit o where exists (select 1 from machvon.organization_unit s where s.id = any($1::uuid[]) and starts_with(o.path, s.path))',
      [segment.unitIds],
    );
    if (!subtree.every((unit) => mayActOnUnit(access, MANAGE, unit, now))) throw new DomainError('SCOPE_DENIED', 403);
  }

  @Post('notification-campaigns')
  @HttpCode(201)
  @OperationId('createCampaign')
  @Command({ operation: 'createCampaign' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['CampaignCreate']): Promise<CommandResult> {
    const now = new Date();
    const draft = assertCampaignDraft(body, now);
    await this.assertSegmentInScope(scope.tx, access, draft.segment, now);
    const made = await this.campaigns.create(scope.tx, scope.tenant.membershipId, draft);
    await scope.audit({
      action: 'notification.campaign_created',
      resourceType: CAMPAIGN_RESOURCE,
      resourceId: made.id,
      classification: 'INTERNAL',
      diff: { purpose: made.purpose, template_version_id: made.templateVersionId, channel: made.templateChannel, scheduled_at: made.scheduledAt, unit_count: made.segment.unitIds.length, role_count: made.segment.roleCodes.length },
    });
    return commandResult(scope, made.status.toUpperCase(), made.version, made.id);
  }

  @Post('notification-campaigns/:campaignId/preview')
  @HttpCode(200)
  @OperationId('previewCampaignRecipients')
  @Command({ operation: 'previewCampaignRecipients', versioned: true })
  async preview(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('campaignId', ParseUUIDPipe) id: string, @Body() body: Schemas['ReasonOnly']): Promise<Schemas['CampaignPreview']> {
    const reason = assertCampaignReason(body);
    const now = new Date();
    const campaign = await this.campaigns.lock(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0);
    campaignAfter(campaign.status, 'preview');
    await this.assertSegmentInScope(scope.tx, access, campaign.segment, now);
    const resolution = await this.campaigns.resolve(scope.tx, campaign, now);
    const saved = await this.campaigns.savePreview(scope.tx, campaign, resolution, now);
    await scope.audit({
      action: 'notification.campaign_previewed',
      resourceType: CAMPAIGN_RESOURCE,
      resourceId: saved.id,
      reason,
      classification: 'INTERNAL',
      // The counts and the hash: never the people.
      diff: { recipient_count: resolution.recipientIds.length, excluded: resolution.excluded, preview_hash: resolution.hash },
    });
    return {
      recipient_count: resolution.recipientIds.length,
      excluded: resolution.excluded,
      preview_hash: resolution.hash,
      sample_recipients_masked: await this.campaigns.maskedSamples(scope.tx, resolution.recipientIds),
      previewed_at: saved.previewedAt as string,
      version: saved.version,
    };
  }

  @Post('notification-campaigns/:campaignId/submit')
  @HttpCode(200)
  @OperationId('submitCampaign')
  @Command({ operation: 'submitCampaign', versioned: true })
  async submit(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('campaignId', ParseUUIDPipe) id: string, @Body() body: Schemas['CampaignSubmit']): Promise<CommandResult> {
    const submission = assertCampaignSubmission(body);
    const now = new Date();
    const campaign = await this.campaigns.lock(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0);
    campaignAfter(campaign.status, 'submit');
    await this.assertSegmentInScope(scope.tx, access, campaign.segment, now);
    // The set is read again: what was previewed, what the caller holds in hand, and what is true now must be the same set.
    const current = await this.campaigns.resolve(scope.tx, campaign, now);
    if (campaign.previewHash !== submission.previewHash || current.hash !== submission.previewHash) throw new DomainError('PREVIEW_STALE', 409, 'preview_hash');
    // A campaign that would write to nobody is not sent to approval.
    if (current.recipientIds.length === 0) throw new DomainError('SEGMENT_INVALID', 409, 'recipient_count');
    const moved = await this.campaigns.move(scope.tx, campaign.id, campaignAfter(campaign.status, 'submit'), { submittedAt: now });
    await scope.audit({
      action: 'notification.campaign_submitted',
      resourceType: CAMPAIGN_RESOURCE,
      resourceId: moved.id,
      ...(submission.reason === undefined ? {} : { reason: submission.reason }),
      classification: 'INTERNAL',
      diff: { recipient_count: current.recipientIds.length, preview_hash: current.hash },
    });
    return commandResult(scope, moved.status.toUpperCase(), moved.version, moved.id);
  }

  @Post('notification-campaigns/:campaignId/decision')
  @HttpCode(200)
  @OperationId('decideCampaign')
  @Command({ operation: 'decideCampaign', versioned: true })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('campaignId', ParseUUIDPipe) id: string, @Body() body: Schemas['Decision']): Promise<CommandResult> {
    if (!holdsOnWholeTenant(access, APPROVE)) throw new DomainError('SCOPE_DENIED', 403);
    const verdict = assertCampaignVerdict(body);
    const now = new Date();
    const approver = scope.tenant.membershipId;
    const campaign = await this.campaigns.lock(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0);
    if (campaign.status !== 'PendingApproval') throw new DomainError('CAMPAIGN_STATE_INVALID', 409, 'status');
    // Maker-checker: the person who made the campaign neither approves it nor sends it back or rejects it, and a second membership of the same person is the same person.
    if (await this.campaigns.samePerson(scope.tx, campaign.createdBy, approver)) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    const patch = { decidedBy: approver, decidedAt: now, decisionReason: verdict.reason };
    if (verdict.decision !== 'approve') {
      const moved = await this.campaigns.move(scope.tx, campaign.id, campaignAfter(campaign.status, verdict.decision), patch);
      await scope.audit({
        action: 'notification.campaign_decided',
        resourceType: CAMPAIGN_RESOURCE,
        resourceId: moved.id,
        reason: verdict.reason,
        classification: 'INTERNAL',
        diff: { decision: verdict.decision, preview_hash: campaign.previewHash, evidence_ids: verdict.evidenceIds },
      });
      return commandResult(scope, moved.status.toUpperCase(), moved.version, moved.id);
    }
    // The set is read again: the approval is for the set that was previewed, not for the set that is there now.
    const current = await this.campaigns.resolve(scope.tx, campaign, now);
    if (campaign.previewHash === null || current.hash !== campaign.previewHash) throw new DomainError('PREVIEW_STALE', 409, 'preview_hash');
    const template = await scope.tx.query<{ status: string }>('select status from machvon.notification_template_version where id = $1::uuid', [campaign.templateVersionId]);
    if (template[0]?.status !== 'Active') throw new DomainError('TEMPLATE_INVALID', 422, 'template_version_id');
    await this.campaigns.move(scope.tx, campaign.id, campaignAfter(campaign.status, 'approve'), { ...patch, approvedBy: approver, approvedAt: now });
    const made = await this.campaigns.launch(scope.tx, campaign, current.recipientIds, { approver, now, dedupeKeyOf: (recipientId) => dedupeKeyOf({ tenantId: scope.tenant.tenantId, sourceEventId: campaign.id, recipientId, purpose: campaign.purpose }) });
    // A time still ahead: Scheduled until it comes; no time, or one gone by: the sends are due and the campaign is Sending.
    const later = campaign.scheduledAt !== null && new Date(campaign.scheduledAt).getTime() > now.getTime();
    const moved = await this.campaigns.move(scope.tx, campaign.id, campaignAfter('Approved', later ? 'schedule' : 'start'), { notificationCount: made });
    await scope.audit({
      action: 'notification.campaign_decided',
      resourceType: CAMPAIGN_RESOURCE,
      resourceId: moved.id,
      reason: verdict.reason,
      classification: 'INTERNAL',
      diff: { decision: 'approve', preview_hash: campaign.previewHash, recipient_count: current.recipientIds.length, notification_count: made, evidence_ids: verdict.evidenceIds },
    });
    await scope.emit({
      aggregateType: CAMPAIGN_RESOURCE,
      aggregateId: moved.id,
      aggregateVersion: moved.version,
      type: APPROVED_EVENT,
      schemaVersion: 1,
      payload: { campaign_id: moved.id, purpose: moved.purpose, channel: moved.templateChannel, recipient_count: made, scheduled_at: moved.scheduledAt, approved_by: approver },
      eventKey: `${APPROVED_EVENT}:${moved.id}`,
    });
    return commandResult(scope, moved.status.toUpperCase(), moved.version, moved.id);
  }

  @Post('notification-campaigns/:campaignId/cancel')
  @HttpCode(200)
  @OperationId('cancelCampaign')
  @Command({ operation: 'cancelCampaign', versioned: true })
  async cancel(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('campaignId', ParseUUIDPipe) id: string, @Body() body: Schemas['ReasonOnly']): Promise<CommandResult> {
    const reason = assertCampaignReason(body);
    const now = new Date();
    const campaign = await this.campaigns.lock(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0);
    const next = campaignAfter(campaign.status, 'cancel');
    await this.assertSegmentInScope(scope.tx, access, campaign.segment, now);
    // What was not yet sent is cancelled with its waiting sends; what is going out right now is asked to stop the way a single notification is.
    const stopped = await this.campaigns.cancelWaiting(scope.tx, campaign.id);
    for (const going of stopped.inFlight) await this.engine.cancel(scope.tx, { notificationId: going.id, expectedVersion: going.version, now });
    const moved = await this.campaigns.move(scope.tx, campaign.id, next, { cancelledAt: now, decisionReason: reason });
    await scope.audit({
      action: 'notification.campaign_cancelled',
      resourceType: CAMPAIGN_RESOURCE,
      resourceId: moved.id,
      reason,
      classification: 'INTERNAL',
      diff: { from: campaign.status, cancelled_notifications: stopped.cancelled, in_flight: stopped.inFlight.length },
    });
    return commandResult(scope, moved.status.toUpperCase(), moved.version, moved.id);
  }

  @Get('notification-campaigns')
  @OperationId('listCampaigns')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('status') status?: unknown, @Query('limit') limit?: unknown, @Query('cursor') cursor?: unknown): Promise<Page> {
    if (status !== undefined && (typeof status !== 'string' || !STATUSES.includes(status))) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const request = parsePageRequest(limit, cursor);
    const rows = await this.database.withTenant(tenant, (tx) => this.campaigns.list(tx, { status, createdBy: holdsOnWholeTenant(access, READ) ? undefined : tenant.membershipId }, { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(viewOf), next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.sortKey, id: last.id }) : null, as_of: new Date().toISOString() };
  }

  @Get('notification-campaigns/:campaignId')
  @OperationId('getCampaign')
  async read(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('campaignId', ParseUUIDPipe) id: string): Promise<Schemas['CampaignView']> {
    const campaign = await this.database.withTenant(tenant, (tx) => this.campaigns.require(tx, id.toLowerCase()));
    // Whoever does not read the campaigns of the whole tenant reads their own; another person's is as good as not there.
    if (!holdsOnWholeTenant(access, READ) && campaign.createdBy !== tenant.membershipId) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return viewOf(campaign);
  }
}
