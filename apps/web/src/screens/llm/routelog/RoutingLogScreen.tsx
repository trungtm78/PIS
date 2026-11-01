import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../../mne/components';
import { attemptKindLabel, outcomeLabel, rejectCodeLabel, requestStatusLabel } from '../eval-labels';
import { AUDIT_READ, NO_FILTER, REQUEST_STATUSES } from '../gateway-model';
import type { RequestFilter, RouteDecision } from '../gateway-model';
import { useRequests, useRouteDecision } from '../hooks';
import { classificationLabel, routeLabel } from '../labels';
import { CLASSIFICATIONS, FINOPS, ROUTES, vietnamDay } from '../llm-model';
import { money } from './model';
import { ReconcileSection } from './ReconcileSection';

const holds = (permissions: readonly string[] | undefined, permission: string): boolean => permissions === undefined || permissions.includes(permission);

/**
 * LLM-21: the routing log of the AI gateway and the reconciliation of the invoices of its providers (ST-LLM-008, LLM F1 and F3, BR-LLM-06). The log lists the requests with the route, provider and model each ended on, and
 * opens one to the class the server gave it and why, the policy in force, and every attempt; nothing that was asked or answered is shown. Below it, the invoices set against the attempts: the variance, its tolerance, the
 * attempts that wait for their usage, and the run that sets an invoice of a provider against a period that is over. Each part needs its own permission: reading the log, and reconciling.
 */
