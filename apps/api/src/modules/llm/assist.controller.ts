import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { AiAssistStore, TenantDatabase } from '@machvon/db';
import { ASSIST_KINDS, DomainError, assertRequestText, isAssistKind, parseSourceRefs } from '@machvon/kernel';
import type { EffectiveAccess, SourceRef, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { cursorOf, idOf, limitOf, oneOf, parseCursor } from './assist-paging';
import { runListView } from './assist-view';
import { AiAssistService } from './assist.service';

const MAX_COST = /^(0|[1-9][0-9]{0,17})$/;
const RUN_STATUSES = ['COMPLETED', 'REFUSED', 'FAILED'];

/**
 * The AI assistant over HTTP (lane AI-2; AI.01, AI.02, AI.04, AI.05, AI.07; LLM-22 to LLM-25). A run is the person's own: they ask, they read it, they decide about it, and nobody else reads what was proposed to them. What the
 * assistant may read is what the person may read (the scope of each kind of source), what comes back is checked before it is kept (citations, labels, checklists, scores), and the decision about it is a command of its own
 * by the person, never the assistant's.
 */
@Controller()
export class AiAssistController {
  private readonly store = new AiAssistStore();

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Inject(AiAssistService) private readonly assist: AiAssistService,
  ) {}

  @Post('ai/assist/runs')
  @HttpCode(200)
  @OperationId('createAiAssistRun')
  @Command({ operation: 'createAiAssistRun' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['AiAssistRunCreate']): Promise<Record<string, unknown>> {
    if (!isAssistKind(body.kind)) throw new DomainError('VALIDATION_FAILED', 422, 'kind');
    const needsText = body.kind !== 'DOC_REVIEW' && body.kind !== 'CONTRACT_EVAL';
    const requestText = assertRequestText(body.request_text ?? '', 'request_text', needsText);
    const sources: SourceRef[] = body.sources === undefined ? [] : parseSourceRefs(body.sources, 'sources');
    const subject = body.subject === undefined ? undefined : parseSourceRefs([body.subject], 'subject')[0];
    if (sources.length === 0 && subject === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'sources');
    if (body.max_cost_vnd !== undefined && !MAX_COST.test(body.max_cost_vnd)) throw new DomainError('VALIDATION_FAILED', 422, 'max_cost_vnd');
    if ((body.kind === 'DOC_REVIEW') !== (body.checklist_id !== undefined)) throw new DomainError('VALIDATION_FAILED', 422, 'checklist_id');
    if ((body.kind === 'CONTRACT_EVAL') !== (body.criteria_set_id !== undefined)) throw new DomainError('VALIDATION_FAILED', 422, 'criteria_set_id');
    const run = await this.assist.create(scope, access, {
      kind: body.kind,
      requestText,
      sources,
      subject,
      checklistId: body.checklist_id === undefined ? undefined : idOf(body.checklist_id, 'checklist_id'),
      criteriaSetId: body.criteria_set_id === undefined ? undefined : idOf(body.criteria_set_id, 'criteria_set_id'),
      profileVersionId: body.profile_version_id === undefined ? undefined : idOf(body.profile_version_id, 'profile_version_id'),
      maxCostVnd: body.max_cost_vnd,
    });
    return this.assist.view(scope.tx, scope.tenant, access, run);
  }

  @Get('ai/assist/runs')
  @OperationId('listAiAssistRuns')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query('kind') kind?: unknown,
    @Query('status') status?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('limit') limit?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const filter = { kind: oneOf(kind, ASSIST_KINDS, 'kind'), status: oneOf(status, RUN_STATUSES, 'status'), limit: limitOf(limit), after: parseCursor(cursor) };
    const { page, decided } = await this.database.withTenant(tenant, async (tx) => {
      const found = await this.store.listRuns(tx, tenant.membershipId, filter);
      return { page: found, decided: await this.store.decisionsOf(tx, found.rows.map((row) => row.id)) };
    });
    return { items: page.rows.map((row) => runListView(row, decided.get(row.id))), next_cursor: page.next === undefined ? null : cursorOf(page.next.key, page.next.id), as_of: new Date().toISOString() };
  }

  @Get('ai/assist/runs/:id')
  @OperationId('getAiAssistRun')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const found = await this.database.withTenant(tenant, async (tx) => {
      const run = await this.store.findRun(tx, id, tenant.membershipId);
      return run === undefined ? undefined : this.assist.view(tx, tenant, access, run);
    });
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return found;
  }

  @Post('ai/assist/runs/:id/decision')
  @HttpCode(200)
  @OperationId('decideAiAssistRun')
  @Command({ operation: 'decideAiAssistRun' })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['AiAssistDecisionRequest']): Promise<CommandResult> {
    const done = await this.assist.decide(scope, access, id, { decision: body.decision, rationale: body.rationale, items: body.items });
    return commandResult(scope, done.decision.decision, 1, done.decision.id);
  }
}
