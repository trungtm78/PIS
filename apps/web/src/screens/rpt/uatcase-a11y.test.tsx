import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { translator } from '../../i18n';
import base from '../../i18n/vi.json';
import { describeViolations, seriousViolations } from '../../test/axe';
import CatalogueScreen from './CatalogueScreen';
import DeliveryLogScreen from './DeliveryLogScreen';
import DraftScreen from './DraftScreen';
import IssuedScreen from './IssuedScreen';
import { ALL, READER, catalogue, delivery, demoEntry, draft, entry, harness, issue, mount, page, previewOf, routeOf, uuid } from './test/support';

const word = (key: string): string => {
  const found = (base as Record<string, string | undefined>)[key];
  if (found === undefined) throw new Error(`missing key ${key}`);
  return found;
};

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
});

const OPENED = uuid(21);

/** One draft on the screen of the drafts, in the state the case names, opened from the address. */
function mountDraft(current: Record<string, unknown>) {
  const h = harness((operation) => (operation === 'listReportDrafts' ? page([current]) : operation === 'getReportDraft' ? current : {}));
  mount(<DraftScreen route={routeOf('RPT-02', 'FR-RPT-02')} />, h, { permissions: ALL, path: `/?draft=${OPENED}` });
  return h;
}

/** Takes the step of the flow with the keyboard: the button of the step opens the dialog, Escape gives the focus back to the button, Enter on the button of the dialog sends it. */
async function takeStep(action: 'check' | 'approve' | 'issue'): Promise<void> {
  const user = userEvent.setup();
  const opener = await screen.findByTestId(`act-${action}`);
  opener.focus();
  await user.keyboard('{Enter}');
  const dialog = await screen.findByRole('dialog', { name: word(`rpt.draft.confirm.${action}.title`) });
  expect(dialog.contains(document.activeElement)).toBe(true);
  expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(document.activeElement).toBe(opener);
  await user.keyboard('{Enter}');
  const again = await screen.findByRole('dialog', { name: word(`rpt.draft.confirm.${action}.title`) });
  within(again).getByRole('button', { name: word(`rpt.draft.act.${action}`) }).focus();
  await user.keyboard('{Enter}');
}

describe('UAT-RPT-A11-01 the four report screens, a draft taken through the three people with the keyboard alone', () => {
  it('UAT-RPT-A11-01 RPT-01 lists the forms in a table with column headers, a form is generated with the keyboard, and it has no serious axe violation', async () => {
    const h = harness(() => catalogue([entry(), demoEntry({ issuable: true })], { demo_mode: true }), () => ({ outcome: 'CREATED', draft_id: uuid(5), issue_id: null, revision: 1, package_sha256: 'a'.repeat(64), issue_count: 0 }));
    mount(<CatalogueScreen route={routeOf('RPT-01', 'FR-RPT-01')} />, h, { permissions: ALL });
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('columnheader').length).toBeGreaterThan(3);
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
    const user = userEvent.setup();
    const opener = await screen.findByTestId('generate-PVN-MONTHLY');
    opener.focus();
    await user.keyboard('{Enter}');
    await screen.findByTestId('period-fields');
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
    screen.getByTestId('period-year').focus();
    await user.clear(screen.getByTestId('period-year'));
    await user.keyboard('2026');
    screen.getByTestId('period-index').focus();
    await user.clear(screen.getByTestId('period-index'));
    await user.keyboard('10');
    screen.getByRole('button', { name: word('rpt.cat.dialog.confirm') }).focus();
    await user.keyboard('{Enter}');
    expect((await screen.findByTestId('generate-receipt')).textContent).toContain('PVN-MONTHLY');
    expect(h.command).toHaveBeenCalledWith('generateReport', expect.objectContaining({ body: { layout_code: 'PVN-MONTHLY', period: { kind: 'MONTH', year: 2026, index: 10 } } }));
  });

  it('UAT-RPT-A11-01 RPT-02 shows the preview as a table with a caption and row headers in a focusable region, says the state of the draft in words at each step, and no step needs a pointer', async () => {
    const preview = previewOf();
    for (const [state, flags, step] of [
      ['DRAFT', { can_check: true }, 'check'],
      ['CHECKED', { can_approve: true, checked_by_name: 'Trần Thị Bình' }, 'approve'],
      ['APPROVED', { can_issue: true, checked_by_name: 'Trần Thị Bình', approved_by_name: 'Lê Văn Cường' }, 'issue'],
    ] as const) {
      const h = mountDraft(draft(21, { state, version: 3, preview, ...flags }));
      await screen.findByTestId('hash-package');
      const region = screen.getByRole('region', { name: word('rpt.common.preview.region') });
      expect(region.getAttribute('tabindex')).toBe('0');
      const table = within(region).getByRole('table', { name: word('rpt.common.preview.caption') });
      expect(within(table).getAllByRole('rowheader').length).toBeGreaterThan(0);
      // The state of the flow is said in words: the step that is now is named in the list of steps, the others say they come later.
      expect(within(screen.getByTestId('flow')).getAllByRole('listitem').length).toBe(3);
      expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
      await takeStep(step);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe(step === 'check' ? 'checkReport' : step === 'approve' ? 'approveReport' : 'issueReport');
      cleanup();
    }
    mountDraft(draft(21, { state: 'ISSUED', issue_id: uuid(31), checked_by_name: 'B', approved_by_name: 'C', preview }));
    expect((await screen.findByTestId('issued-link')).getAttribute('role')).toBe('status');
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });

  it('UAT-RPT-A11-01 RPT-03 (issued copies) and RPT-04 (delivery log) are tables with column headers and have no serious axe violation', async () => {
    const issued = issue(41);
    mount(
      <IssuedScreen route={routeOf('RPT-03', 'FR-RPT-03')} />,
      harness((operation) => (operation === 'listReportIssues' ? page([issued]) : operation === 'getReportIssue' ? issued : {})),
      { permissions: ALL, path: `/?issue=${issued.id as string}` },
    );
    await screen.findByText('c'.repeat(64));
    // Every file of the copy is taken with a button of its own (a native button: Tab reaches it, Enter and Space press it), named in words.
    const files = screen.getByTestId('files');
    const downloads = within(files).getAllByRole('button', { name: word('rpt.common.file.download') });
    expect(downloads.length).toBe(within(files).getAllByRole('listitem').length);
    for (const button of downloads) {
      expect(button.tagName).toBe('BUTTON');
      expect(button.tabIndex).toBe(0);
    }
    for (const table of screen.getAllByRole('table')) expect(within(table).getAllByRole('columnheader').length).toBeGreaterThan(1);
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
    cleanup();
    mount(<DeliveryLogScreen route={routeOf('RPT-04', 'FR-RPT-04')} />, harness(() => page([delivery(61), delivery(62, { event: 'ACCEPTED', channel: 'EMAIL' })])), { permissions: READER });
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('columnheader').length).toBeGreaterThan(3);
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });

  it('negative control: the axe helper reports an image without a text alternative', async () => {
    document.body.innerHTML = '<main><h1>t</h1><div role="region" tabindex="0"><img src="x"></div></main>';
    expect(describeViolations(await seriousViolations(document.body)).join(' ')).toContain('image-alt');
  });
});
