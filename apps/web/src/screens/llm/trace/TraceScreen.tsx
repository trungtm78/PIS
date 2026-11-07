import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../../mne/components';
import { attemptKindLabel, outcomeLabel, rejectCodeLabel, requestStatusLabel } from '../eval-labels';
import { evalCost } from '../eval-model';
import { AUDIT_READ, NO_FILTER, REQUEST_STATUSES } from '../gateway-model';
import type { RequestEntry, RequestFilter, RouteDecision } from '../gateway-model';
import { useRequests, useRouteDecision } from '../hooks';
import { classificationLabel, routeLabel } from '../labels';
import { CLASSIFICATIONS, ROUTES, vietnamDay } from '../llm-model';
import { GUARDRAIL_PATH, isError, matches, maskPersonal, shortId } from './model';
import '../llm-kit.css';

const holds = (permissions: readonly string[] | undefined, permission: string): boolean => permissions === undefined || permissions.includes(permission);

/**
 * LLM-14: the traces and errors of the AI gateway (ST-LLM-009, UAT-AC465): one line for each request with its task, model, route, the class the data were given and the rule that stopped it, if one did; a trace opens to every
 * call the gateway made for it with the outcome and the time each took. The trace is hidden of personal numbers and holds neither what was asked nor what was answered, and no chain of thought is kept.
 */
export default function TraceScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <TraceContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function TraceContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('llm.trace.page.title')}</h1>
          <p>{t('llm.trace.page.subtitle')}</p>
        </div>
      </div>
      <p className="callout" data-testid="trace-note">
        {t('llm.trace.privacy.note')}
      </p>
      {holds(permissions, AUDIT_READ) ? (
        <Traces />
      ) : (
        <div data-testid="trace-denied">
          <StateBoundary state="denied" />
        </div>
      )}
      <p className="prototype-note">{t('llm.trace.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Traces() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const opened = params.get('trace') ?? undefined;
  const [filter, setFilter] = useState<RequestFilter>(NO_FILTER);
  const [words, setWords] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(false);
  const requests = useRequests(filter);
  const loaded = (requests.data?.pages ?? []).flatMap((page) => page.items);
  const rows = loaded.filter((entry) => matches(entry, words) && (!errorsOnly || isError(entry)));
  const state = useScreenState({ isLoading: requests.isLoading, error: requests.isFetchNextPageError ? null : requests.error, data: requests.data === undefined ? undefined : { items: loaded } });
  const set = <K extends keyof RequestFilter>(field: K, value: RequestFilter[K]): void => setFilter((previous) => ({ ...previous, [field]: value }));
  const open = (id: string | undefined): void => setParams(id === undefined ? {} : { trace: id }, { replace: true });
  return (
    <>
      <div className="card">
        <div className="mne-filters">
          <Field id="trace-words" label={t('llm.trace.filter.search')} error={undefined}>
            <input id="trace-words" value={words} maxLength={80} onChange={(event) => setWords(event.target.value)} />
          </Field>
          <Field id="trace-status" label={t('llm.requests.filter.status')} error={undefined}>
            <select id="trace-status" value={filter.status} onChange={(event) => set('status', event.target.value)}>
              <option value="">{t('llm.requests.filter.all')}</option>
              {REQUEST_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {requestStatusLabel(t, status)}
                </option>
              ))}
            </select>
          </Field>
          <Field id="trace-route" label={t('llm.requests.filter.route')} error={undefined}>
            <select id="trace-route" value={filter.route} onChange={(event) => set('route', event.target.value)}>
              <option value="">{t('llm.requests.filter.all')}</option>
              {ROUTES.map((entry) => (
                <option key={entry} value={entry}>
                  {routeLabel(t, entry)}
                </option>
              ))}
            </select>
          </Field>
          <Field id="trace-class" label={t('llm.requests.filter.classification')} error={undefined}>
            <select id="trace-class" value={filter.classification} onChange={(event) => set('classification', event.target.value)}>
              <option value="">{t('llm.requests.filter.all')}</option>
              {CLASSIFICATIONS.map((level) => (
                <option key={level} value={level}>
                  {classificationLabel(t, level)}
                </option>
              ))}
            </select>
          </Field>
          <Field id="trace-task" label={t('llm.requests.filter.task')} error={undefined}>
            <input id="trace-task" value={filter.task} maxLength={60} onChange={(event) => set('task', event.target.value)} />
          </Field>
          <label className="field" htmlFor="trace-errors">
            <input id="trace-errors" type="checkbox" checked={errorsOnly} onChange={(event) => setErrorsOnly(event.target.checked)} /> {t('llm.trace.filter.errors')}
          </label>
        </div>
        <p className="sub">
          <Link to={GUARDRAIL_PATH}>{t('llm.trace.guardrail.link')}</Link>
        </p>
      </div>
      <StateBoundary state={state} onRetry={() => void requests.refetch()}>
        <div className="tablewrap">
          <table className="table" data-testid="trace-table" aria-label={t('llm.trace.table.aria')}>
            <thead>
              <tr>
                <th scope="col">{t('llm.trace.column.id')}</th>
                <th scope="col">{t('llm.trace.column.task')}</th>
                <th scope="col">{t('llm.trace.column.model')}</th>
                <th scope="col">{t('llm.trace.column.classification')}</th>
                <th scope="col">{t('llm.trace.column.route')}</th>
                <th scope="col">{t('llm.trace.column.error')}</th>
                <th scope="col">{t('llm.trace.column.open')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((entry) => (
                <Row key={entry.id} entry={entry} onOpen={() => open(entry.id)} />
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 ? <p data-testid="trace-none">{t('llm.trace.none.notice')}</p> : null}
        {requests.hasNextPage ? (
          <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="trace-more" disabled={requests.isFetchingNextPage} onClick={() => void requests.fetchNextPage()}>
            {t('llm.requests.more')}
          </button>
        ) : null}
        {requests.isFetchNextPageError ? (
          <p className="callout warning" role="alert" data-testid="trace-more-failed">
            {t('llm.requests.moreFailed')}
          </p>
        ) : null}
      </StateBoundary>
      {opened === undefined ? null : <TracePanel key={opened} id={opened} onClose={() => open(undefined)} />}
    </>
  );
}

function Row({ entry, onOpen }: { entry: RequestEntry; onOpen: () => void }) {
  const { t } = useTranslation();
  return (
    <tr data-request-id={entry.id} data-status={entry.status}>
      <td>
        <code title={entry.id}>{shortId(entry.id)}</code> <span className="sub">{vietnamDay(entry.createdAt)}</span>
      </td>
      <td>
        {maskPersonal(entry.taskType)} <span className="sub">{maskPersonal(entry.subjectModule)}</span>
      </td>
      <td>{entry.modelId === null ? '—' : `${maskPersonal(entry.modelId)} · ${maskPersonal(entry.providerCode ?? '')}`}</td>
      <td>{classificationLabel(t, entry.classification)}</td>
      <td>{entry.route === null ? t('llm.requests.noRoute') : routeLabel(t, entry.route)}</td>
      <td>
        {requestStatusLabel(t, entry.status)}
        {entry.rejectCode === null ? null : <span className="sub"> · {maskPersonal(rejectCodeLabel(t, entry.rejectCode))}</span>}
      </td>
      <td>
        <button type="button" onClick={onOpen}>
          {t('llm.trace.open.action', { id: shortId(entry.id) })}
        </button>
      </td>
    </tr>
  );
}

function TracePanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const decision = useRouteDecision(id);
  const state = useScreenState({ isLoading: decision.isLoading, error: decision.error, data: decision.data, isEmpty: (data) => data === null });
  return (
    <section className="card" aria-label={t('llm.trace.detail.title')} data-testid="trace-detail">
      <div className="heading">
        <h2>{t('llm.trace.detail.title')}</h2>
        <button type="button" onClick={onClose}>
          {t('llm.trace.detail.close')}
        </button>
      </div>
      <StateBoundary state={state} onRetry={() => void decision.refetch()}>
        {decision.data === undefined || decision.data === null ? null : <Detail decision={decision.data} />}
      </StateBoundary>
    </section>
  );
}

