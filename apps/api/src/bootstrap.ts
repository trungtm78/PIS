import { Injectable, Module } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import {
  AuditWriter,
  ControlDatabase,
  EffectiveAccessStore,
  EntitlementStore,
  InMemoryAuthzCache,
  InMemoryEntitlementCache,
  LicenseStore,
  TenantBootstrapStore,
  TenantDatabase,
  TenantRegistry,
  ThemeStore,
  UserSessionStore,
} from '@machvon/db';
import type { DeliveryEngine, InboxHandlerRegistry } from '@machvon/db';
import { ConsoleSpanExporter, NoopSpanExporter, OtlpHttpSpanExporter, Tracer, loadErrorRegistry } from '@machvon/kernel';
import type { AlertSink, LiteLlmAdminPort, SecretVaultPort, SpanExporter, TimerPort } from '@machvon/kernel';
import { Pool } from 'pg';
import { createAlertSink } from './alerts/alert-sinks';
import { AppModule } from './app.module';
import type { AuthGuardOptions } from './auth/auth.guard';
import { HttpJwksSource, discoverJwksUri } from './auth/jwks-source';
import { JwksTokenVerifier } from './auth/jwks-token-verifier';
import { LocalTenantTokenIssuer, issuerKeyFromPem } from './auth/tenant-token-issuer';
import type { Config } from './config/config';
import { DatabaseReadinessProbe, expectedMigrations } from './health/database-probe';
import { HealthController, READINESS_PROBE } from './health/health.controller';
import type { ReadinessProbe } from './health/health.controller';
import { INVITATION_MAILER } from './modules/adm/invitation-mailer';
import { LLM_ADMIN, LLM_VAULT } from './modules/llm/tokens';
import type { InvitationMailer } from './modules/adm/invitation-mailer';
import { ADM_INBOX_HANDLERS } from './modules/adm/tokens';
import { CHANNEL_ADAPTERS } from './notifications/delivery/channel-adapters';
import type { ChannelAdapterRegistry } from './notifications/delivery/channel-adapters';
import { ConversationSender } from './omni/conversations/conversation-sender';
import { DeliveryDispatcher } from './notifications/delivery/dispatcher';
import { DELIVERY_ENGINE } from './notifications/delivery/tokens';
import { PermissionResourceAccess } from './notifications/resource-access-port';
import { FileService } from './modules/files';
import { EnvironmentLicenseKeyStore } from './modules/sas/license-signer';
import { operationIdOf } from './operation-id.decorator';
import { MockProvisioningPorts } from './provisioning/mock-ports';
import type { ProvisioningPorts } from './provisioning/ports';
import { createProvisioningConsumer } from './provisioning/provisioning-wiring';
import { InProcessWorkflowRunner } from './provisioning/workflow-runner';
import type { WorkflowRunner } from './provisioning/workflow-runner';
import { DatabaseTenantRuntime } from './session/tenant-runtime';
import { UserSessionDenyList } from './session/user-session-deny-list';
import { requestTelemetry } from './telemetry/request-telemetry';
import { DocumentIssueConsumer } from './modules/doc/issue-consumer';
import { DocumentIssueService } from './modules/doc/issue-request.service';
import { CHANNEL_VERIFIER } from './omni/channel-verifier';
import type { ChannelVerifierPort } from './omni/channel-verifier';
import { PUSH_TOKEN_VAULT } from './notifications/devices/push-vault';
import type { PushTokenVault } from './notifications/devices/push-vault';
import { createOutboxConsumers } from './workers/outbox-consumers';
import { createOutboxPublisher } from './workers/outbox-publisher';
import { startWorkers } from './workers/workers';
import { DOCUMENT_FILE_PORT } from './modules/doc/file-port';
import type { DocumentFilePort } from './modules/doc/file-port';
import type { RunningWorkers } from './workers/workers';

/** Sets the operation id of the handler on the request, so the request span can name it (an allowlisted attribute). */
@Injectable()
class OperationNameInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<{ operationId?: string }>();
    const operation = operationIdOf(context.getHandler());
    if (operation !== undefined) request.operationId = operation;
    return next.handle();
  }
}

