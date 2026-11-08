import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AiAssistSourceStore, AiAssistStore, AiDecisionStore, contractScope, projectScope, scopePredicate, versionScope } from '@machvon/db';
import type { AssistDecisionRow, AssistReadScopes, AssistRunRow, CriteriaSetRow, ReadableSource, TenantTx } from '@machvon/db';
import {
  ASSIST_KIND_PERMISSION,
  ASSIST_TASK_TYPES,
  DomainError,
  MAX_SOURCES,
  NOOP_METRICS,
  buildAssistInput,
  composeReview,
  effectivePermissions,
  holdsPermission,
  materialClassifications,
  materialKey,
  parseAndVerifyAnswer,
  parseDecisionItems,
  proposeScores,
  readableIndex,
  redactCitations,
  refreshReview,
  resolveDecision,
  reverifyStatements,
  scrubSecrets,
  sectionCoverage,
} from '@machvon/kernel';
import type { AssistKind, CheckedStatement, EffectiveAccess, MetricsSink, ReviewResult, SourceMaterial, SourceRef, TenantContext } from '@machvon/kernel';
import type { CommandScope } from '../../command-scope';
import { FileService } from '../files';
import { runView } from './assist-view';
import { LlmGatewayService } from './gateway.service';
import { LLM_DOCUMENT_TEXT } from './knowledge-ports';
import type { DocumentTextPort } from './knowledge-ports';
import { LLM_METRICS } from './tokens';

const RUN = 'ai_assist_run';
const INPUT_KIND = 'ai-assist-input';
const SUBJECT_MODULE = 'LLM';
/** How many contracts of a project go in with it when the question is about the project as a whole. */
const RELATED_CONTRACTS = 10;

export interface AssistCreateInput {
  kind: AssistKind;
  requestText: string;
  sources: readonly SourceRef[];
  subject: SourceRef | undefined;
  checklistId: string | undefined;
  criteriaSetId: string | undefined;
  profileVersionId: string | undefined;
  maxCostVnd: string | undefined;
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const notReadable = (): DomainError => new DomainError('AI_ASSIST_SOURCE_NOT_READABLE', 422, 'sources');

/**
 * The AI assistant (lane AI-2): it reads what the asker may read, gives the gateway the text as data, verifies what comes back, and keeps the run. The class of the request, the route, the budget, the exception an edition asks
 * for and the attempts are the gateway's (`LlmGatewayService`); what is the assistant's is which sources the asker may read, how the statements are checked, and that nothing it proposes is applied: the decision is a person's.
 * The sources are read through the scope of the permission that reads each kind elsewhere, so a record the asker cannot open is never in the input and never in a citation, and a run shown again is checked against what the reader may read then.
 */
@Injectable()
export class AiAssistService {
  private readonly store = new AiAssistStore();
  private readonly sources = new AiAssistSourceStore();
  private readonly decisions = new AiDecisionStore();
  private readonly metrics: MetricsSink;

  constructor(
    @Inject(LlmGatewayService) private readonly gateway: LlmGatewayService,
    @Inject(FileService) private readonly files: FileService,
    @Inject(LLM_DOCUMENT_TEXT) private readonly texts: DocumentTextPort,
    @Optional() @Inject(LLM_METRICS) metrics?: MetricsSink,
  ) {
    this.metrics = metrics ?? NOOP_METRICS;
  }

  /** The scope of the asker over each kind of source: the same scope the register of that kind applies to a read. */
  scopesOf(access: EffectiveAccess, membershipId: string, now: Date): AssistReadScopes {
    return {
      documents: versionScope(access, PERMISSIONS.get_resources_document_version, now, membershipId),
      projects: projectScope(access, PERMISSIONS.get_resources_project, now),
      contracts: contractScope(access, PERMISSIONS.get_resources_contract, now),
      appraisals: (first) => scopePredicate(access, PERMISSIONS.getInvestmentAppraisal, now, { unitPath: 'ou.path', unitId: 'ou.id' }, first),
    };
  }

