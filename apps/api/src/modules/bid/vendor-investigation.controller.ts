import { Body, Controller, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { VendorLeadStore, VendorScreeningStore, VendorTraceStore } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess, FieldCipher, LeadMove } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { VENDOR_CIPHER } from './tokens';
import { todayOf } from './vendor-investigation-view';

interface Announcement {
  action: string;
  resourceType: string;
  resourceId: string;
  version: number;
  eventType: string;
  reason?: string | undefined;
  diff: Record<string, unknown>;
}

/** Writes the audit row (ADM-11, CONFIDENTIAL) and the outbox event of a command; the payload carries ids and codes only, never the words of a person and never a key. */
async function announce(scope: CommandScope, now: Date, item: Announcement): Promise<void> {
  await scope.audit({ action: item.action, resourceType: item.resourceType, resourceId: item.resourceId, classification: 'CONFIDENTIAL', ...(item.reason === undefined ? {} : { reason: item.reason }), diff: item.diff });
  await scope.emit({
    aggregateType: item.resourceType,
    aggregateId: item.resourceId,
    aggregateVersion: item.version,
    type: item.eventType,
    schemaVersion: 1,
    payload: { tenant_id: scope.tenant.tenantId, resource_id: item.resourceId, version: item.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), action: item.action, ...item.diff },
    eventKey: `${item.resourceType}:${item.resourceId}:${item.version}:${item.action}`,
  });
}

const only = (value: string | undefined): string | undefined => (value === undefined || value === '' ? undefined : value);

/**
 * The commands of the investigation and the screening of contractors (VND-13 to VND-15, docs/vendor-investigation.md). Each runs in one transaction with its audit row and its outbox event, judged by the kernel rules and the
 * governance rules (no threshold lives here). The register belongs to the whole tenant, so every command needs its permission through a grant on the whole tenant. A lead is a signal for the auditors: a person who took part in
 * the packages it is about gets 404, a dismissal takes two auditors, and the screening never bans by itself (a confirmed hit on the national list opens the debarment case of VND-1).
 */
@Controller()
export class VendorInvestigationController {
  private readonly leads = new VendorLeadStore();
  private readonly screening = new VendorScreeningStore();
  private readonly traces: VendorTraceStore;

  constructor(@Inject(VENDOR_CIPHER) cipher: FieldCipher) {
    this.traces = new VendorTraceStore(cipher);
  }

  private require(access: EffectiveAccess, permission: string): void {
    if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
  }

  private async leadMove(scope: CommandScope, id: string, move: LeadMove, action: string, reason: string | undefined): Promise<CommandResult> {
    const now = new Date();
    const row = await this.leads.move(scope.tx, scope.tenant.membershipId, id, scope.expectedVersion ?? 0, move, reason, now);
    await announce(scope, now, { action, resourceType: 'vendor_investigation_lead', resourceId: id, version: row.version, eventType: 'vnd.lead.changed.v1', ...(reason === undefined ? {} : { reason }), diff: { lead_id: id, kind: row.kind, move, status: row.status, rank: row.rank } });
    return commandResult(scope, row.status, row.version, id);
  }

  // -- the scan and the review of leads ---------------------------------------------------------------------------------------------------------------------------------------------------