export interface BootstrapOverrides {
  /** Replaces the span exporter chosen by the configuration (tests). */
  exporter?: SpanExporter;
  /** Replaces the readiness probe (tests); the default asks the control-plane pool. */
  probe?: ReadinessProbe;
  /** Port to listen on; `0` picks a free one. Defaults to the configured port. */
  port?: number;
  fetch?: typeof fetch;
  /** Replaces the alert sink of the process (the log and, when configured, the webhook); tests record what is raised. */
  alerts?: AlertSink;
  /** The clock of the scheduled jobs; tests turn it by hand instead of waiting for an interval. */
  timers?: TimerPort;
  /** Where the log line of a failed worker tick goes; defaults to standard error. */
  workerLog?: (line: string) => void;
  /** The infrastructure the provisioning saga acts on; defaults to the in-memory MOCK adapters until the real ones exist. */
  provisioningPorts?: ProvisioningPorts;
  /** Runs the provisioning workflows; defaults to the in-process runner. Shutdown waits for it to be idle before the pools close. */
  workflowRunner?: WorkflowRunner;
}

export interface RunningApi {
  app: NestExpressApplication;
  port: number;
  tracer: Tracer;
  /** The background workers (outbox relay and scheduled jobs); undefined when `WORKERS_ENABLED` is off. */
  workers: RunningWorkers | undefined;
  /**
   * Graceful shutdown: stops accepting connections, lets in-flight requests finish (up to the configured timeout), stops
   * the timers of the workers and waits for the tick in flight, then closes the pools. Safe to call twice.
   */
  stop(): Promise<void>;
}

/** Waits until the runner is idle or the time is up, whichever comes first; the timer never outlives the wait. */
async function drainWorkflows(runner: WorkflowRunner, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<void>((done) => {
    timer = setTimeout(done, timeoutMs);
  });
  try {
    await Promise.race([runner.idle(), expired]);
  } finally {
    clearTimeout(timer);
  }
}

export function exporterOf(config: Config, overrides: BootstrapOverrides): SpanExporter {
  if (overrides.exporter !== undefined) return overrides.exporter;
  const { exporter, otlpEndpoint, serviceName } = config.telemetry;
  if (exporter === 'console') return new ConsoleSpanExporter();
  if (exporter === 'otlp' && otlpEndpoint !== undefined) return new OtlpHttpSpanExporter({ endpoint: otlpEndpoint, serviceName, ...(overrides.fetch === undefined ? {} : { fetch: overrides.fetch }) });
  // Telemetry switched off: spans are dropped. An in-memory exporter here would keep every request span for the life of the process.
  return new NoopSpanExporter();
}

/**
 * Builds and starts the API from a validated configuration: the database pools (one per role, plus the relay role for the workers), the real
 * authentication guard (identity provider keys, tenant tokens of this API), the policy decision point, tenant selection,
 * the command pipeline, the health checks and the request telemetry. Unless `WORKERS_ENABLED` is off it also starts the
 * background workers once the server listens: the outbox relay with its consumers and the scheduled jobs, all raising
 * through the one alert sink of the process (see docs/runbooks/jobs.md).
 */
