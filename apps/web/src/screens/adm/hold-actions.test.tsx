import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { t as tr } from '../../i18n';
import { routeOf } from '../doc/test-support';
import { RetentionWorkspace } from './RetentionWorkspace';
import { toHold } from './retention/model';
import type { HoldView } from './retention/model';
import { harness, mountInSession } from './security/test-support';

afterEach(cleanup);

const ROUTE = routeOf('ADM-12', 'FR-ADM-12');
const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const OK = { operation_id: 'o', status: 'Active', resource_version: 2, resource_id: 'h' };
const problem = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });
const hold = (id: string, status = 'Active', extra: Record<string, unknown> = {}): HoldView =>
  toHold({ id, hold_kind: 'INSPECTION', status, resource_scope: { kind: 'PROJECT', ids: [PROJECT] }, authority_reference: 'Decision 12/QD', reason: `Reason of ${id}`, effective_at: '2026-01-01T00:00:00.000Z', version: 5, ...extra }) as HoldView;

function open(options: { holds?: HoldView[]; permissions?: readonly string[]; mode?: 'FULL' | 'READ_ONLY'; command?: (operation: string, input: unknown) => unknown } = {}) {
  const h = harness(() => new Error('no read'), options.command ?? (() => OK));
  mountInSession(<RetentionWorkspace route={ROUTE} policies={[]} review={[]} holds={options.holds ?? [hold('h1')]} />, h, { permissions: options.permissions ?? ['legal_hold.manage'], ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('placing a legal hold (placeLegalHold)', () => {
  it('offers the actions only to a person who manages holds and not to a frozen session', () => {
    open({ permissions: ['adm.retention.read'] });
    expect(screen.queryByTestId('place-hold')).toBeNull();
    expect(screen.queryByTestId('release-h1')).toBeNull();
    cleanup();
    open({ mode: 'READ_ONLY' });
    expect(screen.queryByTestId('place-hold')).toBeNull();
  });

  it('checks the form, then places the hold on the paper of the authority', async () => {
    const h = open();
    fireEvent.click(screen.getByTestId('place-hold'));
    fireEvent.submit(screen.getByTestId('place-hold-form'));
    expect(h.command).not.toHaveBeenCalled();
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(1);
    type(tr('adm.retention.hold.form.ids'), PROJECT);
    type(tr('adm.retention.hold.form.authority'), 'Decision 77/QD-TTCP');
    type(tr('adm.retention.hold.form.reason'), 'The inspection of the project');
    fireEvent.submit(screen.getByTestId('place-hold-form'));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('placeLegalHold', expect.objectContaining({ body: { hold_kind: 'INSPECTION', resource_scope: { kind: 'PROJECT', ids: [PROJECT] }, authority_reference: 'Decision 77/QD-TTCP', reason: 'The inspection of the project' } })));
    await waitFor(() => expect(screen.queryByTestId('place-hold-form')).toBeNull());
  });

  it('clears the ids typed for another scope when the scope becomes the whole tenant, so the form is not stuck', async () => {
    const h = open();
    fireEvent.click(screen.getByTestId('place-hold'));
    type(tr('adm.retention.hold.form.ids'), PROJECT);
    fireEvent.change(screen.getByLabelText(tr('adm.retention.hold.form.scope')), { target: { value: 'TENANT' } });
    expect((screen.getByLabelText(tr('adm.retention.hold.form.ids')) as HTMLTextAreaElement).value).toBe('');
    type(tr('adm.retention.hold.form.authority'), 'Decision 77/QD-TTCP');
    type(tr('adm.retention.hold.form.reason'), 'The inspection of the province');
    fireEvent.submit(screen.getByTestId('place-hold-form'));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('placeLegalHold', expect.objectContaining({ body: expect.objectContaining({ resource_scope: { kind: 'TENANT' } }) })));
  });

  it('takes no ids for the whole tenant, and keeps the form with a refusal in words', async () => {
    const h = open({ command: () => problem(403, 'SCOPE_DENIED') });
    fireEvent.click(screen.getByTestId('place-hold'));
    fireEvent.change(screen.getByLabelText(tr('adm.retention.hold.form.scope')), { target: { value: 'TENANT' } });
    expect((screen.getByLabelText(tr('adm.retention.hold.form.ids')) as HTMLTextAreaElement).disabled).toBe(true);
    type(tr('adm.retention.hold.form.authority'), 'Decision 77/QD-TTCP');
    type(tr('adm.retention.hold.form.reason'), 'The inspection of the province');
    fireEvent.submit(screen.getByTestId('place-hold-form'));
    expect((await screen.findByTestId('hold-refusal')).textContent).toBe(tr('adm.retention.hold.error.scope'));
    expect(h.command).toHaveBeenCalledWith('placeLegalHold', expect.objectContaining({ body: expect.objectContaining({ resource_scope: { kind: 'TENANT' } }) }));
    expect(screen.getByTestId('place-hold-form')).toBeTruthy();
  });
});

describe('releasing a legal hold (releaseLegalHold)', () => {
  it('asks for a reason, releases under the version of the hold, and closes the form', async () => {
    const h = open();
    fireEvent.click(screen.getByTestId('release-h1'));
    const form = screen.getByTestId('release-hold-form');
    fireEvent.submit(form);
    expect(h.command).not.toHaveBeenCalled();
    expect(within(form).getAllByRole('alert').length).toBe(1);
    type(tr('adm.retention.hold.form.reason'), 'The authority lifted the hold');
    fireEvent.submit(form);
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('releaseLegalHold', expect.objectContaining({ path: { holdId: 'h1' }, ifMatchVersion: 5, body: { reason: 'The authority lifted the hold' } })));
    await waitFor(() => expect(screen.queryByTestId('release-hold-form')).toBeNull());
  });

  it('says that the person who placed the hold cannot release it, and that a hold already released cannot be released again', async () => {
    open({ command: () => problem(403, 'SELF_APPROVAL_DENIED') });
    fireEvent.click(screen.getByTestId('release-h1'));
    type(tr('adm.retention.hold.form.reason'), 'The authority lifted the hold');
    fireEvent.submit(screen.getByTestId('release-hold-form'));
    expect((await screen.findByTestId('hold-refusal')).textContent).toBe(tr('adm.retention.hold.error.self'));
    cleanup();
    open({ command: () => problem(409, 'LEGAL_HOLD_STATE_INVALID') });
    fireEvent.click(screen.getByTestId('release-h1'));
    type(tr('adm.retention.hold.form.reason'), 'The authority lifted the hold');
    fireEvent.submit(screen.getByTestId('release-hold-form'));
    expect((await screen.findByTestId('hold-refusal')).textContent).toBe(tr('adm.retention.hold.error.state'));
  });

  it('offers no release for a hold that is already released', () => {
    open({ holds: [hold('h2', 'Released')] });
    expect(screen.queryByTestId('release-h2')).toBeNull();
  });
});
