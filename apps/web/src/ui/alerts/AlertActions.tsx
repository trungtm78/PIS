import { useId, useState } from 'react';
import { useTranslation } from '../../i18n';
import { todayOf } from './format';
import type { AlertItem } from './types';
import './alerts.css';

export type SnoozeChoice = { kind: 'hour' } | { kind: 'tomorrow' } | { kind: 'date'; day: string };

export interface AlertActionsProps {
  item: AlertItem;
  /** What the person may do: the caller decides from the item and the permissions; the server decides again. */
  can: { claim: boolean; assign: boolean; snooze: boolean };
  onClaim: () => void;
  /** Opens the dialog that asks for the person and the day (the caller owns it). */
  onAssign: () => void;
  onSnooze: (choice: SnoozeChoice) => void;
  /** A command of this item is running: every button is locked so a second click cannot send it twice. */
  busy?: boolean;
}

/** Nhận xử lý · Giao cho · Nhắc lại (1 giờ / sáng mai / chọn ngày). An urgent item cannot be snoozed, so it has no such button. */
export function AlertActions({ item, can, onClaim, onAssign, onSnooze, busy = false }: AlertActionsProps) {
  const { t } = useTranslation();
  const menuId = useId();
  const dayId = useId();
  const [menu, setMenu] = useState(false);
  const [picking, setPicking] = useState(false);
  const [day, setDay] = useState('');
  const open = item.lifecycle !== 'RESOLVED';
  const showClaim = can.claim && item.lifecycle === 'NEW';
  const showAssign = can.assign && open;
  const showSnooze = can.snooze && open && item.severity !== 'URGENT';
  if (!showClaim && !showAssign && !showSnooze) return null;
  const today = todayOf();
  const choose = (choice: SnoozeChoice): void => {
    setMenu(false);
    setPicking(false);
    setDay('');
    onSnooze(choice);
  };
  return (
    <div className="mv-alert-actions" role="group" aria-label={t('alerts.action.group')}>
      {showClaim ? (
        <button type="button" className="mv-alert-button mv-alert-button--primary" disabled={busy} onClick={onClaim}>
          {t('alerts.action.claim')}
        </button>
      ) : null}
      {showAssign ? (
        <button type="button" className="mv-alert-button" disabled={busy} onClick={onAssign}>
          {t('alerts.action.assign')}
        </button>
      ) : null}
      {showSnooze ? (
        <span className="mv-alert-snooze">
          <button type="button" className="mv-alert-button" disabled={busy} aria-expanded={menu} aria-controls={menuId} onClick={() => setMenu((current) => !current)}>
            {t('alerts.action.snooze')}
          </button>
          {menu ? (
            <span id={menuId} className="mv-alert-snooze__menu" role="group" aria-label={t('alerts.snooze.menu')}>
              <button type="button" className="mv-alert-button" disabled={busy} onClick={() => choose({ kind: 'hour' })}>
                {t('alerts.snooze.hour')}
              </button>
              <button type="button" className="mv-alert-button" disabled={busy} onClick={() => choose({ kind: 'tomorrow' })}>
                {t('alerts.snooze.tomorrow')}
              </button>
              <button type="button" className="mv-alert-button" disabled={busy} aria-expanded={picking} onClick={() => setPicking((current) => !current)}>
                {t('alerts.snooze.pick')}
              </button>
              {picking ? (
                <span className="mv-alert-snooze__date">
                  <label htmlFor={dayId}>{t('alerts.snooze.date')}</label>
                  <input id={dayId} type="date" value={day} min={today} {...(item.due_on === null ? {} : { max: item.due_on })} onChange={(event) => setDay(event.target.value)} />
                  <button type="button" className="mv-alert-button mv-alert-button--primary" disabled={busy || day === ''} onClick={() => choose({ kind: 'date', day })}>
                    {t('alerts.snooze.confirm')}
                  </button>
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
