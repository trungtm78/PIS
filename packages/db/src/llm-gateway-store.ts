import { randomUUID } from 'node:crypto';
import { DomainError } from '@machvon/kernel';
import type { Classification, Route, SourceClass } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

interface Sql {
  [column: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const iso = (value: unknown): string | null => (value === null || value === undefined ? null : new Date(value as string).toISOString());

export type RequestStatus = 'ADMITTED' | 'REJECTED_POLICY' | 'RESERVED' | 'DISPATCHED' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'REJECTED_NO_CITATION' | 'PENDING_RECONCILE';

export interface AiRequestRow {
  id: string;
  taskType: string;
  subjectModule: string;
  subjectId: string | null;
  requestedBy: string;
  profileVersionId: string;
  promptVersionId: string | null;
  dataClassification: Classification;
  classificationBasis: Array<{ document_version_id: string; classification: Classification }>;
  anonymisationAttestationId: string | null;
  policyVersionId: string | null;
  routeClass: Route | null;
  providerId: string | null;
  providerCode: string | null;
  modelRefId: string | null;
  modelId: string | null;
  status: RequestStatus;
  rejectCode: string | null;
  inputSha256: string;
  outputSha256: string | null;
  citationsCount: number | null;
  budgetReservationId: string | null;
  costVnd: string | null;
  completedAt: string | null;
  createdAt: string;
  version: number;
  /** Where the row stands in the list: the cursor of the next page is built from it. */
  pageKey: string;
}

export interface AttemptRow {
  id: string;
  aiRequestId: string;
  attemptNo: number;
  attemptKind: 'PRIMARY' | 'RETRY' | 'FALLBACK';
  routeClass: Route;
  providerId: string | null;
  providerCode: string | null;
  actualModel: string;
  outcome: string;
  latencyMs: number | null;
  inputTotal: string;
  cachedInput: string;
  outputTotal: string;
  costVnd: string | null;
  reconcileStatus: string;
  createdAt: string;
  pageKey: string;
}

export interface RequestSummary {
  total: number;
  byRoute: Record<string, number>;
  byStatus: Record<string, number>;
  /** The requests of the month that were refused by the policy or the budget before any model was called. */
  blocked: number;
  periodStart: string;
}

const REQUEST = `select r.id, r.task_type, r.subject_module, r.subject_id, r.requested_by, r.profile_version_id, r.prompt_version_id, r.data_classification, r.classification_basis, r.anonymisation_attestation_id,
    r.policy_version_id, r.route_class, r.provider_id, p.provider_code, r.model_ref_id, m.model_id, r.status, r.reject_code, r.input_sha256, r.output_sha256, r.citations_count, r.budget_reservation_id,
    r.cost_vnd::text as cost_vnd, r.completed_at, r.created_at, r.version::text as version, to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as page_key
  from machvon.ai_request r left join machvon.ai_provider p on p.id = r.provider_id left join machvon.ai_model m on m.id = r.model_ref_id`;

const ATTEMPT = `select a.id, a.ai_request_id, a.attempt_no, a.attempt_kind, a.route_class, a.provider_id, p.provider_code, a.actual_model, a.outcome, a.latency_ms, a.input_total::text as input_total,
    a.cached_input::text as cached_input, a.output_total::text as output_total, a.cost_vnd::text as cost_vnd, a.reconcile_status, a.created_at, to_char(a.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as page_key
  from machvon.llm_attempt a left join machvon.ai_provider p on p.id = a.provider_id`;

const requestOf = (row: Sql): AiRequestRow => ({
  id: row.id,
  taskType: row.task_type,
  subjectModule: row.subject_module,
  subjectId: row.subject_id,
  requestedBy: row.requested_by,
  profileVersionId: row.profile_version_id,
  promptVersionId: row.prompt_version_id,
  dataClassification: row.data_classification,
  classificationBasis: row.classification_basis ?? [],
  anonymisationAttestationId: row.anonymisation_attestation_id,
  policyVersionId: row.policy_version_id,
  routeClass: row.route_class,
  providerId: row.provider_id,
  providerCode: row.provider_code,
  modelRefId: row.model_ref_id,
  modelId: row.model_id,
  status: row.status,
  rejectCode: row.reject_code,
  inputSha256: row.input_sha256,
  outputSha256: row.output_sha256,
  citationsCount: row.citations_count,
  budgetReservationId: row.budget_reservation_id,
  costVnd: row.cost_vnd,
  completedAt: iso(row.completed_at),
  createdAt: iso(row.created_at) as string,
  version: Number(row.version),
  pageKey: row.page_key,
});

const attemptOf = (row: Sql): AttemptRow => ({
  id: row.id,
  aiRequestId: row.ai_request_id,
  attemptNo: row.attempt_no,
  attemptKind: row.attempt_kind,
  routeClass: row.route_class,
  providerId: row.provider_id,
  providerCode: row.provider_code,
  actualModel: row.actual_model,
  outcome: row.outcome,
  latencyMs: row.latency_ms,
  inputTotal: row.input_total,
  cachedInput: row.cached_input,
  outputTotal: row.output_total,
  costVnd: row.cost_vnd,
  reconcileStatus: row.reconcile_status,
  createdAt: iso(row.created_at) as string,
  pageKey: row.page_key,
});

export interface NewRequest {
  taskType: string;
  subjectModule: string;
  subjectId: string | null;
  requestedBy: string;
  profileVersionId: string;
  promptVersionId: string | null;
  dataClassification: Classification;
  classificationBasis: unknown;
  anonymisationAttestationId: string | null;
  policyVersionId: string | null;
  inputSha256: string;
}

export interface RequestFinish {
  status: RequestStatus;
  rejectCode?: string | null;
  routeClass?: Route | null;
  providerId?: string | null;
  modelRefId?: string | null;
  outputSha256?: string | null;
  citationsCount?: number | null;
  budgetReservationId?: string | null;
  costVnd?: string | null;
  completed?: boolean;
}

/** The record of what the gateway did with each request: how it was classified, which route it took, every attempt, and what it cost; never what was asked or answered. */
export class LlmGatewayStore {
  /** The class of each source: the class of the document version is the source of truth, and a source that is not in the tenant, or whose file is not clean, is not one. */
  async sources(tx: TenantTx, ids: readonly string[]): Promise<SourceClass[]> {
    if (ids.length === 0) return [];
    const rows = await tx.query<Sql>('select id, classification, scan_status from machvon.document_version where id = any($1::uuid[])', [[...ids]]);
    const found = new Map(rows.map((row) => [row.id as string, row] as const));
    return ids.map((id) => {
      const row = found.get(id);
      if (row === undefined || row.scan_status !== 'CLEAN') throw new DomainError('VALIDATION_FAILED', 422, 'source_refs');
      return { documentVersionId: id, classification: row.classification as Classification };
    });
  }

  async admit(tx: TenantTx, input: NewRequest): Promise<AiRequestRow> {
    const id = randomUUID();
    await tx.query(
      `insert into machvon.ai_request (tenant_id, id, task_type, subject_module, subject_id, requested_by, profile_version_id, prompt_version_id, data_classification, classification_basis, anonymisation_attestation_id,
         policy_version_id, status, input_sha256, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8, $9::jsonb, $10::uuid, $11::uuid, 'ADMITTED', $12, $5::uuid, $5::uuid)`,
      [id, input.taskType, input.subjectModule, input.subjectId, input.requestedBy, input.profileVersionId, input.promptVersionId, input.dataClassification, JSON.stringify(input.classificationBasis), input.anonymisationAttestationId, input.policyVersionId, input.inputSha256],
    );
    return (await this.find(tx, id)) as AiRequestRow;
  }

  async finish(tx: TenantTx, id: string, finish: RequestFinish, actor: string): Promise<AiRequestRow> {
    await tx.query(
      `update machvon.ai_request set status = $2, reject_code = $3, route_class = coalesce($4, route_class), provider_id = coalesce($5::uuid, provider_id), model_ref_id = coalesce($6::uuid, model_ref_id),
         output_sha256 = $7, citations_count = $8, budget_reservation_id = coalesce($9::uuid, budget_reservation_id), cost_vnd = coalesce($10::numeric, cost_vnd),
         completed_at = case when $11::boolean then now() else completed_at end, updated_at = now(), updated_by = $12::uuid, version = version + 1
       where id = $1::uuid`,
      [id, finish.status, finish.rejectCode ?? null, finish.routeClass ?? null, finish.providerId ?? null, finish.modelRefId ?? null, finish.outputSha256 ?? null, finish.citationsCount ?? null, finish.budgetReservationId ?? null, finish.costVnd ?? null, finish.completed === true, actor],
    );
    return (await this.find(tx, id)) as AiRequestRow;
  }

  /** An attempt that gave no answer to pay for (the provider refused, failed or did not answer in time): it costs nothing that is known, and an attempt that timed out waits for the reconciliation. */
  async failedAttempt(
    tx: TenantTx,
    input: { requestId: string; attemptNo: number; kind: 'PRIMARY' | 'RETRY' | 'FALLBACK'; route: Route; providerId: string; actualModel: string; pricingVersionId: string; outcome: 'TIMEOUT' | 'REFUSAL' | 'PROVIDER_ERROR'; latencyMs: number },
  ): Promise<string> {
    const id = randomUUID();
    await tx.query(
      `insert into machvon.llm_attempt (tenant_id, id, run_id, provider_request_id, actual_model, pricing_version_id, input_total, cached_input, output_total, reasoning_info, cost, currency, reconcile_status,
         ai_request_id, attempt_no, attempt_kind, route_class, provider_id, outcome, latency_ms, noncached_input, tool_fee, fx_rate_to_vnd, cost_vnd)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, null, '', $2, $3::uuid, 0, 0, 0, 0, 0, 'VND', $4, $5::uuid, $6::int, $7, $8, $9::uuid, $10, $11::int, 0, 0, 1, 0)`,
      [id, input.actualModel, input.pricingVersionId, input.outcome === 'TIMEOUT' ? 'PENDING' : 'SETTLED', input.requestId, input.attemptNo, input.kind, input.route, input.providerId, input.outcome, input.latencyMs],
    );
    return id;
  }

  /** An answer that was paid for and then not used (it was not valid, or it cited nothing): the attempt keeps what it cost and says why it was not used. */
  async markAttemptOutcome(tx: TenantTx, attemptId: string, outcome: 'INVALID_JSON' | 'NO_CITATION'): Promise<void> {
    await tx.query('update machvon.llm_attempt set outcome = $2 where id = $1::uuid', [attemptId, outcome]);
  }

  async find(tx: TenantTx, id: string): Promise<AiRequestRow | undefined> {
    const rows = await tx.query<Sql>(`${REQUEST} where r.id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : requestOf(rows[0]);
  }

  async attemptsOf(tx: TenantTx, requestId: string): Promise<AttemptRow[]> {
    return (await tx.query<Sql>(`${ATTEMPT} where a.ai_request_id = $1::uuid order by a.attempt_no, a.created_at`, [requestId])).map(attemptOf);
  }

  async findAttempt(tx: TenantTx, id: string): Promise<AttemptRow | undefined> {
    const rows = await tx.query<Sql>(`${ATTEMPT} where a.id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : attemptOf(rows[0]);
  }

  /** A page of the attempts, the newest first. */
  async attempts(tx: TenantTx, filter: { limit: number; after?: { key: string; id: string } | undefined }): Promise<{ rows: AttemptRow[]; next: { key: string; id: string } | undefined }> {
    const rows = await tx.query<Sql>(
      `${ATTEMPT} where ($1::timestamp is null or (a.created_at at time zone 'UTC', a.id) < ($1::timestamp, $2::uuid)) order by a.created_at desc, a.id desc limit $3::int`,
      [filter.after?.key ?? null, filter.after?.id ?? null, filter.limit + 1],
    );
    const page = rows.slice(0, filter.limit).map(attemptOf);
    const last = page.at(-1);
    return { rows: page, next: rows.length > filter.limit && last !== undefined ? { key: last.pageKey, id: last.id } : undefined };
  }

  /** A page of the requests, the newest first, narrowed by what the reader asks for. */
  async requests(
    tx: TenantTx,
    filter: { status?: string | undefined; routeClass?: string | undefined; classification?: string | undefined; taskType?: string | undefined; limit: number; after?: { key: string; id: string } | undefined },
  ): Promise<{ rows: AiRequestRow[]; next: { key: string; id: string } | undefined }> {
    const rows = await tx.query<Sql>(
      `${REQUEST} where ($1::text is null or r.status = $1) and ($2::text is null or r.route_class = $2) and ($3::text is null or r.data_classification = $3) and ($4::text is null or r.task_type = $4)
         and ($5::timestamp is null or (r.created_at at time zone 'UTC', r.id) < ($5::timestamp, $6::uuid))
       order by r.created_at desc, r.id desc limit $7::int`,
      [filter.status ?? null, filter.routeClass ?? null, filter.classification ?? null, filter.taskType ?? null, filter.after?.key ?? null, filter.after?.id ?? null, filter.limit + 1],
    );
    const page = rows.slice(0, filter.limit).map(requestOf);
    const last = page.at(-1);
    return { rows: page, next: rows.length > filter.limit && last !== undefined ? { key: last.pageKey, id: last.id } : undefined };
  }

  /** The requests of the month that holds `day` (a day of Viet Nam), by route and by state: the overview reads its shares from here. */
  async summary(tx: TenantTx, periodStart: string): Promise<RequestSummary> {
    const rows = await tx.query<Sql>(
      `select route_class, status, count(*)::int as n from machvon.ai_request where (created_at at time zone 'Asia/Ho_Chi_Minh')::date >= $1::date and (created_at at time zone 'Asia/Ho_Chi_Minh')::date < ($1::date + interval '1 month') group by route_class, status`,
      [periodStart],
    );
    const byRoute: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    let total = 0;
    let blocked = 0;
    for (const row of rows) {
      total += row.n;
      byStatus[row.status] = (byStatus[row.status] ?? 0) + row.n;
      if (row.route_class !== null) byRoute[row.route_class] = (byRoute[row.route_class] ?? 0) + row.n;
      if (row.status === 'REJECTED_POLICY') blocked += row.n;
    }
    return { total, byRoute, byStatus, blocked, periodStart };
  }
}
