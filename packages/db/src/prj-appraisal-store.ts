import { DomainError, appraisalTotal, asUuid, decisionOpposesRecommendation, meanAppraisalScore, thresholdRecommendation, versionConflict } from '@machvon/kernel';
import type { AppraisalRecommendation } from '@machvon/kernel';
import { MasterRules } from './master-rules.ts';
import type { AppraisalCriteriaSet } from './master-rules.ts';
import type { ProjectClassification, ProjectStatus } from './prj-project-store.ts';
import { isTransitionAllowed, edgeBy } from './prj-stage-machine.ts';
import { PROJECT_GROUPS } from './prj-stage-store.ts';
import type { StageChange } from './prj-stage-store.ts';
import { effectiveDateOf, invalid, lockProject, reasonOf, recordStageChange, usableDocumentId } from './prj-stage-support.ts';
import type { LockedProject, StageScopes } from './prj-stage-support.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The appraisal of a project (ST-PRJ-003, PRJ 3.1 F2): a project is sent to appraisal with its proposal, each appraiser scores it against the
 * set of criteria in force, and a decision maker admits it to the project bank, rejects it or returns it. Every step is a guarded move of the
 * life cycle or a sheet of it: nothing here writes the stage of a project except through the transition table.
 */

export const SUBMIT_OPERATION = 'submitProjectForAppraisal';
export const DECIDE_OPERATION = 'decideProjectAppraisal';
const MAX_NOTE = 2000;
const MIN_OVERRIDE_REASON = 20;
const MAX_EVIDENCE_PER_SCORE = 20;
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

const DECISION_TARGET: Readonly<Record<AppraisalRecommendation, ProjectStatus>> = { ADMIT: 'PIPELINE', REJECT: 'REJECTED', RETURN: 'CONCEPT' };

export type AppraisalStatus = 'DRAFT' | 'SUBMITTED' | 'DECIDED' | 'VOID';

export interface SubmitRequest {
  projectId: string;
  expectedVersion: number;
  actor: string;
  scopes: StageScopes;
  input: { reason: string; policyProposalDocumentId?: string | undefined; decisionDocumentId?: string | undefined; investmentDecisionDocumentId?: string | undefined; effectiveDate?: string | undefined };
}

export interface ScoreInput {
  criterionCode: string;
  score: number;
  evidenceIds?: readonly string[] | undefined;
}

export interface RecordRequest {
  projectId: string;
  actor: string;
  scopes: StageScopes;
  criteriaSetVersionId: string;
  scores: readonly ScoreInput[];
  recommendation: string;
  note?: string | undefined;
  /** The version of the sheet the appraiser saw, when they replace a sheet they recorded: another version is 409. */
  expectedSheetVersion?: number | undefined;
  today: string;
}

/** The sheet as it was stored: what the audit row, the event and the answer of the command are written from. */
export interface RecordedSheet {
  id: string;
  projectId: string;
  projectVersion: number;
  classification: ProjectClassification;
  round: number;
  version: number;
  criteriaSetVersionId: string;
  totalScore: string;
  recommendation: AppraisalRecommendation;
  replaced: boolean;
  previousTotalScore: string | null;
  scoreCount: number;
  evidenceCount: number;
  hasNote: boolean;
  meanScore: string;
  sheetCount: number;
  passThreshold: string;
  thresholdRecommendation: 'ADMIT' | 'REJECT';
}

export interface DecideRequest {
  appraisalId: string;
  expectedVersion: number;
  actor: string;
  scopes: StageScopes;
  decision: string;
  reason: string;
  decisionDocumentId?: string | undefined;
  projectGroup?: string | undefined;
  overrideReason?: string | undefined;
  /**
   * Whether the caller holds the right to decide over a unit. A project with a deciding authority is decided on by whoever holds it over that
   * unit (a decision outside the level of the authority is refused 403 SCOPE_DENIED); a project without one is judged by its scope alone.
   */
  authorizes?: ((unit: { id: string; path: string }) => boolean) | undefined;
  today: string;
}

