import { DomainError, pwfKpi } from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import { EXCUSAL_MARK_SQL, calendarFingerprint, dayOfInstant, factsOf, itemsFor, loadCalendars, loadKpiSets, loadTaskBundles, readingOf, yearSpanOf } from './pwf-score-facts.ts';
import type { CalendarSet, ResolvedKpiSet, TaskBundle, TaskReading } from './pwf-score-facts.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import { scoreIdOf } from './pwf-score-support.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The KPIs of the tasks of a workflow (PWF-3, docs PWF 3 F9, BR-PWF-30 to 33, R34, R37). When a task is done or cancelled, one `task_kpi_result` is written for each KPI of the set that measures it: the value an
 * operation of the closed catalogue gave on the facts of the task, the score its scale made of it, the weight, and the hash of the facts read. A result is never edited: when the facts of a closed task change (a
 * corrected amount, a calendar published later) the result is read again and, if the hash differs, a NEW row names the old one (`supersedes_id`). The pass is idempotent and incremental: a task is read again only
 * when its version moved since its results were last evaluated (`kpi_recorded_version`).
 */

export interface KpiResultRow {
  id: string;
  taskId: string;
  kpiCode: string;
  operation: pwfKpi.KpiOperationCode;
  kpiSetRuleId: string | null;
  kpiSetVersion: number;
  state: pwfKpi.OperationState;
  value: number | null;
  score: number | null;
  weight: number;
  inputsHash: string;
  inputs: Record<string, unknown>;
  computedAt: string;
  supersedesId: string | null;
}

interface ResultSql {
  id: string;
  task_id: string;
  kpi_code: string;
  operation: pwfKpi.KpiOperationCode;
  kpi_set_rule_id: string | null;
  kpi_set_version: number;
  state: pwfKpi.OperationState;
  value: string | null;
  score: string | null;
  weight: string;
  inputs_hash: string;
  inputs: Record<string, unknown>;
  computed_at: string;
  supersedes_id: string | null;
}

const RESULT_COLUMNS = `id, task_id, kpi_code, operation, kpi_set_rule_id, kpi_set_version, state, value::text as value, score::text as score, weight::text as weight, inputs_hash, inputs,
  to_char(computed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as computed_at, supersedes_id`;

const toResult = (row: ResultSql): KpiResultRow => ({
  id: row.id,
  taskId: row.task_id,
  kpiCode: row.kpi_code,
  operation: row.operation,
  kpiSetRuleId: row.kpi_set_rule_id,
  kpiSetVersion: row.kpi_set_version,
  state: row.state,
  value: row.value === null ? null : Number(row.value),
  score: row.score === null ? null : Number(row.score),
  weight: Number(row.weight),
  inputsHash: row.inputs_hash,
  inputs: row.inputs,
  computedAt: row.computed_at,
  supersedesId: row.supersedes_id,
});

const INSERT_CHUNK = 2000;

/** What a pass wrote: the tasks it looked at, the results it added and the ones it left because nothing changed. */
export interface RecordSummary {
  tasks: number;
  written: number;
  unchanged: number;
}

/** A catalogue entry for the screens: what an operation is called, in which unit it speaks, which way is good, which facts it reads and which parameters it takes. */
export interface KpiOperationEntry {
  code: pwfKpi.KpiOperationCode;
  unit: pwfKpi.KpiOperationUnit;
  goodDirection: 'LOWER_IS_BETTER' | 'HIGHER_IS_BETTER';
  requiredFacts: string[];
  params: Array<{ name: string; type: string; required: boolean }>;
}

const snake = (name: string): string => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

const OPERATION_PARAMS: Readonly<Record<pwfKpi.KpiOperationCode, ReadonlyArray<{ name: string; type: string; required: boolean }>>> = {
  DAYS_DEVIATION: [
    { name: 'unit', type: 'CALENDAR|WORKING', required: false },
    { name: 'against', type: 'FIRST_BASELINE|CURRENT_BASELINE', required: false },
  ],
  ON_TIME_RATE: [
    { name: 'unit', type: 'CALENDAR|WORKING', required: false },
    { name: 'against', type: 'FIRST_BASELINE|CURRENT_BASELINE', required: false },
    { name: 'grace_days', type: 'integer 0..30', required: false },
  ],
  AMOUNT_VARIANCE_PCT: [],
  RETURN_COUNT: [],
  EVIDENCE_COMPLETENESS: [],
  RESCHEDULE_COUNT: [],
};

/** The closed catalogue of the operations, for the editors of a KPI set (`getKpiOperations`). */
export function kpiOperations(): KpiOperationEntry[] {
  return pwfKpi.KPI_OPERATION_CODES.map((code) => {
    const operation = pwfKpi.kpiOperationOf(code);
    return { code, unit: operation.unit, goodDirection: operation.direction, requiredFacts: operation.reads.map((name) => snake(name)), params: OPERATION_PARAMS[code].map((one) => ({ ...one })) };
  });
}

