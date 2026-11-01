import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { fireEvent, screen } from '@testing-library/react';
import vi_ from '../../../i18n/vi.json';
import { inspection } from '../../qms/inspection/test-support';
import { client, mountIssue, routeOf, world } from '../test-support';
import SiteInspectionScreen from './SiteInspectionScreen';
import type { Harness } from '../test-support';

export { category, unit } from '../test-support';
export { inspection };

export const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
export const fill = (value: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, item]) => out.replace(`{${key}}`, String(item)), value);
export const problem = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c', extensions: {} });
export const lost = () => new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c', extensions: {} });

export const ROUTE = routeOf('ISS-05', 'FR-ISS-05');

/** The people of ISS-05: the inspector who records and reports, the one who may only record, the one who may only report, and the one who may only read. */
export const INSPECTOR = ['inspection.read', 'inspection.record', 'issue.create', 'master.read', 'organization_unit.read'];
export const RECORDER = ['inspection.read', 'inspection.record'];
export const REPORTER = ['inspection.read', 'issue.create', 'master.read', 'organization_unit.read'];
export const READER = ['inspection.read'];

/** An inspection that is scheduled, that the caller may record, with the people who take part. */
export const scheduled = (n: number, overrides: Record<string, unknown> = {}) =>
  inspection(n, {
    status: 'SCHEDULED',
    scheduled_at: '2026-10-30T02:00:00.000Z',
    location_text: 'Km 12+300, đường vào cầu',
    participants: [{ membership_id: '00000000-0000-4000-8000-000000000071', display_name: 'Giám sát Bình' }],
    actions: { schedule: false, record: true, cancel: true },
    ...overrides,
  });

/** An inspection whose result is recorded; the items answered FAIL are the ones an issue may still be owed for. */
export const recorded = (n: number, outcomes: Array<'PASS' | 'FAIL' | 'NA'>, overrides: Record<string, unknown> = {}) =>
  inspection(n, {
    status: 'RESULT_RECORDED',
    result: outcomes.includes('FAIL') ? 'FAIL' : 'PASS',
    result_note: 'Đã ghi',
    checklist: [
      { code: 'DOC', label: 'Hồ sơ vật liệu đầy đủ', outcome: outcomes[0], note: outcomes[0] === 'FAIL' ? 'Thiếu chứng chỉ' : null },
      { code: 'SAMPLE', label: 'Mẫu thử đạt yêu cầu', outcome: outcomes[1], note: null },
      { code: 'SAFE', label: 'Biện pháp an toàn tại vị trí', outcome: outcomes[2], note: null },
    ],
    actions: { schedule: false, record: false, cancel: false },
    ...overrides,
  });

/** A client over the inspections and the options of the issue form; `command` answers the commands. */
export function open(
  inspections: Array<Record<string, unknown>>,
  options: {
    permissions?: readonly string[] | undefined;
    mode?: 'FULL' | 'READ_ONLY';
    command?: (operation: string, input: unknown) => unknown;
    path?: string;
    failing?: Error;
    pending?: boolean;
  } = {},
): Harness {
  const h = client(world(), options.command ?? ((operation) => (operation === 'createIssue' ? { resource_id: '00000000-0000-4000-8000-00000000a0a0' } : {})));
  h.read.mockImplementation((operation: string) => {
    if (options.pending === true) return new Promise(() => undefined);
    if (options.failing !== undefined) return Promise.reject(options.failing);
    return operation === 'listInspections' ? Promise.resolve({ items: inspections, as_of: '2026-10-25T03:00:00.000Z' }) : Promise.reject(new Error(`unexpected read ${operation}`));
  });
  mountIssue(<SiteInspectionScreen route={ROUTE} />, h, {
    permissions: 'permissions' in options ? options.permissions : INSPECTOR,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    path: options.path ?? '/iss/iss-05',
  });
  return h;
}

export const answer = (item: string, outcome: string, note = ''): void => {
  const row = document.querySelector<HTMLElement>(`[data-item="${item}"]`) as HTMLElement;
  fireEvent.change(row.querySelector('select') as HTMLSelectElement, { target: { value: outcome } });
  if (note !== '') fireEvent.change(row.querySelector('input') as HTMLInputElement, { target: { value: note } });
};

export const choose = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};

/** The bodies of the commands sent, by operation. */
export const sent = (h: Harness, operation: string): Array<Record<string, unknown>> =>
  h.command.mock.calls.filter(([name]) => name === operation).map(([, input]) => (input as { body: Record<string, unknown> }).body);
