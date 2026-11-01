import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { vietnamToday } from '../../mdm/succession-model';
import { PROJECT_STATUSES, workspaceLink } from '../../prj/model';
import type { ProjectStatus } from '../../prj/model';
import { stageLabel } from '../../prj/labels';
import { Field } from '../../mne/components';
import { useProjectMap } from './hooks';
import { OUTSIDE, READ_PERMISSIONS, clustersOf, filterProjects, sectorsOf, validDate } from './model';
import type { Cluster, ClusterProject, MapData } from './model';

const holds = (permissions: readonly string[] | undefined): boolean => permissions === undefined || READ_PERMISSIONS.every((permission) => permissions.includes(permission));

/**
 * HOME-05: the project map by the administrative structure of a date (ST-HOME-006, BR-HOME-07, UI-HOME-05, UAT-AC277). The date is part of the address: asked for a day before an area was merged, a project is under the old area; after,
 * under the area it became, and the date of the structure is written beside it. The projects have no coordinates in the API, so all of them are in the list apart and none is put at the centre of a province; the placing is by area, in
 * a table that is the accessible form of the map. The tiles of a drawn map wait for tile hosting inside the country.
 */
export default function MapScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is placed belongs to the scope of one member of one tenant: a switch starts the screen over.
  return <MapContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function MapContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const [params, setParams] = useSearchParams();
  const allowed = holds(permissions);
  const asked = params.get('as_of');
  const asOf = validDate(asked) ?? vietnamToday();
  const map = useProjectMap(asOf, allowed);
  const state = useScreenState({ isLoading: map.isLoading, error: map.error, data: map.data, isEmpty: (data) => (data as MapData).projects.length === 0 });
  const status = PROJECT_STATUSES.find((candidate) => candidate === params.get('status')) ?? '';
  const sector = params.get('sector') ?? '';
  const change = (name: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value === '') next.delete(name);
    else next.set(name, value);
    setParams(next, { replace: true });
  };
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('home.map.page.title')}</h1>
          <p>{t('home.map.page.subtitle')}</p>
        </div>
      </div>
      {allowed ? (
        <>
          <div className="card">
            <div className="filters">
              <Field id="map-date" label={t('home.map.date.label')} hint={t('home.map.date.hint')} error={asked !== null && validDate(asked) === undefined ? t('home.map.date.invalid') : undefined}>
                <input id="map-date" type="date" value={asOf} onChange={(event) => change('as_of', event.target.value)} />
              </Field>
              <Field id="map-status" label={t('home.map.status.label')} error={undefined}>
                <select id="map-status" value={status} onChange={(event) => change('status', event.target.value)}>
                  <option value="">{t('home.map.status.all')}</option>
                  {PROJECT_STATUSES.map((candidate) => (
                    <option key={candidate} value={candidate}>
                      {stageLabel(t, candidate)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="map-sector" label={t('home.map.sector.label')} error={undefined}>
                <select id="map-sector" value={sector} onChange={(event) => change('sector', event.target.value)}>
                  <option value="">{t('home.map.sector.all')}</option>
                  {sectorsOf(map.data?.projects ?? []).map((entry) => (
                    <option key={entry.key} value={entry.key}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </div>
          <StateBoundary state={state} onRetry={() => void map.refetch()}>
            {map.data === undefined ? null : <Placing data={map.data} status={status} sector={sector} />}
          </StateBoundary>
        </>
      ) : (
        <div data-testid="map-denied">
          <StateBoundary state="denied" />
        </div>
      )}
      <p className="prototype-note">{t('home.map.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Placing({ data, status, sector }: { data: MapData; status: ProjectStatus | ''; sector: string }) {
  const { t } = useTranslation();
  const projects = filterProjects(data.projects, { status, sector });
  const clusters = clustersOf(projects, data.structures);
  return (
    <>
      <p className="callout" role="note" data-testid="map-asof">
        {t('home.map.asof.text', { date: data.asOf })}
      </p>
      <p className="sub" data-testid="map-tiles">
        {t('home.map.tiles.note')}
      </p>
      {data.truncated ? (
        <p className="callout warning" role="alert" data-testid="map-truncated">
          {t('home.map.truncated.notice')}
        </p>
      ) : null}
      {projects.length === 0 ? (
        <p data-testid="map-nomatch">{t('home.map.nomatch.notice')}</p>
      ) : (
        <>
          <section className="card" aria-label={t('home.map.areas.title')} data-testid="map-areas">
            <h2>{t('home.map.areas.title')}</h2>
            {clusters.map((cluster) => (
              <AreaCluster key={cluster.key} cluster={cluster} />
            ))}
          </section>
          <section className="card" aria-label={t('home.map.nocoords.title')} data-testid="map-nocoords">
            <h2>{t('home.map.nocoords.title')}</h2>
            <p className="sub">{t('home.map.nocoords.note')}</p>
            <ul>
              {projects.map((project) => (
                <li key={project.id} className="item" data-project-id={project.id}>
                  <Link to={workspaceLink(project.id)}>{t('home.map.project.text', { code: project.code, name: project.name })}</Link>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </>
  );
}

function AreaCluster({ cluster }: { cluster: Cluster }) {
  const { t } = useTranslation();
  const title = cluster.key === OUTSIDE ? t('home.map.outside.title') : cluster.label;
  return (
    <section aria-label={title} data-area={cluster.key} data-in-force={cluster.inForce}>
      <h3>{title}</h3>
      <p className="sub">
        {cluster.key === OUTSIDE ? t('home.map.outside.note') : cluster.structureDate === null ? null : t('home.map.structure.text', { date: cluster.structureDate })}
        {cluster.key !== OUTSIDE && !cluster.inForce ? ` ${t('home.map.notinforce.note')}` : ''}
      </p>
      <div className="tablewrap">
        <table className="table" aria-label={title}>
          <thead>
            <tr>
              <th scope="col">{t('home.map.column.project')}</th>
              <th scope="col">{t('home.map.column.status')}</th>
              <th scope="col">{t('home.map.column.share')}</th>
            </tr>
          </thead>
          <tbody>
            {cluster.projects.map((project) => (
              <ProjectRow key={project.id} project={project} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ProjectRow({ project }: { project: ClusterProject }) {
  const { t } = useTranslation();
  return (
    <tr data-project-id={project.id}>
      <th scope="row">
        <Link to={workspaceLink(project.id)}>{t('home.map.project.text', { code: project.code, name: project.name })}</Link>
      </th>
      <td>{stageLabel(t, project.status)}</td>
      <td>{project.sharePct === '100.00' ? '—' : t('home.map.share.value', { share: project.sharePct })}</td>
    </tr>
  );
}
