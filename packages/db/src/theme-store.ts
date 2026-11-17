import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DomainError, canonicalJson, sha256Hex, versionConflict } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

/** The theme of a tenant as the contract `TenantThemeConfig` names it: texts, twelve colours and a logo asset id. */
export type ThemeConfig = Record<string, string | null>;

export interface ThemeVersionRow {
  tenantId: string;
  version: number;
  config: ThemeConfig;
  hash: string;
  sourceVersion: number | null;
  publishedBy: string;
  publishedAt: Date;
  reason: string | null;
}

export interface ThemeDraftRow {
  revision: number;
  config: ThemeConfig;
  updatedBy: string | null;
  updatedAt: Date | null;
}

export interface ThemeChange {
  field: string;
  before: string | null;
  after: string | null;
}

export interface ThemeReviewResult {
  /** The only time the token is shown: the database keeps its hash. */
  token: string;
  expiresAt: Date;
  baseVersion: number;
  candidate: ThemeConfig;
  changes: ThemeChange[];
}

export interface ThemeAssetRow {
  id: string;
  tenantId: string;
  contentHash: string;
  mime: string;
  sizeBytes: number;
  storageKey: string;
  scanStatus: 'pending' | 'clean' | 'rejected';
}

export interface NewThemeAsset {
  tenantId: string;
  id?: string | undefined;
  contentHash: string;
  mime: string;
  sizeBytes: number;
  storageKey: string;
  scanStatus: ThemeAssetRow['scanStatus'];
  createdBy: string;
}

export interface ReviewInput {
  tenantId: string;
  actorId: string;
  baseVersion: number;
  /** A review of the draft names its revision; a rollback names the version it restores and why. */
  draftRevision?: number | undefined;
  sourceVersion?: number | undefined;
  reason?: string | undefined;
  now: Date;
}

export interface PublishInput {
  tenantId: string;
  actorId: string;
  token: string;
  baseVersion: number;
  now: Date;
}

export interface ThemeVersionAnchor {
  version: number;
}

/** A review lives fifteen minutes (SAS 3.12). */
export const REVIEW_LIFETIME_MS = 15 * 60_000;
const MIN_REASON_LENGTH = 10;

const VERSION_COLUMNS = 'tenant_id, version::int as version, config_json, config_hash, source_version::int as source_version, published_by, published_at, reason';

interface VersionSqlRow {
  tenant_id: string;
  version: number;
  config_json: ThemeConfig;
  config_hash: string;
  source_version: number | null;
  published_by: string;
  published_at: Date;
  reason: string | null;
}

interface AssetSqlRow {
  id: string;
  tenant_id: string;
  content_hash: string;
  mime: string;
  size_bytes: string;
  storage_key: string;
  scan_status: ThemeAssetRow['scanStatus'];
}

function toVersion(row: VersionSqlRow): ThemeVersionRow {
  return {
    tenantId: row.tenant_id,
    version: row.version,
    config: row.config_json,
    hash: row.config_hash,
    sourceVersion: row.source_version,
    publishedBy: row.published_by,
    publishedAt: row.published_at,
    reason: row.reason,
  };
}

function toAsset(row: AssetSqlRow): ThemeAssetRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    contentHash: row.content_hash,
    mime: row.mime,
    sizeBytes: Number(row.size_bytes),
    storageKey: row.storage_key,
    scanStatus: row.scan_status,
  };
}

/** The hash a theme is known by: the SHA-256 of its canonical JSON, the same for the same content whatever the key order. */
export function themeHash(config: ThemeConfig): string {
  return sha256Hex(canonicalJson(config));
}

const tokenHashOf = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

/** The fields that differ between two themes, in the order of the contract (the review panel lists them). */
export function themeChanges(before: ThemeConfig, after: ThemeConfig): ThemeChange[] {
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return fields
    .filter((field) => (before[field] ?? null) !== (after[field] ?? null))
    .map((field) => ({ field, before: before[field] ?? null, after: after[field] ?? null }));
}

async function actAs(tx: TenantTx, tenantId: string): Promise<void> {
  await tx.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
}

/**
 * The theme of a tenant (ST-SAS-005, SAS 3.12): a draft per tenant, reviews bound to the person, the tenant, the content and the
 * base version, published versions that never change, and a pointer to the current one. Publishing a draft clears that draft. Only the control plane writes; every
 * method runs in a transaction that acts as the tenant of the theme (`actingAs`), so row-level security confines it to that tenant.
 */
