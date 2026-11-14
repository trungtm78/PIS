import { useTranslation } from '../../../i18n';
import { SectionCard } from '../../../ui';
import { CalendarMissingNote, FigureInfo } from '../components';
import { dayText, missingYears } from '../model';
import type { AdoptResult } from '../model';
import { readinessText, treatmentWord } from './labels';
import { TaskDecision } from './TaskDecision';
import { emptyDecision, pendingDecisions, treatmentCounts, treatmentsFor } from './model';
import type { AdoptReadiness, Decision, Decisions, Treatment } from './model';
import { TaskName } from '../codes';

export interface AdoptResultViewProps {
  result: AdoptResult;
  decisions: Decisions;
  readiness: AdoptReadiness;
  showErrors: boolean;
  onDecision: (code: string, decision: Decision | undefined) => void;
}

/** The dry run of an adoption: how many tasks fall under each treatment, the schedule, the findings, and one row for each task where the person decides what to do with it (BR-PWF-17). */
export function AdoptResultView({ result, decisions, readiness, showErrors, onDecision }: AdoptResultViewProps) {
  const { t } = useTranslation();
  const counts = treatmentCounts(result);
  const pending = pendingDecisions(result, decisions).length;
  const years = missingYears(result.schedule.tasks);
  const version = t('pwf.start.info.version.text', { hash: result.template_hash.slice(0, 8) });
  const choose = (code: string, value: string): void => {
    onDecision(code, value === '' ? undefined : emptyDecision(value as Treatment));
  };
  return (
    <SectionCard title={t('pwf.start.result.title')}>
      <div data-testid="result">
        <p data-testid="result-counts">
          {(['TRACKED', 'IN_PROGRESS', 'DONE', 'NOT_TRACKED', 'EXCLUDED'] as const).map((treatment) => (
            <span key={treatment} className="pwf-figure">
              {treatmentWord(t, treatment)}: <strong>{counts[treatment]}</strong>{' '}
            </span>
          ))}
          <FigureInfo name={t('pwf.start.result.counts.name')} formula={t('pwf.start.result.counts.formula')} source={t('pwf.start.result.counts.source')} asOf={result.as_of} version={version} />
        </p>
        <dl className="pwf-facts">
          <dt>{t('pwf.start.result.projectStart.label')}</dt>
          <dd>{dayText(result.schedule.project_start)}</dd>
          <dt>{t('pwf.start.result.projectFinish.label')}</dt>
          <dd>
            <span className="pwf-figure">
              {dayText(result.schedule.project_finish)}
              <FigureInfo name={t('pwf.start.result.projectFinish.label')} formula={t('pwf.start.result.finish.formula')} source={t('pwf.start.result.finish.source')} asOf={result.as_of} version={version} />
            </span>
          </dd>
          <dt>{t('pwf.start.result.effective.label')}</dt>
          <dd>{dayText(result.effective_date)}</dd>
        </dl>
        <CalendarMissingNote years={years} />
        {result.findings.length === 0 ? null : (
          <ul data-testid="findings">
            {result.findings.map((finding) => (
              <li key={`${finding.code}:${finding.task ?? ''}`}>
                {finding.code}
                {finding.task === null ? '' : ` · ${finding.task}`}
              </li>
            ))}
          </ul>
        )}
        <table className="pwf-table">
          <caption>{t('pwf.start.result.table.caption')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('pwf.start.result.col.task')}</th>
              <th scope="col">{t('pwf.start.result.col.plan')}</th>
              <th scope="col">{t('pwf.start.result.col.treatment')}</th>
            </tr>
          </thead>
          <tbody>
            {result.tasks.map((task) => {
              const decision = decisions[task.task_code];
              const options = treatmentsFor(task);
              return (
                <tr key={task.task_code} data-testid={`row-${task.task_code}`} data-treatment={task.treatment}>
                  <td>
                    <TaskName name={task.name} code={task.task_code} />
                  </td>
                  <td>
                    {dayText(task.planned_start)} – {dayText(task.planned_finish)}
                  </td>
                  <td>
                    {task.treatment === 'EXCLUDED' ? (
                      treatmentWord(t, 'EXCLUDED')
                    ) : (
                      <>
                        <label className="pwf-sr" htmlFor={`treatment-${task.task_code}`}>
                          {t('pwf.start.decision.treatment.label', { task: task.task_code })}
                        </label>
                        <select id={`treatment-${task.task_code}`} data-testid={`treatment-${task.task_code}`} value={decision?.treatment ?? (task.needs_decision ? '' : task.treatment)} onChange={(event) => choose(task.task_code, event.target.value)}>
                          {task.needs_decision ? <option value="">{t('pwf.start.treatment.choose.option')}</option> : null}
                          {options.map((option) => (
                            <option key={option} value={option}>
                              {treatmentWord(t, option)}
                            </option>
                          ))}
                        </select>
                        {task.needs_decision && decision === undefined ? <span className="pwf-missing"> {t('pwf.start.decision.needed.text')}</span> : null}
                        {decision === undefined ? null : <TaskDecision code={task.task_code} decision={decision} showErrors={showErrors} onChange={(next) => onDecision(task.task_code, next)} />}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className={readiness === 'ready' ? 'callout' : 'callout warning'} role="status" data-testid="readiness">
          {readinessText(t, readiness, pending)}
        </p>
      </div>
    </SectionCard>
  );
}
