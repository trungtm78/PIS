import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import { DataTable, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { CalendarMissingCell, CalendarMissingNote, FigureInfo, ProblemBanner } from '../components';
import { describeProblem, dayProblem, dayText, missingYears, todayInVietnam } from '../model';
import type { ProjectFacts, SchedulePreview, ScheduleTask, TemplateValidation } from '../model';
import { formProblemText } from '../labels';
import { factName } from '../codes';
import { FUNDING_SOURCES, PROJECT_GROUPS } from '../process/model';
import { problemWord } from './editor-fields';
import type { PreviewInput } from './hooks';
import type { Template, TemplateProblem } from './template-model';

type T = Translator['t'];

function qualityWord(t: T, code: string): string {
  switch (code) {
    case 'MISSING_PREDECESSOR':
      return t('pwf.templates.quality.missingPredecessor.word');
    case 'MISSING_SUCCESSOR':
      return t('pwf.templates.quality.missingSuccessor.word');
    case 'LEAD':
      return t('pwf.templates.quality.lead.word');
    case 'HARD_CONSTRAINT':
      return t('pwf.templates.quality.hardConstraint.word');
    case 'LONG_TASK':
      return t('pwf.templates.quality.longTask.word');
    case 'NEGATIVE_FLOAT':
      return t('pwf.templates.quality.negativeFloat.word');
    default:
      return code;
  }
}

function scheduleFindingWord(t: T, code: string): string {
  switch (code) {
    case 'CONSTRAINT_CONFLICT':
      return t('pwf.templates.finding.constraintConflict.word');
    case 'CONSTRAINT_VIOLATED':
      return t('pwf.templates.finding.constraintViolated.word');
    case 'ACTUAL_DATES_MISSING':
      return t('pwf.templates.finding.actualDatesMissing.word');
    case 'CALENDAR_UNAVAILABLE':
      return t('pwf.templates.finding.calendarUnavailable.word');
    default:
      return code;
  }
}

export interface ValidationPanelProps {
  /** What the checks of the editor itself found, shown once the person tried to validate or save. */
  local: readonly TemplateProblem[];
  attempted: boolean;
  result: TemplateValidation | undefined;
  /** The result is for the text the editor holds now. */
  current: boolean;
  pending: boolean;
  error: unknown;
  canRun: boolean;
  onRun: () => void;
}

/** The checks of the server on the template (errors by path, and the schedule-quality flags that never block), next to the checks the editor makes itself. */
export function ValidationPanel({ local, attempted, result, current, pending, error, canRun, onRun }: ValidationPanelProps) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('pwf.templates.validate.title')}>
      <p className="pwf-actions">
        <button type="button" className="ui-button ui-button--outline" disabled={!canRun || pending} data-action="validate" onClick={onRun}>
          {pending ? t('pwf.templates.validate.running.text') : t('pwf.templates.validate.run.action')}
        </button>
        <span className="adm-kit-sub">{t('pwf.templates.validate.hint')}</span>
      </p>
      {attempted && local.length > 0 ? (
        <div className="callout danger" role="alert" data-testid="local-problems">
          <p>{t('pwf.templates.validate.local.text', { count: local.length })}</p>
          <ul>
            {local.map((problem) => (
              <li key={`${problem.path}:${problem.problem}`}>
                <code>{problem.path}</code>: {problemWord(t, problem.problem)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {error === undefined || error === null ? null : <ProblemBanner problem={describeProblem(error)} />}
      {result === undefined ? (
        <p className="callout" role="status" data-testid="validate-none">
          {t('pwf.templates.validate.none.text')}
        </p>
      ) : (
        <div data-testid="validation" data-current={current}>
          {current ? null : (
            <p className="callout warning" role="status" data-testid="validate-stale">
              <span aria-hidden="true">⚠ </span>
              {t('pwf.templates.validate.stale.text')}
            </p>
          )}
          <p>
            {result.valid ? (
              <StatusPill tone="success" icon="✔">
                {t('pwf.templates.validate.valid.word')}
              </StatusPill>
            ) : (
              <StatusPill tone="danger" icon="⛔">
                {t('pwf.templates.validate.invalid.word')}
              </StatusPill>
            )}
          </p>
          <dl className="pwf-facts" data-testid="validation-counts">
            {([
              ['tasks', result.task_count],
              ['phases', result.phase_count],
              ['chain', result.longest_chain],
            ] as const).map(([name, value]) => (
              <Count key={name} name={name} value={value} asOf={result.as_of} />
            ))}
          </dl>
          {result.findings.length === 0 ? null : (
            <ul className="pwf-tpl-findings" data-testid="findings">
              {result.findings.map((finding, index) => (
                <li key={`${finding.path}:${finding.code}:${index}`} data-severity={finding.severity}>
                  <StatusPill tone={finding.severity === 'ERROR' ? 'danger' : 'warning'} icon={finding.severity === 'ERROR' ? '⛔' : '⚠'}>
                    {finding.severity === 'ERROR' ? t('pwf.templates.finding.error.word') : t('pwf.templates.finding.warning.word')}
                  </StatusPill>{' '}
                  <code>{finding.path}</code> · {finding.code}
                  {finding.detail === undefined || finding.detail === null ? null : <span className="adm-kit-sub"> · {finding.detail}</span>}
                </li>
              ))}
            </ul>
          )}
          <h3>{t('pwf.templates.quality.title')}</h3>
          <p className="adm-kit-sub">{t('pwf.templates.quality.hint')}</p>
          {result.quality_flags.length === 0 ? (
            <p data-testid="quality-none">{t('pwf.templates.quality.none.text')}</p>
          ) : (
            <ul className="pwf-tpl-findings" data-testid="quality">
              {result.quality_flags.map((flag, index) => (
                <li key={`${flag.code}:${flag.task ?? ''}:${index}`}>
                  <StatusPill tone="warning" icon="⚠">
                    {qualityWord(t, flag.code)}
                  </StatusPill>
                  {flag.task === undefined || flag.task === null ? null : <span> · <code>{flag.task}</code></span>}
                  {flag.detail === undefined || flag.detail === null ? null : <span className="adm-kit-sub"> · {flag.detail}</span>}
                </li>
              ))}
            </ul>
          )}
          {result.template_hash === null ? null : (
            <p className="adm-kit-sub" data-testid="template-hash">
              {t('pwf.templates.validate.hash.text', { hash: result.template_hash.slice(0, 12) })}
            </p>
          )}
        </div>
      )}
    </SectionCard>
  );
}

function Count({ name, value, asOf }: { name: 'tasks' | 'phases' | 'chain'; value: number; asOf: string }) {
  const { t } = useTranslation();
  const label = name === 'tasks' ? t('pwf.templates.validate.tasks.label') : name === 'phases' ? t('pwf.templates.validate.phases.label') : t('pwf.templates.validate.chain.label');
  const formula = name === 'tasks' ? t('pwf.templates.validate.tasks.formula') : name === 'phases' ? t('pwf.templates.validate.phases.formula') : t('pwf.templates.validate.chain.formula');
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <span className="pwf-figure">
          <span data-testid={`count-${name}`}>{value}</span>
          <FigureInfo name={label} formula={formula} source={t('pwf.templates.validate.source')} asOf={asOf} version={t('pwf.templates.validate.version')} />
        </span>
      </dd>
    </>
  );
}

// ---- the schedule preview --------------------------------------------------------------------------------------------------------------------------------------------

export interface PreviewPanelProps {
  template: Template;
  canRun: boolean;
  pending: boolean;
  error: unknown;
  result: SchedulePreview | undefined;
  current: boolean;
  onRun: (input: PreviewInput) => void;
}

const FACTS: readonly (keyof ProjectFacts)[] = ['project_group', 'funding_source', 'project_type'];

/** The values a fact of the preview is chosen from: the groups and sources of capital the law and the shipped templates name, the type of project the template is for, and every value a branch of this template tests. */
export function factChoices(template: Template, name: keyof ProjectFacts, current: string): string[] {
  const known: readonly string[] = name === 'project_group' ? PROJECT_GROUPS : name === 'funding_source' ? FUNDING_SOURCES : template.project_type === null ? [] : [template.project_type];
  const tested = template.tasks.flatMap((task) => task.when.filter((condition) => condition.field === name).flatMap((condition) => condition.in));
  return [...new Set([...known, ...tested, current].filter((value) => value !== ''))];
}

/** The schedule of the template on a start day and the facts of a project: dates, float and the critical path; a year with no calendar is said, never guessed. */
export function PreviewPanel({ template, canRun, pending, error, result, current, onRun }: PreviewPanelProps) {
  const { t } = useTranslation();
  const [start, setStart] = useState(() => todayInVietnam());
  const [facts, setFacts] = useState<Record<keyof ProjectFacts, string>>({ project_group: '', funding_source: '', project_type: '' });
  const [attempted, setAttempted] = useState(false);
  const startProblem = dayProblem(start);
  const run = (): void => {
    setAttempted(true);
    if (startProblem !== undefined) return;
    onRun({ template, plannedStartDate: start.trim(), facts: Object.fromEntries(FACTS.flatMap((name) => (facts[name].trim() === '' ? [] : [[name, facts[name].trim()]]))) as PreviewInput['facts'] });
  };
  const factLabel = (name: keyof ProjectFacts): string => (name === 'project_group' ? t('pwf.templates.condition.projectGroup.word') : name === 'funding_source' ? t('pwf.templates.condition.fundingSource.word') : t('pwf.templates.condition.projectType.word'));
  return (
    <SectionCard title={t('pwf.templates.preview.title')}>
      <div className="pwf-filters">
        <div className="pwf-field">
          <label htmlFor="pwf-preview-start">{t('pwf.templates.preview.start.label')}</label>
          <input id="pwf-preview-start" type="date" value={start} disabled={!canRun} aria-invalid={attempted && startProblem !== undefined} data-testid="preview-start" onChange={(event) => setStart(event.target.value)} />
          {attempted && startProblem !== undefined ? <span className="pwf-field__error">{formProblemText(t, startProblem)}</span> : null}
        </div>
        {FACTS.map((name) => (
          <div key={name} className="pwf-field">
            <label htmlFor={`pwf-preview-${name}`}>{factLabel(name)}</label>
            <select id={`pwf-preview-${name}`} value={facts[name]} disabled={!canRun} data-testid={`field-preview.${name}`} onChange={(event) => setFacts({ ...facts, [name]: event.target.value })}>
              <option value="">{t('pwf6.start.fact.none')}</option>
              {factChoices(template, name, facts[name]).map((value) => (
                <option key={value} value={value}>
                  {factName(t, value)}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
      <p className="pwf-actions">
        <button type="button" className="ui-button ui-button--outline" disabled={!canRun || pending} data-action="preview" onClick={run}>
          {pending ? t('pwf.templates.preview.running.text') : t('pwf.templates.preview.run.action')}
        </button>
        <span className="adm-kit-sub">{t('pwf.templates.preview.hint')}</span>
      </p>
      {error === undefined || error === null ? null : <ProblemBanner problem={describeProblem(error)} />}
      {result === undefined ? (
        <p className="callout" role="status" data-testid="preview-none">
          {t('pwf.templates.preview.none.text')}
        </p>
      ) : (
        <PreviewResult result={result} current={current} />
      )}
    </SectionCard>
  );
}

function PreviewResult({ result, current }: { result: SchedulePreview; current: boolean }) {
  const { t } = useTranslation();
  const years = missingYears(result.tasks);
  const info = (name: string, formula: string) => <FigureInfo name={name} formula={formula} source={t('pwf.templates.preview.source')} asOf={result.as_of} version={t('pwf.templates.preview.version', { versions: result.calendar_versions.map((one) => `${one.year}: v${one.version}`).join(', ') })} />;
  const columns: DataTableColumn<ScheduleTask>[] = [
    {
      key: 'task',
      header: t('pwf.templates.preview.col.task'),
      render: (row) => (
        <>
          <code>{row.task_code}</code> {row.name}
        </>
      ),
    },
    { key: 'start', header: t('pwf.templates.preview.col.start'), render: (row) => (row.state === 'CALENDAR_UNAVAILABLE' ? <CalendarMissingCell year={row.missing_year} /> : dayText(row.start)) },
    { key: 'finish', header: t('pwf.templates.preview.col.finish'), render: (row) => (row.state === 'CALENDAR_UNAVAILABLE' ? <CalendarMissingCell year={row.missing_year} /> : dayText(row.finish)) },
    {
      key: 'float',
      header: t('pwf.templates.preview.col.float'),
      render: (row) => (row.total_float === null ? '–' : t('pwf.templates.preview.float.text', { total: row.total_float, free: row.free_float ?? 0 })),
    },
    {
      key: 'critical',
      header: t('pwf.templates.preview.col.critical'),
      render: (row) =>
        row.critical ? (
          <StatusPill tone="danger" icon="⚑">
            {t('pwf.templates.preview.critical.word')}
          </StatusPill>
        ) : (
          t('pwf.templates.preview.notCritical.word')
        ),
    },
  ];
  return (
    <div data-testid="preview" data-current={current}>
      {current ? null : (
        <p className="callout warning" role="status" data-testid="preview-stale">
          <span aria-hidden="true">⚠ </span>
          {t('pwf.templates.preview.stale.text')}
        </p>
      )}
      <CalendarMissingNote years={years} />
      <dl className="pwf-facts" data-testid="preview-summary">
        <dt>{t('pwf.templates.preview.projectStart.label')}</dt>
        <dd>{dayText(result.project_start)}</dd>
        <dt>{t('pwf.templates.preview.projectFinish.label')}</dt>
        <dd>
          <span className="pwf-figure">
            <span>{result.project_finish === null ? t('pwf.templates.preview.noFinish.text') : dayText(result.project_finish)}</span>
            {info(t('pwf.templates.preview.projectFinish.label'), t('pwf.templates.preview.projectFinish.formula'))}
          </span>
        </dd>
        <dt>{t('pwf.templates.preview.critical.label')}</dt>
        <dd>
          <span className="pwf-figure">
            <span data-testid="critical-path">{result.critical_path.length === 0 ? '–' : result.critical_path.join(' → ')}</span>
            {info(t('pwf.templates.preview.critical.label'), t('pwf.templates.preview.critical.formula'))}
          </span>
        </dd>
      </dl>
      {result.findings.length === 0 ? null : (
        <ul className="pwf-tpl-findings" data-testid="preview-findings">
          {result.findings.map((finding, index) => (
            <li key={`${finding.code}:${finding.task ?? ''}:${index}`}>
              <StatusPill tone="warning" icon="⚠">
                {scheduleFindingWord(t, finding.code)}
              </StatusPill>
              {finding.task === null ? null : <span> · <code>{finding.task}</code></span>}
            </li>
          ))}
        </ul>
      )}
      <DataTable columns={columns} rows={result.tasks} rowKey={(row) => row.task_code} caption={t('pwf.templates.preview.caption')} />
      {result.excluded_tasks.length === 0 ? null : (
        <p className="adm-kit-sub" data-testid="preview-excluded">
          {t('pwf.templates.preview.excluded.text', { codes: result.excluded_tasks.join(', ') })}
        </p>
      )}
    </div>
  );
}