export interface DecidedAppraisal {
  /** The move of the project, for the stage audit row and event. */
  change: StageChange;
  appraisalId: string;
  appraisalVersion: number;
  round: number;
  decision: AppraisalRecommendation;
  meanScore: string;
  sheetCount: number;
  passThreshold: string;
  againstRecommendation: boolean;
  overrideReason: string | null;
  projectGroup: string | null;
  decisionDocumentId: string | null;
}

export interface SheetScore {
  criterionCode: string;
  score: number;
  evidenceIds: string[];
}

export interface AppraisalSheetView {
  id: string;
  round: number;
  version: number;
  status: AppraisalStatus;
  appraiserMembershipId: string;
  appraiserName: string | null;
  scores: SheetScore[];
  totalScore: string;
  recommendation: AppraisalRecommendation;
  note: string | null;
  decision: AppraisalRecommendation | null;
  decidedAt: string | null;
  updatedAt: string;
}

export interface AppraisalViewer {
  actor: string;
  /** The caller holds `project.appraise` on the project. */
  canAppraise: boolean;
  /** The caller holds `project.appraisal.decide` on the project. */
  canDecide: boolean;
  today: string;
}

export interface AppraisalOverview {
  round: number | null;
  status: ProjectStatus;
  /** The caller proposed the project (created it or sent it to appraisal): they neither score nor decide. */
  viewerIsProposer: boolean;
  canRecord: boolean;
  canDecide: boolean;
  criteriaSet: AppraisalCriteriaSet | null;
  /** The sheets the caller may see: all of the round for a decision maker, their own for an appraiser. */
  sheets: AppraisalSheetView[];
  /** For a decision maker: what the submitted sheets of the round add up to. */
  summary: { sheetCount: number; meanScore: string | null; thresholdRecommendation: 'ADMIT' | 'REJECT' | null; overrideRequired: Record<AppraisalRecommendation, boolean> | null } | null;
  /** The sheet that a decision is addressed to and the version to send with it, for a decision maker while the round is open. */
  decisionTarget: { id: string; version: number } | null;
}

interface SheetSql {
  id: string;
  project_id: string;
  round: number;
  criteria_set_version_id: string;
  appraiser_membership_id: string;
  appraiser_name: string | null;
  scores_json: Array<{ criterion_code: string; score: number; evidence_ids?: string[] }>;
  total_score: string;
  recommendation: AppraisalRecommendation;
  status: AppraisalStatus;
  decision: AppraisalRecommendation | null;
  decided_at: string | null;
  note: string | null;
  version: string;
  updated_at: string;
}

const SHEET_SELECT = `select a.id, a.project_id, a.round, a.criteria_set_version_id, a.appraiser_membership_id, d.display_name as appraiser_name, a.scores_json,
  a.total_score::text as total_score, a.recommendation, a.status, a.decision, to_char(a.decided_at at time zone 'UTC', ${ISO}) as decided_at, a.note,
  a.version::text as version, to_char(a.updated_at at time zone 'UTC', ${ISO}) as updated_at
  from machvon.project_appraisal a
  left join machvon.tenant_user_directory d on d.tenant_id = a.tenant_id and d.membership_id = a.appraiser_membership_id`;

const sheetViewOf = (row: SheetSql): AppraisalSheetView => ({
  id: row.id,
  round: row.round,
  version: Number(row.version),
  status: row.status,
  appraiserMembershipId: row.appraiser_membership_id,
  appraiserName: row.appraiser_name,
  scores: row.scores_json.map((entry) => ({ criterionCode: entry.criterion_code, score: entry.score, evidenceIds: entry.evidence_ids ?? [] })),
  totalScore: row.total_score,
  recommendation: row.recommendation,
  note: row.note,
  decision: row.decision,
  decidedAt: row.decided_at,
  updatedAt: row.updated_at,
});

const isRecommendation = (value: string): value is AppraisalRecommendation => value === 'ADMIT' || value === 'REJECT' || value === 'RETURN';

/** True when the version of a criteria set is in force on the date. */
const inForce = (set: AppraisalCriteriaSet, on: string): boolean => set.reading.validFrom <= on && (set.reading.validUntil === null || set.reading.validUntil > on);

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function noteOf(value: string | undefined): string | null {
  if (value === undefined) return null;
  const text = value.trim();
  if (text === '') return null;
  if (text.length > MAX_NOTE || CONTROL.test(text)) throw invalid('note');
  return text;
}

