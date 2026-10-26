import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { CreateDialog } from './dialogs';
import { useEngagements } from './hooks';
import type { EngagementFilter } from './hooks';
import { authorityKindLabel, engagementStatusLabel, engagementTypeLabel, holdStatusLabel } from './labels';
import { ENGAGEMENT_PATH, ENGAGEMENT_STATUSES, ENGAGEMENT_TYPES, canManage, engagementsMatching } from './model';
import './aud.css';

/**
 * AUD-02: the audit and inspection engagements the caller may see (ST-AUD-001, AUD 3.1). The data are confidential: the list holds only the engagements whose scope meets a grant of the caller,
 * and another one is not there for them. An engagement is registered against a decision of DOC that is in force, with the units, projects and contracts it is about, and its file is AUD-03.
 */
export default function EngagementListScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The list and the dialog belong to one membership: a switch of tenant or of membership starts the screen over.
  return <EngagementListContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function EngagementListContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<EngagementFilter>({ status: '', type: '' });
  const [words, setWords] = useState('');
  const [creating, setCreating] = useState(false);
  const list = useEngagements(filter);
  // The list stays under its filters when they match nothing: the empty words are the table's, not the screen's.
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data, isEmpty: () => false });
  const shown = useMemo(() => engagementsMatching(list.data ?? [], words), [list.data, words]);
  const mayManage = canManage(permissions, mode);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('aud.engagements.page.title')}</h1>
          <p>{t('aud.engagements.page.subtitle')}</p>
        </div>
        {mayManage ? (
          <div className="actions">
            <button type="button" className="primary" onClick={() => setCreating(true)}>
              {t('aud.engagements.register.action')}
            </button>
          </div>
        ) : null}
      </div>
      <p className="callout" data-testid="confidential-note">
        {t('aud.engagements.confidential.note')}
      </p>
      <div className="card">
        <div className="aud-filters">
          <div className="field">
            <label htmlFor="engagement-search">{t('aud.engagements.search.label')}</label>
            <input id="engagement-search" type="search" value={words} placeholder={t('aud.engagements.search.placeholder')} onChange={(event) => setWords(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="engagement-status">{t('aud.engagements.status.label')}</label>
            <select id="engagement-status" value={filter.status} onChange={(event) => setFilter({ ...filter, status: event.target.value as EngagementFilter['status'] })}>
              <option value="">{t('aud.engagements.status.all')}</option>
              {ENGAGEMENT_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {engagementStatusLabel(t, status)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="engagement-type-filter">{t('aud.engagements.type.label')}</label>
            <select id="engagement-type-filter" value={filter.type} onChange={(event) => setFilter({ ...filter, type: event.target.value as EngagementFilter['type'] })}>
              <option value="">{t('aud.engagements.type.all')}</option>
              {ENGAGEMENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {engagementTypeLabel(t, type)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <StateBoundary state={state} onRetry={() => void list.refetch()}>
          {shown.length === 0 ? (
            <p className="muted" data-testid="no-engagements">
              {t('aud.engagements.none.text')}
            </p>
          ) : (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('aud.engagements.col.code')}</th>
                    <th>{t('aud.engagements.col.type')}</th>
                    <th>{t('aud.engagements.col.authority')}</th>
                    <th>{t('aud.engagements.col.period')}</th>
                    <th>{t('aud.engagements.col.status')}</th>
                    <th>{t('aud.engagements.col.coordinator')}</th>
                    <th>{t('aud.engagements.col.hold')}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((engagement) => (
                    <tr key={engagement.id} data-engagement-id={engagement.id}>
                      <td>
                        <Link to={`${ENGAGEMENT_PATH}?engagement=${engagement.id}`}>
                          <strong>{engagement.code}</strong>
                        </Link>
                        <div className="sub">{engagement.title}</div>
                      </td>
                      <td>{engagementTypeLabel(t, engagement.type)}</td>
                      <td>
                        {engagement.authorityName}
                        <div className="sub">{authorityKindLabel(t, engagement.authorityKind)}</div>
                      </td>
                      <td>{t('aud.engagements.period.text', { from: engagement.periodFrom, to: engagement.periodTo })}</td>
                      <td>
                        <span className="aud-badge">{engagementStatusLabel(t, engagement.status)}</span>
                      </td>
                      <td>{engagement.coordinatorName}</td>
                      <td>
                        <span className={engagement.holdStatus === 'Active' ? 'aud-badge warning' : 'aud-badge'}>{holdStatusLabel(t, engagement.holdStatus)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="sub" data-testid="engagement-count">
            {t('aud.engagements.count.text', { count: shown.length })}
          </p>
        </StateBoundary>
      </div>
      {creating ? <CreateDialog onClose={() => setCreating(false)} onCreated={(id) => navigate(`${ENGAGEMENT_PATH}?engagement=${id}`)} /> : null}
      <p className="prototype-note">{t('aud.engagements.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