  /** The permission each kind asks for besides the one of the operation: reviewing and evaluating are not the same right as asking. */
  private assertMay(access: EffectiveAccess, kind: AssistKind, now: Date): void {
    if (!holdsPermission(effectivePermissions(access, now), ASSIST_KIND_PERMISSION[kind])) throw new DomainError('SCOPE_DENIED', 403);
  }

  async create(scope: CommandScope, access: EffectiveAccess, input: AssistCreateInput): Promise<AssistRunRow> {
    const { tx, tenant } = scope;
    const actor = tenant.membershipId;
    const now = new Date();
    this.assertMay(access, input.kind, now);
    const scopes = this.scopesOf(access, actor, now);

    // The sources: what the person named, the subject, and for a project or a contract what belongs to it. What the person named must all be readable; what was added for them is dropped when it is not.
    const named = [...input.sources, ...(input.subject === undefined ? [] : [input.subject])];
    const wanted: SourceRef[] = [];
    const add = (ref: SourceRef): void => {
      if (!wanted.some((other) => materialKey(other.kind, other.id) === materialKey(ref.kind, ref.id))) wanted.push(ref);
    };
    named.forEach(add);
    if (wanted.length === 0) throw new DomainError('VALIDATION_FAILED', 422, 'sources');
    // What belongs to the subject goes in with it: the contracts of a project, the project of a contract. A source that is only named brings nothing else.
    const related: SourceRef[] = [];
    for (const ref of input.subject === undefined ? [] : [input.subject]) {
      if (ref.kind === 'PROJECT') for (const id of await this.sources.contractsOfProject(tx, ref.id, scopes.contracts, RELATED_CONTRACTS)) related.push({ kind: 'CONTRACT', id });
      if (ref.kind === 'CONTRACT') {
        const project = await this.sources.projectOfContract(tx, ref.id, scopes.contracts);
        if (project !== undefined) related.push({ kind: 'PROJECT', id: project });
      }
    }
    related.forEach((ref) => {
      if (wanted.length < MAX_SOURCES) add(ref);
    });
    const readable = await this.sources.readable(tx, wanted, scopes);
    const readableKeys = new Set(readable.map((source) => materialKey(source.kind, source.id)));
    if (named.some((ref) => !readableKeys.has(materialKey(ref.kind, ref.id)))) throw notReadable();
    if (readable.length === 0) throw notReadable();
    if (input.kind === 'DOC_REVIEW' && !readable.some((source) => source.kind === 'DOCUMENT_VERSION')) throw new DomainError('VALIDATION_FAILED', 422, 'sources');
    if (input.kind === 'CONTRACT_EVAL' && !readable.some((source) => source.kind === 'CONTRACT')) throw new DomainError('VALIDATION_FAILED', 422, 'sources');

    // The checklist and the criteria in force: only a published revision is run.
    const checklist = input.kind === 'DOC_REVIEW' ? await this.store.findChecklist(tx, input.checklistId ?? randomUUID()) : undefined;
    if (input.kind === 'DOC_REVIEW' && (checklist === undefined || checklist.status !== 'PUBLISHED')) throw new DomainError('CHECKLIST_NOT_PUBLISHED', 422, 'checklist_id');
    const criteria = input.kind === 'CONTRACT_EVAL' ? await this.store.findCriteriaSet(tx, input.criteriaSetId ?? randomUUID()) : undefined;
    if (input.kind === 'CONTRACT_EVAL' && (criteria === undefined || criteria.status !== 'PUBLISHED')) throw new DomainError('CRITERIA_NOT_PUBLISHED', 422, 'criteria_set_id');

    // The text of each document, page by page (the OCR the document module recorded); a record is read as its fields.
    const materials: SourceMaterial[] = [];
    const fullText: string[] = [];
    for (const source of readable) {
      if (source.kind !== 'DOCUMENT_VERSION') {
        materials.push(source);
        continue;
      }
      const pages = await this.texts.pages(tx, tenant, source.id);
      fullText.push(pages.join('\n'));
      materials.push({ ...source, parts: pages.map((text, position) => ({ locator: `page:${position + 1}`, text })) });
    }

    const built = buildAssistInput({
      kind: input.kind,
      request: input.requestText,
      materials,
      checklist: checklist?.items.map((item) => ({ code: item.code, label: item.label, kind: item.kind, question: typeof item.params.question === 'string' ? item.params.question : undefined })),
      criteria: criteria?.criteria.map((criterion) => ({ code: criterion.code, label: criterion.label, guidance: criterion.guidance, evidenceRequired: criterion.evidenceRequired })),
      scaleMax: criteria?.scaleMax,
    });
    const bytes = new TextEncoder().encode(built.body);
    const inputRef = await this.files.storeGenerated(tenant, INPUT_KIND, randomUUID(), bytes, 'application/json');
    scope.afterRollback(async () => {
      await this.files.remove(tenant, inputRef);
    });

    const documents = materials.filter((material) => material.kind === 'DOCUMENT_VERSION');
    const project = input.subject?.kind === 'PROJECT' ? input.subject.id : materials.find((material) => material.kind === 'PROJECT')?.id;
    const outcome = await this.gateway.request(scope, {
      taskType: ASSIST_TASK_TYPES[input.kind],
      subjectModule: SUBJECT_MODULE,
      subjectId: input.subject?.id,
      sourceRefs: documents.map((document) => ({ document_version_id: document.id })),
      recordSources: materialClassifications(materials.filter((material) => material.kind !== 'DOCUMENT_VERSION')).map((entry) => ({ kind: entry.kind, id: entry.id, classification: entry.classification })),
      inputRef,
      inputSha256: sha256(bytes),
      anonymisationAttestationId: undefined,
      maxCostVnd: input.maxCostVnd,
      ...(input.profileVersionId === undefined ? {} : { profileVersionId: input.profileVersionId }),
      ...(project === undefined ? {} : { projectId: project }),
    });
    const request = outcome.request;
    const common = {
      kind: input.kind,
      subjectModule: input.subject === undefined ? null : SUBJECT_MODULE,
      subjectId: input.subject?.id ?? null,
      checklistId: checklist?.id ?? null,
      criteriaSetId: criteria?.id ?? null,
      requestText: input.requestText,
      sourceRefs: readable.map((source) => ({ kind: source.kind, id: source.id })),
      aiRequestId: request.id,
      dataClassification: request.dataClassification,
      routeClass: request.routeClass,
      injectionSignals: built.signalCount,
    };
    const empty = { statements: [] as CheckedStatement[], counts: { statements: 0, verified: 0, unsupported: 0, withheldCitations: 0 }, completeness: 'NONE' as const, outputSha256: null };
    const resultBase = { open_questions: [] as string[], signals: { count: built.signalCount, kinds: built.signalKinds }, truncated: built.truncated, included_parts: built.includedParts };
    let run: AssistRunRow;
    if (request.status !== 'COMPLETED') {
      // A request the gateway refused or could not serve is kept as the run it ended: the same key gets the same answer, and the history shows what was asked and why it stopped.
      const refused = ['REJECTED_POLICY', 'CANCELLED'].includes(request.status);
      run = await this.store.insertRun(tx, { ...common, ...empty, status: refused ? 'REFUSED' : 'FAILED', refusalCode: request.rejectCode ?? request.status, result: resultBase, askedBy: actor });
    } else {
      const verified = parseAndVerifyAnswer(outcome.output ?? '', readableIndex(materials));
      if (!verified.ok) {
        run = await this.store.insertRun(tx, { ...common, ...empty, status: 'FAILED', refusalCode: verified.code, result: resultBase, askedBy: actor });
      } else {
        const answer = verified.value;
        const result: Record<string, unknown> = { ...resultBase, open_questions: answer.openQuestions };
        if (checklist !== undefined) {
          result.checklist = { id: checklist.id, code: checklist.code, revision: checklist.revision, title: checklist.title };
          result.review = composeReview(checklist.items, fullText.join('\n'), answer.statements);
        }
        if (criteria !== undefined) result.evaluation = this.evaluationOf(criteria, answer.statements);
        if (input.kind === 'FEASIBILITY') result.coverage = sectionCoverage(answer.statements);
        run = await this.store.insertRun(tx, {
          ...common,
          status: 'COMPLETED',
          refusalCode: null,
          outputSha256: request.outputSha256,
          statements: answer.statements,
          result,
          counts: { statements: answer.counts.statements, verified: answer.counts.verified, unsupported: answer.counts.unsupported, withheldCitations: answer.counts.withheldCitations },
          completeness: answer.completeness,
          askedBy: actor,
        });
      }
    }
    await scope.audit({
      action: 'llm.assist_run_recorded',
      resourceType: RUN,
      resourceId: run.id,
      diff: {
        kind: run.kind,
        status: run.status,
        refusal_code: run.refusalCode,
        ai_request_id: run.aiRequestId,
        data_classification: run.dataClassification,
        route_class: run.routeClass,
        statements: run.statementCount,
        unsupported: run.unsupportedCount,
        withheld_citations: run.withheldCitationCount,
        injection_signals: run.injectionSignalCount,
        sources: readable.map((source) => source.kind),
      },
    });
    await scope.emit({
      aggregateType: RUN,
      aggregateId: run.id,
      aggregateVersion: 1,
      type: 'llm.assist.run.recorded.v1',
      schemaVersion: 1,
      payload: { run_id: run.id, kind: run.kind, status: run.status, ai_request_id: run.aiRequestId, data_classification: run.dataClassification, route_class: run.routeClass, completeness: run.completeness },
      eventKey: `${RUN}:${run.id}:1`,
    });
    scope.afterCommit(() => {
      this.metrics.increment('llm_assist_runs_total', { tenant_id: tenant.tenantId, kind: run.kind, status: run.status });
      if (run.statementCount > 0) this.metrics.gauge('llm_assist_unsupported_ratio', run.unsupportedCount / run.statementCount, { tenant_id: tenant.tenantId, kind: run.kind });
    });
    return run;
  }

