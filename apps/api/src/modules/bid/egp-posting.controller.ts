import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidWorkflowReads, CONTRACTOR_EXPORT_PERMISSION, CtrExportStore, EgpObligationStore, EgpReconciliationStore, TenantDatabase, contractScope, resolveEgpSubject } from '@machvon/db';
import type { EgpItemRow, EgpObligationRow } from '@machvon/db';
import {
  DomainError,
  EGP_ADAPTER_STATUS,
  EGP_LAYOUT_VERSION,
  EGP_POSTING_FIELDS,
  EGP_POSTING_KINDS,
  EGP_POSTING_SUBJECTS,
  EGP_RECONCILE_SUBJECTS,
  egpAcceptance,
  egpDayOf,
  egpOnTimeOf,
  egpTriggerInstant,
  isEgpSubjectType,
  vietnamDateOf,
} from '@machvon/kernel';
import type { EffectiveAccess, EgpPostingKind, EgpResolutionKind, EgpSubjectType, TenantContext } from '@machvon/kernel';
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
import { RATE_FORMULA, RATE_SOURCE, RECONCILE_FORMULA, RECONCILE_SOURCE, itemDto, obligationDto } from './egp-posting-view';

const OBLIGATION_RESOURCE = 'egp_posting_obligation';
const ITEM_RESOURCE = 'egp_reconciliation_item';
const CLASSIFICATION = 'INTERNAL';
const DAY_MS = 86_400_000;
/** The cutover day of a sweep that names none: the facts of the last 90 days are duties; older ones are not (the agency may name another day). */
const DEFAULT_SWEEP_DAYS = 90;
/** The right of the people who answer for a reconciliation item; the holders of it over the whole tenant are the candidates for the owner. */
const RECONCILE_PERMISSION = 'bid.egp.reconcile';
const GROUPS = ['OPEN', 'SUBMITTED', 'CLOSED'] as const;
const CLOCKS = ['OVERDUE', 'DUE_SOON'] as const;

const people = new BidWorkflowReads();

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** A query value that is one of the words, or absent. */
function word<T extends string>(value: unknown, words: readonly T[], field: string): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(words as readonly string[]).includes(value)) throw invalid(field);
  return value as T;
}

function flag(value: unknown, field: string): boolean {
  if (value === undefined) return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw invalid(field);
}

function uuidOf(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw invalid(field);
  return value.toLowerCase();
}

const obligationEvent = (row: EgpObligationRow, scope: CommandScope, now: Date, type: string, extra: Record<string, unknown> = {}) => ({
  aggregateType: OBLIGATION_RESOURCE,
  aggregateId: row.id,
  aggregateVersion: row.version,
  type,
  schemaVersion: 1,
  payload: {
    tenant_id: scope.tenant.tenantId,
    obligation_id: row.id,
    kind: row.kind,
    subject_type: row.subjectType,
    subject_id: row.subjectId,
    state: row.state,
    due_at: row.dueAt,
    version: row.version,
    actor_id: scope.tenant.membershipId,
    occurred_at: now.toISOString(),
    ...extra,
  },
  eventKey: `${OBLIGATION_RESOURCE}:${row.id}:${row.version}:${type}`,
});

/**
 * The duties of posting to the national procurement network (EGP-2, BID-32, `docs/egp-connector.md` sections 7 and 12). Every command is audited (ADM-11), announced in the outbox with ids, codes and days, and
 * idempotent (`Idempotency-Key`); the moves of a duty are versioned (`If-Match`). The platform never posts: a person posts on the network by hand and writes down what the network answered.
 */
@Controller()
export class EgpObligationController {
  private readonly obligations = new EgpObligationStore();
  private readonly exports = new CtrExportStore();

  private async audited(scope: CommandScope, row: EgpObligationRow, action: string, type: string, now: Date, reason: string | null, diff: Record<string, unknown> = {}): Promise<void> {
    await scope.audit({
      action,
      resourceType: OBLIGATION_RESOURCE,
      resourceId: row.id,
      classification: CLASSIFICATION,
      ...(reason === null ? {} : { reason }),
      diff: { kind: row.kind, subject_type: row.subjectType, subject_id: row.subjectId, subject_code: row.subjectCode, state: row.state, due_at: row.dueAt, rule_version: row.ruleVersion, legal_status: row.legalStatus, ...diff },
    });
    await scope.emit(obligationEvent(row, scope, now, type, diff));
  }

