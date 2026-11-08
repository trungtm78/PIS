import { randomUUID } from 'node:crypto';
import { DomainError, biLoginName, biReaderMove, isScramVerifier, versionConflict } from '@machvon/kernel';
import type { BiReaderMove, BiReaderRequest, BiReaderStatus } from '@machvon/kernel';
import { assertTimestampCursor, timestampKey } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const UNIQUE_VIOLATION = '23505';
/** What PostgreSQL answers when the function of V2200 is not installed or the role may not run it: the environment cannot make logins. */
const UNDEFINED_FUNCTION = '42883';
const INSUFFICIENT_PRIVILEGE = '42501';

export interface BiReaderRow {
  id: string;
  name: string;
  tool: string | null;
  loginName: string;
  connectionLimit: number;
  status: BiReaderStatus;
  statusReason: string | null;
  statusChangedAt: string | null;
  passwordRotatedAt: string;
  version: number;
  createdAt: string;
  createdAtKey: string;
}

interface ReaderSql {
  id: string;
  name: string;
  tool: string | null;
  login_name: string;
  connection_limit: number;
  status: BiReaderStatus;
  status_reason: string | null;
  status_changed_at: string | null;
  password_rotated_at: string;
  version: string;
  created_at: string;
  created_at_key: string;
}

const READER_SELECT = `select r.id, r.name, r.tool, r.login_name, r.connection_limit, r.status, r.status_reason, to_char(r.status_changed_at at time zone 'UTC', ${ISO}) as status_changed_at,
    to_char(r.password_rotated_at at time zone 'UTC', ${ISO}) as password_rotated_at, r.version::text as version, to_char(r.created_at at time zone 'UTC', ${ISO}) as created_at, ${timestampKey('r.created_at')} as created_at_key
  from machvon.int_bi_reader r`;

const readerOf = (row: ReaderSql): BiReaderRow => ({
  id: row.id,
  name: row.name,
  tool: row.tool,
  loginName: row.login_name,
  connectionLimit: row.connection_limit,
  status: row.status,
  statusReason: row.status_reason,
  statusChangedAt: row.status_changed_at,
  passwordRotatedAt: row.password_rotated_at,
  version: Number(row.version),
  createdAt: row.created_at,
  createdAtKey: row.created_at_key,
});

export interface BiReaderEventRow {
  id: string;
  action: string;
  reason: string | null;
  actorId: string;
  readerVersion: number;
  occurredAt: string;
}

/** A failure of the privileged functions that is the environment's, not the caller's: a database that cannot make logins answers 503, never a 500 with the SQL. */
function provisioningFailure(error: unknown): never {
  const code = (error as { code?: string }).code;
  if (code === UNDEFINED_FUNCTION || code === INSUFFICIENT_PRIVILEGE) throw new DomainError('BI_PROVISIONING_UNAVAILABLE', 503);
  throw error;
}

/**
 * The register of the database logins of BI tools (INT-1, R6 and R13). The login and its tenant binding are made, parked and removed by the privileged functions of V2200 (the application role cannot create a login
 * itself); this store keeps the register, the history and the life of each reader, and hands the SCRAM verifier of the password to those functions: the clear password never reaches the database.
 */
export class BiReaderStore {
  async find(tx: TenantTx, id: string, lock = false): Promise<BiReaderRow | undefined> {
    const rows = await tx.query<ReaderSql>(`${READER_SELECT} where r.id = $1::uuid${lock ? ' for update of r' : ''}`, [id]);
    return rows[0] === undefined ? undefined : readerOf(rows[0]);
  }

  async list(tx: TenantTx, filter: { status?: BiReaderStatus | undefined }, request: { limit: number; after: { key: string; id: string } | undefined }): Promise<BiReaderRow[]> {
    if (request.after !== undefined) assertTimestampCursor(request.after.key);
    const rows = await tx.query<ReaderSql>(
      `select * from (${READER_SELECT}) m
        where ($1::text is null or m.status = $1) and ($2::text is null or (m.created_at_key, m.id) < ($2::text, $3::uuid))
        order by m.created_at_key desc, m.id desc limit $4`,
      [filter.status ?? null, request.after?.key ?? null, request.after?.id ?? null, request.limit],
    );
    return rows.map(readerOf);
  }

  async counts(tx: TenantTx): Promise<Record<BiReaderStatus, number>> {
    const rows = await tx.query<{ status: BiReaderStatus; n: string }>('select status, count(*)::text as n from machvon.int_bi_reader group by status');
    const counts: Record<BiReaderStatus, number> = { ACTIVE: 0, SUSPENDED: 0, RETIRED: 0 };
    for (const row of rows) counts[row.status] = Number(row.n);
    return counts;
  }

