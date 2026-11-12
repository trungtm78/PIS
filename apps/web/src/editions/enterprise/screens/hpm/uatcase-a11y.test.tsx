import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { translator } from '../../../../i18n';
import { describeViolations, seriousViolations } from '../../../../test/axe';
import { HPM_ADMIN, hpmClient, hpmConnection, hpmCorrection, hpmFailed, hpmPush, hpmRoute, mount, uuid } from '../shared/test-support';
import CorrectionScreen from './CorrectionScreen';
import PushLogScreen from './PushLogScreen';

const word = (key: string, params: Record<string, string | number> = {}): string => translator.t(key, params);
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
});

/** The three states of a push the case names: one failed, one written and waiting for the receipt, one accepted with its receipt. */
const pushes = () => [
  hpmPush(1),
  hpmFailed(2),
  hpmPush(3, { status: 'ACCEPTED', receipt: { outcome: 'ACCEPTED', reference: 'HPM-R-3', note: null, recorded_by_name: 'Pham Van Cuong', recorded_at: '2026-11-08T02:00:00.000Z' }, response: null }, { may_retry: false, may_record_receipt: false }),
];

const mountLog = () => mount(<PushLogScreen route={hpmRoute('HPM-01')} />, hpmClient({ connection: hpmConnection(), pushes: pushes(), corrections: [] }), { permissions: HPM_ADMIN });

/** HPM A11Y: the case of the two HPM screens stays with a person for what a screen reader says aloud; what a machine can prove of it is here. */
describe('HPM A11Y: the push log (HPM-01) and the corrections (HPM-02) with data in every state', () => {
  it('HPM A11Y HPM-01 says failed, written and accepted in words, carries the PENDING-EXTERNAL band as text in the accessibility tree, and has no serious axe violation', async () => {
    mountLog();
    const table = await screen.findByRole('table', { name: word('hpm.log.section.title') });
    expect(table.textContent).toContain(word('hpm.push.status.failed'));
    expect(table.textContent).toContain(word('hpm.push.status.written'));
    expect(table.textContent).toContain(word('hpm.push.status.accepted'));
    const band = await screen.findByTestId('pending-list');
    expect(band.textContent?.length).toBeGreaterThan(0);
    expect(band.closest('[aria-hidden="true"]')).toBeNull();
    expect(screen.getAllByText(word('ent.acceptance.pending.badge')).length).toBeGreaterThan(0);
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });

  it('HPM A11Y HPM-01 Tab visits the controls in the order of the layout (no positive tabindex) and the receipt dialog is left with Escape, the focus going back to the button that opened it', async () => {
    mountLog();
    await screen.findByRole('table', { name: word('hpm.log.section.title') });
    const user = userEvent.setup();
    const inOrder = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => element.tabIndex === 0);
    expect(Array.from(document.querySelectorAll('[tabindex]')).filter((element) => Number(element.getAttribute('tabindex')) > 0)).toEqual([]);
    document.body.focus();
    const visited: Element[] = [];
    for (let stop = 0; stop < inOrder.length; stop += 1) {
      await user.tab();
      visited.push(document.activeElement as Element);
    }
    expect(visited).toEqual(inOrder);

    const opener = screen.getByTestId(`receipt-${uuid(1)}`);
    opener.focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: word('hpm.receipt.dialog.title') })).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it('HPM A11Y HPM-02 lists the corrections in a table with column headers, says the state in words and has no serious axe violation', async () => {
    mount(
      <CorrectionScreen route={hpmRoute('HPM-02')} />,
      hpmClient({ connection: hpmConnection(), pushes: [], corrections: [hpmCorrection(1), hpmCorrection(2, { state: 'APPROVED', decided_by_name: 'Pham Van Cuong', decided_at: '2026-11-07T02:00:00.000Z', version: 2 }, { may_decide: false })] }),
      { permissions: HPM_ADMIN },
    );
    const table = await screen.findByRole('table', { name: word('hpm.correction.section.title') });
    expect(within(table).getAllByRole('columnheader').length).toBeGreaterThan(3);
    expect(table.textContent).toContain(word('hpm.correction.state.proposed'));
    expect(table.textContent).toContain(word('hpm.correction.state.approved'));
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });

  it('negative control: the axe helper reports a link without a name', async () => {
    document.body.innerHTML = '<main><h1>t</h1><a href="#x"></a></main>';
    expect(describeViolations(await seriousViolations(document.body)).join(' ')).toContain('link-name');
  });
});
