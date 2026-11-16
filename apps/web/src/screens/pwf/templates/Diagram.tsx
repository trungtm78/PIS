import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '@machvon/api-client';
import { hasMessage, useTranslation } from '../../../i18n';
import { SectionCard, StatusPill } from '../../../ui';
import { codeKey } from '../codes';
import { ProblemBanner } from '../components';
import { describeProblem, dayText, isDay } from '../model';
import type { TemplateValidation } from '../model';
import { GanttChart } from '../workflow/GanttChart';
import '../workflow/workflow.css';
import { ganttScale } from '../workflow/model';
import type { LivePreview } from './live-preview';
import { diagramOf } from './preview-model';
import type { Template } from './template-model';

/** The calendar of the working year (ADM-07), where a missing or draft year is put right. */
export const CALENDAR_PATH = '/adm/adm-07';

export interface DiagramProps {
  template: Template;
  live: LivePreview;
  start: string;
  onStart: (day: string) => void;
  /** The table has cells to put right: the diagram says it is the one before. */
  blockedBy: number;
}

/**
 * The diagram under the table (PWF-02): one bar for each step on a sample start day, with the zones of the three colours and the line of the deadline of the whole file, drawn by the Gantt of the project screens from the
 * server's answer. It never counts a date itself, and it says how far the dates can be trusted: counted on a draft calendar ("tạm tính"), a year with no calendar ("chưa tính được"), or not up to date because the table has cells
 * to put right or the server cannot be reached. The table stays editable in every one of those cases.
 */
export function Diagram({ template, live, start, onStart, blockedBy }: DiagramProps) {
  const { t } = useTranslation();
  const words = useMemo(
    () => ({ provisional: t('pwfx.diagram.provisional.short'), missingYear: (year: number) => t('pwfx.diagram.missingYear.row', { year }), notInProject: t('pwfx.diagram.notInProject') }),
    [t],
  );
  const diagram = useMemo(() => (live.result === undefined ? undefined : diagramOf(live.result.preview, template, words)), [live.result, template, words]);
  const hasBars = diagram !== undefined && ganttScale(diagram.rows) !== null;
  return (
    <SectionCard
      title={t('pwfx.diagram.title')}
      status={
        <span className="pwfx-diagram__start">
          <label htmlFor="pwfx-sample-start">{t('pwfx.diagram.start')}</label>
          <input id="pwfx-sample-start" type="date" value={start} aria-invalid={!isDay(start)} onChange={(event) => onStart(event.target.value)} data-testid="sample-start" />
        </span>
      }
    >
      <p className="pwf-hint">{t('pwfx.diagram.hint')}</p>
      <div className="pwfx-diagram__status" data-testid="diagram-status" data-status={live.status} role="status">
        {live.status === 'loading' ? <span>{t('pwfx.diagram.loading')}</span> : null}
        {live.status === 'ready' ? <StatusPill tone="success" icon="✔">{t('pwfx.diagram.ready')}</StatusPill> : null}
        {live.status === 'stale' && blockedBy > 0 ? (
          <span className="callout warning" data-testid="diagram-blocked">
            <span aria-hidden="true">⚠ </span>
            {live.result === undefined ? t('pwfx.diagram.blocked.none', { count: blockedBy }) : t('pwfx.diagram.blocked', { count: blockedBy })}
          </span>
        ) : null}
        {!isDay(start) ? <span className="pwfx-cell-error">{t('pwfx.diagram.start.invalid')}</span> : null}
      </div>
      {live.status === 'error' ? (
        <div className="callout danger" role="alert" data-testid="diagram-offline">
          <p>{live.error instanceof ApiError && live.error.status === 422 ? t('pwfx.diagram.rejected') : t('pwfx.diagram.offline')}</p>
          <ProblemBanner problem={describeProblem(live.error)} />
          <button type="button" className="ui-button ui-button--outline ui-button--small" data-action="retry-diagram" onClick={live.retry}>
            {t('pwfx.diagram.retry')}
          </button>
        </div>
      ) : null}
      {diagram === undefined ? null : (
        <>
          {diagram.provisionalYears.length === 0 ? null : (
            <p className="callout warning" role="status" data-testid="diagram-provisional">
              <span aria-hidden="true">⚠ </span>
              {t('pwfx.diagram.provisional.note', { years: diagram.provisionalYears.map((one) => `${one.year} (${t('pwfx.diagram.version', { version: one.version })})`).join(', ') })}
            </p>
          )}
          {diagram.missingYears.length === 0 ? null : (
            <p className="callout warning" role="status" data-testid="diagram-missing">
              <span aria-hidden="true">⚠ </span>
              {t('pwfx.diagram.missingYear.note', { years: diagram.missingYears.join(', ') })}{' '}
              <Link to={CALENDAR_PATH} data-testid="diagram-calendar-link">
                {t('pwfx.diagram.calendar.link')}
              </Link>
            </p>
          )}
          {hasBars ? (
            <GanttChart rows={diagram.rows} phases={diagram.phases} today={null} variant="template" overall={diagram.overall === undefined ? undefined : { day: diagram.overall.day, label: t('pwfx.diagram.overall.label', { day: dayText(diagram.overall.day) }) }} />
          ) : (
            <p className="adm-kit-empty" data-testid="diagram-empty">
              {t('pwfx.diagram.empty')}
            </p>
          )}
        </>
      )}
      {diagram === undefined && live.status !== 'error' && live.status !== 'loading' && blockedBy === 0 ? <p className="adm-kit-empty">{t('pwfx.diagram.empty')}</p> : null}
    </SectionCard>
  );
}

