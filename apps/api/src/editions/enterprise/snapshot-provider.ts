import { EnterpriseSnapshotStore, EntNarrativeStore } from '@machvon/db';
import { EnterpriseFigureReader, WEEKLY_ORG_FALLBACK, periodRange } from '@machvon/kernel';
import type { FormPeriod } from '@machvon/kernel';
import { ENTERPRISE_SNAPSHOT_PROVIDER, demoFormOf, snapshotFillData } from '@machvon/edition-enterprise/src/server.ts';
import type { SnapshotProjectName } from '@machvon/edition-enterprise/src/server.ts';
import type { ProviderContext, ProviderResult, ReportFigureProvider } from '../../modules/reports/figure-provider';

const nothing = (period: FormPeriod): ProviderResult => ({ data: { period, meta: {}, definitions: {}, figures: [], datasets: {} }, snapshot: null });

/**
 * The figures of the six enterprise forms from the frozen enterprise period snapshot (ENT-3a, R21): the snapshot of the month or the quarter of the form, the latest revision, read through the one reader of the kernel. A
 * period with no frozen snapshot answers without a snapshot and the report engine keeps the illustrative data and the demo stamp; the figures of a tenant are never those of another period. The forms are tenant-wide, so
 * the engine asks the permission over the whole tenant before it calls this provider. The Word document also carries the structured narratives of the projects that the units wrote and the approver accepted for the period. Registered by the enterprise seam of the API (`editions/load-enterprise.ts`), so a public process never holds it.
 */
export class EnterpriseSnapshotProvider implements ReportFigureProvider {
  readonly id = ENTERPRISE_SNAPSHOT_PROVIDER;
  readonly wholeTenant = true;
  private readonly store = new EnterpriseSnapshotStore();
  private readonly narratives = new EntNarrativeStore();

  async load(context: ProviderContext): Promise<ProviderResult> {
    const form = demoFormOf(context.layout.code);
    const kind = context.period.kind;
    if (form === undefined || (kind !== 'MONTH' && kind !== 'QUARTER')) return nothing(context.period);
    const range = periodRange(context.period);
    return context.database.withTenant(context.tenant, async (tx) => {
      const row = await this.store.frozenForDates(tx, kind, range.from, range.to);
      if (row === undefined) return nothing(context.period);
      const reader = new EnterpriseFigureReader(await this.store.view(tx, row));
      const ids = reader.projectIds();
      const projects =
        ids.length === 0
          ? []
          : await tx.query<{ id: string; code: string; name: string; project_group: string | null; unit_name: string | null }>(
              `select p.id, p.code, p.name, p.project_group, u.name as unit_name from machvon.project p left join machvon.organization_unit u on u.tenant_id = p.tenant_id and u.id = p.owner_unit_id where p.id = any($1::uuid[])`,
              [ids],
            );
      const names = new Map<string, SnapshotProjectName>(projects.map((one) => [one.id, { code: one.code, name: one.name, group: one.project_group, unitName: one.unit_name ?? '' }]));
      const [root] = await tx.query<{ name: string }>('select name from machvon.organization_unit where parent_id is null and valid_until is null order by valid_from, id limit 1');
      // The words of the units for the Word document: what the approver accepted for the period (ENT-3b), never a draft.
      const words = await this.narratives.acceptedForForm(tx, ids, { from: range.from, to: range.to });
      return { data: snapshotFillData(form, context.period, reader, names, root?.name ?? WEEKLY_ORG_FALLBACK, words), snapshot: { snapshotId: row.id, revision: row.revision, cutoff: row.asOfDate } };
    });
  }
}
