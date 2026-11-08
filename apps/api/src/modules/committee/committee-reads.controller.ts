import { Controller, Get, Header, Inject, Optional, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { CommitteeRosterStore, CommitteeViewAuditStore, ReportStore, TenantDatabase } from '@machvon/db';
import type { ViewRecord } from '@machvon/db';
import { COMMITTEE_CLASSIFICATION, COMMITTEE_PACK_CODE, COMMITTEE_PACK_VERSION, COMMITTEE_ROSTER_CLASSIFICATION, DomainError, assuranceOf, attentionReasonOf, committeeScreenOf, vietnamDateOf } from '@machvon/kernel';
import type { AssuranceLevel, CommitteeScreen, EffectiveAccess, FactsFilter, TenantContext } from '@machvon/kernel';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { COMMITTEE_ASSURANCE, COMMITTEE_CLOCK, COMMITTEE_FACTS_READER } from './tokens';
import { CommitteeWorkspaceService } from './committee-service';
import type { CommitteeRead } from './committee-service';
import { alertDto, attentionDto, feedDto, memberDto, policyDto, rowDto, trackerDto, unitDto } from './committee-view';
import type { ProvinceFactsReader } from '@machvon/db';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function optionalText(value: unknown, field: string, max = 100): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '' || value.length > max) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
}

function optionalDay(value: unknown, field: string): string | undefined {
  const text = optionalText(value, field, 10);
  if (text === undefined) return undefined;
  if (!DAY.test(text) || new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) !== text) throw new DomainError('VALIDATION_FAILED', 422, field);
  return text;
}

function optionalUuid(value: unknown, field: string): string | undefined {
  const text = optionalText(value, field, 36);
  if (text !== undefined && !UUID.test(text)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return text?.toLowerCase();
}

function optionalFlag(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value !== 'true' && value !== 'false') throw new DomainError('VALIDATION_FAILED', 422, field);
  return value === 'true';
}

function optionalLimit(value: unknown, max: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'string' && /^\d{1,4}$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw new DomainError('VALIDATION_FAILED', 422, 'limit');
  return parsed;
}

interface Filters {
  sector_code?: unknown;
  district_code?: unknown;
  investor_unit_id?: unknown;
  fund_source_code?: unknown;
}

