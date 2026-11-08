import { ApiError } from '@machvon/api-client';
import type { ReactElement } from 'react';
import { useLocation } from 'react-router-dom';
import { harness } from '../sas/test-support';
import type { Harness } from '../sas/test-support';
import { mount as bidMount, routeOf } from '../bid/test-support';
import type { SessionOptions } from '../bid/test-support';

export type { Harness };

export const AS_OF = '2026-11-12T03:00:00.000Z';
export const OTHER = '00000000-0000-4000-8000-00000000b007';
export const id = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;

export const routeFor = (screenId: string, req: string) => ({ ...routeOf(screenId, req), path: `/int/${screenId.toLowerCase()}`, module: 'INT' });

export const problem = (code: string, status: number, extensions: Record<string, unknown> = {}, detail?: string) =>
  new ApiError({ status, code, correlationId: 'c', extensions, ...(detail === undefined ? {} : { detail }) });

/** Answers of the reads by operation; an operation that is missing is a failure of the test. A function answers with its input. */
export type Answers = Record<string, unknown | Error | ((input: unknown) => unknown)>;

export function clientFor(answers: Answers, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  return harness((operation, input) => {
    const answer = answers[operation];
    if (answer === undefined) return new Error(`unexpected read ${operation}`);
    return typeof answer === 'function' ? (answer as (value: unknown) => unknown)(input) : answer;
  }, command);
}

/** Shows the address, so that a test can read what the screen put in it. */
export function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.search}</output>;
}

export function mount(screen: ReactElement, h: Harness, options: SessionOptions = { permissions: undefined }): ReturnType<typeof bidMount> {
  return bidMount(
    <>
      {screen}
      <Where />
    </>,
    h,
    options,
  );
}

// ---- fixtures of the contract shapes

export const credential = (n: number, over: Record<string, unknown> = {}) => ({
  id: id('00c0', n),
  client_id: `mvc_aaaaaaaaaaaaaaaaaaaaaaaaa${n}`,
  secret_hint: 'mvs_Ab12',
  state: 'ACTIVE',
  created_at: '2026-11-01T02:00:00.000Z',
  superseded_at: null,
  expires_at: null,
  revoked_at: null,
  last_used_at: '2026-11-11T05:00:00.000Z',
  ...over,
});

export const account = (n: number, over: Record<string, unknown> = {}) => ({
  id: id('00a0', n),
  name: `Lakehouse ${n}`,
  description: null,
  scopes: ['open.projects.read', 'open.contracts.read'],
  rate_limit_per_minute: 60,
  expires_on: null,
  status: 'ACTIVE',
  status_reason: null,
  status_changed_at: null,
  version: 3,
  created_at: '2026-11-01T02:00:00.000Z',
  created_by_name: 'Nguyễn Văn An',
  credentials: [credential(n)],
  actions: { update: true, decide: true, rotate: true },
  ...over,
});

export const accountPage = (items: unknown[], over: Record<string, unknown> = {}) => ({
  items,
  next_cursor: null,
  counts: { ACTIVE: items.length, SUSPENDED: 0, REVOKED: 0 },
  scopes: [
    { code: 'open.projects.read', dataset_code: null },
    { code: 'open.project-codes.read', dataset_code: null },
    { code: 'open.disbursement.read', dataset_code: 'DS-DISB' },
    { code: 'open.contracts.read', dataset_code: 'DS-CTR' },
  ],
  rate_limit: { min: 1, max: 6000, default: 60 },
  token_url: '/open/v1/token',
  can_create: true,
  as_of: AS_OF,
  ...over,
});

export const logEntry = (n: number, over: Record<string, unknown> = {}) => ({
  id: id('00e0', n),
  account_id: id('00a0', 1),
  account_name: 'Lakehouse 1',
  credential_id: id('00c0', 1),
  operation: 'listOpenProjects',
  scope: 'open.projects.read',
  path: '/open/v1/projects',
  query_keys: ['limit'],
  outcome: 'OK',
  status: 200,
  row_count: 3,
  correlation_id: `corr-${n}`,
  occurred_at: '2026-11-12T02:00:00.000Z',
  ...over,
});

