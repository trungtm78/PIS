import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import vi_ from '../i18n/vi.json';
import { NavigationDialog } from '../shell/NavigationDialog';
import MembersScreen from '../screens/adm/MembersScreen';
import { ADMIN, harness, member, mount, routeOf, unit, UNIT_ONE, UNIT_TWO } from '../screens/adm/members/test-support';
import { StateBoundary } from '../states/StateBoundary';
import type { ScreenState } from '../states/StateBoundary';
import { mockMatchMedia, renderApp } from '../test/render';
import { describeViolations, seriousViolations } from '../test/axe';

const ROUTE = routeOf('ADM-02', 'FR-ADM-02');
const ROWS = [
  member(2, { organization_id: UNIT_TWO, role_codes: ['MEMBER', 'UNIT_ADMIN'] }),
  member(3, { status: 'Suspended', version: 5 }),
  member(4, { status: 'Invited', invitation_status: 'Pending', valid_until: '2027-02-01T00:00:00Z' }),
];
const UNITS = [unit(UNIT_ONE, 'U1', 'Unit one'), unit(UNIT_TWO, 'U2', 'Unit two')];
const STATES: ScreenState[] = ['default', 'loading', 'empty', 'error', 'denied', 'expired', 'signedOut', 'offline'];

/**
 * The viewports of the story: 390 px (a phone), 1280 px, and 1280 px at 200 percent zoom, which lays the page out in 640 CSS px. A DOM without layout has no size of its own, so the viewport is what the
 * page can ask about it: the width of the window and the media queries of the shell (the drawer opens under 980 px).
 */
const VIEWPORTS = [
  { name: '390 px', width: 390 },
  { name: '1280 px', width: 1280 },
  { name: '1280 px at 200 percent zoom (640 px)', width: 640 },
] as const;

function setViewport(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  mockMatchMedia((query) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    const min = /min-width:\s*(\d+)px/.exec(query);
    return (max === null || width <= Number(max[1])) && (min === null || width >= Number(min[1])) && (max !== null || min !== null);
  });
}

afterEach(cleanup);

describe('the checker itself', () => {
  it('AC-ST-KERNEL-032-1 UAT-NFR-ACCESSIBILITY-01: finds a serious violation when there is one, so that a pass means something', async () => {
    const { container } = render(
      <main>
        <img src="logo.png" />
        <button type="button" />
      </main>,
    );
    const found = describeViolations(await seriousViolations(container));
    expect(found.some((line) => line.startsWith('image-alt'))).toBe(true);
    expect(found.some((line) => line.startsWith('button-name'))).toBe(true);
  });
});

describe.each(VIEWPORTS)('the component families at $name', ({ width }) => {
  beforeEach(() => setViewport(width));

  it.each(STATES)('AC-ST-KERNEL-032-1 UAT-NFR-ACCESSIBILITY-01: the %s state of a screen has 0 serious or critical axe violations', async (state) => {
    const { container } = render(
      <main>
        <StateBoundary state={state} onRetry={() => undefined}>
          <h1>Content</h1>
        </StateBoundary>
      </main>,
    );
    expect(describeViolations(await seriousViolations(container))).toEqual([]);
  });

  it('AC-ST-KERNEL-032-1 UAT-NFR-ACCESSIBILITY-01: the table family, with its filter form, has 0 serious or critical axe violations', async () => {
    const view = mount(<MembersScreen route={ROUTE} />, harness({ members: ROWS, units: UNITS }));
    await screen.findByText('Person 2');
    expect(describeViolations(await seriousViolations(view.container))).toEqual([]);
  });

  it('AC-ST-KERNEL-032-1 UAT-NFR-ACCESSIBILITY-01: the dialog family with a form that shows its errors has 0 serious or critical axe violations', async () => {
    mount(<MembersScreen route={ROUTE} />, harness({ members: ROWS, units: UNITS }), { permissions: ADMIN });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: vi_['adm.members.invite.action'] }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText(vi_['adm.members.invite.email.label']), 'not-an-email');
    await user.click(within(dialog).getByRole('button', { name: vi_['adm.members.invite.submit.action'] }));
    expect(within(dialog).getByText(vi_['adm.members.problem.email'])).toBeInTheDocument();
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });

  it('AC-ST-KERNEL-032-1 UAT-NFR-ACCESSIBILITY-01: the shell around a screen (navigation, breadcrumb, tenant switch) has 0 serious or critical axe violations', async () => {
    const view = renderApp('/home/home-01');
    await screen.findAllByRole('navigation');
    expect(describeViolations(await seriousViolations(view.container))).toEqual([]);
  });
});

describe('the dialog family traps focus and gives it back', () => {
  function Opener({ children }: { children?: React.ReactNode }) {
    const [open, setOpen] = useState(false);
    return (
      <div>
        <button type="button" onClick={() => setOpen(true)}>
          open
        </button>
        {open ? (
          <NavigationDialog className="catalog" onClose={() => setOpen(false)}>
            <section role="dialog" aria-modal="true" aria-label="settings">
              <input aria-label="first" />
              <button type="button">middle</button>
              <button type="button">last</button>
              {children}
            </section>
          </NavigationDialog>
        ) : null}
      </div>
    );
  }

  it('AC-ST-KERNEL-032-1 UAT-NFR-ACCESSIBILITY-01: Tab cycles inside the dialog in both directions, Escape closes it, and focus returns to the button that opened it', async () => {
    render(<Opener />);
    const user = userEvent.setup();
    const source = screen.getByRole('button', { name: 'open' });
    await user.click(source);
    const dialog = screen.getByRole('dialog');
    const first = within(dialog).getByLabelText('first');
    const last = within(dialog).getByRole('button', { name: 'last' });
    expect(first).toHaveFocus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
    await user.tab();
    expect(first).toHaveFocus();
    for (let step = 0; step < 6; step += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(source).toHaveFocus();
  });

  it('AC-ST-KERNEL-032-1 UAT-NFR-ACCESSIBILITY-01: the dialog of a screen (suspend a member) keeps focus inside, closes on Escape and returns focus to the row button that opened it', async () => {
    mount(<MembersScreen route={ROUTE} />, harness({ members: ROWS, units: UNITS }));
    await screen.findByText('Person 2');
    const user = userEvent.setup();
    const source = screen.getAllByRole('button', { name: vi_['adm.members.suspend.label'].replace('{name}', 'Person 2') })[0] as HTMLElement;
    await user.click(source);
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    for (let step = 0; step < 8; step += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(source).toHaveFocus();
  });
});
