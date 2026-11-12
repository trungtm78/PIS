import { ApiError } from '@machvon/api-client';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { KpiStrip, KpiTile, SectionCard } from '../../../ui';
import { useProject } from '../../prj/hooks';
import { CalendarMissingNote, FigureInfo, ProblemBanner } from '../components';
import { useReloadPwf } from '../hooks';
import { PATHS, PERMISSIONS, dayText, describeProblem, holds, missingYears, startLink, workflowLink } from '../model';
import type { Problem, Schedule, WorkflowDetail } from '../model';
import { ChangesView } from './ChangesView';
import { DecisionPanel } from './DecisionPanel';
import { ProposalForm } from './ProposalForm';
import { useDecide, usePropose, useSchedule, useWorkflow } from './hooks';
import { decisionBody, emptyForm, hasFormErrors, heldFromAddress, heldFromPreview, isOpenProposal, proposeBody, validateForm } from './model';
import type { DecisionBody, HeldProposal, RescheduleForm } from './model';
import '../pwf.css';
import '../start/start.css';

const NEVER_EMPTY = (): boolean => false;
const notThere = (error: unknown): boolean => error instanceof ApiError && error.status === 404;

/** PWF-06: the preview of a reschedule (what if the start day moves) and the decision of a second person on it. */
export default function RescheduleScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <RescheduleContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function RescheduleContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const projectId = params.get('id') ?? undefined;
  const project = useProject(projectId);
  const workflow = useWorkflow(projectId);
  const schedule = useSchedule(projectId);
  const noWorkflow = notThere(workflow.error);
  const state = useScreenState({
    isLoading: project.isLoading || workflow.isLoading || schedule.isLoading,
    error: noWorkflow ? undefined : (project.error ?? workflow.error ?? schedule.error ?? undefined),
    data: projectId === undefined ? undefined : (project.data ?? undefined),
    isEmpty: NEVER_EMPTY,
  });
  const missing = projectId === undefined || (project.isSuccess && project.data === null);
  const retry = (): void => {
    void project.refetch();
    void workflow.refetch();
    void schedule.refetch();
  };
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <h1 id="screen-title">{t('pwf.resched.page.title')}</h1>
        {project.data === undefined || project.data === null ? null : (
          <p>
            <code>{project.data.code}</code> · {project.data.name} ·{' '}
            <Link to={workflowLink(project.data.id)}>{t('pwf.resched.back.link')}</Link>
          </p>
        )}
      </div>
      {missing ? (
        <p className="callout warning" role="status" data-testid="no-project">
          {t('pwf.resched.noProject.notice')}
        </p>
      ) : noWorkflow ? (
        <p className="callout warning" role="status" data-testid="no-workflow">
          {t('pwf.resched.noWorkflow.notice')} <Link to={startLink(projectId)}>{t('pwf.resched.noWorkflow.link')}</Link>
        </p>
      ) : (
        <StateBoundary state={state} onRetry={retry}>
          {workflow.data === undefined || schedule.data === undefined ? null : <ReschedulePanel projectId={projectId} workflow={workflow.data} schedule={schedule.data} />}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('pwf.resched.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

interface PanelProps {
  projectId: string;
  workflow: WorkflowDetail;
  schedule: Schedule;
}

function ReschedulePanel({ projectId, workflow, schedule }: PanelProps) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const { permissions, mode } = useSession();
  const frozen = mode === 'READ_ONLY';
  const canPropose = holds(permissions, PERMISSIONS.schedulePropose, frozen);
  const canDecide = holds(permissions, PERMISSIONS.scheduleApprove, frozen);
  const reload = useReloadPwf();
  const propose = usePropose(projectId);
  const decide = useDecide();

  const [form, setForm] = useState<RescheduleForm>(emptyForm);
  const [attempted, setAttempted] = useState(false);
  const [held, setHeld] = useState<HeldProposal | undefined>(() => heldFromAddress(params));
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [decided, setDecided] = useState<DecisionBody['decision'] | undefined>(undefined);

  const errors = attempted ? validateForm(form) : { fields: {}, rows: {} };
  const years = missingYears(schedule.tasks);
  const version = t('pwf.resched.info.scheduleVersion.text', { version: workflow.schedule_version });

  const submit = async (): Promise<void> => {
    setAttempted(true);
    if (hasFormErrors(validateForm(form))) return;
    try {
      const preview = await propose.mutateAsync({ id: projectId, version: workflow.version, body: proposeBody(form) });
      setHeld(heldFromPreview(preview));
      setDecided(undefined);
      setProblem(undefined);
    } catch (error) {
      setProblem(describeProblem(error));
    }
  };

  const send = async (decision: DecisionBody['decision'], note: string): Promise<void> => {
    if (held === undefined) return;
    try {
      await decide.mutateAsync({ id: held.id, version: held.baseVersion, body: decisionBody(decision, note) });
      setDecided(decision);
      setProblem(undefined);
    } catch (error) {
      setProblem(describeProblem(error));
    }
  };

  const readNewer = (): void => {
    setHeld(undefined);
    setProblem(undefined);
    setDecided(undefined);
    void reload();
  };

  if (!canPropose && !canDecide) {
    return (
      <p className="callout warning" role="status" data-testid="no-permission">
        {t('pwf.resched.noPermission.notice')}
      </p>
    );
  }

  return (
    <>
      <KpiStrip label={t('pwf.resched.current.label')}>
        <KpiTile label={t('pwf.resched.current.start.label')} value={dayText(schedule.project_start)} />
        <KpiTile label={t('pwf.resched.current.finish.label')} value={dayText(schedule.project_finish)} sub={<FigureInfo name={t('pwf.resched.current.finish.label')} formula={t('pwf.resched.current.finish.formula')} source={t('pwf.resched.current.finish.source')} asOf={schedule.published_at ?? workflow.as_of} version={version} />} />
        <KpiTile label={t('pwf.resched.current.version.label')} value={String(workflow.schedule_version)} sub={<FigureInfo name={t('pwf.resched.current.version.label')} formula={t('pwf.resched.current.version.formula')} source={t('pwf.resched.current.version.source')} asOf={workflow.as_of} version={version} />} />
      </KpiStrip>
      <CalendarMissingNote years={years} />
      {problem === undefined ? null : <ProblemBanner problem={problem} onReload={readNewer} />}

      {canPropose ? (
        <ProposalForm form={form} errors={errors} pending={propose.isPending} disabled={!workflow.can_propose_reschedule} onChange={setForm} onSubmit={() => void submit()} />
      ) : null}
      {canPropose && !workflow.can_propose_reschedule ? (
        <p className="callout warning" role="status" data-testid="cannot-propose">
          {t('pwf.resched.cannotPropose.notice')}
        </p>
      ) : null}

      {held?.preview === undefined ? null : <ChangesView preview={held.preview} before={schedule} />}

      {decided === undefined ? null : (
        <SectionCard title={t('pwf.resched.decided.title')}>
          <p className="callout" role="status" data-testid="decided">
            {decided === 'APPROVE' ? t('pwf.resched.decided.approved.notice') : t('pwf.resched.decided.rejected.notice')} <Link to={workflowLink(projectId)}>{t('pwf.resched.back.link')}</Link>
          </p>
        </SectionCard>
      )}
      {canDecide && held !== undefined && decided === undefined && isOpenProposal(held) ? <DecisionPanel held={held} pending={decide.isPending} onDecide={(decision, note) => void send(decision, note)} /> : null}
      <p>
        <Link to={PATHS.board}>{t('pwf.resched.board.link')}</Link>
      </p>
    </>
  );
}
