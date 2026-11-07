import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, FilterPanel, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { CreateDialog } from './dialogs';
import { useEngagements } from './hooks';
import type { EngagementFilter } from './hooks';
import { authorityKindLabel, engagementStatusLabel, engagementTypeLabel, holdStatusLabel } from './labels';
import { ENGAGEMENT_PATH, ENGAGEMENT_STATUSES, ENGAGEMENT_TYPES, canManage, engagementsMatching } from './model';
import type { EngagementLine } from './model';
import { engagementTone } from './tones';
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
  const { permissions, mode, tenant } = useSession();
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
            <button type="button" className="ui-button ui-button--primary" onClick={() => setCreating(true)}>
              {t('aud.engagements.register.action')}
            </button>
          </div>
        ) : null}
      </div>
      <ContextBar items={[{ label: t('w2iss.ctx.scope'), value: tenant?.name ?? t('w2iss.ctx.scope.all') }]} />
      <p className="callout" data-testid="confidential-note">
        {t('aud.engagements.confidential.note')}
      </p>
      <FilterPanel applied={[words.trim() !== '', filter.status !== '', filter.type !== ''].filter(Boolean).length}>
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
      </FilterPanel>
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        {shown.length === 0 ? (
          <p className="muted" data-testid="no-engagements">
            {t('aud.engagements.none.text')}
          </p>
        ) : (
          <EngagementTable engagements={shown} />
        )}
        <p className="sub" data-testid="engagement-count">
          {t('aud.engagements.count.text', { count: shown.length })}
        </p>
      </StateBoundary>
      {creating ? <CreateDialog onClose={() => setCreating(false)} onCreated={(id) => navigate(`${ENGAGEMENT_PATH}?engagement=${id}`)} /> : null}
      <p className="prototype-note">{t('aud.engagements.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function EngagementTable({ engagements }: { engagements: EngagementLine[] }) {
  const { t } = useTranslation();
  const columns: DataTableColumn<EngagementLine>[] = [
    {
      key: 'code',
      header: t('aud.engagements.col.code'),
      pinned: true,
      render: (engagement) => (
        <>
          <Link to={`${ENGAGEMENT_PATH}?engagement=${engagement.id}`}>
            <strong>{engagement.code}</strong>
          </Link>
          <span className="aud-sub">{engagement.title}</span>
        </>
      ),
    },
    { key: 'type', header: t('aud.engagements.col.type'), render: (engagement) => engagementTypeLabel(t, engagement.type) },
    {
      key: 'authority',
      header: t('aud.engagements.col.authority'),
      render: (engagement) => (
        <>
          {engagement.authorityName}
          <span className="aud-sub">{authorityKindLabel(t, engagement.authorityKind)}</span>
        </>
      ),
    },
    { key: 'period', header: t('aud.engagements.col.period'), render: (engagement) => t('aud.engagements.period.text', { from: engagement.periodFrom, to: engagement.periodTo }) },
    { key: 'status', header: t('aud.engagements.col.status'), render: (engagement) => <StatusPill tone={engagementTone(engagement.status)}>{engagementStatusLabel(t, engagement.status)}</StatusPill> },
    { key: 'coordinator', header: t('aud.engagements.col.coordinator'), render: (engagement) => engagement.coordinatorName },
    { key: 'hold', header: t('aud.engagements.col.hold'), render: (engagement) => <StatusPill tone={engagement.holdStatus === 'Active' ? 'warning' : 'neutral'}>{holdStatusLabel(t, engagement.holdStatus)}</StatusPill> },
  ];
  return <DataTable caption={t('w2iss.aud.engagements.aria')} columns={columns} rows={engagements} rowKey={(engagement) => engagement.id} />;
}
