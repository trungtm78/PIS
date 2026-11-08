import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StatusPill } from '../../ui';
import { Figure, Frame, Info, UnverifiedNote, asList, asRecord, dayLabel, num, text, useGovRead } from './gov11-kit';
import type { RuleReading } from './gov11-kit';

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';
const TONE: Readonly<Record<string, Tone>> = { RUNNING: 'info', NEAR: 'warning', OVERDUE: 'danger', MET: 'success', MET_LATE: 'warning' };
const STATES = ['RUNNING', 'NEAR', 'OVERDUE', 'MET', 'MET_LATE'] as const;

/**
 * CTR-38, the settlement clocks of completed contracts (G1-18): the last day to hand in the settlement file is the day the contract was completed plus the months of its project group (5 for the large groups and
 * 4 for the small one are starting values, not confirmed). The clock ends when the file is handed in, on time or late; near and overdue are read from the day, not stored.
 */
export default function SettlementClocksScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const [state, setState] = useState('');
  const query = useGovRead('ctr', 'listContractSettlementClocks', { query: state === '' ? {} : { state } });
  const label = (value: string): string => {
    switch (value) {
      case 'RUNNING':
        return t('gov11.settlement.state.running');
      case 'NEAR':
        return t('gov11.settlement.state.near');
      case 'OVERDUE':
        return t('gov11.settlement.state.overdue');
      case 'MET':
        return t('gov11.settlement.state.met');
      default:
        return t('gov11.settlement.state.metLate');
    }
  };
  const left = (row: Record<string, unknown>): string => {
    const days = num(row.days_left);
    if (row.state === 'MET') return t('gov11.settlement.metOn', { day: dayLabel(row.met_on) });
    if (row.state === 'MET_LATE') return t('gov11.settlement.metLateOn', { day: dayLabel(row.met_on), days: Math.abs(days) });
    return days >= 0 ? t('gov11.settlement.left', { days, day: dayLabel(row.due_on) }) : t('gov11.settlement.late', { days: Math.abs(days) });
  };
  return (
    <Frame
      route={route}
      title={t('gov11.settlement.title')}
      subtitle={t('gov11.settlement.subtitle')}
      scope={[{ label: t('gov11.common.scope'), value: tenant?.name ?? '–' }]}
      query={query}
      isEmpty={(data) => num(asRecord(data.summary).total) === 0}
      notice={<UnverifiedNote rules={[asRecord(query.data?.rule) as unknown as RuleReading]} />}
    >
      {(data) => {
        const rule = asRecord(data.rule) as unknown as RuleReading;
        const summary = asRecord(data.summary);
        const params = asRecord(asRecord(data.rule).params);
        const months = asRecord(params.months_by_group);
        const items = asList(data.items);
        const asOf = dayLabel(typeof data.as_of === 'string' ? data.as_of.slice(0, 10) : null);
        return (
          <div className="gov11-grid">
            {data.truncated === true && (
              <p className="callout" role="status" data-testid="truncated-note">
                {t('gov11.settlement.truncated')}
              </p>
            )}
            <div className="gov11-row">
              <Figure label={t('gov11.settlement.open')} value={text(num(summary.open))} rule={rule} fallbackFormula={t('gov11.settlement.open.formula')} owner={t('gov11.settlement.owner')} asOf={asOf} />
              <Figure label={t('gov11.settlement.overdue')} value={text(num(summary.overdue))} tone={num(summary.overdue) > 0 ? 'danger' : 'default'} rule={rule} fallbackFormula={t('gov11.settlement.overdue.formula')} owner={t('gov11.settlement.owner')} asOf={asOf} />
              <Figure label={t('gov11.settlement.near')} value={text(num(summary.near))} tone={num(summary.near) > 0 ? 'warning' : 'default'} rule={rule} fallbackFormula={t('gov11.settlement.near.formula')} owner={t('gov11.settlement.owner')} asOf={asOf} />
              <Figure label={t('gov11.settlement.inTime')} value={summary.in_time_rate_pct === null ? '–' : `${text(summary.in_time_rate_pct)}%`} rule={rule} fallbackFormula={t('gov11.settlement.inTime.formula')} owner={t('gov11.settlement.owner')} asOf={asOf} />
            </div>
            <p data-testid="months-line">
              {t('gov11.settlement.months', { large: text(months.A), small: text(months.C) })}
              <Info name={t('gov11.settlement.months.name')} rule={rule} fallbackFormula={t('gov11.settlement.months.formula')} owner={t('gov11.settlement.owner')} asOf={asOf} />
            </p>
            <label>
              {t('gov11.settlement.filter')}
              <select value={state} onChange={(event) => setState(event.target.value)} data-testid="filter-state">
                <option value="">{t('gov11.settlement.filter.all')}</option>
                {STATES.map((value) => (
                  <option key={value} value={value}>
                    {label(value)}
                  </option>
                ))}
              </select>
            </label>
            {items.length === 0 ? (
              <p className="callout" role="status" data-testid="filtered-empty">
                {t('gov11.settlement.filtered')}
              </p>
            ) : (
              <div className="gov11-scroll">
                <table className="gov11-table" data-testid="settlement-table">
                  <caption>{t('gov11.settlement.caption')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('gov11.settlement.col.contract')}</th>
                      <th scope="col">{t('gov11.settlement.col.project')}</th>
                      <th scope="col">{t('gov11.settlement.col.group')}</th>
                      <th scope="col">{t('gov11.settlement.col.started')}</th>
                      <th scope="col" className="gov11-num">
                        {t('gov11.settlement.col.months')}
                      </th>
                      <th scope="col">{t('gov11.settlement.col.due')}</th>
                      <th scope="col">{t('gov11.settlement.col.left')}</th>
                      <th scope="col">{t('gov11.settlement.col.state')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((row) => {
                      const contract = asRecord(row.contract);
                      const project = asRecord(row.project);
                      const value = text(row.state);
                      return (
                        <tr key={text(row.id)} data-testid={`clock-${text(contract.code)}`}>
                          <th scope="row">
                            <Link to={`/ctr/ctr-39?id=${text(contract.id)}`}>{text(contract.code)}</Link>
                          </th>
                          <td>{text(project.code)}</td>
                          <td>{row.project_group === null ? t('gov11.settlement.noGroup') : text(row.project_group)}</td>
                          <td>{dayLabel(row.started_on)}</td>
                          <td className="gov11-num">{text(num(row.months_allowed))}</td>
                          <td>{dayLabel(row.due_on)}</td>
                          <td>{left(row)}</td>
                          <td>
                            <StatusPill tone={TONE[value] ?? 'neutral'}>{label(value)}</StatusPill>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      }}
    </Frame>
  );
}
