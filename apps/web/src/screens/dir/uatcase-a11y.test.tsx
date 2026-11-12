import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { describeViolations, seriousViolations } from '../../test/axe';
import DirectiveDetailScreen from './DirectiveDetailScreen';
import { AS_OF, POLICY, harness, mount, overdueDirective, routeOf, text, uuid } from './test-support';

afterEach(() => cleanup());

const DIRECTIVE_ID = uuid(201);
const EVIDENCE = uuid(501);
const ACTIONS = { assign: false, record_progress: false, request_extension: true, decide_extension: false, close: true, cancel: false, reopen: false };

const overdueDetail = () => ({
  directive: { ...overdueDirective(1), id: DIRECTIVE_ID, version: 4 },
  timeline: [],
  extensions: [],
  evidence: [],
  policy: POLICY,
  actions: ACTIONS,
  as_of: AS_OF,
});

/** The case of the four directive screens (UAT-DIR-A11-01) that a recorded session of one person cannot show on the real stack: the close is offered to a third person only. */
describe('UAT-DIR-A11-01 closing an overdue directive with the keyboard', () => {
  it('UAT-DIR-A11-01 says the overdue state in words, has no serious axe violation with the close dialog open, and the dialog gives the focus back to the button that opened it', async () => {
    const h = harness(() => overdueDetail());
    mount(<DirectiveDetailScreen route={routeOf('DIR-04')} />, h, { permissions: ['directive.read'], path: `/dir/dir-04?directive=${DIRECTIVE_ID}` });
    await screen.findByRole('heading', { level: 1, name: 'GB-2026-001/CD-01' });
    expect(screen.getAllByText(text('dir.status.overdue.label')).length).toBeGreaterThan(0);

    const user = userEvent.setup();
    screen.getByRole('button', { name: text('dir.action.close.action') }).focus();
    await user.keyboard('{Enter}');
    screen.getByLabelText(text('dir.form.documents.label')).focus();
    await user.keyboard(EVIDENCE);
    const review = screen.getByRole('button', { name: text('dir.form.review.action') });
    review.focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: text('dir.confirm.close.title') });
    expect(within(dialog).getByRole('textbox')).toBe(document.activeElement);
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(review);

    await user.keyboard('{Enter}');
    await user.keyboard('Đã bàn giao mặt bằng.');
    within(screen.getByRole('dialog')).getByRole('button', { name: text('dir.confirm.close.action') }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toMatchObject(['closeDirective', { path: { id: DIRECTIVE_ID }, ifMatchVersion: 4, body: { note: 'Đã bàn giao mặt bằng.', evidence_document_version_ids: [EVIDENCE] } }]);
  });

  it('negative control: the axe helper reports a button without a name', async () => {
    document.body.innerHTML = '<main><h1>t</h1><button></button></main>';
    expect(describeViolations(await seriousViolations(document.body)).join(' ')).toContain('button-name');
  });
});
