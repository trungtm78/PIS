import type { DashboardDb, DashboardTable, TableOrigin } from '../db';

export const TABLES: readonly DashboardTable[] = ['don_vi', 'du_an', 'giai_ngan', 'ho_so_trinh', 'luot_giao', 'moc_thoi_gian', 'muc_tieu', 'nguon_von', 'nhiem_vu', 'nv_goc'];

/**
 * The tables that name each other travel together. A disbursement names its project and its source, a project its unit, an assignment its root task: half of a
 * bundle from the system beside half from the template would not add up, so a bundle comes whole from the system or whole from the template.
 */
export const BUNDLES: Readonly<Record<string, readonly DashboardTable[]>> = {
  capital: ['moc_thoi_gian', 'nguon_von', 'muc_tieu', 'don_vi', 'du_an', 'giai_ngan'],
  tasks: ['nhiem_vu'],
  submissions: ['ho_so_trinh'],
  steering: ['nv_goc', 'luot_giao'],
};

export interface DashboardData {
  readonly db: DashboardDb;
  /** Where each table came from: the system, or the illustrative tables of the template. Kept for the tests and the logs; the screen shows no label. */
  readonly origins: Readonly<Record<DashboardTable, TableOrigin>>;
}

/** What the system could supply: whole bundles only (see BUNDLES). */
export type SystemTables = Partial<{ readonly [K in DashboardTable]: DashboardDb[K] }>;

/**
 * The charts of the template write text into the page as HTML. The template escapes what it writes, but one missed field would let a name typed into the system run as
 * markup, so no text reaches the charts with the characters markup is made of: they are replaced by look-alikes that are only ever text.
 */
const UNSAFE: Readonly<Record<string, string>> = { '<': '‹', '>': '›', '"': '”', "'": '’', '`': '’' };
export function plainText(value: string): string {
  return value.replace(/[<>"'`]/g, (character) => UNSAFE[character] ?? '');
}
function plainRows<T>(rows: readonly T[]): T[] {
  return rows.map((row) => {
    const copy: Record<string, unknown> = { ...(row as Record<string, unknown>) };
    for (const [key, value] of Object.entries(copy)) if (typeof value === 'string') copy[key] = plainText(value);
    return copy as T;
  });
}

/** The fields that hold a day, table by table. */
const DAY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  moc_thoi_gian: ['hom_nay', 'ngay_chot_so', 'kho_bac_den', 'nhiem_vu_den'],
  nhiem_vu: ['han', 'ngay_xong'],
  ho_so_trinh: ['ngay_nhan', 'han'],
  nv_goc: ['han_bao_cao', 'ngay_ban_hanh', 'ngay_chap_nhan'],
  luot_giao: ['ngay_giao', 'han_noi_bo', 'ngay_xac_nhan', 'ngay_nop', 'ngay_chap_nhan', 'cap_nhat_cuoi'],
};
/** A calendar day as the tables write it (2026-11-17), and one that exists. */
function isDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** What does not hold together in the tables: a row that names a unit, a project, a source or a root task the tables do not have. An empty list is a sound database. */
export function referenceProblems(db: DashboardDb): string[] {
  const problems: string[] = [];
  const units = new Set(db.don_vi.map((unit) => unit.ma));
  const projects = new Set(db.du_an.map((project) => project.ma));
  const sources = new Set(db.nguon_von.map((source) => source.ma));
  const roots = new Set(db.nv_goc.map((root) => root.ma));
  const miss = (table: string, what: string, value: string) => problems.push(`${table}: ${what} ${value} is not in the tables`);
  for (const project of db.du_an) if (!units.has(project.don_vi)) miss('du_an', 'unit', project.don_vi);
  for (const line of db.giai_ngan) {
    if (!projects.has(line.du_an)) miss('giai_ngan', 'project', line.du_an);
    if (!sources.has(line.nguon)) miss('giai_ngan', 'source', line.nguon);
  }
  for (const task of db.nhiem_vu) {
    if (!units.has(task.don_vi)) miss('nhiem_vu', 'unit', task.don_vi);
    if (task.du_an !== null && !projects.has(task.du_an)) miss('nhiem_vu', 'project', task.du_an);
  }
  for (const paper of db.ho_so_trinh) if (!units.has(paper.don_vi)) miss('ho_so_trinh', 'unit', paper.don_vi);
  for (const assignment of db.luot_giao) if (!roots.has(assignment.nhiem_vu_goc)) miss('luot_giao', 'root task', assignment.nhiem_vu_goc);
  // The engine of the template walks from one day to another: a day it cannot read would never be reached, so every day is a calendar day or absent before it gets there.
  for (const [table, fields] of Object.entries(DAY_FIELDS)) {
    for (const row of db[table as DashboardTable] as unknown as Record<string, unknown>[]) {
      for (const field of fields) {
        const value = row[field];
        if (value !== null && value !== undefined && !(typeof value === 'string' && isDay(value))) problems.push(`${table}: ${field} is not a day (${String(value).slice(0, 20)})`);
      }
    }
  }
  if (db.moc_thoi_gian.length !== 1) problems.push('moc_thoi_gian: exactly one row is expected');
  if (db.muc_tieu.length !== 13) problems.push('muc_tieu: thirteen rows are expected (twelve months and the adjustment period)');
  return [...new Set(problems)];
}

/**
 * The database of the dashboard: the bundles the system supplied, and the template's tables for every bundle it did not. A bundle the system supplied in part, or tables
 * that do not hold together afterwards, are refused: the screen then says it could not read its figures, and never draws tables that contradict each other.
 */
export function assemble(template: DashboardDb, system: SystemTables = {}): DashboardData {
  const db: Record<string, unknown> = {};
  const origins = {} as Record<DashboardTable, TableOrigin>;
  for (const [name, tables] of Object.entries(BUNDLES)) {
    const supplied = tables.filter((table) => system[table] !== undefined);
    if (supplied.length !== 0 && supplied.length !== tables.length) throw new Error(`the system supplied the bundle "${name}" in part (${supplied.join(', ')}): a bundle is whole or absent`);
    for (const table of tables) {
      const fromSystem = supplied.length !== 0;
      db[table] = plainRows((fromSystem ? system[table] : template[table]) as readonly unknown[]);
      origins[table] = fromSystem ? 'system' : 'template';
    }
  }
  const whole = db as unknown as DashboardDb;
  const problems = referenceProblems(whole);
  if (problems.length !== 0) throw new Error(`the tables of the dashboard do not hold together: ${problems.slice(0, 5).join('; ')}`);
  return { db: whole, origins };
}
