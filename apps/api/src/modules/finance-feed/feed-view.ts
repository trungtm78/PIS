import type { FeedDifferenceRow, FeedHealthReading, FeedMappingRow, FeedRunRow, QuarantinedRow } from '@machvon/db';
import { FEED_KINDS, FEED_PENDING_EXTERNAL_ITEMS, FEED_POSITIONS, egpHeaderOf, feedLayoutColumns } from '@machvon/kernel';
import type { FeedFacts, FeedFinding, FeedKind, FeedProjectFact, FeedQuality } from '@machvon/kernel';

const nameOf = (names: ReadonlyMap<string, string>, id: string | null): string | null => (id === null ? null : (names.get(id) ?? null));

export function runDto(row: FeedRunRow, names: ReadonlyMap<string, string>): Record<string, unknown> {
  return {
    id: row.id,
    channel: row.channel,
    kind: row.kind,
    action: row.action,
    layout_version: row.layoutVersion,
    acceptance: row.acceptance,
    file_sha256: row.fileSha256,
    file_import_id: row.fileImportId,
    seed: row.seed,
    epoch: row.epoch,
    parameters: row.parameters,
    counts: { total: row.counts.total, written: row.counts.written, skipped: row.counts.skipped, rejected: row.counts.rejected },
    as_of_latest: row.asOfLatest,
    digest: row.digest,
    imported_by: row.importedBy,
    imported_by_name: nameOf(names, row.importedBy),
    created_at: row.createdAt,
  };
}

export function rowErrorDto(row: QuarantinedRow): Record<string, unknown> {
  return { line: row.line, business_key: row.businessKey, code: row.errorCode, field: row.field, preview: row.maskedPreview };
}

export function mappingDto(row: FeedMappingRow, names: ReadonlyMap<string, string>, caller: { membershipId: string; mayDecide: boolean; mayRetire: boolean }): Record<string, unknown> {
  return {
    id: row.id,
    our_code: row.ourCode,
    our_name: row.ourName,
    external_code: row.externalCode,
    match_method: row.matchMethod,
    valid_from: row.validFrom,
    valid_until: row.validUntil,
    status: row.status,
    proposed_by: row.proposedBy,
    proposed_by_name: nameOf(names, row.proposedBy),
    proposal_reason: row.proposalReason,
    import_id: row.importId,
    approved_by_name: nameOf(names, row.approvedBy),
    approved_at: row.approvedAt,
    decision_reason: row.decisionReason,
    retired_by_name: nameOf(names, row.retiredBy),
    retired_at: row.retiredAt,
    retire_reason: row.retireReason,
    version: row.version,
    created_at: row.createdAt,
    // The maker does not approve: the screen offers the move only to a person who may make it, and the server judges it again.
    can_decide: caller.mayDecide && row.status === 'PROPOSED' && row.proposedBy !== caller.membershipId,
    can_retire: caller.mayRetire && row.status === 'ACTIVE',
  };
}

export function differenceDto(row: FeedDifferenceRow, names: ReadonlyMap<string, string>, caller: { membershipId: string; mayResolve: boolean }): Record<string, unknown> {
  return {
    id: row.id,
    feed_project_code: row.feedProjectCode,
    our_code: row.ourCode,
    fiscal_year: row.fiscalYear,
    field: row.field,
    kind: row.kind,
    feed_value: row.feed,
    our_value: row.ours,
    delta: row.delta,
    delta_pct: row.deltaPct,
    large: row.large,
    state: row.state,
    owner_id: row.ownerId,
    owner_name: nameOf(names, row.ownerId),
    opened_at: row.openedAt,
    due_at: row.dueAt,
    resolution: row.resolutionKind === null ? null : { kind: row.resolutionKind, resolved_by_name: nameOf(names, row.resolvedBy), resolved_at: row.resolvedAt, reason: row.resolutionReason, evidence_ref: row.evidenceRef, review_on: row.reviewOn },
    version: row.version,
    // A maker of the figures does not settle the item: the screen offers the move only to a person who may make it, and the server judges it again.
    can_resolve: caller.mayResolve && row.state === 'OPEN' && !row.makerIds.includes(caller.membershipId),
  };
}

export function healthDto(reading: FeedHealthReading): Record<string, unknown> {
  const { health, freshness, policy } = reading;
  return {
    status: health.status,
    age_hours: health.ageHours,
    last_run_at: reading.lastRunAt,
    last_run_channel: reading.lastRunChannel,
    alert: health.alert === null ? null : { code: health.alert.code, severity: health.alert.severity },
    figures_blocked: health.figuresBlocked,
    rule: {
      source: freshness.source,
      version: freshness.version,
      unverified: freshness.unverified,
      legal_status: freshness.legalStatus,
      formula: freshness.formula,
      source_text: freshness.sourceText,
      as_of: freshness.asOf,
      warn_after_hours: freshness.params.warn_after_hours,
      max_age_hours: freshness.params.max_age_hours,
      stale_severity: freshness.params.stale_severity,
      figures_blocked_when_stale: freshness.params.figures_blocked_when_stale,
    },
    policy: {
      source: policy.source,
      version: policy.version,
      unverified: policy.unverified,
      legal_status: policy.legalStatus,
      formula: policy.formula,
      source_text: policy.sourceText,
      as_of: policy.asOf,
      tolerance_pct: policy.params.tolerance_pct,
      large_discrepancy_pct: policy.params.large_discrepancy_pct,
      report_due_days: policy.params.report_due_days,
      difference_due_days: policy.params.difference_due_days,
    },
  };
}

