import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { AlertActions } from './AlertActions';
import { AlertRow, sourceLabel } from './AlertRow';
import { clock, clockAndDay, dayMonth, severitySuffix, todayOf } from './format';
import { useFocusTrap } from './focus';
import { useAlertAction, useAlertCounts, useAlertItems, useAssignees } from './hooks';
import { PauseDialog } from './PauseDialog';
import { refusalText } from './refusals';
import { SeverityIcon } from './SeverityBadge';
import { SnoozeDialog } from './SnoozeDialog';
import type { SnoozeSubmit } from './SnoozeDialog';
import type { PauseSubmit } from './PauseDialog';
import { SEVERITIES } from './types';
import type { AlertItem, AlertView, Severity } from './types';
import './alerts.css';

/** How long a claim can still be taken back: the command is sent when the time is over (there is no command to release an item). */
export const UNDO_MS = 5000;
const HOME_QUEUE = '/home/home-02';
/** HOME-12: the work held by a snooze, for the readers that have a scope. */
const HOME_SNOOZED = '/home/home-12';

type Filter = Severity | 'ALL';

/** Puts the focus on a control the moment it appears: the undo button takes the place of the claim button that was pressed. */
const focusOnMount = (element: HTMLButtonElement | null): void => element?.focus();

const omit = <T,>(record: Record<string, T>, key: string): Record<string, T> => Object.fromEntries(Object.entries(record).filter(([entry]) => entry !== key));

interface DrawerFrameProps {
  title: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}

/** The right-side drawer: a modal part of the page with a trapped focus, closed by Escape, by its button or by a click outside. */
function DrawerFrame({ title, closeLabel, onClose, children }: DrawerFrameProps) {
  const titleId = useId();
  const panel = useRef<HTMLElement>(null);
  useFocusTrap(panel, true, { onEscape: onClose });
  return createPortal(
    <div className="mv-alert-overlay" data-testid="alert-overlay" onMouseDown={(event) => (event.target === event.currentTarget ? onClose() : undefined)}>
      <aside ref={panel} className="mv-alert-drawer" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="mv-alert-drawer__head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="mv-alert-button" onClick={onClose}>
            {closeLabel}
          </button>
        </header>
        {children}
      </aside>
    </div>,
    document.body,
  );
}

interface AssignDialogProps {
  item: AlertItem;
  pending: boolean;
  refused: boolean;
  onSubmit: (assignee: { id: string; name: string }, dueOn: string) => void;
  onCancel: () => void;
}

