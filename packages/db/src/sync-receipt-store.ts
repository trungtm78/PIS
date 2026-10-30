import type { TenantTx } from './tenant-database.ts';

export type ReceiptStatus = 'accepted' | 'rejected' | 'conflict';

export interface SyncReceipt {
  id: string;
  deviceId: string;
  membershipId: string;
  idempotencyKey: string;
  commandType: string;
  status: ReceiptStatus;
  code: string | undefined;
  serverVersion: number | undefined;
  resultRef: string | undefined;
  requestHash: string;
}

interface ReceiptRow {
  id: string;
  device_id: string;
  membership_id: string;
  idempotency_key: string;
  command_type: string;
  status: ReceiptStatus;
  code: string | null;
  server_version: string | null;
  result_ref: string | null;
  request_hash: string;
}

const COLUMNS = 'id, device_id, membership_id, idempotency_key, command_type, status, code, server_version::text as server_version, result_ref, request_hash';

const toReceipt = (row: ReceiptRow): SyncReceipt => ({
  id: row.id,
  deviceId: row.device_id,
  membershipId: row.membership_id,
  idempotencyKey: row.idempotency_key,
  commandType: row.command_type,
  status: row.status,
  code: row.code ?? undefined,
  serverVersion: row.server_version === null ? undefined : Number(row.server_version),
  resultRef: row.result_ref ?? undefined,
  requestHash: row.request_hash,
});

export type NewSyncReceipt = Omit<SyncReceipt, 'id'>;

/**
 * The receipts of the commands that phones queued offline (ST-MOB-005, MOB 6). One receipt per (device, key), written once with the final answer: a key sent again with the same command gets that answer back without the
 * command being carried out twice; the same key with another command is refused by the caller (the hash differs). The lookup of an UNKNOWN command reads the receipt of the person asking, by key.
 */
export class SyncReceiptStore {
  /** Whether the device is a live registration of this member: a phone sends commands for its own member only, and a removed device sends none. */
  async ownsLiveDevice(tx: TenantTx, deviceId: string, membershipId: string): Promise<boolean> {
    const rows = await tx.query('select 1 from machvon.device_registration where id = $1::uuid and membership_id = $2::uuid and revoked_at is null', [deviceId, membershipId]);
    return rows.length > 0;
  }

  async find(tx: TenantTx, deviceId: string, idempotencyKey: string): Promise<SyncReceipt | undefined> {
    const [row] = await tx.query<ReceiptRow>(`select ${COLUMNS} from machvon.sync_command_receipt where device_id = $1::uuid and idempotency_key = $2`, [deviceId, idempotencyKey]);
    return row === undefined ? undefined : toReceipt(row);
  }

  /** Writes the receipt, or returns the one that is already there (two batches that carry the same key at the same moment write one). */
  async record(tx: TenantTx, input: NewSyncReceipt): Promise<{ receipt: SyncReceipt; created: boolean }> {
    const [row] = await tx.query<ReceiptRow>(
      `insert into machvon.sync_command_receipt (tenant_id, id, device_id, membership_id, idempotency_key, command_type, status, code, server_version, result_ref, request_hash)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5, $6, $7::bigint, $8, $9)
       on conflict (tenant_id, device_id, idempotency_key) do nothing returning ${COLUMNS}`,
      [input.deviceId, input.membershipId, input.idempotencyKey, input.commandType, input.status, input.code ?? null, input.serverVersion ?? null, input.resultRef ?? null, input.requestHash],
    );
    if (row !== undefined) return { receipt: toReceipt(row), created: true };
    const existing = await this.find(tx, input.deviceId, input.idempotencyKey);
    if (existing === undefined) throw new Error('the receipt that was there is gone');
    return { receipt: existing, created: false };
  }

  /**
   * Binds the key to the command it was sent with, in the transaction it is given (the caller gives one of its own, committed at once: the claim must outlive a batch that does not commit). Returns the hash the key is bound
   * to: the given one when the key was free or was sent with this same command, another when the key stands for a different command.
   */
  async claim(tx: TenantTx, input: { deviceId: string; idempotencyKey: string; commandType: string; requestHash: string }): Promise<string> {
    const inserted = await tx.query<{ request_hash: string }>(
      `insert into machvon.sync_command_claim (tenant_id, device_id, idempotency_key, command_type, request_hash)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4)
       on conflict (tenant_id, device_id, idempotency_key) do nothing returning request_hash`,
      [input.deviceId, input.idempotencyKey, input.commandType, input.requestHash],
    );
    if (inserted[0] !== undefined) return input.requestHash.trim();
    const [held] = await tx.query<{ request_hash: string }>('select request_hash from machvon.sync_command_claim where device_id = $1::uuid and idempotency_key = $2', [input.deviceId, input.idempotencyKey]);
    return (held?.request_hash ?? input.requestHash).trim();
  }

  /** The latest receipt of this member for the key, on any of their devices. */
  async lookup(tx: TenantTx, membershipId: string, idempotencyKey: string): Promise<SyncReceipt | undefined> {
    const [row] = await tx.query<ReceiptRow>(
      `select ${COLUMNS} from machvon.sync_command_receipt where membership_id = $1::uuid and idempotency_key = $2 order by received_at desc, id desc limit 1`,
      [membershipId, idempotencyKey],
    );
    return row === undefined ? undefined : toReceipt(row);
  }
}