/** The inputs of one result: what the operation read and how, so that the "i" of a figure can show them and a recomputation is checked against them. */
export function inputsOf(item: pwfKpi.KpiSetItem, facts: pwfKpi.TaskFacts, calendars: CalendarSet): Record<string, unknown> {
  const operation = pwfKpi.kpiOperationOf(item.operation);
  return {
    operation: item.operation,
    params: item.operationParams,
    facts: Object.fromEntries(operation.reads.map((key) => [key, facts[key]])),
    as_of: facts.asOf,
    calendars: calendars.versions,
    scale: item.scale,
    rag_code: item.ragCode,
  };
}

/** The results of the KPIs of a set for one task read as of a day, in memory (nothing is written). */
export function scoreBundle(bundle: TaskBundle, reading: TaskReading, cutoff: string, resolved: ResolvedKpiSet, calendars: CalendarSet): Array<{ item: pwfKpi.KpiSetItem; result: pwfKpi.TaskKpiResult; inputs: Record<string, unknown> }> {
  const facts = factsOf(bundle, reading, cutoff);
  const context: pwfKpi.OperationContext = calendars.source === undefined ? {} : { calendars: calendars.source, calendarVersions: calendars.versions };
  return itemsFor(resolved.set, bundle).map((item) => ({ item, result: pwfKpi.scoreTask(facts, item, context), inputs: inputsOf(item, facts, calendars) }));
}

export class PwfKpiStore {
  private readonly policy = new GovernancePolicyPort();

  /** The ids of the tasks, done or cancelled, whose results were never evaluated or whose task moved since (a limited batch: the job asks again until none is left). */
  async pendingTaskIds(tx: TenantTx, limit: number): Promise<string[]> {
    const fingerprint = await calendarFingerprint(tx);
    const rows = await tx.query<{ id: string }>(
      `select t.id from machvon.project_task t
        where t.tracked and not t.excluded and t.kind = 'TASK' and t.status in ('DONE', 'CANCELLED')
          and (t.kpi_recorded_version is null or t.kpi_recorded_version <> t.version or t.kpi_recorded_calendars is distinct from $2 || '|' || ${EXCUSAL_MARK_SQL})
        order by t.updated_at, t.id limit $1`,
      [limit, fingerprint],
    );
    return rows.map((row) => row.id);
  }

  /**
   * Reads the tasks given as of the day each was closed and writes what is new. A task that is not done or cancelled is not read here (an open task has no final result; a period reads it in memory). The set of KPIs is
   * the one of the template of its workflow on the day the task was closed. Safe to run twice and from two processes at once: a head that already carries the same hash is left alone, and the unique indexes of the table
   * refuse a second head.
   */
  async record(tx: TenantTx, taskIds: readonly string[], now: Date): Promise<RecordSummary> {
    const summary: RecordSummary = { tasks: 0, written: 0, unchanged: 0 };
    if (taskIds.length === 0) return summary;
    // Two passes at once (the job and a period that asks for the results it needs) take turns: neither writes a head the other is about to write.
    await tx.query("select pg_advisory_xact_lock(hashtextextended('pwf-kpi:' || coalesce(current_setting('app.tenant_id', true), ''), 0))");
    // Taken before the calendars are read: a calendar published meanwhile leaves the watermark older than the calendars, so the task is read again and never frozen on stale ones.
    const fingerprint = await calendarFingerprint(tx);
    const bundles = await loadTaskBundles(tx, taskIds.map((id) => scoreIdOf(id, 'task_id')));
    const closed = [...bundles.values()].filter((bundle) => bundle.row.status === 'DONE' || bundle.row.status === 'CANCELLED');
    const today = dayOfInstant(now);
    const readings = new Map<string, TaskReading>();
    for (const bundle of closed) {
      const closedOn = bundle.row.status === 'DONE' ? bundle.row.actualFinish : bundle.row.cancelledOn;
      if (closedOn === null) continue;
      readings.set(bundle.row.id, readingOf(bundle.row, closedOn));
    }
    if (readings.size === 0) return summary;
    const span = yearSpanOf(
      closed.flatMap((bundle) => [bundle.row.baselineFirst, bundle.row.baselineCurrent, bundle.row.actualFinish, bundle.row.cancelledOn]),
      today,
    );
    const calendars = await loadCalendars(tx, span.from, span.to);
    const sets = loadKpiSets(tx, this.policy);
    const heads = await tx.query<ResultSql>(
      `select ${RESULT_COLUMNS} from machvon.task_kpi_result r where r.task_id = any($1::uuid[]) and not exists (select 1 from machvon.task_kpi_result n where n.tenant_id = r.tenant_id and n.supersedes_id = r.id)`,
      [[...readings.keys()]],
    );
    const headOf = new Map(heads.map((row) => [`${row.task_id}:${row.kpi_code}`, row] as const));
    const rows: Array<Record<string, unknown>> = [];
    for (const bundle of closed) {
      const reading = readings.get(bundle.row.id);
      if (reading === undefined) continue;
      summary.tasks += 1;
      const resolved = await sets.forTemplate(bundle.workflow.templateCode, reading.closedOn as string);
      for (const scored of scoreBundle(bundle, reading, reading.closedOn as string, resolved, calendars)) {
        const head = headOf.get(`${bundle.row.id}:${scored.item.kpiCode}`);
        if (head !== undefined && head.inputs_hash === scored.result.inputsHash) {
          summary.unchanged += 1;
          continue;
        }
        rows.push({
          task_id: bundle.row.id,
          workflow_id: bundle.row.workflowId,
          kpi_code: scored.item.kpiCode,
          operation: scored.item.operation,
          kpi_set_code: resolved.code,
          kpi_set_rule_id: resolved.ruleId,
          kpi_set_version: resolved.version,
          state: scored.result.state,
          value: scored.result.value,
          score: scored.result.score,
          weight: scored.result.weight,
          as_of: reading.closedOn,
          inputs_hash: scored.result.inputsHash,
          inputs: scored.inputs,
          supersedes_id: head?.id ?? null,
        });
      }
    }
    // One statement for each chunk of results, whatever the number of tasks (R35): a tenant that closes thousands of tasks in a day is not thousands of round trips.
    for (let at = 0; at < rows.length; at += INSERT_CHUNK) {
      await tx.query(
        `insert into machvon.task_kpi_result (tenant_id, task_id, workflow_id, kpi_code, operation, kpi_set_code, kpi_set_rule_id, kpi_set_version, state, value, score, weight, as_of, inputs_hash, inputs, supersedes_id)
         select nullif(current_setting('app.tenant_id', true), '')::uuid, x.task_id, x.workflow_id, x.kpi_code, x.operation, x.kpi_set_code, x.kpi_set_rule_id, x.kpi_set_version, x.state, x.value, x.score, x.weight, x.as_of, x.inputs_hash, x.inputs, x.supersedes_id
           from jsonb_to_recordset($1::jsonb) as x(task_id uuid, workflow_id uuid, kpi_code text, operation text, kpi_set_code text, kpi_set_rule_id uuid, kpi_set_version integer, state text, value numeric, score numeric, weight numeric, as_of date, inputs_hash text, inputs jsonb, supersedes_id uuid)`,
        [JSON.stringify(rows.slice(at, at + INSERT_CHUNK))],
      );
    }
    summary.written = rows.length;
    await tx.query(`update machvon.project_task t set kpi_recorded_version = t.version, kpi_recorded_calendars = $2 || '|' || ${EXCUSAL_MARK_SQL} where t.id = any($1::uuid[])`, [[...readings.keys()], fingerprint]);
    return summary;
  }

