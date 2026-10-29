import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { mountInSession } from '../../doc/test-support';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import { routeOf } from '../../dgv/test-support';
import WorkflowScreen from './WorkflowScreen';
import * as labels from './labels';
import { BUSINESS_TYPES, commandsOf, describeProblem, diffDefinitions, emptyStep, fromDefinition, localProblems, readDefects, toDefinition, toVersion } from './model';

const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
const problem = (code: string, status = 422, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', retryAfterSeconds: undefined, detail: undefined, extensions });
const uuid = (n: number): string => `00000000-0000-4000-8000-${'0090'}${String(n).padStart(8, '0')}`;
const ROUTE = routeOf('ADM-06', 'FR-ADM-06');
const ALL = ['workflow_version.read', 'adm.workflow.manage', 'adm.workflow.publish'];

const step = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: `Bước ${id}`, assignee_rule: { type: 'DOA' }, min_approvals: 1, sla_working_hours: 16, on_timeout: 'REMIND', ...extra });
const definition = (steps: unknown[]) => ({ steps, terminal: { approved: 'acceptReport', returned: 'returnReport', rejected: 'rejectReport' } });
const version = (n: number, status: string, steps: unknown[], extra: Record<string, unknown> = {}) => ({
  id: uuid(n),
  business_type: 'report.accept',
  kind: 'APPROVAL',
  revision: n,
  status,
  definition: definition(steps),
  created_by: uuid(900),
  published_by: status === 'Draft' ? null : uuid(901),
  created_at: `2026-10-0${n}T01:00:00.000000Z`,
  published_at: status === 'Draft' ? null : `2026-10-0${n}T02:00:00.000000Z`,
  version: 1,
  ...extra,
});

interface World {
  pageSize?: number;
  versions: Array<Record<string, unknown>>;
  failing: Set<string>;
}

function open(state: Partial<World> = {}, options: { permissions?: readonly string[]; mode?: 'FULL' | 'READ_ONLY'; command?: (operation: string, input: unknown) => unknown } = {}): Harness & { world: World } {
  const world: World = { versions: [], failing: new Set(), ...state };
  const h = baseHarness((operation, input) => {
    if (world.failing.has(operation)) return new Error(`${operation} failed`);
    if (operation === 'get_resources_workflow_version') {
      const query = (input as { query?: Record<string, unknown> } | undefined)?.query ?? {};
      const all = world.versions.filter((item) => query.business_type === undefined || item.business_type === query.business_type);
      const from = query.cursor === undefined ? 0 : Number(query.cursor);
      const size = world.pageSize ?? all.length + 1;
      return { items: all.slice(from, from + size), next_cursor: from + size < all.length ? String(from + size) : null };
    }
    return new Error(`unexpected read ${operation}`);
  }, options.command);
  mountInSession(<WorkflowScreen route={ROUTE} />, h, { permissions: options.permissions ?? ALL, ...(options.mode === undefined ? {} : { mode: options.mode }) }, '/adm/adm-06');
  return { ...h, world };
}

const commandsCalled = (h: Harness, operation: string): Array<{ path?: Record<string, string>; body?: Record<string, unknown>; ifMatchVersion?: number }> =>
  h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { path?: Record<string, string>; body?: Record<string, unknown>; ifMatchVersion?: number });
const type = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const dialog = (): HTMLElement => screen.getByRole('dialog');

afterEach(() => cleanup());

