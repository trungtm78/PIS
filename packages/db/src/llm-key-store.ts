import { randomUUID } from 'node:crypto';
import { DomainError } from '@machvon/kernel';
import type { KeyScope } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

export type KeyStatus = 'ACTIVE' | 'ROTATING' | 'REVOKED';

/** A key as the application keeps it: the references are for the server only and are never put in a view. */
export interface KeyRow {
  id: string;
  alias: string;
  fingerprint: string;
  scopeKind: KeyScope;
  budgetId: string | null;
  allowedModelIds: string[];
  rpmLimit: number | null;
  tpmLimit: number | null;
  status: KeyStatus;
  expiresAt: string;
  rotatedFromId: string | null;
  revokedReason: string | null;
  createdBy: string;
  createdAt: string;
  version: number;
  litellmKeyRef: string;
  secretRef: string;
  /** When the vault let go of the secret; null while it still holds it (a revoked key with a null here is taken again by the sweep). */
  secretRemovedAt: string | null;
}

export interface KeyInsert {
  id: string;
  alias: string;
  litellmKeyRef: string;
  fingerprint: string;
  secretRef: string;
  scopeKind: KeyScope;
  budgetId: string | null;
  allowedModelIds: readonly string[];
  rpmLimit: number | null;
  tpmLimit: number | null;
  expiresAt: Date;
  rotatedFromId: string | null;
  actor: string;
}

interface Sql {
  [column: string]: unknown;
  id: string;
  key_alias: string;
  fingerprint: string;
  scope_kind: "UNIT" | "TENANT" | "PROJECT" | "SERVICE";
  budget_id: string | null;
  allowed_model_ids: string[];
  rpm_limit: number | null;
  tpm_limit: number | null;
  status: KeyStatus;
  expires_at: string | number | Date;
  rotated_from_id: string | null;
  revoked_reason: string | null;
  created_by: string;
  created_at: string | number | Date;
  litellm_key_ref: string;
  secret_ref: string;
  secret_removed_at: string | number | Date;
}

const SELECT = `select id, key_alias, litellm_key_ref, fingerprint, secret_ref, scope_kind, budget_id, allowed_model_ids, rpm_limit, tpm_limit, status, expires_at, rotated_from_id, revoked_reason, created_by, created_at, version::text as version, secret_removed_at
  from machvon.ai_virtual_key`;

const toRow = (row: Sql): KeyRow => ({
  id: row.id,
  alias: row.key_alias,
  fingerprint: row.fingerprint,
  scopeKind: row.scope_kind,
  budgetId: row.budget_id,
  allowedModelIds: row.allowed_model_ids,
  rpmLimit: row.rpm_limit,
  tpmLimit: row.tpm_limit,
  status: row.status,
  expiresAt: new Date(row.expires_at).toISOString(),
  rotatedFromId: row.rotated_from_id,
  revokedReason: row.revoked_reason,
  createdBy: row.created_by,
  createdAt: new Date(row.created_at).toISOString(),
  version: Number(row.version),
  litellmKeyRef: row.litellm_key_ref,
  secretRef: row.secret_ref,
  secretRemovedAt: row.secret_removed_at === null ? null : new Date(row.secret_removed_at).toISOString(),
});

/**
 * The virtual keys of the AI gateway (ST-LLM-002, LLM F5): the row keeps the fingerprint of a key and the references to its secret (in the vault) and to the key at LiteLLM; the secret itself is never here. An alias is
 * held by one ACTIVE key (the old key of a rotation keeps its own for its last day); a key goes ACTIVE -> ROTATING -> REVOKED, or ACTIVE -> REVOKED, and a REVOKED key does not come back.
 */
export class LlmKeyStore {
  async list(tx: TenantTx): Promise<KeyRow[]> {
    return (await tx.query<Sql>(`${SELECT} order by created_at desc, id`)).map(toRow);
  }

