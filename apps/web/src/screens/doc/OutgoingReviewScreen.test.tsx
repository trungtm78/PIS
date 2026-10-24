import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import OutgoingReviewScreen from './OutgoingReviewScreen';
import { SECOND_TENANT, TENANT, harness, mount, mountInSession, routeOf } from './test-support';
import type { Harness } from './test-support';

const ROUTE = routeOf('DOC-04', 'FR-DOC-04');
const REVIEW = 'doc.outgoing.review';
const READ = 'doc.outgoing.read';
const DRAFTER = '00000000-0000-4000-8000-0000000000a1';
const SIGNER = '00000000-0000-4000-8000-0000000000b2';
const FIRST = '00000000-0000-4000-8000-000000000201';
const SECOND = '00000000-0000-4000-8000-000000000202';
const LOCKED = '00000000-0000-4000-8000-000000000203';
const OWN = '00000000-0000-4000-8000-000000000204';
const FINAL_SHA = 'f'.repeat(64);
const CHECKLIST_KEYS = ['national_title', 'motto', 'agency_name', 'number_symbol', 'summary', 'body', 'signer_title', 'recipients'];

const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);
const problem = (code: string, status: number, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });

const row = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  document_id: `d-${id}`,
  title: `Title of ${id.slice(-3)}`,
  doc_type_code: 'QD',
  status: 'IN_REVIEW',
  effect_status: 'PENDING',
  urgency: 'NORMAL',
  circulation: 'INTERNAL_CIRCULATION',
  drafting_unit_id: '00000000-0000-4000-8000-000000000f01',
  drafter_user_id: DRAFTER,
  signer_user_id: SIGNER,
  signer_title: 'CHAIRMAN',
  signing_mode: 'KT',
  delegation_id: null,
  template_id: null,
  payload_sha256: 'a'.repeat(64),
  payload: { agency: 'People Committee', place: 'Cao Bang', amount_vnd: '6000000000', body: 'The text of the decision' },
  recipients: [{ kind: 'EXTERNAL_AGENCY', name: 'Department of Finance' }],
  latest_review: null,
  versions: [],
  current_version_id: null,
  version: 2,
  created_at: '2026-10-23T03:00:00.000Z',
  ...overrides,
});

const DOCS: Record<string, Record<string, unknown>> = {
  [FIRST]: row(FIRST),
  [SECOND]: row(SECOND, { created_at: '2026-10-22T03:00:00.000Z', payload: { agency: 'Other' }, signing_mode: 'DIRECT' }),
  [LOCKED]: row(LOCKED, { status: 'SUBMITTED', version: 5, current_version_id: 'v1', versions: [{ id: 'v1', stage: 'RENDERED_FINAL', checksum: FINAL_SHA, page_count: 2 }, { id: 'v0', stage: 'RENDERED_FINAL', checksum: '0'.repeat(64), page_count: 2 }] }),
  [OWN]: row(OWN, { drafter_user_id: TENANT.membershipId }),
};

function world(options: { commands?: Record<string, unknown>; queue?: unknown; events?: unknown[] } = {}): Harness {
  const read = (operation: string, input: unknown): unknown => {
    if (operation === 'listOutgoingDocuments') {
      const status = (input as { query: { status: string } }).query.status;
      if (options.queue !== undefined) return options.queue;
      const items = Object.values(DOCS).filter((doc) => doc.status === status);
      return { items, next_cursor: null };
    }
    if (operation === 'getOutgoingDocument') return DOCS[(input as { path: { id: string } }).path.id] ?? problem('RESOURCE_NOT_FOUND', 404);
    if (operation === 'getDocumentTimeline') {
      return {
        events: options.events ?? [
          { id: 'e1', kind: 'CREATED', from_status: null, to_status: 'DRAFT', actor_id: DRAFTER, comment: null, occurred_at: '2026-10-23T03:00:00.000Z' },
          { id: 'e2', kind: 'REVIEW_REQUESTED', from_status: 'DRAFT', to_status: 'IN_REVIEW', actor_id: DRAFTER, comment: 'Please look at the annex', occurred_at: '2026-10-23T03:05:00.000Z' },
        ],
      };
    }
    return new Error(`unexpected read ${operation}`);
  };
  const command = (operation: string): unknown => options.commands?.[operation] ?? { operation_id: 'o', status: 'SUBMITTED', resource_version: 6, resource_id: FIRST, file_sha256: FINAL_SHA };
  return harness(read, command);
}

