import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { TenantDatabase } from '@machvon/db';
import type { ReportIssueFilter } from '@machvon/db';
import { DomainError, ISSUE_STATES, REPORT_FILE_FORMATS, assertIntegrity, effectivePermissions, holdsPermission, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, IssueState, ReportFileFormat, TenantContext } from '@machvon/kernel';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { sha256Hex } from './digest';
import { reportFileName } from './file-name';
import { REPORT_FORMS } from './form-registry';
import { catalogueEntryDto, deliveryDtos, demoModeOf, draftDtos, issueDtos, reportStore } from './report-view';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** A query value that is one non-empty string or absent. */
function text(value: unknown, field: string, max = 100): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '' || value.length > max) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
}

function limitOf(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  const parsed = typeof value === 'string' && /^\d{1,4}$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) throw new DomainError('VALIDATION_FAILED', 422, 'limit');
  return parsed;
}

function flagOf(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value !== 'true' && value !== 'false') throw new DomainError('VALIDATION_FAILED', 422, field);
  return value === 'true';
}

const formatOf = (value: string): ReportFileFormat => {
  if (!(REPORT_FILE_FORMATS as readonly string[]).includes(value)) throw new DomainError('VALIDATION_FAILED', 422, 'format');
  return value as ReportFileFormat;
};

/**
 * The reads of the report engine (RPT-1 part 2): the catalogue of the forms this process offers, the drafts on their way to issue with the preview of every cell, the issued copies with their hashes and chains of revisions,
 * their files, and the delivery log. A report is the document of the organisation, so every read needs the permission over the whole tenant. Reading a file of an issued copy checks the bytes against the recorded hash
 * before it answers (HASH_MISMATCH otherwise): a copy whose bytes changed is never handed out as the copy that was issued.
 */
@Controller()
export class ReportReadsController {
  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  private assertWhole(access: EffectiveAccess, permission: string): void {
    if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
  }

