import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { mountInSession } from '../../doc/test-support';
import { routeOf } from '../../dgv/test-support';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import ReorganizationScreen from './ReorganizationScreen';
import * as labels from './labels';
import { UNIT_TYPES, WORKING_REFRESH_MS, decisionsFor, describeProblem, isWorking, emptyForm, formProblems, problemsOfStep, readMissing, stepCounts, stepKind, toBody, toReorganization } from './model';
import type { Form, Problem } from './model';

const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
const problem = (code: string, status = 422, extensions: Record<string, unknown> = {}, detail?: string) => new ApiError({ status, code, correlationId: 'c', retryAfterSeconds: undefined, detail, extensions });
const uuid = (n: number): string => `00000000-0000-4000-8000-${'0160'}${String(n).padStart(8, '0')}`;
const ROUTE = routeOf('ADM-16', 'FR-ADM-16');
const ALL = ['iam.unit.reorganize.read', 'iam.unit.reorganize', 'iam.unit.reorganize.approve'];
const UNITS = [uuid(1), uuid(2), uuid(3), uuid(4)].map((id, index) => ({ id, code: `U${index + 1}`, name: `Đơn vị ${index + 1}` }));
const unit = (n: number, status = 'Active') => ({ id: uuid(n), code: `U${n}`, name: `Đơn vị ${n}`, status });

const reorganization = (n: number, extra: Record<string, unknown> = {}) => ({
  id: uuid(100 + n),
  kind: 'MERGE',
  effective_from: '2026-11-15',
  legal_basis_ref: 'NQ 12/NQ-UBND',
  status: 'PendingApproval',
  predecessors: [unit(1), unit(2)],
  successors: [unit(3)],
  new_unit: null,
  mapping: { memberships: 0, projects: 0, default_successor_unit_id: null },
  requested_by: { id: uuid(500), name: 'Lê Người Đề' },
  approved_by: { id: null, name: null },
  decided_at: null,
  decision_reason: null,
  applied_at: null,
  result_summary: null,
  created_at: '2026-10-29T01:00:00.000000Z',
  version: 2,
  actions: { decide: true },
  ...extra,
});
const MEMBERS = [
  { id: uuid(601), organization_id: uuid(1), status: 'Active' },
  { id: uuid(602), organization_id: uuid(1), status: 'Active' },
  { id: uuid(603), organization_id: uuid(2), status: 'Active' },
  { id: uuid(604), organization_id: uuid(2), status: 'Suspended' },
  { id: uuid(605), organization_id: uuid(3), status: 'Active' },
];

interface World {
  rows: Array<Record<string, unknown>>;
  failing: boolean;
}

function open(state: Partial<World> = {}, options: { permissions?: readonly string[]; mode?: 'FULL' | 'READ_ONLY'; command?: (operation: string, input: unknown) => unknown } = {}): Harness & { world: World } {
  const world: World = { rows: [], failing: false, ...state };
  const h = baseHarness((operation, input) => {
    if (operation === 'get_resources_unit_reorganization_id') {
      const found = world.rows.find((row) => row.id === (input as { path: { id: string } }).path.id);
      return found === undefined ? new Error('missing') : found;
    }
    return new Error(`unexpected read ${operation}`);
  }, options.command);
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => {
    if (operation === 'get_resources_unit_reorganization') return world.failing ? Promise.reject(new Error('failed')) : Promise.resolve(world.rows);
    if (operation === 'get_resources_organization_unit') return Promise.resolve(UNITS);
    if (operation === 'get_resources_membership') return Promise.resolve(MEMBERS);
    return Promise.reject(new Error(`unexpected readAll ${operation}`));
  });
  mountInSession(<ReorganizationScreen route={ROUTE} />, h, { permissions: options.permissions ?? ALL, ...(options.mode === undefined ? {} : { mode: options.mode }) }, '/adm/adm-16');
  return { ...h, world };
}

