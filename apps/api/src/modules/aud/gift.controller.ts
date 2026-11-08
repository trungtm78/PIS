import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { GiftStore, TenantDatabase } from '@machvon/db';
import type { GiftRow } from '@machvon/db';
import { GIFT_STATUSES } from '@machvon/kernel';
import type { EffectiveAccess, GiftOutcome, GiftStatus, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { assertWholeTenant, oneOfQuery, pageOf, todayOf, uuidQuery } from '../gov12-support';

const RESOURCE = 'gift_register';

const view = (row: GiftRow): Record<string, unknown> => ({
  id: row.id,
  recipient_id: row.recipientId,
  declared_by: row.declaredBy,
  giver_name: row.giverName,
  giver_kind: row.giverKind,
  project_id: row.projectId,
  description: row.description,
  value_vnd: row.valueVnd,
  received_on: row.receivedOn,
  declared_on: row.declaredOn,
  status: row.status,
  reviewer_id: row.reviewerId,
  outcome: row.outcome,
  outcome_note: row.outcomeNote,
  closed_on: row.closedOn,
  // The flags were fixed with the rule of the day of the declaration (rule_version 0 is the built-in default, UNVERIFIED).
  flags: { late: row.reading.late, declare_due_on: row.reading.declareDueOn, needs_review: row.reading.needsReview, may_be_kept: row.reading.mayBeKept },
  rule_version: row.ruleVersion,
  version: row.version,
});

/**
 * The gifts register (G4-12). A person declares a gift that they received because of their work; the flags (late, needs a review, may be kept) are those of the rule of the day of the declaration. A second person takes the
 * review and closes it: kept only up to the line, otherwise returned or handed to the unit; the recipient never reviews their own gift.
 */
@Controller()
export class GiftController {
  private readonly store = new GiftStore();

  @Post('gifts')
  @HttpCode(200)
  @OperationId('declareGift')
  @Command({ operation: 'declareGift' })
  async declare(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['DeclareGift']): Promise<CommandResult> {
    assertWholeTenant(access, PERMISSIONS.declareGift);
    const gift = await this.store.declare(
      scope.tx,
      { recipientId: body.recipient_id.toLowerCase(), giverName: body.giver_name, giverKind: body.giver_kind, projectId: body.project_id === undefined ? null : body.project_id.toLowerCase(), description: body.description, valueVnd: body.value_vnd, receivedOn: body.received_on },
      scope.tenant.membershipId,
      todayOf(new Date()),
    );
    await this.record(scope, 'aud.gift_declared', gift, 'aud.gift.declared.v1', { late: gift.reading.late, needs_review: gift.reading.needsReview, may_be_kept: gift.reading.mayBeKept, giver_kind: gift.giverKind });
    return commandResult(scope, gift.status, gift.version, gift.id);
  }

  @Post('gifts/:id/take')
  @HttpCode(200)
  @OperationId('takeGiftReview')
  @Command({ operation: 'takeGiftReview', versioned: true })
  async take(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    assertWholeTenant(access, PERMISSIONS.takeGiftReview);
    const gift = await this.store.take(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, scope.tenant.membershipId, todayOf(new Date()));
    await this.record(scope, 'aud.gift_review_taken', gift, 'aud.gift.review_taken.v1', {});
    return commandResult(scope, gift.status, gift.version, gift.id);
  }

  @Post('gifts/:id/close')
  @HttpCode(200)
  @OperationId('closeGift')
  @Command({ operation: 'closeGift', versioned: true })
  async close(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CloseGift']): Promise<CommandResult> {
    assertWholeTenant(access, PERMISSIONS.closeGift);
    const gift = await this.store.close(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, body.outcome as GiftOutcome, body.note, scope.tenant.membershipId, todayOf(new Date()));
    await this.record(scope, 'aud.gift_closed', gift, 'aud.gift.closed.v1', { outcome: gift.outcome }, body.note);
    return commandResult(scope, gift.status, gift.version, gift.id);
  }

  private async record(scope: CommandScope, action: string, gift: GiftRow, event: string, facts: Record<string, unknown>, reason?: string): Promise<void> {
    await scope.audit({ action, resourceType: RESOURCE, resourceId: gift.id, classification: 'CONFIDENTIAL', diff: { status: gift.status, value_vnd: gift.valueVnd, ...facts }, ...(reason === undefined ? {} : { reason: reason.trim() }) });
    await scope.emit({ aggregateType: RESOURCE, aggregateId: gift.id, aggregateVersion: gift.version, type: event, schemaVersion: 1, payload: { tenant_id: scope.tenant.tenantId, gift_id: gift.id, status: gift.status, actor_id: scope.tenant.membershipId, ...facts }, eventKey: `${RESOURCE}:${gift.id}:${gift.version}` });
  }
}

/** The gifts register, read. */
@Controller()
export class GiftReadsController {
  private readonly store = new GiftStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('gifts')
  @OperationId('listGifts')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('status') status?: unknown, @Query('recipient_id') recipient?: unknown, @Query('limit') limit?: unknown, @Query('offset') offset?: unknown): Promise<Record<string, unknown>> {
    assertWholeTenant(access, PERMISSIONS.listGifts);
    const page = pageOf(limit, offset);
    const today = todayOf(new Date());
    const filter = { status: oneOfQuery<GiftStatus>(status, GIFT_STATUSES, 'status'), recipientId: uuidQuery(recipient, 'recipient_id') };
    const found = await this.database.withTenant(tenant, async (tx) => ({ rows: await this.store.list(tx, { ...filter, limit: page.limit + 1, offset: page.offset }), policy: await this.store.policy(tx, today) }));
    return {
      as_of: today,
      items: found.rows.slice(0, page.limit).map(view),
      has_more: found.rows.length > page.limit,
      rule: { version: found.policy.version, unverified: found.policy.unverified, declare_within_days: found.policy.policy.declare_within_days, review_over_vnd: found.policy.policy.review_over_vnd, keep_up_to_vnd: found.policy.policy.keep_up_to_vnd },
    };
  }
}
