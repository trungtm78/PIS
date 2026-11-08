import type { ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import { InfoFormula, StatusPill } from '../../../ui';
import type { InfoFormulaLabels } from '../../../ui';
import { camel, dayText, stateTone } from './common';
import type { Problem, RuleBasis } from './common';
import { problemText } from './common';
import './claims.css';

type T = Translator['t'];

export function infoLabels(t: T, name: string): InfoFormulaLabels {
  return {
    open: t('ctrReg.info.open.label', { name }),
    close: t('ctrReg.info.close.label'),
    formula: t('ctrReg.info.formula.label'),
    numerator: t('ctrReg.info.numerator.label'),
    denominator: t('ctrReg.info.denominator.label'),
    exclusions: t('ctrReg.info.exclusions.label'),
    source: t('ctrReg.info.source.label'),
    asOf: t('ctrReg.info.asOf.label'),
    owner: t('ctrReg.info.owner.label'),
    version: t('ctrReg.info.version.label'),
    unverified: t('ctrReg.info.unverified.text'),
  };
}

export interface FigureInfoProps {
  /** The name of the figure (the title of the panel). */
  name: string;
  formula: string;
  source: string;
  /** The day or moment the figure is as of, already written. */
  asOf: string;
  /** The rule that decided a threshold, when one did: its version, where it came from and whether anybody confirmed it. */
  rule?: RuleBasis | undefined;
  /** The version of the definition when it is not a rule (the term a clock follows), already written. */
  version?: string | undefined;
}

/** The "i" of a number of the registers: the formula in words, the source, the day, the owner (the module) and the version of the rule behind it; a rule nobody confirmed says so. */
export function FigureInfo({ name, formula, source, asOf, rule, version: given }: FigureInfoProps) {
  const { t } = useTranslation();
  const version =
    given !== undefined
      ? given
      : rule === undefined
      ? t('ctrReg.info.noRule.text')
      : t('ctrReg.info.rule.text', { version: rule.version, origin: rule.source === 'RULE' ? t('ctrReg.info.rule.tenant') : t('ctrReg.info.rule.default') });
  return (
    <InfoFormula
      name={name}
      formula={rule?.formula ?? formula}
      source={rule?.source_text ?? source}
      asOf={rule?.as_of === null || rule?.as_of === undefined ? asOf : dayText(rule.as_of)}
      owner={t('ctrReg.info.owner.text')}
      version={version}
      unverified={rule?.unverified === true}
      labels={infoLabels(t, name)}
    />
  );
}

/** A figure with its "i" beside it. */
export function WithInfo({ children, info }: { children: ReactNode; info: ReactNode }) {
  return (
    <span className="ctrreg-with-info">
      {children}
      {info}
    </span>
  );
}

/** The state of a deadline or of a limitation as a pill: a word, never a colour alone. */
export function StatePill({ group, state }: { group: 'deadline' | 'limitation'; state: string }) {
  const { t } = useTranslation();
  return (
    <span data-state={state}>
      <StatusPill tone={stateTone(state)}>{group === 'deadline' ? t(`ctrClaim.deadline.state.${camel(state)}.label`) : t(`ctrClaim.limitation.state.${camel(state)}.label`)}</StatusPill>
    </span>
  );
}

/** The sentence of a refusal in place, with the reload a version conflict offers. */
export function Refusal({ problem, onReload }: { problem: Problem | undefined; onReload?: () => void }) {
  const { t } = useTranslation();
  if (problem === undefined) return null;
  return (
    <div className="ctrreg-refusal" role="alert" data-testid="refusal" data-problem={problem.kind}>
      <p>{problemText(t, problem)}</p>
      {problem.kind === 'versionConflict' && onReload !== undefined && (
        <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onReload}>
          {t('ctrReg.problem.reload.action')}
        </button>
      )}
    </div>
  );
}

/** The notice above a register when the working calendar is not published: deadlines counted in working days cannot be given, and none is guessed. */
export function CalendarNotice({ published }: { published: boolean }) {
  const { t } = useTranslation();
  if (published) return null;
  return (
    <p className="ctrreg-notice" role="status" data-testid="calendar-notice">
      {t('ctrReg.calendar.unavailable.text')}
    </p>
  );
}

/** The notice that a list was cut: the totals are then a lower bound. */
export function TruncatedNotice({ truncated }: { truncated: boolean }) {
  const { t } = useTranslation();
  if (!truncated) return null;
  return (
    <p className="ctrreg-notice" role="status" data-testid="truncated-notice">
      {t('ctrReg.truncated.text')}
    </p>
  );
}

export { Field } from '../components';
export { BackLink } from '../components';