export const pendingExternalDto = (): Array<Record<string, unknown>> =>
  FEED_PENDING_EXTERNAL_ITEMS.map((item) => ({ code: item.code, what: item.what, owner: item.owner, working_assumption: item.workingAssumption, switches_when_it_arrives: item.switchesWhenItArrives }));

export const layoutsDto = (): Array<Record<string, unknown>> =>
  FEED_KINDS.map((kind) => ({
    kind,
    connector_code: FEED_POSITIONS[kind],
    columns: feedLayoutColumns(kind).map((column) => ({ name: column.name, kind: column.kind, required: column.required, ...(column.values === undefined ? {} : { values: [...column.values] }) })),
  }));

/** The kinds whose required columns a header row has (names compared as the layouts compare them: without case, spaces and hyphens). */
export function kindsFittingHeaders(headers: readonly string[]): FeedKind[] {
  const present = new Set(headers.map(egpHeaderOf));
  return FEED_KINDS.filter((kind) => feedLayoutColumns(kind).every((column) => !column.required || present.has(column.name)));
}

const decimalOf = (value: bigint): string => {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const fraction = absolute % 100n;
  const body = fraction === 0n ? `${absolute / 100n}` : `${absolute / 100n}.${String(fraction).padStart(2, '0').replace(/0+$/, '')}`;
  return negative ? `-${body}` : body;
};
const sumOf = (record: Record<string, bigint>): bigint => Object.values(record).reduce((sum, value) => sum + value, 0n);

export function projectFactDto(fact: FeedProjectFact): Record<string, unknown> {
  const plan = sumOf(fact.planByFund);
  const disbursed = sumOf(fact.disbursedByFund);
  return {
    feed_project_code: fact.feedProjectCode,
    channel: fact.channel,
    known: fact.known,
    project_name: fact.projectName,
    sector_code: fact.sectorCode,
    district_code: fact.districtCode,
    investor_code: fact.investorCode,
    investor_name: fact.investorName,
    project_status: fact.projectStatus,
    our_project_code: fact.ourProjectCode,
    fiscal_year: fact.fiscalYear,
    plan_by_fund: Object.fromEntries(Object.entries(fact.planByFund).map(([fund, value]) => [fund, decimalOf(value)])),
    disbursed_by_fund: Object.fromEntries(Object.entries(fact.disbursedByFund).map(([fund, value]) => [fund, decimalOf(value)])),
    plan: decimalOf(plan),
    disbursed_cumulative: decimalOf(disbursed),
    monthly: fact.monthly.map(decimalOf),
    latest_month: fact.latestMonth,
    as_of_statement: fact.asOf,
  };
}

export function factsDto(facts: FeedFacts, asOf: string): Record<string, unknown> {
  const group = (one: FeedFacts['totals']): Record<string, unknown> => ({ key: one.key, label: one.label, projects: one.projects, plan: one.plan, disbursed: one.disbursed, cumulative: one.cumulative, rate_pct: one.ratePct, channels: one.channels, as_of_statement: one.asOf });
  return { fiscal_year: facts.fiscalYear, group_by: facts.groupBy, channels: facts.channels, as_of_statement: facts.asOf, totals: group(facts.totals), groups: facts.groups.map(group), as_of: asOf };
}

export function qualityDto(quality: FeedQuality, findings: readonly FeedFinding[], asOf: string): Record<string, unknown> {
  const indicator = (code: string, one: { pct: string | null; numerator: number; denominator: number }): Record<string, unknown> => ({ code, pct: one.pct, numerator: one.numerator, denominator: one.denominator, as_of: quality.asOf });
  const unit = (one: FeedQuality['units'][number]): Record<string, unknown> => ({ investor_code: one.investorCode, investor_name: one.investorName, status: one.status, reported_on: one.reportedOn, due_on: one.dueOn, projects: one.projects });
  return {
    fiscal_year: quality.fiscalYear,
    month: quality.month,
    due_on: quality.dueOn,
    indicators: [indicator('FEED_COMPLETENESS', quality.completeness), indicator('FEED_TIMELINESS', quality.timeliness), indicator('FEED_DISCREPANCY_RATE', quality.discrepancy)],
    units: quality.units.map(unit),
    late_units: quality.lateUnits.map(unit),
    findings: findings.slice(0, 200).map((one) => ({ code: one.code, channel: one.channel, feed_project_code: one.feedProjectCode, fund_code: one.fundCode, month: one.month, expected: one.expected, actual: one.actual, message: one.message })),
    findings_total: findings.length,
    as_of: asOf,
  };
}
