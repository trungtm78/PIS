import { useTranslation } from '../../../i18n';
import { SectionCard, StatusPill } from '../../../ui';
import { UnverifiedLabel } from '../components';
import { dayText } from '../model';
import { basisText, choiceProblemText, factWord, fundingWord, groupWord } from './labels';
import { FUNDING_SOURCES, PROJECT_GROUPS, choiceProblems, effectiveTemplate, selectionMode } from './model';
import type { ChoiceForm, Suggestion } from './model';
import './process.css';

export interface ProcessKindSectionProps {
  form: ChoiceForm;
  onChange: (patch: Partial<ChoiceForm>) => void;
  /** What the rule answered for the form as it stands; undefined while the first answer is read. */
  suggestion: Suggestion | undefined;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  disabled: boolean;
  /** Whether the problems of the form are said (after the person asked to save). */
  showProblems: boolean;
  /** The sentence that says what happens when no planned start is given (the registration and the start of a workflow say it differently). */
  withoutStart: string;
}

/**
 * The kind of workflow of a project and its planned start (R47): the rule `PROJECT_WORKFLOW_ASSIGNMENT` suggests a template for the type, the group, the source of capital and the unit of the project; the person keeps it or picks
 * another one and says why. Before anything is saved the section shows what the choice gives: the finish day, the working days in total, the number of steps and the time of each step, or what stops them from being told.
 */
