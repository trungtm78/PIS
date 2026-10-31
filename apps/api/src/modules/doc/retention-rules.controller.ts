import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DocRetentionRuleStore } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';

const RESOURCE_TYPE = 'document_retention_rule';

/**
 * The retention rules belong to the whole tenant (DOC 2): a grant on a branch of the organisation tree does not reach their drafting, publication or legal confirmation, as with the templates.
 */
function assertWholeTenant(access: EffectiveAccess, permission: string): void {
  if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
}

/**
 * Management of the retention rules (ST-DOC-017, DOC.md F11): drafted by one person, published by another and confirmed in law by a third; the periods of one rule set and category never overlap and a dossier keeps the rule
 * it was closed under. The list is read in {@link DossierReadsController}.
 */
@Controller()
export class RetentionRulesController {
  private readonly rules = new DocRetentionRuleStore();

  @Post('document-retention-rules')
  @HttpCode(200)
  @OperationId('createDocumentRetentionRule')
  @Command({ operation: 'createDocumentRetentionRule' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['DocRetentionRuleRevision']): Promise<CommandResult> {
    assertWholeTenant(access, PERMISSIONS.createDocumentRetentionRule);
    const created = await this.rules.create(scope.tx, {
      ruleSet: body.rule_set,
      categoryCode: body.category_code,
      classCode: body.class_code,
      retentionYears: body.retention_years,
      startBasis: body.start_basis,
      handoverMonths: body.handover_months,
      legalBasis: body.legal_basis,
      precedence: body.precedence,
      effectiveFrom: body.effective_from,
      effectiveUntil: body.effective_until,
      actor: scope.tenant.membershipId,
    });
    await scope.audit({
      action: 'document_retention_rule.draft',
      resourceType: RESOURCE_TYPE,
      resourceId: created.id,
      diff: { rule_set: created.ruleSet, category_code: created.categoryCode, class_code: created.classCode, retention_years: created.retentionYears, effective_from: created.effectiveFrom, effective_until: created.effectiveUntil },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: 'doc.retention_rule_drafted.v1',
      schemaVersion: 1,
      payload: { rule_id: created.id, rule_set: created.ruleSet, category_code: created.categoryCode, class_code: created.classCode },
      eventKey: `${RESOURCE_TYPE}:${created.id}:${created.version}`,
    });
    return commandResult(scope, 'DRAFT', created.version, created.id);
  }

  @Post('document-retention-rules/:id/publish')
  @HttpCode(200)
  @OperationId('publishDocumentRetentionRule')
  @Command({ operation: 'publishDocumentRetentionRule', versioned: true })
  async publish(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    assertWholeTenant(access, PERMISSIONS.publishDocumentRetentionRule);
    const published = await this.rules.publish(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, scope.tenant.membershipId);
    await scope.audit({
      action: 'document_retention_rule.publish',
      resourceType: RESOURCE_TYPE,
      resourceId: id,
      diff: { rule_set: published.ruleSet, category_code: published.categoryCode, class_code: published.classCode, effective_from: published.effectiveFrom, effective_until: published.effectiveUntil, drafted_by: published.createdBy },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: id,
      aggregateVersion: published.version,
      type: 'doc.retention_rule_published.v1',
      schemaVersion: 1,
      payload: { rule_id: id, rule_set: published.ruleSet, category_code: published.categoryCode, class_code: published.classCode, effective_from: published.effectiveFrom, effective_until: published.effectiveUntil, confirmation_status: published.confirmationStatus },
      eventKey: `${RESOURCE_TYPE}:${id}:${published.version}`,
    });
    return commandResult(scope, 'PUBLISHED', published.version, id);
  }

  @Post('document-retention-rules/:id/legal-confirmation')
  @HttpCode(200)
  @OperationId('confirmDocumentRetentionRuleLegalBasis')
  @Command({ operation: 'confirmDocumentRetentionRuleLegalBasis', versioned: true })
  async confirm(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DocTemplateLegalConfirmation']): Promise<CommandResult> {
    assertWholeTenant(access, PERMISSIONS.confirmDocumentRetentionRuleLegalBasis);
    const confirmed = await this.rules.confirm(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { reference: body.legal_confirmation_ref, evidenceDocumentId: body.evidence_document_id.toLowerCase(), note: body.note },
      scope.tenant.membershipId,
    );
    await scope.audit({
      action: 'document_retention_rule.confirm_legal',
      resourceType: RESOURCE_TYPE,
      resourceId: id,
      diff: { rule_set: confirmed.ruleSet, category_code: confirmed.categoryCode, legal_confirmation_ref: confirmed.legalConfirmationRef, evidence_document_id: body.evidence_document_id.toLowerCase() },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: id,
      aggregateVersion: confirmed.version,
      type: 'doc.retention_rule_confirmed.v1',
      schemaVersion: 1,
      payload: { rule_id: id, rule_set: confirmed.ruleSet, category_code: confirmed.categoryCode, legal_confirmation_ref: confirmed.legalConfirmationRef },
      eventKey: `${RESOURCE_TYPE}:${id}:${confirmed.version}`,
    });
    return commandResult(scope, 'CONFIRMED', confirmed.version, id);
  }
}
