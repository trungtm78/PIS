import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { harness, mount } from '../../sas/test-support';
import { LinkPanel } from './LinkPanel';
import { describeLinkRefusal, emptyLink, linkBody, linkProblem } from './link-model';
import type { Conversation } from './model';

const CONVERSATION = '00000000-0000-4000-8000-0000000000a1';
const PROJECT = '00000000-0000-4000-8000-0000000000b1';
const CONTRACT = '00000000-0000-4000-8000-0000000000c1';
const conversation = { id: CONVERSATION, version: 4 } as unknown as Conversation;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const problem = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });

function client(command: (operation: string, input: unknown) => unknown = () => ({}), projects: unknown[] | Error = [{ id: PROJECT, code: 'DA1', name: 'Project one' }]) {
  const h = harness(() => ({}), command);
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => (projects instanceof Error ? Promise.reject(projects) : Promise.resolve(projects)));
  return h;
}

describe('the model of the link', () => {
  it('wants the record, as an identifier', () => {
    expect(linkProblem(emptyLink)).toBe('required');
    expect(linkProblem({ kind: 'issue', resourceId: 'nope' })).toBe('uuid');
    expect(linkProblem({ kind: 'issue', resourceId: PROJECT })).toBeUndefined();
    expect(linkBody({ kind: 'contract', resourceId: ` ${CONTRACT.toUpperCase()} ` })).toEqual({ resource_type: 'contract', resource_id: CONTRACT });
  });

  it('names each refusal', () => {
    expect(describeLinkRefusal(problem(403, 'SCOPE_DENIED'))).toBe('scope');
    expect(describeLinkRefusal(problem(409, 'CONVERSATION_STATE_INVALID'))).toBe('conversationState');
    expect(describeLinkRefusal(problem(409, 'VERSION_CONFLICT'))).toBe('conflict');
    expect(describeLinkRefusal(problem(422, 'VALIDATION_FAILED'))).toBe('validation');
    expect(describeLinkRefusal(new Error('x'))).toBe('general');
  });
});

describe('OMNI-02 tying a conversation to a record (linkConversationResource)', () => {
  const open = (): void => {
    fireEvent.click(document.querySelector('[data-link-open]') as HTMLButtonElement);
  };

  it('sends the chosen project under the version of the conversation, and says it was tied', async () => {
    const h = client(() => ({ operation_id: 'o', status: 'OPEN', resource_version: 5, resource_id: CONVERSATION }));
    const onDone = vi.fn();
    mount(<LinkPanel conversation={conversation} onDone={onDone} />, h, ['omni.conversation.reply']);
    open();
    await waitFor(() => expect((document.getElementById('link-resource') as HTMLSelectElement).options.length).toBe(2));
    fireEvent.change(document.getElementById('link-resource') as HTMLSelectElement, { target: { value: PROJECT } });
    fireEvent.submit(document.querySelector('[data-link-form]') as HTMLFormElement);
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('linkConversationResource', expect.objectContaining({ path: { conversationId: CONVERSATION }, ifMatchVersion: 4, body: { resource_type: 'project', resource_id: PROJECT } })));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('names a contract by its identifier, and refuses an empty or malformed one before sending', async () => {
    const h = client();
    mount(<LinkPanel conversation={conversation} onDone={() => undefined} />, h, ['omni.conversation.reply']);
    open();
    fireEvent.change(document.getElementById('link-kind') as HTMLSelectElement, { target: { value: 'contract' } });
    fireEvent.submit(document.querySelector('[data-link-form]') as HTMLFormElement);
    expect(document.querySelector('[data-link-field-problem]')).not.toBeNull();
    fireEvent.change(document.getElementById('link-resource') as HTMLInputElement, { target: { value: 'nope' } });
    fireEvent.submit(document.querySelector('[data-link-form]') as HTMLFormElement);
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(document.getElementById('link-resource') as HTMLInputElement, { target: { value: CONTRACT } });
    fireEvent.submit(document.querySelector('[data-link-form]') as HTMLFormElement);
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('linkConversationResource', expect.objectContaining({ body: { resource_type: 'contract', resource_id: CONTRACT } })));
  });

  it('tells a record outside the scope, and keeps the form', async () => {
    const h = client(() => problem(403, 'SCOPE_DENIED'));
    mount(<LinkPanel conversation={conversation} onDone={() => undefined} />, h, ['omni.conversation.reply']);
    open();
    fireEvent.change(document.getElementById('link-kind') as HTMLSelectElement, { target: { value: 'issue' } });
    fireEvent.change(document.getElementById('link-resource') as HTMLInputElement, { target: { value: CONTRACT } });
    fireEvent.submit(document.querySelector('[data-link-form]') as HTMLFormElement);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(document.querySelector('[data-link-problem]')).not.toBeNull();
    expect((document.getElementById('link-resource') as HTMLInputElement).value).toBe(CONTRACT);
  });

  it('falls back to the identifier when the projects cannot be listed', async () => {
    mount(<LinkPanel conversation={conversation} onDone={() => undefined} />, client(() => ({}), new Error('down')), ['omni.conversation.reply']);
    open();
    expect(await screen.findByText(/./, { selector: '[data-link-lookup-error]' })).toBeTruthy();
    expect(document.getElementById('link-resource')?.tagName).toBe('INPUT');
  });
});
