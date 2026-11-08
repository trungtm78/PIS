import { createHash, randomUUID } from 'node:crypto';
import { DomainError, clusterKeyOf, leadKeyOf, leadPrecision, leadRank, nextLeadStatus, reopensDismissed, restrictedAffiliates, screenAll, versionConflict } from '@machvon/kernel';
import type { InvestigationPolicy, LeadKind, LeadMove, LeadStatus, LinkCluster, RiggingBid, RiggingPackage, RiggingSignal } from '@machvon/kernel';
import { timestampKey } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';
import { Vnd3PolicyReader } from './vnd3-policy.ts';
import { VendorLinkStore } from './vnd-link-store.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";

export interface LeadRow {
  id: string;
  kind: LeadKind;
  leadKey: string;
  contractorIds: string[];
  packageIds: string[];
  rank: number;
  evidence: Record<string, unknown>;
  evidenceKinds: string[];
  status: LeadStatus;
  scanId: string;
  firstFlaggedAt: string;
  lastEvaluatedAt: string;
  evaluationCount: number;
  reviewerId: string | null;
  dismissProposedBy: string | null;
  dismissReason: string | null;
  dismissedBy: string | null;
  confirmedBy: string | null;
  confirmReason: string | null;
  referredBy: string | null;
  referralReason: string | null;
  decidedRank: number | null;
  decidedEvidenceKinds: string[] | null;
  reopenedCount: number;
  version: number;
}

export interface LeadHistoryRow {
  id: string;
  move: string;
  fromStatus: string | null;
  toStatus: string;
  actorId: string | null;
  reason: string | null;
  rank: number;
  at: string;
}

export interface LeadFilter {
  status?: string | undefined;
  kind?: string | undefined;
  contractorId?: string | undefined;
  limit: number;
  after?: { code: string; id: string } | undefined;
}

export interface ScanSummary {
  scanId: string;
  parties: number;
  links: number;
  clusters: number;
  ignoredKeys: number;
  packages: number;
  leadsNew: number;
  leadsReopened: number;
  leadsUpdated: number;
  policyVersions: Record<string, string>;
}

interface Candidate {
  kind: LeadKind;
  text: string;
  contractorIds: string[];
  packageIds: string[];
  rank: number;
  evidence: Record<string, unknown>;
  evidenceKinds: string[];
}

interface LeadSql {
  id: string;
  kind: LeadKind;
  lead_key: string;
  contractor_ids: string[];
  package_ids: string[];
  rank: number;
  evidence: Record<string, unknown>;
  evidence_kinds: string[];
  status: LeadStatus;
  scan_id: string;
  first_flagged_at: string;
  last_evaluated_at: string;
  evaluation_count: number;
  reviewer_id: string | null;
  dismiss_proposed_by: string | null;
  dismiss_reason: string | null;
  dismissed_by: string | null;
  confirmed_by: string | null;
  confirm_reason: string | null;
  referred_by: string | null;
  referral_reason: string | null;
  decided_rank: number | null;
  decided_evidence_kinds: string[] | null;
  reopened_count: number;
  version: number | string;
}

const COLUMNS = `l.id, l.kind, l.lead_key, l.contractor_ids, l.package_ids, l.rank, l.evidence, l.evidence_kinds, l.status, l.scan_id, ${timestampKey('l.first_flagged_at')} as first_flagged_at, ${timestampKey('l.last_evaluated_at')} as last_evaluated_at,
  l.evaluation_count, l.reviewer_id, l.dismiss_proposed_by, l.dismiss_reason, l.dismissed_by, l.confirmed_by, l.confirm_reason, l.referred_by, l.referral_reason, l.decided_rank, l.decided_evidence_kinds, l.reopened_count, l.version`;

const toLead = (row: LeadSql): LeadRow => ({
  id: row.id,
  kind: row.kind,
  leadKey: row.lead_key,
  contractorIds: row.contractor_ids,
  packageIds: row.package_ids,
  rank: row.rank,
  evidence: row.evidence,
  evidenceKinds: row.evidence_kinds,
  status: row.status,
  scanId: row.scan_id,
  firstFlaggedAt: row.first_flagged_at,
  lastEvaluatedAt: row.last_evaluated_at,
  evaluationCount: row.evaluation_count,
  reviewerId: row.reviewer_id,
  dismissProposedBy: row.dismiss_proposed_by,
  dismissReason: row.dismiss_reason,
  dismissedBy: row.dismissed_by,
  confirmedBy: row.confirmed_by,
  confirmReason: row.confirm_reason,
  referredBy: row.referred_by,
  referralReason: row.referral_reason,
  decidedRank: row.decided_rank,
  decidedEvidenceKinds: row.decided_evidence_kinds,
  reopenedCount: row.reopened_count,
  version: Number(row.version),
});

