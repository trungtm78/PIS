import { DomainError, assertAttachmentLinkable } from '@machvon/kernel';
import type { AttachmentStatus } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

export interface SyncAttachmentRecord {
  id: string;
  deviceId: string;
  membershipId: string;
  sha256: string;
  sizeBytes: number;
  mime: string;
  chunkBytes: number;
  status: AttachmentStatus;
  storageKey: string;
  received: number[];
  /** The generation of the chunks: a chunk belongs to the generation its link was issued for. */
  epoch: number;
  reason: string | undefined;
}

interface Row {
  id: string;
  device_id: string;
  membership_id: string;
  sha256: string;
  size_bytes: string;
  mime: string;
  chunk_bytes: number;
  status: AttachmentStatus;
  storage_key: string;
  received: number[];
  epoch: number;
  reason: string | null;
}

const COLUMNS = 'id, device_id, membership_id, sha256, size_bytes::text as size_bytes, mime, chunk_bytes, status, storage_key, received, epoch, reason';

const toRecord = (row: Row): SyncAttachmentRecord => ({
  id: row.id,
  deviceId: row.device_id,
  membershipId: row.membership_id,
  sha256: row.sha256.trim(),
  sizeBytes: Number(row.size_bytes),
  mime: row.mime,
  chunkBytes: row.chunk_bytes,
  status: row.status,
  storageKey: row.storage_key,
  received: [...row.received].sort((a, b) => a - b),
  epoch: row.epoch,
  reason: row.reason ?? undefined,
});

/**
 * The attachments of the phones (ST-MOB-009). One row per upload: UPLOADING while chunks arrive, SCANNING while the put-together file is looked at, then CLEAN or INFECTED for good. A file is linked to a record only
 * when it is CLEAN (`linkableKey`).
 */
export class SyncAttachmentStore {
  async create(tx: TenantTx, input: { id: string; deviceId: string; membershipId: string; sha256: string; sizeBytes: number; mime: string; chunkBytes: number; storageKey: string }): Promise<SyncAttachmentRecord> {
    const [row] = await tx.query<Row>(
      `insert into machvon.sync_attachment (tenant_id, id, device_id, membership_id, sha256, size_bytes, mime, chunk_bytes, status, storage_key)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4, $5::bigint, $6, $7::int, 'UPLOADING', $8) returning ${COLUMNS}`,
      [input.id, input.deviceId, input.membershipId, input.sha256, input.sizeBytes, input.mime, input.chunkBytes, input.storageKey],
    );
    return toRecord(row as Row);
  }

  async find(tx: TenantTx, id: string, options: { lock?: boolean } = {}): Promise<SyncAttachmentRecord | undefined> {
    const [row] = await tx.query<Row>(`select ${COLUMNS} from machvon.sync_attachment where id = $1::uuid${options.lock === true ? ' for update' : ''}`, [id]);
    return row === undefined ? undefined : toRecord(row);
  }

  /** One of this member's own uploads, or 404 (an upload of another member, and one that does not exist, look the same). */
  async own(tx: TenantTx, id: string, membershipId: string, options: { lock?: boolean } = {}): Promise<SyncAttachmentRecord> {
    const found = await this.find(tx, id, options);
    if (found === undefined || found.membershipId !== membershipId) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return found;
  }

  /** Notes that a chunk has arrived (the same chunk twice is one), while the file is being uploaded. */
  async chunkReceived(tx: TenantTx, id: string, index: number): Promise<number[]> {
    const rows = await tx.query<{ received: number[] }>(
      "update machvon.sync_attachment set received = array(select distinct chunk from unnest(received || $2::int) as parts(chunk) order by chunk) where id = $1::uuid and status = 'UPLOADING' returning received",
      [id, index],
    );
    if (rows[0] === undefined) throw new DomainError('ATTACHMENT_STATE_INVALID', 409);
    return [...rows[0].received].sort((a, b) => a - b);
  }

  /** The put-together file did not match what was declared: the chunks are dropped so that the phone sends them again, under a new generation (the links of the old one stop working). */
  async resetChunks(tx: TenantTx, id: string): Promise<void> {
    await tx.query("update machvon.sync_attachment set received = '{}', epoch = epoch + 1 where id = $1::uuid and status = 'UPLOADING'", [id]);
  }

  async startScan(tx: TenantTx, id: string): Promise<void> {
    await tx.query("update machvon.sync_attachment set status = 'SCANNING' where id = $1::uuid and status = 'UPLOADING'", [id]);
  }

  async settle(tx: TenantTx, id: string, verdict: 'CLEAN' | 'INFECTED'): Promise<SyncAttachmentRecord> {
    const [row] = await tx.query<Row>(
      `update machvon.sync_attachment set status = $2, reason = $3, completed_at = now() where id = $1::uuid and status = 'SCANNING' returning ${COLUMNS}`,
      [id, verdict, verdict === 'INFECTED' ? 'FILE_INFECTED' : null],
    );
    if (row === undefined) throw new DomainError('ATTACHMENT_STATE_INVALID', 409);
    return toRecord(row);
  }

  /** The storage key of an attachment that a module may link to a record: it exists for this tenant and is CLEAN (409 `ATTACHMENT_NOT_CLEAN` otherwise, 404 when there is none). */
  async linkableKey(tx: TenantTx, id: string): Promise<string> {
    const found = await this.find(tx, id);
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    assertAttachmentLinkable(found.status);
    return found.storageKey;
  }
}
