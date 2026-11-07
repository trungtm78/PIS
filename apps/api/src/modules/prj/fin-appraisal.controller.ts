import { createHash } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { FinAppraisalStore, TenantDatabase, appraisalScope } from '@machvon/db';
import type { AppraisalCommandResult, AppraisalListItem, AppraisalView } from '@machvon/db';
import { DomainError, csvOf, effectivePermissions, finExportDocument, holdsPermission, xlsxOf } from '@machvon/kernel';
import type { EffectiveAccess, FinSensitivityConfig, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { reaches } from '../ctr/contract.controller';

const READ = PERMISSIONS.getInvestmentAppraisal;
const MANAGE = PERMISSIONS.createInvestmentAppraisal;
const SUBMIT = PERMISSIONS.submitInvestmentAppraisal;
const APPROVE = PERMISSIONS.approveInvestmentAppraisal;
const EXPORT = PERMISSIONS.exportInvestmentAppraisal;
const RESOURCE = 'investment_appraisal';
const CLASSIFICATION = 'CONFIDENTIAL';
const MEDIA_TYPE: Readonly<Record<string, string>> = { CSV: 'text/csv; charset=utf-8', XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };

const positiveInt = (value: unknown, field: string, min: number, max: number): number | undefined => {
  if (value === undefined || value === '') return undefined;
  const parsed = typeof value === 'string' && /^[0-9]{1,6}$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new DomainError('VALIDATION_FAILED', 422, field);
  return parsed;
};
const textQuery = (value: unknown, field: string): string | undefined => {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 200) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
};

/** The appraisal as openapi.json exposes it (x-exposure dto): an allowlist, so a column added later is not shown until it is listed here. The buttons are the commands the caller may give now. */
export function appraisalView(view: AppraisalView, actions: Record<string, boolean>): Record<string, unknown> {
  return {
    id: view.id,
    code: view.code,
    revision: view.revision,
    supersedes_id: view.supersedesId,
    title: view.title,
    kind: view.kind,
    status: view.status,
    version: view.version,
    owner_unit: { id: view.ownerUnit.id, code: view.ownerUnit.code, name: view.ownerUnit.name },
    project: view.project,
    package: view.package,
    contract: view.contract,
    period_unit: view.periodUnit,
    discount_rate_pct: view.discountRatePct,
    convention: view.convention,
    sensitivity: view.sensitivity,
    criteria_category: view.criteriaCategory,
    lines: view.lines,
    assumptions: view.assumptions.map((entry) => ({ key: entry.key, value: entry.value, unit: entry.unit, source_kind: entry.sourceKind, source: entry.source, owner_id: entry.ownerId, owner_name: entry.ownerName })),
    scenarios: view.scenarios.map((scenario) => ({ code: scenario.code, label: scenario.label, deltas: scenario.deltas })),
    scores: view.scores.map((score) => ({ key: score.key, score: score.score, evidence: score.evidence })),
    required_assumptions: view.requiredAssumptions,
    missing_assumptions: view.missingAssumptions,
    results: view.results,
    result_hash: view.resultHash,
    formula_version: view.formulaVersion,
    computed_at: view.computedAt,
    computed_by: view.computedBy,
    results_fresh: view.resultsFresh,
    frozen: view.frozen,
    criteria_used: view.criteriaUsed === null ? null : { source: view.criteriaUsed.source, version: view.criteriaUsed.version, criteria: view.criteriaUsed.criteria.map((one) => ({ key: one.key, label: one.label, weight_pct: one.weightPct })) },
    criteria_in_force:
      view.criteriaInForce === null
        ? null
        : { category: view.criteriaInForce.category, source: view.criteriaInForce.source, version: view.criteriaInForce.version, unverified: view.criteriaInForce.unverified, criteria: view.criteriaInForce.criteria.map((one) => ({ key: one.key, label: one.label, weight_pct: one.weightPct })) },
    created_by: view.createdBy,
    updated_by: view.updatedBy,
    submitted_by: view.submittedBy,
    approved_by: view.approvedBy,
    created_at: view.createdAt,
    updated_at: view.updatedAt,
    submitted_at: view.submittedAt,
    approved_at: view.approvedAt,
    decision_reason: view.decisionReason,
    actions,
    as_of: view.asOf,
  };
}