function filterOf(query: Filters): { filter: FactsFilter; audit: Record<string, string> } {
  const sectorCode = optionalText(query.sector_code, 'sector_code');
  const districtCode = optionalText(query.district_code, 'district_code');
  const investorUnitId = optionalUuid(query.investor_unit_id, 'investor_unit_id');
  const fundSourceCode = optionalText(query.fund_source_code, 'fund_source_code');
  return {
    filter: { sectorCode, districtCode, investorUnitId, fundSourceCode },
    audit: Object.fromEntries(Object.entries({ sector_code: sectorCode, district_code: districtCode, investor_unit_id: investorUnitId, fund_source_code: fundSourceCode }).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  };
}

/**
 * The reads of the committee workspace (lane BAN-1, docs/committee-workspace.md). Every one needs `committee.read` over the WHOLE tenant (a province-wide read across investors and sectors, never across tenants: row-level
 * security still holds) and writes the audit row of the view in the same transaction as the read, so a view that cannot be recorded is not answered and nobody sees these screens anonymously. The answers are never cached
 * by a browser or a proxy. Nothing here writes a financial table.
 */
@Controller()
export class CommitteeReadsController {
  private readonly service: CommitteeWorkspaceService;
  private readonly audit = new CommitteeViewAuditStore();
  private readonly roster = new CommitteeRosterStore();
  private readonly reports = new ReportStore();
  private readonly clock: () => Date;
  private readonly assurance: (tenant: TenantContext) => AssuranceLevel;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(COMMITTEE_FACTS_READER) reader?: ProvinceFactsReader,
    @Optional() @Inject(COMMITTEE_CLOCK) clock?: () => Date,
    @Optional() @Inject(COMMITTEE_ASSURANCE) assurance?: (tenant: TenantContext) => AssuranceLevel,
  ) {
    this.service = new CommitteeWorkspaceService(reader);
    this.clock = clock ?? ((): Date => new Date());
    // The level of assurance of the session is read here once the identity provider of the infrastructure phase supplies it; until then it is not known and the audit says so.
    this.assurance = assurance ?? ((): AssuranceLevel => assuranceOf(undefined));
  }

  private assertWhole(access: EffectiveAccess, permission: string): void {
    if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
  }

  private async view(read: CommitteeRead, tenant: TenantContext, screen: CommitteeScreen, filters: Record<string, string | number | boolean | null>, recordCount: number | null, tx: Parameters<CommitteeViewAuditStore['record']>[0]): Promise<void> {
    const view: ViewRecord = {
      membershipId: tenant.membershipId,
      screen,
      filters,
      asOf: read.facts.asOf,
      recordCount,
      feedBasis: read.facts.feed.basis,
      feedReference: read.facts.feed.reference,
      classification: COMMITTEE_CLASSIFICATION,
      assurance: this.assurance(tenant),
      requestId: null,
      today: read.today,
    };
    await this.audit.record(tx, view);
  }

  private asOfOf(value: unknown, today: string): string {
    const day = optionalDay(value, 'as_of') ?? today;
    if (day > today) throw new DomainError('VALIDATION_FAILED', 422, 'as_of');
    return day;
  }

  @Get('committee/workspace')
  @Header('Cache-Control', 'no-store')
  @OperationId('getCommitteeWorkspace')
  async workspace(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('as_of') asOf?: unknown, @Query() query: Filters = {}): Promise<Schemas['CommitteeWorkspace']> {
    this.assertWhole(access, PERMISSIONS.getCommitteeWorkspace);
    const today = vietnamDateOf(this.clock());
    const day = this.asOfOf(asOf, today);
    const { filter, audit } = filterOf(query);
    return this.database.withTenant(tenant, async (tx) => {
      const read = await this.service.read(tx, { asOf: day, filter });
      const types = await this.service.alertTypes(tx, day);
      const stored = await this.service.storedAlerts(tx, 'LIVE');
      const w = read.workspace;
      await this.view(read, tenant, 'WORKSPACE', { ...audit, as_of: asOf === undefined ? null : day }, w.province.projects, tx);
      return {
        as_of: w.asOf,
        fiscal_year: w.fiscalYear,
        feed: feedDto(w.feed),
        policy: policyDto(read.policy, w.asOf),
        figures: read.figures as Schemas['CommitteeFigure'][],
        province: rowDto(w.province),
        by_sector: w.bySector.map(rowDto),
        by_district: w.byDistrict.map(rowDto),
        by_investor: w.byInvestor.map(rowDto),
        by_fund_source: w.byFundSource.map(rowDto),
        attention_total: w.attentionTotal,
        attention: read.attention.slice(0, read.policy.params.attentionTopN).map(attentionDto),
        units: w.units.map(unitDto),
        alerts: stored.map((row) => alertDto(row, types)),
        changes: { lines: w.changes.lines.map((line) => ({ kind: line.kind, direction: line.direction, params: line.params, link: line.link, metric_code: line.metricCode })), previous_as_of: w.changes.previousAsOf, reason: w.changes.reason },
        directives: trackerDto(read.tracker, read.today, read.escalateAfterDays, read.figures),
        filters: audit,
      };
    });
  }

  @Get('committee/attention')
  @Header('Cache-Control', 'no-store')
  @OperationId('listCommitteeAttention')
  async attention(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('as_of') asOf?: unknown,
    @Query('reason') reason?: unknown,
    @Query('include_deferred') includeDeferred?: unknown,
    @Query('limit') limit?: unknown,
    @Query() query: Filters = {},
  ): Promise<Schemas['CommitteeAttentionList']> {
    this.assertWhole(access, PERMISSIONS.listCommitteeAttention);
    const today = vietnamDateOf(this.clock());
    const day = this.asOfOf(asOf, today);
    const reasonText = optionalText(reason, 'reason');
    const wanted = reasonText === undefined ? undefined : attentionReasonOf(reasonText);
    if (reasonText !== undefined && wanted === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
    const withDeferred = optionalFlag(includeDeferred, 'include_deferred') ?? false;
    const size = optionalLimit(limit, 200);
    const { filter, audit } = filterOf(query);
    return this.database.withTenant(tenant, async (tx) => {
      const read = await this.service.read(tx, { asOf: day, filter });
      const visible = read.attention.filter((item) => (wanted === undefined || item.signals.some((signal) => signal.reason === wanted)) && (withDeferred || item.decision === null || item.decision.decision !== 'DEFERRED' || (item.decision.deferUntil ?? '') < read.today));
      const shown = visible.slice(0, size ?? read.policy.params.attentionTopN);
      await this.view(read, tenant, 'ATTENTION', { ...audit, reason: wanted ?? null, include_deferred: withDeferred }, shown.length, tx);
      return { as_of: read.facts.asOf, feed: feedDto(read.workspace.feed), policy: policyDto(read.policy, read.facts.asOf), total: visible.length, shown: shown.length, items: shown.map(attentionDto) };
    });
  }

  @Get('committee/directive-tracker')
  @Header('Cache-Control', 'no-store')
  @OperationId('getCommitteeDirectiveTracker')
  async tracker(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Schemas['CommitteeDirectiveTracker']> {
    this.assertWhole(access, PERMISSIONS.getCommitteeDirectiveTracker);
    const today = vietnamDateOf(this.clock());
    return this.database.withTenant(tenant, async (tx) => {
      const read = await this.service.read(tx, { asOf: today });
      await this.view(read, tenant, 'DIRECTIVE_TRACKER', {}, read.tracker.units.length, tx);
      return trackerDto(read.tracker, read.today, read.escalateAfterDays, read.figures);
    });
  }

  @Get('committee/meeting-pack')
  @Header('Cache-Control', 'no-store')
  @OperationId('getCommitteeMeetingPack')
  async meetingPack(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('as_of') asOf?: unknown): Promise<Schemas['CommitteeMeetingPack']> {
    this.assertWhole(access, PERMISSIONS.getCommitteeMeetingPack);
    const today = vietnamDateOf(this.clock());
    const day = this.asOfOf(asOf, today);
    return this.database.withTenant(tenant, async (tx) => {
      const read = await this.service.read(tx, { asOf: day });
      const w = read.workspace;
      const drafts = await this.reports.listDrafts(tx, { layoutCode: COMMITTEE_PACK_CODE, limit: 10 });
      const issues = await this.reports.listIssues(tx, { layoutCode: COMMITTEE_PACK_CODE, limit: 10 });
      await this.view(read, tenant, 'MEETING_PACK', { as_of: asOf === undefined ? null : day }, read.attention.length, tx);
      return {
        as_of: w.asOf,
        fiscal_year: w.fiscalYear,
        feed: feedDto(w.feed),
        policy: policyDto(read.policy, w.asOf),
        layout_code: COMMITTEE_PACK_CODE,
        layout_version: COMMITTEE_PACK_VERSION,
        figures: read.figures as Schemas['CommitteeFigure'][],
        province: rowDto(w.province),
        by_sector: w.bySector.map(rowDto),
        by_district: w.byDistrict.map(rowDto),
        by_investor: w.byInvestor.map(rowDto),
        by_fund_source: w.byFundSource.map(rowDto),
        attention: read.attention.slice(0, read.policy.params.attentionTopN).map(attentionDto),
        directives: trackerDto(read.tracker, read.today, read.escalateAfterDays, read.figures),
        generation: {
          period: { kind: 'AS_OF', year: w.fiscalYear, day: w.asOf },
          recent_drafts: drafts.map((row) => ({ id: row.id, status: row.state, revision: row.baseRevision + 1, created_at: row.createdAt })),
          recent_issues: issues.map((row) => ({ id: row.id, revision: row.revision, sha256: row.sha256, issued_at: row.issuedAt })),
        },
      };
    });
  }

  @Get('committee/alerts')
  @Header('Cache-Control', 'no-store')
  @OperationId('listCommitteeAlerts')
  async alerts(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('status') status?: unknown): Promise<Schemas['CommitteeAlertList']> {
    this.assertWhole(access, PERMISSIONS.listCommitteeAlerts);
    const today = vietnamDateOf(this.clock());
    const wanted = optionalText(status, 'status', 20);
    if (wanted !== undefined && !['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'LIVE'].includes(wanted)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    return this.database.withTenant(tenant, async (tx) => {
      const read = await this.service.read(tx, { asOf: today });
      const types = await this.service.alertTypes(tx, today);
      const stored = await this.service.storedAlerts(tx, (wanted ?? 'LIVE') as 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED' | 'LIVE');
      await this.view(read, tenant, 'ALERTS', { status: wanted ?? 'LIVE' }, stored.length, tx);
      return { as_of: read.facts.asOf, policy: policyDto(read.policy, read.facts.asOf), alerts: stored.map((row) => alertDto(row, types)) };
    });
  }

  @Get('committee/roster')
  @Header('Cache-Control', 'no-store')
  @OperationId('getCommitteeRoster')
  async rosterOf(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Schemas['CommitteeRoster']> {
    this.assertWhole(access, PERMISSIONS.getCommitteeRoster);
    const today = vietnamDateOf(this.clock());
    return this.database.withTenant(tenant, async (tx) => {
      const committees = await this.roster.committees(tx);
      const members = await this.roster.members(tx);
      await this.audit.record(tx, { membershipId: tenant.membershipId, screen: 'ROSTER', filters: {}, asOf: null, recordCount: members.length, feedBasis: null, feedReference: null, classification: COMMITTEE_ROSTER_CLASSIFICATION, assurance: this.assurance(tenant), requestId: null, today });
      return {
        classification: COMMITTEE_ROSTER_CLASSIFICATION,
        committees: committees.map((committee) => ({ id: committee.id, code: committee.code, name: committee.name, legal_basis: committee.legalBasis, status: committee.status, version: committee.version, members: members.filter((member) => member.committeeId === committee.id).map(memberDto) })),
      };
    });
  }

  @Get('committee/view-audit')
  @Header('Cache-Control', 'no-store')
  @OperationId('listCommitteeViewAudit')
  async viewAudit(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('screen') screen?: unknown,
    @Query('membership_id') membershipId?: unknown,
    @Query('from') from?: unknown,
    @Query('to') to?: unknown,
    @Query('before') before?: unknown,
    @Query('limit') limit?: unknown,
  ): Promise<Schemas['CommitteeViewAuditList']> {
    this.assertWhole(access, PERMISSIONS.listCommitteeViewAudit);
    const today = vietnamDateOf(this.clock());
    const screenText = optionalText(screen, 'screen', 30);
    const chosen = screenText === undefined ? undefined : committeeScreenOf(screenText);
    if (screenText !== undefined && chosen === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'screen');
    const cursor = optionalText(before, 'before', 80);
    if (cursor !== undefined && !/^[0-9T:.\-Z]+\|[0-9a-f-]{36}$/i.test(cursor)) throw new DomainError('VALIDATION_FAILED', 422, 'before');
    return this.database.withTenant(tenant, async (tx) => {
      const page = await this.audit.list(tx, { screen: chosen, membershipId: optionalUuid(membershipId, 'membership_id'), from: optionalDay(from, 'from'), to: optionalDay(to, 'to'), before: cursor, limit: optionalLimit(limit, 200) ?? 50 });
      // Reading the audit is itself audited: the auditor is as traceable as the head.
      await this.audit.record(tx, { membershipId: tenant.membershipId, screen: 'VIEW_AUDIT', filters: { screen: chosen ?? null }, asOf: null, recordCount: page.rows.length, feedBasis: null, feedReference: null, classification: COMMITTEE_ROSTER_CLASSIFICATION, assurance: this.assurance(tenant), requestId: null, today });
      return {
        next: page.next,
        rows: page.rows.map((row) => ({ id: row.id, membership_id: row.membershipId, display_name: row.displayName, committee_role: row.committeeRole, screen: row.screen, filters: row.filters, as_of: row.asOf, record_count: row.recordCount, feed_basis: row.feedBasis, assurance_level: row.assuranceLevel, mfa_required: row.mfaRequired, viewed_at: row.viewedAt })),
      };
    });
  }
}
