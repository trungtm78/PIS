/**
 * What a query of BI costs before it is run (ST-BI-009, BI 3 F3): the lines of the snapshot it reads, times how many groups the dimension makes of them. A query over the cost a screen can wait for is not answered in
 * the request; it becomes a job that is run later under the scope its reader has then, and its answer is kept for the reader to ask again.
 */

/** How many times the lines are touched by a dimension: a dimension that makes many groups (a project) costs more than one that makes few (a budget level). No dimension is the total, read once. */
export const BI_DIMENSION_WEIGHTS: Readonly<Record<string, number>> = { project: 8, unit: 3, fund_source: 3, budget_level: 1, bucket: 1 };

/** The weight of a query with no dimension (the total alone). */
export const BI_TOTAL_WEIGHT = 1;

/** The cost a query may have and still be answered in the request. */
export const BI_SYNC_COST_LIMIT = 250_000;

/** How long the answer of a job that was run is kept for its reader to ask for again. */
export const BI_RESULT_TTL_SECONDS = 3600;

/** How many queued jobs one pass of the worker takes. */
export const BI_JOB_BATCH = 25;

/** The cost of a query, in units: the lines of the snapshot times the weight of the dimension; a filter narrows the lines it reads, so it costs nothing. */
export function estimateQueryCost(input: { snapshotRows: number; dimension: string | undefined }): number {
  const rows = Number.isFinite(input.snapshotRows) && input.snapshotRows > 0 ? Math.floor(input.snapshotRows) : 0;
  const weight = input.dimension === undefined ? BI_TOTAL_WEIGHT : (BI_DIMENSION_WEIGHTS[input.dimension] ?? Math.max(...Object.values(BI_DIMENSION_WEIGHTS)));
  return rows * weight;
}

/** Whether a query is too heavy for the request: strictly over the limit. */
export const isHeavyQuery = (cost: number, limit: number = BI_SYNC_COST_LIMIT): boolean => cost > limit;