describe('WorkflowScreen (ADM-06): the approval workflows', () => {
  it('UI-ADM-06: says which version is in force, lists the versions with their state, and shows the steps of the chosen one beside what changed from the one before', async () => {
    open({ versions: [version(3, 'Draft', [step('review'), step('chief', { allow_return_to: 'review' }), step('sign')]), version(2, 'Published', [step('review'), step('chief', { sla_working_hours: 8 })]), version(1, 'Superseded', [step('review')])] });
    await screen.findByTestId('versions');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('adm.workflow.title'));
    expect(screen.getByTestId('in-force').textContent).toBe(
      word('adm.workflow.inForce')
        .replace('{revision}', '2')
        .replace('{at}', screen.getByTestId('in-force').textContent?.split(' lúc ')[1]?.replace(/\.$/, '') ?? ''),
    );
    expect(Array.from(document.querySelectorAll('[data-version]')).map((row) => row.getAttribute('data-version'))).toEqual([uuid(3), uuid(2), uuid(1)]);
    const statuses = Array.from(document.querySelectorAll('[data-testid="status"]')).map((cell) => cell.textContent);
    expect(statuses).toEqual([word('adm.workflow.status.draft'), word('adm.workflow.status.published'), word('adm.workflow.status.superseded')]);
    // The first row is chosen: its steps, and what changed from revision 2.
    expect(Array.from(document.querySelectorAll('[data-step]')).map((item) => item.getAttribute('data-step'))).toEqual(['review', 'chief', 'sign']);
    const changes = Array.from(document.querySelectorAll('[data-change]')).map((item) => [item.getAttribute('data-change'), item.textContent]);
    expect(changes).toEqual([
      [
        'CHANGED',
        word('adm.workflow.diff.changed')
          .replace('{id}', 'chief')
          .replace('{fields}', `${word('adm.workflow.field.sla')}, ${word('adm.workflow.field.returnTo')}`),
      ],
      ['ADDED', word('adm.workflow.diff.added').replace('{id}', 'sign')],
    ]);
    // Opening the oldest revision: nothing to compare with.
    fireEvent.click(within(document.querySelector(`[data-version="${uuid(1)}"]`) as HTMLElement).getByRole('button', { name: word('adm.workflow.open.action') }));
    expect(screen.getByTestId('no-previous').textContent).toBe(word('adm.workflow.diff.first'));
    expect(screen.getByText(word('adm.workflow.footer.reference').replace('{id}', 'ADM-06').replace('{req}', 'FR-ADM-06'))).toBeTruthy();
  });

  it('reads every page of the versions, so that the one in force is found wherever it is and a new draft starts from it', async () => {
    open({ pageSize: 1, versions: [version(3, 'Draft', [step('review'), step('chief')]), version(2, 'Superseded', [step('review')]), version(1, 'Published', [step('legacy')])] });
    await screen.findByTestId('in-force');
    expect(screen.queryByTestId('not-configured')).toBeNull();
    expect(document.querySelectorAll('[data-version]')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: word('adm.workflow.new.action') }));
    expect((document.getElementById('step-0-id') as HTMLInputElement).value).toBe('legacy');
  });

  it('shows, for the one who only publishes, who receives the authority: the role and the unit, the named approvers and the one a late task is also given to', async () => {
    open(
      { versions: [version(1, 'Draft', [step('legal', { assignee_rule: { type: 'ROLE_IN_UNIT', role_code: 'LEGAL', unit_id: uuid(5) } }), step('chief', { assignee_rule: { type: 'SPECIFIC', membership_ids: [uuid(6), uuid(7)] }, on_timeout: 'ESCALATE', escalate_to: uuid(8) })])] },
      { permissions: ['workflow_version.read', 'adm.workflow.publish'] },
    );
    await screen.findByTestId('detail');
    expect(screen.getByTestId('operand-role').textContent).toContain(word('adm.workflow.summary.role').replace('{role}', 'LEGAL').replace('{unit}', uuid(5)));
    expect(screen.getByTestId('operand-members').textContent).toContain(`${uuid(6)}, ${uuid(7)}`);
    expect(screen.getByTestId('operand-escalate').textContent).toContain(uuid(8));
    expect(document.querySelector('[data-action="edit"]')).toBeNull();
    expect(document.querySelector('[data-action="publish"]')).not.toBeNull();
  });

  it('says that a business type has no workflow in force, and that it has no version at all', async () => {
    open({ versions: [version(1, 'Draft', [step('review')])] });
    expect((await screen.findByTestId('not-configured')).textContent).toBe(word('adm.workflow.notConfigured'));
    cleanup();
    open();
    expect((await screen.findByTestId('no-versions')).textContent).toBe(word('adm.workflow.versions.none'));
  });

  it('AC-ST-ADM-012-5: shows the invalid-definition message and the list of JSON paths when the server refuses a definition, and keeps the form', async () => {
    const defects = [
      { path: '$.steps[0].min_approvals', code: 'MIN_APPROVALS_INVALID', message: 'x' },
      { path: '$.steps[1].allow_return_to', code: 'RETURN_TARGET_INVALID', message: 'y' },
      { path: '$.terminal.approved', code: 'COMMAND_NOT_REGISTERED', message: 'z' },
    ];
    const h = open({ versions: [version(1, 'Published', [step('review')])] }, { command: () => problem('WORKFLOW_DEFINITION_INVALID', 422, { defects }) });
    await screen.findByTestId('versions');
    fireEvent.click(screen.getByRole('button', { name: word('adm.workflow.new.action') }));
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.workflow.builder.save') }));
    const list = await screen.findByTestId('defects');
    expect(within(list).getByText(word('adm.workflow.invalid.title'))).toBeTruthy();
    expect(Array.from(list.querySelectorAll('[data-path]')).map((item) => [item.getAttribute('data-path'), item.textContent])).toEqual([
      ['$.steps[0].min_approvals', `$.steps[0].min_approvals ${word('adm.workflow.defect.minApprovals')}`],
      ['$.steps[1].allow_return_to', `$.steps[1].allow_return_to ${word('adm.workflow.defect.returnTarget')}`],
      ['$.terminal.approved', `$.terminal.approved ${word('adm.workflow.defect.commandNotRegistered')}`],
    ]);
    expect(screen.getByTestId('refusal').textContent).toBe(word('adm.workflow.error.invalid'));
    // The step builder is still there with what was entered.
    expect((document.getElementById('step-0-id') as HTMLInputElement).value).toBe('review');
    expect(commandsCalled(h, 'createWorkflowDraft')).toHaveLength(1);
  });

  it('writes a new draft from the workflow in force, step by step, and sends the definition the form says', async () => {
    const h = open({ versions: [version(1, 'Published', [step('review')])] }, { command: () => ({ resource_id: uuid(2), resource_version: 1 }) });
    await screen.findByTestId('versions');
    fireEvent.click(screen.getByRole('button', { name: word('adm.workflow.new.action') }));
    // It starts from the one in force.
    expect((document.getElementById('step-0-id') as HTMLInputElement).value).toBe('review');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.workflow.builder.add') }));
    // A step that is not valid is not sent.
    type('step-1-id', 'Bad Id');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.workflow.builder.save') }));
    expect(within(dialog()).getByText(word('adm.workflow.problem.idInvalid'))).toBeTruthy();
    expect(within(dialog()).getByText(word('adm.workflow.problem.nameRequired'))).toBeTruthy();
    expect(commandsCalled(h, 'createWorkflowDraft')).toHaveLength(0);
    type('step-1-id', 'chief');
    type('step-1-name', 'Lãnh đạo duyệt');
    type('step-1-rule', 'SPECIFIC');
    type('step-1-members', `${uuid(11)}, ${uuid(12)}`);
    type('step-1-min', '2');
    type('step-1-sla', '24');
    type('step-1-timeout', 'ESCALATE');
    type('step-1-escalate', uuid(13));
    type('step-1-return', 'review');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.workflow.builder.save') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsCalled(h, 'createWorkflowDraft')).toEqual([
      {
        body: {
          business_type: 'report.accept',
          definition: {
            steps: [
              { id: 'review', name: 'Bước review', assignee_rule: { type: 'DOA' }, min_approvals: 1, sla_working_hours: 16, on_timeout: 'REMIND' },
              { id: 'chief', name: 'Lãnh đạo duyệt', assignee_rule: { type: 'SPECIFIC', membership_ids: [uuid(11), uuid(12)] }, min_approvals: 2, sla_working_hours: 24, on_timeout: 'ESCALATE', escalate_to: uuid(13), allow_return_to: 'review' },
            ],
            terminal: { approved: 'acceptReport', returned: 'returnReport', rejected: 'rejectReport' },
          },
        },
        attempt: expect.anything(),
      },
    ]);
  });

  it('edits a draft at the version that was read, removes a step, and tells the person when it changed meanwhile', async () => {
    let refusal: unknown = problem('VERSION_CONFLICT', 409);
    const h = open({ versions: [version(2, 'Draft', [step('review'), step('chief')], { version: 3 })] }, { command: () => refusal });
    await screen.findByTestId('versions');
    fireEvent.click(document.querySelector('[data-action="edit"]') as HTMLElement);
    expect(dialog().querySelectorAll('[data-step-form]')).toHaveLength(2);
    fireEvent.click(dialog().querySelectorAll('[data-action="remove-step"]')[1] as HTMLElement);
    expect(dialog().querySelectorAll('[data-step-form]')).toHaveLength(1);
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.workflow.builder.save') }));
    expect((await screen.findByTestId('refusal')).textContent).toBe(word('adm.workflow.error.versionConflict'));
    refusal = { resource_id: uuid(2), resource_version: 4 };
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.workflow.builder.save') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsCalled(h, 'updateWorkflowDraft').map((call) => [call.path, call.ifMatchVersion])).toEqual([
      [{ workflowVersionId: uuid(2) }, 3],
      [{ workflowVersionId: uuid(2) }, 3],
    ]);
  });

  it('publishes a draft with a reason, and says why when the author tries to publish their own', async () => {
    let refusal: unknown = problem('SELF_APPROVAL_DENIED', 403);
    const h = open({ versions: [version(2, 'Draft', [step('review')], { version: 5 })] }, { command: () => refusal });
    await screen.findByTestId('versions');
    fireEvent.click(document.querySelector('[data-action="publish"]') as HTMLElement);
    expect((document.getElementById('publish-reason') as HTMLTextAreaElement).value).toBe(word('adm.workflow.publish.reason.default'));
    type('publish-reason', 'short');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.workflow.publish.submit') }));
    expect(within(dialog()).getByText(word('adm.workflow.problem.reasonShort'))).toBeTruthy();
    expect(commandsCalled(h, 'publishWorkflowVersion')).toHaveLength(0);
    type('publish-reason', 'Công bố theo quy chế nội bộ mới.');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.workflow.publish.submit') }));
    expect((await screen.findByTestId('refusal')).textContent).toBe(word('adm.workflow.error.selfPublish'));
    refusal = { resource_id: uuid(2), resource_version: 6 };
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.workflow.publish.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsCalled(h, 'publishWorkflowVersion')[1]).toMatchObject({ path: { workflowVersionId: uuid(2) }, body: { reason: 'Công bố theo quy chế nội bộ mới.' }, ifMatchVersion: 5 });
  });

  it('offers what the person may do: no writing without the right to manage, no publishing without the right to publish, nothing while read-only, and a denied screen without the right to read', async () => {
    open({ versions: [version(2, 'Draft', [step('review')])] }, { permissions: ['workflow_version.read'] });
    await screen.findByTestId('versions');
    expect(screen.queryByRole('button', { name: word('adm.workflow.new.action') })).toBeNull();
    expect(document.querySelector('[data-action="edit"]')).toBeNull();
    expect(document.querySelector('[data-action="publish"]')).toBeNull();
    cleanup();
    open({ versions: [version(2, 'Draft', [step('review')])] }, { permissions: ['workflow_version.read', 'adm.workflow.manage'] });
    await screen.findByTestId('versions');
    expect(document.querySelector('[data-action="edit"]')).not.toBeNull();
    expect(document.querySelector('[data-action="publish"]')).toBeNull();
    cleanup();
    open({ versions: [version(2, 'Draft', [step('review')])] }, { mode: 'READ_ONLY' });
    await screen.findByTestId('versions');
    expect(document.querySelector('[data-action="edit"], [data-action="publish"], [data-action="new"]')).toBeNull();
    cleanup();
    const denied = open({}, { permissions: [] });
    await waitFor(() => expect(screen.queryByTestId('versions')).toBeNull());
    expect(denied.read).not.toHaveBeenCalled();
  });

  it('reads the versions of the business type chosen, and shows a read that failed with a way to read again', async () => {
    const h = open({ versions: [version(1, 'Published', [step('review')])] });
    await screen.findByTestId('versions');
    fireEvent.change(document.getElementById('workflow-type') as HTMLElement, { target: { value: 'payment.approve' } });
    expect((await screen.findByTestId('no-versions')).textContent).toBe(word('adm.workflow.versions.none'));
    expect((h.read.mock.calls.at(-1)?.[1] as { query: Record<string, unknown> }).query).toEqual({ business_type: 'payment.approve', limit: 200 });
    cleanup();
    const failing = open({ failing: new Set(['get_resources_workflow_version']) });
    const retry = await screen.findByRole('button', { name: /thử lại|retry/i });
    failing.world.failing.clear();
    fireEvent.click(retry);
    await screen.findByTestId('no-versions');
  });
});