/** The lead is hidden from the people who took part in the packages it is about (`vendor_lead_involved`): this fragment is in every read, with the reader as a parameter. */
const NOT_INVOLVED = (readerParam: string): string => `not exists (select 1 from machvon.vendor_lead_involved i where i.tenant_id = l.tenant_id and i.lead_id = l.id and i.membership_id = ${readerParam}::uuid)`;

const keyHash = (kind: string, text: string): string => createHash('sha256').update(`${kind}|${text}`, 'utf8').digest('hex');
const LINK_KINDS_OF = (cluster: LinkCluster): string[] => [...new Set(cluster.links.flatMap((link) => link.evidence.map((entry) => entry.kind)))].sort();

/**
 * The leads of the investigation (VND-3, V6): a scan builds the related-party links, looks for bid-rigging signals in the packages closed in the window of the rule, and writes each finding as a lead (one row for good: the key is
 * the hash of the kind, the packages and the contractors, so a scan finds the same lead again; a dismissed one reopens only when its rank rose by the amount of the rule or a new kind of evidence appeared). The review
 * is the one of the red flags (take, propose a dismissal with a reason, a different auditor confirms; or confirm the signal as right; or refer it). A lead is never shown to the people who took part in the packages it is about.
 * A lead is a signal, never a conclusion.
 */
export class VendorLeadStore {
  private readonly links = new VendorLinkStore();
  private readonly policies = new Vnd3PolicyReader();

  // -- the scan ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  /** The closed packages of the window with their bids, as the kernel screening needs them (sealed prices are only read after the result of the package is approved). */
  async riggingFacts(tx: TenantTx, now: Date, windowDays: number): Promise<RiggingPackage[]> {
    const packages = await tx.query<{ id: string; code: string; buyer: string; closed_on: string; winner: string | null }>(
      `select pk.id, pk.code, coalesce(prj.owner_unit_id::text, pk.project_id::text) as buyer, to_char(r.approved_at at time zone 'UTC', 'YYYY-MM-DD') as closed_on, r.winner_contractor_id as winner
         from machvon.procurement_result r
         join machvon.procurement_package pk on pk.tenant_id = r.tenant_id and pk.id = r.package_id
         join machvon.project prj on prj.tenant_id = pk.tenant_id and prj.id = pk.project_id
        where r.status = 'APPROVED' and r.approved_at >= $1::timestamptz - make_interval(days => $2::int)
        order by r.approved_at, pk.id`,
      [now.toISOString(), windowDays],
    );
    if (packages.length === 0) return [];
    const ids = packages.map((row) => row.id);
    const proposals = await tx.query<{ id: string; package_id: string; contractor_id: string; revision: number; status: string; price: string | null; submitted_at: string | null }>(
      `select id, package_id, contractor_id, revision, status, bid_price_vnd::text as price, ${timestampKey('submitted_at')} as submitted_at
         from machvon.proposal where package_id = any($1::uuid[]) order by package_id, contractor_id, revision desc`,
      [ids],
    );
    const traces = await tx.query<{ proposal_id: string; origin_key: string | null; device_key: string | null; submitted_at: string | null }>(
      `select proposal_id, origin_key, device_key, ${timestampKey('submitted_at')} as submitted_at from machvon.proposal_submission_trace where package_id = any($1::uuid[])`,
      [ids],
    );
    const files = await tx.query<{ proposal_id: string; file_key: string }>(
      'select t.proposal_id, f.file_key from machvon.proposal_submission_file f join machvon.proposal_submission_trace t on t.tenant_id = f.tenant_id and t.id = f.trace_id where t.package_id = any($1::uuid[])',
      [ids],
    );
    const latest = new Map<string, (typeof proposals)[number]>();
    for (const row of proposals) if (!latest.has(`${row.package_id}|${row.contractor_id}`)) latest.set(`${row.package_id}|${row.contractor_id}`, row);
    const traceOf = new Map(traces.map((row) => [row.proposal_id, row]));
    const filesOf = new Map<string, string[]>();
    for (const row of files) filesOf.set(row.proposal_id, [...(filesOf.get(row.proposal_id) ?? []), row.file_key]);
    return packages.map((row): RiggingPackage => {
      const bids: RiggingBid[] = [...latest.values()]
        .filter((proposal) => proposal.package_id === row.id && proposal.status !== 'SUPERSEDED')
        .map((proposal) => {
          const trace = traceOf.get(proposal.id);
          return {
            contractorId: proposal.contractor_id,
            priceVnd: proposal.price,
            withdrawn: proposal.status === 'WITHDRAWN',
            submittedAt: trace?.submitted_at ?? proposal.submitted_at,
            originKey: trace?.origin_key ?? null,
            deviceKey: trace?.device_key ?? null,
            fileKeys: filesOf.get(proposal.id) ?? [],
          };
        });
      return { packageId: row.id, code: row.code, buyerKey: row.buyer, closedOn: row.closed_on, winnerId: row.winner, bids };
    });
  }