const listItemView = (item: AppraisalListItem): Record<string, unknown> => ({
  id: item.id,
  code: item.code,
  revision: item.revision,
  title: item.title,
  kind: item.kind,
  status: item.status,
  version: item.version,
  owner_unit: item.ownerUnit,
  project: item.project,
  package: item.package,
  contract: item.contract,
  result_state: item.resultState,
  npv: item.npv,
  irr_pct: item.irrPct,
  payback_periods: item.paybackPeriods,
  index_pct: item.indexPct,
  created_by_name: item.createdByName,
  approved_by_name: item.approvedByName,
  updated_at: item.updatedAt,
});

/**
 * The appraisal of the economic and financial effectiveness of an investment (lane FIN-1, customer requirement AI.06; PRJ-23, PRJ-24). The server computes every result with the formula module of the
 * kernel and never takes a number from the client: the commands carry inputs (a cash flow, a rate, scenarios as deltas, the source and the owner of each input, the scores of the criteria) and
 * nothing else. A draft is edited and computed; it is submitted when every input has its source and owner and the result belongs to exactly these inputs; it is approved by someone other than whoever
 * made, edited or submitted it, and approval computes the results once more and freezes them with their hash and the formula version. The AI assistant may later explain a result; it produces no input.
 * Every command is audited and idempotent; the money in an appraisal is exact to two decimals.
 */
@Controller()
export class InvestmentAppraisalController {
  private readonly appraisals = new FinAppraisalStore();

  @Post('investment-appraisals')
  @HttpCode(200)
  @OperationId('createInvestmentAppraisal')
  @Command({ operation: 'createInvestmentAppraisal' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['PrjFinAppraisalCreate']): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const done = await this.appraisals.create(
      scope.tx,
      {
        title: body.title,
        kind: body.kind,
        ownerUnitId: body.owner_unit_id,
        projectId: body.project_id,
        packageId: body.package_id,
        contractId: body.contract_id,
        reviseOf: body.revise_of,
        periodUnit: body.period_unit,
        discountRatePct: body.discount_rate_pct,
        convention: body.convention,
      },
      scope.tenant.membershipId,
      appraisalScope(access, MANAGE, now),
      now,
    );
    await this.record(scope, done, 'project.fin_appraisal_created', 'project.fin_appraisal_created.v1', now, { revise_of: body.revise_of ?? null });
    return { ...commandResult(scope, done.status, done.version, done.id), code: done.code, revision: done.revision };
  }

