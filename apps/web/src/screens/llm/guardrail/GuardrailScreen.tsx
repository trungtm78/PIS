import { useState } from 'react';
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../../mne/components';
import { rejectCodeLabel, requestStatusLabel } from '../eval-labels';
import { AUDIT_READ, NO_FILTER } from '../gateway-model';
import { usePolicies, useRequests } from '../hooks';
import { classificationLabel, routeLabel } from '../labels';
import { CLASSIFICATIONS, matrixInForce, vietnamDay } from '../llm-model';
import { TRACE_PATH, maskPersonal, shortId } from '../trace/model';
import { useGuardProfiles } from './hooks';
import { POLICY_READ_PERMISSION, PROFILE_READ_PERMISSION, refusals } from './model';
import '../llm-kit.css';

const holds = (permissions: readonly string[] | undefined, permission: string): boolean => permissions === undefined || permissions.includes(permission);
const CONTROLS = ['pii', 'tools', 'untrusted', 'citation', 'storage'] as const;

/**
 * LLM-15: the guardrails and the data of the AI gateway (ST-LLM-009, BR-LLM-11, UAT-AC466). What the gateway holds every request to, whatever the profile; what each published profile may call and how long it keeps; the routes each
 * class of data may take; and the requests a guardrail refused, each with the rule that refused it. Each part needs its own right to read. Nothing here shows what was asked or answered, and no personal number is shown.
 */
