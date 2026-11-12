import type { CatalogueEntry, ManagedReportCatalogue } from '@machvon/kernel';
import { MasterStore } from './master-store.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The report catalogue of a tenant as the master catalogues hold it (MD.03): the entries of `REPORTING_PERIOD_KIND`, `REPORT_TYPE` and `RECEIVING_AGENCY` that are in force on a day. Only the published, tenant-owned
 * entries count: a draft or a proposal in review is not yet the catalogue. The pure rules that read the entries are in the kernel (`report-catalogue.ts`).
 */
const PAGE = 200;

export class ReportCatalogueStore {
  private readonly masters = new MasterStore();

  private async entriesOf(tx: TenantTx, masterType: string, asOf: string): Promise<CatalogueEntry[]> {
    const entries: CatalogueEntry[] = [];
    let after: { code: string; id: string } | undefined;
    for (;;) {
      const rows = await this.masters.search(tx, { masterType, namespace: 'TENANT', asOf, limit: PAGE, after });
      for (const row of rows) if (row.versionId !== null && row.attributes !== null && row.label !== null) entries.push({ key: row.businessKey, label: row.displayLabel ?? row.label, attributes: row.attributes });
      const last = rows[rows.length - 1];
      if (rows.length < PAGE || last === undefined) return entries;
      after = { code: `${last.masterType}:${last.businessKey}`, id: last.id };
    }
  }

  async read(tx: TenantTx, asOf: string): Promise<ManagedReportCatalogue> {
    return {
      periodKinds: await this.entriesOf(tx, 'REPORTING_PERIOD_KIND', asOf),
      reportTypes: await this.entriesOf(tx, 'REPORT_TYPE', asOf),
      agencies: await this.entriesOf(tx, 'RECEIVING_AGENCY', asOf),
    };
  }
}