  async find(tx: TenantTx, id: string, lock = false): Promise<KeyRow | undefined> {
    const rows = await tx.query<Sql>(`${SELECT} where id = $1::uuid${lock ? ' for update' : ''}`, [id]);
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  /**
   * The models named must be the tenant's and APPROVED (MODEL_NOT_APPROVED otherwise); the ids at the provider are what LiteLLM is told. A key is made for models, so a model that was only proposed cannot be reached
   * through one.
   */
  async approvedModels(tx: TenantTx, ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await tx.query<{ id: string; model_id: string; status: string }>('select id, model_id, status from machvon.ai_model where id = any($1::uuid[])', [[...ids]]);
    if (rows.length !== ids.length) throw new DomainError('VALIDATION_FAILED', 422, 'allowed_model_ids');
    if (rows.some((row) => row.status !== 'APPROVED')) throw new DomainError('MODEL_NOT_APPROVED', 422, 'allowed_model_ids');
    return ids.map((id) => (rows.find((row) => row.id === id) as { model_id: string }).model_id);
  }

  async budgetExists(tx: TenantTx, id: string): Promise<boolean> {
    return (await tx.query('select 1 from machvon.ai_budget where id = $1::uuid', [id])).length > 0;
  }

  /** Two keys of one alias made at once are taken in turn, so the second is told the alias is held. */
  async lockAlias(tx: TenantTx, alias: string): Promise<void> {
    await tx.query("select pg_advisory_xact_lock(hashtextextended('llm_key:' || current_setting('app.tenant_id', true) || ':' || $1, 0))", [alias]);
  }

  async aliasHeld(tx: TenantTx, alias: string, exceptId?: string): Promise<boolean> {
    return (await tx.query("select 1 from machvon.ai_virtual_key where key_alias = $1 and status = 'ACTIVE' and ($2::uuid is null or id <> $2::uuid)", [alias, exceptId ?? null])).length > 0;
  }

  async insert(tx: TenantTx, input: KeyInsert): Promise<KeyRow> {
    await tx.query(
      `insert into machvon.ai_virtual_key (tenant_id, id, key_alias, litellm_key_ref, fingerprint, secret_ref, scope_kind, budget_id, allowed_model_ids, rpm_limit, tpm_limit, status, expires_at, rotated_from_id, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4, $5, $6, $7::uuid, $8::jsonb, $9::int, $10::int, 'ACTIVE', $11::timestamptz, $12::uuid, $13::uuid, $13::uuid)`,
      [input.id, input.alias, input.litellmKeyRef, input.fingerprint, input.secretRef, input.scopeKind, input.budgetId, JSON.stringify(input.allowedModelIds), input.rpmLimit, input.tpmLimit, input.expiresAt.toISOString(), input.rotatedFromId, input.actor],
    );
    return (await this.find(tx, input.id)) as KeyRow;
  }

  /**
   * A key that was made at LiteLLM and could not be taken back when its command failed: nothing else knows of it, so it is written down at once, in a transaction of its own, as a key that is
   * already due. The sweep stops it at LiteLLM (again and again, until it is stopped) and takes its secret out of the vault.
   */
  async recordOrphan(tx: TenantTx, input: { id: string; alias: string; litellmKeyRef: string; fingerprint: string; secretRef: string; scopeKind: KeyScope; actor: string }): Promise<void> {
    await tx.query(
      `insert into machvon.ai_virtual_key (tenant_id, id, key_alias, litellm_key_ref, fingerprint, secret_ref, scope_kind, allowed_model_ids, status, expires_at, revoked_reason, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4, $5, $6, '[]'::jsonb, 'ROTATING', now() - interval '1 second', 'CREATION_ABORTED', $7::uuid, $7::uuid)`,
      [input.id, input.alias, input.litellmKeyRef, input.fingerprint, input.secretRef, input.scopeKind, input.actor],
    );
  }

  newId(): string {
    return randomUUID();
  }

  /** The old key of a rotation: it goes on until the moment given and is then revoked by the sweep. */
  async markRotating(tx: TenantTx, id: string, until: Date, actor: string): Promise<KeyRow> {
    await tx.query("update machvon.ai_virtual_key set status = 'ROTATING', expires_at = $2::timestamptz, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid", [id, until.toISOString(), actor]);
    return (await this.find(tx, id)) as KeyRow;
  }

  async markRevoked(tx: TenantTx, id: string, reason: string, actor: string): Promise<KeyRow> {
    await tx.query("update machvon.ai_virtual_key set status = 'REVOKED', revoked_reason = $2, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid", [id, reason, actor]);
    return (await this.find(tx, id)) as KeyRow;
  }

  async markSecretRemoved(tx: TenantTx, id: string): Promise<void> {
    await tx.query('update machvon.ai_virtual_key set secret_removed_at = now() where id = $1::uuid and secret_removed_at is null', [id]);
  }

  /** The revoked keys whose secret the vault still holds: the removal is tried again. */
  async pendingCleanup(tx: TenantTx): Promise<KeyRow[]> {
    return (await tx.query<Sql>(`${SELECT} where status = 'REVOKED' and secret_removed_at is null order by updated_at, id for update skip locked`)).map(toRow);
  }

  /** The keys whose time has come: a ROTATING key at the end of its last day, an ACTIVE key at its expiry. Locked, so that two passes do not take the same key. */
  async due(tx: TenantTx, now: Date): Promise<KeyRow[]> {
    return (await tx.query<Sql>(`${SELECT} where status in ('ACTIVE', 'ROTATING') and expires_at <= $1::timestamptz order by expires_at, id for update skip locked`, [now.toISOString()])).map(toRow);
  }
}