export class PrjAppraisalStore {
  private readonly rules: MasterRules;

  constructor(rules: MasterRules = new MasterRules()) {
    this.rules = rules;
  }

  /**
   * CONCEPT to APPRAISAL (F2 step 1): the proposal is a document of the tenant, the investment is more than nothing, and the project moves
   * only along the transition table under the version the caller saw. The document is what the history of the stage keeps as its ground.
   */
  async submit(tx: TenantTx, request: SubmitRequest): Promise<StageChange> {
    const locked = await lockProject(tx, request.projectId, request.scopes);
    if (locked.version !== request.expectedVersion) throw versionConflict(locked.version);
    const edge = edgeBy(SUBMIT_OPERATION, locked.status);
    if (edge === undefined) throw new DomainError('STAGE_TRANSITION_DENIED', 409);
    const { input } = request;
    // A document sent to the wrong command is refused by name, so it is not stored as if it counted.
    if (input.decisionDocumentId !== undefined) throw invalid('decision_document_id');
    if (input.investmentDecisionDocumentId !== undefined) throw invalid('investment_decision_document_id');
    const reason = reasonOf(input.reason);
    const effectiveDate = effectiveDateOf(input.effectiveDate);
    if (input.policyProposalDocumentId === undefined) throw new DomainError('DECISION_REQUIRED', 422, 'policy_proposal_document_id');
    const proposalDocumentId = await usableDocumentId(tx, input.policyProposalDocumentId, 'policy_proposal_document_id');
    if (BigInt(locked.totalInvestmentVnd.split('.')[0] ?? '0') <= 0n) throw invalid('total_investment_vnd');
    const version = locked.version + 1;
    await tx.query(`update machvon.project set status = $2, status_changed_at = now(), updated_at = now(), updated_by = $3::uuid, version = $4::bigint where id = $1::uuid`, [locked.id, edge.to, request.actor, version]);
    await recordStageChange(tx, {
      projectId: locked.id,
      version,
      from: locked.status,
      to: edge.to,
      operation: SUBMIT_OPERATION,
      actorKind: 'USER',
      actorId: request.actor,
      decisionDocumentId: proposalDocumentId,
      reason,
      effectiveDate,
      sourceEventId: null,
    });
    return {
      projectId: locked.id,
      code: locked.code,
      from: locked.status,
      to: edge.to,
      version,
      operation: SUBMIT_OPERATION,
      actorKind: 'USER',
      actorId: request.actor,
      decisionDocumentId: proposalDocumentId,
      classification: locked.classification,
      reason,
      effectiveDate,
      sourceEventId: null,
      nationalCodeWarning: false,
    };
  }

