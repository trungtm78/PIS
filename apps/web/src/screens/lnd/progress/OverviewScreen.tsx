import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { parcelStatusLabel } from '../labels';
import { PARCEL_STATUSES } from '../model';
import type { ParcelStatus } from '../model';
import { useProjectOptions } from '../read-hooks';
import { executorKindLabel, stageLabel, stageStatusLabel } from './labels';
import { useOverview } from './hooks';
import { PROGRESS_PATH, lateStages } from './model';
import type { Overview } from './model';
import { ProjectPicker } from './ProjectPicker';
import '../lnd.css';

/**
 * LND-01: the land clearance of a project at a glance (ST-LND-010). Every figure is counted by the server from the rows of LND at the moment it says (`as_of`): the parcels, the
 * households (a count, never a name), the parcels with a notice, the parcels paid, the area handed over against the area needed, and the stages that are late with the unit
 * that executes each of them, including the stages that an external centre executes.
 */
export default function OverviewScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The figures belong to one membership: a switch of tenant or of membership starts the screen over.
  return <OverviewContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function OverviewContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const projectId = params.get('project') ?? undefined;
  const projects = useProjectOptions();
  const overview = useOverview(projectId, undefined);
  const state = useScreenState({ isLoading: overview.isLoading, error: overview.error, data: overview.data, isEmpty: () => false });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('lnd.overview.page.title')}</h1>
          <p>{t('lnd.overview.page.subtitle')}</p>
        </div>
      </div>
      <ProjectPicker id="overview-project" projects={projects.data ?? []} value={projectId} onChange={(id) => setParams(id === '' ? {} : { project: id })} />
      {projectId === undefined ? (
        <p className="callout" role="status" data-testid="choose-project">
          {t('lnd.progress.project.notice')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void overview.refetch()}>
          {overview.data === undefined ? null : <Figures overview={overview.data} projectId={projectId} />}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('lnd.progress.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Tile({ id, label, value }: { id: string; label: string; value: string }) {
  return (
    <div className="lnd-tile" data-testid={`tile-${id}`}>
      <span className="sub">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Figures({ overview, projectId }: { overview: Overview; projectId: string }) {
  const { t } = useTranslation();
  const { totals } = overview;
  const late = lateStages(overview.stages);
  const sectionCode = (id: string): string => overview.sections.find((section) => section.id === id)?.code ?? '';
  const statuses = PARCEL_STATUSES.filter((status) => overview.parcelsByStatus.some((row) => row.status === status && row.count > 0));
  const countOf = (status: ParcelStatus): number => overview.parcelsByStatus.find((row) => row.status === status)?.count ?? 0;
  return (
    <>
      <p className="sub" data-testid="as-of">
        {t('lnd.overview.asOf.text', { at: overview.asOf ?? '' })}
      </p>
      <div className="lnd-tiles" data-testid="tiles">
        <Tile id="parcels" label={t('lnd.overview.tile.parcels')} value={String(totals.parcels)} />
        <Tile id="households" label={t('lnd.overview.tile.households')} value={String(totals.households)} />
        <Tile id="noticed" label={t('lnd.overview.tile.noticed')} value={`${totals.parcelsNoticed} / ${totals.parcels}`} />
        <Tile id="paid" label={t('lnd.overview.tile.paid')} value={`${totals.parcelsPaid} / ${totals.parcels}`} />
        <Tile id="area" label={t('lnd.overview.tile.area')} value={`${totals.handedAreaM2} / ${totals.requiredAreaM2}`} />
        <Tile id="late" label={t('lnd.overview.tile.late')} value={String(totals.lateStages)} />
      </div>
      <div className="card" data-testid="late-stages">
        <h2>{t('lnd.overview.late.title')}</h2>
        {late.length === 0 ? (
          <p className="callout" role="status" data-testid="no-late">
            {t('lnd.overview.late.none')}
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{t('lnd.progress.column.section')}</th>
                <th scope="col">{t('lnd.progress.column.stage')}</th>
                <th scope="col">{t('lnd.progress.column.executor')}</th>
                <th scope="col">{t('lnd.progress.column.plannedEnd')}</th>
                <th scope="col">{t('lnd.progress.column.status')}</th>
              </tr>
            </thead>
            <tbody>
              {late.map((stage) => (
                <tr key={stage.id} data-stage-id={stage.id}>
                  <th scope="row">{sectionCode(stage.sectionId)}</th>
                  <td>{stageLabel(t, stage.stageCode)}</td>
                  <td data-testid="executor">{`${stage.executorUnitName} (${executorKindLabel(t, stage.executorKind)})`}</td>
                  <td>{stage.plannedEnd ?? ''}</td>
                  <td>
                    <span className="lnd-badge warning">{stageStatusLabel(t, stage.status)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p>
          <Link to={`${PROGRESS_PATH}?project=${projectId}`}>{t('lnd.overview.board.link')}</Link>
        </p>
      </div>
      <div className="card" data-testid="sections">
        <h2>{t('lnd.overview.sections.title')}</h2>
        {overview.sections.length === 0 ? (
          <p className="callout" role="status" data-testid="no-sections">
            {t('lnd.overview.sections.none')}
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{t('lnd.progress.column.section')}</th>
                <th scope="col">{t('lnd.overview.column.parcels')}</th>
                <th scope="col">{t('lnd.overview.column.noticed')}</th>
                <th scope="col">{t('lnd.overview.column.paid')}</th>
                <th scope="col">{t('lnd.overview.column.area')}</th>
                <th scope="col">{t('lnd.overview.column.target')}</th>
              </tr>
            </thead>
            <tbody>
              {overview.sections.map((section) => (
                <tr key={section.id} data-section-id={section.id}>
                  <th scope="row">{`${section.code} · ${section.name}`}</th>
                  <td className="lnd-numeric">{section.parcels}</td>
                  <td className="lnd-numeric">{section.parcelsNoticed}</td>
                  <td className="lnd-numeric">{section.parcelsPaid}</td>
                  <td className="lnd-numeric">{`${section.handedAreaM2} / ${section.requiredAreaM2}`}</td>
                  <td>{section.targetDate ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {statuses.length === 0 ? null : (
        <div className="card" data-testid="by-status">
          <h2>{t('lnd.overview.status.title')}</h2>
          <ul>
            {statuses.map((status) => (
              <li key={status} data-status={status}>
                {`${parcelStatusLabel(t, status)}: ${countOf(status)}`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
