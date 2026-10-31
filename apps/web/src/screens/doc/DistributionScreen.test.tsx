import { ApiError } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import en_ from '../../i18n/en.json';
import vi_ from '../../i18n/vi.json';
import DistributionScreen from './DistributionScreen';
import { harness, mount, mountInSession, routeOf } from './test-support';

const ROUTE = routeOf('DOC-08', 'FR-DOC-08');
const DOC = '00000000-0000-4000-8000-0000000000d8';
const CLERK = ['doc.outgoing.read', 'doc.outgoing.issue', 'doc.distribution.manage', 'doc.template.confirm_legal'];
const REASON = 'The legal office confirmed the template by letter 12/PC';

const recipients = [
  { kind: 'INTERNAL_UNIT', name: 'Planning Division', unit_id: '00000000-0000-4000-8000-0000000000a9' },
  { kind: 'EXTERNAL_AGENCY', name: 'Department of Finance', code: 'SKHDT' },
];

const row = (overrides: Record<string, unknown> = {}) => ({
  id: DOC,
  title: 'Decision to assign capital',
  doc_type_code: 'QD',
  status: 'SEALED',
  document_number: 12,
  symbol: '12/QD-UBND',
  issued_on: '2026-10-23',
  current_version_id: 'v4',
  sealed_at: '2026-10-23T02:00:00Z',
  issued_at: null,
  created_at: '2026-10-23T01:00:00Z',
  version: 4,
  ...overrides,
});

const detail = (overrides: Record<string, unknown> = {}) => ({
  ...row(),
  recipients,
  distributions: [],
  renders_watermarked: false,
  unconfirmed_override_reason: null,
  ...overrides,
});

const distribution = (overrides: Record<string, unknown> = {}) => ({
  id: 'd1',
  recipient_kind: 'EXTERNAL_AGENCY',
  recipient_name: 'Department of Finance',
  recipient_code: 'SKHDT',
  channel: 'PAPER_HANDOVER',
  status: 'SENT',
  acknowledgement_required: true,
  sent_at: '2026-10-23T03:00:00Z',
  delivered_at: null,
  acknowledged_at: null,
  external_ref: null,
  attempts: 1,
  error_code: null,
  version: 2,
  ...overrides,
});

function answer(current: () => Record<string, unknown>) {
  return (operation: string, input: unknown): unknown => {
    if (operation === 'listOutgoingDocuments') {
      const status = (input as { query: { status: string } }).query.status;
      const own = current();
      return { items: own.status === status ? [own] : [], next_cursor: null };
    }
    if (operation === 'getOutgoingDocument') return current();
    return new Error(`unexpected read ${operation}`);
  };
}

const problem = (status: number, code: string, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });

afterEach(cleanup);

