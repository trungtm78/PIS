import { randomUUID } from 'node:crypto';
import {
  DomainError,
  OPEN_DATASETS,
  accessConnectionView,
  assertDatasetOpen,
  datasetGate,
  graceEndsAt,
  machineAccountMove,
  machineCredentialState,
  vietnamDateOf,
  versionConflict,
} from '@machvon/kernel';
import type { AccessAccountFacts, AccessConnectionView, AccessParams, DataProductCertification, GeneratedClientCredentials, MachineAccountMove, MachineAccountRequest, MachineAccountStatus, MachineCredentialState, OpenAccessEntry, OpenAccessOutcome, BiDatasetCode } from '@machvon/kernel';
import { assertTimestampCursor, timestampKey } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const UNIQUE_VIOLATION = '23505';
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Machine accounts and their credentials.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface MachineCredentialRow {
  id: string;
  clientId: string;
  secretHint: string;
  state: MachineCredentialState;
  createdAt: string;
  supersededAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export interface MachineAccountRow {
  id: string;
  name: string;
  description: string | null;
  scopes: string[];
  ratePerMinute: number;
  expiresOn: string | null;
  status: MachineAccountStatus;
  statusReason: string | null;
  statusChangedAt: string | null;
  version: number;
  createdAt: string;
  createdAtKey: string;
  createdBy: string;
  credentials: MachineCredentialRow[];
}

interface AccountSql {
  id: string;
  name: string;
  description: string | null;
  scopes: string[];
  rate_limit_per_minute: number;
  expires_on: string | null;
  status: MachineAccountStatus;
  status_reason: string | null;
  status_changed_at: string | null;
  version: string;
  created_at: string;
  created_at_key: string;
  created_by: string;
}

interface CredentialSql {
  id: string;
  account_id: string;
  client_id: string;
  secret_hint: string;
  created_at: string;
  superseded_at_raw: Date | null;
  expires_at_raw: Date | null;
  revoked_at_raw: Date | null;
  superseded_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
}

const ACCOUNT_SELECT = `select a.id, a.name, a.description, a.scopes, a.rate_limit_per_minute, a.expires_on::text as expires_on, a.status, a.status_reason, to_char(a.status_changed_at at time zone 'UTC', ${ISO}) as status_changed_at,
    a.version::text as version, to_char(a.created_at at time zone 'UTC', ${ISO}) as created_at, ${timestampKey('a.created_at')} as created_at_key, a.created_by
  from machvon.int_machine_account a`;

const CREDENTIAL_SELECT = `select c.id, c.account_id, c.client_id, c.secret_hint, to_char(c.created_at at time zone 'UTC', ${ISO}) as created_at,
    c.superseded_at as superseded_at_raw, c.expires_at as expires_at_raw, c.revoked_at as revoked_at_raw,
    to_char(c.superseded_at at time zone 'UTC', ${ISO}) as superseded_at, to_char(c.expires_at at time zone 'UTC', ${ISO}) as expires_at, to_char(c.revoked_at at time zone 'UTC', ${ISO}) as revoked_at,
    to_char(c.last_used_at at time zone 'UTC', ${ISO}) as last_used_at
  from machvon.int_machine_credential c`;

const credentialOf = (row: CredentialSql, now: Date): MachineCredentialRow => ({
  id: row.id,
  clientId: row.client_id,
  secretHint: row.secret_hint,
  state: machineCredentialState({ expiresAt: row.expires_at_raw, revokedAt: row.revoked_at_raw, supersededAt: row.superseded_at_raw }, now),
  createdAt: row.created_at,
  supersededAt: row.superseded_at,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
  lastUsedAt: row.last_used_at,
});

const accountOf = (row: AccountSql, credentials: MachineCredentialRow[]): MachineAccountRow => ({
  id: row.id,
  name: row.name,
  description: row.description,
  scopes: row.scopes,
  ratePerMinute: row.rate_limit_per_minute,
  expiresOn: row.expires_on,
  status: row.status,
  statusReason: row.status_reason,
  statusChangedAt: row.status_changed_at,
  version: Number(row.version),
  createdAt: row.created_at,
  createdAtKey: row.created_at_key,
  createdBy: row.created_by,
  credentials,
});

export interface MachineAccountFilter {
  status?: MachineAccountStatus | undefined;
  q?: string | undefined;
}

/**
 * The machine accounts of a tenant (INT-1). An account holds scopes, a rate limit and an end day; it is ACTIVE or SUSPENDED (reversible) or REVOKED (final). Its credentials are a client id and the hash of a secret that was
 * shown once; a rotation supersedes the old credential for a bounded overlap, and revoking the account revokes every credential at once. The secret never reaches this class: it is given only its hash.
 */
export class MachineAccountStore {
  private async credentialsOf(tx: TenantTx, ids: readonly string[], now: Date): Promise<Map<string, MachineCredentialRow[]>> {
    const map = new Map<string, MachineCredentialRow[]>();
    if (ids.length === 0) return map;
    const rows = await tx.query<CredentialSql>(`${CREDENTIAL_SELECT} where c.account_id = any($1::uuid[]) order by c.created_at desc, c.id desc`, [[...ids]]);
    for (const row of rows) map.set(row.account_id, [...(map.get(row.account_id) ?? []), credentialOf(row, now)]);
    return map;
  }

  async find(tx: TenantTx, id: string, now: Date, lock = false): Promise<MachineAccountRow | undefined> {
    const rows = await tx.query<AccountSql>(`${ACCOUNT_SELECT} where a.id = $1::uuid${lock ? ' for update of a' : ''}`, [id]);
    if (rows[0] === undefined) return undefined;
    return accountOf(rows[0], (await this.credentialsOf(tx, [id], now)).get(id) ?? []);
  }

  async list(tx: TenantTx, filter: MachineAccountFilter, request: { limit: number; after: { key: string; id: string } | undefined }, now: Date): Promise<MachineAccountRow[]> {
    if (request.after !== undefined) assertTimestampCursor(request.after.key);
    const like = filter.q === undefined ? null : `%${filter.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    const rows = await tx.query<AccountSql>(
      `select * from (${ACCOUNT_SELECT}) m
        where ($1::text is null or m.status = $1) and ($2::text is null or m.name ilike $2 escape '\\')
          and ($3::text is null or (m.created_at_key, m.id) < ($3::text, $4::uuid))
        order by m.created_at_key desc, m.id desc limit $5`,
      [filter.status ?? null, like, request.after?.key ?? null, request.after?.id ?? null, request.limit],
    );
    const credentials = await this.credentialsOf(tx, rows.map((row) => row.id), now);
    return rows.map((row) => accountOf(row, credentials.get(row.id) ?? []));
  }

  async counts(tx: TenantTx): Promise<Record<MachineAccountStatus, number>> {
    const rows = await tx.query<{ status: MachineAccountStatus; n: string }>('select status, count(*)::text as n from machvon.int_machine_account group by status');
    const counts: Record<MachineAccountStatus, number> = { ACTIVE: 0, SUSPENDED: 0, REVOKED: 0 };
    for (const row of rows) counts[row.status] = Number(row.n);
    return counts;
  }

  async create(tx: TenantTx, request: MachineAccountRequest, credentials: GeneratedClientCredentials, actor: string, now: Date): Promise<MachineAccountRow> {
    const id = randomUUID();
    try {
      await tx.query(
        `insert into machvon.int_machine_account (tenant_id, id, name, description, scopes, rate_limit_per_minute, expires_on, created_by, updated_by)
         values (${TENANT}, $1::uuid, $2, $3, $4::text[], $5, $6::date, $7::uuid, $7::uuid)`,
        [id, request.name, request.description, request.scopes, request.ratePerMinute, request.expiresOn, actor],
      );
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new DomainError('OPEN_ACCOUNT_NAME_TAKEN', 409, 'name');
      throw error;
    }
    await this.insertCredential(tx, id, credentials, actor);
    return (await this.find(tx, id, now)) as MachineAccountRow;
  }

  private async insertCredential(tx: TenantTx, accountId: string, credentials: GeneratedClientCredentials, actor: string): Promise<string> {
    const credentialId = randomUUID();
    await tx.query(
      `insert into machvon.int_machine_credential (tenant_id, id, account_id, client_id, secret_hash, secret_hint, created_by) values (${TENANT}, $1::uuid, $2::uuid, $3, $4, $5, $6::uuid)`,
      [credentialId, accountId, credentials.clientId, credentials.secretHash, credentials.secretHint, actor],
    );
    return credentialId;
  }

  /** Changes what an account may read and how fast (a versioned command). The reason is the person's, written to the audit by the caller. */
  async update(tx: TenantTx, id: string, expectedVersion: number, change: { description?: string | null; scopes?: string[]; ratePerMinute?: number; expiresOn?: string | null }, actor: string, now: Date): Promise<{ before: MachineAccountRow; row: MachineAccountRow }> {
    const before = await this.find(tx, id, now, true);
    if (before === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    if (before.status === 'REVOKED') throw new DomainError('OPEN_ACCOUNT_STATE_INVALID', 409, 'status');
    await tx.query(
      `update machvon.int_machine_account
          set description = $2, scopes = $3::text[], rate_limit_per_minute = $4, expires_on = $5::date, updated_at = now(), updated_by = $6::uuid, version = version + 1
        where id = $1::uuid`,
      [
        id,
        change.description === undefined ? before.description : change.description,
        change.scopes ?? before.scopes,
        change.ratePerMinute ?? before.ratePerMinute,
        change.expiresOn === undefined ? before.expiresOn : change.expiresOn,
        actor,
      ],
    );
    return { before, row: (await this.find(tx, id, now)) as MachineAccountRow };
  }

  /** Suspends, reactivates or revokes an account (a versioned command); a revocation revokes every credential in the same transaction. */
  async decide(tx: TenantTx, id: string, expectedVersion: number, step: { move: MachineAccountMove; reason: unknown }, actor: string, now: Date): Promise<{ before: MachineAccountRow; row: MachineAccountRow }> {
    const before = await this.find(tx, id, now, true);
    if (before === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    const decided = machineAccountMove({ status: before.status, expiresOn: before.expiresOn }, { move: step.move, reason: step.reason, today: vietnamDateOf(now) });
    await tx.query(
      `update machvon.int_machine_account set status = $2, status_reason = $3, status_changed_by = $4::uuid, status_changed_at = $5::timestamptz, updated_at = now(), updated_by = $4::uuid, version = version + 1 where id = $1::uuid`,
      [id, decided.to, decided.reason, actor, now.toISOString()],
    );
    if (decided.to === 'REVOKED') {
      await tx.query(
        `update machvon.int_machine_credential set revoked_at = $2::timestamptz, revoked_by = $3::uuid, revoke_reason = $4 where account_id = $1::uuid and revoked_at is null`,
        [id, now.toISOString(), actor, decided.reason],
      );
    }
    return { before, row: (await this.find(tx, id, now)) as MachineAccountRow };
  }

  /**
   * Rotates the secret of an account: a new credential is made, the one in use is superseded and lives on for `graceHours` (0 ends it at once), and a credential that was already waiting out an earlier overlap is
   * revoked, so an account never holds more than two live secrets. Only an ACTIVE account rotates (a suspended one is reactivated first).
   */
  async rotate(tx: TenantTx, id: string, expectedVersion: number, credentials: GeneratedClientCredentials, graceHours: number, actor: string, now: Date): Promise<{ row: MachineAccountRow; credentialId: string }> {
    const before = await this.find(tx, id, now, true);
    if (before === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    if (before.status !== 'ACTIVE') throw new DomainError('OPEN_ACCOUNT_STATE_INVALID', 409, 'status');
    await tx.query(
      `update machvon.int_machine_credential set revoked_at = $2::timestamptz, revoked_by = $3::uuid, revoke_reason = $4
        where account_id = $1::uuid and superseded_at is not null and revoked_at is null and (expires_at is null or expires_at > $2::timestamptz)`,
      [id, now.toISOString(), actor, 'Replaced by a newer rotation'],
    );
    const end = graceEndsAt(now, graceHours);
    await tx.query(
      `update machvon.int_machine_credential set superseded_at = $2::timestamptz, expires_at = $3::timestamptz where account_id = $1::uuid and superseded_at is null and revoked_at is null`,
      [id, now.toISOString(), end.toISOString()],
    );
    const credentialId = await this.insertCredential(tx, id, credentials, actor);
    await tx.query(`update machvon.int_machine_account set updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid`, [id, actor]);
    return { row: (await this.find(tx, id, now)) as MachineAccountRow, credentialId };
  }

  /** The time a credential was last used, written at most once a minute so a busy reader does not rewrite one row on every call. */
  async touchCoarse(tx: TenantTx, credentialId: string): Promise<void> {
    await tx.query("update machvon.int_machine_credential set last_used_at = now() where id = $1::uuid and (last_used_at is null or last_used_at < now() - interval '1 minute')", [credentialId]);
  }

  /** The time a credential was last used is kept for the screens; it is the only thing a read of the open API writes besides the log. */
  async touch(tx: TenantTx, credentialId: string): Promise<void> {
    await tx.query('update machvon.int_machine_credential set last_used_at = now() where id = $1::uuid', [credentialId]);
  }
}

/** What the token endpoint learns about a client id before any tenant is known: the facts that decide the authentication. The secret hash is compared by the caller in constant time. */
export interface ClientLookup {
  tenantId: string;
  accountId: string;
  credentialId: string;
  secretHash: string;
  credentialExpiresAt: Date | null;
  credentialRevokedAt: Date | null;
  accountStatus: MachineAccountStatus;
  accountExpiresOn: string | null;
  scopes: string[];
  ratePerMinute: number;
  tenantStatus: string | null;
}

/** Looks a client id up across tenants through the function that names the tenant itself (`machvon.int_client_lookup`); run on the control connection. */
export async function lookupClient(tx: TenantTx, clientId: string): Promise<ClientLookup | undefined> {
  const rows = await tx.query<{
    tenant_id: string;
    account_id: string;
    credential_id: string;
    secret_hash: string;
    credential_expires_at: Date | null;
    credential_revoked_at: Date | null;
    account_status: MachineAccountStatus;
    account_expires_on: string | null;
    scopes: string[];
    rate_limit_per_minute: number;
    tenant_status: string | null;
  }>("select tenant_id, account_id, credential_id, secret_hash, credential_expires_at, credential_revoked_at, account_status, account_expires_on::text as account_expires_on, scopes, rate_limit_per_minute, tenant_status from machvon.int_client_lookup($1)", [clientId]);
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    tenantId: row.tenant_id,
    accountId: row.account_id,
    credentialId: row.credential_id,
    secretHash: row.secret_hash,
    credentialExpiresAt: row.credential_expires_at,
    credentialRevokedAt: row.credential_revoked_at,
    accountStatus: row.account_status,
    accountExpiresOn: row.account_expires_on,
    scopes: row.scopes,
    ratePerMinute: row.rate_limit_per_minute,
    tenantStatus: row.tenant_status,
  };
}

/** The facts of an account a request is judged on, read under the tenant of the token on every call, so a suspension or a revocation reaches a token that is still alive. */
export interface LiveAccount {
  id: string;
  status: MachineAccountStatus;
  expiresOn: string | null;
  scopes: string[];
  ratePerMinute: number;
  credentialLive: boolean;
}

export async function liveAccount(tx: TenantTx, accountId: string, credentialId: string, now: Date): Promise<LiveAccount | undefined> {
  const rows = await tx.query<{ id: string; status: MachineAccountStatus; expires_on: string | null; scopes: string[]; rate_limit_per_minute: number; credential_live: boolean }>(
    `select a.id, a.status, a.expires_on::text as expires_on, a.scopes, a.rate_limit_per_minute,
            exists (select 1 from machvon.int_machine_credential c where c.id = $2::uuid and c.account_id = a.id and c.revoked_at is null and (c.expires_at is null or c.expires_at > $3::timestamptz)) as credential_live
       from machvon.int_machine_account a where a.id = $1::uuid`,
    [accountId, credentialId, now.toISOString()],
  );
  const row = rows[0];
  return row === undefined ? undefined : { id: row.id, status: row.status, expiresOn: row.expires_on, scopes: row.scopes, ratePerMinute: row.rate_limit_per_minute, credentialLive: row.credential_live };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The access log.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface AccessLogRow {
  id: string;
  accountId: string;
  accountName: string;
  credentialId: string;
  operation: string;
  scope: string | null;
  path: string;
  queryKeys: string[];
  outcome: OpenAccessOutcome;
  status: number;
  rowCount: number | null;
  correlationId: string;
  occurredAt: string;
  occurredAtKey: string;
}

export interface AccessLogFilter {
  accountId?: string | undefined;
  outcome?: OpenAccessOutcome | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

export class AccessLogStore {
  async append(tx: TenantTx, entry: OpenAccessEntry): Promise<void> {
    await tx.query(
      `insert into machvon.int_access_log (tenant_id, account_id, credential_id, operation, scope, path, query_keys, outcome, status, row_count, correlation_id)
       values (${TENANT}, $1::uuid, $2::uuid, $3, $4, $5, $6::text[], $7, $8, $9, $10)`,
      [entry.accountId, entry.credentialId, entry.operation, entry.scope === '' ? null : entry.scope, entry.path, entry.queryKeys, entry.outcome, entry.status, entry.rowCount, entry.correlationId],
    );
  }

  async list(tx: TenantTx, filter: AccessLogFilter, request: { limit: number; after: { key: string; id: string } | undefined }): Promise<AccessLogRow[]> {
    if (request.after !== undefined) assertTimestampCursor(request.after.key);
    const rows = await tx.query<{
      id: string;
      account_id: string;
      account_name: string;
      credential_id: string;
      operation: string;
      scope: string | null;
      path: string;
      query_keys: string[];
      outcome: OpenAccessOutcome;
      status: number;
      row_count: number | null;
      correlation_id: string;
      occurred_at: string;
      occurred_at_key: string;
    }>(
      `select * from (
         select l.id, l.account_id, a.name as account_name, l.credential_id, l.operation, l.scope, l.path, l.query_keys, l.outcome, l.status, l.row_count, l.correlation_id, l.occurred_at as occurred_raw,
                to_char(l.occurred_at at time zone 'UTC', ${ISO}) as occurred_at, ${timestampKey('l.occurred_at')} as occurred_at_key
           from machvon.int_access_log l join machvon.int_machine_account a on a.tenant_id = l.tenant_id and a.id = l.account_id) m
        where ($1::uuid is null or m.account_id = $1) and ($2::text is null or m.outcome = $2)
          and ($3::timestamptz is null or m.occurred_raw >= $3) and ($4::timestamptz is null or m.occurred_raw < $4)
          and ($5::text is null or (m.occurred_at_key, m.id) < ($5::text, $6::uuid))
        order by m.occurred_at_key desc, m.id desc limit $7`,
      [filter.accountId ?? null, filter.outcome ?? null, filter.from ?? null, filter.to ?? null, request.after?.key ?? null, request.after?.id ?? null, request.limit],
    );
    return rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      accountName: row.account_name,
      credentialId: row.credential_id,
      operation: row.operation,
      scope: row.scope,
      path: row.path,
      queryKeys: row.query_keys,
      outcome: row.outcome,
      status: row.status,
      rowCount: row.row_count,
      correlationId: row.correlation_id,
      occurredAt: row.occurred_at,
      occurredAtKey: row.occurred_at_key,
    }));
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The datasets switched on for external readers.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface ExportDatasetRow {
  datasetCode: BiDatasetCode;
  /** Null until the tenant configures the dataset for the first time. */
  id: string | null;
  productId: string | null;
  productCode: string | null;
  productTitle: string | null;
  certification: DataProductCertification | null;
  certificationExpiresOn: string | null;
  enabled: boolean;
  stateReason: string | null;
  stateChangedAt: string | null;
  /** 1 while the dataset is not configured: the first command creates the row at version 2 (so the version of an unconfigured dataset and of a configured one are never the same). */
  version: number;
  gate: { open: true } | { open: false; reason: 'DISABLED' | 'NOT_CERTIFIED' | 'EXPIRED' };
}

interface ExportSql {
  dataset_code: BiDatasetCode;
  id: string | null;
  product_id: string | null;
  product_code: string | null;
  product_title: string | null;
  certification_status: DataProductCertification | null;
  certification_expires_on: string | null;
  enabled: boolean | null;
  state_reason: string | null;
  state_changed_at: string | null;
  version: string | null;
}

export interface ProductChoice {
  id: string;
  code: string;
  title: string;
  certification: DataProductCertification;
  certificationExpiresOn: string | null;
}

/**
 * Which certified datasets the tenant lets out (API and BI). The gate is the kernel rule `datasetGate`, read live: the product behind a dataset must be CERTIFIED and not past its day at every read, so revoking the
 * certification in DGV closes the dataset for readers at once without anyone switching anything. Switching on needs a CERTIFIED product now.
 */
export class ExportDatasetStore {
  /** The datasets named (the open ones unless the edition offers more: `biDatasetsOfEdition`), each with the state the tenant gave it. */
  async state(tx: TenantTx, now: Date, codes: readonly BiDatasetCode[] = OPEN_DATASETS): Promise<ExportDatasetRow[]> {
    const today = vietnamDateOf(now);
    const rows = await tx.query<ExportSql>(
      `select d.code as dataset_code, e.id, e.product_id, p.code as product_code, p.title as product_title, p.certification_status, p.certification_expires_on::text as certification_expires_on,
              e.enabled, e.state_reason, to_char(e.state_changed_at at time zone 'UTC', ${ISO}) as state_changed_at, e.version::text as version
         from unnest($1::text[]) as d(code)
         left join machvon.int_export_dataset e on e.dataset_code = d.code
         left join machvon.data_product p on p.tenant_id = e.tenant_id and p.id = e.product_id
        order by d.code`,
      [[...codes]],
    );
    return rows.map((row) => {
      const enabled = row.enabled === true;
      return {
        datasetCode: row.dataset_code,
        id: row.id,
        productId: row.product_id,
        productCode: row.product_code,
        productTitle: row.product_title,
        certification: row.certification_status,
        certificationExpiresOn: row.certification_expires_on,
        enabled,
        stateReason: row.state_reason,
        stateChangedAt: row.state_changed_at,
        version: row.version === null ? 1 : Number(row.version),
        gate: datasetGate({ enabled, certification: row.certification_status, expiresOn: row.certification_expires_on, today }),
      };
    });
  }

  /** The products a dataset can be backed by: every data product of the tenant, certified first. */
  async products(tx: TenantTx): Promise<ProductChoice[]> {
    const rows = await tx.query<{ id: string; code: string; title: string; certification_status: DataProductCertification; certification_expires_on: string | null }>(
      `select id, code, title, certification_status, certification_expires_on::text as certification_expires_on from machvon.data_product
        order by (certification_status = 'CERTIFIED') desc, code limit 200`,
    );
    return rows.map((row) => ({ id: row.id, code: row.code, title: row.title, certification: row.certification_status, certificationExpiresOn: row.certification_expires_on }));
  }

  /**
   * Switches a dataset on or off for external readers (a versioned command; `expectedVersion` is 1 for a dataset never configured). Switching on needs the named product to be CERTIFIED and not past its day,
   * judged here by the kernel (422 `OPEN_DATASET_NOT_CERTIFIED`); switching off needs only the reason.
   */
  async set(tx: TenantTx, datasetCode: BiDatasetCode, expectedVersion: number, change: { enabled: boolean; productId: string | null; reason: string }, actor: string, now: Date, codes: readonly BiDatasetCode[] = OPEN_DATASETS): Promise<{ before: ExportDatasetRow; row: ExportDatasetRow }> {
    // The row is locked BEFORE its version is read: two commands that carry the same version take turns, and the second one finds the new version and is refused.
    await tx.query('select id from machvon.int_export_dataset where dataset_code = $1 for update', [datasetCode]);
    const states = await this.state(tx, now, codes);
    const before = states.find((state) => state.datasetCode === datasetCode);
    // A dataset the edition does not offer is not there to be switched.
    if (before === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'dataset_code');
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    const productId = change.productId ?? before.productId;
    if (productId === null) throw new DomainError('VALIDATION_FAILED', 422, 'product_id');
    const products = await tx.query<{ certification_status: DataProductCertification; certification_expires_on: string | null }>('select certification_status, certification_expires_on::text as certification_expires_on from machvon.data_product where id = $1::uuid', [productId]);
    const product = products[0];
    if (product === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'product_id');
    if (change.enabled) assertDatasetOpen({ enabled: true, certification: product.certification_status, expiresOn: product.certification_expires_on, today: vietnamDateOf(now) }, 422);
    if (before.id === null) {
      const made = await tx.query<{ id: string }>(
        `insert into machvon.int_export_dataset (tenant_id, id, dataset_code, product_id, enabled, state_reason, state_changed_by, state_changed_at, created_by, updated_by, version)
         values (${TENANT}, $1::uuid, $2, $3::uuid, $4, $5, $6::uuid, $7::timestamptz, $6::uuid, $6::uuid, 2)
         on conflict (tenant_id, dataset_code) do nothing returning id`,
        [randomUUID(), datasetCode, productId, change.enabled, change.reason, actor, now.toISOString()],
      );
      // Another command configured the dataset first: this one was written against a version that no longer is. A dataset never configured is at version 1 and its first row is made at version 2, so a stale screen
      // that saw it unconfigured can never overwrite what was configured since.
      if (made.length === 0) throw versionConflict(2);
    } else {
      await tx.query(
        `update machvon.int_export_dataset set product_id = $2::uuid, enabled = $3, state_reason = $4, state_changed_by = $5::uuid, state_changed_at = $6::timestamptz, updated_at = now(), updated_by = $5::uuid, version = version + 1 where id = $1::uuid`,
        [before.id, productId, change.enabled, change.reason, actor, now.toISOString()],
      );
    }
    const after = (await this.state(tx, now, codes)).find((state) => state.datasetCode === datasetCode) as ExportDatasetRow;
    return { before, row: after };
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// What the open API reads.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface OpenPage<T> {
  items: T[];
  /** The anchor of the last row when more rows follow, else undefined. */
  next: { code: string; id: string } | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function page<T>(rows: T[], limit: number, anchor: (row: T) => { code: string; id: string }): OpenPage<T> {
  const shown = rows.slice(0, limit);
  const last = shown[shown.length - 1];
  return { items: shown, next: rows.length > limit && last !== undefined ? anchor(last) : undefined };
}

const CODE_TYPES = ['PROJECT_CODE', 'EGP_PROJECT'];

/**
 * The reads of the open API, under the row-level security of the tenant of the account (the transaction names it). Rows come back in the shape of the published contract (snake_case), the keyset is the order of the
 * query, and the datasets are read from FROZEN snapshots only: the same tables, columns and conditions as the certified views of the BI reader schema (V2202), so the two paths answer alike.
 */
export class OpenReads {
  async projects(tx: TenantTx, filter: { status?: string | undefined }, request: { limit: number; after: { code: string; id: string } | undefined }): Promise<OpenPage<Record<string, unknown> & { code: string; id: string }>> {
    const rows = await tx.query<Record<string, unknown> & { code: string; id: string }>(
      `select p.id, p.code, p.name, p.status, p.classification, p.total_investment_vnd::text as total_investment_vnd, p.national_project_code, p.start_year, p.end_year, u.code as owner_unit_code,
              (select coalesce(jsonb_agg(jsonb_build_object('source_system', x.source_system, 'external_type', x.external_type, 'external_code', x.external_code, 'valid_from', x.valid_from::text, 'valid_until', x.valid_until::text)
                                         order by x.source_system, x.external_code), '[]'::jsonb)
                 from machvon.master_crosswalk x
                where x.tenant_id = p.tenant_id and x.subject_type = 'PROJECT' and x.subject_id = p.id and x.external_type = any($1::text[]) and x.status = 'ACTIVE') as external_codes
         from machvon.project p left join machvon.organization_unit u on u.tenant_id = p.tenant_id and u.id = p.owner_unit_id
        where ($2::text is null or p.status = $2) and ($3::text is null or (p.code, p.id) > ($3::text, $4::uuid))
        order by p.code, p.id limit $5`,
      [CODE_TYPES, filter.status ?? null, request.after?.code ?? null, request.after?.id ?? null, request.limit + 1],
    );
    return page(rows, request.limit, (row) => ({ code: row.code, id: row.id }));
  }

  async projectCodes(
    tx: TenantTx,
    filter: { sourceSystem?: string | undefined; externalCode?: string | undefined; projectCode?: string | undefined },
    request: { limit: number; after: { code: string; id: string } | undefined },
  ): Promise<OpenPage<Record<string, unknown> & { id: string; sort_key: string }>> {
    const rows = await tx.query<Record<string, unknown> & { id: string; sort_key: string }>(
      `select x.id, p.code as project_code, x.source_system, x.external_type, x.external_code, x.valid_from::text as valid_from, x.valid_until::text as valid_until,
              (x.source_system || ':' || x.external_type || ':' || x.external_code) as sort_key
         from machvon.master_crosswalk x join machvon.project p on p.tenant_id = x.tenant_id and p.id = x.subject_id
        where x.subject_type = 'PROJECT' and x.external_type = any($1::text[]) and x.status = 'ACTIVE'
          and ($2::text is null or x.source_system = $2) and ($3::text is null or x.external_code = $3) and ($4::text is null or p.code = $4)
          and ($5::text is null or ((x.source_system || ':' || x.external_type || ':' || x.external_code), x.id) > ($5::text, $6::uuid))
        order by sort_key, x.id limit $7`,
      [CODE_TYPES, filter.sourceSystem ?? null, filter.externalCode ?? null, filter.projectCode ?? null, request.after?.code ?? null, request.after?.id ?? null, request.limit + 1],
    );
    return page(rows, request.limit, (row) => ({ code: row.sort_key, id: row.id }));
  }

  async disbursementLines(tx: TenantTx, filter: { periodId?: string | undefined; snapshotId?: string | undefined }, request: { limit: number; after: { code: string; id: string } | undefined }, certifiedUntil: string | null): Promise<OpenPage<Record<string, unknown> & { snapshot_id: string; line_id: string }>> {
    for (const value of [filter.periodId, filter.snapshotId, request.after?.code]) if (value !== undefined && !UUID.test(value)) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
    const rows = await tx.query<Record<string, unknown> & { snapshot_id: string; line_id: string }>(
      `select s.tenant_id, s.id as snapshot_id, s.period_id, s.as_of_date::text as as_of_date, l.id as line_id, l.project_id, l.unit_id, l.fund_source_version_id, l.bucket, l.budget_level, l.plan_total_vnd::text as plan_total_vnd,
              l.disbursed_treasury_vnd::text as disbursed_treasury_vnd, l.disbursed_reported_vnd::text as disbursed_reported_vnd, l.period_delta_vnd::text as period_delta_vnd, l.rate_total_pct::text as rate_total_pct,
              l.rate_null_reason, l.treasury_coverage, $1::text as certification_expires_on
         from machvon.period_snapshot s join machvon.period_snapshot_line l on l.tenant_id = s.tenant_id and l.snapshot_id = s.id
        where s.status = 'FROZEN' and s.snapshot_kind = 'PERIOD_CLOSE' and ($2::uuid is null or s.period_id = $2) and ($3::uuid is null or s.id = $3)
          and ($4::uuid is null or (s.id, l.id) > ($4::uuid, $5::uuid))
        order by s.id, l.id limit $6`,
      [certifiedUntil, filter.periodId ?? null, filter.snapshotId ?? null, request.after?.code ?? null, request.after?.id ?? null, request.limit + 1],
    );
    return page(rows, request.limit, (row) => ({ code: row.snapshot_id, id: row.line_id }));
  }

  async contractLines(tx: TenantTx, filter: { periodId?: string | undefined; snapshotId?: string | undefined }, request: { limit: number; after: { code: string; id: string } | undefined }, certifiedUntil: string | null): Promise<OpenPage<Record<string, unknown> & { snapshot_id: string; contract_id: string; contractor_id: string }>> {
    const [afterSnapshot, afterContract] = request.after === undefined ? [undefined, undefined] : request.after.code.split(':');
    for (const value of [filter.periodId, filter.snapshotId, afterSnapshot, afterContract]) if (value !== undefined && !UUID.test(value)) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
    const rows = await tx.query<Record<string, unknown> & { snapshot_id: string; contract_id: string; contractor_id: string }>(
      `select s.tenant_id, s.id as snapshot_id, s.period_id, s.revision, s.cutoff_date::text as cutoff_date, l.contract_id, l.contractor_id, l.is_lead, l.share_pct::text as share_pct, l.project_id, l.unit_id,
              l.contract_status, l.contract_type, l.contract_value_vnd::text as contract_value_vnd, l.active_value_vnd::text as active_value_vnd, l.paid_vnd::text as paid_vnd, $1::text as certification_expires_on
         from machvon.contract_fact_snapshot s
         join machvon.period_snapshot p on p.tenant_id = s.tenant_id and p.id = s.period_snapshot_id and p.status = 'FROZEN'
         join machvon.contract_fact_snapshot_line l on l.tenant_id = s.tenant_id and l.snapshot_id = s.id
        where ($2::uuid is null or s.period_id = $2) and ($3::uuid is null or s.id = $3)
          and ($4::uuid is null or (s.id, l.contract_id, l.contractor_id) > ($4::uuid, $5::uuid, $6::uuid))
        order by s.id, l.contract_id, l.contractor_id limit $7`,
      [certifiedUntil, filter.periodId ?? null, filter.snapshotId ?? null, afterSnapshot ?? null, afterContract ?? null, request.after?.id ?? null, request.limit + 1],
    );
    return page(rows, request.limit, (row) => ({ code: `${row.snapshot_id}:${row.contract_id}`, id: row.contractor_id }));
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// What the Integration Hub aggregates: the access side of the connectors.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * The small read the hub calls for the connector `access.open-api`: every machine account with its scopes, rate limit, last use, state of its newest credential, end day and the calls the rate limit refused lately,
 * and the counts of BI logins. It reads only; the judgement (what needs a look) is the kernel function `accessConnectionView`.
 */
export class AccessOverviewReads {
  async facts(tx: TenantTx, now: Date, params: AccessParams): Promise<{ accounts: AccessAccountFacts[]; readers: { ACTIVE: number; SUSPENDED: number; RETIRED: number } }> {
    const since = new Date(now.getTime() - params.rateLimitedWindowHours * 3_600_000);
    const rows = await tx.query<{
      id: string;
      name: string;
      status: MachineAccountStatus;
      scopes: string[];
      rate_limit_per_minute: number;
      expires_on: string | null;
      created_at: Date;
      last_used_at: Date | null;
      credential_created_at: Date | null;
      credential_expires_at: Date | null;
      credential_revoked_at: Date | null;
      credential_superseded_at: Date | null;
      rate_limited: string;
    }>(
      `select a.id, a.name, a.status, a.scopes, a.rate_limit_per_minute, a.expires_on::text as expires_on, a.created_at,
              (select max(c.last_used_at) from machvon.int_machine_credential c where c.account_id = a.id) as last_used_at,
              k.created_at as credential_created_at, k.expires_at as credential_expires_at, k.revoked_at as credential_revoked_at, k.superseded_at as credential_superseded_at,
              (select count(*) from machvon.int_access_log l where l.account_id = a.id and l.outcome = 'RATE_LIMITED' and l.occurred_at >= $1::timestamptz)::text as rate_limited
         from machvon.int_machine_account a
         left join lateral (select * from machvon.int_machine_credential c where c.account_id = a.id order by (c.revoked_at is null) desc, c.created_at desc limit 1) k on true
        order by a.created_at desc, a.id desc limit 1000`,
      [since.toISOString()],
    );
    const readers = await tx.query<{ status: 'ACTIVE' | 'SUSPENDED' | 'RETIRED'; n: string }>('select status, count(*)::text as n from machvon.int_bi_reader group by status');
    const counts = { ACTIVE: 0, SUSPENDED: 0, RETIRED: 0 };
    for (const row of readers) counts[row.status] = Number(row.n);
    return {
      readers: counts,
      accounts: rows.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        scopes: row.scopes,
        ratePerMinute: row.rate_limit_per_minute,
        expiresOn: row.expires_on,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
        credential: row.credential_created_at === null ? null : { createdAt: row.credential_created_at, expiresAt: row.credential_expires_at, revokedAt: row.credential_revoked_at, supersededAt: row.credential_superseded_at },
        rateLimitedCalls: Number(row.rate_limited),
      })),
    };
  }

  /** The view of the connector for the hub, from the facts above. */
  async view(tx: TenantTx, now: Date, params?: AccessParams): Promise<AccessConnectionView> {
    const used = params ?? { expiresSoonDays: 14, secretMaxAgeDays: 365, rateLimitedWindowHours: 24, neverUsedAfterDays: 7 };
    return accessConnectionView({ ...(await this.facts(tx, now, used)), now, params: used });
  }
}