  @Post('egp/obligations')
  @HttpCode(200)
  @OperationId('openEgpObligation')
  @Command({ operation: 'openEgpObligation' })
  async open(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['EgpObligationOpen']): Promise<Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.openEgpObligation)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    if (!(EGP_POSTING_KINDS as readonly string[]).includes(body.kind)) throw invalid('kind');
    const kind = body.kind as EgpPostingKind;
    const subjectType = EGP_POSTING_SUBJECTS[kind];
    const triggeredAt = egpTriggerInstant(body.triggered_on, now);
    const lookup = await resolveEgpSubject(scope.tx, subjectType, body.our_code, body.our_project_code ?? null);
    if ('missing' in lookup) throw invalid(lookup.missing === 'AMBIGUOUS' ? 'our_project_code' : 'our_code');
    const context = await this.obligations.contextOf(scope.tx, kind, now);
    const { row, created } = await this.obligations.open(
      scope.tx,
      { kind, subjectType, subjectId: lookup.found.id, subjectCode: lookup.found.code, sourceRef: lookup.found.id, triggeredAt: new Date(triggeredAt), ownerId: body.owner_id ?? scope.tenant.membershipId },
      context,
      scope.tenant.membershipId,
    );
    if (created) await this.audited(scope, row, 'bid.egp_obligation_opened', 'bid.egp.obligation.opened.v1', now, null, { owner_id: row.ownerId, origin: 'MANUAL' });
    // A repeat changes nothing and announces nothing, but a command leaves its mark in the trail: the same fact asked for again is a line of its own.
    else await scope.audit({ action: 'bid.egp_obligation_open_repeated', resourceType: OBLIGATION_RESOURCE, resourceId: row.id, classification: CLASSIFICATION, diff: { kind: row.kind, subject_id: row.subjectId, state: row.state } });
    return this.single(scope, access, row, now);
  }

  @Post('egp/obligations/sweep')
  @HttpCode(200)
  @OperationId('sweepEgpObligations')
  @Command({ operation: 'sweepEgpObligations' })
  async sweep(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['EgpObligationSweep']): Promise<Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.sweepEgpObligations)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    const today = vietnamDateOf(now);
    let since = vietnamDateOf(new Date(now.getTime() - DEFAULT_SWEEP_DAYS * DAY_MS));
    if (body.since_on !== undefined) {
      const day = egpDayOf(body.since_on);
      if (day === undefined || day > today) throw invalid('since_on');
      since = day;
    }
    let kinds: EgpPostingKind[] | undefined;
    if (body.kinds !== undefined) {
      kinds = [];
      for (const kind of body.kinds) {
        if (!(EGP_POSTING_KINDS as readonly string[]).includes(kind)) throw invalid('kinds');
        kinds.push(kind as EgpPostingKind);
      }
    }
    const done = await this.obligations.sweep(scope.tx, { since, ownerId: body.owner_id ?? scope.tenant.membershipId, kinds }, scope.tenant.membershipId, now);
    const opened = done.outcomes.reduce((sum, outcome) => sum + outcome.opened, 0);
    const existing = done.outcomes.reduce((sum, outcome) => sum + outcome.existing, 0);
    await scope.audit({ action: 'bid.egp_obligations_swept', resourceType: OBLIGATION_RESOURCE, resourceId: scope.tenant.tenantId, classification: CLASSIFICATION, diff: { since_on: since, opened, existing, kinds: kinds ?? null } });
    for (const row of done.opened) await this.audited(scope, row, 'bid.egp_obligation_opened', 'bid.egp.obligation.opened.v1', now, null, { owner_id: row.ownerId, origin: 'SWEEP', since_on: since });
    return {
      since_on: since,
      opened,
      existing,
      outcomes: done.outcomes.map((outcome) => ({ fact: outcome.fact, kind: outcome.kind, opened: outcome.opened, existing: outcome.existing, truncated: outcome.truncated })),
      as_of: now.toISOString(),
    };
  }

  @Post('egp/obligations/:id/prepare')
  @HttpCode(200)
  @OperationId('prepareEgpObligation')
  @Command({ operation: 'prepareEgpObligation', versioned: true })
  async prepare(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['EgpObligationPrepare']): Promise<CommandResult> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.prepareEgpObligation)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    if ((body.fields === undefined) === (body.export_batch_id === undefined)) throw invalid(body.fields === undefined ? 'fields' : 'export_batch_id');
    let batch: Parameters<EgpObligationStore['prepare']>[3]['batch'];
    if (body.export_batch_id !== undefined) {
      // The batch is the file of the contractor export of CTR-24: it is read as that screen reads it, by someone who may read its file.
      const found = await this.exports.find(scope.tx, body.export_batch_id.toLowerCase());
      const readable = found !== undefined && (await this.exports.mayRead(scope.tx, found.id, scope.tenant.membershipId, contractScope(access, CONTRACTOR_EXPORT_PERMISSION, now), holdsOnWholeTenant(access, CONTRACTOR_EXPORT_PERMISSION)));
      if (found === undefined || !readable) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      batch = { id: found.id, fileSha256: found.fileSha256, rowCount: found.rowCount, scope: found.scope, periodFrom: found.periodFrom, periodTo: found.periodTo };
    }
    const done = await this.obligations.prepare(scope.tx, id, scope.expectedVersion ?? 0, { fields: body.fields, batch }, scope.tenant.membershipId, now);
    await this.audited(scope, done.row, 'bid.egp_obligation_prepared', 'bid.egp.obligation.prepared.v1', now, null, { packet_sha256: done.row.packetSha256, export_batch_id: done.row.exportBatchId, from_state: done.before.state });
    return commandResult(scope, done.row.state, done.row.version, id);
  }

  @Post('egp/obligations/:id/submit')
  @HttpCode(200)
  @OperationId('submitEgpObligation')
  @Command({ operation: 'submitEgpObligation', versioned: true })
  async submit(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.submitEgpObligation)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    const done = await this.obligations.submit(scope.tx, id, scope.expectedVersion ?? 0, scope.tenant.membershipId, now);
    await this.audited(scope, done.row, 'bid.egp_obligation_submitted', 'bid.egp.obligation.submitted.v1', now, null, { prepared_by: done.row.preparedBy, packet_sha256: done.row.packetSha256, in_time: Date.parse(done.row.submittedAt as string) <= Date.parse(done.row.dueAt) });
    return commandResult(scope, done.row.state, done.row.version, id);
  }

  @Post('egp/obligations/:id/receipt')
  @HttpCode(200)
  @OperationId('receiptEgpObligation')
  @Command({ operation: 'receiptEgpObligation', versioned: true })
  async receipt(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['EgpObligationReceipt']): Promise<CommandResult> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.receiptEgpObligation)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    const receiptedAt = body.receipted_at === undefined ? now : new Date(body.receipted_at);
    if (Number.isNaN(receiptedAt.getTime())) throw invalid('receipted_at');
    if (typeof body.receipt_ref !== 'string') throw invalid('receipt_ref');
    const done = await this.obligations.receipt(scope.tx, id, scope.expectedVersion ?? 0, { receiptRef: body.receipt_ref, receiptedAt }, scope.tenant.membershipId, now);
    // The packet of a contractor evaluation or a violation is the file of a batch of the export (CTR-24): its receipt is the receipt of the batch too.
    let batchMoved = false;
    if (done.row.exportBatchId !== null) {
      batchMoved = await this.exports.submitFromObligation(scope.tx, done.row.exportBatchId, { ref: done.row.receiptRef as string, on: vietnamDateOf(receiptedAt) }, scope.tenant.membershipId);
      if (batchMoved) {
        const batch = await this.exports.find(scope.tx, done.row.exportBatchId);
        if (batch !== undefined) {
          await scope.audit({
            action: 'ctr.contractor_export.submitted',
            resourceType: 'contractor_export_batch',
            resourceId: batch.id,
            classification: CLASSIFICATION,
            diff: { scope: batch.scope, period_from: batch.periodFrom, period_to: batch.periodTo, file_sha256: batch.fileSha256, submitted_ref: batch.submittedRef, submitted_on: batch.submittedOn, via_obligation_id: id },
          });
          await scope.emit({
            aggregateType: 'contractor_export_batch',
            aggregateId: batch.id,
            aggregateVersion: batch.version,
            type: 'ctr.contractor_export.submitted.v1',
            schemaVersion: 1,
            payload: { tenant_id: scope.tenant.tenantId, export_id: batch.id, file_sha256: batch.fileSha256, submitted_ref: batch.submittedRef, submitted_on: batch.submittedOn },
            eventKey: `contractor_export_batch:${batch.id}:${batch.version}`,
          });
        }
      }
    }
    await this.audited(scope, done.row, 'bid.egp_obligation_receipted', 'bid.egp.obligation.receipted.v1', now, null, { receipt_ref: done.row.receiptRef, receipted_at: done.row.receiptedAt, export_batch_submitted: batchMoved });
    return commandResult(scope, done.row.state, done.row.version, id);
  }

  @Post('egp/obligations/:id/reject')
  @HttpCode(200)
  @OperationId('rejectEgpObligation')
  @Command({ operation: 'rejectEgpObligation', versioned: true })
  async reject(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['EgpObligationReason']): Promise<CommandResult> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.rejectEgpObligation)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    const done = await this.obligations.reject(scope.tx, id, scope.expectedVersion ?? 0, String(body.reason ?? ''), scope.tenant.membershipId, now);
    await this.audited(scope, done.row, 'bid.egp_obligation_rejected', 'bid.egp.obligation.rejected.v1', now, done.row.rejectionReason);
    return commandResult(scope, done.row.state, done.row.version, id);
  }

  @Post('egp/obligations/:id/cancel')
  @HttpCode(200)
  @OperationId('cancelEgpObligation')
  @Command({ operation: 'cancelEgpObligation', versioned: true })
  async cancel(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['EgpObligationCancel']): Promise<CommandResult> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.cancelEgpObligation)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    const done = await this.obligations.cancel(scope.tx, id, scope.expectedVersion ?? 0, String(body.reason ?? ''), scope.tenant.membershipId, now);
    await this.audited(scope, done.row, 'bid.egp_obligation_cancelled', 'bid.egp.obligation.cancelled.v1', now, done.row.cancelReason, { from_state: done.before.state });
    return commandResult(scope, done.row.state, done.row.version, id);
  }

  private async single(scope: CommandScope, access: EffectiveAccess, row: EgpObligationRow, now: Date): Promise<Record<string, unknown>> {
    const severity = (await this.obligations.severityRule(scope.tx, now)).params;
    const names = await people.names(scope.tx, [row.ownerId, row.preparedBy, row.submittedBy, row.receiptRecordedBy]);
    return obligationDto(row, {
      now,
      severity,
      names,
      caller: { membershipId: scope.tenant.membershipId, mayPrepare: holdsOnWholeTenant(access, PERMISSIONS.prepareEgpObligation), maySubmit: holdsOnWholeTenant(access, PERMISSIONS.submitEgpObligation) },
      obligationText: null,
      batchStatus: null,
    });
  }
}

