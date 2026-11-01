import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field } from '../mne/components';
import { audienceLabel, createProblemMessage, dashboardStatusLabel, refusalMessage, versionStateLabel } from './dashboard-labels';
import { BUILDER_PATH, CHART_PATH, EMPTY_CREATE, MANAGE_DASHBOARD_PERMISSION, describeDashboardProblem, validateCreate } from './dashboard-model';
import type { CreateForm } from './dashboard-model';
import { useCreateDashboard, useDashboards } from './hooks';
import { SHARE_PATH } from './share-model';

/**
 * BI-01: the library of dashboards (ST-BI-005, BI F5): the dashboards of the caller and those the tenant published to its library, each with its owner, its state and the version it points to, and whether
 * every metric of that version is still certified. A person with the right makes a dashboard here and goes on to the builder (BI-03) to give it a layout.
 */
export default function DashboardLibraryScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <LibraryContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function LibraryContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const mayManage = (permissions === undefined || permissions.includes(MANAGE_DASHBOARD_PERMISSION)) && mode !== 'READ_ONLY';
  const list = useDashboards();
  const create = useCreateDashboard();
  const [form, setForm] = useState<CreateForm>(EMPTY_CREATE);
  const [attempted, setAttempted] = useState(false);
  const [saved, setSaved] = useState<string | undefined>(undefined);
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data });
  const problems = attempted ? validateCreate(form) : {};
  const refusal = create.isError ? describeDashboardProblem(create.error) : undefined;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setAttempted(true);
    if (create.isPending || validateCreate(form).code !== undefined || validateCreate(form).title !== undefined) return;
    create.mutate(form, {
      onSuccess: (made) => {
        setForm(EMPTY_CREATE);
        setAttempted(false);
        setSaved((made as { resource_id?: string }).resource_id);
      },
    });
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bi.dash.library.title')}</h1>
          <p>{t('bi.dash.library.subtitle')}</p>
        </div>
        <Link to={CHART_PATH}>{t('bi.dash.library.chart')}</Link>
      </div>
      {saved === undefined ? null : (
        <p className="callout" role="status" data-testid="saved">
          {t('bi.dash.create.saved')}{' '}
          <Link to={`${BUILDER_PATH}?dashboard=${saved}`}>{t('bi.dash.create.open')}</Link>
        </p>
      )}
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        <ul className="cards" data-testid="library">
          {(list.data ?? []).map((dashboard) => (
            <li key={dashboard.id} className="card" data-dashboard={dashboard.id} data-status={dashboard.status}>
              <h2>{dashboard.title}</h2>
              <p className="sub">{dashboard.code}</p>
              <p>
                <span className="pill">{dashboardStatusLabel(t, dashboard.status)}</span> <span className="pill gray">{audienceLabel(t, dashboard.audience)}</span>
              </p>
              <p data-testid="owner">{dashboard.mine ? t('bi.dash.library.mine') : t('bi.dash.library.owner', { name: dashboard.ownerName ?? dashboard.ownerId })}</p>
              {dashboard.current === null ? (
                <p className="sub" data-testid="no-version">
                  {t('bi.dash.library.noVersion')}
                </p>
              ) : (
                <p data-testid="current-version">
                  {t('bi.dash.library.version', { revision: dashboard.current.revision, state: versionStateLabel(t, dashboard.current.status), count: dashboard.current.metricCount })}{' '}
                  {dashboard.current.metricsCertified ? (
                    <span className="pill" data-testid="certified">
                      {t('bi.dash.library.certified')}
                    </span>
                  ) : (
                    <span className="pill warn" data-testid="not-certified">
                      {t('bi.dash.library.notCertified')}
                    </span>
                  )}
                </p>
              )}
              <Link to={`${BUILDER_PATH}?dashboard=${dashboard.id}`}>{dashboard.mayEdit && mayManage ? t('bi.dash.library.edit') : t('bi.dash.library.view')}</Link>
              {dashboard.mine ? (
                <>
                  {' '}
                  <Link to={`${SHARE_PATH}?dashboard=${dashboard.id}`}>{t('bi.dash.library.share')}</Link>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      </StateBoundary>
      {mayManage ? (
        <form className="card" onSubmit={submit} noValidate aria-label={t('bi.dash.create.title')}>
          <h2>{t('bi.dash.create.title')}</h2>
          <p className="sub">{t('bi.dash.create.help')}</p>
          {refusal === undefined ? null : (
            <p className="callout warning" role="alert" data-testid="refusal" data-reason={refusal.reason}>
              {refusalMessage(t, refusal.reason)}
            </p>
          )}
          <Field id="dash-code" label={t('bi.dash.create.code.label')} error={problems.code === undefined ? undefined : createProblemMessage(t, problems.code)}>
            <input id="dash-code" value={form.code} aria-invalid={problems.code !== undefined} onChange={(event) => setForm({ ...form, code: event.target.value })} />
          </Field>
          <Field id="dash-title" label={t('bi.dash.create.title.label')} error={problems.title === undefined ? undefined : createProblemMessage(t, problems.title)}>
            <input id="dash-title" value={form.title} aria-invalid={problems.title !== undefined} onChange={(event) => setForm({ ...form, title: event.target.value })} />
          </Field>
          <div className="formfooter">
            <button type="submit" className="primary" disabled={create.isPending}>
              {t('bi.dash.create.submit')}
            </button>
          </div>
        </form>
      ) : null}
      <p className="prototype-note">{t('bi.dash.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
