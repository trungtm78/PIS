import { useEffect, useRef, useState } from 'react';
import type { FormEvent, RefObject } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from '../i18n';
import type { SessionUser } from '../session/SessionContext';
import { AlertBell } from '../ui/alerts';
import { Breadcrumb } from './Breadcrumb';
import { HelpButton } from './HelpDrawer';
import { Icon } from './Icon';

export interface TopBarProps {
  module: string | undefined;
  title: string;
  /** The screen id to pin; undefined when the address is not a screen. */
  screenId: string | undefined;
  pinned: boolean;
  helpPath: string | undefined;
  /** The global search screen (IAM-07); the quick search box is not offered without it. */
  searchPath?: string | undefined;
  /** The account screen (IAM-05) the avatar opens; the avatar is not offered without a user. */
  accountPath?: string | undefined;
  user?: SessionUser | undefined;
  period: string;
  drawerOpen: boolean;
  menuButton: RefObject<HTMLButtonElement>;
  onOpenDrawer(): void;
  onOpenModule(): void;
  onTogglePin(): void;
}

/** The address of the search screen for a keyword; an empty keyword opens the screen with nothing asked. */
function searchAddress(path: string, keyword: string): string {
  const asked = keyword.trim();
  return asked === '' ? path : `${path}?${new URLSearchParams({ q: asked }).toString()}`;
}

/**
 * The bar above every screen: drawer button, breadcrumb, quick search ("Quick record search", Ctrl K), reporting period,
 * pin, help and the avatar of the account. The title of the page and its context line belong to the screen below it.
 */
export function TopBar(props: TopBarProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [keyword, setKeyword] = useState('');
  const { searchPath } = props;
  const pinLabel = props.pinned ? t('shell.nav.unpin.label') : t('shell.nav.pin.label');

  // Ctrl K (Cmd K) goes to the search box; when the box is not on screen (narrow bar) it opens the search screen instead.
  useEffect(() => {
    if (searchPath === undefined) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 'k' || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
      const box = input.current;
      // `getClientRects` is empty for an element that is not rendered (display: none on a narrow screen).
      if (box !== null && box.getClientRects().length > 0) box.focus();
      else navigate(searchAddress(searchPath, ''));
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [searchPath, navigate]);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (searchPath === undefined) return;
    navigate(searchAddress(searchPath, keyword));
    setKeyword('');
  };

  const user = props.user;
  return (
    <header className="topbar workspace-topbar">
      <button
        type="button"
        className="workspace-menu-toggle"
        ref={props.menuButton}
        onClick={props.onOpenDrawer}
        aria-label={t('shell.nav.open.label')}
        aria-controls="workspace-sidebar"
        aria-expanded={props.drawerOpen}
      >
        <Icon name="menu" />
      </button>
      <Breadcrumb module={props.module} title={props.title} onOpenModule={props.onOpenModule} />
      {searchPath === undefined ? null : (
        <>
          <form className="topbar-search" role="search" onSubmit={submit}>
            <Icon name="search" />
            <label className="sr-only" htmlFor="topbar-search-input">
              {t('shell.search.field.label')}
            </label>
            <input
              id="topbar-search-input"
              ref={input}
              type="search"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder={t('shell.search.field.placeholder')}
              autoComplete="off"
              enterKeyHint="search"
            />
            <kbd aria-hidden="true">{t('shell.search.field.hint')}</kbd>
          </form>
          <Link className="topbar-search-link" to={searchAddress(searchPath, '')} aria-label={t('shell.search.link.label')}>
            <Icon name="search" />
          </Link>
        </>
      )}
      <div className="page-utilities" role="group" aria-label={t('shell.topbar.actions.label')}>
        <span className="period-label">{props.period}</span>
        {props.screenId === undefined ? null : (
          <button type="button" id="pin-current-screen" onClick={props.onTogglePin} aria-label={pinLabel} aria-pressed={props.pinned} title={t('shell.nav.pin.title')}>
            <Icon name="star" />
          </button>
        )}
        <HelpButton screenId={props.screenId} title={props.title} helpCentrePath={props.helpPath} />
      </div>
      <AlertBell />
      {user === undefined || props.accountPath === undefined ? null : (
        <Link to={props.accountPath} className="topbar-avatar" aria-label={t('shell.topbar.account.label', { initials: user.initials, name: user.displayName })}>
          {user.initials}
        </Link>
      )}
    </header>
  );
}