  private evaluationOf(criteria: CriteriaSetRow, statements: readonly CheckedStatement[]): Record<string, unknown> {
    return { criteria_set: { id: criteria.id, code: criteria.code, revision: criteria.revision, title: criteria.title }, scale_max: criteria.scaleMax, criteria: proposeScores(criteria.criteria, criteria.scaleMax, statements) };
  }

  /** What the reader may read of the sources of a run now (parts of documents are not needed to judge a citation: the index only says who may read what). */
  private async readableNow(tx: TenantTx, tenant: TenantContext, access: EffectiveAccess, run: AssistRunRow, now: Date): Promise<ReadableSource[]> {
    return this.sources.readable(tx, run.sourceRefs, this.scopesOf(access, tenant.membershipId, now));
  }

  /** A run as the reader sees it now: the citations of a source they may not read are taken out of the statements and of the result, and what rests on them is shown as unsupported. */
  async view(tx: TenantTx, tenant: TenantContext, access: EffectiveAccess, run: AssistRunRow): Promise<Record<string, unknown>> {
    const now = new Date();
    const readable = await this.readableNow(tx, tenant, access, run, now);
    const index = readableIndex(readable.map((source) => ({ ...source, parts: [] })));
    const again = reverifyStatements(run.statements, index);
    const redacted = redactCitations(run.result, index);
    let result = redacted.value as Record<string, unknown>;
    if (typeof result.review === 'object' && result.review !== null) result = { ...result, review: refreshReview(result.review as ReviewResult, again.statements) };
    // The proposals of an evaluation are judged again on the statements as they stand for this reader: a score that rested on a source they may not read is withheld.
    const evaluation = typeof result.evaluation === 'object' && result.evaluation !== null ? (result.evaluation as Record<string, unknown>) : undefined;
    const scored = evaluation === undefined || run.criteriaSetId === null ? undefined : await this.store.findCriteriaSet(tx, run.criteriaSetId);
    if (evaluation !== undefined && scored !== undefined) result = { ...result, evaluation: { ...evaluation, criteria: proposeScores(scored.criteria, scored.scaleMax, again.statements) } };
    const unreadable = run.sourceRefs.length - readable.length;
    if (unreadable > 0) result = { ...result, sources_unreadable: unreadable };
    const decision = await this.store.findDecision(tx, run.id);
    return runView(run, { statements: again.statements, result, sources: readable, withheld: again.withheld + redacted.withheld, decision });
  }

