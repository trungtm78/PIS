import type { Rejection } from '@machvon/kernel';
import { TREASURY_FILE_PROVIDER, createTreasuryStatementFormat } from './pay-treasury-statement-format.ts';
import type { TreasuryFormatOptions, TreasuryStatementRow } from './pay-treasury-statement-format.ts';
import type { FileImportAdapter } from './file-import-store.ts';
import { MasterCrosswalkStore } from './master-crosswalk-store.ts';
import type { TenantTx } from './tenant-database.ts';

/** The crosswalk that translates the codes of the Treasury offices (ST-MDM-007): the system and the kind of code. */
export const TREASURY_CROSSWALK_SYSTEM = 'TREASURY';
export const TREASURY_CROSSWALK_TYPE = 'AGENCY_CODE';
/** The kind of master entry a Treasury office code stands for (MDM-16). */
export const TREASURY_OFFICE_MASTER_TYPE = 'TREASURY_OFFICE';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";

export interface TreasuryAdapterOptions extends TreasuryFormatOptions {
  /** The membership that runs the import: the author of every transaction it writes. */
  actor: string;
  crosswalks?: MasterCrosswalkStore;
}

/** What the read-only judgement found out about a row, handed to the step that writes it. */
interface Resolved {
  projectId: string;
  officeRecordId: string;
}

/**
 * The adapter of the Treasury statement file (ST-PAY-006): the pure layout of `createTreasuryStatementFormat`, the judgement of a row against
 * what the tenant holds, and the write of the transaction. A row names a project by its code and a Treasury office by the code the Treasury
 * uses; the project must exist, and the office code must have an ACTIVE mapping in force on the voucher date (crosswalk TREASURY/AGENCY_CODE)
 * to an entry of MDM-16. A code with no mapping is the row error CROSSWALK_MISSING in the quarantine: nothing is ever created from a guessed
 * code. The adapter is built for one import, because it remembers what `examine` resolved for `apply`.
 */
export function createTreasuryStatementAdapter(options: TreasuryAdapterOptions): FileImportAdapter<TreasuryStatementRow> {
  const format = createTreasuryStatementFormat(options);
  const crosswalks = options.crosswalks ?? new MasterCrosswalkStore();
  const projects = new Map<string, string | null>();
  const offices = new Map<string, { recordId: string; masterType: string } | null>();
  const resolved = new Map<string, Resolved>();

  async function projectOf(tx: TenantTx, code: string): Promise<string | null> {
    const known = projects.get(code);
    if (known !== undefined) return known;
    const [project] = await tx.query<{ id: string }>('select id from machvon.project where code = $1', [code]);
    projects.set(code, project?.id ?? null);
    return project?.id ?? null;
  }

  async function officeOf(tx: TenantTx, code: string, on: string): Promise<{ recordId: string; masterType: string } | null> {
    const cacheKey = `${on}|${code}`;
    const known = offices.get(cacheKey);
    if (known !== undefined) return known;
    const target = (await crosswalks.resolve(tx, TREASURY_CROSSWALK_SYSTEM, TREASURY_CROSSWALK_TYPE, [code], on)).get(code);
    const office = target === undefined ? null : { recordId: target.recordId, masterType: target.masterType };
    offices.set(cacheKey, office);
    return office;
  }

  return {
    ...format,
    async examine(tx, entry): Promise<Rejection | undefined> {
      const { projectCode, officeCode, documentDate } = entry.record;
      const projectId = await projectOf(tx, projectCode);
      if (projectId === null) return { code: 'PROJECT_NOT_FOUND', field: 'project_code' };
      const office = await officeOf(tx, officeCode, documentDate);
      if (office === null) return { code: 'CROSSWALK_MISSING', field: 'treasury_office_code' };
      // A code that was mapped to an entry of another kind is a wrong mapping, not a Treasury office.
      if (office.masterType !== TREASURY_OFFICE_MASTER_TYPE) return { code: 'CROSSWALK_TARGET_INVALID', field: 'treasury_office_code' };
      resolved.set(entry.businessKey, { projectId, officeRecordId: office.recordId });
      return undefined;
    },
    async apply(tx, entry, context) {
      const where = resolved.get(entry.businessKey);
      if (where === undefined) throw new Error('a statement row reached apply without being examined');
      const { record } = entry;
      const inserted = await tx.query<{ id: string }>(
        `insert into machvon.treasury_transaction
           (tenant_id, id, project_id, external_id, provider, amount_vnd, confirmed_at, source_hash, import_id, direction, document_no, document_date,
            source_kind, row_hash, match_status, created_by, treasury_office_record_id)
         values (${TENANT}, gen_random_uuid(), $1::uuid, $2, $3, $4::numeric, $5::timestamptz, $6, $7::uuid, 'PAYMENT', $8, $9::date,
                 'FILE_IMPORT', $6, 'UNMATCHED', $10::uuid, $11::uuid)
         on conflict (tenant_id, provider, external_id) do nothing
         returning id`,
        [where.projectId, entry.businessKey, TREASURY_FILE_PROVIDER, record.amountVnd, record.confirmedAt, entry.rowHash, context.importId, record.documentNo, record.documentDate, options.actor, where.officeRecordId],
      );
      // The business key was claimed by the framework a moment ago, so no other file can have written this transaction: a conflict here is a defect.
      if (inserted[0] === undefined) throw new Error('a Treasury transaction already exists for a business key that was never claimed');
      return [];
    },
  };
}