  /** The head result of every KPI of the tasks given (the row nobody supersedes). */
  async heads(tx: TenantTx, taskIds: readonly string[], withInputs = true): Promise<Map<string, KpiResultRow[]>> {
    const map = new Map<string, KpiResultRow[]>();
    if (taskIds.length === 0) return map;
    const rows = await tx.query<ResultSql>(
      `select ${withInputs ? RESULT_COLUMNS : RESULT_COLUMNS.replace(' inputs,', " '{}'::jsonb as inputs,")} from machvon.task_kpi_result r where r.task_id = any($1::uuid[]) and not exists (select 1 from machvon.task_kpi_result n where n.tenant_id = r.tenant_id and n.supersedes_id = r.id) order by r.kpi_code`,
      [[...taskIds]],
    );
    for (const row of rows) map.set(row.task_id, [...(map.get(row.task_id) ?? []), toResult(row)]);
    return map;
  }

  /**
   * The results of the KPIs of a task, newest KPI first by code and, inside a code, the newest row first (a correction is listed above what it replaced), in pages. The task is judged in the scope of the caller: a task
   * out of it is not there (404).
   */
  async list(tx: TenantTx, scope: ScopeBuilder, taskId: string, page: { limit: number; after?: { code: string; id: string } | undefined }): Promise<{ items: KpiResultRow[]; next: { code: string; id: string } | null }> {
    const id = scoreIdOf(taskId, 'task_id');
    const predicate = scope(2);
    const found = await tx.query<{ id: string }>(`select t.id from ${SCOPE_FROM} join machvon.project_task t on t.tenant_id = p.tenant_id and t.project_id = p.id where t.id = $1::uuid and ${predicate.sql}`, [id, ...predicate.params]);
    if (found[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const after = page.after;
    const rows = await tx.query<ResultSql & { cursor: string }>(
      `select ${RESULT_COLUMNS}, to_char(computed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || kpi_code as cursor from machvon.task_kpi_result r
        where r.task_id = $1::uuid and ($2::timestamptz is null or (r.computed_at, r.id) < ($2::timestamptz, $3::uuid)) order by r.computed_at desc, r.id desc limit $4`,
      [id, after?.code ?? null, after?.id ?? null, page.limit + 1],
    );
    const shown = rows.slice(0, page.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(toResult), next: rows.length > shown.length && last !== undefined ? { code: last.cursor.split('|')[0] as string, id: last.id } : null };
  }
}
