import { randomUUID } from 'node:crypto';
import {
  DomainError,
  EVALUATION_REPORT_SOURCE_MODULE,
  assertReportDraft,
  assertRunReviewable,
  compareProposals,
  declarationStanding,
  decisionsDigest,
  evaluationQuorum,
  evaluationReportPayload,
  evaluationReportSourceRef,
  payloadSha256,
  reportSummary,
  signerIds,
  standingOpens,
  versionConflict,
} from '@machvon/kernel';
import type { ConflictStanding, DecisionLine, EffectiveAccess, EvaluationReportStatus, ReportSummary, ResourceRef, TeamMember } from '@machvon/kernel';
import { BidReviewStore } from './bid-review-store.ts';
import { LATEST_REVIEW } from './bid-analysis-store.ts';
import { SqlParams } from './bid-plan-reads.ts';
import type { ProposalViewer } from './bid-proposal-reads.ts';
import { grantViewOf } from './effective-access-store.ts';
import type { GrantRow } from './effective-access-store.ts';
import { holdsOver } from './prj-accountability-support.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { TenantTx } from './tenant-database.ts';

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const DRAFT: EvaluationReportStatus = 'DRAFT';
/** The most findings named in a refusal for the findings nobody decided. */
const NAMED_UNREVIEWED = 20;

/** Where the payload of a report is kept: under the prefix of the tenant, which is where DOC reads a payload from. The hash is in the key, because an object is written once. */
export const evaluationReportPayloadRef = (tenantId: string, reportId: string, sha256: string): string => `tenants/${tenantId}/bid/reports/${reportId}/${sha256}.json`;

/** Who reads and signs a report: a member of the evaluation team over the project of its package, and the permission that makes a member of the team (the one `bid.evaluate` names). */
export interface ReportViewer extends ProposalViewer {
  teamPermission: string;
}

export interface NewReport {
  packageId: string;
  criteriaVersionId: string;
  runIds: readonly string[];
  conclusion: string;
}

export interface SignInput {
  id: string;
  expectedVersion: number;
  dissent: string | null;
  tenantId: string;
}

interface Person {
  membershipId: string;
  displayName: string;
}

export interface ReportLine {
  id: string;
  package: { id: string; code: string };
  projectId: string;
  criteriaVersionId: string;
  runIds: string[];
  status: EvaluationReportStatus;
  summary: ReportSummary;
  signedOffBy: Array<Person & { signedAt: string | null; withDissent: boolean }>;
  /** The members the report still waits for; empty once it asked DOC for the minutes. */
  awaiting: Array<Person & { standing: ConflictStanding }>;
  dissentingOpinions: Array<Person & { text: string; recordedAt: string }>;
  payloadSha256: string | null;
  reportDocumentId: string | null;
  /** The state of the document DOC drafted for the minutes, as DOC keeps it; null while DOC has not made one. */
  documentStatus: string | null;
  /** Experts decided a finding of its runs again after the report was drafted: it no longer says what stands, and it is not signed. */
  stale: boolean;
  /** The caller may sign it now. The server judges the command again. */
  mayChange: boolean;
  createdBy: Person;
  createdAt: string;
  issueRequestedAt: string | null;
  issuedAt: string | null;
  recalledAt: string | null;
  version: number;
}

/** What asking DOC for the minutes needs: the payload to write to the file store and what the event carries. */
export interface IssueAsk {
  payload: Record<string, string>;
  payloadSha256: string;
  payloadRef: string;
  eventId: string;
  sourceRef: string;
  draftingUnitId: string;
}

export interface SignedReport {
  report: ReportLine;
  /** The report was complete with this signature and asked DOC for the minutes. */
  issue: IssueAsk | undefined;
  /** The members the report waited for before this signature. */
  awaitedBefore: number;
}

export interface CreatedReport {
  report: ReportLine;
  runCount: number;
}