  private candidates(clusters: readonly LinkCluster[], components: readonly LinkCluster[], restricted: ReadonlySet<string>, signals: readonly RiggingSignal[]): Candidate[] {
    const out: Candidate[] = [];
    for (const cluster of clusters) {
      out.push({
        kind: 'LINK_CLUSTER',
        text: clusterKeyOf(cluster.members),
        contractorIds: cluster.members,
        packageIds: [],
        rank: cluster.score,
        evidence: { score: cluster.score, links: cluster.links.map((link) => ({ a: link.a, b: link.b, strength: link.strength, kinds: link.evidence.map((entry) => entry.kind) })) },
        evidenceKinds: LINK_KINDS_OF(cluster),
      });
    }
    for (const component of components) {
      const found = restrictedAffiliates(component, restricted);
      if (found.affiliates.length === 0) continue;
      out.push({
        kind: 'RESTRICTED_AFFILIATE',
        text: clusterKeyOf(component.members),
        contractorIds: component.members,
        packageIds: [],
        rank: Math.min(100, component.score + 10),
        evidence: { restricted: found.restricted, affiliates: found.affiliates, score: component.score },
        evidenceKinds: LINK_KINDS_OF(component),
      });
    }
    for (const signal of signals) {
      const piled = [...clusters, ...components].some((cluster) => signal.contractorIds.filter((id) => cluster.members.includes(id)).length >= 2);
      out.push({
        kind: signal.code,
        text: leadKeyOf(signal),
        contractorIds: signal.contractorIds,
        packageIds: signal.packageIds,
        rank: leadRank([signal.score], piled ? 2 : 1),
        evidence: { signal: { code: signal.code, score: signal.score, evidence: signal.evidence }, piled_on_links: piled },
        evidenceKinds: [signal.code],
      });
    }
    return out;
  }

