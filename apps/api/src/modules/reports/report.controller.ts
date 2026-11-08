import { Body, Controller, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { TenantDatabase, copyRefOf } from '@machvon/db';
import type { ReportDeliveryRow, ReportDraftRow, ReportIssueRow } from '@machvon/db';
import {
  DomainError,
  assertDeliveryTarget,
  assertLayoutIssuable,
  assertPeriodFitsForm,
  issueMarksOf,
  nextIssueOf,
  packageDigestOf,
  periodCode,
  vietnamDateOf,
} from '@machvon/kernel';
import type { EffectiveAccess, FormPeriod, ReportFileFormat, ReportFillData, SnapshotRevisionRef } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { reportFileName } from './file-name';
import { REPORT_FORMS } from './form-registry';
import { renderReport } from './render';
import { deliveryDtos, demoModeOf, reportStore } from './report-view';
import { REPORT_CLOCK } from './tokens';

const DRAFT_RESOURCE = 'report_draft';
const ISSUE_RESOURCE = 'report_issue';
const CLASSIFICATION = 'INTERNAL';
const CREATOR = 'MACHVON';
/** Reserved for the adapter of the group's system (ENT-2): a person cannot write that a push happened. */
const RESERVED_CHANNEL = 'HPM_PUSH';

const periodOf = (body: Schemas['RptPeriod']): FormPeriod => ({ kind: body.kind, year: body.year, ...(body.index === undefined ? {} : { index: body.index }), ...(body.day === undefined ? {} : { day: body.day }) });

/**
 * The commands of the report engine (RPT-1 part 2, eng-review R17 and R18). A report is generated for a form and a period into a draft; three different people check, approve and issue it; an issued copy never changes, a
 * correction is a new revision that names the one it replaces and says why; a copy is delivered to a receiver once, and a copy a later revision replaced is refused (REPORT_OUT_OF_DATE). A DEMO form can be generated and issued
 * only while demo forms are on, carries its mark in every file, and is never recorded as accepted. Every command is audited and announced in the outbox with ids, codes and hashes, never the words of a person.
 * A report is the document of the organisation: every command needs the permission over the whole tenant.
 */
@Controller()
export class ReportController {
  private readonly clock: () => Date;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(REPORT_CLOCK) clock?: () => Date,
  ) {
    this.clock = clock ?? ((): Date => new Date());
  }

  private assertWhole(access: EffectiveAccess, permission: string): void {
    if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
  }

  private async announceDraft(scope: CommandScope, row: ReportDraftRow, action: string, type: string, extra: Record<string, unknown> = {}): Promise<void> {
    await scope.audit({
      action,
      resourceType: DRAFT_RESOURCE,
      resourceId: row.id,
      classification: CLASSIFICATION,
      diff: { layout_code: row.layoutCode, layout_version: row.layoutVersion, period_code: row.periodCode, state: row.state, package_sha256: row.packageSha256, form_status: row.marks.formStatus, ...extra },
    });
    await scope.emit({
      aggregateType: DRAFT_RESOURCE,
      aggregateId: row.id,
      aggregateVersion: row.version,
      type,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, draft_id: row.id, layout_code: row.layoutCode, period_code: row.periodCode, state: row.state, package_sha256: row.packageSha256, actor_id: scope.tenant.membershipId, occurred_at: this.clock().toISOString() },
      eventKey: `${DRAFT_RESOURCE}:${row.id}:${row.version}`,
    });
  }

  /** A generation that made nothing new (the same bytes as the head, or as an open draft) is still a command with a trail: it says which one it found. */
  private async auditRepeat(scope: CommandScope, outcome: string, foundId: string, layoutCode: string, period: string, packageSha: string): Promise<void> {
    await scope.audit({ action: 'rpt.report_generate_repeated', resourceType: DRAFT_RESOURCE, resourceId: foundId, classification: CLASSIFICATION, diff: { outcome, layout_code: layoutCode, period_code: period, package_sha256: packageSha } });
  }

  @Post('report-engine/drafts')
  @HttpCode(200)
  @OperationId('generateReport')
  @Command({ operation: 'generateReport' })
  async generate(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['RptGenerate']): Promise<Schemas['RptGenerated']> {
    this.assertWhole(access, PERMISSIONS.generateReport);
    const bundle = REPORT_FORMS.get(body.layout_code);
    if (bundle === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'layout_code');
    const period = periodOf(body.period);
    assertPeriodFitsForm(bundle.periodKind, period);
    const { tx } = scope;
    const now = this.clock();
    const today = vietnamDateOf(now);
    const by = scope.tenant.membershipId;
    // A DEMO form is generated only while demo forms are on (TEMPLATE_UNCONFIRMED otherwise); the marks of the copy come from the form as it is today.
    const demoMode = await demoModeOf(tx, today, bundle.layout.status);
    const marks = issueMarksOf(bundle.layout, { demoMode });

    const templates = await bundle.templates();
    const registered = await reportStore.registerLayout(tx, { layout: bundle.layout, narrative: bundle.narrative, edition: bundle.edition, receiver: bundle.receiver, periodKind: bundle.periodKind, dataSource: bundle.dataSource, xlsx: templates.xlsx, docx: templates.docx }, by);
    const layout = registered.row;
    if (registered.created) {
      await scope.audit({
        action: 'rpt.layout_registered',
        resourceType: 'report_layout',
        resourceId: layout.id,
        classification: CLASSIFICATION,
        diff: { code: layout.code, version: layout.version, status: layout.status, edition: layout.edition, template_sha256: layout.templateSha256 },
      });
    }

    let data: ReportFillData;
    let snapshot: SnapshotRevisionRef | null = null;
    if (bundle.dataSource === 'ILLUSTRATIVE') {
      data = (bundle.illustrative as NonNullable<typeof bundle.illustrative>)(period);
    } else {
      const provider = REPORT_FORMS.provider(bundle.provider as string);
      if (provider === undefined) throw new DomainError('PROVIDER_UNAVAILABLE', 503, 'provider');
      if (provider.wholeTenant) this.assertWhole(access, PERMISSIONS.generateReport);
      const loaded = await provider.load({ database: this.database, tenant: scope.tenant, access, now, today, period, layout: layout.layout });
      data = loaded.data;
      snapshot = loaded.snapshot;
    }
    const xlsxTemplate = await reportStore.templateBytes(tx, layout.templateSha256);
    if (xlsxTemplate === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'template');
    const rendered = await renderReport({ layout: layout.layout, narrative: layout.narrative, xlsxTemplate, data, creator: CREATOR });

    const xlsxSha = await reportStore.putOutput(tx, 'XLSX', rendered.xlsx, by);
    const docxSha = rendered.docx === null ? null : await reportStore.putOutput(tx, 'DOCX', rendered.docx, by);
    const packageSha = packageDigestOf([{ format: 'XLSX', sha256: xlsxSha }, ...(docxSha === null ? [] : [{ format: 'DOCX' as ReportFileFormat, sha256: docxSha }])]);
    const code = periodCode(period);
    const series = await reportStore.series(tx, layout.code, code);
    const head = series[series.length - 1];
    // R17: the same bytes as the head are a repeat (nothing new is made); other bytes are the next revision and need a reason.
    const next = nextIssueOf(series.map(copyRefOf), packageSha, body.reason ?? null);
    if (next.outcome === 'DUPLICATE' && head !== undefined) {
      await this.auditRepeat(scope, 'DUPLICATE', head.id, layout.code, code, packageSha);
      return { outcome: 'DUPLICATE', draft_id: null, issue_id: head.id, revision: head.revision, package_sha256: packageSha, issue_count: rendered.issues.length };
    }
    const existing = await reportStore.openDraftWith(tx, layout.code, code, packageSha);
    if (existing !== undefined) {
      await this.auditRepeat(scope, 'EXISTING', existing.id, layout.code, code, packageSha);
      return { outcome: 'EXISTING', draft_id: existing.id, issue_id: null, revision: next.revision, package_sha256: packageSha, issue_count: existing.gridIssues.length };
    }
    const draft = await reportStore.insertDraft(tx, {
      layout,
      period,
      periodCode: code,
      baseRevision: head?.revision ?? 0,
      reason: head === undefined ? null : (body.reason ?? null),
      xlsxSha256: xlsxSha,
      docxSha256: docxSha,
      packageSha256: packageSha,
      dataSource: bundle.dataSource,
      snapshotRef: snapshot,
      marks,
      gridIssues: rendered.issues,
      preview: { columns: rendered.preview.columns, rows: rendered.preview.rows, row_count: rendered.preview.rowCount, truncated: rendered.preview.truncated, narrative: rendered.preview.narrative, stamp: rendered.preview.stamp },
      preparedBy: by,
    });
    await this.announceDraft(scope, draft, 'rpt.report_generated', 'rpt.report.generated.v1', { data_source: draft.dataSource, issue_count: rendered.issues.length, base_revision: draft.baseRevision, snapshot_id: snapshot?.snapshotId ?? null, snapshot_revision: snapshot?.revision ?? null });
    return { outcome: 'CREATED', draft_id: draft.id, issue_id: null, revision: next.revision, package_sha256: packageSha, issue_count: rendered.issues.length };
  }

  @Post('report-engine/drafts/:id/check')
  @HttpCode(200)
  @OperationId('checkReport')
  @Command({ operation: 'checkReport', versioned: true })
  async check(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    this.assertWhole(access, PERMISSIONS.checkReport);
    const done = await reportStore.step(scope.tx, id, scope.expectedVersion ?? 0, 'CHECK', scope.tenant.membershipId);
    await this.announceDraft(scope, done.row, 'rpt.report_checked', 'rpt.report.checked.v1');
    return commandResult(scope, done.row.state, done.row.version, id);
  }

  @Post('report-engine/drafts/:id/approve')
  @HttpCode(200)
  @OperationId('approveReport')
  @Command({ operation: 'approveReport', versioned: true })
  async approve(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    this.assertWhole(access, PERMISSIONS.approveReport);
    const done = await reportStore.step(scope.tx, id, scope.expectedVersion ?? 0, 'APPROVE', scope.tenant.membershipId);
    await this.announceDraft(scope, done.row, 'rpt.report_approved', 'rpt.report.approved.v1');
    return commandResult(scope, done.row.state, done.row.version, id);
  }

  @Post('report-engine/drafts/:id/issue')
  @HttpCode(200)
  @OperationId('issueReport')
  @Command({ operation: 'issueReport', versioned: true })
  async issue(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    this.assertWhole(access, PERMISSIONS.issueReport);
    const { tx } = scope;
    const draft = await reportStore.findDraft(tx, id);
    if (draft === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const layout = await reportStore.getLayout(tx, draft.layoutId);
    if (layout === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'layout');
    // Demo mode is judged again at the moment of issue: a form switched off since the draft was made is not issued (R18).
    assertLayoutIssuable(layout.layout, { demoMode: await demoModeOf(tx, vietnamDateOf(this.clock()), layout.status) });
    const issued = await reportStore.issue(
      tx,
      {
        draft,
        issuedBy: scope.tenant.membershipId,
        names: (revision) => ({
          xlsx: reportFileName({ code: draft.layoutCode, period: draft.period, revision, sha256: draft.xlsxSha256, extension: 'xlsx' }),
          docx: draft.docxSha256 === null ? null : reportFileName({ code: draft.layoutCode, period: draft.period, revision, sha256: draft.docxSha256, extension: 'docx' }),
        }),
      },
      scope.expectedVersion ?? 0,
    );
    // The same bytes are the head of the series already: the answer is that copy, and nothing new is written.
    if (issued.outcome === 'DUPLICATE') {
      await scope.audit({ action: 'rpt.report_issue_repeated', resourceType: ISSUE_RESOURCE, resourceId: issued.row.id, classification: CLASSIFICATION, diff: { draft_id: draft.id, revision: issued.row.revision, sha256: issued.row.sha256 } });
      return commandResult(scope, 'DUPLICATE', issued.row.revision, issued.row.id);
    }
    await this.announceIssue(scope, issued.row);
    return commandResult(scope, 'ISSUED', 1, issued.row.id);
  }

  private async announceIssue(scope: CommandScope, row: ReportIssueRow): Promise<void> {
    await scope.audit({
      action: 'rpt.report_issued',
      resourceType: ISSUE_RESOURCE,
      resourceId: row.id,
      classification: CLASSIFICATION,
      reason: row.reason ?? undefined,
      diff: {
        layout_code: row.layoutCode,
        layout_version: row.layoutVersion,
        period_code: row.periodCode,
        revision: row.revision,
        supersedes_id: row.supersedesId,
        sha256: row.sha256,
        xlsx_sha256: row.xlsxSha256,
        docx_sha256: row.docxSha256,
        form_status: row.formStatus,
        counts_as_accepted: row.countsAsAccepted,
        snapshot_id: row.snapshotRef?.snapshotId ?? null,
        snapshot_revision: row.snapshotRef?.revision ?? null,
      },
    });
    await scope.emit({
      aggregateType: ISSUE_RESOURCE,
      aggregateId: row.id,
      aggregateVersion: 1,
      type: 'rpt.report.issued.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        issue_id: row.id,
        layout_code: row.layoutCode,
        period_code: row.periodCode,
        revision: row.revision,
        supersedes_id: row.supersedesId,
        sha256: row.sha256,
        form_status: row.formStatus,
        counts_as_accepted: row.countsAsAccepted,
        snapshot_id: row.snapshotRef?.snapshotId ?? null,
        snapshot_revision: row.snapshotRef?.revision ?? null,
        actor_id: scope.tenant.membershipId,
        occurred_at: this.clock().toISOString(),
      },
      eventKey: `${ISSUE_RESOURCE}:${row.id}`,
    });
  }

  private async announceDelivery(scope: CommandScope, copy: ReportIssueRow, row: ReportDeliveryRow, action: string, type: string): Promise<void> {
    await scope.audit({
      action,
      resourceType: ISSUE_RESOURCE,
      resourceId: copy.id,
      classification: CLASSIFICATION,
      reason: row.note ?? undefined,
      diff: { delivery_id: row.id, receiver: row.receiver, channel: row.channel, event: row.event, revision: copy.revision, sha256: copy.sha256, counts_as_accepted: row.countsAsAccepted, reference: row.reference },
    });
    await scope.emit({
      aggregateType: ISSUE_RESOURCE,
      aggregateId: copy.id,
      aggregateVersion: 1,
      type,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, issue_id: copy.id, delivery_id: row.id, layout_code: copy.layoutCode, period_code: copy.periodCode, revision: copy.revision, sha256: copy.sha256, receiver: row.receiver, event: row.event, actor_id: scope.tenant.membershipId, occurred_at: this.clock().toISOString() },
      eventKey: `${ISSUE_RESOURCE}:${copy.id}:${row.receiver}:${row.event}`,
    });
  }

  @Post('report-engine/issues/:id/deliveries')
  @HttpCode(200)
  @OperationId('deliverReport')
  @Command({ operation: 'deliverReport' })
  async deliver(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['RptDeliver']): Promise<Schemas['RptDelivery']> {
    this.assertWhole(access, PERMISSIONS.deliverReport);
    assertDeliveryTarget(body.receiver, body.channel);
    if (body.channel === RESERVED_CHANNEL) throw new DomainError('VALIDATION_FAILED', 422, 'channel');
    const copy = await reportStore.findIssue(scope.tx, id);
    if (copy === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const row = await reportStore.deliver(scope.tx, copy, { receiver: body.receiver, channel: body.channel, reference: body.reference ?? null, note: body.note ?? null, by: scope.tenant.membershipId });
    await this.announceDelivery(scope, copy, row, 'rpt.report_delivered', 'rpt.report.delivered.v1');
    return (await deliveryDtos(scope, [row]))[0] as Schemas['RptDelivery'];
  }

  @Post('report-engine/issues/:id/answers')
  @HttpCode(200)
  @OperationId('answerReportDelivery')
  @Command({ operation: 'answerReportDelivery' })
  async answer(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['RptAnswer']): Promise<Schemas['RptDelivery']> {
    this.assertWhole(access, PERMISSIONS.answerReportDelivery);
    assertDeliveryTarget(body.receiver, 'MANUAL');
    if (body.outcome === 'REJECTED' && (body.note === undefined || body.note.trim().length < 10)) throw new DomainError('VALIDATION_FAILED', 422, 'note');
    const copy = await reportStore.findIssue(scope.tx, id);
    if (copy === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const row = await reportStore.answer(scope.tx, copy, body.outcome, { receiver: body.receiver, channel: 'MANUAL', reference: body.reference ?? null, note: body.note ?? null, by: scope.tenant.membershipId });
    await this.announceDelivery(scope, copy, row, 'rpt.report_answered', 'rpt.report.answered.v1');
    return (await deliveryDtos(scope, [row]))[0] as Schemas['RptDelivery'];
  }
}