/** What the server found in the template, short: the verdict and the findings of the checks (the schedule-quality flags never block). */
export function ServerChecks({ result, current, pending, error, rowOf }: { result: TemplateValidation | undefined; current: boolean; pending: boolean; error: unknown; rowOf: (path: string) => string | undefined }) {
  const { t } = useTranslation();
  const errors = result?.findings.filter((finding) => finding.severity === 'ERROR') ?? [];
  const warnings = result?.findings.filter((finding) => finding.severity !== 'ERROR') ?? [];
  return (
    <details className="pwfx-server" data-testid="server-checks" open={errors.length > 0}>
      <summary>
        {t('pwfx.server.title')}{' '}
        {result === undefined ? (
          <span className="pwf-hint">{pending ? t('pwfx.server.running') : t('pwfx.server.none')}</span>
        ) : result.valid ? (
          <StatusPill tone="success" icon="✔">{t('pwf.templates.validate.valid.word')}</StatusPill>
        ) : (
          <StatusPill tone="danger" icon="⛔">{t('pwf.templates.validate.invalid.word')}</StatusPill>
        )}
      </summary>
      {error === undefined || error === null ? null : <ProblemBanner problem={describeProblem(error)} />}
      {result === undefined ? null : (
        <div data-current={current}>
          {current ? null : <p className="callout warning" role="status">{t('pwf.templates.validate.stale.text')}</p>}
          {[...errors, ...warnings].length === 0 ? (
            <p>{t('pwfx.server.clean')}</p>
          ) : (
            <ul className="pwf-tpl-findings" data-testid="findings">
              {[...errors, ...warnings].map((finding, index) => (
                <li key={`${finding.path}:${finding.code}:${index}`} data-severity={finding.severity}>
                  <StatusPill tone={finding.severity === 'ERROR' ? 'danger' : 'warning'} icon={finding.severity === 'ERROR' ? '⛔' : '⚠'}>
                    {finding.severity === 'ERROR' ? t('pwf.templates.finding.error.word') : t('pwf.templates.finding.warning.word')}
                  </StatusPill>{' '}
                  {rowOf(finding.path) === undefined ? null : <strong>{t('pwfx.server.row', { row: rowOf(finding.path) ?? '' })} · </strong>}
                  {hasMessage(`pwfx.server.code.${codeKey(finding.code)}`) ? t(`pwfx.server.code.${codeKey(finding.code)}`) : finding.code}
                  {finding.detail === undefined || finding.detail === null ? null : <span className="adm-kit-sub"> · {finding.detail}</span>}
                </li>
              ))}
            </ul>
          )}
          {result.quality_flags.length === 0 ? null : (
            <ul className="pwf-tpl-findings" data-testid="quality">
              {result.quality_flags.map((flag, index) => (
                <li key={`${flag.code}:${flag.task ?? ''}:${index}`}>
                  <StatusPill tone="warning" icon="⚠">{hasMessage(`pwfx.server.quality.${codeKey(flag.code)}`) ? t(`pwfx.server.quality.${codeKey(flag.code)}`) : flag.code}</StatusPill>
                  {flag.task === undefined || flag.task === null ? null : <span> · {rowOf(`tasks:${flag.task}`) ?? flag.task}</span>}
                  {flag.detail === undefined || flag.detail === null ? null : <span className="adm-kit-sub"> · {flag.detail}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </details>
  );
}
