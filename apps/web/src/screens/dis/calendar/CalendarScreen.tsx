import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StatusPill } from '../../../ui';
import { Frame, UnverifiedNote, asList, asRecord, dayLabel, num, stamp, text, useGovRead } from '../../gov11/gov11-kit';
import type { RuleReading } from '../../gov11/gov11-kit';
import { ITEM_KINDS, STATE_TONE, STEP_KINDS, isStepKind, itemKindOf, kindKeyOf, reminderKindKeyOf, stateKeyOf, stepKeyOf, stepStateOf, yearOf } from './model';
import type { ItemKind } from './model';

const thisYear = (): string => String(new Date().getFullYear());

/**
 * DIS-34, the reporting calendar (QT.02): the periods of a year (month, quarter, year), the in-year plan adjustment, the steering meetings and the directives that fall due, each with the deadline of every step of the
 * schedule rule in force; and, for a period that was generated, the status board by input point. A step with no fact behind it says "not tracked": it is never shown as open or done.
 */
export default function CalendarScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const [yearText, setYearText] = useState(thisYear());
  const [kind, setKind] = useState<ItemKind | ''>('');
  const [periodId, setPeriodId] = useState<string | undefined>(undefined);
  // The year that is read is the last valid one typed: a half-typed year does not blank the screen, and the field stays where it can be corrected.
  const [applied, setApplied] = useState(Number(thisYear()));
  const year = yearOf(yearText);
  const query = useGovRead('dis', 'getReportingCalendar', { query: { year: String(applied) } });
  const schedules = asList(query.data?.schedules).map((one) => one as unknown as RuleReading);
  const filters = (
    <div className="gov11-row">
      <div className="field">
        <label htmlFor="ent4c-year">{t('ent4c.calendar.filter.year')}</label>
        <input
          id="ent4c-year"
          inputMode="numeric"
          maxLength={4}
          value={yearText}
          aria-invalid={year === undefined}
          onChange={(event) => {
            setYearText(event.target.value);
            const next = yearOf(event.target.value);
            if (next !== undefined) setApplied(next);
          }}
        />
        {year === undefined ? <p role="alert">{t('ent4c.calendar.filter.yearInvalid')}</p> : null}
      </div>
      <div className="field">
        <label htmlFor="ent4c-kind">{t('ent4c.calendar.filter.kind')}</label>
        <select id="ent4c-kind" value={kind} onChange={(event) => setKind(itemKindOf(event.target.value) ?? '')}>
          <option value="">{t('ent4c.calendar.filter.allKinds')}</option>
          {ITEM_KINDS.map((one) => (
            <option key={one} value={one}>
              {t(`ent4c.kind.${kindKeyOf(one)}`)}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
  return (
    <Frame
      route={route}
      title={t('ent4c.calendar.title')}
      subtitle={t('ent4c.calendar.subtitle')}
      scope={[{ label: t('ent4c.common.scope'), value: tenant?.name ?? '–' }]}
      query={query}
      isEmpty={(data) => asList(data.items).length === 0}
      notice={
        <>
          {filters}
          <UnverifiedNote rules={schedules} />
        </>
      }
    >
      {(data) => {
        const items = asList(data.items).filter((item) => kind === '' || item.kind === kind);
        return (
          <div className="gov11-grid">
            <div className="gov11-scroll">
              <table className="gov11-table" data-testid="calendar-table">
                <caption>{t('ent4c.calendar.caption', { year: text(data.year) })}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('ent4c.calendar.col.item')}</th>
                    <th scope="col">{t('ent4c.calendar.col.range')}</th>
                    {STEP_KINDS.map((step) => (
                      <th key={step} scope="col">
                        {t(`ent4c.step.${stepKeyOf(step)}`)}
                      </th>
                    ))}
                    <th scope="col">{t('ent4c.calendar.col.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.length === 0 ? (
                    <tr>
                      <td colSpan={STEP_KINDS.length + 3} data-testid="filtered-empty">
                        {t('ent4c.calendar.filtered.empty')}
                      </td>
                    </tr>
                  ) : (
                    items.map((item) => {
                      const steps = asList(item.steps);
                      const id = typeof item.period_id === 'string' ? item.period_id : undefined;
                      const itemKind = itemKindOf(item.kind);
                      return (
                        <tr key={`${text(item.kind)}:${text(item.key)}`} data-kind={text(item.kind)} data-testid="calendar-row">
                          <th scope="row">
                            <span>{text(item.code)}</span>
                            <br />
                            <span className="muted">{itemKind === undefined ? '' : t(`ent4c.kind.${kindKeyOf(itemKind)}`)}</span>
                            {typeof item.title === 'string' ? <span className="muted"> · {item.title}</span> : null}
                          </th>
                          <td>{item.starts_on === item.ends_on ? dayLabel(item.starts_on) : `${dayLabel(item.starts_on)} – ${dayLabel(item.ends_on)}`}</td>
                          {STEP_KINDS.map((step) => {
                            const found = steps.find((one) => one.kind === step);
                            return <td key={step}>{found === undefined ? '–' : `${dayLabel(found.due_on)} ${text(found.due_time, '')}`}</td>;
                          })}
                          <td>
                            {item.kind === 'DIRECTIVE_DUE' ? (
                              <StatusPill tone={item.status === 'OVERDUE' ? 'danger' : 'info'}>{`${text(item.status)}${num(item.overdue_days) > 0 ? ` (${num(item.overdue_days)})` : ''}`}</StatusPill>
                            ) : id !== undefined ? (
                              <button type="button" className="ui-button ui-button--outline ui-button--small" aria-pressed={periodId === id} onClick={() => setPeriodId(periodId === id ? undefined : id)}>
                                {t('ent4c.calendar.board.open')}
                              </button>
                            ) : item.kind === 'REPORT_PERIOD' ? (
                              <span className="muted">{t('ent4c.calendar.notGenerated')}</span>
                            ) : (
                              '–'
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            {periodId === undefined ? null : <Board periodId={periodId} />}
          </div>
        );
      }}
    </Frame>
  );
}

/** The status board of one period: for each input point, where each step stands, and the reminders that were sent. */
function Board({ periodId }: { periodId: string }) {
  const { t } = useTranslation();
  const query = useGovRead('dis', 'getReportingCalendarBoard', { path: { id: periodId } });
  if (query.isLoading) return <p role="status" aria-busy="true">{t('ent4c.board.loading')}</p>;
  if (query.data === undefined) return <p role="alert">{t('ent4c.board.error')}</p>;
  const data = query.data;
  const period = asRecord(data.period);
  const units = asList(data.units);
  const periodSteps = asList(data.period_steps);
  const reminders = asList(data.reminders);
  return (
    <section aria-labelledby="ent4c-board-title" data-testid="board">
      <h2 id="ent4c-board-title">{t('ent4c.board.title', { period: text(period.code) })}</h2>
      <p className="muted">{t('ent4c.board.asOf', { time: stamp(data.as_of) ?? '–' })}</p>
      <div className="gov11-scroll">
        <table className="gov11-table" data-testid="board-table">
          <thead>
            <tr>
              <th scope="col">{t('ent4c.board.col.unit')}</th>
              <th scope="col" className="gov11-num">
                {t('ent4c.board.col.projects')}
              </th>
              {STEP_KINDS.map((step) => (
                <th key={step} scope="col">
                  {t(`ent4c.step.${stepKeyOf(step)}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {units.length === 0 ? (
              <tr>
                <td colSpan={STEP_KINDS.length + 2}>{t('ent4c.board.empty')}</td>
              </tr>
            ) : (
              units.map((row) => {
                const unit = asRecord(row.unit);
                const steps = asList(row.steps);
                return (
                  <tr key={text(unit.id)} data-testid="board-row">
                    <th scope="row">{text(unit.name)}</th>
                    <td className="gov11-num">{num(row.projects)}</td>
                    {STEP_KINDS.map((step) => {
                      const found = steps.find((one) => isStepKind(one.kind) && one.kind === step);
                      if (found === undefined) return <td key={step}>–</td>;
                      const state = stepStateOf(found.state);
                      return (
                        <td key={step} data-state={state}>
                          <StatusPill tone={STATE_TONE[state]}>{t(`ent4c.state.${stateKeyOf(state)}`)}</StatusPill>
                          {found.of === null || found.of === undefined ? null : <span className="muted"> {t('ent4c.board.ratio', { done: num(found.done), of: num(found.of) })}</span>}
                        </td>
                      );
                    })}
                  </tr>
                );
              })
            )}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={2}>
                {t('ent4c.board.periodSteps')}
              </th>
              {STEP_KINDS.map((step) => {
                const found = periodSteps.find((one) => one.kind === step);
                if (found === undefined) return <td key={step}>–</td>;
                const state = stepStateOf(found.state);
                return (
                  <td key={step} data-state={state}>
                    <StatusPill tone={STATE_TONE[state]}>{t(`ent4c.state.${stateKeyOf(state)}`)}</StatusPill>
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>
      <h3>{t('ent4c.board.reminders')}</h3>
      {reminders.length === 0 ? (
        <p className="muted" data-testid="no-reminders">
          {t('ent4c.board.reminders.none')}
        </p>
      ) : (
        <ul data-testid="reminders">
          {reminders.map((one) => (
            <li key={text(one.id)}>
              {t(`ent4c.reminder.${reminderKindKeyOf(text(one.kind))}`)} · {isStepKind(one.step) ? t(`ent4c.step.${stepKeyOf(one.step)}`) : '–'} · {stamp(one.created_at) ?? '–'}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
