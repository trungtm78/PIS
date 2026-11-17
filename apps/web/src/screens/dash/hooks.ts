import type { ApiClient } from '@machvon/api-client';
import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../api/ApiClientContext';
import { useSession } from '../../session/SessionContext';
import type { DashboardDb } from './db';
import { assemble } from './sources/assemble';
import type { DashboardData, SystemTables } from './sources/assemble';
import { capitalFromSystem } from './sources/capital';
import { NotEnoughError, readCapitalInput } from './sources/system';
import { loadTemplateDb } from './sources/template-db';

export const dashKey = (tenantId: string | undefined, membershipId: string | undefined) => ['dash9', tenantId, membershipId] as const;

/** The dashboard and what it was drawn from: `notes` say, bundle by bundle, why a bundle stayed on the tables of the template. */
export interface DashboardRead extends DashboardData {
  readonly notes: readonly string[];
}

const isoDay = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** The rows of the template that name a unit or a project the system's capital tables do not have are left out, so the template's other bundles still hold together beside them. */
function fitTemplate(template: DashboardDb, capital: Pick<DashboardDb, 'don_vi' | 'du_an'>): DashboardDb {
  const units = new Set(capital.don_vi.map((unit) => unit.ma));
  const projects = new Set(capital.du_an.map((project) => project.ma));
  return {
    ...template,
    nhiem_vu: template.nhiem_vu.filter((task) => units.has(task.don_vi) && (task.du_an === null || projects.has(task.du_an))),
    ho_so_trinh: template.ho_so_trinh.filter((paper) => units.has(paper.don_vi) && (paper.du_an === null || projects.has(paper.du_an))),
  };
}

/**
 * The tables of the dashboard: a bundle comes from the system when the system holds enough of it to draw every page that reads it, and from the template otherwise
 * (the owner's rule: real figures where there are enough, the template's where there are not). A read of the system that fails leaves the template in place and says so.
 */
export async function readDashboard(client: ApiClient, today: string): Promise<DashboardRead> {
  const template = await loadTemplateDb();
  const notes: string[] = [];
  let system: SystemTables = {};
  let base = template;
  try {
    const capital = capitalFromSystem(await readCapitalInput(client, today), template.nguon_von, template.muc_tieu.map((row) => row.cung_ky_pct));
    if (capital.tables === undefined) notes.push(`capital: ${capital.reasons.join('; ')}`);
    else {
      system = capital.tables;
      base = fitTemplate(template, capital.tables);
    }
  } catch (error) {
    notes.push(error instanceof NotEnoughError ? `capital: ${error.message}` : `capital: the system could not be read (${error instanceof Error ? error.message : 'unknown error'})`);
  }
  try {
    return { ...assemble(base, system), notes };
  } catch (error) {
    // Tables of the system that do not hold together are not drawn: the template alone does, and the note says what was wrong.
    notes.push(`capital: ${error instanceof Error ? error.message : 'the tables do not hold together'}`);
    return { ...assemble(template), notes };
  }
}

/** The tables of the dashboard for the member of the tenant: read once when the screen opens, and again when the reader asks. */
export function useDashboardData() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<DashboardRead>({
    queryKey: dashKey(tenant?.id, tenant?.membershipId),
    queryFn: () => readDashboard(client, isoDay(new Date())),
    enabled: tenant !== undefined,
    retry: false,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}