export default function RoutingLogScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <RoutingLogContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function RoutingLogContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('llm.routelog.title')}</h1>
          <p>{t('llm.routelog.subtitle')}</p>
        </div>
      </div>
      {holds(permissions, AUDIT_READ) ? (
        <RoutingLog />
      ) : (
        <div data-testid="log-denied">
          <StateBoundary state="denied" />
        </div>
      )}
      {holds(permissions, FINOPS) ? (
        <ReconcileSection />
      ) : (
        <div data-testid="reconcile-denied">
          <StateBoundary state="denied" />
        </div>
      )}
      <p className="prototype-note">{t('llm.routelog.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function RoutingLog() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<RequestFilter>(NO_FILTER);
  const [opened, setOpened] = useState<string | undefined>(undefined);
  const requests = useRequests(filter);
  const rows = (requests.data?.pages ?? []).flatMap((page) => page.items);
  const state = useScreenState({
    isLoading: requests.isLoading,
    error: requests.isFetchNextPageError ? null : requests.error,
    data: requests.data === undefined ? undefined : { rows },
  });
  const set = <K extends keyof RequestFilter>(field: K, value: RequestFilter[K]): void => setFilter((previous) => ({ ...previous, [field]: value }));
  return (
    <section aria-labelledby="log-title" data-testid="log-section">
      <h2 id="log-title">{t('llm.routelog.log.title')}</h2>
      <p className="sub">{t('llm.routelog.log.subtitle')}</p>
      <StateBoundary state={state} onRetry={() => void requests.refetch()}>
        <div className="card">
          <div className="mne-filters">
            <Field id="log-status" label={t('llm.requests.filter.status')} error={undefined}>
              <select id="log-status" value={filter.status} onChange={(event) => set('status', event.target.value)}>
                <option value="">{t('llm.requests.filter.all')}</option>
                {REQUEST_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {requestStatusLabel(t, status)}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="log-route" label={t('llm.requests.filter.route')} error={undefined}>
              <select id="log-route" value={filter.route} onChange={(event) => set('route', event.target.value)}>
                <option value="">{t('llm.requests.filter.all')}</option>
                {ROUTES.map((entry) => (
                  <option key={entry} value={entry}>
                    {routeLabel(t, entry)}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="log-class" label={t('llm.requests.filter.classification')} error={undefined}>
              <select id="log-class" value={filter.classification} onChange={(event) => set('classification', event.target.value)}>
                <option value="">{t('llm.requests.filter.all')}</option>
                {CLASSIFICATIONS.map((level) => (
                  <option key={level} value={level}>
                    {classificationLabel(t, level)}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="log-task" label={t('llm.requests.filter.task')} error={undefined}>
              <input id="log-task" value={filter.task} maxLength={60} onChange={(event) => set('task', event.target.value)} />
            </Field>
          </div>
        </div>
        <div className="tablewrap">
          <table className="table" data-testid="log-table" aria-label={t('llm.requests.table.aria')}>
            <thead>
              <tr>
                <th scope="col">{t('llm.requests.column.time')}</th>
                <th scope="col">{t('llm.requests.column.task')}</th>
                <th scope="col">{t('llm.requests.column.classification')}</th>
                <th scope="col">{t('llm.routelog.log.route')}</th>
                <th scope="col">{t('llm.requests.column.status')}</th>
                <th scope="col">{t('llm.requests.column.detail')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((request) => (
                <tr key={request.id} data-request-id={request.id} data-status={request.status} data-route={request.route ?? 'NONE'}>
                  <td>{vietnamDay(request.createdAt)}</td>
                  <td>
                    {request.taskType} <span className="sub">{request.subjectModule}</span>
                  </td>
                  <td>{classificationLabel(t, request.classification)}</td>
                  <td data-testid="log-route-cell">
                    {request.route === null ? t('llm.requests.noRoute') : `${routeLabel(t, request.route)} · ${request.providerCode ?? ''} · ${request.modelId ?? ''}`}
                  </td>
                  <td>
                    {requestStatusLabel(t, request.status)}
                    {request.rejectCode === null ? null : <span className="sub"> · {rejectCodeLabel(t, request.rejectCode)}</span>}
                  </td>
                  <td>
                    <button type="button" onClick={() => setOpened(request.id)}>
                      {t('llm.routelog.log.open', {
                        task: request.taskType,
                        day: vietnamDay(request.createdAt),
                      })}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 ? <p data-testid="log-none">{t('llm.requests.none')}</p> : null}
        {requests.hasNextPage ? (
          <button type="button" className="btn" data-testid="log-more" disabled={requests.isFetchingNextPage} onClick={() => void requests.fetchNextPage()}>
            {t('llm.requests.more')}
          </button>
        ) : null}
        {requests.isFetchNextPageError ? (
          <p className="callout warning" role="alert" data-testid="log-more-failed">
            {t('llm.requests.moreFailed')}
          </p>
        ) : null}
        {opened === undefined ? null : <RoutePanel key={opened} id={opened} onClose={() => setOpened(undefined)} />}
      </StateBoundary>
    </section>
  );
}

function RoutePanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const decision = useRouteDecision(id);
  const state = useScreenState({
    isLoading: decision.isLoading,
    error: decision.error,
    data: decision.data,
    isEmpty: (data) => data === null,
  });
  return (
    <section className="card" aria-label={t('llm.routing.decision')} data-testid="route-detail">
      <div className="heading">
        <h3>{t('llm.routing.decision')}</h3>
        <button type="button" onClick={onClose}>
          {t('llm.routelog.log.close')}
        </button>
      </div>
      <StateBoundary state={state} onRetry={() => void decision.refetch()}>
        {decision.data === undefined || decision.data === null ? null : <Decision decision={decision.data} />}
      </StateBoundary>
    </section>
  );
}

function Decision({ decision }: { decision: RouteDecision }) {
  const { t } = useTranslation();
  return (
    <div data-request-id={decision.requestId} data-status={decision.status}>
      <dl>
        <dt>{t('llm.routing.classification')}</dt>
        <dd data-testid="route-classification">{classificationLabel(t, decision.classification)}</dd>
        <dt>{t('llm.routing.sources')}</dt>
        <dd data-testid="route-sources">
          {decision.basis.length === 0 ? (
            t('llm.routing.noSources')
          ) : (
            <ul>
              {decision.basis.map((source) => (
                <li key={source.documentVersionId}>
                  <code>{source.documentVersionId.slice(0, 8)}</code> · {classificationLabel(t, source.classification)}
                </li>
              ))}
            </ul>
          )}
        </dd>
        <dt>{t('llm.routing.policy')}</dt>
        <dd data-testid="route-policy">{decision.policyVersionId === null ? t('llm.routing.baseline') : decision.policyVersionId}</dd>
        <dt>{t('llm.routing.route')}</dt>
        <dd data-testid="route-route">{decision.route === null ? t('llm.requests.noRoute') : `${routeLabel(t, decision.route)} · ${decision.providerCode} · ${decision.modelId}`}</dd>
        <dt>{t('llm.routing.status')}</dt>
        <dd data-testid="route-status">
          {requestStatusLabel(t, decision.status)}
          {decision.rejectCode === null ? null : <span className="sub"> · {rejectCodeLabel(t, decision.rejectCode)}</span>}
        </dd>
      </dl>
      {decision.attempts.length === 0 ? (
        <p data-testid="route-no-attempts">{t('llm.routing.noAttempts')}</p>
      ) : (
        <div className="tablewrap">
          <table className="table" data-testid="route-attempts" aria-label={t('llm.routing.attempts.aria')}>
            <thead>
              <tr>
                <th scope="col">{t('llm.routing.attempts.no')}</th>
                <th scope="col">{t('llm.routing.attempts.kind')}</th>
                <th scope="col">{t('llm.routing.attempts.route')}</th>
                <th scope="col">{t('llm.routing.attempts.model')}</th>
                <th scope="col">{t('llm.routing.attempts.outcome')}</th>
                <th scope="col">{t('llm.routing.attempts.latency')}</th>
                <th scope="col">{t('llm.routing.attempts.cost')}</th>
              </tr>
            </thead>
            <tbody>
              {decision.attempts.map((attempt) => (
                <tr key={attempt.id} data-attempt-no={attempt.no} data-route={attempt.route}>
                  <td>{attempt.no}</td>
                  <td>{attemptKindLabel(t, attempt.kind)}</td>
                  <td>{routeLabel(t, attempt.route)}</td>
                  <td>
                    {attempt.modelId} <span className="sub">{attempt.providerCode ?? ''}</span>
                  </td>
                  <td>{outcomeLabel(t, attempt.outcome)}</td>
                  <td>
                    {attempt.latencyMs === null
                      ? '—'
                      : t('llm.routing.attempts.ms', {
                          value: attempt.latencyMs,
                        })}
                  </td>
                  <td>{attempt.costVnd === null ? '—' : `${money(attempt.costVnd)} ₫`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
