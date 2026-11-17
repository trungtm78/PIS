import type { DashboardDb } from '../db';

/** The engine of the owner's template: every figure of the pages, computed from the tables. Its results are read by the charts of the template only, so they are not typed here. */
export const E: {
  invest(db: DashboardDb, period?: number): Record<string, unknown>;
  gov(db: DashboardDb): Record<string, unknown>;
};