/** The reads of the board BID-32: the list with the counts, the figure "posted on time" and the rule behind the urgency; one duty with its history and the fields our register can offer. */
@Controller()
export class EgpObligationReadsController {
  private readonly obligations = new EgpObligationStore();
  private readonly exports = new CtrExportStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('egp/obligations')
  @OperationId('listEgpObligations')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.listEgpObligations)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    const group = word(query.group, GROUPS, 'group');
    const clock = word(query.clock, CLOCKS, 'clock');
    const kind = word(query.kind, EGP_POSTING_KINDS, 'kind');
    const mine = flag(query.mine, 'mine');
    const subjectId = uuidOf(query.subject_id, 'subject_id');
    const request = parsePageRequest(query.limit, query.cursor);
    return this.database.withTenant(tenant, async (tx) => {
      const rows = await this.obligations.list(tx, { group, kind, clock, ownerId: mine ? tenant.membershipId : undefined, subjectId }, { limit: request.limit + 1, after: request.after === undefined ? undefined : { key: request.after.code, id: request.after.id } }, now);
      const shown = rows.slice(0, request.limit);
      const last = shown[shown.length - 1];
      const counts = await this.obligations.counts(tx, now);
      const severity = await this.obligations.severityRule(tx, now);
      const names = await people.names(tx, shown.flatMap((row) => [row.ownerId, row.preparedBy, row.submittedBy, row.receiptRecordedBy]));
      const texts = new Map<string, string | null>();
      for (const one of new Set(shown.map((row) => row.kind))) {
        const rule = await this.obligations.deadlineRule(tx, one, now);
        texts.set(one, typeof rule.params.obligation === 'string' ? rule.params.obligation : null);
      }
      const batches = await this.batchStatuses(tx, shown);
      const caller = { membershipId: tenant.membershipId, mayPrepare: holdsOnWholeTenant(access, PERMISSIONS.prepareEgpObligation), maySubmit: holdsOnWholeTenant(access, PERMISSIONS.submitEgpObligation) };
      const rate = egpOnTimeOf({ met: counts.met, metLate: counts.metLate, overdue: counts.overdue });
      return {
        items: shown.map((row) => obligationDto(row, { now, severity: severity.params, names, caller, obligationText: texts.get(row.kind) ?? null, batchStatus: row.exportBatchId === null ? null : (batches.get(row.exportBatchId) ?? null) })),
        next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.dueAtKey, id: last.id }) : null,
        counts: { total: counts.total, by_state: counts.byState, overdue: counts.overdue, due_soon: counts.dueSoon, met: counts.met, met_late: counts.metLate },
        on_time: { met: rate.met, met_late: rate.metLate, overdue: rate.overdue, rate_bp: rate.rateBp, formula: RATE_FORMULA, source: RATE_SOURCE },
        severity_rule: {
          urgent_within_hours: severity.params.urgent_within_hours,
          version: severity.version,
          source: severity.source,
          unverified: severity.unverified,
          legal_status: severity.legalStatus,
          formula: severity.formula,
          source_text: severity.sourceText,
          as_of: severity.asOf,
        },
        acceptance: egpAcceptance(EGP_LAYOUT_VERSION),
        adapter_status: EGP_ADAPTER_STATUS,
        actions: { sweep: caller.mayPrepare, open: caller.mayPrepare, prepare: caller.mayPrepare, submit: caller.maySubmit },
        as_of: now.toISOString(),
      };
    });
  }

  private async batchStatuses(tx: Parameters<CtrExportStore['find']>[0], rows: readonly EgpObligationRow[]): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    for (const id of new Set(rows.flatMap((row) => (row.exportBatchId === null ? [] : [row.exportBatchId])))) {
      const batch = await this.exports.find(tx, id);
      if (batch !== undefined) found.set(id, batch.status);
    }
    return found;
  }

  @Get('egp/obligations/:id')
  @OperationId('getEgpObligation')
  async detail(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.getEgpObligation)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    return this.database.withTenant(tenant, async (tx) => {
      const row = await this.obligations.find(tx, id);
      if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const severity = await this.obligations.severityRule(tx, now);
      const rule = await this.obligations.deadlineRule(tx, row.kind, now);
      const history = await this.obligations.history(tx, id);
      const names = await people.names(tx, [row.ownerId, row.preparedBy, row.submittedBy, row.receiptRecordedBy, ...history.map((entry) => entry.actorId)]);
      const batches = await this.batchStatuses(tx, [row]);
      const suggested = row.state === 'DUE' || row.state === 'REJECTED' ? await this.obligations.suggestedFields(tx, row) : {};
      const caller = { membershipId: tenant.membershipId, mayPrepare: holdsOnWholeTenant(access, PERMISSIONS.prepareEgpObligation), maySubmit: holdsOnWholeTenant(access, PERMISSIONS.submitEgpObligation) };
      return {
        obligation: obligationDto(row, { now, severity: severity.params, names, caller, obligationText: typeof rule.params.obligation === 'string' ? rule.params.obligation : null, batchStatus: row.exportBatchId === null ? null : (batches.get(row.exportBatchId) ?? null) }),
        history: history.map((entry) => ({ id: entry.id, action: entry.action, actor_name: names.get(entry.actorId) ?? null, reason: entry.reason, state_after: entry.stateAfter, version: entry.version, occurred_at: entry.occurredAt })),
        required_fields: [...EGP_POSTING_FIELDS[row.kind]],
        suggested_fields: suggested,
        deadline_rule: { version: rule.version, source: rule.source, unverified: rule.unverified, legal_status: rule.legalStatus, formula: rule.formula, source_text: rule.sourceText, as_of: rule.asOf, params: rule.params },
        as_of: now.toISOString(),
      };
    });
  }
}

