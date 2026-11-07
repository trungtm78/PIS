import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { clock, clockAndDay, dayMonth, severitySuffix } from '../../ui/alerts/format';
import { useSnoozedWork } from '../../ui/alerts/hooks';
import { pathOfAlert, sourceLabel } from '../../ui/alerts/AlertRow';
import { snoozeReasonLabel } from '../../ui/alerts/reasons';
import { SeverityBadge } from '../../ui/alerts/SeverityBadge';
import type { SnoozedItem } from '../../ui/alerts/types';
import { ContextBar, DataTable } from '../../ui';
import type { DataTableColumn } from '../../ui';
import '../dis/dis.css';
import './home.css';
import { emptyKindOf, isPartialList, ordinalOf, snoozedRowKey } from './snoozed-model';

const NONE = '—';
const QUEUE_PATH = '/home/home-02';

/**
 * HOME-12: the work that is held by a snooze, in the scope of the reader: what, from which source, how urgent, who snoozed it, until when, why, which snooze of the run it is and the day it is due.
 * It is the place a leader finds out that something was put aside, and for how long. A source that could not be read is named (never "nothing is snoozed"), an old answer is said to be old,
 * a reader without a scope is told the scope is hidden, and the policy version the numbers were judged by is on the context line.
 */
export default function SnoozedWorkScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <SnoozedContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function SnoozedContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const tenant = useSession().tenant;
  const query = useSnoozedWork();
  const answer = query.data;
  // A failure after a good answer keeps the answer on the page and says it is old; only a failure with nothing to show is an error.
  const state = useScreenState({ isLoading: query.isLoading, error: answer === undefined ? query.error : undefined, data: answer, isEmpty: () => false });
  const stale = answer !== undefined && query.isError;
  const items = answer?.items ?? [];
  const empty = answer === undefined ? null : emptyKindOf(answer);
  const sourcesText = (answer?.unavailable_sources ?? []).map((source) => sourceLabel(t, source)).join(', ');

  const columns: DataTableColumn<SnoozedItem>[] = [
    {
      key: 'item',
      header: t('home.snoozed.column.item'),
      pinned: true,
      render: (item) => {
        const path = pathOfAlert(item);
        return (
          <>
            {path === undefined ? <strong>{item.title}</strong> : <Link to={path}>{item.title}</Link>}
            {item.subtitle === null ? null : <span className="dis-code">{item.subtitle}</span>}
          </>
        );
      },
    },
    { key: 'source', header: t('home.snoozed.column.source'), render: (item) => sourceLabel(t, item.source) },
    { key: 'severity', header: t('home.snoozed.column.severity'), render: (item) => <SeverityBadge severity={item.severity} label={t(`alerts.severity.${severitySuffix(item.severity)}`)} /> },
    { key: 'by', header: t('home.snoozed.column.by'), render: (item) => item.snooze.by?.name ?? NONE },
    {
      key: 'until',
      header: t('home.snoozed.column.until'),
      render: (item) => (
        <time dateTime={item.snooze.until} data-testid={`until-${snoozedRowKey(item)}`}>
          {clockAndDay(item.snooze.until)}
        </time>
      ),
    },
    {
      key: 'reason',
      header: t('home.snoozed.column.reason'),
      render: (item) => (
        <>
          {item.snooze.reason_code === null ? NONE : snoozeReasonLabel(t, item.snooze.reason_code)}
          {item.snooze.note === null ? null : <span className="dis-code">{item.snooze.note}</span>}
        </>
      ),
    },
    {
      key: 'ordinal',
      header: t('home.snoozed.column.ordinal'),
      render: (item) => {
        const { n, of } = ordinalOf(item);
        return <span data-testid={`ordinal-${snoozedRowKey(item)}`}>{of === null ? t('home.snoozed.ordinalOpen', { n }) : t('home.snoozed.ordinal', { n, of })}</span>;
      },
    },
    { key: 'due', header: t('home.snoozed.column.due'), render: (item) => (item.due_on === null ? NONE : dayMonth(item.due_on)) },
  ];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('home.snoozed.title')}</h1>
          <p>{t('home.snoozed.subtitle')}</p>
        </div>
      </div>
      <div className="home-stack">
        {answer === undefined ? (
          <ContextBar items={[{ label: t('home.snoozed.ctx.scope'), value: tenant?.name ?? t('home.snoozed.ctx.scopeAll') }]} />
        ) : (
          <ContextBar
            items={[
              { label: t('home.snoozed.ctx.scope'), value: tenant?.name ?? t('home.snoozed.ctx.scopeAll') },
              { label: t('home.snoozed.ctx.count'), value: String(answer.count) },
              { label: t('home.snoozed.ctx.policy'), value: answer.policy_version ?? t('home.snoozed.ctx.policyNone') },
            ]}
            {...(answer.as_of === null ? {} : { asOf: clockAndDay(answer.as_of) })}
            stale={stale}
          />
        )}
        {stale ? (
          <p className="home-queue-note home-queue-note--warn" role="status" data-testid="snoozed-stale">
            {t('home.snoozed.stale', { time: clock(new Date(query.dataUpdatedAt)) })}{' '}
            <button type="button" className="mv-alert-link" onClick={() => void query.refetch()}>
              {t('home.snoozed.retry')}
            </button>
          </p>
        ) : null}
        {answer !== undefined && answer.unavailable_sources.length > 0 ? (
          <p className="home-queue-note home-queue-note--warn" role="status" data-testid="snoozed-unavailable">
            {t('home.snoozed.unavailable', { sources: sourcesText })}{' '}
            <button type="button" className="mv-alert-link" onClick={() => void query.refetch()}>
              {t('home.snoozed.retry')}
            </button>
          </p>
        ) : null}
        {answer !== undefined && isPartialList(answer) ? (
          <p className="home-queue-note" role="status" data-testid="snoozed-truncated">
            {t('home.snoozed.truncated', { shown: items.length, count: Math.max(answer.count, items.length) })}
          </p>
        ) : null}
        <StateBoundary state={state} onRetry={() => void query.refetch()}>
          {empty === null ? (
            <DataTable caption={t('home.snoozed.title')} columns={columns} rows={items} rowKey={snoozedRowKey} severity={(item) => item.severity} />
          ) : (
            <div className="home-queue-note" role="status" data-testid="snoozed-empty" data-kind={empty}>
              <p>{empty === 'none' ? t('home.snoozed.empty.none') : t('home.snoozed.empty.unknown')}</p>
              <Link to={QUEUE_PATH} className="mv-alert-link">
                {t('home.snoozed.back')}
              </Link>
            </div>
          )}
        </StateBoundary>
      </div>
    </section>
  );
}
