import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StatusPill } from '../../ui';
import { Figure, Frame, Info, UnverifiedNote, asList, asRecord, money, num, text, useGovRead } from './gov11-kit';
import type { RuleReading } from './gov11-kit';

type Tone = 'success' | 'warning' | 'danger' | 'neutral';
const BAND: Readonly<Record<string, Tone>> = { GOOD: 'success', FAIR: 'warning', POOR: 'danger', INSUFFICIENT: 'neutral' };

/**
 * DIS-28, how well the monthly forecast of each investor foretold what the Treasury paid (G1-16): the weighted absolute percentage error and the bias, from the last forecast made before each month (the history
 * of the schedule is never overwritten). An investor with too few measured months is not given a band, and the figures say so instead of looking good.
 */
export default function AccuracyScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const query = useGovRead('dis', 'getDisbursementForecastAccuracy', undefined);
  const bandLabel = (band: string): string => {
    switch (band) {
      case 'GOOD':
        return t('gov11.accuracy.band.good');
      case 'FAIR':
        return t('gov11.accuracy.band.fair');
      case 'POOR':
        return t('gov11.accuracy.band.poor');
      default:
        return t('gov11.accuracy.band.insufficient');
    }
  };
  return (
    <Frame
      route={route}
      title={t('gov11.accuracy.title')}
      subtitle={t('gov11.accuracy.subtitle')}
      scope={[{ label: t('gov11.common.scope'), value: tenant?.name ?? '–' }]}
      query={query}
      isEmpty={(data) => asList(data.rows).length === 0}
      notice={<UnverifiedNote rules={[asRecord(query.data?.rule) as unknown as RuleReading]} />}
    >
      {(data) => {
        const rule = asRecord(data.rule) as unknown as RuleReading;
        const overall = asRecord(data.overall);
        const rows = asList(data.rows);
        const asOf = text(data.plan_year);
        return (
          <div className="gov11-grid">
            {data.truncated === true && (
              <p className="callout" role="status" data-testid="truncated-note">
                {t('gov11.accuracy.truncated')}
              </p>
            )}
            <div className="gov11-row">
              <Figure label={t('gov11.accuracy.wape')} value={overall.wape_pct === null ? '–' : `${text(overall.wape_pct)}%`} tone={BAND[text(overall.band, 'INSUFFICIENT')] ?? 'neutral'} sub={bandLabel(text(overall.band, 'INSUFFICIENT'))} rule={rule} fallbackFormula={t('gov11.accuracy.wape.formula')} owner={t('gov11.accuracy.owner')} asOf={asOf} />
              <Figure label={t('gov11.accuracy.bias')} value={overall.bias_pct === null ? '–' : `${text(overall.bias_pct)}%`} rule={rule} fallbackFormula={t('gov11.accuracy.bias.formula')} owner={t('gov11.accuracy.owner')} asOf={asOf} />
              <Figure label={t('gov11.accuracy.months')} value={text(num(overall.months))} sub={t('gov11.accuracy.lastMonth', { month: text(data.last_measured_month) })} rule={rule} fallbackFormula={t('gov11.accuracy.months.formula')} owner={t('gov11.accuracy.owner')} asOf={asOf} />
            </div>
            <div className="gov11-scroll">
              <table className="gov11-table" data-testid="accuracy-table">
                <caption>{t('gov11.accuracy.caption', { year: text(data.plan_year) })}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('gov11.accuracy.col.investor')}</th>
                    <th scope="col" className="gov11-num">
                      {t('gov11.accuracy.col.months')}
                    </th>
                    <th scope="col" className="gov11-num">
                      {t('gov11.accuracy.col.forecast')}
                    </th>
                    <th scope="col" className="gov11-num">
                      {t('gov11.accuracy.col.actual')}
                    </th>
                    <th scope="col" className="gov11-num">
                      {t('gov11.accuracy.col.wape')}
                      <Info name={t('gov11.accuracy.col.wape')} rule={rule} fallbackFormula={t('gov11.accuracy.wape.formula')} owner={t('gov11.accuracy.owner')} asOf={asOf} />
                    </th>
                    <th scope="col" className="gov11-num">
                      {t('gov11.accuracy.col.bias')}
                      <Info name={t('gov11.accuracy.col.bias')} rule={rule} fallbackFormula={t('gov11.accuracy.bias.formula')} owner={t('gov11.accuracy.owner')} asOf={asOf} />
                    </th>
                    <th scope="col">{t('gov11.accuracy.col.band')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => {
                    const investor = asRecord(row.investor);
                    const flag = row.bias_flag === 'OVER' ? t('gov11.accuracy.flag.over') : row.bias_flag === 'UNDER' ? t('gov11.accuracy.flag.under') : null;
                    return (
                      <tr key={text(investor.id, `row-${index}`)} data-testid={`investor-${text(investor.code, String(index))}`}>
                        <th scope="row">{text(investor.name, t('gov11.accuracy.noInvestor'))}</th>
                        <td className="gov11-num">{text(num(row.months))}</td>
                        <td className="gov11-num">{money(row.forecast_vnd)}</td>
                        <td className="gov11-num">{money(row.actual_vnd)}</td>
                        <td className="gov11-num">{row.wape_pct === null ? '–' : `${text(row.wape_pct)}%`}</td>
                        <td className="gov11-num">
                          {row.bias_pct === null ? '–' : `${text(row.bias_pct)}%`}
                          {flag !== null && ` · ${flag}`}
                        </td>
                        <td>
                          <StatusPill tone={BAND[text(row.band, 'INSUFFICIENT')] ?? 'neutral'}>{bandLabel(text(row.band, 'INSUFFICIENT'))}</StatusPill>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      }}
    </Frame>
  );
}
