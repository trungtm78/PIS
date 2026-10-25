import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuditWriter, ControlDatabase, IdempotencyStore, NIL_RESOURCE_ID, TenantDatabase, enqueueOutbox } from '@machvon/db';
import type { CompletedOutcome, StoredResponse, TenantTx } from '@machvon/db';
import { DomainError, asUuid, formatEtag, keyHashOf, parseIdempotencyKey, parseIfMatch, requestHashOf } from '@machvon/kernel';
import type { TenantContext } from '@machvon/kernel';
import { from, lastValueFrom } from 'rxjs';
import type { Observable } from 'rxjs';
import { COMMAND_METADATA_KEY, COMMAND_SCOPE_KEY } from './command.decorator';
import type { CommandOptions } from './command.decorator';
import type { CommandScope } from './command-scope';
import { operationIdOf } from './operation-id.decorator';
import { assertValidBody } from './request-validation';
import { tenantContextOf } from './tenant-context.decorator';

const HTTP_CODE_METADATA = '__httpCode__';
const REPLAYED_HEADER = 'Idempotency-Replayed';
const IN_PROGRESS_RETRY_AFTER = '2';

interface CommandRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  params: Record<string, string>;
  body: unknown;
  tenantContext?: unknown;
  [COMMAND_SCOPE_KEY]?: CommandScope;
}

interface CommandResponse {
  setHeader(name: string, value: string): unknown;
}

function versionOf(body: unknown, field?: string): number | undefined {
  // `version` in a resource body, `resource_version` in the CommandResult every command answers, or the field the command names.
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const version = (field === undefined ? undefined : record[field]) ?? record.version ?? record.resource_version;
  return typeof version === 'number' && Number.isSafeInteger(version) && version >= 0 ? version : undefined;
}

function problemOf(error: DomainError): StoredResponse {
  return { kind: 'problem', code: error.code, status: error.status, detail: error.detail, extensions: error.extensions };
}

/**
 * Runs every @Command handler through the command pipeline (BR-PLT-01, BR-PLT-02): Idempotency-Key and
 * If-Match checks, one tenant transaction in which the handler's effects, its audit row, its outbox events
 * and the stored response commit together, and a settled idempotency record when the transaction rolls back.
 */