/**
 * The reconciliation of our register against what the files of the national network said (BID-33): the run opens an item for each field that differs; a person who is not one of the people who made the record
 * settles it with one of four resolutions. A resolution edits nothing of another module: the owner of that record changes it through its own command.
 */
@Controller()
export class EgpReconciliationController {
  private readonly items = new EgpReconciliationStore();
  private readonly obligations = new EgpObligationStore();

  @Post('egp/reconciliation/run')
  @HttpCode(200)
  @OperationId('runEgpReconciliation')
  @Command({ operation: 'runEgpReconciliation' })
  async run(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['EgpReconcileRun']): Promise<Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.runEgpReconciliation)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    let subjectType: EgpSubjectType | undefined;
    if (body.subject_type !== undefined) {
      if (!isEgpSubjectType(body.subject_type) || !EGP_RECONCILE_SUBJECTS.includes(body.subject_type)) throw invalid('subject_type');
      subjectType = body.subject_type;
    }
    const holders = await this.obligations.holdersOf(scope.tx, RECONCILE_PERMISSION, now);
    const done = await this.items.reconcile(scope.tx, { subjectType, ownerId: body.owner_id ?? scope.tenant.membershipId, holders }, scope.tenant.membershipId, now);
    await scope.audit({
      action: 'bid.egp_reconciliation_run',
      resourceType: ITEM_RESOURCE,
      resourceId: scope.tenant.tenantId,
      classification: CLASSIFICATION,
      diff: { subject_type: subjectType ?? null, examined: done.examined, differences: done.differences, opened: done.opened, unchanged: done.unchanged, settled_already: done.settledAlready, no_owner: done.noOwner },
    });
    for (const row of done.rows) {
      await scope.audit({
        action: 'bid.egp_reconciliation_opened',
        resourceType: ITEM_RESOURCE,
        resourceId: row.id,
        classification: CLASSIFICATION,
        diff: { subject_type: row.subjectType, subject_id: row.subjectId, subject_code: row.subjectCode, external_code: row.externalCode, field: row.field, difference_kind: row.differenceKind, owner_id: row.ownerId, due_at: row.dueAt, import_id: row.importId },
      });
      await scope.emit(this.event(scope, row, now, 'bid.egp.reconciliation.opened.v1', { owner_id: row.ownerId, field: row.field, difference_kind: row.differenceKind }));
    }
    const names = await people.names(scope.tx, done.rows.map((row) => row.ownerId));
    const caller = { membershipId: scope.tenant.membershipId, mayResolve: holdsOnWholeTenant(access, PERMISSIONS.resolveEgpReconciliationItem) };
    return {
      examined: done.examined,
      differences: done.differences,
      opened: done.opened,
      unchanged: done.unchanged,
      settled_already: done.settledAlready,
      no_owner: done.noOwner,
      items: done.rows.map((row) => itemDto(row, { now, names, caller })),
      as_of: now.toISOString(),
    };
  }

  private event(scope: CommandScope, row: EgpItemRow, now: Date, type: string, extra: Record<string, unknown>) {
    return {
      aggregateType: ITEM_RESOURCE,
      aggregateId: row.id,
      aggregateVersion: row.version,
      type,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, item_id: row.id, subject_type: row.subjectType, subject_id: row.subjectId, external_code: row.externalCode, state: row.state, version: row.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), ...extra },
      eventKey: `${ITEM_RESOURCE}:${row.id}:${row.version}:${type}`,
    };
  }

  @Post('egp/reconciliation/items/:id/resolution')
  @HttpCode(200)
  @OperationId('resolveEgpReconciliationItem')
  @Command({ operation: 'resolveEgpReconciliationItem', versioned: true })
  async resolve(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['EgpReconciliationResolve']): Promise<CommandResult> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.resolveEgpReconciliationItem)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    const done = await this.items.resolve(
      scope.tx,
      id,
      scope.expectedVersion ?? 0,
      { kind: body.kind as EgpResolutionKind, reason: String(body.reason ?? ''), evidenceRef: body.evidence_ref ?? null, reviewOn: body.review_on ?? null },
      scope.tenant.membershipId,
      now,
    );
    await scope.audit({
      action: 'bid.egp_reconciliation_resolved',
      resourceType: ITEM_RESOURCE,
      resourceId: id,
      classification: CLASSIFICATION,
      reason: done.row.reason as string,
      diff: { subject_type: done.row.subjectType, subject_id: done.row.subjectId, subject_code: done.row.subjectCode, external_code: done.row.externalCode, field: done.row.field, resolution: done.row.resolutionKind, follow_up: done.followUp, evidence_ref: done.row.evidenceRef, review_on: done.row.reviewOn, owner_id: done.row.ownerId },
    });
    await scope.emit(this.event(scope, done.row, now, 'bid.egp.reconciliation.resolved.v1', { resolution: done.row.resolutionKind, follow_up: done.followUp, field: done.row.field }));
    return commandResult(scope, done.row.state, done.row.version, id);
  }
}

