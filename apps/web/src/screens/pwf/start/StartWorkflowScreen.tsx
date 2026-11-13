import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ConfirmDialog, SectionCard, StatusPill } from '../../../ui';
import { useProject } from '../../prj/hooks';
import type { ProjectView } from '../../prj/model';
import { CalendarMissingNote, FigureInfo, ProblemBanner, UnverifiedLabel } from '../components';
import { formProblemText, problemText } from '../labels';
import { PATHS, PERMISSIONS, TEMPLATE_RULE_TYPE, dayText, describeProblem, factsOf, holds, missingYears, workflowLink } from '../model';
import type { AdoptResult, Problem, TemplateParams } from '../model';
import { useWorkflowSuggestion } from '../process/hooks';
import { basisText } from '../process/labels';
import { FACT_VALUE, MAX_SELECTION_REASON, MIN_SELECTION_REASON } from '../process/model';
import { AdoptResultView } from './AdoptResultView';
import { useApplyAdoption, useDryRunAdoption, usePreviewTemplate, useStartWorkflow, useTemplateCatalogue, useTemplateRule } from './hooks';
import { FACT_FIELDS, MAX_FACT, adoptBody, decisionsValid, dryRunKey, emptyForm, factsOfProject, hasErrors, readiness, startBody, summarizeTemplate, templateCodes, validateForm } from './model';
import type { Decision, Decisions, FactField, FormField, Mode, StartForm } from './model';
import './start.css';
import '../pwf.css';

const NEVER_EMPTY = (): boolean => false;
/** The label of a fact of the branch (each key is written out so that the i18n check sees it is in use). */
function factLabel(t: Translator['t'], field: FactField): string {
  switch (field) {
    case 'project_group':
      return t('pwf.start.fact.group.label');
    case 'funding_source':
      return t('pwf.start.fact.funding.label');
    case 'project_type':
      return t('pwf.start.fact.type.label');
  }
}

/** PWF-05: start the workflow of a project from a template, or adopt the workflow of a project that is already running. */
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

interface FieldProps {
  label: string;
  testId: string;
  error?: string | undefined;
  children: (props: { id: string; invalid: true | undefined; describedBy: string | undefined }) => ReactNode;
  hint?: string;
}

function LabelledField({ label, testId, error, children, hint }: FieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="pwf-field">
      <label htmlFor={id}>{label}</label>
      {children({ id, invalid: error === undefined ? undefined : true, describedBy: error === undefined ? undefined : errorId })}
      {hint === undefined ? null : <span className="pwf-hint">{hint}</span>}
      {error === undefined ? null : (
        <span id={errorId} className="pwf-field__error" data-testid={`error-${testId}`}>
          {error}
        </span>
      )}
    </div>
  );
}

