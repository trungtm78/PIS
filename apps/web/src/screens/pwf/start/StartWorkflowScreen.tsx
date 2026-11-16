import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useEdition } from '../../../editions/EditionContext';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ConfirmDialog } from '../../../ui';
import { useProject } from '../../prj/hooks';
import type { ProjectView } from '../../prj/model';
import { Named, templateName } from '../codes';
import { useUnitTree } from '../chooser/hooks';
import { ProcessChooser } from '../chooser/ProcessChooser';
import type { ChooserStep } from '../chooser/ProcessChooser';
import { ProblemBanner } from '../components';
import { problemText } from '../labels';
import { PATHS, PERMISSIONS, TEMPLATE_RULE_TYPE, dayText, describeProblem, holds, workflowLink } from '../model';
import type { AdoptResult, Problem } from '../model';
import { useWorkflowSuggestion } from '../process/hooks';
import { STEP_OF_PROBLEM, choiceProblems, suggestionQuery } from '../process/model';
import type { ChoiceForm } from '../process/model';
import { AdoptResultView } from './AdoptResultView';
import { useApplyAdoption, useDryRunAdoption, useStartWorkflow, useTemplateCatalogue } from './hooks';
import { adoptBody, choiceOfProject, decisionsValid, dryRunKey, readiness, startBodyOf, templateCodes } from './model';
import type { Decision, Decisions, Mode } from './model';
import './start.css';
import '../pwf.css';

const NEVER_EMPTY = (): boolean => false;