  /**
   * One scan: the related-party links are recomputed and written, the packages closed in the window are screened, and every finding becomes a lead or updates its lead. The numbers of the scan are written once (append-only)
   * with the versions of the rules that decided. `requestedBy` is the auditor who asked, or none for the nightly job.
   */
  async scan(tx: TenantTx, requestedBy: string | null, trigger: 'JOB' | 'MANUAL', now: Date, today: string, note?: string | undefined): Promise<ScanSummary> {
    const started = new Date();
    const linkPolicy = await this.policies.link(tx, today);
    const riggingPolicy = await this.policies.rigging(tx, today);
    const investigation = await this.policies.investigation(tx, today);
    const snapshot = await this.links.snapshot(tx, linkPolicy.value);
    const facts = await this.riggingFacts(tx, now, investigation.value.window_days);
    const signals = screenAll(facts, riggingPolicy.value);
    const restricted = await this.links.restricted(tx, today);
    const candidates = this.candidates(snapshot.clusters, snapshot.components, restricted, signals);

    const keys = candidates.map((candidate) => keyHash(candidate.kind, candidate.text));
    const existing = new Map<string, LeadSql>();
    if (keys.length > 0) {
      const rows = await tx.query<LeadSql>(`select ${COLUMNS} from machvon.vendor_investigation_lead l where l.lead_key = any($1::text[]) for update of l`, [keys]);
      for (const row of rows) existing.set(row.lead_key, row);
    }
    const plan = candidates.map((candidate, index) => {
      const key = keys[index] as string;
      const found = existing.get(key);
      const outcome =
        found === undefined
          ? ('new' as const)
          : found.status === 'DISMISSED' && found.decided_rank !== null && reopensDismissed({ rank: found.decided_rank, evidenceKinds: found.decided_evidence_kinds ?? [] }, { rank: candidate.rank, evidenceKinds: candidate.evidenceKinds }, investigation.value.reopen_rise)
            ? ('reopen' as const)
            : ('update' as const);
      return { candidate, key, found, outcome };
    });
    const count = (outcome: string): number => plan.filter((entry) => entry.outcome === outcome).length;
    const scanId = randomUUID();
    const finished = new Date();
    const policyVersions = { VENDOR_LINK_RULE: linkPolicy.version, VENDOR_BID_RIGGING: riggingPolicy.version, VENDOR_INVESTIGATION: investigation.version };
    await tx.query(
      `insert into machvon.vendor_link_scan (tenant_id, id, trigger_kind, started_at, finished_at, parties, links, clusters, ignored_keys, packages, leads_new, leads_reopened, leads_updated, policy_versions, note, requested_by)
       values (${TENANT}, $1::uuid, $2, $3::timestamptz, $4::timestamptz, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15::uuid)`,
      [scanId, trigger, started.toISOString(), finished.toISOString(), snapshot.parties.length, snapshot.set.links.length, snapshot.clusters.length, snapshot.set.ignored.length, facts.length, count('new'), count('reopen'), count('update'), JSON.stringify(policyVersions), note ?? null, requestedBy],
    );
    await this.links.replace(tx, scanId, snapshot.set.links, now);
    for (const entry of plan) await this.write(tx, scanId, entry.candidate, entry.key, entry.found, entry.outcome, now);
    return { scanId, parties: snapshot.parties.length, links: snapshot.set.links.length, clusters: snapshot.clusters.length, ignoredKeys: snapshot.set.ignored.length, packages: facts.length, leadsNew: count('new'), leadsReopened: count('reopen'), leadsUpdated: count('update'), policyVersions };
  }

  private async write(tx: TenantTx, scanId: string, candidate: Candidate, key: string, found: LeadSql | undefined, outcome: 'new' | 'reopen' | 'update', now: Date): Promise<void> {
    const evidence = JSON.stringify(candidate.evidence);
    if (found === undefined) {
      const [row] = await tx.query<{ id: string }>(
        `insert into machvon.vendor_investigation_lead (tenant_id, kind, lead_key, contractor_ids, package_ids, rank, evidence, evidence_kinds, scan_id, first_flagged_at, last_evaluated_at)
         values (${TENANT}, $1, $2, $3::uuid[], $4::uuid[], $5, $6::jsonb, $7::text[], $8::uuid, $9::timestamptz, $9::timestamptz) returning id`,
        [candidate.kind, key, candidate.contractorIds, candidate.packageIds, candidate.rank, evidence, candidate.evidenceKinds, scanId, now.toISOString()],
      );
      const id = (row as { id: string }).id;
      await this.history(tx, id, 'SCAN_NEW', null, 'NEW', null, null, candidate.rank, now);
      await this.deriveInvolved(tx, id, candidate);
      return;
    }
    if (outcome === 'reopen') {
      await tx.query(
        `update machvon.vendor_investigation_lead
            set status = 'NEW', rank = $2, evidence = $3::jsonb, evidence_kinds = $4::text[], contractor_ids = $5::uuid[], package_ids = $6::uuid[], scan_id = $7::uuid, last_evaluated_at = $8::timestamptz, evaluation_count = evaluation_count + 1,
                reopened_count = reopened_count + 1, reviewer_id = null, review_started_at = null, dismiss_proposed_by = null, dismiss_reason = null, dismissed_by = null, dismissed_at = null, version = version + 1
          where id = $1::uuid`,
        [found.id, candidate.rank, evidence, candidate.evidenceKinds, candidate.contractorIds, candidate.packageIds, scanId, now.toISOString()],
      );
      await this.history(tx, found.id, 'SCAN_REOPEN', 'DISMISSED', 'NEW', null, 'the rank rose or a new kind of evidence appeared after the dismissal', candidate.rank, now);
    } else {
      const changed = found.rank !== candidate.rank || JSON.stringify([...found.evidence_kinds].sort()) !== JSON.stringify([...candidate.evidenceKinds].sort());
      await tx.query(
        `update machvon.vendor_investigation_lead
            set rank = $2, evidence = $3::jsonb, evidence_kinds = $4::text[], contractor_ids = $5::uuid[], package_ids = $6::uuid[], scan_id = $7::uuid, last_evaluated_at = $8::timestamptz, evaluation_count = evaluation_count + 1,
                version = version + case when $9::boolean then 1 else 0 end
          where id = $1::uuid`,
        [found.id, candidate.rank, evidence, candidate.evidenceKinds, candidate.contractorIds, candidate.packageIds, scanId, now.toISOString(), changed],
      );
      if (found.rank !== candidate.rank) await this.history(tx, found.id, 'SCAN_UPDATE', found.status, found.status, null, null, candidate.rank, now);
    }
    await this.deriveInvolved(tx, found.id, candidate);
  }

