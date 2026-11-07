import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, FilterPanel, KpiStrip, KpiTile } from '../../ui';
import type { DataTableColumn, DataTablePage } from '../../ui';
import { useIssues } from './hooks';
import { DeadlineLine, DueBadge, PersonText, SeverityBadge, StatusBadge, useMoment } from './issue-components';
import { sourceLabel, statusLabel } from './issue-labels';
import { CREATE_PATH, EMPTY_FILTER, ISSUE_CREATE_PERMISSION, ISSUE_STATUSES, boardOf, businessDay, dueStateOf, filterIssues, hasPermission, stripeOf, workspaceLink } from './issue-model';
import type { IssueFilter, IssueLine, IssueStatus } from './issue-model';
import { severityLabel } from './labels';
import { SEVERITIES } from './model';
import type { Severity } from './model';
import './iss.css';

const NEVER_EMPTY = (): boolean => false;
const PAGE_SIZE = 20;

/** The narrowing of the list that the server takes from the address: the unit, the group, the status and the week of a cell of the weekly matrix. */
const MATRIX_PARAMS = ['owner_unit_id', 'category_version_id', 'status', 'week', 'open'] as const;

/**
 * ISS-01: the issues in the scope of the signed-in member, in the order of the states, with the severity, the deadline (a stripe marks the ones that are overdue or escalated), the person it is given to,
 * the level it has been escalated to and where it came from. The table only reads: every change of an issue is a command of its workspace.
 */
