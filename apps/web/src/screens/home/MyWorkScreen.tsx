import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { AlertActions } from '../../ui/alerts/AlertActions';
import type { SnoozeChoice } from '../../ui/alerts/AlertActions';
import { AlertRow, sourceLabel } from '../../ui/alerts/AlertRow';
import { clock, clockAndDay, dayMonth, morningOf, nextDay, severitySuffix, todayOf } from '../../ui/alerts/format';
import { useAlertAction, useAlertCounts, useAssignees } from '../../ui/alerts/hooks';
import { SeverityIcon } from '../../ui/alerts/SeverityBadge';
import { SEVERITIES } from '../../ui/alerts/types';
import type { AlertItem, AlertView, Severity } from '../../ui/alerts/types';
import '../dis/dis.css';
import './home.css';
import { ofSeverity, useAlertSource } from './alert-source';

type Filter = Severity | 'ALL';
const HOUR_MS = 3_600_000;

/** The moment an item comes back for a choice of the person. */
function snoozeUntil(choice: SnoozeChoice, now: Date): string {
  if (choice.kind === 'hour') return new Date(now.getTime() + HOUR_MS).toISOString();
  if (choice.kind === 'tomorrow') return morningOf(nextDay(todayOf(now)));
  return morningOf(choice.day);
}

/**
 * HOME-02: my work (ST-HOME-004). The full queue of the same source as the bell and the band of HOME-01: one list of what needs action, "mine" or "in my scope", by severity, each with its deadline, escalation and
 * the three actions (claim, assign, snooze). A source that could not be read is named, and a list that could not be read is an error and never "no work".
 */
export default function MyWorkScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <MyWorkContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

interface Receipt {
  tone: 'success' | 'danger';
  text: string;
}

function MyWorkContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<AlertView>('mine');
  const [filter, setFilter] = useState<Filter>('ALL');
  const [assigning, setAssigning] = useState<AlertItem | undefined>(undefined);
  const [receipt, setReceipt] = useState<Receipt | undefined>(undefined);
  // Whether the role reads the scope is asked once; a refusal is said, not hidden.
  const probe = useAlertCounts('scope', { refreshMs: false });
  const scopeDenied = probe.denied;
  const scopeKnown = probe.isSuccess || (probe.isError && !scopeDenied);
  const active: AlertView = view === 'scope' && !scopeKnown ? 'mine' : view;
  const source = useAlertSource(active);
  const { claim, assign, snooze, me } = useAlertAction();
  const today = todayOf();
  const shown = useMemo(() => ofSeverity(source.items, filter), [source.items, filter]);
  const busyId = claim.isPending ? claim.variables?.id : assign.isPending ? assign.variables?.item.id : snooze.isPending ? snooze.variables?.item.id : undefined;
  const sourcesText = source.unavailable.map((entry) => sourceLabel(t, entry)).join(', ');
  const countOf = (severity: Severity): number => (severity === 'URGENT' ? source.counts.urgent : severity === 'ACTION' ? source.counts.action : source.counts.watch);

  const done = (text: string): void => setReceipt({ tone: 'success', text });
  const failed = (): void => setReceipt({ tone: 'danger', text: t('alerts.receipt.failed') });
  const claimItem = (item: AlertItem): void => {
    claim.mutate(item, { onSuccess: () => done(t('alerts.receipt.claimed', { name: me.name, time: clock(new Date()) })), onError: failed });
  };
  const snoozeItem = (item: AlertItem, choice: SnoozeChoice): void => {
    const until = snoozeUntil(choice, new Date());
    snooze.mutate({ item, until }, { onSuccess: () => done(t('alerts.receipt.snoozed', { time: clockAndDay(until) })), onError: failed });
  };
  const assignItem = (item: AlertItem, assignee: { id: string; name: string }, dueOn: string): void => {
    assign.mutate(
      { item, assignee, dueOn },
      {
        onSuccess: () => {
          setAssigning(undefined);
          done(t('alerts.receipt.assigned', { name: assignee.name, date: dayMonth(dueOn) }));
        },
      },
    );
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('home.queue.title')}</h1>
          <p>{t('home.queue.subtitle')}</p>
        </div>
      </div>
      <div className="mv-alert-tabs" role="tablist" aria-label={t('home.queue.tabs')}>
        {(['mine', ...(scopeKnown ? (['scope'] as const) : [])] as AlertView[]).map((entry) => (
          <button
            key={entry}
            type="button"
            role="tab"
            aria-selected={active === entry}
            className="mv-alert-tab"
            data-view={entry}
            onClick={() => {
              setView(entry);
              setFilter('ALL');
            }}
          >
            {t(`alerts.view.${entry}`)}
          </button>
        ))}
      </div>
      {scopeDenied ? (
        <p className="home-queue-note" role="status" data-testid="scope-denied">
          {t('home.queue.scopeDenied')}
        </p>
      ) : null}
      <div className="mv-alert-filter" role="group" aria-label={t('home.queue.filter.label')}>
        <button type="button" className="mv-alert-chip" aria-pressed={filter === 'ALL'} onClick={() => setFilter('ALL')}>
          {source.state === 'ready' ? t('home.queue.filter.all', { count: source.counts.total }) : t('alerts.center.filterAll')}
        </button>
        {SEVERITIES.map((severity) => (
          <button key={severity} type="button" className="mv-alert-chip" data-severity={severity} aria-pressed={filter === severity} onClick={() => setFilter(severity)}>
            <SeverityIcon severity={severity} />
            {source.state === 'ready' ? t('home.queue.filter.level', { label: t(`alerts.severity.${severitySuffix(severity)}`), count: countOf(severity) }) : t(`alerts.severity.${severitySuffix(severity)}`)}
          </button>
        ))}
      </div>
      <div role={receipt?.tone === 'danger' ? 'alert' : 'status'} aria-label={t('alerts.center.receipts')} data-testid="queue-receipt">
        {receipt === undefined ? null : (
          <p className={receipt.tone === 'danger' ? 'home-queue-note home-queue-note--warn' : 'home-queue-note'}>{receipt.text}</p>
        )}
      </div>
      {source.unavailable.length > 0 ? (
        <p className="home-queue-note home-queue-note--warn" role="status" data-testid="queue-unavailable">
          {t('home.queue.unavailable', { sources: sourcesText })}{' '}
          <button type="button" className="mv-alert-link" onClick={source.retry}>
            {t('home.queue.retry')}
          </button>
        </p>
      ) : null}
      {source.state === 'loading' ? (
        <div className="mv-alert-skeleton" role="status" aria-busy="true" aria-label={t('alerts.center.loading')} data-testid="queue-loading">
          <span className="mv-alert-skeleton__row" />
          <span className="mv-alert-skeleton__row" />
          <span className="mv-alert-skeleton__row" />
        </div>
      ) : null}
      {source.state === 'error' ? (
        <div className="home-source-error" role="alert" data-testid="queue-error">
          <p>{t('home.queue.error')}</p>
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={source.retry}>
            {t('home.queue.retry')}
          </button>
        </div>
      ) : null}
      {source.state === 'ready' && shown.length === 0 ? (
        <div className="home-queue-note" role="status" data-testid="queue-empty" data-kind={source.items.length === 0 ? 'none' : 'filtered'}>
          <p>{source.items.length === 0 ? t('home.queue.empty.none') : t('home.queue.empty.filtered')}</p>
          {source.items.length === 0 ? null : (
            <button type="button" className="mv-alert-button" onClick={() => setFilter('ALL')}>
              {t('home.queue.empty.clear')}
            </button>
          )}
        </div>
      ) : null}
      {source.state === 'ready' && source.hasMore ? (
        <p className="home-queue-note" role="status" data-testid="queue-partial">
          {t('home.queue.partial', { count: source.items.length })}
        </p>
      ) : null}
      {shown.length > 0 ? (
        <ul className="home-queue" aria-label={t('home.queue.list')} data-testid="queue-list">
          {shown.map((item) => (
            <AlertRow
              key={item.id}
              item={item}
              today={today}
              detailed
              actions={<AlertActions item={item} can={{ claim: true, assign: true, snooze: true }} busy={busyId === item.id} onClaim={() => claimItem(item)} onAssign={() => setAssigning(item)} onSnooze={(choice) => snoozeItem(item, choice)} />}
            />
          ))}
        </ul>
      ) : null}
      {assigning === undefined ? null : (
        <div className="mv-alert-dialog-layer">
          <AssignDialog item={assigning} pending={assign.isPending} refused={assign.isError} onCancel={() => setAssigning(undefined)} onSubmit={(assignee, dueOn) => assignItem(assigning, assignee, dueOn)} />
        </div>
      )}
    </section>
  );
}