/** The worklist of BID-33: the items with the counts by state and by resolution, the rule behind the due time, and the formula of a difference. */
@Controller()
export class EgpReconciliationReadsController {
  private readonly items = new EgpReconciliationStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('egp/reconciliation/items')
  @OperationId('listEgpReconciliationItems')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.listEgpReconciliationItems)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    const state = word(query.state, ['OPEN', 'RESOLVED'] as const, 'state');
    const subjectText = word(query.subject_type, EGP_RECONCILE_SUBJECTS as readonly string[], 'subject_type');
    const mine = flag(query.mine, 'mine');
    const overdue = flag(query.overdue, 'overdue');
    const request = parsePageRequest(query.limit, query.cursor);
    return this.database.withTenant(tenant, async (tx) => {
      const rows = await this.items.list(
        tx,
        { state, subjectType: subjectText as EgpSubjectType | undefined, ownerId: mine ? tenant.membershipId : undefined, overdue },
        { limit: request.limit + 1, after: request.after === undefined ? undefined : { key: request.after.code, id: request.after.id } },
        now,
      );
      const shown = rows.slice(0, request.limit);
      const last = shown[shown.length - 1];
      const counts = await this.items.counts(tx, now);
      const due = await this.items.dueRule(tx, now);
      const names = await people.names(tx, shown.flatMap((row) => [row.ownerId, row.resolvedBy]));
      const mayResolve = holdsOnWholeTenant(access, PERMISSIONS.resolveEgpReconciliationItem);
      return {
        items: shown.map((row) => itemDto(row, { now, names, caller: { membershipId: tenant.membershipId, mayResolve } })),
        next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.dueAtKey, id: last.id }) : null,
        counts: { open: counts.open, resolved: counts.resolved, overdue: counts.overdue, by_resolution: counts.byResolution, waivers_due: counts.waiversDue },
        due_rule: { days: due.days, version: due.version, source: due.source, unverified: due.unverified, legal_status: due.legalStatus, formula: due.formula, source_text: due.sourceText, as_of: due.asOf },
        formula: RECONCILE_FORMULA,
        source: RECONCILE_SOURCE,
        acceptance: egpAcceptance(EGP_LAYOUT_VERSION),
        actions: { run: holdsOnWholeTenant(access, PERMISSIONS.runEgpReconciliation), resolve: mayResolve },
        as_of: now.toISOString(),
      };
    });
  }
}