  @Post('investment-appraisals/:id/inputs')
  @HttpCode(200)
  @OperationId('updateInvestmentAppraisalInputs')
  @Command({ operation: 'updateInvestmentAppraisalInputs', versioned: true })
  async update(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjFinAppraisalInputs']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.appraisals.updateInputs(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      {
        title: body.title,
        periodUnit: body.period_unit,
        discountRatePct: body.discount_rate_pct,
        convention: body.convention,
        lines: body.lines,
        assumptions: body.assumptions.map((entry) => ({ key: entry.key, value: entry.value, unit: entry.unit, sourceKind: entry.source_kind, source: entry.source, ownerId: entry.owner_id })),
        scenarios: body.scenarios,
        sensitivity: (body.sensitivity ?? null) as FinSensitivityConfig | null,
        criteriaCategory: body.criteria_category ?? null,
        scores: body.scores,
      },
      scope.tenant.membershipId,
      appraisalScope(access, MANAGE, now),
    );
    await this.record(scope, done, 'project.fin_appraisal_inputs_updated', 'project.fin_appraisal_inputs_updated.v1', now, { lines: body.lines.length, assumptions: body.assumptions.length, scenarios: body.scenarios.length, scores: body.scores.length });
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('investment-appraisals/:id/runs')
  @HttpCode(200)
  @OperationId('runInvestmentAppraisal')
  @Command({ operation: 'runInvestmentAppraisal', versioned: true })
  async run(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const done = await this.appraisals.run(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, scope.tenant.membershipId, appraisalScope(access, MANAGE, now), now);
    await this.record(scope, done, 'project.fin_appraisal_computed', 'project.fin_appraisal_computed.v1', now, {});
    return { ...commandResult(scope, done.status, done.version, done.id), result_hash: done.resultHash, formula_version: done.formulaVersion };
  }

  @Post('investment-appraisals/:id/submission')
  @HttpCode(200)
  @OperationId('submitInvestmentAppraisal')
  @Command({ operation: 'submitInvestmentAppraisal', versioned: true })
  async submit(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const done = await this.appraisals.submit(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, scope.tenant.membershipId, appraisalScope(access, SUBMIT, now), now);
    await this.record(scope, done, 'project.fin_appraisal_submitted', 'project.fin_appraisal_submitted.v1', now, {});
    return { ...commandResult(scope, done.status, done.version, done.id), result_hash: done.resultHash, formula_version: done.formulaVersion };
  }

  @Post('investment-appraisals/:id/approval')
  @HttpCode(200)
  @OperationId('approveInvestmentAppraisal')
  @Command({ operation: 'approveInvestmentAppraisal', versioned: true })
  async approve(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjFinAppraisalApproval']): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const done = await this.appraisals.approve(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, body.reason, scope.tenant.membershipId, appraisalScope(access, APPROVE, now), now);
    await this.record(scope, done, 'project.fin_appraisal_approved', 'project.fin_appraisal_approved.v1', now, {}, body.reason);
    return { ...commandResult(scope, done.status, done.version, done.id), result_hash: done.resultHash, formula_version: done.formulaVersion };
  }

  @Post('investment-appraisals/:id/return')
  @HttpCode(200)
  @OperationId('returnInvestmentAppraisal')
  @Command({ operation: 'returnInvestmentAppraisal', versioned: true })
  async giveBack(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjFinAppraisalReturn']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.appraisals.returnToDraft(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, body.reason, scope.tenant.membershipId, appraisalScope(access, APPROVE, now));
    await this.record(scope, done, 'project.fin_appraisal_returned', 'project.fin_appraisal_returned.v1', now, {}, body.reason);
    return commandResult(scope, done.status, done.version, done.id);
  }

  /**
   * The file that carries an appraisal out for cross-checking (KT.02): inputs with their sources and owners, the formula of every measure with its assumptions, the table of the cash flow with the discount
   * factor and present value of each period, scenarios, sensitivity, and the hash of the result. Only current results are exported (frozen at approval, or computed from the inputs as they are now); a
   * draft is marked as one. The export is a command because it is a record: who took the figures out, in which format, with which hash.
   */
  @Post('investment-appraisals/:id/export')
  @HttpCode(200)
  @OperationId('exportInvestmentAppraisal')
  @Command({ operation: 'exportInvestmentAppraisal' })
  async export(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjFinAppraisalExport']): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const made = await this.appraisals.exportData(scope.tx, id.toLowerCase(), appraisalScope(access, EXPORT, now), now);
    const document = finExportDocument(made.input);
    const bytes: Uint8Array = body.format === 'CSV' ? new Uint8Array(Buffer.from(csvOf(document), 'utf8')) : xlsxOf(document);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const fileName = `${made.input.code}-v${made.input.revision}.${body.format === 'CSV' ? 'csv' : 'xlsx'}`;
    await this.record(scope, made.appraisal, 'project.fin_appraisal_exported', 'project.fin_appraisal_exported.v1', now, { format: body.format, sha256, size_bytes: bytes.length });
    return {
      ...commandResult(scope, 'EXPORTED', made.appraisal.version, made.appraisal.id),
      file_name: fileName,
      media_type: MEDIA_TYPE[body.format] as string,
      size_bytes: bytes.length,
      sha256,
      content_base64: Buffer.from(bytes).toString('base64'),
      result_hash: made.input.resultHash,
      formula_version: made.input.formulaVersion,
      as_of: now.toISOString(),
    };
  }

  /** The audit row and the event of a command on an appraisal: ids, status, hashes and counts, never the figures or the words of the inputs. */
  private async record(scope: CommandScope, done: AppraisalCommandResult, action: string, type: string, now: Date, extra: Record<string, unknown>, reason?: string): Promise<void> {
    const facts = { code: done.code, revision: done.revision, kind: done.kind, status: done.status, owner_unit_id: done.ownerUnitId, project_id: done.projectId, result_hash: done.resultHash, formula_version: done.formulaVersion, ...extra };
    await scope.audit({ action, resourceType: RESOURCE, resourceId: done.id, classification: CLASSIFICATION, ...(reason === undefined ? {} : { reason }), diff: facts });
    await scope.emit({
      aggregateType: RESOURCE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, appraisal_id: done.id, ...facts, version: done.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${RESOURCE}:${done.id}:${done.version}:${action}`,
    });
  }
}

/** The appraisals in the scope of the caller (PRJ-23, PRJ-24); the buttons are the commands the caller may give now, so the screen shows no button that the server would refuse. */
@Controller()
export class InvestmentAppraisalReadsController {
  private readonly appraisals = new FinAppraisalStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('investment-appraisals')
  @OperationId('listInvestmentAppraisals')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('project_id') projectId?: unknown,
    @Query('package_id') packageId?: unknown,
    @Query('contract_id') contractId?: unknown,
    @Query('status') status?: unknown,
    @Query('kind') kind?: unknown,
    @Query('q') q?: unknown,
    @Query('limit') limit?: unknown,
    @Query('offset') offset?: unknown,
  ): Promise<Record<string, unknown>> {
    const now = new Date();
    const filter = {
      projectId: textQuery(projectId, 'project_id'),
      packageId: textQuery(packageId, 'package_id'),
      contractId: textQuery(contractId, 'contract_id'),
      status: textQuery(status, 'status'),
      kind: textQuery(kind, 'kind'),
      q: textQuery(q, 'q'),
      limit: positiveInt(limit, 'limit', 1, 100),
      offset: positiveInt(offset, 'offset', 0, 1_000_000),
    };
    const found = await this.database.withTenant(tenant, (tx) => this.appraisals.list(tx, filter, appraisalScope(access, READ, now)));
    return { items: found.items.map(listItemView), total: found.total, actions: { create: holdsPermission(effectivePermissions(access, now), MANAGE) }, as_of: now.toISOString() };
  }

  @Get('investment-appraisals/:id')
  @OperationId('getInvestmentAppraisal')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const view = await this.database.withTenant(tenant, (tx) => this.appraisals.view(tx, id.toLowerCase(), appraisalScope(access, READ, now), now));
    // An appraisal in another tenant or outside the scope of the caller is indistinguishable from one that does not exist.
    if (view === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const refs = [{ ownerUnitPath: view.ownerUnit.path, ownerUnitId: view.ownerUnit.id, ...(view.project === null ? {} : { projectId: view.project.id }), ...(view.contract === null ? {} : { contractId: view.contract.id }) }];
    const me = tenant.membershipId.toLowerCase();
    const maker = [view.createdBy.id, view.updatedBy.id, view.submittedBy?.id ?? null].some((who) => who !== null && who.toLowerCase() === me);
    const draft = view.status === 'DRAFT';
    const submitted = view.status === 'SUBMITTED';
    return appraisalView(view, {
      update_inputs: draft && reaches(access, MANAGE, refs, now),
      run: draft && reaches(access, MANAGE, refs, now),
      submit: draft && reaches(access, SUBMIT, refs, now),
      approve: submitted && !maker && reaches(access, APPROVE, refs, now),
      return: submitted && reaches(access, APPROVE, refs, now),
      export: view.resultsFresh && view.results !== null && reaches(access, EXPORT, refs, now),
      revise: view.status === 'APPROVED' && view.nextRevisionId === null && reaches(access, MANAGE, refs, now),
    });
  }
}
