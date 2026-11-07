import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, FilterPanel, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { NationalCode } from './components';
import { useProjects } from './hooks';
import { lifeLabel, stageLabel, stageTone } from './labels';
import { CREATE_PATH, CREATE_PERMISSION, EMPTY_FILTER, PROJECT_STATUSES, filterProjects, readAtLabel, workspaceLink } from './model';
import type { ListFilter, ProjectLine, ProjectStatus } from './model';
import './prj.css';

const DEFAULT_PAGE_SIZE = 20;

/** PRJ-01: the register of projects in the unit tree of the signed-in member, with the stage, the national code and the leader in charge. */
export default function ProjectListScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The list belongs to one membership: a switch of tenant or of membership starts the screen over.
  return <ProjectListContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ProjectListContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  const canCreate = (permissions === undefined || permissions.includes(CREATE_PERMISSION)) && mode !== 'READ_ONLY';
  const projects = useProjects();
  const [filter, setFilter] = useState<ListFilter>(EMPTY_FILTER);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const state = useScreenState({
    isLoading: projects.isLoading,
    error: projects.error,
    data: projects.data,
  });
  const shown = useMemo(() => filterProjects(projects.data ?? [], filter), [projects.data, filter]);
  const change = (next: Partial<ListFilter>): void => {
    setFilter({ ...filter, ...next });
    setPageIndex(0);
  };
  const applied = [filter.query.trim() !== '', filter.status !== '', filter.missingNationalCode].filter(Boolean).length;
  const lastIndex = Math.max(0, Math.ceil(shown.length / pageSize) - 1);
  const index = Math.min(pageIndex, lastIndex);
  const rows = shown.slice(index * pageSize, (index + 1) * pageSize);
  const from = rows.length === 0 ? 0 : index * pageSize + 1;

  const columns: DataTableColumn<ProjectLine>[] = [
    {
      key: 'project',
      header: t('prj.list.column.project'),
      pinned: true,
      render: (project) => (
        <>
          <Link to={workspaceLink(project.id)}>{project.code}</Link>
          <span className="prj-code">{project.name}</span>
          <span className="prj-pills" data-testid="stage">
            <StatusPill tone={stageTone(project.status)}>{stageLabel(t, project.status)}</StatusPill>
          </span>
        </>
      ),
    },
    {
      key: 'investor',
      header: t('prj.list.column.investor'),
      render: (project) => project.investorUnitName ?? project.ownerUnitName,
    },
    {
      key: 'group',
      header: t('prj.list.column.group'),
      render: (project) => project.projectGroup ?? t('prj.list.group.none'),
    },
    {
      key: 'status',
      header: t('prj.list.column.status'),
      render: (project) => lifeLabel(t, project.status),
    },
    {
      key: 'nationalCode',
      header: t('prj.list.column.nationalCode'),
      render: (project) => <NationalCode code={project.nationalProjectCode} />,
    },
    {
      key: 'leader',
      header: t('prj.list.column.leader'),
      render: (project) => project.leaderName ?? t('prj.list.leader.none'),
    },
  ];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('prj.list.page.title')}</h1>
          <p>{t('prj.list.page.subtitle')}</p>
        </div>
        {canCreate ? (
          <Link className="ui-button ui-button--primary" to={CREATE_PATH}>
            {t('prj.list.create.action')}
          </Link>
        ) : null}
      </div>
      <StateBoundary state={state} onRetry={() => void projects.refetch()}>
        <ContextBar
          items={[
            {
              label: t('prj.list.ctx.scope'),
              value: tenant?.name ?? t('prj.list.ctx.scope.all'),
            },
            {
              label: t('prj.list.ctx.count'),
              value: String((projects.data ?? []).length),
            },
          ]}
          {...(projects.dataUpdatedAt > 0 ? { asOf: readAtLabel(projects.dataUpdatedAt) } : {})}
        />
        <FilterPanel applied={applied}>
          <form className="prj-filters" role="search" aria-label={t('prj.list.filters.title')} onSubmit={(event) => event.preventDefault()}>
            <div className="field">
              <label htmlFor="project-query">{t('prj.list.query.label')}</label>
              <input id="project-query" value={filter.query} onChange={(event) => change({ query: event.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="project-stage">{t('prj.list.stage.label')}</label>
              <select id="project-stage" value={filter.status} onChange={(event) => change({ status: event.target.value as ProjectStatus | '' })}>
                <option value="">{t('prj.list.stage.all')}</option>
                {PROJECT_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {stageLabel(t, status)}
                  </option>
                ))}
              </select>
            </div>
            <label className="check">
              <input type="checkbox" checked={filter.missingNationalCode} onChange={(event) => change({ missingNationalCode: event.target.checked })} />
              {t('prj.list.missingCode.label')}
            </label>
          </form>
        </FilterPanel>
        {/* The table scrolls inside its own region, and the page does not scroll sideways (WCAG 1.4.10). */}
        <div data-testid="projects">
          <DataTable
            caption={t('prj.list.table.aria')}
            columns={columns}
            rows={rows}
            rowKey={(project) => project.id}
            rowAttrs={(project) => ({ 'data-project-id': project.id })}
            emptyKind={applied > 0 ? 'filtered' : 'none'}
            onClearFilters={() => change(EMPTY_FILTER)}
            page={{
              from,
              to: from + rows.length - (rows.length === 0 ? 0 : 1),
              total: shown.length,
              size: pageSize,
              index,
              onPage: setPageIndex,
              onSize: (size) => {
                setPageSize(size);
                setPageIndex(0);
              },
            }}
          />
        </div>
      </StateBoundary>
      <p className="prototype-note">{t('prj.list.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
