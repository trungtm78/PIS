import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import { clockAndDay } from './format';
import { pauseReasonLabel, snoozeReasonLabel } from './reasons';
import type { AlertItem, Clock, ClockState, Pause } from './types';
import './alerts.css';

type T = Translator['t'];

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const STATE_TONE: Readonly<Record<ClockState, 'neutral' | 'info' | 'success' | 'warning' | 'danger'>> = {
  RUNNING: 'neutral',
  PAUSED: 'info',
  MET: 'success',
  MET_LATE: 'warning',
  BREACHED: 'danger',
};

/** "2 days 3 hours", "5 hours 20 minutes", "40 minutes": wall time between two moments, no seconds. */
export function durationText(t: T, milliseconds: number): string {
  const total = Math.max(0, milliseconds);
  const days = Math.floor(total / DAY_MS);
  const hours = Math.floor((total % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((total % HOUR_MS) / MINUTE_MS);
  if (days > 0) return hours > 0 ? t('alerts.clock.duration.days', { days, hours }) : t('alerts.clock.duration.daysOnly', { days });
  if (hours > 0) return minutes > 0 ? t('alerts.clock.duration.hours', { hours, minutes }) : t('alerts.clock.duration.hoursOnly', { hours });
  return minutes > 0 ? t('alerts.clock.duration.minutes', { minutes }) : t('alerts.clock.duration.none');
}

function stateWord(t: T, state: ClockState): string {
  switch (state) {
    case 'RUNNING':
      return t('alerts.clock.state.running');
    case 'PAUSED':
      return t('alerts.clock.state.paused');
    case 'MET':
      return t('alerts.clock.state.met');
    case 'MET_LATE':
      return t('alerts.clock.state.metLate');
    case 'BREACHED':
      return t('alerts.clock.state.breached');
  }
}

interface ClockLineProps {
  kind: 'claim' | 'resolve';
  clock: Clock;
  now: Date;
}

/** One clock: its name, its state in words, the moment it is due in Vietnam time and, while it runs or is breached, how long is left or how long past (wall time, "about"). */
function ClockLine({ kind, clock, now }: ClockLineProps) {
  const { t } = useTranslation();
  const due = Date.parse(clock.due_at);
  const known = Number.isFinite(due);
  const running = clock.state === 'RUNNING';
  const breached = clock.state === 'BREACHED';
  return (
    <li className="mv-alert-clock" data-clock={kind} data-state={clock.state}>
      <strong className="mv-alert-clock__name">{kind === 'claim' ? t('alerts.clock.claim') : t('alerts.clock.resolve')}</strong>
      <span className="mv-alert-tag" data-tone={STATE_TONE[clock.state]}>
        {stateWord(t, clock.state)}
      </span>
      {known ? (
        <time className="mv-alert-clock__due" dateTime={clock.due_at}>
          {t('alerts.clock.due', { time: clockAndDay(clock.due_at) })}
        </time>
      ) : null}
      {known && running ? <span className="mv-alert-clock__left">{t('alerts.clock.left', { duration: durationText(t, due - now.getTime()) })}</span> : null}
      {known && breached ? <span className="mv-alert-clock__over">{t('alerts.clock.over', { duration: durationText(t, now.getTime() - due) })}</span> : null}
      {clock.met_at !== null && (clock.state === 'MET' || clock.state === 'MET_LATE') ? <span className="mv-alert-clock__met">{t('alerts.clock.metAt', { time: clockAndDay(clock.met_at) })}</span> : null}
    </li>
  );
}

function pauseLine(t: T, pause: Pause): string {
  const why = pause.reason_code === '' ? pause.reason : pause.reason === '' ? pauseReasonLabel(t, pause.reason_code) : `${pauseReasonLabel(t, pause.reason_code)}: ${pause.reason}`;
  const time = clockAndDay(pause.until);
  return pause.allowed_by === null ? t('alerts.clock.pauseLineNoAllower', { time, reason: why }) : t('alerts.clock.pauseLine', { time, reason: why, name: pause.allowed_by.name });
}

export interface ClockLinesProps {
  item: AlertItem;
  /** The moment "now" is for the time left; the caller owns the clock so the component is a pure function of its props. */
  now?: Date;
  /** Adds the chips (reclaim, snooze, reminders, escalation) and the clock the module keeps: the drawer and the queue do, the band does not. */
  detailed?: boolean;
}

/** True when the item has anything the clock lines would show. */
export function hasClockLines(item: AlertItem, detailed: boolean): boolean {
  if (item.clocks !== null) return true;
  if (!detailed) return false;
  return item.needs_reclaim || item.snooze !== null || (item.reminders?.sent ?? 0) > 0 || item.notices.length > 0 || item.existing_clock !== null || item.pause !== null;
}

/**
 * The clocks of an item in words: "Take up" and "Handle" each with its state, due moment and time left or overdue; the pause with its reason and who allowed it; the chips of what happened to it (needs reclaim, snoozed n of m,
 * reminded k times, reported to the superior); the clock the module already keeps. A working calendar that is not published is said, never shown as "no deadline". No seconds, no live region.
 */
export function ClockLines({ item, now, detailed = false }: ClockLinesProps) {
  const { t } = useTranslation();
  const at = now ?? new Date();
  const clocks = item.clocks;
  const paused = clocks?.paused ?? item.pause;
  const reclaim = item.needs_reclaim || clocks?.needs_reclaim != null;
  const reminded = Math.max(item.reminders?.sent ?? 0, item.notices.filter((notice) => notice.kind === 'REMINDER').length);
  const escalated = item.notices.some((notice) => notice.kind === 'RECLAIM_NOTICE' || notice.kind === 'SNOOZE_FINAL_NOTICE');
  const snooze = item.snooze;
  if (!hasClockLines(item, detailed)) return null;
  const snoozeN = snooze === null ? 0 : (snooze.ordinal ?? Math.max(item.snooze_count, 1));
  const snoozeWhy = snooze === null ? '' : snooze.reason_code === null ? '' : snoozeReasonLabel(t, snooze.reason_code);
  const calendarMissing = clocks !== null && clocks.basis === 'CALENDAR_UNAVAILABLE' && clocks.claim === null && clocks.resolve === null;
  const noStart = clocks !== null && clocks.basis === 'NO_START' && clocks.claim === null && clocks.resolve === null;
  const showChips = detailed && (reclaim || snooze !== null || reminded > 0 || escalated);
  return (
    <div className="mv-alert-clocks" role="group" aria-label={t('alerts.clock.group')} data-testid="clock-lines">
      {clocks !== null && (clocks.claim !== null || clocks.resolve !== null) ? (
        <ul className="mv-alert-clocks__list">
          {clocks.claim === null ? null : <ClockLine kind="claim" clock={clocks.claim} now={at} />}
          {clocks.resolve === null ? null : <ClockLine kind="resolve" clock={clocks.resolve} now={at} />}
        </ul>
      ) : null}
      {calendarMissing ? (
        <p className="mv-alert-clocks__note" data-tone="warning" data-testid="clock-calendar-unavailable">
          {t('alerts.clock.calendarUnavailable')}
        </p>
      ) : null}
      {noStart ? <p className="mv-alert-clocks__note">{t('alerts.clock.noStart')}</p> : null}
      {paused === null ? null : (
        <p className="mv-alert-clocks__note" data-testid="clock-paused">
          {pauseLine(t, paused)}
        </p>
      )}
      {showChips ? (
        <ul className="mv-alert-tags" aria-label={t('alerts.chip.group')}>
          {reclaim ? (
            <li className="mv-alert-tag" data-tone="warning" data-chip="reclaim">
              {t('alerts.chip.reclaim')}
            </li>
          ) : null}
          {snooze === null ? null : (
            <li className="mv-alert-tag" data-tone="info" data-chip="snooze">
              {[snooze.of === null ? t('alerts.chip.snoozeOpen', { n: snoozeN }) : t('alerts.chip.snooze', { n: snoozeN, of: snooze.of }), snoozeWhy].filter((part) => part !== '').join(' · ')}
            </li>
          )}
          {reminded > 0 ? (
            <li className="mv-alert-tag" data-tone="neutral" data-chip="reminded">
              {t('alerts.chip.reminded', { count: reminded })}
            </li>
          ) : null}
          {escalated ? (
            <li className="mv-alert-tag" data-tone="danger" data-chip="escalated">
              {t('alerts.chip.escalated')}
            </li>
          ) : null}
        </ul>
      ) : null}
      {detailed && item.existing_clock !== null ? (
        <p className="mv-alert-clocks__note mv-alert-muted" data-testid="clock-existing">
          {t('alerts.clock.existing', { code: item.existing_clock.code })}
        </p>
      ) : null}
    </div>
  );
}
