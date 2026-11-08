import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { translator } from '../../../i18n';
import LeadsScreen from './LeadsScreen';
import { hasTraceFact, traceBody } from './trace-dialog';
import { AUDITOR, client, investigationFigures, leadLine, leadPage, mount, routeOf, uuid } from './test/investigation-fixtures';
import type { World } from './test/investigation-fixtures';
import { problem, word } from './test/helpers';

const route = routeOf('VND-13', 'FR-VND-13');
const PROPOSAL = uuid('0500', 1);
const VERSION = uuid('0009', 1);
const WRITER = [...AUDITOR, 'vnd.trace.write'];

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
});

function open(permissions: string[], command?: (operation: string, input: unknown) => unknown, mode?: 'FULL' | 'READ_ONLY') {
  const world: World = { answers: { listVendorLeads: leadPage([leadLine(1)]), getVendorInvestigationFigures: investigationFigures() } };
  const h = client(world, command);
  mount(<LeadsScreen route={route} />, h, { permissions, path: '/vnd/vnd-13', ...(mode === undefined ? {} : { mode }) });
  return h;
}

const dialog = (): HTMLElement => screen.getByRole('dialog', { name: word('lookahead.vnd.trace.title') });
const type = (label: string, value: string): void => {
  fireEvent.change(within(dialog()).getByLabelText(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))), { target: { value } });
};
const confirm = (): HTMLButtonElement => within(dialog()).getByRole('button', { name: word('lookahead.vnd.trace.confirm') }) as HTMLButtonElement;

describe('LeadsScreen (VND-13): recording the submission trace of a proposal', () => {
  it('offers the action only to a person who holds the right and is not in a read-only workspace', async () => {
    open(AUDITOR);
    await screen.findByTestId('run-scan');
    expect(screen.queryByTestId('record-trace')).toBeNull();
    cleanup();
    open(WRITER, undefined, 'READ_ONLY');
    await waitFor(() => expect(document.querySelector('tr[data-lead-id]')).toBeTruthy());
    expect(screen.queryByTestId('record-trace')).toBeNull();
    cleanup();
    open(WRITER);
    expect(await screen.findByTestId('record-trace')).toBeTruthy();
  });

  it('asks for the proposal and at least one fact, and sends nothing until both are given', async () => {
    const h = open(WRITER);
    fireEvent.click(await screen.findByTestId('record-trace'));
    expect(dialog().textContent).toContain(word('lookahead.vnd.trace.note'));
    expect(confirm().disabled).toBe(true);
    type(word('lookahead.vnd.trace.proposal.label'), 'not-an-identifier');
    type(word('lookahead.vnd.trace.origin.label'), '10.1.2.3');
    expect(confirm().disabled).toBe(true);
    type(word('lookahead.vnd.trace.proposal.label'), PROPOSAL);
    expect(confirm().disabled).toBe(false);
    type(word('lookahead.vnd.trace.origin.label'), '');
    expect(confirm().disabled).toBe(true);
    expect(h.command).not.toHaveBeenCalled();
  });

  it('sends the typed facts and the files once under the proposal, then says it was recorded', async () => {
    const h = open(WRITER, () => ({ operation_id: 'o', status: 'RECORDED', resource_version: 1, resource_id: uuid('0600', 1) }));
    fireEvent.click(await screen.findByTestId('record-trace'));
    type(word('lookahead.vnd.trace.proposal.label'), ` ${PROPOSAL} `);
    type(word('lookahead.vnd.trace.origin.label'), ' 10.1.2.3 ');
    type(word('lookahead.vnd.trace.device.label'), 'Laptop A');
    type(word('lookahead.vnd.trace.submittedAt.label'), '2026-11-05');
    fireEvent.click(screen.getByTestId('trace-add-file'));
    expect(confirm().disabled).toBe(true);
    fireEvent.change(screen.getByTestId('trace-file-version-1'), { target: { value: VERSION } });
    fireEvent.change(within(screen.getByTestId('trace-file-1')).getByLabelText(word('lookahead.vnd.trace.file.author')), { target: { value: 'Nguyen Van A' } });
    expect(confirm().disabled).toBe(false);
    fireEvent.click(confirm());
    await waitFor(() =>
      expect(h.command).toHaveBeenCalledWith('recordProposalSubmissionTrace', {
        path: { id: PROPOSAL },
        body: { origin: '10.1.2.3', device: 'Laptop A', submitted_at: '2026-11-05', files: [{ document_version_id: VERSION, author: 'Nguyen Van A' }] },
        attempt: { key: expect.any(String) },
      }),
    );
    expect((await screen.findByText(word('lookahead.vnd.trace.receipt'))).textContent).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('refuses a version named twice before sending', async () => {
    open(WRITER);
    fireEvent.click(await screen.findByTestId('record-trace'));
    type(word('lookahead.vnd.trace.proposal.label'), PROPOSAL);
    type(word('lookahead.vnd.trace.origin.label'), '10.1.2.3');
    fireEvent.click(screen.getByTestId('trace-add-file'));
    fireEvent.click(screen.getByTestId('trace-add-file'));
    fireEvent.change(screen.getByTestId('trace-file-version-1'), { target: { value: VERSION } });
    fireEvent.change(screen.getByTestId('trace-file-version-2'), { target: { value: VERSION } });
    expect(confirm().disabled).toBe(true);
  });

  it('says in the dialog that a trace is recorded once when the server refuses a second one, and keeps the dialog open', async () => {
    open(WRITER, () => Promise.reject(problem(409, 'SUBMISSION_TRACE_EXISTS')));
    fireEvent.click(await screen.findByTestId('record-trace'));
    type(word('lookahead.vnd.trace.proposal.label'), PROPOSAL);
    type(word('lookahead.vnd.trace.origin.label'), '10.1.2.3');
    fireEvent.click(confirm());
    expect((await within(dialog()).findByRole('alert')).textContent).toBe(word('lookahead.vnd.trace.error.exists'));
  });

  it('says a proposal that does not exist as not found', async () => {
    open(WRITER, () => Promise.reject(problem(404, 'RESOURCE_NOT_FOUND')));
    fireEvent.click(await screen.findByTestId('record-trace'));
    type(word('lookahead.vnd.trace.proposal.label'), PROPOSAL);
    type(word('lookahead.vnd.trace.agent.label'), 'Browser 1');
    fireEvent.click(confirm());
    expect((await within(dialog()).findByRole('alert')).textContent).toBe(word('vnd.error.notFound.text'));
  });
});

describe('the body of the trace', () => {
  it('keeps only what was typed, trimmed, and a file with nothing but its version keeps only the version', () => {
    expect(traceBody({ origin: ' a b ', device: '', agent: '', submitted_at: '', files: [{ document_version_id: VERSION, author: '', producer: ' P ', created_stamp: '' }] })).toEqual({ origin: 'a b', files: [{ document_version_id: VERSION, producer: 'P' }] });
    expect(traceBody({ origin: '', files: [] })).toEqual({});
  });
  it('wants one fact: an origin, a device, an agent or a described file', () => {
    expect(hasTraceFact({ origin: '', device: '', agent: '', files: [{ document_version_id: VERSION, author: '', producer: '', created_stamp: '' }] })).toBe(false);
    expect(hasTraceFact({ agent: 'x', files: [] })).toBe(true);
    expect(hasTraceFact({ files: [{ document_version_id: VERSION, author: 'x', producer: '', created_stamp: '' }] })).toBe(true);
  });
});
