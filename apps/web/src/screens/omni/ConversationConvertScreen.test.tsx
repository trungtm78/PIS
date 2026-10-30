import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { harness, mount, routeOf } from '../not/delivery/test-support';
import ConversationConvertScreen from './ConversationConvertScreen';
import { conversionBody, describeProblem, draftProblems, emptyDraft, mayConvert, toConvertible, toOptions } from './conversion/model';

const AGENT = ['conversation.read', 'omni.conversation.convert'];
const NO_CONVERT = ['conversation.read', 'omni.conversation.reply'];
const NOBODY = ['notification.self'];
const problem = (code: string, status = 422) => new ApiError({ status, code, correlationId: 'c' });
const ISSUE = 'issue-1';

const conversation = (overrides: Record<string, unknown> = {}) => ({
  id: 'conversation-1',
  channel_account_id: 'account-1',
  channel: 'ZALO_OA',
  account_name: 'Zalo OA hỗ trợ',
  contact_id: 'contact-1',
  contact_name: 'Lê Thị Hoa',
  status: 'InProgress',
  priority: 'NORMAL',
  assignee_membership_id: 'member-1',
  assignee_name: 'An',
  queue_unit_id: null,
  queue_unit_name: null,
  last_inbound_at: '2026-10-30T03:00:00Z',
  window_expires_at: null,
  sla_first_response_due_at: null,
  sla_resolution_due_at: null,
  message_count: 3,
  resource_links: [],
  assigned_at: null,
  created_at: '2026-10-30T03:00:00Z',
  version: 4,
  ...overrides,
});
const options = () => ({
  projects: [
    { id: 'project-1', code: 'P-01', name: 'Cầu Nà Hang' },
    { id: 'project-2', code: 'P-02', name: 'Đường Bắc Kạn' },
  ],
  issue_types: [
    { code: 'LAND', label: 'Giải phóng mặt bằng' },
    { code: 'ROAD', label: 'Hư hỏng đường' },
  ],
  as_of: '2026-10-30T03:00:00Z',
});
const linked = { resource_type: 'issue', resource_id: ISSUE, linked_at: '2026-10-30T04:00:00Z', converted: true };
const byHand = { ...linked, converted: false };

afterEach(cleanup);

interface Answers {
  conversation?: () => unknown;
  options?: () => unknown;
  command?: (operation: string, input: unknown) => unknown;
  entry?: string;
  mode?: 'READ_ONLY';
}

function open(permissions: readonly string[] | undefined, answers: Answers = {}) {
  const h = harness((operation) => {
    if (operation === 'get_resources_conversation_id') return (answers.conversation ?? (() => conversation()))();
    if (operation === 'getConversionOptions') return (answers.options ?? options)();
    return new Error(`unexpected read ${operation}`);
  }, answers.command ?? (() => ({})));
  return { h, ...mount(<ConversationConvertScreen route={routeOf('OMNI-09', 'FR-OMNI-09')} />, h, { permissions, ...(answers.mode === undefined ? {} : { mode: answers.mode }), entry: answers.entry ?? '/omni/omni-09?id=conversation-1' }) };
}
const form = async (): Promise<HTMLElement> =>
  (await waitFor(() => {
    const found = document.querySelector('[data-convert-form]') as HTMLElement | null;
    if (found === null) throw new Error('not yet');
    return found;
  })) as HTMLElement;
const fill = (root: HTMLElement, project: string, type: string, summary: string): void => {
  fireEvent.change(within(root).getByLabelText(vi_['omni.convert.project.label']), { target: { value: project } });
  fireEvent.change(within(root).getByLabelText(vi_['omni.convert.type.label']), { target: { value: type } });
  fireEvent.change(within(root).getByLabelText(vi_['omni.convert.summary.label'].replace('{max}', '500')), { target: { value: summary } });
};

