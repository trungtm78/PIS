import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field } from '../mne/components';
import { LIBRARY_PATH } from './dashboard-model';
import type { Dashboard } from './dashboard-model';
import { useDashboard, useDashboards, useRevokeShare, useShareDashboard } from './hooks';
import { granteeKindLabel, rightLabel, shareProblemMessage, shareRefusalMessage, shareStateLabel } from './share-labels';
import { EMPTY_SHARE, GRANTEE_KINDS, SHARE_PERMISSION, SHARE_RIGHTS, describeShareProblem, validateShare } from './share-model';
import type { ShareForm, ShareRight } from './share-model';
import '../dis/dis.css';

const NONE = '—';

/**
 * BI-17: the sharing of a dashboard (ST-BI-007, BI F6). The owner gives a person, a role or a unit (and the units under it) the right to see the layout, or to change it, and takes it back at once. A share gives no data: the
 * warning says so, and what the figures show is judged for the reader when they are asked for. Only the owner shares; a person it is shared with sees the dashboard, not who else has it.
 */
export default function DashboardShareScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <ShareContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ShareContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const list = useDashboards();
  const chosen = params.get('dashboard') ?? undefined;
  const dashboard = useDashboard(chosen);
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data });
  const mine = (list.data ?? []).filter((candidate) => candidate.mine);
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <p className="back-link">
        <Link to={LIBRARY_PATH}>
          <span aria-hidden="true">← </span>
          {t('bi.share.back')}
        </Link>
      </p>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bi.share.title')}</h1>
          <p>{t('bi.share.subtitle')}</p>
        </div>
      </div>
      <p className="callout" data-testid="warning">
        {t('bi.share.warning')}
      </p>
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        <div className="mne-filters">
          <Field id="share-dashboard" label={t('bi.share.pick')} error={undefined}>
            <select
              id="share-dashboard"
              value={chosen ?? ''}
              onChange={(event) => {
                const next = new URLSearchParams(params);
                if (event.target.value === '') next.delete('dashboard');
                else next.set('dashboard', event.target.value);
                setParams(next, { replace: true });
              }}
            >
              <option value="">{NONE}</option>
              {mine.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.code} · {candidate.title}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {chosen === undefined ? (
          <p className="card" data-testid="pick-first">
            {t('bi.share.choose')}
          </p>
        ) : dashboard.isError ? (
          <p className="callout warning" role="alert" data-testid="read-failed">
            {t('bi.share.failed')}
          </p>
        ) : dashboard.data === undefined ? (
          <p className="sub" role="status">
            {t('bi.share.loading')}
          </p>
        ) : (
          <Sharing key={dashboard.data.id} dashboard={dashboard.data} />
        )}
      </StateBoundary>
      <p className="prototype-note">{t('bi.dash.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Sharing({ dashboard }: { dashboard: Dashboard }) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const may = dashboard.mine && mode !== 'READ_ONLY' && (permissions === undefined || permissions.includes(SHARE_PERMISSION)) && dashboard.status !== 'ARCHIVED';
  const share = useShareDashboard();
  const revoke = useRevokeShare();
  const [form, setForm] = useState<ShareForm>(EMPTY_SHARE);
  const [attempted, setAttempted] = useState(false);
  const [saved, setSaved] = useState(false);
  const problems = attempted ? validateShare(form) : {};
  const refusal = share.isError ? describeShareProblem(share.error) : revoke.isError ? describeShareProblem(revoke.error) : undefined;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setAttempted(true);
    setSaved(false);
    if (share.isPending || validateShare(form).granteeId !== undefined) return;
    revoke.reset();
    share.mutate(
      { dashboardId: dashboard.id, version: dashboard.version, form },
      {
        onSuccess: () => {
          setForm({ ...form, granteeId: '' });
          setAttempted(false);
          setSaved(true);
        },
      },
    );
  };

  return (
    <>
      <h2>{`${dashboard.code} · ${dashboard.title}`}</h2>
      {refusal === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="refusal" data-reason={refusal}>
          {shareRefusalMessage(t, refusal)}
        </p>
      )}
      {saved ? (
        <p className="callout" role="status" data-testid="saved">
          {t('bi.share.saved')}
        </p>
      ) : null}
      <section className="card" aria-labelledby="shares-title">
        <h2 id="shares-title">{t('bi.share.list.title')}</h2>
        {dashboard.shares.length === 0 ? (
          <p className="sub" data-testid="no-shares">
            {dashboard.mine ? t('bi.share.list.empty') : t('bi.share.list.hidden')}
          </p>
        ) : (
          <table className="table" data-testid="shares" aria-label={t('bi.share.list.title')}>
            <thead>
              <tr>
                <th scope="col">{t('bi.share.col.grantee')}</th>
                <th scope="col">{t('bi.share.col.right')}</th>
                <th scope="col">{t('bi.share.col.state')}</th>
                <th scope="col">{t('bi.share.col.action')}</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.shares.map((row) => (
                <tr key={row.id} data-share={row.id} data-status={row.status}>
                  <td>
                    <span className="pill gray">{granteeKindLabel(t, row.kind)}</span> {row.granteeName ?? row.granteeId}
                  </td>
                  <td>{rightLabel(t, row.permission)}</td>
                  <td>{shareStateLabel(t, row.status)}</td>
                  <td>
                    {may && row.status === 'ACTIVE' ? (
                      <button type="button" disabled={revoke.isPending} onClick={() => revoke.mutate({ shareId: row.id, version: row.version })}>
                        {t('bi.share.revoke')}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {may ? (
        <form className="card" onSubmit={submit} noValidate aria-label={t('bi.share.form.title')}>
          <h2>{t('bi.share.form.title')}</h2>
          <Field id="share-kind" label={t('bi.share.kind')} error={undefined}>
            <select id="share-kind" value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as ShareForm['kind'] })}>
              {GRANTEE_KINDS.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {granteeKindLabel(t, candidate)}
                </option>
              ))}
            </select>
          </Field>
          <Field id="share-grantee" label={t('bi.share.grantee')} error={problems.granteeId === undefined ? undefined : shareProblemMessage(t, problems.granteeId)}>
            <input id="share-grantee" value={form.granteeId} aria-invalid={problems.granteeId !== undefined} onChange={(event) => setForm({ ...form, granteeId: event.target.value })} />
          </Field>
          <Field id="share-right" label={t('bi.share.permission')} error={undefined}>
            <select id="share-right" value={form.permission} onChange={(event) => setForm({ ...form, permission: event.target.value as ShareRight })}>
              {SHARE_RIGHTS.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {rightLabel(t, candidate)}
                </option>
              ))}
            </select>
          </Field>
          <div className="formfooter">
            <button type="submit" className="primary" disabled={share.isPending}>
              {t('bi.share.submit')}
            </button>
          </div>
        </form>
      ) : (
        <p className="callout" data-testid="read-only">
          {t('bi.share.readOnly')}
        </p>
      )}
    </>
  );
}
