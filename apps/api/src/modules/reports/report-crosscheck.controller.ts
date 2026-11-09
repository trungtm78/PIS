import { Body, Controller, Get, HttpCode, Inject, Optional, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { ReportCrosscheckStore, TenantDatabase } from '@machvon/db';
import { DomainError, assertExplanationAllowed, assertReportPeriod, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, FormPeriod, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { crosscheckDto, explanationDtos, runCrosscheck } from './crosscheck';
import { reportStore } from './report-view';
import { REPORT_CLOCK } from './tokens';

const RESOURCE = 'report_crosscheck_explanation';
const CLASSIFICATION = 'INTERNAL';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LIST = 200;
const store = new ReportCrosscheckStore();

const whole = (access: EffectiveAccess, permission: string): void => {
  if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
};

function integer(value: unknown, field: string): number {
  const parsed = typeof value === 'string' && /^\d{1,4}$/.test(value) ? Number(value) : typeof value === 'number' ? value : Number.NaN;
  if (!Number.isInteger(parsed)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return parsed;
}

/** The month or the quarter of the query, judged like every period of the report engine. */
function periodOfQuery(query: Record<string, unknown>): FormPeriod {
  const kind = query.kind;
  if (kind !== 'MONTH' && kind !== 'QUARTER') throw new DomainError('VALIDATION_FAILED', 422, 'kind');
  const period: FormPeriod = { kind, year: integer(query.year, 'year'), index: integer(query.index, 'index') };
  assertReportPeriod(period);
  return period;
}

/**
 * The reads and the explanation of the comparison of the reports of one period (ENT-4a, CN.04, docs/report-engine.md, section "Cross-report comparison"). The comparison itself is computed at the moment of the read from the reports as they stand
 * (the head issued copy of each form, else its newest open draft) and the frozen snapshot of the period, so it can never be out of date; what is kept is the figures each draft was filled with, the explanations and the
 * evidence of each release. Reading needs `rpt.crosscheck.read` over the whole tenant; explaining needs `rpt.crosscheck.explain` and is refused to anyone who prepared a report the finding is about.
 */
@Controller()
export class ReportCrosscheckController {
  private readonly clock: () => Date;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(REPORT_CLOCK) clock?: () => Date,
  ) {
    this.clock = clock ?? ((): Date => new Date());
  }

  @Get('report-engine/crosscheck')
  @OperationId('getReportCrosscheck')
  async read(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Schemas['RptCrosscheck']> {
    whole(access, PERMISSIONS.getReportCrosscheck);
    const period = periodOfQuery(query);
    const draftId = query.draft_id;
    if (draftId !== undefined && (typeof draftId !== 'string' || !UUID.test(draftId))) throw new DomainError('VALIDATION_FAILED', 422, 'draft_id');
    const now = this.clock();
    return this.database.withTenant(tenant, async (tx) => {
      const context = { database: this.database, tenant, access, tx, now, today: vietnamDateOf(now) };
      if (draftId !== undefined && (await reportStore.findDraft(tx, draftId)) === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'draft_id');
      const run = await runCrosscheck(context, period, draftId);
      return crosscheckDto(context, run, draftId);
    });
  }

  @Get('report-engine/crosscheck/explanations')
  @OperationId('listCrosscheckExplanations')
  async explanations(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Schemas['RptCrosscheckExplanationPage']> {
    whole(access, PERMISSIONS.listCrosscheckExplanations);
    const code = query.period_code;
    if (code !== undefined && (typeof code !== 'string' || code === '' || code.length > 20)) throw new DomainError('VALIDATION_FAILED', 422, 'period_code');
    const limit = query.limit === undefined ? 50 : integer(query.limit, 'limit');
    if (limit < 1 || limit > MAX_LIST) throw new DomainError('VALIDATION_FAILED', 422, 'limit');
    return this.database.withTenant(tenant, async (tx) => {
      const rows = await store.explanations(tx, { ...(code === undefined ? {} : { periodCode: code }), limit: limit + 1 });
      return { items: await explanationDtos(tx, rows.slice(0, limit)), truncated: rows.length > limit, as_of: this.clock().toISOString() };
    });
  }

  @Post('report-engine/crosscheck/explanations')
  @HttpCode(200)
  @OperationId('explainCrosscheckFinding')
  @Command({ operation: 'explainCrosscheckFinding' })
  async explain(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['RptCrosscheckExplain']): Promise<Schemas['RptCrosscheckExplained']> {
    whole(access, PERMISSIONS.explainCrosscheckFinding);
    const { tx } = scope;
    const period: FormPeriod = { kind: body.period.kind, year: body.period.year, ...(body.period.index === undefined ? {} : { index: body.period.index }) };
    if (period.kind !== 'MONTH' && period.kind !== 'QUARTER') throw new DomainError('VALIDATION_FAILED', 422, 'period');
    assertReportPeriod(period);
    const now = this.clock();
    const context = { database: this.database, tenant: scope.tenant, access, tx, now, today: vietnamDateOf(now) };
    const run = await runCrosscheck(context, period);
    const finding = run.result.findings.find((one) => one.fingerprint === body.fingerprint);
    if (finding === undefined) throw new DomainError('CROSSCHECK_FINDING_NOT_FOUND', 404, 'fingerprint');
    // The maker is not the checker: whoever prepared a report the finding is about does not explain it (the database refuses it as well).
    const known = run.explanations.get(finding.fingerprint);
    if (known === undefined) assertExplanationAllowed(finding, { explainerId: scope.tenant.membershipId, reason: body.reason });
    const done = await store.explain(tx, {
      fingerprint: finding.fingerprint,
      ruleId: finding.ruleId,
      figureCode: finding.code,
      periodCode: finding.periodCode,
      severity: finding.severity,
      involves: finding.involves,
      reason: body.reason,
      explainedBy: scope.tenant.membershipId,
    });
    const [dto] = await explanationDtos(tx, [done.row]);
    if (done.outcome === 'EXISTING') {
      await scope.audit({ action: 'rpt.crosscheck_explanation_repeated', resourceType: RESOURCE, resourceId: done.row.id, classification: CLASSIFICATION, diff: { fingerprint: done.row.fingerprint, rule_id: done.row.ruleId, period_code: done.row.periodCode } });
      return { outcome: 'EXISTING', explanation: dto as Schemas['RptCrosscheckExplanation'] };
    }
    await scope.audit({
      action: 'rpt.crosscheck_explained',
      resourceType: RESOURCE,
      resourceId: done.row.id,
      classification: CLASSIFICATION,
      reason: done.row.reason,
      diff: { fingerprint: done.row.fingerprint, rule_id: done.row.ruleId, figure_code: done.row.figureCode, period_code: done.row.periodCode, severity: done.row.severity, involves: done.row.involves, difference: finding.difference, tolerance: finding.tolerance },
    });
    await scope.emit({
      aggregateType: RESOURCE,
      aggregateId: done.row.id,
      aggregateVersion: 1,
      type: 'rpt.crosscheck.explained.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        explanation_id: done.row.id,
        fingerprint: done.row.fingerprint,
        rule_id: done.row.ruleId,
        figure_code: done.row.figureCode,
        period_code: done.row.periodCode,
        severity: done.row.severity,
        involves: done.row.involves,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${RESOURCE}:${done.row.fingerprint}`,
    });
    return { outcome: 'CREATED', explanation: dto as Schemas['RptCrosscheckExplanation'] };
  }
}