export class ThemeStore {
  /**
   * Runs `work` while the transaction acts as the tenant, then acts as `restoreTenantId` again (the platform tenant of the
   * command). A tenant that does not exist is a plain 404, before anything is read for it.
   */
  async actingAs<T>(tx: TenantTx, tenantId: string, restoreTenantId: string, work: () => Promise<T>): Promise<T> {
    const known = await tx.query('select 1 from machvon.tenant where id = $1::uuid', [tenantId]);
    if (known.length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await actAs(tx, tenantId);
    const result = await work();
    await actAs(tx, restoreTenantId);
    return result;
  }

  /** The first published version of a tenant and its pointer, in one step (the provisioning saga, SAS-006 step THEME_V1). Idempotent. */
  async createInitialVersion(tx: TenantTx, input: { tenantId: string; config: ThemeConfig; publishedBy: string }): Promise<ThemeVersionRow> {
    const existing = await this.currentVersion(tx, input.tenantId);
    if (existing !== undefined) return existing;
    const [row] = await tx.query<VersionSqlRow>(
      `insert into machvon.tenant_theme_version (tenant_id, version, config_json, config_hash, published_by)
       values ($1::uuid, 1, $2::jsonb, $3, $4::uuid) returning ${VERSION_COLUMNS}`,
      [input.tenantId, JSON.stringify(input.config), themeHash(input.config), input.publishedBy],
    );
    await tx.query('insert into machvon.tenant_theme_pointer (tenant_id, current_version) values ($1::uuid, 1)', [input.tenantId]);
    if (row === undefined) throw new Error('theme version was not stored');
    return toVersion(row);
  }

  /** The published version the pointer names; the tenant plane reads it too (its own tenant only, by row-level security). */
  async currentVersion(tx: TenantTx, tenantId: string): Promise<ThemeVersionRow | undefined> {
    const rows = await tx.query<VersionSqlRow>(
      `select v.tenant_id, v.version::int as version, v.config_json, v.config_hash, v.source_version::int as source_version,
              v.published_by, v.published_at, v.reason
         from machvon.tenant_theme_pointer p
         join machvon.tenant_theme_version v on v.tenant_id = p.tenant_id and v.version = p.current_version
        where p.tenant_id = $1::uuid`,
      [tenantId],
    );
    return rows[0] === undefined ? undefined : toVersion(rows[0]);
  }

  async findVersion(tx: TenantTx, tenantId: string, version: number): Promise<ThemeVersionRow | undefined> {
    const rows = await tx.query<VersionSqlRow>(`select ${VERSION_COLUMNS} from machvon.tenant_theme_version where tenant_id = $1::uuid and version = $2::bigint`, [tenantId, version]);
    return rows[0] === undefined ? undefined : toVersion(rows[0]);
  }

  /** Versions newest first; the page anchor is the last version of the page before. */
  async listVersions(tx: TenantTx, tenantId: string, request: { limit: number; after?: ThemeVersionAnchor | undefined }): Promise<ThemeVersionRow[]> {
    const rows = await tx.query<VersionSqlRow>(
      `select ${VERSION_COLUMNS} from machvon.tenant_theme_version
        where tenant_id = $1::uuid and ($2::bigint is null or version < $2::bigint)
        order by version desc limit $3`,
      [tenantId, request.after?.version ?? null, request.limit],
    );
    return rows.map(toVersion);
  }

  /** The draft, or revision 0 holding the published theme when nobody has edited it yet. A tenant without a theme has none: 404. */
  async getDraft(tx: TenantTx, tenantId: string): Promise<ThemeDraftRow> {
    const rows = await tx.query<{ revision: string; config_json: ThemeConfig; updated_by: string; updated_at: Date }>(
      'select revision::text as revision, config_json, updated_by, updated_at from machvon.tenant_theme_draft where tenant_id = $1::uuid',
      [tenantId],
    );
    const draft = rows[0];
    if (draft !== undefined) return { revision: Number(draft.revision), config: draft.config_json, updatedBy: draft.updated_by, updatedAt: draft.updated_at };
    const published = await this.currentVersion(tx, tenantId);
    if (published === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { revision: 0, config: published.config, updatedBy: null, updatedAt: null };
  }

  /** Saves the draft when the revision is the one the editor saw (If-Match); the draft of one tenant never touches another's. */
  async saveDraft(tx: TenantTx, input: { tenantId: string; config: ThemeConfig; expectedRevision: number; actorId: string }): Promise<ThemeDraftRow> {
    const current = await this.getDraft(tx, input.tenantId);
    if (current.revision !== input.expectedRevision) throw versionConflict(current.revision);
    const [row] = await tx.query<{ revision: string; updated_at: Date }>(
      `insert into machvon.tenant_theme_draft (tenant_id, revision, config_json, updated_by)
       values ($1::uuid, $2::bigint, $3::jsonb, $4::uuid)
       on conflict (tenant_id) do update
         set revision = excluded.revision, config_json = excluded.config_json, updated_by = excluded.updated_by, updated_at = now()
         where machvon.tenant_theme_draft.revision = $5::bigint
       returning revision::text as revision, updated_at`,
      [input.tenantId, current.revision + 1, JSON.stringify(input.config), input.actorId, current.revision],
    );
    if (row === undefined) {
      // Another save won between the read and the write: the conflict carries the revision that is stored now, not the one this save read.
      const stored = await this.getDraft(tx, input.tenantId);
      throw versionConflict(stored.revision);
    }
    return { revision: Number(row.revision), config: input.config, updatedBy: input.actorId, updatedAt: row.updated_at };
  }

  /**
   * A review of the draft or of a version to restore: bound to the person, the tenant, the content (a hash of the candidate) and
   * the base version, valid fifteen minutes, usable once. A base version that is not the published one is VERSION_CONFLICT.
   */
  async createReview(tx: TenantTx, input: ReviewInput): Promise<ThemeReviewResult> {
    const published = await this.currentVersion(tx, input.tenantId);
    if (published === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (published.version !== input.baseVersion) throw versionConflict(published.version);
    let candidate: ThemeConfig;
    let draftRevision: number | null = null;
    let sourceVersion: number | null = null;
    let reason: string | null = null;
    if (input.sourceVersion !== undefined) {
      reason = input.reason?.trim() ?? '';
      if (reason.length < MIN_REASON_LENGTH) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
      const source = await this.findVersion(tx, input.tenantId, input.sourceVersion);
      if (source === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      candidate = source.config;
      sourceVersion = source.version;
    } else {
      const draft = await this.getDraft(tx, input.tenantId);
      if (draft.revision !== input.draftRevision) throw versionConflict(draft.revision);
      // Revision 0 is the published theme itself: there is nothing to review until someone edits it.
      if (draft.revision === 0) throw new DomainError('VALIDATION_FAILED', 422, 'draftRevision');
      candidate = draft.config;
      draftRevision = draft.revision;
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(input.now.getTime() + REVIEW_LIFETIME_MS);
    await tx.query(
      `insert into machvon.tenant_theme_review
         (tenant_id, id, token_hash, actor_id, base_version, draft_revision, source_version, reason, candidate_json, candidate_hash, expires_at)
       values ($1::uuid, $2::uuid, $3, $4::uuid, $5::bigint, $6::bigint, $7::bigint, $8, $9::jsonb, $10, $11)`,
      [input.tenantId, randomUUID(), tokenHashOf(token), input.actorId, input.baseVersion, draftRevision, sourceVersion, reason, JSON.stringify(candidate), themeHash(candidate), expiresAt],
    );
    return { token, expiresAt, baseVersion: input.baseVersion, candidate, changes: themeChanges(published.config, candidate) };
  }

  /**
   * Publishes the reviewed candidate: pointer, then review, then draft are locked in that order, so two publishers of the same
   * base serialise and the second is VERSION_CONFLICT. A review that is expired, used, another person's, another tenant's or no
   * longer the content of the draft is REVIEW_INVALID, never naming anyone (BR-SAS-17). The review is consumed in the same
   * transaction that writes the version and moves the pointer.
   */
  async publish(tx: TenantTx, input: PublishInput): Promise<ThemeVersionRow> {
    const [pointer] = await tx.query<{ current_version: number }>('select current_version::int as current_version from machvon.tenant_theme_pointer where tenant_id = $1::uuid for update', [input.tenantId]);
    if (pointer === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const [review] = await tx.query<{
      id: string;
      actor_id: string;
      base_version: number;
      draft_revision: string | null;
      source_version: number | null;
      reason: string | null;
      candidate_json: ThemeConfig;
      candidate_hash: string;
      expires_at: Date;
      consumed_at: Date | null;
    }>(
      `select id, actor_id, base_version::int as base_version, draft_revision::text as draft_revision, source_version::int as source_version,
              reason, candidate_json, candidate_hash, expires_at, consumed_at
         from machvon.tenant_theme_review where tenant_id = $1::uuid and token_hash = $2 for update`,
      [input.tenantId, tokenHashOf(input.token)],
    );
    const invalid = (): DomainError => new DomainError('REVIEW_INVALID', 409);
    if (review === undefined || review.actor_id !== input.actorId || review.consumed_at !== null || review.expires_at.getTime() <= input.now.getTime()) throw invalid();
    if (pointer.current_version !== input.baseVersion || review.base_version !== input.baseVersion) throw versionConflict(pointer.current_version);
    if (review.draft_revision !== null) {
      const [draft] = await tx.query<{ revision: string; config_json: ThemeConfig }>('select revision::text as revision, config_json from machvon.tenant_theme_draft where tenant_id = $1::uuid for update', [input.tenantId]);
      if (draft === undefined || draft.revision !== review.draft_revision || themeHash(draft.config_json) !== review.candidate_hash) throw invalid();
    }
    if (themeHash(review.candidate_json) !== review.candidate_hash) throw invalid();

    const version = pointer.current_version + 1;
    const [row] = await tx.query<VersionSqlRow>(
      `insert into machvon.tenant_theme_version (tenant_id, version, config_json, config_hash, source_version, published_by, published_at, reason)
       values ($1::uuid, $2::bigint, $3::jsonb, $4, $5::bigint, $6::uuid, $7, $8) returning ${VERSION_COLUMNS}`,
      [input.tenantId, version, JSON.stringify(review.candidate_json), review.candidate_hash, review.source_version, input.actorId, input.now, review.source_version === null ? null : review.reason],
    );
    await tx.query('update machvon.tenant_theme_pointer set current_version = $2::bigint, updated_at = $3 where tenant_id = $1::uuid', [input.tenantId, version, input.now]);
    await tx.query('update machvon.tenant_theme_review set consumed_at = $2 where tenant_id = $1::uuid and id = $3::uuid', [input.tenantId, input.now, review.id]);
    // Publish step 9: the draft that was published is cleared (the row was locked and compared above); a draft someone else
    // saved for another purpose, and every draft when a rollback is published, stays.
    if (review.draft_revision !== null) {
      await tx.query('delete from machvon.tenant_theme_draft where tenant_id = $1::uuid and revision = $2::bigint', [input.tenantId, review.draft_revision]);
    }
    if (row === undefined) throw new Error('theme version was not stored');
    return toVersion(row);
  }

  async registerAsset(tx: TenantTx, input: NewThemeAsset): Promise<ThemeAssetRow> {
    const [row] = await tx.query<AssetSqlRow>(
      `insert into machvon.tenant_theme_asset (tenant_id, id, content_hash, mime, size_bytes, storage_key, scan_status, created_by)
       values ($1::uuid, $2::uuid, $3, $4, $5::bigint, $6, $7, $8::uuid)
       returning id, tenant_id, content_hash, mime, size_bytes::text as size_bytes, storage_key, scan_status`,
      [input.tenantId, input.id ?? randomUUID(), input.contentHash, input.mime, input.sizeBytes, input.storageKey, input.scanStatus, input.createdBy],
    );
    if (row === undefined) throw new Error('theme asset was not stored');
    return toAsset(row);
  }

  /**
   * The logo of the theme in force of this tenant, for the tenant plane: the view `published_theme_logo` (V3080) holds only the logo the published
   * version names and only once it is clean, so a member never reaches an asset row of a draft, an older version or another tenant.
   */
  async publishedLogo(tx: TenantTx, tenantId: string): Promise<Pick<ThemeAssetRow, 'id' | 'tenantId' | 'contentHash' | 'mime' | 'storageKey'> | undefined> {
    const rows = await tx.query<{ id: string; tenant_id: string; content_hash: string; mime: string; storage_key: string }>(
      'select id, tenant_id, content_hash, mime, storage_key from machvon.published_theme_logo where tenant_id = $1::uuid',
      [tenantId],
    );
    const row = rows[0];
    return row === undefined ? undefined : { id: row.id, tenantId: row.tenant_id, contentHash: row.content_hash, mime: row.mime, storageKey: row.storage_key };
  }

  async findAsset(tx: TenantTx, tenantId: string, id: string): Promise<ThemeAssetRow | undefined> {
    const rows = await tx.query<AssetSqlRow>(
      `select id, tenant_id, content_hash, mime, size_bytes::text as size_bytes, storage_key, scan_status
         from machvon.tenant_theme_asset where tenant_id = $1::uuid and id = $2::uuid`,
      [tenantId, id],
    );
    return rows[0] === undefined ? undefined : toAsset(rows[0]);
  }
}