const open = (h: Harness, permissions: readonly string[] = [READ, REVIEW], path = '/') => mount(<OutgoingReviewScreen route={ROUTE} />, h, permissions, path);
const check = async (user: ReturnType<typeof userEvent.setup>, key: string): Promise<void> => user.click(screen.getByLabelText(vi_[`doc.review.checklist.${camel(key)}` as keyof typeof vi_]));
const camel = (key: string): string => key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
const approveButton = () => screen.getByRole('button', { name: vi_['doc.review.approve.action'] }) as HTMLButtonElement;

afterEach(cleanup);

describe('OutgoingReviewScreen (DOC-04)', () => {
  it('lists the documents that wait for review or for the signature, newest first, and opens the first', async () => {
    const h = world();
    open(h);
    expect(await screen.findByRole('heading', { level: 2, name: 'Title of 201' })).toBeTruthy();
    const queue = screen.getByRole('list', { name: vi_['doc.review.queue.title'] });
    expect(within(queue).getAllByRole('listitem').map((item) => item.getAttribute('data-document-id'))).toEqual([FIRST, OWN, LOCKED, SECOND]);
    expect(h.read).toHaveBeenCalledWith('listOutgoingDocuments', { query: { limit: 50, status: 'IN_REVIEW' } });
    expect(h.read).toHaveBeenCalledWith('listOutgoingDocuments', { query: { limit: 50, status: 'SUBMITTED' } });
  });

  it('shows the facts the reviewer checks: the signer, the form of signature, the amount, the recipients and the content', async () => {
    open(world(), [READ, REVIEW], `/?doc=${FIRST}`);
    await screen.findByRole('heading', { level: 2, name: 'Title of 201' });
    expect(screen.getAllByText('6000000000').length).toBeGreaterThan(0);
    expect(screen.getByText(vi_['doc.draft.mode.kt'])).toBeTruthy();
    expect(screen.getByText('Department of Finance')).toBeTruthy();
    expect(screen.getByText('The text of the decision')).toBeTruthy();
    expect(screen.getByText(vi_['doc.review.hash.pending'])).toBeTruthy();
    expect(await screen.findByText(vi_['doc.draft.event.reviewRequested'], { exact: false })).toBeTruthy();
    expect(screen.getByText('Please look at the annex')).toBeTruthy();
  });

  it('approves only when every item of the checklist is confirmed, and locks the final PDF with the version that was read (AC-ST-DOC-007-2)', async () => {
    const h = world();
    open(h, [READ, REVIEW], `/?doc=${FIRST}`);
    const user = userEvent.setup();
    await screen.findByRole('heading', { level: 2, name: 'Title of 201' });
    expect(approveButton().disabled).toBe(true);
    expect(approveButton().getAttribute('title')).toBe(vi_['doc.review.approve.incomplete']);
    for (const key of CHECKLIST_KEYS.slice(0, 7)) await check(user, key);
    expect(approveButton().disabled).toBe(true);
    await check(user, 'recipients');
    expect(approveButton().disabled).toBe(false);
    await user.type(screen.getByLabelText(vi_['doc.review.comment.label']), '  Format checked ');
    await user.click(approveButton());
    await waitFor(() =>
      expect(h.command).toHaveBeenCalledWith(
        'decideOutgoingDocumentReview',
        expect.objectContaining({
          ifMatchVersion: 2,
          path: { id: FIRST },
          body: { decision: 'APPROVE', comment: 'Format checked', format_checklist: Object.fromEntries(CHECKLIST_KEYS.map((key) => [key, true])) },
        }),
      ),
    );
    expect(await screen.findByText(vi_['doc.review.approved.notice'])).toBeTruthy();
    expect(screen.getByText(FINAL_SHA)).toBeTruthy();
    expect((screen.getByRole('link', { name: vi_['doc.review.approved.next'] }) as HTMLAnchorElement).getAttribute('href')).toBe(`/doc/doc-05?doc=${FIRST}`);
  });

  it('does not let the drafter approve their own document, and says so (AC-ST-DOC-007-1)', async () => {
    open(world(), [READ, REVIEW], `/?doc=${OWN}`);
    await screen.findByRole('heading', { level: 2, name: 'Title of 204' });
    expect(screen.getByText(vi_['doc.review.own.notice'])).toBeTruthy();
    expect(approveButton().disabled).toBe(true);
    expect(approveButton().getAttribute('title')).toBe(vi_['doc.review.approve.own']);
    expect(screen.getByLabelText(vi_['doc.review.checklist.nationalTitle']).matches(':disabled')).toBe(true);
    // Returning for changes stays possible.
    expect(screen.getByRole('button', { name: vi_['doc.review.return.action'] })).toBeTruthy();
  });

  it('shows why the server refused: the signer without the authority with the band, and the checks that failed', async () => {
    const threshold = { document_type: 'QD', amount_vnd: '6000000000', amount_min_vnd: '5000000000', amount_max_vnd: '9000000000', approver_role_id: 'r' };
    const h = world({ commands: { decideOutgoingDocumentReview: problem('SIGNER_NOT_AUTHORIZED', 422, { reason: 'ROLE_NOT_HELD', threshold }) } });
    open(h, [READ, REVIEW], `/?doc=${FIRST}`);
    const user = userEvent.setup();
    await screen.findByRole('heading', { level: 2, name: 'Title of 201' });
    for (const key of CHECKLIST_KEYS) await check(user, key);
    await user.click(approveButton());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(vi_['doc.draft.authority.role']);
    expect(alert.textContent).toContain(fill(vi_['doc.draft.authority.band'], { min: '5.000.000.000', max: '9.000.000.000' }));
    cleanup();
    const failing = world({ commands: { decideOutgoingDocumentReview: problem('FORMAT_CHECK_FAILED', 422, { failures: [{ field: 'format_checklist.motto', code: 'CHECK_NOT_CONFIRMED' }] }) } });
    open(failing, [READ, REVIEW], `/?doc=${FIRST}`);
    await screen.findByRole('heading', { level: 2, name: 'Title of 201' });
    for (const key of CHECKLIST_KEYS) await check(user, key);
    await user.click(approveButton());
    expect(await screen.findByText(fill(vi_['doc.draft.failure.check'], { item: 'motto' }))).toBeTruthy();
  });

  it('shows the self-approval refusal of the server when it is the one to say it', async () => {
    const h = world({ commands: { decideOutgoingDocumentReview: problem('SELF_APPROVAL_DENIED', 403) } });
    open(h, [READ, REVIEW], `/?doc=${FIRST}`);
    const user = userEvent.setup();
    await screen.findByRole('heading', { level: 2, name: 'Title of 201' });
    for (const key of CHECKLIST_KEYS) await check(user, key);
    await user.click(approveButton());
    expect(await screen.findByText(vi_['doc.draft.problem.selfApproval'])).toBeTruthy();
  });

  it('returns a document under review with a reason of at least ten characters', async () => {
    const h = world();
    open(h, [READ, REVIEW], `/?doc=${FIRST}`);
    const user = userEvent.setup();
    await screen.findByRole('heading', { level: 2, name: 'Title of 201' });
    await user.click(screen.getByRole('button', { name: vi_['doc.review.return.action'] }));
    expect(await screen.findByText(vi_['doc.draft.field.required'])).toBeTruthy();
    await user.type(screen.getByLabelText(vi_['doc.review.return.reason.label']), 'short');
    await user.click(screen.getByRole('button', { name: vi_['doc.review.return.action'] }));
    expect(await screen.findByText(vi_['doc.draft.field.tooShort'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText(vi_['doc.review.return.reason.label']), ' reason that is long enough');
    await user.click(screen.getByRole('button', { name: vi_['doc.review.return.action'] }));
    await waitFor(() =>
      expect(h.command).toHaveBeenCalledWith('decideOutgoingDocumentReview', expect.objectContaining({ ifMatchVersion: 2, body: { decision: 'RETURN', comment: 'short reason that is long enough' } })),
    );
    expect(await screen.findByText(vi_['doc.review.returned.notice'])).toBeTruthy();
    expect((screen.getByRole('link', { name: vi_['doc.review.returned.next'] }) as HTMLAnchorElement).getAttribute('href')).toBe(`/doc/doc-02?doc=${FIRST}`);
  });

  it('takes a document with a locked PDF back to the draft through its own command, and shows the hash of the PDF that is current', async () => {
    const h = world();
    open(h, [READ, REVIEW], `/?doc=${LOCKED}`);
    const user = userEvent.setup();
    await screen.findByRole('heading', { level: 2, name: 'Title of 203' });
    expect(screen.getByText(FINAL_SHA)).toBeTruthy();
    expect(screen.queryByText('0'.repeat(64))).toBeNull();
    // Nothing to approve any more: the checklist is gone and the return says what it drops.
    expect(screen.queryByRole('button', { name: vi_['doc.review.approve.action'] })).toBeNull();
    expect(screen.getByText(vi_['doc.review.return.locked'])).toBeTruthy();
    await user.type(screen.getByLabelText(vi_['doc.review.return.reason.label']), 'The signer changed, please redraft');
    await user.click(screen.getByRole('button', { name: vi_['doc.review.return.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('returnOutgoingDocument', expect.objectContaining({ ifMatchVersion: 5, path: { id: LOCKED }, body: { reason: 'The signer changed, please redraft' } })));
  });

  it('chooses another document from the queue and starts its review over', async () => {
    open(world());
    const user = userEvent.setup();
    await screen.findByRole('heading', { level: 2, name: 'Title of 201' });
    await user.click(screen.getByLabelText(vi_['doc.review.checklist.motto']));
    expect((screen.getByLabelText(vi_['doc.review.checklist.motto']) as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByRole('link', { name: 'Title of 204' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Title of 204' })).toBeTruthy();
    expect((screen.getByLabelText(vi_['doc.review.checklist.motto']) as HTMLInputElement).checked).toBe(false);
  });

  it('offers a reader the document and its history, and nothing to decide', async () => {
    open(world(), [READ], `/?doc=${FIRST}`);
    await screen.findByRole('heading', { level: 2, name: 'Title of 201' });
    expect(screen.queryByRole('button', { name: vi_['doc.review.approve.action'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['doc.review.return.action'] })).toBeNull();
    expect(screen.getByLabelText(vi_['doc.review.checklist.motto']).matches(':disabled')).toBe(true);
  });

  it('lets the server decide while the grants are not known, and offers nothing while the tenant is suspended', async () => {
    mountInSession(<OutgoingReviewScreen route={ROUTE} />, world(), { permissions: undefined }, `/?doc=${FIRST}`);
    await screen.findByRole('heading', { level: 2, name: 'Title of 201' });
    expect(screen.getByRole('button', { name: vi_['doc.review.approve.action'] })).toBeTruthy();
    cleanup();
    mountInSession(<OutgoingReviewScreen route={ROUTE} />, world(), { permissions: [READ, REVIEW], mode: 'READ_ONLY' }, `/?doc=${FIRST}`);
    await screen.findByRole('heading', { level: 2, name: 'Title of 201' });
    expect(screen.getByText(vi_['doc.review.frozen.notice'])).toBeTruthy();
    expect(screen.queryByRole('button', { name: vi_['doc.review.approve.action'] })).toBeNull();
  });

  it('starts over when the tenant changes: the checklist of the first tenant never reaches the second', async () => {
    const h = world();
    const view = mountInSession(<OutgoingReviewScreen route={ROUTE} />, h, { permissions: [READ, REVIEW], tenant: TENANT }, `/?doc=${FIRST}`);
    const user = userEvent.setup();
    await screen.findByRole('heading', { level: 2, name: 'Title of 201' });
    await user.click(screen.getByLabelText(vi_['doc.review.checklist.motto']));
    view.rerenderWith({ permissions: [READ, REVIEW], tenant: SECOND_TENANT });
    await waitFor(() => expect((screen.getByLabelText(vi_['doc.review.checklist.motto']) as HTMLInputElement).checked).toBe(false));
  });

  it('says that the chosen document cannot be read, without losing the queue', async () => {
    open(world(), [READ, REVIEW], '/?doc=00000000-0000-4000-8000-0000000009ff');
    expect(await screen.findByText(vi_['doc.draft.problem.notFound'])).toBeTruthy();
    expect(screen.getByRole('list', { name: vi_['doc.review.queue.title'] })).toBeTruthy();
  });

  describe('UI-DOC-04: the standard states', () => {
    it.each([
      ['empty', { items: [], next_cursor: null }, vi_['states.empty.title']],
      ['denied', problem('SCOPE_DENIED', 403), vi_['states.denied.title']],
      ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      ['error', problem('INTERNAL_ERROR', 500), vi_['states.error.title']],
      ['signed out', problem('SESSION_EXPIRED', 401), vi_['states.signedOut.title']],
    ])('UI-DOC-04: shows the %s state of the queue', async (_name, queue, title) => {
      open(world({ queue }));
      expect(await screen.findByText(title)).toBeTruthy();
    });

    it('UI-DOC-04: shows the loading state first and names the page for assistive technology', async () => {
      mount(<OutgoingReviewScreen route={ROUTE} />, harness(() => new Promise(() => undefined)), [READ, REVIEW]);
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name: vi_['doc.review.page.title'] })).toBeTruthy();
    });

    it('UI-DOC-04: gives every field, item and action of the loaded screen an accessible name', async () => {
      open(world(), [READ, REVIEW], `/?doc=${FIRST}`);
      await screen.findByRole('heading', { level: 2, name: 'Title of 201' });
      for (const control of [...screen.getAllByRole('checkbox'), ...screen.getAllByRole('textbox')]) expect((control as HTMLInputElement).labels?.length).toBeGreaterThan(0);
      expect(screen.getAllByRole('checkbox')).toHaveLength(8);
      for (const action of screen.getAllByRole('button')) expect((action.getAttribute('aria-label') ?? action.textContent ?? '').trim().length).toBeGreaterThan(0);
      expect(screen.getByRole('group', { name: vi_['doc.review.checklist.title'] })).toBeTruthy();
    });

    it('UI-DOC-04: retries the queue after an error', async () => {
      let failing = true;
      const good = world();
      const h = harness((operation, input) =>
        operation === 'listOutgoingDocuments' && failing ? problem('INTERNAL_ERROR', 500) : (good.read as unknown as (o: string, i: unknown) => unknown)(operation, input),
      );
      mount(<OutgoingReviewScreen route={ROUTE} />, h, [READ, REVIEW]);
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      failing = false;
      await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      expect(await screen.findByRole('list', { name: vi_['doc.review.queue.title'] })).toBeTruthy();
    });
  });
});
