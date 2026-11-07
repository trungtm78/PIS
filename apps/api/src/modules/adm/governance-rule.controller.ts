import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { GovernanceRuleStore, GovernancePolicyPort, TenantDatabase, governanceRulePhaseOf } from '@machvon/db';
import type { GovernanceRuleRow } from '@machvon/db';
import { DomainError, isRuleCode, isRuleDay, isRuleTypeName, ruleTypeOf } from '@machvon/kernel';
import type { EffectiveAccess, GovernanceRuleStatus, ResolvedGovernanceRule, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from './tenant-authority';

const MANAGE_PERMISSION = PERMISSIONS.createGovernanceRuleDraft;
const APPROVE_PERMISSION = PERMISSIONS.approveGovernanceRule;
const READ_PERMISSION = PERMISSIONS.getGovernanceRule;
const RESOURCE_TYPE = 'governance_rule';
const STATUSES: readonly GovernanceRuleStatus[] = ['DRAFT', 'SUBMITTED', 'APPROVED', 'RETIRED'];
const ALERT_TYPE = 'ALERT_TYPE';

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** The governance rules are the thresholds of the whole tenant (ADM): they are not owned by one organisation unit, so only a grant on the whole tenant reaches them. */
function assertHolds(access: EffectiveAccess, permission: string): void {
  if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
}

/** A query value that must be one string or absent (`?a=1&a=2` and `?a[x]=1` are refused). */
function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '') throw invalid(field);
  return value;
}

function requiredText(value: unknown, field: string): string {
  const text = optionalText(value, field);
  if (text === undefined) throw invalid(field);
  return text;
}

function ruleType(value: unknown, required: boolean): string | undefined {
  const text = required ? requiredText(value, 'rule_type') : optionalText(value, 'rule_type');
  if (text !== undefined && !isRuleTypeName(text)) throw invalid('rule_type');
  return text;
}