  private async history(tx: TenantTx, leadId: string, move: string, from: string | null, to: string, actor: string | null, reason: string | null, rank: number, at: Date): Promise<void> {
    await tx.query(
      `insert into machvon.vendor_lead_review (tenant_id, lead_id, move, from_status, to_status, actor_id, reason, rank, at)
       values (${TENANT}, $1::uuid, $2, $3, $4, $5::uuid, $6, $7, $8::timestamptz)`,
      [leadId, move, from, to, actor, reason, rank, at.toISOString()],
    );
  }

  /**
   * Rebuilds the people who took part in what a lead is about: for the packages of the lead (and, for a lead about linked parties, the packages those parties bid for) the drafter, the panel who declared on conflicts, whoever moved
   * the workflow, wrote or approved the result, drew up the contract, and whoever received the proposals and recorded their traces. Those people never see, act on or learn of the lead.
   */
  private async deriveInvolved(tx: TenantTx, leadId: string, candidate: Candidate): Promise<void> {
    const wide = candidate.kind === 'LINK_CLUSTER' || candidate.kind === 'RESTRICTED_AFFILIATE';
    await tx.query(
      `insert into machvon.vendor_lead_involved (tenant_id, lead_id, membership_id, role)
       select distinct ${TENANT}, $1::uuid, x.member, x.role
         from (
           with pk as (
             select p.id from machvon.procurement_package p where p.id = any($2::uuid[])
             union select pr.package_id from machvon.proposal pr where $4::boolean and pr.contractor_id = any($3::uuid[])
           )
           select k.created_by as member, 'DRAFTER' as role from machvon.procurement_package k where k.id in (select id from pk)
           union all select c.user_id, 'PANEL' from machvon.bid_conflict_declaration c where c.package_id in (select id from pk)
           union all select w.owner_membership_id, 'WORKFLOW' from machvon.package_workflow w where w.package_id in (select id from pk)
           union all select l.actor, 'WORKFLOW' from machvon.package_workflow_log l where l.package_id in (select id from pk)
           union all select u.member, 'RESULT' from machvon.procurement_result r cross join lateral (values (r.created_by), (r.submitted_by), (r.approved_by)) as u(member) where r.package_id in (select id from pk)
           union all select k.created_by, 'CONTRACT' from machvon.contract k where k.package_id in (select id from pk)
           union all select pr.created_by, 'RECEIVER' from machvon.proposal pr where pr.package_id in (select id from pk) and pr.contractor_id = any($3::uuid[])
           union all select t.recorded_by, 'RECEIVER' from machvon.proposal_submission_trace t where t.package_id in (select id from pk)
         ) x join machvon.membership m on m.tenant_id = ${TENANT} and m.id = x.member
        where x.member is not null
       on conflict do nothing`,
      [leadId, candidate.packageIds, candidate.contractorIds, wide],
    );
  }

  // -- reads (each leaves out what the reader took part in) ---------------------------------------------------------------------------------------------------------------------------------

  async list(tx: TenantTx, reader: string, filter: LeadFilter): Promise<LeadRow[]> {
    const params: unknown[] = [reader];
    const add = (value: unknown): string => `$${params.push(value)}`;
    const where = [NOT_INVOLVED('$1')];
    if (filter.status !== undefined) where.push(`l.status = ${add(filter.status)}`);
    if (filter.kind !== undefined) where.push(`l.kind = ${add(filter.kind)}`);
    if (filter.contractorId !== undefined) where.push(`${add(filter.contractorId)}::uuid = any(l.contractor_ids)`);
    if (filter.after !== undefined) where.push(`(lpad(l.rank::text, 3, '0'), l.id) < (${add(filter.after.code)}::text, ${add(filter.after.id)}::uuid)`);
    const limit = add(filter.limit + 1);
    const rows = await tx.query<LeadSql>(`select ${COLUMNS} from machvon.vendor_investigation_lead l where ${where.join(' and ')} order by l.rank desc, l.id desc limit ${limit}`, params);
    return rows.map(toLead);
  }