function Detail({ decision }: { decision: RouteDecision }) {
  const { t } = useTranslation();
  const slowest = decision.attempts.reduce((most, attempt) => Math.max(most, attempt.latencyMs ?? 0), 0);
  return (
    <div data-request-id={decision.requestId} data-status={decision.status}>
      <dl>
        <dt>{t('llm.trace.column.id')}</dt>
        <dd data-testid="detail-id">{decision.requestId}</dd>
        <dt>{t('llm.trace.column.classification')}</dt>
        <dd data-testid="detail-classification">{classificationLabel(t, decision.classification)}</dd>
        <dt>{t('llm.trace.column.route')}</dt>
        <dd data-testid="detail-route">
          {decision.route === null ? t('llm.requests.noRoute') : `${routeLabel(t, decision.route)} · ${maskPersonal(decision.providerCode)} · ${maskPersonal(decision.modelId)}`}
        </dd>
        <dt>{t('llm.trace.column.error')}</dt>
        <dd data-testid="detail-status">
          {requestStatusLabel(t, decision.status)}
          {decision.rejectCode === null ? null : <span className="sub"> · {maskPersonal(rejectCodeLabel(t, decision.rejectCode))}</span>}
        </dd>
        <dt>{t('llm.trace.detail.slowest')}</dt>
        <dd data-testid="detail-latency">{slowest === 0 ? '—' : t('llm.routing.attempts.ms', { value: slowest })}</dd>
      </dl>
      {decision.attempts.length === 0 ? (
        <p data-testid="detail-no-attempts">{t('llm.routing.noAttempts')}</p>
      ) : (
        <div className="tablewrap">
          <table className="table" data-testid="detail-attempts" aria-label={t('llm.routing.attempts.aria')}>
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
                <tr key={attempt.id} data-attempt-no={attempt.no}>
                  <td>{attempt.no}</td>
                  <td>{attemptKindLabel(t, attempt.kind)}</td>
                  <td>{routeLabel(t, attempt.route)}</td>
                  <td>
                    {maskPersonal(attempt.modelId)} <span className="sub">{maskPersonal(attempt.providerCode ?? '')}</span>
                  </td>
                  <td>{maskPersonal(outcomeLabel(t, attempt.outcome))}</td>
                  <td>{attempt.latencyMs === null ? '—' : t('llm.routing.attempts.ms', { value: attempt.latencyMs })}</td>
                  <td>{attempt.costVnd === null ? '—' : `${evalCost(attempt.costVnd)} ₫`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