  /**
   * The decision of the person about their run (AI.04): checked against what they may read now, resolved into what they accept, written to the record of human decisions of the gateway and to the run. The assistant is not
   * a party to it, and nothing outside these tables moves.
   */
  async decide(scope: CommandScope, access: EffectiveAccess, runId: string, body: { decision: string; rationale: string; items: unknown }): Promise<{ run: AssistRunRow; decision: AssistDecisionRow }> {
    const { tx, tenant } = scope;
    const actor = tenant.membershipId;
    const run = await this.store.findRun(tx, runId, actor);
    if (run === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (run.status !== 'COMPLETED' || run.aiRequestId === null || run.outputSha256 === null) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    if ((await this.store.findDecision(tx, run.id)) !== undefined) throw new DomainError('AI_ASSIST_ALREADY_DECIDED', 409, 'run_id');
    if (body.decision !== 'ACCEPTED' && body.decision !== 'ACCEPTED_WITH_CHANGE' && body.decision !== 'REJECTED') throw new DomainError('VALIDATION_FAILED', 422, 'decision');
    const rationale = scrubSecrets(body.rationale.trim()).trim();
    if (rationale.length < 20) throw new DomainError('VALIDATION_FAILED', 422, 'rationale');
    const items = parseDecisionItems(body.items);
    const now = new Date();
    const readable = await this.readableNow(tx, tenant, access, run, now);
    const again = reverifyStatements(run.statements, readableIndex(readable.map((source) => ({ ...source, parts: [] }))));
    const criteria = run.kind === 'CONTRACT_EVAL' ? await this.store.findCriteriaSet(tx, run.criteriaSetId ?? randomUUID()) : undefined;
    const accepted = resolveDecision(body.decision, items, {
      kind: run.kind,
      statements: again.statements,
      criteria: criteria?.criteria,
      scaleMax: criteria?.scaleMax,
      proposals: criteria === undefined ? undefined : proposeScores(criteria.criteria, criteria.scaleMax, again.statements),
    });
    const record = await this.decisions.record(tx, {
      aiRequestId: run.aiRequestId,
      subjectModule: SUBJECT_MODULE,
      subjectKind: `ASSIST_${run.kind}`,
      subjectId: run.id,
      aiOutputSha256: run.outputSha256,
      actionKind: run.kind === 'CONTRACT_EVAL' || run.kind === 'DOC_REVIEW' ? 'DECISION' : 'WRITE',
      decision: body.decision,
      rationale,
      actor,
    });
    const decision = await this.store.recordDecision(tx, { runId: run.id, decision: body.decision, rationale, items, acceptedResult: accepted as Record<string, unknown>, aiDecisionRecordId: record.id, actor });
    await scope.audit({ action: 'llm.assist_run_decided', resourceType: RUN, resourceId: run.id, diff: { kind: run.kind, decision: decision.decision, ai_decision_record_id: record.id, items: items.length, total: accepted.total ?? null } });
    await scope.emit({
      aggregateType: RUN,
      aggregateId: run.id,
      aggregateVersion: 1,
      type: 'llm.assist.run.decided.v1',
      schemaVersion: 1,
      payload: { run_id: run.id, kind: run.kind, decision: decision.decision, ai_decision_record_id: record.id },
      eventKey: `${RUN}:${run.id}:decided`,
    });
    return { run, decision };
  }
}
