import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { helpFor, loadHelpIndex } from '../help/help-index';
import type { ScreenHelp } from '../help/help-index';
import { useTranslation } from '../i18n';
import { Icon } from './Icon';
import { NavigationDialog } from './NavigationDialog';
import './help-drawer.css';

export interface HelpButtonProps {
  /** The id of the screen the address shows; undefined when the address is not a screen. */
  screenId: string | undefined;
  /** The title of the page, as the breadcrumb says it. */
  title: string;
  /** The help centre screen (IAM-08); the drawer links to it when given. */
  helpCentrePath?: string | undefined;
}

type State = { status: 'loading' } | { status: 'error' } | { status: 'ready'; help: ScreenHelp | undefined };

/** A key press that is typing: the `?` shortcut must not take it. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return true;
  return ['textbox', 'combobox', 'searchbox'].includes(target.getAttribute('role') ?? '');
}

/**
 * The "?" button of the top bar (YCK.08): it opens the guide of the screen the person is looking at in a drawer. The text comes from the generated help file of the
 * language (scripts/help-index.mjs), read when the drawer first opens. Keyboard: the button, or the `?` key outside a field, opens it; Escape closes it and gives the focus
 * back; Tab stays inside while it is open.
 */
export function HelpButton({ screenId, title, helpCentrePath }: HelpButtonProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== '?' || event.repeat || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
      // Another dialog (not this drawer) is open: the key belongs to it.
      const foreign = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].some((dialog) => dialog.closest('#screen-help') === null);
      if (foreign) return;
      event.preventDefault();
      setOpen((value) => !value);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // A new address is a new screen: the drawer of the old one closes.
  useEffect(() => setOpen(false), [screenId]);

  return (
    <>
      <button
        type="button"
        id="open-screen-help"
        onClick={() => setOpen(true)}
        aria-label={t('shell.help.open.label')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-keyshortcuts="?"
        title={t('shell.help.open.title')}
      >
        <Icon name="help" />
      </button>
      {open ? <HelpDrawer screenId={screenId} title={title} helpCentrePath={helpCentrePath} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

interface HelpDrawerProps extends HelpButtonProps {
  onClose(): void;
}

function HelpDrawer({ screenId, title, helpCentrePath, onClose }: HelpDrawerProps) {
  const { t, locale } = useTranslation();
  const headingId = useId();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const body = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    let current = true;
    setState({ status: 'loading' });
    loadHelpIndex(locale).then(
      (index) => {
        if (current) setState({ status: 'ready', help: helpFor(index, screenId) });
      },
      () => {
        if (current) setState({ status: 'error' });
      },
    );
    return () => {
      current = false;
    };
  }, [locale, screenId]);
  // `attempt` makes the retry button read again.
  useEffect(() => load(), [load, attempt]);

  return (
    <NavigationDialog className="help-drawer" id="screen-help" onClose={onClose}>
      <aside className="help-drawer__panel" role="dialog" aria-modal="true" aria-labelledby={headingId}>
        <header className="help-drawer__head">
          <h2 id={headingId}>{t('shell.help.drawer.title', { screen: title })}</h2>
          <button type="button" className="help-drawer__close" onClick={onClose} aria-label={t('shell.help.close.label')}>
            <Icon name="close" />
          </button>
        </header>
        <div className="help-drawer__body" ref={body} tabIndex={0} role="region" aria-labelledby={headingId}>
          {state.status === 'loading' ? (
            <p role="status" className="help-drawer__note">
              {t('shell.help.loading.text')}
            </p>
          ) : null}
          {state.status === 'error' ? (
            <div role="alert" className="help-drawer__note">
              <p>{t('shell.help.error.text')}</p>
              <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => {
                  // The button is replaced by the loading note: keep the focus inside the drawer so Escape and Tab still work.
                  body.current?.focus();
                  setAttempt((value) => value + 1);
                }}>
                {t('shell.help.retry.label')}
              </button>
            </div>
          ) : null}
          {state.status === 'ready' && state.help === undefined ? <p className="help-drawer__note">{t('shell.help.missing.text')}</p> : null}
          {state.status === 'ready' && state.help !== undefined ? <HelpContent help={state.help} /> : null}
        </div>
        {helpCentrePath === undefined ? null : (
          <footer className="help-drawer__foot">
            <Link to={helpCentrePath} onClick={onClose}>
              {t('shell.help.centre.label')}
            </Link>
          </footer>
        )}
      </aside>
    </NavigationDialog>
  );
}

function HelpContent({ help }: { help: ScreenHelp }) {
  const { t } = useTranslation();
  return (
    <div className="help-drawer__content" lang={help.locale} data-screen={help.id}>
      <p className="help-drawer__purpose">
        {help.moduleName}. {help.purpose}
      </p>
      <section>
        <h3>{t('shell.help.audience.heading')}</h3>
        <p>{help.audience}</p>
      </section>
      <section>
        <h3>{t('shell.help.steps.heading')}</h3>
        <ol>
          {help.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </section>
      <section>
        <h3>{t('shell.help.fields.heading')}</h3>
        <ul>
          {help.fields.map((field) => (
            <li key={field}>{field}</li>
          ))}
        </ul>
      </section>
      {help.rule === undefined ? null : (
        <section>
          <h3>{t('shell.help.rule.heading')}</h3>
          <p>{help.rule}</p>
        </section>
      )}
      {help.chapter === undefined ? null : (
        <section>
          <h3>{t('shell.help.chapter.heading')}</h3>
          <p>{help.chapter.title}</p>
        </section>
      )}
      <section>
        <h3>{t('shell.help.tips.heading')}</h3>
        <ul>
          {help.tips.map((tip) => (
            <li key={tip}>{tip}</li>
          ))}
        </ul>
      </section>
      <p className="help-drawer__ref">{help.req}</p>
    </div>
  );
}
