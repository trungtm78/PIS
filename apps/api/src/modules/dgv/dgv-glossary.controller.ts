import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { DgvGlossaryStore, GLOSSARY_BINDING_RESOURCE, TenantDatabase } from '@machvon/db';
import type { GlossaryBindingLine } from '@machvon/db';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { uuidOf, viewerOf } from './inputs';

const BOUND_EVENT = 'dgv.glossary.bound.v1';

/** The binding as the contract exposes it: an allowlist. */
export function bindingView(line: GlossaryBindingLine): Record<string, unknown> {
  return {
    id: line.id,
    column_name: line.columnName,
    term: { id: line.term.id, term_code: line.term.termCode, term_vi: line.term.termVi, definition: line.term.definition, revision: line.term.revision, status: line.term.status },
    bound_by: { membership_id: line.boundBy.membershipId, display_name: line.boundBy.displayName },
    bound_at: line.boundAt,
    deprecated: line.deprecated,
    successor: line.successor === null ? null : { id: line.successor.id, revision: line.successor.revision },
    replaced: line.replaced,
  };
}

/**
 * The glossary bound to the datasets (ST-DGV-007, DGV 3.1, DGV-02): a PUBLISHED term of MDM is bound to a dataset or one of its columns (422 `GLOSSARY_TERM_NOT_PUBLISHED` otherwise), DGV holds no table of terms, and the
 * read says which bindings have gone out of date (the revision bound was deprecated) and offers the revision in force.
 */
@Controller()
export class DgvGlossaryController {
  private readonly glossary = new DgvGlossaryStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Post('dgv/datasets/:id/glossary-bindings')
  @HttpCode(200)
  @OperationId('bindGlossaryTermToDataset')
  @Command({ operation: 'bindGlossaryTermToDataset' })
  async bind(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DgvGlossaryBind']): Promise<CommandResult & Record<string, unknown>> {
    const bound = await this.glossary.bind(scope.tx, {
      datasetId: id.toLowerCase(),
      viewer: viewerOf(scope.tenant, access),
      termId: uuidOf(body.glossary_term_id, 'glossary_term_id'),
      columnName: body.column_name,
      actor: scope.tenant.membershipId,
    });
    await scope.audit({
      action: 'dgv.glossary_bound',
      resourceType: GLOSSARY_BINDING_RESOURCE,
      resourceId: bound.bindingId,
      classification: 'INTERNAL',
      diff: { dataset_id: bound.datasetId, dataset_code: bound.datasetCode, column_name: bound.columnName, glossary_term_id: bound.termId, term_code: bound.termCode, revision: bound.revision, existing: bound.existing },
    });
    // Binding what is already bound changes nothing, so it announces nothing.
    if (!bound.existing) {
      await scope.emit({
        aggregateType: GLOSSARY_BINDING_RESOURCE,
        aggregateId: bound.bindingId,
        aggregateVersion: 1,
        type: BOUND_EVENT,
        schemaVersion: 1,
        payload: { dataset_id: bound.datasetId, binding_id: bound.bindingId, column_name: bound.columnName, glossary_term_id: bound.termId, term_code: bound.termCode, revision: bound.revision },
        eventKey: `${GLOSSARY_BINDING_RESOURCE}:${bound.bindingId}`,
      });
    }
    return { ...commandResult(scope, 'BOUND', 1, bound.bindingId), existing: bound.existing };
  }

  @Get('dgv/datasets/:id/glossary-bindings')
  @OperationId('listDatasetGlossaryBindings')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const found = await this.database.withTenant(tenant, (tx) => this.glossary.list(tx, id.toLowerCase(), viewerOf(tenant, access)));
    return { items: found.lines.map(bindingView), coverage: found.coverage };
  }
}
