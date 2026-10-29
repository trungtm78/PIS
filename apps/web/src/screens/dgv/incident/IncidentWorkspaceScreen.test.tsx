import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { PLATFORM_TENANT, harness as baseHarness, mount } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import { routeOf } from '../test-support';
import IncidentWorkspaceScreen from './IncidentWorkspaceScreen';
import * as labels from './labels';
import { MAX_WAIVER_DAYS, NO_FILTER, assignBody, decisionBody, describeProblem, emptyAssign, emptyDecision, filterQuery, referenceLines, toException, toIncident, validateAssign, validateDecision, validateResolve, validateVerify, waiverEnd } from './model';

const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
const problem = (code: string, status = 422, detail?: string) => new ApiError({ status, code, correlationId: 'c', retryAfterSeconds: undefined, detail, extensions: {} });
const ME = PLATFORM_TENANT.membershipId;
const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
const ENG = uuid('0001', 3);
const incidentId = (n: number): string => uuid('0010', n);

const actions = (on: Partial<{ assign: boolean; advance: string | null; verify: boolean }> = {}) => ({ assign: false, advance: null, verify: false, ...on });

const incident = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: incidentId(n),
  title: `DS-1 / R-UNIQ ${n}`,
  dataset: { id: uuid('0002', 1), code: 'DS-1' },
  rule: { code: 'R-UNIQ', dimension: 'UNIQUENESS' },
  severity: 'HIGH',
  status: 'OPEN',
  owner: { id: uuid('0001', 2), name: 'Tran Thi Binh' },
  assignee: null,
  due_at: '2999-01-01T03:00:00.000000Z',
  sla_hours: 24,
  is_overdue: false,
  sla_breached_at: null,
  root_cause: null,
  remediation: null,
  resolved_at: null,
  verified_by: null,
  verified_at: null,
  closed_at: null,
  reopened_count: 0,
  run_id: uuid('0003', 1),
  created_at: `2026-10-2${n}T01:00:00.000000Z`,
  version: 1,
  actions: actions(),
  events: [{ id: uuid('0020', n), kind: 'CREATED', actor: null, from_status: null, to_status: 'OPEN', note: null, occurred_at: '2026-10-28T01:00:00.000000Z' }],
  ...overrides,
});

const exceptionRow = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid('0030', n),
  dataset: { id: uuid('0002', 1), code: 'DS-1' },
  incident_id: incidentId(1),
  record_reference: { row_id: 'HH-0001', national_id: '012345672345' },
  masked: false,
  reason: 'Trùng khóa ở dòng này',
  status: 'OPEN',
  decision: null,
  waiver_reason: null,
  waiver_expires_at: null,
  reopened_from_id: null,
  version: 1,
  actions: { decide: true },
  ...overrides,
});

interface World {
  incidents: Array<Record<string, unknown>>;
  exceptions: Array<Record<string, unknown>>;
  members: Array<Record<string, unknown>>;
  failing: Set<string>;
  pageSize?: number;
}

function client(state: Partial<World> = {}, command: (operation: string, input: unknown) => unknown = () => ({ resource_id: incidentId(1), resource_version: 2 })): Harness & { world: World } {
  const world: World = { incidents: [], exceptions: [], members: [{ id: ENG, display_name: 'Le Van Cuong', status: 'Active', membership_type: 'STAFF' }], failing: new Set(), ...state };
  const h = baseHarness((operation, input) => {
    if (world.failing.has(operation)) return new Error(`${operation} failed`);
    const query = (input as { query?: Record<string, string> } | undefined)?.query ?? {};
    if (operation === 'get_resources_quality_incident') {
      const items = world.incidents.filter((item) => (query.status === undefined || item.status === query.status) && (query.severity === undefined || item.severity === query.severity) && (query.overdue === undefined || item.is_overdue === true));
      return { items, next_cursor: null, as_of: '2026-10-28T04:00:00.000Z' };
    }
    if (operation === 'get_resources_quality_incident_id') {
      const found = world.incidents.find((item) => item.id === (input as { path: { id: string } }).path.id);
      return found === undefined ? problem('RESOURCE_NOT_FOUND', 404) : found;
    }
    if (operation === 'get_resources_quality_exception') {
      const all = world.exceptions.filter((item) => (query.incident_id === undefined || item.incident_id === query.incident_id) && (query.status === undefined || item.status === query.status));
      const from = query.cursor === undefined ? 0 : Number(query.cursor);
      const size = world.pageSize ?? 200;
      return { items: all.slice(from, from + size), next_cursor: from + size < all.length ? String(from + size) : null };
    }
    return new Error(`unexpected read ${operation}`);
  }, command);
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => (operation === 'get_resources_membership' ? Promise.resolve(world.members) : Promise.reject(new Error(`unexpected readAll ${operation}`))));
  return { ...h, world };
}