  /**
   * An appraiser's sheet for the current round (F2 step 2, BR-PRJ-03): scored against the set of criteria named, which must be in force, and
   * against the same set as the other sheets of the round so that their mean means something. The total is the server's, not the client's. The
   * proposer of the project does not score it (403 SELF_APPROVAL_DENIED). The same appraiser scoring again replaces their sheet while the
   * round is open; the audit row of each version keeps what it was.
   */
  async record(tx: TenantTx, request: RecordRequest): Promise<RecordedSheet> {
    const locked = await lockProject(tx, request.projectId, request.scopes);
    await this.assertNotProposer(tx, locked, request.actor);
    if (locked.status !== 'APPRAISAL') throw new DomainError('STAGE_TRANSITION_DENIED', 409);
    if (!isRecommendation(request.recommendation)) throw invalid('recommendation');
    const recommendation = request.recommendation;
    const note = noteOf(request.note);
    const setId = asUuid(request.criteriaSetVersionId);
    if (setId === undefined) throw invalid('criteria_set_version_id');
    const set = await this.rules.appraisalCriteriaVersion(tx, setId);
    if (set === undefined || !inForce(set, request.today)) throw invalid('criteria_set_version_id');
    const round = await this.currentRound(tx, locked.id);
    const others = await tx.query<{ criteria_set_version_id: string }>(
      `select distinct criteria_set_version_id from machvon.project_appraisal where project_id = $1::uuid and round = $2 and appraiser_membership_id <> $3::uuid and status in ('DRAFT', 'SUBMITTED')`,
      [locked.id, round, request.actor],
    );
    if (others.some((other) => other.criteria_set_version_id !== setId)) throw invalid('criteria_set_version_id');
    const evidence = await this.checkedEvidence(tx, request.scores);
    const total = appraisalTotal(
      set.criteria.map((criterion) => ({ code: criterion.code, weight: criterion.weight })),
      request.scores.map((entry) => ({ criterionCode: entry.criterionCode, score: entry.score })),
    );
    const scoresJson = JSON.stringify(
      request.scores.map((entry, index) => ({ criterion_code: entry.criterionCode, score: entry.score, ...((evidence[index] ?? []).length === 0 ? {} : { evidence_ids: evidence[index] }) })),
    );
    const existing = (
      await tx.query<{ id: string; version: string; total_score: string; criteria_set_version_id: string }>(
        `select id, version::text as version, total_score::text as total_score, criteria_set_version_id from machvon.project_appraisal where project_id = $1::uuid and round = $2 and appraiser_membership_id = $3::uuid for update`,
        [locked.id, round, request.actor],
      )
    )[0];
    // A sheet keeps the set of criteria it was scored against for good (the database holds it too): scoring again against another set is a fault of the request.
    if (existing !== undefined && existing.criteria_set_version_id !== setId) throw invalid('criteria_set_version_id');
    let id: string;
    let version: number;
    if (existing === undefined) {
      const inserted = await tx.query<{ id: string }>(
        `insert into machvon.project_appraisal
           (tenant_id, id, project_id, round, criteria_set_version_id, appraiser_membership_id, scores_json, total_score, recommendation, status, note, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, $3::uuid, $4::uuid, $5::jsonb, $6::numeric, $7, 'SUBMITTED', $8, $4::uuid, $4::uuid)
         returning id`,
        [locked.id, round, setId, request.actor, scoresJson, total, recommendation, note],
      );
      id = (inserted[0] as { id: string }).id;
      version = 1;
    } else {
      if (request.expectedSheetVersion !== undefined && request.expectedSheetVersion !== Number(existing.version)) throw versionConflict(Number(existing.version));
      id = existing.id;
      version = Number(existing.version) + 1;
      await tx.query(
        `update machvon.project_appraisal
            set criteria_set_version_id = $2::uuid, scores_json = $3::jsonb, total_score = $4::numeric, recommendation = $5, status = 'SUBMITTED', note = $6,
                updated_at = now(), updated_by = $7::uuid, version = $8::bigint
          where id = $1::uuid`,
        [id, setId, scoresJson, total, recommendation, note, request.actor, version],
      );
    }
    const totals = await tx.query<{ total_score: string }>(`select total_score::text as total_score from machvon.project_appraisal where project_id = $1::uuid and round = $2 and status = 'SUBMITTED'`, [locked.id, round]);
    const mean = meanAppraisalScore(totals.map((row) => row.total_score));
    return {
      id,
      projectId: locked.id,
      projectVersion: locked.version,
      classification: locked.classification,
      round,
      version,
      criteriaSetVersionId: setId,
      totalScore: total,
      recommendation,
      replaced: existing !== undefined,
      previousTotalScore: existing?.total_score ?? null,
      scoreCount: request.scores.length,
      evidenceCount: evidence.reduce((sum, ids) => sum + ids.length, 0),
      hasNote: note !== null,
      meanScore: mean,
      sheetCount: totals.length,
      passThreshold: set.passThreshold,
      thresholdRecommendation: thresholdRecommendation(mean, set.passThreshold),
    };
  }

