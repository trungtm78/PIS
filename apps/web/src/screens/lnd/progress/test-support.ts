import { OTHER_PROJECT, PROJECT, SECTION, UNIT_TTQD, client, world } from '../test-support';
import type { Harness, World } from '../test-support';

export const STAGE_DOCUMENT = '00000000-0000-4000-8000-000000000044';

export const stage = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-0005${String(n).padStart(8, '0')}`,
  project_id: PROJECT,
  section_id: SECTION,
  plan_id: null,
  stage_code: 'INVENTORY',
  executor_kind: 'LAND_FUND_CENTRE',
  executor_unit_id: UNIT_TTQD,
  executor_unit_name: 'Trung tâm phát triển quỹ đất',
  mode: 'TRACKED_EXTERNAL',
  planned_start: '2026-06-01',
  planned_end: '2026-08-31',
  actual_start: '2026-06-05',
  actual_end: null,
  parcels_total: 120,
  parcels_done: 45,
  progress_pct: '37.50',
  last_reported_at: '2026-09-01T03:00:00.000Z',
  evidence_document_version_id: STAGE_DOCUMENT,
  status: 'LATE',
  blocker_issue_id: '00000000-0000-4000-8000-000000000088',
  blocker_note: null,
  version: 3,
  ...overrides,
});

export const overview = (overrides: Record<string, unknown> = {}) => ({
  project_id: PROJECT,
  as_of: '2026-10-24T03:00:00.000Z',
  totals: {
    sections: 1,
    sections_handed_over: 0,
    required_area_m2: '30000.00',
    handed_area_m2: '18000.00',
    parcels: 10,
    parcels_noticed: 4,
    parcels_paid: 2,
    parcels_handed_over: 1,
    households: 7,
    plans_posted: 1,
    payments_paid: 3,
    payments_total: 5,
    late_stages: 1,
  },
  parcels_by_status: { SURVEYED: 6, PAID: 2, HANDED_OVER: 2 },
  sections: [
    {
      id: SECTION,
      code: 'KM-0-3',
      name: 'Km 0 đến km 3',
      status: 'PARTIAL',
      required_area_m2: '30000.00',
      handed_area_m2: '18000.00',
      target_date: '2027-03-01',
      parcels: 10,
      parcels_noticed: 4,
      parcels_paid: 2,
      parcels_handed_over: 1,
    },
  ],
  stages: [stage(1), stage(2, { stage_code: 'PLAN_DRAFT', mode: 'NATIVE', executor_kind: 'PROJECT_OWNER', status: 'IN_PROGRESS', blocker_issue_id: null, parcels_done: 10, progress_pct: '8.33' })],
  ...overrides,
});

/** A client whose `getLandProgress` is answered by `read(projectId)`; the lists of the project, its sections and the units come from the shared world. */
export function progressClient(read: (projectId: string, query: unknown) => unknown, command: (operation: string, input: unknown) => unknown = () => ({}), state: World = world()): Harness {
  return client(state, command, (operation, input) => {
    if (operation !== 'getLandProgress') return new Error(`unexpected read ${operation}`);
    const parts = input as { path?: { id?: string }; query?: unknown };
    return read(parts.path?.id ?? '', parts.query);
  });
}

export { OTHER_PROJECT, PROJECT };
