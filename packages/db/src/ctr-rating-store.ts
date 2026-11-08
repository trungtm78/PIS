import {
  DomainError,
  RATING_CRITERIA,
  adoptionScores,
  assertEvaluable,
  daysLateOfFact,
  isRatableStatus,
  moveRating,
  proposeRating,
  ratingDigest,
  ratingKindOf,
  versionConflict,
} from '@machvon/kernel';
import type {
  EvaluationKind,
  RatingAdoptInput,
  RatingCriterion,
  RatingNotifyInput,
  RatingParams,
  RatingProposal,
  RatingProposalInput,
  RatingResponseInput,
  RatingState,
} from '@machvon/kernel';
import { CtrContractStore, SCOPE_FROM } from './ctr-contract-store.ts';
import type { ContractPlace, ContractScopes } from './ctr-contract-store.ts';
import { CtrFactStore } from './ctr-fact-store.ts';
import type { FactQuery } from './ctr-fact-store.ts';
import { CtrRegisterReader, ratingInputsOf } from './ctr-register-reader.ts';
import type { RegisterReaderContext } from './ctr-register-reader.ts';
import { CtrScorecardStore } from './ctr-scorecard-store.ts';
import { EgpObligationStore } from './egp-posting-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The proposals of a rating of the performance of a contractor (CA-3): proposed from the data by the rule `CONTRACT_PERFORMANCE_RATING`, told to the contractor by a second person (which emits the fact
 * CONTRACTOR_NOTIFIED: the obligation CONTRACTOR_RESPONSE of the e-GP posting duties opens in the same transaction, and its deadline is the end of the response window), answered by the contractor, and adopted by a
 * person other than the proposer into the evaluation of CTR-23. The state machine and the maker-checker rule are the kernel's (`moveRating`); the table holds the same edges, so a race ends in the same answer.
 */

export const RATING_PROPOSE_PERMISSION = 'contractor.performance.propose';
export const RATING_NOTIFY_PERMISSION = 'contractor.performance.notify';
export const RATING_RESPOND_PERMISSION = 'contractor.performance.respond';
export const RATING_READ_PERMISSION = 'contractor.performance.read';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const iso = (column: string): string => `to_char(${column} at time zone 'UTC', ${ISO})`;

interface Sql {
  id: string;
  contract_id: string;
  contract_code: string;
  project_id: string;
  contractor_id: string;
  evaluation_kind: EvaluationKind;
  period_label: string;
  as_of_date: string;
  rule_version: number;
  rule_source: string;
  score_quality: number | null;
  score_schedule: number | null;
  score_safety_env: number | null;
  score_cooperation: number | null;
  score_financial: number | null;
  reasons: Record<string, string>;
  readings: Record<string, Record<string, number | string>>;
  covered: number;
  overall_score: string | null;
  rating: string | null;
  inputs_sha256: string;
  state: RatingState;
  proposed_by: string;
  proposed_note: string | null;
  notified_by: string | null;
  notified_at: string | null;
  notify_note: string | null;
  letter_document_version_id: string | null;
  response_due_at: string | null;
  responded_by: string | null;
  responded_at: string | null;
  response_kind: string | null;
  response_text: string | null;
  response_received_on: string | null;
  response_evidence_document_version_id: string | null;
  adopted_by: string | null;
  adopted_at: string | null;
  adopt_note: string | null;
  overrides: Record<string, { score: number; reason: string }> | null;
  evaluation_id: string | null;
  withdrawn_by: string | null;
  withdrawn_at: string | null;
  withdraw_reason: string | null;
  version: string | number;
  created_at: string;
}

export interface RatingProposalRow {
  id: string;
  contractId: string;
  contractCode: string;
  projectId: string;
  contractorId: string;
  kind: EvaluationKind;
  periodLabel: string;
  asOf: string;
  ruleVersion: number;
  ruleSource: string;
  proposal: RatingProposal;
  inputsSha256: string;
  state: RatingState;
  proposedBy: string;
  proposedNote: string | null;
  notifiedBy: string | null;
  notifiedAt: string | null;
  notifyNote: string | null;
  letterDocumentVersionId: string | null;
  responseDueAt: string | null;
  respondedBy: string | null;
  respondedAt: string | null;
  responseKind: string | null;
  responseText: string | null;
  responseReceivedOn: string | null;
  responseEvidenceDocumentVersionId: string | null;
  adoptedBy: string | null;
  adoptedAt: string | null;
  adoptNote: string | null;
  overrides: Record<string, { score: number; reason: string }> | null;
  evaluationId: string | null;
  withdrawnBy: string | null;
  withdrawnAt: string | null;
  withdrawReason: string | null;
  version: number;
  createdAt: string;
}

