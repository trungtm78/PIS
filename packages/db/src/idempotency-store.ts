import { IDEMPOTENCY_LOCK_SECONDS, IDEMPOTENCY_TTL_HOURS } from '@machvon/kernel';
import type { IdempotencyTtl, TenantContext } from '@machvon/kernel';
import { isHeld } from './purge-guard.ts';
import type { PurgeResource } from './purge-guard.ts';
import type { TenantDatabase, TenantTx } from './tenant-database.ts';

export type StoredResponse =
  | { kind: 'success'; body: unknown }
  | { kind: 'problem'; code: string; status: number; detail?: string; extensions?: Record<string, unknown> };

export type BeginResult =
  | { kind: 'started'; recordId: string }
  | { kind: 'replay'; httpStatus: number; response: StoredResponse }
  | { kind: 'conflict' }
  | { kind: 'in_progress'; retryAfterSeconds: 2 };

export interface BeginInput {
  operation: string;
  keyHash: string;
  requestHash: string;
  ttl: IdempotencyTtl;
}

export interface CompletedOutcome {
  httpStatus: number;
  response: StoredResponse;
  resourceType?: string;
  resourceId?: string;
  /**
   * Every resource the command wrote an audit entry for, in the order written. When no explicit resource is given the
   * record points at the first one that a legal hold contains, else at the first one, so a UNIT, PROJECT, CONTRACT or
   * RESOURCE hold protects the record (BR-PLT-04) and not only a TENANT hold does.
   */
  touched?: readonly PurgeResource[];
}

export type FinishOutcome = { retryable: true } | ({ retryable: false } & Pick<CompletedOutcome, 'httpStatus' | 'response'>);

const RETRY_AFTER_SECONDS = 2;

// Expiry and lock are computed by the database clock, so the table CHECK (72 hours to 7 days after
// created_at) never sees client clock skew.
const INSERT_SQL = `insert into machvon.idempotency_record
    (tenant_id, id, subject_id, operation, key_hash, request_hash, response_ref, status, expires_at, locked_until)
  values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, $3, $4, '{}'::jsonb,
    'IN_PROGRESS', now() + make_interval(hours => $5::int), now() + make_interval(secs => $6::double precision))
  on conflict (tenant_id, subject_id, operation, key_hash) do nothing
  returning id`;

const SELECT_SQL = `select id, request_hash, status, http_status, response_ref, resource_type, resource_id,
    coalesce(locked_until > now(), false) as locked, expires_at <= now() as expired
  from machvon.idempotency_record
  where subject_id = $1::uuid and operation = $2 and key_hash = $3
  for update skip locked`;

// Reads the record without waiting for or taking its row lock.
const PEEK_SQL = `select request_hash from machvon.idempotency_record where subject_id = $1::uuid and operation = $2 and key_hash = $3`;

// A fresh created_at keeps the new expiry inside the table CHECK when an expired record is reused.
const RESTART_EXPIRED_SQL = `update machvon.idempotency_record
  set request_hash = $2, status = 'IN_PROGRESS', response_ref = '{}'::jsonb, http_status = null,
      resource_type = null, resource_id = null, completed_at = null, created_at = now(),
      expires_at = now() + make_interval(hours => $3::int), locked_until = now() + make_interval(secs => $4::double precision)
  where id = $1::uuid`;

// A record that a legal hold contains is evidence: it keeps its response, request hash, resource reference and
// timestamps. Only its key is retired (no client key hash looks like this value), which frees the key for the new request.
const RETIRE_HELD_SQL = `update machvon.idempotency_record set key_hash = 'retired:' || id::text where id = $1::uuid`;

const TAKE_OVER_SQL = `update machvon.idempotency_record
  set status = 'IN_PROGRESS', locked_until = now() + make_interval(secs => $2::double precision), completed_at = null
  where id = $1::uuid`;

interface ExistingRow {
  id: string;
  request_hash: string;
  status: string;
  http_status: number | null;
  response_ref: StoredResponse;
  resource_type: string | null;
  resource_id: string | null;
  locked: boolean;
  expired: boolean;
}

/**
 * Idempotency records of BR-PLT-02. `begin` commits an IN_PROGRESS record before the command runs,
 * `completeInTx` writes the response inside the command transaction so effects and response commit
 * together, and `finishOutsideTx` settles a command whose transaction rolled back.
 */
export class IdempotencyStore {
  private readonly database: TenantDatabase;

  constructor(database: TenantDatabase) {
    this.database = database;
  }