/** PWF-05: start the workflow of a project from a process, or adopt the workflow of a project that is already running. The choosing is the shared "Chọn quy trình" (R65). */
export default function StartWorkflowScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <StartWorkflowContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function StartWorkflowContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const projectId = params.get('id') ?? undefined;
  const project = useProject(projectId);
  const state = useScreenState({ isLoading: project.isLoading, error: project.error, data: projectId === undefined ? undefined : (project.data ?? undefined), isEmpty: NEVER_EMPTY });
  const missing = projectId === undefined || (project.isSuccess && project.data === null);
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <h1 id="screen-title">{t('pwf.start.page.title')}</h1>
        {projectId === undefined ? null : (
          <p>
            <Link to={`${PATHS.project}?id=${encodeURIComponent(projectId)}`}>{t('pwf.start.back.link')}</Link>
          </p>
        )}
      </div>
      {missing ? (
        <p className="callout warning" role="status" data-testid="no-project">
          {t('pwf.start.noProject.notice')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void project.refetch()}>
          {project.data === undefined || project.data === null ? null : <StartPanel project={project.data} />}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('pwf.start.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function StartPanel({ project }: { project: ProjectView }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { permissions, mode: sessionMode } = useSession();
  const frozen = sessionMode === 'READ_ONLY';
  const canStart = holds(permissions, PERMISSIONS.workflowManage, frozen);
  const canAdopt = holds(permissions, PERMISSIONS.workflowAdopt, frozen);

  const [mode, setMode] = useState<Mode>(canStart ? 'start' : 'adopt');
  const [choice, setChoice] = useState<ChoiceForm>(() => choiceOfProject(project));
  const [step, setStep] = useState<ChooserStep>(1);
  const [decisions, setDecisions] = useState<Decisions>({});
  const [attempted, setAttempted] = useState(false);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [dry, setDry] = useState<{ result: AdoptResult; key: string } | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);

  // R47: what the rule PROJECT_WORKFLOW_ASSIGNMENT suggests for this project and the facts chosen. The suggestion is a help: when it cannot be read a template chosen by hand still starts the workflow.
  // Asked in the public edition only: another edition keeps the screen it has.
  const suggestion = useWorkflowSuggestion(suggestionQuery({ projectId: project.id }, choice), useEdition().manifest.edition === 'public');
  const answer = suggestion.isError ? undefined : suggestion.data;
  const units = useUnitTree(true);
  const catalogue = useTemplateCatalogue(true);
  const entry = catalogue.data?.find((item) => item.ruleType === TEMPLATE_RULE_TYPE);
  const fallbackTemplates = templateCodes(entry).map((code) => ({ code: code.code, name: templateName(t, code.code), unverified: code.unverified }));

  const start = useStartWorkflow();
  const dryRun = useDryRunAdoption();
  const apply = useApplyAdoption();

  const adopting = mode === 'adopt';
  const problemsNow = () => choiceProblems(choice, answer, { required: true, adopting });
  const edit = (patch: Partial<ChoiceForm>): void => {
    setChoice((current) => ({ ...current, ...patch }));
    setProblem(undefined);
  };
  const changeMode = (next: Mode): void => {
    setAttempted(false);
    setMode(next);
    setProblem(undefined);
  };
  const setDecision = (code: string, decision: Decision | undefined): void => {
    setDecisions((current) => {
      const next = { ...current };
      if (decision === undefined) delete next[code];
      else next[code] = decision;
      return next;
    });
  };
  const goToWorkflow = (): void => navigate(workflowLink(project.id));
  const fail = (error: unknown): void => setProblem(describeProblem(error));
  /** Opens the step that holds the first thing to put right; true when something was in the way. */
  const stopped = (): boolean => {
    setAttempted(true);
    const found = problemsNow();
    if (found.length === 0) return false;
    setStep(Math.min(...found.map((one) => STEP_OF_PROBLEM[one])) as ChooserStep);
    return true;
  };

  const submitStart = async (): Promise<void> => {
    if (stopped()) return;
    try {
      await start.mutateAsync({ projectId: project.id, body: startBodyOf(choice, answer) });
      goToWorkflow();
    } catch (error) {
      fail(error);
    }
  };

  const runDry = async (): Promise<void> => {
    if (stopped() || !decisionsValid(decisions)) return;
    try {
      const result = await dryRun.mutateAsync({ projectId: project.id, body: adoptBody(choice, answer, decisions, true) });
      setDry({ result, key: dryRunKey(choice, answer, decisions) });
      setProblem(undefined);
    } catch (error) {
      fail(error);
    }
  };

  const applyAdoption = async (): Promise<void> => {
    try {
      await apply.mutateAsync({ projectId: project.id, body: adoptBody(choice, answer, decisions, false) });
      setConfirming(false);
      goToWorkflow();
    } catch (error) {
      fail(error);
    }
  };

  if (!canStart && !canAdopt) {
    return (
      <p className="callout warning" role="status" data-testid="no-permission">
        {t('pwf.start.noPermission.notice')}
      </p>
    );
  }

  const status = dry === undefined ? undefined : readiness(dry.result, dry.key, dryRunKey(choice, answer, decisions), decisions);
  const types = [...new Set([project.projectType?.businessKey ?? '', choice.projectType].filter((value) => value !== ''))].map((value) => ({ value, label: value === project.projectType?.businessKey ? (project.projectType?.label ?? '') : '' }));

  return (
    <>
      <p className="pwf-context" data-testid="start-project">
        <Named name={project.name} code={project.code} />
      </p>
      <form
        data-testid="start-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        {canStart && canAdopt ? (
          <fieldset className="pwf-mode">
            <legend>{t('pwf.start.mode.legend')}</legend>
            <label>
              <input type="radio" name="mode" checked={!adopting} onChange={() => changeMode('start')} /> {t('pwf.start.mode.start.label')}
            </label>
            <label>
              <input type="radio" name="mode" checked={adopting} onChange={() => changeMode('adopt')} /> {t('pwf.start.mode.adopt.label')}
            </label>
          </fieldset>
        ) : (
          <p>{canStart ? t('pwf.start.mode.start.label') : t('pwf.start.mode.adopt.label')}</p>
        )}
        {catalogue.error === null || catalogue.error === undefined ? null : <ProblemBanner problem={describeProblem(catalogue.error)} />}
        {entry !== undefined && fallbackTemplates.length === 0 ? (
          <p className="callout warning" role="status" data-testid="no-template">
            {t('pwf.start.template.empty.notice')}
          </p>
        ) : null}
        <ProcessChooser
          mode={mode}
          step={step}
          onStep={setStep}
          form={choice}
          onChange={edit}
          suggestion={answer}
          current={!suggestion.isError}
          loading={suggestion.isLoading}
          failed={suggestion.isError}
          onRetry={() => void suggestion.refetch()}
          fallbackTemplates={fallbackTemplates}
          projectTypes={types}
          units={units.data ?? []}
          unitsFailed={units.isError}
          disabled={false}
          showProblems={attempted}
          withoutStart={t('pwf.start.plannedStart.hint')}
          refusal={problem}
          adoption={
            adopting && dry !== undefined && status !== undefined ? (
              <>
                <AdoptResultView result={dry.result} decisions={decisions} readiness={status} showErrors={attempted} onDecision={setDecision} />
                <div className="pwf-actions">
                  <button type="button" className="ui-button ui-button--primary" data-testid="apply" disabled={status !== 'ready' || apply.isPending} onClick={() => setConfirming(true)}>
                    {t('pwf.start.apply.action')}
                  </button>
                </div>
              </>
            ) : null
          }
          confirm={
            adopting ? (
              <button type="button" className="ui-button ui-button--primary" data-testid="dry-run" disabled={dryRun.isPending} onClick={() => void runDry()}>
                {t('pwf.start.dryRun.action')}
              </button>
            ) : (
              <button type="button" className="ui-button ui-button--primary" data-testid="submit-start" disabled={start.isPending} onClick={() => void submitStart()}>
                {t('pwf.start.submit.action')}
              </button>
            )
          }
        />
        {problem === undefined ? null : <ProblemBanner problem={problem} />}
      </form>
      <ConfirmDialog
        open={confirming}
        title={t('pwf.start.apply.confirm.title')}
        context={[
          { label: t('pwf.start.apply.confirm.project'), value: `${project.code} · ${project.name}` },
          { label: t('pwf.start.effective.label'), value: dayText(choice.effectiveDate) },
        ]}
        confirmLabel={t('pwf.start.apply.confirm.action')}
        cancelLabel={t('pwf.start.apply.cancel.action')}
        pending={apply.isPending}
        {...(problem === undefined ? {} : { error: problemText(t, problem) })}
        onConfirm={() => void applyAdoption()}
        onCancel={() => setConfirming(false)}
      >
        <p>{t('pwf.start.apply.confirm.body')}</p>
      </ConfirmDialog>
    </>
  );
}