export const systemRow = (n: number, over: Record<string, unknown> = {}) => ({
  id: id('0050', n),
  code: n === 1 ? 'EBS' : `SYS${n}`,
  name: n === 1 ? 'Oracle EBS' : `System ${n}`,
  kind: 'ERP',
  code_pattern: 'P-\\d{3}',
  status: 'ACTIVE',
  retire_reason: null,
  retired_at: null,
  active_codes: 0,
  proposed_codes: 0,
  version: 1,
  created_at: '2026-11-01T02:00:00.000Z',
  can_retire: true,
  ...over,
});

export const codeRow = (n: number, over: Record<string, unknown> = {}) => ({
  id: id('00d0', n),
  project_id: id('0060', n),
  project_code: `PRJ-${n}`,
  project_name: `Project ${n}`,
  source_system: 'EBS',
  external_code: `P-${100 + n}`,
  valid_from: '2026-10-01',
  valid_until: null,
  status: 'PROPOSED',
  proposed_by_name: 'Nguyễn Văn An',
  proposal_reason: 'Khớp theo quyết định đầu tư',
  approved_by_name: null,
  approved_at: null,
  decision_reason: null,
  retired_by_name: null,
  retired_at: null,
  retire_reason: null,
  version: 1,
  created_at: '2026-11-01T02:00:00.000Z',
  actions: { decide: true, retire: false },
  ...over,
});

export const codePage = (items: unknown[], over: Record<string, unknown> = {}) => ({
  items,
  next_cursor: null,
  counts: { PROPOSED: items.length, ACTIVE: 0, REJECTED: 0, RETIRED: 0 },
  systems: [{ code: 'EBS', name: 'Oracle EBS', code_pattern: 'P-\\d{3}' }],
  can_propose: true,
  as_of: AS_OF,
  ...over,
});

export const datasetRow = (code: 'DS-DISB' | 'DS-CTR', over: Record<string, unknown> = {}) => ({
  dataset_code: code,
  view_name: code === 'DS-DISB' ? 'v_disbursement_lines' : 'v_contract_lines',
  scope: code === 'DS-DISB' ? 'open.disbursement.read' : 'open.contracts.read',
  grain: 'one row per line',
  columns: ['tenant_id', 'snapshot_id'],
  product_id: null,
  product_code: null,
  product_title: null,
  certification: null,
  certification_expires_on: null,
  enabled: false,
  state_reason: null,
  state_changed_at: null,
  version: 1,
  gate: { open: false, reason: 'DISABLED' },
  can_set: true,
  ...over,
});

export const datasetList = (items: unknown[] = [datasetRow('DS-CTR'), datasetRow('DS-DISB')]) => ({
  items,
  products: [{ id: id('0070', 1), code: 'DP-A', title: 'Certified product', certification: 'CERTIFIED', certification_expires_on: '2099-01-01' }],
  as_of: AS_OF,
});

export const readerRow = (n: number, over: Record<string, unknown> = {}) => ({
  id: id('0080', n),
  name: `Power BI ${n}`,
  tool: 'Power BI',
  login_name: `machvon_bi_00000000000${n}`,
  connection_limit: 5,
  status: 'ACTIVE',
  status_reason: null,
  status_changed_at: null,
  password_rotated_at: '2026-11-01T02:00:00.000Z',
  version: 1,
  created_at: '2026-11-01T02:00:00.000Z',
  actions: { rotate: true, decide: true },
  ...over,
});

export const readerPage = (items: unknown[], over: Record<string, unknown> = {}) => ({
  items,
  next_cursor: null,
  counts: { ACTIVE: items.length, SUSPENDED: 0, RETIRED: 0 },
  views: [
    { dataset_code: 'DS-DISB', view: 'v_disbursement_lines', grain: 'one row per line', columns: ['tenant_id', 'line_id'], open: true },
    { dataset_code: 'DS-CTR', view: 'v_contract_lines', grain: 'one row per contract', columns: ['tenant_id', 'contract_id'], open: false },
  ],
  schema_name: 'machvon_bi',
  can_create: true,
  as_of: AS_OF,
  ...over,
});
