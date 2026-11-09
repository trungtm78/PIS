import { useRef, useState } from 'react';
import { useTranslation } from '../../i18n';
import { useSession } from '../../session/SessionContext';
import { AlertCenter } from './AlertCenter';
import { useAlertCounts, useRefreshOnNotification } from './hooks';
import './alerts.css';

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="mv-alert-bell__icon">
      <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M10 19a2 2 0 0 0 4 0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The button of the top bar, "Needs action": the count of what waits for the person (their own view), by level. It reads only the counts, once a minute, when the window gets focus and when a notification arrives;
 * it never says 0 before the first answer. A click opens the drawer (`AlertCenter`) and Escape brings the focus back here.
 */
export function AlertBell() {
  const { t } = useTranslation();
  // The name starts with the visible label and goes on with the figures in the order they are shown (WCAG 2.5.3, Label in Name): what a person
  // says to a voice control, or reads on the button, is contained in the name that a screen reader reads.
  const label = t('alerts.bell.label');
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const { controlPlane } = useSession();
  const counts = useAlertCounts('mine');
  useRefreshOnNotification();

  const answer = counts.data;
  const stale = counts.isError && answer !== undefined;
  const partial = answer !== undefined && answer.unavailable_sources.length > 0;
  let name: string;
  let value: string;
  if (answer === undefined) {
    name = counts.isError ? t('alerts.bell.nameError', { label }) : t('alerts.bell.nameLoading', { label });
    value = counts.isError ? t('alerts.bell.errorValue') : t('alerts.bell.loadingValue');
  } else {
    const { total, urgent } = answer.counts;
    value = String(total);
    name = total === 0 ? t('alerts.bell.nameNone', { label }) : urgent > 0 ? t('alerts.bell.name', { label, total, urgent }) : t('alerts.bell.nameNoUrgent', { label, total });
  }
  const notes = [partial ? t('alerts.bell.partial') : '', stale ? t('alerts.bell.stale') : ''].filter((note) => note !== '');
  const accessibleName = notes.length === 0 ? name : `${name}, ${notes.join(', ')}`;
  const urgent = answer?.counts.urgent ?? 0;
  const warn = partial || stale || (answer === undefined && counts.isError);
  // The control plane has no work of its own: there is nothing for the bell to count.
  if (controlPlane === true) return null;

  return (
    <>
      <button ref={button} type="button" className="mv-alert-bell" aria-label={accessibleName} aria-haspopup="dialog" aria-expanded={open} data-state={answer === undefined ? (counts.isError ? 'error' : 'loading') : 'ready'} data-urgent={urgent > 0 ? 'true' : 'false'} onClick={() => setOpen(true)}>
        <BellIcon />
        <span className="mv-alert-bell__label" aria-hidden="true">
          {label}
        </span>
        {/* Spaces between the items of the button (not drawn in a flex row): a text reader that joins them reads "Cần xử lý 7 2 khẩn", not "Cần xử lý72 khẩn". */}
        {' '}
        <span className="mv-alert-bell__count" aria-hidden="true">
          {value}
        </span>
        {urgent > 0 ? (
          <>
            {' '}
            <span className="mv-alert-bell__urgent" aria-hidden="true">
              {t('alerts.bell.urgentChip', { urgent })}
            </span>
          </>
        ) : null}
        {warn ? <span className="mv-alert-bell__dot" aria-hidden="true" data-testid="alert-bell-warning" /> : null}
      </button>
      <AlertCenter
        open={open}
        onClose={() => {
          setOpen(false);
          button.current?.focus();
        }}
      />
    </>
  );
}
