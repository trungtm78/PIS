import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar, DataTable, KpiStrip, KpiTile, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { parcelStatusLabel } from '../labels';
import { PARCEL_STATUSES } from '../model';
import type { ParcelStatus } from '../model';
import { useProjectOptions } from '../read-hooks';
import { executorKindLabel, stageLabel, stageStatusLabel } from './labels';
import { useOverview } from './hooks';
import { PROGRESS_PATH, lateStages } from './model';
import type { Overview, SectionLine, StageLine } from './model';
import { ProjectPicker } from './ProjectPicker';
import { UpcomingDeadlines } from './UpcomingDeadlines';
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
  const { tenant } = useSession();
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
      <ContextBar
        items={[
          { label: t('w2iss.ctx.scope'), value: tenant?.name ?? t('w2iss.ctx.scope.all') },
          { label: t('w2iss.lnd.ctx.project'), value: (projects.data ?? []).find((project) => project.id === projectId)?.code ?? t('w2iss.lnd.ctx.project.none') },
        ]}
      />
      <ProjectPicker id="overview-project" projects={projects.data ?? []} value={projectId} onChange={(id) => setParams(id === '' ? {} : { project: id })} />
      <UpcomingDeadlines onOpenProject={(id) => setParams({ project: id })} />
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

function Tile({ id, label, value, unit, tone }: { id: string; label: string; value: string; unit?: string; tone?: 'danger' | 'default' }) {
  return (
    <div className="lnd-tile-wrap" data-testid={`tile-${id}`}>
      <KpiTile label={label} value={value} {...(unit === undefined ? {} : { unit })} {...(tone === undefined ? {} : { tone })} />
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
  const stageColumns: DataTableColumn<StageLine>[] = [
    { key: 'section', header: t('lnd.progress.column.section'), pinned: true, render: (stage) => <span data-stage-id={stage.id}>{sectionCode(stage.sectionId)}</span> },
    { key: 'stage', header: t('lnd.progress.column.stage'), render: (stage) => stageLabel(t, stage.stageCode) },
    { key: 'executor', header: t('lnd.progress.column.executor'), render: (stage) => <span data-testid="executor">{`${stage.executorUnitName} (${executorKindLabel(t, stage.executorKind)})`}</span> },
    { key: 'plannedEnd', header: t('lnd.progress.column.plannedEnd'), render: (stage) => stage.plannedEnd ?? '' },
    { key: 'status', header: t('lnd.progress.column.status'), render: (stage) => <StatusPill tone="warning">{stageStatusLabel(t, stage.status)}</StatusPill> },
  ];
  const sectionColumns: DataTableColumn<SectionLine>[] = [
    { key: 'section', header: t('lnd.progress.column.section'), pinned: true, render: (section) => <span data-section-id={section.id}>{`${section.code} · ${section.name}`}</span> },
    { key: 'parcels', header: t('lnd.overview.column.parcels'), align: 'right', render: (section) => String(section.parcels) },
    { key: 'noticed', header: t('lnd.overview.column.noticed'), align: 'right', render: (section) => String(section.parcelsNoticed) },
    { key: 'paid', header: t('lnd.overview.column.paid'), align: 'right', render: (section) => String(section.parcelsPaid) },
    { key: 'area', header: t('lnd.overview.column.area'), align: 'right', render: (section) => `${section.handedAreaM2} / ${section.requiredAreaM2}` },
    { key: 'target', header: t('lnd.overview.column.target'), render: (section) => section.targetDate ?? '' },
  ];
  return (
    <>
      <p className="sub" data-testid="as-of">
        {t('lnd.overview.asOf.text', { at: overview.asOf ?? '' })}
      </p>
      <div data-testid="tiles">
        <KpiStrip label={t('w2iss.lnd.kpi.label')}>
          <Tile id="parcels" label={t('lnd.overview.tile.parcels')} value={String(totals.parcels)} />
          <Tile id="households" label={t('lnd.overview.tile.households')} value={String(totals.households)} />
          <Tile id="noticed" label={t('lnd.overview.tile.noticed')} value={`${totals.parcelsNoticed} / ${totals.parcels}`} />
          <Tile id="paid" label={t('lnd.overview.tile.paid')} value={`${totals.parcelsPaid} / ${totals.parcels}`} />
          <Tile id="area" label={t('lnd.overview.tile.area')} value={`${totals.handedAreaM2} / ${totals.requiredAreaM2}`} unit={t('w2iss.lnd.unit')} />
          <Tile id="late" label={t('lnd.overview.tile.late')} value={String(totals.lateStages)} tone={totals.lateStages > 0 ? 'danger' : 'default'} />
        </KpiStrip>
      </div>
      <div className="lnd-stack">
        <div data-testid="late-stages">
          <SectionCard title={t('lnd.overview.late.title')}>
            {late.length === 0 ? (
              <p className="callout" role="status" data-testid="no-late">
                {t('lnd.overview.late.none')}
              </p>
            ) : (
              <DataTable caption={t('lnd.overview.late.title')} columns={stageColumns} rows={late} rowKey={(stage) => stage.id} />
            )}
            <p>
              <Link to={`${PROGRESS_PATH}?project=${projectId}`}>{t('lnd.overview.board.link')}</Link>
            </p>
          </SectionCard>
        </div>
        <div data-testid="sections">
          <SectionCard title={t('lnd.overview.sections.title')} unit={t('w2iss.lnd.unit')}>
            {overview.sections.length === 0 ? (
              <p className="callout" role="status" data-testid="no-sections">
                {t('lnd.overview.sections.none')}
              </p>
            ) : (
              <DataTable caption={t('lnd.overview.sections.title')} columns={sectionColumns} rows={overview.sections} rowKey={(section) => section.id} />
            )}
          </SectionCard>
        </div>
        {statuses.length === 0 ? null : (
          <div data-testid="by-status">
            <SectionCard title={t('lnd.overview.status.title')}>
              <ul>
                {statuses.map((status) => (
                  <li key={status} data-status={status}>
                    {`${parcelStatusLabel(t, status)}: ${countOf(status)}`}
                  </li>
                ))}
              </ul>
            </SectionCard>
          </div>
        )}
      </div>
    </>
  );
}
