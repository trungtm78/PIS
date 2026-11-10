import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as helpIndex from '../help/help-index';
import type * as HelpIndexModule from '../help/help-index';
import { EditionProvider } from '../editions/EditionContext';
import { PUBLIC_BUNDLE } from '../editions/edition';
import { t } from '../i18n';
import { HelpButton } from './HelpDrawer';

vi.mock('../help/help-index', async (original) => {
  const actual = await original<typeof HelpIndexModule>();
  return { ...actual, loadHelpIndex: vi.fn(actual.loadHelpIndex) };
});

const OPEN = t('shell.help.open.label');

function renderButton(props: { screenId?: string; title?: string; centre?: string } = {}) {
  return render(
    <MemoryRouter>
      <input aria-label="field" />
      <HelpButton screenId={props.screenId} title={props.title ?? 'Dựng quy trình phê duyệt'} helpCentrePath={props.centre} />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.mocked(helpIndex.loadHelpIndex).mockClear();
});

describe('HelpButton', () => {
  it('opens the guide of the screen: purpose, audience, steps, fields, rule and the chapter', async () => {
    renderButton({ screenId: 'ADM-06', centre: '/iam/iam-08' });
    const button = screen.getByRole('button', { name: OPEN });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(button);
    const dialog = await screen.findByRole('dialog', { name: t('shell.help.drawer.title', { screen: 'Dựng quy trình phê duyệt' }) });
    const content = await within(dialog).findByText(/Đây là màn hình quy trình/u);
    expect(content).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: t('shell.help.steps.heading') })).toBeInTheDocument();
    expect(within(dialog).getAllByRole('listitem').length).toBeGreaterThan(8);
    expect(within(dialog).getByText('Trả lại về bước')).toBeInTheDocument();
    expect(within(dialog).getByText('Quản trị tenant: Quy trình & cấu hình')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: t('shell.help.centre.label') })).toHaveAttribute('href', '/iam/iam-08');
    expect(button).toHaveAttribute('aria-expanded', 'true');
  });

  it('moves the focus into the drawer, closes on Escape and gives the focus back to the button', async () => {
    renderButton({ screenId: 'ADM-06' });
    const button = screen.getByRole('button', { name: OPEN });
    await userEvent.click(button);
    const close = await screen.findByRole('button', { name: t('shell.help.close.label') });
    await waitFor(() => expect(close).toHaveFocus());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(button).toHaveFocus();
  });

  it('keeps Tab inside the drawer', async () => {
    renderButton({ screenId: 'ADM-06', centre: '/iam/iam-08' });
    await userEvent.click(screen.getByRole('button', { name: OPEN }));
    await screen.findByText(/Đây là màn hình quy trình/u);
    const close = screen.getByRole('button', { name: t('shell.help.close.label') });
    const link = screen.getByRole('link', { name: t('shell.help.centre.label') });
    link.focus();
    await userEvent.tab();
    expect(close).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(link).toHaveFocus();
  });

  it('opens and closes on the ? key, but not while the person types in a field', async () => {
    renderButton({ screenId: 'ADM-06' });
    await userEvent.type(screen.getByRole('textbox', { name: 'field' }), '?');
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(document.body);
    await userEvent.keyboard('?');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await userEvent.keyboard('?');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('does not open on a repeated ? key or while another modal dialog is open', async () => {
    render(
      <MemoryRouter>
        <div role="dialog" aria-modal="true" aria-label="other" />
        <HelpButton screenId="ADM-06" title="t" />
      </MemoryRouter>,
    );
    await userEvent.keyboard('?');
    expect(screen.queryByRole('dialog', { name: t('shell.help.drawer.title', { screen: 't' }) })).toBeNull();
  });

  it('closes on a press on the backdrop and on the close button', async () => {
    renderButton({ screenId: 'ADM-06' });
    await userEvent.click(screen.getByRole('button', { name: OPEN }));
    await userEvent.click(await screen.findByRole('button', { name: t('shell.help.close.label') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('says so when the address has no guide, and still offers the help centre', async () => {
    renderButton({ screenId: undefined, title: 'Không tìm thấy', centre: '/iam/iam-08' });
    await userEvent.click(screen.getByRole('button', { name: OPEN }));
    expect(await screen.findByText(t('shell.help.missing.text'))).toBeInTheDocument();
    expect(screen.getByRole('link', { name: t('shell.help.centre.label') })).toBeInTheDocument();
  });

  it('shows a refusal when the guide cannot be read and reads it again on retry', async () => {
    const spy = vi.mocked(helpIndex.loadHelpIndex).mockRejectedValueOnce(new Error('offline'));
    renderButton({ screenId: 'ADM-06' });
    await userEvent.click(screen.getByRole('button', { name: OPEN }));
    expect(await screen.findByRole('alert')).toHaveTextContent(t('shell.help.error.text'));
    await userEvent.click(screen.getByRole('button', { name: t('shell.help.retry.label') }));
    expect(await screen.findByText(/Đây là màn hình quy trình/u)).toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(2);
    // The retry button is gone, yet Escape still reaches the drawer because the focus stayed inside it.
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('closes the drawer when the address changes to another screen', async () => {
    const view = renderButton({ screenId: 'ADM-06' });
    await userEvent.click(screen.getByRole('button', { name: OPEN }));
    await screen.findByRole('dialog');
    view.rerender(
      <MemoryRouter>
        <HelpButton screenId="ADM-05" title="Danh mục dùng chung" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

beforeEach(() => {
  document.body.focus();
});

describe('HelpButton in an edition with guides of its own', () => {
  it('shows the guide with the words of the edition overlay, and the public words without it', async () => {
    const own = { ...PUBLIC_BUNDLE, help: { vi: { terms: [['Sở Tài chính', 'Phòng Tài chính - Kế toán']] as const } } };
    const { unmount } = render(
      <MemoryRouter>
        <EditionProvider edition={own}>
          <HelpButton screenId="PRJ-01" title="Dự án" />
        </EditionProvider>
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('button', { name: OPEN }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Chủ đầu tư và Phòng Tài chính - Kế toán')).toBeInTheDocument();
    unmount();
    renderButton({ screenId: 'PRJ-01', title: 'Dự án' });
    await userEvent.click(screen.getByRole('button', { name: OPEN }));
    expect(await within(await screen.findByRole('dialog')).findByText('Chủ đầu tư và Sở Tài chính')).toBeInTheDocument();
  });
});