  @Get('report-engine/catalogue')
  @OperationId('listReportCatalogue')
  async catalogue(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Schemas['RptCatalogue']> {
    this.assertWhole(access, PERMISSIONS.listReportCatalogue);
    const now = new Date();
    const held = effectivePermissions(access, now);
    return this.database.withTenant(tenant, async (tx) => {
      const demoMode = await demoModeOf(tx, vietnamDateOf(now), 'ANY');
      const registered = new Map((await reportStore.listLayouts(tx)).map((row) => [row.code, row]));
      return {
        items: REPORT_FORMS.list().map((bundle) => catalogueEntryDto(bundle, registered.get(bundle.layout.code), demoMode)),
        demo_mode: demoMode,
        as_of: now.toISOString(),
        can_generate: holdsPermission(held, PERMISSIONS.generateReport),
      };
    });
  }

  @Get('report-engine/drafts')
  @OperationId('listReportDrafts')
  async drafts(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Schemas['RptDraftPage']> {
    this.assertWhole(access, PERMISSIONS.listReportDrafts);
    const now = new Date();
    const state = text(query.state, 'state', 20);
    if (state !== undefined && !(ISSUE_STATES as readonly string[]).includes(state)) throw new DomainError('VALIDATION_FAILED', 422, 'state');
    const limit = limitOf(query.limit);
    return this.database.withTenant(tenant, async (tx) => {
      const rows = await reportStore.listDrafts(tx, { layoutCode: text(query.layout_code, 'layout_code', 40), state: state as IssueState | undefined, limit: limit + 1 });
      const items = await draftDtos({ tx, access, membershipId: tenant.membershipId, now, today: vietnamDateOf(now) }, rows.slice(0, limit), false);
      return { items, truncated: rows.length > limit, as_of: now.toISOString() };
    });
  }

  @Get('report-engine/drafts/:id')
  @OperationId('getReportDraft')
  async draft(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Schemas['RptDraft']> {
    this.assertWhole(access, PERMISSIONS.getReportDraft);
    const now = new Date();
    return this.database.withTenant(tenant, async (tx) => {
      const row = await reportStore.findDraft(tx, id);
      if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const [dto] = await draftDtos({ tx, access, membershipId: tenant.membershipId, now, today: vietnamDateOf(now) }, [row], true);
      return dto as Schemas['RptDraft'];
    });
  }

  @Get('report-engine/drafts/:id/files/:format')
  @OperationId('getReportDraftFile')
  async draftFile(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('format') formatText: string,
  ): Promise<Schemas['RptFileContent']> {
    this.assertWhole(access, PERMISSIONS.getReportDraftFile);
    return this.database.withTenant(tenant, async (tx) => {
      const draft = await reportStore.findDraft(tx, id);
      if (draft === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const format = formatOf(formatText);
      const sha = format === 'XLSX' ? draft.xlsxSha256 : draft.docxSha256;
      if (sha === null) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'format');
      const stored = await reportStore.outputBytes(tx, sha);
      if (stored === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'file');
      assertIntegrity({ sha256: sha }, sha256Hex(stored.bytes));
      const name = reportFileName({ code: draft.layoutCode, period: draft.period, revision: draft.baseRevision + 1, sha256: sha, extension: format === 'XLSX' ? 'xlsx' : 'docx' });
      return { format, sha256: sha, name, size_bytes: stored.bytes.length, content_base64: Buffer.from(stored.bytes).toString('base64') };
    });
  }

  @Get('report-engine/issues')
  @OperationId('listReportIssues')
  async issues(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Schemas['RptIssuePage']> {
    this.assertWhole(access, PERMISSIONS.listReportIssues);
    const now = new Date();
    const limit = limitOf(query.limit);
    const filter: ReportIssueFilter = {
      layoutCode: text(query.layout_code, 'layout_code', 40),
      periodCode: text(query.period_code, 'period_code', 20),
      demo: flagOf(query.demo, 'demo'),
      headsOnly: flagOf(query.heads_only, 'heads_only'),
      limit: limit + 1,
    };
    return this.database.withTenant(tenant, async (tx) => {
      const rows = await reportStore.listIssues(tx, filter);
      const items = await issueDtos({ tx, access, membershipId: tenant.membershipId, now, today: vietnamDateOf(now) }, rows.slice(0, limit), false);
      return { items, truncated: rows.length > limit, as_of: now.toISOString() };
    });
  }

  @Get('report-engine/issues/:id')
  @OperationId('getReportIssue')
  async issue(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Schemas['RptIssue']> {
    this.assertWhole(access, PERMISSIONS.getReportIssue);
    const now = new Date();
    return this.database.withTenant(tenant, async (tx) => {
      const row = await reportStore.findIssue(tx, id);
      if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const [dto] = await issueDtos({ tx, access, membershipId: tenant.membershipId, now, today: vietnamDateOf(now) }, [row], true);
      return dto as Schemas['RptIssue'];
    });
  }

  @Get('report-engine/issues/:id/files/:format')
  @OperationId('getReportIssueFile')
  async issueFile(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('format') formatText: string,
  ): Promise<Schemas['RptFileContent']> {
    this.assertWhole(access, PERMISSIONS.getReportIssueFile);
    return this.database.withTenant(tenant, async (tx) => {
      const copy = await reportStore.findIssue(tx, id);
      if (copy === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const format = formatOf(formatText);
      const sha = format === 'XLSX' ? copy.xlsxSha256 : copy.docxSha256;
      const name = format === 'XLSX' ? copy.xlsxName : copy.docxName;
      if (sha === null || name === null) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'format');
      const stored = await reportStore.outputBytes(tx, sha);
      if (stored === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'file');
      assertIntegrity({ sha256: sha }, sha256Hex(stored.bytes));
      return { format, sha256: sha, name, size_bytes: stored.bytes.length, content_base64: Buffer.from(stored.bytes).toString('base64') };
    });
  }

  @Get('report-engine/deliveries')
  @OperationId('listReportDeliveries')
  async deliveries(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Schemas['RptDeliveryPage']> {
    this.assertWhole(access, PERMISSIONS.listReportDeliveries);
    const now = new Date();
    const limit = limitOf(query.limit);
    return this.database.withTenant(tenant, async (tx) => {
      const rows = await reportStore.listDeliveries(tx, { layoutCode: text(query.layout_code, 'layout_code', 40), receiver: text(query.receiver, 'receiver', 60), limit: limit + 1 });
      return { items: await deliveryDtos({ tx }, rows.slice(0, limit)), truncated: rows.length > limit, as_of: now.toISOString() };
    });
  }
}