function ruleCode(value: unknown, required: boolean): string | undefined {
  const text = required ? requiredText(value, 'code') : optionalText(value, 'code');
  if (text !== undefined && !isRuleCode(text)) throw invalid('code');
  return text;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function unitOf(value: unknown): string | undefined {
  const text = optionalText(value, 'unit_id');
  if (text !== undefined && !UUID.test(text)) throw invalid('unit_id');
  return text;
}

function dayOf(value: unknown, field: string): string | undefined {
  const text = optionalText(value, field);
  if (text !== undefined && !isRuleDay(text)) throw invalid(field);
  return text;
}

/** openapi.json: the version as the admin screen reads it; `phase` says where it stands on `today` (a draft governs nothing, an approved version may be waiting for its first day or past its last). */
function viewOf(row: GovernanceRuleRow, today: string): Record<string, unknown> {
  return {
    id: row.id,
    rule_type: row.type,
    code: row.code,
    version: row.version,
    unit_id: row.unitId,
    status: row.status,
    phase: governanceRulePhaseOf(row, today),
    params: row.params,
    effective_from: row.effectiveFrom,
    effective_to: row.effectiveTo,
    reason: row.reason,
    created_by: row.createdBy,
    created_at: row.createdAt,
    submitted_by: row.submittedBy,
    submitted_at: row.submittedAt,
    approved_by: row.approvedBy,
    approved_at: row.approvedAt,
    retired_by: row.retiredBy,
    retired_at: row.retiredAt,
    retire_reason: row.retireReason,
    resource_version: row.rowVersion,
  };
}

function resolvedView(resolved: ResolvedGovernanceRule, asOf: string): Record<string, unknown> {
  return {
    rule_type: resolved.type,
    code: resolved.code,
    as_of: asOf,
    params: resolved.params,
    version: resolved.version,
    source: resolved.source,
    rule_id: resolved.ruleId,
    unit_id: resolved.unitId,
    unverified: resolved.unverified,
    provenance: resolved.provenance === null ? null : { formula: resolved.provenance.formula, source: resolved.provenance.source, as_of: resolved.provenance.asOf, legal_status: resolved.provenance.legalStatus },
  };
}

/** The diff of the audit row: what the version says, without its params (the params are in the table; the audit keeps who and what moved). */
const identityOf = (row: GovernanceRuleRow): Record<string, unknown> => ({ rule_type: row.type, code: row.code, version: row.version, unit_id: row.unitId, effective_from: row.effectiveFrom, effective_to: row.effectiveTo });

/**
 * The commands on the governance rules (G0-1, ADM). A draft changes nothing; once it is submitted and a third person approves it (neither the person who wrote it nor the one who submitted it), the version governs
 * from its first day and the version it replaces ends there. A version never changes after it is written; a change is a new version. Every move is audited (ADM-11) and the approval and the retirement are
 * announced in the outbox so that the readers of a rule can refresh.
 */
@Controller('governance-rules')
export class GovernanceRulesController {
  private readonly store = new GovernanceRuleStore();

  @Post()
  @OperationId('createGovernanceRuleDraft')
  @Command({ operation: 'createGovernanceRuleDraft' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['GovernanceRuleDraft']): Promise<CommandResult> {
    assertHolds(access, MANAGE_PERMISSION);
    const created = await this.store.create(
      scope.tx,
      { type: body.rule_type, code: body.code, unitId: body.unit_id ?? null, params: body.params, effectiveFrom: body.effective_from, effectiveTo: body.effective_to ?? null, reason: body.reason },
      scope.tenant.membershipId,
    );
    await scope.audit({ action: 'governance_rule.drafted', resourceType: RESOURCE_TYPE, resourceId: created.id, reason: body.reason, classification: 'INTERNAL', diff: identityOf(created) });
    return commandResult(scope, 'DRAFT', created.rowVersion, created.id);
  }

  @Post(':ruleId/submit')
  @HttpCode(200)
  @OperationId('submitGovernanceRule')
  @Command({ operation: 'submitGovernanceRule', versioned: true })
  async submit(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('ruleId', ParseUUIDPipe) ruleId: string,
    @Body() body: Schemas['GovernanceRuleReason'],
  ): Promise<CommandResult> {
    assertHolds(access, MANAGE_PERMISSION);
    const row = await this.store.submit(scope.tx, ruleId, scope.expectedVersion ?? 0, scope.tenant.membershipId);
    await scope.audit({ action: 'governance_rule.submitted', resourceType: RESOURCE_TYPE, resourceId: ruleId, reason: body.reason, classification: 'INTERNAL', diff: identityOf(row) });
    return commandResult(scope, 'SUBMITTED', row.rowVersion, ruleId);
  }

  @Post(':ruleId/withdraw')
  @HttpCode(200)
  @OperationId('withdrawGovernanceRule')
  @Command({ operation: 'withdrawGovernanceRule', versioned: true })
  async withdraw(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('ruleId', ParseUUIDPipe) ruleId: string,
    @Body() body: Schemas['GovernanceRuleReason'],
  ): Promise<CommandResult> {
    assertHolds(access, MANAGE_PERMISSION);
    const row = await this.store.withdraw(scope.tx, ruleId, scope.expectedVersion ?? 0, scope.tenant.membershipId);
    await scope.audit({ action: 'governance_rule.withdrawn', resourceType: RESOURCE_TYPE, resourceId: ruleId, reason: body.reason, classification: 'INTERNAL', diff: identityOf(row) });
    return commandResult(scope, 'DRAFT', row.rowVersion, ruleId);
  }

  @Post(':ruleId/approve')
  @HttpCode(200)
  @OperationId('approveGovernanceRule')
  @Command({ operation: 'approveGovernanceRule', versioned: true })
  async approve(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('ruleId', ParseUUIDPipe) ruleId: string,
    @Body() body: Schemas['GovernanceRuleReason'],
  ): Promise<CommandResult> {
    assertHolds(access, APPROVE_PERMISSION);
    const { row, supersededId } = await this.store.approve(scope.tx, ruleId, scope.expectedVersion ?? 0, scope.tenant.membershipId);
    await scope.audit({
      action: 'governance_rule.approved',
      resourceType: RESOURCE_TYPE,
      resourceId: ruleId,
      reason: body.reason,
      classification: 'INTERNAL',
      diff: { ...identityOf(row), submitted_by: row.submittedBy, created_by: row.createdBy, superseded_id: supersededId },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: ruleId,
      aggregateVersion: row.rowVersion,
      type: 'adm.governance_rule.approved.v1',
      schemaVersion: 1,
      payload: { rule_id: ruleId, rule_type: row.type, code: row.code, version: row.version, unit_id: row.unitId, effective_from: row.effectiveFrom, effective_to: row.effectiveTo, superseded_id: supersededId },
      eventKey: `${RESOURCE_TYPE}:${ruleId}:approved:${row.rowVersion}`,
    });
    return commandResult(scope, 'APPROVED', row.rowVersion, ruleId);
  }

  @Post(':ruleId/retire')
  @HttpCode(200)
  @OperationId('retireGovernanceRule')
  @Command({ operation: 'retireGovernanceRule', versioned: true })
  async retire(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('ruleId', ParseUUIDPipe) ruleId: string,
    @Body() body: Schemas['GovernanceRuleRetire'],
  ): Promise<CommandResult> {
    assertHolds(access, MANAGE_PERMISSION);
    // A version that governs or is going to govern is taken out of force by a person who may approve, not by whoever may draft: stopping a rule is as much a decision as starting one.
    const current = await this.store.find(scope.tx, ruleId);
    if (current === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (current.status === 'APPROVED') assertHolds(access, APPROVE_PERMISSION);
    const row = await this.store.retire(scope.tx, ruleId, scope.expectedVersion ?? 0, scope.tenant.membershipId, body.reason, body.effective_to);
    await scope.audit({ action: 'governance_rule.retired', resourceType: RESOURCE_TYPE, resourceId: ruleId, reason: body.reason, classification: 'INTERNAL', diff: { ...identityOf(row), was_status: current.status } });
    if (current.status === 'APPROVED') {
      await scope.emit({
        aggregateType: RESOURCE_TYPE,
        aggregateId: ruleId,
        aggregateVersion: row.rowVersion,
        type: 'adm.governance_rule.retired.v1',
        schemaVersion: 1,
        payload: { rule_id: ruleId, rule_type: row.type, code: row.code, version: row.version, unit_id: row.unitId, effective_to: row.effectiveTo },
        eventKey: `${RESOURCE_TYPE}:${ruleId}:retired:${row.rowVersion}`,
      });
    }
    return commandResult(scope, 'RETIRED', row.rowVersion, ruleId);
  }
}

/**
 * The reads of the governance rules (G0-1): the versions, the catalog of the types the platform knows, the rule in force on a day, the versions of a code and the difference between two versions. A read that fails is an
 * error, never an empty answer: a caller that cannot read a rule must not conclude that there is none.
 */
@Controller('governance-rules')
export class GovernanceRuleReadsController {
  private readonly store = new GovernanceRuleStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('listGovernanceRules')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('rule_type') type?: unknown,
    @Query('code') code?: unknown,
    @Query('status') status?: unknown,
    @Query('unit_id') unit?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    assertHolds(access, READ_PERMISSION);
    const request = parsePageRequest(limit, cursor);
    const wanted = optionalText(status, 'status');
    if (wanted !== undefined && !(STATUSES as readonly string[]).includes(wanted)) throw invalid('status');
    const filter = { type: ruleType(type, false), code: ruleCode(code, false), status: wanted as GovernanceRuleStatus | undefined, unitId: unitOf(unit), limit: request.limit + 1, after: request.after };
    return this.database.withTenant(tenant, async (tx) => {
      const today = await this.store.today(tx);
      const rows = await this.store.list(tx, filter);
      const shown = rows.slice(0, request.limit);
      const last = shown[shown.length - 1];
      return { items: shown.map((row) => viewOf(row, today)), next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAt, id: last.id }) : null };
    });
  }

  @Get('catalog')
  @OperationId('getGovernanceRuleCatalog')
  async catalog(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    assertHolds(access, READ_PERMISSION);
    return this.database.withTenant(tenant, async (tx) => {
      const types = await this.store.catalog(tx);
      return {
        items: types.map((entry) => ({
          rule_type: entry.type,
          registered: entry.registered,
          owner_module: entry.description?.ownerModule ?? null,
          modules: entry.description?.modules ?? [],
          formula: entry.description?.formula ?? null,
          source: entry.description?.source ?? null,
          as_of: entry.description?.asOf ?? null,
          legal_status: entry.description?.legalStatus ?? null,
          schema: entry.description?.schema ?? null,
          codes: entry.codes.map((one) => ({
            code: one.code,
            has_default: one.hasDefault,
            unverified: one.unverified,
            provenance: one.provenance === null ? null : { formula: one.provenance.formula, source: one.provenance.source, as_of: one.provenance.asOf, legal_status: one.provenance.legalStatus },
            stored_versions: one.storedVersions,
            in_force: one.inForce,
            in_force_version: one.inForceVersion,
          })),
        })),
      };
    });
  }

  @Get('effective')
  @OperationId('getEffectiveGovernanceRule')
  async effective(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('rule_type') type?: unknown,
    @Query('code') code?: unknown,
    @Query('as_of') asOf?: unknown,
    @Query('unit_id') unit?: unknown,
  ): Promise<Record<string, unknown>> {
    assertHolds(access, READ_PERMISSION);
    const wantedType = ruleType(type, true) as string;
    const wantedCode = ruleCode(code, true) as string;
    const day = dayOf(asOf, 'as_of');
    const unitId = unitOf(unit);
    return this.database.withTenant(tenant, async (tx) => {
      ruleTypeOf(wantedType);
      const when = day ?? (await this.store.today(tx));
      const found = await this.store.effective(tx, wantedType, wantedCode, when, unitId ?? null);
      if (found === undefined) throw new DomainError('GOVERNANCE_RULE_NOT_FOUND', 404, 'code');
      return resolvedView(found, when);
    });
  }

  @Get('versions')
  @OperationId('listGovernanceRuleVersions')
  async versions(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('rule_type') type?: unknown,
    @Query('code') code?: unknown,
    @Query('unit_id') unit?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>> }> {
    assertHolds(access, READ_PERMISSION);
    const wantedType = ruleType(type, true) as string;
    const wantedCode = ruleCode(code, true) as string;
    const unitId = unitOf(unit);
    return this.database.withTenant(tenant, async (tx) => {
      const today = await this.store.today(tx);
      const rows = await this.store.versions(tx, wantedType, wantedCode, unitId ?? null);
      return { items: rows.map((row) => viewOf(row, today)) };
    });
  }

  @Get(':ruleId')
  @OperationId('getGovernanceRule')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('ruleId', ParseUUIDPipe) ruleId: string): Promise<Record<string, unknown>> {
    assertHolds(access, READ_PERMISSION);
    return this.database.withTenant(tenant, async (tx) => {
      const row = await this.store.find(tx, ruleId);
      if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      return viewOf(row, await this.store.today(tx));
    });
  }

  @Get(':ruleId/diff')
  @OperationId('getGovernanceRuleDiff')
  async diff(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('ruleId', ParseUUIDPipe) ruleId: string,
    @Query('against') against?: unknown,
  ): Promise<Record<string, unknown>> {
    assertHolds(access, READ_PERMISSION);
    const other = optionalText(against, 'against');
    if (other !== undefined && !UUID.test(other)) throw invalid('against');
    return this.database.withTenant(tenant, async (tx) => {
      const found = await this.store.diff(tx, ruleId, other);
      if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      return {
        from: { id: found.from.id, rule_type: found.from.type, code: found.from.code, version: found.from.version, source: found.from.source },
        to: { id: found.to.id, rule_type: found.to.type, code: found.to.code, version: found.to.version },
        changes: found.changes.map((change) => ({ path: change.path, before: change.before ?? null, after: change.after ?? null })),
      };
    });
  }
}

