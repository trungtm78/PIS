import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../../ctr/components';
import { useOnline } from '../../qms/offline/hooks';
import { useIncomings, useResolveLetter, useStartLetter } from '../incoming/hooks';
import { formProblemMessage, problemMessage, statusLabel, urgencyLabel } from '../incoming/labels';
import { NO_FILTER, canAct, describeProblem, handlingLink, validateWords } from '../incoming/model';
import type { IncomingLine } from '../incoming/model';
import '../incoming/incoming.css';
import './mobile.css';
import { INCOMING_READ, holds, lettersToHandle, numberOf } from './model';

/**
 * DOC-23: the letters assigned to the signed-in handler, on a phone (ST-DOC-020, DOC 4). Each shows its number, its subject, the directive of the leader and its deadline; a letter past its deadline says how many days
 * late it is, and can still be handled. Starting and resolving are commands sent at once, each under its own idempotency key; nothing is queued for later and nothing is kept on the device, so no file or text of a letter
 * is left behind offline (the DOC tables are not in the sync rules). The file itself opens on DOC-13.
 */
export default function IncomingMobileScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, permissions } = useSession();
  // The list and the forms belong to one membership: a switch of tenant or of membership starts the screen over.
  const key = `${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`;
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <Heading />
      {holds(permissions, INCOMING_READ) ? <Letters key={key} /> : <StateBoundary state="denied" />}
      <p className="prototype-note">{t('doc.mobile.in.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Heading() {
  const { t } = useTranslation();
  return (
    <div className="heading">
      <div>
        <h1 id="screen-title">{t('doc.mobile.in.page.title')}</h1>
        <p>{t('doc.mobile.in.page.subtitle')}</p>
      </div>
    </div>
  );
}

function Letters() {
  const { t, locale } = useTranslation();
  const { tenant, mode } = useSession();
  const online = useOnline();
  const list = useIncomings(NO_FILTER);
  const lines = useMemo(
    () =>
      lettersToHandle(
        (list.data?.pages ?? []).flatMap((page) => page.lines),
        tenant?.membershipId,
      ),
    [list.data, tenant?.membershipId],
  );
  // A page with none of the letters this person handles is not the end of the list: the next page is read until one is found or there is none.
  const searching = lines.length === 0 && list.hasNextPage === true && list.error === null;
  const { fetchNextPage, isFetchingNextPage } = list;
  useEffect(() => {
    if (searching && online && !isFetchingNextPage) void fetchNextPage();
  }, [searching, online, isFetchingNextPage, fetchNextPage]);
  // A page that could not be read after others were is not the failure of the list: the letters read stay, with the forms the handler is filling, and the page is asked for again from a control beside them.
  const moreFailed = list.isFetchNextPageError;
  const loaded = useScreenState({
    isLoading: list.isLoading || searching,
    error: moreFailed ? null : list.error,
    data: list.data === undefined ? undefined : lines,
    isEmpty: () => lines.length === 0,
  });
  // With no connection the read waits for it; a person who has nothing to show yet is told so, instead of being left with a spinner.
  const state = !online && loaded === 'loading' ? 'offline' : loaded;
  const acting = canAct(mode) && online;
  const moment = (iso: string): string =>
    new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(`${iso}T00:00:00+07:00`));
  return (
    <>
      {online ? null : (
        <p className="callout warning" role="status" data-testid="offline-note">
          {t('doc.mobile.in.offline.notice')}
        </p>
      )}
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        <ul className="mobile-list" data-testid="letters">
          {lines.map((line) => (
            <Letter key={line.id} line={line} acting={acting} moment={moment} />
          ))}
        </ul>
        {list.hasNextPage ? (
          <button type="button" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
            {t('doc.mobile.in.more.action')}
          </button>
        ) : null}
      </StateBoundary>
      {moreFailed ? (
        <div className="callout warning" role="alert" data-testid="more-failed">
          <p>{t('doc.mobile.in.moreFailed.notice')}</p>
          <button type="button" disabled={isFetchingNextPage || !online} onClick={() => void fetchNextPage()}>
            {t('doc.mobile.in.moreRetry.action')}
          </button>
        </div>
      ) : null}
    </>
  );
}

function Letter({ line, acting, moment }: { line: IncomingLine; acting: boolean; moment: (iso: string) => string }) {
  const { t } = useTranslation();
  const start = useStartLetter();
  const resolve = useResolveLetter();
  const [resolving, setResolving] = useState(false);
  const [summary, setSummary] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const problem = validateWords(summary, 5, 2000);
  const failure = start.isError ? start.error : resolve.isError ? resolve.error : undefined;
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (!acting || resolve.isPending || problem !== undefined) return;
    resolve.mutate({ id: line.id, version: line.version, body: { resolution_summary: summary.trim() } }, { onSuccess: () => setResolving(false) });
  };
  const number = numberOf(line);
  return (
    <li className="card" data-letter={line.id} data-status={line.status} data-overdue={line.overdueDays === null ? 'no' : 'yes'}>
      <p>
        <strong data-testid="letter-title">{line.title}</strong>
      </p>
      <p className="sub">
        {number === null ? null : <span data-testid="letter-number">{t('doc.mobile.in.number', { number })} · </span>}
        {statusLabel(t, line.status)} · {urgencyLabel(t, line.urgency)} · {line.senderName}
      </p>
      <p data-testid="directive">{line.leaderDirective === null ? t('doc.mobile.in.directive.none') : t('doc.mobile.in.directive.text', { text: line.leaderDirective })}</p>
      <p data-testid="due">
        {line.dueOn === null ? t('doc.mobile.in.due.none') : t('doc.mobile.in.due.text', { date: moment(line.dueOn) })}
        {line.overdueDays === null || line.dueOn === null ? null : (
          <span className="incoming-chip danger" data-testid="overdue">
            {' '}
            {t('doc.incoming.overdue', { days: line.overdueDays, date: moment(line.dueOn) })}
          </span>
        )}
      </p>
      {failure === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="refusal">
          {problemMessage(t, describeProblem(failure))}
        </p>
      )}
      <div className="actions">
        <Link className="button" to={handlingLink(line.id)}>
          {t('doc.mobile.in.open.action')}
        </Link>
        {acting && line.actions.startProcessing ? (
          <button type="button" className="primary" data-action="start" disabled={start.isPending} onClick={() => start.mutate({ id: line.id, version: line.version })}>
            {t('doc.incoming.start.action')}
          </button>
        ) : null}
        {acting && line.actions.resolve && !resolving ? (
          <button type="button" className="primary" data-action="resolve" onClick={() => setResolving(true)}>
            {t('doc.incoming.resolve.action')}
          </button>
        ) : null}
      </div>
      {acting && resolving ? (
        <form onSubmit={send} noValidate aria-label={t('doc.incoming.resolve.title')} data-testid="resolve-form">
          {line.overdueDays === null ? null : <p className="callout warning">{t('doc.incoming.resolve.late', { days: line.overdueDays })}</p>}
          <Field id={`summary-${line.id}`} label={t('doc.incoming.field.summary')} error={submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined}>
            <textarea id={`summary-${line.id}`} rows={3} value={summary} onChange={(event) => setSummary(event.target.value)} />
          </Field>
          <div className="formfooter">
            <button type="button" onClick={() => setResolving(false)}>
              {t('doc.mobile.in.cancel.action')}
            </button>
            <button type="submit" className="primary" disabled={resolve.isPending}>
              {t('doc.incoming.resolve.submit')}
            </button>
          </div>
        </form>
      ) : null}
    </li>
  );
}
