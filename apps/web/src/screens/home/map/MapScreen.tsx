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
import { ContextBar, DataTable, FilterPanel, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import '../../dis/dis.css';
import '../home.css';
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
  const { permissions, tenant } = useSession();
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
          <ContextBar items={[{ label: t('dis.wr.ctx.scope'), value: tenant?.name ?? t('dis.wr.ctx.scope.all') }, { label: t('home.map.date.label'), value: asOf }]} />
          <FilterPanel
            applied={(status === '' ? 0 : 1) + (sector === '' ? 0 : 1)}
            actions={
              status === '' && sector === '' ? undefined : (
                <button
                  type="button"
                  className="ui-button ui-button--outline"
                  onClick={() => {
                    const next = new URLSearchParams(params);
                    next.delete('status');
                    next.delete('sector');
                    setParams(next, { replace: true });
                  }}
                >
                  {t('w2dis.home.filter.clear')}
                </button>
              )
            }
          >
            <div className="dis-filters">
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
          </FilterPanel>
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
    <div className="home-stack">
      <p className="callout" role="note" data-testid="map-asof">
        {t('home.map.asof.text', { date: data.asOf })}
      </p>
      <p className="home-note" data-testid="map-tiles">
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
          <div data-testid="map-areas">
            <SectionCard title={t('home.map.areas.title')}>
              <div className="home-stack">
                {clusters.map((cluster) => (
                  <AreaCluster key={cluster.key} cluster={cluster} />
                ))}
              </div>
            </SectionCard>
          </div>
          <div data-testid="map-nocoords">
            <SectionCard title={t('home.map.nocoords.title')}>
              <p className="home-note">{t('home.map.nocoords.note')}</p>
              <ul className="home-lines">
                {projects.map((project) => (
                  <li key={project.id} data-project-id={project.id}>
                    <Link to={workspaceLink(project.id)}>{t('home.map.project.text', { code: project.code, name: project.name })}</Link>
                  </li>
                ))}
              </ul>
            </SectionCard>
          </div>
        </>
      )}
    </div>
  );
}

function AreaCluster({ cluster }: { cluster: Cluster }) {
  const { t } = useTranslation();
  const title = cluster.key === OUTSIDE ? t('home.map.outside.title') : cluster.label;
  const columns: DataTableColumn<ClusterProject>[] = [
    { key: 'project', header: t('home.map.column.project'), pinned: true, render: (project) => <Link to={workspaceLink(project.id)}>{t('home.map.project.text', { code: project.code, name: project.name })}</Link> },
    { key: 'status', header: t('home.map.column.status'), render: (project) => <StatusPill tone="neutral">{stageLabel(t, project.status)}</StatusPill> },
    { key: 'share', header: t('home.map.column.share'), align: 'right', render: (project) => (project.sharePct === '100.00' ? '—' : t('home.map.share.value', { share: project.sharePct })) },
  ];
  return (
    <section aria-label={title} data-area={cluster.key} data-in-force={cluster.inForce}>
      <h3>{title}</h3>
      <p className="home-note">
        {cluster.key === OUTSIDE ? t('home.map.outside.note') : cluster.structureDate === null ? null : t('home.map.structure.text', { date: cluster.structureDate })}
        {cluster.key !== OUTSIDE && !cluster.inForce ? ` ${t('home.map.notinforce.note')}` : ''}
      </p>
      <DataTable caption={title} columns={columns} rows={cluster.projects} rowKey={(project) => project.id} />
    </section>
  );
}
