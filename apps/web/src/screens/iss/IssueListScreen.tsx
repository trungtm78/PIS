import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { useIssues } from './hooks';
import { DueBadge, PersonText, SeverityBadge, useMoment } from './issue-components';
import { sourceLabel, statusLabel } from './issue-labels';
import { CREATE_PATH, EMPTY_FILTER, ISSUE_CREATE_PERMISSION, ISSUE_STATUSES, boardOf, filterIssues, hasPermission, workspaceLink } from './issue-model';
import type { IssueFilter, IssueLine, IssueStatus } from './issue-model';
import { severityLabel } from './labels';
import { SEVERITIES } from './model';
import type { Severity } from './model';
import './iss.css';

const NEVER_EMPTY = (): boolean => false;

/**
 * ISS-01: the issues in the scope of the signed-in member, by status, with the severity, the deadline, the person it is given to, the level
 * it has been escalated to and where it came from. The board only reads: every change of an issue is a command of its workspace.
 */
export default function IssueListScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The board belongs to one membership: a switch of tenant or of membership starts the screen over.
  return <IssueListContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function IssueListContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  const canCreate = hasPermission(permissions, ISSUE_CREATE_PERMISSION) && mode !== 'READ_ONLY';
  const issues = useIssues();
  const [filter, setFilter] = useState<IssueFilter>(EMPTY_FILTER);
  const state = useScreenState({ isLoading: issues.isLoading, error: issues.error, data: issues.data, isEmpty: NEVER_EMPTY });
  const shown = useMemo(() => filterIssues(issues.data ?? [], filter, tenant?.membershipId), [issues.data, filter, tenant?.membershipId]);
  const board = useMemo(() => boardOf(shown), [shown]);
  const now = new Date();

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('iss.list.page.title')}</h1>
          <p>{t('iss.list.page.subtitle')}</p>
        </div>
        {canCreate ? (
          <Link className="button primary" to={CREATE_PATH}>
            {t('iss.list.create.action')}
          </Link>
        ) : null}
      </div>
      <StateBoundary state={state} onRetry={() => void issues.refetch()}>
        <div className="card">
          <form className="iss-filters" role="search" aria-label={t('iss.list.filters.title')} onSubmit={(event) => event.preventDefault()}>
            <div className="field">
              <label htmlFor="issue-query">{t('iss.list.query.label')}</label>
              <input id="issue-query" value={filter.query} onChange={(event) => setFilter({ ...filter, query: event.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="issue-status">{t('iss.list.status.label')}</label>
              <select id="issue-status" value={filter.status} onChange={(event) => setFilter({ ...filter, status: event.target.value as IssueStatus | '' })}>
                <option value="">{t('iss.list.status.all')}</option>
                {ISSUE_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {statusLabel(t, status)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="issue-severity">{t('iss.list.severity.label')}</label>
              <select id="issue-severity" value={filter.severity} onChange={(event) => setFilter({ ...filter, severity: event.target.value as Severity | '' })}>
                <option value="">{t('iss.list.severity.all')}</option>
                {SEVERITIES.map((severity) => (
                  <option key={severity} value={severity}>
                    {severityLabel(t, severity)}
                  </option>
                ))}
              </select>
            </div>
            <label className="check">
              <input type="checkbox" checked={filter.assignedToMe} onChange={(event) => setFilter({ ...filter, assignedToMe: event.target.checked })} />
              {t('iss.list.mine.label')}
            </label>
            <label className="check">
              <input type="checkbox" checked={filter.overdueOnly} onChange={(event) => setFilter({ ...filter, overdueOnly: event.target.checked })} />
              {t('iss.list.overdue.label')}
            </label>
          </form>
          <p className="sub" data-testid="count" role="status">
            {t('iss.list.count.text', { count: shown.length })}
          </p>
          {(issues.data ?? []).length === 0 ? (
            <p className="muted" data-testid="empty-issues">
              {t('iss.list.empty.text')}
            </p>
          ) : shown.length === 0 ? (
            <p className="callout" role="status" data-testid="no-match">
              {t('iss.list.noMatch.notice')}
            </p>
          ) : (
            <div className="iss-board" data-testid="board">
              {board.map((column) => (
                <section key={column.status} className="iss-column" aria-labelledby={`column-${column.status}`} data-status={column.status}>
                  <h2 id={`column-${column.status}`}>
                    {statusLabel(t, column.status)} ({column.lines.length})
                  </h2>
                  {column.lines.length === 0 ? <p className="sub">{t('iss.list.column.empty')}</p> : column.lines.map((line) => <IssueCard key={line.id} line={line} now={now} />)}
                </section>
              ))}
            </div>
          )}
        </div>
      </StateBoundary>
      <p className="prototype-note">{t('iss.list.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function IssueCard({ line, now }: { line: IssueLine; now: Date }) {
  const { t } = useTranslation();
  const moment = useMoment();
  return (
    <article className="iss-card" data-issue-id={line.id}>
      <p>
        <Link to={workspaceLink(line.id)}>{line.code}</Link> <SeverityBadge severity={line.severity} />
      </p>
      <p>{line.title}</p>
      <p className="sub">
        {line.projectCode} · {line.categoryLabel}
      </p>
      <p>
        <DueBadge line={line} now={now} />
      </p>
      <p className="sub">{t('iss.list.card.due', { date: moment(line.dueAt) })}</p>
      <p className="sub">
        {t('iss.list.card.assignee')}: {line.assignee === null ? t('iss.list.card.unassigned') : <PersonText person={line.assignee} />}
      </p>
      <p className="sub">{t('iss.list.card.unit', { unit: line.ownerUnitName })}</p>
      <p className="sub">
        {line.escalationLevel > 0 ? t('iss.escalation.level.text', { level: line.escalationLevel }) : t('iss.escalation.none.text')} · {t('iss.list.card.source', { source: sourceLabel(t, line.sourceModule) })}
      </p>
    </article>
  );
}
