import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { SyncReceiptStore, TenantDatabase } from '@machvon/db';
import type { SyncReceipt } from '@machvon/db';
import { DomainError, MAX_BATCH_ITEMS, MAX_KEY_LENGTH, MIN_KEY_LENGTH, outcomeOf, planOf, syncRequestHashOf } from '@machvon/kernel';
import type { ItemOutcome } from '@machvon/kernel';
import { Command, Scope } from '../command.decorator';
import type { CommandScope } from '../command-scope';
import type { Schemas } from '../contract-types';
import { OperationId } from '../operation-id.decorator';
import { CurrentTenant } from '../tenant-context.decorator';
import type { TenantContext } from '@machvon/kernel';
import { SyncSlotGuard, SyncSlotInterceptor } from './batch-slots';
import { SYNC_OPERATION_INVOKER, forwardedHeaders } from './operation-invoker';
import type { SyncOperationInvoker } from './operation-invoker';

type Item = Schemas['SyncBatchRequest']['items'][number];
type Result = Schemas['SyncBatchResult']['results'][number];

const CALL_TIMEOUT_MS = 20_000;
const KEY_SHAPE = /^[A-Za-z0-9._:-]+$/;

/**
 * The sync endpoints of the phone (ST-MOB-005, MOB 7). A batch carries commands that were queued offline, each with the key the phone gave it. Every command is carried out through the operation it stands for, as the
 * person who sent the batch (`SyncOperationInvoker`), so nothing is trusted for having been queued; every command is answered on its own (accepted, conflict or rejected, with the code of the platform), so one refusal never
 * fails the batch; and every settled command leaves a receipt, so a key sent again is answered from the receipt and never carried out twice, and a command whose answer the phone lost can be looked up by its key.
 */
