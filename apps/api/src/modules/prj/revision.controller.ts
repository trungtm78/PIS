import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { PrjRevisionStore, REVISION_RESOURCE, TenantDatabase, projectScope } from '@machvon/db';
import type { ProjectRevisionLine, RevisionChange } from '@machvon/db';
import { vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { recordGovernanceEffects } from './governance-effects';
import { SHARED_PIPELINE_CACHE } from './pipeline-cache';
import type { PipelineCache } from './pipeline-cache';
import { reaches } from './reach';
import { PRJ_PIPELINE_CACHE } from './tokens';

const READ_PERMISSION = PERMISSIONS.get_resources_project;
const PROPOSE_PERMISSION = PERMISSIONS.proposeProjectRevision;
const APPROVE_PERMISSION = PERMISSIONS.decideProjectRevision;

const PROPOSED_ACTION = 'project.revision_proposed';
const DECIDED_ACTION = 'project.revision_decided';
const REVISED_EVENT = 'project.revised.v1';

/** The line of the history of revisions (PRJ-06, PRJ-04) as the contract exposes it: an allowlist. */
export function revisionLineView(line: ProjectRevisionLine): Record<string, unknown> {
  return {
    id: line.id,
    revision: line.revision,
    change_kind: line.kind,
    status: line.status,
    before: line.before,
    after: line.after,
    total_investment_vnd: line.totalInvestmentVnd,
    reason: line.reason,
    decision_reason: line.decisionReason,
    decision_document:
      line.decisionDocument === null
        ? null
        : {
            id: line.decisionDocument.id,
            title: line.decisionDocument.title,
            number: line.decisionDocument.number,
            number_year: line.decisionDocument.numberYear,
            symbol: line.decisionDocument.symbol,
            issued_on: line.decisionDocument.issuedOn,
            effect_status: line.decisionDocument.effectStatus,
          },
    effective_from: line.effectiveFrom,
    supersedes_id: line.supersedesId,
    created_by: { membership_id: line.createdBy.membershipId, display_name: line.createdBy.displayName },
    created_at: line.createdAt,
    decided_by: line.decidedBy === null ? null : { membership_id: line.decidedBy.membershipId, display_name: line.decidedBy.displayName },
    decided_at: line.decidedAt,
    version: line.version,
  };
}

/**
 * The revisions of a project (ST-PRJ-008, PRJ 3.1 F6, PRJ-06): the investor proposes a change of the investment total, the schedule, the scope or the investor unit; someone else decides it with a decision
 * document and the day it takes effect; the figures of the project follow the revision approved last. The proposal is under the version of the project, the decision under the version of the revision.
 */
@Controller()
export class ProjectRevisionController {
  private readonly revisions = new PrjRevisionStore();
  private readonly cache: PipelineCache;

  constructor(@Optional() @Inject(PRJ_PIPELINE_CACHE) cache?: PipelineCache) {
    this.cache = cache ?? SHARED_PIPELINE_CACHE;
  }

  @Post('projects/:id/revisions')
  @HttpCode(200)
  @OperationId('proposeProjectRevision')
  @Command({ operation: 'proposeProjectRevision', versioned: true })
  async propose(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjRevisionProposal']): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const change = await this.revisions.propose(scope.tx, {
      // The identifier travels on as the lower-case text the database writes: the audit row and the event are matched against ids as strings.
      projectId: id.toLowerCase(),
      expectedVersion: scope.expectedVersion ?? 0,
      body: { ...body },
      actor: scope.tenant.membershipId,
      scopes: { act: projectScope(access, PROPOSE_PERMISSION, now), read: projectScope(access, READ_PERMISSION, now) },
      today: vietnamDateOf(now),
    });
    await this.record(scope, PROPOSED_ACTION, change);
    return this.answer(scope, change);
  }

  @Post('project-revisions/:id/decision')
  @HttpCode(200)
  @OperationId('decideProjectRevision')
  @Command({ operation: 'decideProjectRevision', versioned: true })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjRevisionDecision']): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const change = await this.revisions.decide(scope.tx, {
      revisionId: id.toLowerCase(),
      expectedVersion: scope.expectedVersion ?? 0,
      body: { ...body },
      actor: scope.tenant.membershipId,
      scopes: { act: projectScope(access, APPROVE_PERMISSION, now), read: projectScope(access, READ_PERMISSION, now) },
      authorizes: (unit) => reaches(access, APPROVE_PERMISSION, unit, now),
      today: vietnamDateOf(now),
    });
    await this.record(scope, DECIDED_ACTION, change);
    if (change.status === 'APPROVED') {
      await scope.emit({
        aggregateType: 'project',
        aggregateId: change.projectId,
        aggregateVersion: change.projectVersion,
        type: REVISED_EVENT,
        schemaVersion: 1,
        payload: {
          tenant_id: scope.tenant.tenantId,
          project_id: change.projectId,
          version: change.projectVersion,
          actor_id: scope.tenant.membershipId,
          occurred_at: now.toISOString(),
          revision_id: change.id,
          revision: change.revision,
          change_kind: change.kind,
          total_investment_vnd: change.totalInvestmentVnd,
          effective_from: change.effectiveFrom,
          decision_document_id: change.decisionDocumentId,
          supersedes_revision_id: change.supersededRevisionId,
        },
        eventKey: `project:${change.projectId}:revised:${change.id}`,
      });
      scope.afterCommit(() => this.cache.invalidate(scope.tenant.tenantId));
      // G1-3: the next version of the baseline, a pushed-back end year counted as a move of a date, and the request to appraise again when the deviation passes the threshold (hook of lane B1).
      await recordGovernanceEffects(scope, { id: change.projectId, code: change.projectCode, classification: change.classification }, change.governance, now);
    }
    return this.answer(scope, change);
  }

  private answer(scope: CommandScope, change: RevisionChange): CommandResult & Record<string, unknown> {
    return { ...commandResult(scope, change.status, change.version, change.id), project_id: change.projectId, revision: change.revision, project_version: change.projectVersion };
  }

  /** The audit row of the same transaction. The diff names the kind and what moved (the figures, not the words of the reason); the reason of a decision is the reason of the row. */
  private async record(scope: CommandScope, action: string, change: RevisionChange): Promise<void> {
    await scope.audit({
      action,
      resourceType: REVISION_RESOURCE,
      resourceId: change.id,
      classification: change.classification,
      ...(change.decisionReason === null ? {} : { reason: change.decisionReason }),
      diff: {
        project_id: change.projectId,
        code: change.projectCode,
        revision: change.revision,
        change_kind: change.kind,
        status: change.status,
        before: change.before,
        after: change.after,
        decision_document_id: change.decisionDocumentId,
        effective_from: change.effectiveFrom,
        superseded_revision_id: change.supersededRevisionId,
      },
    });
  }
}

/** The read of PRJ-06 and PRJ-04 (ST-PRJ-008): the history of the revisions of a project in the scope of `project.read`. */
@Controller()
export class ProjectRevisionReadsController {
  private readonly revisions = new PrjRevisionStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('projects/:id/revisions')
  @OperationId('listProjectRevisions')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const register = await this.database.withTenant(tenant, (tx) => this.revisions.list(tx, projectScope(access, READ_PERMISSION, now), id.toLowerCase()));
    return { items: register.lines.map(revisionLineView), current_total_investment_vnd: register.currentTotalVnd, as_of: vietnamDateOf(now) };
  }
}
