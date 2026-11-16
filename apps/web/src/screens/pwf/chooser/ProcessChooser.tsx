import type { ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import { SectionCard, StatusPill } from '../../../ui';
import { ScrollRegion } from '../../scroll-region';
import { NamedTip, factName, projectKindLabel, versionText } from '../codes';
import { FigureInfo, UnverifiedLabel } from '../components';
import { problemText } from '../labels';
import { dayText } from '../model';
import type { Problem } from '../model';
import { basisText, choiceProblemText, factWord, fundingWord, groupWord } from '../process/labels';
import { FUNDING_SOURCES, PROJECT_GROUPS, STEP_OF_PROBLEM, choiceProblems, effectiveTemplate, selectionMode, unresolvedUnits } from '../process/model';
import type { ChoiceForm, ChoiceProblem, Suggestion } from '../process/model';
import { unitsResolution } from './chooser-model';
import type { UnitChoice } from './unit-tree';
import './chooser.css';

export type ChooserStep = 1 | 2 | 3;
export type ChooserMode = 'register' | 'start' | 'adopt';
export interface TemplateOption {
  code: string;
  name: string;
  unverified: boolean;
}

export interface ProcessChooserProps {
  /** The registration of a project (PRJ-02, the day is optional), the start of the workflow of a project (PWF-05) or the adoption of a workflow of a project that is running (the second branch of PWF-05). */
  mode: ChooserMode;
  step: ChooserStep;
  onStep: (step: ChooserStep) => void;
  form: ChoiceForm;
  onChange: (patch: Partial<ChoiceForm>) => void;
  /** What the rule answered for the form as it stands; undefined while the first answer is read. */
  suggestion: Suggestion | undefined;
  /** Whether `suggestion` answers what the form holds NOW (false while a newer question is being read, or after it failed): the problems are judged on a current answer only. */
  current?: boolean;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  /** The templates to pick from when the answer of the rule carries none (the rule store catalogue). */
  fallbackTemplates?: readonly TemplateOption[];
  /** The kinds of project to offer as a fact of the branch, when the screen holds one (PWF-05); the registration says it elsewhere. */
  projectTypes?: readonly { value: string; label: string }[];
  /** The units of the tenant as a tree, to choose the ones the project cannot name; `unitsFailed` says the list could not be read. */
  units: readonly UnitChoice[];
  unitsFailed?: boolean;
  disabled: boolean;
  /** Whether the problems of the form are said (after the person asked to go on). */
  showProblems: boolean;
  /** The sentence that says what happens when no planned start is given (the registration and the start of a workflow say it differently). */
  withoutStart: string;
  /** What the server refused at the last confirmation (a unit, a fact, a template): the refusal of a unit is said at the cell of that unit. */
  refusal?: Problem | undefined;
  /** Extra content of the last step: the dry run of an adoption. */
  adoption?: ReactNode;
  /** The button that confirms, at the end of the last step (the registration confirms with its own button). */
  confirm?: ReactNode;
}

const STEPS: readonly ChooserStep[] = [1, 2, 3];

function stepWord(t: Translator['t'], step: ChooserStep): string {
  switch (step) {
    case 1:
      return t('pwfp.choose.step.process.word');
    case 2:
      return t('pwfp.choose.step.units.word');
    case 3:
      return t('pwfp.choose.step.confirm.word');
  }
}

/** What a reference to a unit of the template stands for, in words: the owner of the file, the investor, the authority that decides, a party the template names, or a unit named outright. */
export function unitRefWord(t: Translator['t'], ref: string, partyName: string | null, unitName: string | null): string {
  if (partyName !== null) return partyName;
  if (ref === 'PROJECT_OWNER') return t('pwfp.choose.ref.owner.word');
  if (ref === 'PROJECT_PARTY:INVESTOR') return t('pwfp.choose.ref.investor.word');
  if (ref === 'PROJECT_PARTY:DECISION_AUTHORITY') return t('pwfp.choose.ref.authority.word');
  if (ref.startsWith('UNIT:')) return unitName ?? t('pwfp.choose.ref.unit.word');
  return ref.replace('PROJECT_PARTY:', '');
}

function sourceWord(t: Translator['t'], source: 'PROJECT' | 'TEMPLATE' | 'CHOSEN' | 'NONE'): string {
  switch (source) {
    case 'PROJECT':
      return t('pwfp.choose.source.project.text');
    case 'TEMPLATE':
      return t('pwfp.choose.source.template.text');
    case 'CHOSEN':
      return t('pwfp.choose.source.chosen.text');
    case 'NONE':
      return t('pwfp.choose.source.none.text');
  }
}

/**
 * "Chọn quy trình": the one component that picks the process of a project, shared by the registration (PRJ-02) and the start or adoption of a workflow (PWF-05, R65). Three short steps: (1) the process, as the rule suggests it for the
 * kind, group and source of capital of the project, which the person keeps or replaces and says why; (2) the planned start and, for each unit the template names, what it stands for in this project: one the project cannot name is chosen
 * from the unit tree of the tenant, never guessed (R61); (3) the schedule the choice gives, and the confirmation. It keeps nothing of its own but the words: the form, the answer of the rule and the step are the caller's.
 */
export function ProcessChooser({
  mode,
  step,
  onStep,
  form,
  onChange,
  suggestion,
  current = true,
  loading,
  failed,
  onRetry,
  fallbackTemplates = [],
  projectTypes,
  units,
  unitsFailed = false,
  disabled,
  showProblems,
  withoutStart,
  refusal,
  adoption,
  confirm,
}: ProcessChooserProps) {
  const { t } = useTranslation();
  const selection = selectionMode(form, suggestion);
  const chosen = effectiveTemplate(form, suggestion);
  const templates: readonly TemplateOption[] = suggestion !== undefined && suggestion.templates.length > 0 ? suggestion.templates.map((one) => ({ code: one.code, name: one.name, unverified: one.unverified })) : fallbackTemplates;
  const template = suggestion?.templates.find((one) => one.code === chosen);
  const preview = suggestion?.preview ?? null;
  const cannotStart = suggestion !== undefined && !suggestion.can_start;
  const locked = disabled || cannotStart;
  const required = mode !== 'register';
  const problems: ChoiceProblem[] = cannotStart ? [] : choiceProblems(form, current ? suggestion : undefined, { required, adopting: mode === 'adopt' });
  const needs = (field: 'project_group' | 'funding_source'): boolean => template === undefined || template.fact_fields.includes(field);
  const missingFacts = (preview?.missing_facts ?? []).map((field) => factWord(t, field)).join(', ');
  const resolution = unitsResolution(suggestion, form.units);
  const stepProblems = (which: 1 | 2): ChoiceProblem[] => problems.filter((one) => STEP_OF_PROBLEM[one] === which);
  const problemList = (which: 1 | 2): ReactNode =>
    showProblems && stepProblems(which).length > 0 ? (
      <div className="callout warning pwf-problem" role="alert" data-testid="kind-problems" data-step={which}>
        <ul>
          {stepProblems(which).map((problem) => (
            <li key={problem} data-problem={problem}>
              {choiceProblemText(t, problem, missingFacts, resolution.missing.join(', '))}
            </li>
          ))}
        </ul>
      </div>
    ) : null;
  const touched = (which: 1 | 2): boolean => showProblems && stepProblems(which).length > 0;
  const suggestedName = suggestion?.templates.find((one) => one.code === suggestion.suggested_template_code)?.name ?? (suggestion?.suggested_template_code == null ? '' : projectKindLabel(t, suggestion.suggested_template_code));

  return (
    <SectionCard
      title={t('pwfp.choose.title')}
      status={
        suggestion?.rule.unverified === true ? (
          <span data-testid="kind-unverified">
            <UnverifiedLabel />
          </span>
        ) : undefined
      }
    >
      <div data-testid="process-kind" data-mode={mode} data-step={step}>
        <ol className="pwfc-steps" aria-label={t('pwfp.choose.steps.label')}>
          {STEPS.map((one) => (
            <li key={one} data-done={one < step} data-bad={one < 3 && touched(one as 1 | 2)}>
              <button type="button" className="pwfc-steps__button" data-step={one} aria-current={one === step ? 'step' : undefined} onClick={() => onStep(one)}>
                <span className="pwfc-steps__number" aria-hidden="true">
                  {one}
                </span>
                {stepWord(t, one)}
              </button>
            </li>
          ))}
        </ol>
        {failed ? (
          <p className="callout warning pwf-notice" role="alert" data-testid="kind-failed">
            {t('pwf.process.kind.failed.text')}{' '}
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onRetry}>
              {t('ui.common.retry')}
            </button>
          </p>
        ) : null}
        {cannotStart ? (
          <p className="callout warning pwf-notice" role="status" data-testid="kind-denied">
            {t('pwf.process.kind.denied.text')}
          </p>
        ) : null}

        {step === 1 ? (
          <div className="pwfc-panel" data-testid="chooser-step-1">
            {problemList(1)}
            <div className="pwf-suggestion" role="status" aria-live="polite" data-testid="kind-suggestion" data-suggested={suggestion?.suggested_template_code ?? undefined}>
              {suggestion === undefined ? (
                loading ? (
                  t('pwf.process.kind.loading.text')
                ) : (
                  t('pwf.process.kind.waiting.text')
                )
              ) : suggestion.suggested_template_code === null ? (
                basisText(t, 'NONE', null)
              ) : (
                <>
                  <span className="pwf-suggestion__label">{t('pwf6.kind.suggested.label')}</span>
                  <strong className="pwf-suggestion__name">
                    <NamedTip name={suggestedName} code={suggestion.suggested_template_code} />
                  </strong>
                  <dl className="pwf-suggestion__why">
                    <dt>{t('pwf6.kind.reason.label')}</dt>
                    <dd>{basisText(t, suggestion.basis, suggestion.line)}</dd>
                    <dt>{t('pwf6.kind.rule.label')}</dt>
                    <dd>{versionText(t, suggestion.rule.version)}</dd>
                  </dl>
                  {form.templateCode !== '' && form.templateCode !== suggestion.suggested_template_code ? (
                    <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="use-suggestion" disabled={locked} onClick={() => onChange({ templateCode: suggestion.suggested_template_code ?? '' })}>
                      {t('pwf.process.kind.useSuggested.action')}
                    </button>
                  ) : null}
                </>
              )}
            </div>
            {suggestion !== undefined && suggestion.unknown_templates.length > 0 ? (
              <p className="callout warning pwf-notice" role="status" data-testid="kind-unknown">
                {t('pwf.process.kind.unknownTemplates.text', { codes: suggestion.unknown_templates.join(', ') })}
              </p>
            ) : null}
            <div className="pwf-filters pwf-kind__fields">
              <div className="pwf-field">
                <label htmlFor="kind-template">{t('pwf.process.kind.template.label')}</label>
                <select id="kind-template" data-testid="kind-template" value={form.templateCode} disabled={locked} aria-invalid={touched(1) && problems.includes('templateRequired') ? true : undefined} onChange={(event) => onChange({ templateCode: event.target.value })}>
                  <option value="">{suggestion?.suggested_template_code === undefined || suggestion?.suggested_template_code === null ? t('pwfp.choose.template.choose.option') : t('pwf.process.kind.template.auto')}</option>
                  {templates.map((one) => (
                    <option key={one.code} value={one.code}>
                      {one.unverified ? t('pwf.start.template.unverifiedOption.text', { code: one.name }) : one.name}
                    </option>
                  ))}
                </select>
              </div>
              {needs('project_group') ? (
                <div className="pwf-field">
                  <label htmlFor="kind-group">{factWord(t, 'project_group')}</label>
                  <select id="kind-group" data-testid="kind-group" value={form.projectGroup} disabled={locked} onChange={(event) => onChange({ projectGroup: event.target.value })}>
                    <option value="">{suggestion?.facts.project_group === undefined ? t('pwf.process.fact.unknown.option') : t('pwf.process.fact.known.option', { value: groupWord(t, suggestion.facts.project_group) })}</option>
                    {[...new Set([...PROJECT_GROUPS, form.projectGroup].filter((value) => value !== ''))].map((group) => (
                      <option key={group} value={group}>
                        {groupWord(t, group)}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              {needs('funding_source') ? (
                <div className="pwf-field">
                  <label htmlFor="kind-funding">{factWord(t, 'funding_source')}</label>
                  <select id="kind-funding" data-testid="kind-funding" value={form.fundingSource} disabled={locked} onChange={(event) => onChange({ fundingSource: event.target.value })}>
                    <option value="">{t('pwf.process.fact.unknown.option')}</option>
                    {[...new Set([...FUNDING_SOURCES, form.fundingSource].filter((value) => value !== ''))].map((source) => (
                      <option key={source} value={source}>
                        {fundingWord(t, source)}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              {projectTypes === undefined ? null : (
                <div className="pwf-field">
                  <label htmlFor="kind-type">{factWord(t, 'project_type')}</label>
                  <select id="kind-type" data-testid="kind-type" value={form.projectType} disabled={locked} onChange={(event) => onChange({ projectType: event.target.value })}>
                    <option value="">{t('pwf.process.fact.unknown.option')}</option>
                    {projectTypes.map((one) => (
                      <option key={one.value} value={one.value}>
                        {one.label === '' ? factName(t, one.value) : one.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {selection === 'OVERRIDE' ? (
                <div className="pwf-field pwf-field--wide">
                  <label htmlFor="kind-reason">{t('pwf.process.kind.reason.label')}</label>
                  <textarea id="kind-reason" rows={2} data-testid="kind-reason" value={form.reason} disabled={locked} aria-invalid={touched(1) && problems.includes('reasonRequired') ? true : undefined} onChange={(event) => onChange({ reason: event.target.value })} aria-describedby="kind-reason-hint" />
                  <span className="pwf-field__hint" id="kind-reason-hint">
                    {t('pwf.process.kind.reason.hint', { code: suggestedName })}
                  </span>
                </div>
              ) : null}
            </div>
            {template === undefined ? null : (
              <div data-testid="template-summary" className="pwfc-summary">
                <p>
                  <strong>{template.name}</strong> {template.unverified ? <UnverifiedLabel /> : <StatusPill tone="success">{t('pwf.start.template.confirmed.word')}</StatusPill>}
                </p>
                <p className="pwf-hint" data-testid="template-counts">
                  <span className="pwf-figure">
                    {t('pwf.process.preview.counts.text', { phases: template.phase_count, steps: template.step_count, tasks: template.task_count })}
                    <FigureInfo name={t('pwf.start.template.phases.label')} formula={t('pwf.start.template.count.formula')} source={t('pwf.start.template.count.source')} asOf={suggestion?.as_of} version={t('pwf.start.template.count.version', { code: template.code })} unverified={template.unverified} />
                  </span>
                </p>
                {template.unverified ? (
                  <p className="pwf-hint" data-testid="kind-template-unverified">
                    {t('pwf.process.kind.templateUnverified.text')}
                  </p>
                ) : null}
              </div>
            )}
          </div>
        ) : null}

        {step === 2 ? (
          <div className="pwfc-panel" data-testid="chooser-step-2">
            {problemList(2)}
            <div className="pwf-filters pwf-kind__fields">
              <div className="pwf-field">
                <label htmlFor="kind-start">{t('pwf.process.kind.start.label')}</label>
                <input id="kind-start" type="date" data-testid="kind-start" value={form.plannedStart} disabled={locked} aria-invalid={touched(2) && (problems.includes('startRequired') || problems.includes('startInvalid')) ? true : undefined} onChange={(event) => onChange({ plannedStart: event.target.value })} />
                <span className="pwf-field__hint">{withoutStart}</span>
              </div>
              {mode === 'adopt' ? (
                <div className="pwf-field">
                  <label htmlFor="kind-effective">{t('pwf.start.effective.label')}</label>
                  <input id="kind-effective" type="date" data-testid="effective-date" value={form.effectiveDate} disabled={locked} aria-invalid={touched(2) && (problems.includes('effectiveRequired') || problems.includes('effectiveInvalid')) ? true : undefined} onChange={(event) => onChange({ effectiveDate: event.target.value })} />
                  <span className="pwf-field__hint">{t('pwf.start.effective.hint')}</span>
                </div>
              ) : null}
            </div>
            <h3 className="pwfc-subtitle">{t('pwfp.choose.units.title')}</h3>
            {preview === null || preview.units === undefined ? (
              <p className="pwf-hint" data-testid="units-waiting">
                {form.plannedStart.trim() === '' ? t('pwfp.choose.units.needStart.text') : t('pwfp.choose.units.none.text')}
              </p>
            ) : preview.units.refs.length === 0 ? (
              <p className="pwf-hint" data-testid="units-none">
                {t('pwfp.choose.units.noRefs.text')}
              </p>
            ) : (
              <>
                <p className="pwf-hint">{t('pwfp.choose.units.hint')}</p>
                {resolution.unresolved.length > 0 && unitsFailed ? (
                  <p className="callout warning pwf-notice" role="alert" data-testid="units-failed">
                    {t('pwfp.choose.units.failed.text')}
                  </p>
                ) : null}
                <ScrollRegion label={t('pwfp.choose.units.caption')}>
                  <table className="pwfc-units" data-testid="units">
                    <caption className="ui-sr-only">{t('pwfp.choose.units.caption')}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{t('pwfp.choose.units.col.ref')}</th>
                        <th scope="col">{t('pwfp.choose.units.col.unit')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.units.refs.map((row) => {
                        const label = unitRefWord(t, row.unit_ref, row.party_name, row.unit_name);
                        const open = unresolvedUnits(suggestion).includes(row.unit_ref);
                        const unknown = (preview.units?.unknown ?? []).includes(row.unit_ref);
                        const refused = refusal?.unitRefs?.includes(row.unit_ref) === true ? refusal : undefined;
                        const missing = showProblems && open && (form.units[row.unit_ref] ?? '') === '';
                        const id = `unit-${row.unit_ref.replace(/[^A-Za-z0-9]/g, '-')}`;
                        return (
                          <tr key={row.unit_ref} data-ref={row.unit_ref} data-open={open} data-unknown={unknown}>
                            <th scope="row">
                              <label htmlFor={open ? id : undefined}>{label}</label>
                              <span className="pwf-code">{row.unit_ref}</span>
                            </th>
                            <td>
                              {open ? (
                                <>
                                  <select id={id} data-testid={id} value={form.units[row.unit_ref] ?? ''} disabled={locked} aria-invalid={missing || refused !== undefined ? true : undefined} aria-describedby={refused === undefined ? undefined : `${id}-error`} onChange={(event) => onChange({ units: { ...form.units, [row.unit_ref]: event.target.value } })}>
                                    <option value="">{t('pwfp.choose.units.choose.option')}</option>
                                    {units.map((one) => (
                                      <option key={one.id} value={one.id}>
                                        {`${'– '.repeat(one.depth)}${one.code === '' ? '' : `${one.code} · `}${one.name}`}
                                      </option>
                                    ))}
                                  </select>
                                  <span className="pwf-hint">{sourceWord(t, 'NONE')}</span>
                                </>
                              ) : (
                                <span data-testid={`resolved-${row.unit_ref}`}>
                                  {row.unit_name ?? '–'} <span className="pwf-hint">{sourceWord(t, row.source)}</span>
                                  {unknown ? <span className="pwf-field__error">{t('pwfp.choose.units.unknown.text')}</span> : null}
                                </span>
                              )}
                              {refused === undefined ? null : (
                                <span id={`${id}-error`} className="pwf-field__error" role="alert" data-testid={`unit-error-${row.unit_ref}`}>
                                  {problemText(t, refused)}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </ScrollRegion>
              </>
            )}
          </div>
        ) : null}

        {step === 3 ? (
          <div className="pwfc-panel" data-testid="chooser-step-3">
            {problems.length > 0 && showProblems ? (
              <div className="callout warning pwf-problem" role="alert" data-testid="kind-problems" data-step={3}>
                <ul>
                  {problems.map((problem) => (
                    <li key={problem} data-problem={problem}>
                      {choiceProblemText(t, problem, missingFacts, resolution.missing.join(', '))}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {preview === null ? (
              <p className="pwf-hint" data-testid="kind-preview-none">
                {t('pwfp.choose.preview.none.text')}
              </p>
            ) : (
              <div className="pwf-preview" data-testid="kind-preview">
                <h3>
                  {t('pwf6.kind.preview.title', { name: suggestion?.templates.find((one) => one.code === preview.template_code)?.name ?? preview.template_code })} <span className="pwf-code">{versionText(t, preview.template_version)}</span>
                </h3>
                {preview.missing_facts.length > 0 ? (
                  <p className="callout warning pwf-notice" role="status" data-testid="preview-facts">
                    {t('pwf.process.preview.missingFacts.text', { facts: missingFacts })}
                  </p>
                ) : (
                  <>
                    <dl className="pwf-stats pwf-preview__stats" data-testid="preview-facts-list">
                      <div className="pwf-stats__item">
                        <dt>{t('pwf.process.preview.finish.label')}</dt>
                        <dd data-testid="preview-finish">{preview.project_finish === null ? t('pwf.process.preview.finish.unknown') : dayText(preview.project_finish)}</dd>
                      </div>
                      <div className="pwf-stats__item">
                        <dt>{t('pwf.process.preview.total.label')}</dt>
                        <dd data-testid="preview-total">{preview.total_working_days === null ? t('pwf.process.preview.finish.unknown') : t('pwf.process.preview.days.text', { days: preview.total_working_days })}</dd>
                      </div>
                      <div className="pwf-stats__item">
                        <dt>{t('pwf6.kind.steps.label')}</dt>
                        <dd data-testid="preview-steps">{t('pwf6.kind.steps.text', { steps: preview.step_count })}</dd>
                      </div>
                      <div className="pwf-stats__item">
                        <dt>{t('pwf.process.preview.counts.label')}</dt>
                        <dd data-testid="preview-counts">{t('pwf.process.preview.counts.text', { phases: preview.phase_count, steps: preview.step_count, tasks: preview.task_count })}</dd>
                      </div>
                    </dl>
                    {preview.findings.some((finding) => finding.code === 'CALENDAR_UNAVAILABLE') ? (
                      <p className="callout warning pwf-notice" role="status" data-testid="preview-calendar">
                        {t('pwf.process.problem.calendarMissing.text')}
                      </p>
                    ) : null}
                    {preview.excluded_tasks.length > 0 ? <p className="pwf-hint">{t('pwf.process.preview.excluded.text', { count: preview.excluded_tasks.length })}</p> : null}
                    <ScrollRegion label={t('pwf.process.preview.steps.caption')}>
                      <table className="pwf-steps-table">
                        <caption className="ui-sr-only">{t('pwf.process.preview.steps.caption')}</caption>
                        <thead>
                          <tr>
                            <th scope="col">{t('pwf.process.preview.col.step')}</th>
                            <th scope="col">{t('pwf.process.preview.col.start')}</th>
                            <th scope="col">{t('pwf.process.preview.col.finish')}</th>
                            <th scope="col" className="pwf-num">
                              {t('pwf.process.preview.col.days')}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {preview.steps.map((one) => (
                            <tr key={`${one.phase_code}/${one.code}`} data-step={one.code}>
                              <th scope="row">{one.name}</th>
                              <td>{one.task_count === 0 ? t('pwf.process.step.notApplicable.word') : dayText(one.start)}</td>
                              <td>{one.task_count === 0 ? '' : dayText(one.finish)}</td>
                              <td className="pwf-num">{one.task_count === 0 ? '' : one.duration_working_days}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </ScrollRegion>
                  </>
                )}
              </div>
            )}
            {adoption}
            {confirm === undefined ? null : <div className="pwf-actions pwfc-confirm">{confirm}</div>}
          </div>
        ) : null}

        <div className="pwfc-nav">
          <button type="button" className="ui-button ui-button--outline" data-action="chooser-back" disabled={step === 1} onClick={() => onStep((step - 1) as ChooserStep)}>
            {t('pwfp.choose.back.action')}
          </button>
          <button type="button" className="ui-button ui-button--outline" data-action="chooser-next" disabled={step === 3} onClick={() => onStep((step + 1) as ChooserStep)}>
            {t('pwfp.choose.next.action')}
          </button>
        </div>
      </div>
    </SectionCard>
  );
}
