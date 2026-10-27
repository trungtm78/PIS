import { Controller, Get, Inject, Optional, Query } from '@nestjs/common';
import { DisSnapshotStore, DisWarningStore, HomeReadStore, TenantDatabase, projectScope } from '@machvon/db';
import type { WarningRow } from '@machvon/db';
import { DomainError, OPEN_WARNING_STATUSES, WARNING_SEVERITIES, warningHistory } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { HOME_READ_PERMISSION } from './scope-hash';
import { HOME_CLOCK } from './tokens';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RULE_CODE = /^[A-Z][A-Z0-9-]{0,29}$/;
const TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$/;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

function optionalUuid(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid(field);
  return value.toLowerCase();
}

/**
 * The early warnings of the command center (ST-HOME-003, HOME 3 F4, HOME-03 and HOME-06): the open warnings of the projects the reader may read, the newest first, narrowed by the severity and the rule, each with what a
 * leader needs to act on it: the rule and the threshold it was opened under, what was observed, the project, the leader in charge now (read as DIS-24 reads it), and the explanation that was asked for. With `warning_id` the
 * answer is the profile of one warning, whatever its status: the evidence (the cells of the project in the snapshot the warning was opened on, with the day the figures are as of) and its history. HOME writes nothing:
 * acknowledging, dismissing and asking for an explanation are the commands of DIS and PRJ, under their own rights.
 */
@Controller()
export class HomeWarningsController {
  private readonly warnings = new DisWarningStore();
  private readonly snapshots = new DisSnapshotStore();
  private readonly reads = new HomeReadStore();
  private readonly clock: () => Date;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(HOME_CLOCK) clock?: () => Date,
  ) {
    this.clock = clock ?? ((): Date => new Date());
  }

  @Get('home/warnings')
  @OperationId('getHomeWarnings')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('snapshot_id') snapshotId?: unknown,
    @Query('severity') severity?: unknown,
    @Query('rule_code') ruleCode?: unknown,
    @Query('warning_id') warningId?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<Record<string, unknown>> {
    const request = parsePageRequest(limit, cursor);
    if (request.after !== undefined && (!TIMESTAMP.test(request.after.code) || Number.isNaN(Date.parse(request.after.code)))) throw invalid('cursor');
    if (severity !== undefined && (typeof severity !== 'string' || !(WARNING_SEVERITIES as readonly string[]).includes(severity))) throw invalid('severity');
    if (ruleCode !== undefined && (typeof ruleCode !== 'string' || !RULE_CODE.test(ruleCode))) throw invalid('rule_code');
    const filter = { snapshotId: optionalUuid(snapshotId, 'snapshot_id'), id: optionalUuid(warningId, 'warning_id'), severity: severity as string | undefined, ruleCode: ruleCode as string | undefined };
    const now = this.clock();
    const scope = projectScope(access, HOME_READ_PERMISSION, now);
    const profile = filter.id !== undefined;
    const read = await this.database.withTenant(tenant, async (tx) => {
      // A profile is of one warning, whatever its status; a list is of the ones that are open.
      const rows = await this.warnings.list(tx, scope, { ...filter, ...(profile ? {} : { statuses: OPEN_WARNING_STATUSES }) }, { limit: request.limit + 1, after: request.after === undefined ? undefined : { openedAt: request.after.code, id: request.after.id } });
      const shown = rows.slice(0, request.limit);
      const leaders = await this.reads.leadersOf(tx, shown.flatMap((row) => (row.projectId === null ? [] : [row.projectId])));
      const rules = await this.reads.rulesOf(tx, shown.map((row) => row.ruleId));
      const explanations = await this.reads.explanationsOf(tx, shown.flatMap((row) => (row.explanationRequestId === null ? [] : [row.explanationRequestId])));
      const evidence = new Map<string, { asOfDate: string; cells: Array<Record<string, unknown>> }>();
      if (profile) {
        for (const row of shown) {
          if (row.projectId === null) continue;
          const snapshot = await this.snapshots.find(tx, row.snapshotId);
          if (snapshot === undefined) continue;
          const lines = await this.snapshots.lines(tx, row.snapshotId, scope, { projectId: row.projectId }, { limit: 200, after: undefined });
          evidence.set(row.id, {
            asOfDate: snapshot.asOfDate,
            cells: lines.map((line) => ({ bucket: line.bucket, budget_level: line.budgetLevel, plan_pm_assigned_vnd: line.planPmAssignedVnd, plan_local_added_vnd: line.planLocalAddedVnd, disbursed_treasury_vnd: line.disbursedTreasuryVnd, rate_pm_pct: line.ratePmPct, rate_total_pct: line.rateTotalPct, rate_null_reason: line.rateNullReason, treasury_coverage: line.treasuryCoverage })),
          });
        }
      }
      return { rows, shown, leaders, rules, explanations, evidence };
    });
    const last = read.shown[read.shown.length - 1];
    const item = (row: WarningRow): Record<string, unknown> => {
      const rule = read.rules.get(row.ruleId);
      const leader = row.projectId === null ? undefined : read.leaders.get(row.projectId);
      const explanation = row.explanationRequestId === null ? undefined : read.explanations.get(row.explanationRequestId);
      return {
        id: row.id,
        rule: { code: row.ruleCode, name: row.ruleName, metric_code: rule?.metricCode ?? null, comparator: rule?.comparator ?? null, threshold: rule?.threshold ?? null },
        severity: row.severity,
        status: row.status,
        project: row.projectId === null ? null : { id: row.projectId, code: row.projectCode, name: row.projectName },
        observed: row.observed,
        snapshot_id: row.snapshotId,
        // The reporting period the warning is of: a request for an explanation names it, so that two warnings of one project and one rule in two periods are two requests.
        period_id: row.periodId,
        opened_at: row.openedAt,
        closed_at: row.closedAt,
        resolution_reason: row.resolutionReason,
        version: row.version,
        leader: leader === undefined ? null : { membership_id: leader.membershipId, display_name: leader.displayName },
        explanation: explanation === undefined ? null : { id: explanation.id, status: explanation.status, due_at: explanation.dueAt, is_late: explanation.isLate },
        ...(profile
          ? {
              evidence: read.evidence.get(row.id) === undefined ? null : { snapshot_id: row.snapshotId, as_of_date: read.evidence.get(row.id)?.asOfDate, cells: read.evidence.get(row.id)?.cells },
              history: warningHistory({
                openedAt: row.openedAt,
                acknowledgedAt: row.acknowledgedAt,
                acknowledgedBy: row.acknowledgedBy,
                acknowledgementNote: row.acknowledgementNote,
                explanation: explanation === undefined ? null : { requestedAt: explanation.requestedAt, requestedBy: explanation.requestedBy, status: explanation.status, respondedAt: explanation.respondedAt, reviewedAt: null },
                closedAt: row.closedAt,
                closedBy: row.closedBy,
                status: row.status,
                resolutionReason: row.resolutionReason,
              }),
            }
          : {}),
      };
    };
    if (profile && read.shown.length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'warning_id');
    return {
      items: read.shown.map(item),
      next_cursor: read.rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.openedAt, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }
}
