import type { DashboardDb, DashboardTable, TableOrigin } from '../db';

export const TABLES: readonly DashboardTable[] = ['don_vi', 'du_an', 'giai_ngan', 'ho_so_trinh', 'luot_giao', 'moc_thoi_gian', 'muc_tieu', 'nguon_von', 'nhiem_vu', 'nv_goc'];

export interface DashboardData {
  readonly db: DashboardDb;
  /** Where each table came from: the system, or the illustrative tables of the template. Kept for the tests and the logs; the screen shows no label. */
  readonly origins: Readonly<Record<DashboardTable, TableOrigin>>;
}

/**
 * What the system could supply, table by table. The tables of one bundle name each other (a disbursement names its project and its source, a project its
 * unit), so the sources hand over a bundle whole or not at all: half of one beside half of the other would not add up.
 */
export type SystemTables = Partial<{ readonly [K in DashboardTable]: DashboardDb[K] }>;

/** The database of the dashboard: the tables the system supplied, and the template's table for every one it did not. */
export function assemble(template: DashboardDb, system: SystemTables = {}): DashboardData {
  const db: Record<string, unknown> = { ...template };
  const origins = {} as Record<DashboardTable, TableOrigin>;
  for (const table of TABLES) {
    const rows = system[table];
    if (rows === undefined) origins[table] = 'template';
    else {
      db[table] = rows;
      origins[table] = 'system';
    }
  }
  return { db: db as unknown as DashboardDb, origins };
}
