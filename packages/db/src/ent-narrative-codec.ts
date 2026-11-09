import { NARRATIVE_FIELDS, NARRATIVE_PACK_ENTERPRISE, NARRATIVE_PACK_VERSION } from '@machvon/kernel';
import type { DirectiveRef, EnterpriseNarrative, NarrativeField, NarrativeInheritance } from '@machvon/kernel';

/**
 * How the enterprise block of the narrative of a report (ENT-3b) is read from and written to the pack columns of `report_narrative`. Kept apart from the store so that the report store and the narrative store
 * can both use it without importing each other.
 */
const iso = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** The columns that carry the block of the pack, as the select of the narrative of a report reads them (the table is aliased `n`). */
export const PACK_SELECT = `n.pack_code, n.pack_version, n.pack_fields, n.cause_codes, n.directive_refs,
       n.inherited_from_report_id, ${iso('n.inherited_at')} as inherited_at, n.inherited_by, n.inherited_hashes,
       (select x.period_id from machvon.report_revision x where x.tenant_id = n.tenant_id and x.id = n.inherited_from_report_id) as inherited_from_period_id`;

export interface PackColumns {
  pack_code: string | null;
  pack_version: number | null;
  pack_fields: Record<string, string> | null;
  cause_codes: string[] | null;
  directive_refs: Array<{ id: string; code: string; status_at_end: string }> | null;
  inherited_from_report_id: string | null;
  inherited_at: string | null;
  inherited_by: string | null;
  inherited_hashes: Record<string, string> | null;
  inherited_from_period_id: string | null;
}

/** The block of the enterprise pack from the columns of a row; undefined for a row without one (and for a pack this code does not know). */
export function enterpriseBlockOf(row: PackColumns): EnterpriseNarrative | undefined {
  if (row.pack_code !== NARRATIVE_PACK_ENTERPRISE || row.pack_fields === null) return undefined;
  const fields = {} as Record<NarrativeField, string | null>;
  for (const field of NARRATIVE_FIELDS) fields[field] = row.pack_fields[field] ?? null;
  const directiveRefs: DirectiveRef[] = (row.directive_refs ?? []).map((ref) => ({ id: ref.id, code: ref.code, statusAtEnd: ref.status_at_end as DirectiveRef['statusAtEnd'] }));
  const inheritance: NarrativeInheritance | undefined =
    row.inherited_from_report_id === null || row.inherited_at === null || row.inherited_by === null
      ? undefined
      : { fromReportId: row.inherited_from_report_id, fromPeriodId: row.inherited_from_period_id, at: row.inherited_at, by: row.inherited_by, hashes: (row.inherited_hashes ?? {}) as NarrativeInheritance['hashes'] };
  return { packVersion: row.pack_version ?? NARRATIVE_PACK_VERSION, fields, causeCodes: row.cause_codes ?? [], directiveRefs, ...(inheritance === undefined ? {} : { inheritance }) };
}

type PackParams = [string | null, number | null, string | null, string[] | null, string | null, string | null, string | null, string | null, string | null];

/** The values of the pack columns for an insert (`pack_code` to `inherited_hashes`): all null when the narrative has no block. */
export function packParams(block: EnterpriseNarrative | undefined): PackParams {
  if (block === undefined) return [null, null, null, null, null, null, null, null, null];
  const sparse: Record<string, string> = {};
  for (const field of NARRATIVE_FIELDS) {
    const text = block.fields[field];
    if (text !== null) sparse[field] = text;
  }
  const inheritance = block.inheritance;
  return [
    NARRATIVE_PACK_ENTERPRISE,
    block.packVersion,
    JSON.stringify(sparse),
    [...block.causeCodes],
    JSON.stringify(block.directiveRefs.map((ref) => ({ id: ref.id, code: ref.code, status_at_end: ref.statusAtEnd }))),
    inheritance?.fromReportId ?? null,
    inheritance?.at ?? null,
    inheritance?.by ?? null,
    inheritance === undefined ? null : JSON.stringify(inheritance.hashes),
  ];
}