const SCORE_FIELD: Readonly<Record<RatingCriterion, keyof Sql>> = {
  quality: 'score_quality',
  schedule: 'score_schedule',
  safety_env: 'score_safety_env',
  cooperation: 'score_cooperation',
  financial: 'score_financial',
};

const SELECT = `select q.id::text as id, q.contract_id::text as contract_id, c.code as contract_code, c.project_id::text as project_id, q.contractor_id::text as contractor_id, q.evaluation_kind, q.period_label, q.as_of_date::text as as_of_date,
       q.rule_version, q.rule_source, q.score_quality, q.score_schedule, q.score_safety_env, q.score_cooperation, q.score_financial, q.reasons, q.readings, q.covered, q.overall_score::text as overall_score, q.rating, q.inputs_sha256::text as inputs_sha256,
       q.state, q.proposed_by::text as proposed_by, q.proposed_note, q.notified_by::text as notified_by, ${iso('q.notified_at')} as notified_at, q.notify_note, q.letter_document_version_id::text as letter_document_version_id,
       ${iso('q.response_due_at')} as response_due_at, q.responded_by::text as responded_by, ${iso('q.responded_at')} as responded_at, q.response_kind, q.response_text, q.response_received_on::text as response_received_on,
       q.response_evidence_document_version_id::text as response_evidence_document_version_id, q.adopted_by::text as adopted_by, ${iso('q.adopted_at')} as adopted_at, q.adopt_note, q.overrides, q.evaluation_id::text as evaluation_id,
       q.withdrawn_by::text as withdrawn_by, ${iso('q.withdrawn_at')} as withdrawn_at, q.withdraw_reason, q.version, ${iso('q.created_at')} as created_at
  from machvon.contract_rating_proposal q join machvon.contract c on c.tenant_id = q.tenant_id and c.id = q.contract_id`;

function rowOf(row: Sql): RatingProposalRow {
  const criteria = {} as RatingProposal['criteria'];
  for (const criterion of RATING_CRITERIA) {
    const score = row[SCORE_FIELD[criterion]] as number | null;
    criteria[criterion] = { score: score === null ? null : Number(score), reason: row.reasons[criterion] ?? null, readings: row.readings[criterion] ?? {} };
  }
  const weights = (row.readings.weights ?? {}) as unknown as Record<RatingCriterion, number>;
  return {
    id: row.id,
    contractId: row.contract_id,
    contractCode: row.contract_code,
    projectId: row.project_id,
    contractorId: row.contractor_id,
    kind: row.evaluation_kind,
    periodLabel: row.period_label,
    asOf: row.as_of_date,
    ruleVersion: Number(row.rule_version),
    ruleSource: row.rule_source,
    proposal: {
      criteria,
      covered: Number(row.covered),
      overall: row.overall_score,
      overallReason: row.overall_score === null ? 'NOT_ENOUGH_CRITERIA' : null,
      rating: row.rating as RatingProposal['rating'],
      weights,
    },
    inputsSha256: row.inputs_sha256,
    state: row.state,
    proposedBy: row.proposed_by,
    proposedNote: row.proposed_note,
    notifiedBy: row.notified_by,
    notifiedAt: row.notified_at,
    notifyNote: row.notify_note,
    letterDocumentVersionId: row.letter_document_version_id,
    responseDueAt: row.response_due_at,
    respondedBy: row.responded_by,
    respondedAt: row.responded_at,
    responseKind: row.response_kind,
    responseText: row.response_text,
    responseReceivedOn: row.response_received_on,
    responseEvidenceDocumentVersionId: row.response_evidence_document_version_id,
    adoptedBy: row.adopted_by,
    adoptedAt: row.adopted_at,
    adoptNote: row.adopt_note,
    overrides: row.overrides,
    evaluationId: row.evaluation_id,
    withdrawnBy: row.withdrawn_by,
    withdrawnAt: row.withdrawn_at,
    withdrawReason: row.withdraw_reason,
    version: Number(row.version),
    createdAt: row.created_at,
  };
}

export interface RatingRule {
  params: RatingParams;
  version: number;
  source: 'RULE' | 'DEFAULT';
}

