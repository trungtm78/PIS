import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { todayInVietnam } from '../model';
import { useProjectOptions, useSections, useUnits } from '../read-hooks';
import { executorKindLabel, modeLabel, stageLabel, stageStatusLabel } from './labels';
import { useOverview } from './hooks';
import { canReport, reportable } from './model';
import type { StageLine } from './model';
import { ProjectPicker } from './ProjectPicker';
import { ReportDialog } from './ReportDialog';
import '../lnd.css';

type Dialog = { kind: 'report'; stage: StageLine | undefined };

/**
 * LND-11: the progress of the stages of land clearance, including those that the land fund centre or the board of the district executes outside this system (ST-LND-010).
 * A stage tracked from outside takes the report of the executing unit with the evidence of a clean document; a stage counted from the data of LND is shown and cannot be
 * reported by hand. A stage that is behind its planned end is marked late, and the issue it opened is named.
 */
export default function ExternalProgressScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The board and the dialog belong to one membership: a switch of tenant or of membership starts the screen over.
  return <ProgressContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ProgressContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [params, setParams] = useSearchParams();
  const projectId = params.get('project') ?? undefined;
  const projects = useProjectOptions();
  const overview = useOverview(projectId, undefined);
  const sections = useSections(projectId);
  const mayReport = canReport(permissions, mode);
  const units = useUnits(mayReport && projectId !== undefined);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const today = todayInVietnam();
  // A project with no stage reported yet is not an empty screen: the officer still needs the button that gives the first stage to its executor.
  const state = useScreenState({ isLoading: overview.isLoading, error: overview.error, data: overview.data, isEmpty: () => false });
  const stages = overview.data?.stages ?? [];
  const sectionCode = (id: string): string => (overview.data?.sections ?? []).find((section) => section.id === id)?.code ?? '';
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('lnd.progress.page.title')}</h1>
          <p>{t('lnd.progress.page.subtitle')}</p>
        </div>
        {mayReport && projectId !== undefined ? (
          <div className="actions">
            <button type="button" className="primary" onClick={() => setDialog({ kind: 'report', stage: undefined })}>
              {t('lnd.progress.report.action')}
            </button>
          </div>
        ) : null}
      </div>
      <ProjectPicker id="progress-project" projects={projects.data ?? []} value={projectId} onChange={(id) => setParams(id === '' ? {} : { project: id })} />
      {projectId === undefined ? (
        <p className="callout" role="status" data-testid="choose-project">
          {t('lnd.progress.project.notice')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void overview.refetch()}>
          <div className="card">
            {stages.length === 0 ? (
              <p className="callout" role="status" data-testid="no-stages">
                {t('lnd.progress.empty.notice')}
              </p>
            ) : (
              <table className="table" data-testid="stages">
                <thead>
                  <tr>
                    <th scope="col">{t('lnd.progress.column.section')}</th>
                    <th scope="col">{t('lnd.progress.column.stage')}</th>
                    <th scope="col">{t('lnd.progress.column.executor')}</th>
                    <th scope="col">{t('lnd.progress.column.mode')}</th>
                    <th scope="col">{t('lnd.progress.column.parcels')}</th>
                    <th scope="col">{t('lnd.progress.column.progress')}</th>
                    <th scope="col">{t('lnd.progress.column.plannedEnd')}</th>
                    <th scope="col">{t('lnd.progress.column.status')}</th>
                    <th scope="col">{t('lnd.progress.column.action')}</th>
                  </tr>
                </thead>
                <tbody>
                  {stages.map((stage) => (
                    <StageRow key={stage.id} stage={stage} sectionCode={sectionCode(stage.sectionId)} canEdit={mayReport && reportable(stage)} onEdit={() => setDialog({ kind: 'report', stage })} />
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </StateBoundary>
      )}
      {dialog?.kind === 'report' && projectId !== undefined ? (
        <ReportDialog projectId={projectId} today={today} sections={sections.data ?? []} units={units.data ?? []} stage={dialog.stage} onClose={() => setDialog(undefined)} />
      ) : null}
      <p className="prototype-note">{t('lnd.progress.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function StageRow({ stage, sectionCode, canEdit, onEdit }: { stage: StageLine; sectionCode: string; canEdit: boolean; onEdit(): void }) {
  const { t } = useTranslation();
  return (
    <tr data-stage-id={stage.id}>
      <th scope="row">{sectionCode}</th>
      <td>{stageLabel(t, stage.stageCode)}</td>
      <td data-testid="executor">{`${stage.executorUnitName} (${executorKindLabel(t, stage.executorKind)})`}</td>
      <td data-testid="mode">{modeLabel(t, stage.mode)}</td>
      <td className="lnd-numeric" data-testid="parcels">{`${stage.parcelsDone} / ${stage.parcelsTotal}`}</td>
      <td className="lnd-numeric" data-testid="progress">{`${stage.progressPct}%`}</td>
      <td>{stage.plannedEnd ?? ''}</td>
      <td>
        <span className={stage.status === 'LATE' || stage.status === 'BLOCKED' ? 'lnd-badge warning' : 'lnd-badge'} data-testid="status">
          {stageStatusLabel(t, stage.status)}
        </span>
        {stage.evidenceDocumentVersionId === null ? null : (
          <small className="sub" data-testid="evidence">
            {t('lnd.progress.evidence.text')}
          </small>
        )}
        {stage.blockerNote === null ? null : (
          <small className="sub" data-testid="blocker">
            {stage.blockerNote}
          </small>
        )}
        {stage.blockerIssueId === null ? null : (
          <small className="sub" data-testid="issue">
            {t('lnd.progress.issue.text')}
          </small>
        )}
      </td>
      <td>
        {canEdit ? (
          <button type="button" className="button" aria-label={t('lnd.progress.update.aria', { stage: stageLabel(t, stage.stageCode), section: sectionCode })} onClick={onEdit}>
            {t('lnd.progress.update.action')}
          </button>
        ) : null}
      </td>
    </tr>
  );
}