@Injectable()
export class CommandInterceptor implements NestInterceptor {
  private readonly logger = new Logger(CommandInterceptor.name);

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Inject(IdempotencyStore) private readonly store: IdempotencyStore,
    @Inject(AuditWriter) private readonly audit: AuditWriter,
    @Optional() @Inject(ControlDatabase) private readonly control?: ControlDatabase,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.get<CommandOptions | undefined>(COMMAND_METADATA_KEY, context.getHandler());
    if (options === undefined) return next.handle();
    return from(this.run(context, next, options));
  }

  private async run(context: ExecutionContext, next: CallHandler, options: CommandOptions): Promise<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<CommandRequest>();
    const response = http.getResponse<CommandResponse>();
    const tenant = tenantContextOf(request);
    const key = parseIdempotencyKey(request.headers['idempotency-key']);
    const ifMatchHeader = options.versioned === true ? request.headers['if-match'] : undefined;
    const expectedVersion = options.versioned === true ? parseIfMatch(ifMatchHeader) : null;
    // A malformed body is refused before anything is stored: no idempotency record, no transaction.
    assertValidBody(operationIdOf(context.getHandler()), request.body);
    const requestHash = requestHashOf({
      body: request.body,
      pathParams: request.params,
      ifMatch: typeof ifMatchHeader === 'string' ? ifMatchHeader : null,
    });

    const begin = await this.store.begin(tenant, {
      operation: options.operation,
      keyHash: keyHashOf(key),
      requestHash,
      ttl: options.ttl ?? 'standard',
    });
    switch (begin.kind) {
      case 'conflict':
        throw new DomainError('IDEMPOTENCY_CONFLICT', 409);
      case 'in_progress':
        throw new DomainError('IDEMPOTENCY_IN_PROGRESS', 409, undefined, { headers: { 'Retry-After': IN_PROGRESS_RETRY_AFTER } });
      case 'replay':
        if (begin.response.kind === 'problem') {
          const { code, status, detail, extensions } = begin.response;
          throw new DomainError(code, status, detail, { extensions, headers: { [REPLAYED_HEADER]: 'true' } });
        }
        response.setHeader(REPLAYED_HEADER, 'true');
        this.setEtag(response, begin.response.body, options.versionField);
        return begin.response.body;
      case 'started':
        break;
    }

    const requestId = randomUUID();
    const correlationId = asUuid(request.headers['x-correlation-id']) ?? randomUUID();
    // The Problem filter reads the same header, so the id in the answer finds the audit row of a denied command.
    request.headers['x-correlation-id'] = correlationId;
    const httpStatus =
      this.reflector.get<number | undefined>(HTTP_CODE_METADATA, context.getHandler()) ?? (request.method === 'POST' ? 201 : 200);
    // An attempt that lost its claim must not settle: the record belongs to the attempt that took it over.
    let ownsRecord = true;
    const afterCommit: Array<() => void | Promise<void>> = [];
    let refusal: DomainError | undefined;
    try {
      const body = await this.runnerFor(options).withTenant(tenant, async (tx) => {
        let audited = 0;
        // The resources the command audited: the idempotency record points at one of them, so a legal hold protects it.
        const touched: Array<{ type: string; id: string }> = [];
        const scope: CommandScope = {
          tx,
          tenant,
          requestId,
          correlationId,
          expectedVersion,
          audit: async (entry) => {
            audited += 1;
            if (entry.resourceId !== NIL_RESOURCE_ID) touched.push({ type: entry.resourceType, id: entry.resourceId });
            return this.audit.recordInTx(tx, tenant.membershipId, { ...entry, correlationId, requestId });
          },
          emit: (event) => enqueueOutbox(tx, { ...event, correlationId }),
          afterCommit: (callback) => {
            afterCommit.push(callback);
          },
          refuseAfterCommit: (error) => {
            refusal ??= error;
          },
        };
        // Fence against a takeover: hold the record's row lock for the whole transaction and stop when it is no longer ours.
        if (!(await this.store.claimInTx(tx, begin.recordId))) {
          ownsRecord = false;
          throw new DomainError('IDEMPOTENCY_IN_PROGRESS', 409, undefined, { headers: { 'Retry-After': IN_PROGRESS_RETRY_AFTER } });
        }
        request[COMMAND_SCOPE_KEY] = scope;
        const result: unknown = await lastValueFrom(next.handle(), { defaultValue: undefined });
        if (audited === 0) throw new Error(`command ${options.operation} wrote no audit entry`);
        // A refusal that is itself a record: what the command wrote commits, and the stored answer is the refusal.
        const answer: Pick<CompletedOutcome, 'httpStatus' | 'response'> = refusal === undefined ? { httpStatus, response: { kind: 'success', body: result } } : { httpStatus: refusal.status, response: problemOf(refusal) };
        await this.store.completeInTx(tx, begin.recordId, { ...answer, ...this.referenceOf(options, touched) });
        return result;
      });
      await this.runAfterCommit(afterCommit, correlationId);
      if (refusal !== undefined) {
        // The record is already completed with the refusal: it is not settled again.
        ownsRecord = false;
        throw refusal;
      }
      this.setEtag(response, body, options.versionField);
      return body;
    } catch (error) {
      if (ownsRecord) await this.settle(tenant, begin.recordId, options.operation, { requestId, correlationId }, error);
      throw error;
    }
  }

  // The control role may not read the legal holds of a tenant, so a control-plane record points at the first audited
  // resource without asking whether a hold contains it; a tenant-plane record lets the store prefer a held resource.
  private referenceOf(options: CommandOptions, touched: ReadonlyArray<{ type: string; id: string }>): Partial<CompletedOutcome> {
    if (options.plane !== 'control') return { touched };
    const first = touched[0];
    return first === undefined ? {} : { resourceType: first.type, resourceId: first.id };
  }

  // The command is committed: a failing callback is logged, the others still run, and the answer stays a success.
  private async runAfterCommit(callbacks: ReadonlyArray<() => void | Promise<void>>, correlationId: string): Promise<void> {
    for (const callback of callbacks) {
      try {
        await callback();
      } catch (callbackError) {
        this.logger.error(callbackError, correlationId);
      }
    }
  }

  // The transaction of the business work: the tenant plane by default, the control plane for `plane: 'control'` commands.
  private runnerFor(options: CommandOptions): { withTenant<T>(ctx: TenantContext, work: (tx: TenantTx) => Promise<T>): Promise<T> } {
    if (options.plane !== 'control') return this.database;
    const control = this.control;
    if (control === undefined) throw new Error(`command ${options.operation} is a control-plane command but no ControlDatabase is registered`);
    return { withTenant: (ctx, work) => control.withTenantOf(ctx.tenantId, work) };
  }

  private setEtag(response: CommandResponse, body: unknown, field?: string): void {
    const version = versionOf(body, field);
    if (version !== undefined) response.setHeader('ETag', formatEtag(version));
  }

  // The business transaction rolled back: a 4xx answer is final and replays; anything else may be retried.
  private async settle(
    tenant: TenantContext,
    recordId: string,
    operation: string,
    ids: { requestId: string; correlationId: string },
    error: unknown,
  ): Promise<void> {
    try {
      if (error instanceof DomainError && error.status >= 400 && error.status < 500) {
        if (error.status === 403) {
          await this.audit.recordDenied(tenant, {
            action: `command.denied:${operation}`,
            resourceType: 'command',
            resourceId: NIL_RESOURCE_ID,
            diff: { operation, code: error.code },
            ...ids,
          });
        }
        await this.store.finishOutsideTx(tenant, recordId, { retryable: false, httpStatus: error.status, response: problemOf(error) });
      } else {
        await this.store.finishOutsideTx(tenant, recordId, { retryable: true });
      }
    } catch (settleError) {
      // The caller still gets the original failure; the record stays IN_PROGRESS until its lock expires.
      this.logger.error(settleError, ids.correlationId);
    }
  }
}