interface ReportSql {
  id: string;
  package_id: string;
  package_code: string;
  project_id: string;
  criteria_version_id: string;
  run_ids: string[];
  status: EvaluationReportStatus;
  summary_json: ReportSummary;
  signed_off_by: unknown[];
  dissenting_opinions: Array<Record<string, unknown>>;
  payload_sha256: string | null;
  report_document_id: string | null;
  document_status: string | null;
  created_by: string;
  created_by_name: string | null;
  created_at: string;
  issue_requested_at: string | null;
  issued_at: string | null;
  recalled_at: string | null;
  version: string;
}

interface DecisionSql {
  finding_id: string;
  run_id: string;
  to_status: DecisionLine['status'];
  score: string | null;
  decision: string;
  decided_at: string;
}

interface PlaceSql {
  project_id: string;
  owner_id: string;
  owner_path: string;
  owner_name: string;
  investor_id: string | null;
  investor_path: string | null;
}

const SELECT = `select e.id, e.package_id, k.code as package_code, k.project_id, e.criteria_version_id, e.run_ids, e.status, e.summary_json, e.signed_off_by, e.dissenting_opinions, e.payload_sha256,
    e.report_document_id, (select od.status from machvon.outgoing_document od where od.source_module = '${EVALUATION_REPORT_SOURCE_MODULE}' and od.source_ref = 'BID:evaluation_report:' || e.id::text order by od.created_at desc, od.id desc limit 1) as document_status,
    e.created_by, cu.display_name as created_by_name, to_char(e.created_at at time zone 'UTC', ${ISO}) as created_at,
    to_char(e.issue_requested_at at time zone 'UTC', ${ISO}) as issue_requested_at, to_char(e.issued_at at time zone 'UTC', ${ISO}) as issued_at, to_char(e.recalled_at at time zone 'UTC', ${ISO}) as recalled_at,
    e.version::text as version
  from machvon.evaluation_report e
  join machvon.procurement_package k on k.tenant_id = e.tenant_id and k.id = e.package_id
  left join machvon.tenant_user_directory cu on cu.tenant_id = e.tenant_id and cu.membership_id = e.created_by`;

const notFound = (field?: string): DomainError => new DomainError('RESOURCE_NOT_FOUND', 404, field);

/**
 * The evaluation report of a package (ST-BID-012, BID 3 F6, BR-BID-03/09, BID-13). A member of the evaluation team makes it from runs whose findings were all decided by the experts, and it freezes what they decided
 * (the comparison of those runs, never what the model said) with the conclusion its author wrote. Every member of the team who is not shut out by a decision on a conflict of interest signs it, with the dissent
 * they hold in their own words; the signature that completes the team asks DOC for the minutes. The module never marks the report issued by itself: that is the consumer of what DOC answers.
 */
export class BidReportStore {
  private readonly review = new BidReviewStore();

