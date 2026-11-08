import { harness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import type { WebRoute } from '../../../routes/types';

export { mount } from '../../bid/test-support';
export type { Harness };
export { harness };

export const ALL = ['rpt.read', 'rpt.generate', 'rpt.check', 'rpt.approve', 'rpt.issue', 'rpt.deliver', 'rpt.answer'];
export const READER = ['rpt.read'];

export const routeOf = (id: string, req: string): WebRoute => ({ id, path: `/rpt/${id.toLowerCase()}`, title: id, kind: 'table', area: 'insights', module: 'RPT', group: 'Báo cáo', role: 'workspace', parent: null, req });

export const AS_OF = '2026-11-08T03:00:00.000Z';
export const DEMO_MARK = 'MẪU DEMO — chờ mẫu chính thức';
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const sha = (letter: string): string => letter.repeat(64);

export const entry = (over: Record<string, unknown> = {}) => ({
  code: 'DIS-WEEKLY',
  name: 'Báo cáo tuần giải ngân (DIS)',
  version: '2026.1',
  edition: 'public',
  status: 'READY',
  official: 'CONFIRMED',
  form_ref: 'spec:DIS',
  receiver: 'INTERNAL',
  period_kind: 'AS_OF',
  has_narrative: false,
  data_source: 'LIVE',
  demo_mark: null,
  registered: false,
  issuable: true,
  whole_tenant: true,
  ...over,
});

export const demoEntry = (over: Record<string, unknown> = {}) =>
  entry({ code: 'PVN-MONTHLY', name: 'Báo cáo tháng gửi PVN (mẫu demo)', edition: 'enterprise', status: 'DEMO', official: 'PENDING_EXTERNAL', form_ref: null, receiver: 'PVN', period_kind: 'MONTH', data_source: 'ILLUSTRATIVE', demo_mark: DEMO_MARK, whole_tenant: false, issuable: false, ...over });

export const catalogue = (items: unknown[], over: Record<string, unknown> = {}) => ({ items, demo_mode: false, as_of: AS_OF, can_generate: true, ...over });

export const previewOf = (over: Record<string, unknown> = {}) => ({
  columns: 3,
  rows: [
    { row: 1, kind: 'TITLE', cells: [{ col: 1, kind: 'TEXT', text: 'BÁO CÁO TUẦN' }] },
    { row: 2, kind: 'NOTE', cells: [{ col: 2, kind: 'TEXT', text: 'Tỷ lệ giải ngân' }, { col: 3, kind: 'NUMBER', text: '60,00' }] },
  ],
  row_count: 2,
  truncated: false,
  narrative: [],
  stamp: null,
  ...over,
});

export const draft = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(n),
  layout_code: 'DIS-WEEKLY',
  layout_version: '2026.1',
  layout_name: 'Báo cáo tuần giải ngân (DIS)',
  period_code: '2026-10-18',
  period: { kind: 'AS_OF', year: 2026, day: '2026-10-18' },
  state: 'DRAFT',
  base_revision: 0,
  reason: null,
  package_sha256: sha('a'),
  files: [{ format: 'XLSX', sha256: sha('b'), name: null, size_bytes: 8192 }],
  data_source: 'LIVE',
  form_status: 'READY',
  demo_mark: null,
  snapshot: { snapshot_id: uuid(900), revision: 1, cutoff: '2026-10-12' },
  issue_count: 0,
  prepared_by: uuid(801),
  prepared_by_name: 'Nguyễn Văn An',
  checked_by_name: null,
  approved_by_name: null,
  issue_id: null,
  version: 1,
  created_at: '2026-11-07T01:00:00.000Z',
  can_check: false,
  can_approve: false,
  can_issue: false,
  demo_forms_off: false,
  preview: null,
  issues: [],
  ...over,
});

export const issue = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(n),
  layout_code: 'DIS-WEEKLY',
  layout_version: '2026.1',
  layout_name: 'Báo cáo tuần giải ngân (DIS)',
  period_code: '2026-10-18',
  period: { kind: 'AS_OF', year: 2026, day: '2026-10-18' },
  revision: 1,
  supersedes_id: null,
  reason: null,
  sha256: sha('c'),
  files: [{ format: 'XLSX', sha256: sha('d'), name: 'DIS-WEEKLY_2026-10-18_v01_dddddddd.xlsx', size_bytes: 8192 }],
  data_source: 'LIVE',
  form_status: 'READY',
  demo_mark: null,
  counts_as_accepted: true,
  snapshot: null,
  issue_count: 0,
  prepared_by_name: 'Nguyễn Văn An',
  checked_by_name: 'Trần Thị Bình',
  approved_by_name: 'Lê Văn Cường',
  issued_by_name: 'Lê Văn Cường',
  issued_at: '2026-11-07T02:00:00.000Z',
  is_current: true,
  current_revision: 1,
  chain: [],
  deliveries: [],
  issues: [],
  can_deliver: true,
  can_answer: true,
  ...over,
});

export const delivery = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(n),
  issue_id: uuid(1),
  layout_code: 'DIS-WEEKLY',
  period_code: '2026-10-18',
  revision: 1,
  sha256: sha('c'),
  receiver: 'MOF',
  channel: 'DOWNLOAD',
  event: 'DELIVERED',
  reference: null,
  note: null,
  counts_as_accepted: true,
  recorded_by_name: 'Phạm Thị Dung',
  occurred_at: '2026-11-07T03:00:00.000Z',
  ...over,
});

export const page = (items: unknown[]) => ({ items, truncated: false, as_of: AS_OF });
export const never = (): Promise<never> => new Promise<never>(() => undefined);
export { uuid };
