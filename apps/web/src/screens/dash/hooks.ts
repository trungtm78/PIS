import type { ApiClient } from '@machvon/api-client';
import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../api/ApiClientContext';
import { useSession } from '../../session/SessionContext';
import type { DashboardDb } from './db';
import { assemble, plainText } from './sources/assemble';
import type { DashboardData, SystemTables } from './sources/assemble';
import { capitalFromSystem } from './sources/capital';
import { NotEnoughError, readCapitalInput } from './sources/system';
import { submissionsFromSystem } from './sources/submissions';
import { readSubmissionsInput } from './sources/system-submissions';
import { readTasksInput } from './sources/system-tasks';
import { tasksFromSystem } from './sources/tasks';
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
  // The tasks and the submissions stand beside the capital tables of the system and name their units and projects only. The board has one clock (today, the period) and
  // the template's is a fixed day: what is read today is judged against today only, so these bundles are taken when the clock is the system's, which comes with the
  // capital tables. Whatever happens to one of these reads, the capital bundle and the other bundle stay as they were decided.
  const optional: [string, SystemTables][] = [];
  const failed = (name: string, error: unknown): string => (error instanceof NotEnoughError ? `${name}: ${error.message}` : `${name}: the system could not be read (${error instanceof Error ? error.message : 'unknown error'})`);
  if (system.moc_thoi_gian === undefined || system.don_vi === undefined || system.du_an === undefined) {
    for (const name of ['tasks', 'submissions']) notes.push(`${name}: left on the template, whose clock the board keeps while the capital tables are those of the template`);
  } else {
    const known = { knownUnitCodes: new Set(system.don_vi.map((unit) => plainText(unit.ma))), knownProjectCodes: new Set(system.du_an.map((project) => plainText(project.ma))) };
    try {
      const found = tasksFromSystem({ ...(await readTasksInput(client, today)), ...known });
      if (found.rows === undefined) notes.push(`tasks: ${found.reasons.join('; ')}`);
      else optional.push(['tasks', { nhiem_vu: found.rows }]);
    } catch (error) {
      notes.push(failed('tasks', error));
    }
    try {
      const found = submissionsFromSystem({ ...(await readSubmissionsInput(client, today)), ...known });
      if (found.rows === undefined) notes.push(`submissions: ${found.reasons.join('; ')}`);
      else optional.push(['submissions', { ho_so_trinh: found.rows }]);
    } catch (error) {
      notes.push(failed('submissions', error));
    }
  }
  // A bundle that does not hold together with the tables kept so far is not drawn: the template's is, and the note says what was wrong.
  let kept = system;
  for (const [name, tables] of optional) {
    try {
      assemble(base, { ...kept, ...tables });
      kept = { ...kept, ...tables };
    } catch (error) {
      notes.push(`${name}: ${error instanceof Error ? error.message : 'the tables do not hold together'}`);
    }
  }
  try {
    return { ...assemble(base, kept), notes };
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
