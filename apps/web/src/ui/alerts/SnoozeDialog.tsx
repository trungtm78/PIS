import { useId, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import { PolicyFailed, PolicyLoading } from './DialogParts';
import { addDays, dayMonth, endOfDay, lastMorningBefore, morningOf, nextDay, todayOf } from './format';
import { useFocusTrap } from './focus';
import { useWorkClockPolicies } from './hooks';
import { NOTE_MIN_LENGTH, snoozeReasonLabel } from './reasons';
import { refusalText } from './refusals';
import type { AlertItem } from './types';
import './alerts.css';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
export interface SnoozeSubmit {
  /** The moment the item comes back, ISO. */
  until: string;
  reasonCode: string;
  note: string;
}

export interface SnoozeDialogProps {
  item: AlertItem;
  pending: boolean;
  /** The failure of the last attempt (the refusal of the server is said in its own words). */
  error: unknown;
  onSubmit: (value: SnoozeSubmit) => void;
  onCancel: () => void;
  /** The moment "now" is for the limits; the caller owns the clock in tests. */
  now?: Date;
}

type Choice = '' | 'hour' | 'tomorrow' | 'date';

/**
 * The dialog that snoozes an item: why (a reason of the policy), a note when the reason asks for one, and for how long, never more than the policy allows for the level of the item nor past its due day.
 * Which reasons, how many days and how many times come from the policy of the tenant; the server decides again and its refusal is said here.
 */
export function SnoozeDialog({ item, pending, error, onSubmit, onCancel, now }: SnoozeDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const reasonId = useId();
  const noteId = useId();
  const dayId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const policies = useWorkClockPolicies();
  const [opened] = useState(() => now ?? new Date());
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote] = useState('');
  const [choice, setChoice] = useState<Choice>('');
  const [day, setDay] = useState('');
  const [tried, setTried] = useState(false);
  useFocusTrap(dialog, true, { onEscape: onCancel });

  const policy = policies.data?.snooze;
  const maxDays = policy?.max_days_by_severity[item.severity] ?? 0;
  const ordinal = item.snooze_count + 1;
  const of = policy?.max_consecutive ?? 0;
  const limitReached = of > 0 && item.snooze_count >= of;
  const finalOne = of > 0 && ordinal === of && policy?.final_notifies_next_level === true;
  const blocked = policy !== undefined && (maxDays <= 0 || limitReached);

  // The furthest moment a snooze may reach: the days of the policy from now, and not past the due day of the item.
  const limit = useMemo(() => {
    const byPolicy = opened.getTime() + maxDays * DAY_MS;
    return new Date(item.due_on === null ? byPolicy : Math.min(byPolicy, endOfDay(item.due_on).getTime()));
  }, [opened, maxDays, item.due_on]);

  const hourAt = new Date(opened.getTime() + HOUR_MS);
  const tomorrowAt = new Date(morningOf(nextDay(todayOf(opened))));
  const hourOk = maxDays > 0 && hourAt.getTime() <= limit.getTime();
  const tomorrowOk = maxDays > 0 && tomorrowAt.getTime() <= limit.getTime();
  const firstDay = nextDay(todayOf(opened));
  const lastDay = maxDays > 0 ? lastMorningBefore(limit) : addDays(firstDay, -1);
  const dayOk = lastDay >= firstDay;

  const until = ((): string | undefined => {
    if (choice === 'hour' && hourOk) return hourAt.toISOString();
    if (choice === 'tomorrow' && tomorrowOk) return tomorrowAt.toISOString();
    if (choice === 'date' && day !== '' && day >= firstDay && day <= lastDay) return morningOf(day);
    return undefined;
  })();

  const noteRequired = policy?.note_required_for.includes(reasonCode) === true;
  const reasonMissing = reasonCode === '';
  const noteMissing = noteRequired && note.trim().length < NOTE_MIN_LENGTH;
  const untilMissing = until === undefined;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (pending || policy === undefined || blocked) return;
    setTried(true);
    if (reasonMissing || noteMissing || untilMissing) return;
    onSubmit({ until, reasonCode, note: note.trim() });
  };
  const refused = refusalText(t, 'snooze', error);

  return (
    <div ref={dialog} className="mv-alert-dialog mv-alert-dialog--wide" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-testid="snooze-dialog">
      <form onSubmit={submit} noValidate>
        <h3 id={titleId}>{t('alerts.snooze.title')}</h3>
        <p className="mv-alert-dialog__item">{item.title}</p>
        {policy === undefined ? null : (
          <p className="mv-alert-dialog__ordinal" data-testid="snooze-ordinal">
            {of > 0 ? t('alerts.snooze.ordinal', { n: Math.min(ordinal, of), of }) : t('alerts.snooze.ordinalOpen', { n: ordinal })}
          </p>
        )}
        {policies.isError ? <PolicyFailed onRetry={() => void policies.refetch()} /> : null}
        {policy !== undefined && maxDays <= 0 ? (
          <p className="mv-alert-banner" data-tone="warning" role="status" data-testid="snooze-not-allowed">
            {t('alerts.snooze.error.notAllowed')}
          </p>
        ) : null}
        {limitReached ? (
          <p className="mv-alert-banner" data-tone="warning" role="status" data-testid="snooze-limit">
            {t('alerts.snooze.limitReached', { of })}
          </p>
        ) : null}
        {finalOne && !limitReached && maxDays > 0 ? (
          <p className="mv-alert-banner" data-tone="warning" role="status" data-testid="snooze-final">
            {t('alerts.snooze.finalWarning')}
          </p>
        ) : null}
        {refused === undefined ? null : (
          <p className="mv-alert-banner" data-tone="danger" role="alert" data-testid="snooze-refused">
            {refused}
          </p>
        )}
        {policies.isPending ? <PolicyLoading /> : null}
        {policy === undefined ? null : (
          <fieldset disabled={pending || blocked}>
            <div className="mv-alert-field">
              <label htmlFor={reasonId}>{t('alerts.snooze.reason')}</label>
              <select id={reasonId} value={reasonCode} aria-invalid={tried && reasonMissing} onChange={(event) => setReasonCode(event.target.value)}>
                <option value="">{t('alerts.snooze.reasonChoose')}</option>
                {policy.reasons.map((code) => (
                  <option key={code} value={code}>
                    {snoozeReasonLabel(t, code)}
                  </option>
                ))}
              </select>
              {tried && reasonMissing ? <span className="mv-alert-field__error">{t('alerts.snooze.reasonRequired')}</span> : null}
            </div>
            <div className="mv-alert-field">
              <label htmlFor={noteId}>{noteRequired ? t('alerts.snooze.noteRequired') : t('alerts.snooze.note')}</label>
              <textarea id={noteId} rows={3} value={note} aria-required={noteRequired} aria-invalid={tried && noteMissing} onChange={(event) => setNote(event.target.value)} />
              {tried && noteMissing ? <span className="mv-alert-field__error">{t('alerts.snooze.noteTooShort', { min: NOTE_MIN_LENGTH })}</span> : null}
            </div>
            <fieldset className="mv-alert-field mv-alert-field--group">
              <legend>{t('alerts.snooze.menu')}</legend>
              <span className="mv-alert-snooze__menu">
                <button type="button" className="mv-alert-button" aria-pressed={choice === 'hour'} disabled={!hourOk} onClick={() => setChoice('hour')}>
                  {t('alerts.snooze.hour')}
                </button>
                <button type="button" className="mv-alert-button" aria-pressed={choice === 'tomorrow'} disabled={!tomorrowOk} onClick={() => setChoice('tomorrow')}>
                  {t('alerts.snooze.tomorrow')}
                </button>
                <button type="button" className="mv-alert-button" aria-pressed={choice === 'date'} disabled={!dayOk} onClick={() => setChoice('date')}>
                  {t('alerts.snooze.pick')}
                </button>
              </span>
              {choice === 'date' ? (
                <span className="mv-alert-snooze__date">
                  <label htmlFor={dayId}>{t('alerts.snooze.date')}</label>
                  <input id={dayId} type="date" value={day} min={firstDay} max={lastDay} aria-invalid={tried && untilMissing} onChange={(event) => setDay(event.target.value)} />
                </span>
              ) : null}
              {tried && untilMissing ? <span className="mv-alert-field__error">{t('alerts.snooze.untilRequired')}</span> : null}
              <span className="mv-alert-muted" data-testid="snooze-limit-line">
                {item.due_on === null ? t('alerts.snooze.limitLine', { days: maxDays }) : t('alerts.snooze.limitLineDue', { days: maxDays, date: dayMonth(item.due_on) })}
              </span>
            </fieldset>
            <p className="mv-alert-muted">{policy.unverified ? t('alerts.snooze.policyUnverified', { version: policy.version }) : t('alerts.snooze.policy', { version: policy.version })}</p>
          </fieldset>
        )}
        <div className="mv-alert-dialog__foot">
          <button type="button" className="mv-alert-button" onClick={onCancel}>
            {t('alerts.assign.cancel')}
          </button>
          <button type="submit" className="mv-alert-button mv-alert-button--primary" disabled={pending || policy === undefined || blocked}>
            {pending ? t('alerts.snooze.pending') : t('alerts.snooze.confirm')}
          </button>
        </div>
      </form>
    </div>
  );
}
