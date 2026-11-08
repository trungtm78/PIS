import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StatusPill } from '../../ui';
import { Figure, Frame, Info, UnverifiedNote, asList, asRecord, dayLabel, money, num, percent, text, useGovRead } from './gov11-kit';
import type { RuleReading } from './gov11-kit';

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';
const TONE: Readonly<Record<string, Tone>> = { ACHIEVED: 'success', ON_TRACK: 'success', AT_RISK: 'warning', OFF_TRACK: 'danger', MISSED: 'danger', NO_DATA: 'neutral' };

/**
 * DIS-30, the projection of the cumulative disbursement to each directive milestone (G1-16): the vintages written when the snapshot was frozen, by investor, with the target, the projection, the gap and the
 * status. A snapshot that was not read yet is told apart from one that has no milestone; a projection that lacks a month says it is a lower bound and never invents the month.
 */
export default function MilestonesScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const query = useGovRead('dis', 'getDisbursementMilestones', undefined);
  const statusLabel = (status: string): string => {
    switch (status) {
      case 'ACHIEVED':
        return t('gov11.milestones.status.achieved');
      case 'MISSED':
        return t('gov11.milestones.status.missed');
      case 'ON_TRACK':
        return t('gov11.milestones.status.onTrack');
      case 'AT_RISK':
        return t('gov11.milestones.status.atRisk');
      case 'OFF_TRACK':
        return t('gov11.milestones.status.offTrack');
      default:
        return t('gov11.milestones.status.noData');
    }
  };
  const coverageLabel = (coverage: string): string => (coverage === 'COMPLETE' ? t('gov11.milestones.coverage.complete') : coverage === 'PARTIAL' ? t('gov11.milestones.coverage.partial') : t('gov11.milestones.coverage.none'));
  return (
    <Frame
      route={route}
      title={t('gov11.milestones.title')}
      subtitle={t('gov11.milestones.subtitle')}
      scope={[{ label: t('gov11.common.scope'), value: tenant?.name ?? '–' }]}
      query={query}
      isEmpty={(data) => data.snapshot === null}
      notice={<UnverifiedNote rules={[asRecord(query.data?.rule) as unknown as RuleReading]} />}
    >
      {(data) => {
        const rule = asRecord(data.rule) as unknown as RuleReading;
        const snapshot = asRecord(data.snapshot);
        const run = data.run === null ? null : asRecord(data.run);
        const asOf = dayLabel(snapshot.as_of_date);
        const milestones = asList(data.milestones);
        return (
          <div className="gov11-grid">
            <p data-testid="snapshot-line">{t('gov11.milestones.snapshot', { asOf, cutoff: dayLabel(snapshot.treasury_cutoff_date), year: text(snapshot.plan_year) })}</p>
            {run === null && (
              <p className="callout" role="status" data-testid="not-recorded">
                {t('gov11.milestones.notRecorded')}
              </p>
            )}
            {run !== null && num(run.rows_written) === 0 && (
              <p className="callout" role="status" data-testid="nothing-to-project">
                {t('gov11.milestones.nothingToProject')}
              </p>
            )}
            {milestones.map((milestone) => {
              const summary = asRecord(milestone.summary);
              const units = asList(milestone.units);
              const code = text(milestone.code);
              return (
                <section key={code} aria-labelledby={`m-${code}`} data-testid={`milestone-${code}`}>
                  <h2 id={`m-${code}`}>{t('gov11.milestones.heading', { code, date: dayLabel(milestone.date), target: percent(milestone.target_pct) })}</h2>
                  <div className="gov11-row">
                    <Figure
                      label={t('gov11.milestones.projected')}
                      value={percent(summary.projected_pct)}
                      tone={TONE[text(summary.status, 'NO_DATA')] ?? 'neutral'}
                      sub={statusLabel(text(summary.status, 'NO_DATA'))}
                      rule={rule}
                      fallbackFormula={t('gov11.milestones.projected.formula')}
                      owner={t('gov11.milestones.owner')}
                      asOf={asOf}
                    />
                    <Figure label={t('gov11.milestones.gap')} value={summary.gap_pct === null ? '–' : `${text(summary.gap_pct)} ${t('gov11.common.points')}`} rule={rule} fallbackFormula={t('gov11.milestones.gap.formula')} owner={t('gov11.milestones.owner')} asOf={asOf} />
                    <Figure label={t('gov11.milestones.plan')} value={money(summary.plan_total_vnd)} sub={t('gov11.common.unit')} rule={undefined} fallbackFormula={t('gov11.milestones.plan.formula')} owner={t('gov11.milestones.owner')} asOf={asOf} />
                  </div>
                  <div className="gov11-scroll">
                    <table className="gov11-table">
                      <caption>{t('gov11.milestones.caption', { code })}</caption>
                      <thead>
                        <tr>
                          <th scope="col">{t('gov11.milestones.col.investor')}</th>
                          <th scope="col" className="gov11-num">
                            {t('gov11.milestones.col.plan')}
                          </th>
                          <th scope="col" className="gov11-num">
                            {t('gov11.milestones.col.target')}
                          </th>
                          <th scope="col" className="gov11-num">
                            {t('gov11.milestones.col.projected')}
                            <Info name={t('gov11.milestones.col.projected')} rule={rule} fallbackFormula={t('gov11.milestones.projected.formula')} owner={t('gov11.milestones.owner')} asOf={asOf} />
                          </th>
                          <th scope="col" className="gov11-num">
                            {t('gov11.milestones.col.gap')}
                          </th>
                          <th scope="col">{t('gov11.milestones.col.coverage')}</th>
                          <th scope="col">{t('gov11.milestones.col.status')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {units.map((unit) => {
                          const own = asRecord(unit.unit);
                          const status = text(unit.status, 'NO_DATA');
                          return (
                            <tr key={text(unit.id)} data-testid={`unit-${text(own.code)}`}>
                              <th scope="row">{text(own.name)}</th>
                              <td className="gov11-num">{money(unit.plan_total_vnd)}</td>
                              <td className="gov11-num">{money(unit.target_vnd)}</td>
                              <td className="gov11-num">{unit.projected_vnd === null ? '–' : `${money(unit.projected_vnd)} (${percent(unit.projected_pct)})`}</td>
                              <td className="gov11-num">{unit.gap_pct === null ? '–' : text(unit.gap_pct)}</td>
                              <td>{coverageLabel(text(unit.coverage, 'NONE'))}</td>
                              <td>
                                <StatusPill tone={TONE[status] ?? 'neutral'}>{statusLabel(status)}</StatusPill>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>
              );
            })}
          </div>
        );
      }}
    </Frame>
  );
}
