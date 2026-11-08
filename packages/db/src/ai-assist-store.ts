import { randomUUID } from 'node:crypto';
import { DomainError, assertWeightsComplete, parseChecklistItems, parseCriteria, versionConflict } from '@machvon/kernel';
import type { AssistKind, CheckedStatement, ReviewItemDef, CriterionDef, SourceRef } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

/**
 * The records of the AI assistant (lane AI-2): its runs (what it proposed, with the statements as verified), what a person decided about each run, the checklists a file is reviewed against and the sets of criteria a contract
 * is evaluated against. A run and a decision never change (the database refuses it); a checklist or a set of criteria is a draft until another person publishes it and then is frozen. Nothing here reads or writes a record of
 * another module: what the assistant read arrives as arguments and what it proposed stays in these tables.
 */

const UNIQUE_VIOLATION = '23505';
const TIME = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const PAGE_KEY = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`;
const MAX_LIST = 100;

interface Sql {
  [column: string]: unknown;
}

const uniqueViolation = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { code?: string }).code === UNIQUE_VIOLATION;

// ---- runs ---------------------------------------------------------------------------------------------------------------------------------------

export interface NewAssistRun {
  kind: AssistKind;
  subjectModule: string | null;
  subjectId: string | null;
  checklistId: string | null;
  criteriaSetId: string | null;
  requestText: string;
  sourceRefs: readonly SourceRef[];
  status: 'COMPLETED' | 'REFUSED' | 'FAILED';
  refusalCode: string | null;
  aiRequestId: string | null;
  dataClassification: string | null;
  routeClass: string | null;
  outputSha256: string | null;
  statements: readonly CheckedStatement[];
  result: Record<string, unknown>;
  counts: { statements: number; verified: number; unsupported: number; withheldCitations: number };
  injectionSignals: number;
  completeness: 'FULL' | 'PARTIAL' | 'NONE';
  askedBy: string;
}

export interface AssistRunRow {
  id: string;
  kind: AssistKind;
  subjectModule: string | null;
  subjectId: string | null;
  checklistId: string | null;
  criteriaSetId: string | null;
  requestText: string;
  sourceRefs: SourceRef[];
  status: 'COMPLETED' | 'REFUSED' | 'FAILED';
  refusalCode: string | null;
  aiRequestId: string | null;
  dataClassification: string | null;
  routeClass: string | null;
  outputSha256: string | null;
  statements: CheckedStatement[];
  result: Record<string, unknown>;
  statementCount: number;
  verifiedCount: number;
  unsupportedCount: number;
  withheldCitationCount: number;
  injectionSignalCount: number;
  completeness: 'FULL' | 'PARTIAL' | 'NONE';
  advisory: true;
  askedBy: string;
  createdAt: string;
  pageKey: string;
}

export interface AssistDecisionRow {
  id: string;
  runId: string;
  decision: 'ACCEPTED' | 'ACCEPTED_WITH_CHANGE' | 'REJECTED';
  rationale: string;
  items: unknown[];
  acceptedResult: Record<string, unknown>;
  aiDecisionRecordId: string;
  decidedBy: string;
  decidedAt: string;
}

const RUN_COLUMNS = `r.id, r.kind, r.subject_module, r.subject_id, r.checklist_id, r.criteria_set_id, r.request_text, r.source_refs, r.status, r.refusal_code, r.ai_request_id, r.data_classification, r.route_class,
  r.output_sha256, r.statements, r.result, r.statement_count, r.verified_count, r.unsupported_count, r.withheld_citation_count, r.injection_signal_count, r.completeness, r.asked_by,
  ${TIME('r.created_at')} as created_at, ${PAGE_KEY('r.created_at')} as page_key`;

const toRun = (row: Sql): AssistRunRow => ({
  id: row.id as string,
  kind: row.kind as AssistKind,
  subjectModule: row.subject_module as string | null,
  subjectId: row.subject_id as string | null,
  checklistId: row.checklist_id as string | null,
  criteriaSetId: row.criteria_set_id as string | null,
  requestText: row.request_text as string,
  sourceRefs: row.source_refs as SourceRef[],
  status: row.status as AssistRunRow['status'],
  refusalCode: row.refusal_code as string | null,
  aiRequestId: row.ai_request_id as string | null,
  dataClassification: row.data_classification as string | null,
  routeClass: row.route_class as string | null,
  outputSha256: (row.output_sha256 as string | null)?.trim() ?? null,
  statements: row.statements as CheckedStatement[],
  result: row.result as Record<string, unknown>,
  statementCount: row.statement_count as number,
  verifiedCount: row.verified_count as number,
  unsupportedCount: row.unsupported_count as number,
  withheldCitationCount: row.withheld_citation_count as number,
  injectionSignalCount: row.injection_signal_count as number,
  completeness: row.completeness as AssistRunRow['completeness'],
  advisory: true,
  askedBy: row.asked_by as string,
  createdAt: row.created_at as string,
  pageKey: row.page_key as string,
});

export interface RunFilter {
  kind?: string | undefined;
  status?: string | undefined;
  limit: number;
  after?: { key: string; id: string } | undefined;
}

export interface Page<R> {
  rows: R[];
  next?: { key: string; id: string };
}

export class AiAssistStore {
  async insertRun(tx: TenantTx, run: NewAssistRun): Promise<AssistRunRow> {
    const id = randomUUID();
    await tx.query(
      `insert into machvon.ai_assist_run (tenant_id, id, kind, subject_module, subject_id, checklist_id, criteria_set_id, request_text, source_refs, status, refusal_code, ai_request_id, data_classification, route_class, output_sha256,
         statements, result, statement_count, verified_count, unsupported_count, withheld_citation_count, injection_signal_count, completeness, asked_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4::uuid, $5::uuid, $6::uuid, $7, $8::jsonb, $9, $10, $11::uuid, $12, $13, $14, $15::jsonb, $16::jsonb, $17::int, $18::int, $19::int, $20::int, $21::int, $22, $23::uuid)`,
      [
        id,
        run.kind,
        run.subjectModule,
        run.subjectId,
        run.checklistId,
        run.criteriaSetId,
        run.requestText,
        JSON.stringify(run.sourceRefs),
        run.status,
        run.refusalCode,
        run.aiRequestId,
        run.dataClassification,
        run.routeClass,
        run.outputSha256,
        JSON.stringify(run.statements),
        JSON.stringify(run.result),
        run.counts.statements,
        run.counts.verified,
        run.counts.unsupported,
        run.counts.withheldCitations,
        run.injectionSignals,
        run.completeness,
        run.askedBy,
      ],
    );
    return (await this.findRun(tx, id)) as AssistRunRow;
  }

  /** One run; `askedBy` narrows it to the person who asked (a run is the asker's own: nobody else reads what was proposed to them). */
  async findRun(tx: TenantTx, id: string, askedBy?: string): Promise<AssistRunRow | undefined> {
    const rows = await tx.query<Sql>(`select ${RUN_COLUMNS} from machvon.ai_assist_run r where r.id = $1::uuid and ($2::uuid is null or r.asked_by = $2::uuid)`, [id, askedBy ?? null]);
    return rows[0] === undefined ? undefined : toRun(rows[0]);
  }

  async listRuns(tx: TenantTx, askedBy: string, filter: RunFilter): Promise<Page<AssistRunRow>> {
    const limit = Math.min(Math.max(filter.limit, 1), MAX_LIST);
    const rows = await tx.query<Sql>(
      `select ${RUN_COLUMNS} from machvon.ai_assist_run r
        where r.asked_by = $1::uuid and ($2::text is null or r.kind = $2) and ($3::text is null or r.status = $3)
          and ($4::text is null or (${PAGE_KEY('r.created_at')}, r.id::text) < ($4::text, $5::text))
        order by r.created_at desc, r.id desc limit $6::int`,
      [askedBy, filter.kind ?? null, filter.status ?? null, filter.after?.key ?? null, filter.after?.id ?? null, limit + 1],
    );
    const mapped = rows.map(toRun);
    const page = mapped.slice(0, limit);
    const last = page[page.length - 1];
    return mapped.length > limit && last !== undefined ? { rows: page, next: { key: last.pageKey, id: last.id } } : { rows: page };
  }

  // ---- decisions --------------------------------------------------------------------------------------------------------------------------

  /** What was decided about each of these runs (the runs that have no decision are not in the map). */
  async decisionsOf(tx: TenantTx, runIds: readonly string[]): Promise<Map<string, AssistDecisionRow['decision']>> {
    if (runIds.length === 0) return new Map();
    const rows = await tx.query<Sql>('select run_id, decision from machvon.ai_assist_decision where run_id = any($1::uuid[])', [[...runIds]]);
    return new Map(rows.map((row) => [row.run_id as string, row.decision as AssistDecisionRow['decision']] as const));
  }

  async findDecision(tx: TenantTx, runId: string): Promise<AssistDecisionRow | undefined> {
    const rows = await tx.query<Sql>(
      `select id, run_id, decision, rationale, items, accepted_result, ai_decision_record_id, decided_by, ${TIME('decided_at')} as decided_at from machvon.ai_assist_decision where run_id = $1::uuid`,
      [runId],
    );
    const row = rows[0];
    return row === undefined
      ? undefined
      : {
          id: row.id as string,
          runId: row.run_id as string,
          decision: row.decision as AssistDecisionRow['decision'],
          rationale: row.rationale as string,
          items: row.items as unknown[],
          acceptedResult: row.accepted_result as Record<string, unknown>,
          aiDecisionRecordId: row.ai_decision_record_id as string,
          decidedBy: row.decided_by as string,
          decidedAt: row.decided_at as string,
        };
  }

  /** Writes the decision about a run, once: a second decision is 409 `AI_ASSIST_ALREADY_DECIDED`. */
  async recordDecision(
    tx: TenantTx,
    input: { runId: string; decision: string; rationale: string; items: readonly unknown[]; acceptedResult: Record<string, unknown>; aiDecisionRecordId: string; actor: string },
  ): Promise<AssistDecisionRow> {
    await tx.query('savepoint ai_assist_decision');
    try {
      await tx.query(
        `insert into machvon.ai_assist_decision (tenant_id, id, run_id, decision, rationale, items, accepted_result, ai_decision_record_id, decided_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, $3, $4::jsonb, $5::jsonb, $6::uuid, $7::uuid)`,
        [input.runId, input.decision, input.rationale, JSON.stringify(input.items), JSON.stringify(input.acceptedResult), input.aiDecisionRecordId, input.actor],
      );
      await tx.query('release savepoint ai_assist_decision');
    } catch (error) {
      await tx.query('rollback to savepoint ai_assist_decision');
      if (uniqueViolation(error)) throw new DomainError('AI_ASSIST_ALREADY_DECIDED', 409, 'run_id');
      throw error;
    }
    return (await this.findDecision(tx, input.runId)) as AssistDecisionRow;
  }

  // ---- checklists -------------------------------------------------------------------------------------------------------------------------

  async createChecklist(tx: TenantTx, input: { code: string; title: string; appliesTo: string; items: unknown; actor: string }): Promise<ChecklistRow> {
    const items = parseChecklistItems(input.items);
    const revision = Number((await tx.query<Sql>('select coalesce(max(revision), 0) + 1 as next from machvon.ai_review_checklist where code = $1', [input.code]))[0]?.next ?? 1);
    // A new revision is made from a published one or from nothing; two drafts of a code at once are one too many.
    const open = await tx.query('select 1 from machvon.ai_review_checklist where code = $1 and status = $2', [input.code, 'DRAFT']);
    if (open.length > 0) throw new DomainError('CHECKLIST_DRAFT_EXISTS', 409, 'code');
    const id = randomUUID();
    await tx.query(
      `insert into machvon.ai_review_checklist (tenant_id, id, code, revision, title, applies_to, created_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3::int, $4, $5, $6::uuid)`,
      [id, input.code, revision, input.title, input.appliesTo, input.actor],
    );
    let position = 0;
    for (const item of items) {
      position += 1;
      await tx.query(
        `insert into machvon.ai_review_checklist_item (tenant_id, id, checklist_id, item_code, position, label, check_kind, params, severity)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, $3::int, $4, $5, $6::jsonb, $7)`,
        [id, item.code, position, item.label, item.kind, JSON.stringify(item.params), item.severity],
      );
    }
    return (await this.findChecklist(tx, id)) as ChecklistRow;
  }

  async findChecklist(tx: TenantTx, id: string, lock = false): Promise<ChecklistRow | undefined> {
    const rows = await tx.query<Sql>(
      `select id, code, revision, title, applies_to, status, created_by, ${TIME('created_at')} as created_at, published_by, ${TIME('published_at')} as published_at, version::text as version
         from machvon.ai_review_checklist where id = $1::uuid${lock ? ' for update' : ''}`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    const items = await tx.query<Sql>('select item_code, label, check_kind, params, severity from machvon.ai_review_checklist_item where checklist_id = $1::uuid order by position', [id]);
    return {
      id: row.id as string,
      code: row.code as string,
      revision: row.revision as number,
      title: row.title as string,
      appliesTo: row.applies_to as string,
      status: row.status as ChecklistRow['status'],
      createdBy: row.created_by as string,
      createdAt: row.created_at as string,
      publishedBy: row.published_by as string | null,
      publishedAt: row.published_at as string | null,
      version: Number(row.version),
      items: items.map((item) => ({ code: item.item_code as string, label: item.label as string, kind: item.check_kind as ReviewItemDef['kind'], params: item.params as Record<string, unknown>, severity: item.severity as ReviewItemDef['severity'] })),
    };
  }

  async listChecklists(tx: TenantTx, filter: { status?: string | undefined; appliesTo?: string | undefined }): Promise<ChecklistRow[]> {
    const ids = await tx.query<Sql>('select id from machvon.ai_review_checklist where ($1::text is null or status = $1) and ($2::text is null or applies_to = $2) order by code, revision desc limit 200', [filter.status ?? null, filter.appliesTo ?? null]);
    const rows: ChecklistRow[] = [];
    for (const entry of ids) rows.push((await this.findChecklist(tx, entry.id as string)) as ChecklistRow);
    return rows;
  }

  /** Publishes a draft: by another person than its author; the revision in force of the code is retired in the same step. */
  async publishChecklist(tx: TenantTx, id: string, expectedVersion: number, actor: string): Promise<{ row: ChecklistRow; retiredId: string | null }> {
    const current = await this.findChecklist(tx, id, true);
    if (current === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (current.version !== expectedVersion) throw versionConflict(current.version);
    if (current.status !== 'DRAFT') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    if (current.createdBy === actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    const previous = await tx.query<Sql>("select id from machvon.ai_review_checklist where code = $1 and status = 'PUBLISHED' for update", [current.code]);
    const retiredId = (previous[0]?.id as string | undefined) ?? null;
    if (retiredId !== null) await tx.query("update machvon.ai_review_checklist set status = 'RETIRED', version = version + 1 where id = $1::uuid", [retiredId]);
    await tx.query("update machvon.ai_review_checklist set status = 'PUBLISHED', published_by = $2::uuid, published_at = now(), version = version + 1 where id = $1::uuid", [id, actor]);
    return { row: (await this.findChecklist(tx, id)) as ChecklistRow, retiredId };
  }

  // ---- sets of criteria -------------------------------------------------------------------------------------------------------------------

  async createCriteriaSet(tx: TenantTx, input: { code: string; title: string; scaleMax: number; criteria: unknown; actor: string }): Promise<CriteriaSetRow> {
    const criteria = parseCriteria(input.criteria, input.scaleMax);
    const revision = Number((await tx.query<Sql>('select coalesce(max(revision), 0) + 1 as next from machvon.ai_eval_criteria_set where code = $1', [input.code]))[0]?.next ?? 1);
    const open = await tx.query('select 1 from machvon.ai_eval_criteria_set where code = $1 and status = $2', [input.code, 'DRAFT']);
    if (open.length > 0) throw new DomainError('CRITERIA_DRAFT_EXISTS', 409, 'code');
    const id = randomUUID();
    await tx.query(
      `insert into machvon.ai_eval_criteria_set (tenant_id, id, code, revision, title, scale_max, created_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3::int, $4, $5::int, $6::uuid)`,
      [id, input.code, revision, input.title, input.scaleMax, input.actor],
    );
    let position = 0;
    for (const criterion of criteria) {
      position += 1;
      await tx.query(
        `insert into machvon.ai_eval_criterion (tenant_id, id, criteria_set_id, criterion_code, position, label, guidance, weight_bp, evidence_required)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, $3::int, $4, $5, $6::int, $7::boolean)`,
        [id, criterion.code, position, criterion.label, criterion.guidance, criterion.weightBp, criterion.evidenceRequired],
      );
    }
    return (await this.findCriteriaSet(tx, id)) as CriteriaSetRow;
  }

  async findCriteriaSet(tx: TenantTx, id: string, lock = false): Promise<CriteriaSetRow | undefined> {
    const rows = await tx.query<Sql>(
      `select id, code, revision, title, scale_max, status, created_by, ${TIME('created_at')} as created_at, published_by, ${TIME('published_at')} as published_at, version::text as version
         from machvon.ai_eval_criteria_set where id = $1::uuid${lock ? ' for update' : ''}`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    const items = await tx.query<Sql>('select criterion_code, label, guidance, weight_bp, evidence_required from machvon.ai_eval_criterion where criteria_set_id = $1::uuid order by position', [id]);
    return {
      id: row.id as string,
      code: row.code as string,
      revision: row.revision as number,
      title: row.title as string,
      scaleMax: row.scale_max as number,
      status: row.status as CriteriaSetRow['status'],
      createdBy: row.created_by as string,
      createdAt: row.created_at as string,
      publishedBy: row.published_by as string | null,
      publishedAt: row.published_at as string | null,
      version: Number(row.version),
      criteria: items.map((item) => ({ code: item.criterion_code as string, label: item.label as string, guidance: item.guidance as string, weightBp: item.weight_bp as number, evidenceRequired: item.evidence_required as boolean })),
    };
  }

  async listCriteriaSets(tx: TenantTx, filter: { status?: string | undefined }): Promise<CriteriaSetRow[]> {
    const ids = await tx.query<Sql>('select id from machvon.ai_eval_criteria_set where ($1::text is null or status = $1) order by code, revision desc limit 200', [filter.status ?? null]);
    const rows: CriteriaSetRow[] = [];
    for (const entry of ids) rows.push((await this.findCriteriaSet(tx, entry.id as string)) as CriteriaSetRow);
    return rows;
  }

  /** Publishes a draft set: its weights add up to 10000 basis points, and by another person than its author; the set in force of the code is retired in the same step. */
  async publishCriteriaSet(tx: TenantTx, id: string, expectedVersion: number, actor: string): Promise<{ row: CriteriaSetRow; retiredId: string | null }> {
    const current = await this.findCriteriaSet(tx, id, true);
    if (current === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (current.version !== expectedVersion) throw versionConflict(current.version);
    if (current.status !== 'DRAFT') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    assertWeightsComplete(current.criteria);
    if (current.createdBy === actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    const previous = await tx.query<Sql>("select id from machvon.ai_eval_criteria_set where code = $1 and status = 'PUBLISHED' for update", [current.code]);
    const retiredId = (previous[0]?.id as string | undefined) ?? null;
    if (retiredId !== null) await tx.query("update machvon.ai_eval_criteria_set set status = 'RETIRED', version = version + 1 where id = $1::uuid", [retiredId]);
    await tx.query("update machvon.ai_eval_criteria_set set status = 'PUBLISHED', published_by = $2::uuid, published_at = now(), version = version + 1 where id = $1::uuid", [id, actor]);
    return { row: (await this.findCriteriaSet(tx, id)) as CriteriaSetRow, retiredId };
  }
}

export interface ChecklistRow {
  id: string;
  code: string;
  revision: number;
  title: string;
  appliesTo: string;
  status: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  createdBy: string;
  createdAt: string;
  publishedBy: string | null;
  publishedAt: string | null;
  version: number;
  items: ReviewItemDef[];
}

export interface CriteriaSetRow {
  id: string;
  code: string;
  revision: number;
  title: string;
  scaleMax: number;
  status: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  createdBy: string;
  createdAt: string;
  publishedBy: string | null;
  publishedAt: string | null;
  version: number;
  criteria: CriterionDef[];
}
