import { useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { MemberOption } from '../../screens/dgv/model';
import { useSession } from '../../session/SessionContext';
import { PolicyFailed, PolicyLoading } from './DialogParts';
import { addDays, lastMorningBefore, morningOf, nextDay, todayOf } from './format';
import { useFocusTrap } from './focus';
import { useAssignees, useWorkClockPolicies } from './hooks';
import { NOTE_MIN_LENGTH, pauseReasonLabel } from './reasons';
import { refusalText } from './refusals';
import type { AlertItem } from './types';
import './alerts.css';

const DAY_MS = 86_400_000;

export interface PauseSubmit {
  allowedBy: MemberOption;
  reasonCode: string;
  reason: string;
  /** The moment the clock runs again, ISO. */
  until: string;
}

export interface PauseDialogProps {
  item: AlertItem;
  pending: boolean;
  error: unknown;
  onSubmit: (value: PauseSubmit) => void;
  onCancel: () => void;
  now?: Date;
}

/**
 * The dialog that stops the clocks of an item: why (a reason of the clock policy), the words that explain it, the person who allowed it (another member than the one who asks) and the day the clock runs again, not
 * further away than the policy allows. The server decides again and its refusal is said here.
 */
export function PauseDialog({ item, pending, error, onSubmit, onCancel, now }: PauseDialogProps) {
  const { t } = useTranslation();
  const me = useSession().tenant?.membershipId;
  const titleId = useId();
  const reasonId = useId();
  const noteId = useId();
  const personId = useId();
  const dayId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const policies = useWorkClockPolicies();
  const people = useAssignees(true);
  const [opened] = useState(() => now ?? new Date());
  const [reasonCode, setReasonCode] = useState('');
  const [reason, setReason] = useState('');
  const [person, setPerson] = useState('');
  const [day, setDay] = useState('');
  const [tried, setTried] = useState(false);
  useFocusTrap(dialog, true, { onEscape: onCancel });

  const policy = policies.data?.clock ?? undefined;
  const maxDays = policy?.max_pause_days ?? 0;
  const firstDay = nextDay(todayOf(opened));
  const lastDay = maxDays > 0 ? lastMorningBefore(new Date(opened.getTime() + maxDays * DAY_MS)) : addDays(firstDay, -1);
  const dayOk = lastDay >= firstDay;
  const candidates = (people.data ?? []).filter((member) => member.id !== me);

  const reasonMissing = reasonCode === '';
  const reasonShort = reason.trim().length < NOTE_MIN_LENGTH;
  const personMissing = person === '';
  const dayMissing = day === '' || day < firstDay || day > lastDay;
  const usable = policy !== undefined && policy.pause_reasons.length > 0 && dayOk;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (pending || !usable) return;
    setTried(true);
    const allowedBy = candidates.find((member) => member.id === person);
    if (reasonMissing || reasonShort || allowedBy === undefined || dayMissing) return;
    onSubmit({ allowedBy, reasonCode, reason: reason.trim(), until: morningOf(day) });
  };
  const refused = refusalText(t, 'pause', error);

  return (
    <div ref={dialog} className="mv-alert-dialog mv-alert-dialog--wide" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-testid="pause-dialog">
      <form onSubmit={submit} noValidate>
        <h3 id={titleId}>{t('alerts.pause.title')}</h3>
        <p className="mv-alert-dialog__item">{item.title}</p>
        {policies.isError ? <PolicyFailed onRetry={() => void policies.refetch()} /> : null}
        {policies.isSuccess && !usable ? (
          <p className="mv-alert-banner" data-tone="warning" role="status" data-testid="pause-no-policy">
            {t('alerts.pause.noPolicy')}
          </p>
        ) : null}
        {people.isError ? (
          <p className="mv-alert-banner" data-tone="warning" role="alert">
            {t('alerts.assign.lookupFailed')}
          </p>
        ) : null}
        {refused === undefined ? null : (
          <p className="mv-alert-banner" data-tone="danger" role="alert" data-testid="pause-refused">
            {refused}
          </p>
        )}
        {policies.isPending ? <PolicyLoading /> : null}
        {policy === undefined ? null : (
          <fieldset disabled={pending || !usable}>
            <div className="mv-alert-field">
              <label htmlFor={reasonId}>{t('alerts.pause.reason')}</label>
              <select id={reasonId} value={reasonCode} aria-invalid={tried && reasonMissing} onChange={(event) => setReasonCode(event.target.value)}>
                <option value="">{t('alerts.pause.reasonChoose')}</option>
                {policy.pause_reasons.map((code) => (
                  <option key={code} value={code}>
                    {pauseReasonLabel(t, code)}
                  </option>
                ))}
              </select>
              {tried && reasonMissing ? <span className="mv-alert-field__error">{t('alerts.pause.reasonRequired')}</span> : null}
            </div>
            <div className="mv-alert-field">
              <label htmlFor={noteId}>{t('alerts.pause.note')}</label>
              <textarea id={noteId} rows={3} value={reason} aria-required="true" aria-invalid={tried && reasonShort} onChange={(event) => setReason(event.target.value)} />
              {tried && reasonShort ? <span className="mv-alert-field__error">{t('alerts.pause.noteTooShort', { min: NOTE_MIN_LENGTH })}</span> : null}
            </div>
            <div className="mv-alert-field">
              <label htmlFor={personId}>{t('alerts.pause.allowedBy')}</label>
              <select id={personId} value={person} aria-invalid={tried && personMissing} onChange={(event) => setPerson(event.target.value)}>
                <option value="">{t('alerts.pause.allowedByChoose')}</option>
                {candidates.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
              {tried && personMissing ? <span className="mv-alert-field__error">{t('alerts.pause.allowedByRequired')}</span> : null}
            </div>
            <div className="mv-alert-field">
              <label htmlFor={dayId}>{t('alerts.pause.until')}</label>
              <input id={dayId} type="date" value={day} min={firstDay} max={lastDay} aria-invalid={tried && dayMissing} onChange={(event) => setDay(event.target.value)} />
              {tried && dayMissing ? <span className="mv-alert-field__error">{t('alerts.pause.untilRequired')}</span> : null}
              <span className="mv-alert-muted" data-testid="pause-limit-line">
                {t('alerts.pause.limitLine', { days: maxDays })}
              </span>
            </div>
            <p className="mv-alert-muted">{policy.unverified ? t('alerts.pause.policyUnverified', { version: policy.version }) : t('alerts.pause.policy', { version: policy.version })}</p>
          </fieldset>
        )}
        <div className="mv-alert-dialog__foot">
          <button type="button" className="mv-alert-button" onClick={onCancel}>
            {t('alerts.assign.cancel')}
          </button>
          <button type="submit" className="mv-alert-button mv-alert-button--primary" disabled={pending || !usable}>
            {pending ? t('alerts.pause.pending') : t('alerts.pause.submit')}
          </button>
        </div>
      </form>
    </div>
  );
}