interface AssignDialogProps {
  item: AlertItem;
  pending: boolean;
  refused: boolean;
  onSubmit: (assignee: { id: string; name: string }, dueOn: string) => void;
  onCancel: () => void;
}

/** Gives an item to a person of the staff of the scope, with the day it must be handled by. */
function AssignDialog({ item, pending, refused, onSubmit, onCancel }: AssignDialogProps) {
  const { t } = useTranslation();
  const people = useAssignees(true);
  const [person, setPerson] = useState('');
  const [dueOn, setDueOn] = useState(item.due_on ?? '');
  const [tried, setTried] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialog.current?.focus();
  }, []);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (pending) return;
    setTried(true);
    const chosen = (people.data ?? []).find((member) => member.id === person);
    if (chosen === undefined || dueOn === '') return;
    onSubmit(chosen, dueOn);
  };
  return (
    <div
      ref={dialog}
      className="mv-alert-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={t('alerts.assign.title')}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
    >
      <form onSubmit={submit} noValidate>
        <h3>{t('alerts.assign.title')}</h3>
        <p className="mv-alert-dialog__item">{item.title}</p>
        {people.isError ? (
          <p className="mv-alert-banner" data-tone="warning" role="alert">
            {t('alerts.assign.lookupFailed')}
          </p>
        ) : null}
        {refused ? (
          <p className="mv-alert-banner" data-tone="danger" role="alert">
            {t('alerts.assign.refused')}
          </p>
        ) : null}
        <fieldset disabled={pending}>
          <div className="mv-alert-field">
            <label htmlFor="queue-assign-person">{t('alerts.assign.person')}</label>
            <select id="queue-assign-person" value={person} aria-invalid={tried && person === ''} onChange={(event) => setPerson(event.target.value)}>
              <option value="">{t('alerts.assign.choose')}</option>
              {(people.data ?? []).map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </select>
            {tried && person === '' ? <span className="mv-alert-field__error">{t('alerts.assign.personRequired')}</span> : null}
          </div>
          <div className="mv-alert-field">
            <label htmlFor="queue-assign-due">{t('alerts.assign.due')}</label>
            <input id="queue-assign-due" type="date" value={dueOn} min={todayOf()} aria-invalid={tried && dueOn === ''} onChange={(event) => setDueOn(event.target.value)} />
            {tried && dueOn === '' ? <span className="mv-alert-field__error">{t('alerts.assign.dueRequired')}</span> : null}
          </div>
        </fieldset>
        <div className="mv-alert-dialog__foot">
          <button type="button" className="mv-alert-button" onClick={onCancel}>
            {t('alerts.assign.cancel')}
          </button>
          <button type="submit" className="mv-alert-button mv-alert-button--primary" disabled={pending}>
            {pending ? t('alerts.assign.pending') : t('alerts.assign.submit')}
          </button>
        </div>
      </form>
    </div>
  );
}
