import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { DeadlineCountdown, StatusPill } from '../../ui';
import { dueLabel, eventLabel, statusLabel } from './issue-labels';
import { businessDay, dueStateOf, dueToneOf, severityToneOf, statusToneOf } from './issue-model';
import type { IssueEventView, IssueLine, IssueStatus, PersonView } from './issue-model';
import { severityLabel } from './labels';
import type { Severity } from './model';
import './iss.css';

/** The time shown in the time zone of the business (UTC+7), in the language of the screen. */
export function useMoment(): (instant: string | null) => string {
  const { t, locale } = useTranslation();
  return (instant) => {
    if (instant === null) return t('iss.value.none.text');
    const date = new Date(instant);
    return Number.isNaN(date.getTime()) ? instant : new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Bangkok' }).format(date);
  };
}

/** The link above the title that the mockup of a detail screen carries: an arrow and the name of the screen it comes from. */
export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <p className="iss-back-link">
      <Link to={to}>
        <span aria-hidden="true">← </span>
        {children}
      </Link>
    </p>
  );
}

export function StatusBadge({ status }: { status: IssueStatus }) {
  const { t } = useTranslation();
  return (
    <span data-testid="status" data-status={status}>
      <StatusPill tone={statusToneOf(status)}>{statusLabel(t, status)}</StatusPill>
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  const { t } = useTranslation();
  return (
    <span data-testid="severity" data-severity={severity}>
      <StatusPill tone={severityToneOf(severity)}>{severityLabel(t, severity)}</StatusPill>
    </span>
  );
}

/** Where the issue stands against its deadline, in words; the days overdue stay with the issue when it moves to another unit. */
export function DueBadge({ line, now }: { line: Pick<IssueLine, 'status' | 'dueAt' | 'overdueSince' | 'overdueDays'>; now: Date }) {
  const { t } = useTranslation();
  const state = dueStateOf(line, now);
  const days =
    state === 'overdue' && line.overdueSince !== null
      ? line.overdueDays === null
        ? ` · ${t('iss.due.overdueUnknown.text')}`
        : ` · ${t('iss.due.overdueDays.text', { count: line.overdueDays })}`
      : '';
  return (
    <span data-testid="due-state" data-state={state}>
      <StatusPill tone={dueToneOf(state)}>{`${dueLabel(t, state)}${days}`}</StatusPill>
    </span>
  );
}

/** The time left to the deadline in the wording of the alert centre ("Còn 2 ngày · 09/11", "Quá hạn 3 ngày"); an issue that is closed has no time left to count. */
export function DeadlineLine({ line, now }: { line: Pick<IssueLine, 'status' | 'dueAt' | 'overdueDays'>; now: Date }) {
  if (line.status === 'CLOSED') return null;
  const dueOn = businessDay(line.dueAt);
  return <DeadlineCountdown dueOn={dueOn === '' ? null : dueOn} today={businessDay(now)} {...(line.overdueDays !== null && line.overdueDays > 0 ? { daysLate: line.overdueDays } : {})} />;
}

export function PersonText({ person }: { person: PersonView | null }) {
  const { t } = useTranslation();
  if (person === null) return <>{t('iss.value.none.text')}</>;
  return <>{person.name === '' ? person.id : person.name}</>;
}

/**
 * The timeline of an issue, oldest first: who did what, when, and the note they left. A note the reader may not see is shown as hidden,
 * so the sequence of events stays whole.
 */
export function Timeline({ events, unitName }: { events: readonly IssueEventView[]; unitName: (unitId: string | null) => string }) {
  const { t } = useTranslation();
  const moment = useMoment();
  return (
    <ol className="iss-timeline" aria-label={t('iss.workspace.timeline.title')} data-testid="timeline">
      {events.map((event) => {
        const from = event.kind === 'TRANSFERRED' ? unitName(event.fromUnitId) : (event.fromAssignee?.name ?? t('iss.value.none.text'));
        const to = event.kind === 'TRANSFERRED' ? unitName(event.toUnitId) : (event.toAssignee?.name ?? t('iss.value.none.text'));
        return (
          <li key={event.id} data-kind={event.kind}>
            <p>
              <strong>{eventLabel(t, event.kind, { from, to })}</strong>
              {event.fromStatus !== null && event.toStatus !== null && event.fromStatus !== event.toStatus ? (
                <span className="sub"> · {t('iss.event.statusChange.text', { from: statusText(t, event.fromStatus), to: statusText(t, event.toStatus) })}</span>
              ) : null}
            </p>
            <p className="sub">
              {moment(event.createdAt)}
              {event.actor === null ? '' : ` · ${t('iss.event.actor.text', { name: event.actor.name === '' ? event.actor.id : event.actor.name })}`}
              {event.documentAttached ? ` · ${t('iss.event.document.text')}` : ''}
            </p>
            {event.note === null ? null : <p className="iss-note">{event.note}</p>}
          </li>
        );
      })}
    </ol>
  );
}

function statusText(t: ReturnType<typeof useTranslation>['t'], status: string): string {
  const known = (['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ESCALATED', 'PENDING_VERIFICATION', 'CLOSED', 'REOPENED'] as const).find((candidate) => candidate === status);
  return known === undefined ? status : statusLabel(t, known);
}