  async events(tx: TenantTx, readerId: string, limit: number): Promise<BiReaderEventRow[]> {
    const rows = await tx.query<{ id: string; action: string; reason: string | null; actor_id: string; reader_version: string; occurred_at: string }>(
      `select id, action, reason, actor_id, reader_version::text as reader_version, to_char(occurred_at at time zone 'UTC', ${ISO}) as occurred_at
         from machvon.int_bi_reader_event where reader_id = $1::uuid order by occurred_at desc, id desc limit $2`,
      [readerId, limit],
    );
    return rows.map((row) => ({ id: row.id, action: row.action, reason: row.reason, actorId: row.actor_id, readerVersion: Number(row.reader_version), occurredAt: row.occurred_at }));
  }

  private async record(tx: TenantTx, readerId: string, action: string, reason: string | null, actor: string, version: number): Promise<void> {
    await tx.query(
      `insert into machvon.int_bi_reader_event (tenant_id, id, reader_id, action, reason, actor_id, reader_version) values (${TENANT}, $1::uuid, $2::uuid, $3, $4, $5::uuid, $6)`,
      [randomUUID(), readerId, action, reason, actor, version],
    );
  }

  /** Makes the login of a reader: the register row, then the privileged function that creates the login with the verifier of its password and binds it to this tenant. */
  async provision(tx: TenantTx, tenantId: string, request: BiReaderRequest, verifier: string, actor: string): Promise<BiReaderRow> {
    if (!isScramVerifier(verifier)) throw new DomainError('VALIDATION_FAILED', 422, 'password');
    const id = randomUUID();
    const login = biLoginName(id);
    try {
      await tx.query(
        `insert into machvon.int_bi_reader (tenant_id, id, name, tool, login_name, connection_limit, created_by, updated_by) values (${TENANT}, $1::uuid, $2, $3, $4, $5, $6::uuid, $6::uuid)`,
        [id, request.name, request.tool, login, request.connectionLimit, actor],
      );
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new DomainError('BI_READER_STATE_INVALID', 409, 'login');
      throw error;
    }
    try {
      await tx.query('select machvon_bi.provision_reader($1::uuid, $2::uuid, $3, $4, $5)', [tenantId, id, login, verifier, request.connectionLimit]);
    } catch (error) {
      provisioningFailure(error);
    }
    await this.record(tx, id, 'PROVISIONED', null, actor, 1);
    return (await this.find(tx, id)) as BiReaderRow;
  }

  /** Gives a reader a new password (a versioned command); the sessions it has open are cut so no one keeps using the old one. */
  async rotatePassword(tx: TenantTx, tenantId: string, id: string, expectedVersion: number, verifier: string, reason: string, actor: string): Promise<BiReaderRow> {
    if (!isScramVerifier(verifier)) throw new DomainError('VALIDATION_FAILED', 422, 'password');
    const before = await this.find(tx, id, true);
    if (before === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    if (before.status === 'RETIRED') throw new DomainError('BI_READER_STATE_INVALID', 409, 'status');
    try {
      await tx.query('select machvon_bi.rotate_reader_password($1::uuid, $2, $3)', [tenantId, before.loginName, verifier]);
    } catch (error) {
      provisioningFailure(error);
    }
    await tx.query(`update machvon.int_bi_reader set password_rotated_at = now(), updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid`, [id, actor]);
    const row = (await this.find(tx, id)) as BiReaderRow;
    await this.record(tx, id, 'PASSWORD_ROTATED', reason, actor, row.version);
    return row;
  }

  /** Parks, resumes or retires a reader (a versioned command). A retired reader's login is dropped, so it is final. */
  async decide(tx: TenantTx, tenantId: string, id: string, expectedVersion: number, step: { move: BiReaderMove; reason: unknown }, actor: string, now: Date): Promise<{ before: BiReaderRow; row: BiReaderRow }> {
    const before = await this.find(tx, id, true);
    if (before === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    const decided = biReaderMove({ status: before.status }, step);
    try {
      if (step.move === 'RETIRE') await tx.query('select machvon_bi.retire_reader($1::uuid, $2)', [tenantId, before.loginName]);
      else await tx.query('select machvon_bi.set_reader_active($1::uuid, $2, $3)', [tenantId, before.loginName, step.move === 'REACTIVATE']);
    } catch (error) {
      provisioningFailure(error);
    }
    await tx.query(
      `update machvon.int_bi_reader set status = $2, status_reason = $3, status_changed_by = $4::uuid, status_changed_at = $5::timestamptz, updated_at = now(), updated_by = $4::uuid, version = version + 1 where id = $1::uuid`,
      [id, decided.to, decided.reason, actor, now.toISOString()],
    );
    const row = (await this.find(tx, id)) as BiReaderRow;
    await this.record(tx, id, decided.to === 'RETIRED' ? 'RETIRED' : decided.to === 'SUSPENDED' ? 'SUSPENDED' : 'REACTIVATED', decided.reason, actor, row.version);
    return { before, row };
  }
}
