import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { LlmGatewayStore, TenantDatabase } from '@machvon/db';
import type { AiRequestRow, AttemptRow, RequestSummary } from '@machvon/db';
import { DomainError, asUuid, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { LlmGatewayService } from './gateway.service';

/** The nil identifier stands for the baseline when no policy was in force: the contract says the route decision names a policy version. */
export const BASELINE_POLICY = '00000000-0000-0000-0000-000000000000';

const STATUSES = ['ADMITTED', 'REJECTED_POLICY', 'RESERVED', 'DISPATCHED', 'COMPLETED', 'FAILED', 'CANCELLED', 'REJECTED_NO_CITATION', 'PENDING_RECONCILE'];
const ROUTES = ['DOMESTIC_HOSTED', 'SELF_HOSTED', 'INTERNATIONAL'];
const CLASSES = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PERSONAL', 'IMPORTANT_CORE'];

export function requestView(row: AiRequestRow): Record<string, unknown> {
  return {
    id: row.id,
    task_type: row.taskType,
    subject_module: row.subjectModule,
    subject_id: row.subjectId,
    data_classification: row.dataClassification,
    route_class: row.routeClass,
    provider_code: row.providerCode,
    model_id: row.modelId,
    status: row.status,
    reject_code: row.rejectCode,
    citations_count: row.citationsCount,
    cost_vnd: row.costVnd,
    requested_by: row.requestedBy,
    created_at: row.createdAt,
    completed_at: row.completedAt,
    version: row.version,
  };
}

export function attemptView(row: AttemptRow): Record<string, unknown> {
  return {
    id: row.id,
    ai_request_id: row.aiRequestId,
    attempt_no: row.attemptNo,
    attempt_kind: row.attemptKind,
    route_class: row.routeClass,
    provider_code: row.providerCode,
    model_id: row.actualModel,
    outcome: row.outcome,
    latency_ms: row.latencyMs,
    input_tokens: row.inputTotal,
    cached_input_tokens: row.cachedInput,
    output_tokens: row.outputTotal,
    cost_vnd: row.costVnd,
    reconcile_status: row.reconcileStatus,
    created_at: row.createdAt,
  };
}

const summaryView = (summary: RequestSummary): Record<string, unknown> => ({ period_start: summary.periodStart, total: summary.total, by_route: summary.byRoute, by_status: summary.byStatus, blocked: summary.blocked });

const cursorOf = (key: string, id: string): string => Buffer.from(`${key}|${id}`).toString('base64url');
function parseCursor(raw: unknown): { key: string; id: string } | undefined {
  if (raw === undefined) return undefined;
  const text = Buffer.from(String(raw), 'base64url').toString('utf8');
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6})\|([0-9a-f-]{36})$/.exec(text);
  if (match === null) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
  const key = match[1] as string;
  // The time must be a real moment and the id a real uuid: what the database would not cast is refused here, not answered with a failure of the server.
  const moment = new Date(`${key.slice(0, 23)}Z`);
  const id = asUuid(match[2] as string);
  if (Number.isNaN(moment.getTime()) || moment.toISOString().slice(0, 23) !== key.slice(0, 23) || id === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
  return { key, id };
}

function limitOf(raw: unknown): number {
  if (raw === undefined) return 50;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 200) throw new DomainError('VALIDATION_FAILED', 422, 'limit');
  return value;
}

function oneOf(raw: unknown, allowed: readonly string[], field: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !allowed.includes(raw)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return raw;
}

/**
 * The request path of the AI gateway over HTTP (ST-LLM-005, LLM F1, LLM-01, LLM-05): a request is made with the sources it reads and the hash of its input, and is classified, routed and checked by the server; the answer of the
 * model goes to the module that asked (`LlmGatewayService`), not to this API, which tells where the request stands. The record of how each request was routed is read here.
 */