  async counts(tx: TenantTx, reader: string): Promise<Record<LeadStatus, number>> {
    const rows = await tx.query<{ status: LeadStatus; n: number }>(`select l.status, count(*)::int as n from machvon.vendor_investigation_lead l where ${NOT_INVOLVED('$1')} group by l.status`, [reader]);
    const out: Record<LeadStatus, number> = { NEW: 0, IN_REVIEW: 0, DISMISS_PROPOSED: 0, DISMISSED: 0, CONFIRMED: 0, REFERRED: 0 };
    for (const row of rows) out[row.status] = row.n;
    return out;
  }

  /** One lead, or nothing when it does not exist or the reader took part in what it is about (the caller answers 404 for both). */
  async findOne(tx: TenantTx, reader: string, id: string, lock = false): Promise<LeadRow | undefined> {
    const [row] = await tx.query<LeadSql>(`select ${COLUMNS} from machvon.vendor_investigation_lead l where l.id = $2::uuid and ${NOT_INVOLVED('$1')}${lock ? ' for update of l' : ''}`, [reader, id]);
    return row === undefined ? undefined : toLead(row);
  }

  async historyOf(tx: TenantTx, leadId: string): Promise<LeadHistoryRow[]> {
    const rows = await tx.query<{ id: string; move: string; from_status: string | null; to_status: string; actor_id: string | null; reason: string | null; rank: number; at: string }>(
      `select id, move, from_status, to_status, actor_id, reason, rank, ${timestampKey('at')} as at from machvon.vendor_lead_review where lead_id = $1::uuid order by at, (move = 'SCAN_NEW') desc, id`,
      [leadId],
    );
    return rows.map((row) => ({ id: row.id, move: row.move, fromStatus: row.from_status, toStatus: row.to_status, actorId: row.actor_id, reason: row.reason, rank: row.rank, at: row.at }));
  }

  /** The bids of the packages of a lead and how many recorded where they were handed in and which files (for the coverage line of the screen). */
  async traceCoverage(tx: TenantTx, packageIds: readonly string[]): Promise<{ bids: number; withOrigin: number; withFiles: number }> {
    if (packageIds.length === 0) return { bids: 0, withOrigin: 0, withFiles: 0 };
    const [row] = await tx.query<{ bids: number; with_origin: number; with_files: number }>(
      `select count(*)::int as bids,
              count(*) filter (where exists (select 1 from machvon.proposal_submission_trace t where t.proposal_id = p.id and (t.origin_key is not null or t.device_key is not null)))::int as with_origin,
              count(*) filter (where exists (select 1 from machvon.proposal_submission_file f join machvon.proposal_submission_trace t on t.tenant_id = f.tenant_id and t.id = f.trace_id where t.proposal_id = p.id))::int as with_files
         from machvon.proposal p where p.package_id = any($1::uuid[]) and p.status <> 'SUPERSEDED'`,
      [[...packageIds]],
    );
    return { bids: row?.bids ?? 0, withOrigin: row?.with_origin ?? 0, withFiles: row?.with_files ?? 0 };
  }

  /** The coverage of the traces over every bid of the tenant (for the figures). */
  async traceCoverageAll(tx: TenantTx): Promise<{ bids: number; withOrigin: number; withFiles: number }> {
    const [row] = await tx.query<{ bids: number; with_origin: number; with_files: number }>(
      `select count(*)::int as bids,
              count(*) filter (where exists (select 1 from machvon.proposal_submission_trace t where t.proposal_id = p.id and (t.origin_key is not null or t.device_key is not null)))::int as with_origin,
              count(*) filter (where exists (select 1 from machvon.proposal_submission_file f join machvon.proposal_submission_trace t on t.tenant_id = f.tenant_id and t.id = f.trace_id where t.proposal_id = p.id))::int as with_files
         from machvon.proposal p where p.status <> 'SUPERSEDED'`,
    );
    return { bids: row?.bids ?? 0, withOrigin: row?.with_origin ?? 0, withFiles: row?.with_files ?? 0 };
  }