export interface RatingListFilter {
  contractId?: string | undefined;
  contractorId?: string | undefined;
  state?: RatingState | undefined;
}

export class CtrRatingStore {
  private readonly contracts = new CtrContractStore();
  private readonly facts = new CtrFactStore();
  private readonly reader = new CtrRegisterReader();
  private readonly scorecards = new CtrScorecardStore();
  private readonly egp = new EgpObligationStore();

  async find(tx: TenantTx, id: string, lock = false): Promise<RatingProposalRow | undefined> {
    const rows = await tx.query<Sql>(`${SELECT} where q.id = $1::uuid${lock ? ' for update of q' : ''}`, [id]);
    return rows[0] === undefined ? undefined : rowOf(rows[0]);
  }

  /** Where the contract of a proposal lies, so the controller can say which steps the caller may take now. */
  async placeOf(tx: TenantTx, contractId: string): Promise<ContractPlace> {
    const [row] = await tx.query<{ project_id: string; owner_unit_id: string; owner_unit_path: string; investor_unit_id: string | null; investor_unit_path: string | null }>(
      `select c.project_id::text as project_id, ou.id::text as owner_unit_id, ou.path as owner_unit_path, iu.id::text as investor_unit_id, iu.path as investor_unit_path from ${SCOPE_FROM} where c.id = $1::uuid`,
      [contractId],
    );
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { contractId, projectId: row.project_id, ownerUnit: { id: row.owner_unit_id, path: row.owner_unit_path }, investorUnit: row.investor_unit_id === null || row.investor_unit_path === null ? null : { id: row.investor_unit_id, path: row.investor_unit_path } };
  }

  /** One proposal the reader may see (404 for one outside its scope: the existence of a contract is not told to one who cannot read it). */
  async get(tx: TenantTx, id: string, read: ScopeBuilder): Promise<RatingProposalRow> {
    const predicate = read(2);
    const seen = await tx.query<{ id: string }>(`select q.id::text as id from machvon.contract_rating_proposal q join ${SCOPE_FROM} on c.tenant_id = q.tenant_id and c.id = q.contract_id where q.id = $1::uuid and ${predicate.sql}`, [id, ...predicate.params]);
    const found = seen[0] === undefined ? undefined : await this.find(tx, id);
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return found;
  }

  /** The proposals the reader may see, newest first. */
  async list(tx: TenantTx, filter: RatingListFilter, read: ScopeBuilder, limit: number): Promise<RatingProposalRow[]> {
    const predicate = read(1);
    const params: unknown[] = [...predicate.params];
    const where: string[] = [predicate.sql];
    const add = (sql: (n: string) => string, value: unknown): void => {
      params.push(value);
      where.push(sql(`$${params.length}`));
    };
    if (filter.contractId !== undefined) add((n) => `q.contract_id = ${n}::uuid`, filter.contractId);
    if (filter.contractorId !== undefined) add((n) => `q.contractor_id = ${n}::uuid`, filter.contractorId);
    if (filter.state !== undefined) add((n) => `q.state = ${n}`, filter.state);
    params.push(limit);
    const ids = await tx.query<{ id: string }>(
      `select q.id::text as id from machvon.contract_rating_proposal q join ${SCOPE_FROM} on c.tenant_id = q.tenant_id and c.id = q.contract_id where ${where.join(' and ')} order by q.created_at desc, q.id desc limit $${params.length}`,
      params,
    );
    const found: RatingProposalRow[] = [];
    for (const row of ids) {
      const one = await this.find(tx, row.id);
      if (one !== undefined) found.push(one);
    }
    return found;
  }

