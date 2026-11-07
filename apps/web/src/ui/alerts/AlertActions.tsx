import { useTranslation } from '../../i18n';
import type { AlertItem } from './types';
import './alerts.css';

export interface AlertActionsProps {
  item: AlertItem;
  /** What the person may do: the caller decides from the item and the permissions; the server decides again. */
  can: { claim: boolean; assign: boolean; snooze: boolean; pause?: boolean };
  onClaim: () => void;
  /** Opens the dialog that asks for the person and the day (the caller owns it). */
  onAssign: () => void;
  /** Opens the dialog that asks why and for how long (the caller owns it). */
  onSnooze: () => void;
  /** Opens the dialog that asks why, who allowed it and until when. Without it the button is not offered. */
  onPause?: () => void;
  /** Runs the clocks again at once. Without it the button is not offered. */
  onResume?: () => void;
  /** A command of this item is running: every button is locked so a second click cannot send it twice. */
  busy?: boolean;
}

/** Whether the clocks of an item are stopped now. */
export const isPaused = (item: AlertItem): boolean => item.pause !== null || item.clocks?.paused != null;

/**
 * Nhận xử lý (Nhận lại when it went silent) · Giao cho · Nhắc lại (a dialog) · Tạm dừng đồng hồ / Chạy lại đồng hồ.
 * An urgent item cannot be snoozed, so it has no such button.
 */
export function AlertActions({ item, can, onClaim, onAssign, onSnooze, onPause, onResume, busy = false }: AlertActionsProps) {
  const { t } = useTranslation();
  const open = item.lifecycle !== 'RESOLVED';
  const reclaim = item.needs_reclaim || item.clocks?.needs_reclaim != null;
  const showClaim = can.claim && open && (item.lifecycle === 'NEW' || reclaim);
  const showAssign = can.assign && open;
  const showSnooze = can.snooze && open && item.severity !== 'URGENT';
  const paused = isPaused(item);
  const showPause = can.pause === true && onPause !== undefined && open && item.clocks !== null && !paused;
  const showResume = can.pause === true && onResume !== undefined && open && paused;
  if (!showClaim && !showAssign && !showSnooze && !showPause && !showResume) return null;
  return (
    <div className="mv-alert-actions" role="group" aria-label={t('alerts.action.group')}>
      {showClaim ? (
        <button type="button" className="mv-alert-button mv-alert-button--primary" disabled={busy} onClick={onClaim}>
          {reclaim ? t('alerts.action.reclaim') : t('alerts.action.claim')}
        </button>
      ) : null}
      {showAssign ? (
        <button type="button" className="mv-alert-button" disabled={busy} onClick={onAssign}>
          {t('alerts.action.assign')}
        </button>
      ) : null}
      {showSnooze ? (
        <button type="button" className="mv-alert-button" disabled={busy} aria-haspopup="dialog" onClick={onSnooze}>
          {t('alerts.action.snooze')}
        </button>
      ) : null}
      {showPause ? (
        <button type="button" className="mv-alert-button" disabled={busy} aria-haspopup="dialog" onClick={onPause}>
          {t('alerts.action.pause')}
        </button>
      ) : null}
      {showResume ? (
        <button type="button" className="mv-alert-button" disabled={busy} onClick={onResume}>
          {t('alerts.action.resume')}
        </button>
      ) : null}
    </div>
  );
}
