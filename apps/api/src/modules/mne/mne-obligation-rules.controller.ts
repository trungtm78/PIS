import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { MneObligationRuleStore } from '@machvon/db';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { OperationId } from '../../operation-id.decorator';
import { ruleDiffOf } from './mne-views';

const RESOURCE_TYPE = 'mne_obligation_rule';

/**
 * The obligation rules of the monitoring module (ST-MNE-001, MNE F1, BR-MNE-01, BR-MNE-03): who files which form, how often, to whom
 * and by which formula, as data with a legal basis and an effective period. A rule is drafted under `mne.calendar.manage` and published
 * by someone else under `mne.calendar.approve`; the obligations are generated from the rules in force (`generateMneObligations`).
 */
@Controller()
export class MneObligationRulesController {
  private readonly rules = new MneObligationRuleStore();

  @Post('mne-obligation-rules')
  @HttpCode(200)
  @OperationId('createMneObligationRule')
  @Command({ operation: 'createMneObligationRule' })
  async create(@Scope() scope: CommandScope, @Body() body: Schemas['MneObligationRule']): Promise<CommandResult & { revision: number }> {
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
  async publish(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
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
}
