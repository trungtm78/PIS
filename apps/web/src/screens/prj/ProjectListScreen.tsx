import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { NationalCode } from './components';
import { useProjects } from './hooks';
import { lifeLabel, stageLabel } from './labels';
import { CREATE_PATH, CREATE_PERMISSION, EMPTY_FILTER, PROJECT_STATUSES, filterProjects, workspaceLink } from './model';
import type { ListFilter, ProjectStatus } from './model';
import './prj.css';

/** PRJ-01: the register of projects in the unit tree of the signed-in member, with the stage, the national code and the leader in charge. */
export default function ProjectListScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The list belongs to one membership: a switch of tenant or of membership starts the screen over.
  return <ProjectListContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ProjectListContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const canCreate = (permissions === undefined || permissions.includes(CREATE_PERMISSION)) && mode !== 'READ_ONLY';
  const projects = useProjects();
  const [filter, setFilter] = useState<ListFilter>(EMPTY_FILTER);
  const state = useScreenState({ isLoading: projects.isLoading, error: projects.error, data: projects.data });
  const shown = useMemo(() => filterProjects(projects.data ?? [], filter), [projects.data, filter]);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('prj.list.page.title')}</h1>
          <p>{t('prj.list.page.subtitle')}</p>
        </div>
        {canCreate ? (
          <Link className="button primary" to={CREATE_PATH}>
            {t('prj.list.create.action')}
          </Link>
        ) : null}
      </div>
      <StateBoundary state={state} onRetry={() => void projects.refetch()}>
        <div className="card">
          <form className="prj-filters" role="search" aria-label={t('prj.list.filters.title')} onSubmit={(event) => event.preventDefault()}>
            <div className="field">
              <label htmlFor="project-query">{t('prj.list.query.label')}</label>
              <input id="project-query" value={filter.query} onChange={(event) => setFilter({ ...filter, query: event.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="project-stage">{t('prj.list.stage.label')}</label>
              <select id="project-stage" value={filter.status} onChange={(event) => setFilter({ ...filter, status: event.target.value as ProjectStatus | '' })}>
                <option value="">{t('prj.list.stage.all')}</option>
                {PROJECT_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {stageLabel(t, status)}
                  </option>
                ))}
              </select>
            </div>
            <label className="check">
              <input type="checkbox" checked={filter.missingNationalCode} onChange={(event) => setFilter({ ...filter, missingNationalCode: event.target.checked })} />
              {t('prj.list.missingCode.label')}
            </label>
          </form>
          {shown.length === 0 ? (
            <p className="callout" role="status" data-testid="no-match">
              {t('prj.list.noMatch.notice')}
            </p>
          ) : (
            <table className="table" data-testid="projects">
              <thead>
                <tr>
                  <th scope="col">{t('prj.list.column.code')}</th>
                  <th scope="col">{t('prj.list.column.name')}</th>
                  <th scope="col">{t('prj.list.column.investor')}</th>
                  <th scope="col">{t('prj.list.column.group')}</th>
                  <th scope="col">{t('prj.list.column.status')}</th>
                  <th scope="col">{t('prj.list.column.nationalCode')}</th>
                  <th scope="col">{t('prj.list.column.stage')}</th>
                  <th scope="col">{t('prj.list.column.leader')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((project) => (
                  <tr key={project.id} data-project-id={project.id}>
                    <th scope="row">
                      <Link to={workspaceLink(project.id)}>{project.code}</Link>
                    </th>
                    <td>{project.name}</td>
                    <td>{project.investorUnitName ?? project.ownerUnitName}</td>
                    <td>{project.projectGroup ?? t('prj.list.group.none')}</td>
                    <td>{lifeLabel(t, project.status)}</td>
                    <td>
                      <NationalCode code={project.nationalProjectCode} />
                    </td>
                    <td>
                      <span className="prj-badge" data-testid="stage">
                        {stageLabel(t, project.status)}
                      </span>
                    </td>
                    <td>{project.leaderName ?? t('prj.list.leader.none')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </StateBoundary>
      <p className="prototype-note">{t('prj.list.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
