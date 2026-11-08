import { useTranslation } from '../../../i18n';
import { InfoFormula, SectionCard, StatusPill } from '../../../ui';
import { dayText } from '../../gov3/model';
import { LEVEL_GLYPH, TREND_GLYPH, factText, indicatorText, infoLabels, kindText, levelText, levelTone, trendText, unitText } from './labels';
import { INDICATORS, INDICATOR_KIND, INDICATOR_UNIT, KINDS, figureText, hasEvidence, indicatorOf } from './model';
import type { Evidence, Level, Policy, Trend } from './model';

/** The "i" of a figure of the board: the formula, the source, the day, the owner and the version of the rule that scored it, and the flag when the rule is a starting value nobody confirmed. */
export function RuleInfo({ policy, asOf, name }: { policy: Policy; asOf: string; name: string }) {
  const { t } = useTranslation();
  return (
    <InfoFormula
      name={name}
      formula={policy.formula ?? t('mr1.risk.info.formula.text')}
      source={policy.source ?? t('mr1.risk.info.source.text')}
      asOf={dayText(policy.asOf ?? asOf)}
      owner={policy.owner === '' ? t('mr1.risk.info.owner.text') : policy.owner}
      version={policy.version === '' ? t('mr1.risk.info.version.none') : policy.version}
      unverified={policy.unverified}
      labels={infoLabels(t, name)}
    />
  );
}

/** The sentence that says the numbers of the rule are a starting value: a rule nobody confirmed is never shown as law. */
export function UnverifiedPill({ unverified }: { unverified: boolean }) {
  const { t } = useTranslation();
  return unverified ? <StatusPill tone="warning">{t('mr1.risk.unverified.pill')}</StatusPill> : <StatusPill tone="success">{t('mr1.risk.verified.pill')}</StatusPill>;
}

/** The level as a word with a glyph (and a tone): the colour never says it alone. */
export function LevelPill({ level }: { level: Level }) {
  const { t } = useTranslation();
  return (
    <StatusPill tone={levelTone(level)} icon={<span aria-hidden="true">{LEVEL_GLYPH[level]}</span>}>
      {levelText(t, level)}
    </StatusPill>
  );
}

/** The trend as an arrow and a word, with the score before it when there was one. */
export function TrendCell({ trend, previous }: { trend: Trend; previous: number | null }) {
  const { t } = useTranslation();
  return (
    <span className="rs-trend" data-trend={trend}>
      <span aria-hidden="true">{TREND_GLYPH[trend]}</span> {trendText(t, trend)}
      {previous === null ? null : <span className="muted"> {t('mr1.risk.trend.previous', { score: previous })}</span>}
    </span>
  );
}

/** The figures a score came from, each with its unit; a figure the system could not know says so and is never written as zero. */
export function EvidenceSummary({ evidence, withFacts = false }: { evidence: Evidence; withFacts?: boolean }) {
  const { t, locale } = useTranslation();
  if (!hasEvidence(evidence)) return <span className="muted">{t('mr1.risk.evidence.none')}</span>;
  return (
    <div className="rs-evidence">
      <ul className="rs-evidence__list">
        {evidence.readings.map((reading) => {
          const indicator = indicatorOf(reading.indicator);
          const driver = evidence.drivers.find((candidate) => candidate.indicator === reading.indicator);
          return (
            <li key={reading.indicator} data-indicator={reading.indicator} data-known={reading.value === null ? 'no' : 'yes'}>
              <span>{indicatorText(t, reading.indicator)}: </span>
              {reading.value === null ? (
                <StatusPill tone="neutral">{t('mr1.risk.evidence.unknown')}</StatusPill>
              ) : (
                <strong>{indicator === undefined ? figureText(reading.value, locale) : unitText(t, INDICATOR_UNIT[indicator], figureText(reading.value, locale))}</strong>
              )}
              {driver === undefined ? null : <span className="muted"> {t('mr1.risk.evidence.likelihood', { value: driver.likelihood })}</span>}
            </li>
          );
        })}
      </ul>
      {withFacts && evidence.facts.length > 0 ? (
        <dl className="rs-facts" data-testid="facts">
          {evidence.facts.map((fact) => (
            <div key={fact.key}>
              <dt>{factText(t, fact.key)}</dt>
              <dd>{fact.value === null ? t('mr1.risk.evidence.unknown') : typeof fact.value === 'boolean' ? (fact.value ? t('mr1.risk.fact.yes') : t('mr1.risk.fact.no')) : String(fact.value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {evidence.unknown.length > 0 ? <p className="muted rs-evidence__reason">{t('mr1.risk.evidence.reason')}</p> : null}
    </div>
  );
}

/** The thresholds, the impacts and the lines of the rule that scored the board: what a figure has to reach for each likelihood. */
export function RuleThresholds({ policy, asOf }: { policy: Policy; asOf: string }) {
  const { t, locale } = useTranslation();
  const params = policy.params;
  return (
    <SectionCard title={t('mr1.risk.rule.title')} status={<RuleInfo policy={policy} asOf={asOf} name={t('mr1.risk.rule.name')} />}>
      {policy.unverified ? (
        <p className="callout warning" role="status" data-testid="unverified-notice">
          {t('mr1.risk.unverified.notice')}
        </p>
      ) : null}
      <p className="muted">{t('mr1.risk.rule.lead')}</p>
      <div className="tablewrap">
        <table className="table" aria-label={t('mr1.risk.rule.thresholds')} data-testid="thresholds">
          <caption className="sub">{t('mr1.risk.rule.thresholds')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('mr1.risk.rule.col.indicator')}</th>
              <th scope="col">{t('mr1.risk.rule.col.kind')}</th>
              <th scope="col">{t('mr1.risk.rule.col.likelihood2')}</th>
              <th scope="col">{t('mr1.risk.rule.col.likelihood3')}</th>
              <th scope="col">{t('mr1.risk.rule.col.likelihood4')}</th>
              <th scope="col">{t('mr1.risk.rule.col.likelihood5')}</th>
            </tr>
          </thead>
          <tbody>
            {INDICATORS.map((indicator) => {
              const line = params.thresholds[indicator];
              return (
                <tr key={indicator} data-indicator={indicator}>
                  <th scope="row">{indicatorText(t, indicator)}</th>
                  <td>{kindText(t, INDICATOR_KIND[indicator])}</td>
                  {[0, 1, 2, 3].map((position) => {
                    const value = line?.[position];
                    return <td key={position}>{value === undefined ? t('mr1.risk.evidence.unknown') : unitText(t, INDICATOR_UNIT[indicator], figureText(value, locale))}</td>;
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ul className="rs-rule-lines" data-testid="rule-lines">
        {KINDS.flatMap((kind) => {
          const value = params.impact[kind];
          return value === undefined ? [] : [<li key={kind}>{t('mr1.risk.rule.impact', { kind: kindText(t, kind), value })}</li>];
        })}
        {params.criticalScore === null ? null : <li>{t('mr1.risk.rule.critical', { value: params.criticalScore })}</li>}
        {params.jumpPoints === null ? null : <li>{t('mr1.risk.rule.jump', { value: params.jumpPoints })}</li>}
        {params.openFromLikelihood === null ? null : <li>{t('mr1.risk.rule.open', { value: params.openFromLikelihood })}</li>}
      </ul>
    </SectionCard>
  );
}
