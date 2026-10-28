import { randomUUID } from 'node:crypto';
import { DomainError, assertKillScope } from '@machvon/kernel';
import type { KillScope, KillSwitch } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

interface Sql {
  [column: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const iso = (value: unknown): string | null => (value === null || value === undefined ? null : new Date(value as string).toISOString());

export interface KillSwitchRow extends KillSwitch {
  reason: string;
  state: 'ENGAGED' | 'RELEASED';
  engagedBy: string;
  engagedAt: string;
  releaseApprovedBy: string | null;
  releasedAt: string | null;
  releaseReason: string | null;
  affectedRequests: number;
  version: number;
  pageKey: string;
}

export interface AiDecisionRow {
  id: string;
  aiRequestId: string;
  subjectModule: string;
  subjectKind: string;
  subjectId: string;
  aiOutputSha256: string;
  actionKind: 'WRITE' | 'MONEY' | 'DECISION' | 'PUBLISH';
  decision: 'ACCEPTED' | 'ACCEPTED_WITH_CHANGE' | 'REJECTED';
  rationale: string;
  decidedBy: string;
  decidedAt: string;
  appliedOperationId: string | null;
  appliedResourceVersion: string | null;
  pageKey: string;
}

const SWITCH = `select id, scope_kind, scope_ref, reason, state, engaged_by, engaged_at, release_approved_by, released_at, release_reason, affected_requests, version::text as version,
    to_char(engaged_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as page_key from machvon.ai_kill_switch`;
const DECISION = `select id, ai_request_id, subject_module, subject_kind, subject_id, ai_output_sha256, action_kind, decision, rationale, decided_by, decided_at, applied_operation_id, applied_resource_version::text as applied_resource_version,
    to_char(decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as page_key from machvon.ai_decision_record`;

const switchOf = (row: Sql): KillSwitchRow => ({
  id: row.id,
  scopeKind: row.scope_kind,
  scopeRef: row.scope_ref,
  reason: row.reason,
  state: row.state,
  engagedBy: row.engaged_by,
  engagedAt: iso(row.engaged_at) as string,
  releaseApprovedBy: row.release_approved_by,
  releasedAt: iso(row.released_at),
  releaseReason: row.release_reason,
  affectedRequests: row.affected_requests,
  version: Number(row.version),
  pageKey: row.page_key,
});

const decisionOf = (row: Sql): AiDecisionRow => ({
  id: row.id,
  aiRequestId: row.ai_request_id,
  subjectModule: row.subject_module,
  subjectKind: row.subject_kind,
  subjectId: row.subject_id,
  aiOutputSha256: row.ai_output_sha256,
  actionKind: row.action_kind,
  decision: row.decision,
  rationale: row.rationale,
  decidedBy: row.decided_by,
  decidedAt: iso(row.decided_at) as string,
  appliedOperationId: row.applied_operation_id,
  appliedResourceVersion: row.applied_resource_version,
  pageKey: row.page_key,
});

/** A request that was in flight when its scope was stopped, and what was done with it. */
export interface StoppedRequest {
  id: string;
  taskType: string;
  outcome: 'CANCELLED' | 'KILLED_PENDING';
  reservationId: string | null;
  /** The provider's own id of the call that is running, for a request that was sent: what is asked to cancel it. */
  providerRequestId: string | null;
}

/** The emergency stop of the AI gateway (ST-LLM-006, LLM F7, BR-LLM-12): the switches of a tenant by scope; Postgres is the source of truth and is read at every request. */
export class LlmEmergencyStore {
  /** The switches that are engaged: a handful at the most, read at every request and again before every call. */
  async engaged(tx: TenantTx): Promise<KillSwitchRow[]> {
    return (await tx.query<Sql>(`${SWITCH} where state = 'ENGAGED' order by engaged_at`)).map(switchOf);
  }

  /**
   * The switches that are engaged and those that were released since a moment (the start of a request, as its page key says it, in UTC): a switch was in force from before the moment until it was released, so a request that
   * it overlapped is stopped, and a release lets new requests in without bringing back what the switch stopped.
   */
  async engagedSince(tx: TenantTx, since: string): Promise<KillSwitchRow[]> {
    return (await tx.query<Sql>(`${SWITCH} where state = 'ENGAGED' or (released_at at time zone 'UTC') >= $1::timestamp order by engaged_at`, [since])).map(switchOf);
  }

  async switches(tx: TenantTx, filter: { state?: string | undefined; limit: number; after?: { key: string; id: string } | undefined }): Promise<{ rows: KillSwitchRow[]; next: { key: string; id: string } | undefined }> {
    const rows = await tx.query<Sql>(
      `${SWITCH}
       where ($1::text is null or state = $1) and ($2::timestamp is null or (engaged_at at time zone 'UTC', id) < ($2::timestamp, $3::uuid)) order by engaged_at desc, id desc limit $4::int`,
      [filter.state ?? null, filter.after?.key ?? null, filter.after?.id ?? null, filter.limit + 1],
    );
    const page = rows.slice(0, filter.limit).map(switchOf);
    const last = page.at(-1);
    return { rows: page, next: rows.length > filter.limit && last !== undefined ? { key: last.pageKey, id: last.id } : undefined };
  }

  async find(tx: TenantTx, id: string, lock = false): Promise<KillSwitchRow | undefined> {
    const rows = await tx.query<Sql>(`${SWITCH} where id = $1::uuid${lock ? ' for update' : ''}`, [id]);
    return rows[0] === undefined ? undefined : switchOf(rows[0]);
  }

  /** Engages a switch for a scope. A provider or a model that is not in the registry is not a scope; one switch of a scope is engaged at a time. */
  async engage(tx: TenantTx, input: { scopeKind: string; scopeRef: string | undefined; reason: string; actor: string }): Promise<KillSwitchRow> {
    const ref = assertKillScope(input.scopeKind, input.scopeRef);
    if (input.scopeKind === 'PROVIDER' && (await tx.query('select 1 from machvon.ai_provider where id = $1::uuid', [ref])).length === 0) throw new DomainError('VALIDATION_FAILED', 422, 'scope_ref');
    if (input.scopeKind === 'MODEL' && (await tx.query('select 1 from machvon.ai_model where id = $1::uuid', [ref])).length === 0) throw new DomainError('VALIDATION_FAILED', 422, 'scope_ref');
    await tx.query("select pg_advisory_xact_lock(hashtextextended('llm_kill:' || current_setting('app.tenant_id', true), 0))");
    const held = await tx.query('select 1 from machvon.ai_kill_switch where state = \'ENGAGED\' and scope_kind = $1 and coalesce(scope_ref, \'\') = coalesce($2, \'\')', [input.scopeKind, ref]);
    if (held.length > 0) throw new DomainError('KILL_SWITCH_ALREADY_ENGAGED', 409, input.scopeKind);
    const id = randomUUID();
    await tx.query(
      `insert into machvon.ai_kill_switch (tenant_id, id, scope_kind, scope_ref, reason, state, engaged_by, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4, 'ENGAGED', $5::uuid, $5::uuid, $5::uuid)`,
      [id, input.scopeKind, ref, input.reason, input.actor],
    );
    return (await this.find(tx, id)) as KillSwitchRow;
  }

  /**
   * The requests of the tenant that this scope stops and that are not over: those that wait are cancelled and their hold is given back (the caller releases it), and those that were sent are marked to have their answer thrown
   * away when it comes. Only rows are changed, so that the switch can commit at once; asking the providers to cancel is done after, with `markCancelled` for those that did. Returns what was done, in the order the requests were made.
   */
  async stopInFlight(tx: TenantTx, scope: { kind: KillScope; ref: string | null }, actor: string): Promise<StoppedRequest[]> {
    const rows = await tx.query<Sql>(
      `select r.id, r.task_type, r.status, coalesce(r.budget_reservation_id, (select b.id from machvon.budget_reservation b where b.request_id = r.id limit 1)) as budget_reservation_id, (select a.provider_request_id from machvon.llm_attempt a where a.ai_request_id = r.id and a.provider_request_id <> '' order by a.attempt_no desc limit 1) as provider_request_id
         from machvon.ai_request r
        where r.status in ('ADMITTED', 'RESERVED', 'DISPATCHED') and r.killed_pending = false
          and ($1 = 'TENANT' or (($1 = 'PROFILE' or $1 = 'TASK_TYPE') and r.task_type = $2) or ($1 = 'PROVIDER' and r.provider_id = $2::uuid) or ($1 = 'MODEL' and r.model_ref_id = $2::uuid))
        order by r.created_at, r.id for update skip locked`,
      [scope.kind, scope.ref],
    );
    const stopped: StoppedRequest[] = [];
    for (const row of rows) {
      const cancelled = row.status !== 'DISPATCHED';
      if (cancelled) {
        await tx.query("update machvon.ai_request set status = 'CANCELLED', reject_code = 'AI_KILL_SWITCH_ENGAGED', completed_at = now(), updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid", [row.id, actor]);
      } else {
        await tx.query('update machvon.ai_request set killed_pending = true, updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid', [row.id, actor]);
      }
      stopped.push({ id: row.id, taskType: row.task_type, outcome: cancelled ? 'CANCELLED' : 'KILLED_PENDING', reservationId: row.budget_reservation_id, providerRequestId: typeof row.provider_request_id === 'string' ? row.provider_request_id : null });
    }
    return stopped;
  }

  /** A request that was sent and that its provider has cancelled since: it is over, as cancelled. A request that finished meanwhile is left as it is. */
  async markCancelled(tx: TenantTx, requestId: string, actor: string): Promise<boolean> {
    const done = await tx.query("update machvon.ai_request set status = 'CANCELLED', reject_code = 'AI_KILL_SWITCH_ENGAGED', killed_pending = false, completed_at = now(), updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid and status = 'DISPATCHED' and killed_pending returning id", [requestId, actor]);
    return done.length > 0;
  }

  async countAffected(tx: TenantTx, id: string, affected: number): Promise<void> {
    await tx.query('update machvon.ai_kill_switch set affected_requests = $2::int, version = version + 1, updated_at = now() where id = $1::uuid', [id, affected]);
  }

  /** Releases a switch, by someone other than who engaged it. */
  async release(tx: TenantTx, id: string, input: { reason: string; actor: string; expectedVersion: number }): Promise<KillSwitchRow> {
    const entry = await this.find(tx, id, true);
    if (entry === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (entry.version !== input.expectedVersion) throw new DomainError('VERSION_CONFLICT', 409);
    if (entry.state !== 'ENGAGED') throw new DomainError('KILL_SWITCH_NOT_ENGAGED', 409, 'state');
    if (entry.engagedBy === input.actor) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'engaged_by');
    await tx.query("update machvon.ai_kill_switch set state = 'RELEASED', release_approved_by = $2::uuid, release_reason = $3, released_at = now(), updated_by = $2::uuid, updated_at = now(), version = version + 1 where id = $1::uuid", [
      id,
      input.actor,
      input.reason,
    ]);
    return (await this.find(tx, id)) as KillSwitchRow;
  }
}

export interface AiDecisionInput {
  aiRequestId: string;
  subjectModule: string;
  subjectKind: string;
  subjectId: string;
  aiOutputSha256: string;
  actionKind: string;
  decision: string;
  rationale: string;
  actor: string;
}

/**
 * The record of what a person decided about an answer of the AI (ST-LLM-006, LLM F8, BR-LLM-11): nothing an AI answered acts on its own. A command that writes, moves money, decides or publishes with an answer of the AI
 * asks `require` in its own transaction, and says afterwards, with `markApplied`, what it did.
 */
export class AiDecisionStore {
  async records(
    tx: TenantTx,
    filter: { aiRequestId?: string | undefined; subjectModule?: string | undefined; decision?: string | undefined; limit: number; after?: { key: string; id: string } | undefined },
  ): Promise<{ rows: AiDecisionRow[]; next: { key: string; id: string } | undefined }> {
    const rows = await tx.query<Sql>(
      `${DECISION} where ($1::uuid is null or ai_request_id = $1::uuid) and ($2::text is null or subject_module = $2) and ($3::text is null or decision = $3)
         and ($4::timestamp is null or (decided_at at time zone 'UTC', id) < ($4::timestamp, $5::uuid)) order by decided_at desc, id desc limit $6::int`,
      [filter.aiRequestId ?? null, filter.subjectModule ?? null, filter.decision ?? null, filter.after?.key ?? null, filter.after?.id ?? null, filter.limit + 1],
    );
    const page = rows.slice(0, filter.limit).map(decisionOf);
    const last = page.at(-1);
    return { rows: page, next: rows.length > filter.limit && last !== undefined ? { key: last.pageKey, id: last.id } : undefined };
  }

  /** Records the decision of a person about the answer of a request: the answer must be the one the request gave (its hash), and the request must have been answered. */
  async record(tx: TenantTx, input: AiDecisionInput): Promise<AiDecisionRow> {
    const request = await tx.query<Sql>('select status, output_sha256 from machvon.ai_request where id = $1::uuid', [input.aiRequestId]);
    if (request[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (request[0].status !== 'COMPLETED' || request[0].output_sha256 === null) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    if (request[0].output_sha256 !== input.aiOutputSha256) throw new DomainError('AI_OUTPUT_HASH_MISMATCH', 422, 'ai_output_sha256');
    const id = randomUUID();
    await tx.query(
      `insert into machvon.ai_decision_record (tenant_id, id, ai_request_id, subject_module, subject_kind, subject_id, ai_output_sha256, action_kind, decision, rationale, decided_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4, $5::uuid, $6, $7, $8, $9, $10::uuid)`,
      [id, input.aiRequestId, input.subjectModule, input.subjectKind, input.subjectId, input.aiOutputSha256, input.actionKind, input.decision, input.rationale, input.actor],
    );
    return (await this.find(tx, id)) as AiDecisionRow;
  }

  async find(tx: TenantTx, id: string): Promise<AiDecisionRow | undefined> {
    const rows = await tx.query<Sql>(`${DECISION} where id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : decisionOf(rows[0]);
  }

  /**
   * What a command that uses an answer of the AI asks for, in its own transaction: the latest decision of a person about this answer for this subject. No decision, or one that rejected the answer, is 422
   * `AI_DECISION_REQUIRED`; a decision about another answer than the one the command holds, or an answer that is not the one the request gave, is 422 `AI_OUTPUT_HASH_MISMATCH`.
   */
  async require(tx: TenantTx, input: { aiRequestId: string; aiOutputSha256: string; subjectKind: string; subjectId: string; actionKind: string }): Promise<AiDecisionRow> {
    const request = await tx.query<Sql>('select output_sha256 from machvon.ai_request where id = $1::uuid', [input.aiRequestId]);
    if (request[0] === undefined || request[0].output_sha256 === null || request[0].output_sha256 !== input.aiOutputSha256) throw new DomainError('AI_OUTPUT_HASH_MISMATCH', 422, 'ai_output_sha256');
    const rows = await tx.query<Sql>(`${DECISION} where ai_request_id = $1::uuid and subject_kind = $2 and subject_id = $3::uuid and action_kind = $4 order by decided_at desc, id desc limit 1`, [
      input.aiRequestId,
      input.subjectKind,
      input.subjectId,
      input.actionKind,
    ]);
    const latest = rows[0] === undefined ? undefined : decisionOf(rows[0]);
    if (latest === undefined || latest.decision === 'REJECTED') throw new DomainError('AI_DECISION_REQUIRED', 422, latest === undefined ? 'ai_decision_record' : 'REJECTED');
    if (latest.aiOutputSha256 !== input.aiOutputSha256) throw new DomainError('AI_OUTPUT_HASH_MISMATCH', 422, 'ai_output_sha256');
    return latest;
  }

  /** The command says what it did with the decision: once. */
  async markApplied(tx: TenantTx, id: string, operationId: string, resourceVersion: number): Promise<void> {
    const done = await tx.query('update machvon.ai_decision_record set applied_operation_id = $2, applied_resource_version = $3::bigint where id = $1::uuid and applied_operation_id is null returning id', [id, operationId, resourceVersion]);
    if (done.length === 0) throw new DomainError('IDEMPOTENCY_CONFLICT', 409, 'applied_operation_id');
  }
}
