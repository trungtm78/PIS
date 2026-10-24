import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { GATE_CODES, PmtGateStore, TenantDatabase, projectScope } from '@machvon/db';
import type { GateEvaluation, GateRuleRow } from '@machvon/db';
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

const MANAGE_PERMISSION = PERMISSIONS.publishPermitGateRule;
const READ_PERMISSION = PERMISSIONS.evaluatePermitGates;
const RULE_RESOURCE = 'permit_gate_rule';

/**
 * The gate rules are the legal data of the whole tenant (PMT 2: the business owner of the tenant), not the data of one organisation unit, so only a
 * grant on the whole tenant publishes or ends one; a grant on a subtree does not.
 */
function assertManages(access: EffectiveAccess): void {
  if (!holdsOnWholeTenant(access, MANAGE_PERMISSION)) throw new DomainError('SCOPE_DENIED', 403);
}

function ruleView(row: GateRuleRow): Record<string, unknown> {
  return {
    id: row.id,
    gate_code: row.gateCode,
    project_milestone_code: row.projectMilestoneCode,
    permit_type_id: row.permitTypeId,
    permit_type_code: row.permitTypeCode,
    requirement: row.requirement,
    applies_to_rule: row.appliesToRule,
    legal_basis: row.legalBasis,
    effective_from: row.effectiveFrom,
    effective_until: row.effectiveUntil,
    revision: row.revision,
    status: row.status,
    version: row.version,
  };
}

/** The evaluation of one gate as the contract exposes it: the verdict and, for each rule judged, its legal basis and what satisfies it or blocks it. */
export function evaluationView(evaluation: GateEvaluation): Record<string, unknown> {
  return {
    gate_code: evaluation.gateCode,
    status: evaluation.status,
    rules: evaluation.verdicts.map((verdict) => ({
      rule_id: verdict.ruleId,
      revision: verdict.revision,
      project_milestone_code: verdict.projectMilestoneCode,
      permit_type_code: verdict.permitTypeCode,
      requirement: verdict.requirement,
      legal_basis: verdict.legalBasis,
      effective_from: verdict.effectiveFrom,
      effective_until: verdict.effectiveUntil,
      outcome: verdict.outcome,
      permit: verdict.permit === null ? null : { id: verdict.permit.id, permit_no: verdict.permit.permitNo, status: verdict.permit.status, valid_until: verdict.permit.validUntil },
      waiver: verdict.waiver === null ? null : { id: verdict.waiver.id, valid_until: verdict.waiver.validUntil },
    })),
  };
}

function textQuery(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
}

/**
 * The gate rules of the permits (ST-PMT-004, PMT 3.2, BR-PMT-03): which permit a gate of a project asks for is dated legal data with a legal basis. A
 * change of the regulation is a new revision that takes over from a date; a rule that an evaluation named never changes, it is only ended. The
 * evaluation of a gate is read here and is the port the commands of CTR, QMS, PRJ, AST and PAY call in their own transactions.
 */
@Controller()
export class PermitGateController {
  private readonly gates = new PmtGateStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Post('permit-gate-rules')
  @HttpCode(200)
  @OperationId('publishPermitGateRule')
  @Command({ operation: 'publishPermitGateRule' })
  async publish(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['PmtPublishPermitGateRule']): Promise<CommandResult> {
    assertManages(access);
    const published = await this.gates.publish(
      scope.tx,
      {
        gateCode: body.gate_code,
        projectMilestoneCode: body.project_milestone_code,
        permitTypeId: body.permit_type_id,
        requirement: body.requirement,
        appliesToRule: body.applies_to_rule,
        legalBasis: body.legal_basis,
        effectiveFrom: body.effective_from,
        effectiveUntil: body.effective_until,
      },
      scope.tenant.membershipId,
    );
    const row = await this.gates.find(scope.tx, published.id);
    await scope.audit({
      action: 'pmt.gate_rule_published',
      resourceType: RULE_RESOURCE,
      resourceId: published.id,
      diff: {
        gate_code: row?.gateCode,
        permit_type_code: published.permitTypeCode,
        requirement: row?.requirement,
        revision: published.revision,
        legal_basis: row?.legalBasis,
        effective_from: row?.effectiveFrom,
        effective_until: row?.effectiveUntil ?? null,
        superseded_gate_rule_id: published.supersededId,
      },
    });
    await scope.emit({
      aggregateType: RULE_RESOURCE,
      aggregateId: published.id,
      aggregateVersion: published.version,
      type: 'pmt.gate_rule.published.v1',
      schemaVersion: 1,
      payload: {
        gate_rule_id: published.id,
        gate_code: row?.gateCode,
        permit_type_code: published.permitTypeCode,
        revision: published.revision,
        effective_from: row?.effectiveFrom,
        effective_until: row?.effectiveUntil ?? null,
        superseded_gate_rule_id: published.supersededId,
      },
      eventKey: `${RULE_RESOURCE}:${published.id}:${published.version}`,
    });
    return commandResult(scope, 'PUBLISHED', published.version, published.id);
  }