export async function bootstrap(config: Config, overrides: BootstrapOverrides = {}): Promise<RunningApi> {
  const pools = {
    app: new Pool({ connectionString: config.databaseUrls.app, max: 10 }),
    control: new Pool({ connectionString: config.databaseUrls.control, max: 4 }),
    // The relay role reads every tenant's outbox; the same role holds the job locks (advisory locks need no privilege).
    relay: new Pool({ connectionString: config.databaseUrls.outboxRelay, max: 2 }),
    locks: new Pool({ connectionString: config.databaseUrls.outboxRelay, max: 6 }),
  };
  for (const pool of Object.values(pools)) pool.on('error', () => undefined);
  const closePools = (): Promise<unknown> => Promise.all(Object.values(pools).map((pool) => pool.end()));
  let app: NestExpressApplication | undefined;
  let workers: RunningWorkers | undefined;
  // The provisioning sagas run detached from the relay tick that delivered their event: shutdown has to wait for them itself.
  const workflowRunner = overrides.workflowRunner ?? new InProcessWorkflowRunner();
  try {
    const tenants = new TenantDatabase(pools.app);
    const control = new ControlDatabase(pools.control);
    const authzCache = new InMemoryAuthzCache();
    const entitlementCache = new InMemoryEntitlementCache();
    const registry = new TenantRegistry(control);
    const entitlementStore = new EntitlementStore(tenants, entitlementCache);
    const alerts = overrides.alerts ?? createAlertSink(config);
    const tenantRuntime = new DatabaseTenantRuntime(tenants);
    const access = new EffectiveAccessStore(tenants, authzCache);
    const sessions = new UserSessionStore(tenants);
    const denyList = new UserSessionDenyList(sessions);
    const issuer = new LocalTenantTokenIssuer({
      issuer: config.tenantToken.issuer,
      signingKey: issuerKeyFromPem(config.tenantToken.signingKeyPem, config.tenantToken.keyId),
      ...(config.tenantToken.retired === undefined ? {} : { retiredKeys: [issuerKeyFromPem(config.tenantToken.retired.pem, config.tenantToken.retired.keyId)] }),
    });
    const jwksUri = config.oidc.jwksUri ?? (await discoverJwksUri(config.oidc.issuer, overrides.fetch));
    const verifier = new JwksTokenVerifier({
      issuer: config.oidc.issuer,
      identityAudience: config.oidc.identityAudience,
      controlAudience: config.oidc.controlAudience,
      jwks: new HttpJwksSource({ jwksUri }),
      tenantTokenKeys: async () => (await issuer.publicKeys()).keys,
      tenantIssuer: config.tenantToken.issuer,
    });
    const authOptions: AuthGuardOptions = { verifier, denyList, controlAudience: config.oidc.controlAudience };
    const tracer = new Tracer({ exporter: exporterOf(config, overrides) });
    const probe = overrides.probe ?? new DatabaseReadinessProbe(pools.control, () => expectedMigrations(config.migrationsDir));

    @Module({
      imports: [
        AppModule.register({
          database: tenants,
          registry: loadErrorRegistry(config.errorCodesPath),
          auth: authOptions,
          policy: { database: tenants, access, denyList },
          session: { verifier, control, tenants, sessions, issuer, denyList },
          control: { database: control, registry },
          entitlements: { store: entitlementStore, control },
          tenantState: { runtime: tenantRuntime, entitlementCache, authzCache },
          // The drill tokens of BI are signed from a configured secret, so that every replica and every restart reads them.
          biDrillSecret: config.outboxSigningKey,
        }),
      ],
      controllers: [HealthController],
      providers: [
        { provide: READINESS_PROBE, useValue: probe },
        { provide: APP_INTERCEPTOR, useClass: OperationNameInterceptor },
      ],
    })
    class RootModule {}

    app = await NestFactory.create<NestExpressApplication>(RootModule, { bodyParser: false, rawBody: true, logger: ['error', 'warn'] });
    app.use(requestTelemetry(tracer));
    // The body size limit applies before any route parses a body; an oversized body is a 413 problem, never a crash.
    app.useBodyParser('json', { limit: config.maxBodyBytes });
    app.enableCors({
      origin: config.corsOrigins.length === 0 ? false : [...config.corsOrigins],
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'if-match', 'x-correlation-id', 'x-tenant-host', 'traceparent'],
      exposedHeaders: ['x-correlation-id', 'x-request-id', 'etag', 'retry-after', 'idempotency-replayed'],
      maxAge: 600,
    });
    app.disable('x-powered-by');
    await app.listen(overrides.port ?? config.port);
    const address = app.getHttpServer().address() as { port: number };
    if (config.workersEnabled) {
      const security = { signingKey: config.outboxSigningKey, alerts };
      const provisioning = createProvisioningConsumer({
        tenants,
        registry,
        services: {
          control,
          entitlements: entitlementStore,
          licenses: new LicenseStore(entitlementStore),
          keys: new EnvironmentLicenseKeyStore(config.licenseKeys),
          themes: new ThemeStore(),
          bootstrap: new TenantBootstrapStore(),
          audit: new AuditWriter(tenants),
          // The invitation of the first owner goes through the mailer of the application, like every other invitation.
          mailer: app.get<InvitationMailer>(INVITATION_MAILER, { strict: false }),
        },
        ports: overrides.provisioningPorts ?? new MockProvisioningPorts(),
        security,
        runner: workflowRunner,
      });
      // The delivery engine and the adapters are the ones the controllers use (the webhook, replay and cancel): the dispatcher of the workers must not own a second set.
      const delivery = app.get<DeliveryEngine>(DELIVERY_ENGINE, { strict: false });
      const dispatcher = new DeliveryDispatcher(
        {
          database: tenants,
          engine: delivery,
          adapters: app.get<ChannelAdapterRegistry>(CHANNEL_ADAPTERS, { strict: false }),
          loadAccess: (ctx) => access.load(ctx),
          resourceAccess: new PermissionResourceAccess(),
          alerts,
          pushTokens: app.get<PushTokenVault>(PUSH_TOKEN_VAULT, { strict: false }),
          // What agents say in conversations goes out in the same pass, through the same adapters (ST-OMNI-005).
          conversations: new ConversationSender({ database: tenants, adapters: app.get<ChannelAdapterRegistry>(CHANNEL_ADAPTERS, { strict: false }), webBaseUrl: config.webBaseUrl, alerts }),
        },
        process.env.MACHVON_ENVIRONMENT,
      );
      // The issue requests of the source modules (DOC): the same service that answers the REST port, with the same file store.
      const docIssue = new DocumentIssueConsumer({ database: tenants, service: app.get(DocumentIssueService, { strict: false }), security });
      const consumers = createOutboxConsumers({
        tenants,
        control,
        access,
        entitlementCache,
        authzCache,
        tenantRuntime,
        security,
        provisioning,
        delivery,
        docIssue,
        channelVerification: { verifier: app.get<ChannelVerifierPort>(CHANNEL_VERIFIER, { strict: false }), alerts },
        silentPush: { adapters: app.get<ChannelAdapterRegistry>(CHANNEL_ADAPTERS, { strict: false }), vault: app.get<PushTokenVault>(PUSH_TOKEN_VAULT, { strict: false }) },
      });
      workers = startWorkers(
        {
          tenants,
          control,
          relayPool: pools.relay,
          lockPool: pools.locks,
          signingKey: config.outboxSigningKey,
          alerts,
          publish: createOutboxPublisher(consumers),
          accessCache: authzCache,
          // The old key of a rotation is revoked at the end of its last day through the same ports the controllers use (ST-LLM-002).
          llmKeys: { litellm: app.get<LiteLlmAdminPort>(LLM_ADMIN, { strict: false }), vault: app.get<SecretVaultPort>(LLM_VAULT, { strict: false }) },
          // The retention job removes the stored payloads of expired inbox events through the same object store the API serves (ST-ADM-017).
          payloads: app.get(FileService, { strict: false }),
          // The exports of the data of a tenant are written to the same object store and read from it for the attachments (ST-SAS-016).
          exportFiles: app.get(FileService, { strict: false }),
          documentFiles: app.get<DocumentFilePort>(DOCUMENT_FILE_PORT, { strict: false }),
          // The adapters that modules register for their inbound provider events are served by the inbox job (ST-ADM-018).
          inboxHandlers: app.get<InboxHandlerRegistry>(ADM_INBOX_HANDLERS, { strict: false }),
          // The sends that are due go out, and the ones whose result was lost are asked about (ST-NOT-002).
          notificationDelivery: dispatcher,
        },
        { ...(overrides.timers === undefined ? {} : { timers: overrides.timers }), ...(overrides.workerLog === undefined ? {} : { log: overrides.workerLog }) },
      );
    }
    let stopping: Promise<void> | undefined;
    const stop = (): Promise<void> => {
      stopping ??= (async () => {
        const server = app?.getHttpServer() as { closeIdleConnections?: () => void; closeAllConnections?: () => void } | undefined;
        const timer = setTimeout(() => server?.closeAllConnections?.(), config.shutdownTimeoutMs);
        try {
          // `close` stops accepting and resolves once in-flight requests have finished; idle keep-alive sockets are dropped at once.
          const closing = app?.close();
          server?.closeIdleConnections?.();
          // The timers stop at once; the tick in flight (a relay batch, a seal) is awaited before the pools it uses are closed.
          await Promise.all([closing, workers?.stop()]);
          // The relay is stopped, so no new workflow starts. The running ones use the pools: wait for them (bounded by the shutdown
          // timeout, a saga in its retry back-off must not hold the process) before the pools close under their next step.
          await drainWorkflows(workflowRunner, config.shutdownTimeoutMs);
          await tracer.shutdown();
        } finally {
          clearTimeout(timer);
          await closePools();
        }
      })();
      return stopping;
    };
    return { app, port: address.port, tracer, workers, stop };
  } catch (error) {
    await app?.close().catch(() => undefined);
    await closePools().catch(() => undefined);
    throw error;
  }
}