  @Post('vendor/link-scans')
  @HttpCode(200)
  @OperationId('runVendorLinkScan')
  @Command({ operation: 'runVendorLinkScan' })
  async scan(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['VendorLinkScanRequest']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.runVendorLinkScan);
    const now = new Date();
    const result = await this.leads.scan(scope.tx, scope.tenant.membershipId, 'MANUAL', now, todayOf(now), only(body.note));
    await announce(scope, now, {
      action: 'vnd.lead_scanned',
      resourceType: 'vendor_link_scan',
      resourceId: result.scanId,
      version: 1,
      eventType: 'vnd.lead.scanned.v1',
      diff: { scan_id: result.scanId, parties: result.parties, links: result.links, clusters: result.clusters, packages: result.packages, leads_new: result.leadsNew, leads_reopened: result.leadsReopened, leads_updated: result.leadsUpdated, policy_versions: result.policyVersions },
    });
    return commandResult(scope, 'SCANNED', 1, result.scanId);
  }

  @Post('vendor/leads/:id/take')
  @HttpCode(200)
  @OperationId('takeVendorLead')
  @Command({ operation: 'takeVendorLead', versioned: true })
  take(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    this.require(access, PERMISSIONS.takeVendorLead);
    return this.leadMove(scope, id, 'TAKE', 'vnd.lead_taken', undefined);
  }

  @Post('vendor/leads/:id/propose-dismissal')
  @HttpCode(200)
  @OperationId('proposeVendorLeadDismissal')
  @Command({ operation: 'proposeVendorLeadDismissal', versioned: true })
  propose(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorLeadReason']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.proposeVendorLeadDismissal);
    return this.leadMove(scope, id, 'PROPOSE_DISMISS', 'vnd.lead_dismissal_proposed', body.reason);
  }

  @Post('vendor/leads/:id/confirm-dismissal')
  @HttpCode(200)
  @OperationId('confirmVendorLeadDismissal')
  @Command({ operation: 'confirmVendorLeadDismissal', versioned: true })
  confirmDismissal(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    this.require(access, PERMISSIONS.confirmVendorLeadDismissal);
    return this.leadMove(scope, id, 'CONFIRM_DISMISS', 'vnd.lead_dismissal_confirmed', undefined);
  }

  @Post('vendor/leads/:id/reject-dismissal')
  @HttpCode(200)
  @OperationId('rejectVendorLeadDismissal')
  @Command({ operation: 'rejectVendorLeadDismissal', versioned: true })
  rejectDismissal(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorLeadReason']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.rejectVendorLeadDismissal);
    return this.leadMove(scope, id, 'REJECT_DISMISS', 'vnd.lead_dismissal_rejected', body.reason);
  }

  @Post('vendor/leads/:id/confirm-signal')
  @HttpCode(200)
  @OperationId('confirmVendorLeadSignal')
  @Command({ operation: 'confirmVendorLeadSignal', versioned: true })
  confirmSignal(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorLeadReason']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.confirmVendorLeadSignal);
    return this.leadMove(scope, id, 'CONFIRM_SIGNAL', 'vnd.lead_signal_confirmed', body.reason);
  }

  @Post('vendor/leads/:id/referral')
  @HttpCode(200)
  @OperationId('referVendorLead')
  @Command({ operation: 'referVendorLead', versioned: true })
  refer(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorLeadReason']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.referVendorLead);
    return this.leadMove(scope, id, 'REFER', 'vnd.lead_referred', body.reason);
  }

  // -- the trace of a submission -----------------------------------------------------------------------------------------------------------------------------------------------------------

  @Post('vendor/proposals/:id/submission-trace')
  @HttpCode(200)
  @OperationId('recordProposalSubmissionTrace')
  @Command({ operation: 'recordProposalSubmissionTrace' })
  async trace(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorSubmissionTraceNew']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.recordProposalSubmissionTrace);
    const now = new Date();
    const row = await this.traces.record(
      scope.tx,
      scope.tenant.tenantId,
      id,
      {
        origin: only(body.origin),
        device: only(body.device),
        agent: only(body.agent),
        submittedAt: only(body.submitted_at),
        files: (body.files ?? []).map((file) => ({ documentVersionId: file.document_version_id, author: only(file.author), producer: only(file.producer), createdStamp: only(file.created_stamp) })),
      },
      scope.tenant.membershipId,
    );
    await announce(scope, now, { action: 'vnd.submission_trace_recorded', resourceType: 'proposal_submission_trace', resourceId: row.id, version: 1, eventType: 'vnd.trace.recorded.v1', diff: { proposal_id: id, package_id: row.packageId, contractor_id: row.contractorId, files: row.files } });
    return commandResult(scope, 'RECORDED', 1, row.id);
  }

  // -- the screening -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  @Post('vendor/screening/runs')
  @HttpCode(200)
  @OperationId('runVendorScreening')
  @Command({ operation: 'runVendorScreening' })
  async runScreening(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess): Promise<CommandResult> {
    this.require(access, PERMISSIONS.runVendorScreening);
    const now = new Date();
    const result = await this.screening.run(scope.tx, scope.tenant.membershipId, 'MANUAL', now, todayOf(now));
    await announce(scope, now, {
      action: 'vnd.screening_run',
      resourceType: 'screening_run',
      resourceId: result.runId,
      version: 1,
      eventType: 'vnd.screening.run.v1',
      diff: { run_id: result.runId, contractors: result.contractors, entries: result.entries, hits_new: result.hitsNew, hits_reopened: result.hitsReopened, hits_resolved: result.hitsResolved, holds: result.holds },
    });
    return commandResult(scope, 'FINISHED', 1, result.runId);
  }

  @Post('vendor/screening/hits/:id/confirm')
  @HttpCode(200)
  @OperationId('confirmVendorScreeningHit')
  @Command({ operation: 'confirmVendorScreeningHit', versioned: true })
  async confirmHit(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorScreeningConfirm']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.confirmVendorScreeningHit);
    const now = new Date();
    const row = await this.screening.confirm(scope.tx, id, scope.expectedVersion ?? 0, { violationGroups: body.violation_groups, violationSummary: only(body.violation_summary), note: only(body.note) }, scope.tenant.membershipId, now);
    await announce(scope, now, { action: 'vnd.screening_hit_confirmed', resourceType: 'screening_hit', resourceId: id, version: row.version, eventType: 'vnd.screening.hit.changed.v1', diff: { hit_id: id, contractor_id: row.contractorId, source: row.source, status: row.status, score: row.score, case_id: row.caseId } });
    return commandResult(scope, row.status, row.version, id);
  }

  @Post('vendor/screening/hits/:id/dismiss')
  @HttpCode(200)
  @OperationId('dismissVendorScreeningHit')
  @Command({ operation: 'dismissVendorScreeningHit', versioned: true })
  async dismissHit(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorScreeningDismiss']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.dismissVendorScreeningHit);
    const now = new Date();
    const row = await this.screening.dismiss(scope.tx, id, scope.expectedVersion ?? 0, body.reason, scope.tenant.membershipId, now);
    await announce(scope, now, { action: 'vnd.screening_hit_dismissed', resourceType: 'screening_hit', resourceId: id, version: row.version, eventType: 'vnd.screening.hit.changed.v1', reason: body.reason, diff: { hit_id: id, contractor_id: row.contractorId, source: row.source, status: row.status, score: row.score } });
    return commandResult(scope, row.status, row.version, id);
  }

  @Post('vendor/screening/list-imports')
  @HttpCode(200)
  @OperationId('importVendorScreeningList')
  @Command({ operation: 'importVendorScreeningList' })
  async importList(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['VendorScreeningImportRequest']): Promise<CommandResult> {
    this.require(access, PERMISSIONS.importVendorScreeningList);
    const now = new Date();
    const imported = await this.screening.importList(
      scope.tx,
      { source: body.source, asOf: body.as_of, reference: body.reference, entries: body.entries.map((entry) => ({ ref: entry.ref, name: only(entry.name), taxCode: only(entry.tax_code), validFrom: only(entry.valid_from), validUntil: only(entry.valid_until) })) },
      scope.tenant.membershipId,
    );
    // A new list is screened at once, in the transaction of the import, so a hold is in force when the answer is sent. A replay of the same content changes nothing and screens nothing.
    const run = imported.replayed ? undefined : await this.screening.run(scope.tx, scope.tenant.membershipId, 'LIST_IMPORT', now, todayOf(now));
    await announce(scope, now, {
      action: 'vnd.screening_list_imported',
      resourceType: 'screening_list_import',
      resourceId: imported.importId,
      version: 1,
      eventType: 'vnd.screening.list.imported.v1',
      diff: { import_id: imported.importId, source: body.source, entries: imported.entries, withdrawn: imported.withdrawn, replayed: imported.replayed, ...(run === undefined ? {} : { run_id: run.runId, hits_new: run.hitsNew, holds: run.holds }) },
    });
    return commandResult(scope, imported.replayed ? 'UNCHANGED' : 'IMPORTED', 1, imported.importId);
  }
}
