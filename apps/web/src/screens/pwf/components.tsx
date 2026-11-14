import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { InfoFormula, StatusPill } from '../../ui';
import type { InfoFormulaLabels } from '../../ui';
import { blockerWord, bandWord, missingReasonWord, problemText, remainingText } from './labels';
import { BANDS, bandIcon, bandTone, dayText, isConflict, taskLink } from './model';
import type { Band, Problem, TaskBand } from './model';
import './pwf.css';
import './pwf6.css';

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

/** "3/5" with a bar: the share done of one tier (a phase, a step, a checklist). Nothing to count is said as a dash of words, never as 0 %. */
export function Meter({ done, total, label, testId }: { done: number; total: number; label: string; testId?: string }) {
  const { t } = useTranslation();
  if (total <= 0) return null;
  const percent = Math.round((Math.min(done, total) / total) * 100);
  return (
    <span className="pwf-meter" data-testid={testId} data-complete={done >= total}>
      <progress value={Math.min(done, total)} max={total} aria-label={t('pwf.process.progress.aria.label', { label, done, total })} />
      <span className="pwf-meter__text">{t('pwf6.meter.value.text', { done, total, percent })}</span>
    </span>
  );
}

export interface BandStripProps {
  counts: Readonly<Record<Band, number>>;
  /** The accessible name of the group. */
  label: string;
  unit: string;
  /** The "i" of the counts: said once for the strip, not under every number. */
  info?: ReactNode;
  /** With `onSelect` each count is a button that filters to its colour (pressed again, it clears the filter). */
  selected?: Band | '';
  onSelect?: (band: Band | '') => void;
  /** The colours that can be chosen (a count that is no filter stays a plain tile). */
  selectable?: readonly Band[];
}

/** The count of tasks by official colour as one strip of five equal tiles, each with its glyph and word; the colour is never the only cue. */
export function BandStrip({ counts, label, unit, info, selected = '', onSelect, selectable = BANDS }: BandStripProps) {
  const { t } = useTranslation();
  return (
    <div className="pwf-bands" role="group" aria-label={label}>
      {BANDS.map((band) => {
        const body = (
          <>
            <span className="pwf-bands__label">
              <span aria-hidden="true">{bandIcon(band)}</span> {bandWord(t, band)}
            </span>
            <span className="pwf-bands__figure">
              <span className="pwf-bands__value">{counts[band]}</span> <span className="pwf-bands__unit">{unit}</span>
            </span>
          </>
        );
        return onSelect === undefined || !selectable.includes(band) ? (
          <div key={band} className="pwf-bands__tile" data-band={band} data-testid={`count-${band.toLowerCase()}`}>
            {body}
          </div>
        ) : (
          <button key={band} type="button" className="pwf-bands__tile" data-band={band} data-testid={`count-${band.toLowerCase()}`} aria-pressed={selected === band} onClick={() => onSelect(selected === band ? '' : band)}>
            {body}
          </button>
        );
      })}
      {info === undefined ? null : <span className="pwf-bands__info">{info}</span>}
    </div>
  );
}
