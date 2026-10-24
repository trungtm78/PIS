import { Body, Controller, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DIS_PERIOD_REOPEN_METRIC, DisPeriodReopenStore, reopenLabels, reopenRecord } from '@machvon/db';
import type { ProjectPlace, ReopenOutcome, ReopenWithPeriod } from '@machvon/db';
import { DomainError, NOOP_METRICS, effectivePermissions, holdsPermission } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink, ResourceRef } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { DIS_CLOCK, DIS_METRICS } from './tokens';

const REQUEST_PERMISSION = PERMISSIONS.requestPeriodReopen;
const DECIDE_PERMISSION = PERMISSIONS.decidePeriodReopen;

/** The places a project lies in for the test of scope: the units that own and invest in it, each with the project. */
function placeRefs(place: ProjectPlace): ResourceRef[] {
  const units = place.investorUnit === null ? [place.ownerUnit] : [place.ownerUnit, place.investorUnit];
  return units.map((unit) => ({ ownerUnitPath: unit.path, ownerUnitId: unit.id, projectId: place.id }));
}

/**
 * The reopening of a locked reporting period (ST-DIS-002, DIS 3 F4). A maker asks with a reason, a scope and a window; a different person
 * with the approver permission decides. The period is never changed: it stays LOCKED, and an approval opens a window for the projects it
 * names, or for the whole period, that the submit guard honours until the window ends.
 *
 * Scope of authority: a request for named projects is within the reach of the requester over each project (the owner or the investor unit
 * is in the scope of their grant); a request for the whole period, and every decision, lie with the whole tenant (DIS 2), since a period
 * belongs to no unit and the window can open other units' projects.
 */
@Controller()
export class PeriodReopenController {
  private readonly reopens = new DisPeriodReopenStore();
  private readonly metrics: MetricsSink;
  private readonly clock: () => Date;

  constructor(@Optional() @Inject(DIS_METRICS) metrics?: MetricsSink, @Optional() @Inject(DIS_CLOCK) clock?: () => Date) {
    this.metrics = metrics ?? NOOP_METRICS;
    this.clock = clock ?? ((): Date => new Date());
  }

  @Post('reporting-periods/:id/reopen-requests')
  @HttpCode(200)
  @OperationId('requestPeriodReopen')
  @Command({ operation: 'requestPeriodReopen' })
  async request(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['DisReopenRequest'],
  ): Promise<CommandResult> {
    const now = this.clock();
    if (body.scope_kind === 'PERIOD' && !holdsOnWholeTenant(access, REQUEST_PERMISSION)) throw new DomainError('SCOPE_DENIED', 403);
    const done = await this.reopens.request(
      scope.tx,
      { periodId: id, scopeKind: body.scope_kind, projectIds: body.project_ids ?? [], reason: body.reason, windowHours: body.window_hours },
      scope.tenant.membershipId,
      now,
      (place) => placeRefs(place).some((ref) => holdsPermission(effectivePermissions(access, now, ref), REQUEST_PERMISSION)),
    );
    return this.recorded(scope, 'requested', done, done.reopen.reason);
  }

  @Post('period-reopens/:id/decision')
  @HttpCode(200)
  @OperationId('decidePeriodReopen')
  @Command({ operation: 'decidePeriodReopen', versioned: true })
  async decide(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['DisReopenDecision'],
  ): Promise<CommandResult> {
    if (!holdsOnWholeTenant(access, DECIDE_PERMISSION)) throw new DomainError('SCOPE_DENIED', 403);
    const done = await this.reopens.decide(
      scope.tx,
      id,
      scope.expectedVersion ?? 0,
      { decision: body.decision, reason: body.reason, windowHours: body.window_hours },
      scope.tenant.membershipId,
      this.clock(),
    );
    return this.recorded(scope, body.decision === 'approve' ? 'approved' : 'rejected', done, done.reopen.decisionReason ?? '');
  }

  /** The audit row, the event of an approval and the counter of a step, built by the same function as the job's. */
  private async recorded(scope: CommandScope, outcome: ReopenOutcome, done: ReopenWithPeriod, reason: string): Promise<CommandResult> {
    const record = reopenRecord(outcome, done.reopen, done.period, reason);
    await scope.audit(record.audit);
    if (record.event !== undefined) await scope.emit(record.event);
    scope.afterCommit(() => this.metrics.increment(DIS_PERIOD_REOPEN_METRIC, reopenLabels(outcome)));
    return commandResult(scope, done.reopen.status, done.reopen.version, done.reopen.id);
  }
}
