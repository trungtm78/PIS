import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import { DataTable, FlowChart, InfoFormula, KpiStrip, KpiTile, SectionCard, StatusPill } from '../../../ui';
import type { InfoFormulaLabels } from '../../../ui';
import { TornadoChart } from './TornadoChart';
import { asOfText, decimalText } from './model';
import type { Appraisal, Headline, Measure, Report } from './model';

type T = Translator['t'];

/** A key of the catalogue made from a code of the server (NO_SIGN_CHANGE becomes noSignChange). */
export const camel = (code: string): string => code.toLowerCase().replace(/_([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());

export const reasonText = (t: T, reason: string | null): string => (reason === null ? '' : t(`fin1.reason.${camel(reason)}`));
export const parameterText = (t: T, parameter: string): string => t(`fin1.param.${parameter}`);
export const periodUnitText = (t: T, unit: string): string => t(`fin1.unit.${camel(unit)}`);

/** A change of a parameter as a person reads it: "+10%", "-1 point", "1 period". */
export function deltaText(t: T, parameter: string, delta: string): string {
  if (parameter === 'benefitDelayPeriods') return t('fin1.delta.periods', { value: delta });
  if (parameter === 'discountRatePp') return t('fin1.delta.points', { value: delta.startsWith('-') ? delta : `+${delta}` });
  return t('fin1.delta.percent', { value: delta.startsWith('-') || delta === '0' ? delta : `+${delta}` });
}

function infoLabels(t: T, name: string): InfoFormulaLabels {
  return {
    open: t('fin1.info.open', { name }),
    close: t('fin1.info.close'),
    formula: t('fin1.info.formula'),
    numerator: t('fin1.info.numerator'),
    denominator: t('fin1.info.denominator'),
    exclusions: t('fin1.info.assumptions'),
    source: t('fin1.info.source'),
    asOf: t('fin1.info.asOf'),
    owner: t('fin1.info.owner'),
    version: t('fin1.info.version'),
    unverified: t('fin1.info.unverified'),
  };
}

interface TileProps {
  appraisal: Appraisal;
  measure: Measure;
  label: string;
  value: string | null;
  unit: string;
  sub?: string | undefined;
  testId: string;
}

/** One figure of the result card: the value, or the reason it does not apply, and the "i" with its formula, inputs and assumptions. */
function MeasureTile({ appraisal, measure, label, value, unit, sub, testId }: TileProps) {
  const { t, locale } = useTranslation();
  const applies = measure.status === 'OK' && value !== null;
  const inputs = Object.entries(measure.inputs).map(([key, text]) => `${key}: ${text}`);
  return (
    <div data-testid={testId} data-status={measure.status}>
      <KpiTile
        label={label}
        value={applies ? decimalText(value, locale) : t('fin1.measure.na')}
        unit={applies ? unit : ''}
        tone={applies ? 'default' : 'neutral'}
        sub={
          <>
            {applies ? (sub === undefined ? null : <span>{sub}</span>) : <span data-testid={`${testId}-reason`}>{reasonText(t, measure.reason)}</span>}
            <InfoFormula
              name={label}
              formula={measure.formula}
              numerator={inputs.join(' · ')}
              source={t('fin1.info.sourceValue', { version: appraisal.formulaVersion ?? '' })}
              asOf={asOfText(appraisal.computedAt)}
              owner={appraisal.approvedBy?.name ?? appraisal.updatedBy.name ?? ''}
              version={t('fin1.info.versionValue', { version: appraisal.formulaVersion ?? '', hash: (appraisal.resultHash ?? '').slice(0, 12) })}
              exclusions={measure.assumptions.map((assumption) => assumption.text)}
              labels={infoLabels(t, label)}
            />
          </>
        }
      />
    </div>
  );
}

const money = (value: string | null | undefined, locale: string): string => decimalText(value, locale);

function HeadlineGrid({ headline, t, locale, periodUnit }: { headline: Headline; t: T; locale: string; periodUnit: string }) {
  const rows: Array<[string, string, string | null, string | null]> = [
    ['npv', t('fin1.measure.npv'), headline.npv === null ? null : `${money(headline.npv, locale)} ${t('fin1.unit.vnd')}`, null],
    ['irr', t('fin1.measure.irr'), headline.irrPct === null ? null : `${money(headline.irrPct, locale)}%`, headline.irrReason],
    ['payback', t('fin1.measure.payback'), headline.paybackPeriods === null ? null : `${money(headline.paybackPeriods, locale)} ${periodUnit}`, headline.paybackReason],
    ['discounted', t('fin1.measure.discounted'), headline.discountedPaybackPeriods === null ? null : `${money(headline.discountedPaybackPeriods, locale)} ${periodUnit}`, headline.discountedPaybackReason],
    ['bcr', t('fin1.measure.bcr'), headline.bcr === null ? null : money(headline.bcr, locale), headline.bcrReason],
    ['tco', t('fin1.measure.tco'), headline.tcoPresentValue === null ? null : `${money(headline.tcoPresentValue, locale)} ${t('fin1.unit.vnd')}`, null],
  ];
  return (
    <dl className="fin1-facts" data-testid="headline">
      {rows.map(([key, label, value, reason]) => (
        <div key={key} data-measure={key}>
          <dt>{label}</dt>
          <dd>{value ?? `${t('fin1.measure.na')}${reason === null ? '' : `: ${reasonText(t, reason)}`}`}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The results of an appraisal, as the server computed them: the figures with the "i" of each (formula, inputs, assumptions, formula version and hash), the cash flow table and its chart, the scenarios in tabs,
 * the sensitivity (one-way, two-way, tornado, switching values) and the non-financial index. Nothing here is computed in the browser: every number is a text that came from the server. The AI assistant may
 * explain these results later; it gives no input and no number.
 */
export function ResultsPanel({ appraisal, report, editingScenarios }: { appraisal: Appraisal; report: Report | null; editingScenarios: Array<{ code: string; label: string }> }) {
  const { t, locale } = useTranslation();
  const [tab, setTab] = useState('BASE');
  const [parameter, setParameter] = useState('benefitPct');
  const results = appraisal.results;
  const unit = periodUnitText(t, appraisal.periodUnit);
  const stale = !appraisal.resultsFresh && !appraisal.frozen;
  return (
    <>
      {results === null ? (
        <p className="callout" role="status" data-testid="no-results">
          {t('fin1.results.none')}
        </p>
      ) : (
        <>
          {stale ? (
            <p className="callout fin1-warn" role="status" data-testid="stale">
              {t('fin1.results.stale')}
            </p>
          ) : null}
          {appraisal.frozen ? (
            <p className="callout" role="status" data-testid="frozen">
              {t('fin1.results.frozen', { hash: (appraisal.resultHash ?? '').slice(0, 16), version: appraisal.formulaVersion ?? '' })}
            </p>
          ) : null}
          {report === null ? null : (
            <>
              <SectionCard title={t('fin1.results.title')} unit={t('fin1.unit.vnd')} status={<StatusPill tone={appraisal.frozen ? 'success' : stale ? 'warning' : 'info'}>{appraisal.frozen ? t('fin1.results.state.frozen') : stale ? t('fin1.results.state.stale') : t('fin1.results.state.computed')}</StatusPill>}>
                <KpiStrip label={t('fin1.results.title')}>
                  <MeasureTile appraisal={appraisal} measure={report.npv} label={t('fin1.measure.npv')} value={report.npv.value} unit={t('fin1.unit.vnd')} testId="npv" />
                  <MeasureTile appraisal={appraisal} measure={report.irr} label={t('fin1.measure.irr')} value={report.irr.value} unit="%" testId="irr" />
                  <MeasureTile appraisal={appraisal} measure={report.payback} label={t('fin1.measure.payback')} value={report.payback.value} unit={unit} testId="payback" />
                  <MeasureTile appraisal={appraisal} measure={report.discountedPayback} label={t('fin1.measure.discounted')} value={report.discountedPayback.value} unit={unit} testId="discounted" />
                  <MeasureTile appraisal={appraisal} measure={report.bcr} label={t('fin1.measure.bcr')} value={report.bcr.value} unit={t('fin1.unit.times')} testId="bcr" />
                  <MeasureTile
                    appraisal={appraisal}
                    measure={report.tco}
                    label={t('fin1.measure.tco')}
                    value={report.tcoValue === null ? null : report.tcoValue.presentValueTotal}
                    unit={t('fin1.unit.vnd')}
                    sub={report.tcoValue?.equivalentPerPeriod == null ? undefined : t('fin1.measure.tco.sub', { value: decimalText(report.tcoValue.equivalentPerPeriod, locale), unit })}
                    testId="tco"
                  />
                </KpiStrip>
                <p className="muted" data-testid="ai-note">
                  {t('fin1.results.aiNote')}
                </p>
              </SectionCard>

              <SectionCard title={t('fin1.flow.title')} unit={t('fin1.unit.vnd')}>
                <FlowChart
                  caption={t('fin1.flow.chart')}
                  unit={t('fin1.unit.vnd')}
                  series={[
                    { label: t('fin1.flow.cumulative'), style: 'actual', points: report.table.map((row) => ({ x: String(row.period), y: Number(row.cumulativeNet) })) },
                    ...(report.table.every((row) => row.cumulativePresentValue !== null) ? [{ label: t('fin1.flow.cumulativePv'), style: 'plan' as const, points: report.table.map((row) => ({ x: String(row.period), y: Number(row.cumulativePresentValue) })) }] : []),
                  ]}
                />
                <DataTable
                  caption={t('fin1.flow.title')}
                  rows={report.table}
                  rowKey={(row) => String(row.period)}
                  columns={[
                    { key: 'period', header: t('fin1.flow.period', { unit }), render: (row) => row.period },
                    { key: 'net', header: t('fin1.flow.net'), align: 'right', render: (row) => money(row.net, locale) },
                    { key: 'factor', header: t('fin1.flow.factor'), align: 'right', render: (row) => (row.factor === null ? t('fin1.measure.na') : money(row.factor, locale)) },
                    { key: 'pv', header: t('fin1.flow.pv'), align: 'right', render: (row) => (row.presentValue === null ? t('fin1.measure.na') : money(row.presentValue, locale)) },
                    { key: 'cum', header: t('fin1.flow.cumulative'), align: 'right', render: (row) => money(row.cumulativeNet, locale) },
                    { key: 'cumpv', header: t('fin1.flow.cumulativePv'), align: 'right', render: (row) => (row.cumulativePresentValue === null ? t('fin1.measure.na') : money(row.cumulativePresentValue, locale)) },
                  ]}
                />
                <p className="muted">{t('fin1.flow.rounding')}</p>
              </SectionCard>

              <SectionCard title={t('fin1.scenario.title')} unit={t('fin1.unit.vnd')}>
                <div role="tablist" aria-label={t('fin1.scenario.title')} className="fin1-tabs">
                  {[{ code: 'BASE', label: t('fin1.scenario.base') }, ...editingScenarios].map((scenario) => (
                    <button key={scenario.code} type="button" role="tab" id={`fin1-tab-${scenario.code}`} aria-selected={tab === scenario.code} aria-controls="fin1-tabpanel" tabIndex={tab === scenario.code ? 0 : -1} data-testid={`tab-${scenario.code}`} onClick={() => setTab(scenario.code)}>
                      {scenario.label}
                    </button>
                  ))}
                </div>
                <div role="tabpanel" id="fin1-tabpanel" aria-labelledby={`fin1-tab-${tab}`} data-testid="tabpanel">
                  {(() => {
                    const found = report.scenarios.find((scenario) => scenario.code === tab);
                    if (found === undefined) return <p className="callout">{t('fin1.scenario.notComputed')}</p>;
                    return (
                      <>
                        <HeadlineGrid headline={found.headline} t={t} locale={locale} periodUnit={unit} />
                        {Object.keys(found.deltas).length === 0 ? (
                          <p className="muted">{t('fin1.scenario.baseNote')}</p>
                        ) : (
                          <p className="muted" data-testid="deltas">
                            {Object.entries(found.deltas)
                              .map(([key, value]) => `${parameterText(t, key)}: ${deltaText(t, key, value)}`)
                              .join(' · ')}
                          </p>
                        )}
                      </>
                    );
                  })()}
                </div>
                <DataTable
                  caption={t('fin1.scenario.compare')}
                  rows={report.scenarios}
                  rowKey={(row) => row.code}
                  columns={[
                    { key: 'scenario', header: t('fin1.scenario.name'), render: (row) => (row.code === 'BASE' ? t('fin1.scenario.base') : row.label) },
                    { key: 'npv', header: t('fin1.measure.npv'), align: 'right', render: (row) => (row.headline.npv === null ? t('fin1.measure.na') : money(row.headline.npv, locale)) },
                    { key: 'irr', header: t('fin1.measure.irr'), align: 'right', render: (row) => (row.headline.irrPct === null ? t('fin1.measure.na') : `${money(row.headline.irrPct, locale)}%`) },
                    { key: 'payback', header: t('fin1.measure.payback'), align: 'right', render: (row) => (row.headline.paybackPeriods === null ? t('fin1.measure.na') : money(row.headline.paybackPeriods, locale)) },
                    { key: 'bcr', header: t('fin1.measure.bcr'), align: 'right', render: (row) => (row.headline.bcr === null ? t('fin1.measure.na') : money(row.headline.bcr, locale)) },
                  ]}
                />
              </SectionCard>

              <SectionCard title={t('fin1.sens.title')} unit={t('fin1.unit.vnd')}>
                <h3>{t('fin1.sens.tornado')}</h3>
                <TornadoChart bars={report.tornado} baseNpv={report.npv.value} parameterLabel={(name) => parameterText(t, name)} deltaLabel={(name, delta) => deltaText(t, name, delta)} caption={t('fin1.sens.tornado')} unit={t('fin1.unit.vnd')} />
                <h3>{t('fin1.sens.oneWay')}</h3>
                <label className="fin1-field">
                  {t('fin1.sens.parameter')}
                  <select value={parameter} onChange={(event) => setParameter(event.target.value)} data-testid="oneway-parameter">
                    {report.oneWay.map((table) => (
                      <option key={table.parameter} value={table.parameter}>
                        {parameterText(t, table.parameter)}
                      </option>
                    ))}
                  </select>
                </label>
                <DataTable
                  caption={t('fin1.sens.oneWay')}
                  rows={report.oneWay.find((table) => table.parameter === parameter)?.points ?? []}
                  rowKey={(row) => row.delta}
                  columns={[
                    { key: 'delta', header: t('fin1.sens.change'), render: (row) => deltaText(t, parameter, row.delta) },
                    { key: 'npv', header: t('fin1.measure.npv'), align: 'right', render: (row) => (row.headline.npv === null ? t('fin1.measure.na') : money(row.headline.npv, locale)) },
                    { key: 'irr', header: t('fin1.measure.irr'), align: 'right', render: (row) => (row.headline.irrPct === null ? t('fin1.measure.na') : `${money(row.headline.irrPct, locale)}%`) },
                    { key: 'payback', header: t('fin1.measure.payback'), align: 'right', render: (row) => (row.headline.paybackPeriods === null ? t('fin1.measure.na') : money(row.headline.paybackPeriods, locale)) },
                  ]}
                />
                <h3>{t('fin1.sens.twoWay', { x: parameterText(t, report.twoWay.x), y: parameterText(t, report.twoWay.y) })}</h3>
                <div className="fin1-scroll" tabIndex={0} role="region" aria-label={t('fin1.sens.twoWay', { x: parameterText(t, report.twoWay.x), y: parameterText(t, report.twoWay.y) })}>
                  <table className="fin1-grid" data-testid="twoway">
                    <thead>
                      <tr>
                        <th scope="col">{t('fin1.sens.corner', { x: parameterText(t, report.twoWay.x), y: parameterText(t, report.twoWay.y) })}</th>
                        {report.twoWay.xPoints.map((point) => (
                          <th key={point} scope="col">
                            {deltaText(t, report.twoWay.x, point)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {report.twoWay.yPoints.map((point, row) => (
                        <tr key={point}>
                          <th scope="row">{deltaText(t, report.twoWay.y, point)}</th>
                          {report.twoWay.xPoints.map((x, column) => (
                            <td key={x} className="fin1-num">
                              {report.twoWay.npv[row]?.[column] == null ? t('fin1.measure.na') : money(report.twoWay.npv[row]?.[column], locale)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <h3>{t('fin1.sens.switching')}</h3>
                <DataTable
                  caption={t('fin1.sens.switching')}
                  rows={report.switching}
                  rowKey={(row) => row.parameter}
                  columns={[
                    { key: 'parameter', header: t('fin1.sens.parameter'), render: (row) => parameterText(t, row.parameter) },
                    { key: 'pct', header: t('fin1.sens.switchingValue'), align: 'right', render: (row) => (row.pct === null ? t('fin1.measure.na') : `${money(row.pct, locale)}%`) },
                    { key: 'reason', header: t('fin1.sens.why'), render: (row) => (row.reason === null ? t('fin1.sens.switchingMeaning') : reasonText(t, row.reason)) },
                  ]}
                />
              </SectionCard>
            </>
          )}

          {results.criteria === null ? null : (
            <SectionCard title={t('fin1.criteria.result.title')} status={<StatusPill tone="info">{t('fin1.criteria.result.index', { value: decimalText(results.criteria.indexPct, locale) })}</StatusPill>}>
              <p data-testid="criteria-score">{t('fin1.criteria.result.score', { value: decimalText(results.criteria.weightedScore, locale) })}</p>
              <DataTable
                caption={t('fin1.criteria.result.title')}
                rows={results.criteria.lines}
                rowKey={(row) => row.key}
                columns={[
                  { key: 'label', header: t('fin1.criteria.name'), render: (row) => row.label },
                  { key: 'weight', header: t('fin1.criteria.weight'), align: 'right', render: (row) => `${decimalText(row.weightPct, locale)}%` },
                  { key: 'score', header: t('fin1.criteria.score'), align: 'right', render: (row) => row.score },
                  { key: 'contribution', header: t('fin1.criteria.contribution'), align: 'right', render: (row) => decimalText(row.contribution, locale) },
                  { key: 'evidence', header: t('fin1.criteria.evidence'), render: (row) => row.evidence },
                ]}
              />
              <p className="muted">{results.criteria.formula}</p>
              {appraisal.criteriaUsed === null ? null : <p className="muted">{appraisal.criteriaUsed.source === 'RULE' ? t('fin1.criteria.used.rule', { version: appraisal.criteriaUsed.version }) : t('fin1.criteria.used.default')}</p>}
            </SectionCard>
          )}
        </>
      )}
    </>
  );
}
