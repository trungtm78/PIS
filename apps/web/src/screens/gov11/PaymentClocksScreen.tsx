import { useState } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StatusPill } from '../../ui';
import { Figure, Frame, Info, UnverifiedNote, asList, asRecord, dayLabel, money, num, stamp, text, useGovRead } from './gov11-kit';
import type { RuleReading } from './gov11-kit';

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';
const TONE: Readonly<Record<string, Tone>> = { RUNNING: 'info', NEAR: 'warning', BREACHED: 'danger', MET: 'success', MET_LATE: 'warning', RETURNED: 'neutral', RETURNED_LATE: 'danger' };
const STATES = ['RUNNING', 'NEAR', 'BREACHED', 'MET', 'MET_LATE', 'RETURNED', 'RETURNED_LATE'] as const;

/**
 * PAY-22, the clocks of the Treasury control (G1-17): a payment request has 2 working days from the complete dossier at the Treasury, an advance 1, counted on the published calendar. The board is judged when it is
 * read; a year without a published calendar is told ("no calendar") and never guessed; a returned dossier carries one of the standard reasons, counted per reason.
 */
export default function PaymentClocksScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const [state, setState] = useState<string>('');
  const [kind, setKind] = useState<string>('');
  const request = { query: { ...(state === '' ? {} : { state }), ...(kind === '' ? {} : { kind }) } };
  const query = useGovRead('pay', 'listPaymentClocks', request);
  const reasons = useGovRead('pay', 'listPaymentReturnReasons', undefined);
  const stateLabel = (value: string): string => {
    switch (value) {
      case 'RUNNING':
        return t('gov11.clocks.state.running');
      case 'NEAR':
        return t('gov11.clocks.state.near');
      case 'BREACHED':
        return t('gov11.clocks.state.breached');
      case 'MET':
        return t('gov11.clocks.state.met');
      case 'MET_LATE':
        return t('gov11.clocks.state.metLate');
      case 'RETURNED':
        return t('gov11.clocks.state.returned');
      default:
        return t('gov11.clocks.state.returnedLate');
    }
  };
  const reasonName = (code: unknown): string => {
    if (typeof code !== 'string') return t('gov11.clocks.reason.none');
    const known = asList(reasons.data?.items).find((entry) => entry.code === code);
    return known === undefined ? code : `${code} (${text(known.category)})`;
  };
  const left = (row: Record<string, unknown>): string => {
    if (row.basis === 'CALENDAR_UNAVAILABLE') return t('gov11.clocks.noCalendar');
    const minutes = row.working_minutes_left === null ? num(row.working_minutes_late) : num(row.working_minutes_left);
    const hours = Math.round(minutes / 60);
    return row.working_minutes_left === null && row.working_minutes_late === null ? '–' : row.working_minutes_left !== null ? t('gov11.clocks.left', { hours }) : t('gov11.clocks.late', { hours });
  };
  return (
    <Frame
      route={route}
      title={t('gov11.clocks.title')}
      subtitle={t('gov11.clocks.subtitle')}
      scope={[{ label: t('gov11.common.scope'), value: tenant?.name ?? '–' }]}
      query={query}
      isEmpty={(data) => asList(data.items).length === 0 && num(asRecord(data.summary).total) === 0}
      notice={<UnverifiedNote rules={asList(query.data?.rules) as unknown as RuleReading[]} />}
    >
      {(data) => {
        const summary = asRecord(data.summary);
        const rules = asList(data.rules) as unknown as Array<RuleReading & { kind: string; working_days: number }>;
        const payment = rules.find((rule) => rule.kind === 'PAYMENT');
        const advance = rules.find((rule) => rule.kind === 'ADVANCE');
        const asOf = stamp(data.as_of) ?? '–';
        const items = asList(data.items);
        return (
          <div className="gov11-grid">
            {data.calendar_unavailable === true && (
              <p className="callout" role="status" data-testid="calendar-note">
                {t('gov11.clocks.calendarNote')}
              </p>
            )}
            {data.truncated === true && (
              <p className="callout" role="status" data-testid="truncated-note">
                {t('gov11.clocks.truncated')}
              </p>
            )}
            <div className="gov11-row">
              <Figure label={t('gov11.clocks.open')} value={text(num(summary.open))} rule={payment} fallbackFormula={t('gov11.clocks.open.formula')} owner={t('gov11.clocks.owner')} asOf={asOf} />
              <Figure label={t('gov11.clocks.breached')} value={text(num(summary.breached))} tone={num(summary.breached) > 0 ? 'danger' : 'default'} rule={payment} fallbackFormula={t('gov11.clocks.breached.formula')} owner={t('gov11.clocks.owner')} asOf={asOf} />
              <Figure label={t('gov11.clocks.near')} value={text(num(summary.near))} tone={num(summary.near) > 0 ? 'warning' : 'default'} rule={payment} fallbackFormula={t('gov11.clocks.near.formula')} owner={t('gov11.clocks.owner')} asOf={asOf} />
              <Figure label={t('gov11.clocks.inTime')} value={summary.in_time_rate_pct === null ? '–' : `${text(summary.in_time_rate_pct)}%`} rule={payment} fallbackFormula={t('gov11.clocks.inTime.formula')} owner={t('gov11.clocks.owner')} asOf={asOf} />
            </div>
            <p data-testid="rules-line">
              {t('gov11.clocks.rules', { payment: text(payment?.working_days), advance: text(advance?.working_days) })}
              <Info name={t('gov11.clocks.rules.name')} rule={payment} fallbackFormula={t('gov11.clocks.rules.formula')} owner={t('gov11.clocks.owner')} asOf={asOf} />
            </p>
            <div className="gov11-row">
              <label>
                {t('gov11.clocks.filter.state')}
                <select value={state} onChange={(event) => setState(event.target.value)} data-testid="filter-state">
                  <option value="">{t('gov11.clocks.filter.all')}</option>
                  {STATES.map((value) => (
                    <option key={value} value={value}>
                      {stateLabel(value)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t('gov11.clocks.filter.kind')}
                <select value={kind} onChange={(event) => setKind(event.target.value)} data-testid="filter-kind">
                  <option value="">{t('gov11.clocks.filter.all')}</option>
                  <option value="PAYMENT">{t('gov11.clocks.kind.payment')}</option>
                  <option value="ADVANCE">{t('gov11.clocks.kind.advance')}</option>
                </select>
              </label>
            </div>
            {items.length === 0 ? (
              <p className="callout" role="status" data-testid="filtered-empty">
                {t('gov11.clocks.filtered')}
              </p>
            ) : (
              <div className="gov11-scroll">
                <table className="gov11-table" data-testid="clocks-table">
                  <caption>{t('gov11.clocks.caption')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('gov11.clocks.col.request')}</th>
                      <th scope="col">{t('gov11.clocks.col.investor')}</th>
                      <th scope="col">{t('gov11.clocks.col.kind')}</th>
                      <th scope="col">{t('gov11.clocks.col.started')}</th>
                      <th scope="col">{t('gov11.clocks.col.due')}</th>
                      <th scope="col">{t('gov11.clocks.col.left')}</th>
                      <th scope="col">{t('gov11.clocks.col.state')}</th>
                      <th scope="col">{t('gov11.clocks.col.reason')}</th>
                      <th scope="col" className="gov11-num">
                        {t('gov11.clocks.col.net')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((row) => {
                      const contract = asRecord(row.contract);
                      const investor = asRecord(row.investor);
                      const value = text(row.state);
                      return (
                        <tr key={text(row.id)} data-testid={`clock-${text(row.id)}`}>
                          <th scope="row">{text(row.request_no, text(contract.code))}</th>
                          <td>{text(investor.name)}</td>
                          <td>{row.clock_kind === 'ADVANCE' ? t('gov11.clocks.kind.advance') : t('gov11.clocks.kind.payment')}</td>
                          <td>{stamp(row.started_at) ?? '–'}</td>
                          <td>{stamp(row.due_at) ?? dayLabel(null)}</td>
                          <td>{left(row)}</td>
                          <td>
                            <StatusPill tone={TONE[value] ?? 'neutral'}>{stateLabel(value)}</StatusPill>
                          </td>
                          <td>{row.end_kind === 'RETURNED' ? reasonName(row.return_reason_code) : '–'}</td>
                          <td className="gov11-num">{money(row.net_vnd)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <section aria-labelledby="returns-title" data-testid="returns-section">
              <h2 id="returns-title">{t('gov11.clocks.returns.title')}</h2>
              {asList(summary.returns_by_reason).length === 0 ? (
                <p>{t('gov11.clocks.returns.none')}</p>
              ) : (
                <ul>
                  {asList(summary.returns_by_reason).map((entry) => (
                    <li key={text(entry.reason_code, 'none')}>{t('gov11.clocks.returns.line', { reason: reasonName(entry.reason_code), count: num(entry.count) })}</li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        );
      }}
    </Frame>
  );
}