export function ProcessKindSection({ form, onChange, suggestion, loading, failed, onRetry, disabled, showProblems, withoutStart }: ProcessKindSectionProps) {
  const { t } = useTranslation();
  const mode = selectionMode(form, suggestion);
  const chosen = effectiveTemplate(form, suggestion);
  const template = suggestion?.templates.find((one) => one.code === chosen);
  const preview = suggestion?.preview ?? null;
  const problems = choiceProblems(form, suggestion);
  const needs = (field: 'project_group' | 'funding_source'): boolean => template === undefined || template.fact_fields.includes(field);
  const cannotStart = suggestion !== undefined && !suggestion.can_start;
  const locked = disabled || cannotStart;
  return (
    <SectionCard
      title={t('pwf.process.kind.section.title')}
      status={
        suggestion?.rule.unverified === true ? (
          <span data-testid="kind-unverified">
            <UnverifiedLabel />
          </span>
        ) : undefined
      }
    >
      <div data-testid="process-kind">
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
        <p className="pwf-suggestion" role="status" aria-live="polite" data-testid="kind-suggestion">
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
              <strong>{t('pwf.process.kind.suggested.text', { code: suggestion.suggested_template_code, name: suggestion.templates.find((one) => one.code === suggestion.suggested_template_code)?.name ?? '' })}</strong>{' '}
              {basisText(t, suggestion.basis, suggestion.line)} {t('pwf.process.kind.ruleVersion.text', { version: suggestion.rule.version })}
            </>
          )}
        </p>
        {suggestion !== undefined && suggestion.unknown_templates.length > 0 ? (
          <p className="callout warning pwf-notice" role="status" data-testid="kind-unknown">
            {t('pwf.process.kind.unknownTemplates.text', { codes: suggestion.unknown_templates.join(', ') })}
          </p>
        ) : null}
        <div className="pwf-filters">
          <div className="pwf-field">
            <label htmlFor="kind-template">{t('pwf.process.kind.template.label')}</label>
            <select id="kind-template" data-testid="kind-template" value={form.templateCode} disabled={locked} onChange={(event) => onChange({ templateCode: event.target.value })}>
              <option value="">{t('pwf.process.kind.template.auto')}</option>
              {(suggestion?.templates ?? []).map((one) => (
                <option key={one.code} value={one.code}>
                  {one.code} · {one.name}
                </option>
              ))}
            </select>
          </div>
          <div className="pwf-field">
            <label htmlFor="kind-start">{t('pwf.process.kind.start.label')}</label>
            <input id="kind-start" type="date" data-testid="kind-start" value={form.plannedStart} disabled={locked} onChange={(event) => onChange({ plannedStart: event.target.value })} />
            <span className="pwf-field__hint">{withoutStart}</span>
          </div>
          {needs('project_group') ? (
            <div className="pwf-field">
              <label htmlFor="kind-group">{factWord(t, 'project_group')}</label>
              <select id="kind-group" data-testid="kind-group" value={form.projectGroup} disabled={locked} onChange={(event) => onChange({ projectGroup: event.target.value })}>
                <option value="">{suggestion?.facts.project_group === undefined ? t('pwf.process.fact.unknown.option') : t('pwf.process.fact.known.option', { value: groupWord(t, suggestion.facts.project_group) })}</option>
                {PROJECT_GROUPS.map((group) => (
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
                {FUNDING_SOURCES.map((source) => (
                  <option key={source} value={source}>
                    {fundingWord(t, source)}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {mode === 'OVERRIDE' ? (
            <div className="pwf-field pwf-field--wide">
              <label htmlFor="kind-reason">{t('pwf.process.kind.reason.label')}</label>
              <textarea id="kind-reason" rows={2} data-testid="kind-reason" value={form.reason} disabled={locked} onChange={(event) => onChange({ reason: event.target.value })} aria-describedby="kind-reason-hint" />
              <span className="pwf-field__hint" id="kind-reason-hint">
                {t('pwf.process.kind.reason.hint', { code: suggestion?.suggested_template_code ?? '' })}
              </span>
            </div>
          ) : null}
        </div>
        {showProblems && problems.length > 0 ? (
          <div className="callout warning pwf-problem" role="alert" data-testid="kind-problems">
            <ul>
              {problems.map((problem) => (
                <li key={problem} data-problem={problem}>
                  {choiceProblemText(t, problem, (preview?.missing_facts ?? []).map((field) => factWord(t, field)).join(', '))}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {preview === null ? null : (
          <div className="pwf-preview" data-testid="kind-preview">
            <h3>{t('pwf.process.preview.title', { code: preview.template_code, version: preview.template_version })}</h3>
            {preview.missing_facts.length > 0 ? (
              <p className="callout warning pwf-notice" role="status" data-testid="preview-facts">
                {t('pwf.process.preview.missingFacts.text', { facts: preview.missing_facts.map((field) => factWord(t, field)).join(', ') })}
              </p>
            ) : (
              <>
                <dl className="pwf-facts" data-testid="preview-facts-list">
                  <dt>{t('pwf.process.preview.finish.label')}</dt>
                  <dd data-testid="preview-finish">{preview.project_finish === null ? t('pwf.process.preview.finish.unknown') : dayText(preview.project_finish)}</dd>
                  <dt>{t('pwf.process.preview.total.label')}</dt>
                  <dd data-testid="preview-total">{preview.total_working_days === null ? t('pwf.process.preview.finish.unknown') : t('pwf.process.preview.days.text', { days: preview.total_working_days })}</dd>
                  <dt>{t('pwf.process.preview.counts.label')}</dt>
                  <dd data-testid="preview-counts">{t('pwf.process.preview.counts.text', { phases: preview.phase_count, steps: preview.step_count, tasks: preview.task_count })}</dd>
                </dl>
                {preview.findings.some((finding) => finding.code === 'CALENDAR_UNAVAILABLE') ? (
                  <p className="callout warning pwf-notice" role="status" data-testid="preview-calendar">
                    {t('pwf.process.problem.calendarMissing.text')}
                  </p>
                ) : null}
                {preview.excluded_tasks.length > 0 ? <p className="pwf-hint">{t('pwf.process.preview.excluded.text', { count: preview.excluded_tasks.length })}</p> : null}
                <table className="pwf-steps-table">
                  <caption>{t('pwf.process.preview.steps.caption')}</caption>
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
                    {preview.steps.map((step) => (
                      <tr key={`${step.phase_code}/${step.code}`} data-step={step.code}>
                        <th scope="row">{step.name}</th>
                        <td>{step.task_count === 0 ? t('pwf.process.step.notApplicable.word') : dayText(step.start)}</td>
                        <td>{step.task_count === 0 ? '–' : dayText(step.finish)}</td>
                        <td className="pwf-num">{step.task_count === 0 ? '–' : step.duration_working_days}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        )}
        {template?.unverified === true ? (
          <p className="pwf-hint" data-testid="kind-template-unverified">
            <StatusPill tone="warning" icon="⚠">
              {t('pwf.process.kind.templateUnverified.word')}
            </StatusPill>{' '}
            {t('pwf.process.kind.templateUnverified.text')}
          </p>
        ) : null}
      </div>
    </SectionCard>
  );
}
