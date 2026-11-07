import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { hasMessage, useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import { pathOf } from '../../screens/home/work-model';
import { WEB_ROUTES } from '../../routes/web-routes';
import { DeadlineCountdown } from './DeadlineCountdown';
import { EscalationTrail } from './EscalationTrail';
import { ClockLines } from './ItemClocks';
import { SeverityBadge } from './SeverityBadge';
import { clock, clockAndDay, dayMonth, lifecycleSuffix, severitySuffix, sourceSuffix } from './format';
import type { AlertItem } from './types';
import './alerts.css';

const ROUTE_PATH: ReadonlyMap<string, string> = new Map(WEB_ROUTES.map((route) => [route.id, route.path]));

/** Where the record of an item is opened: the screens that take the id in the address do, any other known screen is opened on its own page; an unknown screen has no link. */
export function pathOfAlert(item: Pick<AlertItem, 'target'>): string | undefined {
  return pathOf({ target: item.target }) ?? ROUTE_PATH.get(item.target.screen);
}

/** The words of a source (APPROVAL, PERMIT, …); a source this build does not know is shown as it came. */
export function sourceLabel(t: Translator['t'], source: string): string {
  const suffix = sourceSuffix(source);
  return hasMessage(`alerts.source.${suffix}`) ? t(`alerts.source.${suffix}`) : source;
}

/** Who holds the item now, in one sentence. */
export function ownerText(t: Translator['t'], item: AlertItem): string {
  if (item.claimed_by !== null) return t('alerts.item.owner.claimed', { name: item.claimed_by.name, time: clock(item.claimed_by.at) });
  if (item.assignee !== null) {
    return item.assignee.due_on === null ? t('alerts.item.owner.assignedNoDate', { name: item.assignee.name }) : t('alerts.item.owner.assigned', { name: item.assignee.name, date: dayMonth(item.assignee.due_on) });
  }
  return t('alerts.item.owner.none');
}

export interface AlertRowProps {
  item: AlertItem;
  today: string;
  /** The buttons of the item (AlertActions); the band has none. */
  actions?: ReactNode;
  /** A line under the item: the receipt of an action, or its undo. */
  note?: ReactNode;
  /** Shows the consequence of leaving it undone and the escalation: the drawer does, the band does not. */
  detailed?: boolean;
  /** The moment "now" is for the time left on the clocks; tests own the clock. */
  now?: Date;
}

/** One item of the alert centre or of the band: level, title, subtitle, source, deadline (or its clocks), owner, escalation, actions. */
export function AlertRow({ item, today, actions, note, detailed = false, now }: AlertRowProps) {
  const { t } = useTranslation();
  const path = pathOfAlert(item);
  return (
    <li className="mv-alert-row" data-severity={item.severity} data-item-id={item.id} data-lifecycle={item.lifecycle}>
      <div className="mv-alert-row__head">
        <SeverityBadge severity={item.severity} label={t(`alerts.severity.${severitySuffix(item.severity)}`)} />
        <span className="mv-alert-row__source">{sourceLabel(t, item.source)}</span>
        <span className="mv-alert-row__state">{t(`alerts.lifecycle.${lifecycleSuffix(item.lifecycle)}`)}</span>
      </div>
      <div className="mv-alert-row__title">
        {path === undefined ? (
          <strong>{item.title}</strong>
        ) : (
          <Link to={path} aria-label={`${t('alerts.item.open')}: ${item.title}`}>
            {item.title}
          </Link>
        )}
      </div>
      {item.subtitle === null ? null : <div className="mv-alert-row__subtitle">{item.subtitle}</div>}
      <div className="mv-alert-row__meta">
        {item.clocks === null ? <DeadlineCountdown dueOn={item.due_on} today={today} daysLate={item.days_late} /> : null}
        <span>{ownerText(t, item)}</span>
        {item.snoozed_until === null ? null : <span>{t('alerts.item.snoozed', { time: clockAndDay(item.snoozed_until) })}</span>}
      </div>
      {detailed && item.expected_action !== null ? <div className="mv-alert-row__consequence">{t('alerts.item.expectedAction', { text: item.expected_action })}</div> : null}
      <ClockLines item={item} detailed={detailed} {...(now === undefined ? {} : { now })} />
      {detailed && item.consequence !== null ? <div className="mv-alert-row__consequence">{t('alerts.item.consequence', { text: item.consequence })}</div> : null}
      {item.escalation === null ? null : <EscalationTrail level={item.escalation.level} of={item.escalation.of} chain={item.escalation.chain} nextAt={item.escalation.next_at} />}
      {note === undefined ? null : <div className="mv-alert-row__note">{note}</div>}
      {actions}
    </li>
  );
}