  /**
   * The decision on the round (F2 step 3, BR-PRJ-04 and BR-PRJ-05): ADMIT puts the project in the project bank in a group with the document of
   * the decision, REJECT ends it, RETURN sends it back to be reworked. The decision maker is not the proposer, and a decision against what the
   * sheets say (or an admission under the threshold) needs an override reason. Every submitted sheet of the round is decided together, the
   * project moves along the transition table, and the score of the project becomes the mean of the sheets.
   */
  async decide(tx: TenantTx, request: DecideRequest): Promise<DecidedAppraisal> {
    const target = (await tx.query<{ project_id: string }>('select project_id from machvon.project_appraisal where id = $1::uuid', [request.appraisalId]))[0];
    if (target === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const locked = await lockProject(tx, target.project_id, request.scopes);
    await this.assertNotProposer(tx, locked, request.actor);
    await this.assertAuthority(tx, locked, request.authorizes);
    const sheets = await tx.query<SheetSql>(
      `${SHEET_SELECT} where a.id = $1::uuid or (a.project_id = $2::uuid and a.round = (select round from machvon.project_appraisal where id = $1::uuid)) order by a.created_at, a.id for update of a`,
      [request.appraisalId, locked.id],
    );
    const addressed = sheets.find((sheet) => sheet.id === request.appraisalId);
    if (addressed === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (addressed.version !== String(request.expectedVersion)) throw versionConflict(Number(addressed.version));
    const round = await this.currentRound(tx, locked.id);
    if (locked.status !== 'APPRAISAL' || addressed.status !== 'SUBMITTED' || addressed.round !== round) throw new DomainError('STAGE_TRANSITION_DENIED', 409);
    if (sheets.some((sheet) => sheet.status === 'DRAFT')) throw new DomainError('APPRAISAL_INCOMPLETE', 422);
    if (!isRecommendation(request.decision)) throw invalid('decision');
    const decision = request.decision;
    const to = DECISION_TARGET[decision];
    if (!isTransitionAllowed(locked.status, to)) throw new DomainError('STAGE_TRANSITION_DENIED', 409);
    const reason = reasonOf(request.reason);
    const submitted = sheets.filter((sheet) => sheet.status === 'SUBMITTED');
    const mean = meanAppraisalScore(submitted.map((sheet) => sheet.total_score));
    const set = await this.rules.appraisalCriteriaVersion(tx, addressed.criteria_set_version_id);
    if (set === undefined) throw new DomainError('CRITERIA_WEIGHT_INVALID', 422, 'criteria_set_version_id');
    const against = decisionOpposesRecommendation(decision, submitted.map((sheet) => sheet.recommendation), mean, set.passThreshold);
    const override = request.overrideReason?.trim();
    if (against && (override === undefined || override.length < MIN_OVERRIDE_REASON)) throw new DomainError('OVERRIDE_REASON_REQUIRED', 422, 'override_reason');
    if (!against && override !== undefined) throw invalid('override_reason');
    if (override !== undefined && CONTROL.test(override)) throw invalid('override_reason');
    let group: string | null = null;
    let documentId: string | null = null;
    if (decision === 'ADMIT') {
      if (request.projectGroup === undefined) throw new DomainError('PROJECT_GROUP_REQUIRED', 422, 'project_group');
      if (!PROJECT_GROUPS.includes(request.projectGroup)) throw invalid('project_group');
      group = request.projectGroup;
      if (request.decisionDocumentId === undefined) throw new DomainError('DECISION_REQUIRED', 422, 'decision_document_id');
    } else if (request.projectGroup !== undefined) {
      throw invalid('project_group');
    }
    if (request.decisionDocumentId !== undefined) documentId = await usableDocumentId(tx, request.decisionDocumentId, 'decision_document_id');
    const version = locked.version + 1;
    await tx.query(
      `update machvon.project_appraisal
          set status = 'DECIDED', decision = $3, decided_by = $4::uuid, decided_at = now(), decision_document_id = $5::uuid, decision_reason = $6, override_reason = $7, decided_group = $8,
              updated_at = now(), updated_by = $4::uuid, version = version + 1
        where project_id = $1::uuid and round = $2 and status = 'SUBMITTED'`,
      [locked.id, round, decision, request.actor, documentId, reason, override ?? null, group],
    );
    await tx.query(
      `update machvon.project
          set status = $2, status_changed_at = now(), updated_at = now(), updated_by = $3::uuid, version = $4::bigint, appraisal_score = $5::numeric,
              project_group = coalesce($6, project_group), policy_decision_document_id = coalesce($7::uuid, policy_decision_document_id)
        where id = $1::uuid`,
      [locked.id, to, request.actor, version, mean, group, decision === 'ADMIT' ? documentId : null],
    );
    await recordStageChange(tx, {
      projectId: locked.id,
      version,
      from: locked.status,
      to,
      operation: DECIDE_OPERATION,
      actorKind: 'USER',
      actorId: request.actor,
      decisionDocumentId: documentId,
      reason,
      effectiveDate: null,
      sourceEventId: null,
    });
    return {
      change: {
        projectId: locked.id,
        code: locked.code,
        from: locked.status,
        to,
        version,
        operation: DECIDE_OPERATION,
        actorKind: 'USER',
        actorId: request.actor,
        decisionDocumentId: documentId,
        classification: locked.classification,
        reason,
        effectiveDate: null,
        sourceEventId: null,
        nationalCodeWarning: false,
      },
      appraisalId: addressed.id,
      appraisalVersion: Number(addressed.version) + 1,
      round,
      decision,
      meanScore: mean,
      sheetCount: submitted.length,
      passThreshold: set.passThreshold,
      againstRecommendation: against,
      overrideReason: override ?? null,
      projectGroup: group,
      decisionDocumentId: documentId,
    };
  }

  /**
   * What the lifecycle read shows of the appraisal of a project to the caller (PRJ-10, PRJ-15): the set of criteria to score against, the
   * sheets they may see (a decision maker sees every sheet of the round, an appraiser only their own, so that nobody scores with another's
   * score in front of them), and for a decision maker the mean, the recommendation of the threshold and which decisions need an override
   * reason. Nothing for a caller who neither appraises nor decides.
   */
  async overview(tx: TenantTx, projectId: string, viewer: AppraisalViewer): Promise<AppraisalOverview | null> {
    if (!viewer.canAppraise && !viewer.canDecide) return null;
    const project = (await tx.query<{ status: ProjectStatus; created_by: string | null }>('select status, created_by from machvon.project where id = $1::uuid', [projectId]))[0];
    if (project === undefined) return null;
    const proposers = await this.proposersOf(tx, projectId, project.created_by);
    const viewerIsProposer = proposers.has(viewer.actor.toLowerCase());
    const open = project.status === 'APPRAISAL';
    const latest = (await tx.query<{ round: number | null }>('select max(round) as round from machvon.project_appraisal where project_id = $1::uuid', [projectId]))[0]?.round ?? null;
    const round = open ? await this.currentRound(tx, projectId) : latest;
    const rows = round === null ? [] : await tx.query<SheetSql>(`${SHEET_SELECT} where a.project_id = $1::uuid and a.round = $2 order by a.created_at, a.id`, [projectId, round]);
    const submitted = rows.filter((row) => row.status === 'SUBMITTED' || row.status === 'DECIDED');
    const named = rows[0]?.criteria_set_version_id;
    const set = named !== undefined ? await this.rules.appraisalCriteriaVersion(tx, named) : open ? await this.rules.appraisalCriteria(tx, viewer.today) : undefined;
    // Blind scoring: the proposer reads no sheet of an open round even when they hold the right to decide (they may not decide on their own proposal), so
    // they cannot weigh on the appraisers with the scores in front of them; the sheets are theirs to read once the round is decided.
    const readsAll = viewer.canDecide && !(open && viewerIsProposer);
    const visible = readsAll ? rows : rows.filter((row) => row.appraiser_membership_id.toLowerCase() === viewer.actor.toLowerCase());
    const canRecord = viewer.canAppraise && open && !viewerIsProposer;
    const canDecide = viewer.canDecide && open && !viewerIsProposer && submitted.some((row) => row.status === 'SUBMITTED');
    let summary: AppraisalOverview['summary'] = null;
    let decisionTarget: AppraisalOverview['decisionTarget'] = null;
    if (readsAll) {
      const mean = submitted.length === 0 || set === undefined ? null : meanAppraisalScore(submitted.map((row) => row.total_score));
      const recommendations = submitted.map((row) => row.recommendation);
      summary = {
        sheetCount: submitted.length,
        meanScore: mean,
        thresholdRecommendation: mean === null || set === undefined ? null : thresholdRecommendation(mean, set.passThreshold),
        overrideRequired:
          mean === null || set === undefined
            ? null
            : { ADMIT: decisionOpposesRecommendation('ADMIT', recommendations, mean, set.passThreshold), REJECT: decisionOpposesRecommendation('REJECT', recommendations, mean, set.passThreshold), RETURN: decisionOpposesRecommendation('RETURN', recommendations, mean, set.passThreshold) },
      };
      const first = open ? rows.find((row) => row.status === 'SUBMITTED') : undefined;
      decisionTarget = first === undefined ? null : { id: first.id, version: Number(first.version) };
    }
    return { round, status: project.status, viewerIsProposer, canRecord, canDecide, criteriaSet: set ?? null, sheets: visible.map(sheetViewOf), summary, decisionTarget };
  }

  /** The members who proposed the project: whoever created it and whoever sent it to appraisal, in any round. */
  async proposersOf(tx: TenantTx, projectId: string, createdBy: string | null): Promise<Set<string>> {
    const proposers = new Set<string>();
    if (createdBy !== null) proposers.add(createdBy.toLowerCase());
    const senders = await tx.query<{ actor_id: string }>(
      `select distinct actor_id::text as actor_id from machvon.project_stage_change where project_id = $1::uuid and operation = $2 and actor_kind = 'USER'`,
      [projectId, SUBMIT_OPERATION],
    );
    for (const sender of senders) proposers.add(sender.actor_id.toLowerCase());
    return proposers;
  }

  /**
   * The round of the appraisal the project is in: how many times it was sent to appraisal (a project placed in APPRAISAL without being sent is in
   * round 1), and always after the last round that was decided, so that a project of the old shape which was returned and sent again does not open a
   * round over sheets that are decided and never change.
   */
  async currentRound(tx: TenantTx, projectId: string): Promise<number> {
    const rows = await tx.query<{ sent: string; decided: string }>(
      `select (select count(*) from machvon.project_stage_change where project_id = $1::uuid and operation = $2)::text as sent,
              coalesce((select max(round) from machvon.project_appraisal where project_id = $1::uuid and status = 'DECIDED'), 0)::text as decided`,
      [projectId, SUBMIT_OPERATION],
    );
    return Math.max(1, Number(rows[0]?.sent ?? 0), Number(rows[0]?.decided ?? 0) + 1);
  }

  private async assertNotProposer(tx: TenantTx, project: LockedProject, actor: string): Promise<void> {
    const proposers = await this.proposersOf(tx, project.id, project.createdBy);
    if (proposers.has(actor.toLowerCase())) throw new DomainError('SELF_APPROVAL_DENIED', 403);
  }

  private async assertAuthority(tx: TenantTx, project: LockedProject, authorizes: DecideRequest['authorizes']): Promise<void> {
    if (authorizes === undefined || project.decisionAuthorityUnitId === null) return;
    const unit = (await tx.query<{ id: string; path: string }>('select id, path from machvon.organization_unit where id = $1::uuid', [project.decisionAuthorityUnitId]))[0];
    if (unit === undefined || !authorizes(unit)) throw new DomainError('SCOPE_DENIED', 403);
  }

  /** The documents that evidence the scores: each a document of the tenant, a few per score. A document of another tenant is no document. */
  private async checkedEvidence(tx: TenantTx, scores: readonly ScoreInput[]): Promise<string[][]> {
    const normalised = scores.map((entry) => {
      const ids = (entry.evidenceIds ?? []).map((value) => asUuid(value));
      if (ids.length > MAX_EVIDENCE_PER_SCORE || ids.some((id) => id === undefined)) throw invalid('scores');
      return [...new Set(ids as string[])];
    });
    const all = [...new Set(normalised.flat())];
    if (all.length > 0) {
      const found = await tx.query<{ id: string }>('select id from machvon.document where id = any($1::uuid[])', [all]);
      if (found.length !== all.length) throw invalid('scores');
    }
    return normalised;
  }
}
