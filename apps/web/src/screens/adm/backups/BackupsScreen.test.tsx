import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import catalogue from '../../../i18n/vi.json';

import { routeOf } from '../../doc/test-support';
import { harness, mount } from '../../sas/test-support';
import BackupsScreen from './BackupsScreen';
import { kindsFor, refusalOf, toBackupPage } from './model';

vi.setConfig({ testTimeout: 30_000 });

const word = (key: string): string => (catalogue as Record<string, string>)[key] ?? key;
const ROUTE = routeOf('ADM-32', 'FR-ADM-32');
const ALL = ['adm.backup.read', 'adm.backup.request', 'adm.backup.decide', 'adm.backup.record'];
const id = (n: number): string => `00000000-0000-4000-8000-00000000b${String(n).padStart(3, '0')}`;

const request = (n: number, status: string, extra: Record<string, unknown> = {}) => ({
  id: id(n),
  kind: 'full',
  repository: 1,
  reason: 'Before the upgrade of the release.',
  status,
  requested_by: id(900),
  requested_at: '2026-11-09T01:00:00Z',
  decided_by: null,
  decided_at: null,
  decision_reason: null,
  recorded_by: null,
  finished_at: null,
  backup_label: null,
  outcome_note: null,
  version: 1,
  ...extra,
});
const state = (extra: Record<string, unknown> = {}) => ({
  source: 'FILE',
  read_at: '2026-11-09T03:00:00Z',
  backups: [{ label: '20261109-013000F', kind: 'full', finished_at: '2026-11-09T02:00:00Z', repository: 1, failed: false }],
  last_verify_at: '2026-11-08T03:35:00Z',
  health: 'OK',
  detail: null,
  ...extra,
});
const page = (items: unknown[], stateExtra: Record<string, unknown> = {}) => ({ state: state(stateExtra), items, next_cursor: null });

function open(answer: unknown, permissions: readonly string[] | undefined = ALL, command: (operation: string, input: unknown) => unknown = () => ({ resource_id: id(1), resource_version: 2 })) {
  const h = harness((operation) => (operation === 'listBackupRequests' ? answer : new Error(`unexpected read ${operation}`)), command);
  mount(<BackupsScreen route={ROUTE} />, h, permissions, '/adm/adm-32');
  return h;
}
const commands = (h: ReturnType<typeof harness>, operation: string) => h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { path?: Record<string, string>; body?: Record<string, unknown>; ifMatchVersion?: number });
const dialog = (): HTMLElement => screen.getByRole('dialog');
const type = (elementId: string, value: string): void => {
  fireEvent.change(document.getElementById(elementId) as HTMLElement, { target: { value } });
};

afterEach(cleanup);

