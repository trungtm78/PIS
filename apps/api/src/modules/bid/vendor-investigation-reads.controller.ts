import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidWorkflowReads, GovernancePolicyPort, TenantDatabase, Vnd3PolicyReader, VendorLeadStore, VendorLinkStore, VendorScreeningStore } from '@machvon/db';
import type { TenantTx } from '@machvon/db';
import { DomainError, LEAD_KINDS, LEAD_STATUSES, clusterKeyOf, clustersOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { hitDto, hitEventDto, invPolicyDto, leadEventDto, leadLineDto, leadSignals, linkDto, runDto, sourceDto, todayOf } from './vendor-investigation-view';

const FIGURE_CODES = ['VENDOR_LEAD_PRECISION', 'VENDOR_LEADS_OPEN', 'VENDOR_SCREENING_IN_TIME'] as const;
const HIT_STATUSES = ['PENDING', 'CONFIRMED', 'DISMISSED', 'RESOLVED'];
const SOURCES = ['NATIONAL_DEBARMENT', 'WORLD_BANK', 'ADB', 'PEP', 'OTHER_LIST'];

function text(value: unknown, field: string, max = 100): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '' || value.length > max) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
}

function oneOf(value: unknown, field: string, allowed: readonly string[]): string | undefined {
  const found = text(value, field, 40);
  if (found !== undefined && !allowed.includes(found)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return found;
}

function uuid(value: unknown, field: string): string | undefined {
  const found = text(value, field, 36);
  if (found !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(found)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return found;
}

/** The cursor of the list of leads holds the rank as three digits and the id: the list is ordered by rank then id, both descending. */
function leadCursor(code: string | undefined): void {
  if (code !== undefined && !/^\d{3}$/.test(code)) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
}

/**
 * The reads of the investigation and the screening of contractors (VND-13 to VND-15, docs/vendor-investigation.md). Auditors only for the leads and the graph: every read is judged on a grant over the whole tenant, and a
 * lead that the reader took part in (a package it is about) is a 404, never a hint that it exists. Every figure carries the rule it rests on, with version, formula, source and legal status. A read never writes.
 */
@Controller()
export class VendorInvestigationReadsController {
  private readonly leads = new VendorLeadStore();
  private readonly links = new VendorLinkStore();
  private readonly screening = new VendorScreeningStore();
  private readonly policies = new Vnd3PolicyReader();
  private readonly people = new BidWorkflowReads();
  private readonly rules = new GovernancePolicyPort();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  private require(access: EffectiveAccess, permission: string): void {
    if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
  }

  private async packageCodes(tx: TenantTx, ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await tx.query<{ id: string; code: string }>('select id, code from machvon.procurement_package where id = any($1::uuid[])', [[...ids]]);
    return new Map(rows.map((row) => [row.id, row.code]));
  }

  @Get('vendor/leads')
  @OperationId('listVendorLeads')
  async listLeads(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.require(access, PERMISSIONS.listVendorLeads);
    const now = new Date();
    const today = todayOf(now);
    const status = oneOf(query.status, 'status', LEAD_STATUSES);
    const kind = oneOf(query.kind, 'kind', LEAD_KINDS);
    const contractorId = uuid(query.contractor_id, 'contractor_id');
    const request = parsePageRequest(query.limit, query.cursor);
    leadCursor(request.after?.code);
    return this.database.withTenant(tenant, async (tx) => {
      const reader = tenant.membershipId;
      const rows = await this.leads.list(tx, reader, { status, kind, contractorId, limit: request.limit, after: request.after });
      const shown = rows.slice(0, request.limit);
      const last = shown[shown.length - 1];
      const counts = await this.leads.counts(tx, reader);
      const contractorIds = [...new Set(shown.flatMap((row) => row.contractorIds))];
      const contractors = new Map((await this.links.contractors(tx, contractorIds, today)).map((row) => [row.id, row.name]));
      const packages = await this.packageCodes(tx, [...new Set(shown.flatMap((row) => row.packageIds))]);
      const names = await this.people.names(tx, shown.map((row) => row.reviewerId));
      const policy = await this.policies.investigation(tx, today);
      return {
        items: shown.map((row) => leadLineDto(row, names, contractors, packages)),
        counts: { new: counts.NEW, in_review: counts.IN_REVIEW, dismiss_proposed: counts.DISMISS_PROPOSED, dismissed: counts.DISMISSED, confirmed: counts.CONFIRMED, referred: counts.REFERRED },
        next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: String(last.rank).padStart(3, '0'), id: last.id }) : null,
        policies: { investigation: invPolicyDto('VENDOR_INVESTIGATION', policy) },
        as_of: now.toISOString(),
      };
    });
  }

  @Get('vendor/leads/:id')
  @OperationId('getVendorLead')
  async lead(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    this.require(access, PERMISSIONS.getVendorLead);
    const now = new Date();
    const today = todayOf(now);
    const holds = (permission: string): boolean => holdsOnWholeTenant(access, permission);
    return this.database.withTenant(tenant, async (tx) => {
      const reader = tenant.membershipId;
      const row = await this.leads.findOne(tx, reader, id);
      if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const [history, contractorList, linkRows, coverage, link, rigging, investigation] = await Promise.all([
        this.leads.historyOf(tx, id),
        this.links.contractors(tx, row.contractorIds, today),
        this.links.linksOf(tx, row.contractorIds, true),
        this.leads.traceCoverage(tx, row.packageIds),
        this.policies.link(tx, today),
        this.policies.rigging(tx, today),
        this.policies.investigation(tx, today),
      ]);
      const names = await this.people.names(tx, [row.reviewerId, row.dismissProposedBy, row.dismissedBy, row.confirmedBy, row.referredBy, ...history.map((event) => event.actorId)]);
      const contractors = new Map(contractorList.map((one) => [one.id, one.name]));
      const packages = await this.packageCodes(tx, row.packageIds);
      return {
        lead: leadLineDto(row, names, contractors, packages),
        signals: leadSignals(row),
        contractors: contractorList.map((one) => ({ id: one.id, name: one.name, tax_identifier: one.taxIdentifier, restricted: one.restricted })),
        links: linkRows.map(linkDto),
        history: history.map((event) => leadEventDto(event, names)),
        trace_coverage: { bids: coverage.bids, with_origin: coverage.withOrigin, with_files: coverage.withFiles },
        dismiss_proposed_by_name: names.get(row.dismissProposedBy ?? '') ?? null,
        dismiss_reason: row.dismissReason,
        confirm_reason: row.confirmReason,
        referral_reason: row.referralReason,
        policies: { link: invPolicyDto('VENDOR_LINK_RULE', link), rigging: invPolicyDto('VENDOR_BID_RIGGING', rigging), investigation: invPolicyDto('VENDOR_INVESTIGATION', investigation) },
        may_take: row.status === 'NEW' && holds(PERMISSIONS.takeVendorLead),
        may_propose_dismissal: row.status === 'IN_REVIEW' && holds(PERMISSIONS.proposeVendorLeadDismissal),
        may_confirm_dismissal: row.status === 'DISMISS_PROPOSED' && row.dismissProposedBy !== reader && holds(PERMISSIONS.confirmVendorLeadDismissal),
        may_reject_dismissal: row.status === 'DISMISS_PROPOSED' && holds(PERMISSIONS.rejectVendorLeadDismissal),
        may_confirm_signal: row.status === 'IN_REVIEW' && holds(PERMISSIONS.confirmVendorLeadSignal),
        may_refer: (row.status === 'IN_REVIEW' || row.status === 'CONFIRMED') && holds(PERMISSIONS.referVendorLead),
        as_of: now.toISOString(),
      };
    });
  }

  @Get('vendor/contractors/:id/links')
  @OperationId('getVendorContractorLinks')
  async contractorLinks(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    this.require(access, PERMISSIONS.getVendorContractorLinks);
    const now = new Date();
    const today = todayOf(now);
    return this.database.withTenant(tenant, async (tx) => {
      const [self] = await this.links.contractors(tx, [id], today);
      if (self === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const policy = await this.policies.link(tx, today);
      const near = await this.links.linksOf(tx, [id], false);
      const nodeIds = [...new Set([id, ...near.flatMap((row) => [row.aId, row.bId])])];
      const all = await this.links.linksOf(tx, nodeIds, true);
      const active = all.filter((row) => row.status === 'ACTIVE').map((row) => ({ a: row.aId, b: row.bId, strength: row.strength, evidence: row.evidence.map((entry) => ({ kind: entry.kind as never, fingerprint: entry.fingerprint, weight: entry.weight })) }));
      const clusters = clustersOf(active, { cluster_from: 1 });
      const people = await this.links.contractors(tx, nodeIds, today);
      const snapshot = await this.links.snapshot(tx, policy.value);
      const scan = await this.links.lastScan(tx);
      return {
        focus_id: id,
        nodes: people.map((one) => ({ id: one.id, name: one.name, tax_identifier: one.taxIdentifier, restricted: one.restricted, cluster: clusters.findIndex((cluster) => cluster.members.includes(one.id)) < 0 ? null : clusters.findIndex((cluster) => cluster.members.includes(one.id)) })),
        links: all.map(linkDto),
        clusters: clusters.map((cluster) => ({ key: clusterKeyOf(cluster.members), members: cluster.members, score: cluster.score })),
        ignored: snapshot.set.ignored.map((entry) => ({ kind: entry.kind, fingerprint: entry.fingerprint, size: entry.size })),
        scan_at: scan?.finishedAt ?? null,
        policy: invPolicyDto('VENDOR_LINK_RULE', policy),
        as_of: now.toISOString(),
      };
    });
  }

  @Get('vendor/investigation/figures')
  @OperationId('getVendorInvestigationFigures')
  async figures(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    this.require(access, PERMISSIONS.getVendorInvestigationFigures);
    const now = new Date();
    const today = todayOf(now);
    return this.database.withTenant(tenant, async (tx) => {
      const figures = await this.leads.figures(tx, tenant.membershipId);
      const scan = await this.links.lastScan(tx);
      const coverage = await this.leads.traceCoverageAll(tx);
      const indicators = [];
      for (const code of FIGURE_CODES) {
        const rule = await this.rules.get(tx, 'KPI_DEFINITION', code, today);
        if (rule === undefined) continue;
        indicators.push({ code, name: String(rule.params.name ?? code), formula: rule.provenance?.formula ?? String(rule.params.formula ?? ''), source: String(rule.params.source ?? rule.provenance?.source ?? ''), unverified: rule.unverified });
      }
      return {
        leads: { open: figures.open, new: figures.new, confirmed: figures.confirmed, referred: figures.referred, dismissed: figures.dismissed, precision_pct: figures.precisionPct },
        last_scan: scan === undefined ? { id: null, finished_at: null, parties: 0, links: 0, clusters: 0, packages: 0, leads_new: 0 } : { id: scan.id, finished_at: scan.finishedAt, parties: scan.parties, links: scan.links, clusters: scan.clusters, packages: scan.packages, leads_new: scan.leadsNew },
        trace: { bids: coverage.bids, with_origin: coverage.withOrigin, with_files: coverage.withFiles },
        indicators,
        as_of: now.toISOString(),
      };
    });
  }

  @Get('vendor/screening')
  @OperationId('getVendorScreening')
  async screeningOverview(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.require(access, PERMISSIONS.getVendorScreening);
    const now = new Date();
    const today = todayOf(now);
    const status = oneOf(query.status, 'status', HIT_STATUSES);
    const source = oneOf(query.source, 'source', SOURCES);
    const contractorId = uuid(query.contractor_id, 'contractor_id');
    return this.database.withTenant(tenant, async (tx) => {
      const policy = await this.policies.screening(tx, today);
      const [hits, counts, runs, sources, timeliness] = await Promise.all([
        this.screening.list(tx, { status, source, contractorId, limit: 200 }),
        this.screening.counts(tx),
        this.screening.runs(tx, 10),
        this.screening.sources(tx),
        this.screening.timeliness(tx, policy.value.decide_within_days, now),
      ]);
      const names = await this.people.names(tx, [...hits.map((hit) => hit.decidedBy), ...runs.map((run) => run.requestedBy)]);
      return {
        hits: hits.map((hit) => hitDto(hit, names, now, policy.value.decide_within_days)),
        counts: { pending: counts.pending, holds: counts.holds, confirmed: counts.confirmed, dismissed: counts.dismissed, resolved: counts.resolved, overdue: timeliness.overduePending },
        runs: runs.map((run) => runDto(run, names)),
        sources: sources.map(sourceDto),
        in_time_pct: timeliness.inTimePct,
        policy: invPolicyDto('VENDOR_SCREENING', policy),
        as_of: now.toISOString(),
      };
    });
  }

  @Get('vendor/screening/hits/:id')
  @OperationId('getVendorScreeningHit')
  async screeningHit(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    this.require(access, PERMISSIONS.getVendorScreeningHit);
    const now = new Date();
    return this.database.withTenant(tenant, async (tx) => {
      const hit = await this.screening.find(tx, id);
      if (hit === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const policy = await this.policies.screening(tx, todayOf(now));
      const events = await this.screening.events(tx, id);
      const names = await this.people.names(tx, [hit.decidedBy, ...events.map((event) => event.actorId)]);
      return {
        hit: hitDto(hit, names, now, policy.value.decide_within_days),
        events: events.map((event) => hitEventDto(event, names)),
        policy: invPolicyDto('VENDOR_SCREENING', policy),
        may_confirm: hit.status === 'PENDING' && holdsOnWholeTenant(access, PERMISSIONS.confirmVendorScreeningHit),
        may_dismiss: hit.status === 'PENDING' && holdsOnWholeTenant(access, PERMISSIONS.dismissVendorScreeningHit),
        as_of: now.toISOString(),
      };
    });
  }
}