  begin(ctx: TenantContext, input: BeginInput): Promise<BeginResult> {
    return this.database.withTenant(ctx, async (tx) => {
      const ttlHours = IDEMPOTENCY_TTL_HOURS[input.ttl];
      const inserted = await tx.query<{ id: string }>(INSERT_SQL, [
        ctx.membershipId,
        input.operation,
        input.keyHash,
        input.requestHash,
        ttlHours,
        IDEMPOTENCY_LOCK_SECONDS,
      ]);
      const created = inserted[0];
      if (created !== undefined) return { kind: 'started', recordId: created.id };

      const [existing] = await tx.query<ExistingRow>(SELECT_SQL, [ctx.membershipId, input.operation, input.keyHash]);
      // The row exists (the insert just conflicted) but another transaction holds its row lock: the attempt that
      // claimed it is still running, however old its 30 second lock is. Taking over now would run the command twice.
      if (existing === undefined) {
        // A non-locking look still tells a different body (conflict) from a repeat of the running request.
        const [running] = await tx.query<{ request_hash: string }>(PEEK_SQL, [ctx.membershipId, input.operation, input.keyHash]);
        if (running !== undefined && running.request_hash !== input.requestHash) return { kind: 'conflict' };
        return { kind: 'in_progress', retryAfterSeconds: RETRY_AFTER_SECONDS };
      }

      if (existing.expired) {
        // Reusing an expired key must not destroy what a legal hold keeps: the held record is set aside, a new one starts.
        if (await isHeld(tx, { type: existing.resource_type ?? '', id: existing.resource_id ?? undefined })) {
          await tx.query(RETIRE_HELD_SQL, [existing.id]);
          const [restarted] = await tx.query<{ id: string }>(INSERT_SQL, [
            ctx.membershipId,
            input.operation,
            input.keyHash,
            input.requestHash,
            ttlHours,
            IDEMPOTENCY_LOCK_SECONDS,
          ]);
          if (restarted === undefined) throw new Error('idempotency key still taken after its held record was set aside');
          return { kind: 'started', recordId: restarted.id };
        }
        await tx.query(RESTART_EXPIRED_SQL, [existing.id, input.requestHash, ttlHours, IDEMPOTENCY_LOCK_SECONDS]);
        return { kind: 'started', recordId: existing.id };
      }
      if (existing.request_hash !== input.requestHash) return { kind: 'conflict' };
      if (existing.status === 'COMPLETED' && existing.http_status !== null) {
        return { kind: 'replay', httpStatus: existing.http_status, response: existing.response_ref };
      }
      if (existing.status === 'IN_PROGRESS' && existing.locked) {
        return { kind: 'in_progress', retryAfterSeconds: RETRY_AFTER_SECONDS };
      }
      // FAILED_RETRYABLE, or IN_PROGRESS whose owner crashed and let the lock lapse.
      await tx.query(TAKE_OVER_SQL, [existing.id, IDEMPOTENCY_LOCK_SECONDS]);
      return { kind: 'started', recordId: existing.id };
    });
  }

  /**
   * Takes the record's row lock for the rest of the business transaction and tells whether this attempt still owns it
   * (status IN_PROGRESS). A takeover waits out, or is answered in_progress by, the claim of a running attempt, and a
   * stale attempt finds the record settled by the takeover and must roll back.
   */
  async claimInTx(tx: TenantTx, recordId: string): Promise<boolean> {
    const rows = await tx.query<{ status: string }>('select status from machvon.idempotency_record where id = $1::uuid for update', [recordId]);
    return rows[0]?.status === 'IN_PROGRESS';
  }

  /**
   * What a record says about the command that held it, read outside the command: a record that is COMPLETED was completed inside the business transaction, so the transaction committed. It is how a command whose commit
   * ended in an error (the connection was lost before the acknowledgement) finds out whether it was committed or rolled back. `undefined` is a record that is not completed: the transaction did not commit.
   */
  async completedOutcome(ctx: TenantContext, recordId: string): Promise<{ httpStatus: number; response: unknown } | undefined> {
    return this.database.withTenant(ctx, async (tx) => {
      // The command holds the row lock of its record for the whole of its transaction (claimInTx): taking the lock here waits until that transaction has ended, committed or rolled back, so a commit that is still running is not taken for a rollback. A transaction that does not end within the wait leaves the outcome unknown (the lock times out).
      await tx.query("set local lock_timeout = '10s'");
      const [row] = await tx.query<{ http_status: number | null; response_ref: unknown; status: string }>('select status, http_status, response_ref from machvon.idempotency_record where id = $1::uuid for update', [recordId]);
      return row !== undefined && row.status === 'COMPLETED' && row.http_status !== null ? { httpStatus: row.http_status, response: row.response_ref } : undefined;
    });
  }

  async completeInTx(tx: TenantTx, recordId: string, outcome: CompletedOutcome): Promise<void> {
    const resource = await this.referenceOf(tx, outcome);
    await tx.query(
      `update machvon.idempotency_record
         set status = 'COMPLETED', http_status = $2, response_ref = $3::jsonb, resource_type = $4, resource_id = $5::uuid,
             completed_at = now(), locked_until = null
       where id = $1::uuid`,
      [recordId, outcome.httpStatus, JSON.stringify(outcome.response), resource?.type ?? null, resource?.id ?? null],
    );
  }

  private async referenceOf(tx: TenantTx, outcome: CompletedOutcome): Promise<PurgeResource | undefined> {
    if (outcome.resourceType !== undefined && outcome.resourceId !== undefined) return { type: outcome.resourceType, id: outcome.resourceId };
    const touched = outcome.touched ?? [];
    for (const resource of touched) if (await isHeld(tx, resource)) return resource;
    return touched[0];
  }

  async finishOutsideTx(ctx: TenantContext, recordId: string, outcome: FinishOutcome): Promise<void> {
    await this.database.withTenant(ctx, async (tx) => {
      if (outcome.retryable) {
        await tx.query(
          `update machvon.idempotency_record set status = 'FAILED_RETRYABLE', locked_until = null
           where id = $1::uuid and status = 'IN_PROGRESS'`,
          [recordId],
        );
        return;
      }
      await tx.query(
        `update machvon.idempotency_record
           set status = 'COMPLETED', http_status = $2, response_ref = $3::jsonb, completed_at = now(), locked_until = null
         where id = $1::uuid and status = 'IN_PROGRESS'`,
        [recordId, outcome.httpStatus, JSON.stringify(outcome.response)],
      );
    });
  }

  async purgeExpired(ctx: TenantContext): Promise<number> {
    const rows = await this.database.withTenant(ctx, (tx) =>
      tx.query<{ n: number }>(
        `with removed as (
           delete from machvon.idempotency_record
            where expires_at <= now() and not machvon.legal_hold_blocks(resource_type, resource_id)
           returning 1)
         select count(*)::int as n from removed`,
      ),
    );
    return rows[0]?.n ?? 0;
  }
}