@Controller()
export class LlmGatewayController {
  private readonly requests = new LlmGatewayStore();

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Inject(LlmGatewayService) private readonly gateway: LlmGatewayService,
  ) {}

  private whole(access: EffectiveAccess, permission: string): void {
    if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
  }

  @Post('ai/requests')
  @HttpCode(202)
  @OperationId('requestAiCompletion')
  @Command({ operation: 'requestAiCompletion' })
  async request(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['LlmCompletionRequest']): Promise<CommandResult & { data_classification: string; route_class: string | null; reject_code: string | null }> {
    this.whole(access, PERMISSIONS.requestAiCompletion);
    const taskType = body.task_type.trim();
    const module = body.subject_module.trim();
    if (taskType === '' || module === '') throw new DomainError('VALIDATION_FAILED', 422, 'task_type');
    const outcome = await this.gateway.request(scope, {
      taskType,
      subjectModule: module,
      subjectId: body.subject_id,
      sourceRefs: body.source_refs,
      inputRef: body.input_ref,
      inputSha256: body.input_sha256,
      anonymisationAttestationId: body.anonymisation_attestation_id,
      maxCostVnd: body.max_cost_vnd,
    });
    const { request } = outcome;
    return { ...commandResult(scope, request.status, request.version, request.id), data_classification: request.dataClassification, route_class: request.routeClass, reject_code: request.rejectCode };
  }

  @Get('ai/requests')
  @OperationId('listAiRequests')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('status') status?: unknown,
    @Query('route_class') routeClass?: unknown,
    @Query('data_classification') classification?: unknown,
    @Query('task_type') taskType?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('limit') limit?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string; summary: Record<string, unknown> }> {
    this.whole(access, PERMISSIONS.listAiRequests);
    const filter = {
      status: oneOf(status, STATUSES, 'status'),
      routeClass: oneOf(routeClass, ROUTES, 'route_class'),
      classification: oneOf(classification, CLASSES, 'data_classification'),
      taskType: taskType === undefined ? undefined : String(taskType).slice(0, 60),
      limit: limitOf(limit),
      after: parseCursor(cursor),
    };
    const now = new Date();
    const day = vietnamDateOf(now);
    const { page, summary } = await this.database.withTenant(tenant, async (tx) => ({ page: await this.requests.requests(tx, filter), summary: await this.requests.summary(tx, `${day.slice(0, 7)}-01`) }));
    return { items: page.rows.map(requestView), next_cursor: page.next === undefined ? null : cursorOf(page.next.key, page.next.id), as_of: now.toISOString(), summary: summaryView(summary) };
  }

  @Get('ai/requests/:id/route')
  @OperationId('getAiRequestRoute')
  async route(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    this.whole(access, PERMISSIONS.getAiRequestRoute);
    const found = await this.database.withTenant(tenant, async (tx) => {
      const request = await this.requests.find(tx, id);
      return request === undefined ? undefined : { request, attempts: await this.requests.attemptsOf(tx, id) };
    });
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const { request, attempts } = found;
    return {
      ai_request_id: request.id,
      data_classification: request.dataClassification,
      classification_basis: request.classificationBasis,
      policy_version_id: request.policyVersionId ?? BASELINE_POLICY,
      route_class: request.routeClass ?? '',
      provider_code: request.providerCode ?? '',
      model_id: request.modelId ?? '',
      status: request.status,
      reject_code: request.rejectCode,
      attempts: attempts.map(attemptView),
    };
  }

  @Get('resources/llm_attempt')
  @OperationId('get_resources_llm_attempt')
  async attempts(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('cursor') cursor?: unknown, @Query('limit') limit?: unknown): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    this.whole(access, PERMISSIONS.get_resources_llm_attempt);
    const filter = { limit: limitOf(limit), after: parseCursor(cursor) };
    const page = await this.database.withTenant(tenant, (tx) => this.requests.attempts(tx, filter));
    return { items: page.rows.map(attemptView), next_cursor: page.next === undefined ? null : cursorOf(page.next.key, page.next.id), as_of: new Date().toISOString() };
  }

  @Get('resources/llm_attempt/:id')
  @OperationId('get_resources_llm_attempt_id')
  async attempt(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    this.whole(access, PERMISSIONS.get_resources_llm_attempt_id);
    const row = await this.database.withTenant(tenant, (tx) => this.requests.findAttempt(tx, id));
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return attemptView(row);
  }
}