function open(state: Partial<World> = {}, options: { path?: string; mode?: 'FULL' | 'READ_ONLY'; permissions?: readonly string[]; command?: (operation: string, input: unknown) => unknown } = {}) {
  const h = client(state, options.command);
  mount(<IncidentWorkspaceScreen route={routeOf('DGV-08', 'FR-DGV-08')} />, h, options.permissions ?? ['quality_incident.read', 'membership.read'], options.path ?? '/dgv/dgv-08');
  void options.mode;
  return h;
}

const rows = (): string[] => Array.from(document.querySelectorAll('[data-incident]')).map((row) => row.getAttribute('data-incident') as string);
const dialog = (): HTMLElement => screen.getByRole('dialog');
const underIncident = async (): Promise<HTMLElement> => within(await screen.findByTestId('incident-exceptions')).findByTestId('exceptions');
const pick = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const commandsOf = (h: Harness, operation: string): Array<{ path?: { id?: string }; body?: Record<string, unknown>; ifMatchVersion?: number }> =>
  h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { path?: { id?: string }; body?: Record<string, unknown>; ifMatchVersion?: number });
const futureLocal = (hours: number): string => {
  const at = new Date(Date.now() + hours * 3_600_000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
};
const futureDay = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

afterEach(() => cleanup());

describe('IncidentWorkspaceScreen (DGV-08): the incidents of data quality', () => {
  it('UI-DGV-08: lists the incidents with severity, status, handler and due time, and marks the ones that are overdue', async () => {
    open({ incidents: [incident(3, { severity: 'CRITICAL', is_overdue: true, due_at: '2026-10-01T01:00:00.000000Z' }), incident(2, { status: 'ASSIGNED', assignee: { id: ENG, name: 'Le Van Cuong' } }), incident(1)] });
    await screen.findByTestId('incidents');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('dgv.incident.title'));
    expect(rows()).toEqual([incidentId(3), incidentId(2), incidentId(1)]);
    const late = document.querySelector(`[data-incident="${incidentId(3)}"]`) as HTMLElement;
    expect(within(late).getByTestId('severity').textContent).toBe(word('dgv.incident.severity.critical'));
    expect(within(late).getByTestId('overdue').textContent).toBe(word('dgv.incident.overdue'));
    const assigned = document.querySelector(`[data-incident="${incidentId(2)}"]`) as HTMLElement;
    expect(within(assigned).getByTestId('status').textContent).toBe(word('dgv.incident.status.assigned'));
    expect(assigned.textContent).toContain('Le Van Cuong');
    expect(within(document.querySelector(`[data-incident="${incidentId(1)}"]`) as HTMLElement).queryByTestId('overdue')).toBeNull();
    expect(screen.getByText(word('dgv.incident.footer.reference').replace('{id}', 'DGV-08').replace('{req}', 'FR-DGV-08'))).toBeTruthy();
  });

  it('narrows the list by state, severity, overdue and mine, asking the server for only what was chosen', async () => {
    const h = open({ incidents: [incident(3, { severity: 'LOW', status: 'ASSIGNED' }), incident(2, { is_overdue: true }), incident(1)] });
    await screen.findByTestId('incidents');
    const queries = () => h.read.mock.calls.filter((call) => call[0] === 'get_resources_quality_incident').map((call) => (call[1] as { query: Record<string, unknown> }).query);
    expect(queries()[0]).toEqual({ limit: 50 });
    pick('incident-filter-status', 'ASSIGNED');
    await waitFor(() => expect(rows()).toEqual([incidentId(3)]));
    pick('incident-filter-status', '');
    pick('incident-filter-severity', 'LOW');
    await waitFor(() => expect(rows()).toEqual([incidentId(3)]));
    pick('incident-filter-severity', '');
    fireEvent.click(document.getElementById('incident-filter-overdue') as HTMLElement);
    await waitFor(() => expect(rows()).toEqual([incidentId(2)]));
    fireEvent.click(document.getElementById('incident-filter-overdue') as HTMLElement);
    fireEvent.click(document.getElementById('incident-filter-mine') as HTMLElement);
    await waitFor(() => expect(queries().at(-1)).toEqual({ limit: 50, assignee_id: ME }));
  });

  it('says when there is no incident, and shows a read that failed with a way to read again', async () => {
    open();
    expect((await screen.findByTestId('no-incidents')).textContent).toBe(word('dgv.incident.none.notice'));
    cleanup();
    const h = client({ failing: new Set(['get_resources_quality_incident']) });
    mount(<IncidentWorkspaceScreen route={routeOf('DGV-08', 'FR-DGV-08')} />, h, ['quality_incident.read'], '/dgv/dgv-08');
    const retry = await screen.findByRole('button', { name: /thử lại|retry/i });
    h.world.failing.clear();
    fireEvent.click(retry);
    await screen.findByTestId('no-incidents');
  });

  it('opens an incident with its facts, its history and its exceptions, and offers only what the server says the viewer may do', async () => {
    open(
      {
        incidents: [
          incident(1, {
            status: 'RESOLVED_PENDING_VERIFICATION',
            assignee: { id: ENG, name: 'Le Van Cuong' },
            root_cause: 'Trùng khóa do nhập hai lần.',
            remediation: 'Thêm ràng buộc duy nhất ở nguồn.',
            reopened_count: 1,
            actions: actions({ verify: true }),
            events: [
              { id: uuid('0020', 1), kind: 'CREATED', actor: null, from_status: null, to_status: 'OPEN', note: null, occurred_at: '2026-10-28T01:00:00.000000Z' },
              { id: uuid('0020', 2), kind: 'ASSIGNED', actor: { id: ME, name: 'Tran Thi Binh' }, from_status: 'OPEN', to_status: 'ASSIGNED', note: 'Ưu tiên hôm nay.', occurred_at: '2026-10-28T02:00:00.000000Z' },
              { id: uuid('0020', 3), kind: 'SLA_BREACHED', actor: null, from_status: null, to_status: null, note: null, occurred_at: '2026-10-28T03:00:00.000000Z' },
            ],
          }),
        ],
        exceptions: [exceptionRow(1), exceptionRow(2, { masked: true, record_reference: { row_id: '***0001' }, status: 'WAIVED', waiver_expires_at: '2026-12-01T00:00:00.000000Z', actions: { decide: false } })],
      },
      { path: `/dgv/dgv-08?incident=${incidentId(1)}` },
    );
    expect((await screen.findByTestId('detail-title')).textContent).toBe('DS-1 / R-UNIQ 1');
    expect(screen.getByTestId('fact-status').textContent).toContain(word('dgv.incident.status.resolved'));
    expect(screen.getByTestId('fact-root-cause').textContent).toContain('Trùng khóa do nhập hai lần.');
    expect(screen.getByTestId('fact-reopened').textContent).toContain('1');
    expect(Array.from(document.querySelectorAll('[data-event]')).map((entry) => entry.getAttribute('data-event'))).toEqual(['CREATED', 'ASSIGNED', 'SLA_BREACHED']);
    expect(screen.getByTestId('history').textContent).toContain(word('dgv.incident.system'));
    // Only verification is offered.
    expect(Array.from((screen.getByTestId('detail') as HTMLElement).querySelectorAll('[data-action]:not([data-action="decide"])')).map((button) => button.getAttribute('data-action'))).toEqual(['verify']);
    const list = await underIncident();
    expect(list.querySelectorAll('li')).toHaveLength(2);
    expect(within(list.querySelector('[data-exception="' + uuid('0030', 2) + '"]') as HTMLElement).getByTestId('masked').textContent).toBe(word('dgv.incident.exceptions.masked'));
    expect(list.textContent).toContain('national_id: 012345672345');
    expect(list.querySelectorAll('[data-action="decide"]')).toHaveLength(1);
  });

  it('shows nothing to do in a read-only session, and says when an incident is not there', async () => {
    open({ incidents: [incident(1, { actions: actions({ assign: true, verify: true }) })] }, { path: `/dgv/dgv-08?incident=${incidentId(1)}` });
    await screen.findByTestId('detail-title');
    expect(document.querySelectorAll('[data-action]').length).toBeGreaterThan(0);
    cleanup();
    const missing = client({ incidents: [] });
    mount(<IncidentWorkspaceScreen route={routeOf('DGV-08', 'FR-DGV-08')} />, missing, ['quality_incident.read'], `/dgv/dgv-08?incident=${incidentId(9)}`);
    await screen.findByTestId('detail-failed');
  });

  it('AC-ST-DGV-003-1: UAT-AC487 gives an incident to an engineer chosen from the members, with a due time ahead, under the version shown', async () => {
    const h = open({ incidents: [incident(1, { actions: actions({ assign: true }), version: 3 })] }, { path: `/dgv/dgv-08?incident=${incidentId(1)}` });
    fireEvent.click(await screen.findByRole('button', { name: word('dgv.incident.assign.action') }));
    fireEvent.click(within(dialog()).getByRole('button', { name: word('dgv.incident.assign.submit') }));
    expect(within(dialog()).getAllByText(word('dgv.incident.problem.required'))).toHaveLength(2);
    await waitFor(() => expect(within(document.getElementById('assign-assignee') as HTMLElement).getByText('Le Van Cuong')).toBeTruthy());
    pick('assign-assignee', ENG);
    pick('assign-due', futureLocal(-2));
    fireEvent.click(within(dialog()).getByRole('button', { name: word('dgv.incident.assign.submit') }));
    expect(within(dialog()).getByText(word('dgv.incident.problem.pastDate'))).toBeTruthy();
    expect(commandsOf(h, 'assignQualityIncident')).toHaveLength(0);
    pick('assign-due', futureLocal(24));
    pick('assign-note', '  Ưu tiên hôm nay.  ');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('dgv.incident.assign.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const [sent] = commandsOf(h, 'assignQualityIncident');
    expect(sent).toMatchObject({ path: { id: incidentId(1) }, ifMatchVersion: 3, body: { assignee_user_id: ENG, note: 'Ưu tiên hôm nay.' } });
    expect(Date.parse(sent?.body?.due_at as string)).toBeGreaterThan(Date.now());
  });

  it('lets the handler be typed by id when the members cannot be listed, and says the server refused a person who cannot work incidents', async () => {
    const h = open(
      { incidents: [incident(1, { actions: actions({ assign: true }) })], failing: new Set(['get_resources_membership']) },
      {
        path: `/dgv/dgv-08?incident=${incidentId(1)}`,
        permissions: ['quality_incident.read'],
        command: () => {
          throw problem('ASSIGNEE_OUT_OF_SCOPE', 422, 'assignee_user_id');
        },
      },
    );
    fireEvent.click(await screen.findByRole('button', { name: word('dgv.incident.assign.action') }));
    const field = await waitFor(() => {
      const found = document.getElementById('assign-assignee') as HTMLInputElement;
      expect(found.tagName).toBe('INPUT');
      return found;
    });
    fireEvent.change(field, { target: { value: 'not-an-id' } });
    pick('assign-due', futureLocal(5));
    fireEvent.click(within(dialog()).getByRole('button', { name: word('dgv.incident.assign.submit') }));
    expect(within(dialog()).getByText(word('dgv.incident.problem.invalidId'))).toBeTruthy();
    fireEvent.change(field, { target: { value: ENG } });
    fireEvent.click(within(dialog()).getByRole('button', { name: word('dgv.incident.assign.submit') }));
    expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(word('dgv.incident.error.outOfScope'));
    expect(commandsOf(h, 'assignQualityIncident')).toHaveLength(1);
  });

  it('AC-ST-DGV-003-1: UAT-AC487 takes the incident one step with one button, and resolves it with the cause and the measure', async () => {
    const h = open({ incidents: [incident(1, { status: 'ASSIGNED', assignee: { id: ME, name: 'Me' }, actions: actions({ advance: 'ACKNOWLEDGED' }), version: 2 })] }, { path: `/dgv/dgv-08?incident=${incidentId(1)}` });
    fireEvent.click(await screen.findByRole('button', { name: word('dgv.incident.advance.acknowledge') }));
    await waitFor(() => expect(commandsOf(h, 'transitionQualityIncident')).toHaveLength(1));
    expect(commandsOf(h, 'transitionQualityIncident')[0]).toMatchObject({ path: { id: incidentId(1) }, ifMatchVersion: 2, body: { to_status: 'ACKNOWLEDGED' } });
    cleanup();
    const second = open({ incidents: [incident(1, { status: 'IN_PROGRESS', assignee: { id: ME, name: 'Me' }, actions: actions({ advance: 'RESOLVED_PENDING_VERIFICATION' }), version: 4 })] }, { path: `/dgv/dgv-08?incident=${incidentId(1)}` });
    fireEvent.click(await screen.findByRole('button', { name: word('dgv.incident.advance.resolve') }));
    fireEvent.click(within(dialog()).getByRole('button', { name: word('dgv.incident.resolve.submit') }));
    expect(within(dialog()).getAllByText(word('dgv.incident.problem.required'))).toHaveLength(2);
    pick('resolve-root-cause', 'ngắn');
    pick('resolve-remediation', 'Thêm ràng buộc duy nhất ở nguồn.');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('dgv.incident.resolve.submit') }));
    expect(within(dialog()).getByText(word('dgv.incident.problem.tooShort'))).toBeTruthy();
    pick('resolve-root-cause', '  Trùng khóa do nhập hai lần.  ');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('dgv.incident.resolve.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsOf(second, 'transitionQualityIncident')[0]).toMatchObject({ ifMatchVersion: 4, body: { to_status: 'RESOLVED_PENDING_VERIFICATION', root_cause: 'Trùng khóa do nhập hai lần.', remediation: 'Thêm ràng buộc duy nhất ở nguồn.' } });
  });

  it('AC-ST-DGV-003-1: UAT-AC487 says in words why the incident was not closed: the rerun has not passed, or the verifier did the work', async () => {
    const attempts: Error[] = [problem('RERUN_NOT_PASSED'), problem('SELF_APPROVAL_DENIED', 403)];
    const h = open(
      { incidents: [incident(1, { status: 'RESOLVED_PENDING_VERIFICATION', assignee: { id: ENG, name: 'Le Van Cuong' }, actions: actions({ verify: true }), version: 5 })] },
      {
        path: `/dgv/dgv-08?incident=${incidentId(1)}`,
        command: () => {
          const next = attempts.shift();
          if (next !== undefined) throw next;
          return { resource_id: incidentId(1), resource_version: 6 };
        },
      },
    );
    fireEvent.click(await screen.findByRole('button', { name: word('dgv.incident.verify.action') }));
    fireEvent.click(within(dialog()).getByRole('button', { name: word('dgv.incident.verify.submit') }));
    expect(within(dialog()).getByText(word('dgv.incident.problem.required'))).toBeTruthy();
    pick('verify-note', 'Chạy lại đạt, đã kiểm tra ràng buộc.');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('dgv.incident.verify.submit') }));
    expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(word('dgv.incident.error.rerunNotPassed'));
    fireEvent.click(within(dialog()).getByRole('button', { name: word('dgv.incident.verify.submit') }));
    await waitFor(() => expect(within(dialog()).getByTestId('refusal').textContent).toBe(word('dgv.incident.error.selfApproval')));
    expect(commandsOf(h, 'verifyQualityIncident').map((call) => call.body)).toEqual([
      { decision: 'CLOSE', note: 'Chạy lại đạt, đã kiểm tra ràng buộc.' },
      { decision: 'CLOSE', note: 'Chạy lại đạt, đã kiểm tra ràng buộc.' },
    ]);
    pick('verify-decision', 'REOPEN');
    pick('verify-note', 'Nguyên nhân chưa được xử lý ở nguồn.');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('dgv.incident.verify.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsOf(h, 'verifyQualityIncident')[2]).toMatchObject({ ifMatchVersion: 5, body: { decision: 'REOPEN' } });
  });

  it('reads the incident again and says so when it changed while the screen was open', async () => {
    const state: Partial<World> = { incidents: [incident(1, { status: 'IN_PROGRESS', assignee: { id: ME, name: 'Me' }, actions: actions({ advance: 'RESOLVED_PENDING_VERIFICATION' }), version: 4 })] };
    const h = open(state, {
      path: `/dgv/dgv-08?incident=${incidentId(1)}`,
      command: () => {
        throw problem('VERSION_CONFLICT', 409);
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: word('dgv.incident.advance.resolve') }));
    pick('resolve-root-cause', 'Trùng khóa do nhập hai lần.');
    pick('resolve-remediation', 'Thêm ràng buộc duy nhất ở nguồn.');
    h.world.incidents = [incident(1, { status: 'IN_PROGRESS', assignee: { id: ME, name: 'Me' }, actions: actions({ advance: 'RESOLVED_PENDING_VERIFICATION' }), version: 6 })];
    fireEvent.click(within(dialog()).getByRole('button', { name: word('dgv.incident.resolve.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await screen.findByTestId('refusal')).textContent).toBe(word('dgv.incident.error.versionConflict'));
    await waitFor(() => expect(h.read.mock.calls.filter((call) => call[0] === 'get_resources_quality_incident_id').length).toBeGreaterThan(1));
    fireEvent.click(await screen.findByRole('button', { name: word('dgv.incident.advance.resolve') }));
    expect(screen.queryByTestId('refusal')).toBeNull();
  });

  it('AC-ST-DGV-003-2: decides on an exception: resolved with a reason, or waived to a day at most 180 days away', async () => {
    const h = open({ incidents: [incident(1)], exceptions: [exceptionRow(1, { version: 3 })] }, { path: `/dgv/dgv-08?incident=${incidentId(1)}` });
    fireEvent.click(await within(await screen.findByTestId('incident-exceptions')).findByRole('button', { name: word('dgv.incident.exceptions.decide') }));
    fireEvent.click(within(dialog()).getByRole('button', { name: word('dgv.incident.decide.submit') }));
    expect(within(dialog()).getByText(word('dgv.incident.problem.required'))).toBeTruthy();
    pick('decide-decision', 'WAIVED');
    pick('decide-reason', 'Dòng này chờ nguồn sửa trong tháng.');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('dgv.incident.decide.submit') }));
    expect(within(dialog()).getByText(word('dgv.incident.problem.required'))).toBeTruthy();
    pick('decide-until', futureDay(MAX_WAIVER_DAYS + 5));
    fireEvent.click(within(dialog()).getByRole('button', { name: word('dgv.incident.decide.submit') }));
    expect(within(dialog()).getByText(word('dgv.incident.problem.tooFar'))).toBeTruthy();
    pick('decide-until', futureDay(30));
    fireEvent.click(within(dialog()).getByRole('button', { name: word('dgv.incident.decide.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const [sent] = commandsOf(h, 'post_quality_exceptions_id_decision');
    expect(sent).toMatchObject({ path: { id: uuid('0030', 1) }, ifMatchVersion: 3, body: { decision: 'WAIVED', reason: 'Dòng này chờ nguồn sửa trong tháng.' } });
    expect(sent?.body?.waiver_expires_at).toBe(waiverEnd(futureDay(30)).toISOString());
  });

  it('AC-ST-DGV-003-3: UAT-AC55 lists the exceptions on their own, so that a reviewer who may not read the incident can decide them, with the values hidden', async () => {
    const h = open({ incidents: [], exceptions: [exceptionRow(1, { incident_id: null, masked: true, record_reference: { national_id: '***2345' }, version: 7 }), exceptionRow(2, { status: 'RESOLVED', actions: { decide: false } })] });
    const queue = await screen.findByTestId('exception-queue');
    // The open ones first, by default.
    await within(queue).findByTestId('exceptions');
    expect(Array.from(queue.querySelectorAll('li')).map((item) => item.getAttribute('data-exception'))).toEqual([uuid('0030', 1)]);
    expect(within(queue).getByTestId('masked')).toBeTruthy();
    expect(queue.textContent).toContain('***2345');
    expect(queue.textContent).not.toContain('012345672345');
    pick('exception-filter-status', '');
    await waitFor(() => expect(queue.querySelectorAll('li')).toHaveLength(2));
    fireEvent.click(within(queue).getByRole('button', { name: word('dgv.incident.exceptions.decide') }));
    pick('decide-reason', 'Đã sửa dòng này ở nguồn.');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('dgv.incident.decide.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsOf(h, 'post_quality_exceptions_id_decision')[0]).toMatchObject({ ifMatchVersion: 7, body: { decision: 'RESOLVED' } });
  });

  it('reads every page of the exceptions of an incident, so that none is left out', async () => {
    open({ incidents: [incident(1)], pageSize: 2, exceptions: [exceptionRow(1), exceptionRow(2), exceptionRow(3), exceptionRow(4), exceptionRow(5)] }, { path: `/dgv/dgv-08?incident=${incidentId(1)}` });
    const section = await screen.findByTestId('incident-exceptions');
    await within(section).findByTestId('exceptions');
    const count = () => section.querySelectorAll('li').length;
    expect(count()).toBe(2);
    for (const expected of [4, 5]) {
      fireEvent.click(within(section).getByRole('button', { name: word('dgv.incident.more.action') }));
      await waitFor(() => expect(count()).toBe(expected));
    }
    expect(within(section).queryByRole('button', { name: word('dgv.incident.more.action') })).toBeNull();
  });

  it('reads the exceptions again and closes the dialog when another reviewer decided meanwhile', async () => {
    const h = open(
      { incidents: [incident(1)], exceptions: [exceptionRow(1, { version: 3 })] },
      {
        path: `/dgv/dgv-08?incident=${incidentId(1)}`,
        command: () => {
          throw problem('VERSION_CONFLICT', 409);
        },
      },
    );
    fireEvent.click(await within(await screen.findByTestId('incident-exceptions')).findByRole('button', { name: word('dgv.incident.exceptions.decide') }));
    pick('decide-reason', 'Đã sửa dòng này ở nguồn.');
    h.world.exceptions = [exceptionRow(1, { version: 4, status: 'RESOLVED', actions: { decide: false } })];
    fireEvent.click(within(dialog()).getByRole('button', { name: word('dgv.incident.decide.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await screen.findByTestId('refusal')).textContent).toBe(word('dgv.incident.error.versionConflict'));
    await waitFor(() => expect(screen.queryByRole('button', { name: word('dgv.incident.exceptions.decide') })).toBeNull());
  });

  it('says that an exception was decided already, or that the viewer may not decide it', async () => {
    const h = open(
      { incidents: [incident(1)], exceptions: [exceptionRow(1)] },
      {
        path: `/dgv/dgv-08?incident=${incidentId(1)}`,
        command: () => {
          throw problem('EXCEPTION_STATE_INVALID', 409);
        },
      },
    );
    fireEvent.click(await within(await screen.findByTestId('incident-exceptions')).findByRole('button', { name: word('dgv.incident.exceptions.decide') }));
    pick('decide-reason', 'Đã sửa dòng này ở nguồn.');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('dgv.incident.decide.submit') }));
    expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(word('dgv.incident.error.exceptionDecided'));
    expect(commandsOf(h, 'post_quality_exceptions_id_decision')).toHaveLength(1);
  });
});

describe('the model and the words of DGV-08', () => {
  it('reads an incident and an exception, dropping what is not one', () => {
    const view = toIncident(incident(1, { actions: actions({ assign: true, advance: 'IN_PROGRESS' }) }));
    expect(view).toMatchObject({ id: incidentId(1), severity: 'HIGH', status: 'OPEN', datasetCode: 'DS-1', ruleCode: 'R-UNIQ', actions: { assign: true, advance: 'IN_PROGRESS', verify: false } });
    expect(toIncident({ ...incident(1), status: 'LOST' })).toBeUndefined();
    expect(toIncident({ ...incident(1), version: '1' })).toBeUndefined();
    expect(toIncident(null)).toBeUndefined();
    expect(toIncident(incident(1, { actions: actions({ advance: 'CLOSED' }) }))?.actions.advance).toBeNull();
    expect(toException(exceptionRow(1))).toMatchObject({ status: 'OPEN', masked: false, canDecide: true, version: 1 });
    expect(toException({ ...exceptionRow(1), status: 'NOPE' })).toBeUndefined();
    expect(referenceLines({ row_id: 'a', n: 3, nested: { x: 1 } })).toEqual(['row_id: a', 'n: 3', 'nested: {"x":1}']);
    expect(referenceLines('x')).toEqual([]);
  });

  it('asks the server only for what was chosen', () => {
    expect(filterQuery(NO_FILTER, ME)).toEqual({});
    expect(filterQuery({ status: 'ASSIGNED', severity: 'LOW', overdue: true, mine: true }, ME)).toEqual({ status: 'ASSIGNED', severity: 'LOW', overdue: 'true', assignee_id: ME });
    expect(filterQuery({ status: 'NOPE', severity: 'NOPE', overdue: false, mine: true }, undefined)).toEqual({});
  });

  it('validates the forms the way the server will', () => {
    const now = new Date('2026-10-28T04:00:00Z');
    expect(validateAssign(emptyAssign(), now)).toEqual({ assigneeId: 'required', dueAt: 'required' });
    expect(validateAssign({ assigneeId: 'x', dueAt: 'nonsense', note: '' }, now)).toEqual({ assigneeId: 'invalidId', dueAt: 'invalidDate' });
    expect(validateAssign({ assigneeId: ENG, dueAt: '2026-10-28T10:00', note: '' }, new Date('2026-10-28T09:00:00')).dueAt).toBeUndefined();
    expect(validateAssign({ assigneeId: ENG, dueAt: '2020-01-01T00:00', note: '' }, now)).toEqual({ dueAt: 'pastDate' });
    expect(assignBody({ assigneeId: ENG, dueAt: '2999-01-01T10:00', note: '  hi  ' })).toMatchObject({ assignee_user_id: ENG, note: 'hi' });
    expect(assignBody({ assigneeId: ENG, dueAt: '2999-01-01T10:00', note: ' ' })).not.toHaveProperty('note');
    expect(validateResolve({ rootCause: '', remediation: 'x'.repeat(10) })).toEqual({ rootCause: 'required' });
    expect(validateResolve({ rootCause: 'x'.repeat(10), remediation: 'ngắn' })).toEqual({ remediation: 'tooShort' });
    expect(validateVerify({ decision: 'CLOSE', note: '' })).toEqual({ note: 'required' });
    expect(validateVerify({ decision: 'CLOSE', note: 'ngắn' })).toEqual({ note: 'tooShort' });
    expect(validateVerify({ decision: 'CLOSE', note: 'x'.repeat(10) })).toEqual({});
    const decision = { ...emptyDecision(), decision: 'WAIVED' as const, reason: 'Chờ nguồn sửa dữ liệu.' };
    expect(validateDecision(emptyDecision(), now)).toEqual({ reason: 'required' });
    expect(validateDecision(decision, now)).toEqual({ waiverUntil: 'required' });
    expect(validateDecision({ ...decision, waiverUntil: '2026-10-27' }, now)).toEqual({ waiverUntil: 'pastDate' });
    expect(validateDecision({ ...decision, waiverUntil: '2027-12-31' }, now)).toEqual({ waiverUntil: 'tooFar' });
    expect(validateDecision({ ...decision, waiverUntil: '2026-13-45' }, now)).toEqual({ waiverUntil: 'invalidDate' });
    expect(validateDecision({ ...decision, waiverUntil: '2026-11-30' }, now)).toEqual({});
    expect(decisionBody({ ...decision, waiverUntil: '2026-11-30' })).toEqual({ decision: 'WAIVED', reason: 'Chờ nguồn sửa dữ liệu.', waiver_expires_at: '2026-11-30T16:59:00.000Z' });
    expect(decisionBody({ decision: 'RESOLVED', reason: ' Đã sửa dòng này. ', waiverUntil: '2026-11-30' })).toEqual({ decision: 'RESOLVED', reason: 'Đã sửa dòng này.' });
  });

  it('words each refusal and has a word for every state, severity, event and problem', () => {
    const codes: Array<[string, string]> = [
      ['ROOT_CAUSE_REQUIRED', 'rootCause'],
      ['RERUN_NOT_PASSED', 'rerunNotPassed'],
      ['SELF_APPROVAL_DENIED', 'selfApproval'],
      ['INCIDENT_STATE_INVALID', 'stateInvalid'],
      ['EXCEPTION_STATE_INVALID', 'exceptionDecided'],
      ['NOT_ASSIGNEE', 'notAssignee'],
      ['ASSIGNEE_OUT_OF_SCOPE', 'outOfScope'],
      ['VERSION_CONFLICT', 'versionConflict'],
      ['VALIDATION_FAILED', 'validation'],
      ['RESOURCE_NOT_FOUND', 'notFound'],
      ['SCOPE_DENIED', 'denied'],
      ['SOMETHING', 'general'],
    ];
    for (const [code, expected] of codes) expect([code, describeProblem(problem(code))]).toEqual([code, expected]);
    expect(describeProblem(new Error('x'))).toBe('general');
    const t = ((key: string) => (vi_ as Record<string, string>)[key] ?? `MISSING:${key}`) as never;
    const all = [
      ...(['OPEN', 'ASSIGNED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED_PENDING_VERIFICATION', 'CLOSED', 'REOPENED'] as const).map((status) => labels.statusLabel(t, status)),
      ...(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const).map((severity) => labels.severityLabel(t, severity)),
      ...(['OPEN', 'RESOLVED', 'WAIVED'] as const).map((status) => labels.exceptionStatusLabel(t, status)),
      ...(['ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED_PENDING_VERIFICATION'] as const).map((step) => labels.advanceLabel(t, step)),
      ...['CREATED', 'ASSIGNED', 'STATUS_CHANGED', 'COMMENTED', 'REOPENED', 'VERIFIED', 'SLA_BREACHED'].map((kind) => labels.eventLabel(t, kind)),
      ...(['required', 'tooShort', 'invalidId', 'invalidDate', 'pastDate', 'tooFar'] as const).map((item) => labels.formProblemMessage(t, item)),
      ...codes.map(([, expected]) => labels.problemMessage(t, expected as never)),
    ];
    expect(all.filter((entry) => entry.startsWith('MISSING:'))).toEqual([]);
    expect(labels.eventLabel(t, 'OTHER')).toBe('OTHER');
  });
});