  /**
   * Makes a draft. Refusals in order: the package is not one the caller evaluates (404); the caller owes the declaration about it (403 CONFLICT_UNDECLARED) or is shut out by a conflict (404); a proposal waits for
   * the declaration of the caller (403), or the criteria version is not there (404) or of another package (422); a run that is not the analysis that stands for a proposal the caller has in full (404 on run_ids); a run that ran on
   * other criteria (422 CRITERIA_VERSION_MISMATCH); a run that does not wait for the experts (422 RUN_NOT_COMPLETED); a finding nobody decided (422 UNREVIEWED_FINDINGS).
   */
  async create(tx: TenantTx, input: NewReport, viewer: ReportViewer, actor: string): Promise<CreatedReport> {
    if (!(await this.reaches(tx, input.packageId, viewer))) throw notFound();
    await this.gate(tx, input.packageId, viewer);
    const basis = await this.review.comparisonBasis(tx, input.packageId, input.criteriaVersionId, viewer);
    if (basis === undefined) throw notFound();
    const taken = input.runIds.flatMap((runId) => {
      const entry = basis.input.runs.find((candidate) => candidate.run?.id === runId);
      return entry?.run == null ? [] : [{ entry, run: entry.run }];
    });
    if (taken.length !== input.runIds.length) throw notFound('run_ids');
    const mismatched = taken.filter(({ run }) => run.criteriaVersionId !== basis.input.criteriaVersionId);
    if (mismatched.length > 0) throw new DomainError('CRITERIA_VERSION_MISMATCH', 422, 'run_ids', { extensions: { run_ids: mismatched.map(({ run }) => run.id) } });
    for (const { run } of taken) assertRunReviewable(run.status);
    const unreviewed = await this.unreviewed(tx, input.runIds);
    if (unreviewed.count > 0) throw new DomainError('UNREVIEWED_FINDINGS', 422, 'run_ids', { extensions: { unreviewed_count: unreviewed.count, finding_ids: unreviewed.ids } });

    const picked = new Set(taken.map(({ entry }) => entry.proposalId));
    const others = basis.input.runs.filter((entry) => !picked.has(entry.proposalId));
    const notSelected = others.filter((entry) => entry.run !== null && entry.run.criteriaVersionId === basis.input.criteriaVersionId);
    const comparison = compareProposals({ ...basis.input, runs: [...taken.map(({ entry }) => entry), ...others.filter((entry) => !notSelected.includes(entry))] });
    const decisions = await this.decisions(tx, input.runIds);
    const summary = reportSummary({
      conclusion: input.conclusion,
      pack: { id: basis.package.id, code: basis.package.code },
      comparison,
      notSelected: notSelected.map((entry) => ({ proposalId: entry.proposalId, contractor: entry.contractor })),
      decisionsSha256: decisionsDigest(decisions),
    });
    const id = randomUUID();
    await tx.query(
      `insert into machvon.evaluation_report (tenant_id, id, package_id, criteria_version_id, run_ids, summary_json, status, signed_off_by, dissenting_opinions, created_by, updated_by, version)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5::jsonb, 'DRAFT', '[]'::jsonb, '[]'::jsonb, $6::uuid, $6::uuid, 1)`,
      [id, basis.package.id, basis.input.criteriaVersionId, JSON.stringify([...input.runIds].sort()), JSON.stringify(summary), actor],
    );
    return { report: await this.require(tx, id, viewer), runCount: input.runIds.length };
  }

  /**
   * A member signs, with the dissent they hold. Refusals in order: the report is not one of a package the caller evaluates (404), the caller owes the declaration (403 CONFLICT_UNDECLARED) or is shut out (404), the
   * report is not a draft (409 REPORT_STATE_INVALID), the caller signed already (422 ALREADY_SIGNED_OFF, unless the call only confirms a team that a decision on a conflict cut down to the members who signed),
   * the version is not the current one (409 VERSION_CONFLICT), experts decided again since the draft (409 REPORT_OUT_OF_DATE). The signature that leaves no member of the team to wait for asks DOC for the minutes in the same transaction.
   */
  async signOff(tx: TenantTx, input: SignInput, viewer: ReportViewer, actor: string): Promise<SignedReport> {
    const peek = await tx.query<{ package_id: string }>('select package_id from machvon.evaluation_report where id = $1::uuid', [input.id]);
    if (peek[0] === undefined) throw notFound();
    const place = await this.lockPackage(tx, peek[0].package_id, viewer);
    await this.gate(tx, peek[0].package_id, viewer);
    const rows = await tx.query<ReportSql>(`${SELECT} where e.id = $1::uuid for update of e`, [input.id]);
    const row = rows[0] as ReportSql;
    assertReportDraft(row.status);
    const signers = signerIds(row.signed_off_by);
    const team = await this.team(tx, row.package_id, place, viewer);
    const before = evaluationQuorum(team, signers);
    // A member signs once. The one case in which they sign again is the confirmation: the team they were waiting with was cut down by a decision on a conflict of interest after they signed, so that every member
    // who is left has signed and nobody is left to complete the report. It adds no signature and no dissent.
    const confirming = signers.includes(actor);
    if (confirming && (!before.complete || input.dissent !== null)) throw new DomainError('ALREADY_SIGNED_OFF', 422);
    if (Number(row.version) !== input.expectedVersion) throw versionConflict(Number(row.version));
    if (await this.isStale(tx, row)) throw new DomainError('REPORT_OUT_OF_DATE', 409);

    const now = (await tx.query<{ at: string }>(`select to_char(clock_timestamp() at time zone 'UTC', ${ISO}) as at`))[0]?.at as string;
    const signature = { membership_id: actor, signed_at: now, dissent: input.dissent !== null };
    const signed = confirming ? row.signed_off_by : [...row.signed_off_by, signature];
    const dissents = input.dissent === null ? row.dissenting_opinions : [...row.dissenting_opinions, { membership_id: actor, text: input.dissent, recorded_at: now }];
    const complete = evaluationQuorum(team, signerIds(signed)).complete;
    await tx.query(
      `update machvon.evaluation_report set signed_off_by = $2::jsonb, dissenting_opinions = $3::jsonb, status = $4, updated_at = now(), updated_by = $5::uuid, version = version + 1 where id = $1::uuid`,
      [row.id, JSON.stringify(signed), JSON.stringify(dissents), complete ? 'SIGNED_OFF' : DRAFT, actor],
    );
    const issue = complete ? await this.askForMinutes(tx, row.id, input.tenantId, place, actor) : undefined;
    return { report: await this.require(tx, row.id, viewer), issue, awaitedBefore: before.awaiting.length };
  }