const commandsCalled = (h: Harness, operation: string): Array<{ path?: Record<string, string>; body?: Record<string, unknown>; ifMatchVersion?: number }> =>
  h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { path?: Record<string, string>; body?: Record<string, unknown>; ifMatchVersion?: number });
const type = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const dialog = (): HTMLElement => screen.getByRole('dialog');
const check = (role: string, id: string): void => {
  fireEvent.click(document.querySelector(`[data-role="${role}"][value="${id}"]`) as HTMLElement);
};
const next = (): void => {
  fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.reorg.wizard.next') }));
};

afterEach(() => cleanup());

describe('ReorganizationScreen (ADM-16): the reorganisation of organisation units', () => {
  it('UI-ADM-16, AC-ST-ADM-015-3: lists the proposals with the units, the date and the state; opening one shows the timeline of the saga with what has been done', async () => {
    const detail = reorganization(2, {
      status: 'Applied',
      approved_by: { id: uuid(501), name: 'Trần Người Duyệt' },
      result_summary: { memberships: 4, grants: 5, projects: 4 },
      steps: [
        { key: 'succession:a', done_at: '2026-11-15T00:01:00Z' },
        { key: 'membership:b', done_at: '2026-11-15T00:02:00Z' },
        { key: 'membership:c', done_at: '2026-11-15T00:03:00Z' },
        { key: 'grant:d', done_at: '2026-11-15T00:04:00Z' },
        { key: 'project:e', done_at: '2026-11-15T00:05:00Z' },
        { key: 'retire:f', done_at: '2026-11-15T00:06:00Z' },
      ],
    });
    open({ rows: [reorganization(1), detail, reorganization(3, { status: 'Failed', kind: 'SPLIT' })] });
    await screen.findByTestId('reorganizations');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('adm.reorg.title'));
    const row = (n: number) => document.querySelector(`[data-reorganization="${uuid(100 + n)}"]`) as HTMLElement;
    expect(within(row(1)).getByTestId('status').textContent).toBe(word('adm.reorg.status.pending'));
    expect(within(row(2)).getByTestId('status').textContent).toBe(word('adm.reorg.status.applied'));
    expect(within(row(3)).getByTestId('status').textContent).toBe(word('adm.reorg.status.failed'));
    expect(row(1).textContent).toContain('Đơn vị 1, Đơn vị 2');
    expect(row(1).textContent).toContain('Đơn vị 3');
    expect(row(1).textContent).toContain(word('adm.reorg.kind.merge'));
    expect(row(3).textContent).toContain(word('adm.reorg.kind.split'));
    // The timeline of the one opened: what was done, in the order the saga does it.
    fireEvent.click(within(row(2)).getByRole('button', { name: word('adm.reorg.open.action') }));
    const timeline = await screen.findByTestId('timeline');
    expect(Array.from(timeline.querySelectorAll('[data-step]')).map((item) => [item.getAttribute('data-step'), item.textContent])).toEqual([
      ['succession', word('adm.reorg.timeline.succession').replace('{count}', '1')],
      ['membership', word('adm.reorg.timeline.membership').replace('{count}', '2')],
      ['grant', word('adm.reorg.timeline.grant').replace('{count}', '1')],
      ['project', word('adm.reorg.timeline.project').replace('{count}', '1')],
      ['retire', word('adm.reorg.timeline.retire').replace('{count}', '1')],
    ]);
    expect(within(timeline).getByTestId('applied').textContent).toBe(word('adm.reorg.timeline.applied').replace('{members}', '4').replace('{grants}', '5').replace('{projects}', '4'));
    expect(timeline.textContent).toContain('Trần Người Duyệt');
  });

  it('says where a saga that failed stopped, and offers to decide it again', async () => {
    const failed = reorganization(3, { status: 'Failed', result_summary: { failed: { step: `reorg:${uuid(103)}:project:${uuid(77)}`, code: 'PROJECT_TRANSFER_UNAVAILABLE' } }, steps: [{ key: 'membership:b', done_at: '2026-11-15T00:02:00Z' }] });
    const h = open({ rows: [failed] }, { command: () => ({ resource_id: uuid(103), resource_version: 3 }) });
    await screen.findByTestId('reorganizations');
    fireEvent.click(document.querySelector('[data-action="open"]') as HTMLElement);
    const message = await screen.findByTestId('failed');
    expect(message.textContent).toBe(
      word('adm.reorg.timeline.failed')
        .replace('{step}', `reorg:${uuid(103)}:project:${uuid(77)}`)
        .replace('{code}', 'PROJECT_TRANSFER_UNAVAILABLE'),
    );
    fireEvent.click(document.querySelector('[data-action="decide"]') as HTMLElement);
    // After a failure the proposal can be approved again or cancelled, not sent back.
    expect(within(dialog()).queryByRole('option', { name: word('adm.reorg.decide.return') })).toBeNull();
    // A saga that moved part of the world is carried on, not abandoned: only approving again is offered.
    expect(within(dialog()).queryByRole('option', { name: word('adm.reorg.decide.reject') })).toBeNull();
    expect(within(dialog()).getByText(word('adm.reorg.decide.again'))).toBeTruthy();
    type('reorg-reason', 'Đã khắc phục liên kết với module dự án.');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.reorg.decide.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsCalled(h, 'decideUnitReorganization')).toEqual([expect.objectContaining({ path: { reorgId: uuid(103) }, body: { decision: 'approve', reason: 'Đã khắc phục liên kết với module dự án.', evidence_ids: [] }, ifMatchVersion: 2 })]);
  });

  it('decides a proposal that waits with a reason, at the version that was read, and says why when it is refused', async () => {
    let answer: unknown = problem('SELF_APPROVAL_DENIED', 403);
    const h = open({ rows: [reorganization(1)] }, { command: () => answer });
    await screen.findByTestId('reorganizations');
    fireEvent.click(document.querySelector('[data-action="decide"]') as HTMLElement);
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.reorg.decide.submit') }));
    expect(within(dialog()).getByText(word('adm.reorg.problem.reason'))).toBeTruthy();
    expect(commandsCalled(h, 'decideUnitReorganization')).toHaveLength(0);
    type('reorg-reason', 'Đúng nghị quyết của Ủy ban.');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.reorg.decide.submit') }));
    expect((await screen.findByTestId('refusal')).textContent).toBe(word('adm.reorg.error.self'));
    answer = { resource_id: uuid(101), resource_version: 3 };
    type('reorg-decision', 'return');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.reorg.decide.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsCalled(h, 'decideUnitReorganization')[1]).toMatchObject({ body: { decision: 'return' }, ifMatchVersion: 2 });
  });

  it('offers the decision only where the server says it may be taken, and nothing while read-only', async () => {
    open({ rows: [reorganization(1, { actions: { decide: false } })] });
    await screen.findByTestId('reorganizations');
    expect(document.querySelector('[data-action="decide"]')).toBeNull();
    cleanup();
    open({ rows: [reorganization(1)] }, { permissions: ['iam.unit.reorganize.read', 'iam.unit.reorganize'] });
    await screen.findByTestId('reorganizations');
    expect(document.querySelector('[data-action="decide"]')).toBeNull();
    expect(document.querySelector('[data-action="new"]')).not.toBeNull();
    cleanup();
    open({ rows: [reorganization(1)] }, { mode: 'READ_ONLY' });
    await screen.findByTestId('reorganizations');
    expect(document.querySelector('[data-action="new"], [data-action="decide"]')).toBeNull();
  });

  it('AC-ST-ADM-015-3: the wizard has four steps; it will not go on past a step that is not whole, shows what will move, and sends the proposal at the end', async () => {
    const h = open({ rows: [] }, { command: () => ({ resource_id: uuid(199), resource_version: 1 }) });
    await waitFor(() => expect(document.querySelector('[data-action="new"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-action="new"]') as HTMLElement);
    expect(Array.from(dialog().querySelectorAll('[data-wizard-step]')).map((item) => item.getAttribute('data-wizard-step'))).toEqual(['choose', 'map', 'preview', 'submit']);
    expect(dialog().querySelector('[aria-current="step"]')?.getAttribute('data-wizard-step')).toBe('choose');
    await waitFor(() => expect(document.querySelectorAll('[data-role="predecessor"]').length).toBe(4));
    // Step one is not whole: the wizard stays and says what is missing.
    next();
    for (const key of ['predecessors', 'successor', 'basis']) expect(within(dialog()).queryByText(word(`adm.reorg.problem.${key}`))).not.toBeNull();
    expect(dialog().querySelector('[aria-current="step"]')?.getAttribute('data-wizard-step')).toBe('choose');
    check('predecessor', uuid(1));
    check('predecessor', uuid(2));
    // A successor cannot be one of the old units: they are not offered as one.
    expect(document.querySelector(`[data-role="successor"][value="${uuid(1)}"]`)).toBeNull();
    check('successor', uuid(3));
    type('reorg-basis', 'NQ 12/NQ-UBND ngày 01/10/2026');
    type('reorg-date', '2026-11-15');
    next();
    expect(dialog().querySelector('[aria-current="step"]')?.getAttribute('data-wizard-step')).toBe('map');
    expect(within(dialog()).getByText(word('adm.reorg.map.sole'))).toBeTruthy();
    next();
    expect(dialog().querySelector('[aria-current="step"]')?.getAttribute('data-wizard-step')).toBe('preview');
    const preview = within(dialog()).getByTestId('preview');
    expect(preview.textContent).toContain('Đơn vị 1, Đơn vị 2');
    expect(preview.textContent).toContain('Đơn vị 3');
    // Two active members in the first unit and one in the second (the suspended one does not move).
    expect(within(dialog()).getByTestId('impact').textContent).toBe(word('adm.reorg.preview.members').replace('{count}', '3'));
    next();
    expect(dialog().querySelector('[aria-current="step"]')?.getAttribute('data-wizard-step')).toBe('submit');
    expect(commandsCalled(h, 'proposeUnitReorganization')).toHaveLength(0);
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.reorg.wizard.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsCalled(h, 'proposeUnitReorganization')).toEqual([
      expect.objectContaining({ body: { kind: 'MERGE', effective_from: '2026-11-15', legal_basis_ref: 'NQ 12/NQ-UBND ngày 01/10/2026', predecessor_unit_ids: [uuid(1), uuid(2)], successors: [{ existing_unit_id: uuid(3) }], mapping: {} } }),
    ]);
  });

  it('a split asks for the default successor in the mapping step; a rename can name a new unit; going back keeps what was chosen', async () => {
    const h = open({ rows: [] }, { command: () => ({ resource_id: uuid(199), resource_version: 1 }) });
    await waitFor(() => expect(document.querySelector('[data-action="new"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-action="new"]') as HTMLElement);
    await waitFor(() => expect(document.querySelectorAll('[data-role="predecessor"]').length).toBe(4));
    type('reorg-kind', 'SPLIT');
    check('predecessor', uuid(1));
    check('successor', uuid(2));
    check('successor', uuid(3));
    // A split has existing successors only.
    expect(document.querySelector('[data-role="new-unit"]')).toBeNull();
    type('reorg-basis', 'NQ 13/NQ-UBND ngày 01/10/2026');
    next();
    expect(within(dialog()).getByText(word('adm.reorg.map.several'))).toBeTruthy();
    next();
    expect(within(dialog()).getByText(word('adm.reorg.problem.default'))).toBeTruthy();
    expect(dialog().querySelector('[aria-current="step"]')?.getAttribute('data-wizard-step')).toBe('map');
    type('reorg-default', uuid(3));
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.reorg.wizard.back') }));
    expect((document.querySelector(`[data-role="successor"][value="${uuid(2)}"]`) as HTMLInputElement).checked).toBe(true);
    next();
    expect((document.getElementById('reorg-default') as HTMLSelectElement).value).toBe(uuid(3));
    next();
    next();
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.reorg.wizard.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsCalled(h, 'proposeUnitReorganization')[0]?.body).toMatchObject({ kind: 'SPLIT', successors: [{ existing_unit_id: uuid(2) }, { existing_unit_id: uuid(3) }], mapping: { default_successor_unit_id: uuid(3) } });
    cleanup();
    const renamed = open({ rows: [] }, { command: () => ({ resource_id: uuid(198), resource_version: 1 }) });
    await waitFor(() => expect(document.querySelector('[data-action="new"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-action="new"]') as HTMLElement);
    await waitFor(() => expect(document.querySelectorAll('[data-role="predecessor"]').length).toBe(4));
    type('reorg-kind', 'RENAME');
    check('predecessor', uuid(1));
    fireEvent.click(document.querySelector('[data-role="new-unit"]') as HTMLElement);
    type('reorg-new-code', 'SO-MOI');
    type('reorg-new-name', 'Sở Tài chính');
    type('reorg-new-parent', uuid(4));
    type('reorg-basis', 'NQ 14/NQ-UBND ngày 01/10/2026');
    next();
    next();
    next();
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.reorg.wizard.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsCalled(renamed, 'proposeUnitReorganization')[0]?.body).toMatchObject({ kind: 'RENAME', successors: [{ new_unit: { code: 'SO-MOI', name: 'Sở Tài chính', parent_id: uuid(4), unit_type: 'DEPARTMENT' } }] });
  });

  it('the date of the wizard starts as the Vietnam date, whatever the zone of the browser (just after midnight there it is still yesterday in UTC)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date('2026-11-20T18:30:00Z') });
    try {
      open({ rows: [] });
      await waitFor(() => expect(document.querySelector('[data-action="new"]')).not.toBeNull());
      fireEvent.click(document.querySelector('[data-action="new"]') as HTMLElement);
      expect((document.getElementById('reorg-date') as HTMLInputElement).value).toBe('2026-11-21');
    } finally {
      vi.useRealTimers();
    }
  });

  it('says in words why the server refused, how many members and projects have no successor, and keeps the wizard', async () => {
    let answer: unknown = problem('REORG_MAPPING_INCOMPLETE', 422, { missing_membership_ids: [uuid(601)], missing_project_ids: [uuid(701), uuid(702)] });
    const h = open({ rows: [] }, { command: () => answer });
    await waitFor(() => expect(document.querySelector('[data-action="new"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-action="new"]') as HTMLElement);
    await waitFor(() => expect(document.querySelectorAll('[data-role="predecessor"]').length).toBe(4));
    check('predecessor', uuid(1));
    check('predecessor', uuid(2));
    check('successor', uuid(3));
    type('reorg-basis', 'NQ 12/NQ-UBND ngày 01/10/2026');
    next();
    next();
    next();
    const send = (): void => {
      fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.reorg.wizard.submit') }));
    };
    send();
    expect((await screen.findByTestId('refusal')).textContent).toBe(word('adm.reorg.error.mapping'));
    expect(screen.getByTestId('missing').textContent).toBe(word('adm.reorg.missing').replace('{members}', '1').replace('{projects}', '2'));
    answer = problem('REORG_STATE_INVALID', 409, {}, 'predecessor_unit_ids');
    send();
    await waitFor(() => expect(screen.getByTestId('refusal').textContent).toBe(word('adm.reorg.error.busy')));
    answer = problem('UNIT_VALIDITY_INVALID', 422);
    send();
    await waitFor(() => expect(screen.getByTestId('refusal').textContent).toBe(word('adm.reorg.error.unit')));
    expect(commandsCalled(h, 'proposeUnitReorganization')).toHaveLength(3);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('reads the list again while a saga is being applied, so that it shows it done or stopped', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const h = open({ rows: [reorganization(1, { status: 'Applying' })] });
      await screen.findByTestId('reorganizations');
      const reads = () => (h.client.readAll as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((call) => call[0] === 'get_resources_unit_reorganization').length;
      const before = reads();
      h.world.rows = [reorganization(1, { status: 'Applied' })];
      await vi.advanceTimersByTimeAsync(WORKING_REFRESH_MS + 500);
      await waitFor(() => expect(reads()).toBeGreaterThan(before));
      await waitFor(() => expect(within(document.querySelector('[data-reorganization]') as HTMLElement).getByTestId('status').textContent).toBe(word('adm.reorg.status.applied')));
      // Once it is applied nothing is read again.
      const settled = reads();
      await vi.advanceTimersByTimeAsync(WORKING_REFRESH_MS * 3);
      expect(reads()).toBe(settled);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the states: nothing proposed yet, a read that failed with a way to read again, and no right to read', async () => {
    const empty = open({ rows: [] });
    await waitFor(() => expect(empty.client.readAll).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
    expect(screen.queryByTestId('reorganizations')).toBeNull();
    cleanup();
    const failing = open({ failing: true });
    const retry = await screen.findByRole('button', { name: /thử lại|retry/i });
    failing.world.failing = false;
    failing.world.rows = [reorganization(1)];
    fireEvent.click(retry);
    await screen.findByTestId('reorganizations');
    cleanup();
    const denied = open({ rows: [reorganization(1)] }, { permissions: [] });
    await waitFor(() => expect(screen.queryByTestId('reorganizations')).toBeNull());
    expect(denied.client.readAll).not.toHaveBeenCalled();
  });
});

describe('the model of the reorganisation screen', () => {
  const whole = (extra: Partial<Form> = {}): Form => ({ ...emptyForm('2026-11-15'), predecessorIds: [uuid(1), uuid(2)], successorIds: [uuid(3)], legalBasis: 'NQ 12/NQ-UBND', ...extra });

  it('finds what needs no server, kind by kind', () => {
    expect(formProblems(whole())).toEqual([]);
    expect(formProblems(emptyForm('2026-11-15'))).toEqual(['predecessorsRequired', 'successorRequired', 'basisShort']);
    expect(formProblems(whole({ predecessorIds: [uuid(1)] }))).toEqual(['mergeNeedsTwo']);
    expect(formProblems(whole({ kind: 'SPLIT', predecessorIds: [uuid(1), uuid(2)], successorIds: [uuid(3), uuid(4)], defaultSuccessorId: uuid(3) }))).toEqual(['onePredecessor']);
    expect(formProblems(whole({ kind: 'SPLIT', predecessorIds: [uuid(1)], successorIds: [uuid(3)], defaultSuccessorId: uuid(3) }))).toEqual(['splitNeedsTwo']);
    expect(formProblems(whole({ kind: 'SPLIT', predecessorIds: [uuid(1)], successorIds: [uuid(3), uuid(4)] }))).toEqual(['defaultRequired']);
    expect(formProblems(whole({ successorIds: [uuid(3), uuid(4)] }))).toEqual(['oneSuccessor']);
    expect(formProblems(whole({ successorIds: [uuid(1)] }))).toEqual(['successorIsPredecessor']);
    expect(formProblems(whole({ successorIds: [], newUnit: { code: '', name: 'X', parentId: uuid(4), unitType: 'DEPARTMENT' } }))).toEqual(['newUnitIncomplete']);
    expect(formProblems(whole({ effectiveFrom: 'soon' }))).toEqual(['dateInvalid']);
    expect(formProblems(whole({ legalBasis: 'NQ' }))).toEqual(['basisShort']);
    expect(problemsOfStep(whole({ kind: 'SPLIT', predecessorIds: [uuid(1)], successorIds: [uuid(3), uuid(4)] }), 'choose')).toEqual([]);
    expect(problemsOfStep(whole({ kind: 'SPLIT', predecessorIds: [uuid(1)], successorIds: [uuid(3), uuid(4)] }), 'map')).toEqual(['defaultRequired']);
  });

  it('offers only the unit types the contract creates a unit with', async () => {
    const contract = (await import('../../../../../../Design/MACHVON_Design/03_Engineering/openapi.json')) as unknown as { default: { components: { schemas: { OrgUnitCreate: { properties: { unit_type: { enum: string[] } } } } } } };
    expect([...UNIT_TYPES].sort()).toEqual([...contract.default.components.schemas.OrgUnitCreate.properties.unit_type.enum].sort());
  });

  it('builds the body the server takes', () => {
    expect(toBody(whole())).toEqual({ kind: 'MERGE', effective_from: '2026-11-15', legal_basis_ref: 'NQ 12/NQ-UBND', predecessor_unit_ids: [uuid(1), uuid(2)], successors: [{ existing_unit_id: uuid(3) }], mapping: {} });
    expect(toBody(whole({ kind: 'RENAME', predecessorIds: [uuid(1)], successorIds: [], newUnit: { code: ' N ', name: ' Tên ', parentId: uuid(4), unitType: 'COMMUNE' } })).successors).toEqual([
      { new_unit: { code: 'N', name: 'Tên', parent_id: uuid(4), unit_type: 'COMMUNE', valid_from: '2026-11-15' } },
    ]);
    expect(toBody(whole({ kind: 'SPLIT', defaultSuccessorId: uuid(3) })).mapping).toEqual({ default_successor_unit_id: uuid(3) });
    // A default that is left over (another kind, or a successor taken off) is not sent, and a split without a valid one is not whole.
    expect(toBody(whole({ kind: 'MERGE', defaultSuccessorId: uuid(3) })).mapping).toEqual({});
    expect(toBody(whole({ kind: 'SPLIT', successorIds: [uuid(4)], defaultSuccessorId: uuid(3) })).mapping).toEqual({});
    expect(formProblems(whole({ kind: 'SPLIT', predecessorIds: [uuid(1)], successorIds: [uuid(2), uuid(4)], defaultSuccessorId: uuid(3) }))).toEqual(['defaultRequired']);
  });

  it('reads a proposal and leaves out a row that is not one; names the steps of the saga and counts them in the order they are done', () => {
    expect(toReorganization(reorganization(1))).toMatchObject({ id: uuid(101), kind: 'MERGE', status: 'PendingApproval', version: 2, mayDecide: true, requestedByName: 'Lê Người Đề' });
    expect(toReorganization(reorganization(1, { status: 'Gone' }))).toBeUndefined();
    expect(toReorganization(null)).toBeUndefined();
    expect(toReorganization(reorganization(1, { result_summary: { failed: { step: 's', code: 'C' } } }))).toMatchObject({ failedStep: 's', failedCode: 'C' });
    expect(stepKind(`reorg:${uuid(1)}:membership:${uuid(2)}`)).toBe('membership');
    expect(stepKind('grant:x')).toBe('grant');
    expect(stepKind('finish')).toBe('other');
    expect(
      stepCounts([
        { key: 'retire:a', doneAt: '' },
        { key: 'membership:b', doneAt: '' },
        { key: 'membership:c', doneAt: '' },
        { key: 'create-successor:d', doneAt: '' },
      ]).map((entry) => [entry.kind, entry.count]),
    ).toEqual([
      ['create-successor', 1],
      ['membership', 2],
      ['retire', 1],
    ]);
  });

  it('goes on reading while the job works: a saga that is approved or applying is read again every few seconds, and one that is over or stopped is not', () => {
    expect(isWorking('Approved')).toBe(true);
    expect(isWorking('Applying')).toBe(true);
    for (const status of ['Draft', 'PendingApproval', 'Applied', 'Failed', 'Cancelled', undefined] as const) expect(isWorking(status)).toBe(false);
    expect(WORKING_REFRESH_MS).toBeGreaterThanOrEqual(1000);
  });

  it('offers the decisions a person can take: the proposer only withdraws, a saga that failed is only approved again, a proposal sent back is only withdrawn', () => {
    expect(decisionsFor({ status: 'PendingApproval', requestedById: 'a' }, 'b')).toEqual(['approve', 'return', 'reject']);
    expect(decisionsFor({ status: 'PendingApproval', requestedById: 'a' }, 'a')).toEqual(['reject']);
    expect(decisionsFor({ status: 'Failed', requestedById: 'a' }, 'b')).toEqual(['approve']);
    expect(decisionsFor({ status: 'Draft', requestedById: 'a' }, 'b')).toEqual(['reject']);
  });

  it('names each refusal, reads what is missing and has a word for every one', () => {
    const cases: Array<[ApiError, Problem]> = [
      [problem('REORG_MAPPING_INCOMPLETE'), 'mappingIncomplete'],
      [problem('VALIDATION_FAILED'), 'invalid'],
      [problem('UNIT_VALIDITY_INVALID'), 'unitInvalid'],
      [problem('REORG_STATE_INVALID', 409, {}, 'predecessor_unit_ids'), 'busy'],
      [problem('REORG_STATE_INVALID', 409), 'stateInvalid'],
      [problem('SELF_APPROVAL_DENIED', 403), 'selfApproval'],
      [problem('VERSION_CONFLICT', 409), 'versionConflict'],
      [problem('RESOURCE_NOT_FOUND', 404), 'notFound'],
      [problem('SCOPE_DENIED', 403), 'denied'],
      [problem('OTHER'), 'general'],
    ];
    for (const [error, expected] of cases) expect(describeProblem(error)).toBe(expected);
    expect(describeProblem(new Error('x'))).toBe('general');
    expect(readMissing(problem('REORG_MAPPING_INCOMPLETE', 422, { missing_membership_ids: ['a'], missing_project_ids: ['b', 'c', 3] }))).toEqual({ members: ['a'], projects: ['b', 'c'] });
    expect(readMissing(problem('OTHER', 422, { missing_project_ids: ['b'] }))).toEqual({ members: [], projects: [] });
    const t = ((key: string, values?: Record<string, unknown>) => word(key).replace(/\{(\w+)\}/g, (_m, name: string) => String(values?.[name] ?? ''))) as Parameters<typeof labels.problemMessage>[0];
    for (const kind of ['mappingIncomplete', 'invalid', 'unitInvalid', 'busy', 'selfApproval', 'stateInvalid', 'versionConflict', 'notFound', 'denied', 'general'] as const) expect(labels.problemMessage(t, kind)).not.toMatch(/^adm\.reorg\./);
    for (const kind of ['predecessorsRequired', 'mergeNeedsTwo', 'onePredecessor', 'successorRequired', 'oneSuccessor', 'splitNeedsTwo', 'successorIsPredecessor', 'newUnitIncomplete', 'dateInvalid', 'basisShort', 'defaultRequired'] as const)
      expect(labels.formProblemMessage(t, kind)).not.toMatch(/^adm\.reorg\./);
    for (const status of ['Draft', 'PendingApproval', 'Approved', 'Applying', 'Applied', 'Failed', 'Cancelled'] as const) expect(labels.statusLabel(t, status)).not.toMatch(/^adm\.reorg\./);
    for (const kind of ['create-successor', 'activate-successor', 'succession', 'membership', 'grant', 'project', 'retire', 'other'] as const) expect(labels.stepLabel(t, kind, 2)).not.toMatch(/^adm\.reorg\./);
    expect(labels.kindLabel(t, 'OTHER')).toBe('OTHER');
    expect(labels.statusTone('Applied')).toBe('green');
    expect(labels.statusTone('Failed')).toBe('red');
  });
});
