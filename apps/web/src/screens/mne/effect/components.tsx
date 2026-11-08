import { cloneElement } from 'react';
import type { ReactElement } from 'react';
import { useTranslation } from '../../../i18n';
import { InfoFormula, StatusPill } from '../../../ui';
import { dayText } from '../../gov3/model';
import { infoLabels } from '../../prj/risk-signals/labels';
import { BAND_GLYPH, bandText, bandTone } from './labels';
import type { Band, Policy } from './model';

/** The "i" of a figure the rule computes (the variance, the achievement, the band): the formula, the source, the day, the owner and the version of the rule, and the flag when the rule is a starting value nobody confirmed. */
export function RuleInfo({ policy, asOf, name }: { policy: Policy; asOf: string; name: string }) {
  const { t } = useTranslation();
  return (
    <InfoFormula
      name={name}
      formula={policy.formula ?? t('mr1.effect.info.formula.text')}
      source={policy.source ?? t('mr1.effect.info.source.text')}
      asOf={dayText(policy.asOf ?? asOf)}
      owner={policy.owner === '' ? t('mr1.effect.info.owner.text') : policy.owner}
      version={policy.version === '' ? t('mr1.effect.info.version.none') : policy.version}
      unverified={policy.unverified}
      labels={infoLabels(t, name)}
    />
  );
}

/** The "i" of a figure that was entered, not computed: the formula and the source the indicator itself names, as of the day of the figure. */
export function DefinitionInfo({ name, formula, source, asOf, policy }: { name: string; formula: string; source: string; asOf: string; policy: Policy }) {
  const { t } = useTranslation();
  return (
    <InfoFormula
      name={name}
      formula={formula}
      source={source}
      asOf={dayText(asOf)}
      owner={policy.owner === '' ? t('mr1.effect.info.owner.text') : policy.owner}
      version={policy.version === '' ? t('mr1.effect.info.version.none') : policy.version}
      labels={infoLabels(t, name)}
    />
  );
}

/** The band as a word with a sign: the colour never says it alone. */
export function BandPill({ band }: { band: Band }) {
  const { t } = useTranslation();
  return (
    <StatusPill tone={bandTone(band)} icon={<span aria-hidden="true">{BAND_GLYPH[band]}</span>}>
      {bandText(t, band)}
    </StatusPill>
  );
}

/** The sentence that says the numbers of a rule are a starting value: a rule nobody confirmed is never shown as law. */
export function UnverifiedPill({ unverified }: { unverified: boolean }) {
  const { t } = useTranslation();
  return unverified ? <StatusPill tone="warning">{t('mr1.effect.unverified.pill')}</StatusPill> : <StatusPill tone="success">{t('mr1.effect.verified.pill')}</StatusPill>;
}

export interface FormFieldProps {
  id: string;
  label: string;
  error: string | undefined;
  hint?: string;
  children: ReactElement<{ id?: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }>;
}

/** A labelled control with its hint and its error; the error is announced and tied to the control. */
export function FormField({ id, label, error, hint, children }: FormFieldProps) {
  const described = [hint === undefined ? undefined : `${id}-hint`, error === undefined ? undefined : `${id}-error`].filter((item): item is string => item !== undefined).join(' ');
  return (
    <div className="field" data-field={id}>
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id, ...(error === undefined ? {} : { 'aria-invalid': true }), ...(described === '' ? {} : { 'aria-describedby': described }) })}
      {hint === undefined ? null : (
        <small className="sub" id={`${id}-hint`}>
          {hint}
        </small>
      )}
      {error === undefined ? null : (
        <small role="alert" className="field-error" id={`${id}-error`}>
          {error}
        </small>
      )}
    </div>
  );
}