@Controller()
export class SyncController {
  private readonly receipts = new SyncReceiptStore();

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Inject(SYNC_OPERATION_INVOKER) private readonly invoker: SyncOperationInvoker,
  ) {}

  @Post('sync/batches')
  @UseGuards(SyncSlotGuard)
  @UseInterceptors(SyncSlotInterceptor)
  @HttpCode(200)
  @OperationId('post_sync_batches')
  @Command({ operation: 'post_sync_batches', ttl: 'extended' })
  async submit(@Scope() scope: CommandScope, @Req() request: { headers: Record<string, string | string[] | undefined>; socket: { localPort?: number } }, @Body() body: Schemas['SyncBatchRequest']): Promise<Schemas['SyncBatchResult']> {
    if (body.items.length === 0 || body.items.length > MAX_BATCH_ITEMS) throw new DomainError('VALIDATION_FAILED', 422, 'items');
    // A phone sends for its own member, on a device it still has registered.
    if (!(await this.receipts.ownsLiveDevice(scope.tx, body.device_id, scope.tenant.membershipId))) throw new DomainError('SCOPE_DENIED', 403);
    const port = request.socket.localPort;
    if (port === undefined) throw new DomainError('PROVIDER_UNAVAILABLE', 503);
    // The server calls itself, never an address the request names: the Host header is not used.
    const baseUrl = `http://127.0.0.1:${port}`;
    const headers = forwardedHeaders(request.headers);
    // The keys of the batch are claimed before anything is carried out: a command with the same key in another batch at the same moment waits here until this one has committed its receipts, and then finds them.
    // The locks are taken in one order for every batch, so two batches that share keys cannot wait for each other.
    await this.claim(scope, body.device_id, body.items);
    const results: Result[] = [];
    for (const item of body.items) results.push(await this.carryOut(scope, body.device_id, item, baseUrl, headers));
    await scope.audit({
      action: 'sync.batch_submitted',
      resourceType: 'sync_batch',
      resourceId: body.device_id,
      classification: 'INTERNAL',
      // Counts only: not the keys, not the payloads.
      diff: {
        items: results.length,
        accepted: results.filter((result) => result.status === 'accepted').length,
        conflict: results.filter((result) => result.status === 'conflict').length,
        rejected: results.filter((result) => result.status === 'rejected').length,
      },
    });
    return { results };
  }

  @Get('sync/commands/:idempotencyKey')
  @OperationId('get_sync_commands_key')
  async status(@CurrentTenant() tenant: TenantContext, @Param('idempotencyKey') idempotencyKey: string): Promise<Schemas['SyncCommandStatus']> {
    if (idempotencyKey.length < MIN_KEY_LENGTH || idempotencyKey.length > MAX_KEY_LENGTH || !KEY_SHAPE.test(idempotencyKey)) throw new DomainError('VALIDATION_FAILED', 422, 'idempotencyKey');
    const receipt = await this.database.withTenant(tenant, (tx) => this.receipts.lookup(tx, tenant.membershipId, idempotencyKey));
    if (receipt === undefined) return { status: 'not_received' };
    return { status: receipt.status, ...(receipt.resultRef === undefined ? {} : { result_ref: receipt.resultRef }), ...(receipt.code === undefined ? {} : { code: receipt.code }) };
  }

  private async claim(scope: CommandScope, deviceId: string, items: readonly Item[]): Promise<void> {
    const names = [...new Set(items.map((item) => `sync-command:${scope.tenant.tenantId}:${deviceId}:${item.idempotency_key}`))].sort();
    for (const name of names) await scope.tx.query('select pg_advisory_xact_lock(hashtext($1))', [name]);
  }

  /** One queued command: answered from its receipt if it was settled before, otherwise carried out and, if it is settled, remembered. */
  private async carryOut(scope: CommandScope, deviceId: string, item: Item, baseUrl: string, headers: Record<string, string>): Promise<Result> {
    const key = item.idempotency_key;
    if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH || !KEY_SHAPE.test(key)) return { idempotency_key: key, status: 'rejected', code: 'VALIDATION_FAILED' };
    const hash = syncRequestHashOf(item);
    const earlier = await this.receipts.find(scope.tx, deviceId, key);
    if (earlier !== undefined) {
      // The same key with another command is not the same command: it is refused, and the first one stands.
      return earlier.requestHash === hash ? resultOf(earlier) : { idempotency_key: key, status: 'rejected', code: 'IDEMPOTENCY_CONFLICT' };
    }
    let outcome: ItemOutcome;
    try {
      const plan = planOf(item.command_type, item.payload, item.base_server_version);
      // The key is bound to this command in a transaction of its own, before the command is forwarded: if the answer is lost, the key still cannot stand for another command in a later batch.
      const bound = await this.database.withTenant(scope.tenant, (tx) => this.receipts.claim(tx, { deviceId, idempotencyKey: key, commandType: item.command_type, requestHash: hash }));
      if (bound !== hash) return { idempotency_key: key, status: 'rejected', code: 'IDEMPOTENCY_CONFLICT' };
      const answer = await this.invoker.invoke({
        baseUrl,
        path: plan.path,
        body: plan.body,
        idempotencyKey: key,
        ifMatch: plan.versioned ? `"${item.base_server_version}"` : undefined,
        headers,
        timeoutMs: CALL_TIMEOUT_MS,
      });
      outcome = outcomeOf(answer.status, answer.body);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      // A command that cannot be carried out as written is refused for good, and remembered.
      outcome = { kind: 'rejected', code: error.code };
    }
    if (outcome.kind === 'transient') return { idempotency_key: key, status: 'rejected', code: outcome.code };
    const base = { deviceId, membershipId: scope.tenant.membershipId, idempotencyKey: key, commandType: item.command_type, requestHash: hash };
    const written =
      outcome.kind === 'accepted'
        ? await this.receipts.record(scope.tx, { ...base, status: 'accepted', code: undefined, serverVersion: outcome.serverVersion, resultRef: outcome.resultRef })
        : outcome.kind === 'conflict'
          ? await this.receipts.record(scope.tx, { ...base, status: 'conflict', code: outcome.code, serverVersion: outcome.serverVersion, resultRef: undefined })
          : await this.receipts.record(scope.tx, { ...base, status: 'rejected', code: outcome.code, serverVersion: undefined, resultRef: undefined });
    if (written.created) await this.announce(scope, written.receipt);
    return resultOf(written.receipt);
  }

  private async announce(scope: CommandScope, receipt: SyncReceipt): Promise<void> {
    if (receipt.status === 'conflict') return;
    const type = receipt.status === 'accepted' ? 'sync.command_accepted.v1' : 'sync.command_rejected.v1';
    await scope.emit({
      aggregateType: 'sync_command',
      aggregateId: receipt.id,
      aggregateVersion: 1,
      type,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, device_id: receipt.deviceId, command_type: receipt.commandType, idempotency_key: receipt.idempotencyKey, ...(receipt.resultRef === undefined ? {} : { result_ref: receipt.resultRef }), ...(receipt.code === undefined ? {} : { code: receipt.code }) },
      eventKey: `${type}:${receipt.deviceId}:${receipt.idempotencyKey}`,
    });
  }
}

function resultOf(receipt: SyncReceipt): Result {
  return {
    idempotency_key: receipt.idempotencyKey,
    status: receipt.status,
    ...(receipt.code === undefined ? {} : { code: receipt.code }),
    ...(receipt.serverVersion === undefined ? {} : { server_version: receipt.serverVersion }),
  };
}
