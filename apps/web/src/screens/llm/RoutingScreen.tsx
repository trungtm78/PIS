import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field } from '../mne/components';
import '../dis/dis.css';
import { attemptKindLabel, outcomeLabel, rejectCodeLabel, requestStatusLabel } from './eval-labels';
import { REQUESTS_PATH } from './gateway-model';
import type { RouteDecision } from './gateway-model';
import { useRequests, useRouteDecision } from './hooks';
import { classificationLabel, routeLabel } from './labels';
import { NO_FILTER } from './gateway-model';
import { groupDigits, vietnamDay } from './llm-model';
import './llm-kit.css';

/**
 * LLM-05: how a request of the AI gateway was routed (ST-LLM-005, LLM F1, BR-LLM-01, BR-LLM-02): the class the server gave it and the sources that gave it, the policy in force when it was made (or the baseline, when none was),
 * the route, provider and model it ended on, and every attempt in order (the primary, a retry of an answer that failed the checks, a fallback inside the allowed routes) with how each ended and what it cost. A request that was
 * refused says why and shows no attempt. Nothing of what was asked or answered is here.
 */
export default function RoutingScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <RoutingContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function RoutingContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const asked = params.get('request') ?? undefined;
  const recent = useRequests(NO_FILTER);
  const decision = useRouteDecision(asked);
  const choices = (recent.data?.pages ?? []).flatMap((page) => page.items);
  const state = useScreenState({ isLoading: asked !== undefined && decision.isLoading, error: asked === undefined ? undefined : decision.error, data: asked === undefined ? { rows: [] } : decision.data === undefined ? undefined : { rows: decision.data === null ? [] : [decision.data] } });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('llm.routing.page.title')}</h1>
          <p>{t('llm.routing.page.subtitle')}</p>
        </div>
        <Link to={REQUESTS_PATH}>{t('llm.routing.back')}</Link>
      </div>
      <div className="card">
        <Field id="routing-request" label={t('llm.routing.choose')} error={undefined}>
          <select id="routing-request" value={asked ?? ''} onChange={(event) => setParams(event.target.value === '' ? {} : { request: event.target.value }, { replace: true })}>
            <option value="">{t('llm.routing.chooseNone')}</option>
            {asked !== undefined && !choices.some((request) => request.id === asked) ? <option value={asked}>{asked.slice(0, 8)}</option> : null}
            {choices.map((request) => (
              <option key={request.id} value={request.id}>
                {vietnamDay(request.createdAt)} · {request.taskType} · {requestStatusLabel(t, request.status)}
              </option>
            ))}
          </select>
        </Field>
        {recent.isError ? (
          <p className="callout warning" role="alert" data-testid="routing-list-failed">
            {t('llm.routing.listFailed')}{' '}
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void recent.refetch()}>
              {t('llm.routing.listRetry')}
            </button>
          </p>
        ) : null}
      </div>
      <StateBoundary state={state} onRetry={() => void decision.refetch()}>
        {asked === undefined ? <p data-testid="routing-pick">{t('llm.routing.pick')}</p> : decision.data === undefined || decision.data === null ? <p data-testid="routing-unreadable">{t('llm.routing.unreadable')}</p> : <Decision decision={decision.data} />}
      </StateBoundary>
    </section>
  );
}

function Decision({ decision }: { decision: RouteDecision }) {
  const { t } = useTranslation();
  return (
    <div data-request-id={decision.requestId} data-status={decision.status}>
      <div className="card">
        <h2>{t('llm.routing.decision')}</h2>
        <dl>
          <dt>{t('llm.routing.classification')}</dt>
          <dd data-testid="routing-classification">{classificationLabel(t, decision.classification)}</dd>
          <dt>{t('llm.routing.policy')}</dt>
          <dd data-testid="routing-policy">{decision.policyVersionId === null ? t('llm.routing.baseline') : decision.policyVersionId}</dd>
          <dt>{t('llm.routing.route')}</dt>
          <dd data-testid="routing-route">{decision.route === null ? t('llm.requests.noRoute') : `${routeLabel(t, decision.route)} · ${decision.providerCode} · ${decision.modelId}`}</dd>
          <dt>{t('llm.routing.status')}</dt>
          <dd data-testid="routing-status">
            {requestStatusLabel(t, decision.status)}
            {decision.rejectCode === null ? null : <span className="sub"> · {rejectCodeLabel(t, decision.rejectCode)}</span>}
          </dd>
        </dl>
        <h3>{t('llm.routing.sources')}</h3>
        <ul data-testid="routing-sources">
          {decision.basis.map((source) => (
            <li key={source.documentVersionId}>
              <code>{source.documentVersionId.slice(0, 8)}</code> · {classificationLabel(t, source.classification)}
            </li>
          ))}
        </ul>
        {decision.basis.length === 0 ? <p className="sub">{t('llm.routing.noSources')}</p> : null}
      </div>
      <div className="tablewrap" role="region" aria-label={t('llm.routing.attempts.aria')} tabIndex={0}>
        <table className="table" data-testid="attempt-table" aria-label={t('llm.routing.attempts.aria')}>
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
                <td>{attempt.latencyMs === null ? '—' : t('llm.routing.attempts.ms', { value: attempt.latencyMs })}</td>
                <td>{attempt.costVnd === null ? '—' : `${groupDigits(attempt.costVnd)} ₫`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {decision.attempts.length === 0 ? <p data-testid="routing-no-attempts">{t('llm.routing.noAttempts')}</p> : null}
    </div>
  );
}