  /** The reports of a package the caller evaluates, newest first. The caller owes the declaration (403 CONFLICT_UNDECLARED) or is shut out (404); undefined when the package is not one they evaluate. */
  async list(tx: TenantTx, packageId: string, viewer: ReportViewer): Promise<ReportLine[] | undefined> {
    if (!(await this.reaches(tx, packageId, viewer))) return undefined;
    await this.gate(tx, packageId, viewer);
    const rows = await tx.query<ReportSql>(`${SELECT} where e.package_id = $1::uuid order by e.created_at desc, e.id desc`, [packageId]);
    return this.lines(tx, rows, viewer);
  }

  /** One report, with the same gate; undefined when it does not exist for the caller. */
  async find(tx: TenantTx, id: string, viewer: ReportViewer): Promise<ReportLine | undefined> {
    const rows = await tx.query<ReportSql>(`${SELECT} where e.id = $1::uuid`, [id]);
    const row = rows[0];
    if (row === undefined || !(await this.reaches(tx, row.package_id, viewer))) return undefined;
    await this.gate(tx, row.package_id, viewer);
    return (await this.lines(tx, rows, viewer))[0];
  }

  // ---- who the caller is for the package ------------------------------------------------------------------------------------------------------

  /** The caller's standing for the package: the declaration they made, or none. */
  private async standing(tx: TenantTx, packageId: string, member: string): Promise<ConflictStanding> {
    const rows = await tx.query<{ has_conflict: boolean; decision: 'ALLOWED' | 'RECUSED' | 'BLOCKED' | null; contractor_id: string | null }>(
      'select has_conflict, decision, contractor_id from machvon.bid_conflict_declaration where package_id = $1::uuid and user_id = $2::uuid',
      [packageId, member],
    );
    const declaration = rows[0];
    return declaration === undefined ? 'UNDECLARED' : declarationStanding({ hasConflict: declaration.has_conflict, decision: declaration.decision, contractorId: declaration.contractor_id });
  }

  /** The report concerns every proposal of the package, so it is opened by who may open them all: the declaration is owed (403) or a conflict shuts the member out (404, and nothing says why). */
  private async gate(tx: TenantTx, packageId: string, viewer: ReportViewer): Promise<void> {
    const standing = await this.standing(tx, packageId, viewer.membershipId);
    if (standing === 'UNDECLARED') throw new DomainError('CONFLICT_UNDECLARED', 403);
    if (!standingOpens(standing)) throw notFound();
  }

  private async reaches(tx: TenantTx, packageId: string, viewer: ReportViewer): Promise<boolean> {
    const params = new SqlParams();
    const evaluate = params.scope(viewer.evaluate);
    const rows = await tx.query(`select 1 from ${SCOPE_FROM} join machvon.procurement_package k on k.tenant_id = p.tenant_id and k.project_id = p.id where k.id = ${params.add(packageId)}::uuid and ${evaluate}`, params.values);
    return rows.length > 0;
  }

