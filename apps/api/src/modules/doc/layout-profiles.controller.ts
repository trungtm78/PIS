import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DocumentLayoutProfileStore, TenantDatabase } from '@machvon/db';
import type { LayoutProfileDetail } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';

const RESOURCE_TYPE = 'document_layout_profile';
const STATUSES: ReadonlySet<string> = new Set(['DRAFT', 'PUBLISHED', 'SUPERSEDED']);
const REVISION_PART = /^[1-9][0-9]{0,8}$/;

/** Layout profiles belong to the whole tenant, like the template library (DOC 2): a grant on a branch of the organisation tree does not reach them. */
function assertWholeTenant(access: EffectiveAccess, permission: string): void {
  if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
}

function profileView(row: LayoutProfileDetail): Record<string, unknown> {
  return {
    id: row.id,
    profile_code: row.profileCode,
    revision: row.revision,
    page_size: row.pageSize,
    margins_mm: row.marginsMm,
    font_family: row.fontFamily,
    font_substitute: row.fontSubstitute,
    element_styles: row.elementStyles,
    signature_layout: row.signatureLayout,
    number_field_layout: row.numberFieldLayout,
    watermark_policy: row.watermarkPolicy,
    legal_basis: row.legalBasis,
    legal_confirmation_ref: row.legalConfirmationRef,
    confirmation_status: row.confirmationStatus,
    effective_from: row.effectiveFrom,
    effective_until: row.effectiveUntil,
    status: row.status,
    created_by: row.createdBy,
    approved_by: row.approvedBy,
    version: row.version,
  };
}

function pageAnchor(cursor: ReturnType<typeof parsePageRequest>['after']): { profileCode: string; revision: number } | undefined {
  if (cursor === undefined) return undefined;
  const cut = cursor.code.lastIndexOf('|');
  const revision = cursor.code.slice(cut + 1);
  if (cut <= 0 || !REVISION_PART.test(revision)) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
  return { profileCode: cursor.code.slice(0, cut), revision: Number(revision) };
}

/**
 * The layout profiles (ST-DOC-016, DOC F12, BR-DOC-13, DOC-16): the formatting of Appendix I of Decree 30/2020 as data. A revision is drafted with every value inside its legal range and published by someone else; the
 * render reads the revision in force on its date, so a command here is seen by the next render. The legal confirmation of a profile (CXN-DOC-01) is not a command here.
 */
@Controller()
export class LayoutProfilesController {
  private readonly profiles = new DocumentLayoutProfileStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Post('document-layout-profiles')
  @HttpCode(200)
  @OperationId('createDocumentLayoutProfileRevision')
  @Command({ operation: 'createDocumentLayoutProfileRevision' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['DocLayoutProfileRevision']): Promise<CommandResult & { revision: number }> {
    assertWholeTenant(access, PERMISSIONS.createDocumentLayoutProfileRevision);
    const created = await this.profiles.create(scope.tx, {
      profileCode: body.profile_code,
      margins_mm: body.margins_mm,
      font_family: body.font_family,
      font_substitute: body.font_substitute,
      element_styles: body.element_styles,
      signature_layout: body.signature_layout,
      number_field_layout: body.number_field_layout,
      watermark_policy: body.watermark_policy,
      legalBasis: body.legal_basis,
      legalConfirmationRef: body.legal_confirmation_ref,
      effectiveFrom: body.effective_from,
      effectiveUntil: body.effective_until,
      actor: scope.tenant.membershipId,
    });
    await scope.audit({
      action: 'document_layout_profile.draft',
      resourceType: RESOURCE_TYPE,
      resourceId: created.id,
      diff: { profile_code: created.profileCode, revision: created.revision, effective_from: created.effectiveFrom, effective_until: created.effectiveUntil, margins_mm: created.marginsMm },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: 'doc.layout_drafted.v1',
      schemaVersion: 1,
      payload: { layout_profile_id: created.id, profile_code: created.profileCode, revision: created.revision },
      eventKey: `${RESOURCE_TYPE}:${created.id}:${created.version}`,
    });
    return { ...commandResult(scope, 'DRAFT', created.version, created.id), revision: created.revision };
  }

  @Post('document-layout-profiles/:id/publish')
  @HttpCode(200)
  @OperationId('publishDocumentLayoutProfile')
  @Command({ operation: 'publishDocumentLayoutProfile', versioned: true })
  async publish(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    assertWholeTenant(access, PERMISSIONS.publishDocumentLayoutProfile);
    const { record, closed } = await this.profiles.publish(scope.tx, id, scope.expectedVersion ?? 0, scope.tenant.membershipId);
    const closedRevisions = closed.map((revision) => ({ layout_profile_id: revision.id, revision: revision.revision, effective_until: revision.effectiveUntil }));
    await scope.audit({
      action: 'document_layout_profile.publish',
      resourceType: RESOURCE_TYPE,
      resourceId: id,
      diff: { profile_code: record.profileCode, revision: record.revision, effective_from: record.effectiveFrom, effective_until: record.effectiveUntil, closed_revisions: closedRevisions },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: id,
      aggregateVersion: record.version,
      type: 'doc.layout_published.v1',
      schemaVersion: 1,
      payload: { layout_profile_id: id, profile_code: record.profileCode, revision: record.revision, effective_from: record.effectiveFrom, effective_until: record.effectiveUntil, confirmation_status: record.confirmationStatus },
      eventKey: `${RESOURCE_TYPE}:${id}:${record.version}`,
    });
    return commandResult(scope, 'PUBLISHED', record.version, id);
  }

  @Get('document-layout-profiles')
  @OperationId('listDocumentLayoutProfiles')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query('profile_code') profileCode?: unknown,
    @Query('status') status?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    const request = parsePageRequest(limit, cursor);
    if (profileCode !== undefined && typeof profileCode !== 'string') throw new DomainError('VALIDATION_FAILED', 422, 'profile_code');
    if (status !== undefined && (typeof status !== 'string' || !STATUSES.has(status))) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const after = pageAnchor(request.after);
    const rows = await this.database.withTenant(tenant, (tx) => this.profiles.list(tx, { profileCode, status, limit: request.limit + 1, after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(profileView),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: `${last.profileCode}|${last.revision}`, id: last.id }) : null,
    };
  }

  @Get('document-layout-profiles/:id')
  @OperationId('getDocumentLayoutProfile')
  async get(@CurrentTenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    return this.database.withTenant(tenant, async (tx) => {
      const row = await this.profiles.find(tx, id);
      if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      return profileView(row);
    });
  }
}
