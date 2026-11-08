import { Body, Controller, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { CommitteeAlertStore, CommitteeDecisionStore, CommitteeRosterStore } from '@machvon/db';
import type { AuditClassification, CommitteeAlertRow, ProvinceFactsReader } from '@machvon/db';
import { COMMITTEE_CLASSIFICATION, COMMITTEE_ROSTER_CLASSIFICATION, DomainError, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { CommitteeWorkspaceService } from './committee-service';
import { alertDto } from './committee-view';
import { COMMITTEE_CLOCK, COMMITTEE_FACTS_READER } from './tokens';

const COMMITTEE = 'committee';
const MEMBER = 'committee_member';
const DECISION = 'committee_attention_decision';
const ALERT = 'committee_alert';

/**
 * The commands of the committee (lane BAN-1): the roster of the steering committee, the decisions of the Ban on the projects that need the head, and the alerts. Each needs its permission over the whole tenant, is
 * idempotent and audited, and writes an event. None of them writes a financial table: a decision records that the head saw a project or gave a directive (the directive itself is given through the commands of DIR).
 */
@Controller()
export class CommitteeController {
  private readonly roster = new CommitteeRosterStore();
  private readonly decisions = new CommitteeDecisionStore();
  private readonly alerts = new CommitteeAlertStore();
  private readonly service: CommitteeWorkspaceService;
  private readonly clock: () => Date;

  constructor(@Optional() @Inject(COMMITTEE_FACTS_READER) reader?: ProvinceFactsReader, @Optional() @Inject(COMMITTEE_CLOCK) clock?: () => Date) {
    this.service = new CommitteeWorkspaceService(reader);
    this.clock = clock ?? ((): Date => new Date());
  }

  private assertWhole(access: EffectiveAccess, permission: string): void {
    if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
  }

  private async record(scope: CommandScope, input: { action: string; resource: string; id: string; version: number; type: string; classification: AuditClassification; facts: Record<string, unknown>; reason?: string | undefined }): Promise<void> {
    await scope.audit({ action: input.action, resourceType: input.resource, resourceId: input.id, classification: input.classification, ...(input.reason === undefined ? {} : { reason: input.reason }), diff: { ...input.facts, version: input.version } });
    await scope.emit({
      aggregateType: input.resource,
      aggregateId: input.id,
      aggregateVersion: input.version,
      type: input.type,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, ...input.facts, version: input.version, actor_id: scope.tenant.membershipId, occurred_at: this.clock().toISOString() },
      eventKey: `${input.resource}:${input.id}:${input.version}:${input.action}`,
    });
  }

  @Post('committee/roster')
  @HttpCode(200)
  @OperationId('registerCommittee')
  @Command({ operation: 'registerCommittee' })
  async register(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['CommitteeRegister']): Promise<CommandResult> {
    this.assertWhole(access, PERMISSIONS.registerCommittee);
    const done = await this.roster.register(scope.tx, { code: body.code, name: body.name, legalBasis: body.legal_basis }, scope.tenant.membershipId);
    await this.record(scope, { action: 'committee.registered', resource: COMMITTEE, id: done.id, version: done.version, type: 'committee.registered.v1', classification: COMMITTEE_CLASSIFICATION, facts: { code: done.code } });
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('committee/roster/members')
  @HttpCode(200)
  @OperationId('appointCommitteeMember')
  @Command({ operation: 'appointCommitteeMember' })
  async appoint(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['CommitteeAppoint']): Promise<CommandResult> {
    this.assertWhole(access, PERMISSIONS.appointCommitteeMember);
    const done = await this.roster.appoint(
      scope.tx,
      { committeeId: body.committee_id, membershipId: body.membership_id, committeeRole: body.committee_role, agencyCode: body.agency_code, agencyName: body.agency_name, decisionRef: body.decision_ref, validFrom: body.valid_from, validUntil: body.valid_until, mfaRequired: body.mfa_required },
      scope.tenant.membershipId,
    );
    await this.record(scope, {
      action: 'committee.member_appointed',
      resource: MEMBER,
      id: done.id,
      version: done.version,
      type: 'committee.member_appointed.v1',
      classification: COMMITTEE_ROSTER_CLASSIFICATION,
      facts: { committee_id: done.committeeId, membership_id: done.membershipId, committee_role: done.committeeRole, agency_code: done.agencyCode, valid_from: done.validFrom, valid_until: done.validUntil, mfa_required: done.mfaRequired, role_granted: done.roleGranted },
    });
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('committee/roster/members/:id/ending')
  @HttpCode(200)
  @OperationId('endCommitteeMember')
  @Command({ operation: 'endCommitteeMember', versioned: true })
  async end(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CommitteeMemberEnd']): Promise<CommandResult> {
    this.assertWhole(access, PERMISSIONS.endCommitteeMember);
    const done = await this.roster.end(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, body.reason, scope.tenant.membershipId);
    await this.record(scope, {
      action: 'committee.member_ended',
      resource: MEMBER,
      id: done.id,
      version: done.version,
      type: 'committee.member_ended.v1',
      classification: COMMITTEE_ROSTER_CLASSIFICATION,
      reason: body.reason,
      facts: { committee_id: done.committeeId, membership_id: done.membershipId, committee_role: done.committeeRole },
    });
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('committee/attention/decisions')
  @HttpCode(200)
  @OperationId('recordAttentionDecision')
  @Command({ operation: 'recordAttentionDecision' })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['CommitteeAttentionDecide']): Promise<CommandResult> {
    this.assertWhole(access, PERMISSIONS.recordAttentionDecision);
    const today = vietnamDateOf(this.clock());
    // The reasons and the score the Ban saw are those of the list today; a project that is not on the list is decided with no reasons and no score.
    const read = await this.service.read(scope.tx, { asOf: today });
    const item = read.attention.find((one) => one.projectId === body.project_id.toLowerCase());
    const done = await this.decisions.record(
      scope.tx,
      { projectId: body.project_id, decision: body.decision, note: body.note, deferUntil: body.defer_until, directiveId: body.directive_id, reasons: item?.signals.map((signal) => signal.reason) ?? [], score: item?.score ?? null, asOf: read.facts.asOf, policyVersion: read.policy.version },
      scope.tenant.membershipId,
      today,
    );
    await this.record(scope, {
      action: 'committee.attention_decided',
      resource: DECISION,
      id: done.id,
      version: 1,
      type: 'committee.attention_decided.v1',
      classification: COMMITTEE_CLASSIFICATION,
      ...(done.note === null ? {} : { reason: done.note }),
      facts: { project_id: done.projectId, decision: done.decision, reasons: done.reasons, score: done.score, defer_until: done.deferUntil, directive_id: done.directiveId },
    });
    return commandResult(scope, done.decision, 1, done.id);
  }

  @Post('committee/alerts/evaluate')
  @HttpCode(200)
  @OperationId('evaluateCommitteeAlerts')
  @Command({ operation: 'evaluateCommitteeAlerts' })
  async evaluate(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess): Promise<CommandResult & Record<string, unknown>> {
    this.assertWhole(access, PERMISSIONS.evaluateCommitteeAlerts);
    const today = vietnamDateOf(this.clock());
    const read = await this.service.read(scope.tx, { asOf: today });
    const done = await this.alerts.reconcile(scope.tx, read.workspace.alerts, read.workspace.fiscalYear, today, read.policy.version);
    const emit = async (row: CommitteeAlertRow, action: string, type: string): Promise<void> =>
      this.record(scope, { action, resource: ALERT, id: row.id, version: row.version, type, classification: COMMITTEE_CLASSIFICATION, facts: { alert_type: row.alertType, subject_kind: row.subjectKind, subject_key: row.subjectKey, severity: row.severity, value: row.value, threshold: row.threshold, status: row.status } });
    for (const row of done.opened) await emit(row, 'committee.alert_raised', 'committee.alert_raised.v1');
    for (const row of done.resolved) await emit(row, 'committee.alert_resolved', 'committee.alert_resolved.v1');
    await scope.audit({ action: 'committee.alerts_evaluated', resourceType: ALERT, resourceId: scope.tenant.tenantId, classification: COMMITTEE_CLASSIFICATION, diff: { opened: done.opened.length, kept: done.kept, resolved: done.resolved.length, as_of: read.facts.asOf, policy_version: read.policy.version } });
    const types = await this.service.alertTypes(scope.tx, today);
    const live = await this.alerts.list(scope.tx, 'LIVE');
    return { operation_id: scope.requestId, status: 'EVALUATED', resource_version: 0, resource_id: scope.tenant.tenantId, opened: done.opened.length, kept: done.kept, resolved: done.resolved.length, as_of: read.facts.asOf, alerts: live.map((row) => alertDto(row, types)) };
  }

  @Post('committee/alerts/:id/acknowledgement')
  @HttpCode(200)
  @OperationId('acknowledgeCommitteeAlert')
  @Command({ operation: 'acknowledgeCommitteeAlert', versioned: true })
  async acknowledge(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CommitteeAlertAcknowledge']): Promise<CommandResult> {
    this.assertWhole(access, PERMISSIONS.acknowledgeCommitteeAlert);
    const done = await this.alerts.acknowledge(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, body.note, scope.tenant.membershipId);
    await this.record(scope, { action: 'committee.alert_acknowledged', resource: ALERT, id: done.id, version: done.version, type: 'committee.alert_acknowledged.v1', classification: COMMITTEE_CLASSIFICATION, reason: body.note, facts: { alert_type: done.alertType, subject_key: done.subjectKey, severity: done.severity } });
    return commandResult(scope, done.status, done.version, done.id);
  }
}
