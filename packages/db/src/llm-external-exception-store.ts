import { randomUUID } from 'node:crypto';
import { DomainError, assertExceptionRevocable, decideException, versionConflict } from '@machvon/kernel';
import type { Classification, ExceptionRecord, ExceptionRequest, AiExceptionStatus, Route } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

/**
 * The exceptions that let data go to a provider outside the customer servers, and the log of their use (lane AI-2, eng-review R5, KT.02). The rules are the kernel's (`ai-edition-policy.ts`); the database holds the same ones
 * (two people, at most 90 days, append-only log), so a write that skips the service is refused as well. An exception is never deleted: it ends by its date or by a revocation, and what it allowed and every request that used it
 * stay readable.
 */

interface Sql {
  [column: string]: unknown;
}

const TIME = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const PAGE_KEY = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`;
const MAX_LIST = 100;

export interface ExceptionRow {
  id: string;
  providerId: string;
  providerCode: string;
  routeClass: Route;
  taskType: string | null;
  maxClassification: Classification;
  reason: string;
  requestedBy: string;
  requestedAt: string;
  requestedValidDays: number;
  status: AiExceptionStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  approvalRef: string | null;
  validFrom: string | null;
  validUntil: string | null;
  revokedBy: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  useCount: number;
  version: number;
  pageKey: string;
}

export interface ExceptionUseRow {
  id: string;
  exceptionId: string;
  aiRequestId: string;
  taskType: string;
  dataClassification: Classification;
  routeClass: Route;
  usedAt: string;
}

const COLUMNS = `e.id, e.provider_id, p.provider_code, p.route_class, p.max_classification as provider_max, e.task_type, e.max_classification, e.reason, e.requested_by, ${TIME('e.requested_at')} as requested_at, e.requested_valid_days,
  e.status, e.decided_by, ${TIME('e.decided_at')} as decided_at, e.decision_note, e.approval_ref, ${TIME('e.valid_from')} as valid_from, ${TIME('e.valid_until')} as valid_until, e.revoked_by, ${TIME('e.revoked_at')} as revoked_at,
  e.revoke_reason, (select count(*)::int from machvon.ai_external_exception_use u where u.tenant_id = e.tenant_id and u.exception_id = e.id) as use_count, e.version::text as version, ${PAGE_KEY('e.requested_at')} as page_key`;
const FROM = `machvon.ai_external_exception e join machvon.ai_provider p on p.tenant_id = e.tenant_id and p.id = e.provider_id`;

const toRow = (row: Sql): ExceptionRow => ({
  id: row.id as string,
  providerId: row.provider_id as string,
  providerCode: row.provider_code as string,
  routeClass: row.route_class as Route,
  taskType: row.task_type as string | null,
  maxClassification: row.max_classification as Classification,
  reason: row.reason as string,
  requestedBy: row.requested_by as string,
  requestedAt: row.requested_at as string,
  requestedValidDays: row.requested_valid_days as number,
  status: row.status as AiExceptionStatus,
  decidedBy: row.decided_by as string | null,
  decidedAt: row.decided_at as string | null,
  decisionNote: row.decision_note as string | null,
  approvalRef: row.approval_ref as string | null,
  validFrom: row.valid_from as string | null,
  validUntil: row.valid_until as string | null,
  revokedBy: row.revoked_by as string | null,
  revokedAt: row.revoked_at as string | null,
  revokeReason: row.revoke_reason as string | null,
  useCount: row.use_count as number,
  version: Number(row.version),
  pageKey: row.page_key as string,
});

export interface AiExceptionFilter {
  status?: string | undefined;
  providerId?: string | undefined;
  limit: number;
  after?: { key: string; id: string } | undefined;
}

export class LlmExternalExceptionStore {
  async find(tx: TenantTx, id: string, lock = false): Promise<ExceptionRow | undefined> {
    const rows = await tx.query<Sql>(`select ${COLUMNS} from ${FROM} where e.id = $1::uuid${lock ? ' for no key update of e' : ''}`, [id]);
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  async list(tx: TenantTx, filter: AiExceptionFilter): Promise<{ rows: ExceptionRow[]; next?: { key: string; id: string } }> {
    const limit = Math.min(Math.max(filter.limit, 1), MAX_LIST);
    const rows = await tx.query<Sql>(
      `select ${COLUMNS} from ${FROM}
        where ($1::text is null or e.status = $1) and ($2::uuid is null or e.provider_id = $2::uuid)
          and ($3::text is null or (${PAGE_KEY('e.requested_at')}, e.id::text) < ($3::text, $4::text))
        order by e.requested_at desc, e.id desc limit $5::int`,
      [filter.status ?? null, filter.providerId ?? null, filter.after?.key ?? null, filter.after?.id ?? null, limit + 1],
    );
    const mapped = rows.map(toRow);
    const page = mapped.slice(0, limit);
    const last = page[page.length - 1];
    return mapped.length > limit && last !== undefined ? { rows: page, next: { key: last.pageKey, id: last.id } } : { rows: page };
  }

  async uses(tx: TenantTx, exceptionId: string, limit: number): Promise<ExceptionUseRow[]> {
    const rows = await tx.query<Sql>(
      `select id, exception_id, ai_request_id, task_type, data_classification, route_class, ${TIME('used_at')} as used_at from machvon.ai_external_exception_use where exception_id = $1::uuid order by used_at desc, id desc limit $2::int`,
      [exceptionId, Math.min(Math.max(limit, 1), MAX_LIST)],
    );
    return rows.map((row) => ({
      id: row.id as string,
      exceptionId: row.exception_id as string,
      aiRequestId: row.ai_request_id as string,
      taskType: row.task_type as string,
      dataClassification: row.data_classification as Classification,
      routeClass: row.route_class as Route,
      usedAt: row.used_at as string,
    }));
  }

  /** Asks for an exception for a provider that is not self-hosted (a self-hosted provider needs none) and is not retired. */
  async request(tx: TenantTx, input: ExceptionRequest & { actor: string }): Promise<ExceptionRow> {
    const providers = await tx.query<Sql>('select route_class, status, max_classification from machvon.ai_provider where id = $1::uuid', [input.providerId]);
    const provider = providers[0];
    if (provider === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (provider.route_class === 'SELF_HOSTED') throw new DomainError('VALIDATION_FAILED', 422, 'provider_id');
    if (provider.status === 'RETIRED') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'provider');
    const open = await tx.query("select 1 from machvon.ai_external_exception where provider_id = $1::uuid and status = 'REQUESTED' and task_type is not distinct from $2", [input.providerId, input.taskType]);
    if (open.length > 0) throw new DomainError('EXCEPTION_REQUEST_OPEN', 409, 'provider_id');
    const id = randomUUID();
    await tx.query(
      `insert into machvon.ai_external_exception (tenant_id, id, provider_id, task_type, max_classification, reason, requested_by, requested_valid_days)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7::int)`,
      [id, input.providerId, input.taskType, input.maxClassification, input.reason, input.actor, input.validDays],
    );
    return (await this.find(tx, id)) as ExceptionRow;
  }

  /** Approves or rejects an open request (the kernel judges the person, the paper and the class); an approval starts now and ends after the days that were asked. */
  async decide(tx: TenantTx, id: string, input: { decision: string; note: string | undefined; approvalRef: string | undefined; actor: string; expectedVersion: number; now: Date }): Promise<{ row: ExceptionRow; before: AiExceptionStatus }> {
    const current = await this.find(tx, id, true);
    if (current === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (current.version !== input.expectedVersion) throw versionConflict(current.version);
    const provider = (await tx.query<Sql>('select max_classification from machvon.ai_provider where id = $1::uuid', [current.providerId]))[0];
    const decided = decideException({
      decision: input.decision,
      note: input.note,
      approvalRef: input.approvalRef,
      requestedBy: current.requestedBy,
      actor: input.actor,
      requestedValidDays: current.requestedValidDays,
      providerMaxClassification: provider?.max_classification as Classification,
      maxClassification: current.maxClassification,
      status: current.status,
      now: input.now,
    });
    await tx.query(
      `update machvon.ai_external_exception set status = $2, decided_by = $3::uuid, decided_at = $4::timestamptz, decision_note = $5, approval_ref = $6, valid_from = $7::timestamptz, valid_until = $8::timestamptz, version = version + 1 where id = $1::uuid`,
      [id, decided.status, input.actor, input.now.toISOString(), decided.note, decided.approvalRef, decided.validFrom?.toISOString() ?? null, decided.validUntil?.toISOString() ?? null],
    );
    return { row: (await this.find(tx, id)) as ExceptionRow, before: current.status };
  }

  async revoke(tx: TenantTx, id: string, input: { reason: string | undefined; actor: string; expectedVersion: number; now: Date }): Promise<ExceptionRow> {
    const current = await this.find(tx, id, true);
    if (current === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (current.version !== input.expectedVersion) throw versionConflict(current.version);
    const reason = assertExceptionRevocable(current.status, input.reason);
    await tx.query("update machvon.ai_external_exception set status = 'REVOKED', revoked_by = $2::uuid, revoked_at = $3::timestamptz, revoke_reason = $4, version = version + 1 where id = $1::uuid", [id, input.actor, input.now.toISOString(), reason]);
    return (await this.find(tx, id)) as ExceptionRow;
  }

  /** The exceptions that stand now (approved and inside their dates) as records the kernel judges requests against. */
  async standing(tx: TenantTx, now: Date): Promise<ExceptionRecord[]> {
    const rows = await tx.query<Sql>(
      `select id, provider_id, task_type, max_classification, status, valid_from, valid_until from machvon.ai_external_exception
        where status = 'APPROVED' and valid_from <= $1::timestamptz and valid_until > $1::timestamptz order by valid_until desc, id`,
      [now.toISOString()],
    );
    return rows.map((row) => ({
      id: row.id as string,
      providerId: row.provider_id as string,
      taskType: row.task_type as string | null,
      maxClassification: row.max_classification as Classification,
      status: row.status as AiExceptionStatus,
      validFrom: new Date(row.valid_from as string),
      validUntil: new Date(row.valid_until as string),
    }));
  }

  /** Logs the use of an exception by a request: once for each (request, exception). */
  async logUse(tx: TenantTx, input: { exceptionId: string; aiRequestId: string; providerId: string; taskType: string; classification: Classification; route: Route }): Promise<void> {
    await tx.query(
      `insert into machvon.ai_external_exception_use (tenant_id, id, exception_id, ai_request_id, provider_id, task_type, data_classification, route_class)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4, $5, $6) on conflict (tenant_id, ai_request_id, exception_id) do nothing`,
      [input.exceptionId, input.aiRequestId, input.providerId, input.taskType, input.classification, input.route],
    );
  }
}