  /** Locks the project and the package, as the decisions on conflicts do, so that a signature and a decision that takes one away are taken one after the other. 404 when the caller does not evaluate the package. */
  private async lockPackage(tx: TenantTx, packageId: string, viewer: ReportViewer): Promise<PlaceSql> {
    const params = new SqlParams();
    const evaluate = params.scope(viewer.evaluate);
    const rows = await tx.query<PlaceSql>(
      `select p.id as project_id, ou.id as owner_id, ou.path as owner_path, ou.name as owner_name, iu.id as investor_id, iu.path as investor_path
         from ${SCOPE_FROM} join machvon.procurement_package k on k.tenant_id = p.tenant_id and k.project_id = p.id
        where k.id = ${params.add(packageId)}::uuid and ${evaluate} for update of p, k`,
      params.values,
    );
    if (rows[0] === undefined) throw notFound();
    return rows[0];
  }

  /**
   * The evaluation team of a package: whoever holds the permission over its project (the register has no table of team members), with the standing the declaration they made gives them. Members are judged by
   * the grants in force at this moment, in one read for all of them.
   */
  private async team(tx: TenantTx, packageId: string, place: PlaceSql, viewer: ReportViewer): Promise<TeamMember[]> {
    const grants = await tx.query<GrantRow & { membership_id: string }>(
      `select g.membership_id, r.code, r.rank, r.permissions, g.scope_kind, g.scope_ref_ids, g.status, g.effective_from, g.effective_until,
              coalesce((select array_agg(u.path order by u.path) from machvon.organization_unit u where u.id = any(g.scope_ref_ids)), '{}') as unit_paths
         from machvon.membership m
         join machvon.role_grant g on g.tenant_id = m.tenant_id and g.membership_id = m.id and g.status = 'Active'
         join machvon.role_definition r on r.tenant_id = g.tenant_id and r.id = g.role_id
        where m.status = 'Active' and m.membership_type = 'STAFF' and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now())
        order by g.membership_id, g.created_at, g.id`,
    );
    const refs: ResourceRef[] = [{ ownerUnitId: place.owner_id, ownerUnitPath: place.owner_path, projectId: place.project_id }];
    if (place.investor_id !== null && place.investor_path !== null) refs.push({ ownerUnitId: place.investor_id, ownerUnitPath: place.investor_path, projectId: place.project_id });
    const byMember = new Map<string, GrantRow[]>();
    for (const grant of grants) byMember.set(grant.membership_id, [...(byMember.get(grant.membership_id) ?? []), grant]);
    const members: string[] = [];
    for (const [membershipId, rows] of byMember) {
      const access: EffectiveAccess = { membershipId, scopeVersion: 0, membershipActive: true, grants: rows.map(grantViewOf) };
      if (refs.some((ref) => holdsOver(access, viewer.teamPermission, ref, viewer.now))) members.push(membershipId);
    }
    if (members.length === 0) return [];
    const declared = await tx.query<{ user_id: string; has_conflict: boolean; decision: 'ALLOWED' | 'RECUSED' | 'BLOCKED' | null; contractor_id: string | null }>(
      'select user_id, has_conflict, decision, contractor_id from machvon.bid_conflict_declaration where package_id = $1::uuid and user_id = any($2::uuid[])',
      [packageId, members],
    );
    const byDeclaration = new Map(declared.map((row) => [row.user_id, row] as const));
    return members.map((membershipId): TeamMember => {
      const declaration = byDeclaration.get(membershipId);
      return { membershipId, standing: declaration === undefined ? 'UNDECLARED' : declarationStanding({ hasConflict: declaration.has_conflict, decision: declaration.decision, contractorId: declaration.contractor_id }) };
    });
  }

  // ---- what the experts decided -----------------------------------------------------------------------------------------------------------------

  /** The findings of the runs that nobody decided: how many, and the first of them. */
  private async unreviewed(tx: TenantTx, runIds: readonly string[]): Promise<{ count: number; ids: string[] }> {
    const rows = await tx.query<{ id: string }>(
      'select f.id from machvon.analysis_finding f where f.run_id = any($1::uuid[]) and not exists (select 1 from machvon.analysis_finding_review rv where rv.tenant_id = f.tenant_id and rv.finding_id = f.id) order by f.id',
      [[...runIds]],
    );
    return { count: rows.length, ids: rows.slice(0, NAMED_UNREVIEWED).map((row) => row.id) };
  }

