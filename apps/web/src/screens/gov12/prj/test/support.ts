import { ApiError } from '@machvon/api-client';
import { translator } from '../../../../i18n';
import base from '../../../../i18n/vi.json';
import type { WebRoute } from '../../../../routes/types';
import { harness } from '../../../sas/test-support';
import type { Harness } from '../../../sas/test-support';

export { mount } from '../../../bid/test-support';
export { harness };
export type { Harness };

// The parts of the catalogue are added to the catalogue object when the translator loads: reading it through `translator` makes sure they are there.
void translator;

export const AS_OF = '2027-03-10';
export const FILE_ID = '00000000-0000-4000-8000-0000000000f1';
export const PROJECT_ID = '00000000-0000-4000-8000-0000000000a1';
export const OTHER = '00000000-0000-4000-8000-000000000099';
export const ME = '00000000-0000-4000-8000-000000000001';

export const MANAGER = ['project.monitoring.read', 'project.monitoring.manage', 'project.monitoring.feedback', 'project.monitoring.respond'];
export const READER = ['project.monitoring.read'];
export const PORTAL_MANAGER = ['project.portal.read', 'project.portal.manage', 'project.portal.publish'];
export const PORTAL_READER = ['project.portal.read'];

export const word = (key: string): string => {
  const found = (base as Record<string, string | undefined>)[key];
  if (found === undefined) throw new Error(`missing key ${key}`);
  return found;
};
export const fill = (key: string, params: Record<string, string | number>): string => Object.entries(params).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), word(key));
export const problem = (code: string, status: number, detail?: string) => new ApiError({ status, code, correlationId: 'c', ...(detail === undefined ? {} : { detail }) });
export const never = (): Promise<never> => new Promise<never>(() => undefined);

export const routeOf = (id: string, req: string): WebRoute => ({ id, path: `/prj/${id.toLowerCase()}`, title: id, kind: 'table', area: 'investment', module: 'PRJ', group: 'Minh bach', role: 'workspace', parent: null, req });

export const notice = (over: Record<string, unknown> = {}) => ({ state: 'PENDING', due_on: '2027-02-15', days_left: 36, days_late: null, sent_on: null, sent_by: null, note: null, ...over });

export const fileView = (over: Record<string, unknown> = {}) => ({
  id: FILE_ID,
  project_id: PROJECT_ID,
  project_code: 'PRJ-001',
  project_name: 'Road to the commune',
  status: 'OPEN',
  trigger: { kind: 'WORKS_START', on: '2027-01-01', reason: null },
  notice_days: 45,
  notice_rule_version: 0,
  notice: notice(),
  closed_at: null,
  version: 3,
  ...over,
});

export const listItem = (over: Record<string, unknown> = {}) => ({ ...fileView(), summary: { feedback_total: 2, open: 1, overdue: 1, answered_on_time_pct: 50 }, ...over });
export const fileList = (items: unknown[], over: Record<string, unknown> = {}) => ({ as_of: AS_OF, items, has_more: false, ...over });

export const feedback = (n: number, over: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  file_id: FILE_ID,
  reference: `PH-00${n}`,
  received_on: '2027-03-01',
  channel: 'MEETING',
  topic: 'LAND',
  from_label: 'Hamlet 3',
  summary: 'The access road is blocked by spoil from the works.',
  status: 'RECEIVED',
  response_days: 15,
  rule_version: 0,
  owner_id: null,
  response_text: null,
  responded_on: null,
  responded_by: null,
  closed_by: null,
  declined_reason: null,
  response: { state: 'NOT_DUE', due_on: '2027-03-16', days_left: 6, days_late: null },
  version: 1,
  ...over,
});

export const packItem = (n: number, item: string, over: Record<string, unknown> = {}) => ({ id: `00000000-0000-4000-8000-0000000001${n}0`, item, document_id: OTHER, document_kind: 'DOCUMENT', title: `Document ${n}`, sha256: 'a'.repeat(64), added_at: '2027-02-01T01:00:00.000Z', ...over });

export const detail = (over: Record<string, unknown> = {}) => ({
  ...fileView(),
  as_of: AS_OF,
  pack: { present: [], missing: ['NOTICE_TEXT', 'PROJECT_INFO', 'PLAN_SCHEDULE', 'BOARD_LIST', 'MEETING_MINUTES', 'FEEDBACK_REPORT'], required_missing: ['NOTICE_TEXT', 'PROJECT_INFO', 'PLAN_SCHEDULE'], complete: false, items: [] },
  summary: { feedback_total: 1, open: 1, overdue: 0, answered_on_time_pct: null },
  feedback: [feedback(1)],
  rule: { version: 0, unverified: true, notice_days_now: 45, response_days_now: 15, reminder_days: 5 },
  ...over,
});

export const completePack = () => ({
  present: ['NOTICE_TEXT', 'PROJECT_INFO', 'PLAN_SCHEDULE'],
  missing: ['BOARD_LIST', 'MEETING_MINUTES', 'FEEDBACK_REPORT'],
  required_missing: [],
  complete: true,
  items: [packItem(1, 'NOTICE_TEXT'), packItem(2, 'PROJECT_INFO'), packItem(3, 'PLAN_SCHEDULE')],
});

export const settings = (over: Record<string, unknown> = {}) => ({
  slug: 'cao-bang',
  enabled: true,
  whistle_enabled: true,
  title: 'Public investment of Cao Bang',
  publisher_name: 'Provincial Board',
  id_prefix: 'VN-CB',
  license_uri: 'https://example.org/license',
  policy_uri: 'https://example.org/policy',
  allowed_fields: ['project_code', 'title', 'summary'],
  rate_per_minute: 60,
  page_size_max: 100,
  policy_rule_version: 0,
  whistle: { acknowledge_days: 7, resolve_days: 90, rate_per_hour: 5, rule_version: 0 },
  updated_at: '2027-03-01T01:00:00.000Z',
  version: 2,
  ...over,
});

export const settingsRead = (current: Record<string, unknown> | null, over: Record<string, unknown> = {}) => ({
  as_of: AS_OF,
  settings: current,
  catalogue: ['project_code', 'title', 'summary'],
  rule: { version: 0, unverified: true, allowed_fields: ['project_code', 'title', 'summary'], rate_per_minute: 60, page_size_max: 100 },
  ...over,
});

export const record = (over: Record<string, unknown> = {}) => ({
  project_id: PROJECT_ID,
  public_code: 'PRJ-001',
  fields: { project_code: 'PRJ-001', title: 'Road to the commune' },
  fields_sha256: 'b'.repeat(64),
  revision: 2,
  published_at: '2027-03-02T01:00:00.000Z',
  withdrawn_at: null,
  withdrawn_reason: null,
  version: 2,
  ...over,
});
