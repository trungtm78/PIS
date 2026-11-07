import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from '../i18n';
import { useMediaQuery } from './useMediaQuery';

export interface StickyActionsProps {
  primary: ReactNode;
  secondary?: ReactNode[];
  overflow?: ReactNode[];
}

/** The width at and under which only the primary action stays on the bar (design.md). */
export const STICKY_ACTIONS_NARROW_QUERY = '(max-width: 360px)';

/** The action bar of a form: it stays at the foot of the screen; at 360 px only `primary` stays and the others go in a menu. */
export function StickyActions({ primary, secondary = [], overflow = [] }: StickyActionsProps) {
  const { t } = useTranslation();
  const narrow = useMediaQuery(STICKY_ACTIONS_NARROW_QUERY);
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const inMenu = narrow ? [...secondary, ...overflow] : overflow;
  const inline = narrow ? [] : secondary;

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="ui-sticky" role="group" aria-label={t('ui.stickyActions.label')}>
      {inMenu.length > 0 && (
        <div className="ui-sticky__more">
          <button
            type="button"
            ref={trigger}
            className="ui-button ui-button--outline"
            aria-haspopup="true"
            aria-expanded={open}
            aria-controls={menuId}
            onClick={() => setOpen((value) => !value)}
          >
            {t('ui.stickyActions.more')}
          </button>
          {open && (
            <div className="ui-sticky__menu" id={menuId} role="group" aria-label={t('ui.stickyActions.more')}>
              {inMenu.map((item, position) => (
                <div className="ui-sticky__menu-item" key={position}>
                  {item}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {inline.map((item, position) => (
        <div className="ui-sticky__secondary" key={position}>
          {item}
        </div>
      ))}
      <div className="ui-sticky__primary">{primary}</div>
    </div>
  );
}