  // -- the review ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  /** One move of the review. The reader must not have taken part (404 as if the lead did not exist); the version must be the one the caller saw; the status machine and the second person are the kernel's. */
  async move(tx: TenantTx, reader: string, id: string, expectedVersion: number, move: LeadMove, reason: string | undefined, now: Date): Promise<LeadRow> {
    const current = await this.findOne(tx, reader, id, true);
    if (current === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (current.version !== expectedVersion) throw versionConflict(current.version);
    const next = nextLeadStatus(current.status, move, { actor: reader, proposer: current.dismissProposedBy, reason: reason ?? null });
    const at = now.toISOString();
    const text = reason?.trim();
    switch (move) {
      case 'TAKE':
        await tx.query('update machvon.vendor_investigation_lead set status = $2, reviewer_id = $3::uuid, review_started_at = $4::timestamptz, version = version + 1 where id = $1::uuid', [id, next, reader, at]);
        break;
      case 'PROPOSE_DISMISS':
        await tx.query('update machvon.vendor_investigation_lead set status = $2, dismiss_proposed_by = $3::uuid, dismiss_reason = $4, version = version + 1 where id = $1::uuid', [id, next, reader, text]);
        break;
      case 'CONFIRM_DISMISS':
        await tx.query('update machvon.vendor_investigation_lead set status = $2, dismissed_by = $3::uuid, dismissed_at = $4::timestamptz, decided_rank = rank, decided_evidence_kinds = evidence_kinds, version = version + 1 where id = $1::uuid', [id, next, reader, at]);
        break;
      case 'REJECT_DISMISS':
        await tx.query('update machvon.vendor_investigation_lead set status = $2, dismiss_proposed_by = null, dismiss_reason = null, version = version + 1 where id = $1::uuid', [id, next]);
        break;
      case 'CONFIRM_SIGNAL':
        await tx.query('update machvon.vendor_investigation_lead set status = $2, confirmed_by = $3::uuid, confirmed_at = $4::timestamptz, confirm_reason = $5, decided_rank = rank, decided_evidence_kinds = evidence_kinds, version = version + 1 where id = $1::uuid', [id, next, reader, at, text]);
        break;
      case 'REFER':
        await tx.query('update machvon.vendor_investigation_lead set status = $2, referred_by = $3::uuid, referred_at = $4::timestamptz, referral_reason = $5, version = version + 1 where id = $1::uuid', [id, next, reader, at, text]);
        break;
    }
    await this.history(tx, id, move, current.status, next, reader, text ?? null, current.rank, now);
    const after = await this.findOne(tx, reader, id);
    return after as LeadRow;
  }

  // -- figures and alerts -----------------------------------------------------------------------------------------------------------------------------------------------------------------------

  async figures(tx: TenantTx, reader: string): Promise<{ open: number; new: number; confirmed: number; referred: number; dismissed: number; precisionPct: number | null }> {
    const counts = await this.counts(tx, reader);
    return {
      open: counts.NEW + counts.IN_REVIEW + counts.DISMISS_PROPOSED,
      new: counts.NEW,
      confirmed: counts.CONFIRMED,
      referred: counts.REFERRED,
      dismissed: counts.DISMISSED,
      precisionPct: leadPrecision({ confirmed: counts.CONFIRMED, referred: counts.REFERRED, dismissed: counts.DISMISSED }),
    };
  }

  /** The open leads the reader may see, for the alert centre: the rank and the day found, strongest first. */
  async alertable(tx: TenantTx, reader: string, policy: InvestigationPolicy): Promise<Array<{ id: string; kind: LeadKind; rank: number; contractorCount: number; firstFlaggedAt: string; status: LeadStatus; high: boolean }>> {
    const rows = await tx.query<{ id: string; kind: LeadKind; rank: number; n: number; first_flagged_at: string; status: LeadStatus }>(
      `select l.id, l.kind, l.rank, cardinality(l.contractor_ids) as n, ${timestampKey('l.first_flagged_at')} as first_flagged_at, l.status
         from machvon.vendor_investigation_lead l where l.status in ('NEW', 'IN_REVIEW', 'DISMISS_PROPOSED') and ${NOT_INVOLVED('$1')} order by l.rank desc, l.id limit 200`,
      [reader],
    );
    return rows.map((row) => ({ id: row.id, kind: row.kind, rank: row.rank, contractorCount: row.n, firstFlaggedAt: row.first_flagged_at, status: row.status, high: row.rank >= policy.alert_from }));
  }
}