  /** The latest decision of a person about each finding of the runs. */
  private async decisions(tx: TenantTx, runIds: readonly string[]): Promise<DecisionLine[]> {
    const rows = await tx.query<DecisionSql>(
      `select f.id as finding_id, f.run_id, lr.to_status, lr.score_after::text as score, lr.decision, to_char(lr.decided_at at time zone 'UTC', ${ISO}) as decided_at
         from machvon.analysis_finding f ${LATEST_REVIEW} where f.run_id = any($1::uuid[]) and lr.decision is not null`,
      [[...runIds]],
    );
    return rows.map((row) => ({ findingId: row.finding_id, runId: row.run_id, status: row.to_status, score: row.score, decision: row.decision, decidedAt: row.decided_at }));
  }

  /** Whether experts decided a finding of the runs again since the report froze what they had decided. */
  private async isStale(tx: TenantTx, row: Pick<ReportSql, 'run_ids' | 'summary_json'>): Promise<boolean> {
    return decisionsDigest(await this.decisions(tx, row.run_ids)) !== row.summary_json.decisions_sha256;
  }

  // ---- the minutes ------------------------------------------------------------------------------------------------------------------------------

  /** The report is complete: it is fully signed, its payload is frozen with its hash and DOC is asked to issue it (the caller writes the payload to the file store). */
  private async askForMinutes(tx: TenantTx, id: string, tenantId: string, place: PlaceSql, actor: string): Promise<IssueAsk> {
    const row = (await tx.query<ReportSql>(`${SELECT} where e.id = $1::uuid`, [id]))[0] as ReportSql;
    const names = await this.names(tx, [...signerIds(row.signed_off_by), ...row.dissenting_opinions.map((entry) => String(entry.membership_id))]);
    const nameOf = (membershipId: string): string => names.get(membershipId.toLowerCase()) ?? '';
    const packageName = (await tx.query<{ title: string | null }>('select title from machvon.procurement_package where id = $1::uuid', [row.package_id]))[0]?.title;
    const payload = evaluationReportPayload({
      summary: row.summary_json,
      packageName: packageName ?? row.package_code,
      agency: place.owner_name,
      signatures: signaturesOf(row.signed_off_by).map((signature) => ({ displayName: nameOf(signature.membershipId), signedAt: signature.signedAt ?? '' })),
      dissents: row.dissenting_opinions.map((entry) => ({ displayName: nameOf(String(entry.membership_id)), text: String(entry.text), recordedAt: String(entry.recorded_at) })),
    });
    const hash = payloadSha256(payload);
    const eventId = randomUUID();
    const payloadRef = evaluationReportPayloadRef(tenantId, id, hash);
    await tx.query(
      `update machvon.evaluation_report
          set status = 'ISSUE_REQUESTED', payload_sha256 = $2, payload_ref = $3, issue_event_id = $4::uuid, issue_requested_at = clock_timestamp(), updated_at = now(), updated_by = $5::uuid, version = version + 1
        where id = $1::uuid`,
      [id, hash, payloadRef, eventId, actor],
    );
    return { payload, payloadSha256: hash, payloadRef, eventId, sourceRef: evaluationReportSourceRef(id), draftingUnitId: place.owner_id };
  }

  // ---- reading ------------------------------------------------------------------------------------------------------------------------------------

  private async require(tx: TenantTx, id: string, viewer: ReportViewer): Promise<ReportLine> {
    const rows = await tx.query<ReportSql>(`${SELECT} where e.id = $1::uuid`, [id]);
    return (await this.lines(tx, rows, viewer))[0] as ReportLine;
  }

