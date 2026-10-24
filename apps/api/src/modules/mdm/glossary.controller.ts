import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { GLOSSARY_STATUSES, GlossaryStore, TenantDatabase } from '@machvon/db';
import type { GlossaryStatus, GlossaryTermRow } from '@machvon/db';
import { DomainError, asUuid } from '@machvon/kernel';
import type { TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { textOf } from './inputs';

const RESOURCE_TYPE = 'glossary_term';
const GLOSSARY_STATUS_SET: ReadonlySet<string> = new Set(GLOSSARY_STATUSES);
const DECISION_ACTIONS = { approve: 'glossary.approved', reject: 'glossary.rejected', return: 'glossary.returned' } as const;

function viewOf(row: GlossaryTermRow): Record<string, unknown> {
  return {
    id: row.id,
    term_code: row.termCode,
    term_vi: row.termVi,
    definition: row.definition,
    formula_ref: row.formulaRef,
    domain: row.domain,
    owner_membership_id: row.ownerMembershipId,
    legal_basis: row.legalBasis,
    revision: row.revision,
    status: row.status,
    approved_by: row.approvedBy,
    effective_from: row.effectiveFrom,
    supersedes_id: row.supersedesId,
    created_by: row.createdBy,
    created_at: row.createdAt,
    decided_by: row.decidedBy,
    decided_at: row.decidedAt,
    decision_reason: row.decisionReason,
    published_by: row.publishedBy,
    published_at: row.publishedAt,
    version: row.version,
  };
}

/** The identifiers of a term that the contract writes as UUIDs, in their lower-case form; anything else is 422 naming the field. */
function uuidOf(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const id = asUuid(value);
  if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return id;
}

/**
 * The glossary of business terms and its approval workflow (ST-MDM-008, MDM 3.1 F6): a steward proposes a term, the owner of the domain
 * decides it (never its proposer) and publishes it; a published term is replaced by the next revision, never edited.
 */
@Controller()
export class GlossaryController {
  private readonly terms = new GlossaryStore();

  @Post('glossary-terms')
  @HttpCode(200)
  @OperationId('proposeGlossaryTerm')
  @Command({ operation: 'proposeGlossaryTerm' })
  async propose(@Scope() scope: CommandScope, @Body() body: Schemas['MdmGlossaryTerm']): Promise<CommandResult> {
    const owner = uuidOf(body.owner_membership_id, 'owner_membership_id') as string;
    const created = await this.terms.propose(
      scope.tx,
      {
        termCode: body.term_code,
        termVi: body.term_vi,
        definition: body.definition,
        formulaRef: body.formula_ref,
        domain: body.domain,
        ownerMembershipId: owner,
        legalBasis: body.legal_basis,
        supersedesId: uuidOf(body.supersedes_id, 'supersedes_id'),
      },
      scope.tenant.membershipId,
    );
    await scope.audit({
      action: 'glossary.proposed',
      resourceType: RESOURCE_TYPE,
      resourceId: created.id,
      diff: { term_code: body.term_code.trim(), revision: created.revision, domain: body.domain.trim(), owner_membership_id: owner },
    });
    return commandResult(scope, 'DRAFT', created.version, created.id);
  }

  @Post('glossary-terms/:id/submit')
  @HttpCode(200)
  @OperationId('submitGlossaryTerm')
  @Command({ operation: 'submitGlossaryTerm', versioned: true })
  async submit(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    const submitted = await this.terms.submit(scope.tx, id, scope.expectedVersion ?? 0, scope.tenant.membershipId);
    await scope.audit({
      action: 'glossary.submitted',
      resourceType: RESOURCE_TYPE,
      resourceId: id,
      diff: { term_code: submitted.row.termCode, revision: submitted.row.revision, domain: submitted.row.domain },
    });
    return commandResult(scope, 'IN_REVIEW', submitted.version, id);
  }

  @Post('glossary-terms/:id/decision')
  @HttpCode(200)
  @OperationId('decideGlossaryTerm')
  @Command({ operation: 'decideGlossaryTerm', versioned: true })
  async decide(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['MdmDecision']): Promise<CommandResult> {
    const decided = await this.terms.decide(scope.tx, id, scope.expectedVersion ?? 0, body.decision, body.reason, scope.tenant.membershipId);
    await scope.audit({
      action: DECISION_ACTIONS[body.decision],
      resourceType: RESOURCE_TYPE,
      resourceId: id,
      reason: body.reason,
      diff: { term_code: decided.row.termCode, revision: decided.row.revision, domain: decided.row.domain, decision: body.decision, status: decided.status },
    });
    return commandResult(scope, decided.status, decided.version, id);
  }

  @Post('glossary-terms/:id/publish')
  @HttpCode(200)
  @OperationId('publishGlossaryTerm')
  @Command({ operation: 'publishGlossaryTerm', versioned: true })
  async publish(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    const published = await this.terms.publish(scope.tx, id, scope.expectedVersion ?? 0, scope.tenant.membershipId);
    const { row } = published;
    await scope.audit({
      action: 'glossary.published',
      resourceType: RESOURCE_TYPE,
      resourceId: id,
      diff: { term_code: row.termCode, revision: row.revision, domain: row.domain, deprecated_id: published.deprecatedId },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: id,
      aggregateVersion: published.version,
      type: 'glossary.published.v1',
      schemaVersion: 1,
      payload: { term_code: row.termCode, revision: row.revision, domain: row.domain },
      // A revision is published once: the key names it, so the event of a later revision is never taken for this one.
      eventKey: `${RESOURCE_TYPE}:${id}:published`,
    });
    return commandResult(scope, 'PUBLISHED', published.version, id);
  }
}

/** The list of terms (for MDM-34): by domain, status and term code, the newest first. */
@Controller()
export class GlossaryReadsController {
  private readonly terms = new GlossaryStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('glossary-terms')
  @OperationId('listGlossaryTerms')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query('domain') domain?: unknown,
    @Query('status') status?: unknown,
    @Query('term_code') termCode?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    const request = parsePageRequest(limit, cursor);
    if (status !== undefined && (typeof status !== 'string' || !GLOSSARY_STATUS_SET.has(status))) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const rows = await this.database.withTenant(tenant, (tx) =>
      this.terms.list(
        tx,
        { domain: textOf(domain, 'domain'), status: status as GlossaryStatus | undefined, termCode: textOf(termCode, 'term_code') },
        { limit: request.limit + 1, after: request.after },
      ),
    );
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(viewOf),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAt, id: last.id }) : null,
    };
  }
}
