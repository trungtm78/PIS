import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { SyncAttachmentStore, SyncReceiptStore, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import type { SyncAttachmentRecord } from '@machvon/db';
import {
  ATTACHMENT_CHUNK_BYTES,
  DomainError,
  MAX_PRESIGN_TTL_SECONDS,
  assembledMatches,
  assertInit,
  assertLooksLike,
  chunkCountOf,
  chunkSizeAt,
  missingChunks,
  objectKey,
} from '@machvon/kernel';
import type { TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../command.decorator';
import { commandResult } from '../command-result';
import type { CommandResult } from '../command-result';
import type { CommandScope } from '../command-scope';
import type { Schemas } from '../contract-types';
import { FileService } from '../modules/files';
import { OperationId } from '../operation-id.decorator';
import { Public } from '../public.decorator';
import { CurrentTenant } from '../tenant-context.decorator';

const ATTACHMENT_KIND = 'sync_attachment';
const PART_KIND = 'sync_chunk';
const SIGNATURE = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The most that is read from a chunk body that is too long before the connection is cut. */
const DRAIN_LIMIT = 8 * ATTACHMENT_CHUNK_BYTES;

const partKeyOf = (tenantId: string, attachmentId: string, epoch: number, index: number): string => objectKey(tenantId, PART_KIND, `${attachmentId}-${epoch}-${index}`);

/** Reads the body of a chunk as it is, up to the size the chunk must have: a longer one is refused as soon as it is seen. */
async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let total = 0;
  for await (const part of request) {
    const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part as string);
    total += buffer.length;
    // A body that is too long is read to its end and thrown away (never kept), so that the connection can answer; a body that never ends is cut at a hard limit.
    if (total > DRAIN_LIMIT) throw new DomainError('PAYLOAD_TOO_LARGE', 413);
    if (total <= maxBytes) parts.push(buffer);
  }
  if (total > maxBytes) throw new DomainError('PAYLOAD_TOO_LARGE', 413);
  return Buffer.concat(parts, total);
}

/**
 * The attachments a phone uploads in chunks (ST-MOB-009, MOB 5, 7). The phone starts an upload (`post_sync_attachments`) and gets a link for each chunk, signed for that chunk and the tenant and valid for a few minutes;
 * it sends the chunks to those links in any order, as often as it needs (an interrupted upload asks `get_sync_attachments_id` which chunks the server holds and gets fresh links for the others); and it completes the upload
 * (`post_sync_attachments_id_complete`): the server puts the chunks together, compares the size and the SHA-256 with what was declared, judges the file by its bytes, has it scanned, and the attachment is CLEAN or
 * INFECTED. Only a CLEAN attachment is linked to a record. Every key is under `tenants/{tenant_id}/`.
 */