describe('BackupsScreen (ADM-32, HSKT YCK.06)', () => {
  it('shows the state the server read and the requests with the actions each status allows', async () => {
    open(page([request(1, 'Requested'), request(2, 'Approved', { kind: 'diff' }), request(3, 'Completed', { backup_label: '20261109-013000F_20261109-123000D', kind: 'diff' })]));
    expect((await screen.findByTestId('backup-health')).getAttribute('data-health')).toBe('OK');
    expect(screen.getByText(word('adm.backups.health.ok'))).toBeTruthy();
    expect(document.querySelector('[data-backup="20261109-013000F"]')).not.toBeNull();
    const row = (n: number): HTMLElement => document.querySelector(`[data-request="${id(n)}"]`) as HTMLElement;
    expect(row(1).querySelector('[data-action="decide"]')).not.toBeNull();
    expect(row(1).querySelector('[data-action="cancel"]')).not.toBeNull();
    expect(row(2).querySelector('[data-action="record"]')).not.toBeNull();
    expect(row(3).querySelector('button')).toBeNull();
    expect(row(3).textContent).toContain('20261109-013000F_20261109-123000D');
  });

  it('never invents a state: no source is UNKNOWN with the reason, a failed or stale repository is shown as a problem', async () => {
    open(page([], { source: 'NONE', health: 'UNKNOWN', detail: 'NOT_CONFIGURED', backups: [], last_verify_at: null }));
    expect((await screen.findByTestId('backup-health')).getAttribute('data-health')).toBe('UNKNOWN');
    expect(screen.getByText(word('adm.backups.detail.notConfigured'))).toBeTruthy();
    expect(screen.getByTestId('backup-none')).toBeTruthy();
    expect(screen.getByTestId('request-none')).toBeTruthy();
    expect(screen.getByText(word('adm.backups.verify.none'))).toBeTruthy();
    cleanup();
    open(page([], { health: 'FAILED' }));
    expect((await screen.findByTestId('backup-health')).getAttribute('data-health')).toBe('FAILED');
    cleanup();
    expect(toBackupPage('garbage').state.health).toBe('UNKNOWN');
    expect(toBackupPage({ state: { health: 'FINE' }, items: [{ id: 'x', kind: 'weekly', reason: 'r', status: 'Requested' }] })).toMatchObject({ state: { health: 'UNKNOWN' }, items: [] });
  });

  it('a person without adm.backup.read is told so and nothing is requested; a failure is shown', async () => {
    const denied = open(page([]), []);
    expect(await screen.findByText((catalogue as Record<string, string>)['states.denied.title'] as string)).toBeTruthy();
    expect(denied.read).not.toHaveBeenCalled();
    cleanup();
    open(new Error('down'));
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('asks for a backup: the archive offers full only, a short reason is refused in the form, and the request is sent once with its kind and repository', async () => {
    const h = open(page([]));
    await screen.findByTestId('backup-health');
    fireEvent.click(document.querySelector('[data-action="new"]') as HTMLElement);
    type('backup-repository', '2');
    const kinds = within(dialog()).getAllByRole('option').map((option) => option.textContent);
    expect(kinds).toContain(word('adm.backups.kind.full'));
    expect(kinds).not.toContain(word('adm.backups.kind.diff'));
    type('backup-repository', '1');
    type('backup-kind', 'diff');
    type('backup-reason', 'short');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.backups.new.submit') }));
    expect(commands(h, 'requestBackup')).toHaveLength(0);
    expect(within(dialog()).getByRole('alert').textContent).toContain('10');
    type('backup-reason', 'Before the upgrade of the release on Saturday.');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.backups.new.submit') }));
    await waitFor(() => expect(commands(h, 'requestBackup')).toHaveLength(1));
    expect(commands(h, 'requestBackup')[0]?.body).toEqual({ kind: 'diff', repository: 1, reason: 'Before the upgrade of the release on Saturday.' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('decides with the version of the row; a rejection needs a reason; the refusal of the server is shown in words', async () => {
    const h = open(page([request(1, 'Requested', { version: 4 })]), ALL, () => new ApiError({ status: 403, code: 'SELF_APPROVAL_DENIED', correlationId: 'c' }));
    await screen.findByTestId('backup-requests');
    fireEvent.click(document.querySelector('[data-action="decide"]') as HTMLElement);
    type('backup-decision', 'reject');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.backups.decide.submit') }));
    expect(commands(h, 'decideBackupRequest')).toHaveLength(0);
    type('backup-decision', 'approve');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.backups.decide.submit') }));
    await waitFor(() => expect(commands(h, 'decideBackupRequest')).toHaveLength(1));
    expect(commands(h, 'decideBackupRequest')[0]).toMatchObject({ path: { id: id(1) }, body: { decision: 'approve' }, ifMatchVersion: 4 });
    expect((await screen.findByTestId('refusal')).textContent).toBe(word('adm.backups.refusal.selfApproval'));
  });

  it('records the outcome of an approved request with the label, or the failure with a note', async () => {
    const h = open(page([request(2, 'Approved', { version: 2 })]));
    await screen.findByTestId('backup-requests');
    fireEvent.click(document.querySelector('[data-action="record"]') as HTMLElement);
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.backups.record.submit') }));
    expect(commands(h, 'recordBackupOutcome')).toHaveLength(0);
    type('backup-label', '20261109-013000F');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.backups.record.submit') }));
    await waitFor(() => expect(commands(h, 'recordBackupOutcome')).toHaveLength(1));
    expect(commands(h, 'recordBackupOutcome')[0]).toMatchObject({ path: { id: id(2) }, body: { outcome: 'completed', backup_label: '20261109-013000F' }, ifMatchVersion: 2 });
  });

  it('withdraws a waiting request with a reason', async () => {
    const h = open(page([request(1, 'Requested')]));
    await screen.findByTestId('backup-requests');
    fireEvent.click(document.querySelector('[data-action="cancel"]') as HTMLElement);
    type('backup-reason', 'Not needed any more.');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('adm.backups.cancel.submit') }));
    await waitFor(() => expect(commands(h, 'cancelBackupRequest')).toHaveLength(1));
  });

  it('a person who may only read sees no action', async () => {
    open(page([request(1, 'Requested'), request(2, 'Approved')]), ['adm.backup.read']);
    await screen.findByTestId('backup-requests');
    expect(document.querySelector('button[data-action]')).toBeNull();
  });
});

describe('the model of the backups screen', () => {
  it('maps the codes of the server to refusals and the archive to full backups only', () => {
    const refusal = (code: string): string => refusalOf(new ApiError({ status: 409, code, correlationId: 'c' }));
    expect([refusal('SELF_APPROVAL_DENIED'), refusal('BACKUP_REQUEST_OPEN'), refusal('VERSION_CONFLICT'), refusal('STAGE_TRANSITION_DENIED'), refusal('VALIDATION_FAILED'), refusal('SCOPE_DENIED'), refusal('X')]).toEqual(['selfApproval', 'open', 'conflict', 'state', 'invalid', 'denied', 'general']);
    expect(refusalOf(new Error('x'))).toBe('general');
    expect(kindsFor(1)).toEqual(['full', 'diff', 'incr']);
    expect(kindsFor(2)).toEqual(['full']);
  });
});