describe('DistributionScreen (DOC-08)', () => {
  it('shows the sealed document with its issue form and no distribution yet', async () => {
    mount(<DistributionScreen route={ROUTE} />, harness(answer(() => detail())), CLERK);
    expect(await screen.findByRole('form', { name: vi_['doc.distribution.issue.form'] })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['doc.distribution.page.title']);
    expect(screen.getByTestId('document-status').textContent).toBe(vi_['doc.distribution.status.sealed']);
    expect(screen.getByText(vi_['doc.distribution.table.notIssued'])).toBeTruthy();
    expect(screen.queryByLabelText(vi_['doc.distribution.reason.label'])).toBeNull();
    expect(screen.getByText(vi_['doc.distribution.version.pill'].replace('{version}', '4'))).toBeTruthy();
    expect(screen.getByRole('link', { name: vi_['doc.distribution.verify.link'] }).getAttribute('href')).toBe('/doc/doc-07?version=v4');
  });

  it('says there is nothing to issue or distribute when no document is waiting', async () => {
    mount(<DistributionScreen route={ROUTE} />, harness(() => ({ items: [], next_cursor: null })), CLERK);
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
  });

  it('says the documents could not be read and reads them again on request', async () => {
    let fails = true;
    const h = harness((operation, input) => (fails ? new ApiError({ status: 503, code: 'UNAVAILABLE', correlationId: 'c' }) : answer(() => detail())(operation, input)));
    mount(<DistributionScreen route={ROUTE} />, h, CLERK);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: vi_['states.retry.action'] }));
    fails = false;
    await user.click(await screen.findByRole('button', { name: vi_['states.retry.action'] }));
    expect(await screen.findByRole('form', { name: vi_['doc.distribution.issue.form'] })).toBeTruthy();
  });

  describe('issuing', () => {
    it('issues a sealed document of a confirmed template with the version it saw (no reason is sent)', async () => {
      const h = harness(answer(() => detail()), () => ({ status: 'ISSUED', resource_id: DOC, resource_version: 5 }));
      mount(<DistributionScreen route={ROUTE} />, h, CLERK);
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: vi_['doc.distribution.issue.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('issueOutgoingDocument');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: DOC }, ifMatchVersion: 4, body: {} });
      expect((await screen.findByText(vi_['doc.distribution.done.issued'])).closest('[role="status"]')).not.toBeNull();
    });

    it('asks a document of an unconfirmed template for the written reason in the browser, then sends it trimmed (AC-ST-DOC-010-1, UAT-AC407)', async () => {
      const h = harness(answer(() => detail({ renders_watermarked: true })), () => ({ status: 'ISSUED', resource_id: DOC, resource_version: 5 }));
      mount(<DistributionScreen route={ROUTE} />, h, CLERK);
      const user = userEvent.setup();
      expect(await screen.findByText(vi_['doc.distribution.watermark.notice'])).toBeTruthy();
      const button = screen.getByRole('button', { name: vi_['doc.distribution.issue.action'] });
      await user.click(button);
      expect((await screen.findByRole('alert')).textContent).toBe(vi_['doc.distribution.reason.problem.required']);
      const reason = screen.getByLabelText(vi_['doc.distribution.reason.label']);
      await user.type(reason, 'too short');
      await user.click(button);
      expect((await screen.findByRole('alert')).textContent).toBe(vi_['doc.distribution.reason.problem.tooShort']);
      expect(h.command).not.toHaveBeenCalled();
      await user.clear(reason);
      await user.type(reason, `  ${REASON}  `);
      await user.click(button);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { unconfirmed_override_reason: REASON } });
    });

    it('offers the reason field only to someone who may confirm templates, and says why not to the others', async () => {
      mount(<DistributionScreen route={ROUTE} />, harness(answer(() => detail({ renders_watermarked: true }))), ['doc.outgoing.read', 'doc.outgoing.issue']);
      const reason = (await screen.findByLabelText(vi_['doc.distribution.reason.label'])) as HTMLTextAreaElement;
      expect(reason.disabled).toBe(true);
      expect(screen.getByText(vi_['doc.distribution.reason.denied'])).toBeTruthy();
      expect((screen.getByRole('button', { name: vi_['doc.distribution.issue.action'] }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('asks to distribute at once only for someone who may distribute', async () => {
      const h = harness(answer(() => detail()), () => ({ status: 'DELIVERED', resource_id: DOC, resource_version: 6 }));
      mount(<DistributionScreen route={ROUTE} />, h, CLERK);
      const user = userEvent.setup();
      await user.click(await screen.findByLabelText(vi_['doc.distribution.now.label']));
      await user.click(screen.getByRole('button', { name: vi_['doc.distribution.issue.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { distribute_now: true } });
      cleanup();
      mount(<DistributionScreen route={ROUTE} />, harness(answer(() => detail())), ['doc.outgoing.read', 'doc.outgoing.issue']);
      await screen.findByRole('form', { name: vi_['doc.distribution.issue.form'] });
      expect(screen.queryByLabelText(vi_['doc.distribution.now.label'])).toBeNull();
    });

    it.each([
      ['SIGNATURE_VERIFICATION_FAILED', 422, {}, 'doc.distribution.problem.signature'],
      ['CERTIFICATE_CHAIN_UNTRUSTED', 422, {}, 'doc.distribution.problem.chain'],
      ['INCREMENTAL_CHANGES_NOT_ALLOWED', 422, {}, 'doc.distribution.problem.incremental'],
      ['SIGNING_TIME_UNPROVEN', 422, {}, 'doc.distribution.problem.time'],
      ['PROVIDER_UNAVAILABLE', 503, {}, 'doc.distribution.problem.revocation'],
      ['TEMPLATE_PENDING_LEGAL_CONFIRMATION', 422, {}, 'doc.distribution.problem.template'],
      ['VERSION_CONFLICT', 409, {}, 'doc.distribution.problem.conflict'],
      ['DOCUMENT_STATE_INVALID', 409, {}, 'doc.distribution.problem.state'],
      ['SCOPE_DENIED', 403, {}, 'doc.distribution.problem.denied'],
    ] as const)('says in words why the gate refused: %s', async (code, status, extensions, key) => {
      const h = harness(answer(() => detail()), () => problem(status, code, extensions));
      mount(<DistributionScreen route={ROUTE} />, h, CLERK);
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: vi_['doc.distribution.issue.action'] }));
      expect((await screen.findByRole('alert')).textContent).toContain(vi_[key]);
    });

    it('lists the findings of a failed verification next to the message', async () => {
      const h = harness(answer(() => detail()), () => problem(422, 'SIGNATURE_VERIFICATION_FAILED', { findings: ['DIGEST_MISMATCH', 'CERTIFICATE_REVOKED'] }));
      mount(<DistributionScreen route={ROUTE} />, h, CLERK);
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: vi_['doc.distribution.issue.action'] }));
      expect((await screen.findByRole('alert')).textContent).toContain('DIGEST_MISMATCH, CERTIFICATE_REVOKED');
    });

    it('shows no way to issue to someone without the right, and nothing at all in a suspended tenant', async () => {
      mount(<DistributionScreen route={ROUTE} />, harness(answer(() => detail())), ['doc.outgoing.read']);
      expect(await screen.findByText(vi_['doc.distribution.denied.issue'])).toBeTruthy();
      expect(screen.queryByRole('button', { name: vi_['doc.distribution.issue.action'] })).toBeNull();
      cleanup();
      const view = mountInSession(<DistributionScreen route={ROUTE} />, harness(answer(() => detail())), { permissions: CLERK, mode: 'READ_ONLY' });
      expect(await screen.findByText(vi_['doc.distribution.frozen.notice'])).toBeTruthy();
      expect(screen.queryByRole('button', { name: vi_['doc.distribution.issue.action'] })).toBeNull();
      view.unmount();
    });
  });

  describe('distributing', () => {
    it('sends a corrected document to new recipients too: it is in the queue and has the dispatch form (ST-DOC-015)', async () => {
      const corrected = detail({ status: 'CORRECTED', issued_at: '2026-10-23T03:00:00Z', distributions: [] });
      const h = harness(answer(() => corrected), () => ({ status: 'CORRECTED', resource_id: DOC, resource_version: 5 }));
      mount(<DistributionScreen route={ROUTE} />, h, CLERK);
      expect(await screen.findByRole('form', { name: vi_['doc.distribution.dispatch.form'] })).toBeTruthy();
      expect(screen.getByText(vi_['doc.distribution.queue.option.text'].replace('{title}', 'Decision to assign capital').replace('{status}', vi_['doc.distribution.status.corrected']))).toBeTruthy();
      expect(h.read.mock.calls.some(([operation, input]) => operation === 'listOutgoingDocuments' && (input as { query: { status: string } }).query.status === 'CORRECTED')).toBe(true);
    });

    const issued = (distributions: unknown[] = [], overrides: Record<string, unknown> = {}) => detail({ status: 'ISSUED', issued_at: '2026-10-23T03:00:00Z', distributions, ...overrides });

    it('sends to the chosen recipients, on the chosen channel, with the duty to acknowledge as set (AC-ST-DOC-010-2, UAT-AC410)', async () => {
      const h = harness(answer(() => issued()), () => ({ status: 'ISSUED', resource_id: DOC, resource_version: 4 }));
      mount(<DistributionScreen route={ROUTE} />, h, CLERK);
      const user = userEvent.setup();
      await screen.findByRole('form', { name: vi_['doc.distribution.dispatch.form'] });
      const send = screen.getByRole('button', { name: vi_['doc.distribution.dispatch.action'] }) as HTMLButtonElement;
      expect(send.disabled).toBe(true);
      await user.click(screen.getByLabelText(vi_['doc.distribution.dispatch.select.label'].replace('{name}', 'Planning Division')));
      await user.click(screen.getByLabelText(vi_['doc.distribution.dispatch.select.label'].replace('{name}', 'Department of Finance')));
      // The agency is outside the system: its inbox channel is not offered, and its default is the paper handover.
      const agencyChannel = screen.getByLabelText(vi_['doc.distribution.dispatch.channel.label'].replace('{name}', 'Department of Finance')) as HTMLSelectElement;
      expect(Array.from(agencyChannel.options).map((option) => option.value)).toEqual(['EMAIL', 'PAPER_HANDOVER']);
      expect(agencyChannel.value).toBe('PAPER_HANDOVER');
      await user.click(screen.getByLabelText(vi_['doc.distribution.dispatch.receipt.label'].replace('{name}', 'Department of Finance')));
      await user.click(send);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('dispatchOutgoingDocument');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({
        path: { id: DOC },
        ifMatchVersion: 4,
        body: {
          recipients: [
            { kind: 'INTERNAL_UNIT', name: 'Planning Division', unit_id: recipients[0]?.unit_id, channel: 'INTERNAL', acknowledgement_required: true },
            { kind: 'EXTERNAL_AGENCY', name: 'Department of Finance', code: 'SKHDT', channel: 'PAPER_HANDOVER', acknowledgement_required: false },
          ],
        },
      });
      expect(await screen.findByText(vi_['doc.distribution.done.sent'])).toBeTruthy();
    });

    it('shows the rows with their status and progress, and keeps a recipient that already has a row out of a new dispatch', async () => {
      const rows = [distribution(), distribution({ id: 'd2', recipient_name: 'Planning Division', recipient_kind: 'INTERNAL_UNIT', channel: 'INTERNAL', status: 'DELIVERED', delivered_at: '2026-10-23T03:00:00Z' })];
      mount(<DistributionScreen route={ROUTE} />, harness(answer(() => issued(rows, { status: 'DELIVERED' }))), CLERK);
      expect(await screen.findByTestId('progress')).toBeTruthy();
      expect(screen.getByTestId('progress').textContent).toBe(vi_['doc.distribution.progress.text'].replace('{reached}', '1').replace('{total}', '2').replace('{acknowledged}', '0'));
      const table = screen.getAllByRole('table').at(-1) as HTMLElement;
      const first = within(table).getByText('Department of Finance').closest('tr') as HTMLElement;
      expect(within(first).getByText(vi_['doc.distribution.rowStatus.sent']).className).toBe('pill warn');
      expect(within(first).getByText(vi_['doc.distribution.channel.paper'])).toBeTruthy();
      const dispatchRow = screen.getByRole('form', { name: vi_['doc.distribution.dispatch.form'] });
      const taken = within(dispatchRow).getByLabelText(vi_['doc.distribution.dispatch.select.label'].replace('{name}', 'Department of Finance'));
      expect(Array.from(within(dispatchRow).getAllByRole('combobox')).length).toBe(2);
      // The agency already has its paper handover, and so has the unit its inbox: neither is offered again on that channel.
      expect((taken as HTMLInputElement).disabled).toBe(true);
      const unit = within(dispatchRow).getByLabelText(vi_['doc.distribution.dispatch.select.label'].replace('{name}', 'Planning Division')) as HTMLInputElement;
      expect(unit.disabled).toBe(true);
    });

    it('records a receipt with the time and the reference, and says why a receipt was refused', async () => {
      let fail = true;
      const h = harness(answer(() => issued([distribution()])), () => (fail ? problem(422, 'VALIDATION_FAILED', {}) : { status: 'ACKNOWLEDGED', resource_id: 'd1', resource_version: 3 }));
      mount(<DistributionScreen route={ROUTE} />, h, CLERK);
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: vi_['doc.distribution.row.receipt.action'] }));
      const form = screen.getByRole('form', { name: vi_['doc.distribution.receipt.form'] });
      await user.type(within(form).getByLabelText(vi_['doc.distribution.receipt.ref.label']), '  RECEIPT-9  ');
      await user.click(within(form).getByRole('button', { name: vi_['doc.distribution.receipt.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('recordDistributionAcknowledgement');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: 'd1' }, ifMatchVersion: 2, body: { external_ref: 'RECEIPT-9' } });
      expect(h.command.mock.calls[0]?.[1].body.acknowledged_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect((await screen.findByRole('alert')).textContent).toContain(vi_['doc.distribution.problem.invalid']);
      fail = false;
      await user.click(within(screen.getByRole('form', { name: vi_['doc.distribution.receipt.form'] })).getByRole('button', { name: vi_['doc.distribution.receipt.submit.action'] }));
      await waitFor(() => expect(screen.queryByRole('form', { name: vi_['doc.distribution.receipt.form'] })).toBeNull());
    });

    it('lets the receipt form be dropped without sending anything', async () => {
      const h = harness(answer(() => issued([distribution()])));
      mount(<DistributionScreen route={ROUTE} />, h, CLERK);
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: vi_['doc.distribution.row.receipt.action'] }));
      await user.click(screen.getByRole('button', { name: vi_['doc.distribution.receipt.cancel.action'] }));
      expect(screen.queryByRole('form', { name: vi_['doc.distribution.receipt.form'] })).toBeNull();
      expect(h.command).not.toHaveBeenCalled();
    });

    it('shows the failure of a row with its reason and sends it again (the same row)', async () => {
      const failed = distribution({ status: 'FAILED', channel: 'EMAIL', sent_at: null, error_code: 'PROVIDER_UNAVAILABLE', attempts: 1 });
      const h = harness(answer(() => issued([failed])), () => ({ status: 'SENT', resource_id: 'd1', resource_version: 3 }));
      mount(<DistributionScreen route={ROUTE} />, h, CLERK);
      const user = userEvent.setup();
      const line = (await screen.findAllByText(vi_['doc.distribution.rowStatus.failed']))[0]?.closest('tr') as HTMLElement;
      expect(within(line).getByText(vi_['doc.distribution.error.provider'])).toBeTruthy();
      expect(within(line).getByText(vi_['doc.distribution.rowStatus.failed']).className).toBe('pill red');
      await user.click(within(line).getByRole('button', { name: vi_['doc.distribution.row.retry.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('retryDocumentDistribution');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: 'd1' }, ifMatchVersion: 2 });
    });

    it('offers neither sending nor receipts to someone who may not distribute, and still shows the rows', async () => {
      const failed = distribution({ status: 'FAILED', error_code: 'CHANNEL_ERROR' });
      mount(<DistributionScreen route={ROUTE} />, harness(answer(() => issued([failed, distribution({ id: 'd3', recipient_name: 'Other' })]))), ['doc.outgoing.read']);
      expect(await screen.findByText(vi_['doc.distribution.error.channel'])).toBeTruthy();
      expect(screen.queryByRole('form', { name: vi_['doc.distribution.dispatch.form'] })).toBeNull();
      expect(screen.queryByRole('button', { name: vi_['doc.distribution.row.retry.action'] })).toBeNull();
      expect(screen.queryByRole('button', { name: vi_['doc.distribution.row.receipt.action'] })).toBeNull();
    });

    it('marks a copy that needs no receipt, shows an unknown error code as it is and the override reason of an unconfirmed template', async () => {
      const rows = [distribution({ acknowledgement_required: false, status: 'FAILED', error_code: 'SOMETHING_ELSE' })];
      mount(<DistributionScreen route={ROUTE} />, harness(answer(() => issued(rows, { unconfirmed_override_reason: REASON }))), CLERK);
      expect(await screen.findByText(vi_['doc.distribution.table.copy'])).toBeTruthy();
      expect(screen.getByText('SOMETHING_ELSE')).toBeTruthy();
      expect(screen.getByText(vi_['doc.distribution.override.notice'].replace('{reason}', REASON))).toBeTruthy();
    });

    it.each([
      ['RECIPIENT_INVALID', 422, 'doc.distribution.problem.recipient'],
      ['PROVIDER_UNAVAILABLE', 503, 'doc.distribution.problem.channel'],
      ['DISTRIBUTION_STATE_INVALID', 409, 'doc.distribution.problem.distributionState'],
    ] as const)('says in words why a dispatch was refused: %s', async (code, status, key) => {
      const h = harness(answer(() => issued()), () => problem(status, code));
      mount(<DistributionScreen route={ROUTE} />, h, CLERK);
      const user = userEvent.setup();
      await user.click(await screen.findByLabelText(vi_['doc.distribution.dispatch.select.label'].replace('{name}', 'Department of Finance')));
      await user.click(screen.getByRole('button', { name: vi_['doc.distribution.dispatch.action'] }));
      expect((await screen.findByRole('alert')).textContent).toContain(vi_[key]);
    });
  });

  it('keeps the same labels in both languages for the placeholders it fills', () => {
    for (const key of Object.keys(vi_).filter((name) => name.startsWith('doc.distribution.'))) {
      const placeholders = (text: string): string[] => (text.match(/\{\w+\}/g) ?? []).sort();
      expect(placeholders((en_ as Record<string, string>)[key] ?? ''), key).toEqual(placeholders((vi_ as Record<string, string>)[key] ?? ''));
    }
  });
});