/**
 * The registry of alert types (G0-3): for each type of alert, who owns it, what is expected, what happens when it is not done, how fast it must be answered, why it exists and when it is next reviewed. The answer is
 * what governs on a day: the approved rule of the tenant or the built-in type, with the version that decided and whether the numbers were confirmed. A type past its review day says so.
 */
@Controller('alert-types')
export class AlertTypeReadsController {
  private readonly store = new GovernanceRuleStore();
  private readonly port = new GovernancePolicyPort();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('listAlertTypes')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('as_of') asOf?: unknown, @Query('unit_id') unit?: unknown): Promise<{ as_of: string; items: Array<Record<string, unknown>> }> {
    assertHolds(access, READ_PERMISSION);
    const day = dayOf(asOf, 'as_of');
    const unitId = unitOf(unit);
    return this.database.withTenant(tenant, async (tx) => {
      const today = await this.store.today(tx);
      const when = day ?? today;
      const unitChain = unitId === undefined ? [] : await this.store.unitChain(tx, unitId);
      const all = await this.port.getAll(tx, ALERT_TYPE, when, { unitChain });
      return { as_of: when, items: all.map((one) => alertView(one, today)) };
    });
  }

  @Get(':code')
  @OperationId('getAlertType')
  async get(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('code') code: string,
    @Query('as_of') asOf?: unknown,
    @Query('unit_id') unit?: unknown,
  ): Promise<Record<string, unknown>> {
    assertHolds(access, READ_PERMISSION);
    if (!isRuleCode(code)) throw invalid('code');
    const day = dayOf(asOf, 'as_of');
    const unitId = unitOf(unit);
    return this.database.withTenant(tenant, async (tx) => {
      const today = await this.store.today(tx);
      const when = day ?? today;
      const found = await this.store.effective(tx, ALERT_TYPE, code, when, unitId ?? null);
      if (found === undefined) throw new DomainError('GOVERNANCE_RULE_NOT_FOUND', 404, 'code');
      const versions = await this.store.versions(tx, ALERT_TYPE, code, unitId ?? null);
      return { ...alertView(found, today), versions: versions.map((row) => viewOf(row, today)) };
    });
  }
}

/** One alert type as the registry shows it: the fields of the rule, where it came from and whether its review day has passed. */
function alertView(resolved: ResolvedGovernanceRule, today: string): Record<string, unknown> {
  const params = resolved.params;
  const review = typeof params.review_on === 'string' ? params.review_on : null;
  return {
    code: resolved.code,
    source: params.source ?? null,
    owner: params.owner ?? null,
    expected_action: params.expected_action ?? null,
    consequence: params.consequence ?? null,
    response_hours: params.response_hours ?? null,
    default_severity: params.default_severity ?? null,
    reason_to_exist: params.reason_to_exist ?? null,
    review_on: review,
    review_overdue: review !== null && review < today,
    enabled: params.enabled ?? null,
    version: resolved.version,
    rule_source: resolved.source,
    rule_id: resolved.ruleId,
    unit_id: resolved.unitId,
    unverified: resolved.unverified,
    provenance: resolved.provenance === null ? null : { formula: resolved.provenance.formula, source: resolved.provenance.source, as_of: resolved.provenance.asOf, legal_status: resolved.provenance.legalStatus },
  };
}
