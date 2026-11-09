import { registerMigrationVerifier, validateMasterContent } from '@machvon/db';
import type { EntryRef, MigrationVerifier, TypeLookup } from '@machvon/db';
import { DomainError, ORG_PACK_MAPPING, ORG_PACK_MAPPING_VERSION, orgPackOfRows, registerMigrationMapping } from '@machvon/kernel';
import type { PackEntry, RowError } from '@machvon/kernel';

/**
 * The entries of the shared catalogues in a pack file meet the rules of their master data type in the dry run, not only when they are proposed (a customer who edits the file learns of a wrong value on its row). The
 * entries of the pack refer to each other (a report type names a period kind), so the lookup knows the pack first and then the tenant.
 */
export const orgPackCatalogueVerifier: MigrationVerifier = async (tx, rows) => {
  const { pack } = orgPackOfRows(rows.map((row) => ({ rowNumber: row.rowNumber, businessKey: row.businessKey, payload: row.payload })));
  const entryRef = (entry: PackEntry): EntryRef => ({ masterType: entry.masterType, businessKey: entry.key, attributes: entry.attributes });
  const lookup: TypeLookup = {
    entry: async (masterType, businessKey) => {
      const own = pack.entries.find((entry) => entry.masterType === masterType && entry.key === businessKey);
      if (own !== undefined) return entryRef(own);
      const found = await tx.query<{ attributes: Record<string, unknown> }>(
        `select v.attributes from machvon.master_record r
           join lateral (select x.attributes from machvon.master_record_version x where x.master_record_id = r.id order by x.revision desc limit 1) v on true
          where r.master_type = $1 and r.business_key = $2 and r.status not in ('RETIRED', 'MERGED') limit 1`,
        [masterType, businessKey],
      );
      return found[0] === undefined ? undefined : { masterType, businessKey, attributes: found[0].attributes };
    },
  };
  const errors: RowError[] = [];
  for (const entry of pack.entries) {
    const row = rows.find((candidate) => candidate.businessKey === `ENTRY:${entry.masterType}:${entry.key}`);
    if (row === undefined) continue;
    const parent = entry.parentKey === null ? undefined : pack.entries.find((candidate) => candidate.masterType === entry.masterType && candidate.key === entry.parentKey);
    try {
      await validateMasterContent({
        masterType: entry.masterType,
        businessKey: entry.key,
        content: { label: entry.label, attributes: entry.attributes, parentRecordId: null, validFrom: '2026-01-01', validUntil: null, legalBasis: null },
        parent: parent === undefined ? undefined : entryRef(parent),
        lookup,
      });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      errors.push({ rowNumber: row.rowNumber, lineNumber: row.lineNumber, field: error.detail ?? 'data', code: 'PACK_INVALID', message: `ENTRY_CONTENT: ${entry.masterType} ${entry.key} does not meet the rules of its type (${error.code})` });
    }
  }
  return errors;
};

/** Adds the organisation pack to this process: its mapping for the batch judge and its verifier for the dry run. Called once when the enterprise edition loads; calling it again changes nothing. */
export function registerEnterpriseOrgPack(): void {
  registerMigrationMapping(ORG_PACK_MAPPING);
  registerMigrationVerifier(ORG_PACK_MAPPING_VERSION, orgPackCatalogueVerifier);
}
