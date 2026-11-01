import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { SeverityBadge, StatusBadge, useMoment } from '../issue-components';
import { sourceLabel } from '../issue-labels';
import { workspaceLink } from '../issue-model';
import '../iss.css';
import './sources.css';
import { useSourceIssues } from './hooks';
import { AUTOMATIC_SOURCES, NO_FILTER, categoriesOf, countBySource, filterIssues, mayRead, sourceLink } from './model';
import type { SourceFilter, SourceIssue } from './model';

/**
 * ISS-11: the issues that other modules opened (land clearance, permits, quality, assets, payments, contracts), each with the module it came from, the link to the object there, its category, severity and deadline.
 * Nothing that a person wrote and no name of a person is shown: the title, the description, the reporter and the assignee stay in the workspace of the issue (ISS-03), which each line links to. The screen only reads.
 */
export default function SourceIssuesScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The list belongs to one membership: a switch of tenant or of membership starts the screen over.
  return <SourceIssuesContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function SourceIssuesContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const readable = mayRead(permissions);
  const issues = useSourceIssues(readable);
  const [filter, setFilter] = useState<SourceFilter>(NO_FILTER);
  const all = useMemo(() => issues.data ?? [], [issues.data]);
  const shown = useMemo(() => filterIssues(all, filter), [all, filter]);
  const state = useScreenState({
    isLoading: readable && issues.isLoading,
    error: readable ? issues.error : undefined,
    data: readable ? issues.data : undefined,
    isEmpty: (data) => (data as SourceIssue[]).length === 0,
  });

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('iss.sources.page.title')}</h1>
          <p>{t('iss.sources.page.subtitle')}</p>
        </div>
      </div>
      <p className="callout" role="note" data-testid="privacy-note">
        {t('iss.sources.privacy.notice')}
      </p>
      <StateBoundary state={readable ? state : 'denied'} onRetry={() => void issues.refetch()}>
        <div className="card">
          <ul className="iss-counts" data-testid="counts" aria-label={t('iss.sources.counts.aria')}>
            {countBySource(all).map((entry) => (
              <li key={entry.source} data-source={entry.source}>
                {t('iss.sources.counts.item', { source: sourceLabel(t, entry.source), count: entry.count })}
              </li>
            ))}
          </ul>
          <form className="iss-filters" role="search" aria-label={t('iss.sources.filters.title')} onSubmit={(event) => event.preventDefault()}>
            <div className="field">
              <label htmlFor="source-filter-source">{t('iss.sources.filter.source')}</label>
              <select id="source-filter-source" value={filter.source} onChange={(event) => setFilter({ ...filter, source: AUTOMATIC_SOURCES.find((source) => source === event.target.value) ?? '' })}>
                <option value="">{t('iss.sources.filter.allSources')}</option>
                {AUTOMATIC_SOURCES.map((source) => (
                  <option key={source} value={source}>
                    {sourceLabel(t, source)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="source-filter-category">{t('iss.sources.filter.category')}</label>
              <select id="source-filter-category" value={filter.category} onChange={(event) => setFilter({ ...filter, category: event.target.value })}>
                <option value="">{t('iss.sources.filter.allCategories')}</option>
                {categoriesOf(all).map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
            </div>
          </form>
          <p className="sub" role="status" data-testid="count">
            {t('iss.sources.count.text', { count: shown.length })}
          </p>
          {shown.length === 0 ? (
            <p className="callout" role="status" data-testid="no-match">
              {t('iss.sources.noMatch.notice')}
            </p>
          ) : (
            <div className="tablewrap">
              <table className="table" aria-label={t('iss.sources.table.aria')} data-testid="issues">
                <thead>
                  <tr>
                    <th scope="col">{t('iss.sources.column.code')}</th>
                    <th scope="col">{t('iss.sources.column.source')}</th>
                    <th scope="col">{t('iss.sources.column.object')}</th>
                    <th scope="col">{t('iss.sources.column.category')}</th>
                    <th scope="col">{t('iss.sources.column.severity')}</th>
                    <th scope="col">{t('iss.sources.column.due')}</th>
                    <th scope="col">{t('iss.sources.column.unit')}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((issue) => (
                    <IssueRow key={issue.id} issue={issue} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </StateBoundary>
      <p className="prototype-note">{t('iss.sources.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function IssueRow({ issue }: { issue: SourceIssue }) {
  const { t } = useTranslation();
  const moment = useMoment();
  const link = sourceLink(issue);
  return (
    <tr data-issue={issue.id} data-source={issue.source}>
      <th scope="row">
        <Link to={workspaceLink(issue.id)}>{issue.code}</Link>
        <small className="sub iss-stack">
          <StatusBadge status={issue.status} />
        </small>
      </th>
      <td data-testid="source">{sourceLabel(t, issue.source)}</td>
      <td data-testid="object">
        {link === undefined ? (
          <span className="sub" data-testid="object-text">
            {issue.sourceRefId === null ? t('iss.sources.object.none') : t('iss.sources.object.reference', { reference: issue.sourceRefId })}
          </span>
        ) : (
          <Link to={link} data-testid="source-link">
            {t('iss.sources.object.open', { source: sourceLabel(t, issue.source) })}
          </Link>
        )}
      </td>
      <td data-testid="category">{issue.categoryLabel}</td>
      <td>
        <SeverityBadge severity={issue.severity} />
      </td>
      <td data-testid="due">
        {moment(issue.dueAt)}
        {issue.overdueDays === null ? null : <small className="sub iss-stack">{t('iss.sources.overdue.text', { days: issue.overdueDays })}</small>}
      </td>
      <td>
        {issue.projectCode}
        <small className="sub iss-stack">{issue.ownerUnitName}</small>
      </td>
    </tr>
  );
}
