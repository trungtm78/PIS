import { ChannelAccountStore } from '@machvon/db';
import type { AuditWriter, TenantDatabase } from '@machvon/db';
import { activeGrants, holdsPermission } from '@machvon/kernel';
import type { ChannelSendResult, EffectiveAccess, MetricsSink, TenantContext } from '@machvon/kernel';
import { ReportMailRunner } from '@machvon/edition-enterprise/src/server.ts';
import type { ReportMailer } from '@machvon/edition-enterprise/src/server.ts';
import type { ChannelAdapterRegistry } from '../../notifications/delivery/channel-adapters';
import { layoutReadable } from '../../modules/reports/form-registry';
import { MAIL_READ } from './report-mail.controller';

/** The channel the forms are mailed on: the e-mail channel of the delivery engine (its adapter is the SMTP one of ENT-4c in production, the in-memory one in development). */
const CHANNEL = 'EMAIL';

/**
 * The mailer of the report schedules: the channel port, not a sender of its own. It asks the registry of the process for the adapter of the e-mail channel (one whose honest status allows it where the process runs) and the
 * tenant for an active e-mail account, and hands the message, with the file attached, to `ChannelAdapter.send`. No adapter or no account means `ready` says why and the runner writes nothing.
 */
export class ChannelReportMailer implements ReportMailer {
  private readonly accounts = new ChannelAccountStore();

  constructor(
    private readonly database: Pick<TenantDatabase, 'withTenant'>,
    private readonly registry: Pick<ChannelAdapterRegistry, 'usable'>,
  ) {}

  private async accountOf(ctx: TenantContext): Promise<string | undefined> {
    const accounts = await this.database.withTenant(ctx, (tx) => this.accounts.list(tx, { status: 'ACTIVE', channel: CHANNEL }, { limit: 1, after: undefined }));
    return accounts[0]?.externalAccountId;
  }

  async ready(ctx: TenantContext): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.registry.usable(CHANNEL) === undefined) return { ok: false, reason: 'NO_CHANNEL_ADAPTER' };
    return (await this.accountOf(ctx)) === undefined ? { ok: false, reason: 'NO_EMAIL_ACCOUNT' } : { ok: true };
  }

  async send(ctx: TenantContext, request: Parameters<ReportMailer['send']>[1]): Promise<ChannelSendResult> {
    const adapter = this.registry.usable(CHANNEL);
    const accountId = await this.accountOf(ctx);
    if (adapter === undefined || accountId === undefined) return { kind: 'FAILED', failureClass: 'RETRYABLE', errorCode: 'CHANNEL_NOT_READY' };
    return adapter.send({ idempotencyKey: request.idempotencyKey, to: request.to, accountId, subject: request.subject, text: request.text, attachments: request.attachments });
  }
}

/** The recipient may read the form when they hold the right to read mailed forms over the whole tenant and the guard of the form lets them in. */
export function recipientMayRead(access: EffectiveAccess, layoutCode: string, now: Date): boolean {
  const wholeTenant = activeGrants(access, now).some((grant) => grant.scope.kind === 'TENANT' && holdsPermission(new Set(grant.permissions), MAIL_READ));
  return wholeTenant && layoutReadable(access, layoutCode);
}

export interface ReportMailJobDeps {
  tenants: TenantDatabase;
  registry: ChannelAdapterRegistry;
  audit?: Pick<AuditWriter, 'recordInTx'>;
  metrics?: MetricsSink;
}

/** The job `report-mail-runner` for the worker process: one pass over the schedules of the tenant. */
export function createReportMailJob(deps: ReportMailJobDeps): { run(ctx: TenantContext, now: Date): Promise<unknown> } {
  const runner = new ReportMailRunner({
    database: deps.tenants,
    mailer: new ChannelReportMailer(deps.tenants, deps.registry),
    mayRead: recipientMayRead,
    ...(deps.audit === undefined ? {} : { audit: deps.audit }),
    ...(deps.metrics === undefined ? {} : { metrics: deps.metrics }),
  });
  return { run: (ctx, now) => runner.run(ctx, now) };
}