function StartPanel({ project }: { project: ProjectView }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { permissions, mode: sessionMode } = useSession();
  const frozen = sessionMode === 'READ_ONLY';
  const canStart = holds(permissions, PERMISSIONS.workflowManage, frozen);
  const canAdopt = holds(permissions, PERMISSIONS.workflowAdopt, frozen);
  const canPreview = holds(permissions, PERMISSIONS.templateManage, frozen);

  const [form, setForm] = useState<StartForm>(() => ({ ...emptyForm(canStart ? 'start' : 'adopt'), facts: factsOfProject(project) }));
  const [decisions, setDecisions] = useState<Decisions>({});
  const [attempted, setAttempted] = useState(false);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [dry, setDry] = useState<{ result: AdoptResult; key: string } | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');

  // R47: what the rule PROJECT_WORKFLOW_ASSIGNMENT suggests for this project and the facts typed. The suggestion is a help: when it cannot be read the form works as it always did.
  const suggestionQuery: Record<string, string> = { project_id: project.id };
  for (const field of FACT_FIELDS) if (FACT_VALUE.test(form.facts[field].trim())) suggestionQuery[field] = form.facts[field].trim();
  const suggestion = useWorkflowSuggestion(suggestionQuery, true);
  const suggested = suggestion.data?.suggested_template_code ?? null;
  const overriding = suggested !== null && form.templateCode !== '' && form.templateCode !== suggested;
  const reasonMissing = overriding && (reason.trim().length < MIN_SELECTION_REASON || reason.trim().length > MAX_SELECTION_REASON);
  const withReason = <Body extends object>(body: Body): Body => (overriding && reason.trim() !== '' ? { ...body, selection_reason: reason.trim() } : body);

  const catalogue = useTemplateCatalogue(true);
  const entry = catalogue.data?.find((item) => item.ruleType === TEMPLATE_RULE_TYPE);
  const codes = templateCodes(entry);
  const rule = useTemplateRule(form.templateCode, form.templateCode !== '');
  const summary = rule.data === null || rule.data === undefined ? undefined : summarizeTemplate(rule.data.params);

  const start = useStartWorkflow();
  const dryRun = useDryRunAdoption();
  const apply = useApplyAdoption();
  const preview = usePreviewTemplate();

  const errors = attempted ? validateForm(form) : {};
  const fieldError = (field: FormField): string | undefined => {
    const found = errors[field];
    return found === undefined ? undefined : formProblemText(t, found, { max: MAX_FACT });
  };
  const edit = (patch: Partial<StartForm>): void => {
    setForm((current) => ({ ...current, ...patch }));
    setProblem(undefined);
  };
  const setMode = (mode: Mode): void => {
    setAttempted(false);
    edit({ mode });
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

  const submitStart = async (): Promise<void> => {
    setAttempted(true);
    if (hasErrors(validateForm(form)) || reasonMissing) return;
    try {
      await start.mutateAsync({ projectId: project.id, body: withReason(startBody(form)) });
      goToWorkflow();
    } catch (error) {
      fail(error);
    }
  };

  const runDry = async (): Promise<void> => {
    setAttempted(true);
    if (hasErrors(validateForm(form)) || !decisionsValid(decisions) || reasonMissing) return;
    try {
      const result = await dryRun.mutateAsync({ projectId: project.id, body: withReason(adoptBody(form, decisions, true)) });
      setDry({ result, key: dryRunKey(form, decisions) });
      setProblem(undefined);
    } catch (error) {
      fail(error);
    }
  };

  const applyAdoption = async (): Promise<void> => {
    try {
      await apply.mutateAsync({ projectId: project.id, body: withReason(adoptBody(form, decisions, false)) });
      setConfirming(false);
      goToWorkflow();
    } catch (error) {
      fail(error);
    }
  };

  const runPreview = (): void => {
    setAttempted(true);
    if (rule.data === null || rule.data === undefined || validateForm(form).plannedStart !== undefined) return;
    preview.mutate({ params: rule.data.params as unknown as TemplateParams, plannedStart: form.plannedStart.trim(), facts: factsOf(form.facts) });
  };

  if (!canStart && !canAdopt) {
    return (
      <p className="callout warning" role="status" data-testid="no-permission">
        {t('pwf.start.noPermission.notice')}
      </p>
    );
  }

  const current = dryRunKey(form, decisions);
  const status = dry === undefined ? undefined : readiness(dry.result, dry.key, current, decisions);
  const adopting = form.mode === 'adopt';

  return (
    <>
      <p>
        <code>{project.code}</code> · {project.name}
      </p>
      <SectionCard title={t('pwf.start.form.title')}>
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
                <input type="radio" name="mode" checked={!adopting} onChange={() => setMode('start')} /> {t('pwf.start.mode.start.label')}
              </label>
              <label>
                <input type="radio" name="mode" checked={adopting} onChange={() => setMode('adopt')} /> {t('pwf.start.mode.adopt.label')}
              </label>
            </fieldset>
          ) : (
            <p>{canStart ? t('pwf.start.mode.start.label') : t('pwf.start.mode.adopt.label')}</p>
          )}

          {catalogue.error === null || catalogue.error === undefined ? null : <ProblemBanner problem={describeProblem(catalogue.error)} />}
          <div className="pwf-filters">
            <LabelledField label={t('pwf.start.template.label')} testId="template" error={fieldError('templateCode')}>
              {({ id, invalid, describedBy }) => (
                <select id={id} data-testid="template" value={form.templateCode} aria-invalid={invalid} aria-describedby={describedBy} onChange={(event) => edit({ templateCode: event.target.value })}>
                  <option value="">{t('pwf.start.template.choose.option')}</option>
                  {codes.map((code) => (
                    <option key={code.code} value={code.code}>
                      {code.unverified ? t('pwf.start.template.unverifiedOption.text', { code: code.code }) : code.code}
                    </option>
                  ))}
                </select>
              )}
            </LabelledField>
            <LabelledField label={t('pwf.start.plannedStart.label')} testId="plannedStart" error={fieldError('plannedStart')} hint={t('pwf.start.plannedStart.hint')}>
              {({ id, invalid, describedBy }) => <input id={id} type="date" data-testid="planned-start" value={form.plannedStart} aria-invalid={invalid} aria-describedby={describedBy} onChange={(event) => edit({ plannedStart: event.target.value })} />}
            </LabelledField>
            {adopting ? (
              <LabelledField label={t('pwf.start.effective.label')} testId="effectiveDate" error={fieldError('effectiveDate')} hint={t('pwf.start.effective.hint')}>
                {({ id, invalid, describedBy }) => <input id={id} type="date" data-testid="effective-date" value={form.effectiveDate} aria-invalid={invalid} aria-describedby={describedBy} onChange={(event) => edit({ effectiveDate: event.target.value })} />}
              </LabelledField>
            ) : null}
          </div>
          {suggestion.data === undefined ? null : (
            <div className="pwf-suggestion" data-testid="suggestion">
              <p role="status" aria-live="polite">
                {suggested === null ? (
                  basisText(t, 'NONE', null)
                ) : (
                  <>
                    <strong>{t('pwf.process.kind.suggested.text', { code: suggested, name: suggestion.data.templates.find((one) => one.code === suggested)?.name ?? '' })}</strong> {basisText(t, suggestion.data.basis, suggestion.data.line)}{' '}
                    {t('pwf.process.kind.ruleVersion.text', { version: suggestion.data.rule.version })}
                  </>
                )}
              </p>
              {suggested !== null && form.templateCode !== suggested ? (
                <p>
                  <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="use-suggestion" onClick={() => edit({ templateCode: suggested })}>
                    {t('pwf.process.kind.useSuggested.action')}
                  </button>
                </p>
              ) : null}
              {overriding ? (
                <LabelledField label={t('pwf.process.kind.reason.label')} testId="selectionReason" error={attempted && reasonMissing ? t('pwf.process.problem.reasonRequired.text') : undefined} hint={t('pwf.process.kind.reason.hint', { code: suggested ?? '' })}>
                  {({ id, invalid, describedBy }) => <textarea id={id} rows={2} data-testid="selection-reason" value={reason} aria-invalid={invalid} aria-describedby={describedBy} onChange={(event) => setReason(event.target.value)} />}
                </LabelledField>
              ) : null}
            </div>
          )}
          {entry !== undefined && codes.length === 0 ? (
            <p className="callout warning" role="status" data-testid="no-template">
              {t('pwf.start.template.empty.notice')}
            </p>
          ) : null}
          {summary === undefined ? null : (
            <div data-testid="template-summary">
              <p>
                <strong>{summary.name}</strong>{' '}
                {rule.data?.unverified === true ? <UnverifiedLabel /> : <StatusPill tone="success">{t('pwf.start.template.confirmed.word')}</StatusPill>}
              </p>
              <dl className="pwf-facts">
                <dt>{t('pwf.start.template.projectType.label')}</dt>
                <dd>{summary.projectType ?? t('pwf.start.template.anyType.text')}</dd>
                <dt>{t('pwf.start.template.version.label')}</dt>
                <dd>{rule.data?.source === 'RULE' ? t('pwf.start.template.sourceRule.text', { version: rule.data.version }) : t('pwf.start.template.sourceDefault.text')}</dd>
                <dt>{t('pwf.start.template.phases.label')}</dt>
                <dd data-testid="template-phases">
                  <span className="pwf-figure">
                    {summary.phases}
                    <FigureInfo name={t('pwf.start.template.phases.label')} formula={t('pwf.start.template.count.formula')} source={t('pwf.start.template.count.source')} asOf={rule.data?.asOf} version={t('pwf.start.template.count.version', { code: form.templateCode })} unverified={rule.data?.unverified === true} />
                  </span>
                </dd>
                <dt>{t('pwf.start.template.tasks.label')}</dt>
                <dd data-testid="template-tasks">
                  <span className="pwf-figure">
                    {summary.tasks}
                    <FigureInfo name={t('pwf.start.template.tasks.label')} formula={t('pwf.start.template.count.formula')} source={t('pwf.start.template.count.source')} asOf={rule.data?.asOf} version={t('pwf.start.template.count.version', { code: form.templateCode })} unverified={rule.data?.unverified === true} />
                  </span>
                </dd>
              </dl>
            </div>
          )}

          <fieldset className="pwf-facts-set">
            <legend>{t('pwf.start.facts.legend')}</legend>
            <p className="pwf-hint">{t('pwf.start.facts.hint')}</p>
            <div className="pwf-filters">
              {FACT_FIELDS.map((field) => (
                <LabelledField key={field} label={factLabel(t, field)} testId={field} error={fieldError(field)}>
                  {({ id, invalid, describedBy }) => <input id={id} type="text" data-testid={`fact-${field}`} value={form.facts[field]} aria-invalid={invalid} aria-describedby={describedBy} onChange={(event) => edit({ facts: { ...form.facts, [field]: event.target.value } })} />}
                </LabelledField>
              ))}
            </div>
          </fieldset>

          {problem === undefined ? null : <ProblemBanner problem={problem} />}

          <div className="pwf-actions">
            {adopting ? (
              <button type="button" className="ui-button" data-testid="dry-run" disabled={dryRun.isPending} onClick={() => void runDry()}>
                {t('pwf.start.dryRun.action')}
              </button>
            ) : (
              <button type="button" className="ui-button" data-testid="submit-start" disabled={start.isPending} onClick={() => void submitStart()}>
                {t('pwf.start.submit.action')}
              </button>
            )}
            {canPreview && !adopting ? (
              <button type="button" className="ui-button ui-button--outline" data-testid="preview" disabled={preview.isPending || summary === undefined} onClick={runPreview}>
                {t('pwf.start.preview.action')}
              </button>
            ) : null}
          </div>
        </form>
      </SectionCard>

      {preview.data === undefined || adopting ? null : (
        <SectionCard title={t('pwf.start.preview.title')}>
          <div data-testid="preview-result">
            <dl className="pwf-facts">
              <dt>{t('pwf.start.result.projectStart.label')}</dt>
              <dd>{dayText(preview.data.project_start)}</dd>
              <dt>{t('pwf.start.result.projectFinish.label')}</dt>
              <dd>
                <span className="pwf-figure">
                  {dayText(preview.data.project_finish)}
                  <FigureInfo name={t('pwf.start.result.projectFinish.label')} formula={t('pwf.start.result.finish.formula')} source={t('pwf.start.result.finish.source')} asOf={preview.data.as_of} version={t('pwf.start.info.version.text', { hash: preview.data.result_hash.slice(0, 8) })} />
                </span>
              </dd>
              <dt>{t('pwf.start.preview.critical.label')}</dt>
              <dd>{preview.data.critical_path.length}</dd>
            </dl>
            <CalendarMissingNote years={missingYears(preview.data.tasks)} />
          </div>
        </SectionCard>
      )}
      {preview.error === null ? null : <ProblemBanner problem={describeProblem(preview.error)} />}

      {adopting && dry !== undefined && status !== undefined ? (
        <>
          <AdoptResultView result={dry.result} decisions={decisions} readiness={status} showErrors={attempted} onDecision={setDecision} />
          <div className="pwf-actions">
            <button type="button" className="ui-button" data-testid="apply" disabled={status !== 'ready' || apply.isPending} onClick={() => setConfirming(true)}>
              {t('pwf.start.apply.action')}
            </button>
          </div>
        </>
      ) : null}
      <ConfirmDialog
        open={confirming}
        title={t('pwf.start.apply.confirm.title')}
        context={[
          { label: t('pwf.start.apply.confirm.project'), value: `${project.code} · ${project.name}` },
          { label: t('pwf.start.effective.label'), value: dayText(form.effectiveDate) },
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