  /**
   * Proposes the rating of a contract from the data on `asOf`: the fact of the contract, its defects, its issues, its confirmed violations and the audit recoveries the proposer may see. The proposer must be able to
   * read the ledger of the contract (the financial criterion is made of it): 403 `SCOPE_DENIED` otherwise. One live proposal per contract, kind and period (409 `RATING_PROPOSAL_EXISTS`).
   */
  async propose(
    tx: TenantTx,
    contractId: string,
    input: RatingProposalInput,
    actor: string,
    scopes: ContractScopes,
    base: FactQuery,
    context: RegisterReaderContext,
    rule: RatingRule,
  ): Promise<RatingProposalRow> {
    const locked = await this.contracts.lock(tx, contractId, scopes);
    if (!isRatableStatus(locked.status)) throw new DomainError('CONTRACT_STATE_INVALID', 409, 'id');
    const kind = input.kind ?? ratingKindOf(locked.status);
    assertEvaluable(kind, locked.status);
    const [earlier] = await tx.query<{ id: string }>("select id::text as id from machvon.contract_rating_proposal where contract_id = $1::uuid and evaluation_kind = $2 and period_label = $3 and state <> 'WITHDRAWN'", [contractId, kind, input.periodLabel]);
    if (earlier !== undefined) throw new DomainError('RATING_PROPOSAL_EXISTS', 409, 'period_label');
    const query: FactQuery = { ...base, filters: { ids: [contractId] } };
    const page = await this.facts.page(tx, query, { sort: 'code', direction: 'asc', limit: 1 });
    const fact = page.facts[0];
    if (fact === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (!fact.ledgerOk) throw new DomainError('SCOPE_DENIED', 403);
    const [defects, obstacles, violations, findings] = [await this.reader.defects(tx, query), await this.reader.obstacles(tx, query), await this.reader.violations(tx, query), await this.reader.findings(tx, query, context)];
    const inputs = ratingInputsOf({ asOf: base.asOf, fact, daysLate: daysLateOfFact(fact, base.asOf), defects, obstacles, violations: violations.get(contractId) ?? [], findings });
    const proposal = proposeRating(inputs, rule.params);
    const digest = ratingDigest(inputs, rule.params);
    const reasons: Record<string, string> = {};
    const readings: Record<string, unknown> = { weights: proposal.weights };
    for (const criterion of RATING_CRITERIA) {
      const found = proposal.criteria[criterion];
      if (found.reason !== null) reasons[criterion] = found.reason;
      readings[criterion] = found.readings;
    }
    const s = (criterion: RatingCriterion): number | null => proposal.criteria[criterion].score;
    const [made] = await tx.query<{ id: string }>(
      `insert into machvon.contract_rating_proposal
         (tenant_id, id, contract_id, contractor_id, evaluation_kind, period_label, as_of_date, rule_version, rule_source, score_quality, score_schedule, score_safety_env, score_cooperation, score_financial, reasons, readings, covered, overall_score, rating, inputs_sha256, proposed_by, proposed_note, created_by, updated_by)
       values (${TENANT}, gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5::date, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15, $16::numeric, $17, $18, $19::uuid, $20, $19::uuid, $19::uuid) returning id::text as id`,
      [contractId, locked.contractorId, kind, input.periodLabel, base.asOf, rule.version, rule.source, s('quality'), s('schedule'), s('safety_env'), s('cooperation'), s('financial'), JSON.stringify(reasons), JSON.stringify(readings), proposal.covered, proposal.overall, proposal.rating, digest, actor, input.note ?? null],
    );
    return (await this.find(tx, (made as { id: string }).id)) as RatingProposalRow;
  }

  private async guarded(tx: TenantTx, id: string, expectedVersion: number, scopes: ContractScopes): Promise<RatingProposalRow> {
    const row = await this.find(tx, id);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await this.contracts.lock(tx, row.contractId, scopes);
    const locked = (await this.find(tx, id, true)) as RatingProposalRow;
    if (locked.version !== expectedVersion) throw versionConflict(locked.version);
    return locked;
  }

  private async write(tx: TenantTx, id: string, actor: string, set: Record<string, unknown>): Promise<RatingProposalRow> {
    const names = Object.keys(set);
    await tx.query(`update machvon.contract_rating_proposal set ${names.map((name, index) => `${name} = $${index + 3}`).join(', ')}, version = version + 1, updated_at = now(), updated_by = $2::uuid where id = $1::uuid`, [id, actor, ...names.map((name) => set[name])]);
    return (await this.find(tx, id)) as RatingProposalRow;
  }

  /**
   * Tells the contractor (by a person other than the proposer, 403 `SELF_APPROVAL_DENIED`). The fact CONTRACTOR_NOTIFIED is emitted here: the obligation `CONTRACTOR_RESPONSE` of the e-GP posting duties opens on the same
   * instant, with its deadline from the rule `EGP_POSTING_DEADLINES` and the published working calendar (a year with no calendar is 422 `CALENDAR_NOT_EFFECTIVE`: a deadline is never guessed), and that deadline is the
   * end of the response window of the proposal.
   */
  async notify(tx: TenantTx, id: string, expectedVersion: number, input: RatingNotifyInput, actor: string, now: Date, scopes: ContractScopes): Promise<{ before: RatingProposalRow; row: RatingProposalRow; obligationId: string }> {
    const before = await this.guarded(tx, id, expectedVersion, scopes);
    moveRating(before.state, 'NOTIFY', { actor, proposedBy: before.proposedBy, now, dueAt: null });
    const [contractor] = await tx.query<{ tax: string | null }>('select tax_identifier as tax from machvon.contractor where id = $1::uuid', [before.contractorId]);
    const context = await this.egp.contextOf(tx, 'CONTRACTOR_RESPONSE', now);
    const opened = await this.egp.open(
      tx,
      { kind: 'CONTRACTOR_RESPONSE', subjectType: 'CONTRACTOR', subjectId: before.contractorId, subjectCode: contractor?.tax ?? before.contractorId, sourceRef: before.id, triggeredAt: now, ownerId: actor },
      context,
      actor,
    );
    const row = await this.write(tx, id, actor, { state: 'NOTIFIED', notified_by: actor, notified_at: now.toISOString(), notify_note: input.note ?? null, letter_document_version_id: input.letterDocumentVersionId ?? null, response_due_at: opened.row.dueAt });
    return { before, row, obligationId: opened.row.id };
  }

  /** Records the answer of the contractor while the proposal is NOTIFIED (late or not: the lateness is a figure of the report). */
  async respond(tx: TenantTx, id: string, expectedVersion: number, input: RatingResponseInput, actor: string, now: Date, scopes: ContractScopes): Promise<{ before: RatingProposalRow; row: RatingProposalRow }> {
    const before = await this.guarded(tx, id, expectedVersion, scopes);
    moveRating(before.state, 'RESPOND', { actor, proposedBy: before.proposedBy, now, dueAt: null });
    if (before.notifiedAt !== null && input.receivedOn < before.notifiedAt.slice(0, 10)) throw new DomainError('VALIDATION_FAILED', 422, 'received_on');
    const row = await this.write(tx, id, actor, {
      state: 'RESPONDED',
      responded_by: actor,
      responded_at: now.toISOString(),
      response_kind: input.kind,
      response_text: input.text ?? null,
      response_received_on: input.receivedOn,
      response_evidence_document_version_id: input.evidenceDocumentVersionId ?? null,
    });
    return { before, row };
  }

  /**
   * Adopts the proposal into the evaluation of CTR-23, which then waits for its own approval by a second person. The scores are the proposal's; a criterion that had no data needs an override with its reason. After the
   * answer, or once the window ended with none (409 `RATING_RESPONSE_WINDOW_OPEN` before that).
   */
  async adopt(tx: TenantTx, id: string, expectedVersion: number, input: RatingAdoptInput, actor: string, now: Date, scopes: ContractScopes): Promise<{ before: RatingProposalRow; row: RatingProposalRow; evaluationId: string }> {
    const before = await this.guarded(tx, id, expectedVersion, scopes);
    moveRating(before.state, 'ADOPT', { actor, proposedBy: before.proposedBy, now, dueAt: before.responseDueAt === null ? null : new Date(before.responseDueAt) });
    const scores = adoptionScores(before.proposal, input.overrides);
    const evaluation = await this.scorecards.evaluate(
      tx,
      before.contractId,
      { kind: before.kind, periodLabel: before.periodLabel, scores: { quality: scores.quality, schedule: scores.schedule, safetyEnv: scores.safety_env, cooperation: scores.cooperation, financial: scores.financial }, remarks: `Adopted from the rating proposal ${before.id}` },
      actor,
      scopes,
    );
    const row = await this.write(tx, id, actor, { state: 'ADOPTED', adopted_by: actor, adopted_at: now.toISOString(), adopt_note: input.note ?? null, overrides: Object.keys(input.overrides).length === 0 ? null : JSON.stringify(input.overrides), evaluation_id: evaluation.id });
    return { before, row, evaluationId: evaluation.id };
  }

  /** Withdraws a proposal that the contractor was not told of yet. */
  async withdraw(tx: TenantTx, id: string, expectedVersion: number, reason: string, actor: string, now: Date, scopes: ContractScopes): Promise<{ before: RatingProposalRow; row: RatingProposalRow }> {
    const before = await this.guarded(tx, id, expectedVersion, scopes);
    moveRating(before.state, 'WITHDRAW', { actor, proposedBy: before.proposedBy, now, dueAt: null });
    const row = await this.write(tx, id, actor, { state: 'WITHDRAWN', withdrawn_by: actor, withdrawn_at: now.toISOString(), withdraw_reason: reason });
    return { before, row };
  }
}