/** The small dialog that gives an item to a person (chosen from the staff of the scope, as the delegations of ADM do) with the day it must be handled by. */
function AssignDialog({ item, pending, refused, onSubmit, onCancel }: AssignDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const personId = useId();
  const dueId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const people = useAssignees(true);
  const [person, setPerson] = useState('');
  const [dueOn, setDueOn] = useState(item.due_on ?? '');
  const [tried, setTried] = useState(false);
  useFocusTrap(dialog, true, { onEscape: onCancel });
  const today = todayOf();
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (pending) return;
    setTried(true);
    const chosen = (people.data ?? []).find((member) => member.id === person);
    if (chosen === undefined || dueOn === '') return;
    onSubmit(chosen, dueOn);
  };
  return (
    <div ref={dialog} className="mv-alert-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <form onSubmit={submit} noValidate>
        <h3 id={titleId}>{t('alerts.assign.title')}</h3>
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
            <label htmlFor={personId}>{t('alerts.assign.person')}</label>
            <select id={personId} value={person} aria-invalid={tried && person === ''} onChange={(event) => setPerson(event.target.value)}>
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
            <label htmlFor={dueId}>{t('alerts.assign.due')}</label>
            <input id={dueId} type="date" value={dueOn} min={today} aria-invalid={tried && dueOn === ''} onChange={(event) => setDueOn(event.target.value)} />
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

export interface AlertCenterProps {
  open: boolean;
  onClose: () => void;
}

interface Receipt {
  tone: 'success' | 'danger';
  text: string;
}

/**
 * The drawer of the alert centre: the items of the person (or of their scope), by level, each with its deadline, owner, escalation and actions. The full list is read only while it is open.
 * A claim can be taken back for five seconds: it is sent when they are over, or when the drawer closes.
 */
export function AlertCenter({ open, onClose }: AlertCenterProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<AlertView>('mine');
  const [filter, setFilter] = useState<Filter>('ALL');
  const [assigning, setAssigning] = useState<AlertItem | undefined>(undefined);
  const [snoozing, setSnoozing] = useState<AlertItem | undefined>(undefined);
  const [pausing, setPausing] = useState<AlertItem | undefined>(undefined);
  const [receipt, setReceipt] = useState<Receipt | undefined>(undefined);
  const [pendingClaims, setPendingClaims] = useState<Record<string, AlertItem>>({});
  const waiting = useRef(new Map<string, { item: AlertItem; timer: ReturnType<typeof setTimeout> }>());
  const claimedAt = useRef(new Map<string, string>());

  const scopeCounts = useAlertCounts('scope', { enabled: open, refreshMs: false });
  const scopeDenied = scopeCounts.denied;
  const scopeKnown = scopeCounts.isSuccess || (scopeCounts.isError && !scopeDenied);
  const active: AlertView = view === 'scope' && !scopeKnown ? 'mine' : view;
  const counts = useAlertCounts(active, { enabled: open });
  const items = useAlertItems(active, { enabled: open });
  const { claim, assign, snooze, pause, resume, me } = useAlertAction();
  const claimMutate = claim.mutate;

  const sendClaim = useCallback(
    (item: AlertItem): void => {
      claimMutate(item, {
        onSuccess: () => setReceipt({ tone: 'success', text: t('alerts.receipt.claimed', { name: me.name, time: clock(claimedAt.current.get(item.id) ?? new Date()) }) }),
        onError: () => setReceipt({ tone: 'danger', text: t('alerts.receipt.failed') }),
      });
    },
    // `claim.mutate` is stable; the other values only feed the receipt text.
    [claimMutate, me.name, t],
  );
  const sendClaimRef = useRef(sendClaim);
  sendClaimRef.current = sendClaim;

  const startClaim = (item: AlertItem): void => {
    if (waiting.current.has(item.id)) return;
    claimedAt.current.set(item.id, new Date().toISOString());
    setPendingClaims((current) => ({ ...current, [item.id]: item }));
    const timer = setTimeout(() => {
      waiting.current.delete(item.id);
      setPendingClaims((current) => omit(current, item.id));
      sendClaimRef.current(item);
    }, UNDO_MS);
    waiting.current.set(item.id, { item, timer });
  };
  const undoClaim = (id: string): void => {
    const entry = waiting.current.get(id);
    if (entry !== undefined) clearTimeout(entry.timer);
    waiting.current.delete(id);
    setPendingClaims((current) => omit(current, id));
  };
  /** Sends at once the claims whose time to be taken back is not over: the drawer closes or goes away. */
  const flushClaims = useCallback((): void => {
    const entries = Array.from(waiting.current.values());
    waiting.current.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      sendClaimRef.current(entry.item);
    }
    if (entries.length > 0) setPendingClaims({});
  }, []);
  useEffect(() => {
    if (!open) {
      flushClaims();
      setAssigning(undefined);
      setSnoozing(undefined);
      setPausing(undefined);
      setReceipt(undefined);
    }
  }, [open, flushClaims]);
  useEffect(() => () => flushClaims(), [flushClaims]);

  const today = todayOf();
  const list = useMemo(() => items.data?.items ?? [], [items.data]);
  const shown = useMemo(() => list.filter((item) => filter === 'ALL' || item.severity === filter), [list, filter]);
  const unavailable = items.data?.unavailable_sources ?? [];
  const busyId = claim.isPending ? claim.variables?.id : assign.isPending ? assign.variables?.item.id : snooze.isPending ? snooze.variables?.item.id : pause.isPending ? pause.variables?.item.id : resume.isPending ? resume.variables?.item.id : undefined;

  if (!open) return null;

  const openSnooze = (item: AlertItem): void => {
    snooze.reset();
    setSnoozing(item);
  };
  const openPause = (item: AlertItem): void => {
    pause.reset();
    setPausing(item);
  };
  const snoozeItem = (item: AlertItem, value: SnoozeSubmit): void => {
    snooze.mutate(
      { item, until: value.until, reasonCode: value.reasonCode, note: value.note },
      {
        onSuccess: () => {
          setSnoozing(undefined);
          setReceipt({ tone: 'success', text: t('alerts.receipt.snoozed', { time: clockAndDay(value.until) }) });
        },
      },
    );
  };
  const pauseItem = (item: AlertItem, value: PauseSubmit): void => {
    pause.mutate(
      { item, allowedBy: value.allowedBy, reasonCode: value.reasonCode, reason: value.reason, until: value.until },
      {
        onSuccess: () => {
          setPausing(undefined);
          setReceipt({ tone: 'success', text: t('alerts.receipt.paused', { time: clockAndDay(value.until) }) });
        },
      },
    );
  };
  const resumeItem = (item: AlertItem): void => {
    resume.mutate(
      { item },
      {
        onSuccess: () => setReceipt({ tone: 'success', text: t('alerts.receipt.resumed') }),
        onError: (failure) => setReceipt({ tone: 'danger', text: refusalText(t, 'resume', failure) ?? t('alerts.receipt.failed') }),
      },
    );
  };
  const assignItem = (item: AlertItem, assignee: { id: string; name: string }, dueOn: string): void => {
    assign.mutate(
      { item, assignee, dueOn },
      {
        onSuccess: () => {
          setAssigning(undefined);
          setReceipt({ tone: 'success', text: t('alerts.receipt.assigned', { name: assignee.name, date: dayMonth(dueOn) }) });
        },
      },
    );
  };

  const countOf = (severity: Severity): number | undefined => {
    const answer = counts.data?.counts;
    if (answer === undefined) return undefined;
    return severity === 'URGENT' ? answer.urgent : severity === 'ACTION' ? answer.action : answer.watch;
  };
  const failed = items.isError && items.data === undefined;
  const stale = items.isError && items.data !== undefined;
  const denied = items.denied;
  const sourcesText = unavailable.map((source) => sourceLabel(t, source)).join(', ');

  return (
    <DrawerFrame title={t('alerts.center.title')} closeLabel={t('alerts.center.close')} onClose={onClose}>
      <div className="mv-alert-tabs" role="tablist" aria-label={t('alerts.center.views')}>
        {(['mine', ...(scopeKnown ? (['scope'] as const) : [])] as AlertView[]).map((entry) => (
          <button key={entry} type="button" role="tab" aria-selected={active === entry} className="mv-alert-tab" data-view={entry} onClick={() => setView(entry)}>
            {t(`alerts.view.${entry}`)}
          </button>
        ))}
      </div>
      <div className="mv-alert-filter" role="group" aria-label={t('alerts.center.filter')}>
        <button type="button" className="mv-alert-chip" aria-pressed={filter === 'ALL'} onClick={() => setFilter('ALL')}>
          {t('alerts.center.filterAll')}
        </button>
        {SEVERITIES.map((severity) => {
          const count = countOf(severity);
          return (
            <button key={severity} type="button" className="mv-alert-chip" data-severity={severity} aria-pressed={filter === severity} onClick={() => setFilter(severity)}>
              <SeverityIcon severity={severity} />
              {t(`alerts.severity.${severitySuffix(severity)}`)}
              {count === undefined ? null : <span className="mv-alert-chip__count">{count}</span>}
            </button>
          );
        })}
      </div>

      <div className="mv-alert-drawer__body">
        <div className="mv-alert-receipts" role={receipt?.tone === 'danger' ? 'alert' : 'status'} aria-label={t('alerts.center.receipts')}>
          {receipt === undefined ? null : (
            <p className="mv-alert-banner" data-tone={receipt.tone === 'danger' ? 'danger' : 'success'}>
              {receipt.text}
            </p>
          )}
        </div>
        {stale ? (
          <p className="mv-alert-banner" data-tone="warning" role="status">
            {t('alerts.state.stale', { time: clock(new Date(items.dataUpdatedAt)) })}{' '}
            <button type="button" className="mv-alert-link" onClick={() => void items.refetch()}>
              {t('alerts.error.retry')}
            </button>
          </p>
        ) : null}
        {unavailable.length > 0 ? (
          <p className="mv-alert-banner" data-tone="warning" role="status" data-testid="alert-unavailable">
            {t('alerts.state.unavailable', { sources: sourcesText })}{' '}
            <button type="button" className="mv-alert-link" onClick={() => void items.refetch()}>
              {t('alerts.error.retry')}
            </button>
          </p>
        ) : null}

        {items.isPending && items.fetchStatus !== 'idle' ? (
          <div className="mv-alert-skeleton" role="status" aria-busy="true" aria-label={t('alerts.center.loading')}>
            <span className="mv-alert-skeleton__row" />
            <span className="mv-alert-skeleton__row" />
            <span className="mv-alert-skeleton__row" />
          </div>
        ) : null}
        {denied ? (
          <p className="mv-alert-banner" data-tone="warning" role="status">
            {t('alerts.state.denied')}
          </p>
        ) : failed ? (
          <div className="mv-alert-banner" data-tone="danger" role="alert">
            <span>{t('alerts.error.title')}</span>{' '}
            <button type="button" className="mv-alert-link" onClick={() => void items.refetch()}>
              {t('alerts.error.retry')}
            </button>
          </div>
        ) : null}

        {items.data !== undefined && shown.length === 0 ? (
          <div className="mv-alert-empty" data-kind={list.length === 0 ? 'none' : 'filtered'}>
            <p>{list.length === 0 ? t('alerts.empty.none') : t('alerts.empty.filtered')}</p>
            {list.length === 0 ? null : (
              <button type="button" className="mv-alert-button" onClick={() => setFilter('ALL')}>
                {t('alerts.empty.clearFilter')}
              </button>
            )}
          </div>
        ) : null}

        {shown.length > 0 ? (
          <ul className="mv-alert-list" aria-label={t('alerts.center.list')}>
            {shown.map((item) => {
              const held = pendingClaims[item.id];
              const showItem: AlertItem = held === undefined ? item : { ...item, lifecycle: 'CLAIMED', claimed_by: { id: me.id, name: me.name, at: claimedAt.current.get(item.id) ?? new Date().toISOString() } };
              return (
                <AlertRow
                  key={item.id}
                  item={showItem}
                  today={today}
                  detailed
                  note={
                    held === undefined ? undefined : (
                      <button ref={focusOnMount} type="button" className="mv-alert-link" aria-label={t('alerts.action.undoName')} onClick={() => undoClaim(item.id)}>
                        {t('alerts.action.undo')}
                      </button>
                    )
                  }
                  actions={
                    held === undefined ? (
                      <AlertActions item={item} can={{ claim: true, assign: true, snooze: true, pause: true }} busy={busyId === item.id} onClaim={() => startClaim(item)} onAssign={() => setAssigning(item)} onSnooze={() => openSnooze(item)} onPause={() => openPause(item)} onResume={() => resumeItem(item)} />
                    ) : null
                  }
                />
              );
            })}
          </ul>
        ) : null}
      </div>

      <footer className="mv-alert-drawer__foot">
        {items.data?.as_of == null ? null : <span className="mv-alert-muted">{t('alerts.center.asOf', { time: clock(items.data.as_of) })}</span>}
        {scopeKnown ? (
          <Link to={HOME_SNOOZED} className="mv-alert-link" onClick={onClose}>
            {t('alerts.center.viewSnoozed')}
          </Link>
        ) : null}
        <Link to={HOME_QUEUE} className="mv-alert-link" onClick={onClose}>
          {t('alerts.center.viewAll')}
        </Link>
      </footer>

      {assigning === undefined ? null : (
        <div className="mv-alert-dialog-layer">
          <AssignDialog item={assigning} pending={assign.isPending} refused={assign.isError} onCancel={() => setAssigning(undefined)} onSubmit={(assignee, dueOn) => assignItem(assigning, assignee, dueOn)} />
        </div>
      )}
      {snoozing === undefined ? null : (
        <div className="mv-alert-dialog-layer">
          <SnoozeDialog item={snoozing} pending={snooze.isPending} error={snooze.error} onCancel={() => setSnoozing(undefined)} onSubmit={(value) => snoozeItem(snoozing, value)} />
        </div>
      )}
      {pausing === undefined ? null : (
        <div className="mv-alert-dialog-layer">
          <PauseDialog item={pausing} pending={pause.isPending} error={pause.error} onCancel={() => setPausing(undefined)} onSubmit={(value) => pauseItem(pausing, value)} />
        </div>
      )}
    </DrawerFrame>
  );
}
