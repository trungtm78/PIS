import type { DashboardDb } from '../db';

export interface MountedDashboard {
  /** How many pages the dashboard has, and their names in order. */
  readonly count: number;
  readonly names: readonly string[];
  /** Shows a page (0 is the first) without calling `onPage`. */
  go(index: number): void;
  /** Removes the dashboard and every listener it added. */
  dispose(): void;
}

export interface MountOptions {
  /** The page shown first (0 is the first). */
  page?: number;
  /** Called when the reader moves to another page by a tab or an arrow key. */
  onPage?(index: number): void;
}

export function mountDashboard(host: HTMLElement, db: DashboardDb, options?: MountOptions): MountedDashboard;