describe('the model of the step builder', () => {
  it('turns the form into the definition the server validates and back, leaving out what a type does not use', () => {
    const steps = [
      { ...emptyStep(0), id: 'review', name: 'Rà soát' },
      { ...emptyStep(1), id: 'role', name: 'Vai trò', ruleType: 'ROLE_IN_UNIT' as const, roleCode: 'LEGAL', unitId: uuid(1), members: 'ignored' },
      { ...emptyStep(2), id: 'named', name: 'Người', ruleType: 'SPECIFIC' as const, members: `${uuid(2)};${uuid(3)}\n${uuid(4)}`, onTimeout: 'ESCALATE' as const, escalateTo: uuid(5), allowReturnTo: 'review' },
    ];
    const built = toDefinition('report.accept', steps);
    expect(built).toEqual({
      steps: [
        { id: 'review', name: 'Rà soát', assignee_rule: { type: 'DOA' }, min_approvals: 1, sla_working_hours: 16, on_timeout: 'REMIND' },
        { id: 'role', name: 'Vai trò', assignee_rule: { type: 'ROLE_IN_UNIT', role_code: 'LEGAL', unit_id: uuid(1) }, min_approvals: 1, sla_working_hours: 16, on_timeout: 'REMIND' },
        { id: 'named', name: 'Người', assignee_rule: { type: 'SPECIFIC', membership_ids: [uuid(2), uuid(3), uuid(4)] }, min_approvals: 1, sla_working_hours: 16, on_timeout: 'ESCALATE', escalate_to: uuid(5), allow_return_to: 'review' },
      ],
      terminal: { approved: 'acceptReport', returned: 'returnReport', rejected: 'rejectReport' },
    });
    const back = fromDefinition(built);
    expect(back.map((entry) => [entry.id, entry.ruleType, entry.roleCode, entry.members.split(', ').filter(Boolean).length, entry.allowReturnTo])).toEqual([
      ['review', 'DOA', '', 0, ''],
      ['role', 'ROLE_IN_UNIT', 'LEGAL', 0, ''],
      ['named', 'SPECIFIC', '', 3, 'review'],
    ]);
    expect(fromDefinition(null)).toEqual([]);
    expect(fromDefinition({ steps: [null, { id: 7, assignee_rule: { type: 'X' }, on_timeout: 'Y', min_approvals: 'a' }] }).map((entry) => [entry.ruleType, entry.onTimeout, entry.minApprovals])).toEqual([
      ['DOA', 'REMIND', '1'],
      ['DOA', 'REMIND', '1'],
    ]);
    expect(commandsOf('period.reopen')).toEqual({ approved: 'reopenPeriod', returned: 'returnPeriodReopen', rejected: 'rejectPeriodReopen' });
    expect(commandsOf('nothing')).toBeUndefined();
    expect(BUSINESS_TYPES.map((entry) => entry.code)).toHaveLength(5);
  });

  it('finds the problems that need no server: a malformed or repeated id, a missing name, a number that is not one', () => {
    const problems = localProblems([
      { ...emptyStep(0), id: 'ok', name: 'Tên' },
      { ...emptyStep(1), id: 'ok', name: 'x', minApprovals: 'two', slaHours: '1.5.2' },
      { ...emptyStep(2), id: 'A', name: 'Tên', slaHours: '12.5' },
    ]);
    expect(problems).toEqual([{}, { id: 'idDuplicate', name: 'nameRequired', minApprovals: 'numberInvalid', slaHours: 'numberInvalid' }, { id: 'idInvalid' }]);
  });

  it('reads the defects of a refused definition, and nothing from any other refusal', () => {
    expect(readDefects(problem('WORKFLOW_DEFINITION_INVALID', 422, { defects: [{ path: '$.steps', code: 'STEPS_REQUIRED' }, { path: 3 }, 'x'] }))).toEqual([{ path: '$.steps', code: 'STEPS_REQUIRED' }]);
    expect(readDefects(problem('WORKFLOW_DEFINITION_INVALID', 422, {}))).toEqual([]);
    expect(readDefects(problem('VERSION_CONFLICT', 409, { defects: [{ path: '$', code: 'X' }] }))).toEqual([]);
    expect(readDefects(new Error('x'))).toEqual([]);
  });

  it('compares two definitions by step id: added, removed and changed with the fields that differ', () => {
    const older = definition([step('a1'), step('b1', { min_approvals: 2 }), step('c1')]);
    const newer = definition([step('a1'), step('b1', { min_approvals: 3, name: 'Khác' }), step('d1', { assignee_rule: { type: 'SPECIFIC', membership_ids: [uuid(1)] } })]);
    expect(diffDefinitions(older, newer)).toEqual([
      { id: 'b1', kind: 'CHANGED', fields: ['name', 'minApprovals'] },
      { id: 'd1', kind: 'ADDED', fields: [] },
      { id: 'c1', kind: 'REMOVED', fields: [] },
    ]);
    expect(diffDefinitions(older, older)).toEqual([]);
    // Steps that kept their fields but changed places are a change of the approval.
    expect(diffDefinitions(definition([step('a1'), step('b1'), step('c1')]), definition([step('c1'), step('a1'), step('b1')]))).toEqual([
      { id: 'c1', kind: 'MOVED', fields: [] },
      { id: 'a1', kind: 'MOVED', fields: [] },
      { id: 'b1', kind: 'MOVED', fields: [] },
    ]);
    expect(diffDefinitions(definition([step('a1'), step('b1')]), definition([step('a1'), step('x1'), step('b1')]))).toEqual([{ id: 'x1', kind: 'ADDED', fields: [] }]);
    const reordered = definition([step('b1', { assignee_rule: { type: 'SPECIFIC', membership_ids: [uuid(2), uuid(1)] } })]);
    expect(diffDefinitions(reordered, definition([step('b1', { assignee_rule: { type: 'SPECIFIC', membership_ids: [uuid(1), uuid(2)] } })]))).toEqual([]);
  });

  it('reads a version and leaves out a row that is not one, names each refusal, and has a word for every one', () => {
    expect(toVersion(version(2, 'Published', [step('review')]))).toMatchObject({ revision: 2, status: 'Published', businessType: 'report.accept', publishedBy: uuid(901) });
    for (const broken of [null, {}, version(2, 'Archived', []), { ...version(2, 'Draft', []), revision: '2' }, { ...version(2, 'Draft', []), id: 7 }]) expect(toVersion(broken)).toBeUndefined();
    const cases: Array<[unknown, ReturnType<typeof describeProblem>]> = [
      [problem('WORKFLOW_DEFINITION_INVALID'), 'invalidDefinition'],
      [problem('VERSION_CONFLICT', 409), 'versionConflict'],
      [problem('WORKFLOW_NOT_DRAFT', 409), 'notDraft'],
      [problem('SELF_APPROVAL_DENIED', 403), 'selfPublish'],
      [problem('SCOPE_DENIED', 403), 'denied'],
      [problem('RESOURCE_NOT_FOUND', 404), 'notFound'],
      [problem('VALIDATION_FAILED'), 'validation'],
      [problem('OTHER', 500), 'general'],
      [new Error('network'), 'general'],
    ];
    for (const [error, expected] of cases) expect(describeProblem(error)).toBe(expected);
    const t = ((key: string, values?: Record<string, unknown>) => Object.entries(values ?? {}).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), word(key))) as Parameters<typeof labels.problemMessage>[0];
    const codes = [
      'NOT_AN_OBJECT',
      'UNKNOWN_FIELD',
      'BUSINESS_TYPE_UNKNOWN',
      'STEPS_REQUIRED',
      'TOO_MANY_STEPS',
      'STEP_ID_INVALID',
      'STEP_ID_DUPLICATE',
      'STEP_NAME_INVALID',
      'ASSIGNEE_RULE_REQUIRED',
      'ASSIGNEE_TYPE_INVALID',
      'ROLE_CODE_REQUIRED',
      'UNIT_REQUIRED',
      'MEMBERS_REQUIRED',
      'MEMBERS_DUPLICATE',
      'DOA_TAKES_NO_OPERANDS',
      'UNEXPECTED_OPERAND',
      'MIN_APPROVALS_INVALID',
      'MIN_APPROVALS_EXCEEDS_APPROVERS',
      'SLA_INVALID',
      'ON_TIMEOUT_INVALID',
      'ESCALATE_TO_REQUIRED',
      'RETURN_TARGET_INVALID',
      'TERMINAL_REQUIRED',
      'COMMAND_REQUIRED',
      'COMMAND_NOT_REGISTERED',
    ];
    for (const code of codes) expect([code, labels.defectLabel(t, code).startsWith('adm.')]).toEqual([code, false]);
    expect(labels.defectLabel(t, 'SOMETHING_NEW')).toBe('SOMETHING_NEW');
    for (const status of ['Draft', 'Published', 'Superseded', 'Retired'] as const) expect(labels.statusLabel(t, status).startsWith('adm.')).toBe(false);
    expect(['Draft', 'Published', 'Superseded', 'Retired'].map((status) => labels.statusTone(status as 'Draft'))).toEqual(['warn', 'green', 'gray', 'gray']);
    expect([...BUSINESS_TYPES.map((entry) => entry.code), 'nothing'].map((code) => labels.businessTypeLabel(t, code))).toHaveLength(6);
    expect(['DOA', 'ROLE_IN_UNIT', 'SPECIFIC', 'OTHER'].map((entry) => labels.ruleTypeLabel(t, entry))[3]).toBe('OTHER');
    expect(['REMIND', 'ESCALATE', 'EXPIRE', 'OTHER'].map((entry) => labels.timeoutLabel(t, entry))[3]).toBe('OTHER');
    expect(['name', 'assignee', 'minApprovals', 'slaHours', 'onTimeout', 'allowReturnTo', 'other'].map((field) => labels.fieldLabel(t, field)).every((text) => !text.startsWith('adm.'))).toBe(true);
    for (const name of ['idInvalid', 'idDuplicate', 'nameRequired', 'numberInvalid'] as const) expect(labels.stepProblemMessage(t, name).startsWith('adm.')).toBe(false);
    for (const name of ['invalidDefinition', 'versionConflict', 'notDraft', 'selfPublish', 'denied', 'notFound', 'validation', 'general'] as const) expect(labels.problemMessage(t, name).startsWith('adm.')).toBe(false);
  });
});