describe('OMNI-09 turn a conversation into an issue (UI-OMNI-09)', () => {
  it('AC-ST-OMNI-007-1 UI-OMNI-09: offers only the projects and the issue types of the options, and says that only a summary and a link go into the issue', async () => {
    const { h } = open(AGENT);
    const root = await form();
    expect(document.querySelector('[data-privacy-notice]')?.textContent).toBe(vi_['omni.convert.privacy.notice']);
    expect(screen.getByRole('heading', { level: 2, name: 'Lê Thị Hoa' })).toBeTruthy();
    const project = within(root).getByLabelText(vi_['omni.convert.project.label']) as HTMLSelectElement;
    expect([...project.options].map((option) => option.textContent)).toEqual([vi_['omni.convert.project.choose'], 'P-01 · Cầu Nà Hang', 'P-02 · Đường Bắc Kạn']);
    const type = within(root).getByLabelText(vi_['omni.convert.type.label']) as HTMLSelectElement;
    expect([...type.options].map((option) => option.textContent)).toEqual([vi_['omni.convert.type.choose'], 'Giải phóng mặt bằng', 'Hư hỏng đường']);
    expect(h.read.mock.calls.find((call) => call[0] === 'getConversionOptions')).toEqual(['getConversionOptions', {}]);
    expect(h.read.mock.calls.find((call) => call[0] === 'get_resources_conversation_id')).toEqual(['get_resources_conversation_id', { path: { id: 'conversation-1' } }]);
    expect(screen.getByRole('link', { name: vi_['omni.convert.back.action'] }).getAttribute('href')).toBe('/omni/omni-02?id=conversation-1');
  });

  it('AC-ST-OMNI-007-1 UI-OMNI-09: sends the project, the type and the trimmed summary with the version read, then shows where the conversation went', async () => {
    let converted = false;
    const { h } = open(AGENT, {
      conversation: () => conversation(converted ? { version: 5, resource_links: [linked] } : {}),
      command: () => {
        converted = true;
        return { operation_id: 'o', status: 'CONVERTED', resource_version: 5, resource_id: ISSUE };
      },
    });
    const root = await form();
    fill(root, 'project-1', 'LAND', '  Người dân báo sụt lún trước cổng  ');
    fireEvent.submit(root);
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toEqual(['convertConversationToIssue', expect.objectContaining({ path: { conversationId: 'conversation-1' }, body: { project_id: 'project-1', issue_type: 'LAND', summary: 'Người dân báo sụt lún trước cổng' }, ifMatchVersion: 4 })]);
    const notice = await waitFor(() => {
      const found = document.querySelector('[data-converted]') as HTMLElement | null;
      if (found === null) throw new Error('not yet');
      return found;
    });
    expect(within(notice).getByRole('link', { name: vi_['omni.convert.issue.open.action'] }).getAttribute('href')).toBe(`/iss/iss-03?id=${ISSUE}`);
    expect(document.querySelector('[data-convert-form]')).toBeNull();
  });

  it('refuses an empty form before sending: a project, a type and a summary of up to 500 characters are named, and nothing is sent', async () => {
    const { h } = open(AGENT);
    const root = await form();
    fireEvent.submit(root);
    expect(await within(root).findByText(vi_['omni.convert.project.invalid'])).toBeTruthy();
    expect(within(root).getByText(vi_['omni.convert.type.invalid'])).toBeTruthy();
    expect(within(root).getByText(vi_['omni.convert.summary.invalid'].replace('{max}', '500'))).toBeTruthy();
    fill(root, 'project-2', 'ROAD', 'x'.repeat(501));
    fireEvent.submit(root);
    expect(await within(root).findByText(vi_['omni.convert.summary.invalid'].replace('{max}', '500'))).toBeTruthy();
    expect(within(root).queryByText(vi_['omni.convert.project.invalid'])).toBeNull();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('says in words why the server refused: invalid, closed, already converted, conflict, denied, not found, refused by the issue module, session, general', async () => {
    for (const [code, key] of [
      ['VALIDATION_FAILED', 'omni.convert.problem.invalid'],
      ['CONVERSATION_STATE_INVALID', 'omni.convert.problem.state'],
      ['CONVERSATION_ALREADY_CONVERTED', 'omni.convert.problem.already'],
      ['VERSION_CONFLICT', 'omni.convert.problem.conflict'],
      ['SCOPE_DENIED', 'omni.convert.problem.denied'],
      ['RESOURCE_NOT_FOUND', 'omni.convert.problem.notFound'],
      ['ISSUE_COMMAND_REJECTED', 'omni.convert.problem.rejected'],
      ['SESSION_EXPIRED', 'omni.convert.problem.session'],
      ['INTERNAL_ERROR', 'omni.convert.problem.general'],
    ] as const) {
      open(AGENT, { command: () => problem(code, code === 'INTERNAL_ERROR' ? 500 : 422) });
      const root = await form();
      fill(root, 'project-1', 'LAND', 'Tóm tắt');
      fireEvent.submit(root);
      expect((await within(root).findByRole('alert')).textContent).toBe((vi_ as Record<string, string>)[key]);
      cleanup();
    }
  });

  it('shows where a conversation went when it was converted already, and takes no second conversion', async () => {
    open(AGENT, { conversation: () => conversation({ resource_links: [{ resource_type: 'project', resource_id: 'project-1', linked_at: 'x' }, linked] }) });
    const notice = await waitFor(() => {
      const found = document.querySelector('[data-converted]') as HTMLElement | null;
      if (found === null) throw new Error('not yet');
      return found;
    });
    expect(notice.textContent).toContain(vi_['omni.convert.converted.notice']);
    expect(document.querySelector('[data-convert-form]')).toBeNull();
  });

  it('shows the form for a conversation whose issue was linked by hand: it is a record the conversation is about, not the result of a conversion', async () => {
    open(AGENT, { conversation: () => conversation({ resource_links: [byHand] }) });
    await form();
    expect(document.querySelector('[data-converted]')).toBeNull();
  });

  it('shows the conversation and no form while the tenant is suspended (read-only), whatever the grants say', async () => {
    const { h } = open(AGENT, { mode: 'READ_ONLY' });
    expect((await screen.findByText(vi_['omni.convert.frozen.notice'])).closest('[data-frozen]')).not.toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Lê Thị Hoa' })).toBeTruthy();
    expect(document.querySelector('[data-convert-form]')).toBeNull();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('says a closed conversation cannot be converted and shows no form', async () => {
    open(AGENT, { conversation: () => conversation({ status: 'Closed' }) });
    expect((await screen.findByText(vi_['omni.convert.closed.notice'])).closest('[data-closed]')).not.toBeNull();
    expect(document.querySelector('[data-convert-form]')).toBeNull();
  });

  it('says so, and keeps the button off, when there is no project in the scope or no issue type', async () => {
    open(AGENT, { options: () => ({ ...options(), projects: [] }) });
    const root = await form();
    expect(within(root).getByText(vi_['omni.convert.options.none'])).toBeTruthy();
    expect((within(root).getByRole('button', { name: vi_['omni.convert.submit.action'] }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    open(AGENT, { options: () => ({ ...options(), issue_types: [] }) });
    expect((within(await form()).getByRole('button', { name: vi_['omni.convert.submit.action'] }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the seven states: loading, denied, signed out, offline, error, empty (no conversation named) and not found', async () => {
    const loading = open(AGENT);
    expect(loading.container.querySelector('[role="status"]')).not.toBeNull();
    cleanup();
    for (const [error, title] of [
      [new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }), vi_['states.denied.title']],
      [new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), vi_['states.signedOut.title']],
      [new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      [new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), vi_['states.error.title']],
    ] as const) {
      open(AGENT, { conversation: () => error });
      expect(await screen.findByText(title)).toBeTruthy();
      cleanup();
    }
    // One who may not convert is not shown the form, and nothing is read for them.
    for (const permissions of [NO_CONVERT, NOBODY]) {
      const { h } = open(permissions);
      expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
      expect(h.read).not.toHaveBeenCalled();
      cleanup();
    }
    const none = open(AGENT, { entry: '/omni/omni-09' });
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    expect(screen.getByRole('link', { name: vi_['omni.convert.back.inbox'] }).getAttribute('href')).toBe('/omni/omni-01');
    expect(none.h.read).not.toHaveBeenCalled();
    cleanup();
    open(AGENT, { conversation: () => ({ id: 3 }) });
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
  });

  it('keeps the form and what was typed when the refresh that follows a failed command cannot reach the server, and takes it away when the conversation is refused', async () => {
    for (const [reading, expected] of [
      [new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), 'kept'],
      [new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c' }), 'gone'],
    ] as const) {
      let calls = 0;
      const { h } = open(AGENT, {
        conversation: () => {
          calls += 1;
          return calls === 1 ? conversation() : reading;
        },
        command: () => problem('INTERNAL_ERROR', 500),
      });
      const root = await form();
      fill(root, 'project-1', 'LAND', 'Tóm tắt');
      fireEvent.submit(root);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(calls).toBeGreaterThan(1));
      if (expected === 'kept') {
        expect((await within(root).findByRole('alert')).textContent).toBe(vi_['omni.convert.problem.general']);
        expect((within(root).getByLabelText(vi_['omni.convert.summary.label'].replace('{max}', '500')) as HTMLTextAreaElement).value).toBe('Tóm tắt');
      } else {
        await waitFor(() => expect(document.querySelector('[data-convert-form]')).toBeNull());
      }
      cleanup();
    }
  });

  describe('the rules of the form', () => {
    it('reads the options of the server, and ignores what is not a project or a type', () => {
      expect(toOptions(options())).toEqual({
        projects: [
          { id: 'project-1', code: 'P-01', name: 'Cầu Nà Hang' },
          { id: 'project-2', code: 'P-02', name: 'Đường Bắc Kạn' },
        ],
        issueTypes: [
          { code: 'LAND', label: 'Giải phóng mặt bằng' },
          { code: 'ROAD', label: 'Hư hỏng đường' },
        ],
      });
      expect(toOptions({ projects: [{ id: 3 }, null], issue_types: [{ code: '' }, { code: 'X' }] })).toEqual({ projects: [], issueTypes: [{ code: 'X', label: 'X' }] });
      expect(toOptions(null)).toEqual({ projects: [], issueTypes: [] });
    });

    it('finds the issue a conversation became among its links', () => {
      expect(toConvertible(conversation())?.issueId).toBeUndefined();
      expect(toConvertible(conversation({ resource_links: [linked] }))?.issueId).toBe(ISSUE);
      expect(toConvertible(conversation({ resource_links: [byHand] }))?.issueId).toBeUndefined();
      expect(toConvertible(conversation({ resource_links: 'x' }))?.issueId).toBeUndefined();
      expect(toConvertible({ id: 'c' })).toBeUndefined();
    });

    it('turns an open conversation that is not an issue yet, and nothing else', () => {
      expect(mayConvert({ status: 'InProgress', issueId: undefined })).toBe(true);
      expect(mayConvert({ status: 'Resolved', issueId: undefined })).toBe(true);
      expect(mayConvert({ status: 'Closed', issueId: undefined })).toBe(false);
      expect(mayConvert({ status: 'InProgress', issueId: ISSUE })).toBe(false);
    });

    it('names what is missing from the form, and builds the body without the spaces around the summary', () => {
      expect(draftProblems(emptyDraft())).toEqual(['projectId', 'issueType', 'summary']);
      expect(draftProblems({ projectId: 'p', issueType: 'T', summary: 'x'.repeat(500) })).toEqual([]);
      expect(draftProblems({ projectId: 'p', issueType: 'T', summary: ` ${'x'.repeat(500)} ` })).toEqual([]);
      expect(draftProblems({ projectId: 'p', issueType: 'T', summary: 'x'.repeat(501) })).toEqual(['summary']);
      expect(conversionBody({ projectId: 'p', issueType: 'T', summary: ' s ' })).toEqual({ project_id: 'p', issue_type: 'T', summary: 's' });
    });

    it('does not take a failure that is not the server\'s for one of its refusals', () => {
      expect(describeProblem(new Error('x')).reason).toBe('general');
      expect(describeProblem(problem('SOMETHING_NEW')).reason).toBe('general');
    });
  });
});
