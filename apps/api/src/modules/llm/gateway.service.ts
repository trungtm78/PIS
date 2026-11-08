import { Inject, Injectable, Optional } from '@nestjs/common';
import { LlmEmergencyStore, LlmEvalStore, LlmExternalExceptionStore, LlmFinopsStore, LlmGatewayStore, LlmRegistryStore, TenantDatabase } from '@machvon/db';
import type { AiRequestRow } from '@machvon/db';
import { CLASSIFICATIONS, DomainError, GatewayFailure, MAX_CHECK_RETRIES, NOOP_METRICS, aiEditionPolicy, asUuid, classifySources, estimateVnd, externalVerdict, isExternalRoute, killedBy, planRoute, postCheck, unsupportedSchemaKeyword, vietnamDateOf } from '@machvon/kernel';
import type { AiGatewayPort, BudgetScope, Classification, MetricsSink, Price, RouteCandidate } from '@machvon/kernel';
import type { CommandScope } from '../../command-scope';
import { LLM_GATEWAY, LLM_METRICS } from './tokens';

const REQUEST = 'ai_request';
/** How long the hold of a request lasts before the job takes it for a request that never came back. */
const HOLD_MINUTES = 15;

export interface GatewayInput {
  taskType: string;
  subjectModule: string;
  subjectId: string | undefined;
  sourceRefs: readonly unknown[];
  inputRef: string;
  inputSha256: string;
  anonymisationAttestationId: string | undefined;
  maxCostVnd: string | undefined;
  /** The profile the caller admitted its request against: when given, the request is served by that profile or by none, never by one published since. */
  profileVersionId?: string;
  /** The project the request is made for, when the subject is not the project itself: its budget is held and charged as a project's is. */
  projectId?: string;
  /**
   * Sources that are records (a project, a contract) and not document versions: the caller read them in the scope of its user and gives their class (a record with no label is CONFIDENTIAL). They count in the class of
   * the request like a document does, and are kept with it in the classification basis.
   */
  recordSources?: ReadonlyArray<{ kind: string; id: string; classification: Classification }>;
}

export interface GatewayOutcome {
  request: AiRequestRow;
  /** What the model answered, for the module that asked: it is not kept here and is not in the answer of the API. */
  output: string | undefined;
}

/**
 * The request path of the AI gateway (ST-LLM-005, LLM F1): the class comes from the sources and never from the caller; the route is chosen among the routes the policy in force, the profile and the approved, priced models allow; a
 * request falls back only inside them; the budget is held before a model is called and settled attempt by attempt; and the answer is checked before it is used. What is kept is how the request was classified and routed,
 * every attempt, and its cost: the hash of the input and of the output, never the text of either.
 */
