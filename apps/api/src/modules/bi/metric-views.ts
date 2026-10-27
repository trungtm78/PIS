import type { MetricRow } from '@machvon/db';

/**
 * The revision of a metric as the registry exposes it (x-exposure keep: every field of the baseline stays, the fields of the story are added): the definition, where it comes from, who wrote it
 * and who certified it. A metric of the platform carries the commit it came from and the hash of its definition.
 */
export function metricView(row: MetricRow): Record<string, unknown> {
  return {
    id: row.id,
    code: row.code,
    revision: row.revision,
    grain: row.grain,
    aggregation_type: row.aggregationType,
    expression_ast: row.expressionAst,
    numerator_ast: row.numeratorAst,
    denominator_ast: row.denominatorAst,
    unit: row.unit,
    owner_id: row.ownerId,
    status: row.status,
    origin: row.origin,
    source_commit: row.sourceCommit,
    definition_sha256: row.definitionSha256,
    null_policy: row.nullPolicy,
    dimension_codes: row.dimensionCodes,
    dataset_id: row.datasetId,
    glossary_term_id: row.glossaryTermId,
    effective_from: row.effectiveFrom,
    effective_until: row.effectiveUntil,
    supersedes_id: row.supersedesId,
    certified_by: row.certifiedBy,
    certified_at: row.certifiedAt,
    created_at: row.createdAt,
    created_by: row.createdBy,
    version: row.version,
  };
}