  @Post('permit-gate-rules/:id/retire')
  @HttpCode(200)
  @OperationId('retirePermitGateRule')
  @Command({ operation: 'retirePermitGateRule' })
  async retire(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PmtRetirePermitGateRule']): Promise<CommandResult> {
    assertManages(access);
    const retired = await this.gates.retire(scope.tx, id, body.effective_until, scope.tenant.membershipId);
    // Every command is audited, also the one that found the end already in place: who asked for it, and that nothing changed.
    await scope.audit({
      action: 'pmt.gate_rule_retired',
      resourceType: RULE_RESOURCE,
      resourceId: id,
      diff: {
        gate_code: retired.row.gateCode,
        permit_type_code: retired.row.permitTypeCode,
        revision: retired.row.revision,
        effective_until_before: retired.row.effectiveUntil,
        effective_until: body.effective_until,
        changed: retired.changed,
      },
    });
    if (retired.changed) {
      await scope.emit({
        aggregateType: RULE_RESOURCE,
        aggregateId: id,
        aggregateVersion: retired.version,
        type: 'pmt.gate_rule.retired.v1',
        schemaVersion: 1,
        payload: { gate_rule_id: id, gate_code: retired.row.gateCode, permit_type_code: retired.row.permitTypeCode, revision: retired.row.revision, effective_until: body.effective_until },
        eventKey: `${RULE_RESOURCE}:${id}:${retired.version}`,
      });
    }
    return commandResult(scope, 'RETIRED', retired.version, id);
  }

  /**
   * Every version of the gate rules of the tenant (PMT-04). The rules are legal data of the whole tenant, so the permission of the contract
   * (`permit.read`, checked by the policy guard) is enough whatever the scope of the grant is, as for the permit types.
   */
  @Get('resources/permit_gate_rule')
  @OperationId('get_resources_permit_gate_rule')
  async list(@CurrentTenant() tenant: TenantContext, @Query('limit') limit?: unknown, @Query('cursor') cursor?: unknown): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    const request = parsePageRequest(limit, cursor);
    const rows = await this.database.withTenant(tenant, (tx) => this.gates.list(tx, {}, { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(ruleView),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAtKey, id: last.id }) : null,
    };
  }

  /**
   * Whether a gate passes for a project on a day, or all five gates when none is named: the verdict, and for each rule judged the legal basis and the
   * permit or waiver that satisfies it. A project outside the scope of the caller, or of another tenant, does not exist for them.
   */
  @Get('projects/:id/permit-gates')
  @OperationId('evaluatePermitGates')
  async evaluate(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('gate_code') gateCode?: unknown,
    @Query('as_of') asOf?: unknown,
  ): Promise<Record<string, unknown>> {
    const gate = textQuery(gateCode, 'gate_code');
    const day = textQuery(asOf, 'as_of');
    const now = new Date();
    const found = await this.database.withTenant(tenant, async (tx) => {
      if (!(await this.gates.visible(tx, id, projectScope(access, READ_PERMISSION, now)))) return undefined;
      const wanted = gate === undefined ? [...GATE_CODES] : [gate];
      const evaluations: GateEvaluation[] = [];
      for (const code of wanted) {
        const evaluation = await this.gates.evaluate(tx, id, code, day);
        if (evaluation === undefined) return undefined;
        evaluations.push(evaluation);
      }
      return evaluations;
    });
    // A project of another tenant, or outside the scope of the caller, is indistinguishable from one that does not exist.
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { project_id: found[0]?.projectId ?? id.toLowerCase(), as_of: found[0]?.asOf, gates: found.map(evaluationView) };
  }
}
