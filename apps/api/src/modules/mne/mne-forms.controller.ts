import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { MNE_REPORT_KINDS, MneFormStore, TenantDatabase } from '@machvon/db';
import type { MneFormRow } from '@machvon/db';
import { DomainError, isIsoDate } from '@machvon/kernel';
import type { TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { formViewOf } from './mne-views';

const RESOURCE_TYPE = 'mne_report_form';
const REPORT_KINDS: ReadonlySet<string> = new Set(MNE_REPORT_KINDS);
const REVISION_PART = /^[1-9][0-9]{0,8}$/;

function dateFilter(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !isIsoDate(value)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
}

function kindFilter(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !REPORT_KINDS.has(value)) throw new DomainError('VALIDATION_FAILED', 422, 'report_kind');
  return value;
}

/** The cursor of a page carries `<form_code>|<revision>`: the ordering key of the last form revision on it. */
function pageAnchor(cursor: ReturnType<typeof parsePageRequest>['after']): { formCode: string; revision: number } | undefined {
  if (cursor === undefined) return undefined;
  const cut = cursor.code.lastIndexOf('|');
  const revision = cursor.code.slice(cut + 1);
  if (cut <= 0 || !REVISION_PART.test(revision)) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
  return { formCode: cursor.code.slice(0, cut), revision: Number(revision) };
}

const diffOf = (row: MneFormRow): Record<string, unknown> => ({
  form_code: row.formCode,
  revision: row.revision,
  report_kind: row.reportKind,
  effective_from: row.effectiveFrom,
  effective_until: row.effectiveUntil,
  doc_template_code: row.docTemplateCode,
  legal_confirmation_ref: row.legalConfirmationRef,
});

/**
 * The report forms of the monitoring module (ST-MNE-001, MNE F1, BR-MNE-01): each revision is data with a legal basis and an effective
 * period, drafted under `mne.form.manage` and published by someone else under `mne.form.approve`. A report is made with the revision
 * in force on the last day of its period, so a command here changes the reports made after it and none that exist (BR-MNE-02).
 */
@Controller()
export class MneFormsController {
  private readonly forms = new MneFormStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Post('mne-forms')
  @HttpCode(200)
  @OperationId('createMneFormVersion')
  @Command({ operation: 'createMneFormVersion' })
  async create(@Scope() scope: CommandScope, @Body() body: Schemas['MneFormVersion']): Promise<CommandResult & { revision: number }> {
    const created = await this.forms.create(
      scope.tx,
      {
        formCode: body.form_code,
        title: body.title,
        reportKind: body.report_kind,
        legalBasis: body.legal_basis,
        legalConfirmationRef: body.legal_confirmation_ref,
        effectiveFrom: body.effective_from,
        effectiveUntil: body.effective_until,
        schemaJson: body.schema_json,
        docTemplateCode: body.doc_template_code,
        exportFormats: body.export_formats,
      },
      scope.tenant.membershipId,
    );
    await scope.audit({ action: 'mne.form_drafted', resourceType: RESOURCE_TYPE, resourceId: created.id, diff: diffOf(created) });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: 'mne.form.drafted.v1',
      schemaVersion: 1,
      payload: { form_id: created.id, form_code: created.formCode, revision: created.revision, report_kind: created.reportKind },
      eventKey: `${RESOURCE_TYPE}:${created.id}:${created.version}`,
    });
    return { ...commandResult(scope, 'DRAFT', created.version, created.id), revision: created.revision };
  }

  @Post('mne-forms/:id/publish')
  @HttpCode(200)
  @OperationId('publishMneForm')
  @Command({ operation: 'publishMneForm', versioned: true })
  async publish(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    const { record, closed } = await this.forms.publish(scope.tx, id, scope.expectedVersion ?? 0, scope.tenant.membershipId);
    const closedRevisions = closed.map((revision) => ({ form_id: revision.id, revision: revision.revision, effective_until: revision.effectiveUntil }));
    await scope.audit({ action: 'mne.form_published', resourceType: RESOURCE_TYPE, resourceId: id, diff: { ...diffOf(record), closed_revisions: closedRevisions } });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: id,
      aggregateVersion: record.version,
      type: 'mne.form.published.v1',
      schemaVersion: 1,
      payload: { form_id: id, form_code: record.formCode, revision: record.revision, effective_from: record.effectiveFrom, awaiting_confirmation: record.legalConfirmationRef === null, closed_revisions: closedRevisions },
      eventKey: `${RESOURCE_TYPE}:${id}:${record.version}`,
    });
    return commandResult(scope, 'PUBLISHED', record.version, id);
  }

  @Get('mne-forms')
  @OperationId('listMneForms')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query('effective_on') effectiveOn?: unknown,
    @Query('report_kind') reportKind?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    const request = parsePageRequest(limit, cursor);
    const filter = { effectiveOn: dateFilter(effectiveOn, 'effective_on'), reportKind: kindFilter(reportKind) };
    const after = pageAnchor(request.after);
    const rows = await this.database.withTenant(tenant, (tx) => this.forms.list(tx, filter, { limit: request.limit + 1, after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(formViewOf),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: `${last.formCode}|${last.revision}`, id: last.id }) : null,
    };
  }
}
