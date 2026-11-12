import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { InfoFormula, StatusPill } from '../../ui';
import type { InfoFormulaLabels } from '../../ui';
import { blockerWord, bandWord, missingReasonWord, problemText, remainingText } from './labels';
import { bandIcon, bandTone, dayText, isConflict, taskLink } from './model';
import type { Problem, TaskBand } from './model';
import './pwf.css';

/** The words of the "i" control: the keys the other figures of the product use, so a number says its formula, source and day the same way on every screen. */
export function useInfoLabels(): (name: string) => InfoFormulaLabels {
  const { t } = useTranslation();
  return (name) => ({
    open: t('govc.bi.info.open', { name }),
    close: t('govc.bi.info.close'),
    formula: t('govc.bi.info.formula'),
    numerator: t('govc.bi.info.numerator'),
    denominator: t('govc.bi.info.denominator'),
    exclusions: t('govc.bi.info.exclusions'),
    source: t('govc.bi.info.source'),
    asOf: t('govc.bi.info.asOf'),
    owner: t('govc.bi.info.owner'),
    version: t('govc.bi.info.version'),
  });
}

export interface FigureInfoProps {
  /** What the figure is called (the name of the "i" panel). */
  name: string;
  /** How the figure is computed, already translated. */
  formula: string;
  /** Where its inputs come from, already translated. */
  source: string;
  /** The instant or day the figure was read (`as_of` of the answer). */
  asOf: string | null | undefined;
  /** The version of the rule or the schedule behind it, already translated. */
  version: string;
  unverified?: boolean;
}

/** The "i" of a figure: formula, source, day, owner and version (the rule of the module: no number without it). */
export function FigureInfo({ name, formula, source, asOf, version, unverified }: FigureInfoProps) {
  const { t } = useTranslation();
  const labels = useInfoLabels();
  return <InfoFormula name={name} formula={formula} source={source} asOf={dayText(asOf?.slice(0, 10))} owner={t('pwf.info.owner.label')} version={version} unverified={unverified === true} labels={labels(name)} />;
}

/** A colour of the three: always the word and the glyph with it, and the days left in the unit of the source when the band has them (the colour is never the only cue). */
export function BandBadge({ band, showDays = true }: { band: TaskBand; showDays?: boolean }) {
  const { t } = useTranslation();
  const days = showDays ? remainingText(t, band) : undefined;
  return (
    <span className="pwf-band" data-band={band.band}>
      <StatusPill tone={bandTone(band.band)} icon={bandIcon(band.band)}>
        {bandWord(t, band.band)}
      </StatusPill>
      {days === undefined ? null : <span className="pwf-band__days">{days}</span>}
    </span>
  );
}

/** A template that was shipped as a starting point and not confirmed with the owner of the process: it says so wherever it is shown (PWF.md, F1). */
export function UnverifiedLabel() {
  const { t } = useTranslation();
  return (
    <StatusPill tone="warning" icon="⚠">
      {t('pwf.common.unverified.label')}
    </StatusPill>
  );
}

/** "Deadline cannot be counted, the calendar of year N is missing": no date is guessed (BR-PWF-26). */
export function CalendarMissingNote({ years }: { years: readonly number[] }) {
  const { t } = useTranslation();
  if (years.length === 0) return null;
  return (
    <p className="callout warning pwf-notice" role="status" data-testid="calendar-missing">
      <span aria-hidden="true">⚠ </span>
      {t('pwf.common.calendarMissing.note', { years: years.join(', ') })}
    </p>
  );
}

/** One deadline cell for a task whose year has no calendar: the words, never a date and never a green. */
export function CalendarMissingCell({ year }: { year: number | null }) {
  const { t } = useTranslation();
  return <span className="pwf-missing">{year === null ? t('pwf.common.noDue.text') : t('pwf.common.calendarMissingYear.text', { year })}</span>;
}

/**
 * The refusal of a command in the words of the module: what the server listed with it (the blockers of a completion, the tasks a gate still waits for, each with a link to the task)
 * and, for a refusal that says somebody changed it first, the button that reads the newer version.
 */
export function ProblemBanner({ problem, onReload }: { problem: Problem; onReload?: (() => void) | undefined }) {
  const { t } = useTranslation();
  return (
    <div className="callout danger pwf-problem" role="alert" data-testid="problem" data-kind={problem.kind}>
      <p>{problemText(t, problem)}</p>
      {problem.blockers.length === 0 ? null : (
        <ul data-testid="problem-blockers">
          {problem.blockers.map((blocker) => (
            <li key={`${blocker.code}:${blocker.subject}`}>{blockerWord(t, blocker.code, blocker.subject)}</li>
          ))}
        </ul>
      )}
      {problem.missing.length === 0 ? null : (
        <ul data-testid="problem-missing">
          {problem.missing.map((item) => (
            <li key={`${item.task}:${item.reason}`}>
              {item.task_id === null ? item.task : <Link to={taskLink(item.task_id)}>{item.task}</Link>} · {missingReasonWord(t, item.reason)}
            </li>
          ))}
        </ul>
      )}
      {onReload !== undefined && isConflict(problem) ? (
        <button type="button" className="ui-button ui-button--outline ui-button--small" data-action="reload" onClick={onReload}>
          {t('pwf.problem.reload.action')}
        </button>
      ) : null}
    </div>
  );
}