export default function GuardrailScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is typed belongs to one member of one tenant: a switch starts the screen over.
  return <GuardrailContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function GuardrailContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const part = (permission: string, name: string, content: ReactElement) =>
    holds(permissions, permission) ? (
      content
    ) : (
      <div data-testid={`${name}-denied`}>
        <StateBoundary state="denied" />
      </div>
    );
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('llm.guardrail.page.title')}</h1>
          <p>{t('llm.guardrail.page.subtitle')}</p>
        </div>
      </div>
      <Controls />
      {part(PROFILE_READ_PERMISSION, 'profiles', <ProfileGuards />)}
      {part(POLICY_READ_PERMISSION, 'routes', <RouteMatrix />)}
      {part(AUDIT_READ, 'refusals', <Refusals />)}
      <p className="prototype-note">{t('llm.guardrail.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Controls() {
  const { t } = useTranslation();
  const rules: Record<(typeof CONTROLS)[number], { name: string; holds: string }> = {
    pii: { name: t('llm.guardrail.control.pii.name'), holds: t('llm.guardrail.control.pii.holds') },
    tools: { name: t('llm.guardrail.control.tools.name'), holds: t('llm.guardrail.control.tools.holds') },
    untrusted: { name: t('llm.guardrail.control.untrusted.name'), holds: t('llm.guardrail.control.untrusted.holds') },
    citation: { name: t('llm.guardrail.control.citation.name'), holds: t('llm.guardrail.control.citation.holds') },
    storage: { name: t('llm.guardrail.control.storage.name'), holds: t('llm.guardrail.control.storage.holds') },
  };
  return (
    <section className="card" aria-labelledby="controls-title" data-testid="guardrail-controls">
      <h2 id="controls-title">{t('llm.guardrail.controls.title')}</h2>
      <p className="sub">{t('llm.guardrail.controls.subtitle')}</p>
      <dl>
        {CONTROLS.map((control) => (
          <div key={control} data-control={control}>
            <dt>{rules[control].name}</dt>
            <dd>{rules[control].holds}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ProfileGuards() {
  const { t } = useTranslation();
  const profiles = useGuardProfiles();
  const state = useScreenState({ isLoading: profiles.isLoading, error: profiles.error, data: profiles.data });
  return (
    <section aria-labelledby="profiles-title" data-testid="guardrail-profiles">
      <h2 id="profiles-title">{t('llm.guardrail.profiles.title')}</h2>
      <StateBoundary state={state} onRetry={() => void profiles.refetch()}>
        <div className="tablewrap">
          <table className="table" aria-label={t('llm.guardrail.profiles.aria')}>
            <thead>
              <tr>
                <th scope="col">{t('llm.guardrail.profiles.task')}</th>
                <th scope="col">{t('llm.guardrail.profiles.tools')}</th>
                <th scope="col">{t('llm.guardrail.profiles.routes')}</th>
                <th scope="col">{t('llm.guardrail.profiles.ceiling')}</th>
                <th scope="col">{t('llm.guardrail.profiles.retention')}</th>
              </tr>
            </thead>
            <tbody>
              {(profiles.data ?? []).map((profile) => (
                <tr key={profile.id} data-profile-id={profile.id}>
                  <td>
                    {maskPersonal(profile.taskType)} <span className="sub">#{profile.revision}</span>
                  </td>
                  <td>{profile.tools.length === 0 ? t('llm.guardrail.profiles.noTools') : profile.tools.map(maskPersonal).join(', ')}</td>
                  <td>{profile.routes.length === 0 ? '—' : profile.routes.map((entry) => routeLabel(t, entry)).join(', ')}</td>
                  <td>{profile.maxClassification === null ? '—' : classificationLabel(t, profile.maxClassification)}</td>
                  <td>{profile.retentionDays === null ? '—' : t('llm.guardrail.profiles.days', { value: profile.retentionDays })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </StateBoundary>
    </section>
  );
}

function RouteMatrix() {
  const { t } = useTranslation();
  const policies = usePolicies();
  const state = useScreenState({ isLoading: policies.isLoading, error: policies.error, data: policies.data, isEmpty: () => false });
  const matrix = policies.data === undefined ? undefined : matrixInForce(policies.data);
  return (
    <section aria-labelledby="routes-title" data-testid="guardrail-routes">
      <h2 id="routes-title">{t('llm.guardrail.routes.title')}</h2>
      <StateBoundary state={state} onRetry={() => void policies.refetch()}>
        <p className="sub" data-testid="routes-source">
          {policies.data?.inForce === undefined ? t('llm.guardrail.routes.baseline') : t('llm.guardrail.routes.policy', { revision: policies.data.inForce.revision })}
        </p>
        <div className="tablewrap">
          <table className="table" aria-label={t('llm.guardrail.routes.aria')}>
            <thead>
              <tr>
                <th scope="col">{t('llm.guardrail.routes.class')}</th>
                <th scope="col">{t('llm.guardrail.routes.allowed')}</th>
              </tr>
            </thead>
            <tbody>
              {CLASSIFICATIONS.map((level) => (
                <tr key={level} data-classification={level}>
                  <td>{classificationLabel(t, level)}</td>
                  <td>{matrix === undefined || matrix[level].length === 0 ? t('llm.guardrail.routes.none') : matrix[level].map((entry) => routeLabel(t, entry)).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </StateBoundary>
    </section>
  );
}

function Refusals() {
  const { t } = useTranslation();
  const [words, setWords] = useState('');
  const policy = useRequests({ ...NO_FILTER, status: 'REJECTED_POLICY' });
  const citation = useRequests({ ...NO_FILTER, status: 'REJECTED_NO_CITATION' });
  const loaded = [...(policy.data?.pages ?? []), ...(citation.data?.pages ?? [])].flatMap((page) => page.items);
  const rows = refusals(loaded, words);
  const pagingFailed = policy.isFetchNextPageError || citation.isFetchNextPageError;
  const state = useScreenState({
    isLoading: policy.isLoading || citation.isLoading,
    error: pagingFailed ? null : (policy.error ?? citation.error),
    data: policy.data === undefined || citation.data === undefined ? undefined : { items: loaded },
  });
  const more = policy.hasNextPage || citation.hasNextPage;
  return (
    <section aria-labelledby="refusals-title" data-testid="guardrail-refusals">
      <h2 id="refusals-title">{t('llm.guardrail.refusals.title')}</h2>
      <p className="sub">{t('llm.guardrail.refusals.subtitle')}</p>
      <StateBoundary
        state={state}
        onRetry={() => {
          void policy.refetch();
          void citation.refetch();
        }}
      >
        <div className="card">
          <Field id="refusals-words" label={t('llm.guardrail.refusals.search')} error={undefined}>
            <input id="refusals-words" value={words} maxLength={80} onChange={(event) => setWords(event.target.value)} />
          </Field>
        </div>
        <div className="tablewrap">
          <table className="table" data-testid="refusals-table" aria-label={t('llm.guardrail.refusals.aria')}>
            <thead>
              <tr>
                <th scope="col">{t('llm.guardrail.refusals.trace')}</th>
                <th scope="col">{t('llm.guardrail.refusals.task')}</th>
                <th scope="col">{t('llm.guardrail.refusals.class')}</th>
                <th scope="col">{t('llm.guardrail.refusals.rule')}</th>
                <th scope="col">{t('llm.guardrail.refusals.status')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((entry) => (
                <tr key={entry.id} data-request-id={entry.id} data-status={entry.status}>
                  <td>
                    <Link to={`${TRACE_PATH}?trace=${entry.id}`}>
                      <code>{shortId(entry.id)}</code>
                    </Link>{' '}
                    <span className="sub">{vietnamDay(entry.createdAt)}</span>
                  </td>
                  <td>{maskPersonal(entry.taskType)}</td>
                  <td>{classificationLabel(t, entry.classification)}</td>
                  <td data-testid="refusal-rule">
                    {entry.rejectCode === null ? '—' : maskPersonal(rejectCodeLabel(t, entry.rejectCode))}
                    {entry.rejectCode === null ? null : (
                      <>
                        {' '}
                        <code>{maskPersonal(entry.rejectCode)}</code>
                      </>
                    )}
                  </td>
                  <td>{requestStatusLabel(t, entry.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 ? <p data-testid="refusals-none">{t('llm.guardrail.refusals.none')}</p> : null}
        {more ? (
          <button
            type="button"
            className="ui-button ui-button--outline ui-button--small"
            data-testid="refusals-more"
            disabled={policy.isFetchingNextPage || citation.isFetchingNextPage}
            onClick={() => {
              if (policy.hasNextPage) void policy.fetchNextPage();
              if (citation.hasNextPage) void citation.fetchNextPage();
            }}
          >
            {t('llm.requests.more')}
          </button>
        ) : null}
        {pagingFailed ? (
          <p className="callout warning" role="alert" data-testid="refusals-more-failed">
            {t('llm.requests.moreFailed')}
          </p>
        ) : null}
      </StateBoundary>
    </section>
  );
}
