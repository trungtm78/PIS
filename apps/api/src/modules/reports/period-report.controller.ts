import { createHash } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { CertificateStore, PeriodReportStore, TenantDatabase } from '@machvon/db';
import type { PeriodLockRow, ReportSignatureRow } from '@machvon/db';
import { DomainError, assertSignerIsApprover, eventLocks, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { signedDigestOf } from '../doc/cms-verification';
import type { SessionRef, SigningPort } from '../doc/signing-port';
import { DOC_SIGNING_PORT } from '../doc/tokens';
import { assertWholeTenant, booleanQuery, pageOf, todayOf } from '../gov12-support';

const LOCK = 'report_period_lock';
const ISSUE = 'report_issue';
const SESSION = 'report_signature_session';

const lockView = (row: PeriodLockRow): Record<string, unknown> => ({
  id: row.id,
  layout_code: row.layoutCode,
  period_code: row.periodCode,
  issue_id: row.issueId,
  digest_sha256: row.digestSha256,
  locked_by: row.lockedBy,
  locked_at: row.lockedAt,
  open: row.unlockedAt === null,
  unlocked_by: row.unlockedBy,
  unlocked_at: row.unlockedAt,
  unlock_reason: row.unlockReason,
  version: row.version,
});

const signatureView = (row: ReportSignatureRow): Record<string, unknown> => ({
  id: row.id,
  issue_id: row.issueId,
  digest_sha256: row.digestSha256,
  provider: row.provider,
  signer_id: row.signerId,
  certificate_fingerprint: row.certificateFingerprint,
  cms_sha256: row.cmsSha256,
  // A signature of the MOCK provider is a test signature: it never lets a copy go to a receiver that requires a signature.
  counts_for_delivery: row.countsForDelivery,
  signed_at: row.signedAt,
});

/**
 * Period reports for the Ministry (G4-6), commands on top of the report engine: the approver of an issued copy signs its package digest through the signing port of DOC (the certificate is one of their own that is active), the
 * signature is stored with the hash of the CMS, and the period is locked when the rule says so. A locked period takes no new copy; two people release it, the second with a reason. Whole tenant only.
 */
@Controller()
export class PeriodReportController {
  private readonly store = new PeriodReportStore();
  private readonly certificates = new CertificateStore();

  constructor(@Inject(DOC_SIGNING_PORT) private readonly signing: SigningPort) {}

  @Post('report-engine/issues/:id/signature')
  @HttpCode(200)
  @OperationId('startReportSignature')
  @Command({ operation: 'startReportSignature' })
  async start(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['StartReportSignature']): Promise<CommandResult> {
    assertWholeTenant(access, PERMISSIONS.startReportSignature);
    const { tx } = scope;
    const copy = await this.store.issue(tx, id.toLowerCase());
    if (copy === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    assertSignerIsApprover({ signerId: scope.tenant.membershipId, approverId: copy.approvedBy });
    if ((await this.store.signatureOf(tx, copy.id)) !== undefined || (await this.store.openSession(tx, copy.id)) !== undefined) throw new DomainError('REPORT_STATE_INVALID', 409, 'signature');
    if (!(await this.store.isHead(tx, copy.id))) throw new DomainError('REPORT_OUT_OF_DATE', 409, 'issue');
    const certificate = await this.certificates.find(tx, body.certificate_id.toLowerCase());
    // A certificate that is not the signer's own, not personal or not active is "not active" to the caller, whichever it is.
    if (certificate === undefined || certificate.kind !== 'PERSONAL' || certificate.holderMembershipId !== scope.tenant.membershipId || certificate.status !== 'Active') throw new DomainError('CERTIFICATE_NOT_ACTIVE', 422, 'certificate_id');
    const ref = await this.signing.startSession({ digestSha256: copy.sha256, certificateFingerprint: certificate.fingerprintSha256, correlationId: scope.requestId });
    scope.afterRollback(() => this.signing.cancel(ref));
    const session = await this.store.createSession(tx, { issueId: copy.id, provider: ref.provider, providerSessionId: ref.sessionId, certificateId: certificate.id, certificateFingerprint: certificate.fingerprintSha256, digestSha256: copy.sha256, startedBy: scope.tenant.membershipId, expiresAt: ref.expiresAt });
    await scope.audit({ action: 'rpt.signature_started', resourceType: SESSION, resourceId: session.id, classification: 'INTERNAL', diff: { issue_id: copy.id, layout_code: copy.layoutCode, period_code: copy.periodCode, revision: copy.revision, digest_sha256: copy.sha256, provider: ref.provider, certificate_id: certificate.id } });
    await scope.emit({ aggregateType: SESSION, aggregateId: session.id, aggregateVersion: session.version, type: 'rpt.signature.started.v1', schemaVersion: 1, payload: { tenant_id: scope.tenant.tenantId, issue_id: copy.id, session_id: session.id, provider: ref.provider, actor_id: scope.tenant.membershipId }, eventKey: `${SESSION}:${session.id}:started` });
    return commandResult(scope, 'STARTED', session.version, session.id);
  }

  @Post('report-engine/signature-sessions/:id/completion')
  @HttpCode(200)
  @OperationId('completeReportSignature')
  @Command({ operation: 'completeReportSignature' })
  async complete(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    assertWholeTenant(access, PERMISSIONS.completeReportSignature);
    const { tx } = scope;
    const session = await this.store.findSession(tx, id.toLowerCase(), true);
    // Only the person who started the signing completes it; anybody else is told it does not exist.
    if (session === undefined || session.startedBy !== scope.tenant.membershipId) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    if (session.state !== 'OPEN') throw new DomainError('SIGNING_SESSION_EXPIRED', 409, 'session');
    const ref: SessionRef = { provider: session.provider, sessionId: session.providerSessionId, expiresAt: new Date(session.expiresAt) };
    const collected = await this.signing.collect(ref);
    // The signer has not approved on their device yet: nothing changes and the caller asks again.
    if (collected === 'PENDING') {
      await scope.audit({ action: 'rpt.signature_pending', resourceType: SESSION, resourceId: session.id, classification: 'INTERNAL', diff: { issue_id: session.issueId } });
      return commandResult(scope, 'PENDING', session.version, session.id);
    }
    const cms = collected.cms;
    const covered = signedDigestOf(cms);
    if (covered === null || covered.toString('hex') !== session.digestSha256) throw new DomainError('SIGNATURE_INVALID', 422, 'cms');
    const copy = await this.store.issue(tx, session.issueId);
    if (copy === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    const signature = await this.store.storeSignature(tx, { issueId: copy.id, sessionId: session.id, digestSha256: session.digestSha256, provider: session.provider, signerId: scope.tenant.membershipId, certificateFingerprint: session.certificateFingerprint, cms, cmsSha256: createHash('sha256').update(cms).digest('hex') });
    await this.store.closeSession(tx, session.id, 'COMPLETED');
    await scope.audit({ action: 'rpt.signature_completed', resourceType: ISSUE, resourceId: copy.id, classification: 'INTERNAL', diff: { signature_id: signature.id, digest_sha256: signature.digestSha256, cms_sha256: signature.cmsSha256, provider: signature.provider, counts_for_delivery: signature.countsForDelivery } });
    await scope.emit({ aggregateType: ISSUE, aggregateId: copy.id, aggregateVersion: 1, type: 'rpt.signature.completed.v1', schemaVersion: 1, payload: { tenant_id: scope.tenant.tenantId, issue_id: copy.id, signature_id: signature.id, provider: signature.provider, counts_for_delivery: signature.countsForDelivery, actor_id: scope.tenant.membershipId }, eventKey: `${ISSUE}:${copy.id}:signed` });
    // The period is locked when the policy says that a signature does it; a TEST signature (the MOCK provider) locks nothing: the period is not final until a real signature or an acceptance.
    const policy = (await this.store.policy(tx, vietnamDateOf(new Date()))).policy;
    if (signature.countsForDelivery && eventLocks('SIGNED', policy)) {
      const { lock, created } = await this.store.lock(tx, copy, scope.tenant.membershipId);
      if (created) {
        await scope.audit({ action: 'rpt.period_locked', resourceType: LOCK, resourceId: lock.id, classification: 'INTERNAL', diff: { layout_code: lock.layoutCode, period_code: lock.periodCode, issue_id: lock.issueId, digest_sha256: lock.digestSha256, event: 'SIGNED' } });
        await scope.emit({ aggregateType: LOCK, aggregateId: lock.id, aggregateVersion: lock.version, type: 'rpt.period.locked.v1', schemaVersion: 1, payload: { tenant_id: scope.tenant.tenantId, lock_id: lock.id, layout_code: lock.layoutCode, period_code: lock.periodCode, actor_id: scope.tenant.membershipId }, eventKey: `${LOCK}:${lock.id}:locked` });
      }
    }
    return commandResult(scope, 'SIGNED', 1, copy.id);
  }

  @Post('report-engine/period-locks/:id/unlock')
  @HttpCode(200)
  @OperationId('unlockReportPeriod')
  @Command({ operation: 'unlockReportPeriod', versioned: true })
  async unlock(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['Gov12Reason']): Promise<CommandResult> {
    assertWholeTenant(access, PERMISSIONS.unlockReportPeriod);
    const lock = await this.store.unlock(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, scope.tenant.membershipId, body.reason, todayOf(new Date()));
    await scope.audit({ action: 'rpt.period_unlocked', resourceType: LOCK, resourceId: lock.id, classification: 'INTERNAL', diff: { layout_code: lock.layoutCode, period_code: lock.periodCode, issue_id: lock.issueId }, reason: body.reason.trim() });
    await scope.emit({ aggregateType: LOCK, aggregateId: lock.id, aggregateVersion: lock.version, type: 'rpt.period.unlocked.v1', schemaVersion: 1, payload: { tenant_id: scope.tenant.tenantId, lock_id: lock.id, layout_code: lock.layoutCode, period_code: lock.periodCode, actor_id: scope.tenant.membershipId }, eventKey: `${LOCK}:${lock.id}:unlocked` });
    return commandResult(scope, 'UNLOCKED', lock.version, lock.id);
  }
}

/** Period reports for the Ministry, reads: the locks and the signature of a copy. */
@Controller()
export class PeriodReportReadsController {
  private readonly store = new PeriodReportStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('report-engine/period-locks')
  @OperationId('listReportPeriodLocks')
  async locks(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('layout_code') layoutCode?: unknown, @Query('open_only') openOnly?: unknown, @Query('limit') limit?: unknown, @Query('offset') offset?: unknown): Promise<Record<string, unknown>> {
    assertWholeTenant(access, PERMISSIONS.listReportPeriodLocks);
    const page = pageOf(limit, offset);
    if (layoutCode !== undefined && (typeof layoutCode !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/.test(layoutCode))) throw new DomainError('VALIDATION_FAILED', 422, 'layout_code');
    const today = todayOf(new Date());
    const found = await this.database.withTenant(tenant, async (tx) => ({ rows: await this.store.locks(tx, { layoutCode: layoutCode as string | undefined, openOnly: booleanQuery(openOnly, 'open_only'), limit: page.limit + 1, offset: page.offset }), policy: await this.store.policy(tx, today) }));
    return {
      as_of: today,
      items: found.rows.slice(0, page.limit).map(lockView),
      has_more: found.rows.length > page.limit,
      rule: { version: found.policy.version, unverified: found.policy.unverified, lock_after: found.policy.policy.lock_after, signature_required_receivers: found.policy.policy.signature_required_receivers, unlock_reason_min_chars: found.policy.policy.unlock_reason_min_chars },
    };
  }

  @Get('report-engine/issues/:id/signature')
  @OperationId('getReportSignature')
  async signature(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    assertWholeTenant(access, PERMISSIONS.getReportSignature);
    const today = todayOf(new Date());
    const found = await this.database.withTenant(tenant, async (tx) => {
      const copy = await this.store.issue(tx, id.toLowerCase());
      if (copy === undefined) return undefined;
      const lock = await this.store.openLock(tx, copy.layoutCode, copy.periodCode);
      return { copy, signature: await this.store.signatureOf(tx, copy.id), session: await this.store.openSession(tx, copy.id), lock, policy: await this.store.policy(tx, today) };
    });
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    return {
      as_of: today,
      issue_id: found.copy.id,
      layout_code: found.copy.layoutCode,
      period_code: found.copy.periodCode,
      revision: found.copy.revision,
      digest_sha256: found.copy.sha256,
      signed: found.signature !== undefined,
      signature: found.signature === undefined ? null : signatureView(found.signature),
      open_session_id: found.session?.id ?? null,
      period_lock: found.lock === undefined ? null : lockView(found.lock),
      signature_required_receivers: found.policy.policy.signature_required_receivers,
    };
  }
}
