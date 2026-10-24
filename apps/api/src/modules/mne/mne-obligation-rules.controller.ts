import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { MNE_REPORTING_ROLES, MneObligationRuleStore, TenantDatabase } from '@machvon/db';
import type { MneReportingRole, MneRevisionStatus } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
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
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { ruleDiffOf, ruleViewOf } from './mne-views';

const RESOURCE_TYPE = 'mne_obligation_rule';
const ROLES: ReadonlySet<string> = new Set(MNE_REPORTING_ROLES);
const STATUSES: ReadonlySet<string> = new Set(['DRAFT', 'PUBLISHED', 'RETIRED']);
const FORM_CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,49}$/;

function choiceOf<Value extends string>(value: unknown, name: string, allowed: ReadonlySet<string>): Value | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.has(value)) throw new DomainError('VALIDATION_FAILED', 422, name);
  return value as Value;
}

/** The filing rules belong to the tenant (MNE 2): a grant on a subtree does not reach them. */
function assertWholeTenant(access: EffectiveAccess, permission: string): void {
  if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
}

function formCodeOf(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !FORM_CODE.test(value)) throw new DomainError('VALIDATION_FAILED', 422, 'form_code');
  return value;
}

/**
 * The obligation rules of the monitoring module (ST-MNE-001, MNE F1, BR-MNE-01, BR-MNE-03): who files which form, how often, to whom
 * and by which formula, as data with a legal basis and an effective period. A rule is drafted under `mne.calendar.manage` and published
 * by someone else under `mne.calendar.approve`; the obligations are generated from the rules in force (`generateMneObligations`).
 */
@Controller()
export class MneObligationRulesController {
  private readonly rules = new MneObligationRuleStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Post('mne-obligation-rules')
  @HttpCode(200)
  @OperationId('createMneObligationRule')
  @Command({ operation: 'createMneObligationRule' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['MneObligationRule']): Promise<CommandResult & { revision: number }> {
    assertWholeTenant(access, PERMISSIONS.createMneObligationRule);
    const created = await this.rules.create(
      scope.tx,
      {
        ruleCode: body.rule_code,
        formId: body.form_id,
        reportingRole: body.reporting_role,
        recipient: body.recipient,
        frequency: body.frequency,
        dueRuleJson: body.due_rule_json,
        legalBasis: body.legal_basis,
        legalConfirmationRef: body.legal_confirmation_ref,
        effectiveFrom: body.effective_from,
        effectiveUntil: body.effective_until,
      },
      scope.tenant.membershipId,
    );
    await scope.audit({ action: 'mne.obligation_rule_drafted', resourceType: RESOURCE_TYPE, resourceId: created.id, diff: ruleDiffOf(created) });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: 'mne.obligation_rule.drafted.v1',
      schemaVersion: 1,
      payload: { rule_id: created.id, rule_code: created.ruleCode, revision: created.revision, frequency: created.frequency },
      eventKey: `${RESOURCE_TYPE}:${created.id}:${created.version}`,
    });
    return { ...commandResult(scope, 'DRAFT', created.version, created.id), revision: created.revision };
  }

  @Post('mne-obligation-rules/:id/publish')
  @HttpCode(200)
  @OperationId('publishMneObligationRule')
  @Command({ operation: 'publishMneObligationRule', versioned: true })
  async publish(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    assertWholeTenant(access, PERMISSIONS.publishMneObligationRule);
    const { record, closed } = await this.rules.publish(scope.tx, id, scope.expectedVersion ?? 0, scope.tenant.membershipId);
    const closedRevisions = closed.map((revision) => ({ rule_id: revision.id, revision: revision.revision, effective_until: revision.effectiveUntil }));
    await scope.audit({ action: 'mne.obligation_rule_published', resourceType: RESOURCE_TYPE, resourceId: id, diff: { ...ruleDiffOf(record), closed_revisions: closedRevisions } });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: id,
      aggregateVersion: record.version,
      type: 'mne.obligation_rule.published.v1',
      schemaVersion: 1,
      payload: { rule_id: id, rule_code: record.ruleCode, revision: record.revision, effective_from: record.effectiveFrom, awaiting_confirmation: record.legalConfirmationRef === null, closed_revisions: closedRevisions },
      eventKey: `${RESOURCE_TYPE}:${id}:${record.version}`,
    });
    return commandResult(scope, 'PUBLISHED', record.version, id);
  }

  @Get('mne-obligation-rules')
  @OperationId('listMneObligationRules')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query('reporting_role') reportingRole?: unknown,
    @Query('form_code') formCode?: unknown,
    @Query('status') status?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    const request = parsePageRequest(limit, cursor);
    const filter = {
      reportingRole: choiceOf<MneReportingRole>(reportingRole, 'reporting_role', ROLES),
      formCode: formCodeOf(formCode),
      status: choiceOf<MneRevisionStatus>(status, 'status', STATUSES),
    };
    const after = request.after === undefined ? undefined : { createdAtKey: request.after.code, id: request.after.id };
    const rows = await this.database.withTenant(tenant, (tx) => this.rules.list(tx, filter, { limit: request.limit + 1, after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(ruleViewOf),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAtKey, id: last.id }) : null,
    };
  }
}