export default function IssueListScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The board belongs to one membership: a switch of tenant or of membership starts the screen over.
  return <IssueListContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function IssueListContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const moment = useMoment();
  const { permissions, mode, tenant } = useSession();
  const canCreate = hasPermission(permissions, ISSUE_CREATE_PERMISSION) && mode !== 'READ_ONLY';
  // A cell of the weekly matrix opens this list with the unit, the group, the status and the week it counts; the status is then the one the issue had when the week ended.
  const [search] = useSearchParams();
  const narrow = useMemo(() => Object.fromEntries(MATRIX_PARAMS.flatMap((name) => (search.get(name) === null ? [] : [[name, search.get(name) as string]]))), [search]);
  const issues = useIssues(narrow);
  const [filter, setFilter] = useState<IssueFilter>(EMPTY_FILTER);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const state = useScreenState({ isLoading: issues.isLoading, error: issues.error, data: issues.data, isEmpty: NEVER_EMPTY });
  const shown = useMemo(() => filterIssues(issues.data ?? [], filter, tenant?.membershipId), [issues.data, filter, tenant?.membershipId]);
  // The rows follow the order of the state machine, so the issues of one status stay together as they were in the columns of the board.
  const ordered = useMemo(() => boardOf(shown).flatMap((column) => column.lines), [shown]);
  const now = new Date();
  const index = Math.min(pageIndex, Math.max(0, Math.ceil(ordered.length / pageSize) - 1));
  const visible = ordered.slice(index * pageSize, (index + 1) * pageSize);
  const all = issues.data ?? [];
  const open = all.filter((line) => line.status !== 'CLOSED');
  const overdue = open.filter((line) => dueStateOf(line, now) === 'overdue');
  const escalated = open.filter((line) => line.escalationLevel > 0);
  const applied = [filter.query.trim() !== '', filter.status !== '', filter.severity !== '', filter.assignedToMe, filter.overdueOnly].filter(Boolean).length;
  const update = (next: Partial<IssueFilter>): void => {
    setFilter({ ...filter, ...next });
    setPageIndex(0);
  };
  const page: DataTablePage = {
    from: index * pageSize + 1,
    to: index * pageSize + visible.length,
    total: ordered.length,
    size: pageSize,
    index,
    onPage: setPageIndex,
    onSize: (size) => {
      setPageSize(size);
      setPageIndex(0);
    },
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('iss.list.page.title')}</h1>
          <p>{t('iss.list.page.subtitle')}</p>
        </div>
        {canCreate ? (
          <Link className="ui-button ui-button--primary" to={CREATE_PATH}>
            {t('iss.list.create.action')}
          </Link>
        ) : null}
      </div>
      <ContextBar
        items={[
          { label: t('w2iss.ctx.scope'), value: tenant?.name ?? t('w2iss.ctx.scope.all') },
          { label: t('w2iss.ctx.today'), value: businessDay(now).split('-').reverse().join('/') },
        ]}
        {...(issues.dataUpdatedAt > 0 ? { asOf: moment(new Date(issues.dataUpdatedAt).toISOString()) } : {})}
      />
      <StateBoundary state={state} onRetry={() => void issues.refetch()}>
        {Object.keys(narrow).length === 0 ? null : (
          <p className="callout" role="note" data-testid="narrowed">
            {t('iss.list.narrowed.notice', { week: narrow.week ?? t('iss.list.narrowed.now') })} <Link to="/iss/iss-01">{t('iss.list.narrowed.clear')}</Link>
          </p>
        )}
        <KpiStrip label={t('w2iss.list.kpi.label')}>
          <KpiTile label={t('w2iss.list.kpi.open')} value={String(open.length)} />
          <KpiTile label={t('w2iss.list.kpi.overdue')} value={String(overdue.length)} tone={overdue.length > 0 ? 'danger' : 'default'} />
          <KpiTile label={t('w2iss.list.kpi.escalated')} value={String(escalated.length)} tone={escalated.length > 0 ? 'warning' : 'default'} />
        </KpiStrip>
        <FilterPanel applied={applied}>
          <form className="iss-filters" role="search" aria-label={t('iss.list.filters.title')} onSubmit={(event) => event.preventDefault()}>
            <div className="field">
              <label htmlFor="issue-query">{t('iss.list.query.label')}</label>
              <input id="issue-query" value={filter.query} onChange={(event) => update({ query: event.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="issue-status">{t('iss.list.status.label')}</label>
              <select id="issue-status" value={filter.status} onChange={(event) => update({ status: event.target.value as IssueStatus | '' })}>
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
              <select id="issue-severity" value={filter.severity} onChange={(event) => update({ severity: event.target.value as Severity | '' })}>
                <option value="">{t('iss.list.severity.all')}</option>
                {SEVERITIES.map((severity) => (
                  <option key={severity} value={severity}>
                    {severityLabel(t, severity)}
                  </option>
                ))}
              </select>
            </div>
            <label className="check">
              <input type="checkbox" checked={filter.assignedToMe} onChange={(event) => update({ assignedToMe: event.target.checked })} />
              {t('iss.list.mine.label')}
            </label>
            <label className="check">
              <input type="checkbox" checked={filter.overdueOnly} onChange={(event) => update({ overdueOnly: event.target.checked })} />
              {t('iss.list.overdue.label')}
            </label>
          </form>
        </FilterPanel>
        <p className="sub" data-testid="count" role="status">
          {t('iss.list.count.text', { count: shown.length })}
        </p>
        {all.length === 0 ? (
          <p className="muted" data-testid="empty-issues">
            {t('iss.list.empty.text')}
          </p>
        ) : shown.length === 0 ? (
          <p className="callout" role="status" data-testid="no-match">
            {t('iss.list.noMatch.notice')}
          </p>
        ) : (
          <div data-testid="board">
            <IssueTable lines={visible} now={now} page={page} />
          </div>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('iss.list.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function IssueTable({ lines, now, page }: { lines: IssueLine[]; now: Date; page: DataTablePage }) {
  const { t } = useTranslation();
  const moment = useMoment();
  const columns: DataTableColumn<IssueLine>[] = [
    {
      key: 'issue',
      header: t('w2iss.list.col.issue'),
      pinned: true,
      render: (line) => (
        <>
          <Link to={workspaceLink(line.id)}>{line.code}</Link>
          <span className="iss-sub">{line.title}</span>
          <span className="iss-sub">
            {line.projectCode} · {line.categoryLabel}
          </span>
          <span className="iss-chips">
            <StatusBadge status={line.status} />
            <DueBadge line={line} now={now} />
          </span>
        </>
      ),
    },
    { key: 'severity', header: t('iss.list.severity.label'), render: (line) => <SeverityBadge severity={line.severity} /> },
    {
      key: 'deadline',
      header: t('w2iss.list.col.deadline'),
      render: (line) => (
        <>
          <DeadlineLine line={line} now={now} />
          <span className="iss-sub">{t('iss.list.card.due', { date: moment(line.dueAt) })}</span>
        </>
      ),
    },
    {
      key: 'assignee',
      header: t('iss.list.card.assignee'),
      render: (line) => (
        <>
          {line.assignee === null ? t('iss.list.card.unassigned') : <PersonText person={line.assignee} />}
          <span className="iss-sub">{t('iss.list.card.unit', { unit: line.ownerUnitName })}</span>
        </>
      ),
    },
    {
      key: 'escalation',
      header: t('w2iss.list.col.escalation'),
      render: (line) => (
        <>
          {line.escalationLevel > 0 ? t('iss.escalation.level.text', { level: line.escalationLevel }) : t('iss.escalation.none.text')}
          <span className="iss-sub">{t('iss.list.card.source', { source: sourceLabel(t, line.sourceModule) })}</span>
        </>
      ),
    },
  ];
  return <DataTable caption={t('w2iss.list.table.aria')} columns={columns} rows={lines} rowKey={(line) => line.id} rowAttrs={(line) => ({ 'data-issue-id': line.id, 'data-status': line.status })} severity={(line) => stripeOf(line, now)} page={page} />;
}