  private async names(tx: TenantTx, ids: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.map((id) => id.toLowerCase()))];
    if (unique.length === 0) return new Map();
    const rows = await tx.query<{ membership_id: string; display_name: string | null }>('select membership_id, display_name from machvon.tenant_user_directory where membership_id = any($1::uuid[])', [unique]);
    return new Map(rows.map((row) => [row.membership_id.toLowerCase(), row.display_name ?? ''] as const));
  }

  private async lines(tx: TenantTx, rows: readonly ReportSql[], viewer: ReportViewer): Promise<ReportLine[]> {
    const lines: ReportLine[] = [];
    const teams = new Map<string, TeamMember[]>();
    for (const row of rows) {
      const waiting = row.status === 'DRAFT' || row.status === 'SIGNED_OFF';
      if (waiting && !teams.has(row.package_id)) teams.set(row.package_id, await this.team(tx, row.package_id, await this.placeOf(tx, row.project_id), viewer));
      const team = waiting ? (teams.get(row.package_id) as TeamMember[]) : [];
      const signers = signerIds(row.signed_off_by);
      const awaiting = waiting ? evaluationQuorum(team, signers).awaiting : [];
      const names = await this.names(tx, [...signers, ...awaiting.map((member) => member.membershipId), ...row.dissenting_opinions.map((entry) => String(entry.membership_id)), row.created_by]);
      const nameOf = (membershipId: string): string => names.get(membershipId.toLowerCase()) ?? '';
      const stale = row.status === 'DRAFT' && (await this.isStale(tx, row));
      const standing = await this.standing(tx, row.package_id, viewer.membershipId);
      lines.push({
        id: row.id,
        package: { id: row.package_id, code: row.package_code },
        projectId: row.project_id,
        criteriaVersionId: row.criteria_version_id,
        runIds: row.run_ids,
        status: row.status,
        summary: row.summary_json,
        signedOffBy: signaturesOf(row.signed_off_by).map((signature) => ({ membershipId: signature.membershipId, displayName: nameOf(signature.membershipId), signedAt: signature.signedAt, withDissent: signature.withDissent })),
        awaiting: awaiting.map((member) => ({ membershipId: member.membershipId, displayName: nameOf(member.membershipId), standing: member.standing })),
        dissentingOpinions: row.dissenting_opinions.map((entry) => ({ membershipId: String(entry.membership_id), displayName: nameOf(String(entry.membership_id)), text: String(entry.text), recordedAt: String(entry.recorded_at) })),
        payloadSha256: row.payload_sha256,
        reportDocumentId: row.report_document_id,
        documentStatus: row.document_status,
        stale,
        mayChange: row.status === 'DRAFT' && !stale && standingOpens(standing) && !signers.includes(viewer.membershipId),
        createdBy: { membershipId: row.created_by, displayName: row.created_by_name ?? '' },
        createdAt: row.created_at,
        issueRequestedAt: row.issue_requested_at,
        issuedAt: row.issued_at,
        recalledAt: row.recalled_at,
        version: Number(row.version),
      });
    }
    return lines;
  }

  private async placeOf(tx: TenantTx, projectId: string): Promise<PlaceSql> {
    const rows = await tx.query<PlaceSql>(
      `select p.id as project_id, ou.id as owner_id, ou.path as owner_path, ou.name as owner_name, iu.id as investor_id, iu.path as investor_path from ${SCOPE_FROM} where p.id = $1::uuid`,
      [projectId],
    );
    return rows[0] as PlaceSql;
  }
}

/** A signature as the table holds it: a membership id (the older form) or an object with the moment. */
function signaturesOf(signedOffBy: readonly unknown[]): Array<{ membershipId: string; signedAt: string | null; withDissent: boolean }> {
  return signedOffBy.flatMap((entry) => {
    if (typeof entry === 'string') return [{ membershipId: entry.toLowerCase(), signedAt: null, withDissent: false }];
    if (typeof entry !== 'object' || entry === null) return [];
    const fields = entry as Record<string, unknown>;
    if (typeof fields.membership_id !== 'string') return [];
    return [{ membershipId: fields.membership_id.toLowerCase(), signedAt: typeof fields.signed_at === 'string' ? fields.signed_at : null, withDissent: fields.dissent === true }];
  });
}