@Injectable()
export class LlmGatewayService {
  private readonly requests = new LlmGatewayStore();
  private readonly evals = new LlmEvalStore();
  private readonly registry = new LlmRegistryStore();
  private readonly finops = new LlmFinopsStore();
  private readonly emergency = new LlmEmergencyStore();
  private readonly exceptions = new LlmExternalExceptionStore();
  private readonly metrics: MetricsSink;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Inject(LLM_GATEWAY) private readonly gateway: AiGatewayPort,
    @Optional() @Inject(LLM_METRICS) metrics?: MetricsSink,
  ) {
    this.metrics = metrics ?? NOOP_METRICS;
  }

  private async pinnedProfile(tx: CommandScope['tx'], taskType: string, id: string) {
    const profile = await this.evals.findProfile(tx, id);
    return profile !== undefined && profile.status === 'PUBLISHED' && profile.taskType === taskType ? profile : undefined;
  }

  async request(scope: CommandScope, input: GatewayInput): Promise<GatewayOutcome> {
    const { tx } = scope;
    const actor = scope.tenant.membershipId;
    const profile = input.profileVersionId === undefined ? await this.evals.publishedProfile(tx, input.taskType) : await this.pinnedProfile(tx, input.taskType, input.profileVersionId);
    // A task with no profile in force cannot be asked for at all: there is nothing to record the request against.
    if (profile === undefined || profile.promptVersionId === null) throw new DomainError('AI_ROUTE_NOT_ALLOWED', 422, 'profile');
    // A profile that was published before the schema was limited to what the gateway checks is not served: an answer would be taken as valid by a rule that is not applied.
    if (unsupportedSchemaKeyword(profile.outputSchema) !== undefined) throw new DomainError('AI_ROUTE_NOT_ALLOWED', 422, 'output_schema');
    // The prompt the profile runs is the one that was approved and evaluated: a profile whose prompt is not approved any more is not served.
    const prompt = await this.evals.findPrompt(tx, profile.promptVersionId);
    if (prompt === undefined || (prompt.status !== 'APPROVED' && prompt.status !== 'RETIRED')) throw new DomainError('AI_ROUTE_NOT_ALLOWED', 422, 'prompt');
    const ids = input.sourceRefs.map((ref) => {
      const id = typeof ref === 'object' && ref !== null && !Array.isArray(ref) ? asUuid(String((ref as Record<string, unknown>).document_version_id)) : undefined;
      if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'source_refs');
      return id;
    });
    const sources = await this.requests.sources(tx, [...new Set(ids)]);
    const records = (input.recordSources ?? []).map((record) => ({ documentVersionId: record.id, classification: record.classification, kind: record.kind }));
    const classified = classifySources([...sources, ...records]);
    const policy = await this.registry.published(tx);
    const admitted = await this.requests.admit(tx, {
      taskType: input.taskType,
      subjectModule: input.subjectModule,
      subjectId: input.subjectId ?? null,
      requestedBy: actor,
      profileVersionId: profile.id,
      promptVersionId: profile.promptVersionId,
      dataClassification: classified.classification,
      classificationBasis: classified.basis,
      anonymisationAttestationId: input.anonymisationAttestationId ?? null,
      policyVersionId: policy?.id ?? null,
      inputSha256: input.inputSha256,
    });
    const now = new Date();
    // A request is stopped at the door by a switch of the tenant or of its task; a switch of a provider or a model only takes those candidates out. Postgres is read at every request (BR-LLM-12).
    const switches = await this.emergency.engaged(tx);
    const stopped = killedBy(switches, { taskType: input.taskType });
    if (stopped !== undefined) return this.reject(scope, admitted, new DomainError('AI_KILL_SWITCH_ENGAGED', 503, stopped.scopeKind), 'AI_KILL_SWITCH_ENGAGED');
    // The models that a switch of their provider or of themselves takes out: kept apart, to tell whether the switches are what left the request with nothing.
    const stoppedPool: RouteCandidate[] = [];
    // Where the edition keeps processing on the servers of the customer, a provider outside them is used only under an approved exception that stands (R5, KT.02): the models it takes out are kept apart too, to tell the caller why.
    const edition = aiEditionPolicy();
    const standing = edition.externalRouting === 'EXCEPTION_REQUIRED' ? await this.exceptions.standing(tx, now) : [];
    const withheldPool: RouteCandidate[] = [];
    const exceptionOf = new Map<string, string>();

    // The models the profile may use that can be called now: approved, on an active provider, with a price whose figures are all known.
    const prices = new Map<string, { id: string; price: Price }>();
    const candidates: RouteCandidate[] = [];
    for (const model of await this.evals.modelsOfProfile(tx, profile)) {
      if (model.status !== 'APPROVED' || model.providerStatus !== 'ACTIVE') continue;
      // A model is sent nothing above the class it takes.
      if (CLASSIFICATIONS.indexOf(model.maxClassification) < CLASSIFICATIONS.indexOf(classified.classification)) continue;
      const row = await this.finops.priceAt(tx, model.id, now);
      if (row === undefined || row.cachedSemantics === null || row.fxRateToVnd === null) continue;
      if (killedBy(switches, { taskType: input.taskType, providerId: model.providerId, modelRefId: model.id }) !== undefined) {
        stoppedPool.push({ modelRefId: model.id, modelId: model.modelId, providerId: model.providerId, providerCode: model.providerCode, route: model.route, pricingVersionId: row.id });
        continue;
      }
      const verdict = externalVerdict(edition, { providerId: model.providerId, route: model.route, taskType: input.taskType, classification: classified.classification, now }, standing);
      if (!verdict.allowed || !(await this.attested(tx, edition.attestationRequired, model.providerId, model.route))) {
        withheldPool.push({ modelRefId: model.id, modelId: model.modelId, providerId: model.providerId, providerCode: model.providerCode, route: model.route, pricingVersionId: row.id });
        continue;
      }
      if (verdict.exceptionId !== null) exceptionOf.set(model.id, verdict.exceptionId);
      prices.set(model.id, { id: row.id, price: { inputPerMillion: row.inputPerMillion, cachedPerMillion: row.cachedPerMillion, outputPerMillion: row.outputPerMillion, cachedSemantics: row.cachedSemantics, fxRateToVnd: row.fxRateToVnd } });
      candidates.push({ modelRefId: model.id, modelId: model.modelId, providerId: model.providerId, providerCode: model.providerCode, route: model.route, pricingVersionId: row.id });
    }
    const planFor = (models: RouteCandidate[]) =>
      planRoute({
        classification: classified.classification,
        profileMax: profile.maxClassification as typeof classified.classification,
        profileRoutes: profile.routingPolicy.routes,
        policy: policy === undefined ? undefined : { matrix: policy.matrix, internationalEnabled: policy.internationalEnabled },
        candidates: models,
        primaryModelId: profile.modelId,
      });
    const plan = planFor(candidates);
    // Nothing is left to serve the request, and a switch is the reason (the request could have been served without the switches): that is what the caller is told.
    if (!plan.ok && stoppedPool.length > 0 && planFor([...candidates, ...stoppedPool]).ok) return this.reject(scope, admitted, new DomainError('AI_KILL_SWITCH_ENGAGED', 503, 'provider'), 'AI_KILL_SWITCH_ENGAGED');
    // Nothing is left to serve the request, and the edition keeps it off the providers it would have gone to: that is what the caller is told, with the way out (an exception).
    if (!plan.ok && withheldPool.length > 0 && planFor([...candidates, ...withheldPool]).ok) return this.reject(scope, admitted, new DomainError('AI_EXTERNAL_EXCEPTION_REQUIRED', 422, 'provider'), 'AI_EXTERNAL_EXCEPTION_REQUIRED');
    if (!plan.ok) return this.reject(scope, admitted, new DomainError(plan.code, 422, plan.detail), plan.code);

    // The budget is held before a model is called, at the dearest of the models the request may fall back to, for every answer that may be paid for: the first and the ones asked again after a failed check.
    const dearest = plan.attempts.reduce((highest, attempt) => {
      const entry = prices.get(attempt.modelRefId) as { id: string; price: Price };
      const value = BigInt(estimateVnd({ inputBound: profile.maxInputTokens ?? 8000, outputCap: profile.outputCap }, entry.price));
      return value > highest ? value : highest;
    }, 0n);
    const estimate = dearest * BigInt(1 + MAX_CHECK_RETRIES);
    if (input.maxCostVnd !== undefined && estimate > BigInt(input.maxCostVnd)) return this.reject(scope, admitted, new DomainError('BUDGET_EXCEEDED', 429, 'max_cost_vnd'), 'COST_ABOVE_LIMIT');
    const scopes: Array<{ kind: BudgetScope; ref: string | null }> = [{ kind: 'TENANT', ref: null }];
    const project = input.projectId ?? (input.subjectModule.toUpperCase() === 'PRJ' ? input.subjectId : undefined);
    if (project !== undefined) scopes.push({ kind: 'PROJECT', ref: project });
    // The person who asks has a budget of their own when one was set.
    scopes.push({ kind: 'USER', ref: actor });
    const held = await this.finops.reserve(tx, { requestId: admitted.id, scopes, estimateVnd: estimate.toString(), day: vietnamDateOf(now), expiresAt: new Date(now.getTime() + HOLD_MINUTES * 60_000) });
    if (held.kind === 'DENIED') return this.reject(scope, admitted, new DomainError('BUDGET_EXCEEDED', 429, held.scope), 'BUDGET_EXCEEDED');
    if (held.kind === 'APPROVAL_REQUIRED') return this.reject(scope, admitted, new DomainError('BUDGET_EXCEEDED', 429, `APPROVAL_REQUIRED:${held.scope}`), 'BUDGET_APPROVAL_REQUIRED');
    const reservationId = held.reservation.id;
    const first = plan.attempts[0] as RouteCandidate;
    await this.requests.finish(tx, admitted.id, { status: 'RESERVED', routeClass: first.route, providerId: first.providerId, modelRefId: first.modelRefId, budgetReservationId: reservationId }, actor);

    // The call: the primary model, then the others in the order the plan gives; an answer that fails the checks is asked for again from the same model, and is not sent to another.
    const sourceIds = sources.map((source) => source.documentVersionId);
    const paid: Array<{ candidate: RouteCandidate; kind: 'PRIMARY' | 'RETRY' | 'FALLBACK'; attemptNo: number; providerRequestId: string; usage: { inputTotal: number; cachedInput: number; outputTotal: number }; latencyMs: number; check: ReturnType<typeof postCheck> }> = [];
    let attemptNo = 0;
    let timedOut = false;
    let last: RouteCandidate = first;
    let accepted: { output: string; outputSha256: string; citations: number } | undefined;
    let checkFailure: 'INVALID_JSON' | 'REJECTED_NO_CITATION' | undefined;
    let killed = false;
    let passedOver = false;
    // An exception that ended (its date, a revocation) while an earlier call was pending: no further call goes out under it.
    let externalLapsed = false;
    await this.requests.finish(tx, admitted.id, { status: 'DISPATCHED', routeClass: first.route }, actor);
    outer: for (const candidate of plan.attempts) {
      // A switch that was engaged since: the request stops, or only this model is passed over.
      const engagedNow = await this.emergency.engagedSince(tx, admitted.pageKey);
      if (killedBy(engagedNow, { taskType: input.taskType }) !== undefined) {
        killed = true;
        break;
      }
      if (killedBy(engagedNow, { taskType: input.taskType, providerId: candidate.providerId, modelRefId: candidate.modelRefId }) !== undefined) {
        passedOver = true;
        continue;
      }
      // Defence in depth: a route that is not allowed for the class of the request is not called, whatever the plan says.
      if (candidate.route === 'INTERNATIONAL' && classified.classification !== 'PUBLIC') {
        this.metrics.increment('llm_international_non_public_total', { tenant_id: scope.tenant.tenantId });
        continue;
      }
      last = candidate;
      // A call that goes out under an exception is logged before it is made: who allowed it, and which request used it.
      const usedException = exceptionOf.get(candidate.modelRefId);
      if (usedException !== undefined) {
        await this.exceptions.logUse(tx, { exceptionId: usedException, aiRequestId: admitted.id, providerId: candidate.providerId, taskType: input.taskType, classification: classified.classification, route: candidate.route });
        await scope.audit({ action: 'llm.external_exception_used', resourceType: 'ai_external_exception', resourceId: usedException, diff: { ai_request_id: admitted.id, provider_id: candidate.providerId, route_class: candidate.route, data_classification: classified.classification, task_type: input.taskType } });
      }
      let kind: 'PRIMARY' | 'RETRY' | 'FALLBACK' = attemptNo === 0 ? 'PRIMARY' : 'FALLBACK';
      for (let tries = 0; tries <= MAX_CHECK_RETRIES; tries += 1) {
        // The exception is read again before each call, retries included: what was allowed when the route was planned may have been revoked or may have run out since.
        if (usedException !== undefined) {
          const moment = new Date();
          const verdict = externalVerdict(edition, { providerId: candidate.providerId, route: candidate.route, taskType: input.taskType, classification: classified.classification, now: moment }, await this.exceptions.standing(tx, moment));
          if (!verdict.allowed || !(await this.attested(tx, edition.attestationRequired, candidate.providerId, candidate.route))) {
            externalLapsed = true;
            break;
          }
        }
        attemptNo += 1;
        const started = Date.now();
        try {
          const result = await this.gateway.complete({
            route: candidate.route,
            providerCode: candidate.providerCode,
            providerModelId: candidate.modelId,
            inputRef: input.inputRef,
            inputSha256: input.inputSha256,
            promptTemplateKey: prompt.templateObjectKey,
            promptSha256: prompt.templateSha256,
            sourceIds,
            outputSchema: profile.outputSchema,
            maxOutputTokens: profile.outputCap,
            effort: profile.effort,
            timeoutMs: profile.timeoutMs ?? 30_000,
            tools: profile.toolAllowlist,
          });
          const check = postCheck({ output: result.output, outputSchema: profile.outputSchema, sourceIds });
          paid.push({ candidate, kind, attemptNo, providerRequestId: result.providerRequestId, usage: result.usage, latencyMs: result.latencyMs, check });
          // The answer came after the scope was stopped: it was paid for and it is thrown away.
          if (killedBy(await this.emergency.engagedSince(tx, admitted.pageKey), { taskType: input.taskType, providerId: candidate.providerId, modelRefId: candidate.modelRefId }) !== undefined) {
            killed = true;
            break outer;
          }
          if (check.ok) {
            accepted = { output: result.output, outputSha256: check.outputSha256, citations: check.citations };
            break outer;
          }
          checkFailure = check.code;
          kind = 'RETRY';
        } catch (error) {
          // What a provider says about a failure can carry what was sent: only the kind of the failure is kept.
          const failure = error instanceof GatewayFailure ? error.kind : 'PROVIDER_ERROR';
          if (failure === 'TIMEOUT') timedOut = true;
          await this.requests.failedAttempt(tx, { requestId: admitted.id, attemptNo, kind, route: candidate.route, providerId: candidate.providerId, actualModel: candidate.modelId, pricingVersionId: candidate.pricingVersionId, outcome: failure, latencyMs: Date.now() - started });
          // A scope that was stopped while the call ran ends the request, as it does when the call answers: it is not sent on to another model.
          if (killedBy(await this.emergency.engagedSince(tx, admitted.pageKey), { taskType: input.taskType, providerId: candidate.providerId, modelRefId: candidate.modelRefId }) !== undefined) {
            killed = true;
            break outer;
          }
          // A retry that fails to answer ends the request on the failure of the checks it was asked again for; it is not sent to another model.
          if (kind !== 'RETRY') checkFailure = undefined;
          break;
        }
      }
      // An answer that failed the checks twice ends the request: another model is not asked to answer what this one was asked.
      if (checkFailure !== undefined) break;
    }

    // Every model that was left was stopped by a switch while the request ran: it is stopped, not exhausted.
    if (passedOver && accepted === undefined && checkFailure === undefined) killed = true;

    // The cost: every answer that was paid for is settled; the last one releases what is left of the hold.
    let costVnd = 0n;
    for (const [index, attempt] of paid.entries()) {
      const settled = await this.finops.settle(tx, {
        reservationId,
        providerRequestId: attempt.providerRequestId,
        actualModel: attempt.candidate.modelId,
        pricingVersionId: attempt.candidate.pricingVersionId,
        usage: attempt.usage,
        attemptKind: attempt.kind,
        attemptNo: attempt.attemptNo,
        routeClass: attempt.candidate.route,
        providerId: attempt.candidate.providerId,
        latencyMs: attempt.latencyMs,
        // A call that did not answer in time may still have been paid for, whether or not another model answered after it: the hold stays open until its usage is known.
        final: index === paid.length - 1 && !timedOut,
        actor,
      });
      costVnd += BigInt(settled.costVnd);
      if (!attempt.check.ok) await this.requests.markAttemptOutcome(tx, settled.attemptId, attempt.check.code === 'INVALID_JSON' ? 'INVALID_JSON' : 'NO_CITATION');
    }
    // Only a hold that is still open waits: a paid answer that went over the hold has settled it as an exception, and that stands.
    if (timedOut && (await this.finops.findReservation(tx, reservationId))?.status === 'RESERVED') await this.finops.markPendingReconcile(tx, reservationId, 'TIMEOUT_NO_USAGE');
    // A switch engaged after the last look, while the cost was settled, stops the request before it is called complete.
    if (!killed && accepted !== undefined && killedBy(await this.emergency.engagedSince(tx, admitted.pageKey), { taskType: input.taskType, providerId: last.providerId, modelRefId: last.modelRefId }) !== undefined) {
      killed = true;
      accepted = undefined;
    }
    const common = { routeClass: last.route, providerId: last.providerId, modelRefId: last.modelRefId, costVnd: costVnd.toString() };
    let finished: AiRequestRow;
    if (killed) {
      finished = await this.requests.finish(tx, admitted.id, { ...common, status: 'CANCELLED', rejectCode: 'AI_KILL_SWITCH_ENGAGED', completed: true }, actor);
      if (paid.length === 0 && !timedOut) await this.finops.release(tx, reservationId, 'KILL_SWITCH');
    } else if (accepted !== undefined) {
      finished = await this.requests.finish(tx, admitted.id, { ...common, status: 'COMPLETED', outputSha256: accepted.outputSha256, citationsCount: accepted.citations, completed: true }, actor);
    } else if (checkFailure === 'REJECTED_NO_CITATION') {
      finished = await this.requests.finish(tx, admitted.id, { ...common, status: 'REJECTED_NO_CITATION', rejectCode: 'NO_CITATION', completed: true }, actor);
    } else if (checkFailure === 'INVALID_JSON') {
      finished = await this.requests.finish(tx, admitted.id, { ...common, status: 'FAILED', rejectCode: 'INVALID_JSON', completed: true }, actor);
    } else if (timedOut) {
      // The hold stays until the usage is known (BR-LLM-06).
      finished = await this.requests.finish(tx, admitted.id, { ...common, status: 'PENDING_RECONCILE', rejectCode: 'AI_ROUTE_EXHAUSTED' }, actor);
    } else {
      if (paid.length === 0) await this.finops.release(tx, reservationId, 'NO_ANSWER');
      finished = await this.requests.finish(tx, admitted.id, { ...common, status: 'FAILED', rejectCode: externalLapsed ? 'AI_EXTERNAL_EXCEPTION_REQUIRED' : 'AI_ROUTE_EXHAUSTED', completed: true }, actor);
    }

    const attempts = await this.requests.attemptsOf(tx, admitted.id);
    await scope.audit({
      action: 'llm.request_routed',
      resourceType: REQUEST,
      resourceId: admitted.id,
      diff: {
        task_type: input.taskType,
        data_classification: finished.dataClassification,
        policy_version_id: finished.policyVersionId,
        status: finished.status,
        reject_code: finished.rejectCode,
        route_class: finished.routeClass,
        attempts: attempts.map((attempt) => ({ no: attempt.attemptNo, kind: attempt.attemptKind, route: attempt.routeClass, model: attempt.actualModel, outcome: attempt.outcome })),
      },
    });
    await scope.emit({
      aggregateType: REQUEST,
      aggregateId: admitted.id,
      aggregateVersion: finished.version,
      type: finished.status === 'COMPLETED' ? 'llm.request.completed.v1' : 'llm.request.failed.v1',
      schemaVersion: 1,
      payload: { ai_request_id: admitted.id, task_type: input.taskType, status: finished.status, route_class: finished.routeClass, data_classification: finished.dataClassification, cost_vnd: finished.costVnd },
      eventKey: `${REQUEST}:${admitted.id}:${finished.version}`,
    });
    this.count(scope, finished);
    return { request: finished, output: accepted?.output };
  }

  /** Where the edition asks for it, a provider outside the customer servers is used only while its data location and its no-training attestation are on record (R5): read at planning and again before each call. */
  private async attested(tx: CommandScope['tx'], required: boolean, providerId: string, route: RouteCandidate['route']): Promise<boolean> {
    if (!required || !isExternalRoute(route)) return true;
    const provider = await this.registry.findProvider(tx, providerId);
    return provider !== undefined && provider.dataLocationCountry !== null && provider.noTrainingAttested;
  }

  /** A request that the policy or the budget refuses is kept as such, with its audit, and the caller is told the refusal (the same key gets it again). */
  private async reject(scope: CommandScope, admitted: AiRequestRow, error: DomainError, code: string): Promise<GatewayOutcome> {
    const finished = await this.requests.finish(scope.tx, admitted.id, { status: 'REJECTED_POLICY', rejectCode: code, completed: true }, scope.tenant.membershipId);
    await scope.audit({
      action: 'llm.request_rejected',
      resourceType: REQUEST,
      resourceId: admitted.id,
      diff: { task_type: admitted.taskType, data_classification: admitted.dataClassification, policy_version_id: admitted.policyVersionId, reject_code: code, detail: error.detail ?? null },
    });
    await scope.emit({
      aggregateType: REQUEST,
      aggregateId: admitted.id,
      aggregateVersion: finished.version,
      type: 'llm.request.rejected.v1',
      schemaVersion: 1,
      payload: { ai_request_id: admitted.id, task_type: admitted.taskType, data_classification: admitted.dataClassification, reject_code: code },
      eventKey: `${REQUEST}:${admitted.id}:${finished.version}`,
    });
    this.count(scope, finished);
    scope.refuseAfterCommit(error);
    return { request: finished, output: undefined };
  }

  private count(scope: CommandScope, request: AiRequestRow): void {
    scope.afterCommit(() => this.metrics.increment('llm_requests_total', { tenant_id: scope.tenant.tenantId, route: request.routeClass ?? 'NONE', classification: request.dataClassification, status: request.status }));
  }
}
