import { useEffect, useId, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useTranslation } from '../../../i18n';

const FOCUSABLE = 'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])';

export interface SideDrawerProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  testId: string;
}

/**
 * A panel at the side of the table that leaves the table in sight: the caret goes into it on opening and back to where it was on closing, Tab stays inside, Escape closes. Below 900 px it is a sheet over the page.
 * It is not modal for the page behind it (the table is still read while the details are open), so it says `aria-modal="false"`.
 */
export function SideDrawer({ title, onClose, children, testId }: SideDrawerProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.querySelector<HTMLElement>('[data-close]')?.focus();
    return () => before?.focus();
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || panel.current === null) return;
    const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return (
    <aside className="pwfx-drawer" role="dialog" aria-modal="false" aria-labelledby={titleId} ref={panel} onKeyDown={onKeyDown} data-testid={testId}>
      <header className="pwfx-drawer__head">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="ui-button ui-button--outline" data-close onClick={onClose}>
          {t('pwfx.drawer.close')}
        </button>
      </header>
      <div className="pwfx-drawer__body">{children}</div>
    </aside>
  );
}