@Controller()
export class SyncAttachmentsController {
  private readonly store = new SyncAttachmentStore();
  private readonly receipts = new SyncReceiptStore();

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Inject(FileService) private readonly files: FileService,
  ) {}

  @Post('sync/attachments')
  @HttpCode(200)
  @OperationId('post_sync_attachments')
  @Command({ operation: 'post_sync_attachments', ttl: 'extended' })
  async start(@Scope() scope: CommandScope, @Body() body: Schemas['SyncAttachmentInit']): Promise<Schemas['SyncAttachmentStarted']> {
    // A phone uploads for its own member, from a device it still has registered.
    if (!(await this.receipts.ownsLiveDevice(scope.tx, body.device_id, scope.tenant.membershipId))) throw new DomainError('SCOPE_DENIED', 403);
    const declared = assertInit(body);
    const id = randomUUID();
    const record = await this.store.create(scope.tx, {
      id,
      deviceId: body.device_id,
      membershipId: scope.tenant.membershipId,
      sha256: declared.sha256,
      sizeBytes: declared.sizeBytes,
      mime: declared.mime,
      chunkBytes: ATTACHMENT_CHUNK_BYTES,
      storageKey: objectKey(scope.tenant.tenantId, ATTACHMENT_KIND, id),
    });
    await scope.audit({
      action: 'sync.attachment_started',
      resourceType: 'sync_attachment',
      resourceId: id,
      classification: 'INTERNAL',
      // The size and the type: not the checksum, not the key of the file.
      diff: { size_bytes: declared.sizeBytes, mime: declared.mime, chunk_count: chunkCountOf(declared.sizeBytes) },
    });
    const links = this.linksFor(scope.tenant.tenantId, record);
    return { ...commandResult(scope, 'UPLOADING', 1, id), status: 'UPLOADING', chunk_bytes: record.chunkBytes, chunk_count: chunkCountOf(record.sizeBytes, record.chunkBytes), expires_at: links.expiresAt, chunks: links.chunks };
  }

  @Get('sync/attachments/:id')
  @OperationId('get_sync_attachments_id')
  async status(@CurrentTenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<Schemas['SyncAttachmentStatus']> {
    const record = await this.database.withTenant(tenant, (tx) => this.store.own(tx, id.toLowerCase(), tenant.membershipId));
    const links = record.status === 'UPLOADING' ? this.linksFor(tenant.tenantId, record) : undefined;
    return {
      id: record.id,
      status: record.status,
      size_bytes: record.sizeBytes,
      chunk_bytes: record.chunkBytes,
      chunk_count: chunkCountOf(record.sizeBytes, record.chunkBytes),
      received: record.received,
      reason: record.reason ?? null,
      expires_at: links?.expiresAt ?? null,
      chunks: links?.chunks ?? [],
    };
  }

  /**
   * The link of a chunk: it keeps the bytes while the signature is good and the time has not run out, and nothing else (a forged, altered, expired or foreign link all answer the same 401 SIGNATURE_INVALID). It names no
   * person: the member was judged when the link was issued. A chunk has exactly its size, and the same chunk sent again is the same chunk.
   */
  @Public()
  @Put('sync/attachments/:id/chunks/:index')
  @HttpCode(200)
  async chunk(
    @Req() request: IncomingMessage,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('index') indexText: string,
    @Query('tenant') tenantId: unknown,
    @Query('expires') expires: unknown,
    @Query('signature') signature: unknown,
    @Query('epoch') epochText: unknown,
  ): Promise<{ received: number }> {
    const invalid = (): DomainError => new DomainError('SIGNATURE_INVALID', 401);
    if (typeof tenantId !== 'string' || typeof expires !== 'string' || typeof signature !== 'string' || !UUID.test(tenantId) || !SIGNATURE.test(signature) || !/^[0-9]{1,12}$/.test(expires) || !/^[0-9]{1,4}$/.test(indexText) || typeof epochText !== 'string' || !/^[0-9]{1,6}$/.test(epochText)) throw invalid();
    const index = Number(indexText);
    const epoch = Number(epochText);
    const attachmentId = id.toLowerCase();
    const key = partKeyOf(tenantId, attachmentId, epoch, index);
    const link = (() => {
      try {
        return this.files.redeemUpload({ method: 'PUT', key, expires: Number(expires), signature });
      } catch (error) {
        throw error instanceof DomainError ? error : invalid();
      }
    })();
    const context: TenantContext = { tenantId: link.tenantId, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 };
    // The body is read before anything is locked: a slow phone holds no lock.
    const known = await this.database.withTenant(context, (tx) => this.store.find(tx, attachmentId));
    // The link named an upload that is not there for this tenant: it is not one.
    if (known === undefined) throw invalid();
    const expected = chunkSizeAt(known.sizeBytes, index, known.chunkBytes);
    const bytes = await readBody(request, expected);
    if (bytes.length !== expected) throw new DomainError('VALIDATION_FAILED', 422, 'chunk');
    // The chunk is kept and acknowledged with the upload locked, in the generation its link was issued for: the completion takes the same lock, so it sees every chunk that was acknowledged and none that is lost to its cleanup.
    return this.database.withTenant(context, async (tx) => {
      const record = await this.store.find(tx, attachmentId, { lock: true });
      if (record === undefined) throw invalid();
      if (record.status !== 'UPLOADING' || record.epoch !== epoch) throw new DomainError('ATTACHMENT_STATE_INVALID', 409);
      await this.files.storePart(link.tenantId, key, bytes);
      const received = await this.store.chunkReceived(tx, attachmentId, index);
      return { received: received.length };
    });
  }

  @Post('sync/attachments/:id/complete')
  @HttpCode(200)
  @OperationId('post_sync_attachments_id_complete')
  @Command({ operation: 'post_sync_attachments_id_complete', ttl: 'extended' })
  async complete(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['SyncAttachmentComplete']): Promise<CommandResult> {
    const record = await this.store.own(scope.tx, id.toLowerCase(), scope.tenant.membershipId, { lock: true });
    if (record.status !== 'UPLOADING') throw new DomainError('ATTACHMENT_STATE_INVALID', 409);
    const missing = missingChunks(record.sizeBytes, record.received, record.chunkBytes);
    if (missing.length > 0) throw new DomainError('ATTACHMENT_CHUNKS_MISSING', 409, undefined, { extensions: { missing } });
    const parts: Uint8Array[] = [];
    for (let index = 0; index < chunkCountOf(record.sizeBytes, record.chunkBytes); index += 1) {
      const part = await this.files.readPart(scope.tenant.tenantId, partKeyOf(scope.tenant.tenantId, record.id, record.epoch, index));
      if (part === undefined) throw new DomainError('ATTACHMENT_CHUNKS_MISSING', 409, undefined, { extensions: { missing: [index] } });
      parts.push(part);
    }
    const bytes = Buffer.concat(parts);
    // What was sent must be what was declared when the upload began, and what the phone says now: the size, and the SHA-256 of the whole.
    if (body.sha256 !== record.sha256 || !assembledMatches(bytes, { sha256: record.sha256, sizeBytes: record.sizeBytes, mime: record.mime })) {
      await this.store.resetChunks(scope.tx, record.id);
      this.dropParts(scope, record);
      await this.refused(scope, record, 'CHECKSUM_MISMATCH');
      // The chunks are dropped in this transaction, so it is committed and then the phone is told why (the same way as a diary conflict).
      scope.refuseAfterCommit(new DomainError('CHECKSUM_MISMATCH', 422, 'sha256'));
      return commandResult(scope, 'REFUSED', 1, record.id);
    }
    try {
      assertLooksLike(bytes, record.mime);
    } catch (error) {
      await this.store.resetChunks(scope.tx, record.id);
      this.dropParts(scope, record);
      await this.refused(scope, record, (error as DomainError).code);
      scope.refuseAfterCommit(error as DomainError);
      return commandResult(scope, 'REFUSED', 1, record.id);
    }
    await this.store.startScan(scope.tx, record.id);
    // The file is stored under the key the upload was given, and the row decides what it is: if this attempt does not commit, nothing refers to what it stored (the row is still UPLOADING with its chunks), and the next
    // attempt stores the same file under the same key. Nothing is removed on a rollback, so a failed attempt can never remove the file that another one stored.
    const verdict = await this.files.storeAndScan(scope.tenant, record.storageKey, bytes, record.mime);
    // No verdict (the scanner is not configured or away): the file is neither clean nor infected. Nothing is settled and the request is refused with 409 SCAN_PENDING, so this attempt rolls back and the phone completes the upload again later (closed by default).
    if (verdict === 'PENDING') throw new DomainError('SCAN_PENDING', 409);
    const settled = await this.store.settle(scope.tx, record.id, verdict === 'CLEAN' ? 'CLEAN' : 'INFECTED');
    this.dropParts(scope, record);
    await scope.audit({
      action: 'sync.attachment_completed',
      resourceType: 'sync_attachment',
      resourceId: record.id,
      classification: 'INTERNAL',
      diff: { status: settled.status, size_bytes: record.sizeBytes, mime: record.mime },
    });
    if (settled.status === 'CLEAN') {
      await scope.emit({
        aggregateType: 'sync_attachment',
        aggregateId: record.id,
        aggregateVersion: 1,
        type: 'sync.attachment_clean.v1',
        schemaVersion: 1,
        payload: { tenant_id: scope.tenant.tenantId, attachment_id: record.id, size_bytes: record.sizeBytes, mime: record.mime },
        eventKey: `sync.attachment_clean.v1:${record.id}`,
      });
    }
    return commandResult(scope, settled.status, 1, record.id);
  }

  private async refused(scope: CommandScope, record: SyncAttachmentRecord, code: string): Promise<void> {
    await scope.audit({ action: 'sync.attachment_refused', resourceType: 'sync_attachment', resourceId: record.id, classification: 'INTERNAL', diff: { code, size_bytes: record.sizeBytes, mime: record.mime } });
  }

  /** The chunks are not needed once the file is put together, or once they are known to be wrong: they leave the storage after the commit. */
  private dropParts(scope: CommandScope, record: SyncAttachmentRecord): void {
    const count = chunkCountOf(record.sizeBytes, record.chunkBytes);
    scope.afterCommit(async () => {
      for (let index = 0; index < count; index += 1) await this.files.remove(scope.tenant, partKeyOf(scope.tenant.tenantId, record.id, record.epoch, index)).catch(() => false);
    });
  }

  /** A link for each chunk still to send (all of them for a new upload), signed for that chunk and this tenant. */
  private linksFor(tenantId: string, record: SyncAttachmentRecord): { expiresAt: string; chunks: Array<{ index: number; url: string }> } {
    const chunks = missingChunks(record.sizeBytes, record.received, record.chunkBytes).map((index) => {
      const grant = this.files.presignUpload(partKeyOf(tenantId, record.id, record.epoch, index), MAX_PRESIGN_TTL_SECONDS);
      const query = new URLSearchParams({ tenant: tenantId, epoch: String(record.epoch), expires: String(grant.expires), signature: grant.signature });
      return { index, url: `/sync/attachments/${record.id}/chunks/${index}?${query.toString()}`, expires: grant.expires };
    });
    const expiresAt = new Date((chunks[0]?.expires ?? Math.floor(Date.now() / 1000) + MAX_PRESIGN_TTL_SECONDS) * 1000).toISOString();
    return { expiresAt, chunks: chunks.map(({ index, url }) => ({ index, url })) };
  }
}
