import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field } from '../mne/components';
import '../dis/dis.css';
import { requestStatusLabel, rejectCodeLabel } from './eval-labels';
import { NO_FILTER, REQUEST_STATUSES, ROUTING_PATH, sharePercent } from './gateway-model';
import type { RequestFilter, RequestSummary } from './gateway-model';
import { useRequests } from './hooks';
import { classificationLabel, routeLabel } from './labels';
import { CLASSIFICATIONS, ROUTES, groupDigits, vietnamDay } from './llm-model';

/**
 * LLM-01: the overview of what the AI gateway did (ST-LLM-005, LLM F1): for the month, how many requests there were, the share of each route (the international one with two places: 50 of 1,000 is 5.00 percent), how many were
 * refused by the policy or the budget before any model was called, and how many ended in failure; and below, the requests themselves, newest first, that can be narrowed by state, route, class and task, each with a link to
 * how it was routed (LLM-05). Only public data is on the international route, and the table says it for each request. Nothing here shows what was asked or answered.
 */
export default function RequestsScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <RequestsContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function RequestsContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<RequestFilter>(NO_FILTER);
  const requests = useRequests(filter);
  const pages = requests.data?.pages ?? [];
  const rows = pages.flatMap((page) => page.items);
  const summary = pages[0]?.summary;
  const state = useScreenState({ isLoading: requests.isLoading, error: requests.isFetchNextPageError ? null : requests.error, data: requests.data === undefined ? undefined : { rows } });
  const set = <K extends keyof RequestFilter>(field: K, value: RequestFilter[K]): void => setFilter((previous) => ({ ...previous, [field]: value }));
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('llm.requests.page.title')}</h1>
          <p>{t('llm.requests.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void requests.refetch()}>
        {summary === undefined ? null : <Tiles summary={summary} />}
        <div className="card">
          <div className="mne-filters">
            <Field id="requests-status" label={t('llm.requests.filter.status')} error={undefined}>
              <select id="requests-status" value={filter.status} onChange={(event) => set('status', event.target.value)}>
                <option value="">{t('llm.requests.filter.all')}</option>
                {REQUEST_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {requestStatusLabel(t, status)}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="requests-route" label={t('llm.requests.filter.route')} error={undefined}>
              <select id="requests-route" value={filter.route} onChange={(event) => set('route', event.target.value)}>
                <option value="">{t('llm.requests.filter.all')}</option>
                {ROUTES.map((entry) => (
                  <option key={entry} value={entry}>
                    {routeLabel(t, entry)}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="requests-class" label={t('llm.requests.filter.classification')} error={undefined}>
              <select id="requests-class" value={filter.classification} onChange={(event) => set('classification', event.target.value)}>
                <option value="">{t('llm.requests.filter.all')}</option>
                {CLASSIFICATIONS.map((level) => (
                  <option key={level} value={level}>
                    {classificationLabel(t, level)}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="requests-task" label={t('llm.requests.filter.task')} error={undefined}>
              <input id="requests-task" value={filter.task} maxLength={60} onChange={(event) => set('task', event.target.value)} />
            </Field>
          </div>
        </div>
        <table className="table" data-testid="request-table" aria-label={t('llm.requests.table.aria')}>
          <thead>
            <tr>
              <th scope="col">{t('llm.requests.column.time')}</th>
              <th scope="col">{t('llm.requests.column.task')}</th>
              <th scope="col">{t('llm.requests.column.classification')}</th>
              <th scope="col">{t('llm.requests.column.route')}</th>
              <th scope="col">{t('llm.requests.column.model')}</th>
              <th scope="col">{t('llm.requests.column.status')}</th>
              <th scope="col">{t('llm.requests.column.cost')}</th>
              <th scope="col">{t('llm.requests.column.detail')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((request) => (
              <tr key={request.id} data-request-id={request.id} data-status={request.status} data-route={request.route ?? 'NONE'} data-classification={request.classification}>
                <td>{vietnamDay(request.createdAt)}</td>
                <td>
                  {request.taskType} <span className="sub">{request.subjectModule}</span>
                </td>
                <td>{classificationLabel(t, request.classification)}</td>
                <td>{request.route === null ? t('llm.requests.noRoute') : routeLabel(t, request.route)}</td>
                <td>{request.modelId ?? t('llm.requests.noRoute')}</td>
                <td>
                  {requestStatusLabel(t, request.status)}
                  {request.rejectCode === null ? null : <span className="sub"> · {rejectCodeLabel(t, request.rejectCode)}</span>}
                </td>
                <td>{request.costVnd === null ? '—' : `${groupDigits(request.costVnd)} ₫`}</td>
                <td>
                  <Link to={`${ROUTING_PATH}?request=${request.id}`}>{t('llm.requests.route')}</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 ? <p data-testid="requests-none">{t('llm.requests.none')}</p> : null}
        {requests.hasNextPage ? (
          <button type="button" className="btn" data-testid="requests-more" disabled={requests.isFetchingNextPage} onClick={() => void requests.fetchNextPage()}>
            {t('llm.requests.more')}
          </button>
        ) : null}
        {requests.isFetchNextPageError ? (
          <p className="callout warning" role="alert" data-testid="requests-more-failed">
            {t('llm.requests.moreFailed')}
          </p>
        ) : null}
      </StateBoundary>
    </section>
  );
}

function Tiles({ summary }: { summary: RequestSummary }) {
  const { t } = useTranslation();
  const failed = (summary.byStatus.FAILED ?? 0) + (summary.byStatus.REJECTED_NO_CITATION ?? 0);
  return (
    <div className="card" data-testid="request-tiles">
      <h2>{t('llm.requests.month', { month: summary.periodStart.slice(0, 7) })}</h2>
      <ul className="list-plain">
        <li data-tile="total">
          {t('llm.requests.tile.total')}: <strong>{groupDigits(String(summary.total))}</strong>
        </li>
        {ROUTES.map((entry) => (
          <li key={entry} data-tile={entry}>
            {routeLabel(t, entry)}: <strong>{groupDigits(String(summary.byRoute[entry] ?? 0))}</strong> · <span data-share={entry}>{sharePercent(summary.byRoute[entry] ?? 0, summary.total)}%</span>
          </li>
        ))}
        <li data-tile="blocked">
          {t('llm.requests.tile.blocked')}: <strong>{groupDigits(String(summary.blocked))}</strong>
        </li>
        <li data-tile="failed">
          {t('llm.requests.tile.failed')}: <strong>{groupDigits(String(failed))}</strong>
        </li>
      </ul>
      <p className="sub">{t('llm.requests.internationalNote')}</p>
    </div>
  );
}
