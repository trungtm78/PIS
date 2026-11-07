import { ApiError } from '@machvon/api-client';
import vi_ from '../../../../i18n/vi.json';
import part from '../../../../i18n/vi.json';
import type { WebRoute } from '../../../../routes/types';
import { PLATFORM_TENANT, harness } from '../../../sas/test-support';

export const catalogue = { ...(vi_ as Record<string, string>), ...(part as Record<string, string>) };
export const text = (key: string, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), catalogue[key] ?? key);

export const routeOf = (id: string): WebRoute => ({ id, path: `/adm/${id.toLowerCase()}`, title: id, kind: 'policy', area: 'admin', module: 'ADM', group: 'Quy tắc quản trị', role: 'workspace', parent: null, req: `FR-${id}` });
export const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const ME = PLATFORM_TENANT.membershipId;
export const OTHER = uuid(70);
export const THIRD = uuid(71);
export const refusal = (code: string, status = 422, detail?: string) => new ApiError({ status, code, correlationId: 'c', extensions: {}, ...(detail === undefined ? {} : { detail }) });

export const READ = 'adm.governance.read';
export const MANAGE = 'adm.governance.manage';
export const APPROVE = 'adm.governance.approve';
export const ALL = [READ, MANAGE, APPROVE];

export type Answer = unknown | ((input: Record<string, unknown>) => unknown);
/** A client whose reads are answered by the operation. */
export const serve = (answers: Record<string, Answer>, commands: Record<string, Answer> = {}) =>
  harness(
    (operation, input) => {
      const answer = answers[operation];
      if (answer === undefined) return new Error(`unexpected read ${operation}`);
      return typeof answer === 'function' ? (answer as (input: unknown) => unknown)(input) : answer;
    },
    (operation, input) => {
      const answer = commands[operation];
      return typeof answer === 'function' ? (answer as (input: unknown) => unknown)(input) : (answer ?? {});
    },
  );

const ALERT_SCHEMA = {
  source: { kind: 'text', max: 64 },
  owner: { kind: 'text', max: 64 },
  expected_action: { kind: 'text', max: 500, optional: true, allowEmpty: true },
  consequence: { kind: 'text', max: 500 },
  response_hours: { kind: 'int', min: 1, max: 8760 },
  default_severity: { kind: 'enum', values: ['URGENT', 'ACTION', 'WATCH'] },
  reason_to_exist: { kind: 'text', max: 500 },
  review_on: { kind: 'date' },
  enabled: { kind: 'boolean' },
};

const TIER_SCHEMA = {
  bands: { kind: 'list', max: 5, min: 1, of: { kind: 'object', fields: { tier: { kind: 'int', min: 1, max: 3 }, up_to_vnd: { kind: 'int', min: 0, max: 1_000_000_000_000 } } } },
  projectAdjustmentPct: { kind: 'number', min: 0, max: 100 },
  requireReserveCover: { kind: 'boolean' },
};

const provenance = (legal: 'VERIFIED' | 'UNVERIFIED') => ({ formula: 'Ngưỡng theo tỷ lệ cộng dồn', source: 'Báo cáo nghiên cứu 2026', as_of: '2026-11-08', legal_status: legal });

export const catalogueBody = () => ({
  items: [
    {
      rule_type: 'ALERT_TYPE',
      registered: true,
      owner_module: 'ADM',
      modules: ['NOT', 'HOME', 'ADM'],
      formula: 'Một loại cảnh báo nói ai phải làm, làm gì và khi nào xét lại',
      source: 'Sổ loại cảnh báo (G0-3)',
      as_of: '2026-11-08',
      legal_status: 'VERIFIED',
      schema: ALERT_SCHEMA,
      codes: [
        { code: 'APPROVAL', has_default: true, unverified: false, provenance: provenance('VERIFIED'), stored_versions: 0, in_force: 'DEFAULT', in_force_version: 0 },
        { code: 'EXPLANATION', has_default: true, unverified: false, provenance: provenance('VERIFIED'), stored_versions: 2, in_force: 'RULE', in_force_version: 2 },
      ],
    },
    {
      rule_type: 'CHANGE_ORDER_TIER',
      registered: true,
      owner_module: 'CTR',
      modules: ['CTR', 'PAY'],
      formula: 'Bậc của lệnh thay đổi theo giá trị cộng dồn',
      source: 'Thiết kế lệnh thay đổi (G1-8)',
      as_of: '2026-11-08',
      legal_status: 'UNVERIFIED',
      schema: TIER_SCHEMA,
      codes: [{ code: 'DEFAULT', has_default: true, unverified: true, provenance: provenance('UNVERIFIED'), stored_versions: 0, in_force: 'DEFAULT', in_force_version: 0 }],
    },
    {
      rule_type: 'RAG_THRESHOLDS',
      registered: true,
      owner_module: 'BI',
      modules: ['HOME', 'BI'],
      formula: 'Đèn xanh vàng đỏ theo ngưỡng',
      source: 'Báo cáo nghiên cứu 2026',
      as_of: '2026-11-08',
      legal_status: 'UNVERIFIED',
      schema: { direction: { kind: 'enum', values: ['HIGHER_IS_BETTER', 'LOWER_IS_BETTER'] }, green: { kind: 'number', min: 0, max: 100 } },
      codes: [{ code: 'DISBURSEMENT', has_default: true, unverified: true, provenance: provenance('UNVERIFIED'), stored_versions: 0, in_force: 'DEFAULT', in_force_version: 0 }],
    },
  ],
});

export const version = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(100 + n),
  rule_type: 'ALERT_TYPE',
  code: 'EXPLANATION',
  version: n,
  unit_id: null,
  status: 'DRAFT',
  phase: 'DRAFT',
  params: { response_hours: 72 },
  effective_from: '2026-12-01',
  effective_to: null,
  reason: `Lý do của phiên bản ${n}`,
  created_by: OTHER,
  created_at: '2026-11-01T03:00:00.000Z',
  submitted_by: null,
  submitted_at: null,
  approved_by: null,
  approved_at: null,
  retired_by: null,
  retired_at: null,
  retire_reason: null,
  resource_version: 1,
  ...over,
});

export const effectiveBody = (over: Record<string, unknown> = {}) => ({
  rule_type: 'ALERT_TYPE',
  code: 'EXPLANATION',
  as_of: '2026-11-08',
  params: { source: 'EXPLANATION', owner: 'RESPONDENT', response_hours: 48, enabled: true },
  version: 2,
  source: 'RULE',
  rule_id: uuid(102),
  unit_id: null,
  unverified: false,
  provenance: provenance('VERIFIED'),
  ...over,
});

export const defaultBody = (over: Record<string, unknown> = {}) =>
  effectiveBody({ params: { source: 'EXPLANATION', owner: 'RESPONDENT', response_hours: 72, enabled: true }, version: 0, source: 'DEFAULT', rule_id: null, ...over });

export const alertType = (code: string, over: Record<string, unknown> = {}) => ({
  code,
  source: code,
  owner: 'APPROVER',
  expected_action: 'Xem hồ sơ và quyết định',
  consequence: 'Hồ sơ bị dừng',
  response_hours: 72,
  default_severity: 'ACTION',
  reason_to_exist: 'Quyết định chậm là điểm nghẽn',
  review_on: '2027-05-08',
  review_overdue: false,
  enabled: true,
  version: 0,
  rule_source: 'DEFAULT',
  rule_id: null,
  unit_id: null,
  unverified: false,
  provenance: null,
  ...over,
});
